# Plan

_Last reviewed: 2026-10-30._

## One line

**Human Tesla:** play real Tesla light shows on a crowd of phones arranged as a car (or a fleet of
cars), where every phone is one specific light and behaves exactly like that light on the car.

## What already exists (and what we do with it)

| Need | Existing project | Licence | Decision |
|------|------------------|---------|----------|
| Song → Tesla show | [LightCue](https://github.com/wmorrill3/lightcue) (new, v1), LightMyTesla, TLGen, Light Show Creator | LightCue: MIT; others closed | **Don't build a generator.** Import their `.fseq` output. |
| Tesla channel map + byte meanings | LightCue `engine/channels.js`, `docs/SHOW-FORMAT.md` (from Tesla's public template) | MIT | **Reuse the facts with credit**, verify against Tesla's official example shows. |
| Crowd phones flashing in sync | [crowd-light-show](https://github.com/AndriiShramko/crowd-light-show), Concert Lume, Glanz, LightUp Crowd, Crowdr | crowd-light-show: Apache-2.0 | **Study its sync and safety design** before writing ours. It plays presets and music-reactive effects, not choreographed Tesla shows mapped to positions. |
| Clock sync across phones | Beatsync, SyncWave, SyncSound, collective-soundworks sync | MIT / various | **Reuse the proven approach** (NTP-style ping over WebSocket, schedule on the audio clock, drift correction). |
| `.fseq` reading/writing in Rust | None mature on crates.io | — | **Built our own** (`lsa-fseq`, done). |
| Tesla's in-car player internals | Inside vehicle firmware | Proprietary | **Out of scope.** Not extracted, not needed. |

## What is new (our part)

1. **Position mapping:** each phone is assigned one Tesla light (left headlight, brake light, a
   Cybertruck light-bar pixel…) and placed in a car-shaped layout.
2. **Faithful Tesla behaviour:** phones emulate Tesla's built-in ramps (byte 178 = fade on over
   500 ms, etc.), so a show looks like it does on the car.
3. **Fleet shows → groups:** a 5- or 8-car Tesla show becomes 5 or 8 groups of people.
4. **Safety governor:** Tesla shows strobe faster than is safe for a crowd. Every phone limits
   flashes (≤ 3 per second, no large red strobe, minimum ramps), following WCAG 2.3.1 as
   crowd-light-show does.
5. **Microphone latency calibration:** phones hear test tones from the speaker and measure how
   late they arrive; the host sets one speaker delay from the median. (Not a per-phone
   correction: lights must stay in step with each other for the car's shape to read from a
   distance.)
6. **Plays any `.fseq`:** official Tesla examples, LightCue, LightMyTesla, xlightshows.io.

## Phases

| # | Phase | Output | Done when |
|---|-------|--------|-----------|
| 0 | Workspace + `lsa-fseq` | Read/write FSEQ v2, Tesla rule checks, CI | ✅ Done |
| 1 | `lsa-tesla` | 200-channel map, light/closure decoding, ramp emulation, closure limits | ✅ Done: matches Tesla's README ramp examples; renders Tesla's official example 1 (45 s) in ~0.3 ms |
| 1b | `lsa-tesla` refinements | OR-combined channels (aux park/side markers, 4–6 on Model 3/Y), channel 4 as ramp leader, Cybertruck remapping | ✅ Done: tests from the README's mapping notes; phones use Cybertruck light names and colours, the viewer uses the names (its drawing colours are still generic). Not modelled: pre-Oct-2020 Model 3 tail/plate, regional/trim differences |
| 2 | Viewer | `lsa-wasm` + web page: 2D car (front/rear) plays a show with its song | ✅ Done: Tesla example 1 matches the file frame by frame (checked at 1.5 s and 13 s); Cybertruck bars, dimming and interior RGB verified with a generated 200-channel show |
| 3 | Party mode | Rust sync server (rooms, roles, clock sync) + phone page (one light, full screen) | ✅ Done: server tests over real WebSockets (7 at the time; 14 with phase 4); end-to-end with 2 headless-Chrome phones on Tesla example 1: all light changes matched, mean error ≈ 8 ms, worst ≈ 15 ms, phones within 13 ms. Real phones on Wi-Fi not tested yet. |
| 4 | Crowd quality | Safety governor (flash limit), HTTPS for wake lock + flashlight, reconnect/resume for host and phones, mic calibration, load test with many phones | Survives a real party test. Governor ✅: every phone track ≤ 3 flashes/s (WCAG 2.3.1, red counted as white), ≥ 150 ms ramps; tested on synthetic strobes and every light of Tesla example 1; e2e sync unchanged (mean ≈ 7 ms). HTTPS ✅: `--tls` self-signed certificate for the LAN addresses (kept and reused; renewed for new networks or near expiry) or `--cert/--key`; Vite `dev:https`; e2e over HTTPS passes (mean ≈ 7 ms). Reconnect ✅: dropped phones and host keep their place (and light) for 2 min and resume with a session token; phones keep playing meanwhile, and joining/leaving phones no longer move others' lights; e2e with phone 1 cut mid-show: reconnected, 14/14 changes in time. Mic calibration ✅: matched-filter detector exact to < 0.01 ms on synthetic recordings (noise louder than the tone, louder echoes, hum); in headless Chrome a known 200 ms delay measures within one audio render block (± 2.7 ms at 48 kHz); a just-started audio clock was up to 8 ms off, so the clock is trusted only after 2 s and the host makes its audio context when the party starts. CI ✅: fetches Tesla example 1 (pinned, hash-checked) so its tests fail instead of skipping, and runs every browser test (party, dropped phone, calibration, HTTPS) in headless Chrome; checked in a Linux container, where Chrome without a sound card wanders ± 12 ms, so CI allows ± 20 ms for calibration. Load test ✅ (`tests/load.rs`, real WebSockets, one laptop, release build): 2000 phones joining at once all have their light within 0.7 s (clock-sync round trip p99 24 ms), **Play** reaches the last phone in 24 ms (start lead 1000 ms), the next song's tracks reach all in 0.19 s, and after a Wi-Fi blip all are back in 0.8 s, each within 94 ms of retrying. It found two problems, now fixed: the host got a full roster per change (a blip with 1000 phones sent it 2000 rosters, 114 MB), now batched to one per 200 ms (0.2 MB); and phones reconnected at fixed delays, so 2000 at once overflowed the listen queue (128 on macOS) and a quarter waited 6.5 s for TCP retries, now spread by random retry delays. The practical limit is the Wi-Fi router, not the server. Real-phone kit ✅: phones report their health (clock sync, round trip, screen kept awake, flashlight, HTTPS, reconnects) and the host's phone list flags problems; the wake lock is now taken again whenever the page comes back (browsers drop it when the screen locks, so a phone that had been locked could fall asleep mid-show); checklist in `docs/party-test.md`. Still to check on real phones (run `docs/party-test.md`): wake lock and flashlight after accepting the warning, reconnect after a locked screen, calibration with a real speaker (phone microphone delay, unknown to the browser, adds a few ms) |
| 5 | Extras | Fleet groups, any-shape layouts, WLED output, video export | Each ships separately |

## Research before each phase

- **Phase 1:** download Tesla's official template and example shows into `shows/` (git-ignored, not
  redistributed); compare our decoder with LightCue's `rampOf`/`closureOf`.
- **Phase 3:** read crowd-light-show's sync code and Beatsync's design; reuse code only where the
  licence allows, with attribution.
- **REA (optional):** study xLights effects or Hue Sync latency handling if a question remains that
  public sources do not answer.

## Rules

- Search before building; reuse mature, compatible-licence code; otherwise write our own with tests.
- Never bundle other people's shows or songs; link to the source instead.
- No firmware extraction or circumvention.
