# The studio contract (Rust · wgpu)

What the studio relies on in this folder. `docs/GENEX_API.md` is the API the game's code is
written against; this page says which file is whose.

| File | What it is |
| --- | --- |
| `genex.toml` | The only build input: title, optional size and save name, extra crates from the reviewed list (or one the person approved through `request_crate`, pinned `=<version>`), WGSL extension sources (each with its extension `api`, 1 or 2), native GPU features, the `[render]` table (form factors, preset, look, per-class quality) and the `[web]` code budget. The studio writes the cargo manifest and lock from it. |
| `src/main.rs` | The entry: builds a `Game`, wires the starter and every facet, then `genex::install(game)`. Its FACET WIRING block is where other facets add their two lines. |
| `src/game.rs` | The world type (`World`) and the owner's hooks. |
| `src/facets/<slug>.rs` | One facet each: `pub fn wire(game: &mut Game<super::World>)`, its own state through `game.facet_state::<T>()`. |
| `assets/` | Models, textures and sounds the game loads, committed with it. |
| `web/shell.html` | The studio's page around the browser build. Not edited by the game. |
| `docs/GENEX_API.md` | The facade's reference, read-only. |
| `engine/` | Only after the person ejected the engine: the game's own copy of the genex crates, the entry owner's code. The studio writes its `Cargo.toml` files (so its build scripts never build, trusted or not) and the `[engine]` row of `genex.toml`; a build whose row differs from the person's eject is refused `engine-unrecorded`. |

A facet's only change to `src/main.rs` is inside the FACET WIRING block:

```rust
// ── FACET WIRING ── two lines per facet, nothing else
#[path = "facets/fishing.rs"] mod fishing;
fishing::wire(&mut game);
// ── END FACET WIRING ──
```

Parallel workers that each add a facet merge by keeping every line of the block, so a facet never
edits the lines around it. The studio builds the game offline with its own pinned toolchain and
vendored crates; a folder with a `Cargo.toml`, a `Cargo.lock`, a build script or cargo
configuration is refused before anything runs, and `unsafe` code fails the studio's build.

## Host verbs

The studio drives a running game with these verbs on its private channel (fd 3: `{id, op, arg}`
in, `{id, ok, result | error}` out). The game answers them through the facade; it never calls
one and cannot add one. A verb the game does not know answers `unknown-op`.

