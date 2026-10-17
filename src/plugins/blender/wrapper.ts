/**
 * The Python the studio runs inside headless Blender (AG-930). The builder's file is `exec`'d
 * inside it: the builder starts from an empty scene, creates objects with `bpy`, and leaves
 * them there. It must not export, render or save — the wrapper does all three, the same way
 * every time, so the file in `assets/` and the render in the run folder never depend on what a
 * contractor remembered to write.
 *
 * Arguments after `--`: the script, the GLB, the first render and the asset name, then flags:
 * `--rig 0|1` (also export armatures and their actions, each armature's scale applied to its bones
 * and clips), `--model <file>` (a transform's source) and, for a compose job, `--inputs <labels>`
 * with one `--slot <file>` per label. A label is the game path of an extra input, or `model`; the
 * script reads them as `ASSET_INPUTS[label]`.
 *
 * Output contract: one line on stdout, `STUDIO_BLENDER_RESULT {json}`, with `ok`, what is in
 * the file (`meshes: [{name, polygons, triangles, materials, slots}]`, where `slots` holds each
 * material slot's `{slot, material, polygons, triangles}`, `materials: [names]`,
 * `armatures: [{name, bones}]`, `actions: [names]`, `rig`), the totals (`polygons`,
 * `triangles`, `size`, `glbBytes`, `seconds`) and the two render paths, or `ok:false` and the
 * error. Anything else Blender prints is noise the studio clips.
 *
 * The renders draw each material in colour: Workbench shows a material's viewport colour, which
 * stays grey when a script sets only its shader's Base Color, so the wrapper copies that colour
 * across (or draws the image feeding it) after the export, leaving the file as the script made it.
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
import bpy, bmesh, json, math, os, shutil, sys, tempfile, time, traceback
from mathutils import Vector
t0 = time.time()
argv = sys.argv[sys.argv.index("--") + 1:]
script, out_glb, out_png, name = argv[0], argv[1], argv[2], argv[3]
out_front = out_png[:-4] + "-front.png" if out_png.lower().endswith(".png") else out_png + "-front.png"
MARGIN = 1.15         # the framed box fills ~87 % of its tightest axis (its corners; the mesh itself less)
VOLUME_SHARE = 0.95   # meshes are framed by volume until this share is in frame
MAX_LISTED = 100      # meshes named in the result line
MODEL_LABEL = "model" # the compose job's label for a transform's source
NEW_MATERIAL_COLOUR = (0.8, 0.8, 0.8, 1.0)  # a new material's viewport colour, before anyone sets it
TEXTURE_LINKS = 4     # links followed up from a Base Color to find the image feeding it
UNIT_TOLERANCE = 1e-4 # an armature scale this close to 1 is left as it is

def result(payload):
    print("STUDIO_BLENDER_RESULT " + json.dumps(payload))
    sys.stdout.flush()

def flags(rest):
    # The flags after the four positional arguments, each with one value; --slot repeats.
    found = {"rig": "0", "model": None, "inputs": "", "slot": []}
    for i in range(0, len(rest) - 1, 2):
        key, value = rest[i][2:], rest[i + 1]
        if key == "slot":
            found["slot"].append(value)
        else:
            found[key] = value
    return found

def asset_inputs(given):
    # ASSET_INPUTS: the model, and each extra input under its game path. Extras are copied under
    # their own file names into one scratch folder that is also on sys.path, so a shared module
    # imports by name and an image keeps its name.
    inputs = {MODEL_LABEL: given["model"]} if given["model"] else {}
    labels = [label for label in given["inputs"].split(",") if label]
    if not labels:
        return inputs
    folder = tempfile.mkdtemp(prefix="inputs-")
    sys.path.insert(0, folder)
    for label, staged in zip(labels, given["slot"]):
        if label == MODEL_LABEL:
            inputs[MODEL_LABEL] = staged
            continue
        local = os.path.join(folder, os.path.basename(label))
        shutil.copyfile(staged, local)
        inputs[label] = local
    return inputs

given = flags(argv[4:])
rig = given["rig"] == "1"
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

src = open(script, encoding="utf-8").read()
try:
    exec(compile(src, script, "exec"), {"__name__": "__main__", "bpy": bpy, "math": math, "ASSET_NAME": name, "ASSET_INPUTS": asset_inputs(given)})
except Exception:
    result({"ok": False, "error": traceback.format_exc()[-1500:]})
    sys.exit(1)

meshes = [o for o in scene.objects if o.type == "MESH"]
armatures = [o for o in scene.objects if o.type == "ARMATURE"]
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
    # Faces and triangles per material slot: a slot that drew nothing, or drew the wrong part, shows.
    per_slot = {}
    tris = 0
    for p in me.polygons:
        t = max(0, p.loop_total - 2)
        tris += t
        counted = per_slot.setdefault(p.material_index, [0, 0])
        counted[0] += 1
        counted[1] += t
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
    slot_names = [slot.material.name[:60] if slot.material else None for slot in o.material_slots]
    slot_count = max([len(slot_names)] + [index + 1 for index in per_slot])
    detail.append({
        "name": o.name[:60],
        "polygons": polys,
        "triangles": tris,
        "materials": [m.name[:60] for m in o.data.materials if m],
        "slots": [
            {
                "slot": index,
                "material": slot_names[index] if index < len(slot_names) else None,
                "polygons": per_slot.get(index, [0, 0])[0],
                "triangles": per_slot.get(index, [0, 0])[1],
            }
            for index in range(slot_count)
        ][:MAX_LISTED],
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

def fcurves_of(action):
    # An action's curves: Blender 5 keeps them in its layers' channel bags, older Blender on the action.
    legacy = getattr(action, "fcurves", None)
    if legacy is not None:
        return list(legacy)
    return [curve for layer in action.layers for strip in layer.strips for bag in strip.channelbags for curve in bag.fcurves]

def actions_of(armature):
    data = armature.animation_data
    if data is None:
        return []
    found = [data.action] if data.action else []
    for track in data.nla_tracks:
        found.extend(strip.action for strip in track.strips if strip.action)
    return list(dict.fromkeys(found))

def normalise(armature):
    # An armature scaled s (Genex's Meshy rigs hang under 0.01 with their bones in centimetres) is applied to its
    # bones, its skinned meshes and its clips' bone locations, so every bone, the root included, is in metres at
    # scale 1: an exporter that applied the scale to the object alone left the root bone at x100. The scale applied,
    # or None for an armature at scale 1 or one scaled unevenly.
    s = armature.scale
    if max(abs(s.x - s.y), abs(s.x - s.z)) > UNIT_TOLERANCE or abs(s.x - 1.0) <= UNIT_TOLERANCE:
        return None
    factor = s.x
    bpy.ops.object.select_all(action="DESELECT")
    for o in [armature] + [child for child in armature.children_recursive if child.type == "MESH"]:
        o.select_set(True)
    bpy.context.view_layer.objects.active = armature
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    for action in actions_of(armature):
        for curve in fcurves_of(action):
            if curve.data_path.startswith("pose.bones[") and curve.data_path.endswith(".location"):
                for key in curve.keyframe_points:
                    key.co.y *= factor
                    key.handle_left.y *= factor
                    key.handle_right.y *= factor
    return round(factor, 6)

applied = {o.name: normalise(o) for o in armatures} if rig else {}

bpy.ops.object.select_all(action="DESELECT")
for o in meshes + (armatures if rig else []):
    o.select_set(True)
# Armatures, their skins and actions only on request: the default stays one static mesh file.
rig_export = {"export_skins": True, "export_animations": True} if rig else {}
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
    **rig_export,
)

def base_colour_input(material):
    # The colour input of the shader the material's output draws: Base Color, or a plain Color.
    tree = material.node_tree
    if tree is None:
        return None
    outputs = [n for n in tree.nodes if n.type == "OUTPUT_MATERIAL" and n.inputs["Surface"].is_linked]
    if not outputs:
        return None
    shader = outputs[0].inputs["Surface"].links[0].from_node
    return shader.inputs.get("Base Color") or shader.inputs.get("Color")

def image_feeding(socket, links_left):
    # The image texture node behind a colour input, at most TEXTURE_LINKS links up.
    if not socket.is_linked or links_left == 0:
        return None
    node = socket.links[0].from_node
    if node.type == "TEX_IMAGE" and node.image is not None:
        return node
    for upstream in node.inputs:
        found = image_feeding(upstream, links_left - 1)
        if found is not None:
            return found
    return None

def is_new_colour(colour):
    # Viewport colours are stored as 32-bit floats, so compare within a hair of 0.8.
    return all(abs(a - b) < 1e-4 for a, b in zip(colour, NEW_MATERIAL_COLOUR))

def show_colours():
    # Copy each shader's Base Color to the viewport colour Workbench draws, unless the script set
    # one; a textured material shows its image instead. Returns the Workbench colour mode to use.
    textured = False
    for material in bpy.data.materials:
        socket = base_colour_input(material)
        if socket is None:
            continue
        image = image_feeding(socket, TEXTURE_LINKS)
        if image is not None:
            material.node_tree.nodes.active = image
            textured = True
        elif not socket.is_linked and is_new_colour(material.diffuse_color):
            material.diffuse_color = tuple(socket.default_value)
    return "TEXTURE" if textured else "MATERIAL"

# "What did I make" thumbnails: Workbench, studio light, the camera fitted to the framed box.
scene.render.engine = "BLENDER_WORKBENCH"
scene.display.shading.light = "STUDIO"
scene.display.shading.color_type = show_colours()
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
    "armatures": [
        {"name": o.name[:60], "bones": len(o.data.bones), **({"appliedScale": applied[o.name]} if applied.get(o.name) else {})}
        for o in armatures
    ][:MAX_LISTED],
    "actions": sorted(a.name[:60] for a in bpy.data.actions)[:MAX_LISTED],
    "rig": rig,
    "glbBytes": os.path.getsize(out_glb),
    "renders": [out_png, out_front],
    "seconds": round(time.time() - t0, 2),
})
`;
