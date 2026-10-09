## Known artefact classes — scan every camera for each before you list defects

Report a hit with its class name in square brackets, then what and where and which camera
(e.g. `[haze-plane] the lower metre of every crate is washed by a translucent horizontal
plane — eye:spawn`). A defect in a known class becomes the catalogue check for that class;
a defect outside the list is described in full.

- `[haze-plane]` translucent horizontal planes or additive bands cutting through geometry:
  objects look "filled with water" up to a line, a milky layer floats at a fixed height.
- `[light-cone]` visible volumetric cones, pyramids or "huts" over lamps.
- `[moire]` shimmer or stripes on fine repeating textures (ceilings, grilles, skies).
- `[floating]` props, characters or enemies hovering above or sunk into the floor.
- `[duplicate-overlay]` the same HUD element or readout drawn twice; overlapping or misaligned
  overlays; a `user:view` frame showing UI the canvas frame lacks.
- `[hud-crowding]` HUD panels, gauges or readouts that claim a large share of the frame or the
  middle of the play view, or run into each other (the HUD line, when given, measures both).
- `[jagged-hud]` stair-stepped circles, arcs or diagonals in the HUD; pixelated gauges, icons or
  text — curves built out of rectangles, or drawn below the frame's resolution.
- `[primitive]` a weapon, prop or character that is an untextured box/capsule with no silhouette.
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
