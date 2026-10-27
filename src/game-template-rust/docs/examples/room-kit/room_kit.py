"""A room's shell as one GLB kit for `blender__model`: walls with real window and door openings
(their reveals included), steel window frames, concrete sills, a floor, a ceiling, a skirting
trim and a radiator under each window.

Two rules keep a scan from looking like a scan:
- No stretching: every face gets world-scale UVs (a box projection, one UV unit per `tile`
  metres), so a scan keeps its real size on walls, reveals and sills alike.
- No visible repeat: big faces are cut into uneven panels, and every panel shifts its UVs by a
  random offset and turns them a random quarter turn, all from `SEED`; a surface may list close
  variants of one scan to mix too. Decals in the game then break up what still lines up. Never mix
  two differently coloured scans panel by panel (it reads as a quilt): give the second one a zone
  of its own, as the painted dado below the whitewash here, with a line where they meet.

Copy it to `assets/src/room_kit.py`, fetch the scans with `cc0__fetch` (1k), and run
`blender__model {name: "room-kit", inputs: "<the maps below, comma-separated>"}`. A run takes at
most 8 inputs, so the second paint brings its colour and normal only and the floor and ceiling
their main maps; a map left out is skipped. The maps travel into the GLB; Studio's import
compresses them. In the game draw it with
`frame.model(&kit, Transform::IDENTITY)` and give it the colliders, probe, volume, lights and
decals of `docs/examples/interior-room` (its numbers are this file's, turned into the game's axes).

Blender is +Z up and metres; the GLB comes out +Y up, so Blender (x, y, z) is the game's
(x, z, -y): the window wall at Blender y = -3 is the game's z = +3.
"""

import random

import bmesh

# The room inside its walls (x, y from the centre; z from the floor), metres, as the interior example.
HALF_X, HALF_Y, HEIGHT = 4.0, 3.0, 3.2
WALL = 0.25
# The window wall (Blender -y, the game's +z): openings along x, their sill and head.
WINDOWS = [(-2.9, -1.1), (1.1, 2.9)]
SILL, HEAD = 0.9, 2.5
# The door in the east wall (+x): along y, its head.
DOOR = (1.3, 2.4)
DOOR_HEAD = 2.1
SKIRTING = 0.12
# The painted dado's top: oil paint below, whitewash above, a painted line between.
DADO = 1.3

# The seed of every panel's offset, turn and variant: change it for another arrangement.
SEED = 7

# The scans as cc0__fetch delivers them (folder and file names), and the size one copy covers.
def poly_haven(folder, id):
    stem = f"assets/cc0/{folder}/{id}"
    return {"color": f"{stem}_diff_1k.jpg", "normal": f"{stem}_nor_gl_1k.jpg", "arm": f"{stem}_arm_1k.jpg"}


def ambient_cg(folder, id):
    stem = f"assets/cc0/{folder}/{id}_1K-JPG"
    return {"color": f"{stem}_Color.jpg", "normal": f"{stem}_NormalGL.jpg", "roughness": f"{stem}_Roughness.jpg"}


PLASTER = poly_haven("aeaef6d7-72f1-a42b-cd06-d4d2de83a72a", "peeling_painted_wall")
PLASTER_B = ambient_cg("bda79521-bec0-2370-fb9d-36bab473c63b", "PaintedPlaster016")
TILES = poly_haven("e6657b6b-b54c-49ce-7af8-709354a34ed0", "floor_tiles_06")
CONCRETE = poly_haven("69d58cd7-d02f-5f73-c20b-748197b36df8", "concrete_wall_003")
# The 8 inputs of one run: PLASTER's color, normal and arm; PLASTER_B's color and normal; TILES'
# color and normal; CONCRETE's color.
INPUTS = [PLASTER["color"], PLASTER["normal"], PLASTER["arm"], PLASTER_B["color"], PLASTER_B["normal"],
          TILES["color"], TILES["normal"], CONCRETE["color"]]
# Big faces are cut into panels about this many tiles across, each with its own offset and variant.
PANEL_TILES = 1.5


def image(path, colour):
    """The staged map at `path`, or None when it was not passed in `inputs`."""
    staged = ASSET_INPUTS.get(path)
    if staged is None:
        return None
    picture = bpy.data.images.load(staged)
    picture.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return picture


