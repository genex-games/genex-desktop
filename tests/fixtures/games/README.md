# Five games nobody wrote the studio's contract for

Every game the rest of this repository exercises was written by the studio, in the studio's own
shape: one `index.html` with the vendored import map, one `src/main.js` that calls
`installStudio`, one first-person player. That makes a whole class of failure invisible — the
studio can only be proved to run "any Three.js game" against games it did not write. These five
folders are those games. Each one is a real page a browser can open, in a shape somebody
actually ships, and none of them was written to be judged: they are here so that the shim, the
renderer hook, the readiness poll, the evidence pass and the checks are tested against code that
never heard of any of them.

## The five shapes

| folder | title | shape | edits | proves |
| --- | --- | --- | --- | --- |
| `inline-raf` | Sweep | one `index.html`, an inline module, its own `requestAnimationFrame` loop | none | the shim owns the clock for a page that never heard of the studio |
| `esm-addons` | Orbit Yard | ES modules, the five import-map keys, `three/addons`, an `EffectComposer` | none | addons resolve with no install; the judged frame is the composer's output |
| `bundled-ts` | Corridor | TypeScript bundled to `dist/`, `three` as a bare specifier inside the bundle | two lines | a bundled game attaches with `installStudio({ renderer, player })` |
| `menu-levels` | Two Rooms | DOM UI, a menu → level-select → level state machine, two scenes and two cameras | none | a title screen becomes ready, and the setup script walks it to the judged state |
| `webgpu-field` | Ion Field | `three/webgpu`, a top-level `await renderer.init()`, `setAnimationLoop` | none | the WebGPU backend is recognised everywhere `isWebGLRenderer` was the gate |

## The rules every fixture keeps

These are not style preferences. Each one is asserted by
`tests/conformance/shapes-fixtures.test.ts`, and a fixture that breaks one stops being evidence
of anything.

1. **No studio scaffold, and above all no `studio.json` carrying `contractVersion`.** That field
   plus the vendored import map is the one proof `detectProjectShape` reads to say "this folder
   is the studio's template". A fixture that carries it is testing the template again.
2. **No network.** Every bare specifier resolves through an import map to the copies the studio
   serves under `/vendor/`, or is bundled from the repo's own `node_modules`. There is no CDN
   tag, no `https://` import and no install step in any fixture.
3. **Every fixture carries an import map** with at least the `three` key, unless it is bundled.
   A no-build own-shape game with an unresolved bare specifier is a hard validation problem
   before its page ever loads, so it would prove nothing about the runtime.
4. **Under 300 lines and 12 KB per source file.** A fixture is read far more often than it is
   run.
5. **A `README.md` whose first paragraph says what the shape proves.** Adoption seeds `NOTES.md`
   from exactly that file (`GameWorkspaces#folderReadme`), so the paragraph is also a live check
   of that path.
6. **A `manifest.json`** (version 1) recording what the studio must answer about the folder:
   the shape `detectProjectShape` returns, the files adoption may and may not add, the kind and
   traits, the setup script, the cameras, and the state paths a play script must move.

## Adding a sixth shape

1. Make the folder, write the game, keep it under the caps and inside the rules above.
2. Write `README.md` — first paragraph, at least 200 characters, what this shape proves and
   nothing else.
3. Write `manifest.json`. `shape` must deep-equal what `detectProjectShape` answers; run the
   conformance test and paste in what it reports rather than guessing.
4. `addsAtLeast` is a **subset** relation and `neverAdded` a **must-not-contain** one, against
   `plannedWrites(dir, { template: false })`. Never write the template's whole file list into a
   fixture: it changes for reasons that have nothing to do with these shapes.
5. Only one fixture may declare `edits: "two-line-install"`. Everything else is `edits: "none"`,
   because a fixture that is "fixed" by adding `installStudio` stops being the thing under test.

## Deliberately unproven

These are decisions, not omissions. Each one costs more to fake than it would prove:

- **A real `vite.config` with a non-default `outDir`.** `bundled-ts` builds with esbuild from the
  repo's own `node_modules`, because Vite is not a dependency of this repository and installing
  one would open the network in a test. What the studio sees is identical either way — `kindOf`
  answers `three-vite` from three-in-dependencies plus a build script, `outputDir` answers
  `dist`, `packageCommands` answers `npm run build`. The `outDir`-reading branch of `outputDir`
  is covered by `project-shape.test.ts` instead.
- **A GLB asset load.** A binary asset in a fixture is a binary asset in the repository, and the
  loader path it would exercise is three's, not the studio's.
- **Physics.** No physics engine is vendored, and adding one would be an install.
- **A gamepad.** Chromium grants no gamepad to a hidden window, so the fixture could only test
  the studio's synthetic path against itself.
- **Other engines** — Phaser, plain canvas 2D, Unity and Godot exports. They are a different
  contract and a different milestone; `detectProjectShape` already names them, and refusing them
  early is the studio's whole answer for now.

## What `bundled-ts` does not build into

`bundled-ts` is checked in **without** `dist/`, and its `src/main.ts` imports `./studio.js`,
which exists only after the studio adopts the folder. That is deliberate in both directions: a
checked-in `dist/` would let the build path rot silently — which is the exact failure this
milestone exists to catch — and a fixture that builds standalone would not be proving that
adoption gives a bundled game a contract module it can import. The runner adopts the copy, links
the repo's `node_modules` into it (`manifest.needsNodeModules`), and only then builds.
