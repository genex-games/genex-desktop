"""First-person arms on an AK-pattern rifle, as one rigged GLB for `blender__model` with `rig: true`:
two gloved hands in jacket sleeves, and a rifle built from parts (receiver, dust cover, barrel, gas
tube, wooden handguards, grip and stock, iron sights, a side rail) whose magazine, charging handle
and trigger are bones of their own, with the clips a view model plays.

Kit space is the camera's. The eye is at the origin looking along Blender +Y with +Z up, so in the
GLB (+Y up) the eye is at the origin looking along -Z: draw the character at the camera's position
and turn, and the rifle sits in view at the hip. Keep the eye where the kit puts it; move the whole
kit (sway, kick) by the transform you draw it at.

- Bones: `weapon` carries the rifle; `magazine`, `charging_handle` and `trigger` move under it;
  `muzzle`, `sight` (the rear notch), `sight_front` (the post's top) and `eject` are sockets with
  no mesh. The arms are `upperarm`, `forearm` and `hand` per side, solved here by IK onto the
  rifle and baked into every clip, so the hands stay on it in the GLB without any IK in the game.
- Clips (seconds): Idle (4, loop), Walk (1, loop, two steps), Sprint (0.667, loop), AdsIn (0.25),
  Ads (2, loop), AdsOut (0.25), Fire (0.1: one round at 600 rpm, as an additive layer over any
  pose; its first frame is the hip pose), DryFire (0.3), Reload (2.6: the old magazine rocks out
  and leaves the well by 0.6 s, a new one is in by 1.8 s, the handle racked at 2.3 s), Inspect (3.2).
- ADS puts the sight line (the notch and the post, `SIGHT_HEIGHT` above the bore) on the eye's
  axis, so both sockets sit on the screen's centre.
- Surfaces are CC0 scans at 2k (`SCANS`: black painted steel, dark wood, plum bakelite tinted from
  plastic, coyote leather tinted from white, olive cotton), mapped at their real size (`TILE`) and
  fitted to `COLOR_TEXELS`, `NORMAL_TEXELS` and `SURFACE_TEXELS` as JPEG. A map not passed in
  `inputs` is made here from `SEED` with numpy instead (tileable), so the script runs without any.

Copy it to `assets/src/fps_arms.py`, fetch the scans with `cc0__fetch` at 2k, and call
`blender__model {name: "fps-arms", rig: true, inputs: "<the maps>"}`. A call takes at most 8 inputs:
pass the colour and normal maps of the surfaces you want scanned, and the rest are made here.
Change `SEED`, `TINT`, the colours in `LOOK` or the poses below and run it again for a variant. The game side is
`docs/examples/fps-arms/` (its README explains it).
"""

import math
import os
import tempfile

import bmesh
import numpy as np
from mathutils import Matrix, Quaternion, Vector

SEED = 11
FPS = 60
MAP = 1024
SMALL_MAP = 512
JPEG_QUALITY = 86

# Where the rifle's origin (the bore above the trigger) sits at the hip and when aiming, in kit
# space; aiming puts the sight line on the eye's axis, the receiver's rear past the camera's 0.1 m
# near plane (nearer, the plane cuts the dust cover open in the middle of the view).
SIGHT_HEIGHT = 0.045
HIP = Vector((0.1, 0.33, -0.115))
ADS = Vector((0.0, 0.33, -SIGHT_HEIGHT))
SPRINT = Vector((0.08, 0.3, -0.13))
RELOAD = Vector((0.07, 0.3, -0.045))
# The shoulders, and the arm's two lengths (m).
SHOULDER = {"R": Vector((0.2, -0.11, -0.25)), "L": Vector((-0.16, 0.04, -0.22))}
UPPER_ARM, FOREARM = 0.3, 0.29
# Which way each elbow bends (away from the body, down).
ELBOW_OUT = {"R": Vector((1.0, -0.2, -0.9)), "L": Vector((-1.0, -0.1, -0.9))}

# Rifle points in its own frame (y along the bore, z up, the origin on the bore above the trigger).
MAG_TOP = Vector((0.0, 0.058, -0.048))
GRIP_TOP, GRIP_BOTTOM = Vector((0.0, -0.046, -0.044)), Vector((0.0, -0.09, -0.158))
TRIGGER_PIVOT = Vector((0.0, 0.004, -0.047))
HANDLE = Vector((0.016, 0.018, 0.006))
MUZZLE = Vector((0.0, 0.562, 0.0))
SIGHT = Vector((0.0, 0.064, SIGHT_HEIGHT))
SIGHT_FRONT = Vector((0.0, 0.448, SIGHT_HEIGHT))
EJECT = Vector((0.02, -0.03, 0.006))
# How far the charging handle travels when the carrier cycles or is racked (m).
CARRIER_TRAVEL = 0.075

# Metres one texture tile covers on each surface, and each surface's look.
TILE = {"steel": 0.2, "wood": 0.35, "mag": 0.15, "glove": 0.12, "sleeve": 0.25}
LOOK = {
    "steel": {"base": (0.105, 0.105, 0.11), "rough": 0.48, "metal": 0.85},
    "wood": {"dark": (0.12, 0.065, 0.04), "light": (0.27, 0.15, 0.085), "rough": 0.36},
    "mag": {"base": (0.29, 0.1, 0.07), "rough": 0.55},
    "glove": {"base": (0.25, 0.235, 0.2), "rough": 0.72},
    "sleeve": {"base": (0.3, 0.32, 0.23), "rough": 0.9},
}
SLOTS = ["steel", "wood", "mag", "glove", "sleeve"]

# Each surface's CC0 scan at 2k, as `cc0__fetch` delivers it (ambientCG's Metal029 and Plastic014A;
# Poly Haven's dark_wood, leather_white and book_pattern). Pass the files in `inputs` (where a fetch
# lands them under another folder, use that path here). A map left out is made here from `SEED`
# instead, so the script also runs with no inputs at all.
def ambient_cg(id, metal=False):
    stem = f"assets/cc0/{id}/{id}_2K-JPG"
    maps = {"color": f"{stem}_Color.jpg", "normal": f"{stem}_NormalGL.jpg", "rough": f"{stem}_Roughness.jpg"}
    return {**maps, "metal": f"{stem}_Metalness.jpg"} if metal else maps


def poly_haven(id, colour="diff"):
    stem = f"assets/cc0/{id}/{id}"
    return {"color": f"{stem}_{colour}_2k.jpg", "normal": f"{stem}_nor_gl_2k.jpg", "arm": f"{stem}_arm_2k.jpg"}


SCANS = {
    "steel": ambient_cg("Metal029", metal=True),
    "wood": poly_haven("dark_wood"),
    "mag": ambient_cg("Plastic014A"),
    "glove": poly_haven("leather_white"),
    "sleeve": poly_haven("book_pattern", "col1"),
}
# A scan's colour multiplied by this: the orange plastic becomes the AK-74's plum bakelite, the
# white leather a grey coyote glove (never a skin tone), the cherry wood a darker stained birch.
TINT = {"mag": (0.3, 0.2, 0.3), "glove": (0.33, 0.31, 0.26), "wood": (0.72, 0.6, 0.55)}
# The least roughness a surface keeps: the rifle's finish is matte paint, not a mirror.
ROUGH_FLOOR = {"steel": 0.45, "wood": 0.35}
# Texels across in the GLB: the rifle's metal and wood and the hands fill the frame, so their colour keeps 2k.
COLOR_TEXELS = {"steel": 2048, "wood": 2048, "mag": 1024, "glove": 2048, "sleeve": 2048}
NORMAL_TEXELS = 1024
SURFACE_TEXELS = 512

