#!/usr/bin/env bash
# Downloads Tesla's example show 1 and the 5-car example 3 (shows only, no songs) into git-ignored
# shows/, pinned to a commit and hash-checked.
set -euo pipefail

COMMIT=9f949512146d881b6eb66d042b22ee3f9e115afb
BASE="https://raw.githubusercontent.com/teslamotors/light-show/$COMMIT/examples"
root="$(cd "$(dirname "$0")/.." && pwd)"
tesla="$root/shows/tesla"

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch <url path under examples/> <sha256> <destination>
fetch() {
  local dest=$3
  if [[ -f "$dest" ]]; then
    echo "already there: $dest"
    return
  fi
  mkdir -p "$(dirname "$dest")"
  curl -sSfL -o "$dest.part" "$BASE/$1"
  if [[ "$(sha256 "$dest.part")" != "$2" ]]; then
    rm -f "$dest.part"
    echo "unexpected download: $1" >&2
    exit 1
  fi
  mv "$dest.part" "$dest"
  echo "downloaded: $dest"
}

EX1=lightshow_example_1_elevator_music
show="$tesla/$EX1/$EX1/lightshow.fseq"
if [[ ! -f "$show" ]]; then
  fetch "$EX1.zip" e5017fe813ab1cec47da221c44acecaf4d5e65c8d1291e2ead81d459833d811e "$tesla/$EX1.zip"
  unzip -q -o "$tesla/$EX1.zip" -d "$tesla/$EX1"
fi
echo "ready: $show"

EX3=lightshow_example_3_The_Arrival_5_Car
car_sha=(
  0bc2e00113b071c277974eb5da2259ded4faebfe26024e6ac9f6bedd404c2d62
  d0335096a0c66077aa223c59091658e6a18b08192be0f6f5ac759d141660ac37
  9f35b34db8252e03c54584fe34aae16aa88c6154660bec0536d894fba81b489e
  d0dbd0c3ae04161de3644cad4e8c15a23a6b1942d6a5d6415bed913aacfac493
  7f6b032304f44734d4568cd3a64c37c39d0a8ac7b4e2a524e5429744e4b58768
)
for n in 1 2 3 4 5; do
  fetch "$EX3/Car%20%23$n/LightShow/lightshow.fseq" "${car_sha[$((n - 1))]}" "$tesla/$EX3/Car #$n/lightshow.fseq"
done
