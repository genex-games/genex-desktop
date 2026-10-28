---
name: Look dev
description: Before any breadth, make one hero shot per area that passes against the references at ultra on desktop — scene recipe, light, materials, dressing, luma — and brief workers with the numbers.
facts: web-game
---

# Look dev

A game is judged on captures at `ultra` on a desktop, at 1600x900 or larger, lens off, beside the
references. Look-dev is the short stage that makes one shot per area pass that bar before anyone
builds breadth: an area that only exists is not a look.

## When

- After sourcing has delivered the area's hero assets (`asset-sourcing`), before mechanics fill
  the area with more of the same.
- Again when a brief or a person's message changes the place, the time of day or the weather.

## Steps

1. **Pick the scene type** of each area: interior day, interior night, exterior day, overcast and
   snow, rain, night street, forest, desert. In a Rust game folder its numbers are a block in
   `docs/look-recipes.md` and code in `docs/examples/looks/src/looks.rs`; tell the worker which
   block, and that it copies the block's `light` and `look` pair first.
2. **Place one hero camera** per area (a `named_camera`) where the person plays: the shot the
   judges compare with the references. Keep the camera, and name it in every brief for the area.
3. **Light before materials.** Sky and sun, the room's lights paired with their emissive
   fittings, one reflection probe and one irradiance volume per room, fog, exposure, then the
   grade. Never darken a room by stacking controls (negative compensation, a raised `ev_min`, a
   vignette, a dark grade): a dark room needs less light where it should be dark.
4. **Materials.** Every surface the camera comes within 10 m of is a scan with normal and ORM
   maps at `2k` (`4k` for a hero surface filling a desktop screen), at its real size, stochastic
   tiling and a macro variation on large areas, decals for wear.
5. **Dressing.** Hero props within 3 m of the path, mid dressing every 2 to 4 m, clutter between;
   no bare 4 m patch of floor or ground in the shot.
6. **Measure.** Capture the hero camera at `ultra`, lens off, then at `low` and as `mobile-mid`.
   The `ultra` capture's mean luma sits in the recipe's band (`docs/calibration.md`); `low` and the
   phone stay readable. Zoom into the nearest props: a flat colour, a cube edge or a stretched
   texel fails.
7. **Compare.** Put the capture beside each reference and write the largest gap first:
   silhouette, material, light, density. Fix that gap, capture again.

The area's look is done when its hero shot passes and none of the never-ship items below shows.

## Never ship

Each id is a defect a judge names; any one in a hero shot fails it.

`box-tree`, `slab-snow`, `block-furniture`, `flat-prop`, `scan-missing-maps`, `box-ground`,
`camera-over-comfort`, `camera-tick-noise`, `fov-out-of-range`, `stacked-darkening`,
`post-without-clean-tier`, `near-billboard`, `black-silhouette`, `cube-particles`. In a Rust game
folder `CLAUDE.md` (Art bar) says what each one is.

## Briefing a worker

Give numbers, never adjectives: the recipe block, the hero camera, the luma band, the map sizes,
the props to place and where, and the references to compare with. "Make it moodier" makes a black
room; "interior night block, lamps every 3 m, luma 45 to 85 at the hero camera" makes a scene.
Never cap textures or drop maps to protect a web boot or memory warning: those budgets are the
web's and phones', and the presets already shrink the picture for them.
