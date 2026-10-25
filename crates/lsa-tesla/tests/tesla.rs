//! Behaviour tests. Expected values come from Tesla's README unless noted.

use lsa_fseq::Sequence;
use lsa_tesla::{
    Behavior, Channel, Closure, ClosureCommand, EXTENDED_CHANNELS, Light, LightBar, LightCommand,
    Rgb, RgbZone, STANDARD_CHANNELS, Side, Vehicle, closure_usage, render,
};

const STEP_MS: u8 = 20;
const FRAMES_PER_SECOND: usize = 50;

/// Builds a show from per-frame values of a single channel; all other channels stay 0.
fn single_channel_show(channels: usize, channel: usize, values: &[u8]) -> Sequence {
    let mut data = vec![0u8; channels * values.len()];
    for (frame, &value) in data.chunks_exact_mut(channels).zip(values) {
        frame[channel] = value;
    }
    Sequence::from_frames(channels as u32, STEP_MS, data).unwrap()
}

fn repeat(value: u8, seconds: f32) -> Vec<u8> {
    vec![value; (seconds * FRAMES_PER_SECOND as f32).round() as usize]
}

fn inner_beam() -> usize {
    Channel::Light(Light::InnerMainBeam(Side::Left))
        .index()
        .unwrap()
}

const ON_2000: u8 = 229;
const OFF_2000: u8 = 76;

// ---------------------------------------------------------------- channel map

#[test]
fn channel_numbers_match_tesla_template() {
    let number = |channel: Channel| channel.number().unwrap();

    assert_eq!(number(Channel::Light(Light::OuterMainBeam(Side::Left))), 1);
    assert_eq!(number(Channel::Light(Light::Channel4(Side::Left))), 7);
    assert_eq!(number(Channel::Light(Light::FrontTurn(Side::Right))), 14);
    assert_eq!(number(Channel::Light(Light::Brake)), 25);
    assert_eq!(number(Channel::Light(Light::LicensePlate)), 30);
    assert_eq!(
        number(Channel::Closure(Closure::FalconDoor(Side::Left))),
        31
    );
    assert_eq!(
        number(Channel::Closure(Closure::Window {
            side: Side::Right,
            rear: false
        })),
        39
    );
    assert_eq!(number(Channel::Closure(Closure::Liftgate)), 41);
    assert_eq!(number(Channel::Closure(Closure::ChargePort)), 46);
    let pixel = |bar, index| Channel::BarPixel { bar, index };
    assert_eq!(number(pixel(LightBar::Front, 0)), 47);
    assert_eq!(number(pixel(LightBar::Front, 59)), 106);
    assert_eq!(number(pixel(LightBar::Rear, 0)), 111);
    assert_eq!(number(pixel(LightBar::Rear, 51)), 162);
    assert_eq!(number(pixel(LightBar::Offroad, 5)), 172);
    assert_eq!(number(Channel::Suspension), 175);
    let interior = |zone, component| Channel::Interior { zone, component };
    assert_eq!(number(interior(RgbZone::Display, Rgb::Red)), 176);
    assert_eq!(number(interior(RgbZone::CenterFront, Rgb::Red)), 185);
    assert_eq!(number(interior(RgbZone::LeftRear, Rgb::Blue)), 193);
}

#[test]
fn every_channel_round_trips() {
    for index in 0..EXTENDED_CHANNELS {
        let channel = Channel::from_index(index, EXTENDED_CHANNELS);
        if channel != Channel::Unused {
            assert_eq!(channel.index(), Some(index), "{channel:?}");
        }
    }
    let unused: Vec<usize> = (0..EXTENDED_CHANNELS)
        .filter(|&i| Channel::from_index(i, EXTENDED_CHANNELS) == Channel::Unused)
        .map(|i| i + 1)
        .collect();
    let mut expected: Vec<usize> = (107..=110).chain(163..=166).chain(173..=174).collect();
    expected.extend(194..=200);
    assert_eq!(unused, expected);
}

