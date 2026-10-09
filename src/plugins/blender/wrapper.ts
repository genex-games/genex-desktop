/**
 * The Python the studio runs inside headless Blender (AG-930). The builder's file is `exec`'d
 * inside it: the builder starts from an empty scene, creates objects with `bpy`, and leaves
 * them there. It must not export, render or save — the wrapper does all three, the same way
 * every time, so the file in `assets/` and the render in the run folder never depend on what a
 * contractor remembered to write.
 *
 * Output contract: one line on stdout, `STUDIO_BLENDER_RESULT {json}`, with `ok`, what is in
 * the file (`meshes: [{name, polygons, triangles, materials}]`, `materials: [names]`), the
 * totals (`polygons`, `triangles`, `size`, `glbBytes`, `seconds`) and the two render paths, or
 * `ok:false` and the error. Anything else Blender prints is noise the studio clips.
 *
 * Two renders per call: a three-quarter view (`<out>.png`) and a front view
 * (`<out>-front.png`). Framing is exact — every corner of the framed box is fitted inside the
 * frame with `MARGIN` to spare — and the framed box leaves out thin tails: meshes are added in
 * order of volume until 95 % of the asset's volume is in frame, so a cable or an antenna can
 * hang out of the picture but the cups it belongs to never get cropped (measured on the first
 * chat build: the cable dominated the bounds, the headband was clipped).
 */
export const STUDIO_BLENDER_RESULT = "STUDIO_BLENDER_RESULT ";

/** Render size of each view. */
export const BLENDER_RENDER_SIZE: readonly [number, number] = [512, 384];

/** `<out>.png` → `<out>-front.png`: the second view the wrapper writes beside the first. */
export function frontRenderPath(png: string): string {
  return png.replace(/\.png$/i, "") + "-front.png";
}

