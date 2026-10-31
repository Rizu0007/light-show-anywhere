//! The host gives phones lights by hand, including single LEDs of a Cybertruck light bar.

use lsa_fseq::Sequence;
use lsa_server::protocol::{ServerMsg, TRACK_HEADER_LEN};
use lsa_server::room::{Outgoing, Rooms, Slot};
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

/// Rear light bar LED 1 (channel 111): never handed out automatically.
const REAR_BAR_FIRST: u16 = 111;

fn drain(rx: &mut UnboundedReceiver<Outgoing>) -> Vec<Outgoing> {
    std::iter::from_fn(|| rx.try_recv().ok()).collect()
}

#[test]
fn a_phone_can_play_one_led_of_a_light_bar() {
    // 200 channels, 50 frames: the rear bar's first LED on full, everything else off but the
    // left outer main beam (so phones are dealt a light automatically).
    let mut data = vec![0u8; 200 * 50];
    for frame in data.as_chunks_mut::<200>().0 {
        frame[0] = 255;
        frame[usize::from(REAR_BAR_FIRST) - 1] = 255;
    }
    let show = Sequence::from_frames(200, 20, data)
        .unwrap()
        .to_bytes()
        .unwrap();

    let mut rooms = Rooms::default();
    let code = rooms.create(1, unbounded_channel().0).unwrap();
    let (tx, mut phone) = unbounded_channel();
    rooms.join(2, &code, None, tx).unwrap();
    rooms
        .load_show(1, "cybertruck", "Bars", &show, &[])
        .unwrap();
    drain(&mut phone);

    let slot = Slot {
        car: 1,
        channel: REAR_BAR_FIRST,
    };
    rooms.assign(1, 2, Some(slot), None).unwrap();
    let messages = drain(&mut phone);
    let role = messages.iter().find_map(|m| match m {
        Outgoing::Text(ServerMsg::Role {
            channel,
            label,
            color,
            ..
        }) => Some((*channel, label.clone(), color.clone())),
        _ => None,
    });
    assert_eq!(
        role,
        Some((
            Some(REAR_BAR_FIRST),
            Some("Rear Light Bar 1".into()),
            Some("red".into())
        ))
    );
    let track = messages
        .iter()
        .find_map(|m| match m {
            Outgoing::Binary(bytes) => Some(bytes),
            Outgoing::Text(_) => None,
        })
        .expect("the phone gets the LED's track");
    assert_eq!(
        u16::from_le_bytes([track[8], track[9]]),
        REAR_BAR_FIRST,
        "track for the LED's channel"
    );
    assert!(
        track[TRACK_HEADER_LEN..].contains(&255),
        "the LED lights up"
    );
}
