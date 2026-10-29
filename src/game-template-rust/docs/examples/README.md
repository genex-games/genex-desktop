# Examples

Working code for this engine, compiled, run and captured with it by its own tests. Copy from it:
an example's folder is laid out like this game (`genex.toml`, `src/`), so its files drop in
where yours go. Keep your own title, and merge `genex.toml` switches rather than replacing yours.

| Example | What it shows | Read it for |
| --- | --- | --- |
| `docs/examples/interior-room/` | A classroom and a corridor: walls with window and door openings, CC0 scans at their real size in uneven, seeded panels of close variants (whitewash over a painted dado), a probe and a volume per room, fluorescent tubes paired with lights, decals, the low sun's shafts through the windows, fog and a grade last | any indoor scene, any "photoreal" brief |
| `docs/examples/interior-kit/` | A school corridor and classroom built from a modular interior kit: 2 m wall modules with real reveals, their dado coat and trims, windows with frames, sashes, broken glass and sunburst or barred grilles, doors, beams, fluorescent fittings, radiators, desks, chairs, a blackboard and rubble, each piece a small GLB drawn with a CC0 scan at its real size or the kit's trim sheet and props atlas, 2k scans per room, generated hero lockers and a wrecked car, photographic decals (peeling paint, leaks, posters, chalk), a collider per solid part | the shell and dressing of a finished level (`docs/examples/rooms-and-buildings.md`) |
| `docs/examples/library-yard/` | A yard dressed entirely from the Genex Library: asphalt, snow and brick materials at their real size, a bench, a barrel and a crate, under an HDRI sky, each read in `on_reset` with `gfx.assets().library(id)`, with stand-ins and the missing ids probed when an entry was not added | any common surface, sky or prop before sourcing or modelling it (`docs/api/library.md`) |
| `docs/examples/fps/` | An FPS facet set: mouse look, a chest camera with bob, a view model of forearms, gloves and a pistol built from parts, hitscan against Rapier colliders, recoil, and a rigged enemy with idle, walk, fire, hit and death | any first-person game (`docs/examples/fps.md` explains each part) |
| `docs/examples/coming-from.md` | Bevy, Unity, Unreal, three.js and Godot calls mapped to the genex call and the page that teaches it, after the five biggest differences | any habit from another engine, before you guess a name |
| `docs/examples/fps-arms/` | The first-person arms kit: gloved arms on an AK-pattern rifle as one rigged GLB (`fps-arms.glb`, made by `fps_arms.py`), whose magazine, charging handle and trigger are bones, played by an animator from the rifle's rules: hip, walk, sprint, sights, fire, dry fire, a reload that takes the magazine out, inspect | the arms and gun of any first-person shooter (`docs/examples/fps-arms/README.md`) |
| `docs/examples/third-person/` | A third-person hero: a rigged character on a Rapier capsule walked along the camera's ground directions and turned to face its walk, an orbit camera on mouse, stick or a dragged finger, a boom that pulls in when a pillar comes behind the hero, and an animator graph with idle, walk and run on a `speed` parameter and a slash on the upper body over the legs, with its `hit` event | any third-person, action or adventure game |
| `docs/examples/crowd/` | A crowd on a nav mesh: 120 walkers wander a walled market square, each a nav agent driving its own sensor capsule through the documented loop, sent to the least busy stall near the last, animated at their ground speed; 240 trees round the walls as two retained instance groups; a camera that draws the nav mesh | townsfolk, shoppers, zombies, any many-agent scene, and many things that stand still |
| `docs/examples/explosion/` | An explosion on one tick: an emissive fireball that swells and dies, fire, sparks that fall and bounce, a smoke cloud that thins out, a point light's flash, the bang played where it happened, a radial impulse that throws Rapier crates, and a camera shake, all drawn from the blast's age | any burst effect (a grenade, a spell, a hit, a pickup) with sound and shake |
| `docs/examples/menus-saves/` | Menus and save slots: a title menu (Continue, New game, Load, Settings), a pause menu, a quit confirm, slot lists that save and load the whole world, an autosave ring, the facade's settings menu and a toast per slot event, all from the kit's menus so keys, a pad and a tap walk them; a HUD with a health bar and the buttons a phone plays with | any game with a title screen, a pause menu or saving |
| `docs/examples/soldier/` | The soldier kit: a rigged soldier in combat gear holding the arms kit's rifle (`soldier.glb`, made by `soldier.py` from Quaternius' CC0 animation library), animated from a remote player's replicated state alone: gaits from the velocity, an aim layer along the pitch, fire, reload, hits by side and death, framed close by the game camera | enemies and remote players in any shooter (`docs/examples/soldier/README.md`) |

## Building blocks

What a game is usually made of, and where working code for each is. A gap has no example yet: build
it from the reference page named, and look at a capture after each step.

