//! Rooms: members, the loaded show, light assignment and playback. A dropped connection keeps
//! its place until [`Rooms::expire`] and can [`Rooms::resume`] it. Methods are synchronous, so
//! the lock around [`Rooms`] is never held across an `await`.

use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, RandomState};

use lsa_fseq::Sequence;
use lsa_tesla::{Channel, Rendered, Vehicle, render};
use tokio::sync::mpsc::UnboundedSender;

use crate::lights::{color_of, playable_channels};
use crate::protocol::{PhoneHealth, RosterEntry, ServerMsg, Spot, encode_track};
use crate::safety::govern;

/// Delay between a play command and the show actually starting, so every phone receives it
/// in time.
pub const START_LEAD_MS: f64 = 1000.0;
/// Delay between a calibration request and the first tone: time for phones to open their
/// microphones.
pub const CALIBRATION_LEAD_MS: f64 = 2500.0;
/// Calibration tones per measurement (phones average them).
pub const CALIBRATION_TONES: u32 = 5;
/// Milliseconds between calibration tones; longer than any speaker delay worth measuring.
pub const CALIBRATION_GAP_MS: f64 = 700.0;
/// Largest show file accepted (bytes).
pub const MAX_SHOW_BYTES: usize = 64 * 1024 * 1024;
/// Largest decoded show accepted (bytes). Tesla's limit, 200 channels for 4 hours at 15 ms per
/// frame, is 192 MB; a compressed file can claim far more.
pub const MAX_DECODED_BYTES: usize = 256 * 1024 * 1024;
/// Most cars in one fleet show (Tesla's largest example has 8).
pub const MAX_CARS: usize = 16;
/// Most places in a layout.
pub const MAX_SPOTS: usize = 4096;

const ROOM_CODE_LEN: usize = 4;
// No I, O, 0 or 1: codes are read aloud and typed on phones.
const ROOM_CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";

/// Something to deliver to one connection.
#[derive(Debug, Clone, PartialEq)]
pub enum Outgoing {
    /// A JSON message.
    Text(ServerMsg),
    /// A binary frame (light track).
    Binary(Vec<u8>),
}

/// Unique id of a connection.
pub type MemberId = u64;

/// One light of a (fleet) show: the car, numbered from 1 left to right as seen from the front
/// (as Tesla numbers them), and its 1-based Tesla channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Slot {
    /// Car number, from 1.
    pub car: u8,
    /// Tesla channel, from 1.
    pub channel: u16,
}

impl Slot {
    fn of(spot: Spot) -> Self {
        Self {
            car: spot.car,
            channel: spot.channel,
        }
    }
}

/// A connection's hold on its place in a room.
#[derive(Debug)]
struct Session {
    tx: UnboundedSender<Outgoing>,
    /// Secret that lets a new connection take this place.
    token: String,
    online: bool,
    /// Counts disconnects, so an expiry scheduled for an earlier one is ignored.
    epoch: u64,
}

impl Session {
    fn new(tx: UnboundedSender<Outgoing>, token: String) -> Self {
        Self {
            tx,
            token,
            online: true,
            epoch: 0,
        }
    }

    /// Marks the session offline if `tx` is still its connection; returns the new epoch.
    fn disconnect(&mut self, tx: &UnboundedSender<Outgoing>) -> Option<u64> {
        if !self.online || !self.tx.same_channel(tx) {
            return None;
        }
        self.online = false;
        self.epoch += 1;
        Some(self.epoch)
    }

    fn reconnect(&mut self, tx: UnboundedSender<Outgoing>) {
        self.tx = tx;
        self.online = true;
    }
}

#[derive(Debug)]
struct Member {
    session: Session,
    name: Option<String>,
    /// With a layout: the phone's place in it. Its light (`slot`) is that place's light.
    spot: Option<u16>,
    slot: Option<Slot>,
    /// Chosen by the host; kept when a new show loads if still playable.
    pinned: bool,
    /// Last report from the phone.
    health: Option<PhoneHealth>,
}

