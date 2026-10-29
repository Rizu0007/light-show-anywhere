//! Rooms: members, the loaded show, light assignment and playback.
//!
//! A dropped connection does not leave its room: the phone or host goes offline but keeps its
//! place (and light) until [`Rooms::expire`], and can take it back with its session token
//! ([`Rooms::resume`]). Phones keep playing while the host is offline.
//!
//! All methods are synchronous and send through each member's unbounded channel, so the lock
//! around [`Rooms`] is never held across an `await`.

use std::collections::{BTreeMap, HashMap};
use std::hash::{BuildHasher, RandomState};

use lsa_fseq::Sequence;
use lsa_tesla::{Channel, Rendered, Vehicle, render};
use tokio::sync::mpsc::UnboundedSender;

use crate::lights::{color_of, parse_vehicle, playable_channels};
use crate::protocol::{RosterEntry, ServerMsg, encode_track};
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
    channel: Option<u16>,
    /// Chosen by the host; kept when a new show loads if still playable.
    pinned: bool,
}

#[derive(Debug)]
struct LoadedShow {
    version: u32,
    name: String,
    vehicle: String,
    rendered: Rendered,
    playable: Vec<u16>,
    duration_ms: f64,
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
                channel: None,
                pinned: false,
            },
        );
        self.membership.insert(id, code);

        room.assign_unpinned();
        room.send_state(id);
        room.send_roster();
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
        room.send_roster();
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
            room.send_roster();
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
            room.send_roster();
        }
    }

    /// Host: loads a show, renders it for `vehicle`, and sends every phone its track.
    pub fn load_show(
        &mut self,
        host: MemberId,
        vehicle_name: &str,
        name: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        let vehicle: Vehicle =
            parse_vehicle(vehicle_name).ok_or_else(|| format!("unknown vehicle {vehicle_name}"))?;
        if bytes.len() > MAX_SHOW_BYTES {
            return Err("show file is too large".into());
        }
        let sequence = Sequence::parse(bytes).map_err(|e| e.to_string())?;
        let rendered = render(&sequence, vehicle);
        let version = room.show.as_ref().map_or(1, |s| s.version + 1);
        let show = LoadedShow {
            version,
            name: name.chars().take(80).collect(),
            vehicle: vehicle_name.to_owned(),
            playable: playable_channels(&rendered),
            duration_ms: sequence.duration().as_secs_f64() * 1000.0,
            rendered,
        };

        room.playback = Playback::Paused { position_ms: 0.0 };
        let message = show_msg(&show);
        send(&room.host_session.tx, message.clone());
        for member in room.members.values() {
            send(&member.session.tx, message.clone());
        }
        // Pins survive when the light is in the new show; every other phone is dealt again.
        for member in room.members.values_mut() {
            if !(member.pinned && member.channel.is_some_and(|c| show.playable.contains(&c))) {
                member.pinned = false;
                member.channel = None;
            }
        }
        room.show = Some(show);
        room.assign_unpinned();
        let ids: Vec<MemberId> = room.members.keys().copied().collect();
        for id in ids {
            room.send_role(id);
        }
        room.broadcast_playback();
        room.send_roster();
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

    /// Host: pins a phone to a light, or clears it.
    pub fn assign(
        &mut self,
        host: MemberId,
        member: MemberId,
        channel: Option<u16>,
    ) -> Result<(), String> {
        let room = self.hosted_room(host)?;
        let phone = room
            .members
            .get_mut(&member)
            .ok_or("no such phone in this room")?;
        if let Some(channel) = channel
            && !(1..=lsa_tesla::EXTENDED_CHANNELS as u16).contains(&channel)
        {
            return Err(format!("channel {channel} is out of range"));
        }
        phone.channel = channel;
        phone.pinned = channel.is_some();
        // Only this phone changes; the others keep their lights.
        room.assign_unpinned();
        room.send_role(member);
        room.send_roster();
        Ok(())
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

    /// Gives every phone without a light the playable light with the fewest phones (ties go to
    /// the higher-priority light). Phones that have a light keep it, so a phone joining or
    /// leaving never moves the others.
    fn assign_unpinned(&mut self) {
        let Some(show) = &self.show else {
            return;
        };
        let mut phones: HashMap<u16, usize> = show.playable.iter().map(|&c| (c, 0)).collect();
        for member in self.members.values() {
            if let Some(count) = member.channel.and_then(|c| phones.get_mut(&c)) {
                *count += 1;
            }
        }
        for member in self.members.values_mut().filter(|m| m.channel.is_none()) {
            let Some(&channel) = show.playable.iter().min_by_key(|c| phones[c]) else {
                return;
            };
            member.channel = Some(channel);
            *phones.entry(channel).or_default() += 1;
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
        self.send_role(id);
        send(&member.session.tx, self.playback_msg());
    }

    fn send_role(&self, id: MemberId) {
        let Some(member) = self.members.get(&id) else {
            return;
        };
        let (channel_count, label, color) = match (&self.show, member.channel) {
            (Some(show), Some(number)) => {
                let count = show.rendered.channel_count();
                let channel = Channel::from_index(usize::from(number) - 1, count);
                let vehicle = show.rendered.vehicle();
                (
                    count,
                    Some(vehicle.channel_name(channel)),
                    Some(color_of(vehicle, channel).to_owned()),
                )
            }
            _ => (0, None, None),
        };
        send(
            &member.session.tx,
            ServerMsg::Role {
                channel: member.channel.filter(|_| channel_count > 0),
                label,
                color,
            },
        );
        if let (Some(show), Some(number)) = (&self.show, member.channel)
            && let Some(levels) = show.rendered.channel_track(usize::from(number) - 1)
        {
            let step_ms = show.rendered.step_time().as_millis() as u8;
            let _ = member.session.tx.send(Outgoing::Binary(encode_track(
                show.version,
                number,
                step_ms,
                &govern(&levels, step_ms),
            )));
        }
    }

    fn send_roster(&self) {
        let members = self
            .members
            .iter()
            .map(|(&id, m)| RosterEntry {
                id,
                name: m.name.clone(),
                channel: m.channel,
                online: m.session.online,
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
        step_ms: show.rendered.step_time().as_millis() as u8,
        frame_count: show.rendered.frame_count(),
        duration_ms: show.duration_ms,
    }
}

fn send(tx: &UnboundedSender<Outgoing>, message: ServerMsg) {
    // A closed channel means the connection is going away; it is removed on disconnect.
    let _ = tx.send(Outgoing::Text(message));
}