def scan_material(name, maps, roughness=1.0, tint=None):
    """A Principled material from a scan's colour, normal and arm (or plain roughness) maps, its
    colour multiplied by `tint` (exported as the glTF base colour factor) when given."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = roughness

    def texture(key, colour):
        picture = image(maps.get(key, ""), colour)
        if picture is None:
            return None
        node = nodes.new("ShaderNodeTexImage")
        node.image = picture
        return node

    colour = texture("color", True)
    if colour and tint:
        mix = nodes.new("ShaderNodeMix")
        mix.data_type, mix.blend_type = "RGBA", "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        mix.inputs["B"].default_value = (*tint, 1.0)
        links.new(colour.outputs["Color"], mix.inputs["A"])
        links.new(mix.outputs["Result"], shader.inputs["Base Color"])
    elif colour:
        links.new(colour.outputs["Color"], shader.inputs["Base Color"])
    normal = texture("normal", False)
    if normal:
        bump = nodes.new("ShaderNodeNormalMap")
        links.new(normal.outputs["Color"], bump.inputs["Color"])
        links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    arm = texture("arm", False)
    if arm:
        # glTF's metal-roughness texture: roughness in green, metal in blue (as Poly Haven's arm).
        split = nodes.new("ShaderNodeSeparateColor")
        links.new(arm.outputs["Color"], split.inputs["Color"])
        links.new(split.outputs["Green"], shader.inputs["Roughness"])
        links.new(split.outputs["Blue"], shader.inputs["Metallic"])
    rough = texture("roughness", False)
    if rough:
        links.new(rough.outputs["Color"], shader.inputs["Roughness"])
    return material


def plain_material(name, rgb, metallic, roughness):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    shader = material.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = (*rgb, 1.0)
    shader.inputs["Metallic"].default_value = metallic
    shader.inputs["Roughness"].default_value = roughness
    return material


class Surface:
    """Boxes that share one surface's variants, joined into one mesh with box-projected world UVs."""

    def __init__(self, name, variants, tile):
        self.name, self.variants, self.tile = name, variants, tile
        self.bm = bmesh.new()
        self.panels = []

    def box(self, lo, hi):
        if min(h - l for l, h in zip(lo, hi)) <= 0.001:
            return
        made = bmesh.ops.create_cube(self.bm, size=1.0)
        for vert in made["verts"]:
            vert.co = tuple(l + (c + 0.5) * (h - l) for c, l, h in zip(vert.co, lo, hi))
        self.panels.append({face for vert in made["verts"] for face in vert.link_faces})

    def panelled(self, lo, hi):
        """A box cut on its two largest sides into uneven panels about `PANEL_TILES` tiles across."""
        size = [h - l for l, h in zip(lo, hi)]
        if min(size) <= 0.001:
            return
        thin = size.index(min(size))
        pick = random.Random(f"{SEED}:{self.name}:{lo}")
        cuts = []
        for axis in range(3):
            count = 1 if axis == thin else max(1, round(size[axis] / (self.tile * PANEL_TILES)))
            weights = [pick.uniform(0.7, 1.3) for _ in range(count)]
            at, edges = lo[axis], [lo[axis]]
            for weight in weights:
                at += size[axis] * weight / sum(weights)
                edges.append(at)
            edges[-1] = hi[axis]
            cuts.append(edges)
        for x0, x1 in zip(cuts[0], cuts[0][1:]):
            for y0, y1 in zip(cuts[1], cuts[1][1:]):
                for z0, z1 in zip(cuts[2], cuts[2][1:]):
                    self.box((x0, y0, z0), (x1, y1, z1))

    def finish(self):
        uv = self.bm.loops.layers.uv.new("UVMap")
        for index, faces in enumerate(self.panels):
            # Each panel's own offset, quarter turns and variant, the same on every run.
            pick = random.Random(f"{SEED}:{self.name}:{index}")
            du, dv, turns = pick.random(), pick.random(), pick.randrange(4)
            variant = pick.randrange(len(self.variants))
            for face in faces:
                face.material_index = variant
                # Project along the face's main axis: the other two world axes become u and v.
                n = face.normal
                axis = max(range(3), key=lambda i: abs(n[i]))
                u_axis, v_axis = [(1, 2), (0, 2), (0, 1)][axis]
                for loop in face.loops:
                    u, v = loop.vert.co[u_axis] / self.tile, loop.vert.co[v_axis] / self.tile
                    for _ in range(turns):
                        u, v = -v, u
                    loop[uv].uv = (u + du, v + dv)
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for material in self.variants:
            mesh.materials.append(material)
        bpy.context.scene.collection.objects.link(bpy.data.objects.new(self.name, mesh))


