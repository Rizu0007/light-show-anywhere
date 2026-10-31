//! One server's limits: open rooms, decoded show data, and shows it cannot play faithfully.

use lsa_fseq::{Sequence, SparseRange};
use lsa_server::protocol::ServerMsg;
use lsa_server::room::{Limits, Outgoing, Rooms};
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
    // A 500-frame show is 24,000 bytes decoded and needs twice that while it is built: room for
    // one show, not two.
    let mut rooms = Rooms::with_limits(Limits {
        show_bytes: 60_000,
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
fn shows_being_built_hold_their_share_of_the_budget() {
    let mut rooms = Rooms::with_limits(Limits {
        show_bytes: 60_000,
        ..Limits::default()
    });
    host(&mut rooms, 1).unwrap();
    host(&mut rooms, 2).unwrap();
    let file = show(500);
    // Room 1's show is still rendering (outside the lock): room 2 cannot take its memory.
    let building = rooms.begin_load(1, "model-3y", "A", &file, &[]).unwrap();
    let refused = rooms.begin_load(2, "model-3y", "B", &file, &[]);
    assert!(refused.unwrap_err().contains("full"));
    // A failed build gives the reservation back.
    rooms
        .finish_load(building, Err("broken".into()))
        .unwrap_err();
    let second = rooms.begin_load(2, "model-3y", "B", &file, &[]).unwrap();
    let built = second.build(&file, &[]);
    rooms.finish_load(second, built).unwrap();
}

#[test]
fn a_load_that_finishes_late_does_not_replace_a_newer_show() {
    let (tx, mut rx) = unbounded_channel();
    let mut rooms = Rooms::default();
    rooms.create(1, tx).unwrap();
    let file = show(10);
    let older = rooms
        .begin_load(1, "model-3y", "Older", &file, &[])
        .unwrap();
    let newer = rooms
        .begin_load(1, "model-3y", "Newer", &file, &[])
        .unwrap();
    let built = newer.build(&file, &[]);
    rooms.finish_load(newer, built).unwrap();
    let built = older.build(&file, &[]);
    rooms.finish_load(older, built).unwrap();

    let mut shows = Vec::new();
    while let Ok(message) = rx.try_recv() {
        if let Outgoing::Text(ServerMsg::Show { name, version, .. }) = message {
            shows.push((name, version));
        }
    }
    assert_eq!(shows, [("Newer".to_owned(), 2)]);
}

#[test]
fn a_load_for_an_ended_party_is_dropped() {
    let mut rooms = Rooms::default();
    host(&mut rooms, 1).unwrap();
    let file = show(10);
    let load = rooms.begin_load(1, "model-3y", "A", &file, &[]).unwrap();
    rooms.leave(1);
    let built = load.build(&file, &[]);
    assert!(rooms.finish_load(load, built).is_err());
    assert!(rooms.is_empty());
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
