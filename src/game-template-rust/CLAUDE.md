This is a Rust game on the studio's `genex` runtime (wgpu on WebGPU core, Rapier 3D physics, egui
for UI) for the destinations in `studio.json`: desktop, phones and the web, from one source. No
model was trained on this engine: these pages are all you know of it, so look a call up before you
write it. `docs/GENEX_API.md` indexes the API (one topic per page in `docs/api/`),
`docs/CONTRACT.md` says which file is whose, which verbs the studio drives the game with and what
each refusal means, `docs/look-recipes.md` gives the light and look of each scene type in numbers,
`docs/calibration.md` the units, exposure, luma, texel and frame-rate tables, and
`docs/examples/README.md` lists compiled code to copy. Before writing a Bevy, Unity, Unreal,
three.js or Godot habit, find its genex call in `docs/examples/coming-from.md`.

**Quality stance: author for `ultra` on desktop; check that `low` and phones stay readable.** The
presets scale the picture down for a smaller device; nothing scales a cheap picture up.

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
   edit `docs/GENEX_API.md`, `docs/api/` or `web/shell.html`. The build runs clippy: style and
   complexity lints only warn, but a determinism ban (`std::time`, `HashMap`, threads) fails it
   like a type error. `computer action=check` runs the same build check without a reload.
4. **One screen, one input path, phone first.** Draw all UI with egui in `on_ui` (the HUD is egui
   too). Read input only from `ctx` inside the hooks (`ctx.actions` for a game's own actions,
   `ctx.keys`, `ctx.touches`, `ctx.pointer`, `ctx.look`, `ctx.pads`, `ctx.text`). Touch is a
   first-class input: the mouse's first button arrives as touch 0, so write one touch path that
   also serves the desktop, keep tap targets large, and give every action a way to reach it
   without a keyboard.
5. **Tag and measure.** `frame.tag("<name>")` before what you draw, a `probe` per mechanic, a
   camera that shows it, a `demo` when a generic walk cannot reach it. The checks see the game only
   through these: a mechanic with no probe, tag or camera is unmeasured, and an unmeasured
   mechanic does not count as built. Three names the harness looks for: a
   `game.named_camera("hero:<area>", ..)` per area, the shot judged against `references/`; a
   `game.demo("sprint-run", ..)` in a first-person game, sprinting straight ahead for a few
   seconds; and a `game.demo("doorway", ..)` where rooms meet, walking from a lit room into a
   darker one. The harness measures camera comfort and exposure over time on those two demos.
6. **Deterministic.** Randomness only from `ctx.rng` or the reset `rng`; time only from `ctx.tick`
   and `ctx.dt`; transcendental math from `genex::math`; `genex::Map`/`genex::Set` instead of
   `HashMap`/`HashSet`; no `std::time`, threads or OS entropy. The studio's build refuses them.

Draw and probe hooks take `&Sim` and no `ctx`, and cannot change the simulation: animation that
exists only on screen derives from simulation state (a tick counter the world keeps from
`on_update`). Models come from `assets/` (`gfx.assets().model(..)`); `references/` is for you to
LOOK at. A studio run gives the game its own `state/` folder to save in, never this one. `target/`
is scratch: never committed, served or judged.

The game fills any window: `main.rs` sets `.fit(Fit::Expand)` and `genex.toml` `fit = "expand"`
(keep both alike). The 960x540 world stays whole and centred and the scene shows more past it on
the window's long side, so frame the camera for 16:9 and keep the HUD inside the world; use
`Fit::Letterbox` only for a fixed picture (`docs/api/ctx.md`). Every device must offer WebGPU core;
there is no WebGL path. A game that names a native-enhanced feature in `genex.toml` has no web
build, so add one only when the brief needs it. A web export over its code budget (4 MB of gzip
unless `genex.toml` `[web] wasm_budget_mb` raises it, at most 32) still exports but loads slower;
past 32 MB it is refused `wasm-over-budget`, and a budget outside 1..=32 is refused
`invalid-web-budget`. A system the game does not use stays switched off in `genex.toml`: this game
starts with `[nav]`, `[streaming]` and `[animation]` off (Game systems below). Every destination
shows a loading screen until the first lit frame; give it the game's look in `[render.loading]`
(`docs/api/loading-screen.md`), never draw your own. A multiplayer game follows `docs/api/net.md`.
When a run answers a refusal code (`gpu-unsupported`, `build-failed`, ...), read it in
`docs/CONTRACT.md` before changing code.

