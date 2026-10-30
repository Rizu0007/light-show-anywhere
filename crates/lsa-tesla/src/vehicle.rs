//! How each vehicle responds to each channel, from Tesla's README and xLights template. Outer
//! main beams ramp (LED reflector). Not modelled: pre-Oct-2020 Model 3, regional/trim differences.

use crate::channel::{Channel, Closure, Light, Side};

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

/// How a light's channel is wired on a vehicle (see [`Vehicle::wiring`]).
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct Wiring {
    /// Channels whose on/off states are combined with OR to switch this light.
    pub sources: Vec<Channel>,
    /// Channel whose command sets the ramp time.
    pub ramp_from: Channel,
    /// Ramp time used for every change, whatever the commands say.
    pub fixed_ramp_ms: Option<u16>,
}

impl Wiring {
    fn own(channel: Channel) -> Self {
        Self {
            sources: vec![channel],
            ramp_from: channel,
            fixed_ramp_ms: None,
        }
    }
}

impl Vehicle {
    /// Every supported vehicle.
    pub const ALL: [Self; 4] = [Self::ModelS, Self::ModelX, Self::Model3Y, Self::Cybertruck];

    /// The vehicle named by `id`: `model-s`, `model-x`, `model-3y` or `cybertruck`.
    #[must_use]
    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "model-s" => Some(Self::ModelS),
            "model-x" => Some(Self::ModelX),
            "model-3y" => Some(Self::Model3Y),
            "cybertruck" => Some(Self::Cybertruck),
            _ => None,
        }
    }

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
            // Reverse: Cybertruck bed lights, which always ramp over 500 ms (see `wiring`).
            | (Light::SideMarker(_) | Light::Reverse, Cybertruck) => Ramping,

            // Rear turn: "L/R Rear Turn Signals have been disabled" on Cybertruck (remapping
            // notes). Fog lights and right aux park: the template has no Cybertruck light there.
            (
                Light::Signature(_)
                | Light::Channel4(_)
                | Light::Channel5(_)
                | Light::Channel6(_)
                | Light::RearTurn(_)
                | Light::FrontFog(_)
                | Light::RearFog
                | Light::AuxPark(Side::Right),
                Cybertruck,
            ) => Absent,

            (Light::Brake, Cybertruck) => FullBrightness,

            _ => Boolean,
        }
    }

    /// Which channels drive the light on `channel` (shared outputs OR them) and which sets its
    /// ramp time. Every channel of a shared output gets the same wiring.
    #[must_use]
    pub fn wiring(self, channel: Channel) -> Wiring {
        let Channel::Light(light) = channel else {
            return Wiring::own(channel);
        };
        let lights = |lights: &[Light]| lights.iter().map(|&l| Channel::Light(l)).collect();
        let own = Wiring::own(channel);
        match (light, self) {
            // "On Model 3/Y, all aux park and side markers operate together."
            (Light::AuxPark(_) | Light::SideMarker(_), Self::Model3Y) => Wiring {
                sources: lights(&[
                    Light::SideMarker(Side::Left),
                    Light::AuxPark(Side::Left),
                    Light::SideMarker(Side::Right),
                    Light::AuxPark(Side::Right),
                ]),
                ..own
            },
            // Model S: together, but with independent left/right control.
            (Light::AuxPark(side) | Light::SideMarker(side), Self::ModelS) => Wiring {
                sources: lights(&[Light::SideMarker(side), Light::AuxPark(side)]),
                ..own
            },
            // Model 3/Y: channels 4–6 are one output, ORed; channel 4 sets the ramp time.
            (
                Light::Channel4(side) | Light::Channel5(side) | Light::Channel6(side),
                Self::Model3Y,
            ) => Wiring {
                sources: lights(&[
                    Light::Channel4(side),
                    Light::Channel5(side),
                    Light::Channel6(side),
                ]),
                ramp_from: Channel::Light(Light::Channel4(side)),
                ..own
            },
            // Model S/X: individual on/off, but channel 4 sets the ramp time for all three.
            (
                Light::Channel4(side) | Light::Channel5(side) | Light::Channel6(side),
                Self::ModelS | Self::ModelX,
            ) => Wiring {
                ramp_from: Channel::Light(Light::Channel4(side)),
                ..own
            },
            // "Cybertruck Bed Lights always ramp on and off with a 500 ms duration."
            (Light::Reverse, Self::Cybertruck) => Wiring {
                fixed_ramp_ms: Some(500),
                ..own
            },
            _ => own,
        }
    }

    /// What `channel` is called on this vehicle. Cybertruck remaps some channels to other
    /// lights (README, "Cybertruck Light Remapping").
    #[must_use]
    pub fn channel_name(self, channel: Channel) -> String {
        if self == Self::Cybertruck {
            let renamed = match channel {
                Channel::Light(Light::Tail(side)) => Some(format!("{side} Reverse Light")),
                Channel::Light(Light::SideMarker(side)) => {
                    Some(format!("{side} Front Side Marker"))
                }
                Channel::Light(Light::SideRepeater(side)) => {
                    Some(format!("{side} Rear Side Marker"))
                }
                Channel::Light(Light::AuxPark(Side::Left)) => Some("Frunk Light".into()),
                Channel::Light(Light::Reverse) => Some("Bed Lights".into()),
                Channel::Closure(Closure::Liftgate) => Some("Powered Frunk".into()),
                _ => None,
            };
            if let Some(name) = renamed {
                return name;
            }
        }
        channel.to_string()
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
