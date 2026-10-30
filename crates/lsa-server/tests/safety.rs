//! Safety governor tests, checked with an independent flash counter.

use lsa_server::safety::{MAX_FLASHES_PER_SECOND, MIN_RAMP_MS, govern, luminance};

const STEP_MS: u8 = 20;

/// Times (ms) of every change that counts as half a flash, found from the turning points of the
/// luminance curve.
fn transition_times(levels: &[u8], step_ms: u8) -> Vec<u32> {
    let mut times = Vec::new();
    // The extreme reached since the last counted change, and which way that change went.
    let mut extreme = 0.0f32;
    let mut last_rising: Option<bool> = None;
    for (frame, &level) in levels.iter().enumerate() {
        let lum = luminance(level);
        let rising = lum > extreme;
        let opposite = last_rising != Some(rising);
        let change = (lum - extreme).abs();
        if opposite && change >= 0.1 && lum.min(extreme) < 0.8 {
            times.push(frame as u32 * u32::from(step_ms));
            last_rising = Some(rising);
            extreme = lum;
        } else if last_rising == Some(rising) {
            extreme = lum;
        }
    }
    times
}

/// Most flashes (pairs of changes) in any one-second window.
fn max_flashes_per_second(levels: &[u8], step_ms: u8) -> f32 {
    let times = transition_times(levels, step_ms);
    let most = times
        .iter()
        .map(|&start| {
            times
                .iter()
                .filter(|&&t| t >= start && t < start + 1000)
                .count()
        })
        .max()
        .unwrap_or(0);
    most as f32 / 2.0
}

fn assert_safe(levels: &[u8], step_ms: u8) {
    let flashes = max_flashes_per_second(levels, step_ms);
    assert!(
        flashes <= MAX_FLASHES_PER_SECOND as f32,
        "{flashes} flashes in one second"
    );
    let max_change = (255 * u32::from(step_ms)).div_ceil(MIN_RAMP_MS);
    let mut previous = 0u8;
    for &level in levels {
        assert!(u32::from(level.abs_diff(previous)) <= max_change);
        previous = level;
    }
}

#[test]
fn fast_strobe_is_slowed_to_three_flashes_per_second() {
    // Tesla shows can switch every 20 ms frame: 25 flashes per second.
    let strobe: Vec<u8> = (0..300).map(|i| if i % 2 == 0 { 255 } else { 0 }).collect();
    assert!(max_flashes_per_second(&strobe, STEP_MS) > 20.0);

    let governed = govern(&strobe, STEP_MS);
    assert_safe(&governed, STEP_MS);
    // The light still pulses at full brightness instead of being held dark or steady.
    assert!(governed.contains(&255));
    assert!(max_flashes_per_second(&governed, STEP_MS) >= 2.0);
}

#[test]
fn slow_blinks_pass_except_for_ramped_edges() {
    // On 500 ms, off 500 ms: one flash per second.
    let blink: Vec<u8> = (0..250)
        .map(|i| if (i / 25) % 2 == 0 { 255 } else { 0 })
        .collect();
    let governed = govern(&blink, STEP_MS);
    assert_safe(&governed, STEP_MS);

    // Each edge takes at most 150 ms; the rest of every half-second matches the show.
    let edge_frames = (MIN_RAMP_MS / u32::from(STEP_MS)) as usize + 1;
    for (i, (&want, &got)) in blink.iter().zip(&governed).enumerate() {
        if i % 25 >= edge_frames {
            assert_eq!(got, want, "frame {i}");
        }
    }
}

#[test]
fn tesla_ramps_are_untouched() {
    // A 2000 ms ramp up and down (Tesla's slowest) is far below every limit.
    let up = (0..100).map(|i| (i * 255 / 99) as u8);
    let ramp: Vec<u8> = up.clone().chain(up.rev()).collect();
    assert_eq!(govern(&ramp, STEP_MS), ramp);
}

#[test]
fn dim_changes_do_not_count_as_flashes() {
    // Flickering between 0 and 12 % level stays below a 10 % luminance change (and within one
    // frame's ramp).
    let flicker: Vec<u8> = (0..100).map(|i| if i % 2 == 0 { 30 } else { 0 }).collect();
    assert!(luminance(30) < 0.1);
    assert_eq!(govern(&flicker, STEP_MS), flicker);
}

#[test]
fn other_frame_rates_are_governed() {
    for step_ms in [15, 50, 100] {
        let strobe: Vec<u8> = (0..400).map(|i| if i % 2 == 0 { 255 } else { 0 }).collect();
        assert_safe(&govern(&strobe, step_ms), step_ms);
    }
}

#[test]
fn every_light_of_tesla_example_1_is_safe() {
    // Tesla's example show is not redistributed; scripts/fetch-tesla-example.sh downloads it.
    // Without it the test skips, unless LSA_REQUIRE_SHOWS is set (CI).
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../shows/tesla/lightshow_example_1_elevator_music/lightshow_example_1_elevator_music/lightshow.fseq"
    );
    let Ok(bytes) = std::fs::read(path) else {
        assert!(
            std::env::var_os("LSA_REQUIRE_SHOWS").is_none(),
            "{path} not found; run scripts/fetch-tesla-example.sh"
        );
        eprintln!("skipped: {path} not found");
        return;
    };
    let show = lsa_fseq::Sequence::parse(&bytes).unwrap();
    for vehicle in lsa_tesla::Vehicle::ALL {
        let rendered = lsa_tesla::render(&show, vehicle);
        for channel in 0..30 {
            let track = rendered.channel_track(channel).unwrap();
            assert_safe(
                &govern(&track, show.header().step_time_ms),
                show.header().step_time_ms,
            );
        }
    }
}