#[derive(Debug)]
struct LoadedShow {
    version: u32,
    name: String,
    vehicle: String,
    duration_ms: f64,
    cars: Vec<CarShow>,
    /// Lights handed out to phones: each car's playable lights in priority order, interleaved
    /// so every car gets its most recognisable lights first.
    slots: Vec<Slot>,
}

#[derive(Debug)]
struct CarShow {
    rendered: Rendered,
    /// Governed, encoded track of each playable light, made once instead of per phone.
    tracks: HashMap<u16, Vec<u8>>,
}

impl LoadedShow {
    fn new(version: u32, name: &str, vehicle: &str, cars: Vec<Rendered>, duration_ms: f64) -> Self {
        let playable: Vec<Vec<u16>> = cars.iter().map(playable_channels).collect();
        let longest = playable.iter().map(Vec::len).max().unwrap_or(0);
        let slots = (0..longest)
            .flat_map(|rank| {
                playable
                    .iter()
                    .enumerate()
                    .filter_map(move |(car, lights)| {
                        Some(Slot {
                            car: car as u8 + 1,
                            channel: *lights.get(rank)?,
                        })
                    })
            })
            .collect();
        let cars = cars
            .into_iter()
            .zip(&playable)
            .enumerate()
            .map(|(car, (rendered, lights))| {
                let tracks = lights
                    .iter()
                    .filter_map(|&channel| {
                        let slot = Slot {
                            car: car as u8 + 1,
                            channel,
                        };
                        Some((channel, encode_car_track(version, slot, &rendered)?))
                    })
                    .collect();
                CarShow { rendered, tracks }
            })
            .collect();
        Self {
            version,
            name: name.chars().take(80).collect(),
            vehicle: vehicle.to_owned(),
            duration_ms,
            cars,
            slots,
        }
    }

    fn car(&self, slot: Slot) -> Option<&CarShow> {
        self.cars.get(usize::from(slot.car).checked_sub(1)?)
    }

    /// The binary frame a phone playing `slot` receives.
    fn track(&self, slot: Slot) -> Option<Vec<u8>> {
        let car = self.car(slot)?;
        car.tracks
            .get(&slot.channel)
            .cloned()
            .or_else(|| encode_car_track(self.version, slot, &car.rendered))
    }
}

