"""A room's shell as one GLB kit for `blender__model`: walls with real window and door openings
(their reveals included), steel window frames, concrete sills, a floor, a ceiling, a skirting
trim and a radiator under each window. Every surface gets world-scale UVs (a box projection, one
UV unit per `tile` metres), so a CC0 scan keeps its real size on every face, reveals and sills
included, instead of stretching over each box.

Copy it to `assets/src/room_kit.py`, fetch the scans with `cc0__fetch` (polyhaven, 1k), and run
`blender__model {name: "room-kit", inputs: "<the maps below, comma-separated>"}`. The maps travel
into the GLB; Studio's import compresses them. In the game draw it with
`frame.model(&kit, Transform::IDENTITY)` and give it the colliders, probe, volume, lights and
decals of `docs/examples/interior-room` (its numbers are this file's, turned into the game's axes).

Blender is +Z up and metres; the GLB comes out +Y up, so Blender (x, y, z) is the game's
(x, z, -y): the window wall at Blender y = -3 is the game's z = +3.
"""

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

# The scans as cc0__fetch delivers them; a map left out of `inputs` is skipped.
PLASTER = ("assets/cc0/aeaef6d7-72f1-a42b-cd06-d4d2de83a72a/peeling_painted_wall", 2.0)
TILES = ("assets/cc0/e6657b6b-b54c-49ce-7af8-709354a34ed0/floor_tiles_06", 2.0)
CONCRETE = ("assets/cc0/69d58cd7-d02f-5f73-c20b-748197b36df8/concrete_wall_003", 2.5)


def image(path, colour):
    """The staged map at `path`, or None when it was not passed in `inputs`."""
    staged = ASSET_INPUTS.get(path)
    if staged is None:
        return None
    picture = bpy.data.images.load(staged)
    picture.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return picture


def scan_material(name, scan, roughness=1.0):
    """A Principled material from a Poly Haven scan's diff, nor_gl and arm maps."""
    stem, _ = scan
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes["Principled BSDF"]
    shader.inputs["Roughness"].default_value = roughness
    diff = image(f"{stem}_diff_1k.jpg", True)
    if diff:
        node = nodes.new("ShaderNodeTexImage")
        node.image = diff
        links.new(node.outputs["Color"], shader.inputs["Base Color"])
    normal = image(f"{stem}_nor_gl_1k.jpg", False)
    if normal:
        node, bump = nodes.new("ShaderNodeTexImage"), nodes.new("ShaderNodeNormalMap")
        node.image = normal
        links.new(node.outputs["Color"], bump.inputs["Color"])
        links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    arm = image(f"{stem}_arm_1k.jpg", False)
    if arm:
        # glTF's metal-roughness texture: roughness in green, metal in blue (as Poly Haven's arm).
        node, split = nodes.new("ShaderNodeTexImage"), nodes.new("ShaderNodeSeparateColor")
        node.image = arm
        links.new(node.outputs["Color"], split.inputs["Color"])
        links.new(split.outputs["Green"], shader.inputs["Roughness"])
        links.new(split.outputs["Blue"], shader.inputs["Metallic"])
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
    """Boxes that share one material, joined into one mesh with box-projected world UVs."""

    def __init__(self, name, material, tile):
        self.name, self.material, self.tile = name, material, tile
        self.bm = bmesh.new()

    def box(self, lo, hi):
        if min(h - l for l, h in zip(lo, hi)) <= 0.001:
            return
        made = bmesh.ops.create_cube(self.bm, size=1.0)
        for vert in made["verts"]:
            vert.co = tuple(l + (c + 0.5) * (h - l) for c, l, h in zip(vert.co, lo, hi))

    def finish(self):
        uv = self.bm.loops.layers.uv.new("UVMap")
        for face in self.bm.faces:
            # Project along the face's main axis: the other two world axes become u and v.
            n = face.normal
            axis = max(range(3), key=lambda i: abs(n[i]))
            u_axis, v_axis = [(1, 2), (0, 2), (0, 1)][axis]
            for loop in face.loops:
                loop[uv].uv = (loop.vert.co[u_axis] / self.tile, loop.vert.co[v_axis] / self.tile)
        mesh = bpy.data.meshes.new(self.name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        mesh.materials.append(self.material)
        bpy.context.scene.collection.objects.link(bpy.data.objects.new(self.name, mesh))


def wall(surface, along_x, at, span, openings):
    """A wall `WALL` thick from `at` outward, `span` long, with (from, to, sill, head) holes."""

    def panel(a, b, z0, z1):
        if along_x:
            surface.box((a, at[0], z0), (b, at[1], z1))
        else:
            surface.box((at[0], a, z0), (at[1], b, z1))

    start = span[0]
    for a, b, sill, head in openings:
        panel(start, a, 0.0, HEIGHT)
        panel(a, b, 0.0, sill)
        panel(a, b, head, HEIGHT)
        start = b
    panel(start, span[1], 0.0, HEIGHT)


plaster = Surface("walls", scan_material("plaster", PLASTER), PLASTER[1])
floor = Surface("floor", scan_material("tiles", TILES, 0.6), TILES[1])
concrete = Surface("ceiling-and-sills", scan_material("concrete", CONCRETE), CONCRETE[1])
steel = Surface("frames-and-radiators", plain_material("steel", (0.05, 0.05, 0.055), 1.0, 0.45), 1.0)

outer_x, outer_y = HALF_X + WALL, HALF_Y + WALL
windows = [(a, b, SILL, HEAD) for a, b in WINDOWS]
wall(plaster, True, (-outer_y, -HALF_Y), (-outer_x, outer_x), windows)
wall(plaster, True, (HALF_Y, outer_y), (-outer_x, outer_x), [])
wall(plaster, False, (-outer_x, -HALF_X), (-HALF_Y, HALF_Y), [])
wall(plaster, False, (HALF_X, outer_x), (-HALF_Y, HALF_Y), [(DOOR[0], DOOR[1], 0.0, DOOR_HEAD)])
floor.box((-HALF_X, -HALF_Y, -0.2), (HALF_X, HALF_Y, 0.0))
concrete.box((-outer_x, -outer_y, HEIGHT), (outer_x, outer_y, HEIGHT + 0.2))
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

for surface in (plaster, floor, concrete, steel):
    surface.finish()
