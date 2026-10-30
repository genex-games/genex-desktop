## Known artefact classes — scan every camera for each before you list defects

The look blockers — `[primitive]`, `[dark-viewmodel]`, `[crushed-shadow]`,
`[placeholder-particles]`, `[sky-contradicts]`, `[visible-tiling]`, `[not-shipped]`,
`[flat-material]`, `[stick-tree]`, `[slab-snow]`, `[art-source-mismatch]`, `[exposure-pump]`,
`[uncomfortable-camera]`, `[feature-off]`, `[broken-pose]`, `[incoherent-place]`, `[unreachable-zone]`,
`[no-exit]`, `[dead-end]` and `[unbounded]` — hold the work open: while one is on screen no facet is satisfied, no finish is done and the build does not
ship, whichever list you put it in. Tag each one you see; never soften one into polish.

Report a hit with its class name in square brackets, then what and where and which camera
(e.g. `[haze-plane] the lower metre of every crate is washed by a translucent horizontal
plane — eye:spawn`). A defect in a known class becomes the catalogue check for that class;
a defect outside the list is described in full.

- `[haze-plane]` translucent horizontal planes or additive bands cutting through geometry:
  objects look "filled with water" up to a line, a milky layer floats at a fixed height.
- `[light-cone]` visible volumetric cones, pyramids or "huts" over lamps.
- `[moire]` shimmer or stripes on fine repeating textures (ceilings, grilles, skies).
- `[floating]` props, characters or enemies hovering above or sunk into the floor.
- `[duplicate-overlay]` the same HUD element or readout drawn twice within one frame; overlapping
  or misaligned overlays. Never a difference between `user:view` and a canvas frame.
- `[hud-crowding]` HUD panels, gauges or readouts that claim a large share of the frame or the
  middle of the play view, or run into each other (the HUD line, when given, measures both).
- `[jagged-hud]` stair-stepped circles, arcs or diagonals in the HUD; pixelated gauges, icons or
  text — curves built out of rectangles, or drawn below the frame's resolution.
- `[primitive]` a weapon, prop, tree, pole, vehicle, building or character that is an untextured
  box, cylinder, capsule or stick with no silhouette: a tree that is a trunk with sticks, a car
  that is a box, a wall of flat panel blocks. Greybox left on screen is this class.
- `[dark-viewmodel]` {when: fps, first-person, shooter} the first-person hands, weapon or tool
  drawn unlit or as a black silhouette: no material, no light on it.
- `[crushed-shadow]` shadows crushed to pure black: no fill, no bounce, nothing readable inside
  them.
- `[placeholder-particles]` snow, rain, sparks, dust or smoke drawn as cubes or hard-edged quads
  with no soft edge.
- `[sky-contradicts]` a sky or light that contradicts the weather or time the ask names: a bright
  blue sky while it snows, noon sun in a scene asked for at night.
- `[visible-tiling]` a texture's repeat reads at play distance: the same stain, crack or patch in a
  grid across a floor, wall or ground.
- `[flat-material]` a prop, wall, floor or ground drawn in one flat colour: no albedo variation, no
  normal or roughness detail, so it reads as plastic or paint at any distance.
- `[stick-tree]` a tree or bush built from cones, cylinders or sticks: bare trunks with no twig
  mass, no leaf or needle cards, no light through the crown. Its leafless winter form still has
  twigs.
- `[slab-snow]` snow, sand or dust drawn as a separate box or slab laid on a bench, a lid, a roof
  or the ground: a hard white rectangle with straight edges instead of cover that follows the
  surface.
- `[art-source-mismatch]` the harness's own tag, never a judge's: a planned asset delivered from
  a lesser source than the art pass named.
- `[exposure-pump]` the harness's own tag, measured on `demo:doorway`: the exposure jumps or
  overshoots as the player crosses from light into dark.
- `[uncomfortable-camera]` the harness's own tag, measured on `demo:sprint-run`: the camera
  rolls, bobs or shakes past the comfort caps.
- `[feature-off]` the harness's own tag: a look feature (fog, a lit volume, shadows, bloom) the
  accepted build drew is switched off at the same preset.
- `[broken-pose]` a character whose body does not hold together in a frame or a `closeup:` camera:
  a torso sunk into the legs, arms folded into a knot, a limb stretched or bent backwards, feet
  sliding or floating, a hand off the weapon it holds, a low-resolution face.
- `[incoherent-place]` a place that does not make sense as a level, most visible on `map:top`:
  rooms with no way in or out, zones that do not connect, a corridor to nowhere, no entrance, no
  exit, nothing that keeps the player in the world.
- `[unreachable-zone]`, `[no-exit]`, `[dead-end]`, `[unbounded]` the harness's own tags, from the
  game's reachability report against its `docs/LEVEL.md`.
- `[no-hands]` {when: fps, first-person, shooter} a first-person view with no arms or hands holding the weapon or tool.
- `[noise-as-texture]` tiling noise standing in for a material.
- `[z-fight]` flickering or striped coplanar surfaces.
- `[blown]` highlights or light pools clipped to white; a washed-out frame with no black point.
- `[dead-input]` state that shows the scripted controls did nothing: the numbers the GAME line
  names as this game's input evidence are unchanged between the early state and the late one.
  Never report it when the GAME line says the class does not apply to this game.
- `[blob]` something organic — a tree canopy, a bush, hay, an animal, smoke — built as a smooth or
  faceted solid (sphere, icosahedron, capsule, lump) so it reads as a boulder, an egg or a loaf:
  no leaf silhouette, no light through it, no parts. A tree whose crown is a ball on a post is
  a `[blob]` whatever texture is on it.
