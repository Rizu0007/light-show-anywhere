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
| 1b | `lsa-tesla` refinements | OR-combined channels (aux park/side markers, 4–6 on Model 3/Y), channel 4 as ramp leader, Cybertruck remapping | Tests from the README's mapping notes |
| 2 | Viewer | `lsa-wasm` + web page: 2D car (front/rear) plays a show with its song | ✅ Done: Tesla example 1 matches the file frame by frame (checked at 1.5 s and 13 s); Cybertruck bars, dimming and interior RGB verified with a generated 200-channel show |
| 3 | Party mode | Rust sync server (rooms, roles, clock sync) + phone page (one light, full screen) | 10 phones in a car shape stay within ~20 ms |
| 4 | Crowd quality | Safety governor, mic calibration, reconnect, late join | Survives a real party test |
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