def wall(paint, along_x, at, span, openings):
    """A wall `WALL` thick from `at` outward, `span` long, with (from, to, sill, head) holes.
    `paint` is one surface, or (below, above, line) for a dado."""

    def place(surface, a, b, z0, z1, proud=0.0):
        if along_x:
            surface.panelled((a, at[0] - proud, z0), (b, at[1] + proud, z1))
        else:
            surface.panelled((at[0] - proud, a, z0), (at[1] + proud, b, z1))

    def panel(a, b, z0, z1):
        if not isinstance(paint, tuple):
            place(paint, a, b, z0, z1)
            return
        below, above, line = paint
        split = min(max(DADO, z0), z1)
        place(below, a, b, z0, split)
        place(above, a, b, split, z1)
        if z0 < DADO < z1:
            place(line, a, b, DADO - 0.015, DADO + 0.015, proud=0.006)

    start = span[0]
    for a, b, sill, head in openings:
        panel(start, a, 0.0, HEIGHT)
        panel(a, b, 0.0, sill)
        panel(a, b, head, HEIGHT)
        start = b
    panel(start, span[1], 0.0, HEIGHT)


plaster = Surface("walls", [scan_material("plaster", PLASTER)], 2.0)
# Institutional green oil paint over the plaster scan (linear rgb).
dado = Surface("dado", [scan_material("dado", PLASTER_B, 0.6, tint=(0.3, 0.5, 0.36))], 2.0)
floor = Surface("floor", [scan_material("tiles", TILES, 0.6)], 2.0)
concrete = Surface("ceiling-and-sills", [scan_material("concrete", CONCRETE)], 2.5)
steel = Surface("frames-and-radiators", [plain_material("steel", (0.05, 0.05, 0.055), 1.0, 0.45)], 1.0)

outer_x, outer_y = HALF_X + WALL, HALF_Y + WALL
windows = [(a, b, SILL, HEAD) for a, b in WINDOWS]
painted = (dado, plaster, steel)
wall(painted, True, (-outer_y, -HALF_Y), (-outer_x, outer_x), windows)
wall(painted, True, (HALF_Y, outer_y), (-outer_x, outer_x), [])
wall(painted, False, (-outer_x, -HALF_X), (-HALF_Y, HALF_Y), [])
wall(painted, False, (HALF_X, outer_x), (-HALF_Y, HALF_Y), [(DOOR[0], DOOR[1], 0.0, DOOR_HEAD)])
floor.panelled((-HALF_X, -HALF_Y, -0.2), (HALF_X, HALF_Y, 0.0))
concrete.panelled((-outer_x, -outer_y, HEIGHT), (outer_x, outer_y, HEIGHT + 0.2))
# A skirting trim round the floor, broken at the door.
for lo, hi in [((-HALF_X, -HALF_Y, 0), (HALF_X, -HALF_Y + 0.02, SKIRTING)), ((-HALF_X, HALF_Y - 0.02, 0), (HALF_X, HALF_Y, SKIRTING)),
               ((-HALF_X, -HALF_Y, 0), (-HALF_X + 0.02, HALF_Y, SKIRTING)), ((HALF_X - 0.02, -HALF_Y, 0), (HALF_X, DOOR[0], SKIRTING)),
               ((HALF_X - 0.02, DOOR[1], 0), (HALF_X, HALF_Y, SKIRTING))]:
    concrete.box(lo, hi)
for a, b in WINDOWS:
    mid = -HALF_Y - WALL / 2
    # Frame: jambs, a mullion, sill rail, transom and head rail.
    for x in (a, (a + b) / 2 - 0.025, b - 0.05):
        steel.box((x, mid - 0.03, SILL), (x + 0.05, mid + 0.03, HEAD))
    for z in (SILL, 1.9, HEAD - 0.05):
        steel.box((a, mid - 0.03, z), (b, mid + 0.03, z + 0.05))
    # A concrete sill standing proud of the wall inside, and a radiator under it.
    concrete.box((a - 0.08, -HALF_Y - 0.02, SILL - 0.05), (b + 0.08, -HALF_Y + 0.08, SILL))
    for i in range(14):
        x = a + 0.15 + i * (b - a - 0.3) / 13
        steel.box((x - 0.025, -HALF_Y + 0.07, 0.18), (x + 0.025, -HALF_Y + 0.17, 0.78))
    for z in (0.2, 0.74):
        steel.box((a + 0.1, -HALF_Y + 0.1, z), (b - 0.1, -HALF_Y + 0.14, z + 0.04))

for surface in (plaster, dado, floor, concrete, steel):
    surface.finish()
