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
    /// Host: the next binary frame is a show for this vehicle.
    Load {
        /// `model-s`, `model-x`, `model-3y` or `cybertruck`.
        vehicle: String,
        /// Show name for display.
        name: String,
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
    /// Host: give a phone a specific light (1-based channel), or `None` to clear it.
    Assign {
        /// Member id.
        member: u64,
        /// 1-based Tesla channel number.
        channel: Option<u16>,
    },
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
    },
    /// Joined a room.
    Joined {
        /// This member's id.
        id: u64,
        /// Room code.
        room: String,
    },
    /// The room's current show.
    Show {
        /// Increases every time a new show is loaded.
        version: u32,
        /// Display name.
        name: String,
        /// Vehicle the show is emulated for.
        vehicle: String,
        /// Milliseconds per frame.
        step_ms: u8,
        /// Number of frames.
        frame_count: usize,
        /// Show length in milliseconds.
        duration_ms: f64,
    },
    /// The light this phone plays.
    Role {
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RosterEntry {
    /// Member id.
    pub id: u64,
    /// Display name, if given.
    pub name: Option<String>,
    /// Assigned 1-based channel.
    pub channel: Option<u16>,
}

/// Magic bytes at the start of a light-track frame.
pub const TRACK_MAGIC: [u8; 4] = *b"LSAT";
/// Bytes before the levels in a light-track frame.
pub const TRACK_HEADER_LEN: usize = 12;

/// Encodes a phone's light track.
///
/// Layout: `LSAT` · show version (u32 LE) · channel (u16 LE, 1-based) · step ms (u8) ·
/// reserved (u8) · one level byte per frame (0 = off, 255 = full).
#[must_use]
pub fn encode_track(version: u32, channel: u16, step_ms: u8, levels: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(TRACK_HEADER_LEN + levels.len());
    out.extend_from_slice(&TRACK_MAGIC);
    out.extend_from_slice(&version.to_le_bytes());
    out.extend_from_slice(&channel.to_le_bytes());
    out.push(step_ms);
    out.push(0);
    out.extend_from_slice(levels);
    out
}
