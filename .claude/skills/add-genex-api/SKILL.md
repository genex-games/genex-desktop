---
name: add-genex-api
description: Add or change what a generated Rust game can call on the genex facade (a Game hook, a Ctx or Frame method, a runtime key, an install refusal) together with its runtime crate, reference page, vocabulary fixture and tests. Use for work under native/genex-rust and the Rust game template, not for a game's own code.
---

# Add or change a genex API

`genex` is the facade a Rust · wgpu game is written against (`native/genex-rust/crates/genex`);
the crates behind it draw, simulate, play audio and talk to Studio. The game-facing contract is
`native/genex-rust/docs/GENEX_API.md`. An agent writing a game reaches for the lowest level of the
extension ladder that works (hooks, its own modules, WGSL, custom GPU passes, an approved crate,
eject), so a new API earns its place only when games keep escaping to a higher level for it.
Guarantees (captures, Live, determinism, Stop, the sandbox) hold by behaviour, never by hiding
the API.

## Files

1. **Facade** - `native/genex-rust/crates/genex/src/` (`game.rs` for hooks and registration,
   `ctx.rs`, `frame.rs`, `sim.rs`, `gpu.rs`). A capability that draws, plays audio or reads
   input lives in its runtime crate (`genex-render`, `genex-audio`, `genex-core`,
   `genex-hud`) and the facade re-exports a small safe surface. Update hooks stay deterministic
   and see only the seeded clock and merged input; draw hooks stay read-only on `Sim`.
2. **Dependencies** - take them only from `[workspace.dependencies]`; a crate missing from the
   vendored tree goes into `scripts/spike/rust-wgpu/vendor-allowlist.toml` first, then
   `scripts/toolchains/rust-vendor.ts check` must still pass (no build script, proc macro or
   GL backend crate without a reviewed `rust-inventory.json` row).
3. **Reference page** - `native/genex-rust/docs/GENEX_API.md` and its byte-equal copy
   `src/game-template-rust/docs/GENEX_API.md` (`rust-template-docs.test.ts` fails when they
   differ). Write it for the game's agent: what to call, what is refused, how determinism holds.
4. **Vocabularies** - a runtime key, install refusal or registration refusal is pinned in
   `tests/fixtures/rust-facade-vocabulary.json` and held by
   `native/genex-rust/crates/genex/tests/vocabulary.rs` on the Rust side and by
   `tests/conformance/rust-template-docs.test.ts` on the docs side; change all three together.
5. **Host contract** - only when a verb, refusal or feature the app knows changes:
   `src/shared/native-contract.ts`, the seed's typed copy `src/harness-seed/loop/native-contract.ts`
   (held by `tests/conformance/seed-contracts.test.ts`) and
   `src/game-template-rust/docs/CONTRACT.md`. A game cannot add a verb.
6. **Release tree** - the genex crates ship as a reviewed release; after a crate change refresh
   its digest for review with
   `node scripts/toolchains/rust-release.ts inventory` and name the new digest in the PR.

## Tests (red first)

- A Rust test in `native/genex-rust/crates/genex/tests/` (`runtime.rs`, `determinism.rs`,
  `install.rs`) that fails for the reported reason, run through the env helper only:
  `node scripts/toolchains/rust-env.ts -- cargo test -p genex --offline --locked`. Never call
  `cargo` directly, never use rustup or `~/.cargo`, and keep one shared `CARGO_TARGET_DIR`
  (a cold build takes several GB: check free disk first).
- A misuse the compiler should refuse (a mutation from a draw hook, a hook that advances time)
  is a compile-fail case in `crates/genex/tests/ui/fail/` with its `.stderr`; after an intended
  diagnostic change rerun with `TRYBUILD=overwrite` and review the diff.
- Anything that draws gets a golden or an `examples/` sample (`examples/pond`,
  `examples/custom-pass`); captures run headless, no test opens a window (`GENEX_NO_WINDOW=1`).
- `npm run test:rust-spike` runs the workspace's tests and clippy with `-D warnings`.
- On the host side: `npm run test:area -- rust-runtime` and `npm run test:area -- stack-identity`;
  a change under `src/game-template-rust/**` also needs `npm run verify:harness`.
  `GENEX_REQUIRE_TOOLCHAINS=1` turns a skipped real-toolchain row into a failure.

## Rules

- Never run a phone, an emulator or a device from a test or a script; the owner's device rows
  are manual.
- Do not add an API the extension ladder already covers at a lower level; do not add a platform
  tier (WebGPU is the minimum everywhere).
- Docs describe what runs: update `docs/agent/architecture.md` and `docs/product/builds-live.md`
  when behaviour a person sees changes, and report which layers ran.
