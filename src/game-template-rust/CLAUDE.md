This is a Rust game on the studio's `genex` runtime (wgpu on WebGPU core, Rapier 3D physics, egui
for UI) for the destinations in `studio.json`: desktop, phones and the web, from one source.
`docs/GENEX_API.md` indexes the whole API it is written against (each topic is a page in
`docs/api/`), and `docs/CONTRACT.md` says which file is whose, which verbs the studio drives the
game with and which refusals a run can meet.

1. **Read `.studio/BRIEF.md` first when it exists.**
2. **Keep the studio contract.** `src/main.rs` ends `main` with `genex::install(game);`. A facet
   lives in `src/facets/<slug>.rs` with `pub fn wire(game: &mut Game<super::World>)`; non-owner
   facets touch `src/main.rs` only inside the FACET WIRING block, with exactly two lines:
   `#[path = "facets/<slug>.rs"] mod <slug>;` and `<slug>::wire(&mut game);`.
3. **Only the genex API, only the studio's build.** There is no `Cargo.toml`: the studio writes the
   manifest and the lock from `genex.toml`, which names the title and any extra crates from the
   reviewed list. A crate off that list is asked for with the `request_crate` tool (one exact
   version, and why); only the person approves it, and once approved it is named in `[crates]` at
   `=<version>`. Never add cargo files, build scripts, `unsafe`, or renderer internals, and never
   edit `docs/GENEX_API.md`, `docs/api/` or `web/shell.html`.
4. **One screen, one input path, phone first.** Draw all UI with egui in `on_ui` (the HUD is egui
   too). Read input only from `ctx` inside the hooks (`ctx.actions` for a game's own actions,
   `ctx.keys`, `ctx.touches`, `ctx.pointer`, `ctx.look`, `ctx.pads`, `ctx.text`). Touch is a
   first-class input: the mouse's first button arrives as touch 0, so write one touch path that
   also serves the desktop, keep tap targets large, and give every action a way to reach it
   without a keyboard.
5. **Tag and measure.** `frame.tag("<name>")` before what you draw, a `probe` per mechanic, a
   camera that shows it, a `demo` when a generic walk cannot reach it. The checks see the game only
   through these: a mechanic with no probe, tag or camera is unmeasured, and an unmeasured
   mechanic does not count as built.
6. **Deterministic.** Randomness only from `ctx.rng` or the reset `rng`; time only from `ctx.tick`
   and `ctx.dt`; transcendental math from `genex::math`; `genex::Map`/`genex::Set` instead of
   `HashMap`/`HashSet`; no `std::time`, threads or OS entropy. The studio's build refuses them.

Draw and probe hooks take `&Sim` and no `ctx`, and cannot change the simulation: animation that
exists only on screen derives from simulation state (a tick counter the world keeps from
`on_update`). Models come from `assets/`
(`gfx.assets().model(..)`); `references/` is for you to LOOK at. A studio run gives the game its
own `state/` folder to save in, never this one. `target/` is scratch: never committed, served or
judged.

Every device must offer WebGPU core; there is no WebGL path. A game that names a native-enhanced
feature in `genex.toml` has no web build, so add one only when the brief needs it. A web export
over its code budget (4 MB of gzip unless `genex.toml` `[web] wasm_budget_mb` raises it, at most
32) still exports but loads slower on phones; raise the budget only for a desktop-first brief.
Past 32 MB the export is refused `wasm-over-budget`, and a budget outside 1..=32 is refused
`invalid-web-budget`. A system the game does not use stays switched off in `genex.toml`, which
keeps the web build small: this game starts with `[nav]`, `[streaming]` and `[animation]` off, and
Game systems below names each switch and what a switched-off system answers.
Every destination shows a loading screen until the first lit frame; never draw your own. Give it
the game's look in `genex.toml` `[render.loading]` (title, `#rrggbb` background, accent and text, a
logo under `assets/`), as `docs/api/loading-screen.md` shows.
A multiplayer game follows `docs/api/net.md`: no network before the player picks online, Live
is a loopback room, and online play is proved only on the published draft in two windows.
When a run answers a refusal code (`gpu-unsupported`, `build-failed`, ...), read it in
`docs/CONTRACT.md` before changing code.

## Assets

Models, textures and skies live in `assets/`. Studio imports each file when it lands and writes
what the game loads; `docs/api/assets.md`, `docs/api/drawing.md` and `docs/api/genex-toml.md`
hold the how.

- **CC0 before making.** For a common prop, surface or sky, `cc0__search`, then `cc0__fetch` at
  `1k` (2k only for what fills the screen). Studio downloads it and records its licence in
  `genex-assets.lock`: never download a file, add a licence line or edit the lock yourself. A held
  curated pack answers why: take a Poly Haven or ambientCG asset instead.
