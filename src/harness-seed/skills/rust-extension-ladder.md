---
name: Rust extension ladder
description: When a Rust · wgpu game needs more than the genex facade gives — which level to reach for, who decides, and how to read each typed refusal.
---

# The extension ladder for Rust games

A Rust game is written against the genex facade (`docs/GENEX_API.md` in the game folder). When
the brief needs more, climb one level at a time and stop at the lowest level that works. Every
level keeps what the studio relies on (captures, Live, seed determinism, Stop), and no level
loosens the sandbox.

| Level | What the game may do | Who decides |
| --- | --- | --- |
| 0 hooks | `on_reset`, `on_update`, `on_ui`, read-only draw and probe hooks, demos | you |
| 1 own modules | any safe Rust in `src/game.rs`, `src/facets/*.rs` and modules beside them | you |
| 2 WGSL | a `[[wgsl]]` source in `genex.toml` (material, post or pass), checked by naga against WebGPU core | you |
| 3 custom GPU passes | `game.gpu_pass(..)` through `genex::gpu`, safe Rust only | you |
| 4 crate requests | `request_crate` with one exact version and one sentence of why | the person approves |
| 5 eject | the engine copied into the game's `engine/`; a per-game trust flag for `unsafe` and build scripts | the person, in Studio |

## Rules

- Try the level below first, and say in your notes why it was not enough.
- Never ask for `unsafe` or a build script to get past a refusal: fix the code. Only the person
  trusts a game, in Studio's window; no tool, game file or `genex.toml` key can.
- Never eject on your own: you cannot. If a game truly needs its own engine, suggest it to the
  person in chat with the reason, and say that engine updates stop and that each new build must
  pass `check_conformance` before Live, capture and export.
- After an eject, `engine/` is the entry owner's code. Its `Cargo.toml` files are the studio's, so
  its build scripts never build, trusted or not. Never write or remove the `[engine]` row of
  `genex.toml`: the build checks it against the person's eject. Run `check_conformance` after
  every change there and fix the check it names; in a worktree, the evidence pass runs it itself.
- Rendering is per device: state the look and the per-class wishes in `genex.toml` `[render]` and
  never a fixed `ultra`, a resolution or a render scale. Before climbing to level 2 or 3, check
  that the built-ins cannot do it: the look (tonemapper, exposure, bloom, fog, ambient occlusion),
  `frame.point_light` and `frame.spot_light`, `Material::emissive`, `frame.environment` and the
  preset's shadows all reach a v2 material as they reach a built-in surface, and a custom pass
  that redraws one of them costs every device the effect twice.
- Author a visual change for `ultra` on desktop and judge it there first; before calling it done,
  also capture it under `renderSettings` `{set: {deviceClass: "mobile-mid"}}` and at `low`: a
  level-2 source or level-3 pass must stay readable there, and `state().volatile.render.degraded` says (by typed reason, never refusal) what a device
  gave up. Write level-2 sources and level-3 passes at v2 (`api = 2`): they draw linear,
  pre-exposed colour into the HDR scene before the look's tonemapper and read the frame's depth,
  normals, motion, environment and HDR scene by declared input (`RenderInputs`). A level-3 stage
  is `PassStage::BeforeCull`, `AfterPrepass`, `AfterOpaque`, `AfterTransparent`, `PostHdr` (a grade
  of your own, before the tonemap) or `Post`; a level-2 post pass runs on the display-ready frame
  after it. v1 work keeps running, but a v1 pass in the world or a v1 material holds the whole
  frame on the old LDR scene (listed in `degraded`). Under TAA a pass keys per-pixel noise to
  `frame_index` and projects markers with `unjittered_view_proj`; the details are in
  `docs/api/custom-materials.md`.
- After an eject the renderer is in `engine/genex-render` with its own `README.md`, and the
  conformance suite's two renderer rows, `render-presets` (every preset and the phone classes,
  one look on all, pinned captures) and `render-extensions` (no refused custom pass), run with
  `check_conformance` like the rest: a fork that breaks either names the check.
- Menus and saves never need a level above 0. The kit's `Menu`, `Dialog` and lists move by pad
  or keys, and each widget's key (`pause.save`) is in `state().hud.widgets`, so a check walks a
  menu by key. `game.saves(..)` with `ctx.slots()` saves and loads slots (`docs/api/saves.md`);
  never write a save format of your own with `ctx.save`. Prove a save works: save a slot, load
  it, then read `state().volatile.saves.lastLoad.checksumMatch`. False means some state a probe
  reads is in no save section.
- A switched-off system is never a reason to climb. Physics, sound, navigation, streaming and
  animation each have a `genex.toml` table with `enabled`; while it is false the system's calls
  are refused (`audio-disabled`, `nav-disabled`, `streaming-disabled`, `animation-disabled`) or,
  for Rapier, do not compile. Set `enabled = true` when the brief needs the system, and write none
  of your own.
- A recurring need (the same crate, the same eject reason across games) is a missing genex
  feature: say so in your summary.

## Reading a refusal

Read the code, never the words:

- `gpu-pass-invalid`: the pass named in `state().volatile.customPasses` failed its WGSL, layout or
  limits.
- `native-feature-missing`, `native-features-web`: a native-enhanced feature the device or the
  web does not have.
- `dependency-not-allowed`: a crate off the reviewed list; use the facade or `request_crate`.
- `crate-declined`, `crate-advisory`, `crate-licence`, `crate-banned`, `crate-build-script`,
  `crate-proc-macro`: the person or Genex's checks refused a requested crate; an advisory, a
  licence or a ban refuses it even after the person approved. A missing audit never refuses.
- `crate-unvetted`: from an older ledger; ask again with `request_crate`, as a missing audit no
  longer refuses.
- `crate-checker-unavailable`, `crate-check-failed`: Genex could not check the crate, so nothing
  was added and the request is still waiting; ask the person to approve it again (for the first,
  once Genex can install its checker).
- `crate-policy-tampered`: Genex's crate policy is not the shipped one, so nothing was added; tell
  the person.
- `unsafe-code`, `build-script-refused`: the game's own `unsafe` or build script while it is not
  trusted.
- `trust-person-only`: a game file claimed trust; remove the claim.
- `conformance-required`: an ejected game's build has no passing conformance run.
- `eject-target-exists`, `eject-source-tampered`, `eject-lock-missing`, `eject-needs-mac`: the
  person's eject changed nothing (`eject-needs-mac`: the suite judges the Mac build, so eject needs
  a Mac and macOS among the destinations).
