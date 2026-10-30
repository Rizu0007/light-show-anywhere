//! Tesla's 5-car example show ("The Arrival") as one fleet: scripts/fetch-tesla-example.sh
//! downloads it; without it the test skips, unless `LSA_REQUIRE_SHOWS` is set (CI).

use lsa_server::protocol::ServerMsg;
use lsa_server::room::{Outgoing, Rooms};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

const CARS: usize = 5;

fn car_files() -> Option<Vec<Vec<u8>>> {
    let folder = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../shows/tesla/lightshow_example_3_The_Arrival_5_Car"
    );
    let files: Option<Vec<_>> = (1..=CARS)
        .map(|n| std::fs::read(format!("{folder}/Car #{n}/lightshow.fseq")).ok())
        .collect();
    if files.is_none() {
        assert!(
            std::env::var_os("LSA_REQUIRE_SHOWS").is_none(),
            "{folder} not found; run scripts/fetch-tesla-example.sh"
        );
        eprintln!("skipped: {folder} not found");
    }
    files
}

/// The role and track a phone was sent, skipping other messages.
fn role_and_track(rx: &mut UnboundedReceiver<Outgoing>) -> (u8, u16, Vec<u8>) {
    let mut role = None;
    while let Ok(message) = rx.try_recv() {
        match message {
            Outgoing::Text(ServerMsg::Role {
                car: Some(car),
                channel: Some(channel),
                ..
            }) => role = Some((car, channel)),
            Outgoing::Binary(track) => {
                let (car, channel) = role.expect("track before role");
                return (car, channel, track);
            }
            Outgoing::Text(_) => {}
        }
    }
    panic!("no track sent");
}

#[test]
fn teslas_five_car_example_plays_as_one_fleet() {
    let Some(files) = car_files() else {
        return;
    };
    let mut rooms = Rooms::default();
    let (host_tx, _host_rx) = unbounded_channel();
    let code = rooms.create(1, host_tx);
    let sizes: Vec<u32> = files.iter().map(|f| f.len() as u32).collect();
    rooms
        .load_show(1, "model-s", "The Arrival", &files.concat(), &sizes)
        .unwrap();

    // The first five phones get the same headlight on each of the five cars.
    let mut phones = Vec::new();
    for id in 2..2 + CARS as u64 {
        let (tx, mut rx) = unbounded_channel();
        rooms.join(id, &code, None, tx).unwrap();
        phones.push(role_and_track(&mut rx));
    }
    let cars: Vec<u8> = phones.iter().map(|(car, ..)| *car).collect();
    assert_eq!(cars, [1, 2, 3, 4, 5]);
    assert!(phones.iter().all(|(_, channel, _)| *channel == phones[0].1));

    // Cars 1 and 3 run at 25 ms per frame, the others at 50 ms, over the same 110 s song.
    for (car, _, track) in &phones {
        let step_ms = track[10];
        assert_eq!(track[11], *car);
        assert_eq!(step_ms, if matches!(car, 1 | 3) { 25 } else { 50 });
        let frames = track.len() - lsa_server::protocol::TRACK_HEADER_LEN;
        assert_eq!(frames * usize::from(step_ms), 110_250);
    }
}
