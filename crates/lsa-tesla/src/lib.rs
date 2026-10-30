//! Tesla light-show semantics from Tesla's docs and template
//! (<https://github.com/teslamotors/light-show>): the [`Channel`] map, per-[`Vehicle`] behaviour,
//! byte commands, and [`render`], which emulates a whole show.
//!
//! ```
//! use lsa_fseq::Sequence;
//! use lsa_tesla::{Channel, Light, LightCommand, Side, Vehicle, render};
//!
//! // Left inner main beam, "Turn on; 2000 ms" held for 1 s (50 frames of 20 ms).
//! let beam = Channel::Light(Light::InnerMainBeam(Side::Left)).index().unwrap();
//! let on_2000 = LightCommand { on: true, ramp_ms: 2000 }.to_byte();
//! let mut data = vec![0u8; 48 * 50];
//! for frame in data.chunks_exact_mut(48) {
//!     frame[beam] = on_2000;
//! }
//! let show = Sequence::from_frames(48, 20, data)?;
//!
//! // Tesla's README: the light reaches 50 % after 1 s.
//! let rendered = render(&show, Vehicle::Model3Y);
//! assert_eq!(rendered.frame(49).unwrap()[beam], 128);
//! # Ok::<(), lsa_fseq::FseqError>(())
//! ```

mod channel;
mod closure;
mod command;
mod emulate;
mod vehicle;

pub use channel::{
    Channel, Closure, EXTENDED_CHANNELS, Light, LightBar, Rgb, RgbZone, STANDARD_CHANNELS, Side,
};
pub use closure::{ClosureUsage, closure_usage};
pub use command::{ClosureCommand, LightCommand};
pub use emulate::{Emulator, Rendered, render};
pub use vehicle::{Behavior, Vehicle, Wiring};
