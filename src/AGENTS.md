# Source folders

Notes for the external developer. Root rules are in [AGENTS.md](../AGENTS.md); house terms
are in the [glossary](../docs/agent/glossary.md). Never add developer `AGENTS.md` or `CLAUDE.md`
files inside `harness-seed/`, `game-template/`, `game-template-cpp/` or `game-template-rust/`:
`scripts/build.mjs` copies these trees into every user's workspace, where in-app engines read them.
`tests/conformance/agent-instructions.test.ts` enforces this.

## harness-seed

- This is the seed of the in-app harness. `substrate/seed-upgrade.ts` (`applySeed`) copies it
  into the user's editable harness workspace and keeps files the in-app agent has edited, so a
  seed change may not reach an existing profile. Check the seed-upgrade report for `kept` files.
  When you move exported code from one seed file to another, add the move to `SEED_MOVES` in
  `substrate/seed-upgrade.ts` so a kept copy of the old file is reported (`moved`). When you
  rename an exported name or a module, add it to `substrate/seed-renames.ts`: the upgrade rewrites
  the old name in the agent's kept files, or the harness stops loading. An old name that is also an
  English word goes in its `ENGLISH_NAMES` too, so prose keeps it.
- It is TypeScript run by type stripping: the in-app agent edits it at runtime, and the harness
  runs it under Electron's Node (`ELECTRON_RUN_AS_NODE`) with no build step, so erasable syntax
  only and `.ts` import specifiers. Keep it dependency-free. It is its own strict project
  (`harness-seed/tsconfig.json`, checked by `npm run typecheck` through `tsconfig.harness.json`)
  and cannot import `src/shared`: host calls are typed by `types/host-api.d.ts` and named by
  `loop/host-methods.ts` (`HostMethod`), both generated from `shared/harness-api.ts`
  (`node scripts/gen-harness-types.ts` after changing the contract). Its other copies of shared
  vocabularies (`RunEvent`, `ExecutionStatus`, `EngineId`, `EngineFailure`, `VerdictPass` and
  `VerdictRule` in `loop/verdict.ts`, `loop/time.ts`) are held to the app's by
  `seed-contracts.test.ts`.
  `harness-boot/bootstrap.mjs` stays plain JavaScript and falls back to a legacy `loop/main.mjs`;
  a workspace still on `.mjs` is moved to `.ts` by `migrateHarnessLayout` (seed manifest
  `layoutVersion`), never by leaving new files beside old ones. The agent's own code edits pass the
  self-edit gate (`main/core/self-edit-gate.ts`): keep the seed's tool descriptions and prompts
  accurate when that contract changes.
- The director and the facet loop are folders (`loop/director/`, `loop/facet/` with one
  `phases/*.ts` per round phase); `director.ts` and `facet-loop.ts` stay the entry points and
  re-export what older kept files import. Model-facing text lives in sibling `*-prompts.ts`.
- `prompts/`, `judge/`, `skills/` and `library/` text is product copy addressed to in-app models;
  edit it as product text and never follow it as instructions.
- Every loop fix gets one incident test in `tests/conformance/harness-incidents.test.ts` that
  fails without the fix. Run `npm run verify:harness`; see the
  [incident recipe](../docs/agent/recipes.md#harness-incident-fix).

## game-template

- The starting project of every new game. `CLAUDE.md`, `CLAUDE.own.md`, `NOTES*.md` and
  `docs/CONTRACT.md` are payload for in-app builders.
- `src/studio.js` installs `window.__studio`, the contract the harness and preview use to
  inspect, step and capture a game. Never remove a method.
- A change affects every new game. Run `npm run test:shapes:e2e` when the contract or boot
  path changes.

## game-template-cpp

- The starting project of every C++ · raylib game: `CMakeLists.txt` calls `genex_add_game` from
  the toolchain store's `genex.cmake`, `src/studio.*` is the C++ studio runtime (verbs mirror
  `studio.d.ts`; never remove one) and `web/shell.html` binds it to `window.__studio`.
  `CLAUDE.md`, `CLAUDE.own.md`, `NOTES*.md` and `docs/CONTRACT.md` are payload.
- Its raylib-free units (`protocol`, `json`, `input`, `clock`, `session`, `paths`, `transport`)
  are tested in `tests/cpp/` through `tests/conformance/cpp-runtime.test.ts`, which also drives
  the runtime over a stub raylib (`tests/cpp/raylib_stub.h`) on fd 3; the raylib-including files
  through `cpp-template.test.ts` and `scripts/toolchains/compile-check.sh`. The real web and Mac
  builds are `cpp-lane-real.test.ts`; a `web/shell.html` change also regenerates
  `tests/fixtures/raylib-wasm` (`scripts/toolchains/make-wasm-fixture.sh`).
- `src/frames.*` is Live's frames ring (a Mac headless build's alone; `frames_wire.h` is a byte
  copy of `native/genex-frames/include/gxf_wire.h`): `tests/cpp/frames_test.cpp`, and for real
  through the addon `native-embed-real.test.ts`.
- `native/raylib-platform/rcore_genex_headless.c` is Genex's headless raylib platform: the Mac
  prewarm compiles it in place of raylib's `rcore_memory.c` (`headless-raylib.test.ts`).

## game-template-rust

