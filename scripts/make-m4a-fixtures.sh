#!/usr/bin/env bash
# Regenerates the small m4a test files in tests/fixtures/ from the synthetic
# demo song (no real music). Needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg).
set -euo pipefail
cd "$(dirname "$0")/.."
FF="${FFMPEG:-ffmpeg}"
[ -f tests/fixtures/demo-song.generated.wav ] || npm run demo-song
# AAC-LC, stereo 44.1 kHz, 6 s
"$FF" -y -loglevel error -t 6 -i tests/fixtures/demo-song.generated.wav -c:a aac -b:a 96k tests/fixtures/tone-aac.m4a
# Apple Lossless, mono 22.05 kHz, 4 s (also checks the native rate is kept)
"$FF" -y -loglevel error -t 4 -i tests/fixtures/demo-song.generated.wav -ac 1 -ar 22050 -c:a alac tests/fixtures/tone-alac.m4a
ls -la tests/fixtures/tone-*.m4a
