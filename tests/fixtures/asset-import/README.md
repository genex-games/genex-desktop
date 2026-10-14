# Asset import samples

Inputs and goldens for the Rust · wgpu import step (`tests/conformance/rust-assets.test.ts`) and
the runtime's loaders (`native/genex-rust/crates/genex-assets`, `genex-audio`). The model and
texture inputs are the shared samples in `../asset-previews/`.

- `tone.wav`, `tone.ogg`, `tone.mp3`, `tone.flac`, `tone.opus`: a 440 Hz sine, mono, 48 kHz, made
  locally with FFmpeg 7.1.1 (`-f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.5`,
  0.25 s for Opus; `-fflags +bitexact -map_metadata -1`; libvorbis `-q:a 2`, libmp3lame 64 kb/s,
  FLAC, PCM s16le, libopus 24 kb/s). No third-party recording.
- `basisu-golden.json`: the first level of `../asset-previews/texture.ktx2` transcoded by the
  pinned Basis Universal transcoder to each texture family (BC7, ASTC 4×4, ETC2, RGBA32), by
  digest. A transcoder change shows here first.
- `texture-table.json`: the per-destination texture table both sides keep.
- `hostile-importer.mjs`: a stand-in importer that tries what its sandbox must refuse.
