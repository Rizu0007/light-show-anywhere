#!/usr/bin/env bash
# Downloads Tesla's official example show 1 into shows/ (git-ignored; Tesla's files are not
# redistributed here). Tests that use it skip without it, or fail when LSA_REQUIRE_SHOWS is set,
# as in CI.
#
# Pinned to one commit of https://github.com/teslamotors/light-show and checked by hash, so the
# tests always run against the same file.
set -euo pipefail

COMMIT=9f949512146d881b6eb66d042b22ee3f9e115afb
NAME=lightshow_example_1_elevator_music
SHA256=e5017fe813ab1cec47da221c44acecaf4d5e65c8d1291e2ead81d459833d811e

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/shows/tesla"
show="$dir/$NAME/$NAME/lightshow.fseq"
if [[ -f "$show" ]]; then
  echo "already there: $show"
  exit 0
fi

mkdir -p "$dir"
zip="$dir/$NAME.zip"
curl -sSfL -o "$zip" "https://raw.githubusercontent.com/teslamotors/light-show/$COMMIT/examples/$NAME.zip"
if command -v sha256sum >/dev/null; then
  actual="$(sha256sum "$zip" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$zip" | cut -d' ' -f1)"
fi
if [[ "$actual" != "$SHA256" ]]; then
  rm -f "$zip"
  echo "unexpected download (sha256 $actual)" >&2
  exit 1
fi
unzip -q -o "$zip" -d "$dir/$NAME"
echo "downloaded: $show"
