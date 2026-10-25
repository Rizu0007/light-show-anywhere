//! Writes a small 200-channel test show: a light chasing along the Cybertruck bars, interior
//! colour cycling, and headlights ramping on and off.
//!
//! ```text
//! cargo run -p lsa-tesla --example demo_show -- shows/demo/cybertruck_chase.fseq
//! ```

use std::process::ExitCode;

use lsa_fseq::Sequence;
use lsa_tesla::{Channel, EXTENDED_CHANNELS, Light, LightBar, LightCommand, Rgb, RgbZone, Side};

const STEP_MS: u8 = 20;
const SECONDS: usize = 12;
const FRAMES: usize = SECONDS * 1000 / STEP_MS as usize;

fn index(channel: Channel) -> usize {
    channel.index().expect("mapped channel")
}

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: demo_show <output.fseq>");
        return ExitCode::FAILURE;
    };

    let mut data = vec![0u8; EXTENDED_CHANNELS * FRAMES];
    for (frame_index, frame) in data
        .as_chunks_mut::<EXTENDED_CHANNELS>()
        .0
        .iter_mut()
        .enumerate()
    {
        let t = frame_index as f32 * f32::from(STEP_MS) / 1000.0;

        // A bright head with a fading tail running along each bar.
        for bar in [LightBar::Front, LightBar::Rear, LightBar::Offroad] {
            let len = bar.len();
            let head = (t * 30.0) as usize % len;
            for tail in 0..len.min(8) {
                let pixel = (head + len - tail) % len;
                let level = 255u8.saturating_sub((tail * 32) as u8);
                let channel = index(Channel::BarPixel {
                    bar,
                    index: pixel as u8,
                });
                frame[channel] = frame[channel].max(level);
            }
        }

        // Main beams: ramp on for 2 s, ramp off for 2 s.
        let on = (t as usize / 2).is_multiple_of(2);
        let beam = LightCommand { on, ramp_ms: 1000 }.to_byte();
        for side in [Side::Left, Side::Right] {
            frame[index(Channel::Light(Light::OuterMainBeam(side)))] = beam;
            frame[index(Channel::Light(Light::InnerMainBeam(side)))] = beam;
        }

        // Brake light breathing (full brightness control on Cybertruck).
        let breathe = ((t * 2.0).sin() * 0.5 + 0.5) * 255.0;
        frame[index(Channel::Light(Light::Brake))] = breathe as u8;

        // Interior display cycling through colours.
        let hue = t * 0.5;
        for (component, phase) in [(Rgb::Red, 0.0), (Rgb::Green, 2.1), (Rgb::Blue, 4.2)] {
            let value = ((hue + phase).sin() * 0.5 + 0.5) * 255.0;
            frame[index(Channel::Interior {
                zone: RgbZone::Display,
                component,
            })] = value as u8;
        }
    }

    let result = Sequence::from_frames(EXTENDED_CHANNELS as u32, STEP_MS, data)
        .and_then(|show| show.to_bytes())
        .map_err(|e| e.to_string())
        .and_then(|bytes| {
            if let Some(dir) = std::path::Path::new(&path).parent() {
                std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, bytes).map_err(|e| e.to_string())
        });
    match result {
        Ok(()) => {
            println!("wrote {path} ({FRAMES} frames, {SECONDS} s)");
            ExitCode::SUCCESS
        }
        Err(err) => {
            eprintln!("failed: {err}");
            ExitCode::FAILURE
        }
    }
}