## Route the request

Find the brief's kind, read those pages, copy those examples, start from that look recipe, and
source its assets as the next table says. Several kinds mix (a horror FPS in a snowed school):
read each row.

| Kind | Read | Copy from `docs/examples/` | Look recipe | Assets first |
| --- | --- | --- | --- | --- |
| First-person shooter, bodycam | `docs/api/characters.md`, `docs/api/input.md`, `docs/api/animation.md`, `docs/examples/fps.md` | `fps/`, `fps-arms/`, `soldier/` | the place's (interior, street) | arms and weapon kit, rigged enemies (`genex__asset character`), props up close |
| Horror, stealth | as FPS, plus `docs/api/lighting.md` (local lights, fog) | `fps/`, `interior-kit/` | interior night | the kit, scans with normal and ORM, decals for wear |
| Third-person action, adventure | `docs/api/characters.md`, `docs/api/animation.md` | `third-person/` | the place's | rigged hero (`genex__asset character`), props |
| Interior, architecture, school, office | `docs/examples/rooms-and-buildings.md`, `docs/api/lighting.md` | `interior-kit/`, `interior-room/`, `looks/` | interior day or night | 2k scans per surface, kit pieces, hero props |
| Open world, exterior, town | `docs/api/terrain.md`, `docs/api/instance-groups.md`, `docs/api/streaming.md` | `looks/`, `crowd/` | exterior day, overcast and snow, rain, forest, desert | terrain layers from scans, CC0 or generated models, an HDRI or the sky |
| Night city, street | `docs/api/lighting.md`, `docs/api/particles.md` | `looks/` | night street | lamp and facade models, wet-surface scans |
| Racing, vehicles | `docs/api/physics.md`, `docs/api/terrain.md` | `looks/` (exterior) | exterior day | vehicle models (`genex__asset model`), track scans |
| Crowds, many agents | `docs/api/navigation.md`, `docs/api/instance-groups.md` | `crowd/` | the place's | rigged walkers, instanced props |
| Effects-heavy, combat | `docs/api/particles.md`, `docs/api/audio.md` | `explosion/` | the place's | flipbook atlases, sounds |
| Menus, saves, settings | `docs/api/ui.md`, `docs/api/settings.md`, `docs/api/saves.md` | `menus-saves/` | none | none |

Budgets per device class are in `docs/api/performance.md`; check them before adding content.

## Art bar

A brief that asks for a look (realistic, photoreal, AAA, beautiful, or an image in `references/`)
is judged on captures against it at `ultra` on desktop. Plan each area as a shot: hero assets near
the camera, mid-range dressing, ground cover and scatter (dense, varied, never one model in a
row), a sky and weather that agree with the brief, and a light mood from `docs/look-recipes.md`.
Compare every camera with `references/` and fix the largest gap first: silhouette, material,
light, density. A box may stand in while a mechanic is proved inside a round; replace it before
calling that facet done.

**Source by class.** Fetch or generate assets before building with them, and in parallel.

| Asset class | Route, best first | Never |
| --- | --- | --- |
| Hero prop, furniture, vehicle (seen within 10 m) | `cc0__search` a model, else `genex__asset` `model` with `auto-size` (and `face-limit` for a mid prop) | a cube or cone script, a flat-coloured `blender__model` |
| Character, creature, enemy | `genex__asset` `character` or `creature` (rigged, then `animate`) | a capsule or a mannequin |
| Weapon and first-person arms | `docs/examples/fps-arms/` kit, else `genex__asset` `model` | arms or a gun built from boxes |
| Walls, floors, ceilings, ground surfaces | `cc0__fetch` a scan at `2k` with its normal and ORM maps; `genex__asset` `texture` for a surface no scan has | a scan without normal and ORM, a 1k or smaller map on a near surface |
| Modular shell (walls with openings, trims, windows, doors) | `blender__model` kit script textured with scans (`docs/examples/interior-kit/`); Blender otherwise only finishes a heavy model (decimate, levels) | untextured modules, boxes with no reveals |
| Trees, bushes, foliage | a CC0 tree model (decimated, with its impostor); `genex__asset` `image` (transparent) for leaf and grass cards | a cone, sphere or box tree; one model cloned in a row |
| Ground across the world | one `Terrain` with scan layers (`docs/api/terrain.md`) | a box or a quad as outdoor ground |
| Snow, dust, moss on things | a terrain layer and the material's own map; snow falls as `Particles::snow(..)` | a slab or a thin box on top |
| Posters, grime, cracks, puddles | `frame.decal(..)` with a `genex__asset` `image` or CC0 decal | thin boxes over a surface |
| Sky and outdoor light | `Environment::sky()` with the recipe's sun, or a CC0 `.hdr` at 4k | a sky-dome texture on a sphere |
| Sounds | `genex__asset` `sfx`, or CC0 | silence for a mechanic that has sound |

