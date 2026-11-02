# Development

Notes for working on the code: running with hot reload, tests and the demo video.
For using the app, see the [README](../README.md).

## Requirements

- [rustup](https://rustup.rs): `rust-toolchain.toml` installs the exact Rust version, `rustfmt`,
  `clippy` and the `wasm32-unknown-unknown` target automatically.
- Node 24 LTS and [wasm-pack](https://rustwasm.github.io/wasm-pack/).
- Chrome for the browser tests (or Safari with `BROWSER=safari`).
- For the demo video only: ffmpeg, and Python 3 for the Kokoro voice.

## Run with hot reload

```bash
cargo run --release -p lsa-server -- --tls   # terminal 1: party server (creates .lsa-tls/ first)
cd web && npm run dev:https                  # terminal 2: app on https://<address>:5173
```

`npm run dev` and a server without `--tls` work over plain `http`: the lights work, but phones
may sleep and the flashlight stays off.

Shortcut: `http://localhost:5173/?show=/@fs/<absolute path>.fseq&t=12000&vehicle=cybertruck`
opens a show from disk at 12 s.

## Everyday commands

```bash
cargo test --workspace --all-features   # every Rust test
cargo fmt --all                         # format
cargo lint                              # strict lint (same as CI)
cargo wasm-check                        # the engine still builds for the browser
cd web && npm run typecheck             # TypeScript
```

CI (`.github/workflows/ci.yml`) runs format, lint, tests and the browser build on every push.

## Browser tests

Tests that play Tesla's official example show need it downloaded once (into the git-ignored
`shows/`; CI does the same and fails rather than skipping them):

```bash
scripts/fetch-tesla-example.sh
```

Every browser test with real headless-Chrome phones, as CI runs them (starts and stops both
servers itself; needs `npm ci` and `npm run wasm` in `web/`):

```bash
cd web && scripts/e2e.sh                 # BROWSER=safari to use Safari windows
```

Or one at a time, with both servers running:

```bash
cd web
node scripts/party-e2e.mjs ../shows/<show>.fseq [channel] [seconds]
APP=https://localhost:5173 node scripts/party-e2e.mjs ../shows/<show>.fseq   # over HTTPS
DROP=1 node scripts/party-e2e.mjs ../shows/<show>.fseq   # phone 1 drops halfway and must keep time
node scripts/chirp-test.mjs && node scripts/calibrate-e2e.mjs   # speaker calibration
node scripts/car-test.mjs && node scripts/car-e2e.mjs ../shows/<tesla example 1>.fseq   # car preview
```

## Load test

One host and many simulated phones join at once, play, load the next song and all reconnect
after a Wi-Fi blip (200 phones in `cargo test`; more with `LSA_LOAD_PHONES`):

```bash
LSA_LOAD_PHONES=2000 cargo test --release -p lsa-server --test load -- --nocapture
```

One laptop serves 2000 phones: all get their light within 0.7 s of joining together, hear about
**Play** within 25 ms (the show starts 1 s after the press) and are back 0.8 s after a Wi-Fi blip.

## Demo video

The narrated demo video (`media/light-show-anywhere-demo.mp4`, 92 s, plus a WebM copy) is drawn
by code in [`web/src/demo/demo.ts`](../web/src/demo/demo.ts) and rendered frame by frame in
headless Chrome, so every run gives the same video.

```bash
scripts/fetch-tesla-example.sh                 # the show the video plays
cargo run --release -p lsa-server              # terminal 1
cd web && npm run dev                          # terminal 2
cd web && node scripts/capture-app.mjs         # screenshots of the real app → media/shots
cd web && node scripts/make-demo.mjs           # render, narrate, mix → media/
```

- Preview any moment at `http://localhost:5173/demo.html?t=50` (add `show`, `song` and `shots`
  as `make-demo.mjs` does to see the real lights and screenshots).
- The narration is the `NARRATION` list in `demo.ts`; it is also drawn as subtitles.
- The voice is [Kokoro](https://github.com/thewh1teagle/kokoro-onnx), which runs offline from
  `.demo-tools/` (a Python venv with `kokoro-onnx` and `soundfile`, plus
  `models/kokoro-v1.0.onnx` and `voices-v1.0.bin`). Without it, macOS `say` is used.
  `VOICE=am_michael` picks another voice; `NO_VOICE=1` leaves the narration out.
- [`demo-video-playbook.md`](demo-video-playbook.md) explains the whole method, to make the same
  kind of video for another project.
