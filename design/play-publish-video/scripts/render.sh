#!/bin/sh
# Render the Play publish film and its poster, then copy both beside the renderer.
set -e
cd "$(dirname "$0")/.."
OUT=../../src/renderer/media
POSTER_FRAME=236
mkdir -p out "$OUT"
# Render at twice the size; the downscale below smooths text and edges at 760×400.
npx remotion render PlayPublish out/play-publish-raw.mp4 --scale=2 --codec=h264 --crf=16 --pixel-format=yuv420p --muted
# Re-encode small for the card: no audio, fast start, one keyframe a second.
ffmpeg -y -loglevel error -i out/play-publish-raw.mp4 -an -vf scale=760:400:flags=lanczos -c:v libx264 -preset slow -crf 24 -pix_fmt yuv420p -g 30 -movflags +faststart "$OUT/play-publish.mp4"
# The poster is the dialog live on Play, its five players in and 128 playing.
npx remotion still PlayPublish out/play-publish-poster.png --scale=2 --frame=$POSTER_FRAME
ffmpeg -y -loglevel error -i out/play-publish-poster.png -vf scale=760:400:flags=lanczos -q:v 2 "$OUT/play-publish-poster.jpg"
ls -l "$OUT"/play-publish*
