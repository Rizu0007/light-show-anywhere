//! How each vehicle responds to each channel.
//!
//! From the "Light Channels with Brightness Control" and "Closures channels" tables in Tesla's
//! README. Outer main beams are modelled as LED reflector headlights (ramping); vehicles with
//! LED projector headlights switch them on and off instantly instead.

use crate::channel::{Channel, Closure, Light};

/// A Tesla model family with its own light behaviour.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Vehicle {
    /// Model S.
    ModelS,
    /// Model X.
    ModelX,
    /// Model 3 and Model Y.
    Model3Y,
    /// Cybertruck.
    Cybertruck,
}

/// How a channel's value turns into light (or movement) on a given vehicle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Behavior {
    /// On above 50 % brightness, off otherwise, switching instantly.
    Boolean,
    /// On/off with Tesla's built-in 500/1000/2000 ms ramps.
    Ramping,
    /// The value is the brightness.
    FullBrightness,
    /// A moving part.
    Closure,
    /// The vehicle has no such light or part.
    Absent,
}

impl Vehicle {
    /// Every supported vehicle.
    pub const ALL: [Self; 4] = [Self::ModelS, Self::ModelX, Self::Model3Y, Self::Cybertruck];

    /// How this vehicle handles `channel`.
    #[must_use]
    pub fn behavior(self, channel: Channel) -> Behavior {
        match channel {
            Channel::Light(light) => self.light_behavior(light),
            Channel::Closure(closure) => {
                if self.has_closure(closure) {
                    Behavior::Closure
                } else {
                    Behavior::Absent
                }
            }
            Channel::BarPixel { .. } => self.cybertruck_only(Behavior::FullBrightness),
            Channel::Interior { .. } => Behavior::FullBrightness,
            Channel::Suspension | Channel::Unused => Behavior::Absent,
        }
    }

    fn light_behavior(self, light: Light) -> Behavior {
        use Behavior::{Absent, Boolean, FullBrightness, Ramping};
        use Vehicle::{Cybertruck, Model3Y, ModelS, ModelX};

        match (light, self) {
            (Light::OuterMainBeam(_) | Light::InnerMainBeam(_), _)
            | (Light::Signature(_), Model3Y)
            | (
                Light::Channel4(_) | Light::Channel5(_) | Light::Channel6(_),
                ModelS | ModelX | Model3Y,
            )
            | (Light::FrontTurn(_), Model3Y | Cybertruck)
            | (Light::SideMarker(_), Cybertruck) => Ramping,

            // Rear turn: "L/R Rear Turn Signals have been disabled" on Cybertruck (remapping notes).
            (
                Light::Signature(_)
                | Light::Channel4(_)
                | Light::Channel5(_)
                | Light::Channel6(_)
                | Light::RearTurn(_),
                Cybertruck,
            ) => Absent,

            (Light::Brake, Cybertruck) => FullBrightness,

            _ => Boolean,
        }
    }

    fn has_closure(self, closure: Closure) -> bool {
        match closure {
            Closure::Mirror(_)
            | Closure::Window { .. }
            | Closure::ChargePort
            | Closure::Liftgate => true,
            Closure::DoorHandle { .. } => self == Self::ModelS,
            Closure::FrontDoor(_) | Closure::FalconDoor(_) => self == Self::ModelX,
        }
    }

    fn cybertruck_only(self, behavior: Behavior) -> Behavior {
        if self == Self::Cybertruck {
            behavior
        } else {
            Behavior::Absent
        }
    }
}
