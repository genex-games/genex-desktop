# rust-render-game

"Every Light": a Rust · wgpu game that reaches every renderer feature through the facade, as it
stands just before the person ejects its engine (extension ladder level 5). Its `genex.toml`
`[render]` table chooses the look (AgX punchy, auto exposure, bloom, AO, fog, contact shadows),
the shadow reach and per-class quality (meshlets with Hi-Z occlusion on the desktop-high and
desktop-ultra classes, a render scale on mobile-mid); `src/scene.rs` draws the physical sky, the
sun, shadowed and unshadowed spot lights, point lights, PBR and emissive surfaces, named moving
orbs for TAA's motion vectors, a v2 Level-2 material (`shaders/glow.wgsl`) and a v2 Level-2 post
pass (`shaders/vignette.wgsl`), with the settings panel behind Tab; `src/probe.rs` is a v2 Level-3
pass at `after-prepass` that reads the prepass depth (`shaders/depth_probe.wgsl`), and `src/warm.rs`
one at `post-hdr` that warms the HDR scene before the tonemap (`shaders/warm.wgsl`).

`tests/conformance/rust-eject.test.ts` parses its `genex.toml`, ejects a copy through the real
eject (`src/main/rust-eject.ts`) and, on an Apple silicon Mac with the release's vendored crates,
builds the fork offline with the real lane, runs the game conformance suite on the build and checks
that the fork draws every renderer feature with its extensions admitted. The folder holds no
`engine/` and no `[engine]` row: only an eject writes them.