# A metaball's surface lies this fraction of its radius out (threshold 0.6, stiffness 2).
BALL_SURFACE = 0.574
FINGER = 0.0088
rng = np.random.default_rng(SEED)
TEMP = tempfile.mkdtemp(prefix="fps-arms-")


# ── Textures ──────────────────────────────────────────────────────────────────────────────────


def noise(size, scale, stretch=1.0):
    """Zero-mean, unit noise that tiles: white noise low-passed in the frequency domain, its
    features about `scale` texels across (`stretch` > 1 draws them out along u)."""
    f = np.fft.fftfreq(size)
    fu, fv = np.meshgrid(f, f)
    keep = np.exp(-((fu * scale * stretch) ** 2 + (fv * scale) ** 2) * 4.0)
    field = np.real(np.fft.ifft2(np.fft.fft2(rng.standard_normal((size, size))) * keep))
    return (field - field.mean()) / (field.std() + 1e-9)


def fbm(size, scale, octaves=4, stretch=1.0):
    """Noise summed over octaves, each half the size and half the weight of the one before."""
    total = sum(noise(size, scale / 2**i, stretch) * 0.5**i for i in range(octaves))
    return total / total.std()


def normal_map(height, strength):
    """A tangent-space normal map (OpenGL: green up) of a tiling height field."""
    du = (np.roll(height, -1, axis=1) - np.roll(height, 1, axis=1)) * 0.5 * strength
    dv = (np.roll(height, -1, axis=0) - np.roll(height, 1, axis=0)) * 0.5 * strength
    n = np.stack([-du, -dv, np.ones_like(height)], axis=-1)
    return n / np.linalg.norm(n, axis=-1, keepdims=True) * 0.5 + 0.5


def tinted(base, variation):
    """An sRGB colour map: `base` lightened and darkened by a field in [-1, 1] (scaled by it)."""
    return np.clip(np.array(base)[None, None, :] * (1.0 + variation[..., None]), 0.0, 1.0)


def channels(rough, metal):
    """The roughness and metal map: green roughness, blue metal (glTF's metallicRoughness)."""
    size = rough.shape[0]
    return np.stack([np.ones((size, size)), np.clip(rough, 0.04, 1.0), np.broadcast_to(metal, (size, size))], axis=-1)


def downsized(field, size):
    """A field averaged down to `size` texels across."""
    step = field.shape[0] // size
    return field.reshape(size, step, size, step, *field.shape[2:]).mean(axis=(1, 3))


def save_map(name, rgb, colour):
    """`rgb` (rows from the bottom, values 0..1) as a JPEG the GLB carries as it is."""
    size = rgb.shape[0]
    path = os.path.join(TEMP, name + ".jpg")
    scratch = bpy.data.images.new(name + "-scratch", size, size, alpha=False)
    rgba = np.concatenate([np.clip(rgb, 0.0, 1.0), np.ones((size, size, 1))], axis=-1).astype(np.float32)
    scratch.pixels.foreach_set(rgba.ravel())
    scratch.file_format = "JPEG"
    scratch.save(filepath=path, quality=JPEG_QUALITY)
    bpy.data.images.remove(scratch)
    image = bpy.data.images.load(path)
    image.name = name
    image.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return image


def steel_maps():
    grain = fbm(MAP, 3.0, 3)
    streaks = noise(MAP, 6.0, stretch=12.0)
    worn = np.clip((streaks - 2.2) * 0.6, 0.0, 1.0)
    colour = tinted(LOOK["steel"]["base"], 0.05 * fbm(MAP, 90.0) + 0.03 * grain + 0.6 * worn)
    rough = LOOK["steel"]["rough"] + 0.08 * fbm(MAP, 60.0) + 0.03 * grain - 0.2 * worn
    height = 0.25 * grain - 0.6 * worn
    return colour, normal_map(height, 0.6), channels(downsized(rough, SMALL_MAP), LOOK["steel"]["metal"])


def wood_maps():
    warp = fbm(MAP, 160.0, 3, stretch=0.2)
    rings = 0.5 + 0.5 * np.sin(np.linspace(0.0, 2.0 * np.pi * 34.0, MAP, endpoint=False)[:, None] + warp * 1.2)
    pores = np.clip(noise(MAP, 1.2, stretch=6.0) - 1.2, 0.0, 1.0)
    figure = rings**3 * 0.5 + 0.5 * (0.5 + 0.5 * fbm(MAP, 30.0, 2, stretch=8.0))
    dark, light = np.array(LOOK["wood"]["dark"]), np.array(LOOK["wood"]["light"])
    colour = dark + (light - dark) * np.clip(figure - 0.35 * pores, 0.0, 1.0)[..., None]
    rough = LOOK["wood"]["rough"] + 0.05 * fbm(MAP, 50.0) + 0.25 * pores
    height = -0.5 * rings**3 - 1.5 * pores
    return colour, normal_map(height, 0.5), channels(downsized(rough, SMALL_MAP), 0.0)


def mag_maps():
    mottle = fbm(SMALL_MAP, 40.0)
    colour = tinted(LOOK["mag"]["base"], 0.1 * mottle + 0.04 * noise(SMALL_MAP, 1.5))
    return colour, normal_map(0.2 * noise(SMALL_MAP, 2.0), 0.5), channels(LOOK["mag"]["rough"] + 0.06 * mottle, 0.0)


def glove_maps():
    pebbles = 1.0 - np.abs(noise(MAP, 3.5))
    creases = np.clip(np.abs(fbm(MAP, 70.0, 3)) * -1.0 + 0.25, 0.0, 1.0)
    colour = tinted(LOOK["glove"]["base"], 0.12 * fbm(MAP, 80.0) + 0.05 * pebbles - 0.3 * creases)
    rough = LOOK["glove"]["rough"] + 0.06 * pebbles + 0.1 * creases
    return colour, normal_map(0.6 * pebbles - 2.0 * creases, 0.9), channels(downsized(rough, SMALL_MAP), 0.0)


def sleeve_maps():
    u = np.arange(MAP)
    weave = (np.sin(u * 2.0 * np.pi / 4.0)[None, :] * np.sin(u * 2.0 * np.pi / 4.0)[:, None]) * 0.5
    grid = np.maximum(np.cos(u * 2.0 * np.pi / 32.0)[None, :], np.cos(u * 2.0 * np.pi / 32.0)[:, None])
    ripstop = np.clip((grid - 0.92) * 12.0, 0.0, 1.0)
    mottle = fbm(MAP, 110.0, 3)
    colour = tinted(LOOK["sleeve"]["base"], 0.1 * mottle + 0.05 * weave + 0.07 * ripstop)
    height = weave + 1.5 * ripstop + 0.6 * fbm(MAP, 40.0, 2)
    return colour, normal_map(height, 0.7), channels(np.full((SMALL_MAP, SMALL_MAP), LOOK["sleeve"]["rough"]), 0.0)