- **Read the import's facts.** After a delivery the lock's rows name `issues` by code
  (`triangles-over-budget`, `albedo-out-of-range`, `usage-unknown`): fix the file, never the lock.
- **Say how a loose texture is used.** A texture a model's material samples needs nothing. A loose
  image your code samples gets a `[[texture]]` row (`color`, `data` or `normal`); without one it
  ships uncompressed and `state().__render.assetIssues` names it `texture-uncompressed`. Keep
  images square with a power-of-two side.
- **Fit the budgets.** Each destination has one (web 64 MB, phones 200 MB, desktop 2 GB): past it
  an export still ships but downloads slower, so prefer compressed, fewer and smaller files over
  raising `[assets] budget_mb`; past 512 MB a web build is refused `assets-over-ceiling`. What the
  first frame does not need goes in an `[[asset_group]]`, which a reset never reads.
- **Check a capture.** `state().__render.missingModels` absent, each texture in
  `__render.textures` with a compressed `family`, and `assetIssues` absent before calling assets
  done.

## Rendering

The game runs on devices from a high-end desktop to an older phone and a browser, and the
renderer picks each device's quality itself (`docs/api/rendering.md`): you state the look,
never the quality.

- **Presets, not numbers.** Never hard-code `ultra`, a resolution or a render scale, and never
  read render settings in `on_update` or a probe. State the look in `genex.toml` `[render]`
  (`preset = "auto"`, `[render.look]`) and a per-device wish only in `[render.class.<class>]`.
  Offer `genex::render::settings_panel(ui)` in an options menu: the person's choice is saved per
  device, outside the simulation. Make content cheap at `low` and let presets add to it.
