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
  `@genex-ai/cli-demo` 1.36.2 `templates/skills` (MIT, Copyright (c) 2026 me-ai-org). The
  license text ships beside them as `skills/LICENSE-cards`, copied from the CLI's `LICENSE`.
- `genex/SKILL.md` wraps https://genex.games/SKILL.md (v1.36.2), which is not part of the npm
  package. It is attributed to Genex here; its license is not yet confirmed (see "Status not yet
  recorded" below).

## Vendored three.js

Games and the asset preview use a vendored three.js (MIT, Copyright © 2010-2026 three.js
authors); its license ships as `dist/resources/vendor/three-LICENSE`. The copied `examples/jsm`
tree includes third-party libraries under their own terms, listed with their licenses in
[three.js add-on libraries](#threejs-add-on-libraries); the Assets viewer also copies the Draco and
Basis Universal decoders to `dist/renderer/decoders`.

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

The Claude Code and Codex marks in `src/renderer/ui/provider-marks.ts` are copied unaltered from
@lobehub/icons-static-svg 1.95.1 (claudecode.svg, codex.svg). Claude Code is a trademark of
Anthropic and Codex of OpenAI; the marks only name the subscriptions Studio connects to.
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

Applies to Basis Universal, Draco, Chevrotain and the pdf.js JPEG decoder. Text from https://www.apache.org/licenses/LICENSE-2.0.txt:

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