**Never ship.** Each line names the check that refuses it; fix what it names.

- `box-tree`: a tree or bush made of cones, spheres or boxes.
- `slab-snow`: snow as a slab or box on the ground or on props.
- `block-furniture`: furniture or props built from cubes in code or a primitive-only script.
- `flat-prop`: an untextured, flat-coloured surface the camera comes within 10 m of.
- `scan-missing-maps`: a scan drawn without its normal and ORM maps, or below `2k` up close.
- `box-ground`: a box or a quad as the outdoor ground.
- `camera-over-comfort`: head bob over 2.8 cm, roll over 2 degrees or a step cadence over 2.8 Hz.
- `camera-tick-noise`: camera shake drawn fresh from `ctx.rng` every tick.
- `fov-out-of-range`: a first-person `fovy` (vertical, degrees) outside 60 to 80.
- `stacked-darkening`: a dark look made of negative compensation, a raised `ev_min`, a vignette
  and a dark grade together; a dark room needs less light, not every control turned down.
- `post-without-clean-tier`: a lens, grain or vignette pass with no way off in the settings.
- `near-billboard`: a flat card or impostor within 50 m of the camera.
- `black-silhouette`: hands, a weapon or a character that reads as a black shape; draw
  first-person parts between `frame.view_model()` and `frame.end_view_model()`.
- `cube-particles`: particles that read as cubes; use `Particles::snow(..)`, `Particles::dust(..)`.

## Assets

Models, textures and skies live in `assets/`. Studio imports each file when it lands and writes
what the game loads; `docs/api/assets.md`, `docs/api/drawing.md` and `docs/api/genex-toml.md`
hold the how.

- **The Genex Library first.** For a common surface, sky, prop, rock or tree, `library__search`
  (any word matches), then `library__add`: pre-processed CC0 entries at real size, within a
  triangle budget, with no import work. Read one in `on_reset` with `gfx.assets().library(id)`
  (`docs/api/library.md`; `docs/examples/library-yard/`).
- **CC0 at full quality.** `cc0__search`, then `cc0__fetch` at `2k` for anything the camera comes
  near, with every map the scan has (colour, normal, ORM); `4k` only for a hero surface that fills a
  desktop screen. Studio downloads it and records its licence in `genex-assets.lock`: never
  download a file, add a licence line or edit the lock yourself.
- **Read the import's facts.** The lock's rows name `issues` by code (`triangles-over-budget`,
  `albedo-out-of-range`, `usage-unknown`): fix the file, never the lock.
- **Say how a loose texture is used.** A loose image your code samples gets a `[[texture]]` row
  (`color`, `data` or `normal`); without one it ships uncompressed and
  `state().__render.assetIssues` names it `texture-uncompressed`. Keep images square, power of two.
- **Budgets are per destination.** Web 64 MB, phones 200 MB, desktop 2 GB (`[assets] budget_mb`);
  past 512 MB a web build is refused `assets-over-ceiling`. A web or phone budget never lowers the
  desktop picture: what the first frame does not need goes in an `[[asset_group]]`, and a slow web
  boot raises `studio.json` `bootMs` (1000 to 60000, default 15000). Never drop maps or shrink
  scans to pass a web warning.
- **Check a capture.** `state().__render.missingModels` absent, each texture in
  `__render.textures` with a compressed `family`, and `assetIssues` absent.

## Rendering

The renderer picks each device's quality itself (`docs/api/rendering.md`): you state the look,
never the quality.

