# Local asset viewer samples

Small, synthetic format samples created locally for Studio's preview acceptance; no paid generations or user game assets.

- Blender 4.5.4 default Suzanne mesh, one material and 49-frame Z-rotation: GLB, separate glTF/buffer, FBX, OBJ/MTL, STL, PLY.
- Blender default scene + Suzanne with Draco compression: compressed.glb.
- Blender floating-point 32×16 gradient saved with OPEN_EXR render settings: texture.exr. HDR sample is a small constant-color image.
- KTX2: Three.js official `examples/textures/ktx2/2d_etc1s.ktx2` sample, retrieved 22 September 2026 from https://github.com/mrdoob/three.js/blob/dev/examples/textures/ktx2/2d_etc1s.ktx2. SHA-256 `e56ddcc757fc73ff06bb0dac2a3533ce79c1e196ad895a3ff7dcc4d9de6b9d5d`. This exercises real Basis transcoding, not just raw-container reading. See the upstream MIT notice below.
- FFmpeg lavfi testsrc (128×96, 12fps, two seconds): video.mp4 and animated.gif. Sine 440Hz, two seconds: tone.wav.
- notes.json is plain metadata. broken.glb deliberately contains invalid text.
- raylib-only formats, written by hand from each format's public header layout (no encoder, no third-party file): sample.qoi, sample.dds (images), sample.vox, sample.iqm, sample.m3d (models), sample.qoa, sample.xm, sample.mod (audio). `asset-preview.test.ts` reads them; the build smoke copies them with the rest and checks none of them.

Run after building:

```sh
node tests/e2e/run-build-smoke.mjs --studio-assets-smoke-dir=tests/fixtures/asset-previews
```

The optional real-file acceptance also accepts `retained.glb` and `retained.mp3` in a separate directory. It must not copy a user's assets into this checked-in fixture directory. The runner records their inclusion; no missing retained file is represented as a passed real-asset check.

## Three.js sample license

```text
The MIT License

Copyright © 2010-2026 three.js authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

```
