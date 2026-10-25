# Architecture

```
            .fseq + audio
                  │
            ┌─────▼──────┐
            │  lsa-fseq  │  parse / write / Tesla rules
            └─────┬──────┘
            ┌─────▼──────┐
            │ lsa-engine │  playback clock, frame at time t, beat detection
            └──┬──────┬──┘
     ┌─────────▼┐   ┌─▼──────────┐
     │ lsa-wasm │   │ lsa-server │  rooms, light roles, clock sync (WebSocket)
     └────┬─────┘   └─────┬──────┘
          │ browser        │ network
     ┌────▼────────────────▼────┐
     │ web app (React + WebGPU) │  car view, phone light, host controls
     └──────────────────────────┘
```

## Rules every crate follows

- Shared versions, metadata and lints live in the root `Cargo.toml`; crates opt in with
  `workspace = true`.
- No `unsafe` code (`unsafe_code = "forbid"`).
- Library code never panics on bad input. Every failure is a typed error.
- Engine crates must compile for `wasm32-unknown-unknown` (`cargo wasm-check`).
- Public items are documented; examples in docs are compiled and run as tests.

## Tesla notes (`lsa-tesla`)

- Source of truth: Tesla's README and `xlights_rgbeffects.xml` in the official template, not
  third-party summaries. LightCue (MIT) was used only as a cross-check.
- Channel bytes are commands: 25/51/76 = ramp off over 500/1000/2000 ms, 178/204/229 = ramp on,
  255 = instant on; closures 0/63/127/191/255 = idle/open/dance/close/stop.
- Brightness is emulated in parts per million so ramps land exactly on Tesla's examples.
- Channel 175 ("Suspension") exists in the template but is inactive and undocumented; it is
  treated as reserved.
- Closure positions and dance motion are preview approximations; Tesla only publishes travel
  times.

## FSEQ notes

- Tesla requires FSEQ **2.0 or 2.2**, **uncompressed**, **48 or 200 channels**, step time
  of at least **15 ms**, at most **4 hours** (`lsa_fseq::tesla`).
- xLights may write zstd-compressed files; `lsa-fseq` decodes them, and `Sequence::to_bytes`
  always writes the uncompressed form a car can play.
