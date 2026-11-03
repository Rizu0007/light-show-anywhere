//! WLED output: LED strips play Tesla lights in step with the phones, through the same safety
//! governor, over DDP (<http://www.3waylabs.com/ddp/>; WLED listens on UDP port 4048). Strips
//! play the room that most recently pressed play and go back to their own effects when it closes.
//!
//! The server's operator lists the strips in a file (`lsa-server --wled wled.json`), so hosts
//! cannot point the server's packets anywhere else:
//!
//! ```json
//! { "devices": [ { "address": "192.168.1.50", "leds": 70, "map": [
//!     { "start": 0, "count": 10, "channel": 1 },
//!     { "start": 10, "count": 60, "channel": 47, "per_led": true } ] } ] }
//! ```

use std::collections::HashMap;
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tokio::net::UdpSocket;

use crate::AppState;
use crate::room::{OutputTrack, Slot};

/// Port WLED listens on for DDP.
pub const DDP_PORT: u16 = 4048;
/// Most data bytes in one DDP packet (480 RGB LEDs; fits an Ethernet frame).
pub const MAX_DATA: usize = 1440;
/// Most LEDs on one device.
pub const MAX_LEDS: usize = 4096;

/// The LED strips to drive.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// Frames sent per second.
    #[serde(default = "default_fps")]
    pub fps: u32,
    /// WLED devices.
    pub devices: Vec<Device>,
}

/// One WLED device and which LEDs play which light.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Device {
    /// `host` or `host:port` (port 4048 by default).
    pub address: String,
    /// LEDs on the device.
    pub leds: usize,
    /// Runs of LEDs and their lights; LEDs in no run stay dark.
    pub map: Vec<Run>,
}

/// A run of LEDs playing one light, or one channel per LED (a Cybertruck light bar).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Run {
    /// First LED, from 0.
    pub start: usize,
    /// LEDs in the run.
    pub count: usize,
    /// Car of a fleet show, from 1.
    #[serde(default = "first_car")]
    pub car: u8,
    /// 1-based Tesla channel (the first one with `per_led`).
    pub channel: u16,
    /// LED `i` of the run plays `channel + i` instead of every LED playing `channel`.
    #[serde(default)]
    pub per_led: bool,
}

fn default_fps() -> u32 {
    40
}

fn first_car() -> u8 {
    1
}

impl Config {
    /// Reads and checks a config file.
    pub fn load(path: &Path) -> io::Result<Self> {
        let config: Self = serde_json::from_slice(&std::fs::read(path)?)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        config
            .check()
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
        Ok(config)
    }

    /// Checks frame rate, LED counts and that every run fits its strip and the channel map.
    pub fn check(&self) -> Result<(), String> {
        if !(1..=60).contains(&self.fps) {
            return Err(format!("fps {} is not between 1 and 60", self.fps));
        }
        for device in &self.devices {
            let name = &device.address;
            if device.leds == 0 || device.leds > MAX_LEDS {
                return Err(format!("{name}: leds must be 1 to {MAX_LEDS}"));
            }
            for run in &device.map {
                if run.count == 0
                    || run
                        .start
                        .checked_add(run.count)
                        .is_none_or(|end| end > device.leds)
                {
                    return Err(format!(
                        "{name}: LEDs {}+{} do not fit",
                        run.start, run.count
                    ));
                }
                let last = if run.per_led {
                    usize::from(run.channel).saturating_add(run.count - 1)
                } else {
                    usize::from(run.channel)
                };
                if run.channel == 0 || last > lsa_tesla::EXTENDED_CHANNELS || run.car == 0 {
                    return Err(format!(
                        "{name}: no such light (car {}, channel {last})",
                        run.car
                    ));
                }
            }
        }
        Ok(())
    }
}

/// The colour of a light at `level`, as the phones show it.
#[must_use]
pub fn rgb(color: &str, level: u8) -> [u8; 3] {
    let full: [u16; 3] = match color {
        "amber" => [255, 174, 26],
        "red" => [255, 43, 43],
        _ => [255, 244, 220],
    };
    full.map(|c| ((c * u16::from(level) + 127) / 255) as u8)
}