fn encode_car_track(version: u32, slot: Slot, rendered: &Rendered) -> Option<Vec<u8>> {
    let levels = rendered.channel_track(usize::from(slot.channel).checked_sub(1)?)?;
    let step_ms = rendered.step_time().as_millis() as u8;
    Some(encode_track(
        version,
        slot.car,
        slot.channel,
        step_ms,
        &govern(&levels, step_ms),
    ))
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Playback {
    Paused {
        position_ms: f64,
    },
    /// Position at server time `s` is `max(from_ms, s - t0)`: held at `from_ms` until the
    /// start lead has passed.
    Playing {
        t0: f64,
        from_ms: f64,
    },
}

#[derive(Debug)]
struct Room {
    host: MemberId,
    host_session: Session,
    /// Phones in join order.
    members: BTreeMap<MemberId, Member>,
    show: Option<LoadedShow>,
    playback: Playback,
    /// Where phones stand; empty for the car shape, where phones are dealt lights directly.
    layout: Vec<Spot>,
    /// The phones changed since the host's last roster (see [`Rooms::flush_rosters`]).
    roster_due: bool,
}

/// Every room on this server.
#[derive(Debug, Default)]
pub struct Rooms {
    by_code: HashMap<String, Room>,
    /// Which room each connection belongs to.
    membership: HashMap<MemberId, String>,
    hasher: RandomState,
    counter: u64,
}

impl Rooms {
    /// Creates a room hosted by `host` and returns its code.
    pub fn create(&mut self, host: MemberId, tx: UnboundedSender<Outgoing>) -> String {
        self.leave(host);
        let code = self.new_code();
        let token = self.new_token();
        send(
            &tx,
            ServerMsg::Created {
                room: code.clone(),
                token: token.clone(),
            },
        );
        self.by_code.insert(
            code.clone(),
            Room {
                host,
                host_session: Session::new(tx, token),
                members: BTreeMap::new(),
                show: None,
                playback: Playback::Paused { position_ms: 0.0 },
                layout: Vec::new(),
                roster_due: false,
            },
        );
        self.membership.insert(host, code.clone());
        code
    }

    /// Adds a phone to a room and sends it everything it needs to start playing.
    pub fn join(
        &mut self,
        id: MemberId,
        code: &str,
        name: Option<String>,
        tx: UnboundedSender<Outgoing>,
    ) -> Result<(), String> {
        let code = code.trim().to_ascii_uppercase();
        let not_found = || format!("room {code} not found");
        if !self.by_code.contains_key(&code) {
            return Err(not_found());
        }
        // Leaving first can close a room this connection was hosting, so look it up again.
        self.leave(id);
        let token = self.new_token();
        let Some(room) = self.by_code.get_mut(&code) else {
            return Err(not_found());
        };
        send(
            &tx,
            ServerMsg::Joined {
                id,
                room: code.clone(),
                token: token.clone(),
            },
        );
        room.members.insert(
            id,
            Member {
                session: Session::new(tx, token),
                name: name.map(|n| n.chars().take(32).collect()),
                spot: None,
                slot: None,
                pinned: false,
                health: None,
            },
        );
        self.membership.insert(id, code);

        room.assign_unpinned();
        room.send_state(id);
        room.roster_due = true;
        Ok(())
    }

    /// Gives the place holding `token` to a new connection and sends it the room's state.
    /// Returns the member id the connection now speaks for, or `None` if the token is unknown.
    pub fn resume(&mut self, token: &str, tx: UnboundedSender<Outgoing>) -> Option<MemberId> {
        let (code, room) = self.by_code.iter_mut().find(|(_, room)| {
            room.host_session.token == token
                || room.members.values().any(|m| m.session.token == token)
        })?;
        let host = room.host_session.token == token;
        let id = if host {
            room.host_session.reconnect(tx);
            room.host
        } else {
            let (&id, member) = room
                .members
                .iter_mut()
                .find(|(_, m)| m.session.token == token)?;
            member.session.reconnect(tx);
            id
        };
        let resumed = ServerMsg::Resumed {
            id,
            room: code.clone(),
            host,
        };
        if host {
            send(&room.host_session.tx, resumed);
            if let Some(show) = &room.show {
                send(&room.host_session.tx, show_msg(show));
            }
            send(&room.host_session.tx, room.playback_msg());
        } else {
            send(&room.members[&id].session.tx, resumed);
            room.send_state(id);
        }
        room.roster_due = true;
        Some(id)
    }

    /// Marks `id` offline after its connection `tx` dropped, keeping its place. Returns the
    /// epoch to pass to [`Rooms::expire`], or `None` if `tx` no longer speaks for `id` (another
    /// connection resumed it) or `id` is in no room.
    pub fn disconnect(&mut self, id: MemberId, tx: &UnboundedSender<Outgoing>) -> Option<u64> {
        let room = self.by_code.get_mut(self.membership.get(&id)?)?;
        if room.host == id {
            room.host_session.disconnect(tx)
        } else {
            let epoch = room.members.get_mut(&id)?.session.disconnect(tx)?;
            room.roster_due = true;
            Some(epoch)
        }
    }

    /// Gives up the place of `id` if it is still offline since the disconnect that returned
    /// `epoch`.
    pub fn expire(&mut self, id: MemberId, epoch: u64) {
        let Some(room) = self
            .membership
            .get(&id)
            .and_then(|code| self.by_code.get(code))
        else {
            return;
        };
        let session = if room.host == id {
            Some(&room.host_session)
        } else {
            room.members.get(&id).map(|m| &m.session)
        };
        if session.is_some_and(|s| !s.online && s.epoch == epoch) {
            self.leave(id);
        }
    }

    /// Removes a connection from its room. A room closes when its host leaves.
    pub fn leave(&mut self, id: MemberId) {
        let Some(code) = self.membership.remove(&id) else {
            return;
        };
        let Some(room) = self.by_code.get_mut(&code) else {
            return;
        };
        if room.host == id {
            let Some(room) = self.by_code.remove(&code) else {
                return;
            };
            for (member, phone) in room.members {
                self.membership.remove(&member);
                send(
                    &phone.session.tx,
                    ServerMsg::Error {
                        message: "the host ended the party".into(),
                    },
                );
            }
        } else if room.members.remove(&id).is_some() {
            room.roster_due = true;
        }
    }

    /// Host: loads a show, renders it for `vehicle`, and sends every phone its track. `bytes`
    /// holds one `.fseq` per car of a fleet show, back to back, with their lengths in `sizes`
    /// (empty for a single show).
    pub fn load_show(
        &mut self,
        host: MemberId,
        vehicle_name: &str,
        name: &str,
        bytes: &[u8],
        sizes: &[u32],
    ) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        let vehicle: Vehicle = Vehicle::from_id(vehicle_name)
            .ok_or_else(|| format!("unknown vehicle {vehicle_name}"))?;
        if bytes.len() > MAX_SHOW_BYTES {
            return Err("show file is too large".into());
        }
        let files = split_files(bytes, sizes)?;
        let mut decoded = 0usize;
        for file in &files {
            let header = lsa_fseq::Header::parse(file).map_err(|e| e.to_string())?;
            decoded = decoded.saturating_add(header.data_len().map_err(|e| e.to_string())?);
        }
        if decoded > MAX_DECODED_BYTES {
            return Err("show is too long".into());
        }
        let mut cars = Vec::with_capacity(files.len());
        let mut duration_ms = 0.0f64;
        for file in files {
            let sequence = Sequence::parse(file).map_err(|e| e.to_string())?;
            duration_ms = duration_ms.max(sequence.duration().as_secs_f64() * 1000.0);
            cars.push(render(&sequence, vehicle));
        }
        let version = room.show.as_ref().map_or(1, |s| s.version + 1);
        let show = LoadedShow::new(version, name, vehicle_name, cars, duration_ms);

        room.playback = Playback::Paused { position_ms: 0.0 };
        let message = show_msg(&show);
        send(&room.host_session.tx, message.clone());
        for member in room.members.values() {
            send(&member.session.tx, message.clone());
        }
        // With a layout everyone keeps their place. Otherwise pins survive when the light is in
        // the new show and every other phone is dealt again.
        if room.layout.is_empty() {
            for member in room.members.values_mut() {
                if !(member.pinned && member.slot.is_some_and(|slot| show.slots.contains(&slot))) {
                    member.pinned = false;
                    member.slot = None;
                }
            }
        }
        room.show = Some(show);
        room.assign_unpinned();
        let ids: Vec<MemberId> = room.members.keys().copied().collect();
        for id in ids {
            room.send_role(id);
        }
        room.broadcast_playback();
        room.roster_due = true;
        Ok(())
    }

    /// Host: starts playback from `position_ms` after [`START_LEAD_MS`].
    pub fn play(&mut self, host: MemberId, position_ms: f64, now: f64) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        if room.show.is_none() {
            return Err("load a show first".into());
        }
        let from_ms = position_ms.max(0.0);
        room.playback = Playback::Playing {
            t0: now + START_LEAD_MS - from_ms,
            from_ms,
        };
        room.broadcast_playback();
        Ok(())
    }

    /// Host: pauses at the current position.
    pub fn pause(&mut self, host: MemberId, now: f64) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        room.playback = Playback::Paused {
            position_ms: room.position(now),
        };
        room.broadcast_playback();
        Ok(())
    }

    /// Host: jumps to `position_ms`, keeping the play/pause state.
    pub fn seek(&mut self, host: MemberId, position_ms: f64, now: f64) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        let position_ms = position_ms.max(0.0);
        room.playback = match room.playback {
            Playback::Playing { .. } => Playback::Playing {
                t0: now + START_LEAD_MS - position_ms,
                from_ms: position_ms,
            },
            Playback::Paused { .. } => Playback::Paused { position_ms },
        };
        room.broadcast_playback();
        Ok(())
    }

    /// Host: schedules calibration tones and tells every phone when to listen.
    pub fn calibrate(&mut self, host: MemberId, now: f64) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        if matches!(room.playback, Playback::Playing { .. }) {
            return Err("pause the show before measuring the speaker".into());
        }
        let message = ServerMsg::Calibrate {
            at: now + CALIBRATION_LEAD_MS,
            tones: CALIBRATION_TONES,
            gap_ms: CALIBRATION_GAP_MS,
        };
        send(&room.host_session.tx, message.clone());
        for member in room.members.values() {
            send(&member.session.tx, message.clone());
        }
        Ok(())
    }

    /// Phone: passes its calibration measurement to the host.
    pub fn heard(&mut self, id: MemberId, delay_ms: Option<f64>) -> Result<(), String> {
        let room = self
            .membership
            .get(&id)
            .and_then(|code| self.by_code.get(code))
            .ok_or("join a room first")?;
        if !room.members.contains_key(&id) {
            return Err("only phones measure the speaker".into());
        }
        send(
            &room.host_session.tx,
            ServerMsg::Heard {
                member: id,
                delay_ms: delay_ms.filter(|d| d.is_finite()),
            },
        );
        Ok(())
    }

    /// Phone: records how it is doing for the host's roster.
    pub fn status(&mut self, id: MemberId, mut health: PhoneHealth) -> Result<(), String> {
        let room = self
            .membership
            .get(&id)
            .and_then(|code| self.by_code.get_mut(code))
            .ok_or("join a room first")?;
        let member = room
            .members
            .get_mut(&id)
            .ok_or("only phones report their status")?;
        health.rtt_ms = health.rtt_ms.filter(|ms| ms.is_finite() && *ms >= 0.0);
        // Unchanged reports do not cost the host a roster.
        if member.health.as_ref() != Some(&health) {
            member.health = Some(health);
            room.roster_due = true;
        }
        Ok(())
    }

    /// Host: pins a phone to a light (car shape) or to a place (layout), or clears it.
    pub fn assign(
        &mut self,
        host: MemberId,
        member: MemberId,
        slot: Option<Slot>,
        place: Option<u16>,
    ) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        if room.layout.is_empty() && place.is_some() {
            return Err("this party has no layout; choose a light".into());
        }
        if !room.layout.is_empty() && slot.is_some() {
            return Err("this party uses a layout; choose a place".into());
        }
        if let Some(Slot { car, channel }) = slot {
            if !(1..=lsa_tesla::EXTENDED_CHANNELS as u16).contains(&channel) {
                return Err(format!("channel {channel} is out of range"));
            }
            let cars = room.show.as_ref().map_or(MAX_CARS, |show| show.cars.len());
            if !(1..=cars).contains(&usize::from(car)) {
                return Err(format!("car {car} is not in this show"));
            }
        }
        let layout_spot = match place {
            Some(index) => Some(
                *room
                    .layout
                    .get(usize::from(index))
                    .ok_or_else(|| format!("place {} is not in the layout", index + 1))?,
            ),
            None => None,
        };
        let phone = room
            .members
            .get_mut(&member)
            .ok_or("no such phone in this room")?;
        phone.spot = place;
        phone.slot = slot.or(layout_spot.map(Slot::of));
        phone.pinned = phone.slot.is_some();
        // Only this phone changes; the others keep their lights.
        room.assign_unpinned();
        room.send_role(member);
        room.roster_due = true;
        Ok(())
    }

    /// Host: sets where phones stand (empty for the car shape) and deals every phone again.
    pub fn set_layout(&mut self, host: MemberId, spots: Vec<Spot>) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        if spots.len() > MAX_SPOTS {
            return Err(format!("at most {MAX_SPOTS} places in a layout"));
        }
        let cars = room.show.as_ref().map_or(MAX_CARS, |show| show.cars.len());
        for (i, spot) in spots.iter().enumerate() {
            let inside = |v: f32| (0.0..=1.0).contains(&v);
            if !(inside(spot.x) && inside(spot.y)) {
                return Err(format!("place {} is outside the layout", i + 1));
            }
            if !(1..=lsa_tesla::EXTENDED_CHANNELS as u16).contains(&spot.channel)
                || !(1..=cars).contains(&usize::from(spot.car))
            {
                return Err(format!("place {} has no such light", i + 1));
            }
        }
        room.layout = spots;
        for member in room.members.values_mut() {
            member.spot = None;
            member.slot = None;
            member.pinned = false;
        }
        room.assign_unpinned();
        let ids: Vec<MemberId> = room.members.keys().copied().collect();
        for id in ids {
            room.send_layout(id);
            room.send_role(id);
        }
        room.roster_due = true;
        Ok(())
    }

    /// Whether any host is owed a roster.
    #[must_use]
    pub fn rosters_due(&self) -> bool {
        self.by_code.values().any(|room| room.roster_due)
    }

    /// Sends each host whose phones changed one roster. Batched: one per change sent 2000
    /// rosters (114 MB) after a Wi-Fi blip with 1000 phones.
    pub fn flush_rosters(&mut self) {
        for room in self.by_code.values_mut().filter(|room| room.roster_due) {
            room.roster_due = false;
            room.send_roster();
        }
    }

    /// Number of open rooms.
    #[must_use]
    pub fn len(&self) -> usize {
        self.by_code.len()
    }

    /// Whether no rooms are open.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.by_code.is_empty()
    }

    fn hosted_room(&mut self, host: MemberId) -> Result<&mut Room, String> {
        let code = self.membership.get(&host).ok_or("create a room first")?;
        let room = self.by_code.get_mut(code).ok_or("room closed")?;
        if room.host == host {
            Ok(room)
        } else {
            Err("only the host can do that".into())
        }
    }

    /// An unguessable session token: 128 bits from the randomly keyed hasher.
    fn new_token(&mut self) -> String {
        self.counter += 1;
        let high = self.hasher.hash_one((self.counter, 0u8));
        let low = self.hasher.hash_one((self.counter, 1u8));
        format!("{high:016x}{low:016x}")
    }

    fn new_code(&mut self) -> String {
        loop {
            self.counter += 1;
            let mut value = self.hasher.hash_one(self.counter);
            let code: String = (0..ROOM_CODE_LEN)
                .map(|_| {
                    let letter =
                        ROOM_CODE_ALPHABET[(value % ROOM_CODE_ALPHABET.len() as u64) as usize];
                    value /= ROOM_CODE_ALPHABET.len() as u64;
                    char::from(letter)
                })
                .collect();
            if !self.by_code.contains_key(&code) {
                return code;
            }
        }
    }
}

