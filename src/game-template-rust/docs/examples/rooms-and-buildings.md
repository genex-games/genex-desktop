# Rooms and buildings

How a room, a corridor or a building comes out looking built, not boxed. The renderer lights,
reflects and fogs a room by itself once it has the right pieces; what it cannot do is make box
panels with a stretched photo on each face read as walls. Work in this order and look at a capture
after each step.

1. **Greybox in code.** Boxes from `frame.cube_with`, sized in metres, with Rapier colliders from
   the same numbers. Play it until the layout works. Spend minutes here, not the run.
2. **Fetch the surfaces.** `cc0__search` then `cc0__fetch` at `1k` for each surface: plaster or
   paint, floor, concrete, wood, metal. Note each scan's real size (Poly Haven's pages give it;
   about 2 m for walls and floors). A scan stretched over a 6 m wall reads as noise.
3. **Build the shell as a GLB kit in Local Blender.** Copy `docs/examples/room-kit/room_kit.py` to
   `assets/src/<name>.py`, set its numbers to your greybox, and run
   `blender__model {name, inputs: "<the scan maps, comma-separated>"}`. It makes walls with real
   openings (their reveals included), window frames, sills, a skirting trim and radiators, and
   gives every face world-scale UVs: a box projection at one UV unit per tile, so a scan keeps its
   real size on walls, reveals and sills alike. Add what the brief's place has (door frames, pipes,
   cornices, broken plaster edges, stairs) the same way. Look at the tool's two renders, then draw
   the kit with `frame.model(&kit, Transform::IDENTITY)` from the path it answered. Blender is +Z
   up: its (x, y, z) is the game's (x, z, -y).
4. **Keep the colliders.** The kit has no collision: keep the greybox's Rapier cuboids (walls,
   floor, cover), from the same numbers as the script.
5. **Sun and sky first, then lamps.** `Environment::sky()` and a low white sun that falls in at the
   windows; nothing outside may block it (a building across the yard must stay under the sun's
   elevation). Every glowing fitting is `Material::emissive` paired with a `spot_light` or
   `point_light`: emission alone lights nothing.
6. **A probe and a volume per room.** `ReflectionProbe` and `IrradianceVolume` on each room's
   inside box, `with_blend` the wall's thickness. Without them a closed room takes the sky's light
   through its walls and its floor mirrors the sky.
7. **Decals for wear.** Grime under sills, water stains, posters and puddles are `Decal::on_wall`
   and `Decal::on_ground`, never thin boxes.
8. **Fog thin, grade last.** Fog takes the sky's light, so indoors a dense fog glows milky in every
   corner; about `0.01` per metre still draws the sun's shafts at `high`. Then exposure, then the
   grade.

`docs/examples/interior-room/` is steps 1, 2 and 5 to 8 in one file (its shell boxes cut to the
scans' size, the stand-in for step 3), and the kit script is step 3 for the same room. Clutter
(desks, chairs, crates, debris) comes from `cc0__search` models first, then Blender scripts.

A finished room shows its light in a capture at a desktop preset: sun patches on the floor with
the window bars' shadows, walls that bounce their colour, a floor that reflects the room, and
blacks in the corners away from the windows.