| Verb | What it does |
| --- | --- |
| `seed` | Rebuild the simulation from the seed (`W::default()`, each facet's state, an empty physics world, every `on_reset`) and pause. |
| `start` | Let ticks run. |
| `pause` | Stop ticks. |
| `step` | Run `max(1, round(ms / 16.667))` ticks, at most 36,000, and answer the frame, the simulated time, the ticks run and the draw calls. |
| `state` | Every probe plus the runtime's own keys (`frame`, `checksum`, `held`, `hud`, `__render`, ...), and on phones the app `lifecycle` and the `safeArea`. |
| `input` | Inject a list of `actions`: keys, pointer, look, wheel, `text`, `gamepad` state or `touch` fingers; edges fire on the next tick. |
| `capture` | Render a view of the world target (BGRA, the HUD painted in) into the run's `state/captures/` and answer its size and digest, and, once the game serves `renderSettings`, the `render` settings it was drawn with (preset, device class, where the settings came from, scale, settle frames). A frame that could not be drawn is refused with the renderer's code (`device-lost`, `upload-budget`, ...), never answered with an older picture. An optional `size` (`{width, height}`, whole pixels, each side 64 to 4096) draws it natively at that size; one outside that shape is refused `bad-argument`. An optional `lens` (`{depthOfField?, motionBlur?}`, booleans) draws the look's depth of field and motion blur, which a capture otherwise leaves out; another shape, or an ask a game without render settings cannot draw, is refused `bad-argument`. |
| `debugCamera` | Switch to a named camera or eye, or back to the game's own. |
| `cameras` | The registered camera names. |
| `eyes` | The registered eye names. |
| `demos` | The registered demo names. |
| `demo` | Run a demo by name and answer its value; the runtime is paused afterwards. |
| `audio` | Mute or unmute the game's sound with `{muted}`. |
| `audioLevel` | The loudness and brightness of what the game plays (`rms`, `centroid`), measured natively. |
| `timing` | Frame, update and draw milliseconds, and the frames they cover. |
| `quit` | End the game cleanly. |
| `front` | Raise the game's window (a headless run answers `fronted: false`). |
| `visible` | Show or hide a window run. |
| `surface` | Embedded runs: create the shared-image ring Live draws from. |
| `release` | Embedded runs: give a finished frame slot back to the game. |
| `renderSettings` | Read the renderer's quality, or change it with `{set: {preset, deviceClass, features, renderScaleLock, frameBudgetMs}}`: a preset, an emulated device class (to see the game "as a phone"), feature switches, a render-scale lock and the frame time dynamic resolution holds (1-100 ms), for this session only. A game advertises it in its `ready` receipt (`renderSettingsApi`); until then it answers `unavailable`. An unknown preset, class or feature answers `unknown-preset`, `unknown-device-class` or `unknown-render-feature`; a budget outside its range answers `invalid-frame-budget`. |

What the renderer runs with is in `state().volatile.render` (device class, preset, scale, feature
switches, `degraded` reasons, GPU and CPU milliseconds): outside the checksum and never compared.

## Page verbs

A game's web build binds the page contract on `window.__studio`, which the harness calls through
the preview. Each forwards to the host verb of its name, except the page shapes below.

| Verb | What it does |
| --- | --- |
| `version` | The page contract's version. |
| `seed` | As the host verb; answers the seed. |
| `start` | As the host verb. |
| `pause` | As the host verb. |
| `step` | As the host verb. |
| `state` | As the host verb. |
| `input` | The host `input` verb with its full argument, touches included. |
| `injectInput` | The page shape of `input` for a play script: held keys, look and wheel deltas. |
| `debugCamera` | As the host verb. |
| `cameras` | As the host verb. |
| `eyes` | As the host verb. |
| `eye` | `debugCamera` for an eye. |
| `demos` | As the host verb. |
| `demo` | As the host verb. |
| `player` | The `player` hook's value, from `state()`. |
| `audio` | Mute with `{muted}`; the web build does not measure a level. |
| `renderSettings` | As the host verb; a refusal comes back as `{__refused: code}`, which the studio reads as the host verb's refusal. |
| `capture` | Draw a view, read back the world target (never the canvas) and hand the picture to the studio. |
| `begin` | Not bound: the shell has no title flow to skip, so the call is refused and the harness presses the game's declared start keys or waits for play. |
| `assist` | Not bound: the shell has no steering assist, so the call is refused and the harness's drive holds the throttle with nothing steering. |

## GPU floor and tiers

Every destination (macOS, Windows, Linux, iOS, Android and the web) needs WebGPU core: an adapter
that offers the core limits, with compute shaders, storage buffers and indirect draws. The
`core` tier is the floor and is all a game gets unless it asks for more. `native-enhanced` adds
optional wgpu features a game names in `genex.toml` (`[gpu] native_features`, listed in
`docs/GENEX_API.md`); it is never a tier of its own, never requested unless declared, and not
available on the web. There is no WebGL or GLES path and no fallback renderer: a device without
the floor refuses with `gpu-unsupported` rather than rendering worse.

The `ready` receipt lists the extension APIs the game serves (`extensionApis` and
`customPassApis`, `[1, 2]` today). Version 2 draws on the HDR scene with reverse depth and adds
the custom pass stage `post-hdr`; version 1 sources and passes keep working, and a frame holding a
v1 material or a v1 pass inside the world is drawn LDR with standard depth instead, listed in
`state().volatile.render.degraded` as `material-v1-in-hdr` or `custom-pass-v1-in-world`. The
stage vocabulary also names `after-prepass` (version 2: after the depth/normal prepass, reading
its depth and normals); until the renderer draws that prepass, a pass registered there is
refused `gpu-pass-invalid`.

## Refusals

A run, a page or a probe that cannot continue says why with one of these typed codes. They are
data, never prose to match: read the code, then read the run's `problem`.

| Code | Meaning |
| --- | --- |
| `gpu-unsupported` | No adapter on a WebGPU-core backend, or one below the core limits: a native run ends with `fatal` of this reason. On the web, the designed "this game needs WebGPU" page. |
| `device-lost` | The GPU device was lost; the run re-creates it, and `capture` answers this meanwhile. Retry. A web page cannot re-create it: it flushes the saves and shows a card with this code (`GenexShell.status.state` is `failed`). |
| `gpu-hang` | A `step` or `capture` passed its deadline; the host took it for a GPU hang and ended the run. Known gap: on a Mac the system's GPU watchdog can end a frame stuck in a looping shader before that deadline, and such a frame is answered blank instead of refused. A capture that is suddenly black after a slow `ready` or `capture` points at a shader that never finishes. |
| `native-feature-missing` | The game declares a native-enhanced feature the device does not offer: the run ends with `fatal` of this reason (the device is opened with exactly the declared features). |
| `native-features-web` | A web build of a game that declares native-enhanced features: the web has none. |
| `gpu-pass-invalid` | A custom GPU pass failed validation: its WGSL, binding layout or limits. The pass is left out of every frame and listed in `state().volatile.customPasses` as `{name, stage, running: false, code}` (stage `before-cull`, `after-opaque`, `after-transparent`, `post`, `post-hdr` or `after-prepass`). |
| `build-failed` | The lane's build failed (clippy's `-D warnings` gate, `unsafe`, a refused determinism path or the compiler); the run's `problem` carries the first diagnostic. |
| `lane-missing` | No build lane exists for this stack in this build; nothing was built. |
| `conformance-required` | The game runs an ejected engine and this build has no passing conformance run: nothing started or was exported. Run `check_conformance` and fix the check it names. |
| `engine-unrecorded` | `genex.toml`'s `[engine]` row and the person's eject disagree (a row the person never made, or one removed or changed): nothing was built. Put the row back as the eject wrote it. |
| `ready-timeout` | The game did not announce itself within the start deadline: 20 s from its start or from the facade's last `starting` event (each finished boot step), at most 60 s in all. |
| `unresponsive` | The game stopped answering verbs. A verb asked while the game starts waits for its `ready`. |
| `memory-cap` | The game passed its memory cap. |
| `unknown-op` | The game has no such verb. |
| `unavailable` | The game knows the verb but this build cannot serve it yet (`renderSettings` before the renderer's settings). |