| Block | Example | Reference |
| --- | --- | --- |
| Interior, architecture | `interior-room/`, `interior-kit/` (`rooms-and-buildings.md`) | `docs/api/lighting.md` |
| Outdoor terrain and nature | gap: `crowd/` stands trees as instance groups and the yards are open ground under a sky, but no example shapes terrain, water or foliage | `docs/api/terrain.md`, `docs/api/water.md`, `docs/api/instance-groups.md` |
| Rigged characters, animation | `third-person/` (a graph with a masked layer and an event), `fps/` (an enemy's graph with one-shot clips), `crowd/` (simple animators at ground speed), `fps-arms/` (a weapon rig), `soldier/` (gaits from velocity, an aim layer, hits, death) | `docs/api/animation.md` |
| First-person controller and weapon | `fps/`, `fps-arms/` | `docs/api/characters.md`, `docs/api/input.md` |
| Third-person controller and camera | `third-person/` | `docs/api/characters.md` |
| Vehicle | gap | `docs/api/physics.md` |
| Crowds, many entities | `crowd/` (agents that move every tick, things that never move) | `docs/api/navigation.md`, `docs/api/instance-groups.md` |
| UI, menus, saves | `menus-saves/` (menus, slots, settings, toasts, a HUD), `fps/` (a shooter's HUD) | `docs/api/ui.md`, `docs/api/settings.md`, `docs/api/saves.md` |
| VFX, particles | `explosion/` (fire, sparks, smoke, a flash), `fps/` (a muzzle flash with its light, bullet-hole decals) | `docs/api/particles.md` |
| Audio | `explosion/` (one sound played at a place) | `docs/api/audio.md` |
| Multiplayer | gap | `docs/api/net.md` |
| Streaming a big world | gap | `docs/api/streaming.md` |

## What each needs in `assets/`

The examples ship no scans; without them they draw stand-in colours, so they run as soon as they
are copied. Each `Scan` names the folder `cc0__fetch` lands in; if yours answers another path, use it.
The interior kit and the arms kit ship their own GLBs.

- **interior-room**: `cc0__fetch` at `1k` from Poly Haven: `peeling_painted_wall`,
  `blue_plaster_wall` (the dado), `floor_tiles_06`, `concrete_wall_003`, `wood_table_worn`,
  `rusty_metal_02`. Three RGBA decals: `decals/grime-streaks.png`, `decals/poster.png`,
  `decals/stain.png` (an alpha shape on transparency; a decal without its texture is not drawn).
- **library-yard**: `library__add` each of `material/asphalt_01`, `material/red_brick`,
  `material/snow_02`, `model/painted_wooden_bench`, `model/barrel_01`, `model/wooden_crate_01` and
  `sky/kloofendal_48d_partly_cloudy_puresky`; without one the yard draws its stand-in and
  `state().library.missing` names it.
- **interior-kit**: copy its `assets/kit/` (15 MB: 42 GLBs of a few kilobytes each, 2k trim and
  props sheets cut from CC0 scans, photographic decals for wear, posters and chalk, and two
  generated hero models, `hero/lockers.glb` and `hero/car-shell.glb`) to your `assets/kit/`, and
  fetch the shell's scans at `2k` from Poly Haven (walls and floors fill the screen):
  `preconcrete_wall_001` (whitewash), `blue_plaster_weathered` and `painted_concrete` (the two
  dados), `concrete_wall_003`, `dirty_tiles` and `herringbone_parquet`. The kit ships ready because
  making it needs Local Blender, the scans its sheets are cut from and the generations its decals
  and heroes come from; `interior_kit.py` remakes or adds a piece when the level needs one. Studio's
  import compresses every texture when the folder lands.
- **fps-arms**: `fps-arms.glb` from this folder copied to `kits/fps-arms.glb`; without it the view
  model is left out and its probe says `"kit": false`. Its `studio.json` declares the same traits
  as the FPS set's.
- **soldier**: `soldier.glb` from this folder copied to `kits/soldier.glb`; without it the soldier is
  left out and its probe says `"kit": false`.
- **fps**: a rigged character at `characters/enemy.glb` with clips you rename in `CLIPS` (Uthana
  makes one from a generated model), and `decals/bullet-hole.png`. Its `studio.json` declares
  `"game": { "kind": "first-person", "hud": true, "mouseLook": true, "keyboardMove": true }`, so
  Live locks the pointer and the checks know how to drive it.
- **third-person**: a rigged character at `characters/hero.glb` with clips you rename in `CLIPS`
  (idle, walk, run and a one-shot attack; Uthana makes one from a generated model). Without it the
  hero is a stand-in block and the `hero` probe's `anim` is null. Its `studio.json` declares
  `"game": { "kind": "third-person", "hud": true, "mouseLook": true, "keyboardMove": true }`.
- **crowd**: optionally a rigged character at `characters/walker.glb` with `Idle` and `Walk`
  clips; without it every walker is a coloured block.
- **menus-saves**: nothing; a game with locales keys its labels to `assets/lang/<locale>.ftl`
  lines (`docs/api/text.md`).
- **explosion**: a short bang at `sfx/explosion.wav` (WAV, Ogg, MP3 or FLAC); without it the blast
  is silent and the `blast` probe says `"sound": false`.

## How they are judged

The interior is built to be looked at on a desktop preset (`high` or `ultra`: volumetric shafts,
ambient occlusion, TAA). Look at it there, then check it stays readable at `low` and as a phone.
