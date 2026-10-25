//! Renders a show for every vehicle and prints closure usage, timing, and a text preview.
//!
//! ```text
//! cargo run --release -p lsa-tesla --example render -- path/to/show.fseq
//! ```

use std::process::ExitCode;
use std::time::Instant;

use lsa_fseq::Sequence;
use lsa_tesla::{Channel, Light, Side, Vehicle, closure_usage, render};

const PREVIEW_COLUMNS: usize = 100;
const SHADES: [char; 5] = [' ', '░', '▒', '▓', '█'];

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: render <file.fseq>");
        return ExitCode::FAILURE;
    };
    let show = match std::fs::read(&path)
        .map_err(|e| e.to_string())
        .and_then(|bytes| Sequence::parse(&bytes).map_err(|e| e.to_string()))
    {
        Ok(show) => show,
        Err(err) => {
            eprintln!("cannot load {path}: {err}");
            return ExitCode::FAILURE;
        }
    };

    println!(
        "{path}\n{} frames × {} channels, {:.1} s\n",
        show.frame_count(),
        show.channel_count(),
        show.duration().as_secs_f64()
    );

    println!("closure commands (limit):");
    for usage in closure_usage(&show).iter().filter(|u| u.commands > 0) {
        let flag = if usage.exceeded() { "  OVER LIMIT" } else { "" };
        println!(
            "  {:?}: {} ({}){flag}",
            usage.closure, usage.commands, usage.limit
        );
    }

    let preview = [
        (
            "L outer beam",
            Channel::Light(Light::OuterMainBeam(Side::Left)),
        ),
        ("L signature ", Channel::Light(Light::Signature(Side::Left))),
        ("L channel 4 ", Channel::Light(Light::Channel4(Side::Left))),
        (
            "L repeater  ",
            Channel::Light(Light::SideRepeater(Side::Left)),
        ),
        ("brake       ", Channel::Light(Light::Brake)),
    ];

    for vehicle in Vehicle::ALL {
        let started = Instant::now();
        let rendered = render(&show, vehicle);
        let elapsed = started.elapsed();
        println!(
            "\n{vehicle:?}: rendered in {:.2} ms",
            elapsed.as_secs_f64() * 1000.0
        );
        for (label, channel) in preview {
            let Some(track) = channel.index().and_then(|i| rendered.channel_track(i)) else {
                continue;
            };
            println!("  {label} |{}|", sparkline(&track));
        }
    }
    ExitCode::SUCCESS
}

/// Squeezes a track into a fixed-width row of shade characters (average of each bucket).
fn sparkline(track: &[u8]) -> String {
    let bucket = track.len().div_ceil(PREVIEW_COLUMNS).max(1);
    track
        .chunks(bucket)
        .map(|chunk| {
            let average = chunk.iter().map(|&v| usize::from(v)).sum::<usize>() / chunk.len();
            SHADES[average * (SHADES.len() - 1) / 255]
        })
        .collect()
}
