# audio-yard assets

Everything here was made for this repository; there is no third-party audio, so no notices row.

- `music/yard.ogg`: a copy of genex-audio's `tests/fixtures/music-10s.ogg` (two tremolo sines in
  stereo at 48 kHz, FFmpeg's libvorbis encoder at `-q:a 0`).
- `music/cave.ogg`: 12 s of a low two-voice drone, made with FFmpeg 7.1 and libvorbis:

  ```sh
  ffmpeg -f lavfi -i "aevalsrc=0.3*sin(2*PI*110*t)*(0.6+0.4*sin(2*PI*0.25*t))+0.08*sin(2*PI*330*t)|0.3*sin(2*PI*164.81*t)*(0.6+0.4*sin(2*PI*0.25*t+PI))+0.08*sin(2*PI*247.5*t):s=48000:d=12" \
    -c:a libvorbis -q:a 0 -map_metadata -1 -fflags +bitexact -flags:a +bitexact cave.ogg
  ```

- `sfx/beacon.ogg`: a copy of `tests/fixtures/asset-import/tone.ogg` (a 440 Hz sine, mono,
  48 kHz, 0.5 s; see that folder's README).

The short sounds (footstep, gunshot, dialogue, click, drone, hum, cricket, drip) are not files in
the tree: `build.rs` synthesizes them into 16-bit WAV in Cargo's `OUT_DIR` at build time, and
`src/lib.rs` compiles them into the asset table.