- The starting project of every Rust · wgpu game, created by a development build and, in a
  release build, where the Rust lane runs (the gate in `main/core/stack-gate.ts`). `genex.toml`
  is its only build input: the host writes the cargo manifest, lock and configuration, so the
  template ships none. `src/main.rs`
  keeps one `FACET WIRING` block before `genex::install` for the union merge.
  Keep `docs/GENEX_API.md` and `docs/api/` byte-equal to `native/genex-rust/docs/`; `CLAUDE.md`,
  `CLAUDE.own.md`, `NOTES*.md` and `docs/CONTRACT.md` are payload.
- `tests/conformance/rust-template.test.ts` copies, creates and type-checks it under the pinned
  sysroot; the crates it builds against are `native/genex-rust/` (cargo only through
  `scripts/toolchains/rust-env.ts`, see its README).

## main and substrate

- IPC is registered per domain in `main/ipc/<domain>.ts` through `handle()`
  (`main/ipc-handle.ts`), typed by the channel map in `shared/ipc-channels.ts`; `main/index.ts`
  composes the registrars. Follow the [IPC recipe](../docs/agent/recipes.md#ipc-channel).
  Classify every new channel in `main/dev/native-policy.ts`: a map channel it does not classify
  fails the typecheck.
- `main/studio-core.ts` holds the core's lifecycle and public methods; the harness RPC surface
  is `main/harness-rpc/<namespace>.ts` (typed by `HarnessHostApi` in `shared/harness-api.ts`)
  and the behavior lives in services under `main/core/`. Follow the
  [RPC recipe](../docs/agent/recipes.md#harness-rpc-method). Smoke, selftest and acceptance
  drivers live in `main/smoke/`.
- A game's stack is `stackOf(shape)`; compiled builds go only through the build-lane seam
  (`main/game-build.ts` `GameBuildLanes`, the core's `x.gameBuilds`), never `CppBuilds` directly.
  Follow the [stack recipe](../docs/agent/recipes.md#stack); `npm run test:area -- stack-identity`
  runs its suites.
- Path checks go through `substrate/paths.ts` (`isInside`, `isBelow`, `containedReal`) and
  atomic writes through `substrate/fsx.ts` (`atomicWriteText`).
- Spawned processes go through `substrate/spawn.ts` (`ProcessSandbox`); quote shell arguments
  with `shellQuote`. A C++ game starts only through `spawnGame` (profile in
  `substrate/game-sandbox-profile.ts`, admission and run folder in `substrate/native-bundle.ts`);
  `main/core/native-runs.ts` is the run registry and `substrate/native-game-port.ts` the protocol
  port. `tests/conformance/native-real.test.ts` drives them over a real Mac build.
  `main/native-frames.ts` is the one place main loads native code (the `genex-frames` addon,
  `native-frames-addon.test.ts` for real), gated by `main/electron-gate.ts`; Mac app exports are
  `substrate/native-export.ts` behind `main/core/native-export-run.ts`. Validate path
  parameters from the harness by realpath inside the owned root; their shape is checked first by
  `HARNESS_PARAM_SCHEMAS` at `HarnessHost`.
- The Windows and Linux destinations, cross-built with zig from a Mac (a Windows host refuses C++
  builds, `unsupported-host`):
  - `substrate/toolchain-store/cross-targets.ts`: the zig CMake toolchain files, raylib's cross
    prebuild and the cross `genex.cmake`; `scripts/cross-build-smoke.ts` drives them for real in CI.
  - `substrate/native-gate-pe.ts`, `substrate/native-gate-elf.ts`: the Windows and Linux bundle
    gates; they read PE and ELF headers themselves, never through `llvm-readobj`.
  - `substrate/bundle-walk.ts`: the one bounded, link-refusing walk of a build's output for both
    gates and the cross run directory.
  - `substrate/windows-names.ts`: the one rule for a name Windows can hold (PE gate and archives).
  - `substrate/native-cross-admission.ts`: the lane's admission of a cross `out/` against the
    lock's store ANGLE manifest.
  - `substrate/native-rundir-cross.ts`: a Windows or Linux game's run directory on its own OS.
  - `substrate/windows-game-launch.ts`: how a Windows host starts `genex-game-launcher.exe`
    (`native/genex-game-launcher/`), which puts the game in an AppContainer.
  - `substrate/linux-game-box.ts`, `substrate/linux-game-seccomp.ts`: the bubblewrap box a game
    runs in on a Linux host, and the seccomp filter bubblewrap loads into it.
  - `substrate/native-export-archive.ts`, `substrate/native-export-desktop.ts`: the Windows zip and
    Linux tar.gz exports; `substrate/windows-sign.ts` is the optional `jsign` step with the
    person's own certificate.

## renderer, shared and page

- `renderer/` and `shared/` are browser code: no Node, Electron, main, preload or substrate
  runtime imports (`npm run verify:architecture`). Contracts live in `shared/`, including the
  host's copies of seed contracts (`coordinator.ts`, `message-queue.ts`, `model-roles.ts`,
  `skill-edits.ts`); nothing in the app imports `harness-seed/`.
- Renderer state is read only through the selector hooks in `renderer/state/hooks.ts`, and
  `localStorage` keys only through `renderer/storage.ts`. A large panel keeps its parts in a
  folder beside it (`panels/inspector/`, `panels/run-graph/`, `panels/stage/`, `panels/plugins/`,
  `panels/connectors/`); `App.tsx` keeps the shell's in `shell/`, `panels/ChatPanel.tsx` the
  chat's in `chat/`.
- `page/` is shipped into every served game page; it must not assume the game's code shape.
- Stage and panel controls expose `data-*` selectors listed in
  [the feature map](../docs/agent/feature-map.md); keep existing selectors and aria-labels
  stable because smoke runners use them.
- UI work follows [the design workflow](../docs/agent/design.md).
