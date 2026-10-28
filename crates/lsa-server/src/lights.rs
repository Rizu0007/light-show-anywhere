//! Which lights phones play, in what order, and in what colour.

use lsa_tesla::{Behavior, Channel, Light, Rendered, Side, Vehicle};

/// Lights handed out to phones, most recognisable first. Light-bar pixels and interior zones
/// are not handed out automatically.
const PRIORITY: [Light; 30] = {
    use Side::{Left as L, Right as R};
    [
        Light::OuterMainBeam(L),
        Light::OuterMainBeam(R),
        Light::InnerMainBeam(L),
        Light::InnerMainBeam(R),
        Light::Signature(L),
        Light::Signature(R),
        Light::FrontTurn(L),
        Light::FrontTurn(R),
        Light::Brake,
        Light::Tail(L),
        Light::Tail(R),
        Light::RearTurn(L),
        Light::RearTurn(R),
        Light::FrontFog(L),
        Light::FrontFog(R),
        Light::Reverse,
        Light::Channel4(L),
        Light::Channel4(R),
        Light::Channel5(L),
        Light::Channel5(R),
        Light::Channel6(L),
        Light::Channel6(R),
        Light::SideRepeater(L),
        Light::SideRepeater(R),
        Light::AuxPark(L),
        Light::AuxPark(R),
        Light::SideMarker(L),
        Light::SideMarker(R),
        Light::RearFog,
        Light::LicensePlate,
    ]
};

/// Parses the vehicle names used by the web app.
#[must_use]
pub fn parse_vehicle(name: &str) -> Option<Vehicle> {
    match name {
        "model-s" => Some(Vehicle::ModelS),
        "model-x" => Some(Vehicle::ModelX),
        "model-3y" => Some(Vehicle::Model3Y),
        "cybertruck" => Some(Vehicle::Cybertruck),
        _ => None,
    }
}

/// 1-based channels to hand out for this show: lights the vehicle has and the show uses.
#[must_use]
pub fn playable_channels(rendered: &Rendered) -> Vec<u16> {
    let vehicle = rendered.vehicle();
    PRIORITY
        .iter()
        .map(|&light| Channel::Light(light))
        .filter(|&channel| vehicle.behavior(channel) != Behavior::Absent)
        .filter_map(Channel::index)
        .filter(|&index| {
            rendered
                .channel_track(index)
                .is_some_and(|track| track.iter().any(|&level| level > 0))
        })
        .map(|index| (index + 1) as u16)
        .collect()
}

/// Colour a phone shows for a channel.
#[must_use]
pub fn color_of(channel: Channel) -> &'static str {
    match channel {
        Channel::Light(
            Light::FrontTurn(_)
            | Light::RearTurn(_)
            | Light::SideRepeater(_)
            | Light::SideMarker(_),
        ) => "amber",
        Channel::Light(Light::Brake | Light::Tail(_) | Light::RearFog) => "red",
        _ => "white",
    }
}
