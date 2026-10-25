//! The Tesla channel map.
//!
//! Channel numbers come from Tesla's official xLights template
//! (`tesla_xlights_show_folder/xlights_rgbeffects.xml` in
//! <https://github.com/teslamotors/light-show>). Indexes in this module are 0-based; Tesla's
//! documentation and xLights count from 1, which [`Channel::number`] returns.

/// Left or right side of the vehicle.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Side {
    /// Driver's left.
    Left,
    /// Driver's right.
    Right,
}

/// An exterior light (channels 1–30).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Light {
    /// Outer main beam.
    OuterMainBeam(Side),
    /// Inner main beam.
    InnerMainBeam(Side),
    /// Signature light.
    Signature(Side),
    /// Ramping channel 4.
    Channel4(Side),
    /// Ramping channel 5.
    Channel5(Side),
    /// Ramping channel 6.
    Channel6(Side),
    /// Front turn signal.
    FrontTurn(Side),
    /// Front fog light.
    FrontFog(Side),
    /// Aux park light.
    AuxPark(Side),
    /// Side marker.
    SideMarker(Side),
    /// Side repeater.
    SideRepeater(Side),
    /// Rear turn signal.
    RearTurn(Side),
    /// Brake lights.
    Brake,
    /// Tail light.
    Tail(Side),
    /// Reverse lights.
    Reverse,
    /// Rear fog lights.
    RearFog,
    /// License plate lights.
    LicensePlate,
}

/// A moving part (channels 31–46).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Closure {
    /// Model X falcon door.
    FalconDoor(Side),
    /// Model X front door.
    FrontDoor(Side),
    /// Mirror fold.
    Mirror(Side),
    /// Window.
    Window {
        /// Vehicle side.
        side: Side,
        /// Rear window when `true`, front window otherwise.
        rear: bool,
    },
    /// Liftgate (Cybertruck: powered frunk).
    Liftgate,
    /// Model S door handle.
    DoorHandle {
        /// Vehicle side.
        side: Side,
        /// Rear handle when `true`, front handle otherwise.
        rear: bool,
    },
    /// Charge port door (Dance flashes its LED in rainbow colours).
    ChargePort,
}

/// A Cybertruck light bar with individually addressable LEDs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LightBar {
    /// Front bar, 60 LEDs (channels 47–106).
    Front,
    /// Rear bar, 52 LEDs (channels 111–162).
    Rear,
    /// Optional off-road bar, 6 segments (channels 167–172).
    Offroad,
}

impl LightBar {
    /// Number of LEDs in the bar.
    #[must_use]
    pub const fn len(self) -> usize {
        match self {
            Self::Front => 60,
            Self::Rear => 52,
            Self::Offroad => 6,
        }
    }

    /// Bars are never empty; present for API completeness.
    #[must_use]
    pub const fn is_empty(self) -> bool {
        false
    }

    const fn first_index(self) -> usize {
        match self {
            Self::Front => 46,
            Self::Rear => 110,
            Self::Offroad => 166,
        }
    }
}

/// An interior RGB zone (channels 176–193, three channels each).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum RgbZone {
    /// Center front display.
    Display,
    /// Right rear accent light.
    RightRear,
    /// Right front accent light.
    RightFront,
    /// Center front accent light.
    CenterFront,
    /// Left front accent light.
    LeftFront,
    /// Left rear accent light.
    LeftRear,
}

/// Colour component of an RGB zone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Rgb {
    /// Red.
    Red,
    /// Green.
    Green,
    /// Blue.
    Blue,
}

/// What a single channel controls.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Channel {
    /// An exterior light.
    Light(Light),
    /// A moving part.
    Closure(Closure),
    /// One LED of a Cybertruck light bar.
    BarPixel {
        /// Which bar.
        bar: LightBar,
        /// LED index within the bar, from 0.
        index: u8,
    },
    /// One colour of an interior RGB zone.
    Interior {
        /// Which zone.
        zone: RgbZone,
        /// Which colour.
        component: Rgb,
    },
    /// Present in the template but inactive and undocumented (channel 175).
    Suspension,
    /// Not assigned.
    Unused,
}

