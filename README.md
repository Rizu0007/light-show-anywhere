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

```bash
cargo run --release -p lsa-server        # terminal 1: party server on :8787
cd web && npm run dev                    # terminal 2: app on :5173 (proxies /ws to the server)
```

1. On the host computer, open the app using its **network address** (the `Network:` line Vite
   prints, e.g. `http://192.168.1.20:5173`) — phones cannot reach `localhost`.
2. Load a show (and its song), press **Start party**, show the QR code.
3. Phones on the same Wi-Fi scan it and tap **Join**; each becomes one light.
4. Press **Play**. Use **Speaker delay** if sound arrives after the lights (Bluetooth speakers).

Over plain `http` on a LAN, phones can't keep the screen awake or use the flashlight (browsers
require HTTPS for those); the light itself works.

End-to-end check with real headless-Chrome phones (needs both servers running):

```bash
cd web && node scripts/party-e2e.mjs ../shows/<show>.fseq [channel] [seconds]
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
