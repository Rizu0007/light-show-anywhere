//! Messages exchanged over the WebSocket.
//!
//! Text frames carry JSON tagged by `t`. Binary frames carry show data:
//! - host → server: a raw `.fseq` file, right after a [`ClientMsg::Load`];
//! - server → phone: that phone's light track (see [`encode_track`]).

use serde::{Deserialize, Serialize};

/// Messages from browsers.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ClientMsg {
    /// Clock sync ping; `c0` is the client's clock when sent.
    Sync {
        /// Client time in milliseconds.
        c0: f64,
    },
    /// Create a room and become its host.
    Create,
    /// Join a room as a phone.
    Join {
        /// Room code.
        room: String,
        /// Optional display name.
        #[serde(default)]
        name: Option<String>,
    },
    /// Host: the next binary frame is a show for this vehicle: one `.fseq`, or one per car of a
    /// fleet show back to back.
    Load {
        /// `model-s`, `model-x`, `model-3y` or `cybertruck`.
        vehicle: String,
        /// Show name for display.
        name: String,
        /// Byte length of each car's file, car 1 first; empty for a single show.
        #[serde(default)]
        sizes: Vec<u32>,
    },
    /// Host: start playing from `position_ms`.
    Play {
        /// Show position to start from.
        position_ms: f64,
    },
    /// Host: pause.
    Pause,
    /// Host: jump to `position_ms`, keeping the play/pause state.
    Seek {
        /// New show position.
        position_ms: f64,
    },
    /// Take back a place after a dropped connection, using the token from
    /// [`ServerMsg::Created`] or [`ServerMsg::Joined`].
    Resume {
        /// Session token.
        token: String,
    },
    /// Leave the room now (the host ends the party). A dropped connection instead keeps its
    /// place for a while so it can [`ClientMsg::Resume`].
    Leave,
    /// Host: measure the speaker delay with phones' microphones (see
    /// [`ServerMsg::Calibrate`]).
    Calibrate,
    /// Phone: how late the calibration tones arrived, or `None` if they were not heard.
    Heard {
        /// Milliseconds after the scheduled time.
        delay_ms: Option<f64>,
    },
    /// Host: give a phone a specific light, or `None` to clear it.
    Assign {
        /// Member id.
        member: u64,
        /// 1-based Tesla channel number.
        channel: Option<u16>,
        /// Car of a fleet show, from 1 (default 1).
        #[serde(default)]
        car: Option<u8>,
        /// With a layout: the spot (index into it) instead of a light.
        #[serde(default)]
        spot: Option<u16>,
    },
    /// Host: where phones stand and which light each place plays; empty for the car shape.
    Layout {
        /// Places, in the order phones are dealt to them.
        spots: Vec<Spot>,
    },
    /// Phone: how it is doing, shown to the host in the roster. Sent when it changes.
    Status(PhoneHealth),
}

/// A place in a layout: where a phone stands (0–1 across and down, as the audience sees it) and
/// the light it plays.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize, Serialize)]
pub struct Spot {
    /// Across, 0 (audience's left) to 1.
    pub x: f32,
    /// Down, 0 (back) to 1 (front).
    pub y: f32,
    /// Car of a fleet show, from 1.
    pub car: u8,
    /// 1-based Tesla channel.
    pub channel: u16,
}

/// What a phone reports about itself, so the host can spot phones that will not play well.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhoneHealth {
    /// The phone's clock is synced to the server's.
    pub synced: bool,
    /// Best clock-sync round trip in milliseconds, if any.
    #[serde(default)]
    pub rtt_ms: Option<f64>,
    /// The screen is kept awake; `None` where the browser cannot.
    #[serde(default)]
    pub awake: Option<bool>,
    /// The flashlight works; `None` when the guest did not ask for it.
    #[serde(default)]
    pub torch: Option<bool>,
    /// The page is on HTTPS (needed to keep the screen awake and use the flashlight).
    pub secure: bool,
    /// Times the connection dropped and came back.
    #[serde(default)]
    pub reconnects: u32,
}