def material(name, colour, normal, rough_metal):
    """A Principled material on a colour map, a normal map and a roughness/metal map."""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    shader = nodes["Principled BSDF"]
    base = nodes.new("ShaderNodeTexImage")
    base.image = colour
    links.new(base.outputs["Color"], shader.inputs["Base Color"])
    bump = nodes.new("ShaderNodeTexImage")
    bump.image = normal
    mapped = nodes.new("ShaderNodeNormalMap")
    links.new(bump.outputs["Color"], mapped.inputs["Color"])
    links.new(mapped.outputs["Normal"], shader.inputs["Normal"])
    surface = nodes.new("ShaderNodeTexImage")
    surface.image = rough_metal
    split = nodes.new("ShaderNodeSeparateColor")
    links.new(surface.outputs["Color"], split.inputs["Color"])
    links.new(split.outputs["Green"], shader.inputs["Roughness"])
    links.new(split.outputs["Blue"], shader.inputs["Metallic"])
    return mat


MAKERS = {"steel": steel_maps, "wood": wood_maps, "mag": mag_maps, "glove": glove_maps, "sleeve": sleeve_maps}


def read_scan(path):
    """The staged map at `path` as an array (rows from the bottom, RGB 0..1), or None when it was
    not passed in `inputs`."""
    staged = ASSET_INPUTS.get(path)
    if staged is None:
        return None
    image = bpy.data.images.load(staged)
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    bpy.data.images.remove(image)
    return pixels.reshape(height, width, 4)[..., :3]


def fit(field, size):
    """A square map averaged down to at most `size` texels across."""
    return downsized(field, size) if field.shape[0] > size else field


def unit_normals(field):
    """A normal map whose averaged texels are made unit length again."""
    n = field * 2.0 - 1.0
    return n / np.maximum(np.linalg.norm(n, axis=-1, keepdims=True), 1e-6) * 0.5 + 0.5


def surface_maps(surface):
    """A surface's colour, normal and roughness/metal maps: its scans where they were passed,
    the maps made here for the rest."""
    scans = {role: read_scan(path) for role, path in SCANS[surface].items()}
    made = []

    def fallback(index):
        if not made:
            made.extend(MAKERS[surface]())
        return made[index]

    colour = scans["color"] * np.array(TINT.get(surface, (1.0, 1.0, 1.0))) if scans["color"] is not None else fallback(0)
    normal = unit_normals(fit(scans["normal"], NORMAL_TEXELS)) if scans["normal"] is not None else fallback(1)
    if scans.get("arm") is not None:
        rough_metal = scans["arm"]
    elif scans.get("rough") is not None:
        metal = scans["metal"][..., 0] if scans.get("metal") is not None else 0.0
        rough_metal = channels(scans["rough"][..., 0], metal)
    else:
        rough_metal = fallback(2)
    rough_metal = fit(rough_metal, SURFACE_TEXELS).copy()
    rough_metal[..., 1] = np.maximum(rough_metal[..., 1], ROUGH_FLOOR.get(surface, 0.0))
    return fit(colour, COLOR_TEXELS[surface]), fit(normal, NORMAL_TEXELS), rough_metal


def materials():
    """The five surfaces, in `SLOTS` order."""
    made = []
    for surface in SLOTS:
        colour, normal, rough_metal = surface_maps(surface)
        made.append(material(surface, save_map(f"{surface}-color", colour, True), save_map(f"{surface}-normal", normal, False), save_map(f"{surface}-rm", rough_metal, False)))
    return made


# ── Geometry ──────────────────────────────────────────────────────────────────────────────────

KIT = bmesh.new()
DEFORM = KIT.verts.layers.deform.verify()
UV = KIT.loops.layers.uv.verify()
GROUPS = []  # vertex group names, by index


def group(bone):
    if bone not in GROUPS:
        GROUPS.append(bone)
    return GROUPS.index(bone)


def box(bm, center, size, matrix=None):
    """An axis-aligned box (in `matrix`'s frame when given)."""
    at = Matrix.Translation(center) @ Matrix.Diagonal((*size, 1.0))
    bmesh.ops.create_cube(bm, size=1.0, matrix=(matrix or Matrix()) @ at)


def cylinder(bm, start, end, radius, segments=20, radius_end=None):
    """A capped cylinder (or cone) from `start` to `end`."""
    axis = end - start
    turn = Vector((0.0, 0.0, 1.0)).rotation_difference(axis.normalized()).to_matrix().to_4x4()
    at = Matrix.Translation((start + end) * 0.5) @ turn
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments, radius1=radius, radius2=radius_end or radius, depth=axis.length, matrix=at)


def rounded(half_w, low, high, radius, corner=3):
    """A rounded rectangle across x (half width) and z (`low` to `high`), corners of `radius`, as
    (x, z) points counter-clockwise from the bottom right."""
    radius = min(radius, half_w, (high - low) * 0.5)
    points = []
    for cx, cz, start in ((half_w - radius, low + radius, -90), (half_w - radius, high - radius, 0), (-half_w + radius, high - radius, 90), (-half_w + radius, low + radius, 180)):
        for i in range(corner + 1):
            a = math.radians(start + 90.0 * i / corner)
            points.append((cx + radius * math.cos(a), cz + radius * math.sin(a)))
    return points


def sweep(bm, rings):
    """A closed tube through rings of points (each the same count), its ends capped."""
    verts = [[bm.verts.new(p) for p in ring] for ring in rings]
    count = len(rings[0])
    for a, b in zip(verts, verts[1:]):
        for i in range(count):
            j = (i + 1) % count
            bm.faces.new((a[i], a[j], b[j], b[i]))
    bm.faces.new(verts[0])
    bm.faces.new(list(reversed(verts[-1])))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])


def ring_y(y, profile, scale=1.0, lift=0.0):
    """A profile (x, z points) placed across the bore at `y`."""
    return [Vector((x * scale, y, z * scale + lift)) for x, z in profile]


def bevel(bm, offset, segments=2, angle=30.0):
    """Bevel every edge sharper than `angle` degrees."""
    edges = [e for e in bm.edges if e.is_manifold and math.degrees(e.calc_face_angle(0.0)) > angle]
    if edges:
        bmesh.ops.bevel(bm, geom=edges, offset=offset, segments=segments, profile=0.5, affect="EDGES", clamp_overlap=True)


def project_uvs(faces, tile, offset):
    """World-scale box projection: each face takes the plane its normal faces most, u along the
    rifle (y) wherever it can, so wood grain runs lengthwise."""
    for face in faces:
        n = face.normal
        axis = max(range(3), key=lambda i: abs(n[i]))
        for loop in face.loops:
            co = loop.vert.co
            u, v = ((co.y, co.z), (co.x, co.z), (co.y, co.x))[axis]
            loop[UV].uv = ((u + offset[0]) / tile, (v + offset[1]) / tile)


