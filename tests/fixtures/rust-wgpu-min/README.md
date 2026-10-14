# rust-wgpu-min

The smallest folder the studio must read as a Rust · wgpu game: a `genex.toml`, a `src/main.rs`
that hands its game to `genex::install` and one gameplay module, with no page, no `Cargo.toml`
and no `studio.json`. `tests/conformance/game-workspace.test.ts` copies it to prove the folder is
detected as `rust-wgpu` (never the studio's Three.js template), validated by its own checks and
adopted without a byte of the JavaScript or C++ scaffold. It is never compiled: the `genex.toml`
keys are a stand-in until the manifest parser (M2.2) fixes them.
