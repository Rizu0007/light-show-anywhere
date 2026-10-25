//! Frame-by-frame emulation of how a vehicle responds to a sequence.
//!
//! Light rules (Tesla README, "Ramping light channels"):
//! - A ramp moves brightness towards 0 % or 100 % at a fixed rate: full range in the ramp
//!   duration. It cannot hold a level in between.
//! - A new command takes over immediately from the current brightness, so ramps can stop early
//!   or reverse.
//!
//! Closure positions are approximations for previews: travel times come from Tesla's table, and
//! Dance is drawn as a 1-second swing between two positions, since Tesla does not publish the
//! exact dance positions.

use core::f32::consts::TAU;
use core::time::Duration;

use lsa_fseq::Sequence;

use crate::channel::{Channel, Closure};
use crate::command::{ClosureCommand, LightCommand};
use crate::vehicle::{Behavior, Vehicle};

/// Brightness and position are stored as parts per million so ramps land exactly on Tesla's
/// documented values (500, 1000 and 2000 ms all divide one million evenly).
const FULL: u32 = 1_000_000;
const DANCE_PERIOD_MS: f32 = 1000.0;
const DANCE_OPEN_RANGE: (f32, f32) = (0.6, 1.0);
const DANCE_WINDOW_RANGE: (f32, f32) = (0.0, 0.4);
const FULLY_OPEN: f32 = 0.999;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Motion {
    Still,
    Opening,
    Closing,
    Dancing { elapsed_ms: f32 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct ClosureState {
    closure: Closure,
    position: f32,
    motion: Motion,
}

impl ClosureState {
    fn new(closure: Closure) -> Self {
        Self {
            closure,
            position: 0.0,
            motion: Motion::Still,
        }
    }

    fn step(&mut self, command: ClosureCommand, dt_ms: f32) {
        self.apply(command);
        self.advance(dt_ms);
    }

    fn apply(&mut self, command: ClosureCommand) {
        let dancing = matches!(self.motion, Motion::Dancing { .. });
        self.motion = match command {
            ClosureCommand::Open if self.position < FULLY_OPEN => Motion::Opening,
            ClosureCommand::Close if self.position > 0.0 => Motion::Closing,
            ClosureCommand::Dance if dancing => self.motion,
            ClosureCommand::Dance if self.can_start_dance() => Motion::Dancing { elapsed_ms: 0.0 },
            ClosureCommand::Stop => Motion::Still,
            // Idle lets an open or close finish but ends a dance; a refused command is ignored.
            ClosureCommand::Idle if dancing => Motion::Still,
            _ => self.motion,
        };
    }

    fn can_start_dance(&self) -> bool {
        self.closure.supports_dance()
            && (self.closure.dances_when_closed() || self.position >= FULLY_OPEN)
    }

    fn advance(&mut self, dt_ms: f32) {
        match &mut self.motion {
            Motion::Still => {}
            Motion::Opening => {
                self.position += dt_ms / self.closure.open_ms() as f32;
                if self.position >= 1.0 {
                    self.position = 1.0;
                    self.motion = Motion::Still;
                }
            }
            Motion::Closing => {
                self.position -= dt_ms / self.closure.close_ms() as f32;
                if self.position <= 0.0 {
                    self.position = 0.0;
                    self.motion = Motion::Still;
                }
            }
            Motion::Dancing { elapsed_ms } => {
                *elapsed_ms += dt_ms;
                let swing = (1.0 - (TAU * *elapsed_ms / DANCE_PERIOD_MS).cos()) / 2.0;
                self.position = if self.closure.dances_when_closed() {
                    let (low, high) = DANCE_WINDOW_RANGE;
                    low + (high - low) * swing
                } else {
                    let (low, high) = DANCE_OPEN_RANGE;
                    high - (high - low) * swing
                };
            }
        }
    }
}

/// Simulates one vehicle, one frame at a time.
#[derive(Debug, Clone)]
pub struct Emulator {
    behaviors: Vec<Behavior>,
    /// Output per channel in parts per million.
    levels: Vec<u32>,
    closures: Vec<Option<ClosureState>>,
}

impl Emulator {
    /// Creates an emulator for `vehicle` and files with `channel_count` channels.
    #[must_use]
    pub fn new(vehicle: Vehicle, channel_count: usize) -> Self {
        let channels: Vec<Channel> = (0..channel_count)
            .map(|index| Channel::from_index(index, channel_count))
            .collect();
        let behaviors = channels.iter().map(|&c| vehicle.behavior(c)).collect();
        let closures = channels
            .iter()
            .map(|channel| match channel {
                Channel::Closure(closure) => Some(ClosureState::new(*closure)),
                _ => None,
            })
            .collect();
        Self {
            behaviors,
            levels: vec![0; channel_count],
            closures,
        }
    }

    /// Returns every light to off and every closure to closed.
    pub fn reset(&mut self) {
        self.levels.fill(0);
        for state in self.closures.iter_mut().flatten() {
            *state = ClosureState::new(state.closure);
        }
    }

    /// Applies one frame of channel values, then advances time by `dt_ms` milliseconds.
    ///
    /// # Panics
    ///
    /// Panics if `frame` is shorter than the channel count given to [`Emulator::new`].
    pub fn step(&mut self, frame: &[u8], dt_ms: u32) {
        let channels = self.levels.len();
        for (index, &value) in frame[..channels].iter().enumerate() {
            let level = &mut self.levels[index];
            match self.behaviors[index] {
                Behavior::Absent => *level = 0,
                Behavior::FullBrightness => *level = u32::from(value) * FULL / 255,
                Behavior::Boolean => *level = bool_level(LightCommand::from_byte(value).on),
                Behavior::Ramping => {
                    let command = LightCommand::from_byte(value);
                    let target = bool_level(command.on);
                    if command.ramp_ms == 0 {
                        *level = target;
                    } else {
                        let delta = dt_ms.saturating_mul(FULL) / u32::from(command.ramp_ms);
                        *level = if target > *level {
                            level.saturating_add(delta).min(target)
                        } else {
                            level.saturating_sub(delta).max(target)
                        };
                    }
                }
                Behavior::Closure => {
                    if let Some(state) = &mut self.closures[index] {
                        state.step(ClosureCommand::from_byte(value), dt_ms as f32);
                        *level = (state.position.clamp(0.0, 1.0) * FULL as f32).round() as u32;
                    }
                }
            }
        }
    }

    /// Current output of one channel: brightness for lights, openness for closures (0–1).
    #[must_use]
    pub fn level(&self, index: usize) -> Option<f32> {
        self.levels.get(index).map(|&ppm| ppm as f32 / FULL as f32)
    }

    /// Current output of one channel as a byte (0 = off/closed, 255 = full/open).
    #[must_use]
    pub fn level_byte(&self, index: usize) -> Option<u8> {
        self.levels.get(index).map(|&ppm| to_byte(ppm))
    }
}

fn bool_level(on: bool) -> u32 {
    if on { FULL } else { 0 }
}

/// Parts per million to a byte, rounding half up.
fn to_byte(ppm: u32) -> u8 {
    ((u64::from(ppm.min(FULL)) * 255 + u64::from(FULL / 2)) / u64::from(FULL)) as u8
}

/// What a vehicle shows for every channel of every frame, precomputed for instant seeking.
///
/// Each byte is the channel's output at the end of that frame (0 = off/closed, 255 = full/open).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rendered {
    vehicle: Vehicle,
    channel_count: usize,
    step_time_ms: u8,
    levels: Vec<u8>,
}

impl Rendered {
    /// Vehicle the show was rendered for.
    #[must_use]
    pub fn vehicle(&self) -> Vehicle {
        self.vehicle
    }

    /// Channels per frame.
    #[must_use]
    pub fn channel_count(&self) -> usize {
        self.channel_count
    }

    /// Number of frames.
    #[must_use]
    pub fn frame_count(&self) -> usize {
        self.levels.len() / self.channel_count
    }

    /// Time between frames.
    #[must_use]
    pub fn step_time(&self) -> Duration {
        Duration::from_millis(u64::from(self.step_time_ms))
    }

    /// Output of every channel in one frame.
    #[must_use]
    pub fn frame(&self, index: usize) -> Option<&[u8]> {
        let start = index.checked_mul(self.channel_count)?;
        self.levels.get(start..start + self.channel_count)
    }

    /// Output of every channel at `time`, or `None` after the show ends.
    #[must_use]
    pub fn frame_at(&self, time: Duration) -> Option<&[u8]> {
        let index = time.as_millis() / u128::from(self.step_time_ms);
        self.frame(usize::try_from(index).ok()?)
    }

    /// Output of one channel across the whole show, the data a single phone needs.
    #[must_use]
    pub fn channel_track(&self, channel: usize) -> Option<Vec<u8>> {
        (channel < self.channel_count).then(|| {
            self.levels
                .iter()
                .skip(channel)
                .step_by(self.channel_count)
                .copied()
                .collect()
        })
    }
}

/// Emulates `show` on `vehicle` and stores the result for every frame.
#[must_use]
pub fn render(show: &Sequence, vehicle: Vehicle) -> Rendered {
    let channel_count = show.channel_count();
    let step_time_ms = show.header().step_time_ms;
    let dt_ms = u32::from(step_time_ms);

    let mut emulator = Emulator::new(vehicle, channel_count);
    let mut levels = Vec::with_capacity(show.data().len());
    for frame in show.frames() {
        emulator.step(frame, dt_ms);
        levels.extend(emulator.levels.iter().map(|&ppm| to_byte(ppm)));
    }

    Rendered {
        vehicle,
        channel_count,
        step_time_ms,
        levels,
    }
}