impl Room {
    fn position(&self, now: f64) -> f64 {
        match self.playback {
            Playback::Paused { position_ms } => position_ms,
            Playback::Playing { t0, from_ms } => (now - t0).max(from_ms),
        }
    }

    fn playback_msg(&self) -> ServerMsg {
        match self.playback {
            Playback::Paused { position_ms } => ServerMsg::Playback {
                playing: false,
                t0: None,
                position_ms,
            },
            Playback::Playing { t0, from_ms } => ServerMsg::Playback {
                playing: true,
                t0: Some(t0),
                position_ms: from_ms,
            },
        }
    }

    fn broadcast_playback(&self) {
        let message = self.playback_msg();
        send(&self.host_session.tx, message.clone());
        for member in self.members.values() {
            send(&member.session.tx, message.clone());
        }
    }

    /// Gives every phone without a light the slot with the fewest phones (ties go to the earlier
    /// slot). Phones that have a light keep it, so a phone joining or leaving never moves others.
    fn assign_unpinned(&mut self) {
        if !self.layout.is_empty() {
            self.assign_places();
            return;
        }
        let Some(show) = &self.show else {
            return;
        };
        let mut phones: HashMap<Slot, usize> = show.slots.iter().map(|&s| (s, 0)).collect();
        for member in self.members.values() {
            if let Some(count) = member.slot.and_then(|s| phones.get_mut(&s)) {
                *count += 1;
            }
        }
        for member in self.members.values_mut().filter(|m| m.slot.is_none()) {
            let Some(&slot) = show.slots.iter().min_by_key(|s| phones[s]) else {
                return;
            };
            member.slot = Some(slot);
            *phones.entry(slot).or_default() += 1;
        }
    }

