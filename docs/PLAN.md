# Plan

_Last reviewed: 2026-10-25._

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
5. **Microphone latency calibration:** each phone hears a test tone and corrects its own delay.
6. **Plays any `.fseq`:** official Tesla examples, LightCue, LightMyTesla, xlightshows.io.

## Phases

| # | Phase | Output | Done when |
|---|-------|--------|-----------|
| 0 | Workspace + `lsa-fseq` | Read/write FSEQ v2, Tesla rule checks, CI | ✅ Done |
| 1 | `lsa-tesla` | 200-channel map, light/closure decoding, ramp emulation, closure limits | ✅ Done: matches Tesla's README ramp examples; renders Tesla's official example 1 (45 s) in ~0.3 ms |
| 1b | `lsa-tesla` refinements | OR-combined channels (aux park/side markers, 4–6 on Model 3/Y), channel 4 as ramp leader, Cybertruck remapping | ✅ Done: tests from the README's mapping notes; phones use Cybertruck light names and colours, the viewer uses the names (its drawing colours are still generic). Not modelled: pre-Oct-2020 Model 3 tail/plate, regional/trim differences |
| 2 | Viewer | `lsa-wasm` + web page: 2D car (front/rear) plays a show with its song | ✅ Done: Tesla example 1 matches the file frame by frame (checked at 1.5 s and 13 s); Cybertruck bars, dimming and interior RGB verified with a generated 200-channel show |
| 3 | Party mode | Rust sync server (rooms, roles, clock sync) + phone page (one light, full screen) | ✅ Done: 7 server tests over real WebSockets; end-to-end with 2 headless-Chrome phones on Tesla example 1: all light changes matched, mean error ≈ 8 ms, worst ≈ 15 ms, phones within 13 ms. Real phones on Wi-Fi not tested yet. |
| 4 | Crowd quality | Safety governor (flash limit), HTTPS for wake lock + flashlight, reconnect/resume for host and phones, mic calibration, load test with many phones | Survives a real party test. Governor ✅: every phone track ≤ 3 flashes/s (WCAG 2.3.1, red counted as white), ≥ 150 ms ramps; tested on synthetic strobes and every light of Tesla example 1; e2e sync unchanged (mean ≈ 7 ms). HTTPS ✅: `--tls` self-signed certificate for the LAN addresses (kept and reused; renewed for new networks or near expiry) or `--cert/--key`; Vite `dev:https`; e2e over HTTPS passes (mean ≈ 7 ms). Reconnect ✅: dropped phones and host keep their place (and light) for 2 min and resume with a session token; phones keep playing meanwhile, and joining/leaving phones no longer move others' lights; e2e with phone 1 cut mid-show: reconnected, 14/14 changes in time. Still to check on real phones: wake lock and flashlight after accepting the warning, reconnect after a locked screen |
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
