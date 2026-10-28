//! End-to-end tests over real `WebSocket` connections: a host and phones talk to a running server.

use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use lsa_fseq::Sequence;
use lsa_server::protocol::{TRACK_HEADER_LEN, TRACK_MAGIC};
use lsa_server::{AppState, app};
use lsa_tesla::{Channel, Light, Side, Vehicle, render};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const TIMEOUT: Duration = Duration::from_secs(5);

async fn start_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        axum::serve(listener, app(Arc::new(AppState::default()), None))
            .await
            .unwrap();
    });
    format!("ws://{addr}/ws")
}

struct Client {
    ws: WebSocketStream<MaybeTlsStream<TcpStream>>,
}

impl Client {
    async fn connect(url: &str) -> Self {
        let (ws, _) = connect_async(url).await.unwrap();
        Self { ws }
    }

    async fn send(&mut self, message: Value) {
        self.ws
            .send(Message::Text(message.to_string().into()))
            .await
            .unwrap();
    }

    async fn send_binary(&mut self, bytes: Vec<u8>) {
        self.ws.send(Message::Binary(bytes.into())).await.unwrap();
    }

    async fn next(&mut self) -> Message {
        tokio::time::timeout(TIMEOUT, self.ws.next())
            .await
            .expect("timed out waiting for a message")
            .expect("connection closed")
            .unwrap()
    }

    /// Next JSON message with tag `t`, skipping others (including binary frames).
    async fn expect(&mut self, t: &str) -> Value {
        loop {
            if let Message::Text(text) = self.next().await {
                let value: Value = serde_json::from_str(&text).unwrap();
                if value["t"] == t {
                    return value;
                }
            }
        }
    }

    /// Next binary frame, skipping JSON messages.
    async fn expect_binary(&mut self) -> Vec<u8> {
        loop {
            if let Message::Binary(bytes) = self.next().await {
                return bytes.to_vec();
            }
        }
    }
}

/// A 48-channel show where the left outer beam, brake light and left front turn are used.
fn test_show() -> Vec<u8> {
    let channel = |light| Channel::Light(light).index().unwrap();
    let beam = channel(Light::OuterMainBeam(Side::Left));
    let brake = channel(Light::Brake);
    let turn = channel(Light::FrontTurn(Side::Left));
    let mut data = vec![0u8; 48 * 100];
    for (i, frame) in data.as_chunks_mut::<48>().0.iter_mut().enumerate() {
        frame[beam] = if i % 2 == 0 { 255 } else { 0 };
        frame[brake] = 255;
        frame[turn] = if i >= 50 { 255 } else { 0 };
    }
    Sequence::from_frames(48, 20, data)
        .unwrap()
        .to_bytes()
        .unwrap()
}

async fn host_with_show(url: &str) -> (Client, String) {
    let mut host = Client::connect(url).await;
    host.send(json!({"t": "create"})).await;
    let room = host.expect("created").await["room"]
        .as_str()
        .unwrap()
        .to_owned();
    host.send(json!({"t": "load", "vehicle": "model-3y", "name": "Test"}))
        .await;
    host.send_binary(test_show()).await;
    host.expect("show").await;
    (host, room)
}

#[tokio::test]
async fn clock_sync_echoes_and_stamps() {
    let url = start_server().await;
    let mut client = Client::connect(&url).await;
    client.send(json!({"t": "sync", "c0": 1234.5})).await;
    let reply = client.expect("sync").await;
    assert_eq!(reply["c0"], 1234.5);
    assert!(reply["s1"].as_f64().unwrap() >= 0.0);
}