    /// Layout version of [`Room::assign_unpinned`]: phones without a place get the place with
    /// the fewest phones, earliest first.
    fn assign_places(&mut self) {
        let mut phones = vec![0usize; self.layout.len()];
        for member in self.members.values() {
            if let Some(count) = member.spot.and_then(|s| phones.get_mut(usize::from(s))) {
                *count += 1;
            }
        }
        for member in self.members.values_mut().filter(|m| m.spot.is_none()) {
            let Some((index, _)) = phones.iter().enumerate().min_by_key(|&(_, count)| *count)
            else {
                return;
            };
            member.spot = Some(index as u16);
            member.slot = Some(Slot::of(self.layout[index]));
            phones[index] += 1;
        }
    }

    fn send_layout(&self, id: MemberId) {
        if let Some(member) = self.members.get(&id) {
            let spots = self.layout.iter().map(|s| [s.x, s.y]).collect();
            send(&member.session.tx, ServerMsg::Layout { spots });
        }
    }

    /// Sends a phone the show, its light and track, and the playback state.
    fn send_state(&self, id: MemberId) {
        let Some(member) = self.members.get(&id) else {
            return;
        };
        if let Some(show) = &self.show {
            send(&member.session.tx, show_msg(show));
        }
        if !self.layout.is_empty() {
            self.send_layout(id);
        }
        self.send_role(id);
        send(&member.session.tx, self.playback_msg());
    }

