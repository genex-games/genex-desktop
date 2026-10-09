# The studio contract — reference tables

`CLAUDE.md` carries the rules; this file carries the tables they point at.

## Projects with their own build

A folder the user brings may run differently — Vite, TypeScript, a bundler — and the studio does
not rewrite it. `studio.json` records that folder's shape, detected on first open and editable:

| Field | Meaning | Template value |
| --- | --- | --- |
| `main` | The game's real entry module — the main owner edits it, other facets wire into it | `src/main.js` |
| `build` | Shell command the studio runs (in the folder, or the facet's copy) before every preview | none |
| `entry` | The page the studio serves; with a build, inside its output. May carry a query the page reads (a Genex game gets `?genex_local_test=1`) | `index.html` |
| `bootMs` | How long the studio waits for the page to report itself ready before it looks anyway — 1000..60000, default 15000. Raise it for a game with a long asset load or a top-level `await`. The studio reads this field and never writes it | none (15000) |
| `game` | This game's kind and traits, declared once a run by the plan — a nested block, not the top-level `kind`, which is the project's SHAPE | none |

Every rule below then reads with `main` in place of `src/main.js`: the contract is installed from
the real entry, facets wire into its FACET WIRING block, and the game's own UI and input stay as
they are. A build that fails is a black screen for every critic — run it before you finish.

## `window.__studio`

`src/studio.js` installs it; a build that breaks it cannot be judged and is discarded.

The studio ATTACHES as well as installs. It serves the page itself, so its own code is on the
page before any game code runs: it owns `performance.now`, `Date.now` and `requestAnimationFrame`,
it seeds `Math.random`, it counts the draws, and it watches every renderer your `three` exports to
find the scene and the camera from the frames you actually draw. A game that calls none of this is
still stepped, seeded, photographed and inspected. Two consequences for any game:

- **The studio may pause your own loop and step it.** Keep state in variables the loop updates
  from its delta, never in the wall clock: with the clock frozen, `Date.now()` does not move
  between frames because the studio is what moves it.
- **Assigning `window.__studio` yourself keeps every method you defined** — the studio's object is
  a facade that fills in only what you did not supply, and never writes to yours.

A game whose `three` is inside its own bundle is out of the import map's reach, so the studio
cannot find the renderer by watching it. That game gets exactly two lines in its entry:
`import { installStudio } from "./studio.js"` and `installStudio({ renderer, player })`. Everything
else on this page is optional for it — `update`, `render`, `cameras`, `demos` and the HUD are the
template's, and a game that supplies none of them still answers `cameras()` with `["default"]`,
`inspect()` once a frame has been drawn (before that, `{ available: false, reason }`, and its
helpers throw the same reason) and `capture()` from the page. `player()` needs `x` plus one of
`y`/`z`; the axis you leave out is reported as 0, and `eyes()` needs it at all.

| Call | Meaning |
| --- | --- |
| `__studio.seed(n)` | Reseed and reset deterministically to the game's first screen — **and pause**, so the judge can step from a known frame. Same seed ⇒ same run. |
| `__studio.start()` / `pause()` / `begin()` | `start`/`pause` are the studio's clock, not your Start button: the loop runs and draws from load, menu included — never wait for `start()`. A title, menu or countdown is welcome as the first screen that starts on a key: give `config.begin` (from where `reset` leaves the game straight into play; synchronous, deterministic, no wall clock; `begin()` leaves it paused) and `config.flow` (a `FlowPhase` word; `state().flow = {phase, playing}`), and every judge drives from play; `reaches-play` checks `flow.playing` after `begin()`. |
| `__studio.step(dtMs)` | Advance by hand, independent of wall clock — used for scripted playthroughs. |
| `__studio.steer()` / `assist()` | **Racing games.** Pass `config.steer`: the steering a driver on your racing line would apply now, -1 full left … 1 full right — a pure read, called every frame while the assist is on. The evidence drive holds the throttle with `assist({ steer: true })`, which steers through the arrow and A/D keys in `ctx.keys` for the share of frames the line asks, so the car follows the road instead of the first wall (the playtester's `press_keys` has `autosteer`); without it the drive steers nothing. Report `race: { position, finished }` (1 = leading) from `probes()`: the harness check `throttle-bot-loses` races a bot that only holds the throttle — your line steering, never a brake — for up to six minutes, and it must not win. The drive also photographs the first corner it turns into (`drive:corner`, read off `player().yaw`). |
| `__studio.state()` | JSON snapshot: runtime timing and input state, plus probes for implemented mechanics. No score or entity counters are required for mechanics the game does not have. Keep it to what a player would notice: past 48 KB the studio cuts its largest lists whole and names them under `__cut`, and a check that reads inside a cut one goes unmeasured. |
| `__studio.debugCamera(name)` | Move to a named viewpoint so screenshots are comparable. `eye:spawn`, `eye:here`, `eye:down`, `eye:back` are built in (player-eye cameras the harness owns). |
| `__studio.demos()` / `demo(name)` | Scripted demonstrations (`config.demos`): each runs deterministically to its end state, which the critic photographs. |
| `__studio.capture()` | Return the frame as a data URL — the critic's screenshot path. Pass your renderer's canvas as `config.canvas`; never remove this method. |
| `__studio.hud` | **The template's only UI.** `text(id, str, {x,y,size,color,align})`, `bar(id, fraction, {x,y,w,h,color,back})`, `arc(id, {x,y,r,start,end,fraction,width,color,back,cap})` for gauges and rings, `panel(id, {x,y,w,h,radius,fill,stroke,width})`, `path(id, svgPathD, {x,y,w,h,viewBox,fill,stroke,width})`, `image(id, src, {x,y,w,h})` (from `assets/` or a data URL), `font(family, url)` for a bundled font, `crosshair({size,gap,thickness,color,visible,spread})`, `flash(color, alpha)`, `remove(id)`, `clear()`. `x`/`y` are frame fractions measured inward from `anchor` (nine points, default `"top-left"`); the lengths of arc, panel, path and image are fractions of the frame's height, so a circle stays round. Drawn into the canvas at the drawing buffer's resolution as one quad tagged `hud`; keep the middle of the view for the game. `state().hud` reports the first 64 ids, `count`, `coverage` (share of the frame), `overlaps` (items that run into each other; one sitting inside a larger one is a group) and `pending`, and the judges read the coverage; the harness-owned checks `no-dom-ui`, `single-hud`, `hud-coverage` (the kind's share of the frame) and `hud-overlap` ride on a game that declares a HUD. Screen-fixed information only: a name or marker over something in the world is a scene object attached to it. |
| `__studio.inspect()` | Read-only scene-graph helpers the `scene` checks run against: `meshes(tag)`, `objects(tag)`, `materials(tag)`, `lights()`, `renderTargets()`, `count(tag)`, `bbox(tag)`, `bboxOf(obj)`, `domUi()`, `hud()`, `untagged()`, `audio()`. `bbox()` returns `{min, max, size}` where each is `{x, y, z}` **and** index-addressable (`size.y === size[1]`). |
| `state().camera` | The named viewpoint the last `debugCamera()`/`eye()` placed — how a capture proves which camera it rendered. |
| `__studio.audio()` | RMS + spectral centroid from the `AnalyserNode` you pass as `config.audio`. A game about feel has sound: procedural WebAudio (oscillators, filtered noise — an engine from rpm and load, tyres, rain, music) is enough; create the `AudioContext` on the first key press or in `config.begin`, route it through that analyser, and give the player a mute key. |

**Pass `scene`, `renderer` and `camera` into `installStudio`**, plus a real `player: () => ({x, y, z, yaw})` when the game has one, so eye cameras and control checks work.

## Input — `ctx` inside `update()`

`studio.js` owns live input in the template. Read it from `ctx`, never from your own listeners and
never from a private look accumulator — the critic drives WASD, look and Mouse1 through the same
`ctx` a human uses.

| Member | What it holds |
| --- | --- |
| `ctx.keys` | A Set of held keys (`KeyW` / `w`, `Space`, …), **including mouse buttons as `Mouse1` (left), `Mouse2` (right), `Mouse3` (middle)** |
| `ctx.look` | `{x, y}` mouse pixels since the last step — the pointer-locked mouse, or the harness's injected look, the same accumulator |
| `ctx.wheel` | `{x, y}` wheel delta since the last step |
| `ctx.pointer` | `{x, y, locked}` normalised cursor position and whether the pointer is locked |

Report `yaw` from `player()`: `look-turns-camera` and `keys-move-player` read it.

## Tags: how checks find your work

Every object you add carries a tag: `mesh.userData.tag = "roof"`, a group's tag covering its
children. Checks are written against tags (`meshes("terrain").every(m => !m.material.transparent)`),
so an untagged object does not exist as far as the contract is concerned. Use the brief's tag names
and invent short lowercase ones for the rest (`ground`, `water`, `building`, `tree`, `prop`,
`light-key`). `hud` is reserved for the studio's overlay; first-person games tag `weapon`, `hands`,
`muzzle`, `sight`; characters tag `enemy` / `npc`. Each mechanic also gets a probe in `probes()`, a
camera that shows it, and — when the generic walk would never trigger it — a demo in `config.demos`
that plays it out deterministically and may return data its checks read.

## Renderers

Both WebGL and WebGPU are supported, without a default; the offline import map carries
`three/webgpu` and `three/tsl` alongside `three`. With the bundled Three 0.185.1,
`await renderer.init()` must finish before a WebGPURenderer's synchronous render, capture or step,
and a WebGPU `render` may return a promise (`renderer.renderAsync`) that capture awaits. A
WebGPURenderer can fall back to WebGL; the profiler reports its initialized backend. Do not convert
existing materials or renderers merely for profiling. With a post pass, capture
`renderer.info.render` **immediately after the world render** and report those numbers from
`probes()` — three resets the counters at the start of every `render()` call, so a later read
reports the composite quad (1 call / 2 triangles), not your scene.

## Optimization-stage observation

The studio installs a temporary, app-owned observer through `inspect()`. Return the actual
`renderer`, primary world `scene`, and `camera`; retain `seed`, `pause`, `step`, `start`, state,
cameras, demos, capture and input behavior. This works for custom runtimes as well as this starter,
and requires no new game state fields, live profiler UI or FPS overlay. World-call counters include
renderer-internal passes, exclude separately rendered HUD or postprocessing calls, and are not
total GPU time or memory; unknown counters and cached bundle coverage are reported as unavailable.
The observer does not change `state().fps` or simulation time, and adds nothing to exported source.

## Harness-owned modules

### Materials — `src/materials.js`

Everything baked on a canvas from a seed; a mesh with a plain
`MeshStandardMaterial` and no `map` reads as an untextured box from every camera.

| Call | What it gives |
| --- | --- |
| `bakeTexture({ kind, seed, size, palette, repeat })` | `{ map, roughnessMap, bumpMap }`, tileable, mean-normalised (attaching it does not change average brightness). Kinds: `wood`, `masonry`, `plaster`, `thatch`, `stone`, `moss`, `chitin`, `cloth`, `dirt`, `metal`. |
| `standardMaterial({ kind, seed, palette, … })` | A `MeshStandardMaterial` with all three maps attached. |
| `triplanar(material, { scale })` | World-space triplanar sampling of `map` for terrain and rocks — no UV stretch. |
| `weather(material, { dirt, moss, edgeWear })` | Grime from the bottom, moss on top, wear on edges, painted into the map. |
| `variant(baseColor, seed, spread)` | A per-instance tone of a colour — twenty houses, twenty tones. |
| `normalFromHeight(canvas)` | A normal map from the baked height canvas (`bakeTexture().heightCanvas`). |

### Assets — `assets/` and `src/assets.js`

`assets/<name>.glb` is committed with the game and
`assets/src/<name>.py` is the Blender script that made it. Write that script for the `blender` tool
when the studio offers it: it runs headless with `bpy`, `math` and `ASSET_NAME` in scope — build at
the origin, in metres, +Z up, give every mesh a material, do not export or save. The reply names
every mesh, its triangles and its material; use those names. Inspect mesh, texture and runtime costs; there is no universal 4 MiB model cap. Local Blender outputs, including renders, have a 100 MiB native-job resource limit. Preserve generated originals; optimize derivatives when useful. To import a model, pass it as the Blender tool's declared model input and read ASSET_INPUTS["model"], never an absolute path.

| Call | What it gives |
| --- | --- |
| `await loadAsset("dog", { tag: "dog", scale: 0.6, position: [x, y, z] })` | a fresh `THREE.Group` tagged `dog`; every mesh and material inside carries `userData.asset = "dog"` |
| `loadAsset("dog", { material: "cloth" })` | the same, with every untextured material given a baked `cloth` grain in the file's own colour |
| `loadAsset("gun", { material: (mesh, m) => mesh.name === "Barrel" ? steel : null })` | your material per mesh; `null` keeps the file's |
| `await preloadAssets(["dog", "cart"])` | parse several before the first frame, so checks never see a half-built world |
| `assetUrl("dog")` | `assets/dog.glb` |

### Foliage — `src/foliage.js`

Anything leafy is built from **alpha-tested leaf cards**, never a
solid: `makeTree({ height, spread, seed, kind: "broadleaf" | "needle", palette })` (tag `tree`,
sways with `swayTree`), `makeBush({ radius, seed })` (tag `bush`), `makeLog` / `makeLogPile`,
`leafSprite` + `foliageMaterial` for your own cards. The `flora.*` craft recipes carry the checks.