- **The look.** Frames are HDR. `khronos-neutral` (the default) keeps authored colours;
  `agx-punchy` (this template's) suits bright, high-contrast scenes; plain `agx` greys saturated
  lights. Use `exposure = "auto"` (with `ev_compensation = 0.5` for a sunlit scene, under any
  curve) when light and shade sit together. Bloom, height fog, ambient occlusion and contact shadows are the look's and
  the preset's: set `bloom_*`, `fog_*`, `ao_*` and `contact_shadow_length` in `[render.look]`,
  never as custom passes.
- **Light with the built-ins.** `frame.sun`, `frame.ambient`, `frame.point_light` and
  `frame.spot_light` (each with the range it needs), `Material::emissive(color, strength)` for a
  glowing lamp or window (emission lights the picture, not other surfaces: pair it with a light),
  `frame.environment(Environment::sky())` outdoors (a white sun; the time of day is its elevation)
  or `Environment::hdri(path)` for a `.hdr` map in `assets/`. Keep `frame.ambient` and
  `frame.clear` sensible for devices that draw no sky, and retune `ev_compensation` against a
  capture after adding an environment.
- **Prefer built-ins to custom passes.** A custom material or pass is for what they cannot draw,
  written at `api = 2` (linear, pre-exposed colour; a grade of your own goes at `PostHdr`). A
  Level-3 pass is not fogged or lit by point or spot lights yet (it shadows itself from
  `gx_shadow_map`), and a custom material casts no shadow: keep ground and characters built-in
  or `api = 2` surfaces. v1 work in the world
  holds the whole frame on the old LDR scene.
- **Temporal effects.** `high` and `ultra` draw TAA. Draw everything that moves on its own (a
  character, an enemy, a vehicle) under `frame.id(key)` with a key that stays with it, end it with
  `frame.end_id()`, and call `frame.camera_cut()` on the frame a shot changes (a camera key, a
  respawn, a teleport), never every frame. In a shader key per-pixel noise to `frame_index`.
- **Shadows scale themselves.** Never switch `shadows` off or fix a cascade count to save time:
  ask for more at one preset with
  `RenderConfig::shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4))` and size the
  reach to the world with `[render.shadows] distance`.
- **Meshlets and occlusion** are off on every preset because they measured slower; opt in per
  class only on the game's own measurement (`docs/api/meshlets.md`).
- **Test as a phone.** Call `renderSettings` with `{set: {deviceClass: "mobile-mid"}}`, then
  `{set: {preset: "low"}}`, look at a capture each time and keep the game readable and playable
  at both before calling it done. A change holds for the session, so give the game's own back:
  `{set: {preset: null, deviceClass: null, features: null, renderScaleLock: null, frameBudgetMs: null}}`.
  `state().volatile.render.degraded` names what a device gave up.

## World look

The renderer lights, fogs and reflects the world itself; build its look from the built-ins in this
order and look at a capture after each step (`docs/api/lighting.md`, then
`docs/api/grading.md`).

- **Sky and sun first.** `frame.environment(Environment::sky())` with a white sun whose elevation
  is the time of day. For night keep the sun and let it set: the stars come out, and
  `SkyParams::default().with_moon(Some(Moon::new(direction)))` lights the ground. Clouds are
  `.with_clouds(Some(Clouds::default().with_coverage(0.5)))`, never sky-dome textures.
- **Each room gets a probe and a volume.** Over each room, hall or courtyard declare
  `frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(eye))` and
  `frame.irradiance_volume(&IrradianceVolume::new(min, max))` on the same box, every frame, so its
  floor reflects the room and its walls bounce their colour. Open ground needs neither.
- **Surfaces.** Posters, puddles and grime are `frame.decal(&Decal::on_wall(..))` or
  `Decal::on_ground(..)`, never thin boxes; leaves, wax and skin take
  `.with_subsurface(Subsurface::LEAF)` (or `WAX`, `SKIN`).
- **Air.** Depth and mist are the look's fog: `fog_*` in `[render.look]`, or
  `RenderConfig::from_build().fog(Fog::default().with_density(0.02))`; `high` and `ultra` light it as a
  volume with sun shafts (`.with_volumetric(false)` keeps the plain height fog). The near ground
  keeps its colour; never stack transparent planes for haze.
- **Grade last.** Exposure first, then the grade in code on top of `genex.toml`'s look:
  `game.render_settings(RenderConfig::from_build().grading(Grading::NEUTRAL.with_vibrance(1.1)))`
  (`RenderConfig::new()` would drop `[render]`), `.temperature(0.3, 0.0)` for warmth, a `.cube`
  LUT only for a strong look. A grade never fixes light: a dark room needs a light, a probe or a
  volume.
- **Lens off in play.** `.depth_of_field(..)` and `.motion_blur(..)` suit cutscenes, photo modes
  and racers, never where the person steers.

## Game systems

Use the built-in system before writing your own; each page holds the how and its refusals.
Five systems have a `genex.toml` switch (`docs/api/genex-toml.md`). A switched-off system leaves
its engine out of the build; facade calls still compile, but they are refused:

| Switch | Off means | Refused |
| --- | --- | --- |
| `[physics]` | no Rapier (a fifth of the web build); `sim.physics` is never stepped | code that reaches for Rapier does not compile |
| `[audio]` | no mixer or decoders | every sound is missing, `audio-disabled` |
| `[nav]` | no walkers or paths | `game.navigation` fails install, `nav-disabled` |
| `[streaming]` | no streamed cells | `game.streaming` fails install, `streaming-disabled` |
| `[animation]` | no rigs or animators | `gfx.character` and every animator, `animation-disabled` |

Set the table's `enabled = true` in the same change that first calls the system, and leave
off what the brief never uses. A `*-disabled` refusal means the switch is off: turn it on, never
write your own system around it.

- **Input**: name actions once with `game.input(ActionMap::new()..)` and read `ctx.actions`, so
  keys, pads and on-screen touch controls drive the same action; `controls_panel(ui)` rebinds,
  and a prompt's label is display text, never kept in the world (`docs/api/input.md`; raw
  keys, touches and pads are `docs/api/ctx.md`).
