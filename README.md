# Light Show Anywhere

**Human Tesla:** play real Tesla light shows on a crowd of phones arranged as a car, where every
phone is one light. See [docs/PLAN.md](docs/PLAN.md).

## Status

| Crate | Purpose | State |
|-------|---------|-------|
| [`lsa-fseq`](crates/lsa-fseq) | Read and write FSEQ v2 sequences, check Tesla rules | ✅ Done |
| [`lsa-tesla`](crates/lsa-tesla) | Channel map, light/closure decoding, Tesla ramp emulation | ✅ Done (see limits in docs) |
| [`lsa-wasm`](crates/lsa-wasm) | Browser bindings (129 KB WebAssembly) | ✅ Done |
| [`web/`](web) | Viewer: front/rear car plays any show with its song | ✅ Done |
| [`lsa-server`](crates/lsa-server) | Party server: rooms, clock sync, light assignment, per-phone tracks | ✅ Done |

## Run the viewer

```bash
cd web
npm install
npm run dev          # builds the engine to WebAssembly, then opens http://localhost:5173
```

Drop a `.fseq` show and its `.wav`/`.mp3` onto the page, pick a vehicle, press Play.
Development shortcut: `http://localhost:5173/?show=/@fs/<absolute path>.fseq&t=12000&vehicle=cybertruck`
opens a file from disk at 12 s.

## Run a party (phones as lights)

Phones only keep the screen awake and use the flashlight on **HTTPS** pages, so a real party runs
with `--tls`. The server then makes its own certificate for this computer's network addresses and
keeps it in `.lsa-tls/` (git-ignored).

```bash
(cd web && npm install && npm run build)
cargo run --release -p lsa-server -- --tls --static web/dist   # app + party server on :8787
```

1. On the host computer, open the **https://** network address the server prints (e.g.
   `https://192.168.1.20:8787`), not `localhost`, since phones cannot reach that. Accept the
   certificate warning once.
2. Load a show (and its song), press **Start party**, show the QR code.
3. Phones on the same Wi-Fi scan it and tap **Join**. Each phone warns about the certificate once
   (Chrome: *Advanced → Proceed*; Safari: *Show Details → visit this website*). Each becomes one
   light.
4. Press **Play**. If sound arrives after the lights (Bluetooth speakers), set **Speaker
   delay**, or let the phones measure it: guests who tick *Help tune the sound* lend their
   microphone, **Measure speaker delay** plays five short tones through the speaker, and
   **Use … ms** applies the median of what the phones heard. Measure with the speaker you will
   use for the song, with the show paused.

Dropped connections are fine: a phone that loses Wi-Fi, locks its screen or reloads the page
gets its light back when it returns, and keeps playing on its own meanwhile. If the host computer
drops, phones keep playing and the host takes the room back when it reconnects. A place is kept
for 2 minutes; **End party** closes the room at once.

The certificate is reused, so phones are not warned again. It is renewed (and phones warn once
more) when the computer joins a network it does not cover yet, or a month before it expires. With
a real certificate for a domain, use `--cert cert.pem --key key.pem` instead of `--tls`.

While developing, run the app with Vite instead (hot reload):

```bash
cargo run --release -p lsa-server -- --tls   # terminal 1: party server (creates .lsa-tls/ first)
cd web && npm run dev:https                  # terminal 2: app on https://<address>:5173
```

`npm run dev` and a server without `--tls` work over plain `http`; the lights work, but phones
may sleep and the flashlight is off.

End-to-end check with real headless-Chrome phones (needs both servers running):

```bash
cd web && node scripts/party-e2e.mjs ../shows/<show>.fseq [channel] [seconds]
# over HTTPS (lsa-server --tls, npm run dev:https):
cd web && APP=https://localhost:5173 node scripts/party-e2e.mjs ../shows/<show>.fseq
# cut phone 1's connection halfway; it must reconnect and keep time:
cd web && DROP=1 node scripts/party-e2e.mjs ../shows/<show>.fseq
# speaker calibration (needs only `npm run dev`): detector on synthetic recordings, then the
# whole browser pipeline with the tones wired into a fake microphone through a known delay
cd web && node scripts/chirp-test.mjs && node scripts/calibrate-e2e.mjs
```

## Requirements

- [rustup](https://rustup.rs). `rust-toolchain.toml` installs the exact Rust version,
  `rustfmt`, `clippy` and the `wasm32-unknown-unknown` target automatically.
- Node 24 LTS (for the web app, later).

## Everyday commands

```bash
cargo test --workspace --all-features   # run every test
cargo fmt --all                         # format code
cargo lint                              # strict lint (same as CI)
cargo wasm-check                        # confirm the engine still builds for the browser

# Tools (put shows in the git-ignored shows/ folder)
cargo run -p lsa-fseq --example inspect -- shows/my-show.fseq           # header + channel values
cargo run --release -p lsa-tesla --example render -- shows/my-show.fseq # emulate on every vehicle
cargo run -p lsa-tesla --example demo_show -- shows/demo/chase.fseq     # 200-channel test show
```

CI runs format, lint, tests and the browser build on every push
(`.github/workflows/ci.yml`).

## Layout

```
crates/        Rust crates (one folder per crate)
docs/          Design notes
.cargo/        Command aliases
```

See [docs/architecture.md](docs/architecture.md) for how the parts fit together.