- **Presets, not numbers.** Never hard-code `ultra`, a resolution, a render scale or an upscaling
  mode (a photo mode alone holds Native: `genex::render::lock_upscale`), and never read render
  settings in `on_update` or a probe. State the look in `genex.toml` `[render]`
  (`preset = "auto"`, `[render.look]`) and a per-device wish only in `[render.class.<class>]`.
  Offer the whole settings menu, `genex::settings::menu(ui)` (`docs/api/settings.md`): its
  Graphics tab is `genex::render::settings_panel(ui)`, which a menu of your own may show alone.
  The person's choice is saved per device, outside the simulation.
- **The look.** Frames are HDR. `khronos-neutral` (the default) keeps authored colours;
  `agx-punchy` (this template's) suits bright, high-contrast scenes; plain `agx` greys saturated
  lights. Exposure, fog and grade per scene type are in `docs/look-recipes.md`; bloom, fog,
  ambient occlusion and contact shadows are `[render.look]` keys, never custom passes.
- **Light with the built-ins.** `frame.sun`, `frame.ambient`, `frame.point_light` and
  `frame.spot_light` (each with the range it needs), `Material::emissive(color, strength)` for a
  glowing lamp or window (emission lights the picture, not other surfaces: pair it with a light),
  `frame.environment(Environment::sky())` outdoors or `Environment::hdri(path)` for a `.hdr` map.
- **Prefer built-ins to custom passes.** A custom material or pass is for what they cannot draw,
  written at `api = 2` (linear, pre-exposed colour; a grade of your own goes at `PostHdr`). A
  Level-3 pass is not fogged or lit by point or spot lights yet, and a custom material casts no
  shadow: keep ground and characters built-in or `api = 2` surfaces.
- **Temporal effects.** `high` and `ultra` draw TAA. Draw everything that moves on its own under
  `frame.id(key)` with a key that stays with it, end it with `frame.end_id()`, and call
  `frame.camera_cut()` on the frame a shot changes, never every frame.
- **Shadows scale themselves.** Never switch `shadows` off or fix a cascade count to save time:
  ask for more at one preset with
  `RenderConfig::shadows_at(QualityPreset::High, ShadowConfig::new().cascades(4))` and size the
  reach to the world with `[render.shadows] distance`. Meshlets stay off unless a measurement opts
  a class in (`docs/api/meshlets.md`).
- **Check low and a phone.** Call `renderSettings` with `{set: {deviceClass: "mobile-mid"}}`, then
  `{set: {preset: "low"}}`, and look at a capture each time: the game must stay readable and
  playable. Then give the game's own back:
  `{set: {preset: null, deviceClass: null, features: null, renderScaleLock: null, frameBudgetMs: null}}`.
  `state().volatile.render.degraded` names what a device gave up.

## World look

Build the look from the built-ins in this order and look at a capture after each step; start from
your scene's recipe in `docs/look-recipes.md` (`docs/api/lighting.md`, then `docs/api/grading.md`).

- **Sky and sun first.** `frame.environment(Environment::sky())` with a white sun whose elevation
  is the time of day. For night keep the sun and let it set: the stars come out, and
  `SkyParams::default().with_moon(Some(Moon::new([x, y, z])))` lights the ground. Snow and rain
  fall under `SkyParams::overcast()`; clouds are `Clouds::default().with_coverage(0.5)`.
- **Each room gets a probe and a volume.** Over each room, hall or courtyard declare
  `frame.reflection_probe(&ReflectionProbe::new(min, max).with_capture(eye))` and
  `frame.irradiance_volume(&IrradianceVolume::new(min, max))` on the same box, every frame.
- **Surfaces.** Posters, puddles and grime are `frame.decal(&Decal::on_wall(..))` or
  `Decal::on_ground(..)`; leaves, wax and skin take `.with_subsurface(Subsurface::LEAF)`.
- **Air.** Depth and mist are the look's fog: `fog_*` in `[render.look]`, or
  `RenderConfig::from_build().fog(Fog::default().with_density(0.02))`; `high` and `ultra` light it
  as a volume (`.with_volumetric(false)` keeps the plain height fog).
- **Exposure, then grade last.** Auto exposure with the recipe's compensation and curve; then
  `.grading(Grading::NEUTRAL.with_vibrance(1.1))` and `.temperature(0.3, 0.0)` on
  `RenderConfig::from_build()`. A grade never fixes light: a dark room needs a light, a probe or a
  volume.
- **Lens off in play.** `.depth_of_field(..)` and `.motion_blur(..)` suit cutscenes, photo modes
  and racers, never where the person steers.

## Rooms and buildings

A room is built, not boxed: `docs/examples/rooms-and-buildings.md` holds the order. Greybox in code
with Rapier colliders, fetch a scan per surface, then build the shell from a kit as
`docs/examples/interior-kit/` does (2 m modules with reveals, sills and trims), hero props from CC0
or `genex__asset`, scans at their real size with `.with_world_uv(metres)`,
`.with_stochastic_tiling(true)` and a macro variation, decals over the rest, then light it as
World look says.

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
  only for a child placed back at the screen edge. Give every game option's label key an `.ftl`
  line: a missing one reads as words and records `text-missing`.
- **A large world** streams in cells: `game.streaming(..)` (`docs/api/streaming.md`). A
  compiled cell pack is read with `genex::pack::CellPacks::from_table(ASSETS, "<folder>")`, and
  `genex::digest` hashes the game's own data: a game depends on `genex` alone. A level that loads
  an interior while playing requires its `[[asset_group]]` with `sim.stream.require("<group>")`
  and waits for `sim.stream.ready(ticket)`. On the web a required group and a pack's cells and
  terrain tiles around the player are fetched while playing (`state().volatile.webStream` lists
  the resident cells), so a streamed world plays in Web as in Native.
- **Moving things**: `game.navigation(..)` for walkers and paths (`docs/api/navigation.md`),
  `Character::spawn(..)` and ragdolls (`docs/api/characters.md`), `gfx.character(..)` with an
  `Animator` for rigged models (`docs/api/animation.md`). A character stands by its feet: spawn
  its capsule at the feet, draw the model at the capsule, never placed by its centre, and call
  `animator.plant_feet(..)` after `animator.update` so both feet meet uneven ground.
- **Physics**: crates, debris, a wrecking ball on a rope, a door on a hinge are Rapier bodies in
  `sim.physics`, built in `on_reset` and stepped by the runtime after `on_update`; never step it
  yourself. Draw each moving body in `on_draw` under its own `frame.id(..)`, save each body's pose
  and velocities in a section of its own, and probe each mechanic (`docs/api/physics.md`).
- **Far things**: imported models already have levels; `gfx.assets().compound(..)` keeps a
  tree's parts together and `.with_impostor(Impostor::hemi())` draws trees and buildings as
  cards past their last level, declared once in `on_reset`. A model only streamed cells draw
  bakes its card only if `wire` registers it with `game.impostor_bake(..)`; otherwise it keeps
  its last level, named `impostor-not-baked` (`docs/api/drawing.md`).
- **Sound**: switch `[audio]` on (the template ships it off), `gfx.sound(..)` in `on_reset`,
  `ctx.audio` to play; prove it played from `state().volatile.audio`, never by ear
  (`docs/api/audio.md`).
- **Ground** across the world is one `Terrain` made in `on_reset` and drawn with
  `frame.terrain(..)`; stand things on it with `terrain.height(x, z)` (`docs/api/terrain.md`).
- **Saves**: `game.saves(..)` and `ctx.slots()` (`docs/api/saves.md`). With `game.input` a slot
  keeps the input actions itself, so a load mid-hold replays exactly; a slot holds at most 61 game
  sections.
- **Multiplayer**: `game.net(..)` and `sim.net`; connect only after the player picks Play
  online, move yourself locally and rule on `.state_raw()`. Only the published draft in two
  windows proves online play (`docs/api/net.md`).
- **A hitch**: time the suspects with `genex::profile_scope!` and read `volatile.profile`
  on a native run; the web has none yet (`docs/api/profiling.md`). **A crash** leaves a record
  naming its line, seed and tick: give each `expect` the rule that broke and never catch a panic.

## Extension ladder

When the facade is not enough, climb one level at a time (hooks, own modules, WGSL, GPU passes,
`request_crate`, the person's eject) and stop at the lowest that works: `docs/CONTRACT.md`
(Extension ladder) holds each level, who decides, `check_conformance` and every refusal code.
