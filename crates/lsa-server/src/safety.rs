//! Photosensitive-epilepsy governor (WCAG 2.3.1): every phone track ramps no faster than
//! [`MIN_RAMP_MS`] and flashes at most [`MAX_FLASHES_PER_SECOND`] times a second. A flash is a
//! pair of opposing luminance changes of ≥ 10 % with the darker end below 0.80; every colour
//! counts as white (WCAG's red-flash rule). Tracks are governed one at a time, not as a crowd.

use std::collections::VecDeque;

/// Most flashes allowed in any one-second period (WCAG 2.3.1).
pub const MAX_FLASHES_PER_SECOND: usize = 3;
/// Shortest time for a change between off and full brightness.
pub const MIN_RAMP_MS: u32 = 150;

const WINDOW_MS: u32 = 1000;
/// Smallest luminance change that counts as one half of a flash.
const MIN_CHANGE: f32 = 0.1;
/// A change only counts when its darker end is below this luminance.
const DARK_BELOW: f32 = 0.8;

/// Relative luminance (0–1) of a level shown as white on an sRGB screen (WCAG 2.x formula).
#[must_use]
pub fn luminance(level: u8) -> f32 {
    let c = f32::from(level) / 255.0;
    if c <= 0.039_28 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// Finds the changes that count as half of a flash, one level at a time.
#[derive(Debug)]
struct Transitions {
    /// Luminance at the last turning point.
    anchor: f32,
    /// Direction of the last counted change.
    rising: Option<bool>,
}

impl Transitions {
    fn new() -> Self {
        Self {
            anchor: 0.0,
            rising: None,
        }
    }

    /// Whether moving to `lum` completes a change in the opposite direction to the last one.
    fn crosses(&self, lum: f32) -> bool {
        let change = match self.rising {
            None => (lum - self.anchor).abs(),
            Some(true) => self.anchor - lum,
            Some(false) => lum - self.anchor,
        };
        change >= MIN_CHANGE && lum.min(self.anchor) < DARK_BELOW
    }

    /// Counts a change ending at `lum`.
    fn record(&mut self, lum: f32) {
        self.rising = Some(lum > self.anchor);
        self.anchor = lum;
    }

    /// Moves the turning point along while the level keeps going the same way.
    fn follow(&mut self, lum: f32) {
        match self.rising {
            Some(true) if lum > self.anchor => self.anchor = lum,
            Some(false) if lum < self.anchor => self.anchor = lum,
            _ => {}
        }
    }
}

/// Rewrites a light track (one level per `step_ms` frame, starting dark) so that it never
/// flashes more than [`MAX_FLASHES_PER_SECOND`] times in any second and never ramps faster than
/// [`MIN_RAMP_MS`].
#[must_use]
pub fn govern(levels: &[u8], step_ms: u8) -> Vec<u8> {
    let step = u32::from(step_ms.max(1));
    let max_change = (255 * step).div_ceil(MIN_RAMP_MS).min(255) as u8;
    let max_transitions = 2 * MAX_FLASHES_PER_SECOND;

    let mut out = Vec::with_capacity(levels.len());
    let mut level = 0u8;
    // Where the current change is heading. A change runs to the end before the light follows
    // the show again, so a strobe faster than the ramp becomes a slower pulse instead of a dim
    // flicker that never gets bright.
    let mut goal = 0u8;
    let mut transitions = Transitions::new();
    let mut recent: VecDeque<usize> = VecDeque::with_capacity(max_transitions + 1);

    for (frame, &target) in levels.iter().enumerate() {
        while recent
            .front()
            .is_some_and(|&at| (frame - at) as u32 * step >= WINDOW_MS)
        {
            recent.pop_front();
        }

        let further = (goal > level && target > goal) || (goal < level && target < goal);
        if level == goal || further {
            goal = target;
        }
        let next = if goal > level {
            level.saturating_add(max_change).min(goal)
        } else {
            level.saturating_sub(max_change).max(goal)
        };
        let lum = luminance(next);
        if transitions.crosses(lum) {
            if recent.len() < max_transitions {
                recent.push_back(frame);
                transitions.record(lum);
                level = next;
            } else {
                // Hold until the oldest change leaves the window, then follow the show afresh.
                goal = level;
            }
        } else {
            transitions.follow(lum);
            level = next;
        }
        out.push(level);
    }
    out
}
