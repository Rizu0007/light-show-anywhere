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

**Fleet shows** (Tesla's multi-car shows: one `.fseq` per car in `Car #1`, `Car #2`… folders)
load with **Fleet show (folder)**. Phones are dealt across the cars, every car's headlights
first, and each phone shows its car number in large type: group the guests by car, numbered
left to right as seen from the front. **Preview car** picks which car the preview shows; the
host can move a phone to any car's light.

**Crowd layouts** free the phones from the car shape. Under **Crowd layout**, make a grid,
line or circle of places (up to 4096): each place plays the nearest light of the car picture
(front or rear), so the crowd draws the car; a fleet show splits the layout left to right by
car. Drag places to move them, double-click to add one, pick a place's light, or press Delete.
Phones then show their place number and a map with their spot, and the preview lights the
crowd as it will look. A new song keeps everyone in their place; **Use the car shape** goes
back.

**LED strips** running [WLED](https://kno.wled.ge) can join in: list them in a file and start
the server with `--wled wled.json` (see [`docs/wled.example.json`](docs/wled.example.json)).
Each run of LEDs plays one light, or one channel per LED to make a strip a Cybertruck light
bar (`"per_led": true`). Strips play the room that last pressed **Play**, in step with the
phones, in the lights' colours and through the same flash limit, over DDP (UDP port 4048).
When the party ends they go back to their own effects. Only the server's operator chooses the
strips; hosts cannot point the server's packets elsewhere.

**Export video** (next to the show's details) saves the preview with the song as a 1280 × 720
video: MP4 (H.264 + AAC) where the browser can make it, otherwise WebM. Frames are rendered one
by one, so the video is frame-exact and quicker than playing the show (a 30 s clip takes about
9 s). With a crowd layout, tick *film the crowd layout* to film the crowd instead of the car.

The **Phones** list shows each phone's network round trip and flags phones that will not play
well: clock not synced, slow Wi-Fi, not HTTPS, screen may sleep, no flashlight, or frequent
reconnects. Before a real party, run the [real-phone party test](docs/party-test.md).

Dropped connections are fine: a phone that loses Wi-Fi, locks its screen or reloads the page
gets its light back when it returns, and keeps playing on its own meanwhile. If the host computer
drops, or its tab is reloaded, phones keep playing and the host takes the room back (a
reloaded tab does not re-send the same show, so nothing restarts). A place is kept
for 2 minutes; **End party** closes the room at once.

How many phones? The server is not the limit: in its load test one laptop serves 2000 phones,
which all get their light within 0.7 s of joining together, hear about **Play** within 25 ms
(the show starts 1 s after the press) and are all back 0.8 s after a Wi-Fi blip. The Wi-Fi is the
limit: home routers often struggle beyond a few dozen devices, so for a big crowd use a router
or access points built for many clients.

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

Tests that play Tesla's official example show need it downloaded once (into the git-ignored
`shows/`; CI does the same and fails rather than skipping them):

```bash
scripts/fetch-tesla-example.sh
```

Every browser test with real headless-Chrome phones (or Safari windows with `BROWSER=safari`,
after ticking *Allow remote automation* in Safari's Developer settings), as CI runs them (starts and stops both
servers itself; needs Chrome, `npm ci` and `npm run wasm` in `web/`):

```bash
cd web && scripts/e2e.sh
```

Or one at a time, with both servers running:

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

Load test: one host and many simulated phones join at once, play, load the next song and all
reconnect after a Wi-Fi blip (200 phones in `cargo test`; more with `LSA_LOAD_PHONES`):

```bash
LSA_LOAD_PHONES=2000 cargo test --release -p lsa-server --test load -- --nocapture
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
