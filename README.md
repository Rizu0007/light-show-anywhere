# Light Show Anywhere

**Human Tesla:** play real Tesla light shows on a crowd of phones arranged as a car, where every
phone is one light. See [docs/PLAN.md](docs/PLAN.md).

## Status

| Crate | Purpose | State |
|-------|---------|-------|
| [`lsa-fseq`](crates/lsa-fseq) | Read and write FSEQ v2 sequences, check Tesla rules | ✅ Done |
| [`lsa-tesla`](crates/lsa-tesla) | Channel map, light/closure decoding, Tesla ramp emulation | ✅ Done (see limits in docs) |
| `lsa-wasm` | Browser bindings | Next |
| `lsa-server` | Rooms and clock sync for phone parties | Planned |

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
