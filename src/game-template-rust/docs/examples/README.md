# Examples

Working code for this engine, compiled, run and captured with it by its own tests. Copy from it:
an example's folder is laid out like this game (`genex.toml`, `src/`), so its files drop in
where yours go. Keep your own title, and merge `genex.toml` switches rather than replacing yours.

| Example | What it shows | Read it for |
| --- | --- | --- |
| `docs/examples/interior-room/` | A classroom and a corridor: walls with window and door openings, CC0 scans at their real size in uneven, seeded panels of close variants (whitewash over a painted dado), a probe and a volume per room, fluorescent tubes paired with lights, decals, the low sun's shafts through the windows, fog and a grade last | any indoor scene, any "photoreal" brief |
| `docs/examples/interior-kit/` | A school corridor and classroom built from a modular interior kit: 2 m wall modules with real reveals, their dado coat and trims, windows with frames, sashes, broken glass and sunburst or barred grilles, doors, beams, fluorescent fittings, radiators, desks, chairs, lockers, a blackboard and rubble, each piece a small GLB drawn with a CC0 scan at its real size or the kit's trim sheet and props atlas, peeling-paint decals, a collider per solid part | the shell and dressing of a finished level (`docs/examples/rooms-and-buildings.md`) |
| `docs/examples/fps/` | An FPS facet set: mouse look, a chest camera with bob, a view model of forearms, gloves and a pistol built from parts, hitscan against Rapier colliders, recoil, and a rigged enemy with idle, walk, fire, hit and death | any first-person game (`docs/examples/fps.md` explains each part) |

## What each needs in `assets/`

The examples ship no scans; without them they draw stand-in colours, so they run as soon as they
are copied. Each `Scan` names the folder `cc0__fetch` lands in; if yours answers another path, use it.

- **interior-room**: `cc0__fetch` at `1k` from Poly Haven: `peeling_painted_wall`,
  `blue_plaster_wall` (the dado), `floor_tiles_06`, `concrete_wall_003`, `wood_table_worn`,
  `rusty_metal_02`. Three RGBA decals: `decals/grime-streaks.png`, `decals/poster.png`,
  `decals/stain.png` (an alpha shape on transparency; a decal without its texture is not drawn).
- **interior-kit**: copy its `assets/kit/` (1.4 MB: 42 GLBs of a few kilobytes each, the trim
  sheet, the props atlas and the decals, all made from CC0 scans) to your `assets/kit/`, and fetch
  the shell's scans at `1k` from Poly Haven: `painted_plaster_wall`, `blue_plaster_wall`,
  `concrete_wall_003`, `floor_tiles_06`. The kit ships ready because making it needs Local Blender
  and the scans its sheets are cut from; `interior_kit.py` remakes or adds a piece when the level
  needs one.
- **fps**: a rigged character at `characters/enemy.glb` with clips you rename in `CLIPS` (Uthana
  makes one from a generated model), and `decals/bullet-hole.png`. Its `studio.json` declares
  `"game": { "kind": "first-person", "hud": true, "mouseLook": true, "keyboardMove": true }`, so
  Live locks the pointer and the checks know how to drive it.

## How they are judged

The interior is built to be looked at on a desktop preset (`high` or `ultra`: volumetric shafts,
ambient occlusion, TAA). Look at it there, then check it stays readable at `low` and as a phone.
