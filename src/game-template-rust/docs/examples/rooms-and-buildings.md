# Rooms and buildings

How a room, a corridor or a building comes out looking built, not boxed. The renderer lights,
reflects and fogs a room by itself once it has the right pieces; what it cannot do is make box
panels with a stretched photo on each face read as walls. Work in this order and look at a capture
after each step.

1. **Greybox in code.** Boxes from `frame.cube_with`, sized in metres, with Rapier colliders from
   the same numbers. Play it until the layout works. Spend minutes here, not the run.
2. **Fetch the surfaces.** `cc0__search` then `cc0__fetch` for each surface: plaster or paint,
   floor, concrete, wood, metal; `2k` for walls and floors, which fill the screen, `1k` for the
   rest. Pick scans that read as the place (a Soviet school: whitewash, chipped oil paint, quarry
   tiles, parquet), a dado and a floor per room. Note each scan's real size (Poly Haven's pages
   give it; 2 to 4 m for walls and floors). A scan stretched over a 6 m wall reads as noise.
3. **Build the shell from the interior kit.** Copy `docs/examples/interior-kit/assets/kit/` to
   `assets/kit/` and lay the level out in 2 m modules as `docs/examples/interior-kit/src/game.rs`
   does: each module a shell piece (`wall`, `wall-window`, `wall-door`, the opening's sides its
   reveals) with its dado coat and trims on each painted face; windows dressed with frame, sill,
   sashes, glass and a grille; then beams, fittings, radiators, desks and rubble. Every piece's GLB
   has one material named for its role (`plaster`, `paint`, `concrete`, `trim`, `props`, `glass`,
   `tube`): draw it with `frame.model_with` and that role's material, a scan with `.with_world_uv`
   for the shell and coat, the kit's trim sheet for trims and its props atlas for props. The
   generated hero models in `hero/` (lockers, a wrecked car) bring their own materials: draw them
   with `frame.model`. For
   another module width, storey height or a piece the kit lacks (pipes, cornices, stairs), copy
   `interior_kit.py` to `assets/src/`, change or add a piece and run
   `blender__model {name: "<piece>", script: "assets/src/interior_kit.py"}`. Blender is +Z up: its
   (x, y, z) is the game's (x, z, -y).
4. **Colliders from the same plan.** The GLBs have no collision: give each module its solid boxes
   (a window's piers, the wall under its sill and over its head) as fixed Rapier cuboids, from the
   plan that draws it, so a player walks through the door and a shot leaves by the window.
5. **Sun and sky first, then lamps.** `Environment::sky()` and a low white sun that falls in at the
   windows; nothing outside may block it (a building across the yard must stay under the sun's
   elevation). Every glowing fitting is `Material::emissive` paired with a `spot_light` or
   `point_light`: emission alone lights nothing.
6. **A probe and a volume per room.** `ReflectionProbe` and `IrradianceVolume` on each room's
   inside box, `with_blend` the wall's thickness. Without them a closed room takes the sky's light
   through its walls and its floor mirrors the sky.
7. **Decals for wear.** `Decal::on_wall` and `Decal::on_ground`, never thin boxes. The kit's
   `decals/` hold peeling paint along an edge (`peel_edge`, under the dado rail and over the
   skirting) and in a patch, a crack, a leak for under a sill, grime for along a floor, a water
   stain for a ceiling, a lesson in chalk for the blackboard and four school posters; puddles and
   other posters are your own (`genex__asset` image, keyed as `kit_sheets.py` keys these).
8. **Fog thin, grade last.** Fog takes the sky's light, so indoors a dense fog glows milky in every
   corner; about `0.01` per metre still draws the sun's shafts at `high`. Then exposure, then the
   grade.

## No stretching, no repeat

A photo scan gives itself away two ways: stretched over a face bigger than the photo, or the
same photo tiled in a grid. Fix both, in this order.

- **Real size.** Give the scan's material `.with_world_uv(metres)` (the size one copy covers):
  every face of a kit piece or a box then shows it at that size, whatever its scale
  (`docs/api/lighting.md`).
- **No tile twice.** `.with_stochastic_tiling(true)` blends each scan from two copies at shifting
  offsets, and `.with_macro_variation(0.15, 3.0)` fades its colour in large patches, as wear does.
- **Uneven patches.** Cut a long surface into a few large patches at uneven widths (0.75 to 1.25
  of each other), so no seams line up into a grid; with world UVs a patch can be several copies wide.
- **Jitter each patch from a seed.** `.with_uv_jitter(seed)` per patch (and `.with_uv_rotation(..)` for plaster or concrete,
  never brick or wood). Take the
  randomness from a fixed seed (the reset `rng`, or `Pcg32::seeded`) so the layout is the same
  every run and every frame.
- **Close variants.** Mix one scan in two or three tints a shade apart (`Material::color(tint)`
  multiplies its colour map) panel by panel. Never mix two differently coloured scans panel by
  panel: it reads as a quilt. Give a second scan a zone of its own where a real building changes
  finish (a painted dado below whitewash, a tiled band, a different floor in the corridor), with
  a trim on the seam: the kit's dado coat and rail are that.
- **Decals last.** Scatter streaks, scuffs and stains from the same seed at uneven sizes, strengths
  and turns over walls and floors: they cover whatever repeat still shows.

`docs/examples/interior-room/` is steps 1, 2 and 5 to 8 in one file (its shell boxes in world-UV
patches, the stand-in for step 3); `docs/examples/interior-kit/` is every step on a corridor and a
classroom built from the kit. Clutter the kit lacks comes from `cc0__search` models first, then
`genex__asset` `model` with `auto-size`; a `blender__model` script makes kit pieces textured with
scans, never a prop the camera comes near.

A finished room shows its light in a capture at a desktop preset: sun patches on the floor with
the window bars' shadows, walls that bounce their colour, a floor that reflects the room, and
blacks in the corners away from the windows.
