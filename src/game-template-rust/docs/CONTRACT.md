# The studio contract (Rust · wgpu)

What the studio relies on in this folder. `docs/GENEX_API.md` and its topic pages in `docs/api/` are the API the game's code is
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
| `docs/api/` | The reference's topic pages, read-only. |
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
| `input` | Inject a list of `actions`: keys, pointer, look, wheel, `text`, `gamepad` state or `touch` fingers; edges fire on the next tick. A `gamepad` action may name its `family` (`generic`, `xbox`, `playstation`, `nintendo`, `steam`) so a run without real pads shows that family's button labels; it never changes what a button does, and any other value refuses the whole list. |
| `capture` | Render a view of the world target (BGRA, the HUD painted in) into the run's `state/captures/` and answer its size and digest, and, once the game serves `renderSettings`, the `render` settings it was drawn with (preset, device class, where the settings came from, scale, settle frames). A frame that could not be drawn is refused with the renderer's code (`device-lost`, `upload-budget`, ...), never answered with an older picture. An optional `size` (`{width, height}`, whole pixels, each side 64 to 4096) draws it natively at that size; one outside that shape is refused `bad-argument`. An optional `lens` (`{depthOfField?, motionBlur?}`, booleans) draws the look's depth of field and motion blur, which a capture otherwise leaves out; another shape, or an ask a game without render settings cannot draw, is refused `bad-argument`. |
| `debugCamera` | Switch to a named camera or eye, or back to the game's own. |
| `cameras` | The registered camera names. |
| `eyes` | The registered eye names. |
| `demos` | The registered demo names. |
| `demo` | Run a demo by name and answer its value; the runtime is paused afterwards. |
| `audio` | Mute or unmute the game's sound with `{muted}`. Only the device goes quiet: the mix, its level and the simulation go on. |
| `audioLevel` | The loudness and brightness of what the game plays (`rms`, `centroid`), measured natively over the game's own mix before the mute, so a headless run measures it too. |
| `timing` | Frame, update and draw milliseconds, and the frames they cover. |
| `quit` | End the game cleanly. |
| `front` | Raise the game's window (a headless run answers `fronted: false`). |
| `visible` | Show or hide a window run. |
| `surface` | Embedded runs: create the shared-image ring Live draws from. |
| `release` | Embedded runs: give a finished frame slot back to the game. |
| `renderSettings` | Read the renderer's quality, or change it with `{set: {preset, deviceClass, features, renderScaleLock, frameBudgetMs}}`: a preset, an emulated device class (to see the game "as a phone"), feature switches, a render-scale lock and the frame time dynamic resolution holds (1-100 ms), for this session only. A game advertises it in its `ready` receipt (`renderSettingsApi`); until then it answers `unavailable`. An unknown preset, class or feature answers `unknown-preset`, `unknown-device-class` or `unknown-render-feature`; a scale lock outside 0.5 to 1 answers `invalid-render-scale` and a budget outside its range `invalid-frame-budget`; a member of the wrong type answers `bad-argument`. A change holds for the rest of the session: `{set: {preset: null, deviceClass: null, features: null, renderScaleLock: null, frameBudgetMs: null}}` gives the game's own settings back. |
| `bakeAssets` | Run one bake the game registered, `{kind, name}` with kind `nav` or `impostor` and a name of lowercase letters, digits, `-` and `_` (at most 64), into the run's `state/bakes/<kind>/<name>`, and answer the bake with its `bytes` and `digest`. The studio's build sends it to a headless run after a dev build; a game never calls it and an agent cannot send it. The output goes to the build's stage and the studio's cache, never into the game folder. Kind `nav` runs a `game.nav_bake`; a name the game did not register answers `unknown-bake`, an output past 256 MiB `bake-too-large` (nothing written), a bake the nav refuses its `nav-*` code, and kind `impostor` `unavailable` for now. The file is written through a staging file renamed onto it. A dev build's `ready` receipt lists the game's bakes as `bakes: [{kind, name}]`; an export answers `unknown-op`. |
| `profile` | The game's frame profile, `{action, frames?, mode?}`: `summary` (what `state().volatile.profile` holds), `report` (a `ProfileReport` v2 of the last `frames`, default 120, at most 240, with every kept hitch; at most 256 KiB, `truncated` past it), `arm` (`mode` `frame` or `nodes`: per-node GPU timing until `frame` again or 1,800 frames pass) or `trace` (a Chrome trace of the report window into the run's `state/profile/`, answering its `bytes` and `digest`). Dev builds only: an export (and the web build, which an export serves) answers `unknown-op`; a dev build whose runtime serves no profiles yet answers `unavailable`, and an argument outside its shape (an unknown action, `frames` not a whole number of at least 1, `arm` without a known `mode`) `bad-argument`. `frames` past 240 is clamped to 240. A trace is written as `state/profile/trace-<seq>.json` (the newest 8 kept) and answered with its `seq`, `bytes` and `digest`. |
| `saves` | The game's save slots, `{op, slot?, label?, envelope?}`: `list` (`{slots, bytes, quota}`), `read` (a slot's decoded envelope, or `{tooLarge, bytes, digest}` past 1,020 KiB), `write` (seed a slot with a fixture envelope, validated and migrated as a load is), `save` (optional `label`, at most 64 characters), `load` (answered once it applied: `{tick, checksum, checksumMatch}`; a differing checksum reports `save-restore-diverged`; `checksumMatch` is null while a streamed world's cells still build, and its check runs at the next tick) and `delete`. A slot name is lowercase letters, digits and `-`, at most 32 bytes, not starting with `-`. The studio refuses an argument out of shape `bad-argument` before it is sent; a game refuses with a `save-*` code and changes nothing; one that registered no saves answers `save-not-configured`; a build made before the verb answers `unknown-op`. |
| `uiSettings` | A session layer over the gameplay UI's settings, `{locale?, scale?, safeArea?, textSize?}`, applied at the next tick: a locale tag, a scale and text size in 0.5 to 3, safe-area insets `[left, top, right, bottom]` in world pixels (0 to 4096). A member left out stays, `null` gives the game's own back, no member reads. The studio refuses a member out of shape `bad-argument` before it is sent; a well-formed locale the game does not offer answers `text-locale-unknown`; a build made before the verb answers `unknown-op`. |
| `reloadAssets` | Swap asset files in a running dev game without a rebuild: `{files: [{path, digest}]}`, at most 256, each re-read on the next frame. Answers the `reloaded` paths, the `refused` ones with a code (`unsafe-path`, `digest-mismatch`, `missing`) and how many reloads are still `pending`; a settled capture waits for 0. The frame is drawn again at once, running or paused, so the next capture shows only the new bytes; a path outside the asset-path rule is refused `unsafe-path` without being read. A game still applying an earlier reload answers `busy`, a build that does not serve it yet `unavailable`, and an export `unknown-op`. A build that serves it says `reloadAssetsApi: 1` in its `ready` receipt. Bytes a reset already read stay in the world until the next `seed`. |

Besides its answers the game sends events on the same channel: `ready` once it runs, `starting`
for each finished boot step before that, `fatal` before it exits on an error, and `crash` with its
`genex-crash/1` record when it panics or loses its GPU device (a boot panic before `ready` too).
The studio reads each crash record as data: a malformed one ends the run `reply-invalid`, and so
does one naming a kind or a writer only the studio makes (`hang`, `process-exit`, a `source` other
than `game`). It keeps the run's last record in the game's `.studio/crashes/` (at most 32; the same
crash again is counted, not stored twice), and agents read them with `game.crashes`.

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
| `input` | The host `input` verb with its full argument, touches included. The shell sends real pads with their `Gamepad.id` (so the game can tell a pad's family) and, where the browser offers the keyboard's layout map, its key labels once as `layout`, for display only. |
| `injectInput` | The page shape of `input` for a play script: held keys, look and wheel deltas. |
| `debugCamera` | As the host verb. |
| `cameras` | As the host verb. |
| `eyes` | As the host verb. |
| `eye` | `debugCamera` for an eye. |
| `demos` | As the host verb. |
| `demo` | As the host verb. |
| `player` | The `player` hook's value, from `state()`. |
| `audio` | Mute with `{muted}`. With no argument, the game's level as `{available, rms, centroid}`: the web build's own mix before the mute, measured before the first click opens the device too. `available` is false for a build made before the level probe or a level the page could not read; its numbers then read 0 and are never judged. |
| `renderSettings` | As the host verb; a refusal comes back as `{__refused: code}`, which the studio reads as the host verb's refusal. |
| `profile` | The host `profile` verb through the page; a refusal comes back as `{__refused: code}` (the web build answers `unknown-op`). |
| `crashes` | The page's crash records, newest first (a promise): the game's `genex-crash/1` records (a panic, a lost device) and the shell's own (`wasm-trap` for a trap with no panic, `device-lost` when the game wrote none, `gpu-validation` for an uncaptured GPU error, not fatal), at most 16, kept in the browser's IndexedDB `genex-crashes:<game>` across reloads. Bound on every page, a failed boot's too. After a fatal crash the shell never calls the game's module again. |
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
| `unavailable` | The game knows the verb but this build cannot serve it yet (`renderSettings` before the renderer's settings, `bakeAssets` for kind `impostor`, `reloadAssets` before its runtime lands). |
| `busy` | The game is still applying an earlier `reloadAssets`: the studio asks again once it settles. |