def merge(bm, slot, weights, uvs=None):
    """Append a part's mesh to the kit: its material, its bone weights (a group name or a function
    of the vertex), its UVs (world-scale box projection unless `uvs` maps them)."""
    mesh = bpy.data.meshes.new("part")
    bm.to_mesh(mesh)
    bm.free()
    first_vert, first_face = len(KIT.verts), len(KIT.faces)
    KIT.from_mesh(mesh)
    bpy.data.meshes.remove(mesh)
    KIT.verts.ensure_lookup_table()
    KIT.faces.ensure_lookup_table()
    faces = KIT.faces[first_face:]
    for face in faces:
        face.material_index = SLOTS.index(slot)
        face.smooth = True
    for vert in KIT.verts[first_vert:]:
        for bone, weight in (weights(vert.co) if callable(weights) else [(weights, 1.0)]):
            vert[DEFORM][group(bone)] = weight
    if uvs:
        uvs(faces)
    else:
        project_uvs(faces, TILE[slot], tuple(rng.uniform(0.0, 1.0, 2) * TILE[slot]))


def part(slot, bone, build, bevel_offset=0.0012, at=None):
    """One hard-surface part of the rifle, built in the rifle's frame and placed at the hip."""
    bm = bmesh.new()
    build(bm)
    if bevel_offset:
        bevel(bm, bevel_offset)
    bm.transform(Matrix.Translation(HIP) @ (at or Matrix()))
    merge(bm, slot, bone)


def receiver():
    """The receiver, dust cover, trunnions, rear sight, rail, selector, rivets and trigger guard."""
    steel = lambda build, offset=0.0012: part("steel", "weapon", build, offset)
    steel(lambda bm: box(bm, Vector((0.0, -0.045, -0.02)), (0.03, 0.255, 0.056)))
    cover = rounded(0.0158, 0.004, 0.0298, 0.0125, 4)
    steel(lambda bm: sweep(bm, [ring_y(-0.178, cover, 0.96), ring_y(-0.172, cover), ring_y(0.046, cover)]), 0.0)
    steel(lambda bm: box(bm, Vector((0.0, -0.183, 0.014)), (0.012, 0.01, 0.01)))
    steel(lambda bm: box(bm, Vector((0.0, -0.178, -0.012)), (0.032, 0.014, 0.05)))
    steel(lambda bm: box(bm, Vector((0.0, 0.092, -0.012)), (0.034, 0.022, 0.06)))
    steel(lambda bm: box(bm, Vector((0.0, 0.085, 0.022)), (0.026, 0.05, 0.022)))
    steel(lambda bm: box(bm, Vector((0.0, 0.064, 0.039)), (0.024, 0.004, 0.012)), 0.0005)
    for side in (-1.0, 1.0):
        steel(lambda bm, s=side: box(bm, Vector((s * 0.0068, 0.064, 0.0475)), (0.0104, 0.004, 0.005)), 0.0004)
    steel(lambda bm: box(bm, Vector((0.0, 0.077, 0.0355)), (0.028, 0.008, 0.006)), 0.0006)
    steel(lambda bm: box(bm, Vector((-0.0165, -0.075, -0.018)), (0.004, 0.1, 0.016)), 0.0006)
    steel(lambda bm: box(bm, Vector((0.0162, -0.1, -0.004)), (0.003, 0.11, 0.012)), 0.0006)
    steel(lambda bm: box(bm, Vector((0.018, -0.047, -0.013)), (0.004, 0.012, 0.018)), 0.0006)
    for y in (-0.152, -0.128, 0.062, 0.074):
        for z in (-0.036, -0.012):
            for side in (-1.0, 1.0):
                start = Vector((side * 0.015, y, z))
                steel(lambda bm, a=start, s=side: cylinder(bm, a, a + Vector((s * 0.0014, 0.0, 0.0)), 0.0022, 8), 0.0)
    steel(lambda bm: box(bm, Vector((0.0, -0.007, -0.0715)), (0.01, 0.07, 0.005)), 0.0008)
    steel(lambda bm: box(bm, Vector((0.0, 0.026, -0.061)), (0.01, 0.005, 0.026)), 0.0008)
    steel(lambda bm: box(bm, Vector((0.0, 0.026, -0.056)), (0.012, 0.006, 0.016)), 0.0006)


def barrel():
    """The barrel, gas block and tube, front sight, retainer band and muzzle brake."""
    steel = lambda build, offset=0.0012: part("steel", "weapon", build, offset)
    steel(lambda bm: cylinder(bm, Vector((0.0, 0.103, 0.0)), Vector((0.0, 0.52, 0.0)), 0.0085), 0.0)
    steel(lambda bm: cylinder(bm, Vector((0.0, 0.105, 0.024)), Vector((0.0, 0.335, 0.024)), 0.0085), 0.0)
    steel(lambda bm: box(bm, Vector((0.0, 0.335, 0.012)), (0.022, 0.03, 0.036)))
    steel(lambda bm: box(bm, Vector((0.0, 0.445, 0.006)), (0.02, 0.026, 0.03)))
    steel(lambda bm: box(bm, Vector((0.0, 0.448, 0.028)), (0.012, 0.014, 0.016)))
    steel(lambda bm: box(bm, SIGHT_FRONT - Vector((0.0, 0.0, 0.0045)), (0.003, 0.003, 0.009)), 0.0004)
    for side in (-1.0, 1.0):
        steel(lambda bm, s=side: box(bm, Vector((s * 0.0078, 0.448, 0.036)), (0.003, 0.012, 0.03)), 0.0005)
    band = rounded(0.0205, -0.023, 0.016, 0.014, 4)
    steel(lambda bm: sweep(bm, [ring_y(0.299, band), ring_y(0.311, band)]), 0.0)
    steel(lambda bm: cylinder(bm, Vector((0.0, 0.52, 0.0)), Vector((0.0, 0.552, 0.0)), 0.0115), 0.0)
    steel(lambda bm: cylinder(bm, Vector((0.0, 0.552, 0.0)), MUZZLE, 0.0105, 20, 0.009), 0.0)


def furniture():
    """The wooden handguards, pistol grip and stock, and the steel butt plate."""
    wood = lambda build: part("wood", "weapon", build, 0.0)
    upper = rounded(0.0158, 0.012, 0.038, 0.013, 4)
    wood(lambda bm: sweep(bm, [ring_y(0.104, upper, 0.94), ring_y(0.112, upper), ring_y(0.272, upper), ring_y(0.282, upper, 0.92)]))
    lower = rounded(0.0235, -0.038, 0.012, 0.017, 4)
    wood(lambda bm: sweep(bm, [ring_y(0.104, lower, 0.95), ring_y(0.115, lower), ring_y(0.2, lower, 1.04), ring_y(0.288, lower), ring_y(0.3, lower, 0.88)]))
    stock = [(-0.186, 0.014, -0.042, -0.014), (-0.3, 0.0168, -0.08, -0.03), (-0.43, 0.0188, -0.118, -0.042)]
    wood(lambda bm: sweep(bm, [ring_y(y, rounded(w, low, high, 0.009, 3)) for y, w, low, high in stock]))
    plate = rounded(0.0195, -0.12, -0.04, 0.009, 3)
    part("steel", "weapon", lambda bm: sweep(bm, [ring_y(-0.4295, plate), ring_y(-0.436, plate)]), 0.0)
    axis = (GRIP_BOTTOM - GRIP_TOP).normalized()
    fore = (Vector((0.0, 1.0, 0.0)) - axis * axis.y).normalized()
    grip = rounded(0.0145, -0.022, 0.022, 0.011, 4)
    rings = []
    for t, flare in ((0.0, 1.0), (0.85, 1.04), (1.0, 1.07)):
        center = GRIP_TOP.lerp(GRIP_BOTTOM, t)
        rings.append([center + Vector((x * flare, 0.0, 0.0)) + fore * (d * flare) for x, d in grip])
    wood(lambda bm: sweep(bm, rings))