export const BLENDER_WRAPPER_PY = String.raw`
import bpy, bmesh, json, math, os, sys, time, traceback
from mathutils import Vector
t0 = time.time()
argv = sys.argv[sys.argv.index("--") + 1:]
script, out_glb, out_png, name = argv[0], argv[1], argv[2], argv[3]
extra = argv[4:]
out_fbx = None
if "--fbx" in extra:
    flag = extra.index("--fbx")
    out_fbx = extra[flag + 1]
    del extra[flag:flag + 2]
model_input = extra[0] if extra else None
out_front = out_png[:-4] + "-front.png" if out_png.lower().endswith(".png") else out_png + "-front.png"
MARGIN = 1.15         # the framed box fills ~87 % of its tightest axis (its corners; the mesh itself less)
VOLUME_SHARE = 0.95   # meshes are framed by volume until this share is in frame
MAX_LISTED = 100      # meshes named in the result line

def result(payload):
    print("STUDIO_BLENDER_RESULT " + json.dumps(payload))
    sys.stdout.flush()

bpy.ops.wm.read_factory_settings(use_empty=True)
if sys.platform == "win32":
    # The trusted wrapper lives in this job's scratch folder, which remains inside its sandbox.
    bpy.context.preferences.filepaths.temporary_directory = os.path.dirname(os.path.abspath(__file__))
scene = bpy.context.scene

src = open(script, encoding="utf-8").read()
try:
    exec(compile(src, script, "exec"), {"__name__": "__main__", "bpy": bpy, "math": math, "ASSET_NAME": name, "ASSET_INPUTS": ({"model": model_input} if model_input else {})})
except Exception:
    result({"ok": False, "error": traceback.format_exc()[-1500:]})
    sys.exit(1)

meshes = [o for o in scene.objects if o.type == "MESH"]
if not meshes:
    result({"ok": False, "error": "the script left no mesh objects in the scene"})
    sys.exit(1)

# Measure the asset the way the game will see it: modifiers applied, world space.
depsgraph = bpy.context.evaluated_depsgraph_get()
detail = []
per_mesh = []   # (volume, bounds) per mesh, for the framing
xs, ys, zs = [], [], []
for o in meshes:
    ev = o.evaluated_get(depsgraph)
    me = ev.to_mesh()
    polys = len(me.polygons)
    tris = sum(max(0, len(p.vertices) - 2) for p in me.polygons)
    bx, by, bz = [], [], []
    for v in me.vertices:
        w = ev.matrix_world @ v.co
        bx.append(w.x); by.append(w.y); bz.append(w.z)
    if not bx:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            bx.append(w.x); by.append(w.y); bz.append(w.z)
    volume = 0.0
    try:
        bm = bmesh.new()
        bm.from_mesh(me)
        bm.transform(ev.matrix_world)
        volume = abs(bm.calc_volume(signed=True))
        bm.free()
    except Exception:
        volume = 0.0
    ev.to_mesh_clear()
    bounds = (min(bx), max(bx), min(by), max(by), min(bz), max(bz))
    xs += [bounds[0], bounds[1]]; ys += [bounds[2], bounds[3]]; zs += [bounds[4], bounds[5]]
    per_mesh.append((volume, bounds))
    detail.append({
        "name": o.name[:60],
        "polygons": polys,
        "triangles": tris,
        "materials": [m.name[:60] for m in o.data.materials if m],
    })
size = [max(xs) - min(xs), max(ys) - min(ys), max(zs) - min(zs)]
polygons = sum(d["polygons"] for d in detail)
triangles = sum(d["triangles"] for d in detail)
material_names = []
for d in detail:
    for m in d["materials"]:
        if m not in material_names:
            material_names.append(m)

# The framed box: meshes by volume, largest first, until VOLUME_SHARE of the total is in.
total_volume = sum(v for v, _ in per_mesh)
framed = sorted(per_mesh, key=lambda t: -t[0])
if total_volume > 0:
    kept, acc = [], 0.0
    for v, b in framed:
        kept.append(b)
        acc += v
        if acc >= total_volume * VOLUME_SHARE:
            break
    framed = kept
else:
    framed = [b for _, b in framed]
fx0 = min(b[0] for b in framed); fx1 = max(b[1] for b in framed)
fy0 = min(b[2] for b in framed); fy1 = max(b[3] for b in framed)
fz0 = min(b[4] for b in framed); fz1 = max(b[5] for b in framed)
corners = [Vector((x, y, z)) for x in (fx0, fx1) for y in (fy0, fy1) for z in (fz0, fz1)]
centre = Vector(((fx0 + fx1) / 2, (fy0 + fy1) / 2, (fz0 + fz1) / 2))
extent = max(fx1 - fx0, fy1 - fy0, fz1 - fz0) or 1.0

bpy.ops.object.select_all(action="DESELECT")
for o in meshes:
    o.select_set(True)
bpy.ops.export_scene.gltf(
    filepath=out_glb,
    export_format="GLB",
    use_selection=True,
    export_apply=True,
    export_yup=True,
    export_texcoords=True,
    export_normals=True,
    export_materials="EXPORT",
    export_image_format="AUTO",
)
if out_fbx:
    # Unity imports FBX without a glTF package. Export the same selected, evaluated meshes.
    bpy.ops.export_scene.fbx(
        filepath=out_fbx,
        use_selection=True,
        object_types={"MESH"},
        use_mesh_modifiers=True,
        axis_forward="-Z",
        axis_up="Y",
        apply_unit_scale=True,
        add_leaf_bones=False,
        bake_anim=False,
        path_mode="COPY",
        embed_textures=True,
    )

# "What did I make" thumbnails, with the camera fitted to the framed box.
if sys.platform == "win32":
    # Windows LPAC jobs render on CPU: vendor OpenGL drivers require broader OS access.
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 16
    scene.world = bpy.data.worlds.new("studio-world")
    scene.world.use_nodes = True
    scene.world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.6, 0.6, 0.6, 1)
    scene.world.node_tree.nodes["Background"].inputs["Strength"].default_value = 1
else:
    scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = "MATERIAL"
scene.render.resolution_x, scene.render.resolution_y = 512, 384
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
cam_data = bpy.data.cameras.new("studio-cam")
cam_data.sensor_fit = "HORIZONTAL"
cam = bpy.data.objects.new("studio-cam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam
tan_h = math.tan(cam_data.angle / 2)
tan_v = tan_h * scene.render.resolution_y / scene.render.resolution_x

def shoot(direction, path):
    # Camera on the given direction from the centre, pulled back until every corner is inside the
    # frame with MARGIN to spare: in camera space a corner at (cx, cy, cz) needs the camera at
    # a distance d >= cz + |cx| * MARGIN / tan_h (and the same for y with tan_v).
    d = Vector(direction).normalized()
    rot = d.to_track_quat("Z", "Y")           # camera looks down -Z; +Z of the camera points at us
    inv = rot.inverted()
    dist = extent
    for c in corners:
        local = inv @ (c - centre)
        dist = max(dist, local.z + abs(local.x) * MARGIN / tan_h, local.z + abs(local.y) * MARGIN / tan_v)
    cam.location = centre + d * dist
    cam.rotation_euler = rot.to_euler()
    cam_data.clip_start = max(0.01, dist * 0.01)
    cam_data.clip_end = max(dist * 10, 100.0)
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)

shoot((0.6, -0.7, 0.45), out_png)      # three-quarter, from the front-right, above
shoot((0.0, -1.0, 0.18), out_front)    # front (Blender's -Y), a touch above

result({
    "ok": True,
    "meshes": detail[:MAX_LISTED],
    "meshCount": len(detail),
    "polygons": polygons,
    "triangles": triangles,
    "size": size,
    "framedSize": [fx1 - fx0, fy1 - fy0, fz1 - fz0],
    "materials": material_names[:MAX_LISTED],
    "glbBytes": os.path.getsize(out_glb),
    **({"fbxBytes": os.path.getsize(out_fbx)} if out_fbx else {}),
    "renders": [out_png, out_front],
    "seconds": round(time.time() - t0, 2),
})
`;
