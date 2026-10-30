//! Load test: one host and many phones in a room, over real `WebSocket` connections.
//!
//! Phases: phones join all at once (with clock sync), the host presses play, and every phone
//! drops and resumes at the same moment (a Wi-Fi blip). Each phase checks what a party needs:
//! the play command reaches every phone well inside the start lead, clock-sync round trips stay
//! short, and every phone gets its light back.
//!
//! `cargo test -p lsa-server --test load -- --nocapture` runs 200 phones and prints the
//! timings. For a bigger crowd: `LSA_LOAD_PHONES=1000 cargo test --release -p lsa-server --test
//! load -- --nocapture`.

use std::hash::{BuildHasher, RandomState};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use lsa_fseq::Sequence;
use lsa_server::room::START_LEAD_MS;
use lsa_server::{AppState, app};
use serde_json::{Value, json};
use tokio::net::TcpStream;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream, connect_async};

const DEFAULT_PHONES: usize = 200;
const TIMEOUT: Duration = Duration::from_secs(60);
/// Clock-sync pings each phone sends while joining (the web client sends a burst like this).
const SYNC_PINGS: usize = 5;
/// A three-minute show at 20 ms per frame.
const SHOW_FRAMES: usize = 9000;
/// The web client's first reconnect delay; each phone waits a random 50–150% of it
/// (`web/src/party/connection.ts`).
const RETRY_MS: u64 = 500;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

async fn start_server() -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let state = Arc::new(AppState::default());
    tokio::spawn(async move {
        axum::serve(listener, app(state, None)).await.unwrap();
    });
    format!("ws://{addr}/ws")
}

async fn connect(url: &str) -> Ws {
    // Connecting thousands at once can overflow the listen backlog; retry like a phone would.
    let mut wait = Duration::from_millis(20);
    loop {
        match connect_async(url).await {
            Ok((ws, _)) => return ws,
            Err(_) if wait < Duration::from_secs(5) => {
                tokio::time::sleep(wait).await;
                wait *= 2;
            }
            Err(err) => panic!("connecting: {err}"),
        }
    }
}

async fn send(ws: &mut Ws, message: Value) {
    ws.send(Message::Text(message.to_string().into()))
        .await
        .unwrap();
}

