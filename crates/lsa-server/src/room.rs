//! Rooms: members, the loaded show, light assignment and playback.
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

#[derive(Debug)]
struct Member {
    tx: UnboundedSender<Outgoing>,
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
    host_tx: UnboundedSender<Outgoing>,
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
        send(&tx, ServerMsg::Created { room: code.clone() });
        self.by_code.insert(
            code.clone(),
            Room {
                host,
                host_tx: tx,
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
        let Some(room) = self.by_code.get_mut(&code) else {
            return Err(not_found());
        };
        send(
            &tx,
            ServerMsg::Joined {
                id,
                room: code.clone(),
            },
        );
        room.members.insert(
            id,
            Member {
                tx,
                name: name.map(|n| n.chars().take(32).collect()),
                channel: None,
                pinned: false,
            },
        );
        self.membership.insert(id, code);

        if let Some(show) = &room.show {
            send(&room.members[&id].tx, show_msg(show));
        }
        room.assign_unpinned();
        room.send_role(id);
        send(&room.members[&id].tx, room.playback_msg());
        room.send_roster();
        Ok(())
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
                    &phone.tx,
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
        room.show = Some(show);
        send(&room.host_tx, message.clone());
        for member in room.members.values() {
            send(&member.tx, message.clone());
        }
        for member in room.members.values_mut() {
            if member.pinned
                && !room
                    .show
                    .as_ref()
                    .is_some_and(|s| member.channel.is_some_and(|c| s.playable.contains(&c)))
            {
                member.pinned = false;
            }
        }
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
        send(&self.host_tx, message.clone());
        for member in self.members.values() {
            send(&member.tx, message.clone());
        }
    }

    /// Gives every unpinned phone a light: playable lights in priority order, repeating once
    /// every light has a phone.
    fn assign_unpinned(&mut self) {
        let Some(show) = &self.show else {
            return;
        };
        if show.playable.is_empty() {
            for member in self.members.values_mut().filter(|m| !m.pinned) {
                member.channel = None;
            }
            return;
        }
        let unpinned = self.members.values_mut().filter(|m| !m.pinned);
        for (slot, member) in unpinned.enumerate() {
            member.channel = Some(show.playable[slot % show.playable.len()]);
        }
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
            &member.tx,
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
            let _ = member.tx.send(Outgoing::Binary(encode_track(
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
            })
            .collect();
        send(&self.host_tx, ServerMsg::Roster { members });
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
