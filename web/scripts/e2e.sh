#!/usr/bin/env bash
# Every browser test, as CI runs them: starts lsa-server and the dev server, runs the party test
# (plain, with a dropped phone, then over HTTPS), the calibration and wake-lock tests, and stops
# both.
#
#   ../scripts/fetch-tesla-example.sh   # once: the show the party test plays
#   npm run wasm                        # once: the engine the dev server loads
#   scripts/e2e.sh
#
# Ports 8787 and 5173 must be free. CHROME and CHROME_FLAGS select the browser (see chrome.mjs).
set -euo pipefail

web="$(cd "$(dirname "$0")/.." && pwd)"
root="$(cd "$web/.." && pwd)"
show="$root/shows/tesla/lightshow_example_1_elevator_music/lightshow_example_1_elevator_music/lightshow.fseq"
logs="$(mktemp -d)"
pids=()

stop() {
  for pid in ${pids[@]+"${pids[@]}"}; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  pids=()
}
trap 'stop; echo "logs: $logs"' EXIT

wait_for() {
  for _ in $(seq 1 120); do
    curl -sfk -o /dev/null "$1" && return 0
    sleep 0.5
  done
  echo "$1 did not come up; logs in $logs" >&2
  exit 1
}

# Starts both servers; with "https", over HTTPS (the dev server reuses lsa-server's certificate).
start() {
  local scheme=http tls=() https=
  if [[ ${1:-} == https ]]; then scheme=https tls=(--tls) https=1; fi
  (cd "$root" && exec target/release/lsa-server ${tls[@]+"${tls[@]}"}) >"$logs/server-$scheme.log" 2>&1 &
  pids+=($!)
  wait_for "$scheme://localhost:8787/health"
  # Not through npx: on Linux, stopping npx leaves vite running on the port.
  (cd "$web" && LSA_HTTPS=$https exec node_modules/.bin/vite --strictPort) >"$logs/vite-$scheme.log" 2>&1 &
  pids+=($!)
  wait_for "$scheme://localhost:5173/"
}

[[ -f "$show" ]] || { echo "missing $show; run scripts/fetch-tesla-example.sh" >&2; exit 1; }
(cd "$root" && cargo build --release -p lsa-server)

cd "$web"
start
echo "== party"
node scripts/party-e2e.mjs "$show"
echo "== party, phone 1 dropped mid-show"
DROP=1 node scripts/party-e2e.mjs "$show"
echo "== speaker calibration"
node scripts/calibrate-e2e.mjs
echo "== keeping the screen awake"
node scripts/wake-lock-e2e.mjs
stop

start https
echo "== party over HTTPS"
APP=https://localhost:5173 node scripts/party-e2e.mjs "$show"