#[test]
fn standard_layout_has_no_cybertruck_channels() {
    assert_eq!(
        Channel::from_index(45, STANDARD_CHANNELS),
        Channel::Closure(Closure::ChargePort)
    );
    assert_eq!(Channel::from_index(46, STANDARD_CHANNELS), Channel::Unused);
    assert_eq!(Channel::from_index(47, STANDARD_CHANNELS), Channel::Unused);
}

// ---------------------------------------------------------------- vehicles

#[test]
fn vehicle_behaviour_table() {
    let light = |l| Channel::Light(l);
    let signature = light(Light::Signature(Side::Left));
    assert_eq!(Vehicle::ModelS.behavior(signature), Behavior::Boolean);
    assert_eq!(Vehicle::Model3Y.behavior(signature), Behavior::Ramping);
    assert_eq!(Vehicle::Cybertruck.behavior(signature), Behavior::Absent);

    let brake = light(Light::Brake);
    assert_eq!(Vehicle::ModelX.behavior(brake), Behavior::Boolean);
    assert_eq!(
        Vehicle::Cybertruck.behavior(brake),
        Behavior::FullBrightness
    );

    let bar = Channel::BarPixel {
        bar: LightBar::Front,
        index: 0,
    };
    assert_eq!(Vehicle::Model3Y.behavior(bar), Behavior::Absent);
    assert_eq!(Vehicle::Cybertruck.behavior(bar), Behavior::FullBrightness);

    let falcon = Channel::Closure(Closure::FalconDoor(Side::Left));
    assert_eq!(Vehicle::ModelX.behavior(falcon), Behavior::Closure);
    assert_eq!(Vehicle::ModelS.behavior(falcon), Behavior::Absent);
}

// ---------------------------------------------------------------- commands

#[test]
fn documented_bytes_decode_and_encode() {
    let lights = [
        (0, false, 0),
        (25, false, 500),
        (51, false, 1000),
        (76, false, 2000),
        (178, true, 500),
        (204, true, 1000),
        (229, true, 2000),
        (255, true, 0),
    ];
    for (byte, on, ramp_ms) in lights {
        let command = LightCommand::from_byte(byte);
        assert_eq!(command, LightCommand { on, ramp_ms }, "byte {byte}");
        assert_eq!(command.to_byte(), byte);
    }
    // "Any brightness setting above 50 % will set the light to ON."
    assert!(!LightCommand::from_byte(127).on);
    assert!(LightCommand::from_byte(128).on);

    let closures = [
        (0, ClosureCommand::Idle),
        (63, ClosureCommand::Open),
        (127, ClosureCommand::Dance),
        (191, ClosureCommand::Close),
        (255, ClosureCommand::Stop),
    ];
    for (byte, command) in closures {
        assert_eq!(ClosureCommand::from_byte(byte), command);
        assert_eq!(command.to_byte(), byte);
    }
}

// ---------------------------------------------------------------- ramps

#[test]
fn readme_example_1_partial_ramp_then_instant_off() {
    // "Turn on; 2000 ms", effect duration 1 s: ramps to 50 %, then turns off instantly.
    let mut values = repeat(ON_2000, 1.0);
    values.extend(repeat(0, 0.2));
    let rendered = render(
        &single_channel_show(48, inner_beam(), &values),
        Vehicle::Model3Y,
    );
    let track = rendered.channel_track(inner_beam()).unwrap();

    assert_eq!(track[24], 64); // 25 % at 0.5 s
    assert_eq!(track[49], 128); // 50 % at 1 s
    assert_eq!(track[50], 0); // instant off
}

#[test]
fn readme_example_2_full_ramp_then_hold() {
    // "Turn on; 2000 ms", effect duration 4 s: 100 % after 2 s, holds for 2 s, then off.
    let mut values = repeat(ON_2000, 4.0);
    values.push(0);
    let rendered = render(
        &single_channel_show(48, inner_beam(), &values),
        Vehicle::Model3Y,
    );
    let track = rendered.channel_track(inner_beam()).unwrap();

    assert_eq!(track[99], 255);
    assert!(track[100..200].iter().all(|&v| v == 255));
    assert_eq!(track[200], 0);
}

