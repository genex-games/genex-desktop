"""Genex Roblox realism test: a small sunlit Mediterranean alley built in Blender from CC0 Poly Haven
textures and models, exported in the form a Roblox Studio plugin builds from (EditableMesh /
EditableImage), plus an optional Cycles reference render.

Run: blender -b -P realism_scene.py -- <assets-dir> <out-dir> [--render] [--samples N]

Out:
  meshes/<part>.gxm      "GXM1", u32 vertices, u32 triangles, f32 positions*3, f32 normals*3, f32 uvs*2,
                         u32 triangles*3 (Roblox axes, studs, relative to the part's centre; UV v down)
  textures/<mat>_<map>.raw  8-bit pixels, rows top to bottom; "rgb" (3 bytes) or "r" (1 byte) per pixel
  manifest.json          parts (mesh, centre, material), materials (maps, sizes), shots, sun direction
  reference_<shot>.png   Cycles renders (with --render)
"""
import json
import math
import os
import struct
import sys

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
ASSETS = os.path.abspath(ARGS[0])
OUT = os.path.abspath(ARGS[1])
RENDER = "--render" in ARGS
SAMPLES = int(ARGS[ARGS.index("--samples") + 1]) if "--samples" in ARGS else 48

STUDS_PER_M = 1 / 0.28
MAX_TRIS = 20000
SURFACE_SIDE = {"color": 1024, "normal": 512, "roughness": 512}
PROP_SIDE = {"color": 512, "normal": 256, "roughness": 256, "metalness": 256}
# A metalness map whose brightest texel is under this (0..1) is left out: the material is not metal.
METAL_FLOOR = 0.04
BEVEL_M = 0.025
SMOOTH_ANGLE = math.radians(31)
# Direction the sunlight travels (Blender axes): from the upper left-front of the alley.
SUN_TRAVEL = Vector((0.62, -0.42, -0.66)).normalized()

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
os.makedirs(os.path.join(OUT, "meshes"), exist_ok=True)
os.makedirs(os.path.join(OUT, "textures"), exist_ok=True)

# ---------------------------------------------------------------- materials

MATERIALS = {}  # key -> {"maps": {map: path or (path, channel)}, "ao": path?, "prop": bool, "bl": material}


def image_node(nodes, path, non_color):
    node = nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(path, check_existing=True)
    if non_color:
        node.image.colorspace_settings.name = "Non-Color"
    return node


def surface_material(key, texture):
    """A tiling material from a Poly Haven texture set (UVs are in tile units)."""
    folder = os.path.join(ASSETS, "textures", texture)
    maps = {
        "color": os.path.join(folder, f"{texture}_diff.jpg"),
        "normal": os.path.join(folder, f"{texture}_nor_gl.jpg"),
        "roughness": os.path.join(folder, f"{texture}_rough.jpg"),
    }
    mat = bpy.data.materials.new(key)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    bsdf = nodes["Principled BSDF"]
    color = image_node(nodes, maps["color"], False)
    rough = image_node(nodes, maps["roughness"], True)
    normal = image_node(nodes, maps["normal"], True)
    nmap = nodes.new("ShaderNodeNormalMap")
    links.new(color.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(rough.outputs["Color"], bsdf.inputs["Roughness"])
    links.new(normal.outputs["Color"], nmap.inputs["Color"])
    links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])
    MATERIALS[key] = {"maps": maps, "prop": False, "bl": mat}
    return mat


def prop_material(key, bl_mat, folder, stem):
    """A prop's own material (Poly Haven model): colour, GL normal and the ARM (AO, rough, metal) pack."""
    tex = os.path.join(folder, "textures")
    arm = os.path.join(tex, f"{stem}_arm_1k.jpg")
    maps = {
        "color": os.path.join(tex, f"{stem}_diff_1k.jpg"),
        "normal": os.path.join(tex, f"{stem}_nor_gl_1k.jpg"),
    }
    if os.path.exists(arm):
        maps["roughness"] = (arm, 1)
        maps["metalness"] = (arm, 2)
        ao = (arm, 0)
    else:
        maps["roughness"] = os.path.join(tex, f"{stem}_rough_1k.jpg")
        ao = None
    MATERIALS[key] = {"maps": maps, "ao": ao, "prop": True, "bl": bl_mat}


