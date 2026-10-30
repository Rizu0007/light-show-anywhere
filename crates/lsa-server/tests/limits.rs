//! One server's limits: open rooms, decoded show data, and shows it cannot play faithfully.

use lsa_fseq::{Sequence, SparseRange};
use lsa_server::room::{Limits, Rooms};
use tokio::sync::mpsc::unbounded_channel;

/// A 48-channel show of `frames` frames (48 bytes each once decoded).
fn show(frames: usize) -> Vec<u8> {
    Sequence::from_frames(48, 20, vec![0; 48 * frames])
        .unwrap()
        .to_bytes()
        .unwrap()
}

fn host(rooms: &mut Rooms, id: u64) -> Result<String, String> {
    rooms.create(id, unbounded_channel().0)
}

#[test]
fn rooms_are_limited_and_freed_when_a_party_ends() {
    let mut rooms = Rooms::with_limits(Limits {
        rooms: 2,
        ..Limits::default()
    });
    host(&mut rooms, 1).unwrap();
    host(&mut rooms, 2).unwrap();
    assert!(host(&mut rooms, 3).unwrap_err().contains("full"));
    rooms.leave(1);
    host(&mut rooms, 3).unwrap();
}

#[test]
fn loaded_shows_share_one_budget() {
    // Room for one 500-frame show (24,000 bytes decoded), not two.
    let mut rooms = Rooms::with_limits(Limits {
        show_bytes: 36_000,
        ..Limits::default()
    });
    host(&mut rooms, 1).unwrap();
    host(&mut rooms, 2).unwrap();
    rooms
        .load_show(1, "model-3y", "A", &show(500), &[])
        .unwrap();
    let refused = rooms.load_show(2, "model-3y", "B", &show(500), &[]);
    assert!(refused.unwrap_err().contains("full"));
    // A room replacing its own show does not count the old one.
    rooms
        .load_show(1, "model-3y", "A2", &show(500), &[])
        .unwrap();
    // Once the first party ends, the second has room.
    rooms.leave(1);
    rooms
        .load_show(2, "model-3y", "B", &show(500), &[])
        .unwrap();
}

#[test]
fn shows_with_moved_channels_are_refused() {
    let mut rooms = Rooms::default();
    host(&mut rooms, 1).unwrap();
    let with_range = |start_channel| {
        let mut show = Sequence::from_frames(48, 20, vec![0; 48 * 10]).unwrap();
        show.header_mut().sparse_ranges = vec![SparseRange {
            start_channel,
            channel_count: 48,
        }];
        show.to_bytes().unwrap()
    };
    let refused = rooms.load_show(1, "model-3y", "Moved", &with_range(10), &[]);
    assert!(refused.unwrap_err().contains("sparse"));
    rooms
        .load_show(1, "model-3y", "Same", &with_range(0), &[])
        .unwrap();
}
