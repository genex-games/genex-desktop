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
- On macOS and Windows, cua-driver (MIT) keeps its license and cua's notices under
  `dist/resources/cua-driver` ([Vendored Cua Driver](#vendored-cua-driver-cua-driver)).
- On Windows, Git for Windows (GPL-2.0 and its components' licenses) keeps its `LICENSE.txt` and
  `usr/share/licenses` under `resources/git`
  ([Bundled Git for Windows](#bundled-git-for-windows)).
- On Windows, Microsoft's Visual C++ runtime DLL ships beside sandbox-runtime's `srt-win.exe`
  ([Visual C++ runtime](#visual-c-runtime-windows)).
- The TypeScript 7 compiler (Apache-2.0), `@types/node` and `undici-types` (MIT) that the
  self-edit type gate runs keep their license and notice files under `dist/resources/tsc`.
- The Rust asset importer's tools under `dist/resources/importer-tools` (Basis Universal, Draco,
  meshoptimizer) have this page beside them ([Asset importer decoders](#asset-importer-decoders)).
- The Genex asset CLI (`@genex-ai/cli-demo`, MIT) and its dependencies keep their license files
  in the Genex plugin payload under `dist/resources/plugins/genex/node_modules`.

## Bundled plugin icons

- `src/plugins/blender/icon.png` (shipped as `dist/resources/plugins/blender/icon.png`) is the
  official Blender mark, as Blender's own app icon shows it. The Blender logo is a registered
  trademark of the Blender Foundation; Local Blender uses it only to identify Blender, which it
  runs (https://www.blender.org/about/logo/). No endorsement is implied.
- `src/plugins/genex/icon.png` is Genex's own icon from genex.games.
- `src/plugins/godot/icon.svg` and the `godot` glyph in `src/renderer/ui/icons.tsx` redraw the
  head of the Godot logo as simplified line art. The Godot logo is by Andrea Calabró, licensed
  under CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); these drawings change it.
  Godot and the Godot logo are trademarks of the Godot Foundation, used only to identify Godot,
  which the Godot plugin runs. Genex is not affiliated with or endorsed by the Godot Foundation.
- `src/plugins/unreal/icon.svg` and the `unreal` glyph in `src/renderer/ui/icons.tsx` draw a U in
  a ring to identify Unreal Engine, which the Unreal plugin runs. Unreal and Unreal Engine are
  trademarks or registered trademarks of Epic Games, Inc. in the United States and elsewhere.
  Genex is not affiliated with or endorsed by Epic Games.
- `src/plugins/unity/icon.svg`, the `unity` glyph in `src/renderer/ui/icons.tsx` and the project
  tile in `src/plugins/unity/panel.html` show the Unity logo, unaltered (its path from Simple Icons
  13.21.0, CC0-1.0), only to identify Unity, which the Unity plugin runs. Unity and the Unity logo
  are trademarks or registered trademarks of Unity Technologies or its affiliates in the U.S. and
  elsewhere. Genex is not affiliated with or endorsed by Unity Technologies.
- The `linux` glyph in `src/renderer/ui/icons.tsx` draws Tux, Linux's penguin (its path from
  Simple Icons 16.35.0, CC0-1.0, without the feet lines), only to show that a game has a
  Linux version. Tux was drawn by Larry Ewing with The GIMP. Linux is a registered trademark of
  Linus Torvalds.

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
  `@genex-ai/cli-demo` 1.36.13 `templates/skills` (MIT, Copyright (c) 2026 me-ai-org). The
  license text ships beside them as `skills/LICENSE-cards`, copied from the CLI's `LICENSE`.
- `genex/SKILL.md` wraps https://genex.games/SKILL.md (v1.36.13), which is not part of the npm
  package. It is attributed to Genex here; its license is not yet confirmed (see "Status not yet
  recorded" below).

## Adapted Roblox skill

`src/plugins/roblox/skills/get-started.md` (shipped as
`dist/resources/plugins/roblox/skills/get-started.md`) adapts the `roblox-get-started` skill from
Roblox's [roblox-studio-agent-plugin](https://github.com/Roblox/roblox-studio-agent-plugin)
(plugin version 0.2.1, `skills/roblox-get-started`), MIT, Copyright (c) 2026 Roblox Corporation. It
is rewritten for Genex's Roblox Studio button and keeps the original's license text at its end.
The Roblox Studio plugin's other skills are Genex's own. Roblox and Roblox Studio are trademarks of
Roblox Corporation; Genex is not affiliated with Roblox Corporation.

## Luau checks downloaded on request

The Roblox Studio plugin's **Add Luau checks** downloads these public releases from GitHub, each
pinned by version, size and sha256 (`src/plugins/roblox/luau-tools.ts`), only when the person
confirms it. None of them is in the app's build or this repository; they are kept in the plugin's
own storage (`<plugin storage>/luau/<name>-<version>/`) and run on the person's computer to check a
game's scripts.

- [luau-lsp](https://github.com/JohnnyMorganz/luau-lsp) 1.70.1 (`luau-lsp-macos.zip`,
  `luau-lsp-win64.zip`), MIT, Copyright (c) 2022 JohnnyMorganz; and its Roblox type definitions
  `scripts/globalTypes.None.d.luau` at the same tag, from the same repository and license.
- [selene](https://github.com/Kampfkarren/selene) 0.32.0 (`selene-0.32.0-macos.zip`,
  `selene-0.32.0-windows.zip`), Mozilla Public License 2.0. selene fetches Roblox's API library
  itself on its first run.
- [StyLua](https://github.com/JohnnyMorganz/StyLua) 2.6.0 (`stylua-macos-aarch64.zip`,
  `stylua-macos-x86_64.zip`, `stylua-windows-x86_64.zip`), Mozilla Public License 2.0.

Each release ships its own license; Genex neither changes nor redistributes these programs.

## Vendored three.js

Games and the asset preview use a vendored three.js (MIT, Copyright © 2010-2026 three.js
authors); its license ships as `dist/resources/vendor/three-LICENSE`. The copied `examples/jsm`
tree includes third-party libraries under their own terms, listed with their licenses in
[three.js add-on libraries](#threejs-add-on-libraries); the Assets viewer also copies the Draco and
Basis Universal decoders to `dist/renderer/decoders`.

## Vendored Cua Driver (cua-driver)

On macOS and Windows, computer control runs cua-driver 0.35.2 from
[trycua/cua](https://github.com/trycua/cua) (MIT, Copyright (c) 2025 Cua AI, Inc.), bundled as
`dist/resources/cua-driver/cua-driver` (`cua-driver.exe` on Windows): the executable from cua's
release, on macOS thinned to the app's architecture and signed with the app's identity, on Windows
as cua signed it (`scripts/vendor-cua-driver.ts`). Its license and cua's third-party notices for that release
(code derived from trope-cua, Interface-Agent, yabai, QuickJS-ng, rquickjs and T3 Code, all MIT)
ship beside it as `LICENSE.md` and `THIRD_PARTY_NOTICES.md`, copied from `build/cua-driver/`. The
bundled copy runs with cua's telemetry and update check turned off.

## Bundled Git for Windows

The Windows app ships Git for Windows 2.56.0.windows.2, the portable edition from
[git-for-windows/git](https://github.com/git-for-windows/git), as `resources/git` beside the app:
Git (GPL-2.0) and the MSYS2 and MinGW-w64 programs and libraries it is built with, each under its
own license. Its `LICENSE.txt` and the license files in `usr/share/licenses` ship unchanged with
it. The copy is the release's own files with its documentation, graphical tools, Vim and Git
Credential Manager left out (`scripts/vendor-git-for-windows.ts`); nothing in it is modified. The
source of every part is published with that release on GitHub and in the MSYS2 and Git for Windows
package repositories it names.

## Visual C++ runtime (Windows)

The Windows app ships Microsoft's Visual C++ 2015-2022 runtime library `vcruntime140.dll`
(Copyright (c) Microsoft Corporation) beside sandbox-runtime's `srt-win.exe`, which imports it and
would not start without it: Windows does not include it. Packaging copies it unchanged, for that
executable's architecture, from the Visual C++ redistributable folder of the Visual Studio that
builds the package (`VC\Redist\MSVC\<version>\<arch>\Microsoft.VC14x.CRT`,
`scripts/package-vc-runtime.cjs`): app-local deployment, which the Distributable Code terms of the
Visual Studio license allow. It remains under those terms. Any other Visual C++ runtime DLL a
bundled program imports ships the same way, and the packaged smoke fails when one is missing.

## Vendored Genex embed SDK (@genex-ai/embed-sdk)

Template games and published games that bring no SDK of their own use Genex's player-identity SDK,
`@genex-ai/embed-sdk` 0.33.0 (MIT, as its package.json declares; the package ships no license
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

Zalando Sans SemiExpanded, Geist Mono, LINE Seed JP, TikTok Sans, Pretendard and Noto Sans SC
are licensed under the SIL Open Font License 1.1; their OFL texts ship beside them in
`dist/renderer/fonts`. Zalando Sans SemiExpanded, Geist Mono and LINE Seed JP are as published.
TikTok Sans is cut to its Cyrillic and Greek at one width as "TikTok Sans Genex"; Pretendard
(Reserved Font Name "Pretendard") is cut to its Hangul as "Genex Hangul"; Noto Sans SC is cut to
the characters of GB 2312 ([sources](src/renderer/ui/GENEX-SOURCES.md#font-licenses)). Geist, as
published, renders design studies in `design/`. Copies with their OFL texts in `design/genex-promo-video/public/fonts` and
`design/play-publish-video/public/fonts` render the promo films.

## Promo films

The films in `src/renderer/media` are made by Genex with Remotion, which is not bundled. The
Genex promo film is made from recordings of genex.games; one clip, `village-game.mp4`, was
generated through fal.ai with Nano Banana Pro and Seedance 2.5 (`design/genex-promo-video/README.md`).
The Play film, `play-publish.mp4`, shows game covers from the public genex.games gallery
(`design/play-publish-video/README.md`); its players and its desk were made with Genex image
generation for the film.

## Rust template's interior kit

The trim sheet, props atlas and decals in `src/game-template-rust/docs/examples/interior-kit/assets/kit/`
are cut and repainted from Poly Haven scans published under CC0-1.0 (`wood_table_worn`,
`green_metal_rust`, `rusty_metal_02`, `concrete_wall_003`, `painted_plaster_wall`,
`peeling_painted_wall`) by `native/genex-rust/examples/template-examples/kit/kit_sheets.py`; no
credit is required. Its GLBs are made by Genex's own `interior_kit.py`.

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
  wgpu asset import step encodes and transcodes textures with (`src/substrate/asset-import/basis-encoder.ts`,
  pinned by sha256 at the `v2_50` release commit). A development fetch
  (`node scripts/toolchains/importer-tools.ts fetch`) downloads it and it is never committed; the
  build copies it into the packaged app ([Asset importer decoders](#asset-importer-decoders)).
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

## SDL's controller table and face labels

`native/genex-rust/crates/genex-core/src/pad_family.rs` holds an altered port of SDL's
`src/joystick/controller_list.h` (zlib, Copyright (C) Valve Corporation; SDL commit
b9d64c45a965edc4b003c160ab446426363e192d): the USB vendor and product ids of known gamepads, each
folded into the face-label family Genex shows. `native/genex-rust/crates/genex-input/src/glyph.rs`
holds an altered port of SDL3's face-button labels (`SDL_GetGamepadButtonLabelForFaceStyle` and
`SDL_GetGamepadFaceStyleForGamepadType` in `src/joystick/SDL_gamepad.c`, zlib, Copyright (C)
1997-2026 Sam Lantinga; same SDL commit). The module notes of both files mark what Genex changed and
keep the zlib notice; every Rust game compiles them in.

## Rust runtime crates

The `genex` workspace in `native/genex-rust` (Genex's own code, MIT) builds offline from a vendored
crate set: `scripts/spike/rust-wgpu/vendor-allowlist.toml` names the direct dependencies,
`setup-toolchain.sh` vendors their resolved closure (502 crates) into the project-local toolchain
folder, and `native/genex-rust/Cargo.lock` pins what the workspace uses. Apart from
genex-multiplayer (below), no crate source is copied into this repository or shipped inside
Genex.app; each vendored crate keeps its licence files in
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
- `bevy_mikktspace` 1.0.0 (the MikkTSpace tangent algorithm, Morten S. Mikkelsen's original under
  the zlib licence) is under Zlib AND (MIT OR Apache-2.0); the zlib terms are in its source.
- tinystr 0.8.4, zerofrom 0.1.8 and zerovec 0.11.8 (ICU4X, through unic-langid for gameplay UI
  text) are under the Unicode License v3 (Unicode-3.0), a permissive licence.
- `self_cell` 1.3.0 is offered under Apache-2.0 OR GPL-2.0-only and `r-efi` under MIT OR
  Apache-2.0 OR LGPL-2.1-or-later; Genex uses Apache-2.0 and MIT respectively.

| Licence (as the crate declares it) | Crates | Crates and versions |
| --- | --- | --- |
| MIT OR Apache-2.0 | 263 | accesskit 0.24.1, ahash 0.8.12, allocator-api2 0.2.21, android-activity 0.6.1, android_log-sys 0.3.2, android_logger 0.15.1, android_system_properties 0.1.6, anyhow 1.0.104, arboard 3.6.1, arrayvec 0.7.8, as-raw-xcb-connection 1.0.1, ash 0.38.0+1.3.281, async-trait 0.1.92, atomic-arena 0.1.2, atomic-polyfill 1.0.3, backtrace 0.3.76, base64 0.13.1, bitflags 1.3.2, bitflags 2.13.2, block-buffer 0.10.4, bumpalo 3.20.3, cast 0.3.0, cc 1.6.0, cfg-if 1.0.5, cobs 0.3.0, core-foundation 0.9.4, core-foundation-sys 0.8.7, core-graphics 0.23.2, core-graphics-types 0.1.3, coreaudio-rs 0.14.2, cpufeatures 0.2.17, crc32fast 1.5.2, critical-section 1.2.0, crossbeam-utils 0.8.23, crypto-common 0.1.7, dasp_sample 0.11.0, digest 0.10.7, displaydoc 0.2.7, document-features 0.2.12, downcast-rs 1.2.1, downcast-rs 2.0.2, ecolor 0.36.2, egui 0.36.2, egui-wgpu 0.36.2, egui-winit 0.36.2, either 1.18.0, emath 0.36.2, embedded-io 0.4.0, embedded-io 0.6.1, ena 0.14.4, env_filter 0.1.4, epaint 0.36.2, errno 0.3.14, euclid 0.22.14, fdeflate 0.3.7, find-msvc-tools 0.1.14, flate2 1.1.10, font-types 0.12.6, foreign-types 0.5.0, foreign-types-macros 0.2.4, foreign-types-shared 0.3.1, futures-channel 0.3.34, futures-core 0.3.34, futures-task 0.3.34, futures-util 0.3.34, getrandom 0.3.4, getrandom 0.4.3, gif 0.14.2, gimli 0.32.3, glam 0.30.10, glam 0.31.1, glam 0.32.1, glam 0.33.12, glamx 0.3.1, glob 0.3.4, gltf 1.4.1, gltf-derive 1.4.1, gltf-json 1.4.1, gpu-allocator 0.28.0, guillotiere 0.7.0, half 2.7.1, hash32 0.2.1, hash32 0.3.1, hashbrown 0.16.1, hashbrown 0.17.1, heapless 0.7.17, heapless 0.8.0, hermit-abi 0.5.3, image 0.25.10, image-webp 0.2.4, itertools 0.14.0, itertools 0.15.0, itoa 1.0.18, jni 0.21.1, jni 0.22.4, jni-macros 0.22.4, jni-sys 0.3.1, jni-sys 0.4.1, jni-sys-macros 0.4.1, jobserver 0.1.35, js-sys 0.3.106, kira 0.12.5, lazy_static 1.5.1, libc 0.2.190, litrs 1.0.0, lock_api 0.4.14, log 0.4.34, matrixmultiply 0.3.11, memmap2 0.9.11, naga 30.0.1, naga-types 30.0.1, ndk 0.9.0, ndk-context 0.1.1, ndk-sys 0.6.0+11769913, nonmax 0.5.5, num-bigint 0.4.8, num-complex 0.4.6, num-derive 0.4.2, num-derive 0.5.1, num-integer 0.1.47, num-rational 0.4.2, num-traits 0.2.19, once_cell 1.21.4, parking_lot 0.12.5, parking_lot_core 0.9.12, paste 1.0.15, pastey 0.2.3, percent-encoding 2.3.2, pkg-config 0.3.34, plain 0.2.3, png 0.18.1, polycool 0.4.0, postcard 1.1.3, presser 0.3.1, proc-macro-crate 3.5.0, proc-macro2 1.0.107, profiling 1.0.18, profiling-procmacros 1.0.18, puffin 0.20.0, qoi 0.4.1, quick-error 2.0.1, quote 1.0.47, rand 0.8.8, rand_core 0.6.4, rand_xorshift 0.3.0, range-alloc 0.1.5, raw-window-metal 1.1.0, rawpointer 0.2.1, read-fonts 0.41.0, regex 1.13.1, regex-automata 0.4.18, regex-lite 0.1.9, regex-syntax 0.8.11, renderdoc-sys 1.1.0, robust 1.2.0, rstar 0.13.0, rtrb 0.4.0, rustc_version 0.4.1, rustversion 1.0.23, scoped-tls 1.0.1, scopeguard 1.2.0, semver 1.0.28, send_wrapper 0.6.0, serde 1.0.229, serde_arrays 0.2.0, serde_core 1.0.229, serde_derive 1.0.229, serde_json 1.0.151, serde_spanned 1.1.1, sha2 0.10.9, shlex 2.0.1, simdutf8 0.1.5, skrifa 0.44.0, smallvec 1.16.2, smol_str 0.2.2, spade 2.15.1, stable_deref_trait 1.2.1, static_assertions 1.1.0, syn 2.0.119, syn 3.0.6, sys-locale 0.3.2, target-tuple 1.0.2, thiserror 1.0.69, thiserror 2.0.21, thiserror-impl 1.0.69, thiserror-impl 2.0.21, toml 1.1.6+spec-1.1.0, toml_datetime 1.1.1+spec-1.1.0, toml_edit 0.25.15+spec-1.1.0, toml_parser 1.1.3+spec-1.1.0, toml_writer 1.1.2+spec-1.1.0, trybuild 1.0.121, ttf-parser 0.25.1, type-map 0.5.1, typenum 1.20.1, unic-langid 0.9.6, unic-langid-impl 0.9.6, unicode-segmentation 1.13.3, unicode-width 0.2.2, vec_map 0.8.2, version_check 0.9.5, wasm-bindgen 0.2.129, wasm-bindgen-futures 0.4.79, wasm-bindgen-macro 0.2.129, wasm-bindgen-macro-support 0.2.129, wasm-bindgen-shared 0.2.129, wasm-bindgen-test 0.3.79, wasm-bindgen-test-macro 0.3.79, wasm-bindgen-test-shared 0.2.129, web-sys 0.3.106, web-time 1.1.0, weezl 0.1.12, wgpu 30.0.1, wgpu-core 30.0.1, wgpu-core-deps-apple 30.0.1, wgpu-core-deps-windows-linux-android 30.0.1, wgpu-hal 30.0.1, wgpu-naga-bridge 30.0.1, wgpu-types 30.0.1, windows 0.62.2, windows-collections 0.3.2, windows-core 0.62.2, windows-future 0.3.2, windows-implement 0.60.2, windows-interface 0.59.3, windows-link 0.2.1, windows-numerics 0.3.1, windows-result 0.4.1, windows-strings 0.5.1, windows-sys 0.45.0, windows-sys 0.52.0, windows-sys 0.59.0, windows-sys 0.60.2, windows-sys 0.61.2, windows-targets 0.42.2, windows-targets 0.52.6, windows-targets 0.53.5, windows-threading 0.2.1, windows_aarch64_gnullvm 0.42.2, windows_aarch64_gnullvm 0.52.6, windows_aarch64_gnullvm 0.53.1, windows_aarch64_msvc 0.42.2, windows_aarch64_msvc 0.52.6, windows_aarch64_msvc 0.53.1, windows_i686_gnu 0.42.2, windows_i686_gnu 0.52.6, windows_i686_gnu 0.53.1, windows_i686_gnullvm 0.52.6, windows_i686_gnullvm 0.53.1, windows_i686_msvc 0.42.2, windows_i686_msvc 0.52.6, windows_i686_msvc 0.53.1, windows_x86_64_gnu 0.42.2, windows_x86_64_gnu 0.52.6, windows_x86_64_gnu 0.53.1, windows_x86_64_gnullvm 0.42.2, windows_x86_64_gnullvm 0.52.6, windows_x86_64_gnullvm 0.53.1, windows_x86_64_msvc 0.42.2, windows_x86_64_msvc 0.52.6, windows_x86_64_msvc 0.53.1, x11rb 0.13.2, x11rb-protocol 0.13.2 |
| MIT | 86 | alsa-sys 0.4.0, android-properties 0.2.2, block2 0.5.1, block2 0.6.2, bytes 1.12.1, calloop 0.13.0, calloop 0.14.5, calloop-wayland-source 0.3.0, calloop-wayland-source 0.4.1, cfg_aliases 0.2.2, color_quant 1.1.0, combine 4.6.8, crunchy 0.2.4, dispatch 0.2.0, dlib 0.5.3, extended 0.1.0, fax 0.2.7, generic-array 0.14.7, harfrust 0.12.0, inflections 1.1.1, libm 0.2.16, libredox 0.1.25, libudev-sys 0.1.4, mint 0.5.9, nix 0.31.3, nu-ansi-term 0.50.3, objc-sys 0.3.5, objc2 0.5.3, objc2 0.6.5, objc2-app-kit 0.2.2, objc2-cloud-kit 0.2.2, objc2-contacts 0.2.2, objc2-core-data 0.2.2, objc2-core-image 0.2.2, objc2-core-location 0.2.2, objc2-encode 4.1.0, objc2-foundation 0.2.2, objc2-foundation 0.3.2, objc2-link-presentation 0.2.2, objc2-metal 0.2.2, objc2-quartz-core 0.2.2, objc2-symbols 0.2.2, objc2-ui-kit 0.2.2, objc2-uniform-type-identifiers 0.2.2, objc2-user-notifications 0.2.2, offset-allocator 0.2.0, oorandom 11.1.5, orbclient 0.3.55, ordered-float 5.5.0, pulp 0.22.3, pulp-wasm-simd-flag 0.1.1, quick-xml 0.41.0, raw-cpuid 11.6.0, reborrow 0.5.5, redox_syscall 0.4.1, redox_syscall 0.5.18, redox_syscall 0.9.4, sctk-adwaita 0.10.1, simd-adler32 0.3.10, slab 0.4.12, smithay-client-toolkit 0.19.2, smithay-client-toolkit 0.20.0, smithay-clipboard 0.7.3, spin 0.9.9, strict-num 0.1.1, tiff 0.11.3, tokio 1.53.2, tracing 0.1.44, tracing-core 0.1.36, urlencoding 2.1.3, wayland-backend 0.3.17, wayland-client 0.31.15, wayland-csd-frame 0.3.0, wayland-cursor 0.31.14, wayland-protocols 0.32.13, wayland-protocols-experimental 20250721.0.1, wayland-protocols-misc 0.3.12, wayland-protocols-plasma 0.3.12, wayland-protocols-wlr 0.3.12, wayland-scanner 0.31.11, wayland-sys 0.31.11, winnow 1.0.4, x11-dl 2.21.0, xcursor 0.3.11, xkbcommon-dl 0.4.2, zmij 1.0.23 |
| Apache-2.0 OR MIT | 42 | addr2line 0.25.1, alsa 0.11.0, atomic-waker 1.1.2, autocfg 1.5.1, bit-set 0.10.0, bit-vec 0.9.1, bit_field 0.10.3, cesu8 1.1.0, color 0.3.3, concurrent-queue 2.5.0, equivalent 1.0.2, fastrand 2.5.0, fearless_simd 0.4.1, fluent-bundle 0.16.0, fluent-langneg 0.13.1, fluent-syntax 0.12.0, fnv 1.0.7, gilrs 0.11.2, gilrs-core 0.6.8, glifo 0.2.0, indexmap 2.14.2, intl-memoizer 0.5.3, kurbo 0.13.1, linebender_resource_handle 0.1.1, minicov 0.3.8, nohash-hasher 0.2.0, noise 0.9.0, object 0.37.3, peniko 0.6.1, pin-project 1.1.13, pin-project-internal 1.1.13, pin-project-lite 0.2.17, polling 3.11.0, pollster 0.4.0, portable-atomic 1.15.0, portable-atomic-util 0.2.8, rustc-hash 1.1.0, rustc-hash 2.1.3, simd_cesu8 1.2.0, uuid 1.27.0, vello_common 0.1.0, vello_cpu 0.1.0 |
| Zlib OR Apache-2.0 OR MIT | 24 | bytemuck 1.25.2, bytemuck_derive 1.12.1, dispatch2 0.3.1, objc2-app-kit 0.3.2, objc2-audio-toolbox 0.3.2, objc2-avf-audio 0.3.2, objc2-cloud-kit 0.3.2, objc2-core-audio 0.3.2, objc2-core-audio-types 0.3.2, objc2-core-data 0.3.2, objc2-core-foundation 0.3.2, objc2-core-graphics 0.3.2, objc2-core-image 0.3.2, objc2-core-location 0.3.2, objc2-core-text 0.3.2, objc2-core-video 0.3.2, objc2-io-kit 0.3.2, objc2-io-surface 0.3.2, objc2-metal 0.3.2, objc2-quartz-core 0.3.2, objc2-ui-kit 0.3.2, objc2-user-notifications 0.3.2, safe_arch 1.2.0, wide 1.7.1 |
| Apache-2.0 | 16 | ab_glyph 0.2.32, ab_glyph_rasterizer 0.1.10, approx 0.5.1, codespan-reporting 0.13.1, cpal 0.18.2, gethostname 1.1.0, ktx2 0.5.0, nalgebra 0.35.0, nalgebra-macros 0.3.0, owned_ttf_parser 0.25.1, parry3d 0.31.1, rapier3d 0.36.0, simba 0.10.2, spirv 0.4.0+sdk-1.4.341.0, unicode-general-category 1.1.0, winit 0.30.13 |
| MPL-2.0 | 11 | symphonia 0.6.1, symphonia-bundle-flac 0.6.1, symphonia-bundle-mp3 0.6.1, symphonia-codec-pcm 0.6.1, symphonia-codec-vorbis 0.6.1, symphonia-common 0.6.1, symphonia-core 0.6.1, symphonia-format-ogg 0.6.1, symphonia-format-riff 0.6.1, symphonia-metadata 0.6.1, triple_buffer 9.0.0 |
| Unlicense OR MIT | 8 | aho-corasick 1.1.5, byteorder 1.5.0, byteorder-lite 0.1.0, memchr 2.8.3, same-file 1.0.6, termcolor 1.4.1, walkdir 2.5.0, winapi-util 0.1.11 |
| Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT | 6 | linux-raw-sys 0.12.1, linux-raw-sys 0.4.15, rustix 0.38.44, rustix 1.1.5, wasip2 1.0.4+wasi-0.2.12, wit-bindgen 0.57.1 |
| MIT OR Apache-2.0 OR Zlib | 6 | cursor-icon 1.2.0, raw-window-handle 0.6.2, xkeysym 0.2.1, zune-core 0.5.3, zune-inflate 0.2.54, zune-jpeg 0.5.15 |
| BSD-3-Clause | 4 | exr 1.74.2, lebe 0.5.3, tiny-skia 0.11.4, tiny-skia-path 0.11.4 |
| ISC | 3 | inotify 0.11.5, inotify-sys 0.1.8, libloading 0.8.9 |
| Apache-2.0/MIT | 4 | deprecate-until 1.0.0, integer-sqrt 0.1.5, intl_pluralrules 7.0.2, pathfinding 4.16.0 |
| Unicode-3.0 | 3 | tinystr 0.8.4, zerofrom 0.1.8, zerovec 0.11.8 |
| MIT/Apache-2.0 | 2 | fallible-iterator 0.3.0, rustc-demangle 0.1.28 |
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
| Zlib AND (MIT OR Apache-2.0) | 1 | bevy_mikktspace 1.0.0 |

### Vendored relay client (genex-multiplayer)

`native/genex-rust/crates/genex-multiplayer` is Genex's own relay protocol 3 client (MIT, first
party), copied unchanged from the genex-demo monorepo at commit 8cd1477a2
(`sdks/rust/genex-multiplayer`); its `PROVENANCE.toml` records every file's sha256, the one
manifest line changed (the upstream edition, 2021) and the one file added (`clippy.toml`). Its
native backend links the Colyseus native SDK 0.18.10 prebuilt (MIT), which bundles cJSON (MIT),
mbedTLS (Apache-2.0), wslay (MIT), sds (BSD-2-Clause) and uthash (BSD-1-Clause). The toolchain
store pins upstream's v0.18.10 release assets by sha256 (the `colyseus` component: the
xcframework, the Linux x86_64 tarball and the MinGW zip, laid out unchanged one folder per triple,
the universal Apple libraries thinned to arm64) and the source tarball (`colyseus-source`); only an
export of a `[net]` game links it, and no shipped build does yet. Its build script uses RustCrypto
sha2 (MIT OR Apache-2.0). Android's libcolyseus is built by the store from that source with zig
0.15.2 (MIT), whose standard library and compiler-rt are compiled into the library's Zig parts,
and with zig-msgpack (MIT, https://github.com/zigcc/zig-msgpack, commit
47c15d217efebd17a585dd04125f9b6b6f659d5a), pinned by sha256 beside the source.
`native/genex-rust/crates/genex-net/src/interp.rs` is a port of this crate's `src/interp.rs` and
`src/pose.rs` (MIT, first party) to sim time over libm; its header names the source.
A `[net]` game's web export serves the relay client's JS bridge instead: `bridge.global.js` of
`@genex-ai/multiplayer` 0.17.0 (MIT, first party), which bundles @colyseus/sdk and
@colyseus/schema (MIT) and @genex-ai/embed-sdk (MIT); the store pins the npm tarball by sha256
(the `genex-mp-bridge` component) and the web build copies the file only at its pinned sha256,
beside Genex's own shim (`src/main/mp-bridge-shim.ts`).

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
| `shaders/post/gtao.wgsl` (`gx_ao_bitmask`, `gx_ao_sample_sectors`, `gx_ao_hidden_arc`, `gx_ao_light_at`), `shaders/post/ao_denoise.wgsl` (the GI term) | The visibility bitmask and screen-space GI: 32 sectors a slice, each depth sample hiding the sectors between its front face and a point a constant thickness behind it; the sectors a sample hides first send the light the previous frame drew there (Genex weighs the sectors by XeGTAO's cosine-weighted arc, keeps the ratio estimator, takes the bent normal from the open run around the view vector and scales the thickness with the radius) | three.js r186 (https://github.com/mrdoob/three.js), `examples/jsm/tsl/display/SSGINode.js` (a port of SSRT3); Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/ssao/ssao.wesl` (`updateSectors`, `processSample`) | three.js authors; Bevy contributors; the method after Therrien, Levesque and Gilet 2023, "Screen Space Indirect Lighting with Visibility Bitmask" | MIT (three.js, see [Vendored three.js](#vendored-threejs)); MIT OR Apache-2.0, used under Apache 2.0 (Bevy) (see [Apache License 2.0](#apache-license-20)) |
| `shaders/lighting/ambient.wgsl` (`gx_caps_intersection`, `gx_specular_occlusion_bent`, `gx_ao_multibounce`) | Cone-cone specular occlusion from a bent normal and the multi-bounce AO fit | Filament (https://github.com/google/filament), `shaders/src/surface_ambient_occlusion.fs` (`sphericalCapsIntersection`, `specularAO_Cones`, `gtaoMultiBounce`) | The Android Open Source Project; the methods by Jimenez et al. 2016 and Oat and Sander 2007 | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/easu.wgsl`, `shaders/post/rcas.wgsl`, `src/post/fsr.rs` (the constants) | FSR1 upscaler: edge-adaptive spatial upsampling (EASU) with its 12-tap kernel, direction and length estimate, and robust contrast-adaptive sharpening (RCAS) with its per-channel lobe limiters | AMD FidelityFX Super Resolution 1.0 (https://github.com/GPUOpen-Effects/FidelityFX-FSR), `ffx-fsr/ffx_fsr1.h` (`FsrEasuCon`, `FsrEasuF`, `FsrRcasCon`, `FsrRcasF`) | Advanced Micro Devices, Inc. | MIT (see [FidelityFX FSR1](#fidelityfx-fsr1)) |
| `shaders/post/taa.wgsl` (`gx_taa_tonemap`, `gx_taa_inverse_tonemap`, `gx_taa_lightness`, `gx_taa_thin_feature`, `gx_taa_lock`, `gx_taa_instability`, the soft rectification), `src/post/taa.rs` (the constants) | TAA history protection: the reversible tonemap the colour box is built in, the thin-feature lock (lightness ridge and 2x2 rejection masks) with its lifetime and shading-change kill, the luma instability over four frames of quantised luma, the rectification undone by lock and instability and scaled by the reactive factor, and the temporal reactive factor of motion (Genex adapts the instability test, the shading luma and the lock trigger) | AMD FidelityFX SDK v1.1.4 (https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), FSR 2.2 `sdk/include/FidelityFX/gpu/fsr2/` (`ffx_fsr2_lock.h`, `ffx_fsr2_accumulate.h`, `ffx_fsr2_postprocess_lock_status.h`, `ffx_fsr2_common.h`) | Advanced Micro Devices, Inc. | MIT (see [FidelityFX SDK](#fidelityfx-sdk)) |
| `shaders/post/taau.wgsl` (`fs_taau_convert`, `fs_taau`, `gx_taau_reconstruct`, `gx_taau_lanczos2_sq`), `src/post/taau.rs` (`jitter_phases`, `kernel_bias`, `texture_lod_bias`, the constants) | TAA upscaling at output size: the two fragment passes (a render-size convert of dilated motion and a depth clip, then an output-size upscale of the nearest jittered sample and its four edge neighbours with a box clamp over the 3x3 and an accumulation capped under motion), FSR2's Lanczos-2 approximation from the squared distance with its deringing, its kernel bias and fresh-pixel bias (lerped by how far the box clip moved the history, as FSR2 lerps it by its reactive factor), its jitter phase count `ceil(8 · ratio²)` and its mip bias `log2(render / display) − 1` (Genex keeps its own depth-key disocclusion and luma weighting, carries the accumulated sample weight in the history's alpha, and sharpens the kernel by a third instead of running RCAS) | Snapdragon Game Super Resolution v2 (https://github.com/SnapdragonGameStudios/snapdragon-gsr), `sgsr/v2/include/glsl_2_pass_fs/sgsr2_convert.fs` and `sgsr2_upscale.fs`; AMD FidelityFX SDK v1.1.4 (https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK), FSR 2.2 `ffx_fsr2_upsample.h`, `ffx_fsr2_common.h` and its README | Qualcomm Innovation Center, Inc.; Advanced Micro Devices, Inc. | BSD-3-Clause (see [Snapdragon Game Super Resolution](#snapdragon-game-super-resolution)); MIT (see [FidelityFX SDK](#fidelityfx-sdk)) |
| `shaders/post/tonemap.wgsl` (`gx_tm_awp`, `gx_tm_agx_punchy`), `src/post/tonemap.rs` (`AgxCurve`, its CPU reference) | AgX punchy: the allenwp tonemapping curve with its CPU-computed toe, slope and shoulder, between the combined Rec. 709 -> Rec. 2020 -> AgX inset and outset matrices; Genex generalises the crossover's output | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/effects/tonemap.glsl` (`allenwp_curve`, `tonemap_agx`) and `servers/rendering/storage/environment_storage.cpp` (`environment_get_tonemap_parameters`) | Godot Engine contributors; the curve by Allen Pestaluky (allenwp); the matrices after EaryChow's Blender AgX | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/post/exposure_adapt.wgsl` (`gx_adapt_tick`, `gx_compensation`), `src/post/exposure.rs` (`adapt_tick`, `curve_compensation`), `src/settings.rs` (`CompensationCurve`) | Hybrid auto exposure adaptation (linear far from the target, exponential within a transition distance) and the exposure compensation curve over the metered EV | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_post_process/src/auto_exposure/auto_exposure.wesl` and `compensation_curve.rs` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `src/settings.rs` (`chromatic_adaptation` and its colour matrices) | White balance as a von Kries chromatic adaptation in CIECAT16 cone space from a temperature and tint, the white point moved along the daylight locus | Filament v1.78.0 (https://github.com/google/filament), `filament/src/details/ColorGrading.cpp` (`adaptationTransform`) and `filament/src/ColorSpaceUtils.h` | The Android Open Source Project | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/tonemap.wgsl` (`gx_grade`, `gx_grade_weights`, `gx_grade_lut`), `src/post/grading.rs` (`Grading::grade`, `tetrahedral`, their CPU twins) | Colour grading: per-section (shadows, midtones, highlights) saturation, contrast, gamma, gain and lift blended across the sections' margins; contrast in log space about middle grey and vibrance; a 3D LUT read with tetrahedral interpolation from four texel loads (Genex stores each texel's change from the identity and blends shadows into midtones where Bevy blends them into highlights) | Bevy 0.16.0 (https://github.com/bevyengine/bevy), `crates/bevy_core_pipeline/src/tonemapping/tonemapping_shared.wgsl` (`sectional_color_grading`); Filament v1.78.0 (https://github.com/google/filament), `filament/src/details/ColorGrading.cpp` (`contrast`, `vibrance`); pmndrs/postprocessing (https://github.com/pmndrs/postprocessing), `src/effects/glsl/lut-3d.frag` (`applyLUT`, tetrahedral) | Bevy contributors; The Android Open Source Project; Raoul van Rüschen | MIT OR Apache-2.0, used under Apache 2.0 (Bevy); Apache 2.0 (Filament) (see [Apache License 2.0](#apache-license-20)); Zlib (pmndrs/postprocessing, see [pmndrs/postprocessing](#pmndrspostprocessing)) |
| `shaders/ibl/sh9.wgsl` (`ibl_sh9_window`, the bisection after the reduction), `src/ibl.rs` (`sh9_window`, `sh9_dering_window`, their CPU twin) | Spherical-harmonic deringing: the sinc^4 window of bands 1 and 2 and the bisection for the weakest cutoff that keeps the reconstruction non-negative (Genex windows only an SH that rings) | Filament v1.78.0 (https://github.com/google/filament), `libs/ibl/src/CubemapSH.cpp` (`sincWindow`, `windowSH`) | The Android Open Source Project; the method by Peter-Pike Sloan ("Deringing Spherical Harmonics", 2017) | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/pbr.wgsl` (`gx_specular_energy`), `shaders/lighting/ambient.wgsl` (`gx_diffuse_normal`) | Multiple-scattering energy compensation of direct specular, `1 + f0 (1 / E - 1)` from the split-sum LUT; the diffuse environment light looked up along the bent normal | Filament v1.78.0 (https://github.com/google/filament), `shaders/src/surface_shading_lit.fs` (`energyCompensation`), `shaders/src/surface_light_indirect.fs` (`diffuseNormal`) | The Android Open Source Project | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/alpha_mask.wgsl` (`gx_alpha_hash2`, `gx_alpha_hash3`, `gx_alpha_hash_threshold`) | Hashed alpha testing: the hash and the two-scale, CDF-remapped alpha threshold (Genex turns it by the frame for TAA and compares the edge's sharpened coverage with it) | three.js 0.185.1, `src/renderers/shaders/ShaderChunk/alphahash_pars_fragment.glsl.js` (`hash2D`, `hash3D`, `getAlphaHashThreshold`) | three.js authors, after Wyman and McGuire 2017, "Hashed Alpha Testing" | MIT (three.js, see [Vendored three.js](#vendored-threejs)) |
| `shaders/post/sun_mask_denoise.wgsl` (`fs_sun_mask_temporal`, `gx_mask_history`, `gx_mask_depth_tolerance`, `gx_mask_alpha`, `gx_mask_input`, `gx_mask_atrous`), `src/post/sun_mask.rs` (the constants) | The sun-shadow screen mask's denoise: temporal reprojection with the view-alignment-scaled disocclusion test, the neighbourhood clamp, the sample-count damper, the variance boost of a young history and the accumulation schedule; the 3x3 a-trous kernel with the shadow edge-stopping weight (Genex ports it to fragment passes without wave intrinsics or tile bitmasks, for a continuous PCSS visibility: one filter step instead of three, a depth weight instead of the normal's, and the shadow weight over the variance of the accumulated estimate) | AMD FidelityFX Denoiser (https://github.com/GPUOpen-Effects/FidelityFX-Denoiser), `ffx-shadows-dnsr/ffx_denoiser_shadows_tileclassification.h` and `ffx_denoiser_shadows_filter.h` | Advanced Micro Devices, Inc. | MIT (see [FidelityFX Denoiser](#fidelityfx-denoiser)) |
| `shaders/pbr.wgsl` (`gx_sun_area_direction`) | The sun as a disc for specular: the direction inside the sun's disc closest to the mirror direction | Filament v1.77.3 (https://github.com/google/filament), `shaders/src/surface_light_directional.fs` (`sampleSunAreaLight`) | The Android Open Source Project | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/lighting/subsurface.wgsl` (`gx_subsurface_sun`) | Subsurface scattering: the wrapped back-scatter lobe mixed toward a forward-scatter lobe about the view-to-light axis (a spherical-gaussian `exp2` for `pow`), times one minus the thickness, in the subsurface colour; and diffuse transmission as a Lambert lobe about the back of the surface in the base colour (Genex lights both through one shadow-map gather that measures the distance the light crosses inside the material) | Filament v1.77.3 (https://github.com/google/filament), `shaders/src/surface_shading_model_subsurface.fs` (`surfaceShading`); Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/render/pbr_functions.wesl` (diffuse transmission) | The Android Open Source Project; Bevy contributors | Apache 2.0 (Filament); MIT OR Apache-2.0, used under Apache 2.0 (Bevy) (see [Apache License 2.0](#apache-license-20)) |
| `shaders/post/contact_shadow.wgsl` (`gx_contact_edge_fade`, `gx_contact_soft_hit`, the screen-space step count and the per-step tolerance) | Contact shadows: the occlusion faded out across the screen's outer twelfth, the thickness at least the ray's change in view distance per step; the steps set by the depth texels the ray spans on the screen and the soft hit over the back half of the thickness | Filament v1.77.3 (https://github.com/google/filament), `shaders/src/surface_shadowing.fs` (`screenSpaceContactShadow`); Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/ssr/raymarch.wesl` (`depth_ray_march_march`) and `crates/bevy_pbr/src/render/pbr_functions.wesl` (`calculate_contact_shadow`) | The Android Open Source Project; Tomasz Stachowiak and Bevy contributors | Apache 2.0 (Filament); MIT OR Apache-2.0, used under Apache 2.0 (Bevy) (see [Apache License 2.0](#apache-license-20)) |
| `shaders/screen/ssr_march.wgsl` (`gx_ssr_march_run`, `gx_ssr_march_clip`, `gx_ssr_sample`, `gx_ssr_edge_fade`) and its CPU twin `src/screen_inputs.rs` (`march`) | The screen-space ray march shared by water and screen-space reflections: the ray clipped to the view frustum, a linear march over the pixels it crosses, bisection and a secant step, each sample compared against the bilinear and the nearest depth; the screen-edge fade | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/ssr/raymarch.wesl` (a port of h3r2tic's `raymarch.hlsl`); Filament v1.77.3 (https://github.com/google/filament), `shaders/src/surface_shadowing.fs` (the edge fade) | Tomasz Stachowiak and Bevy contributors; The Android Open Source Project | MIT OR Apache-2.0, used under Apache 2.0 (Bevy); Apache 2.0 (Filament) (see [Apache License 2.0](#apache-license-20)) |
| `shaders/screen/ssr_trace.wgsl` (`cs_ssr_trace`, `ssr_walk`, `ssr_validity`, `ssr_geometric_normal`, `ssr_mip`), `shaders/screen/ssr_resolve.wgsl` (`cs_ssr_resolve`) and their CPU twin `src/ssr.rs` (`twin`); the lake's reflection mip `shaders/water/water_reflect.wgsl` (`gx_water_screen_mip`) and its twin `src/water/reflect.rs` (`screen_mip`) | Hi-Z screen-space reflections: the trace at half the render size down a nearest-depth Hi-Z with parametric t, the geometric-normal bias against self intersection, the hit validated by its depth, its facing and the screen margin, the roughness cone's blur as a colour-pyramid mip, and the bilateral upsample by depth, normal and roughness (Genex takes uniforms for push constants, samples the previous frame's colour pyramid at the cone's mip instead of writing an `r8` mip image and filtering, supports either depth convention and fades a long ray out by a smoothstep) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/effects/screen_space_reflection.glsl`, `screen_space_reflection_hiz.glsl` and `screen_space_reflection_resolve.glsl` | Godot Engine contributors; the hit validation after AMD FidelityFX SSSR, parametric t after hacksoflife (2020) | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/forward_env.wgsl` (`gx_probe_parallax`), `shaders/water/water_reflect.wgsl` (`gx_water_probe_parallax`, the water's copy), `src/probes.rs` (`parallax_direction`) | Reflection probes' box projection: where a reflected ray leaves the probe's box, seen from its capture point, with the largest float standing in for an axis the ray never leaves (WGSL has no infinity); Genex projects onto the box grown by the probe's fade and eases the projection in with the probe's weight | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/light_probe/environment_map.wesl` (`compute_cubemap_sample_dir`) | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/forward_env.wgsl` (`gx_volume_irradiance`), `src/irradiance.rs` (`atlas_texel`, `ambient_irradiance`, `grid_irradiance`) | Irradiance volumes' ambient-cube packing and lookup: each cell's six axis-direction texels in an `X x 2Y x 3Z` block (the negative directions in the upper half of y, the axes in thirds of z), the three faces toward the normal read with the sampler's trilinear filter inside their sub-block and weighted by the normal's squared components (Genex packs every volume's block into one atlas, offsets the lookup along the normal, moves it toward the cells that see the point by their reaches and bakes the cells in the scene on the GPU) | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_pbr/src/light_probe/irradiance_volume.wesl` (`irradiance_volume_light`) and `crates/bevy_pbr/src/light_probe/irradiance_volume.rs` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/lighting/decals.wgsl` (`gx_decals`, `gx_decal_fade`), `src/decals.rs` (`Decal::to_gpu`) | Clustered decals: each decal a box binned like the lights, the fragment's position taken into the box by its world-to-decal transform, its maps sampled at the gradients of that position, faded towards the box's upper and lower faces and on surfaces turned from its face, and blended into the surface's colour, normal, roughness, metallic and occlusion before lighting (Genex keeps the rows in the light-extension table, samples the material size-class arrays at one level per decal and blends overlapping decals order-independently) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/forward_clustered/scene_forward_clustered.glsl` (the decal loop) and `servers/rendering/renderer_rd/shaders/decal_data_inc.glsl` | Godot Engine contributors | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/part2/particles_draw.wgsl` (`particle_soft`) | Soft particles: the gap between the opaque scene's view depth and the fragment's in world units over the fade distance, through the white paper's symmetric contrast curve of power 2 (Genex reads the view depth at half size, filtered by hand) | three.js r186 (https://github.com/mrdoob/three.js), `examples/jsm/tsl/utils/SoftParticles.js` (`softParticles`, `contrastCurve`) | three.js authors; the method after Tristan Lorach, "Soft Particles" (NVIDIA, 2007) | MIT (three.js, see [Vendored three.js](#vendored-threejs)) |
| `shaders/part2/particles_sort.wgsl` (`cs_sort_block`, `cs_sort_step`, `cs_sort_inner`), `src/particles.rs` (`sort_steps`, `sort_plan`) | The particles' bitonic sort: each block of pairs sorted in workgroup memory, then for every larger merge its global steps (a mirrored "flip" first, so a count that is not a power of two needs no padding) and the rest of the merge in workgroup memory (Genex sorts (view depth, slot) pairs so ties break by slot, holds 2048 pairs a block where Godot holds 512, and sorts every sorted emitter of a frame in the same dispatches) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/effects/sort.glsl`, itself AMD GPUParticles11 (https://github.com/GPUOpen-LibrariesAndSDKs/GPUParticles11) | Advanced Micro Devices, Inc.; Godot Engine contributors | MIT (see [GPUParticles11](#gpuparticles11) and [Godot Engine](#godot-engine)) |
| `shaders/post/dof_prepare.wgsl`, `shaders/post/dof_ring.wgsl`, `shaders/post/dof_combine.wgsl` (`fs_dof_combine`), `shaders/post/dof_common.wgsl` (`dof_coc`, `dof_coc_to_alpha`, the tile tests), `src/post/dof.rs` (`CocParams`) | Gather depth of field, ring tier: the circle of confusion as a madd on the depth buffer, the half-resolution downsample keeping the smallest CoC, its mips, the min/max CoC tiles and their dilation, the ring gather with foreground (two layers) and background (ring-occlusion merge) buckets and a fast path, the 3x3 median network and the combine (Genex keeps the colour's plain mean, reduces the tiles in two passes, leaves in-focus texels out of the median and does not jitter the gather by a noise) | Filament v1.77.3 (https://github.com/google/filament), `filament/src/materials/dof/` (`dof.mat`, `dofDownsample.mat`, `dofMipmap.mat`, `dofTiles.mat`, `dofDilate.mat`, `dofMedian.mat`, `dofCombine.mat`, `dofUtils.fs`) and `filament/src/PostProcessManager.cpp` (`PostProcessManager::dof`) | The Android Open Source Project; the methods after Jimenez (SIGGRAPH 2014), Abadie ("Life of a Bokeh", SIGGRAPH 2018) and McGuire ("A Fast, Small-Radius GPU Median Filter", 2008) | Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `shaders/sky/froxel_fog.wgsl` (`cs_froxel_inject`, `cs_froxel_integrate`), `src/froxel.rs` (`HALTON`, `HISTORY_WEIGHT`, `integrate_column`, its CPU twin) | Froxel volumetric fog: each froxel's density and light (the directional light's single shadow tap, the clustered local lights through a Henyey-Greenstein phase) blended with the last frame's volume at a Halton jitter, and the front-to-back, energy-conserving scan of each column (Genex slices the rays logarithmically out to the aerial perspective's range, takes each slice's extinction from the height fog's closed form, holds the fog's largest opacity and folds the aerial perspective in behind the fog) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/environment/volumetric_fog_process.glsl` (`MODE_DENSITY`, `MODE_FOG`, `halton_map`) | Godot Engine contributors; the method after Bart Wronski (2014) and Sébastien Hillaire (2015) | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/sky/clouds.wgsl` (`cloud_march`, `cloud_density`, `cloud_scattering`, `cloud_light_depth`), `shaders/sky/cloud_noise.wgsl` (`noise_worley`, `noise_perlin`, `cs_cloud_shape`, `cs_cloud_detail`, `cs_cloud_weather`), `src/clouds.rs` | The cloud panorama: a weather field's coverage, a cumulus height profile, the Perlin-Worley shape remapped by its Worley fbm and eroded by a Worley detail volume, a march towards the sun, Wrenninge's multiple-scattering octaves over a dual-lobe Henyey-Greenstein phase with a powder term, and the tileable Worley and Perlin noise those volumes are made of (Genex marches into a sky panorama amortised over frames instead of a screen-space pass, starts each texel's march at a fixed interleaved gradient noise instead of the STBN texture, which it does not ship, lights the clouds with its own transmittance and sky-view LUTs and makes the noise once on the GPU) | takram three-geospatial `@takram/three-clouds` 0.7.6 (https://github.com/takram-design-engineering/three-geospatial), `packages/clouds/src/shaders/clouds.frag` (ideas and structure); sebh TileableVolumeNoise (https://github.com/sebh/TileableVolumeNoise), as the clouds package carries it | Shota Matsuda; Sébastien Hillaire | MIT (see [three-geospatial clouds](#three-geospatial-clouds)) |
| `shaders/post/dof_circular.wgsl`, `shaders/post/dof_combine.wgsl` (`fs_dof_composite`) | Gather depth of field, circular tier: the single-pass golden-angle gather whose samples behind the centre are limited by its CoC, and the composite by the pixel's or the gathered CoC (Genex bounds the spiral by the tile's CoC and a sample budget and upsamples by CoC likeness) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `servers/rendering/renderer_rd/shaders/effects/bokeh_dof_raster.glsl` (`MODE_BOKEH_CIRCULAR`, `MODE_COMPOSITE_BOKEH`) | Godot Engine contributors; the method after Tuxedo Labs ("Bokeh depth of field in a single pass", 2018) | MIT (see [Godot Engine](#godot-engine)) |
| `shaders/post/motion_blur_common.wgsl` (`mb_velocity`, `mb_vmax`), `shaders/post/motion_blur_tiles.wgsl`, `shaders/post/motion_blur.wgsl` (`fs_mb_reconstruct`), `src/post/motion_blur.rs` (`MAX_BLUR_HEIGHT_SHARE`, `depth_row`) | Motion blur, reconstruction tier: half the exposure vector in pixels clamped to the largest radius, the longest velocity of each tile and of its 3x3 neighbourhood (centre favoured by 1%), the tile lookup jittered by a quarter tile, and the gather along the neighbourhood's and the pixel's velocities with its depth-softened foreground and background weights, triangular window and centre weight (Genex reduces the tiles in a compute pass, spaces samples a pixel apart without per-pixel noise and reads whole texels) | keijiro/KinoMotion (https://github.com/keijiro/KinoMotion), `Assets/Kino/Motion/Shader/Prefilter.cginc` (`frag_VelocitySetup`, `frag_TileMax*`, `frag_NeighborMax`), `Reconstruction.cginc` (`frag_Reconstruction`, `JitterTile`) and `Common.cginc` (`LinearizeDepth`) | Keijiro Takahashi; the method after McGuire, Hennessy, Bukowski and Osman ("A Reconstruction Filter for Plausible Motion Blur", I3D 2012) | MIT (see [KinoMotion](#kinomotion)) |
| `shaders/post/motion_blur.wgsl` (`fs_mb_direct`) | Motion blur, direct tier: samples along the pixel's own exposure vector, a nearer sample kept only where its own motion along that direction reaches the pixel, the scene kept below a pixel of motion (Genex compares the sample's exposure with the pixel's, spaces samples a pixel apart without noise and reads whole texels) | Bevy 0.20.0 (https://github.com/bevyengine/bevy), `crates/bevy_post_process/src/motion_blur/motion_blur.wesl` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `src/terrain/mod.rs` (`TerrainTree::select`, `TerrainLod`, `TerrainTree::vertex`), `shaders/terrain/terrain_core.wgsl` (`gx_terrain_morph_k`, `gx_terrain_vertex`) | Continuous distance-dependent level of detail for heightmap terrain: the quadtree selection by distance ranges with partial (quarter) nodes, the morph constants and the vertex morph of odd grid vertices onto their even neighbours (Genex selects on the CPU without a frustum and culls per view, floors the ranges so no node is two levels from a neighbour, reads 16-bit heights from a storage table and samples integer positions exactly) | CDLOD (https://github.com/fstrugar/CDLOD), `source/BasicCDLOD/CDLODQuadTree.cpp` (`LODSelect`), `CDLODRenderer.cpp` and the shader's `morphVertex` | Filip Strugar | MIT (see [CDLOD](#cdlod)) |
| `shaders/terrain/hextile.wgsl` | Hex-tiling: the triangle grid of hexagons, each tile's rotation and offset, its centre, and the luminance-weighted blend of the three tiles' samples (Genex hashes the vertex ids with integers instead of `sin`, shares the tiles between a layer's colour and data textures and turns the data texture's normal back onto the surface) | mmikk/hextile-demo (https://github.com/mmikk/hextile-demo), `hextile-demo/hextiling.h` (`TriangleGrid`, `hash`, `MakeCenST`, `LoadRot2x2`, `hex2colTex`) | Morten S. Mikkelsen ("Practical Real-Time Hex-Tiling", JCGT 11(2) 2022) | MIT (see [hextile-demo](#hextile-demo)) |
| `src/impostor/mod.rs` (`encode`, `decode`, `frame_direction`, `frame_axes`, `ImpostorBounds::of_points`), `src/impostor/bake.rs` (`ImpostorBaker`), `shaders/impostor/pack.wgsl`, `shaders/impostor/mip.wgsl`, `shaders/impostor/draw.wgsl` and `src/impostor/draw.rs` (the impostor draw) | Octahedral and hemi-octahedral impostors: the frame grid's encode and decode, the bake cameras' axes, the orthographic per-frame bake at a supersampled size, the pack compute (coverage, averages over covered render texels, the normal from the depth's slope where none was written, the dilation of empty texels) and the coverage-weighted mip compute. Genex adds a third atlas (occlusion, metallic, transmission, class), octahedrally encoded normals, the forward pass's own material evaluation in the bake fragment, texture-array layers per species, and coverage-preserving mips (Castano's rule) where kansei averages plainly; the draw: the camera-facing quad clamped to the projected box, the three nearest frames' barycentric blend with the view ray's reprojection to the stored depth; Genex adds texture-array atlases, three parallax steps, sharpened surface weights, the forward pass's lighting, motion vectors from the reconstructed point and frag_depth on desktop high and ultra | kansei (https://github.com/Siroko/kansei) at its 2026-10-18 head, `rust/kansei-core/src/impostors/{mod,bake}.rs`, `rust/kansei-core/src/shaders/impostor_pack.wgsl`, `impostor_mip.wgsl`, `rust/kansei-core/src/shaders/impostor.wgsl` (commit 1e3bddb8) | Felix Martinez | MIT (see [kansei](#kansei)) |

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

### Snapdragon Game Super Resolution

The licence of the Qualcomm Snapdragon Game Super Resolution v2 code the TAA upscale ports (table
above).

```
Copyright (c) 2023, Qualcomm Innovation Center, Inc. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.

SPDX-License-Identifier: BSD-3-Clause
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

### GPUParticles11

The licence of AMD's GPUParticles11 sort, which Godot Engine carries, that the particles' bitonic
sort ports (table above).

```
Copyright (c) 2016 Advanced Micro Devices, Inc. All rights reserved.

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

The licence of the Godot Engine code the AgX punchy tonemap, the circular depth of field, the clustered decals, the froxel volumetric fog, the particles' bitonic sort and the Hi-Z screen-space reflections port (table above), the animation state machine's rules and the input's stick dead zone.

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

### three-geospatial clouds

The licence of the takram three-geospatial clouds package and the TileableVolumeNoise code it carries, which the cloud panorama follows (table above).

```
Copyright (c) 2024 Shota Matsuda
Copyright (c) 2017 Sébastien Hillaire

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

### kansei

MIT License

Copyright (c) 2024 Felix Martinez

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

## Rust game systems ports

The game systems crates (`native/genex-rust/crates/genex-anim`, `genex-audio`, `genex-input`, `genex-nav`, `genex-profile`, `genex-stream`,
`genex-ui`, the web crash hook of `genex-platform-web` and the mesh arena and terrain tile atlas of `genex-render`, the runtime LOD simplifier of `genex-render`, the fast hasher of `genex-core`, Genex's own code, MIT) port this code or these rules. They ship inside every
Rust game that links the crate, and in its ejected source. Each file credits its source in a
comment; each Apache 2.0 port carries the upstream notice and lists Genex's changes (§4(b)).

| Genex file | What | Source | Upstream authors | Licence |
| --- | --- | --- | --- | --- |
| `crates/genex-anim/src/skeleton.rs` (`Skeleton`, `Skeleton::local_to_model`) | Joints sorted parent-first once at load, so local-to-model is one allocation-free pass over caller scratch | ozz-animation 0.17.0 (https://github.com/guillaumeblanc/ozz-animation), `include/ozz/animation/runtime/skeleton.h`, `src/animation/runtime/local_to_model_job.cc` | Guillaume Blanc | MIT (see [ozz-animation](#ozz-animation)) |
| `crates/genex-anim/src/sample.rs` (`SampleCursor`) | One key position per track remembered between sampling calls, so a tick forward or backward costs a step or two instead of a search | ozz-animation 0.17.0, `include/ozz/animation/runtime/sampling_job.h`, `src/animation/runtime/sampling_job.cc` (`SamplingJob::Context`) | Guillaume Blanc | MIT (see [ozz-animation](#ozz-animation)) |
| `crates/genex-anim/src/sample.rs` (cubic segments) | Evaluating a glTF cubic-spline segment with the tangents scaled by the key span and the rotation normalized afterwards (the rule only; no code was copied) | Bevy 0.20 (https://github.com/bevyengine/bevy), `crates/bevy_animation/src/gltf_curves.rs` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-anim/src/blend.rs` (`Blender::blend`, `apply_additive`, `additive_delta`) | The normalized pose blend (weighted sums, rotations kept in one hemisphere and normalized, the rest pose filling in under a weight threshold) and additive layers applied as `base × delta` (ozz 0.15's multiplication order); Genex copies a joint one layer alone drives and adds a Unity-style override | ozz-animation 0.17.0 (https://github.com/guillaumeblanc/ozz-animation), `src/animation/runtime/blending_job.cc` | Guillaume Blanc | MIT (see [ozz-animation](#ozz-animation)) |
| `crates/genex-anim/src/mask.rs` (`JointMask::subtrees`) | Per-joint layer weights (ozz) named by subtree roots, a joint inherits its parent's membership (the rule only; no Bevy code was copied) | ozz-animation 0.17.0, `include/ozz/animation/runtime/blending_job.h` (`joint_weights`); Bevy (https://github.com/bevyengine/bevy), `crates/bevy_animation/src/graph.rs` (`AnimationMask`, mask groups) | Guillaume Blanc; Bevy contributors | MIT (see [ozz-animation](#ozz-animation)); MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-anim/src/humanoid.rs` (`HumanoidBone`), `tests/fixtures/humanoid-aliases.json` | The humanoid profile's bone names and order (22 of them) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `scene/resources/skeleton_profile.cpp` (`SkeletonProfileHumanoid`) | Godot Engine contributors | MIT (see [Godot Engine](#godot-engine)) |
| `crates/genex-anim/src/graph.rs` (`AnimGraphBuilder`, `AnimGraph`), `src/machine.rs` (`Machine::step`) | The layered state machine: each layer with its own states, weight and mask, transitions within a layer, conditions built from parameters with and/or/not, and the per-layer update order (advance, then try the transitions). Only the structure and rules were taken; no code was copied. Genex adds priorities, any-state transitions, synced switches and interruptible blends | Fyrox 1.0.1 (https://github.com/FyroxEngine/Fyrox), `fyrox-animation/src/machine/{layer,state,transition,parameter}.rs` | Dmitry Stepanov and Fyrox Engine contributors | MIT (see [Fyrox](#fyrox)) |
| `crates/genex-anim/src/ragdoll.rs` (`Ragdoll::follow`, `Ragdoll::go_limp`) | The ragdoll sync: while animated, each limb body is kinematic and follows its bone; once limp, it is dynamic, seeded with a velocity on the activation tick, and the bone follows the body; a partial ragdoll is a limb subtree. The logic only; no code was copied. Genex generates the joints from the skeleton's rest pose and a humanoid profile, and adds powered bodies and recovery | Fyrox 1.0.1 (https://github.com/FyroxEngine/Fyrox), `fyrox-impl/src/scene/ragdoll.rs` | Dmitry Stepanov and Fyrox Engine contributors | MIT (see [Fyrox](#fyrox)) |
| `crates/genex-anim/src/graph.rs` (`TransitionBuilder::{priority, at_end, synced}`), `src/params.rs` (triggers) | Transition priorities, `AtEnd` and `Sync` switch modes, any-state transitions and one-shot requests consumed by the transition that takes them (the rules only; no code was copied) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `scene/animation/animation_node_state_machine.cpp` | Godot Engine contributors | MIT (see [Godot Engine](#godot-engine)) |
| `crates/genex-anim/src/compact.rs` (`compact`, `CompactClip`) | Clip compaction: per-track key reduction against a model-space error measured at the joint's hierarchy radius (at least a 0.1 m skin distance), constant-track removal, smallest-three 16-bit rotations and 16-bit range-quantized translations and scales. Only the method was taken; no code was copied. Genex adds a whole-skeleton error check with tolerance halving and shared time-table indices | ozz-animation 0.17.0 (https://github.com/guillaumeblanc/ozz-animation), `src/animation/offline/animation_optimizer.cc`, `src/animation/runtime/animation_keyframe.h`, `src/animation/offline/animation_builder.cc` | Guillaume Blanc | MIT (see [ozz-animation](#ozz-animation)) |
| `crates/genex-anim/src/inertial.rs` (`InertialOffset`, `decay_spring`, `fast_negexp`, `halflife_to_damping`, `fade_velocities`) | Inertialized transitions: the offset from the next pose to the visible one, with its velocity, decayed by a critically damped spring of a given half-life and added onto the next pose; Holden's rational `exp(-x)`; dead blending's fading velocity (Genex keeps rotation offsets as scaled axes in the parent's frame, takes the next pose's velocity at the switch as zero, clears an offset under 1e-4 and refuses non-finite parts) | Spring-It-On (https://github.com/orangeduck/Spring-It-On, commit 4d97b497), `common.h` (`fast_negexp`, `halflife_to_damping`, `damper_decay_exact`), `springdamper.c`, `inertialization.c`, `deadblending.c`; Motion-Matching (https://github.com/orangeduck/Motion-Matching, commit 57b7250e), `controller.cpp`, `spring.h` | Daniel Holden | MIT (see [Spring-It-On and Motion-Matching](#spring-it-on-and-motion-matching)) |
| `crates/genex-anim/src/transition.rs` (`TransitionPlayer`) | What a layer shows across switches: a linear crossfade of the left and next states, an inertialized switch taking its offset from the visible pose, and an interrupted crossfade that starts from the frozen visible pose carried on by a fading velocity (the crossfade rule is Godot's xfade, the rule only; dead blending after Holden) | Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `scene/animation/animation_node_state_machine.cpp` (xfade); Spring-It-On, `deadblending.c` | Godot Engine contributors; Daniel Holden | MIT (see [Godot Engine](#godot-engine) and [Spring-It-On and Motion-Matching](#spring-it-on-and-motion-matching)) |
| `crates/genex-anim/src/ik.rs` (`solve_two_bone`, `solve_aim`, `apply_two_bone`, `apply_look_at`) | Two-bone IK (the mid angle by the law of cosines, the start joint turned onto the target, then about the target axis toward the pole, an optional twist, softening near full reach, the weight as an nlerp from identity) and aim IK (a forward ray from an offset point turned through the target, up kept toward a pole). Changed: half-angle quaternions over `sqrt` instead of `acos`; a bent chain bends in its own plane (bevy_animation_graph's pole inference, the rule only) and `mid_axis` serves a straight one; Genex's own softening curve `1 - (4 / (r + 4))^4`; every degenerate input solves to no correction; a look-at chain split by share, base first | ozz-animation 0.17.0 (https://github.com/guillaumeblanc/ozz-animation), `src/animation/runtime/ik_two_bone_job.cc`, `src/animation/runtime/ik_aim_job.cc`, `samples/look_at/sample_look_at.cc`; bevy_animation_graph (https://github.com/mbrea-c/bevy_animation_graph), `twoboneik_node.rs` | Guillaume Blanc; bevy_animation_graph contributors | MIT (see [ozz-animation](#ozz-animation)); bevy_animation_graph MIT OR Apache-2.0, the rule only, no code copied |
| `crates/genex-anim/src/root_motion.rs` (`extract`, `MotionTrack::delta`, `blend`) | Root motion: the root joint's ground-plane travel and yaw taken out of a clip at load into a motion track and baked out of the root's keys, the per-tick delta read across a loop's wrap as the rest of the cycle plus the start of the next, and deltas blended by weight (the rules only; no code was copied). Genex adds the in-place flag, the swing-twist yaw unwrapped over a 60 Hz grid joined with the root's keys, and deltas in character space at the tick's start | ozz-animation 0.17.0 (https://github.com/guillaumeblanc/ozz-animation), `include/ozz/animation/offline/motion_extractor.h`, `src/animation/runtime/motion_blending_job.cc`; Godot Engine 4.7.2-stable (https://github.com/godotengine/godot), `scene/animation/animation_mixer.cpp` (root motion accumulation) | Guillaume Blanc; Godot Engine contributors | MIT (see [ozz-animation](#ozz-animation) and [Godot Engine](#godot-engine)) |
| `crates/genex-anim/src/evaluate.rs` (`compose`) | The evaluation order: sample, blend, layers, local-to-model, then IK as modifiers parent before child (legs, arms, look-at) (the order only; no code was copied) | ozz-animation 0.17.0, `samples/` job chains; Godot Engine 4.7.2-stable, `scene/3d/skeleton_modifier_3d.cpp` | Guillaume Blanc; Godot Engine contributors | MIT (see [ozz-animation](#ozz-animation) and [Godot Engine](#godot-engine)) |
| `crates/genex-anim/src/foot.rs` (`FootPlacer::plant`, the foot lock) | Foot locking. A foot locks where it stands when its contact turns on and holds that world point while locked. It lets go when the contact lifts or when the animated foot moves past an unlock radius. Each switch is inertialized: the offset from source to destination, with the velocities, decays by a critically damped spring. Genex adds the slope rule, the pelvis drop and the clamped foot tilt | Motion-Matching (https://github.com/orangeduck/Motion-Matching), `controller.cpp` (`contact_update`) | Daniel Holden | MIT (see [Spring-It-On and Motion-Matching](#spring-it-on-and-motion-matching)) |
| `crates/genex-anim/src/retarget.rs` (`Retargeter`) | Humanoid retargeting through a bone profile, with the target's rest normalized onto the source's silhouette ("Fix Silhouette"). Each bone takes the source bone's model-space turn from rest, applied to the normalized target rest. Only the rule was taken; no code was copied | Godot Engine 4.x skeleton retargeting (https://docs.godotengine.org/en/4.6/tutorials/assets_pipeline/retargeting_3d_skeletons.html) | Godot Engine contributors | MIT (see [Godot Engine](#godot-engine)) |
| `crates/genex-stream/src/residency.rs` (`Residency`, `ResidencyLimits`) | The residency policy: per-requester reference counts, an unload queue of unreferenced entries in release order, drained while resident bytes exceed a byte cap under a time limit, a cap on loads in flight, and `forbidHoles` (keep the coarser parent until every wanted child is resident) | cesium-native (https://github.com/CesiumGS/cesium-native), `Cesium3DTilesSelection/src/TilesetContentManager.cpp` (`unloadCachedTiles`, the tile reference counts and the unload list) and `Cesium3DTilesSelection/include/Cesium3DTilesSelection/TilesetOptions.h` (`maximumCachedBytes`, `maximumSimultaneousTileLoads`, `tileCacheUnloadTimeLimit`, `forbidHoles`) | CesiumGS, Inc. and Contributors | Apache 2.0 (see [Apache License 2.0](#apache-license-20); cesium-native ships no NOTICE file) |
| `crates/genex-render/src/mesh_arena.rs` (`MeshArena::grow`, `move_to`) | Growing a full GPU buffer by remaking it twice as large and copying its live prefix buffer to buffer (the rule only; no code was copied) | Bevy (https://github.com/bevyengine/bevy), `crates/bevy_render/src/slab_allocator.rs` | Bevy contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-render/src/terrain/atlas.rs` (`TileAtlas`, `TileAtlas::best_tile`) | The terrain tile atlas: a request count per tile, released tiles kept in their slots with the slots queued oldest-first and revived on a re-request, a new tile taking the front slot, and the walk up the parents to the nearest loaded tile. Changed (listed in the file's header): slot exhaustion refuses `stream-arena-full` instead of panicking, a completion for a tile that is not loading is dropped, a `BTreeMap` instead of hashing, no file IO or Bevy resources, slots sized by form factor and the 128 MiB binding | bevy_terrain (https://github.com/kurtkuehnert/bevy_terrain), `src/terrain_data/tile_atlas.rs` (`TileAtlasState`) | Kurt Kühnert | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-render/src/mesh_lod_runtime.rs` (`simplify`, `simplify_levels`) | Runtime LOD chains (game systems LOD-21): edge-collapse simplification on position quadrics (triangle planes weighted by the square root of their area, border and seam edge planes), vertices classed manifold, border, seam or locked, collapses ranked by quadric error and applied in passes that move no vertex twice, and the triangle-flip check. Genex's port from the algorithm; it leaves out attribute quadrics, the complex class, `Prune`, `ErrorClamped` and `PreserveFolds`, sorts collapses exactly, stops a level within 1/32 of its target and carries one run from level to level | meshoptimizer (https://github.com/zeux/meshoptimizer), `src/simplifier.cpp` | Arseny Kapoulkine | MIT (see [meshoptimizer](#meshoptimizer)) |
| `crates/genex-core/src/map.rs` (`FastHasher`) | The Fx hash for engine lookup tables: each word rotated left by 5, xored in and multiplied by a fixed seed, with no per-process key. Changed (listed in the file): byte strings are hashed 8 bytes at a time, little-endian, then byte by byte | rustc-hash 1.1.0 (https://github.com/rust-lang/rustc-hash), `src/lib.rs` (`FxHasher`) | The Rust Project Developers | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-profile/src/gpu_lane.rs` (`GpuLane::spans`) | GPU query results laid out as begin/end spans with depth, stream range and scope count (sequential node brackets; not registered with puffin's global profiler) | wgpu-profiler 0.28.0 (https://github.com/Wumpf/wgpu-profiler), `src/puffin.rs` (`collect_stream_info_recursive`) | Andreas Reich and wgpu-profiler contributors | MIT OR Apache-2.0, used under MIT (see [wgpu-profiler](#wgpu-profiler)) |
| `crates/genex-profile/src/trace.rs` (`chrome_trace`) | Chrome trace JSON: a `traceEvents` array of `X` events with microsecond `ts` and `dur`, one `tid` per lane (written with serde_json, frames laid out by interval) | wgpu-profiler 0.28.0, `src/chrometrace.rs` | Andreas Reich and wgpu-profiler contributors | MIT OR Apache-2.0, used under MIT (see [wgpu-profiler](#wgpu-profiler)) |
| `crates/genex-nav/src/runtime/dodgy/` (every file, with dodgy's own tests as `*_test.rs`) | ORCA local avoidance: velocity obstacles from neighbours and polygon obstacles, the 2D and 3D linear programs, the visibility set. Changed (§4(b), listed in `dodgy/mod.rs`): the `rand` direction for two agents on one spot is hashed from their keys, `Simulator::step` has no `HashMap` and keeps its near neighbours, visible line ids come back sorted, angles use libm, a zero responsibility sum no longer divides by zero, no `debug` feature | dodgy_2d 0.5.5 (https://github.com/andriyDev/dodgy, crates.io sha256 `d35627725e918aa4593ca54937cd8ef58078d3b9ab0fd060aee60c9bc3a2050e`), itself ported from RVO2 (https://gamma.cs.unc.edu/RVO2/) `Agent.cc` | andriyDev; RVO2: Jur van den Berg, Stephen J. Guy, Jamie Snape, Ming C. Lin, Dinesh Manocha, 2008 University of North Carolina at Chapel Hill | MIT OR Apache-2.0, used under Apache 2.0; RVO2 Apache 2.0 (see [Apache License 2.0](#apache-license-20) and [RVO2](#rvo2)) |
| `crates/genex-nav/src/runtime/avoidance.rs` (`Avoidance::step`) | Gathering each agent's neighbouring agents and bodies and handing them to ORCA (Genex replaces the k-d tree and `HashMap`s with a sorted uniform grid and sorts neighbours by distance, then key) | landmass 0.9.3 (https://github.com/andriyDev/landmass, crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`), `src/avoidance.rs` (`apply_avoidance_to_agents`) | andriyDev | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-nav/src/runtime/{coords, util, geometry, nav_mesh, island, nav_data, link}.rs` (islands, navigation-mesh validation and sampling, island stitching with boundary links, modified nodes, region connectivity, animation-link data), with landmass's own tests as `nav_mesh_test.rs` and `nav_data_test.rs` | Islands and their stitching. Changed (listed in each file's header): std `HashMap`/`HashSet` and slotmap are insertion-ordered maps and a deterministic arena, the `geo` boundary clip and `kdtree` vertex snap are Genex's own `clip.rs` and `grid.rs`, the `disjoint` set is Genex's own `disjoint.rs` without a `Mutex`, a Y-up `GenexCoords`, a caller-set edge-link distance, tests converted from googletest to plain asserts | landmass 0.9.3 (https://github.com/andriyDev/landmass, crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`), `src/{coords, util, geometry, nav_mesh, island, nav_data, link}.rs`, `PermittedAnimationLinks` from `src/agent.rs`, `src/{nav_mesh, nav_data}_test.rs` | andriyDev | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-nav/src/runtime/{archipelago, agent, character, astar, path, pathfinding, query}.rs` (agents, characters, A*, the funnel, path queries, the nav-mesh border obstacles for avoidance), with landmass's own tests as `{archipelago, agent, astar, path, pathfinding, query}_test.rs` | Agents, A* and the straight-path funnel. Changed (listed in each file's header): insertion-ordered maps and a deterministic arena, an A* heap ordered by (estimate, cost, state) with a node cap and partial results, a per-update search budget with a FIFO wait queue, shut areas and closed links (gates) that drop the corridors crossing them, a filter-based path query, tests converted from googletest to plain asserts | landmass 0.9.3 (https://github.com/andriyDev/landmass, crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`), `src/{lib, agent, character, astar, path, pathfinding, query}.rs`, `nav_mesh_borders_to_dodgy_obstacles` from `src/avoidance.rs`, `src/{lib, agent, astar, path, pathfinding, query}_test.rs` | andriyDev | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-nav/src/runtime/detour.rs` (`Archipelago::{raycast, move_along, random_point, distance_to_wall}`) | Detour surface queries: the 2D segment-polygon clip of `dtIntersectSegmentPoly2D` and the polygon walk of `dtNavMeshQuery::raycast`, the bounded breadth-first slide of `moveAlongSurface` (`MAX_STACK` 48), the area-weighted reservoir pick of `findRandomPointAroundCircle` with `dtRandomPointInConvexPoly`, and the shrinking-radius wall search of `findDistanceToWall`. Changed (listed in the file header): islands and boundary links walked in world space, walls from modified nodes and shut areas, genex-core Pcg32 only, breadth-first search, hostile input answers None. An altered version | Recast Navigation (https://github.com/recastnavigation/recastnavigation), `Detour/Source/DetourNavMeshQuery.cpp`, `Detour/Source/DetourCommon.cpp` | Mikko Mononen and Recast Navigation contributors | Zlib (see [Recast Navigation](#recast-navigation)) |
| `crates/genex-nav/src/debug.rs` (`lines`, `segments`) | The nav debug drawing: boundary edges, connectivity edges, boundary links and agents' corridors, and the rule that a node cut by boundary links draws what is left of its boundary. Changed (listed in the file's header): lines returned in genex world space instead of a `DebugDrawer`, no points, each stitch and each inner edge drawn once | landmass 0.9.3 (https://github.com/andriyDev/landmass, crates.io sha256 `fd2fd988b81194c6f02c293a28b510b44f1d8581c80b1bfe498e85e9c3f57b93`), `src/debug.rs` (`draw_archipelago_debug`) | andriyDev | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-nav/src/input_rapier.rs` (`collider_triangles`, `ColliderView::is_static`) | Which collider shapes give bake triangles (compounds recurse with their parts' poses, rounded shapes give their inner shape, half-spaces, segments and polylines give none) and the default pick (static colliders only, never a sensor). The table and the rule only; no code was copied | rerecast 0.5.0 (https://github.com/janhohenheim/rerecast), the `avian_rerecast` crate's `collider_to_trimesh.rs`; oxidized_navigation 0.12.0 (https://github.com/TheGrimsey/oxidized_navigation, archived), its collider filter | Jan Hohenheim and rerecast contributors; TheGrimsey and oxidized_navigation contributors | MIT OR Apache-2.0 |
| `crates/genex-nav/src/carve.rs` (`Carving`, `NavObstacle`) | Obstacle carving: cylinder and box obstacles marking the tiles they touch, and a rebuild queue worked a bounded amount per update, rebuilding touched tiles from a kept checkpoint. The logic only; no code was copied | Recast Navigation (https://github.com/recastnavigation/recastnavigation), `DetourTileCache/Source/DetourTileCache.cpp`; DotRecast (https://github.com/ikpil/DotRecast), `src/DotRecast.Detour.Dynamic` | Mikko Mononen and Recast Navigation contributors; ikpil and DotRecast contributors | Zlib (see [Recast Navigation](#recast-navigation)); Zlib |
| `crates/genex-nav/src/input.rs` (`TileInput::clear_steep`, `AreaVolume`) | The walkable-slope rule (a triangle is walkable when its unit normal's y is above cos(slope)), convex area volumes marked between two heights with the even-odd point-in-polygon test, and the 12-point outline cap. The rules only; no code was copied | rerecast 0.5.0 (https://github.com/janhohenheim/rerecast), `ConvexVolume`; Recast Navigation (https://github.com/recastnavigation/recastnavigation), `Recast/Source/Recast.cpp` (`rcClearUnwalkableTriangles`), `Recast/Source/RecastArea.cpp` (`rcMarkConvexPolyArea`, `pointInPoly`), `DetourTileCache/Include/DetourTileCacheBuilder.h` (`DT_MAX_CONVEXVOL_PTS`) | Jan Hohenheim and rerecast contributors; Mikko Mononen and Recast Navigation contributors | MIT OR Apache-2.0 (rerecast); Zlib (Recast Navigation) |
| `crates/genex-nav/src/recast/` (every file but `error.rs`; `ops.rs` keeps only `floor`, `ceil`, `abs`, `cos`), `tests/recast_parity.rs` (from `tests/cpp_comparison.rs` and `crates/test_utils`) | Recast navmesh generation: heightfield rasterization, span filters, compact heightfield, erosion, convex area volumes, the watershed distance field and regions, contours, polygon mesh and detail mesh, with the C++ parity test. Changed (listed in `recast/mod.rs`, each file's header and `crates/genex-nav/PORTS.md`): glam 0.33, slotmap replaced by Genex's arena, thiserror and bitflags written out by hand, one typed `RecastError` in place of anyhow, `cos` always through libm, no tracing, serde or bevy_reflect, std instead of no_std. An altered version of both rerecast and Recast | rerecast 0.5.0 (https://github.com/janhohenheim/rerecast, tag `v0.5.0`, tarball sha256 `1ed9c37afa1ccca1121b16bed89afd33dab05cf5668bbeeac58dc4d7054fc2d0`), `crates/rerecast/src/*`, itself a port of Recast Navigation (https://github.com/recastnavigation/recastnavigation) | Jan Hohenheim and rerecast contributors; Mikko Mononen and Recast Navigation contributors | MIT OR Apache-2.0, used under MIT (see [rerecast](#rerecast)); Zlib (see [Recast Navigation](#recast-navigation)) |
| `crates/genex-nav/tests/fixtures/recast/dungeon/*.json` | Recast's dungeon demo level and C++ Recast's dumps of its config, area volumes, contour set, polygon mesh and detail mesh, byte for byte | rerecast 0.5.0, `assets/test/dungeon/`; the level is Recast Navigation's `RecastDemo/Bin/Meshes/dungeon.obj` ("Dungeon level copyrighted by John Ratcliff for use in recast algorithm testing", rerecast's `assets/models/license.md`) | John Ratcliff (level); Jan Hohenheim (dumps) | Zlib (Recast Navigation); MIT OR Apache-2.0 (rerecast) |
| `crates/genex-nav/src/bake.rs` (`bake_tile`) | The per-tile build: a border of `walkableRadius + 3` cells, regions partitioned with the border kept out, heights counted from one floor for every tile. The steps only; no code was copied | Recast Navigation, `RecastDemo/Source/Sample_TileMesh.cpp` (`Sample_TileMesh::buildTileMesh`) | Mikko Mononen and Recast Navigation contributors | Zlib (see [Recast Navigation](#recast-navigation)) |
| `crates/genex-input/src/modifier.rs` (`Modifier::DeadZone` with `DeadZoneKind::Radial`, `radial`) | The radial stick dead zone: zero inside the dead zone, normalized past length 1, otherwise the length inverse-lerped from the dead zone to the edge (Genex takes the outer edge as a parameter instead of a fixed 1 and computes in libm) | Godot Engine 4.5-stable (https://github.com/godotengine/godot, commit 876b290332ec6f2e6d173d08162a02aa7e6ca46d), `core/input/input.cpp` (`Input::get_vector`) | Godot Engine contributors | MIT (see [Godot Engine](#godot-engine)) |
| `crates/genex-input/src/modifier.rs` (`DeadZoneKind::Axial`, `Modifier::Hysteresis`, `BUTTON_PRESS`, `BUTTON_RELEASE`) | The per-axis dead zone remap between the dead zone and the live zone, and the button hysteresis defaults (press at 0.75, release at 0.65) | Bevy v0.17.2 (https://github.com/bevyengine/bevy, commit 566358363126dd69f6e457e47f306c68f8041d2a), `crates/bevy_input/src/gamepad.rs` (`AxisSettings`, `ButtonSettings`) | Bevy contributors | MIT OR Apache-2.0, used under MIT (see [Bevy](#bevy)) |
| `crates/genex-input/src/modifier.rs` (`Modifier::{Negate, Swizzle, Scale, Curve}`), `src/condition.rs` (`Condition::{Hold, Tap, Pulse, Toggle, Cooldown, BlockBy}`), `src/map.rs` and `src/state.rs` (context priority, consume-when-actuated, pass-through) | Input modifiers, input conditions and context layering. The modifiers follow the source; for the conditions and contexts only the rules were taken and no code was copied (Genex counts every window in ticks instead of seconds, steps conditions on its own hold counter and evaluates from genex-core's merged tick input) | bevy_enhanced_input v0.27.0 (https://github.com/simgine/bevy_enhanced_input, commit d7be47fd91184c1bb1ff1f5a40d073d36a18547e), `src/modifier/*.rs`, `src/condition/*.rs` | Hennadii Chernyshchyk and bevy_enhanced_input contributors | MIT OR Apache-2.0, used under MIT (see [Bevy Enhanced Input](#bevy-enhanced-input)) |
| `crates/genex-ui/src/kit/toast.rs` (`Toasts`, `ToastKind`) | The toast queue: top-right stack with 8 px margin and spacing and 10 px padding, the `1 - (1 - x)^3` slide, a countdown that pauses under the pointer, the 4 px progress line. Changed (listed in the file's header): time counted in simulation ticks instead of `stable_dt`, the queue kept in egui memory (a seed forgets it), level icons drawn as shapes, the close cross dropped (a click anywhere dismisses), a capped queue, AccessKit labels and keys | egui-notify 0.23 (https://github.com/ItsEthra/egui-notify), `src/lib.rs` | ItsEthra | MIT (see [egui-notify](#egui-notify)) |
| `crates/genex-audio/src/music.rs` (`MusicStream`, `Resampler`), `src/decode.rs` (`decode_sound`, `append_frames`), `src/lowpass.rs` (`LowPass`) | Playing a sound from a frame source: kira's static-sound process loop (per-frame volume and fade interpolation, the fractional position advanced by the source rate, the 4-point resampler fed one source frame at a time, the stop fade and the end once the resampler empties) and its decode loop and sample conversion over symphonia buffers; each voice's low-pass: kira's state-variable filter in low-pass mode. Changed (listed in the files' headers): frames come from a ring that symphonia packets fill inline instead of a decoded array; loops wrap by an accurate seek plus a priming packet or by reopening; no pause, resume, rate, panning or seek commands; the decode is capped and guarded against panics; the low-pass keeps kira's default resonance and mix as constants and computes its coefficients once per block while the cutoff holds still | kira 0.12.5 (https://github.com/tesselode/kira), `src/sound/static_sound/sound.rs`, `src/sound/static_sound/sound/resampler.rs`, `src/sound/static_sound/data/from_file.rs`, `src/sound/symphonia.rs`, `src/effect/filter.rs`, `src/effect/filter/builder.rs`, `src/effect/filter/handle.rs` | Andrew Minnich and kira contributors | MIT OR Apache-2.0, used under Apache 2.0 (see [Apache License 2.0](#apache-license-20)) |
| `crates/genex-platform-web/src/crash.rs` (`console_text`, `console_hook`, the `Error().stack` binding) | The panic hook's console text: the panic, `\n\nStack:\n\n`, the stack of a fresh `Error`, `\n\n` | console_error_panic_hook 0.1.7 (https://github.com/rustwasm/console_error_panic_hook), `src/lib.rs` `hook_impl` | Nick Fitzgerald and the Rust and WebAssembly Working Group | MIT OR Apache-2.0, used under MIT (text below) |

### egui-notify

The licence of egui-notify, whose toast queue `crates/genex-ui/src/kit/toast.rs` ports (table above).

```
MIT License

Copyright (c) 2022-2023 ItsEthra

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

### Fyrox

The licence of Fyrox, whose animation state machine's structure and rules the graph and machine follow and whose
ragdoll sync the ragdoll ports (table above).

```
Copyright (c) 2019-present Dmitry Stepanov and Fyrox Engine contributors.

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

### ozz-animation

The licence of the ozz-animation code the skeleton, sampler, blend, mask and IK port (table above).

```
ozz-animation is hosted at http://github.com/guillaumeblanc/ozz-animation and
distributed under the MIT License (MIT).

---

Copyright (c) 2020 Guillaume Blanc

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
of the Software, and to permit persons to whom the Software is furnished to do
so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

### Recast Navigation

The licence of Recast Navigation, which rerecast ported and whose tile build and dungeon test level
genex-nav uses (table above).

```
Copyright (c) 2009 Mikko Mononen memon@inside.org

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

### rerecast

The licence of rerecast, whose Recast port genex-nav ports (table above). Its MIT text carries no
copyright line; its Cargo.toml names the author, Jan Hohenheim.

```
MIT License

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

### RVO2

The notice the dodgy_2d port keeps from RVO2, which dodgy_2d ported (table above). RVO2 is licensed
under the Apache License 2.0 (see [Apache License 2.0](#apache-license-20)); it ships no NOTICE file.
Each ported file carries this header:

    Agent.cc
    RVO2 Library

    SPDX-FileCopyrightText: 2008 University of North Carolina at Chapel Hill

    The authors may be contacted via:

    Jur van den Berg, Stephen J. Guy, Jamie Snape, Ming C. Lin, Dinesh Manocha
    Dept. of Computer Science
    201 S. Columbia St.
    Frederick P. Brooks, Jr. Computer Science Bldg.
    Chapel Hill, N.C. 27599-3175
    United States of America

    <https://gamma.cs.unc.edu/RVO2/>

### Spring-It-On and Motion-Matching

The licence of Daniel Holden's code the inertialization and dead-blending port (table above). Both
repositories carry the same text.

```
MIT License

Copyright (c) 2021 Daniel Holden

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

### wgpu-profiler

The licence of wgpu-profiler, whose span layout and Chrome trace format genex-profile ports (table
above).

```
MIT License

Copyright (c) 2021 Andreas Reich

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

### console_error_panic_hook

The licence of console_error_panic_hook, whose panic console text genex-platform-web's crash hook
ports (table above).

```
Copyright (c) 2018 Nick Fitzgerald

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

### Bevy

The MIT side of Bevy's licence, under which genex-input ports bevy_input's dead zone remap and
button hysteresis (table above). Bevy's `LICENSE-MIT` names no copyright holder; the authors are
the Bevy contributors.

```
MIT License

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

### Bevy Enhanced Input

The MIT side of bevy_enhanced_input's licence, whose modifiers, conditions and context rules
genex-input ports (table above).

```
MIT License

Copyright (c) 2023 Hennadii Chernyshchyk

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
| `herringbone_parquet` | the cafe's varnished floor | https://polyhaven.com/a/herringbone_parquet (`herringbone_parquet_diff_1k.jpg`, `herringbone_parquet_nor_gl_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Jenelle van Heerden, Sergej Majboroda, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,202,484 bytes |
| `painted_metal_shutter` | the closed shops' shutters | https://polyhaven.com/a/painted_metal_shutter (`painted_metal_shutter_diff_1k.jpg`, `painted_metal_shutter_nor_gl_1k.jpg`, `painted_metal_shutter_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dario Barresi, Rico Cilliers, Charlotte Baglioni, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,964,868 bytes |
| `dark_wood` | the cafe's tables, chairs, counter, shelves and door, its menu board's frame, the street bench and the alley's crates | https://polyhaven.com/a/dark_wood (`dark_wood_diff_1k.jpg`, `dark_wood_nor_gl_1k.jpg`, `dark_wood_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Dario Barresi, Dimitrios Savva, Rico Cilliers, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,717,893 bytes |
| `marble_01` | the cafe's counter top and the cup and saucer on the window table | https://polyhaven.com/a/marble_01 (`marble_01_diff_1k.jpg`, `marble_01_nor_gl_1k.jpg`, `marble_01_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 469,999 bytes |
| `metal_plate_02` | the street lamps, the bollards, the window frames, the sign panels, the furniture's legs and the alley's pipes, air conditioners and bin | https://polyhaven.com/a/metal_plate_02 (`metal_plate_02_diff_1k.jpg`, `metal_plate_02_nor_gl_1k.jpg`, `metal_plate_02_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,885,020 bytes |
| `granite_tile` | the kerb stones and the cafe's threshold | https://polyhaven.com/a/granite_tile (`granite_tile_diff_1k.jpg`, `granite_tile_nor_gl_1k.jpg`, `granite_tile_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Charlotte Baglioni, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 1,987,919 bytes |
| `metal_grate_rusty` | the drains along the kerbs, the manhole covers, the alley's gutter and the air conditioners' grilles | https://polyhaven.com/a/metal_grate_rusty (`metal_grate_rusty_diff_1k.jpg`, `metal_grate_rusty_nor_gl_1k.jpg`, `metal_grate_rusty_arm_1k.jpg`, from `https://dl.polyhaven.org/file/ph-assets/`) | Rob Tuytel, Dimitrios Savva, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 2,774,295 bytes |
| `kloppenheim_01_puresky` | the overcast dusk sky map (B switches to it): image-based light and the backdrop | https://polyhaven.com/a/kloppenheim_01_puresky (`kloppenheim_01_puresky_2k.hdr`, from `https://dl.polyhaven.org/file/ph-assets/`) | Greg Zaal, Jarod Guest, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway | 3,187,954 bytes |

## Soldier kit

`src/game-template-rust/docs/examples/soldier/soldier.glb` is built by `soldier.py` from Quaternius'
Universal Animation Library (Standard), CC0 1.0: its mannequin, skeleton and clips (Idle, Walk,
Run, Sprint, CrouchIdle, CrouchWalk and Death, some turned, the strafes made from its walk). The
library is `universal_animation_librarystandard.zip` (14,541,205 bytes, sha256
`18ff1a7215f4852b320203e8aaf02a1578b5c8eef9027fbaedfcedc7b85a3ac2`) from
https://opengameart.org/sites/default/files/universal_animation_librarystandard.zip (page
https://quaternius.com), its `Godot/AnimationLibrary_Godot_Standard.glb`. The outfit and rifle carry
the arms kit's scans below (Poly Haven's `book_pattern`, `leather_white` and `dark_wood`; ambientCG's
`Metal029` and `Plastic014A`), tinted. CC0; the credit is given anyway.

## First-person arms kit scans

`src/game-template-rust/docs/examples/fps-arms/fps-arms.glb` carries five CC0 scans, resized
(2k colour, 1k normal, 512 roughness/metal), some tinted, and packed into the GLB by
`fps_arms.py`. Every one is CC0; the credits are given anyway.

| Scan | Used for | Source | Authors | Licence |
| --- | --- | --- | --- | --- |
| `Metal029` | the rifle's black painted steel | https://ambientcg.com/view?id=Metal029 (`Metal029_2K-JPG.zip`: Color, NormalGL, Roughness, Metalness) | Lennart Demes, via ambientCG | CC0 1.0 (ambientCG's licence, https://docs.ambientcg.com/license/); no attribution is required and it is given anyway |
| `Plastic014A` | the magazine's bakelite, tinted plum | https://ambientcg.com/view?id=Plastic014A (`Plastic014A_2K-JPG.zip`: Color, NormalGL, Roughness) | Lennart Demes, via ambientCG | CC0 1.0 (ambientCG's licence, https://docs.ambientcg.com/license/); no attribution is required and it is given anyway |
| `dark_wood` | the handguards, grip and stock | https://polyhaven.com/a/dark_wood (`dark_wood_diff_2k.jpg`, `dark_wood_nor_gl_2k.jpg`, `dark_wood_arm_2k.jpg`) | Dario Barresi, Dimitrios Savva and Rico Cilliers, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway |
| `leather_white` | the gloves, tinted coyote | https://polyhaven.com/a/leather_white (`leather_white_diff_2k.jpg`, `leather_white_nor_gl_2k.jpg`, `leather_white_arm_2k.jpg`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway |
| `book_pattern` | the sleeves' olive cotton | https://polyhaven.com/a/book_pattern (`book_pattern_col1_2k.jpg`, `book_pattern_nor_gl_2k.jpg`, `book_pattern_arm_2k.jpg`) | Rob Tuytel, via Poly Haven | CC0 1.0 (Poly Haven's licence, https://polyhaven.com/license); no attribution is required and it is given anyway |

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
in its own sandbox: the Basis Universal transcoder, Draco's glTF decoder, and meshoptimizer's
decoder, meshlet clusterizer and simplifier. Before any of them it runs the Khronos glTF validator
(JavaScript compiled from Dart) on every glTF file. The packaged app carries them in
`resources/importer-tools/` (paths below are under it), with this page beside them, and every file
is pinned by sha256 in `src/substrate/asset-import/decoders.ts`. Draco and meshoptimizer are copied
from the npm packages below; the Basis build is the v2.50 release's `webgl/encoder/build`, whose
transcoder the importer calls (the same build encodes, so encoder and transcoder match). Their
licence and notice texts are in the [Basis Universal](#basis-universal), [Draco](#draco),
[meshoptimizer](#meshoptimizer) and [Zstandard](#zstandard) sections below.

| File | Project | License |
| --- | --- | --- |
| `basis-encoder-2.50/` | [Basis Universal](https://github.com/BinomialLLC/basis_universal) v2.50 WebAssembly build (encoder and transcoder), with its embedded [Zstandard](https://github.com/facebook/zstd) | Apache-2.0 with its NOTICE; embedded Zstandard BSD-3-Clause |
| `draco3dgltf/` | [Draco](https://github.com/google/draco) 1.5.9 glTF decoder (npm `draco3dgltf`) | Apache-2.0 |
| `meshoptimizer/` | [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.3.0 decoder, meshlet clusterizer, simplifier, MikkTSpace-compatible tangents and encoder (vertex cache and fetch order) (npm `meshoptimizer`); the importer stores its meshlets and levels of detail in glTF `extras` | MIT |
| `gltf-validator/` | [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) 2.0.0-dev.3.10 (npm `gltf-validator`), the import step's glTF validation gate; its `LICENSE` and `NOTICES` files (the Dart runtime's notices) ship beside it | Apache-2.0 |

## Asset importer packages

These npm packages are pinned exactly in `package.json` for the asset importer
(`src/substrate/asset-import/`), as development dependencies: the build copies the files the
importer runs from `draco3dgltf`, `meshoptimizer` and `gltf-validator` into the app's `resources/importer-tools/`
([Asset importer decoders](#asset-importer-decoders)), and the others are not carried in the app
yet. Each package keeps its licence file in its own folder, except `draco3dgltf`,
whose package declares Apache-2.0 without a licence file (the text is in
[Apache License 2.0](#apache-license-20)); `gltf-validator` also carries a `NOTICES` file.

| Package | Version | Project | License |
| --- | --- | --- | --- |
| `meshoptimizer` | 1.3.0 | [meshoptimizer](https://github.com/zeux/meshoptimizer) (simplifier, clusterizer, tangents, vertex order) | MIT |
| `draco3dgltf` | 1.5.9 | [Draco](https://github.com/google/draco) glTF decoder | Apache-2.0 |
| `gltf-validator` | 2.0.0-dev.3.10 | [Khronos glTF-Validator](https://github.com/KhronosGroup/glTF-Validator) | Apache-2.0 |
| `fast-png` | 8.0.0 | [fast-png](https://github.com/image-js/fast-png) PNG decoder, with `iobuffer` 6.0.1 (MIT) | MIT |
| `jpeg-js` | 0.4.4 | [jpeg-js](https://github.com/eugeneware/jpeg-js) JPEG decoder | BSD-3-Clause |
| `fflate` | 0.8.3 | [fflate](https://github.com/101arrowz/fflate) zip and deflate | MIT |

## Asset importer ports

Code of the Rust · wgpu asset import step (`src/substrate/asset-import/`) ported from other
projects. The test fixture `tests/fixtures/asset-import/quantized.glb` is the output of
[gltfpack](https://github.com/zeux/meshoptimizer) 1.3.0 (MIT, the meshoptimizer licence below);
gltfpack itself is not in the repository.

| Genex file | What | Source | Upstream author | Licence |
| --- | --- | --- | --- | --- |
| `src/substrate/asset-import/dequantize.ts` | `KHR_mesh_quantization` undone: which attributes become float32 (every one but `JOINTS_n`, morph targets too) and the normalized-integer division with its -1 clamp | glTF-Transform 4.5.1 (https://github.com/donmccurdy/glTF-Transform), `packages/functions/src/dequantize.ts` and `packages/core/src/utils/math-utils.ts` (`decodeNormalizedInt`) | Don McCurdy | MIT (see [glTF-Transform](#gltf-transform)) |
| `src/substrate/asset-import/weld.ts`, `src/substrate/asset-import/prune.ts`, `src/substrate/asset-import/inspect.ts` | Bitwise vertex weld (the first-use write map over the index stream, the MurmurHash2 vertex hash over 4-byte-padded attributes with triangular probing, attribute compaction, 16-bit indices up to 65,534 vertices); accessor dedup (grouped as attributes, indices, animation inputs and outputs) and material dedup ignoring names; unreferenced accessors and materials pruned; the inspect report's mesh, texture and animation sizes | glTF-Transform 4.4.2 (https://github.com/donmccurdy/glTF-Transform), `packages/functions/src/weld.ts`, `hash-table.ts`, `compact-primitive.ts`, `dedup.ts`, `prune.ts` and `inspect.ts` | Don McCurdy | MIT (see [glTF-Transform](#gltf-transform)) |

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
- The X logo in `src/renderer/ui/brand.tsx` is a trademark of X Corp., used unaltered only to name
  X on Post on X, under its brand toolkit (https://about.x.com/en/who-we-are/brand-toolkit).
- The GitHub mark in `src/renderer/ui/brand.tsx` is Primer Octicons' `mark-github` (MIT,
  © GitHub, Inc.) and a trademark of GitHub, Inc., used unaltered only to mark a link to a
  community plugin publisher's GitHub profile (https://github.com/logos).

## Status not yet recorded

These need an owner decision before public distribution; see
[release readiness](docs/release-readiness.md#distribution-and-open-source).

- Genex UI sources: components, theme tokens, the wordmark, the coin mark and the catalog-search
  engine were adapted from the owner's `genex-cli-threejs` web app (`src/renderer/ui/GENEX-SOURCES.md`).
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

### @genex-ai/embed-sdk 0.33.0

Bundled into `vendor/genex/`, the player-identity SDK a game made from Studio's template maps in its import
map. Its package and repository (https://github.com/genex-games/genex) declare the MIT license
without a license file. The MIT terms:

Copyright (c) 2026 Genex

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

### @genex-ai/multiplayer 0.17.1

Bundled into `vendor/genex/`, the multiplayer SDK a game made from Studio's template maps in its import
map, and shipped as `genex-multiplayer-bridge.js` (its `dist/bridge.global.js`) beside a multiplayer
Godot game's web export. Its package and repository (https://github.com/genex-games/genex) declare the MIT license
without a license file. The MIT terms:

Copyright (c) 2026 Genex

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

(The line above is from the v1.50 transcoder sources; v1.50's LICENSE carries only the Apache template line. The current upstream LICENSE reads `Copyright 2019-2026 Binomial LLC`. The asset importer's v2.50 build is under the same licence and the NOTICE below.)

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

(From the Draco 1.5.6 source file headers; the LICENSE file carries only the Apache template line. Draco has no NOTICE file. The asset importer's npm `draco3dgltf` 1.5.9 decoder is under the same licence.)

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

Copyright (c) 2016-2026 Arseny Kapoulkine (covers `meshopt_clusterizer.module.js`, `meshopt_decoder.module.js` and `meshopt_simplifier.module.js`, and the asset importer's `meshoptimizer/` files from npm `meshoptimizer` 1.3.0, whose `LICENSE.md` is this text)

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

Applies to Basis Universal, Draco, Chevrotain, the pdf.js JPEG decoder, the Filament functions the Rust renderer ports (Copyright (C) The Android Open Source Project) and the Bevy auto exposure, contact-shadow, screen-space ray march, reflection-probe box-projection, irradiance-volume lookup, motion-blur and diffuse-transmission functions it ports (Bevy contributors and Tomasz Stachowiak, dual-licensed MIT OR Apache-2.0) ([Rust renderer shader ports](#rust-renderer-shader-ports)). Text from https://www.apache.org/licenses/LICENSE-2.0.txt:

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