#[test]
fn readme_example_3_ramps_reverse_mid_way() {
    // On 2000 ms for 2.06 s, off 2000 ms for 1.9 s, on 2000 ms for 2.06 s:
    // up to 100 %, down close to but not reaching 0 %, back up to 100 %.
    let mut values = repeat(ON_2000, 2.06);
    values.extend(repeat(OFF_2000, 1.9));
    values.extend(repeat(ON_2000, 2.06));
    let rendered = render(
        &single_channel_show(48, inner_beam(), &values),
        Vehicle::Model3Y,
    );
    let track = rendered.channel_track(inner_beam()).unwrap();

    assert_eq!(track[102], 255);
    let lowest = track[198];
    assert!((10..=15).contains(&lowest), "lowest point was {lowest}"); // ≈ 5 %
    assert_eq!(*track.last().unwrap(), 255);
}

#[test]
fn boolean_lights_switch_instantly() {
    // Model S signature lights are boolean: a ramp command just switches them.
    let signature = Channel::Light(Light::Signature(Side::Left))
        .index()
        .unwrap();
    let values = [ON_2000, ON_2000, 0];
    let track = render(
        &single_channel_show(48, signature, &values),
        Vehicle::ModelS,
    )
    .channel_track(signature)
    .unwrap();
    assert_eq!(track, vec![255, 255, 0]);
}

#[test]
fn full_brightness_and_absent_channels() {
    let pixel = Channel::BarPixel {
        bar: LightBar::Front,
        index: 3,
    }
    .index()
    .unwrap();
    let show = single_channel_show(EXTENDED_CHANNELS, pixel, &[0, 100, 200]);

    assert_eq!(
        render(&show, Vehicle::Cybertruck).channel_track(pixel),
        Some(vec![0, 100, 200])
    );
    assert_eq!(
        render(&show, Vehicle::Model3Y).channel_track(pixel),
        Some(vec![0, 0, 0])
    );
}

// ---------------------------------------------------------------- closures

#[test]
fn liftgate_opens_over_14_seconds_and_idle_lets_it_finish() {
    let liftgate = Channel::Closure(Closure::Liftgate).index().unwrap();
    // Open for 1 s only, then Idle: the open still completes.
    let mut values = repeat(ClosureCommand::Open.to_byte(), 1.0);
    values.extend(repeat(0, 14.0));
    let track = render(&single_channel_show(48, liftgate, &values), Vehicle::ModelX)
        .channel_track(liftgate)
        .unwrap();

    assert_eq!(track[349], 128); // halfway after 7 s
    assert_eq!(*track.last().unwrap(), 255);
}

#[test]
fn dance_requires_open_closure_except_windows() {
    let dance = ClosureCommand::Dance.to_byte();

    let liftgate = Channel::Closure(Closure::Liftgate).index().unwrap();
    let closed = render(
        &single_channel_show(48, liftgate, &repeat(dance, 1.0)),
        Vehicle::ModelX,
    )
    .channel_track(liftgate)
    .unwrap();
    assert!(
        closed.iter().all(|&v| v == 0),
        "closed liftgate must not dance"
    );

    let window = Channel::Closure(Closure::Window {
        side: Side::Left,
        rear: false,
    })
    .index()
    .unwrap();
    let dancing = render(
        &single_channel_show(48, window, &repeat(dance, 1.0)),
        Vehicle::Model3Y,
    )
    .channel_track(window)
    .unwrap();
    assert!(dancing.iter().any(|&v| v > 50), "windows dance from closed");
}

#[test]
fn closure_command_limits() {
    let port = Channel::Closure(Closure::ChargePort).index().unwrap();
    let open = ClosureCommand::Open.to_byte();
    let close = ClosureCommand::Close.to_byte();
    // Open, close, open, close: 4 commands, but the charge port allows 3.
    let values = [open, open, 0, close, open, 0, 0, close, close];
    let usage = closure_usage(&single_channel_show(48, port, &values));

    let port_usage = usage
        .iter()
        .find(|u| u.closure == Closure::ChargePort)
        .unwrap();
    assert_eq!(port_usage.commands, 4);
    assert_eq!(port_usage.limit, 3);
    assert!(port_usage.exceeded());
    assert!(
        usage
            .iter()
            .filter(|u| u.closure != Closure::ChargePort)
            .all(|u| u.commands == 0)
    );
}
