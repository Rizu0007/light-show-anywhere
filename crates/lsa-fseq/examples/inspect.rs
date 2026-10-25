//! Prints a summary of an FSEQ file: header, Tesla check, and the values each channel uses.
//!
//! ```text
//! cargo run -p lsa-fseq --example inspect -- path/to/show.fseq
//! ```

use std::collections::BTreeMap;
use std::process::ExitCode;

use lsa_fseq::{Sequence, tesla};

fn main() -> ExitCode {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: inspect <file.fseq>");
        return ExitCode::FAILURE;
    };
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(err) => {
            eprintln!("cannot read {path}: {err}");
            return ExitCode::FAILURE;
        }
    };
    let show = match Sequence::parse(&bytes) {
        Ok(show) => show,
        Err(err) => {
            eprintln!("cannot parse {path}: {err}");
            return ExitCode::FAILURE;
        }
    };

    let header = show.header();
    println!("file:        {path}");
    println!(
        "version:     {}.{}",
        header.version.major, header.version.minor
    );
    println!("channels:    {}", header.channel_count);
    println!("frames:      {}", header.frame_count);
    println!("step time:   {} ms", header.step_time_ms);
    println!("duration:    {:.1} s", show.duration().as_secs_f64());
    println!("compression: {:?}", header.compression);
    println!("sparse:      {:?}", header.sparse_ranges);
    for entry in &header.variable_headers {
        println!(
            "meta {}:     {}",
            String::from_utf8_lossy(&entry.code),
            entry.text().unwrap_or("<binary>")
        );
    }
    match tesla::check(header) {
        Ok(report) => println!("tesla:       OK {report:?}"),
        Err(issue) => println!("tesla:       REJECTED: {issue}"),
    }

    println!("\nchannel (1-based) -> value: frames using it");
    for channel in 0..show.channel_count() {
        let mut counts = BTreeMap::<u8, usize>::new();
        let mut changes = 0;
        let mut previous = None;
        for frame in show.frames() {
            *counts.entry(frame[channel]).or_default() += 1;
            if previous.is_some_and(|p| p != frame[channel]) {
                changes += 1;
            }
            previous = Some(frame[channel]);
        }
        if counts.len() > 1 || counts.keys().next() != Some(&0) {
            let values: Vec<String> = counts.iter().map(|(v, n)| format!("{v}:{n}")).collect();
            println!(
                "{:>4}  changes {:>4}  {}",
                channel + 1,
                changes,
                values.join(" ")
            );
        }
    }
    ExitCode::SUCCESS
}