- **UI and settings**: text, locales and the kit's menus through `game.ui(..)` and `genex::ui`
  (`docs/api/ui.md`); the whole settings menu is `genex::settings::menu(ui)`
  (`docs/api/settings.md`). `on_ui` hooks already draw inside the safe area plus a 16 pt margin
  and at the player's text size, so add no edge margin of your own; `genex::ui::safe_area(ui)` is
  only for a child placed back at the screen edge (zero inside the hook's rect). Give every game
  option's label key an `.ftl` line: a missing one reads as words and records `text-missing`.
- **A large world** streams in cells: `game.streaming(..)` (`docs/api/streaming.md`). A
  compiled cell pack is read with `genex::pack::CellPacks::from_table(ASSETS, "<folder>")`, and
  `genex::digest` hashes the game's own data: a game depends on `genex` alone. A level that loads
  an interior while playing requires its `[[asset_group]]` with `sim.stream.require("<group>")`
  and waits for `sim.stream.ready(ticket)`. On the web a named group is not fetched yet, so a game
  with a web build loads what it needs up front.
- **Moving things**: `game.navigation(..)` for walkers and paths (`docs/api/navigation.md`),
  `Character::spawn(..)` and ragdolls (`docs/api/characters.md`), `gfx.character(..)` with an
  `Animator` for rigged models (`docs/api/animation.md`). A character stands by its feet: spawn
  its capsule at the feet, draw the model at the capsule, never placed by its centre, and call
  `animator.plant_feet(..)` after `animator.update` so both feet meet uneven ground
  (`docs/api/animation.md`).
- **Far things**: imported models already have levels; `gfx.assets().compound(..)` keeps a
  tree's parts together and `.with_impostor(Impostor::hemi())` draws trees and buildings as
  cards past their last level, declared once in `on_reset`. A model only streamed cells draw
  bakes its card only if `wire` registers it with `game.impostor_bake(..)`; otherwise it keeps
  its last level, named `impostor-not-baked` (`docs/api/drawing.md`).
- **Sound**: `gfx.sound(..)` in `on_reset`, `ctx.audio` to play; prove it played from
  `state().volatile.audio`, never by ear (`docs/api/audio.md`).
- **Ground** across the world is one `Terrain` made in `on_reset` and drawn with
  `frame.terrain(..)`; stand things on it with `terrain.height(x, z)` (`docs/api/terrain.md`).
- **Saves**: `game.saves(..)` and `ctx.slots()` (`docs/api/saves.md`). With `game.input` a slot
  keeps the input actions itself, so a load mid-hold replays exactly; a slot holds at most 61 game
  sections.
- **Multiplayer**: `game.net(..)` and `sim.net`; connect only after the player picks Play
  online, move yourself locally and rule on `.state_raw()`. Only the published draft in two
  windows proves online play (`docs/api/net.md`).
- **A hitch**: time the suspects with `genex::profile_scope!` and read `volatile.profile`
  (`docs/api/profiling.md`). **A crash** leaves a record naming its line, seed and tick: give
  each `expect` the rule that broke and never catch a panic.

## Extension ladder

When the brief needs more than the facade gives, climb one level at a time and stop at the lowest
level that works. Every level keeps captures, Live, determinism and Stop working, and none loosens
the sandbox.

0. **Hooks**: `on_reset`, `on_update`, `on_ui`, the draw and probe hooks, demos.
1. **Your own modules**: any safe Rust in `src/game.rs`, `src/facets/` and modules beside them,
   against the genex API and the reviewed crates.
2. **WGSL**: a `[[wgsl]]` source in `genex.toml`, checked by naga against WebGPU core.
3. **Custom GPU passes**: `game.gpu_pass(..)` through `genex::gpu` (`docs/api/gpu-passes.md`).
4. **Crate requests**: the `request_crate` tool; only the person approves.
5. **Eject**: only the person copies the engine into this folder's `engine/`, and only the person
   sets the game's trust flag for `unsafe` and build scripts, both in Studio's window. You may
   suggest either in chat with the reason; never ask for `unsafe` or a build script to get past a
   refusal. After an eject, `engine/` is the entry owner's code (its `Cargo.toml` files are the
   studio's, so its build scripts never build, trusted or not), engine updates stop, and Live,
   capture and export wait until the current build passes the `check_conformance` tool: run it
   after every `engine/` change. Never write or remove the `[engine]` row in `genex.toml`: only
   the person's eject does, and a build whose row differs from it is refused.

A refusal names its level. Read the code, not the words:

| Code | What to do |
| --- | --- |
| `gpu-pass-invalid` | Fix the pass the code names in `state().volatile.customPasses` (its WGSL, layout or limits). |
| `native-feature-missing`, `native-features-web` | Drop the native feature, or keep it and accept no web build and fewer devices. |
| `dependency-not-allowed` | Use the facade or a reviewed crate, or ask with `request_crate`. |
| `crate-declined`, `crate-advisory`, `crate-licence`, `crate-banned`, `crate-build-script`, `crate-proc-macro` | The person or Genex's checks refused the crate (an advisory, a licence or a ban refuses even an approved one): build it from the facade instead. |
| `crate-unvetted` | From an older ledger: ask for the crate again with `request_crate`; a missing audit no longer refuses. |
| `crate-checker-unavailable`, `crate-check-failed` | Genex could not check the crate, so nothing was added and the request is still waiting: ask the person to approve it again (once Genex can install its checker, for the first). |
| `crate-policy-tampered` | Genex's crate policy is not the shipped one, so nothing was added: tell the person what the code says. |
| `unsafe-code`, `build-script-refused` | Remove the `unsafe` block or the build script; only the person can trust a game. |
| `trust-person-only` | A game file or `genex.toml` claimed trust: remove the claim. |
| `conformance-required` | Run `check_conformance` and fix the check it names, then try again. |
| `eject-target-exists`, `eject-source-tampered`, `eject-lock-missing`, `eject-needs-mac` | The person's eject did nothing; tell them what the code says. |
