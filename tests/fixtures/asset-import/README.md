# Asset import samples

Inputs and goldens for the Rust · wgpu import step (`tests/conformance/rust-assets.test.ts`) and
the runtime's loaders (`native/genex-rust/crates/genex-assets`, `genex-audio`). The model and
texture inputs are the shared samples in `../asset-previews/`.

- `tone.wav`, `tone.ogg`, `tone.mp3`, `tone.flac`, `tone.opus`: a 440 Hz sine, mono, 48 kHz, made
  locally with FFmpeg 7.1.1 (`-f lavfi -i sine=frequency=440:sample_rate=48000:duration=0.5`,
  0.25 s for Opus; `-fflags +bitexact -map_metadata -1`; libvorbis `-q:a 2`, libmp3lame 64 kb/s,
  FLAC, PCM s16le, libopus 24 kb/s). No third-party recording.
- `basisu-golden.json`: the first level of `../asset-previews/texture.ktx2` and of
  `basis-uastc-64.ktx2` transcoded by the importer's pinned Basis Universal v2.50 build (its
  `basis_encoder.wasm`, by sha256) to each texture family (BC7, ASTC 4×4, ETC2, RGBA32), by
  digest. A transcoder change shows here first.
- `texture-table.json`: the per-destination texture table both sides keep.
- `hostile-importer.mjs`: a stand-in importer that tries what its sandbox must refuse.
- `quantized.glb`: the Suzanne OBJ sample (`../asset-previews/model.obj`) with a 4x4 checker as its
  base-colour texture, written as a GLB by the import step's converter and packed by
  [gltfpack](https://github.com/zeux/meshoptimizer) 1.3.0 (npm `gltfpack`, MIT) with its defaults:
  `KHR_mesh_quantization` (14-bit positions under a node scale, 8-bit normals, 12-bit uvs under
  `KHR_texture_transform`). `quantized.plain.glb` is what the import step writes from it
  (`normalizeGltf`); the runtime's mesh tests load that file.
- `basis-uastc-64.ktx2`, `basis-etc1s-64.ktx2`: a synthetic 64 x 64 RGBA pattern (a checker over
  two gradients, alpha falling left to right), sRGB, mipmapped down to 1 x 1, encoded locally with
  the [Basis Universal](https://github.com/BinomialLLC/basis_universal) v2.50 WebAssembly encoder
  (`webgl/encoder/build`, Apache-2.0) as UASTC LDR 4x4 with Zstandard and as ETC1S (quality 128).
  `basis-uastc-64.{bc,astc,etc2,rgba8}.ktx2` are what the import step writes from the UASTC one
  (`transcodeKtx2Families`, through the pinned transcoder); the runtime's `texture_compressed`
  rows read them.
- `lods-sphere.glb`: a 16 x 32 UV sphere in two primitives (the test's own `sphereGlb`), as the
  import step writes it: welded (C-7), then `extras.genex_lods` simplified by meshoptimizer's
  simplifier (`rust-assets-lods.test.ts` holds it to `convertAsset`); genex-render's `glb_lods` rows
  load it.