/// Total channels in the extended (200-channel) layout.
pub const EXTENDED_CHANNELS: usize = 200;
/// Total channels in the standard (48-channel) layout.
pub const STANDARD_CHANNELS: usize = 48;

const LIGHTS: [Light; 30] = {
    use Side::{Left as L, Right as R};
    [
        Light::OuterMainBeam(L),
        Light::OuterMainBeam(R),
        Light::InnerMainBeam(L),
        Light::InnerMainBeam(R),
        Light::Signature(L),
        Light::Signature(R),
        Light::Channel4(L),
        Light::Channel4(R),
        Light::Channel5(L),
        Light::Channel5(R),
        Light::Channel6(L),
        Light::Channel6(R),
        Light::FrontTurn(L),
        Light::FrontTurn(R),
        Light::FrontFog(L),
        Light::FrontFog(R),
        Light::AuxPark(L),
        Light::AuxPark(R),
        Light::SideMarker(L),
        Light::SideMarker(R),
        Light::SideRepeater(L),
        Light::SideRepeater(R),
        Light::RearTurn(L),
        Light::RearTurn(R),
        Light::Brake,
        Light::Tail(L),
        Light::Tail(R),
        Light::Reverse,
        Light::RearFog,
        Light::LicensePlate,
    ]
};

const RGB_ZONES: [RgbZone; 6] = [
    RgbZone::Display,
    RgbZone::RightRear,
    RgbZone::RightFront,
    RgbZone::CenterFront,
    RgbZone::LeftFront,
    RgbZone::LeftRear,
];

const LIGHTS_START: usize = 0;
const CLOSURES_START: usize = 30;
const SUSPENSION_INDEX: usize = 174;
const INTERIOR_START: usize = 175;

impl Channel {
    /// What the channel at 0-based `index` controls, for a file with `channel_count` channels.
    ///
    /// The 48-channel layout predates the Cybertruck, so channels 47–48 are unused there.
    #[must_use]
    pub fn from_index(index: usize, channel_count: usize) -> Self {
        if index >= channel_count {
            return Self::Unused;
        }
        if let Some(light) = index.checked_sub(LIGHTS_START).and_then(|i| LIGHTS.get(i)) {
            return Self::Light(*light);
        }
        if let Some(closure) = index
            .checked_sub(CLOSURES_START)
            .and_then(|i| Closure::ALL.get(i))
        {
            return Self::Closure(*closure);
        }
        if channel_count <= STANDARD_CHANNELS {
            return Self::Unused;
        }
        for bar in [LightBar::Front, LightBar::Rear, LightBar::Offroad] {
            let start = bar.first_index();
            if (start..start + bar.len()).contains(&index) {
                return Self::BarPixel {
                    bar,
                    index: (index - start) as u8,
                };
            }
        }
        if index == SUSPENSION_INDEX {
            return Self::Suspension;
        }
        if let Some(offset) = index.checked_sub(INTERIOR_START)
            && let Some(zone) = RGB_ZONES.get(offset / 3)
        {
            let component = match offset % 3 {
                0 => Rgb::Red,
                1 => Rgb::Green,
                _ => Rgb::Blue,
            };
            return Self::Interior {
                zone: *zone,
                component,
            };
        }
        Self::Unused
    }

    /// 0-based channel index, or `None` for [`Channel::Unused`].
    #[must_use]
    pub fn index(self) -> Option<usize> {
        match self {
            Self::Light(light) => LIGHTS.iter().position(|l| *l == light),
            Self::Closure(closure) => Closure::ALL
                .iter()
                .position(|c| *c == closure)
                .map(|i| CLOSURES_START + i),
            Self::BarPixel { bar, index } => {
                (usize::from(index) < bar.len()).then(|| bar.first_index() + usize::from(index))
            }
            Self::Interior { zone, component } => {
                let zone = RGB_ZONES.iter().position(|z| *z == zone)?;
                let component = match component {
                    Rgb::Red => 0,
                    Rgb::Green => 1,
                    Rgb::Blue => 2,
                };
                Some(INTERIOR_START + zone * 3 + component)
            }
            Self::Suspension => Some(SUSPENSION_INDEX),
            Self::Unused => None,
        }
    }