/// Reads until a JSON message with tag `t` arrives and returns it.
async fn expect(ws: &mut Ws, t: &str) -> Value {
    loop {
        let message = tokio::time::timeout(TIMEOUT, ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for {t}"))
            .expect("connection closed")
            .unwrap();
        if let Message::Text(text) = message {
            let value: Value = serde_json::from_str(&text).unwrap();
            assert_ne!(value["t"], "error", "server error: {value}");
            if value["t"] == t {
                return value;
            }
        }
    }
}

async fn expect_binary(ws: &mut Ws) -> usize {
    loop {
        let message = tokio::time::timeout(TIMEOUT, ws.next())
            .await
            .expect("timed out waiting for a track")
            .expect("connection closed")
            .unwrap();
        if let Message::Binary(bytes) = message {
            return bytes.len();
        }
    }
}

/// A 48-channel show of [`SHOW_FRAMES`] frames where every light does something different.
fn long_show() -> Vec<u8> {
    let mut data = vec![0u8; 48 * SHOW_FRAMES];
    for (i, frame) in data.as_chunks_mut::<48>().0.iter_mut().enumerate() {
        for (c, level) in frame.iter_mut().enumerate() {
            *level = if (i / (c + 2)) % 3 == 0 { 255 } else { 0 };
        }
    }
    Sequence::from_frames(48, 20, data)
        .unwrap()
        .to_bytes()
        .unwrap()
}

struct Phone {
    ws: Ws,
    token: String,
    channel: u64,
}

/// What one phone saw while joining.
struct Joined {
    phone: Phone,
    /// From opening the connection to holding its light track.
    took: Duration,
    sync_rtts: Vec<Duration>,
}

async fn join(url: String, room: String, n: usize) -> Joined {
    let start = Instant::now();
    let mut ws = connect(&url).await;
    let mut sync_rtts = Vec::with_capacity(SYNC_PINGS);
    for _ in 0..SYNC_PINGS {
        let sent = Instant::now();
        send(&mut ws, json!({"t": "sync", "c0": 0.0})).await;
        expect(&mut ws, "sync").await;
        sync_rtts.push(sent.elapsed());
    }
    send(
        &mut ws,
        json!({"t": "join", "room": room, "name": format!("phone {n}")}),
    )
    .await;
    let token = expect(&mut ws, "joined").await["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let channel = expect(&mut ws, "role").await["channel"].as_u64().unwrap();
    assert_eq!(expect_binary(&mut ws).await, 12 + SHOW_FRAMES);
    Joined {
        phone: Phone { ws, token, channel },
        took: start.elapsed(),
        sync_rtts,
    }
}

/// Drops the connection without a goodbye and, after the web client's random retry delay, takes
/// the place back on a new one, as a phone does after a Wi-Fi blip. Returns the new phone and
/// how long it took from trying again to having its track.
async fn blip(url: String, phone: Phone, retry: Duration) -> (Phone, Duration) {
    drop(phone.ws);
    tokio::time::sleep(retry).await;
    let start = Instant::now();
    let mut ws = connect(&url).await;
    send(&mut ws, json!({"t": "resume", "token": phone.token})).await;
    expect(&mut ws, "resumed").await;
    let channel = expect(&mut ws, "role").await["channel"].as_u64().unwrap();
    assert_eq!(channel, phone.channel, "a phone lost its light on resume");
    expect_binary(&mut ws).await;
    let took = start.elapsed();
    (
        Phone {
            ws,
            token: phone.token,
            channel,
        },
        took,
    )
}

/// Reads host messages until the roster lists `phones` phones, all online. Returns how many
/// rosters arrived and their total size.
async fn drain_rosters(host: &mut Ws, phones: usize) -> (usize, usize) {
    let (mut count, mut bytes) = (0, 0);
    let mut last = String::from("no roster");
    loop {
        let message = tokio::time::timeout(TIMEOUT, host.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for the full roster; last: {last}"))
            .expect("host connection closed")
            .unwrap();
        let Message::Text(text) = message else {
            continue;
        };
        let value: Value = serde_json::from_str(&text).unwrap();
        if value["t"] != "roster" {
            continue;
        }
        count += 1;
        bytes += text.len();
        let members = value["members"].as_array().unwrap();
        let online = members.iter().filter(|m| m["online"] == true).count();
        last = format!("{} phones, {online} online", members.len());
        if members.len() == phones && online == phones {
            return (count, bytes);
        }
    }
}

fn phones_wanted() -> usize {
    std::env::var("LSA_LOAD_PHONES")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(DEFAULT_PHONES)
}

/// Median, 99th percentile and maximum, in milliseconds.
fn spread(mut times: Vec<Duration>) -> (f64, f64, f64) {
    times.sort();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    let at = |q: f64| ms(times[((times.len() - 1) as f64 * q).round() as usize]);
    (at(0.5), at(0.99), ms(times[times.len() - 1]))
}

fn report(what: &str, times: Vec<Duration>) -> (f64, f64, f64) {
    let (median, p99, max) = spread(times);
    println!("  {what:<34} median {median:7.1} ms   p99 {p99:7.1} ms   max {max:7.1} ms");
    (median, p99, max)
}

/// Starts `step` on every phone at once. Collect with [`gather`].
fn on_every_phone<T, Fut>(
    crowd: Vec<Phone>,
    step: impl Fn(usize, Phone) -> Fut,
) -> Vec<JoinHandle<(Phone, T)>>
where
    Fut: Future<Output = (Phone, T)> + Send + 'static,
    T: Send + 'static,
{
    crowd
        .into_iter()
        .enumerate()
        .map(|(n, phone)| tokio::spawn(step(n, phone)))
        .collect()
}

async fn gather<T>(handles: Vec<JoinHandle<(Phone, T)>>) -> (Vec<Phone>, Vec<T>) {
    let mut crowd = Vec::with_capacity(handles.len());
    let mut results = Vec::with_capacity(handles.len());
    for handle in handles {
        let (phone, result) = handle.await.unwrap();
        crowd.push(phone);
        results.push(result);
    }
    (crowd, results)
}

fn report_rosters(rosters: usize, bytes: usize) {
    println!(
        "  host received {rosters} rosters ({:.1} MB)",
        bytes as f64 / 1e6
    );
}

/// Everyone scans the QR code at once.
async fn join_storm(url: &str, room: &str, host: &mut Ws, phones: usize) -> Vec<Phone> {
    let started = Instant::now();
    let joins: Vec<_> = (0..phones)
        .map(|n| tokio::spawn(join(url.to_owned(), room.to_owned(), n)))
        .collect();
    let mut crowd = Vec::with_capacity(phones);
    let (mut join_times, mut rtts) = (Vec::new(), Vec::new());
    for handle in joins {
        let joined = handle.await.unwrap();
        join_times.push(joined.took);
        rtts.extend(joined.sync_rtts);
        crowd.push(joined.phone);
    }
    let all_joined = started.elapsed();
    let (rosters, roster_bytes) = drain_rosters(host, phones).await;
    println!("join storm: all {phones} phones had their light after {all_joined:.2?}");
    report("join → light track", join_times);
    let (_, sync_p99, _) = report("clock-sync round trip", rtts);
    report_rosters(rosters, roster_bytes);

    // Every light is used before any is doubled up.
    let mut per_light = std::collections::HashMap::<u64, usize>::new();
    for phone in &crowd {
        *per_light.entry(phone.channel).or_default() += 1;
    }
    let (fewest, most) = (
        per_light.values().min().unwrap(),
        per_light.values().max().unwrap(),
    );
    println!(
        "  {} lights in use, {fewest}–{most} phones each",
        per_light.len()
    );
    assert!(most - fewest <= 1, "lights are shared unevenly");
    assert!(
        sync_p99 < 250.0,
        "clock-sync round trips p99 {sync_p99:.0} ms"
    );
    crowd
}

/// The host presses play: every phone must hear about it well before the show starts.
async fn press_play(host: &mut Ws, crowd: Vec<Phone>) -> Vec<Phone> {
    let waits = on_every_phone(crowd, |_, mut phone| async move {
        // The paused state sent at join may still be waiting.
        while expect(&mut phone.ws, "playback").await["playing"] != true {}
        (phone, Instant::now())
    });
    let pressed = Instant::now();
    send(host, json!({"t": "play", "positionMs": 0.0})).await;
    let (crowd, told) = gather(waits).await;
    println!("play:");
    let (_, _, max) = report(
        "play pressed → phone told",
        told.iter().map(|&at| at - pressed).collect(),
    );
    assert!(
        max < START_LEAD_MS / 2.0,
        "play reached the last phone after {max:.0} ms; the show starts {START_LEAD_MS} ms after the press"
    );
    crowd
}

/// The next song: the server renders it and every phone gets its new track.
async fn next_song(host: &mut Ws, crowd: Vec<Phone>) -> Vec<Phone> {
    let waits = on_every_phone(crowd, |_, mut phone| async move {
        assert_eq!(expect(&mut phone.ws, "show").await["version"], 2);
        // Lights are dealt again for the new show.
        phone.channel = expect(&mut phone.ws, "role").await["channel"]
            .as_u64()
            .unwrap();
        expect_binary(&mut phone.ws).await;
        (phone, Instant::now())
    });
    let sent = Instant::now();
    send(
        host,
        json!({"t": "load", "vehicle": "model-3y", "name": "Next"}),
    )
    .await;
    host.send(Message::Binary(long_show().into()))
        .await
        .unwrap();
    let (crowd, received) = gather(waits).await;
    println!("next song:");
    let (_, _, max) = report(
        "upload → phone has new track",
        received.iter().map(|&at| at - sent).collect(),
    );
    assert!(
        max < 5000.0,
        "the last phone got the next song after {max:.0} ms"
    );
    crowd
}

/// The Wi-Fi drops for a moment and every phone reconnects.
async fn wifi_blip(url: &str, host: &mut Ws, crowd: Vec<Phone>) -> Vec<Phone> {
    let phones = crowd.len();
    let random = RandomState::new();
    let started = Instant::now();
    let blips = on_every_phone(crowd, |n, phone| {
        let retry = RETRY_MS / 2 + random.hash_one(n) % RETRY_MS;
        blip(url.to_owned(), phone, Duration::from_millis(retry))
    });
    let (crowd, resume_times) = gather(blips).await;
    let all_back = started.elapsed();
    let (rosters, roster_bytes) = drain_rosters(host, phones).await;
    println!("Wi-Fi blip: all {phones} phones back on their light after {all_back:.2?}");
    let (_, _, max) = report("retry → light track", resume_times);
    report_rosters(rosters, roster_bytes);
    assert!(
        max < 1000.0,
        "a phone took {max:.0} ms to get its light back"
    );
    crowd
}

#[tokio::test(flavor = "multi_thread")]
async fn a_crowd_of_phones_joins_plays_and_survives_a_wifi_blip() {
    let phones = phones_wanted();
    let url = start_server().await;
    println!("\n{phones} phones, one host, a {SHOW_FRAMES}-frame show");

    let mut host = connect(&url).await;
    send(&mut host, json!({"t": "create"})).await;
    let room = expect(&mut host, "created").await["room"]
        .as_str()
        .unwrap()
        .to_owned();
    send(
        &mut host,
        json!({"t": "load", "vehicle": "model-3y", "name": "Load"}),
    )
    .await;
    host.send(Message::Binary(long_show().into()))
        .await
        .unwrap();
    expect(&mut host, "show").await;

    let crowd = join_storm(&url, &room, &mut host, phones).await;
    let crowd = press_play(&mut host, crowd).await;
    let crowd = next_song(&mut host, crowd).await;
    wifi_blip(&url, &mut host, crowd).await;
}
