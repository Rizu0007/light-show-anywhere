//! Tesla light-show semantics: what each channel controls and how each vehicle responds.
//!
//! Everything here follows Tesla's public documentation and template
//! (<https://github.com/teslamotors/light-show>):
//!
//! - [`Channel`]: the 200-channel map (lights, closures, Cybertruck light bars, interior RGB).
//! - [`Vehicle`] and [`Behavior`]: which lights switch, ramp, or dim on each model.
//! - [`LightCommand`] and [`ClosureCommand`]: what a channel byte means.
//! - [`render`]: emulates a whole show and stores each channel's output per frame.
//! - [`closure_usage`]: checks Tesla's per-show closure command limits.
//!
//! Not modelled yet: channels the vehicle combines with OR (aux park / side markers, channels
//! 4–6 on Model 3/Y), channel 4 setting the ramp time for channels 5–6, and Cybertruck
//! light remapping.
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
pub use vehicle::{Behavior, Vehicle};