    fn send_role(&self, id: MemberId) {
        let Some(member) = self.members.get(&id) else {
            return;
        };
        let known = self
            .show
            .as_ref()
            .zip(member.slot)
            .and_then(|(show, slot)| Some((show, slot, show.car(slot)?)));
        let Some((show, slot, car)) = known else {
            send(
                &member.session.tx,
                ServerMsg::Role {
                    spot: member.spot,
                    car: None,
                    channel: None,
                    label: None,
                    color: None,
                },
            );
            return;
        };
        let rendered = &car.rendered;
        let channel = Channel::from_index(usize::from(slot.channel) - 1, rendered.channel_count());
        let vehicle = rendered.vehicle();
        send(
            &member.session.tx,
            ServerMsg::Role {
                spot: member.spot,
                car: Some(slot.car),
                channel: Some(slot.channel),
                label: Some(vehicle.channel_name(channel)),
                color: Some(color_of(vehicle, channel).to_owned()),
            },
        );
        if let Some(track) = show.track(slot) {
            let _ = member.session.tx.send(Outgoing::Binary(track));
        }
    }

    fn send_roster(&self) {
        let members = self
            .members
            .iter()
            .map(|(&id, m)| RosterEntry {
                id,
                name: m.name.clone(),
                spot: m.spot,
                car: m.slot.map(|s| s.car),
                channel: m.slot.map(|s| s.channel),
                online: m.session.online,
                health: m.health.clone(),
            })
            .collect();
        send(&self.host_session.tx, ServerMsg::Roster { members });
    }
}