def moving_parts():
    """The magazine, the charging handle (with the carrier's face in the port) and the trigger."""
    radius, sweep_angle = 0.32, 0.6
    center = MAG_TOP + Vector((0.0, radius, -0.002))
    rings = []
    for i in range(9):
        phi = sweep_angle * i / 8
        out = Vector((0.0, -math.cos(phi), -math.sin(phi)))
        depth = 0.026 + 0.006 * i / 8
        profile = rounded(0.0128, -depth, depth, 0.0045, 2)
        rings.append([center + out * radius + Vector((x, 0.0, 0.0)) + out * d for x, d in profile])
    part("mag", "magazine", lambda bm: sweep(bm, rings), 0.0)
    out = Vector((0.0, -math.cos(sweep_angle), -math.sin(sweep_angle)))
    floor = center + out * (radius + 0.004)
    tangent = Vector((0.0, math.sin(sweep_angle), -math.cos(sweep_angle)))
    floor_profile = rounded(0.0142, -0.034, 0.034, 0.005, 2)
    part("mag", "magazine", lambda bm: sweep(bm, [[floor + tangent * s + Vector((x, 0.0, 0.0)) + out * d for x, d in floor_profile] for s in (0.0, 0.008)]), 0.0)
    part("steel", "charging_handle", lambda bm: box(bm, Vector((0.025, 0.018, 0.006)), (0.018, 0.01, 0.009)), 0.0008)
    part("steel", "charging_handle", lambda bm: cylinder(bm, Vector((0.032, 0.018, 0.006)), Vector((0.045, 0.018, 0.006)), 0.0068, 14), 0.0)
    part("steel", "charging_handle", lambda bm: box(bm, Vector((0.0155, -0.032, 0.006)), (0.0016, 0.07, 0.012)), 0.0)
    blade = Matrix.Translation(TRIGGER_PIVOT) @ Matrix.Rotation(0.22, 4, "X")
    part("steel", "trigger", lambda bm: box(bm, Vector((0.0, 0.002, -0.01)), (0.006, 0.005, 0.021), blade), 0.0008)


# ── Arms ──────────────────────────────────────────────────────────────────────────────────────


def frame(x_axis, y_axis, origin):
    """A frame with the given x and y axes (y is kept, x made square to it)."""
    y = y_axis.normalized()
    z = x_axis.cross(y).normalized()
    x = y.cross(z)
    m = Matrix((x, y, z)).transposed().to_4x4()
    m.translation = origin
    return m


def grip_frame(axis_dir, palm_dir, axis_point, grip_radius, side):
    """Where the hand's frame goes so the cylinder it grips (its across-the-knuckles axis) lies on
    the rifle's `axis_point`, the palm facing along `palm_dir`. The hand's frame: x along `axis_dir`
    (toward the thumb on a right hand, the little finger on a left one, whose fingers are mirrored),
    y toward the fingers, z out of the palm."""
    x = axis_dir.normalized()
    z = (palm_dir - x * palm_dir.dot(x)).normalized()
    y = z.cross(x)
    m = Matrix((x, y, z)).transposed().to_4x4()
    middle = Vector((0.006 if side == "R" else -0.006, 0.057, 0.013 + grip_radius))
    m.translation = axis_point - m.to_3x3() @ middle
    return m


def capsule(mball, a, b, radius):
    el = mball.elements.new(type="CAPSULE")
    el.co = (a + b) * 0.5
    el.radius = radius / BALL_SURFACE
    el.size_x = max((b - a).length * 0.5, 1e-4)
    el.rotation = Vector((1.0, 0.0, 0.0)).rotation_difference((b - a).normalized() if (b - a).length > 1e-6 else Vector((1.0, 0.0, 0.0)))


def ellipsoid(mball, at, half, turn):
    el = mball.elements.new(type="ELLIPSOID")
    el.co = at
    el.radius = 1.0 / BALL_SURFACE
    el.size_x, el.size_y, el.size_z = half
    el.rotation = turn


def hand_bones(grip_radius, side, trigger=None, start=62.0):
    """A gripping hand's finger chains in the hand's frame (x toward the thumb for a right hand):
    each finger's joints wrap the cylinder of `grip_radius` its across-the-knuckles axis holds."""
    mirror = 1.0 if side == "R" else -1.0
    reach = grip_radius + FINGER
    yc, zc = 0.057, 0.013 + grip_radius

    def around(x, theta):
        return Vector((x * mirror, yc + reach * math.sin(theta), zc - reach * math.cos(theta)))

    def wrap(x, lengths, first=0.0):
        theta = math.radians(start + first)
        points = [around(x, theta)]
        for length in lengths:
            theta += 2.0 * math.asin(min(0.99, length / (2.0 * reach)))
            points.append(around(x, theta))
        return points

    fingers = {
        "index": (wrap(0.024, (0.042, 0.025, 0.021)), FINGER),
        "middle": (wrap(0.005, (0.045, 0.028, 0.022)), FINGER * 1.04),
        "ring": (wrap(-0.014, (0.042, 0.026, 0.021)), FINGER * 0.98),
        "pinky": (wrap(-0.031, (0.032, 0.02, 0.018), 8.0), FINGER * 0.86),
    }
    if trigger is not None:
        fingers["index"] = (trigger, FINGER)
    thumb = [Vector((0.026 * mirror, 0.012, 0.004))]
    for theta, x in ((-0.45, 0.031), (-1.45, 0.028), (-2.15, 0.024)):
        thumb.append(Vector((x * mirror, yc + (reach + 0.002) * math.sin(theta), zc - (reach + 0.002) * math.cos(theta))))
    fingers["thumb"] = (thumb, FINGER * 1.12)
    return fingers