#[tokio::test]
async fn room_codes_and_bad_joins() {
    let url = start_server().await;
    let mut host = Client::connect(&url).await;
    host.send(json!({"t": "create"})).await;
    let room = host.expect("created").await["room"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(room.len(), 4);
    assert!(
        room.chars()
            .all(|c| c.is_ascii_uppercase() && !"IO".contains(c))
    );

    let mut phone = Client::connect(&url).await;
    phone.send(json!({"t": "join", "room": "ZZZZ"})).await;
    let error = phone.expect("error").await;
    assert!(error["message"].as_str().unwrap().contains("not found"));

    // Codes are case-insensitive; before a show loads the phone has no light yet.
    phone
        .send(json!({"t": "join", "room": room.to_lowercase()}))
        .await;
    phone.expect("joined").await;
    let role = phone.expect("role").await;
    assert_eq!(role["channel"], Value::Null);
    assert_eq!(phone.expect("playback").await["playing"], false);
}

#[tokio::test]
async fn phones_get_lights_and_tracks_in_priority_order() {
    let url = start_server().await;
    let (mut host, room) = host_with_show(&url).await;

    let mut first = Client::connect(&url).await;
    first
        .send(json!({"t": "join", "room": room, "name": "Ana"}))
        .await;
    first.expect("show").await;
    let role = first.expect("role").await;
    assert_eq!(role["channel"], 1);
    assert_eq!(role["label"], "Left Outer Main Beam");
    assert_eq!(role["color"], "white");

    // The track equals the engine's own emulation of that channel.
    let track = first.expect_binary().await;
    assert_eq!(track[..4], TRACK_MAGIC);
    assert_eq!(u16::from_le_bytes([track[8], track[9]]), 1);
    assert_eq!(track[10], 20);
    let expected = render(&Sequence::parse(&test_show()).unwrap(), Vehicle::Model3Y)
        .channel_track(0)
        .unwrap();
    assert_eq!(track[TRACK_HEADER_LEN..], expected[..]);

    // Next phone gets the next used light in priority order (front turn before brake).
    let mut second = Client::connect(&url).await;
    second.send(json!({"t": "join", "room": room})).await;
    let role = second.expect("role").await;
    assert_eq!(role["label"], "Left Front Turn");
    assert_eq!(role["color"], "amber");

    let mut third = Client::connect(&url).await;
    third.send(json!({"t": "join", "room": room})).await;
    assert_eq!(third.expect("role").await["label"], "Brake Lights");

    // Only three lights are used, so the fourth phone doubles up on the first.
    let mut fourth = Client::connect(&url).await;
    fourth.send(json!({"t": "join", "room": room})).await;
    assert_eq!(fourth.expect("role").await["channel"], 1);

    let roster = loop {
        let roster = host.expect("roster").await;
        if roster["members"].as_array().unwrap().len() == 4 {
            break roster;
        }
    };
    assert_eq!(roster["members"][0]["name"], "Ana");
}

#[tokio::test]
async fn playback_commands_reach_every_phone() {
    let url = start_server().await;
    let (mut host, room) = host_with_show(&url).await;
    let mut phone = Client::connect(&url).await;
    phone.send(json!({"t": "join", "room": room})).await;
    phone.expect("playback").await;

    phone.send(json!({"t": "sync", "c0": 0})).await;
    let before = phone.expect("sync").await["s1"].as_f64().unwrap();
    host.send(json!({"t": "play", "positionMs": 500})).await;
    let playing = phone.expect("playback").await;
    assert_eq!(playing["playing"], true);
    // Phones hold at the start position during the lead instead of playing earlier frames.
    assert_eq!(playing["positionMs"], 500.0);
    // t0 = now + 1000 ms lead - 500 ms position.
    let t0 = playing["t0"].as_f64().unwrap();
    assert!(
        (t0 - (before + 500.0)).abs() < 200.0,
        "t0 {t0}, before {before}"
    );
    host.expect("playback").await;

    host.send(json!({"t": "pause"})).await;
    let paused = phone.expect("playback").await;
    assert_eq!(paused["playing"], false);
    assert_eq!(paused["t0"], Value::Null);

    host.send(json!({"t": "seek", "positionMs": 1500})).await;
    assert_eq!(phone.expect("playback").await["positionMs"], 1500.0);

    // Phones cannot control playback.
    phone.send(json!({"t": "play", "positionMs": 0})).await;
    let error = phone.expect("error").await;
    assert!(error["message"].as_str().unwrap().contains("host"));
}

#[tokio::test]
async fn host_can_pin_a_phone_to_a_light() {
    let url = start_server().await;
    let (mut host, room) = host_with_show(&url).await;
    let mut phone = Client::connect(&url).await;
    phone.send(json!({"t": "join", "room": room})).await;
    let id = phone.expect("joined").await["id"].as_u64().unwrap();
    phone.expect("role").await;

    let brake = Channel::Light(Light::Brake).number().unwrap();
    host.send(json!({"t": "assign", "member": id, "channel": brake}))
        .await;
    let role = phone.expect("role").await;
    assert_eq!(role["channel"], brake);
    assert_eq!(role["color"], "red");
    let track = phone.expect_binary().await;
    assert!(track[TRACK_HEADER_LEN..].iter().all(|&level| level == 255));
}

#[tokio::test]
async fn bad_uploads_are_rejected() {
    let url = start_server().await;
    let mut host = Client::connect(&url).await;
    host.send(json!({"t": "create"})).await;
    host.expect("created").await;

    host.send_binary(test_show()).await;
    assert!(
        host.expect("error").await["message"]
            .as_str()
            .unwrap()
            .contains("load")
    );

    host.send(json!({"t": "load", "vehicle": "model-3y", "name": "Broken"}))
        .await;
    host.send_binary(b"not a show".to_vec()).await;
    host.expect("error").await;

    host.send(json!({"t": "load", "vehicle": "bicycle", "name": "x"}))
        .await;
    host.send_binary(test_show()).await;
    assert!(
        host.expect("error").await["message"]
            .as_str()
            .unwrap()
            .contains("vehicle")
    );
}

#[tokio::test]
async fn phones_are_told_when_the_host_leaves() {
    let url = start_server().await;
    let (host, room) = host_with_show(&url).await;
    let mut phone = Client::connect(&url).await;
    phone.send(json!({"t": "join", "room": room})).await;
    phone.expect("playback").await;

    drop(host);
    let error = phone.expect("error").await;
    assert!(error["message"].as_str().unwrap().contains("ended"));
}

#[tokio::test]
async fn cybertruck_phones_get_remapped_names_and_colours() {
    let url = start_server().await;
    let mut host = Client::connect(&url).await;
    host.send(json!({"t": "create"})).await;
    let room = host.expect("created").await["room"]
        .as_str()
        .unwrap()
        .to_owned();
    host.send(json!({"t": "load", "vehicle": "cybertruck", "name": "CT"}))
        .await;
    host.send_binary(test_show()).await;
    host.expect("show").await;

    let mut phone = Client::connect(&url).await;
    phone.send(json!({"t": "join", "room": room})).await;
    let id = phone.expect("joined").await["id"].as_u64().unwrap();
    phone.expect("role").await;

    // On Cybertruck the tail channels drive the (white) reverse lights.
    let tail = Channel::Light(Light::Tail(Side::Left)).number().unwrap();
    host.send(json!({"t": "assign", "member": id, "channel": tail}))
        .await;
    let role = phone.expect("role").await;
    assert_eq!(role["label"], "Left Reverse Light");
    assert_eq!(role["color"], "white");
}