PLASTER = surface_material("plaster_red", "red_plaster_weathered")
BLUE = surface_material("plaster_blue", "blue_plaster_weathered")
SANDSTONE = surface_material("sandstone", "large_sandstone_blocks")
COBBLE = surface_material("cobblestone", "cobblestone_floor_08")
PLANKS = surface_material("shutter_wood", "wood_shutter")
ROOF = surface_material("roof_tiles", "clay_roof_tiles_02")

# ---------------------------------------------------------------- geometry helpers

TILE = {}  # object name -> tile size in metres for box UVs
CUTTERS = []


def link(obj):
    scene.collection.objects.link(obj)
    return obj


def box_mesh(name, x0, x1, y0, y1, z0, z1):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(
            (
                x0 + (v.co.x + 0.5) * (x1 - x0),
                y0 + (v.co.y + 0.5) * (y1 - y0),
                z0 + (v.co.z + 0.5) * (z1 - z0),
            )
        )
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def cylinder_mesh(name, centre, radius, depth, axis, segments=48):
    """A closed cylinder along `axis` ('X' or 'Y'), centred at `centre`."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius, depth=depth)
    rot = Matrix.Rotation(math.radians(90), 4, "Y" if axis == "X" else "X")
    bmesh.ops.transform(bm, matrix=Matrix.Translation(Vector(centre)) @ rot, verts=bm.verts)
    bm.to_mesh(me)
    bm.free()
    return link(bpy.data.objects.new(name, me))


def cutter_box(*bounds):
    obj = box_mesh(f"cut{len(CUTTERS)}", *bounds)
    obj.hide_render = True
    CUTTERS.append(obj)
    return obj


def cutter_arch(axis, plane0, plane1, a0, a1, z0, spring, name="arch"):
    """An arched opening through a wall: a box from z0 to `spring` plus a half cylinder on top.
    For axis 'X' the wall runs along Y (a0..a1 are Y), the cut goes through X plane0..plane1."""
    radius = (a1 - a0) / 2
    mid = (a0 + a1) / 2
    if axis == "X":
        body = cutter_box(plane0, plane1, a0, a1, z0, spring)
        top = cylinder_mesh(f"cut{len(CUTTERS)}", ((plane0 + plane1) / 2, mid, spring), radius, plane1 - plane0, "X")
    else:
        body = cutter_box(a0, a1, plane0, plane1, z0, spring)
        top = cylinder_mesh(f"cut{len(CUTTERS)}", (mid, (plane0 + plane1) / 2, spring), radius, plane1 - plane0, "Y")
    top.hide_render = True
    CUTTERS.append(top)
    return [body, top]


def cut(obj, cutters):
    for c in cutters:
        mod = obj.modifiers.new(f"cut_{c.name}", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.solver = "EXACT"
        mod.object = c


def finish(obj, material, tile, bevel=True):
    """Apply cuts and a small bevel, then give the part its material and box UVs in tile units."""
    if bevel:
        mod = obj.modifiers.new("bevel", "BEVEL")
        mod.width = BEVEL_M
        mod.segments = 3
        mod.limit_method = "ANGLE"
        mod.angle_limit = math.radians(30)
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(obj.evaluated_get(dg), depsgraph=dg)
    obj.modifiers.clear()
    obj.data = me
    me.materials.clear()
    me.materials.append(material)
    box_uv(obj, tile)
    me.set_sharp_from_angle(angle=SMOOTH_ANGLE)
    return obj


def box_uv(obj, tile):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    uv = bm.loops.layers.uv.verify()
    mw = obj.matrix_world
    for f in bm.faces:
        n = (mw.to_3x3() @ f.normal).normalized()
        axis = max(range(3), key=lambda i: abs(n[i]))
        for loop in f.loops:
            p = mw @ loop.vert.co
            if axis == 0:
                u, v = (p.y if n.x < 0 else -p.y), p.z
            elif axis == 1:
                u, v = (-p.x if n.y < 0 else p.x), p.z
            else:
                u, v = p.x, (p.y if n.z > 0 else -p.y)
            loop[uv].uv = (u / tile, v / tile)
    bm.to_mesh(obj.data)
    bm.free()


def solid(name, bounds, material, tile, cutters=(), bevel=True):
    obj = box_mesh(name, *bounds)
    cut(obj, cutters)
    return finish(obj, material, tile, bevel)


# ---------------------------------------------------------------- the alley (metres, Z up, alley along +Y)

solid("ground", (-8, 8, -6, 34, -0.2, 0), COBBLE, 2.2, bevel=False)
solid("curb_left", (-3.0, -2.25, -6, 20, 0, 0.14), SANDSTONE, 1.6)

# Left building, warm plaster: a door, three shuttered windows, plinth, cornice and roof edge.
left_cuts = [cutter_box(-3.35, -2.9, 5.0, 6.4, 0.14, 2.75)]
for y in (1.4, 9.2, 14.6):
    left_cuts.append(cutter_box(-3.28, -2.9, y, y + 1.15, 3.4, 5.05))
solid("left_wall", (-10, -3.0, -6, 22, 0, 8.0), PLASTER, 3.2, left_cuts)
solid("left_plinth", (-3.0, -2.91, -6, 4.82, 0.14, 0.9), SANDSTONE, 1.6)
solid("left_plinth2", (-3.0, -2.91, 6.58, 20.0, 0.14, 0.9), SANDSTONE, 1.6)
solid("left_door", (-3.36, -3.3, 5.0, 6.4, 0.14, 2.75), PLANKS, 1.4)
solid("left_jamb_a", (-3.14, -2.98, 4.82, 5.0, 0.14, 2.93), SANDSTONE, 1.6)
solid("left_jamb_b", (-3.14, -2.98, 6.4, 6.58, 0.14, 2.93), SANDSTONE, 1.6)
solid("left_lintel", (-3.14, -2.98, 4.82, 6.58, 2.75, 3.0), SANDSTONE, 1.6)
for i, y in enumerate((1.4, 9.2, 14.6)):
    solid(f"left_shutters{i}", (-3.27, -3.2, y, y + 1.15, 3.4, 5.05), PLANKS, 1.2)
    solid(f"left_sill{i}", (-3.12, -2.88, y - 0.12, y + 1.27, 3.28, 3.42), SANDSTONE, 1.6)
    solid(f"left_head{i}", (-3.1, -2.96, y - 0.08, y + 1.23, 5.05, 5.22), SANDSTONE, 1.6)
solid("left_cornice", (-3.0, -2.72, -6, 22, 7.72, 8.0), SANDSTONE, 1.6)
solid("left_roof", (-3.4, -2.55, -6, 22, 8.0, 8.16), ROOF, 1.2)

# Right building, weathered blue plaster: an arched doorway with a sandstone surround, two windows.
arch_y0, arch_y1, arch_spring = 6.0, 8.4, 2.7
right_cuts = cutter_arch("X", 2.7, 3.65, arch_y0, arch_y1, -0.1, arch_spring)
for y in (1.2, 10.9):
    right_cuts.append(cutter_box(2.9, 3.28, y, y + 1.1, 3.5, 5.0))
solid("right_wall", (3.0, 10, -6, 13.0, 0, 6.6), BLUE, 3.2, right_cuts)
solid("right_plinth", (2.91, 3.0, -6, arch_y0 - 0.3, 0, 0.75), SANDSTONE, 1.6)
solid("right_plinth2", (2.91, 3.0, arch_y1 + 0.3, 13.0, 0, 0.75), SANDSTONE, 1.6)
surround = box_mesh("right_arch_surround", 2.93, 3.0, arch_y0 - 0.3, arch_y1 + 0.3, 0, arch_spring + 1.5)
cut(surround, cutter_arch("X", 2.8, 3.1, arch_y0, arch_y1, -0.2, arch_spring))
finish(surround, SANDSTONE, 1.6)
for i, y in enumerate((1.2, 10.9)):
    solid(f"right_shutters{i}", (3.2, 3.27, y, y + 1.1, 3.5, 5.0), PLANKS, 1.2)
    solid(f"right_sill{i}", (2.88, 3.12, y - 0.12, y + 1.22, 3.38, 3.5), SANDSTONE, 1.6)
solid("right_cornice", (2.76, 3.0, -6, 13.0, 6.38, 6.6), SANDSTONE, 1.6)
solid("lantern_shelf", (2.78, 3.0, 5.35, 5.75, 2.55, 2.68), SANDSTONE, 1.6)

# Far right: a lower sandstone wall, then steps up to an archway in the end wall.
solid("right_low_wall", (3.0, 10, 13.0, 22, 0, 3.6), SANDSTONE, 2.4)
solid("right_low_cap", (2.9, 3.4, 13.0, 22, 3.6, 3.78), SANDSTONE, 1.6)
for i in range(3):
    solid(f"step{i}", (-3.0, 3.0, 20.0 + i * 0.4, 22.2, 0, 0.18 * (i + 1)), SANDSTONE, 1.6)
end_cuts = cutter_arch("Y", 21.8, 23.8, -1.4, 1.4, 0.5, 3.2)
solid("end_wall", (-10, 10, 22.0, 23.5, 0, 7.2), SANDSTONE, 2.4, end_cuts)
solid("court_floor", (-8, 8, 22.2, 34, 0, 0.54), COBBLE, 2.2, bevel=False)
solid("court_wall", (-8, 8, 31.0, 32.0, 0, 6.0), PLASTER, 3.2)

for c in CUTTERS:
    bpy.data.objects.remove(c, do_unlink=True)

# ---------------------------------------------------------------- props (Poly Haven models)

PROPS = []  # (object, material key)


def place_model(name, location, rot_deg=0.0, keep=None, scale=1.0, wall=None):
    """Import a Poly Haven model, merge it per material and stand it at `location` (its base centre).
    With `wall` (an x plane), the group is moved along x so its back touches that wall."""
    folder = os.path.join(ASSETS, "models", name)
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(folder, f"{name}.gltf"))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH" and (keep is None or o.name.split(".")[0] in keep)]
    # Split the kept meshes by material and merge the pieces per material, in world space.
    # A second import of a model names its materials "<stem>.001": the stem names the texture set.
    dg = bpy.context.evaluated_depsgraph_get()
    by_mat = {}
    for o in meshes:
        m = bpy.data.meshes.new_from_object(o.evaluated_get(dg), depsgraph=dg)
        m.transform(o.matrix_world)
        for slot, mat in enumerate(o.data.materials):
            bm = bmesh.new()
            bm.from_mesh(m)
            bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index != slot], context="FACES")
            piece = bpy.data.meshes.new("piece")
            bm.to_mesh(piece)
            bm.free()
            by_mat.setdefault(mat.name.split(".")[0], []).append(piece)
        bpy.data.meshes.remove(m)
    for o in new:
        bpy.data.objects.remove(o, do_unlink=True)
    placed = []
    for stem, pieces in by_mat.items():
        merged = bmesh.new()
        for piece in pieces:
            merged.from_mesh(piece)
            bpy.data.meshes.remove(piece)
        if not merged.faces:
            merged.free()
            continue
        me = bpy.data.meshes.new(f"{name}_{stem}")
        merged.to_mesh(me)
        merged.free()
        for poly in me.polygons:
            poly.material_index = 0
        obj = link(bpy.data.objects.new(f"{name}_{stem}", me))
        obj.data.materials.clear()
        obj.data.materials.append(bpy.data.materials[stem])
        key = f"prop_{stem}"
        if key not in MATERIALS:
            prop_material(key, bpy.data.materials[stem], folder, stem)
        placed.append((obj, key))
    # Rest the group on z=0 at its footprint centre, then move it into place.
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for obj, _ in placed:
        for v in obj.data.vertices:
            lo = Vector(map(min, lo, v.co))
            hi = Vector(map(max, hi, v.co))
    base = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
    xf = (
        Matrix.Translation(Vector(location))
        @ Matrix.Rotation(math.radians(rot_deg), 4, "Z")
        @ Matrix.Scale(scale, 4)
        @ Matrix.Translation(-base)
    )
    for obj, _ in placed:
        obj.data.transform(xf)
    if wall is not None:
        xs = [v.co.x for obj, _ in placed for v in obj.data.vertices]
        shift = wall - min(xs) if wall < location[0] else wall - max(xs)
        for obj, _ in placed:
            obj.data.transform(Matrix.Translation((shift, 0, 0)))
    for obj, key in placed:
        obj.data.update()
        obj.data.set_sharp_from_angle(angle=math.radians(60))
        PROPS.append((obj, key))
    return hi - lo


place_model("wooden_crate_01", (2.25, 2.6, 0), 8)
size = place_model("wooden_crate_02", (2.3, 3.75, 0), -6)
place_model("wooden_crate_01", (2.32, 3.72, 0.46), 96)
place_model("wooden_barrels_01", (-2.55, 11.0, 0.14), 0, keep={"wooden_barrels_01_barrel01"})
place_model("wooden_barrels_01", (-2.45, 11.9, 0.14), 40, keep={"wooden_barrels_01_barrel02"})
place_model("planter_pot_clay", (2.45, 9.0, 0), 0)
place_model("ceramic_vase_01", (-2.55, 7.0, 0.14), 0)
place_model("ceramic_vase_03", (2.5, 5.55, 0), 30)
place_model("large_castle_door", (3.42, (arch_y0 + arch_y1) / 2, 0), 90, scale=1.0)
place_model("wooden_lantern_01", (2.86, 5.55, 2.68), 90, keep={"wooden_lantern_01", "wooden_lantern_01_handle"})
place_model("painted_wooden_bench", (-2.6, 3.4, 0.14), 90, wall=-2.91)
place_model("wooden_bucket_01", (-1.95, 10.35, 0), 0)
place_model("garden_hose_wall_mounted_01", (-2.9, 7.7, 0.95), 90, wall=-3.0)
place_model("utility_box_01", (-2.9, 12.9, 1.25), 90, wall=-3.0)
place_model("water_manhole_cover", (0.35, 9.4, -0.015), 0)
place_model("potted_plant_04", (-3.0, 9.75, 3.42), 0)
place_model("potted_plant_04", (3.0, 1.75, 3.5), 140)

# ---------------------------------------------------------------- export for Roblox

def to_roblox(v):
    """Blender (x, y, z) metres, Z up -> Roblox (x, z, -y) studs, Y up (a rotation: winding kept)."""
    return (v.x * STUDS_PER_M, v.z * STUDS_PER_M, -v.y * STUDS_PER_M)


def export_mesh(obj, material):
    me = obj.data
    me.calc_loop_triangles()
    uv_layer = me.uv_layers.active
    normals = me.corner_normals
    mw = obj.matrix_world
    rot = mw.to_3x3()
    index, positions, nrm, uvs, tris = {}, [], [], [], []
    for tri in me.loop_triangles:
        face = []
        for li in tri.loops:
            p = to_roblox(mw @ me.vertices[me.loops[li].vertex_index].co)
            n = rot @ normals[li].vector
            n = (n.x, n.z, -n.y)
            uv = uv_layer.data[li].uv if uv_layer else (0.0, 0.0)
            key = (*(round(c, 4) for c in p), *(round(c, 3) for c in n), round(uv[0], 4), round(uv[1], 4))
            at = index.get(key)
            if at is None:
                at = index[key] = len(positions)
                positions.append(p)
                nrm.append(n)
                uvs.append((uv[0], 1.0 - uv[1]))
            face.append(at)
        # A triangle whose corners merged (a sliver from a boolean cut) has no area: Roblox refuses it.
        if len(set(face)) == 3:
            tris.append(face)
    if len(tris) > MAX_TRIS:
        raise SystemExit(f"{obj.name}: {len(tris)} triangles, over {MAX_TRIS}")
    lo = [min(p[i] for p in positions) for i in range(3)]
    hi = [max(p[i] for p in positions) for i in range(3)]
    centre = [(lo[i] + hi[i]) / 2 for i in range(3)]
    name = obj.name.replace(".", "_")
    with open(os.path.join(OUT, "meshes", f"{name}.gxm"), "wb") as out:
        out.write(b"GXM1" + struct.pack("<II", len(positions), len(tris)))
        out.write(b"".join(struct.pack("<3f", *(p[i] - centre[i] for i in range(3))) for p in positions))
        out.write(b"".join(struct.pack("<3f", *n) for n in nrm))
        out.write(b"".join(struct.pack("<2f", *uv) for uv in uvs))
        out.write(b"".join(struct.pack("<3I", *t) for t in tris))
    return {
        "name": name,
        "mesh": f"meshes/{name}.gxm",
        "centre": centre,
        "size": [hi[i] - lo[i] for i in range(3)],
        "triangles": len(tris),
        "vertices": len(positions),
        "material": material,
    }


def pixels(path):
    img = bpy.data.images.load(path, check_existing=True)
    w, h = img.size
    data = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(data)
    return np.flipud(data.reshape(h, w, 4))  # rows top to bottom


def shrink(arr, side):
    h = arr.shape[0]
    f = h // side
    if f <= 1:
        return arr
    return arr.reshape(side, f, side, f, arr.shape[2]).mean(axis=(1, 3))


def export_material(key, entry):
    out = {}
    ao = None
    if entry.get("ao"):
        path, ch = entry["ao"]
        ao = pixels(path)[:, :, ch : ch + 1]
    for name, src in entry["maps"].items():
        side = (PROP_SIDE if entry["prop"] else SURFACE_SIDE)[name]
        if isinstance(src, tuple):
            arr = pixels(src[0])[:, :, src[1] : src[1] + 1]
        else:
            arr = pixels(src)
            arr = arr[:, :, :3] if name in ("color", "normal") else arr[:, :, :1]
        if name == "metalness" and arr.max() < METAL_FLOOR:
            continue
        if name == "color" and ao is not None:
            arr = arr * (0.3 + 0.7 * ao)
        arr = shrink(arr, side)
        fmt = "rgb" if arr.shape[2] == 3 else "r"
        file = f"textures/{key}_{name}.raw"
        (np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8).tofile(os.path.join(OUT, file))
        out[name] = {"file": file, "width": arr.shape[1], "height": arr.shape[0], "format": fmt}
        if name == "color":
            out["average"] = [round(float(c), 4) for c in arr.reshape(-1, 3).mean(axis=0)]
    if key.endswith("_glass"):
        out["transparency"] = 0.55
    return out


parts = []
for obj in [o for o in scene.objects if o.type == "MESH"]:
    if obj.data.materials and obj.data.materials[0]:
        mat = obj.data.materials[0].name
        key = next(k for k, e in MATERIALS.items() if e["bl"].name == mat)
        parts.append(export_mesh(obj, key))

materials = {key: export_material(key, entry) for key, entry in MATERIALS.items()}


def look(name, eye, target, fov):
    return {"name": name, "eye": list(to_roblox(Vector(eye))), "target": list(to_roblox(Vector(target))), "fov": fov}


SHOTS = [
    look("alley", (0.6, -1.5, 1.7), (-0.2, 20.0, 2.4), 70),
    look("door", (-1.6, 2.2, 1.65), (3.0, 7.4, 1.9), 55),
    look("steps", (1.2, 12.5, 1.7), (-0.3, 24.0, 2.6), 60),
]
manifest = {
    "parts": parts,
    "materials": materials,
    "shots": SHOTS,
    # Lighting:GetSunDirection() points from the scene to the sun.
    "toSun": [-SUN_TRAVEL.x, -SUN_TRAVEL.z, SUN_TRAVEL.y],
    # The lantern's warm light (Roblox studs), a little in front of the lantern on the blue wall.
    "lights": [{"position": list(to_roblox(Vector((2.72, 5.55, 2.92)))), "color": [255, 184, 110], "brightness": 2.2, "range": 14}],
    "studsPerMetre": STUDS_PER_M,
}
with open(os.path.join(OUT, "manifest.json"), "w") as f:
    json.dump(manifest, f, indent=1)
total = sum(p["triangles"] for p in parts)
print(f"exported {len(parts)} parts, {total} triangles, {len(materials)} materials")

# ---------------------------------------------------------------- reference render (Cycles)

if RENDER:
    world = bpy.data.worlds.new("sky")
    scene.world = world
    world.use_nodes = True
    wn = world.node_tree.nodes
    env = wn.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(os.path.join(ASSETS, "hdri", "kloofendal_48d_partly_cloudy_puresky.hdr"))
    world.node_tree.links.new(env.outputs["Color"], wn["Background"].inputs["Color"])
    wn["Background"].inputs["Strength"].default_value = 0.7
    sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
    sun.data.energy = 4.5
    sun.data.angle = math.radians(0.8)
    sun.rotation_euler = SUN_TRAVEL.to_track_quat("-Z", "Y").to_euler()
    link(sun)
    lamp = bpy.data.objects.new("lamp", bpy.data.lights.new("lamp", "POINT"))
    lamp.data.energy = 60
    lamp.data.color = (1.0, 0.72, 0.4)
    lamp.location = (2.75, 5.55, 2.95)
    link(lamp)
    cam_data = bpy.data.cameras.new("cam")
    cam_data.sensor_fit = "VERTICAL"
    cam = link(bpy.data.objects.new("cam", cam_data))
    scene.camera = cam
    r = scene.render
    r.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = SAMPLES
    scene.cycles.use_denoising = True
    r.resolution_x, r.resolution_y = 1280, 720
    try:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
    except TypeError:
        pass
    for shot in SHOTS:
        eye = Vector((shot["eye"][0], -shot["eye"][2], shot["eye"][1])) / STUDS_PER_M
        target = Vector((shot["target"][0], -shot["target"][2], shot["target"][1])) / STUDS_PER_M
        cam.location = eye
        cam.rotation_euler = (target - eye).to_track_quat("-Z", "Y").to_euler()
        cam_data.angle_y = math.radians(shot["fov"])
        r.filepath = os.path.join(OUT, f"reference_{shot['name']}.png")
        bpy.ops.render.render(write_still=True)
        print("rendered", r.filepath)