def metaballs(name, resolution):
    """An empty metaball object in the scene. Each is a family of its own: its elements blend
    with each other and never with another object's."""
    mball = bpy.data.metaballs.new(name)
    mball.resolution = mball.render_resolution = resolution
    obj = bpy.data.objects.new(name, mball)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def build_hand(name, hand_matrix, fingers):
    """One gloved hand as metaballs in kit space: the cuff, palm and knuckle pad as one blend,
    and each finger a blend of its own, so the creases between the fingers stay."""
    turn = hand_matrix.to_quaternion()
    place = lambda p: hand_matrix @ p
    palm = metaballs(f"{name}-palm", 0.0026)
    ellipsoid(palm.data, place(Vector((0.0, -0.03, -0.002))), (0.031, 0.034, 0.024), turn)
    ellipsoid(palm.data, place(Vector((0.0, 0.035, 0.002))), (0.039, 0.044, 0.014), turn)
    ellipsoid(palm.data, place(Vector((0.0, 0.07, -0.011))), (0.036, 0.012, 0.006), turn)
    parts = [palm]
    for finger, (points, radius) in fingers.items():
        obj = metaballs(f"{name}-{finger}", 0.0018)
        world = [place(p) for p in points]
        for i, (a, b) in enumerate(zip(world, world[1:])):
            capsule(obj.data, a, b, radius * (1.0 - 0.07 * i))
        parts.append(obj)
    return parts


def build_sleeve(name, shoulder, elbow, wrist):
    """A jacket sleeve from the shoulder to just above the glove's cuff, with folds."""
    mball = bpy.data.metaballs.new(name)
    mball.resolution = mball.render_resolution = 0.006
    obj = bpy.data.objects.new(name, mball)
    bpy.context.scene.collection.objects.link(obj)
    end = wrist + (elbow - wrist).normalized() * 0.02
    capsule(mball, shoulder, elbow, 0.05)
    capsule(mball, elbow, elbow.lerp(end, 0.5), 0.044)
    capsule(mball, elbow.lerp(end, 0.5), end, 0.038)
    axis = (end - elbow).normalized()
    side = axis.orthogonal().normalized()
    for t in np.linspace(0.1, 0.85, 7):
        angle = rng.uniform(0.0, 2.0 * math.pi)
        out = Quaternion(axis, angle) @ side
        at = elbow.lerp(end, float(t)) + out * 0.03
        ellipsoid(mball, at, (0.012, 0.024, 0.008), Vector((0.0, 1.0, 0.0)).rotation_difference(out.cross(axis).normalized()))
    return obj


def metaball_mesh(obj, ratio):
    """The metaball's surface as a mesh, decimated to `ratio` of its faces."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    raw = bpy.data.meshes.new_from_object(obj.evaluated_get(depsgraph))
    holder = bpy.data.objects.new(obj.name + "-mesh", raw)
    bpy.context.scene.collection.objects.link(holder)
    decimate = holder.modifiers.new("decimate", "DECIMATE")
    decimate.ratio = ratio
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(holder.evaluated_get(depsgraph))
    for gone in (holder, obj):
        bpy.data.objects.remove(gone)
    bpy.data.meshes.remove(raw)
    return mesh


def smoothstep(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3.0 - 2.0 * t)


def sleeve_uvs(elbow, wrist, shoulder):
    """Cylindrical UVs about the forearm and the upper arm: one tile around (the seam underneath),
    world scale along."""

    def uvs(faces):
        for face in faces:
            coords = []
            for loop in face.loops:
                co = loop.vert.co
                fore = (co - elbow).dot((wrist - elbow).normalized()) > -0.02
                a, b = (elbow, wrist) if fore else (shoulder, elbow)
                axis = (b - a).normalized()
                side = axis.cross(Vector((0.0, 0.0, -1.0))).normalized()
                up = axis.cross(side)
                rel = co - a
                angle = math.atan2(rel.dot(up), rel.dot(side))
                coords.append([angle / (2.0 * math.pi), rel.dot(axis) / TILE["sleeve"] + (0.0 if fore else 0.37)])
            us = [c[0] for c in coords]
            if max(us) - min(us) > 0.5:
                for c in coords:
                    c[0] += 1.0 if c[0] < 0.0 else 0.0
            for loop, (u, v) in zip(face.loops, coords):
                loop[UV].uv = (u * 2.0, v)

    return uvs


def two_bone(shoulder, wrist, bend):
    """The elbow of an arm reaching from `shoulder` to `wrist`, bent toward `bend`."""
    reach = wrist - shoulder
    distance = min(reach.length, UPPER_ARM + FOREARM - 0.002)
    along = (UPPER_ARM**2 - FOREARM**2 + distance**2) / (2.0 * distance)
    height = math.sqrt(max(0.0, UPPER_ARM**2 - along**2))
    axis = reach.normalized()
    out = (bend - axis * bend.dot(axis)).normalized()
    return shoulder + axis * along + out * height


# ── Rig and clips ─────────────────────────────────────────────────────────────────────────────


def place_bone(bone, matrix, length):
    """Put an edit bone at `matrix` (its y along the bone, its z for the roll), `length` long."""
    head = matrix.translation
    bone.head = head
    bone.tail = head + matrix.col[1].xyz.normalized() * length
    bone.align_roll(matrix.col[2].xyz)


def build_rig(hands):
    """The armature: the rifle's bones and sockets, the arms, the IK targets and poles."""
    data = bpy.data.armatures.new("fps-arms")
    rig = bpy.data.objects.new("fps-arms", data)
    bpy.context.scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    bones = data.edit_bones

    def straight(name, head, parent, deform=True, length=0.04):
        bone = bones.new(name)
        bone.head, bone.tail = head, head + Vector((0.0, length, 0.0))
        bone.parent = bones.get(parent) if parent else None
        bone.use_deform = deform
        return bone

    straight("root", Vector(), None, False, 0.05)
    straight("weapon", HIP, "root", True, 0.1)
    straight("magazine", HIP + MAG_TOP, "weapon")
    straight("charging_handle", HIP + HANDLE, "weapon")
    straight("trigger", HIP + TRIGGER_PIVOT, "weapon", True, 0.02)
    for name, at in (("muzzle", MUZZLE), ("sight", SIGHT), ("sight_front", SIGHT_FRONT), ("eject", EJECT)):
        straight(name, HIP + at, "weapon", False, 0.02)
    for side, hand in hands.items():
        wrist = hand.translation
        elbow = two_bone(SHOULDER[side], wrist, ELBOW_OUT[side])
        normal = (elbow - SHOULDER[side]).cross(wrist - SHOULDER[side]).normalized()
        upper = bones.new(f"upperarm.{side}")
        place_bone(upper, frame(normal, elbow - SHOULDER[side], SHOULDER[side]), (elbow - SHOULDER[side]).length)
        upper.parent = bones["root"]
        fore = bones.new(f"forearm.{side}")
        place_bone(fore, frame(normal, wrist - elbow, elbow), (wrist - elbow).length)
        fore.parent = upper
        fore.use_connect = True
        for name, parent in ((f"hand.{side}", fore), (f"ik_hand.{side}", bones["weapon"])):
            bone = bones.new(name)
            place_bone(bone, hand, 0.08)
            bone.parent = parent
            bone.use_deform = name.startswith("hand")
        pole = straight(f"pole.{side}", elbow + (elbow - (SHOULDER[side] + wrist) * 0.5).normalized() * 0.3, "root", False)
        pole.use_deform = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for side in hands:
        fore = rig.pose.bones[f"forearm.{side}"]
        ik = fore.constraints.new("IK")
        ik.target, ik.subtarget = rig, f"ik_hand.{side}"
        ik.pole_target, ik.pole_subtarget = rig, f"pole.{side}"
        ik.chain_count = 2
        ik.use_tail = True
        ik.pole_angle = best_pole_angle(rig, fore, ik)
        turn = rig.pose.bones[f"hand.{side}"].constraints.new("COPY_ROTATION")
        turn.target, turn.subtarget = rig, f"ik_hand.{side}"
    for bone in rig.pose.bones:
        bone.rotation_mode = "QUATERNION"
    return rig