fn show_msg(show: &LoadedShow) -> ServerMsg {
    ServerMsg::Show {
        version: show.version,
        name: show.name.clone(),
        vehicle: show.vehicle.clone(),
        cars: show.cars.len() as u8,
        duration_ms: show.duration_ms,
    }
}

/// Splits back-to-back files by `sizes`; no sizes means one file.
fn split_files<'a>(bytes: &'a [u8], sizes: &[u32]) -> Result<Vec<&'a [u8]>, String> {
    if sizes.is_empty() {
        return Ok(vec![bytes]);
    }
    if sizes.len() > MAX_CARS {
        return Err(format!("at most {MAX_CARS} cars per show"));
    }
    let mut files = Vec::with_capacity(sizes.len());
    let mut rest = bytes;
    for &size in sizes {
        let (file, after) = rest
            .split_at_checked(size as usize)
            .ok_or("show files are shorter than their sizes")?;
        files.push(file);
        rest = after;
    }
    if !rest.is_empty() {
        return Err("show files are longer than their sizes".into());
    }
    Ok(files)
}

fn send(tx: &UnboundedSender<Outgoing>, message: ServerMsg) {
    // A closed channel means the connection is going away; it is removed on disconnect.
    let _ = tx.send(Outgoing::Text(message));
}
