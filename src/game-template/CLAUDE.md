# Game workspace

You are building a game inside Genex as a contractor. This project starts empty:
`src/main.js` boots a renderer and the studio instrumentation, nothing more — no default game,
player, ground, HUD or loop to preserve. Build the scene and mechanics from the brief, choose that
game's controls and viewpoints, replace `phase: "empty"`. Five rules; tables in `docs/CONTRACT.md`.

1. **In a build, read `.studio/BRIEF.md` first when it exists.** This iteration's contract: the checks,
   the scoreboard, the losing attempts, the reference distance, the recipes; identity first. Never edit
   another's module: `docs/MODULE-CONTRACT.md` and a game's own `docs/ARCHITECTURE.md` name owners and APIs.
2. **Keep `window.__studio` working.** `installStudio({ scene, renderer, camera, player, … })`
   from `src/studio.js` — never remove a method. A build the harness cannot inspect is a loss.
3. **One screen, one input path.** All UI is `__studio.hud` in the canvas: text, bars, arcs, paths, images, panels,
   fonts at frame-fraction anchors, the middle kept for play (coverage and overlap are measured); no DOM, no second HUD or canvas; names are scene sprites; input from `ctx.keys`/`ctx.look`/`ctx.wheel` in `update()`.
4. **Tag everything, make it measurable.** Tag every object (`userData.tag`), a camera per mechanic; probes
   report what a player notices, `state()` stays small, `config.demos` reach what the walk cannot. The game
   opens on its title, starts on a key and MUST declare `config.begin`/`config.flow`, or judges see the title. A racer also gives `config.steer` (its racing line, -1…1) and reports `race: {position, finished}`.
5. **Deterministic, textured, modelled.** Randomness only from the `rng` in `update()` or a
   generator seeded in `reset(seed)`; time only from `dt`. `references/` is for you to LOOK at.
   Materials come from `src/materials.js` and foliage from `src/foliage.js`. Use procedural geometry,
   imports or enabled asset tools for silhouettes. Optional tools/skills come from Studio’s current
   registry: load their returned files and verify use in the preview. A flat colour with no map is
   a defect; a sphere canopy a `[blob]`; a box for a gun a `[primitive]`.

Three lessons every facet re-learned: non-owner facets touch `src/main.js` only inside the `FACET
WIRING` block (one import, one init line — the harness union-merges it, anything else conflicts);
before re-tuning lighting or fog, capture what the base already draws; and a check that cannot pass
as written is not yours to force — write a `HARNESS:` line naming the id and why in
`docs/notes/NOTES.<facet-id>.md` (`NOTES.md` in a chat build, read back next time). A facet's
`## Fixed by looking` bullets become lessons Studio adds to later briefs or lists in Activity.
