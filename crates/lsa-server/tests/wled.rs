//! WLED output: DDP packets, colours, config checks, and a running server driving a stand-in
//! WLED device (a UDP socket).

use std::sync::Arc;
use std::time::Duration;

use futures_util::SinkExt;
use lsa_fseq::Sequence;
use lsa_server::wled::{self, Config, Device, Run, ddp_packets, rgb};
use lsa_server::{AppState, app};
use lsa_tesla::{Channel, Light};
use serde_json::json;
use tokio::net::UdpSocket;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;

#[test]
fn frames_split_into_ddp_packets_and_the_last_one_pushes() {
    let frame: Vec<u8> = (0..600 * 3).map(|i| i as u8).collect();
    let packets = ddp_packets(&frame, 7);
    assert_eq!(packets.len(), 2);
    // Version 1, sequence, RGB 8-bit, output 1, offset, length (big-endian).
    assert_eq!(packets[0][..10], [0x40, 7, 0x0B, 1, 0, 0, 0, 0, 0x05, 0xA0]);
    assert_eq!(
        packets[1][..10],
        [0x41, 7, 0x0B, 1, 0, 0, 0x05, 0xA0, 0x01, 0x68]
    );
    assert_eq!([&packets[0][10..], &packets[1][10..]].concat(), frame);
}

#[test]
fn colours_match_the_phones() {
    assert_eq!(rgb("red", 255), [255, 43, 43]);
    assert_eq!(rgb("amber", 255), [255, 174, 26]);
    assert_eq!(rgb("white", 0), [0, 0, 0]);
    assert_eq!(rgb("white", 128), [128, 122, 110]);
}

#[test]
fn configs_are_checked() {
    let run = |start, count, channel, per_led| Run {
        start,
        count,
        car: 1,
        channel,
        per_led,
    };
    let config = |runs: Vec<Run>| Config {
        fps: 40,
        devices: vec![Device {
            address: "127.0.0.1".into(),
            leds: 60,
            map: runs,
        }],
    };
    assert!(config(vec![run(0, 60, 47, true)]).check().is_ok());
    assert!(
        config(vec![run(50, 20, 1, false)]).check().is_err(),
        "past the strip"
    );
    assert!(
        config(vec![run(0, 60, 150, true)]).check().is_err(),
        "past channel 200"
    );
    assert!(
        config(vec![run(0, 10, 0, false)]).check().is_err(),
        "channel 0"
    );
    let parsed: Result<Config, _> = serde_json::from_value(json!({"devices": [], "colour": "red"}));
    assert!(parsed.is_err(), "unknown fields are refused");
}

/// A show with the brake light on throughout.
fn brake_show() -> Vec<u8> {
    let brake = Channel::Light(Light::Brake).index().unwrap();
    let mut data = vec![0u8; 48 * 500];
    for frame in data.as_chunks_mut::<48>().0 {
        frame[brake] = 255;
    }
    Sequence::from_frames(48, 20, data)
        .unwrap()
        .to_bytes()
        .unwrap()
}

/// The next frame the stand-in device receives, or `None` within `wait`.
async fn next_frame(device: &UdpSocket, wait: Duration) -> Option<Vec<u8>> {
    let mut buffer = [0u8; 2048];
    let received = tokio::time::timeout(wait, device.recv(&mut buffer)).await;
    received.ok().map(|n| buffer[10..n.unwrap()].to_vec())
}

#[tokio::test]
async fn strips_play_the_show_on_air_and_stop_when_it_ends() {
    let device = UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let brake = Channel::Light(Light::Brake).number().unwrap() as u16;
    let config = Config {
        fps: 40,
        devices: vec![Device {
            address: device.local_addr().unwrap().to_string(),
            leds: 8,
            map: vec![Run {
                start: 0,
                count: 4,
                car: 1,
                channel: brake,
                per_led: false,
            }],
        }],
    };
    let state = Arc::new(AppState::default());
    tokio::spawn(wled::run(Arc::clone(&state), config));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}/ws", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app(state, None)).await });

    let (mut host, _) = connect_async(&url).await.unwrap();
    let send = |m: serde_json::Value| Message::Text(m.to_string().into());
    host.send(send(json!({"t": "create"}))).await.unwrap();
    host.send(send(
        json!({"t": "load", "vehicle": "model-3y", "name": "Brake"}),
    ))
    .await
    .unwrap();
    host.send(Message::Binary(brake_show().into()))
        .await
        .unwrap();
    assert!(
        next_frame(&device, Duration::from_millis(400))
            .await
            .is_none(),
        "nothing is sent before play"
    );

    host.send(send(json!({"t": "play", "positionMs": 0})))
        .await
        .unwrap();
    // Once the governor's ramp is done the brake LEDs are full red; the rest stay dark.
    let lit = async {
        loop {
            let frame = next_frame(&device, Duration::from_secs(5)).await.unwrap();
            if frame[..12] == [255, 43, 43].repeat(4)[..] {
                return frame;
            }
        }
    };
    let frame = tokio::time::timeout(Duration::from_secs(5), lit)
        .await
        .expect("brake LEDs never lit");
    assert_eq!(frame.len(), 8 * 3);
    assert!(
        frame[12..].iter().all(|&c| c == 0),
        "unmapped LEDs stay dark"
    );

    // The party ends: sending stops, so the strips go back to their own effects.
    host.send(send(json!({"t": "leave"}))).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    while next_frame(&device, Duration::from_millis(50))
        .await
        .is_some()
    {}
    assert!(
        next_frame(&device, Duration::from_millis(400))
            .await
            .is_none(),
        "frames still sent after the party ended"
    );
}

#[test]
fn the_documented_example_config_loads() {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../docs/wled.example.json");
    let config = Config::load(path.as_ref()).unwrap();
    assert_eq!(config.devices.len(), 2);
    assert!(config.devices[1].map[0].per_led);
}