    /// 1-based channel number as shown in xLights and Tesla's documentation.
    #[must_use]
    pub fn number(self) -> Option<usize> {
        self.index().map(|i| i + 1)
    }
}

impl core::fmt::Display for Side {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::Left => "Left",
            Self::Right => "Right",
        })
    }
}

impl core::fmt::Display for Light {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let (side, name) = match self {
            Self::OuterMainBeam(s) => (Some(s), "Outer Main Beam"),
            Self::InnerMainBeam(s) => (Some(s), "Inner Main Beam"),
            Self::Signature(s) => (Some(s), "Signature"),
            Self::Channel4(s) => (Some(s), "Channel 4"),
            Self::Channel5(s) => (Some(s), "Channel 5"),
            Self::Channel6(s) => (Some(s), "Channel 6"),
            Self::FrontTurn(s) => (Some(s), "Front Turn"),
            Self::FrontFog(s) => (Some(s), "Front Fog"),
            Self::AuxPark(s) => (Some(s), "Aux Park"),
            Self::SideMarker(s) => (Some(s), "Side Marker"),
            Self::SideRepeater(s) => (Some(s), "Side Repeater"),
            Self::RearTurn(s) => (Some(s), "Rear Turn"),
            Self::Brake => (None, "Brake Lights"),
            Self::Tail(s) => (Some(s), "Tail"),
            Self::Reverse => (None, "Reverse Lights"),
            Self::RearFog => (None, "Rear Fog Lights"),
            Self::LicensePlate => (None, "License Plate"),
        };
        match side {
            Some(side) => write!(f, "{side} {name}"),
            None => f.write_str(name),
        }
    }
}

impl core::fmt::Display for Closure {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let position = |rear: bool| if rear { "Rear" } else { "Front" };
        match self {
            Self::FalconDoor(s) => write!(f, "{s} Falcon Door"),
            Self::FrontDoor(s) => write!(f, "{s} Front Door"),
            Self::Mirror(s) => write!(f, "{s} Mirror"),
            Self::Window { side, rear } => write!(f, "{side} {} Window", position(*rear)),
            Self::Liftgate => f.write_str("Liftgate"),
            Self::DoorHandle { side, rear } => {
                write!(f, "{side} {} Door Handle", position(*rear))
            }
            Self::ChargePort => f.write_str("Charge Port"),
        }
    }
}

impl core::fmt::Display for Channel {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Light(light) => light.fmt(f),
            Self::Closure(closure) => closure.fmt(f),
            Self::BarPixel { bar, index } => {
                let bar = match bar {
                    LightBar::Front => "Front Light Bar",
                    LightBar::Rear => "Rear Light Bar",
                    LightBar::Offroad => "Offroad Light Bar",
                };
                write!(f, "{bar} {}", u16::from(*index) + 1)
            }
            Self::Interior { zone, component } => {
                let zone = match zone {
                    RgbZone::Display => "Center Front Display",
                    RgbZone::RightRear => "Right Rear RGB",
                    RgbZone::RightFront => "Right Front RGB",
                    RgbZone::CenterFront => "Center Front RGB",
                    RgbZone::LeftFront => "Left Front RGB",
                    RgbZone::LeftRear => "Left Rear RGB",
                };
                let component = match component {
                    Rgb::Red => "R",
                    Rgb::Green => "G",
                    Rgb::Blue => "B",
                };
                write!(f, "{zone} ({component})")
            }
            Self::Suspension => f.write_str("Suspension (reserved)"),
            Self::Unused => f.write_str("Unused"),
        }
    }
}