def best_pole_angle(rig, fore, ik):
    """The pole angle that keeps the arm in its rest pose when its target is at rest."""

    def error(angle):
        ik.pole_angle = angle
        bpy.context.view_layer.update()
        return (fore.head - fore.bone.head_local).length

    candidates = [math.radians(a) for a in range(-180, 180, 5)]
    best = min(candidates, key=error)
    fine = [best + math.radians(d) / 10.0 for d in range(-50, 51)]
    return min(fine, key=error)


def euler(x=0.0, y=0.0, z=0.0):
    """A rotation of x about the rifle's right axis (muzzle up), y about its bore (top to the right)
    and z about up (muzzle left)."""
    return Quaternion((0.0, 0.0, 1.0), z) @ Quaternion((0.0, 1.0, 0.0), y) @ Quaternion((1.0, 0.0, 0.0), x)


def ease(t):
    t = min(1.0, max(0.0, t))
    return t * t * (3.0 - 2.0 * t)


def between(t, start, end):
    """0 before `start`, 1 after `end`, eased between."""
    return ease((t - start) / (end - start))


def blend(a, b, s):
    return (a[0].lerp(b[0], s), a[1].slerp(b[1], s))


# The rifle at the hip turns its muzzle a little left and up, so its right side shows.
HIP_TURN = Quaternion((0.0, 0.0, 1.0), 0.1) @ Quaternion((1.0, 0.0, 0.0), 0.03)
HIP_POSE = (HIP, HIP_TURN)
ADS_POSE = (ADS, Quaternion())


def hip(offset=Vector(), turn=Quaternion()):
    """The hip pose moved by `offset` and turned by `turn`, both in the rifle's own frame."""
    return (HIP + HIP_TURN @ offset, HIP_TURN @ turn)


def idle(t):
    breath = math.sin(2.0 * math.pi * t / 4.0)
    drift = math.sin(2.0 * math.pi * t / 2.0)
    return {"weapon": hip(Vector((0.0008 * drift, 0.0, 0.0016 * breath)), euler(0.004 * breath, 0.0, 0.003 * drift))}


def walk(t):
    phase = 2.0 * math.pi * t
    offset = Vector((0.007 * math.sin(phase), 0.003 * math.sin(2.0 * phase), -0.008 * abs(math.sin(phase))))
    return {"weapon": hip(offset, euler(0.01 * math.sin(2.0 * phase), 0.025 * math.sin(phase), 0.015 * math.sin(phase)))}


def sprint(t):
    phase = 2.0 * math.pi * t / 0.6667
    offset = Vector((0.012 * math.sin(phase), 0.006 * math.sin(2.0 * phase), -0.014 * abs(math.sin(phase))))
    return {"weapon": (SPRINT + offset, euler(-0.3 + 0.03 * math.sin(2.0 * phase), 0.45 + 0.05 * math.sin(phase), 0.75))}


def ads_in(t):
    s = between(t, 0.0, 0.25)
    position, turn = blend(HIP_POSE, ADS_POSE, s)
    return {"weapon": (position + Vector((0.0, 0.0, 0.006 * math.sin(math.pi * s))), turn @ euler(0.0, -0.12 * math.sin(math.pi * s)))}


def ads(t):
    breath = math.sin(2.0 * math.pi * t / 2.0)
    return {"weapon": (ADS + Vector((0.0, 0.0, 0.0004 * breath)), euler(0.0006 * breath))}


def ads_out(t):
    return ads_in(0.25 - t)


def fire(t):
    kick = (t / 0.012 if t < 0.012 else math.exp(-(t - 0.012) / 0.022)) * (1.0 - between(t, 0.07, 0.1))
    carrier = between(t, 0.004, 0.03) * (1.0 - between(t, 0.04, 0.075))
    pull = between(t, 0.0, 0.01) * (1.0 - between(t, 0.05, 0.08))
    return {
        "weapon": hip(Vector((0.0, -0.02 * kick, 0.004 * kick)), euler(0.04 * kick, 0.01 * kick, 0.006 * kick)),
        "charging_handle": (HANDLE + Vector((0.0, -CARRIER_TRAVEL * carrier, 0.0)), Quaternion()),
        "trigger": (TRIGGER_PIVOT, euler(-0.3 * pull)),
    }


def dry_fire(t):
    pull = between(t, 0.0, 0.05) * (1.0 - between(t, 0.12, 0.22))
    click = between(t, 0.04, 0.05) * (1.0 - between(t, 0.05, 0.12))
    return {"weapon": hip(Vector((0.0, -0.002 * click, 0.0)), euler(0.004 * click)), "trigger": (TRIGGER_PIVOT, euler(-0.3 * pull))}


def reload_pose():
    """The rifle canted toward the support hand and lifted for the reload."""
    return (RELOAD, euler(0.5, 1.05, 0.3))


def reload(t):
    """The old magazine rocks out (0.45-0.6 s), is held clear of the well (0.6-0.85 s) and drops
    away; a new one comes up, is held under the well (1.35-1.55 s), hooks in and rocks home
    (1.55-1.85 s); the support hand racks the handle (2.15-2.3 s) and goes back to the handguard."""
    pose = blend(blend(HIP_POSE, reload_pose(), between(t, 0.0, 0.3)), HIP_POSE, between(t, 2.3, 2.6))
    hand_rest = REST["ik_hand.L"]
    grab = euler(0.0, math.pi / 2.0) @ hand_rest[1]
    at_mag = (MAG_TOP + Vector((-0.03, 0.05, -0.12)), grab)
    at_handle = (HANDLE + Vector((0.006, 0.04, -0.07)), euler(-0.4, -math.pi / 2.0) @ hand_rest[1])
    clear = Vector((0.0, 0.05, -0.15))
    below = Vector((0.06, -0.06, -0.4))
    rocked = euler(0.32)
    hooked = MAG_TOP + Vector((0.0, 0.012, -0.004))
    if t < 1.0:
        out = between(t, 0.45, 0.6)
        away = clear * between(t, 0.6, 0.75) + (below - clear) * between(t, 0.85, 1.0)
        mag = (MAG_TOP.lerp(hooked, out) + away, Quaternion().slerp(rocked, out))
        hand = blend(hand_rest, at_mag, between(t, 0.05, 0.4))
        hand = (hand[0] + away, euler(0.0, 0.0, 0.4 * between(t, 0.85, 1.0)) @ hand[1])
        return {"weapon": pose, "ik_hand.L": hand, "magazine": mag}
    if t < 1.9:
        up = clear + (below - clear) * (1.0 - between(t, 1.1, 1.35))
        away = up * (1.0 - between(t, 1.55, 1.7))
        seat = between(t, 1.7, 1.85)
        mag = (hooked.lerp(MAG_TOP, seat) + away, rocked.slerp(Quaternion(), seat))
        hand = (at_mag[0] + away + (mag[0] - MAG_TOP - away) * 0.0, grab)
        return {"weapon": pose, "ik_hand.L": hand, "magazine": mag}
    rack = between(t, 2.15, 2.27) * (1.0 - between(t, 2.3, 2.34))
    hand = blend(at_mag, at_handle, between(t, 1.9, 2.12))
    hand = (hand[0] + Vector((0.0, -0.08 * between(t, 2.15, 2.27), 0.0)), hand[1])
    hand = blend(hand, hand_rest, between(t, 2.32, 2.58))
    return {"weapon": pose, "ik_hand.L": hand, "charging_handle": (HANDLE + Vector((0.0, -0.085 * rack, 0.0)), Quaternion())}