/// Messages to browsers.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "t", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ServerMsg {
    /// Clock sync reply; `s1` is the server clock when the ping arrived.
    Sync {
        /// Echo of the client's `c0`.
        c0: f64,
        /// Server time in milliseconds.
        s1: f64,
    },
    /// Room created; the sender is its host.
    Created {
        /// Room code to share.
        room: String,
        /// Secret for [`ClientMsg::Resume`].
        token: String,
    },
    /// Joined a room.
    Joined {
        /// This member's id.
        id: u64,
        /// Room code.
        room: String,
        /// Secret for [`ClientMsg::Resume`].
        token: String,
    },
    /// Back in the room after [`ClientMsg::Resume`]; the room's state follows.
    Resumed {
        /// This member's id.
        id: u64,
        /// Room code.
        room: String,
        /// Whether this connection is the host.
        host: bool,
    },
    /// The token is unknown: the place was given up or the room closed. Join or create again.
    Expired,
    /// The room's current show.
    Show {
        /// Increases every time a new show is loaded.
        version: u32,
        /// Display name.
        name: String,
        /// Vehicle the show is emulated for.
        vehicle: String,
        /// Cars in the show (1 unless it is a fleet show).
        cars: u8,
        /// Show length in milliseconds.
        duration_ms: f64,
    },
    /// Phones: every place of the room's layout as `[x, y]`, so a phone can show where it stands
    /// (see [`ServerMsg::Role`]'s `spot`). Empty for the car shape.
    Layout {
        /// Places, in layout order.
        spots: Vec<[f32; 2]>,
    },
    /// The light this phone plays.
    Role {
        /// With a layout: this phone's place (index into it).
        spot: Option<u16>,
        /// Car of a fleet show, from 1, or `None` while waiting for a light.
        car: Option<u8>,
        /// 1-based Tesla channel, or `None` while waiting for a light.
        channel: Option<u16>,
        /// Readable light name.
        label: Option<String>,
        /// Light colour: `white`, `amber` or `red`.
        color: Option<String>,
    },
    /// Playback state. Position at server time `s` is `s - t0` while playing.
    Playback {
        /// Whether the show is running.
        playing: bool,
        /// Server time at which the show position is 0 (only while playing).
        t0: Option<f64>,
        /// Position when paused (or when the state was sent).
        position_ms: f64,
    },
    /// Speaker calibration: the host plays `tones` tone sweeps, the first at server time `at`
    /// and then every `gap_ms`; phones with a microphone listen and answer with
    /// [`ClientMsg::Heard`].
    Calibrate {
        /// Server time of the first tone.
        at: f64,
        /// Number of tones.
        tones: u32,
        /// Milliseconds between tones.
        gap_ms: f64,
    },
    /// Host only: what one phone measured.
    Heard {
        /// Member id.
        member: u64,
        /// Milliseconds after the scheduled time, or `None` if not heard.
        delay_ms: Option<f64>,
    },
    /// Host only: every phone in the room.
    Roster {
        /// Phones in join order.
        members: Vec<RosterEntry>,
    },
    /// Something went wrong with the last request.
    Error {
        /// What happened.
        message: String,
    },
}

/// One phone in the roster.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    /// Member id.
    pub id: u64,
    /// Display name, if given.
    pub name: Option<String>,
    /// Assigned place in the layout, if there is one.
    pub spot: Option<u16>,
    /// Assigned car, from 1.
    pub car: Option<u8>,
    /// Assigned 1-based channel.
    pub channel: Option<u16>,
    /// Whether the phone is connected (offline phones keep their light for a while).
    pub online: bool,
    /// The phone's last [`ClientMsg::Status`], if it sent one.
    pub health: Option<PhoneHealth>,
}

/// Magic bytes at the start of a light-track frame.
pub const TRACK_MAGIC: [u8; 4] = *b"LSAT";
/// Bytes before the levels in a light-track frame.
pub const TRACK_HEADER_LEN: usize = 12;

/// Encodes a phone's light track.
///
/// Layout: `LSAT` · show version (u32 LE) · channel (u16 LE, 1-based) · step ms (u8) ·
/// car (u8, from 1) · one level byte per frame (0 = off, 255 = full).
#[must_use]
pub fn encode_track(version: u32, car: u8, channel: u16, step_ms: u8, levels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(TRACK_HEADER_LEN + levels.len());
    out.extend_from_slice(&TRACK_MAGIC);
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&channel.to_le_bytes());
    out.push(step_ms);
    out.push(car);
    out.extend_from_slice(levels);
    out
}