/// DDP packets for one frame of RGB data, the last one telling the device to show it.
/// `sequence` is 1–15 (0: unused).
#[must_use]
pub fn ddp_packets(rgb: &[u8], sequence: u8) -> Vec<Vec<u8>> {
    let chunks: Vec<&[u8]> = rgb.chunks(MAX_DATA).collect();
    let last = chunks.len().saturating_sub(1);
    chunks
        .iter()
        .enumerate()
        .map(|(i, data)| {
            let mut packet = Vec::with_capacity(10 + data.len());
            // Version 1, push on the last packet.
            packet.push(if i == last { 0x41 } else { 0x40 });
            packet.push(sequence & 0x0F);
            packet.push(0x0B); // RGB, 8 bits per channel
            packet.push(1); // default output
            packet.extend_from_slice(&((i * MAX_DATA) as u32).to_be_bytes());
            packet.extend_from_slice(&(data.len() as u16).to_be_bytes());
            packet.extend_from_slice(data);
            packet
        })
        .collect()
}

/// One frame for `device` at `position_ms`, from each light's track (`None`: dark).
fn render(
    device: &Device,
    position_ms: f64,
    track: &mut impl FnMut(Slot) -> Option<Arc<OutputTrack>>,
) -> Vec<u8> {
    let mut frame = vec![0u8; device.leds * 3];
    for run in &device.map {
        for i in 0..run.count {
            let channel = if run.per_led {
                run.channel + i as u16
            } else {
                run.channel
            };
            let Some(track) = track(Slot {
                car: run.car,
                channel,
            }) else {
                continue;
            };
            let index = (position_ms.max(0.0) / f64::from(track.step_ms.max(1))) as usize;
            let level = track.levels.get(index).copied().unwrap_or(0);
            let led = (run.start + i) * 3;
            frame[led..led + 3].copy_from_slice(&rgb(track.color, level));
        }
    }
    frame
}

/// `host`, `host:port`, an IP address (IPv6 too) or `[ipv6]:port`; port 4048 when not given.
async fn resolve(address: &str) -> io::Result<SocketAddr> {
    if let Ok(addr) = address.parse::<SocketAddr>() {
        return Ok(addr);
    }
    if let Ok(ip) = address.parse::<IpAddr>() {
        return Ok(SocketAddr::new(ip, DDP_PORT));
    }
    let with_port = if address.contains(':') {
        address.to_owned()
    } else {
        format!("{address}:{DDP_PORT}")
    };
    tokio::net::lookup_host(&with_port)
        .await?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, format!("{address}: no address")))
}

/// Sends frames to every device until the server stops.
pub async fn run(state: Arc<AppState>, config: Config) -> io::Result<()> {
    let mut targets = Vec::with_capacity(config.devices.len());
    for device in &config.devices {
        targets.push(resolve(&device.address).await?);
    }
    let socket = UdpSocket::bind("0.0.0.0:0").await?;
    let mut ticks = tokio::time::interval(Duration::from_secs(1) / config.fps);
    ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    // Governed tracks of the show on air, made once per light.
    let mut tracks: HashMap<Slot, Option<Arc<OutputTrack>>> = HashMap::new();
    let mut showing: Option<(String, u32)> = None;
    let mut sequence = 0u8;
    tracing::info!("sending light shows to {} WLED device(s)", targets.len());

    loop {
        ticks.tick().await;
        let frames: Vec<Vec<u8>> = {
            let rooms = state.rooms();
            // Nothing on air: stop sending, so the strips go back to their own effects.
            let Some(on_air) = rooms.on_air(state.now_ms()) else {
                continue;
            };
            let show = Some((on_air.room.clone(), on_air.version));
            if showing != show {
                tracks.clear();
                showing = show;
            }
            let mut track = |slot: Slot| {
                tracks
                    .entry(slot)
                    .or_insert_with(|| rooms.output_track(&on_air.room, slot).map(Arc::new))
                    .clone()
            };
            config
                .devices
                .iter()
                .map(|device| render(device, on_air.position_ms, &mut track))
                .collect()
        };
        sequence = sequence % 15 + 1;
        for (frame, target) in frames.iter().zip(&targets) {
            for packet in ddp_packets(frame, sequence) {
                if let Err(err) = socket.send_to(&packet, target).await {
                    tracing::debug!("WLED {target}: {err}");
                }
            }
        }
    }
}