def inspect(t):
    left = (HIP + Vector((-0.06, 0.02, 0.035)), euler(0.25, -0.75, 0.55))
    right = (HIP + Vector((-0.05, 0.0, 0.05)), euler(0.3, 0.9, 0.6))
    pose = blend(HIP_POSE, left, between(t, 0.0, 0.55))
    pose = blend(pose, right, between(t, 1.35, 2.0))
    return {"weapon": blend(pose, HIP_POSE, between(t, 2.55, 3.2))}


CLIPS = [
    ("Idle", 4.0, idle),
    ("Walk", 1.0, walk),
    ("Sprint", 0.6667, sprint),
    ("AdsIn", 0.25, ads_in),
    ("Ads", 2.0, ads),
    ("AdsOut", 0.25, ads_out),
    ("Fire", 0.1, fire),
    ("DryFire", 0.3, dry_fire),
    ("Reload", 2.6, reload),
    ("Inspect", 3.2, inspect),
]
KEYED = ["weapon", "magazine", "charging_handle", "trigger", "ik_hand.L"]
REST = {}


def parent_space_rest(rig, name):
    bone = rig.data.bones[name]
    parent = bone.parent.matrix_local if bone.parent else Matrix()
    return parent.inverted() @ bone.matrix_local


def key_clips(rig):
    """Each clip as an action of its own on an NLA track, every bone keyed on every frame."""
    rests = {name: parent_space_rest(rig, name) for name in KEYED}
    for name, matrix in rests.items():
        REST[name] = (matrix.to_translation() - (HIP if name != "weapon" else Vector()), matrix.to_quaternion())
    REST["weapon"] = HIP_POSE
    for name in ("magazine", "charging_handle", "trigger"):
        REST[name] = (rests[name].to_translation(), Quaternion())
    REST["ik_hand.L"] = (rests["ik_hand.L"].to_translation(), rests["ik_hand.L"].to_quaternion())
    data = rig.animation_data_create()
    for clip, seconds, pose in CLIPS:
        action = bpy.data.actions.new(clip)
        action.use_fake_user = True
        data.action = action
        frames = round(seconds * FPS)
        for f in range(frames + 1):
            posed = pose(min(f / FPS, seconds))
            for bone in KEYED:
                position, turn = posed.get(bone, REST[bone])
                desired = Matrix.Translation(position) @ turn.to_matrix().to_4x4()
                pb = rig.pose.bones[bone]
                pb.matrix_basis = rests[bone].inverted() @ desired
                pb.keyframe_insert("location", frame=f)
                pb.keyframe_insert("rotation_quaternion", frame=f)
        track = data.nla_tracks.new()
        track.name = clip
        track.strips.new(clip, 0, action)
        data.action = None
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()


def arm_weights(side, shoulder, elbow, wrist):
    def weights(co):
        fore = smoothstep(-0.05, 0.03, (co - elbow).dot((wrist - elbow).normalized()))
        return [(f"upperarm.{side}", 1.0 - fore), (f"forearm.{side}", fore)] if fore < 1.0 else [(f"forearm.{side}", 1.0)]

    return weights


def glove_weights(side, hand):
    wrist, along = hand.translation, hand.to_3x3() @ Vector((0.0, 1.0, 0.0))

    def weights(co):
        h = smoothstep(-0.045, -0.01, (co - wrist).dot(along))
        return [(f"hand.{side}", h), (f"forearm.{side}", 1.0 - h)] if h < 1.0 else [(f"hand.{side}", 1.0)]

    return weights


def build():
    bpy.context.scene.render.fps = FPS
    mats = materials()
    receiver()
    barrel()
    furniture()
    moving_parts()
    rest = Matrix.Translation(HIP)
    grip_axis = (GRIP_TOP - GRIP_BOTTOM).normalized()
    right = grip_frame(grip_axis, Vector((-1.0, 0.35, 0.0)), rest @ GRIP_TOP.lerp(GRIP_BOTTOM, 0.33), 0.017, "R")
    left = grip_frame(Vector((0.0, -1.0, 0.0)), Vector((0.0, 0.0, 1.0)), rest @ Vector((0.0, 0.2, -0.013)), 0.025, "L")
    to_hand = right.inverted()
    trigger_touch = rest @ (TRIGGER_PIVOT + Vector((0.002, 0.006, -0.012)))
    index_mcp = hand_bones(0.017, "R")["index"][0][0]
    trigger_chain = [index_mcp, to_hand @ (trigger_touch + Vector((0.02, -0.03, 0.002))), to_hand @ (trigger_touch + Vector((0.008, -0.004, 0.0))), to_hand @ (trigger_touch + Vector((-0.006, 0.004, -0.004)))]
    hands = {"R": right, "L": left}
    fingers = {"R": hand_bones(0.017, "R", trigger_chain), "L": hand_bones(0.025, "L", start=20.0)}
    for side, hand in hands.items():
        wrist = hand.translation
        elbow = two_bone(SHOULDER[side], wrist, ELBOW_OUT[side])
        for piece in build_hand(f"glove{side}", hand, fingers[side]):
            glove = metaball_mesh(piece, 0.3)
            bm = bmesh.new()
            bm.from_mesh(glove)
            bpy.data.meshes.remove(glove)
            merge(bm, "glove", glove_weights(side, hand))
        sleeve = metaball_mesh(build_sleeve(f"sleeve{side}", SHOULDER[side], elbow, wrist), 0.18)
        bm = bmesh.new()
        bm.from_mesh(sleeve)
        bpy.data.meshes.remove(sleeve)
        merge(bm, "sleeve", arm_weights(side, SHOULDER[side], elbow, wrist), sleeve_uvs(elbow, wrist, SHOULDER[side]))
    rig = build_rig(hands)
    mesh = bpy.data.meshes.new("fps-arms")
    KIT.to_mesh(mesh)
    KIT.free()
    for mat in mats:
        mesh.materials.append(mat)
    body = bpy.data.objects.new("fps-arms-mesh", mesh)
    bpy.context.scene.collection.objects.link(body)
    for name in GROUPS:
        body.vertex_groups.new(name=name)
    body.parent = rig
    normals = body.modifiers.new("normals", "WEIGHTED_NORMAL")
    normals.keep_sharp = True
    skin = body.modifiers.new("skin", "ARMATURE")
    skin.object = rig
    key_clips(rig)


build()
