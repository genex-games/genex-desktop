# Third-party notices

Genex's own source is licensed under [MIT](LICENSE). These notices preserve the separate
licenses and terms of included third-party software.

## Where notices ship

- Bundled packages: the build writes their notices to `dist/resources/third-party` (`NOTICE.md`
  plus each package's license files), for every npm package bundled into the app's JavaScript or
  compiled into its stylesheet (Tailwind CSS, tw-animate-css, xterm's CSS). A package that ships
  no license file has its section on this page, and the build stops when one has neither. This
  page ships as `PROJECT-SOURCES.md`, beside the root MIT license, and again beside the vendored
  three.js and the Assets viewer's decoders.
- External runtime packages (`node-pty`, `@anthropic-ai/sandbox-runtime`,
  `@modelcontextprotocol/sdk`, `@xterm/*`, `zod` and their dependencies) keep their license
  files in the packaged `node_modules`.
- Electron supplies its own license and Chromium notices.
- The TypeScript 7 compiler (Apache-2.0), `@types/node` and `undici-types` (MIT) that the
  self-edit type gate runs keep their license and notice files under `dist/resources/tsc`.
- The Genex asset CLI (`@genex-ai/cli-demo`, MIT) and its dependencies keep their license files
  in the Genex plugin payload under `dist/resources/plugins/genex/node_modules`.

## Bundled plugin icons

- `src/plugins/blender/icon.png` (shipped as `dist/resources/plugins/blender/icon.png`) is the
  official Blender mark, as Blender's own app icon shows it. The Blender logo is a registered
  trademark of the Blender Foundation; Local Blender uses it only to identify Blender, which it
  runs (https://www.blender.org/about/logo/). No endorsement is implied.
- `src/plugins/genex/icon.png` is Genex's own icon from genex.games.

## Routed tool marks

`src/renderer/media/tools` holds the marks of the tools Genex routes, as genex.games/tools shows
them, for the Genex plugin's page and picture. Each mark is its owner's trademark (Tripo, Meshy,
Uthana, OpenAI, Google Gemini, MiniMax, the Blender Foundation, ElevenLabs) and only names the
tool Genex sends work to; no endorsement is implied. The Meshy, Gemini, MiniMax, OpenAI and
ElevenLabs marks come from lobe-icons (MIT, below); the light fills are recoloured for a dark
tile. `genex.svg` is Genex's own G, from the startup loader.

## Vendored Genex skills

`src/plugins/genex/skills` (shipped as `dist/resources/plugins/genex/skills`) holds Genex skill
text behind a Studio-written preface; `vendor.json` records each source, version and sha256, and
`npm run genex:skills` refreshes them.

- Eight platform cards and their references, copied unchanged from
  `@genex-ai/cli-demo` 1.36.4 `templates/skills` (MIT, Copyright (c) 2026 me-ai-org). The
  license text ships beside them as `skills/LICENSE-cards`, copied from the CLI's `LICENSE`.
- `genex/SKILL.md` wraps https://genex.games/SKILL.md (v1.36.4), which is not part of the npm
  package. It is attributed to Genex here; its license is not yet confirmed (see "Status not yet
  recorded" below).

## Vendored three.js

Games and the asset preview use a vendored three.js (MIT, Copyright © 2010-2026 three.js
authors); its license ships as `dist/resources/vendor/three-LICENSE`. The copied `examples/jsm`
tree includes third-party libraries under their own terms, listed with their licenses in
[three.js add-on libraries](#threejs-add-on-libraries); the Assets viewer also copies the Draco and
Basis Universal decoders to `dist/renderer/decoders`.

## Vendored Genex embed SDK (@genex-ai/embed-sdk)

Template games and published games that bring no SDK of their own use Genex's player-identity SDK,
`@genex-ai/embed-sdk` 0.30.0 (MIT, as its package.json declares; the package ships no license
file). Its browser modules are copied unchanged to `dist/resources/vendor/genex/embed-sdk` and to
`dist/resources/plugins/genex/embed-sdk`, and from there into a published game's
`vendor/genex/embed-sdk`.

## Cover orb shaders from orbkit

`src/shared/cover-orbs.ts` holds twelve fragment shaders and orbkit's shared GLSL helpers, copied
from orbkit (https://github.com/zzzzshawn/orbkit, commit 5dbd641) with `main` renamed and their
parameter and colour defaults kept; Genex wraps them to fill the circle and light the ball. Only
orbkit's MIT-licensed runtime and orbs are included (SHDR-11, 12, 13, 14, 16, 17, 21, 23, 24, 30,
32 and 33); its orbs ported from XorDev's shaders are under non-commercial terms and are not.
The renderer chunk carries the notice below as a legal comment.

```
MIT License

Copyright (c) 2026 zzzzshawn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Fonts

Zalando Sans SemiExpanded, Geist and Geist Mono are used as published under the SIL Open Font
License 1.1 (Geist Mono as its Google Fonts Latin subset). Their OFL texts ship beside them in
`dist/renderer/fonts`. Copies with their OFL texts in `design/genex-promo-video/public/fonts`
render the Genex promo film.

## Promo film

The film in `src/renderer/media` is made by Genex with Remotion, which is not bundled, from
recordings of genex.games. One clip, `village-game.mp4`, was generated through fal.ai with Nano
Banana Pro and Seedance 2.5 (`design/genex-promo-video/README.md`).

## Downloaded components

C++ · raylib games are built with toolchains, and Rust games' crate requests are checked with a
crate checker, that the toolchain store downloads onto the user's machine, each pinned by version
and sha256. None of them is copied into this repository or shipped inside Genex.app; each archive
keeps its own licence files where the store unpacks it. ANGLE and Linux build headers are the
exceptions: Genex ships them (below).

- raylib 6.0 (zlib), compiled into every C++ game, with the libraries it bundles under their own
  headers: GLFW (zlib), miniaudio (public domain or MIT-0), and raylib's `src/external` single-file
  libraries (stb, cgltf, par_shapes, dr_libs, jar_xm/jar_mod, m3d, qoi, qoa and others).
- Emscripten (MIT or University of Illinois/NCSA), with LLVM (Apache-2.0 with LLVM exception),
  Binaryen (Apache-2.0), Node.js (MIT) and Python (PSF-2.0) in the managed emsdk installation.
  On Linux, Python is the portable CPython 3.13.3 build from Astral's
  `python-build-standalone` release `20250529`; its Python, Tcl/Tk and pip licence files remain
  in the installed archive. The managed Python replaces emsdk's upstream system-Python fallback.
- CMake (BSD-3-Clause) and Ninja (Apache-2.0).
- zig (MIT) for the Windows and Linux cross-builds, and llvm-mingw (LLVM under Apache-2.0 with
  LLVM exception; the mingw-w64 runtime and headers under ZPL-2.1 and public-domain terms) as its
  pinned fallback.
- The Basis Universal v2.50 WebAssembly encoder (`basis_encoder.js` and `basis_encoder.wasm`,
  Apache-2.0 with its NOTICE, the text under [Basis Universal](#basis-universal)), which the Rust ·
  wgpu asset import step encodes textures with (`src/substrate/asset-import/basis-encoder.ts`,
  pinned by sha256 at the `v2_50` release commit). So far only a development fetch
  (`scripts/toolchains/basis-encoder.ts fetch`) downloads it; it is not committed or shipped.
- The Rust crate checker, installed on the first crate approval: cargo-deny (MIT OR Apache-2.0)
  and cargo-vet (MIT OR Apache-2.0) from their official GitHub releases, and the RustSec
  advisory-db (CC0-1.0) at the commit `native/genex-rust/crate-policy.json` pins. The trusted
  sources' cargo-vet audit lists that policy names (Bytecode Alliance, Embark, Google, Mozilla,
  Zcash) are read under their repositories' own licences, and only once the policy pins a list's
  sha256.

## Bundled ANGLE

Every Genex build ships ANGLE (https://chromium.googlesource.com/angle/angle, BSD-3-Clause), built
by Genex's `angle.yml` from commit c5bf49e78850a5335a8fa2a7bfb53b559fbfc927 for macOS (Metal),
Windows (Direct3D 11) and Linux (Vulkan with SwiftShader), in `resources/angle/<target>/<commit>/`.
It is loaded only into C++ games' processes and copied into the apps they export. Each build's
`licenses/` folder holds the texts of what is compiled in: in all three, abseil-cpp, astc-encoder
(Apache-2.0), libc++, libc++abi and llvm-libc (Apache-2.0 with LLVM exception), zlib (Zlib),
Vulkan-Headers (Apache-2.0), volk and ceval (MIT) and libXNVCtrl (X11-style); the Khronos EGL
and GLES headers (Apache-2.0 or MIT-style, in the headers themselves, which the builds' manifests
list as missing from staging); on Linux, SwiftShader with marl (Apache-2.0), Vulkan-Loader,
Vulkan-Tools, SPIRV-Tools and SPIRV-Headers (Apache-2.0, SPIRV-Headers MIT-style),
VulkanMemoryAllocator, expat and wayland (MIT). The Windows build carries Microsoft's
`d3dcompiler_47.dll`, redistributable under the Windows SDK's redistribution terms (the SDK
version's redist list is still to be confirmed).

Genex also ships the Linux build's software Vulkan on its own, for Rust · wgpu games, which use
no ANGLE: the Vulkan loader, SwiftShader and its ICD manifest with their licence files, split
byte for byte from the Linux build into `resources/swiftshader/linux-x64-swiftshader/<commit>/`
and pinned beside the ANGLE builds in `native/angle/bundle-lock.json` (`swiftshader`). A Rust
Linux export copies these files and their licences (see "Rust toolchain runtime" below).

## Bundled Linux build headers

`native/linux-sysroot/linux-sysroot-x64.tar.gz` contains the X11, Wayland and xkbcommon build
headers and link-time libraries from AlmaLinux 8.10, and GLFW's generated Wayland protocol code.
Genex includes them in `resources/linux-sysroot/` so cross-building Linux games needs no X11/Wayland
development package installation. `native/linux-sysroot/bundle-lock.json` pins both the archive and its manifest;
the manifest records the source image digest and exact RPM package versions. Every copied
header and protocol file preserves its copyright and permission notices, including MIT/X11-style
terms from The Open Group, Silicon Graphics, Wayland and xkbcommon contributors. These are
build inputs; exported Linux games carry the generated protocol code's notices in their own
third-party notices, and load desktop X11/Wayland libraries from the player's system.

## raylib's platform template

`native/raylib-platform/rcore_genex_headless.c` is an altered copy of raylib 6.0's
`src/platforms/rcore_template.c` (zlib/libpng, Copyright (c) 2013-2026 Ramon Santamaria
(@raysan5) and contributors). Its header marks what Genex changed and keeps raylib's licence
notice; the toolchain store compiles it into the headless raylib library on the user's machine.

## Rust runtime crates

The `genex` workspace in `native/genex-rust` (Genex's own code, MIT) builds offline from a vendored
crate set: `scripts/spike/rust-wgpu/vendor-allowlist.toml` names the direct dependencies,
`setup-toolchain.sh` vendors their resolved closure (469 crates) into the project-local toolchain
folder, and `native/genex-rust/Cargo.lock` pins what the workspace uses. No crate source is copied
into this repository or shipped inside Genex.app; each vendored crate keeps its licence files in
its own folder. A Rust game or a `genex` release links only the subset its targets and features
resolve, together with the Rust standard library (MIT OR Apache-2.0). Where a crate offers a
choice of licences, Genex uses it under the first one listed.

Notable terms in the closure:

- egui's default fonts, compiled into the HUD through `epaint_default_fonts` 0.36.2: Ubuntu Light
  (Ubuntu Font Licence 1.0), Hack Regular (MIT; its Bitstream Vera glyphs under the Bitstream
  Vera License with the reserved font names "Bitstream" and "Vera"), Noto Emoji (SIL Open Font
  License 1.1) and emoji-icon-font (MIT). The licence texts are in the crate's `fonts/` folder.
- MPL-2.0: the symphonia 0.6.1 crates (audio decoding) and triple_buffer 9.0.0, used unmodified;
  their source is the published crate on crates.io.
- `self_cell` 1.3.0 is offered under Apache-2.0 OR GPL-2.0-only and `r-efi` under MIT OR
  Apache-2.0 OR LGPL-2.1-or-later; Genex uses Apache-2.0 and MIT respectively.

| Licence (as the crate declares it) | Crates | Crates and versions |
| --- | --- | --- |
| MIT OR Apache-2.0 | 248 | accesskit 0.24.1, ahash 0.8.12, allocator-api2 0.2.21, android-activity 0.6.1, android_log-sys 0.3.2, android_logger 0.15.1, android_system_properties 0.1.6, arboard 3.6.1, arrayvec 0.7.8, as-raw-xcb-connection 1.0.1, ash 0.38.0+1.3.281, async-trait 0.1.92, atomic-arena 0.1.2, atomic-polyfill 1.0.3, base64 0.13.1, bitflags 1.3.2, bitflags 2.13.2, bumpalo 3.20.3, cast 0.3.0, cc 1.6.0, cfg-if 1.0.5, cobs 0.3.0, core-foundation 0.9.4, core-foundation-sys 0.8.7, core-graphics 0.23.2, core-graphics-types 0.1.3, coreaudio-rs 0.14.2, crc32fast 1.5.2, critical-section 1.2.0, crossbeam-utils 0.8.23, dasp_sample 0.11.0, document-features 0.2.12, downcast-rs 1.2.1, downcast-rs 2.0.2, ecolor 0.36.2, egui 0.36.2, egui-wgpu 0.36.2, egui-winit 0.36.2, either 1.18.0, emath 0.36.2, embedded-io 0.4.0, embedded-io 0.6.1, ena 0.14.4, env_filter 0.1.4, epaint 0.36.2, errno 0.3.14, euclid 0.22.14, fdeflate 0.3.7, find-msvc-tools 0.1.14, flate2 1.1.10, font-types 0.12.6, foreign-types 0.5.0, foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, futures-channel 0.3.34, futures-core 0.3.34, futures-task 0.3.34, futures-util 0.3.34, getrandom 0.3.4, getrandom 0.4.3, gif 0.14.2, glam 0.30.10, glam 0.31.1, glam 0.32.1, glam 0.33.12, glamx 0.3.1, glob 0.3.4, gltf 1.4.1, gltf-derive 1.4.1, gltf-json 1.4.1, gpu-allocator 0.28.0, guillotiere 0.7.0, half 2.7.1, hash32 0.2.1, hash32 0.3.1, hashbrown 0.16.1, hashbrown 0.17.1, heapless 0.7.17, heapless 0.8.0, hermit-abi 0.5.3, image 0.25.10, image-webp 0.2.4, itertools 0.15.0, itoa 1.0.18, jni 0.21.1, jni 0.22.4, jni-macros 0.22.4, jni-sys 0.3.1, jni-sys 0.4.1, jni-sys-macros 0.4.1, jobserver 0.1.35, js-sys 0.3.106, kira 0.12.5, lazy_static 1.5.1, libc 0.2.190, litrs 1.0.0, lock_api 0.4.14, log 0.4.34, matrixmultiply 0.3.11, memmap2 0.9.11, naga 30.0.1, naga-types 30.0.1, ndk 0.9.0, ndk-context 0.1.1, ndk-sys 0.6.0+11769913, num-bigint 0.4.8, num-complex 0.4.6, num-derive 0.4.2, num-derive 0.5.1, num-integer 0.1.47, num-rational 0.4.2, num-traits 0.2.19, once_cell 1.21.4, parking_lot 0.12.5, parking_lot_core 0.9.12, paste 1.0.15, pastey 0.2.3, percent-encoding 2.3.2, pkg-config 0.3.34, plain 0.2.3, png 0.18.1, polycool 0.4.0, postcard 1.1.3, presser 0.3.1, proc-macro-crate 3.5.0, proc-macro2 1.0.107, profiling 1.0.18, profiling-procmacros 1.0.18, qoi 0.4.1, quick-error 2.0.1, quote 1.0.47, rand 0.8.8, rand_core 0.6.4, rand_xorshift 0.3.0, range-alloc 0.1.5, raw-window-metal 1.1.0, rawpointer 0.2.1, read-fonts 0.41.0, regex 1.13.1, regex-automata 0.4.18, regex-lite 0.1.9, regex-syntax 0.8.11, renderdoc-sys 1.1.0, robust 1.2.0, rstar 0.13.0, rtrb 0.4.0, rustc_version 0.4.1, rustversion 1.0.23, scoped-tls 1.0.1, scopeguard 1.2.0, semver 1.0.28, send_wrapper 0.6.0, serde 1.0.229, serde_arrays 0.2.0, serde_core 1.0.229, serde_derive 1.0.229, serde_json 1.0.151, serde_spanned 1.1.1, shlex 2.0.1, simdutf8 0.1.5, skrifa 0.44.0, smallvec 1.16.2, smol_str 0.2.2, spade 2.15.1, stable_deref_trait 1.2.1, static_assertions 1.1.0, syn 2.0.119, syn 3.0.6, target-tuple 1.0.2, thiserror 1.0.69, thiserror 2.0.21, thiserror-impl 1.0.69, thiserror-impl 2.0.21, toml 1.1.6+spec-1.1.0, toml_datetime 1.1.1+spec-1.1.0, toml_edit 0.25.15+spec-1.1.0, toml_parser 1.1.3+spec-1.1.0, toml_writer 1.1.2+spec-1.1.0, trybuild 1.0.121, ttf-parser 0.25.1, type-map 0.5.1, typenum 1.20.1, unicode-segmentation 1.13.3, unicode-width 0.2.2, vec_map 0.8.2, version_check 0.9.5, wasm-bindgen 0.2.129, wasm-bindgen-futures 0.4.79, wasm-bindgen-macro 0.2.129, wasm-bindgen-macro-support 0.2.129, wasm-bindgen-shared 0.2.129, wasm-bindgen-test 0.3.79, wasm-bindgen-test-macro 0.3.79, wasm-bindgen-test-shared 0.2.129, web-sys 0.3.106, web-time 1.1.0, weezl 0.1.12, wgpu 30.0.1, wgpu-core 30.0.1, wgpu-core-deps-apple 30.0.1, wgpu-core-deps-windows-linux-android 30.0.1, wgpu-hal 30.0.1, wgpu-naga-bridge 30.0.1, wgpu-types 30.0.1, windows 0.62.2, windows-collections 0.3.2, windows-core 0.62.2, windows-future 0.3.2, windows-implement 0.60.2, windows-interface 0.59.3, windows-link 0.2.1, windows-numerics 0.3.1, windows-result 0.4.1, windows-strings 0.5.1, windows-sys 0.45.0, windows-sys 0.52.0, windows-sys 0.59.0, windows-sys 0.60.2, windows-sys 0.61.2, windows-targets 0.42.2, windows-targets 0.52.6, windows-targets 0.53.5, windows-threading 0.2.1, windows_aarch64_gnullvm 0.42.2, windows_aarch64_gnullvm 0.52.6, windows_aarch64_gnullvm 0.53.1, windows_aarch64_msvc 0.42.2, windows_aarch64_msvc 0.52.6, windows_aarch64_msvc 0.53.1, windows_i686_gnu 0.42.2, windows_i686_gnu 0.52.6, windows_i686_gnu 0.53.1, windows_i686_gnullvm 0.52.6, windows_i686_gnullvm 0.53.1, windows_i686_msvc 0.42.2, windows_i686_msvc 0.52.6, windows_i686_msvc 0.53.1, windows_x86_64_gnu 0.42.2, windows_x86_64_gnu 0.52.6, windows_x86_64_gnu 0.53.1, windows_x86_64_gnullvm 0.42.2, windows_x86_64_gnullvm 0.52.6, windows_x86_64_gnullvm 0.53.1, windows_x86_64_msvc 0.42.2, windows_x86_64_msvc 0.52.6, windows_x86_64_msvc 0.53.1, x11rb 0.13.2, x11rb-protocol 0.13.2 |
| MIT | 84 | alsa-sys 0.4.0, android-properties 0.2.2, block2 0.5.1, block2 0.6.2, bytes 1.12.1, calloop 0.13.0, calloop 0.14.5, calloop-wayland-source 0.3.0, calloop-wayland-source 0.4.1, cfg_aliases 0.2.2, color_quant 1.1.0, combine 4.6.8, crunchy 0.2.4, dispatch 0.2.0, dlib 0.5.3, extended 0.1.0, fax 0.2.7, harfrust 0.12.0, inflections 1.1.1, libm 0.2.16, libredox 0.1.25, libudev-sys 0.1.4, mint 0.5.9, nix 0.31.3, nu-ansi-term 0.50.3, objc-sys 0.3.5, objc2 0.5.3, objc2 0.6.5, objc2-app-kit 0.2.2, objc2-cloud-kit 0.2.2, objc2-contacts 0.2.2, objc2-core-data 0.2.2, objc2-core-image 0.2.2, objc2-core-location 0.2.2, objc2-encode 4.1.0, objc2-foundation 0.2.2, objc2-foundation 0.3.2, objc2-link-presentation 0.2.2, objc2-metal 0.2.2, objc2-quartz-core 0.2.2, objc2-symbols 0.2.2, objc2-ui-kit 0.2.2, objc2-uniform-type-identifiers 0.2.2, objc2-user-notifications 0.2.2, oorandom 11.1.5, orbclient 0.3.55, ordered-float 5.5.0, pulp 0.22.3, pulp-wasm-simd-flag 0.1.1, quick-xml 0.41.0, raw-cpuid 11.6.0, reborrow 0.5.5, redox_syscall 0.4.1, redox_syscall 0.5.18, redox_syscall 0.9.4, sctk-adwaita 0.10.1, simd-adler32 0.3.10, slab 0.4.12, smithay-client-toolkit 0.19.2, smithay-client-toolkit 0.20.0, smithay-clipboard 0.7.3, spin 0.9.9, strict-num 0.1.1, tiff 0.11.3, tokio 1.53.2, tracing 0.1.44, tracing-core 0.1.36, urlencoding 2.1.3, wayland-backend 0.3.17, wayland-client 0.31.15, wayland-csd-frame 0.3.0, wayland-cursor 0.31.14, wayland-protocols 0.32.13, wayland-protocols-experimental 20250721.0.1, wayland-protocols-misc 0.3.12, wayland-protocols-plasma 0.3.12, wayland-protocols-wlr 0.3.12, wayland-scanner 0.31.11, wayland-sys 0.31.11, winnow 1.0.4, x11-dl 2.21.0, xcursor 0.3.11, xkbcommon-dl 0.4.2, zmij 1.0.23 |
| Apache-2.0 OR MIT | 37 | alsa 0.11.0, atomic-waker 1.1.2, autocfg 1.5.1, bit-set 0.10.0, bit-vec 0.9.1, bit_field 0.10.3, cesu8 1.1.0, color 0.3.3, concurrent-queue 2.5.0, console_error_panic_hook 0.1.7, equivalent 1.0.2, fastrand 2.5.0, fearless_simd 0.4.1, fnv 1.0.7, gilrs 0.11.2, gilrs-core 0.6.8, glifo 0.2.0, indexmap 2.14.2, kurbo 0.13.1, linebender_resource_handle 0.1.1, minicov 0.3.8, nohash-hasher 0.2.0, noise 0.9.0, peniko 0.6.1, pin-project 1.1.13, pin-project-internal 1.1.13, pin-project-lite 0.2.17, polling 3.11.0, pollster 0.4.0, portable-atomic 1.15.0, portable-atomic-util 0.2.8, rustc-hash 1.1.0, rustc-hash 2.1.3, simd_cesu8 1.2.0, uuid 1.27.0, vello_common 0.1.0, vello_cpu 0.1.0 |
| Zlib OR Apache-2.0 OR MIT | 24 | bytemuck 1.25.2, bytemuck_derive 1.12.1, dispatch2 0.3.1, objc2-app-kit 0.3.2, objc2-audio-toolbox 0.3.2, objc2-avf-audio 0.3.2, objc2-cloud-kit 0.3.2, objc2-core-audio 0.3.2, objc2-core-audio-types 0.3.2, objc2-core-data 0.3.2, objc2-core-foundation 0.3.2, objc2-core-graphics 0.3.2, objc2-core-image 0.3.2, objc2-core-location 0.3.2, objc2-core-text 0.3.2, objc2-core-video 0.3.2, objc2-io-kit 0.3.2, objc2-io-surface 0.3.2, objc2-metal 0.3.2, objc2-quartz-core 0.3.2, objc2-ui-kit 0.3.2, objc2-user-notifications 0.3.2, safe_arch 1.2.0, wide 1.7.1 |
| Apache-2.0 | 16 | ab_glyph 0.2.32, ab_glyph_rasterizer 0.1.10, approx 0.5.1, codespan-reporting 0.13.1, cpal 0.18.2, gethostname 1.1.0, ktx2 0.5.0, nalgebra 0.35.0, nalgebra-macros 0.3.0, owned_ttf_parser 0.25.1, parry3d 0.31.1, rapier3d 0.36.0, simba 0.10.2, spirv 0.4.0+sdk-1.4.341.0, unicode-general-category 1.1.0, winit 0.30.13 |
| MPL-2.0 | 11 | symphonia 0.6.1, symphonia-bundle-flac 0.6.1, symphonia-bundle-mp3 0.6.1, symphonia-codec-pcm 0.6.1, symphonia-codec-vorbis 0.6.1, symphonia-common 0.6.1, symphonia-core 0.6.1, symphonia-format-ogg 0.6.1, symphonia-format-riff 0.6.1, symphonia-metadata 0.6.1, triple_buffer 9.0.0 |
| Unlicense OR MIT | 8 | aho-corasick 1.1.5, byteorder 1.5.0, byteorder-lite 0.1.0, memchr 2.8.3, same-file 1.0.6, termcolor 1.4.1, walkdir 2.5.0, winapi-util 0.1.11 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 6 | linux-raw-sys 0.12.1, linux-raw-sys 0.4.15, rustix 0.38.44, rustix 1.1.5, wasip2 1.0.4+wasi-0.2.12, wit-bindgen 0.57.1 |
| MIT OR Apache-2.0 OR Zlib | 6 | cursor-icon 1.2.0, raw-window-handle 0.6.2, xkeysym 0.2.1, zune-core 0.5.3, zune-inflate 0.2.54, zune-jpeg 0.5.15 |
| BSD-3-Clause | 4 | exr 1.74.2, lebe 0.5.3, tiny-skia 0.11.4, tiny-skia-path 0.11.4 |
| ISC | 3 | inotify 0.11.5, inotify-sys 0.1.8, libloading 0.8.9 |
| BSD-2-Clause OR Apache-2.0 OR MIT | 2 | zerocopy 0.8.59, zerocopy-derive 0.8.59 |
| BSD-2-Clause OR MIT OR Apache-2.0 | 2 | mach2 0.4.3, mach2 0.6.0 |
| BSD-3-Clause OR Apache-2.0 | 2 | moxcms 0.8.1, pxfm 0.1.30 |
| BSD-3-Clause OR MIT OR Apache-2.0 | 2 | num_enum 0.7.6, num_enum_derive 0.7.6 |
| BSL-1.0 | 2 | clipboard-win 5.4.1, error-code 3.4.0 |
| MIT OR Apache-2.0 OR LGPL-2.1-or-later | 2 | r-efi 5.3.0, r-efi 6.0.0 |
| MIT OR Zlib OR Apache-2.0 | 2 | miniz_oxide 0.8.9, miniz_oxide 0.9.1 |
| Zlib | 2 | foldhash 0.2.0, zlib-rs 0.6.8 |
| (MIT OR Apache-2.0) AND OFL-1.1 AND Ubuntu-font-1.0 | 1 | epaint_default_fonts 0.36.2 |
| (MIT OR Apache-2.0) AND Unicode-3.0 | 1 | unicode-ident 1.0.26 |
| 0BSD OR MIT OR Apache-2.0 | 1 | adler2 2.0.1 |
| Apache-2.0 AND MIT | 1 | dpi 0.1.2 |
| Apache-2.0 OR GPL-2.0-only | 1 | self_cell 1.3.0 |
| BSD-2-Clause | 1 | arrayref 0.3.9 |

The spike's Android packaging (`scripts/spike/rust-wgpu/android-apk.sh`, developer tool only)
fetches games-activity 4.4.0 (androidx.games), and its AppCompat closure from androidx: activity 1.0.0, annotation 1.2.0, appcompat 1.2.0, appcompat-resources 1.2.0, arch.core core-common 2.1.0 and core-runtime 2.0.0, collection 1.1.0, core 1.5.0, cursoradapter 1.0.0, customview 1.0.0, drawerlayout 1.0.0, fragment 1.1.0, interpolator 1.0.0, lifecycle-common 2.1.0, lifecycle-livedata 2.0.0, lifecycle-livedata-core 2.0.0, lifecycle-runtime 2.1.0, lifecycle-viewmodel 2.1.0, loader 1.0.0, savedstate 1.0.0, vectordrawable 1.1.0, vectordrawable-animated 1.1.0, versionedparcelable 1.1.1 and viewpager 1.0.0 from Google Maven (Apache-2.0), each pinned by sha256 in the script. They are
not in this repository and nothing Genex ships contains them yet; the owner has not yet
ratified Google Maven as their source.

## Rust renderer shader ports

The Rust renderer (`native/genex-rust/crates/genex-render`, Genex's own code, MIT) ports these
shader functions into its WGSL; it ships inside every Rust game and its ejected source. Each file
credits its source in a comment.

| Genex files | What | Source | Upstream authors | Licence |
| --- | --- | --- | --- | --- |
| `shaders/post/tonemap.wgsl`, `src/post/tonemap.rs` (its CPU reference) | Tonemapping curves: Khronos PBR Neutral, AgX, ACES fit | three.js 0.185.1, `src/renderers/shaders/ShaderChunk/tonemapping_pars_fragment.glsl.js` | three.js authors; Khronos PBR Neutral by the Khronos Group (Emmett Lalish); AgX by Troy Sobotka, the minimal fit by Benjamin Wrensch (iolite) and Filament's Rec. 2020 port; the ACES fit by Stephen Hill after the Academy's ACES RRT and ODT | MIT (three.js, see [Vendored three.js](#vendored-threejs)) |
| `shaders/post/gtao.wgsl`, `shaders/post/ao_denoise.wgsl` (the raw term's packing) | Ground-truth ambient occlusion: the depth prefilter and its MIP filter, the horizon search with its falloff, the Hilbert-curve R2 noise, the bent normal and the fast arc cosine | XeGTAO (https://github.com/GameTechDev/XeGTAO), `Source/Rendering/Shaders/XeGTAO.hlsli` | Intel Corporation (Filip Strugar), after Jimenez, Wu, Pesce and Jarabo 2016, "Practical Real-Time Strategies for Accurate Indirect Occlusion" | MIT (see [XeGTAO](#xegtao)) |
| `shaders/lighting/ambient.wgsl` (`gx_caps_intersection`, `gx_specular_occlusion_bent`, `gx_ao_multibounce`) | Cone-cone specular occlusion from a bent normal and the multi-bounce AO fit | Filament (https://github.com/google/filament), `shaders/src/surface_ambient_occlusion.fs` (`sphericalCapsIntersection`, `specularAO_Cones`, `gtaoMultiBounce`) | The Android Open Source Project; the methods by Jimenez et al. 2016 and Oat and Sander 2007 | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/easu.wgsl`, `shaders/post/rcas.wgsl`, `src/post/fsr.rs` (the constants) | FSR1 upscaler: edge-adaptive spatial upsampling (EASU) with its 12-tap kernel, direction and length estimate, and robust contrast-adaptive sharpening (RCAS) with its per-channel lobe limiters | AMD FidelityFX Super Resolution 1.0 (https://github.com/GPUOpen-Effects/FidelityFX-FSR), `ffx-fsr/ffx_fsr1.h` (`FsrEasuCon`, `FsrEasuF`, `FsrRcasCon`, `FsrRcasF`) | Advanced Micro Devices, Inc. | MIT (see [FidelityFX FSR1](#fidelityfx-fsr1)) |
| `shaders/post/taa.wgsl` (`gx_taa_tonemap`, `gx_taa_inverse_tonemap`, `gx_taa_lightness`, `gx_taa_thin_feature`, `gx_taa_lock`, `gx_taa_instability`, the soft rectification), `src/post/taa.rs` (the constants) | TAA history protection: the reversible tonemap the colour box is built in, the thin-feature lock (lightness ridge and 2x2 rejection masks) with its lifetime and shading-change kill, the luma instability over four frames of quantised luma, the rectification undone by lock and instability and scaled by the reactive factor, and the temporal reactive factor of motion (Genex adapts the instability test, the shading luma and the lock trigger) | AMD FidelityFX SDK v1.1.4 (https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), FSR 2.2 `sdk/include/FidelityFX/gpu/fsr2/` (`ffx_fsr2_lock.h`, `ffx_fsr2_accumulate.h`, `ffx_fsr2_postprocess_lock_status.h`, `ffx_fsr2_common.h`) | Advanced Micro Devices, Inc. | MIT (see [FidelityFX SDK](#fidelityfx-sdk)) |
| `shaders/post/tonemap.wgsl` (`gx_tm_awp`, `gx_tm_agx_punchy`), `src/post/tonemap.rs` (`AgxCurve`, its CPU reference) | AgX punchy: the allenwp tonemapping curve with its CPU-computed toe, slope and shoulder, between the combined Rec. 709 -> Rec. 2020 -> AgX inset and outset matrices; Genex generalises the crossover's output | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/effects/tonemap.glsl` (`allenwp_curve`, `tonemap_agx`) and `servers/rendering/storage/environment_storage.cpp` (`environment_get_tonemap_parameters`) | Godot Engine contributors; the curve by Allen Pestaluky (allenwp); the matrices after EaryChow's Blender AgX | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/post/exposure_adapt.wgsl` (`gx_adapt_tick`, `gx_compensation`), `src/post/exposure.rs` (`adapt_tick`, `curve_compensation`), `src/settings.rs` (`CompensationCurve`) | Hybrid auto exposure adaptation (linear far from the target, exponential within a transition distance) and the exposure compensation curve over the metered EV | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_post_process/src/auto_exposure/auto_exposure.wesl` and `compensation_curve.rs` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `src/settings.rs` (`chromatic_adaptation` and its colour matrices) | White balance as a von Kries chromatic adaptation in CIECAT16 cone space from a temperature and tint, the white point moved along the daylight locus | Filament v1.78.0 (https://github.com/google/filament), `filament/src/details/ColorGrading.cpp` (`adaptationTransform`) and `filament/src/ColorSpaceUtils.h` | The Android Open Source Project | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/tonemap.wgsl` (`gx_grade`, `gx_grade_weights`, `gx_grade_lut`), `src/post/grading.rs` (`Grading::grade`, `tetrahedral`, their CPU twins) | Colour grading: per-section (shadows, midtones, highlights) saturation, contrast, gamma, gain and lift blended across the sections' margins; contrast in log space about middle grey and vibrance; a 3D LUT read with tetrahedral interpolation from four texel loads (Genex stores each texel's change from the identity and blends shadows into midtones where Bevy blends them into highlights) | Bevy 0.16.0 (https://github.com/bevyengine/bevy), `crates/bevy_core_pipeline/src/tonemapping/tonemapping_shared.wgsl` (`sectional_color_grading`); Filament v1.78.0 (https://github.com/google/filament), `filament/src/details/ColorGrading.cpp` (`contrast`, `vibrance`); pmndrs/postprocessing (https://github.com/pmndrs/postprocessing), `src/effects/glsl/lut-3d.frag` (`applyLUT`, tetrahedral) | Bevy contributors; The Android Open Source Project; Raoul van Rüschen | MIT OR Apache-2.0, used under Apache 2.0 (Bevy); Apache 2.0 (Filament) (see [Apache License 2.0](#apache-license-20)); Zlib (pmndrs/postprocessing, see [pmndrs/postprocessing](#pmndrspostprocessing)) |
| `shaders/ibl/sh9.wgsl` (`ibl_sh9_window`, the bisection after the reduction), `src/ibl.rs` (`sh9_window`, `sh9_dering_window`, their CPU twin) | Spherical-harmonic deringing: the sinc^4 window of bands 1 and 2 and the bisection for the weakest cutoff that keeps the reconstruction non-negative (Genex windows only an SH that rings) | Filament v1.78.0 (https://github.com/google/filament), `libs/ibl/src/CubemapSH.cpp` (`sincWindow`, `windowSH`) | The Android Open Source Project; the method by Peter-Pike Sloan ("Deringing Spherical Harmonics", 2017) | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/pbr.wgsl` (`gx_specular_energy`), `shaders/lighting/ambient.wgsl` (`gx_diffuse_normal`) | Multiple-scattering energy compensation of direct specular, `1 + f0 (1 / E - 1)` from the split-sum LUT; the diffuse environment light looked up along the bent normal | Filament v1.78.0 (https://github.com/google/filament), `shaders/src/surface_shading_lit.fs` (`energyCompensation`), `shaders/src/surface_light_indirect.fs` (`diffuseNormal`) | The Android Open Source Project | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/alpha_mask.wgsl` (`gx_alpha_hash2`, `gx_alpha_hash3`, `gx_alpha_hash_threshold`) | Hashed alpha testing: the hash and the two-scale, CDF-remapped alpha threshold (Genex turns it by the frame for TAA and compares the edge's sharpened coverage with it) | three.js 0.185.1, `src/renderers/shaders/ShaderChunk/alphahash_pars_fragment.glsl.js` (`hash2D`, `hash3D`, `getAlphaHashThreshold`) | three.js authors, after Wyman and McGuire 2017, "Hashed Alpha Testing" | MIT (three.js, see [Vendored three.js](#vendored-threejs)) |
| `shaders/post/sun_mask_denoise.wgsl` (`fs_sun_mask_temporal`, `gx_mask_history`, `gx_mask_depth_tolerance`, `gx_mask_alpha`, `gx_mask_input`, `gx_mask_atrous`), `src/post/sun_mask.rs` (the constants) | The sun-shadow screen mask's denoise: temporal reprojection with the view-alignment-scaled disocclusion test, the neighbourhood clamp, the sample-count damper, the variance boost of a young history and the accumulation schedule; the 3x3 a-trous kernel with the shadow edge-stopping weight (Genex ports it to fragment passes without wave intrinsics or tile bitmasks, for a continuous PCSS visibility: one filter step instead of three, a depth weight instead of the normal's, and the shadow weight over the variance of the accumulated estimate) | AMD FidelityFX Denoiser (https://github.com/GPUOpen-Effects/FidelityFX-Denoiser), `ffx-shadows-dnsr/ffx_denoiser_shadows_tileclassification.h` and `ffx_denoiser_shadows_filter.h` | Advanced Micro Devices, Inc. | MIT (see [FidelityFX Denoiser](#fidelityfx-denoiser)) |
| `shaders/pbr.wgsl` (`gx_sun_area_direction`) | The sun as a disc for specular: the direction inside the sun's disc closest to the mirror direction | Filament v1.77.3 (https://github.com/google/filament), `shaders/src/surface_light_directional.fs` (`sampleSunAreaLight`) | The Android Open Source Project | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/contact_shadow.wgsl` (`gx_contact_edge_fade`, `gx_contact_soft_hit`, the screen-space step count and the per-step tolerance) | Contact shadows: the occlusion faded out across the screen's outer twelfth, the thickness at least the ray's change in view distance per step; the steps set by the depth texels the ray spans on the screen and the soft hit over the back half of the thickness | Filament v1.77.3 (https://github.com/google/filament), `shaders/src/surface_shadowing.fs` (`screenSpaceContactShadow`); Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/ssr/raymarch.wesl` (`depth_ray_march_march`) and `crates/bevy_pbr/src/render/pbr_functions.wesl` (`calculate_contact_shadow`) | The Android Open Source Project; Tomasz Stachowiak and Bevy contributors | Apache 2.0 (Filament); MIT OR Apache-2.0, used under Apache 2.0 (Bevy) (see [Apache License 2.0](#apache-license-20)) |
| `shaders/forward_env.wgsl` (`gx_probe_parallax`), `src/probes.rs` (`parallax_direction`) | Reflection probes' box projection: where a reflected ray leaves the probe's box, seen from its capture point, with the largest float standing in for an axis the ray never leaves (WGSL has no infinity); Genex projects onto the box grown by the probe's fade and eases the projection in with the probe's weight | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/light_probe/environment_map.wesl` (`compute_cubemap_sample_dir`) | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/forward_env.wgsl` (`gx_volume_irradiance`), `src/irradiance.rs` (`atlas_texel`, `ambient_irradiance`, `grid_irradiance`) | Irradiance volumes' ambient-cube packing and lookup: each cell's six axis-direction texels in an `X x 2Y x 3Z` block (the negative directions in the upper half of y, the axes in thirds of z), the three faces toward the normal read with the sampler's trilinear filter inside their sub-block and weighted by the normal's squared components (Genex packs every volume's block into one atlas, offsets the lookup along the normal, moves it toward the cells that see the point by their reaches and bakes the cells in the scene on the GPU) | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/light_probe/irradiance_volume.wesl` (`irradiance_volume_light`) and `crates/bevy_pbr/src/light_probe/irradiance_volume.rs` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/dof_prepare.wgsl`, `shaders/post/dof_ring.wgsl`, `shaders/post/dof_combine.wgsl` (`fs_dof_combine`), `src/post/dof.rs` (`CocParams`) | Gather depth of field, ring tier: the circle of confusion as a madd on the depth buffer, the half-resolution downsample keeping the smallest CoC, its mips, the min/max CoC tiles and their dilation, the ring gather with foreground (two layers) and background (ring-occlusion merge) buckets and a fast path, the 3x3 median network and the combine (Genex keeps the colour's plain mean, reduces the tiles in two passes, leaves in-focus texels out of the median and does not jitter the gather by a noise) | Filament v1.77.3 (https://github.com/google/filament), `filament/src/materials/dof/` (`dof.mat`, `dofDownsample.mat`, `dofMipmap.mat`, `dofTiles.mat`, `dofDilate.mat`, `dofMedian.mat`, `dofCombine.mat`, `dofUtils.fs`) and `filament/src/PostProcessManager.cpp` (`PostProcessManager::dof`) | The Android Open Source Project; the methods after Jimenez (SIGGRAPH 2014), Abadie ("Life of a Bokeh", SIGGRAPH 2018) and McGuire ("A Fast, Small-Radius GPU Median Filter", 2008) | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/dof_circular.wgsl`, `shaders/post/dof_combine.wgsl` (`fs_dof_composite`) | Gather depth of field, circular tier: the single-pass golden-angle gather whose samples behind the centre are limited by its CoC, and the composite by the pixel's or the gathered CoC (Genex bounds the spiral by the tile's CoC and a sample budget and upsamples by CoC likeness) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/effects/bokeh_dof_raster.glsl` (`MODE_BOKEH_CIRCULAR`, `MODE_COMPOSITE_BOKEH`) | Godot Engine contributors; the method after Tuxedo Labs ("Bokeh depth of field in a single pass", 2018) | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/post/motion_blur_common.wgsl` (`mb_velocity`, `mb_vmax`), `shaders/post/motion_blur_tiles.wgsl`, `shaders/post/motion_blur.wgsl` (`fs_mb_reconstruct`), `src/post/motion_blur.rs` (`MAX_BLUR_HEIGHT_SHARE`, `depth_row`) | Motion blur, reconstruction tier: half the exposure vector in pixels clamped to the largest radius, the longest velocity of each tile and of its 3x3 neighbourhood (centre favoured by 1%), the tile lookup jittered by a quarter tile, and the gather along the neighbourhood's and the pixel's velocities with its depth-softened foreground and background weights, triangular window and centre weight (Genex reduces the tiles in a compute pass, spaces samples a pixel apart without per-pixel noise and reads whole texels) | keijiro/KinoMotion (https://github.com/keijiro/KinoMotion), `Assets/Kino/Motion/Shader/Prefilter.cginc` (`frag_VelocitySetup`, `frag_TileMax*`, `frag_NeighborMax`), `Reconstruction.cginc` (`frag_Reconstruction`, `JitterTile`) and `Common.cginc` (`LinearizeDepth`) | Keijiro Takahashi; the method after McGuire, Hennessy, Bukowski and Osman ("A Reconstruction Filter for Plausible Motion Blur", I3D 2012) | MIT (see [KinoMotion](#kinomotion)) |
| `shaders/post/motion_blur.wgsl` (`fs_mb_direct`) | Motion blur, direct tier: samples along the pixel's own exposure vector, a nearer sample kept only where its own motion along that direction reaches the pixel, the scene kept below a pixel of motion (Genex compares the sample's exposure with the pixel's, spaces samples a pixel apart without noise and reads whole texels) | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_post_process/src/motion_blur/motion_blur.wesl` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `src/terrain/mod.rs` (`TerrainTree::select`, `TerrainLod`, `TerrainTree::vertex`), `shaders/terrain/terrain_core.wgsl` (`gx_terrain_morph_k`, `gx_terrain_vertex`) | Continuous distance-dependent level of detail for heightmap terrain: the quadtree selection by distance ranges with partial (quarter) nodes, the morph constants and the vertex morph of odd grid vertices onto their even neighbours (Genex selects on the CPU without a frustum and culls per view, floors the ranges so no node is two levels from a neighbour, reads 16-bit heights from a storage table and samples integer positions exactly) | CDLOD (https://github.com/fstrugar/CDLOD), `source/BasicCDLOD/CDLODQuadTree.cpp` (`LODSelect`), `CDLODRenderer.cpp` and the shader's `morphVertex` | Filip Strugar | MIT (see [CDLOD](#cdlod)) |
| `shaders/terrain/hextile.wgsl` | Hex-tiling: the triangle grid of hexagons, each tile's rotation and offset, its centre, and the luminance-weighted blend of the three tiles' samples (Genex hashes the vertex ids with integers instead of `sin`, shares the tiles between a layer's colour and data textures and turns the data texture's normal back onto the surface) | mmikk/hextile-demo (https://github.com/mmikk/hextile-demo), `hextile-demo/hextiling.h` (`TriangleGrid`, `hash`, `MakeCenST`, `LoadRot2x2`, `hex2colTex`) | Morten S. Mikkelsen ("Practical Real-Time Hex-Tiling", JCGT 11(2) 2022) | MIT (see [hextile-demo](#hextile-demo)) |

### CDLOD

The licence of the CDLOD code the terrain's selection and morph port (table above).

```
MIT License

Copyright (c) 2010 Filip Strugar

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### hextile-demo

The licence of the hex-tiling code the terrain's layers port (table above).

```
MIT License

Copyright (c) 2022 mmikk

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### XeGTAO

The licence of the XeGTAO code the GTAO shaders port (table above).

```
Copyright (C) 2016-2021, Intel Corporation

SPDX-License-Identifier: MIT

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### FidelityFX FSR1

The licence of the AMD FidelityFX FSR1 code the upscaler shaders port (table above).

```
Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES
OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### FidelityFX SDK

The licence of the AMD FidelityFX SDK (FSR 2.2) code the TAA resolve ports (table above).

```
Copyright (C) 2024 Advanced Micro Devices, Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files(the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and /or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions :

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

### FidelityFX Denoiser

The licence of the AMD FidelityFX Denoiser code the sun-shadow mask's denoise ports (table above).

```
Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.

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
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

### Godot Engine

The licence of the Godot Engine code the AgX punchy tonemap and the circular depth of field port (table above).

```
Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md).
Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### KinoMotion

The licence of the KinoMotion code the motion blur's reconstruction tier ports (table above).

```
MIT License

Copyright (c) 2016, 2017 Keijiro Takahashi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### pmndrs/postprocessing

The licence of the pmndrs/postprocessing code the grading LUT's tetrahedral interpolation ports
(table above). The WGSL port is an altered version: it reads changes from the identity and is
marked as a port in `tonemap.wgsl`.

```
Copyright © 2015 Raoul van Rüschen

This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

## Rust showcase environment map

The Rust renderer's showcase game ships one sample HDR environment map. It is a development and
demonstration asset: the renderer never depends on it, and the renderer's tests use maps their own
code writes.

| Genex file | What | Source | Author | Licence | Size | sha256 |
| --- | --- | --- | --- | --- | --- | --- |
| `native/genex-rust/examples/showcase/game/assets/env/kloofendal_43d_clear_puresky_1k.hdr` | "Kloofendal 43d Clear (Pure Sky)", 1k (1024 x 512) Radiance HDR | https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/kloofendal_43d_clear_puresky_1k.hdr (page https://polyhaven.com/a/kloofendal_43d_clear_puresky) | Greg Zaal, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,184,531 bytes | `de7ba9d0b070470dbb70d0144294c8708068df353537b26ab59c394707e84377` |

## Rust showcase fetched assets

The lakeside showcase's remaster can draw photo-scanned CC0 textures and a golden-hour sky map that
are not in the repository: `node scripts/showcase-assets.ts fetch` downloads them from the pinned
official URLs in `native/genex-rust/examples/showcase/assets-manifest.json` (which records every
file's URL, size and sha256 and refuses any byte that does not match) into a local cache, and the
scene draws its procedural stand-ins without them. They are demonstration assets: the renderer and
its tests never depend on them. Every one is CC0 from Poly Haven; the credits are given anyway.

| Asset | Used for | Source | Authors | Licence | Size |
| --- | --- | --- | --- | --- | --- |
| `forrest_ground_01` | terrain grass layer (atlas tile 0) | https://polyhaven.com/a/forrest_ground_01 (`forrest_ground_01_diff_1k.jpg`, `forrest_ground_01_nor_gl_1k.jpg`, `forrest_ground_01_arm_1k.jpg`, `forrest_ground_01_disp_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,880,670 bytes |
| `dirt` | terrain soil layer: the path and the yard (atlas tile 1) | https://polyhaven.com/a/dirt (`dirt_diff_1k.jpg`, `dirt_nor_gl_1k.jpg`, `dirt_arm_1k.jpg`, `dirt_disp_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Charlotte Baglioni, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 3,005,661 bytes |
| `coast_sand_01` | terrain sand layer: the beach and the lake bed (atlas tile 2) | https://polyhaven.com/a/coast_sand_01 (`coast_sand_01_diff_1k.jpg`, `coast_sand_01_nor_gl_1k.jpg`, `coast_sand_01_arm_1k.jpg`, `coast_sand_01_disp_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 3,095,130 bytes |
| `rock_face` | terrain rock layer: steep slopes (atlas tile 3) | https://polyhaven.com/a/rock_face (`rock_face_diff_1k.jpg`, `rock_face_nor_gl_1k.jpg`, `rock_face_arm_1k.jpg`, `rock_face_disp_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dario Barresi, Greg Zaal, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,635,276 bytes |
| `bark_brown_02` | broadleaf bark | https://polyhaven.com/a/bark_brown_02 (`bark_brown_02_diff_1k.jpg`, `bark_brown_02_nor_gl_1k.jpg`, `bark_brown_02_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,907,957 bytes |
| `pine_bark` | pine bark | https://polyhaven.com/a/pine_bark (`pine_bark_diff_1k.jpg`, `pine_bark_nor_gl_1k.jpg`, `pine_bark_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dimitrios Savva, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,826,181 bytes |
| `mossy_rock` | rocks and boulders | https://polyhaven.com/a/mossy_rock (`mossy_rock_diff_1k.jpg`, `mossy_rock_nor_gl_1k.jpg`, `mossy_rock_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 3,047,106 bytes |
| `dark_wooden_planks` | the dock deck, the porch, the bench and the boat | https://polyhaven.com/a/dark_wooden_planks (`dark_wooden_planks_diff_1k.jpg`, `dark_wooden_planks_nor_gl_1k.jpg`, `dark_wooden_planks_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Amal Kumar, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,137,495 bytes |
| `raw_plank_wall` | the cabin logs, the posts and the woodpile | https://polyhaven.com/a/raw_plank_wall (`raw_plank_wall_diff_1k.jpg`, `raw_plank_wall_nor_gl_1k.jpg`, `raw_plank_wall_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dimitrios Savva, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,961,411 bytes |
| `roof_slates_02` | the cabin roof | https://polyhaven.com/a/roof_slates_02 (`roof_slates_02_diff_1k.jpg`, `roof_slates_02_nor_gl_1k.jpg`, `roof_slates_02_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,503,066 bytes |
| `rustic_stone_wall` | the cabin footing and the chimney | https://polyhaven.com/a/rustic_stone_wall (`rustic_stone_wall_diff_1k.jpg`, `rustic_stone_wall_nor_gl_1k.jpg`, `rustic_stone_wall_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dimitrios Savva, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,779,719 bytes |
| `kloppenheim_06_puresky` | the golden-hour sky map (B switches to it): image-based light and the backdrop | https://polyhaven.com/a/kloppenheim_06_puresky (`kloppenheim_06_puresky_2k.hdr`, from `https://dl.polyhaven.org/file/ph-assets/`) | Greg Zaal, Jarod Guest, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 4,434,394 bytes |

Harbour Street, renderer pass 2's urban and interior showcase, fetches its own CC0 scans and sky
map the same way (`node scripts/showcase-assets.ts fetch --scene harbour-street`, pinned in
`native/genex-rust/examples/showcase/harbour/assets-manifest.json`); its blockout draws untextured
stand-ins without them.

| Asset | Used for | Source | Authors | Licence | Size |
| --- | --- | --- | --- | --- | --- |
| `asphalt_02` | the street and the crossing, wet after the rain (its roughness lowered in code) | https://polyhaven.com/a/asphalt_02 (`asphalt_02_diff_1k.jpg`, `asphalt_02_nor_gl_1k.jpg`, `asphalt_02_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,268,599 bytes |
| `concrete_pavement` | the pavements either side of the street | https://polyhaven.com/a/concrete_pavement (`concrete_pavement_diff_1k.jpg`, `concrete_pavement_nor_gl_1k.jpg`, `concrete_pavement_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Charlotte Baglioni, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,912,926 bytes |
| `brick_wall_001` | the street facades and the alley walls | https://polyhaven.com/a/brick_wall_001 (`brick_wall_001_diffuse_1k.jpg`, `brick_wall_001_nor_gl_1k.jpg`, `brick_wall_001_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, Dimitrios Savva, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 993,044 bytes |
| `plastered_wall` | the cafe's front, its inner walls and ceiling | https://polyhaven.com/a/plastered_wall (`plastered_wall_diff_1k.jpg`, `plastered_wall_nor_gl_1k.jpg`, `plastered_wall_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Amal Kumar, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,313,364 bytes |
| `large_red_bricks` | the cafe's red wall (the interior's colour-bleed source) | https://polyhaven.com/a/large_red_bricks (`large_red_bricks_diff_1k.jpg`, `large_red_bricks_nor_gl_1k.jpg`, `large_red_bricks_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,712,292 bytes |
| `herringbone_parquet` | the cafe's polished floor | https://polyhaven.com/a/herringbone_parquet (`herringbone_parquet_diff_1k.jpg`, `herringbone_parquet_nor_gl_1k.jpg`, `herringbone_parquet_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Jenelle van Heerden, Sergej Majboroda, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,757,394 bytes |
| `painted_metal_shutter` | the closed shops' shutters | https://polyhaven.com/a/painted_metal_shutter (`painted_metal_shutter_diff_1k.jpg`, `painted_metal_shutter_nor_gl_1k.jpg`, `painted_metal_shutter_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dario Barresi, Rico Cilliers, Charlotte Baglioni, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,964,868 bytes |
| `dark_wood` | the cafe's tables, chairs, counter, shelves and door, its menu board's frame, the street bench and the alley's crates | https://polyhaven.com/a/dark_wood (`dark_wood_diff_1k.jpg`, `dark_wood_nor_gl_1k.jpg`, `dark_wood_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dario Barresi, Dimitrios Savva, Rico Cilliers, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,717,893 bytes |
| `marble_01` | the cafe's counter top and the cup and saucer on the window table | https://polyhaven.com/a/marble_01 (`marble_01_diff_1k.jpg`, `marble_01_nor_gl_1k.jpg`, `marble_01_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 469,999 bytes |
| `metal_plate_02` | the street lamps, the bollards, the window frames, the sign panels, the furniture's legs and the alley's pipes, air conditioners and bin | https://polyhaven.com/a/metal_plate_02 (`metal_plate_02_diff_1k.jpg`, `metal_plate_02_nor_gl_1k.jpg`, `metal_plate_02_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,885,020 bytes |
| `granite_tile` | the kerb stones and the cafe's threshold | https://polyhaven.com/a/granite_tile (`granite_tile_diff_1k.jpg`, `granite_tile_nor_gl_1k.jpg`, `granite_tile_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Charlotte Baglioni, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,987,919 bytes |
| `metal_grate_rusty` | the drains along the kerbs, the manhole covers, the alley's gutter and the air conditioners' grilles | https://polyhaven.com/a/metal_grate_rusty (`metal_grate_rusty_diff_1k.jpg`, `metal_grate_rusty_nor_gl_1k.jpg`, `metal_grate_rusty_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, Dimitrios Savva, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,774,295 bytes |
| `kloppenheim_01_puresky` | the overcast dusk sky map (B switches to it): image-based light and the backdrop | https://polyhaven.com/a/kloppenheim_01_puresky (`kloppenheim_01_puresky_2k.hdr`, from `https://dl.polyhaven.org/file/ph-assets/`) | Greg Zaal, Jarod Guest, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 3,187,954 bytes |

## Rust toolchain runtime

Besides its crates (above), a Rust game links what the pinned toolchains compile into every
binary for its destination, and a Linux export ships a software Vulkan beside the game. The
toolchain store installs the toolchains on the user's computer; an exported game carries the
linked parts inside its executable or module, and a Linux export carries the Vulkan loader,
SwiftShader and its ICD manifest next to its executable, split from Genex's bundled Linux ANGLE
build (see "Bundled ANGLE" above). `scripts/third-party-notices.mjs` (`RUST_TOOLCHAIN_RUNTIME`)
holds this table to every part a destination's export notices name (`RUST_NOTICE_ROWS` in
`src/substrate/rust-notices.ts`), and each export's `notices/` folder carries the texts.
Libraries a destination's operating system provides (libSystem on Apple platforms, `libgcc_s`
and glibc on Linux, the Universal CRT on Windows, Bionic on Android) are the system's and are
not shipped.

| Component | Linked into | License |
| --- | --- | --- |
| `std` | every destination: the Rust standard library (`std`, `core`, `alloc`, and the crates it builds in: hashbrown, libc, addr2line, gimli, object, miniz_oxide, rustc-demangle, memchr, cfg-if, adler2, dlmalloc on the web), each used under MIT among the licences it offers | MIT OR Apache-2.0 |
| `compiler_builtins` | every destination: the Rust crate of compiler intrinsics | MIT OR Apache-2.0 |
| `compiler-rt` | every destination: the LLVM compiler-rt builtins `compiler_builtins` ports and, on some targets, compiles in | Apache-2.0 WITH LLVM-exception |
| `libunwind` | Windows, Android: LLVM's unwinder (llvm-mingw's for `x86_64-pc-windows-gnullvm`, the NDK's for Android) | Apache-2.0 WITH LLVM-exception |
| `mingw-w64-crt` | Windows: the mingw-w64 C runtime startup and support objects llvm-mingw links into a `gnullvm` executable (a few files are in the public domain) | ZPL-2.1 |
| `winpthreads` | Windows: mingw-w64's POSIX threads library, linked by the `gnullvm` target | MIT |
| `zig-runtime` | Linux: zig's compiler-rt and C start-up code, which cargo-zigbuild's link against glibc 2.28 adds | MIT |
| `swiftshader` | Linux: [SwiftShader](https://swiftshader.googlesource.com/SwiftShader) (`libvk_swiftshader.so` and its ICD manifest) with marl, SPIRV-Tools and SPIRV-Headers and Chromium's libc++, libc++abi and llvm-libc compiled in, shipped beside the game | Apache-2.0 (SPIRV-Headers MIT-style; libc++, libc++abi and llvm-libc Apache-2.0 WITH LLVM-exception) |
| `vulkan-loader` | Linux: the Khronos [Vulkan loader](https://github.com/KhronosGroup/Vulkan-Loader) (`libvulkan.so.1`), shipped beside the game | Apache-2.0 |

## Asset importer decoders

The Rust · wgpu asset import step (`src/substrate/asset-import/`) runs five WebAssembly modules
in its own sandbox: three decoders, meshoptimizer's meshlet clusterizer and its simplifier. They are the builds
three.js 0.185.1 ships in `examples/jsm/libs`, read from the pinned `three` package (paths below
are under it). Their licence and notice texts are in the three.js add-on library sections below. The packaged app does not carry the importer yet; when it does,
this page ships beside the decoders.

| File | Project | License |
| --- | --- | --- |
| `examples/jsm/libs/basis/` | [Basis Universal](https://github.com/BinomialLLC/basis_universal) v1.50 transcoder, with its embedded [Zstandard](https://github.com/facebook/zstd) decoder | Apache-2.0; embedded Zstandard BSD-3-Clause |
| `examples/jsm/libs/draco/gltf/` | [Draco](https://github.com/google/draco) 1.5.6 glTF decoder | Apache-2.0 |
| `examples/jsm/libs/meshopt_decoder.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.1.1 decoder | MIT |
| `examples/jsm/libs/meshopt_clusterizer.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) meshlet clusterizer (a development build between 1.1.1 and 1.2.0); the importer stores its meshlets in glTF `extras` | MIT |
| `examples/jsm/libs/meshopt_simplifier.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) simplifier (a development build between 1.1.1 and 1.2.0); the importer stores its levels of detail in glTF `extras` | MIT |

## Asset importer ports

Code of the Rust · wgpu asset import step (`src/substrate/asset-import/`) ported from other
projects. The test fixture `tests/fixtures/asset-import/quantized.glb` is the output of
[gltfpack](https://github.com/zeux/meshoptimizer) 1.3.0 (MIT, the meshoptimizer licence below);
gltfpack itself is not in the repository.

| Genex file | What | Source | Upstream author | Licence |
| --- | --- | --- | --- | --- |
| `src/substrate/asset-import/dequantize.ts` | `KHR_mesh_quantization` undone: which attributes become float32 (every one but `JOINTS_n`, morph targets too) and the normalized-integer division with its -1 clamp | glTF-Transform 4.5.1 (https://github.com/donmccurdy/glTF-Transform), `packages/functions/src/dequantize.ts` and `packages/core/src/utils/math-utils.ts` (`decodeNormalizedInt`) | Don McCurdy | MIT (see [glTF-Transform](#gltf-transform)) |

### glTF-Transform

```
The MIT License (MIT)

Copyright (c) 2024 Don McCurdy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Components under other terms

- Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) ships in the package. It is not open
  source: © Anthropic PBC, all rights reserved, used under Anthropic's legal agreements
  (https://code.claude.com/docs/en/legal-and-compliance). Its native CLI packages are excluded.
- The Blender logo in `src/renderer/ui/brand.tsx` is a trademark of the Blender Foundation, used
  unaltered to refer to Blender under its logo guidelines (https://www.blender.org/about/logo/).

## Status not yet recorded

These need an owner decision before public distribution; see
[release readiness](docs/release-readiness.md#distribution-and-open-source).

- Genex UI sources: components, theme tokens, the wordmark and the catalog-search engine were
  adapted from the owner's `genex-cli-threejs` web app (`src/renderer/ui/GENEX-SOURCES.md`).
  The owner's contributed adaptations are covered by the root MIT license. Genex's name and
  logo identify the product; the code license does not grant trademark rights.
- The Genex guide https://genex.games/SKILL.md, vendored as `src/plugins/genex/skills/genex`:
  its license and terms are not recorded.
- The GameActivity AppCompat closure the spike's Android packaging fetches from Google Maven
  (see Rust runtime crates): the owner has not yet ratified that source.
- An unlicensed third-party canvas-editor reference has been excluded from the current tree.
  Its historical copies still need review before repository publication.

## Exo ports

The event store (`src/substrate/event-store.ts`), UUID semantics (`src/substrate/ids.ts`),
event envelope (`src/shared/event-log.ts`), turn rule (`src/substrate/turns.ts`), the guardian's
restart intent (`src/substrate/harness-host.ts`) and turn loop
(`src/harness-seed/loop/turn-loop.ts`) are TypeScript adaptations of Exo. Source: https://github.com/exoharness/exo.
Upstream license: https://github.com/exoharness/exo/blob/main/LICENSE.

MIT License

Copyright (c) 2026 Ankur Goyal

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## shadcn/ui

The primitives `src/renderer/ui/Button.tsx`, `dialog.tsx`, `dropdown-menu.tsx`, `input.tsx`,
`popover.tsx`, `switch.tsx`, `textarea.tsx`, `tooltip.tsx` and `cn.ts` follow shadcn/ui
components, through the Genex web app (`src/renderer/ui/GENEX-SOURCES.md`).
Source: https://github.com/shadcn-ui/ui/blob/main/LICENSE.md

MIT License

Copyright (c) 2023 shadcn

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Pi AI (@earendil-works/pi-ai) 0.84.2

The installed npm package omits a separate license file. This notice is copied from the exact upstream release: https://github.com/earendil-works/pi/blob/v0.84.2/LICENSE

MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Packages without a license file

These npm packages ship in the app without a license file of their own; their notices follow.

### github-url-to-object 4.0.6

Bundled. Its repository (https://github.com/zeke/github-url-to-object) and package declare the
MIT license without a license file; the author is zeke (Zeke Sikelianos). The MIT terms:

Copyright (c) zeke (Zeke Sikelianos)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### react-remove-scroll-bar 2.3.8

Bundled. Source: https://github.com/theKashey/react-remove-scroll-bar/blob/master/LICENSE

MIT License

Copyright (c) 2025 Anton Korzunov <thekashey@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### standardwebhooks 1.0.0

A dependency of the Anthropic SDK, in the packaged `node_modules`. Source:
https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/LICENSE

The MIT License

Copyright (c) 2023 Svix (https://www.svix.com)

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

### @sentry/server-utils 10.74.0

A dependency of the Genex CLI, in the Genex plugin payload. Source:
https://github.com/getsentry/sentry-javascript/blob/develop/LICENSE.md

MIT License

Copyright (c) 2012 Functional Software, Inc. dba Sentry

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Provider marks from lobe-icons

The Claude Code, Codex, OpenRouter and OpenCode marks in `src/renderer/ui/provider-marks.ts` are
copied unaltered from @lobehub/icons-static-svg 1.95.1 (claudecode.svg, codex.svg,
openrouter-color.svg, opencode.svg). Claude Code is a trademark of Anthropic, Codex of OpenAI,
OpenRouter of OpenRouter, Inc. and OpenCode of its owners; the marks only name the providers
Studio connects to.
Source: https://github.com/lobehub/lobe-icons/blob/master/LICENSE

MIT License

Copyright (c) 2023 LobeHub

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Appearance palette adaptations

The bundled palettes adapt the following MIT-licensed themes for Studio UI roles.

### Tokyo Night

Source: https://raw.githubusercontent.com/tokyo-run/tokyo-run-vscode-theme/master/LICENSE.txt

The MIT License (MIT)

Copyright (c) 2018-present Enkia

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.


### Catppuccin

Source: https://raw.githubusercontent.com/catppuccin/palette/main/LICENSE

MIT License

Copyright (c) 2021 Catppuccin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


### Rosé Pine

Source: https://raw.githubusercontent.com/rose-pine/rose-pine-palette/main/LICENSE

MIT License

Copyright (c) mvllow

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.


### GitHub VS Code themes

Source: https://raw.githubusercontent.com/primer/github-vscode-theme/main/LICENSE

MIT License

Copyright (c) 2020 Primer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## three.js add-on libraries

three.js 0.185.1 (r185) ships these third-party libraries in `examples/jsm/libs`. Genex vendors that folder for games, and copies the Basis and Draco decoders for the Assets viewer, with this page beside both copies. three.js's own license ships as `three-LICENSE`.

| File | Project | License |
| --- | --- | --- |
| `basis/` | [Basis Universal](https://github.com/BinomialLLC/basis_universal) v1.50 transcoder (three.js #29418); the WASM includes Basis's bundled [Zstandard](https://github.com/facebook/zstd) decoder (`transcoderSupportsKTX2Zstd()` returns true). `README.md` is three.js's own text. | Apache-2.0; embedded Zstandard BSD-3-Clause |
| `draco/` | [Draco](https://github.com/google/draco) 1.5.6 decoders, default and `gltf/` builds (three.js #25475). `README.md` is three.js's own text. | Apache-2.0 |
| `chevrotain.module.min.js` | [Chevrotain](https://github.com/Chevrotain/chevrotain) 9.0.1 (banner); bundles [regexp-to-ast](https://github.com/bd82/regexp-to-ast) 0.5.0 | Apache-2.0; bundled regexp-to-ast MIT |
| `demuxer_mp4.js` | [WebCodecs samples](https://github.com/w3c/webcodecs/tree/main/samples/video-decode-display) `video-decode-display/demuxer_mp4.js`, modified by three.js (ES module import). Imports [mp4box.js](https://github.com/gpac/mp4box.js) 2.3.0 from cdn.jsdelivr.net at runtime; mp4box.js itself is not in the folder. | W3C-20150513 (W3C Software and Document License, 2023 version) |
| `ecsy.module.js` | [ECSY](https://github.com/ecsyjs/ecsy) 0.4.2 (identical to npm `ecsy@0.4.2` `build/ecsy.module.js`; its internal `Version` constant reads 0.3.1) | MIT |
| `fflate.module.js` | [fflate](https://github.com/101arrowz/fflate) 0.8.2 (banner) | MIT |
| `ktx-parse.module.js` | [KTX-Parse](https://github.com/donmccurdy/KTX-Parse) 1.1.0 (three.js #31621, same day as the npm release) | MIT |
| `lil-gui.module.min.js` | [lil-gui](https://github.com/georgealways/lil-gui) 0.17.0 (identical to npm `dist/lil-gui.esm.min.js`) | MIT |
| `meshopt_clusterizer.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) development build between 1.1.1 and 1.2.0 (banner: built from meshoptimizer 1.1) | MIT |
| `meshopt_decoder.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.1.1 (identical to npm `meshopt_decoder.mjs`) | MIT |
| `meshopt_simplifier.module.js` | [meshoptimizer](https://github.com/zeux/meshoptimizer) development build between 1.1.1 and 1.2.0 (banner: built from meshoptimizer 1.1) | MIT |
| `mikktspace.module.js` | [mikktspace-wasm](https://github.com/donmccurdy/mikktspace-wasm) 1.1.0 (embedded WASM identical to npm `mikktspace@1.1.0`); compiled from the Rust crate [mikktspace](https://github.com/gltf-rs/mikktspace) 0.2.0 (a port of Morten S. Mikkelsen's [MikkTSpace](https://github.com/mmikk/MikkTSpace)), [nalgebra](https://github.com/dimforge/nalgebra) 0.19.0 and [wee_alloc](https://github.com/rustwasm/wee_alloc) 0.4.5 | MIT (wrapper); MIT OR Apache-2.0 (crate); Zlib (MikkTSpace); BSD-3-Clause (nalgebra); **MPL-2.0 (wee_alloc)** |
| `motion-controllers.module.js` | [WebXR Input Profiles](https://github.com/immersive-web/webxr-input-profiles) `@webxr-input-profiles/motion-controllers` 1.0.0 (banner; JSDoc types edited by three.js) | MIT |
| `potpack.module.js` | [potpack](https://github.com/mapbox/potpack) 1.0.1 (code identical to npm `index.mjs`; license header added by three.js) | ISC |
| `stats.module.js` | [stats.js](https://github.com/mrdoob/stats.js) r17 `src/Stats.js` as an ES module | MIT |
| `surfaceNet.js` | [isosurface](https://github.com/mikolalysenko/isosurface) `lib/surfacenets.js` (last upstream commit 22eba3c, 2014), modified by three.js; no release number | MIT |
| `tween.module.js` | [tween.js](https://github.com/tweenjs/tween.js) 23.1.1 (identical to npm `dist/tween.esm.js`) | MIT |
| `utif.module.js` | [UTIF.js](https://github.com/photopea/UTIF.js) at commit fce41de (2023-06-09) as an ES module; no release number. Embeds the [pdf.js](https://github.com/mozilla/pdf.js) JPEG decoder and camera-raw decoders ported from dcraw and LibRaw (see the UTIF.js section) | MIT; embedded pdf.js JPEG decoder Apache-2.0; Panasonic RW2 decoder apparently from LibRaw (**LGPL-2.1 OR CDDL-1.0**) |
| `zstddec.module.js` | [zstddec](https://github.com/donmccurdy/zstddec) 0.0.2 (npm `dist/zstddec.modern.js`); embeds a WASM build of [Zstandard](https://github.com/facebook/zstd) | MIT; embedded Zstandard BSD-3-Clause (zstd is BSD-3-Clause OR GPL-2.0-only; BSD chosen) |

### Basis Universal

Copyright (C) 2019-2024 Binomial LLC. All Rights Reserved.

(The line above is from the v1.50 transcoder sources; v1.50's LICENSE carries only the Apache template line. The current upstream LICENSE reads `Copyright 2019-2026 Binomial LLC`.)

Licensed under the Apache License, Version 2.0; the full text is at the end of this file.

NOTICE (upstream `NOTICE` on the default branch; v1.50 had no NOTICE file). The embedded Zstandard decoder is covered by the Zstandard section below.

```
NOTICE

Basis Universal™ Supercompressed GPU Texture Compression Library

Copyright © 2016–2026 Binomial LLC.
All rights reserved except as granted under the [Apache 2.0 license](https://github.com/BinomialLLC/basis_universal/blob/master/LICENSE).
"Basis Universal" is a trademark of Binomial LLC.

The documents in the Basis Universal wiki, and the Basis Universal library, example, and tool source code, fall under the Apache 2.0 license, unless otherwise explicitly indicated.

Redistributions or derivative works must include a readable copy of the attribution notices from this NOTICE file (see Apache License 2.0 §4(d)).

If you modify the Basis Universal source code, specifications, or wiki documents and redistribute the files, you must cause any modified files to carry prominent notices stating that you changed the files (see Apache 2.0 §4(b)).

**This software, documentation and specifications are provided "as is", without warranty of any kind (see Apache 2.0 §§7–8).**
```

### Draco

Copyright 2016 The Draco Authors.

(From the Draco 1.5.6 source file headers; the LICENSE file carries only the Apache template line. Draco has no NOTICE file.)

Licensed under the Apache License, Version 2.0; the full text is at the end of this file.

### Chevrotain

Copyright (c) 2015-2019 SAP SE or an SAP affiliate company.

Licensed under the Apache License, Version 2.0; the full text is at the end of this file.

NOTICE (`NOTICE.txt` at tag v9.0.1; the current upstream file adds the line `Copyright (c) 2021 the original author or authors from the Chevrotain project`):

```
Copyright (c) 2015-2019 SAP SE or an SAP affiliate company.
```

### regexp-to-ast

Bundled inside `chevrotain.module.min.js` (version 0.5.0).

Copyright (c) 2018 Shahar Soel

```
MIT License

Copyright (c) 2018 Shahar Soel

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### WebCodecs samples

Upstream has no copyright line: the file carries none, and the repository's LICENSE.md says "All documents in this Repository are licensed by contributors under the W3C Software and Document License". The license asks for the W3C short notice when no notice exists, and for a statement of changes. Both are filled in below from W3C's templates; the years are the file's history in w3c/webcodecs (2022-08 to 2023-06, the version three.js copied).

```
WebCodecs samples, video-decode-display/demuxer_mp4.js:
https://github.com/w3c/webcodecs/blob/main/samples/video-decode-display/demuxer_mp4.js

Copyright © 2022-2023 World Wide Web Consortium. All Rights Reserved. This work is
distributed under the W3C® Software and Document License [1] in the hope that it will
be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.

[1] https://www.w3.org/Consortium/Legal/copyright-software

demuxer_mp4.js includes material copied from or derived from WebCodecs samples,
video-decode-display/demuxer_mp4.js
(https://github.com/w3c/webcodecs/tree/main/samples/video-decode-display), modified by the
three.js authors. Copyright © 2022-2023 World Wide Web Consortium.
https://www.w3.org/copyright/software-license-2023/
```

W3C Software and Document License, 2023 version (https://www.w3.org/copyright/software-license-2023/):

```
This work is being provided by the copyright holders under the following license.

License

By obtaining and/or copying this work, you (the licensee) agree that you have read, understood, and will comply with the following terms and conditions.

Permission to copy, modify, and distribute this work, with or without modification, for any purpose and without fee or royalty is hereby granted, provided that you include the following on ALL copies of the work or portions thereof, including modifications:

- The full text of this NOTICE in a location viewable to users of the redistributed or derivative work.
- Any pre-existing intellectual property disclaimers, notices, or terms and conditions. If none exist, the W3C software and document short notice should be included.
- Notice of any changes or modifications, through a copyright statement on the new code or document such as "This software or document includes material copied from or derived from [title and URI of the W3C document]. Copyright © [$year-of-document] World Wide Web Consortium. https://www.w3.org/copyright/software-license-2023/"

Disclaimers

THIS WORK IS PROVIDED "AS IS," AND COPYRIGHT HOLDERS MAKE NO REPRESENTATIONS OR WARRANTIES, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO, WARRANTIES OF MERCHANTABILITY OR FITNESS FOR ANY PARTICULAR PURPOSE OR THAT THE USE OF THE SOFTWARE OR DOCUMENT WILL NOT INFRINGE ANY THIRD PARTY PATENTS, COPYRIGHTS, TRADEMARKS OR OTHER RIGHTS.

COPYRIGHT HOLDERS WILL NOT BE LIABLE FOR ANY DIRECT, INDIRECT, SPECIAL OR CONSEQUENTIAL DAMAGES ARISING OUT OF ANY USE OF THE SOFTWARE OR DOCUMENT.

The name and trademarks of copyright holders may NOT be used in advertising or publicity pertaining to the work without specific, written prior permission. Title to copyright in this work will at all times remain with copyright holders.
```

### ECSY

Copyright (c) 2020 Mozilla

```
MIT License

Copyright (c) 2020 Mozilla

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### fflate

Copyright (c) 2023 Arjun Barrett (LICENSE at tag v0.8.2; the current file says 2026)

```
MIT License

Copyright (c) 2023 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### KTX-Parse

Copyright (c) 2020 Don McCurdy

```
The MIT License (MIT)

Copyright (c) 2020 Don McCurdy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### lil-gui

Copyright (c) 2019 George Michael Brower

```
MIT License

Copyright (c) 2019 George Michael Brower

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### meshoptimizer

Copyright (c) 2016-2026 Arseny Kapoulkine (covers `meshopt_clusterizer.module.js`, `meshopt_decoder.module.js` and `meshopt_simplifier.module.js`)

```
MIT License

Copyright (c) 2016-2026 Arseny Kapoulkine

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### mikktspace-wasm

Copyright (c) 2021 Don McCurdy

```
The MIT License (MIT)

Copyright (c) 2021 Don McCurdy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The embedded WASM is compiled from the code in the next four sections, plus the Rust standard library and wasm-bindgen 0.2.73 (both MIT OR Apache-2.0).

### mikktspace (Rust crate)

Copyright (c) 2017 The mikktspace Library Developers

Dual-licensed MIT OR Apache-2.0; used here under MIT (`LICENSE-MIT` of crate 0.2.0):

```
Copyright (c) 2017 The mikktspace Library Developers

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

### MikkTSpace

Copyright (C) 2011 by Morten S. Mikkelsen

The mikktspace crate is a transpilation of this C code (upstream gltf-rs/mikktspace now reproduces the notice in `src/generated.rs`). Text from the header of `mikktspace.c` in mmikk/MikkTSpace:

```
Copyright (C) 2011 by Morten S. Mikkelsen

This software is provided 'as-is', without any express or implied
warranty.  In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
   claim that you wrote the original software. If you use this software
   in a product, an acknowledgment in the product documentation would be
   appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.
```

### nalgebra

Copyright (c) 2013, Sébastien Crozet

Version 0.19.0, a dependency of the mikktspace crate (LICENSE at tag v0.19.0):

```
Copyright (c) 2013, Sébastien Crozet
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the author nor the names of its contributors may be used
   to endorse or promote products derived from this software without specific
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### wee_alloc

wee_alloc 0.4.5 (https://github.com/rustwasm/wee_alloc) is the global allocator compiled into the mikktspace WASM. Upstream names no copyright holder (its LICENSE file is the bare MPL text).

This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not distributed with this file, You can obtain one at http://mozilla.org/MPL/2.0/.

Source Code Form: the unmodified crate from crates.io, https://crates.io/crates/wee_alloc/0.4.5, and https://github.com/rustwasm/wee_alloc/tree/0.4.5.

### WebXR Input Profiles

Copyright (c) 2019 Amazon

(`packages/motion-controllers/LICENSE.md`; identical to the LICENSE.md in the npm package 1.0.0.)

```
MIT License

Copyright (c) 2019 Amazon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is furnished
to do so, subject to the following conditions:

The above copyright notice and this permission notice (including the next
paragraph) shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS
OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF
OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### potpack

Copyright (c) 2018, Mapbox

```
ISC License

Copyright (c) 2018, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### stats.js

Copyright (c) 2009-2016 stats.js authors

```
The MIT License

Copyright (c) 2009-2016 stats.js authors

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

### isosurface

Copyright (c) 2013 Mikola Lysenko

(`surfaceNet.js` also carries the line `Written by Mikola Lysenko (C) 2012` from the upstream file header.)

```
The MIT License (MIT)

Copyright (c) 2013 Mikola Lysenko

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

### tween.js

Copyright (c) 2010-2012 Tween.js authors.

Easing equations Copyright (c) 2001 Robert Penner http://robertpenner.com/easing/

```
The MIT License

Copyright (c) 2010-2012 Tween.js authors.

Easing equations Copyright (c) 2001 Robert Penner http://robertpenner.com/easing/

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

### UTIF.js

Copyright (c) 2017 Photopea

```
MIT License

Copyright (c) 2017 Photopea

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

UTIF.js publishes the whole file under MIT and credits none of the following embedded code:

- **JPEG decoder (Apache-2.0).** The minified block after `// Following lines add a JPEG decoder` is pdf.js's `JpegImage` (same DCT constants and `JpegError`, and the file says `//UTIF.JpegDecoder = PDFJS.JpegImage;`). See the pdf.js section.
- **Nikon and Sony ARW raw decoders (dcraw).** `_decodeNikon` (the `nikon_tree` table), `_decodeARW`, `_ljpeg_diff`, `_getbithuff` and `_make_decoder` port dcraw's `nikon_load_raw`, `sony_arw_load_raw`, `ljpeg_diff`, `getbithuff` and `make_decoder`. dcraw.c (Copyright 1997-2018 by Dave Coffin) restricts only its Foveon functions and says "All other code remains free for all uses"; UTIF.js contains no Foveon code.
- **Panasonic RW2 format-6 decoder (LGPL-2.1 OR CDDL-1.0).** `readPageRW6` in `_decodePanasonic` matches LibRaw's `pana_cs6_page_decoder::read_page` line for line (same shifts, masks and `// 14 bit` comments). LibRaw (Copyright 2019-2022 LibRaw LLC) is dual-licensed under the GNU Lesser General Public License 2.1 (https://www.gnu.org/licenses/old-licenses/lgpl-2.1.txt) or the Common Development and Distribution License 1.0 (https://opensource.org/license/cddl-1-0); its source is at https://github.com/LibRaw/LibRaw.
- **GoPro VC-5 decoder.** `_decodeVC5` is minified; its origin is not identified.

### pdf.js

Copyright 2014 Mozilla Foundation

(From the header of `src/core/jpg.js`, the JPEG decoder embedded in `utif.module.js`; pdf.js has no NOTICE file.)

Licensed under the Apache License, Version 2.0; the full text is at the end of this file.

### zstddec

Copyright (c) 2020 Don McCurdy

```
The MIT License (MIT)

Copyright (c) 2020 Don McCurdy

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The WebAssembly decoder embedded in `zstddec.module.js` is Zstandard; see the next section. zstddec's own LICENSE file repeats the Zstandard BSD license with the line `Copyright (c) 2016-present, Yann Collet, Facebook, Inc. All rights reserved.`

### Zstandard

Copyright (c) 2016-present, Facebook, Inc. All rights reserved.

Covers the decoders embedded in `zstddec.module.js` and `basis/basis_transcoder.wasm`. zstd is dual-licensed BSD-3-Clause OR GPL-2.0-only; this distribution uses the BSD license. Text below is zstd's `LICENSE` as it read from 2016-08 to 2022-12, the period both decoders were built in (zstddec 0.0.2 in 2020; Basis's `zstddeclib.c` header is dated 2016-2021), and identical to `zstd/LICENSE` in Basis Universal v1.50. (Since 2022-12 the upstream line reads `Copyright (c) Meta Platforms, Inc. and affiliates. All rights reserved.`)

```
BSD License

For Zstandard software

Copyright (c) 2016-present, Facebook, Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 * Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

 * Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

 * Neither the name Facebook nor the names of its contributors may be used to
   endorse or promote products derived from this software without specific
   prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Apache License 2.0

Applies to Basis Universal, Draco, Chevrotain, the pdf.js JPEG decoder, the Filament functions the Rust renderer ports (Copyright (C) The Android Open Source Project) and the Bevy auto exposure, contact-shadow, reflection-probe box-projection, irradiance-volume lookup and motion-blur functions it ports (Bevy contributors and Tomasz Stachowiak, dual-licensed MIT OR Apache-2.0) ([Rust renderer shader ports](#rust-renderer-shader-ports)). Text from https://www.apache.org/licenses/LICENSE-2.0.txt:

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```
