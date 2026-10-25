//! Browser bindings: load a show once, then read any frame instantly while the song plays.
//!
//! Built with `wasm-pack build crates/lsa-wasm --target web` (see `web/package.json`).

// Every export is called from JavaScript, where `#[must_use]` has no effect.
#![allow(clippy::must_use_candidate)]

use core::time::Duration;

use lsa_fseq::{Sequence, tesla};
use lsa_tesla::{Channel, Rendered, Vehicle, closure_usage, render};
use wasm_bindgen::prelude::*;

/// A loaded show, emulated for one vehicle.
#[wasm_bindgen]
pub struct Show {
    sequence: Sequence,
    rendered: Rendered,
}

#[wasm_bindgen]
impl Show {
    /// Parses an `.fseq` file and emulates it for `vehicle`
    /// (`"model-s"`, `"model-x"`, `"model-3y"` or `"cybertruck"`).
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8], vehicle: &str) -> Result<Self, JsError> {
        let vehicle = parse_vehicle(vehicle)?;
        let sequence = Sequence::parse(bytes)?;
        let rendered = render(&sequence, vehicle);
        Ok(Self { sequence, rendered })
    }

    /// Re-emulates the show for another vehicle.
    #[wasm_bindgen(js_name = setVehicle)]
    pub fn set_vehicle(&mut self, vehicle: &str) -> Result<(), JsError> {
        self.rendered = render(&self.sequence, parse_vehicle(vehicle)?);
        Ok(())
    }

    /// Channels per frame (48 or 200 for Tesla shows).
    #[wasm_bindgen(getter, js_name = channelCount)]
    pub fn channel_count(&self) -> usize {
        self.sequence.channel_count()
    }

    /// Number of frames.
    #[wasm_bindgen(getter, js_name = frameCount)]
    pub fn frame_count(&self) -> usize {
        self.sequence.frame_count()
    }

    /// Milliseconds between frames.
    #[wasm_bindgen(getter, js_name = stepMs)]
    pub fn step_ms(&self) -> u8 {
        self.sequence.header().step_time_ms
    }

    /// Show length in milliseconds.
    #[wasm_bindgen(getter, js_name = durationMs)]
    pub fn duration_ms(&self) -> f64 {
        self.sequence.duration().as_secs_f64() * 1000.0
    }

    /// Audio file name the show was made for, if recorded.
    #[wasm_bindgen(getter, js_name = mediaFilename)]
    pub fn media_filename(&self) -> Option<String> {
        self.sequence
            .header()
            .media_filename()
            .map(|path| path.rsplit(['/', '\\']).next().unwrap_or(path).to_owned())
    }

    /// Output of every channel at `ms` (0 = off/closed, 255 = full/open), or `undefined` after
    /// the show ends.
    #[wasm_bindgen(js_name = levelsAt)]
    pub fn levels_at(&self, ms: f64) -> Option<Vec<u8>> {
        if !ms.is_finite() || ms < 0.0 {
            return None;
        }
        self.rendered
            .frame_at(Duration::from_secs_f64(ms / 1000.0))
            .map(<[u8]>::to_vec)
    }

    /// Problems that would stop the show playing on a real Tesla (empty when it is fine).
    #[wasm_bindgen(js_name = teslaIssues)]
    pub fn tesla_issues(&self) -> Vec<String> {
        let mut issues = Vec::new();
        if let Err(issue) = tesla::check(self.sequence.header()) {
            issues.push(issue.to_string());
        }
        for usage in closure_usage(&self.sequence) {
            if usage.exceeded() {
                issues.push(format!(
                    "{}: {} commands, limit {}",
                    usage.closure, usage.commands, usage.limit
                ));
            }
        }
        issues
    }
}

/// Human-readable name of the channel at 0-based `index`.
#[wasm_bindgen(js_name = channelName)]
pub fn channel_name(index: usize, channel_count: usize) -> String {
    Channel::from_index(index, channel_count).to_string()
}

fn parse_vehicle(name: &str) -> Result<Vehicle, JsError> {
    match name {
        "model-s" => Ok(Vehicle::ModelS),
        "model-x" => Ok(Vehicle::ModelX),
        "model-3y" => Ok(Vehicle::Model3Y),
        "cybertruck" => Ok(Vehicle::Cybertruck),
        other => Err(JsError::new(&format!("unknown vehicle: {other}"))),
    }
}
