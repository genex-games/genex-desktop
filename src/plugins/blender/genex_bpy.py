"""Genex's bpy helpers for blender__model scripts: `import genex_bpy as gx`.

Studio ships this module beside the wrapper and puts it on the import path of every job, so a
script never copies it. It makes the steps that turn a block-out into an asset that holds up close
one call each, on Blender 4.2 to 5.2:

- surfaces from real scans: `gx.scan(ASSET_INPUTS, "concrete_wall_008")` finds a fetched scan's
  maps among the job's inputs, and `gx.pbr(name, maps)` builds a Principled material from them
  (colour in sRGB; normal, roughness, metalness as data) that the glTF export writes as base
  colour, normal and metallic-roughness maps;
- edges that catch light: `gx.bevel(obj)` (a small bevel with hardened normals) and
  `gx.weighted_normals(obj)`, both applied at export;
- texture space: `gx.smart_uv(obj)` unwraps, `gx.world_uv(obj, metres)` scales the islands so a
  tiling scan repeats every `metres` metres, whatever the object's size;
- wear and one atlas: `gx.bake_atlas(objects, wear=0.5)` bakes every material of the objects,
  with curvature edge wear when `wear` is above 0, into one non-overlapping colour, normal and
  metallic-roughness atlas with one UV set, the shape the engine imports;
- heavy models: `gx.load(ASSET_INPUTS["model"])` imports a GLB, `gx.decimate_to(objects, 40000)`
  brings it to a triangle budget (collapse, applied at export), `gx.triangles(objects)` counts.

There is no flat-colour box here: `gx.slab(...)` is a bevelled, unwrapped cuboid that refuses a
material without an image texture, because a box of one colour on screen fails Genex's Art bar.
Organic shapes (trees, rocks, people, food) never come from stacked primitives: fetch them
(cc0__fetch) or generate them (genex__asset model) and use this module to finish them.
"""

import math
import os

import bmesh
import bpy

# Bevel width in metres and its segments: a 4 mm round that catches a highlight on a 1 m prop.
BEVEL_WIDTH_M = 0.004
BEVEL_SEGMENTS = 2
# Edges sharper than this get bevelled and keep their crease in the weighted normals.
SHARP_ANGLE_DEG = 30.0
# Smart UV's island angle and the gap between islands, in UV units.
UV_ANGLE_DEG = 66.0
UV_MARGIN = 0.004
# Bake settings: atlas size, Cycles samples, and the margin bled around islands (px).
ATLAS_PX = 1024
BAKE_SAMPLES = 8
BAKE_MARGIN_PX = 8
# Curvature (Cycles pointiness) where edge wear starts and where it is full, around 0.5 = flat.
WEAR_FROM = 0.52
WEAR_FULL = 0.58
# The colour worn edges lighten towards: bare, dusty material.
WEAR_COLOUR = (0.78, 0.75, 0.70, 1.0)
# A map's role by the word its file name carries: Poly Haven's (`_diff_1k`), ambientCG's
# (`_Color`) and Genex texture's (`-basecolor`) vocabularies, as gx.pbr reads them.
MAP_ROLE_WORDS = {
    "diff": "diff", "diffuse": "diff", "color": "diff", "basecolor": "diff", "albedo": "diff",
    "nor_gl": "nor_gl", "normalgl": "nor_gl", "normal": "nor_gl",
    "arm": "arm",
    "rough": "rough", "roughness": "rough",
    "metal": "metal", "metallic": "metal", "metalness": "metal",
    "ao": "ao", "ambientocclusion": "ao", "occlusion": "ao",
}
ATLAS_UV = "atlas"


def _select_only(objects):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]


def _meshes(objects):
    return [obj for obj in objects if obj.type == "MESH"]


def triangles(objects):
    """The objects' triangles as the export will write them: modifiers applied."""
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in _meshes(objects):
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        total += sum(max(0, poly.loop_total - 2) for poly in mesh.polygons)
        evaluated.to_mesh_clear()
    return total


def load(path):
    """Import a GLB (`ASSET_INPUTS["model"]`); the new mesh objects."""
    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    return [obj for obj in bpy.context.scene.objects if obj not in before and obj.type == "MESH"]


def decimate_to(objects, budget):
    """Bring the objects to about `budget` triangles with a collapse decimation, applied at export."""
    current = triangles(objects)
    if current <= budget:
        return current
    ratio = budget / current
    for obj in _meshes(objects):
        modifier = obj.modifiers.new("gx_decimate", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
    return triangles(objects)


def bevel(obj, width=BEVEL_WIDTH_M, segments=BEVEL_SEGMENTS, angle_deg=SHARP_ANGLE_DEG):
    """A small bevel on edges sharper than `angle_deg`, normals hardened, then weighted normals."""
    modifier = obj.modifiers.new("gx_bevel", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    modifier.angle_limit = math.radians(angle_deg)
    modifier.harden_normals = True
    modifier.miter_outer = "MITER_ARC"
    weighted_normals(obj)
    return obj


def weighted_normals(obj):
    """Smooth shading weighted by face area, sharp edges kept: flat faces stay flat, rounds read round."""
    obj.data.shade_smooth()
    if not any(modifier.type == "WEIGHTED_NORMAL" for modifier in obj.modifiers):
        modifier = obj.modifiers.new("gx_weighted_normals", "WEIGHTED_NORMAL")
        modifier.keep_sharp = True
    return obj


def smart_uv(obj, angle_deg=UV_ANGLE_DEG, margin=UV_MARGIN, uv_name=None):
    """Unwrap `obj` into non-overlapping islands (into `uv_name`, made active, when given)."""
    if uv_name is not None:
        # The new layer becomes the one edited and baked into; the render layer the materials sample stays.
        layer = obj.data.uv_layers.get(uv_name) or obj.data.uv_layers.new(name=uv_name)
        obj.data.uv_layers.active = layer
    elif not obj.data.uv_layers:
        obj.data.uv_layers.new(name="UVMap")
    _select_only([obj])
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.uv.smart_project(angle_limit=math.radians(angle_deg), island_margin=margin)
    bpy.ops.object.mode_set(mode="OBJECT")
    return obj


def world_uv(obj, metres_per_tile=1.0):
    """Scale `obj`'s active UVs so a tiling texture repeats every `metres_per_tile` metres on it."""
    if not obj.data.uv_layers:
        smart_uv(obj)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bm.transform(obj.matrix_world)
    uv = bm.loops.layers.uv.active
    world_area = sum(face.calc_area() for face in bm.faces)
    uv_area = 0.0
    for face in bm.faces:
        points = [loop[uv].uv for loop in face.loops]
        uv_area += abs(sum(a.x * b.y - b.x * a.y for a, b in zip(points, points[1:] + points[:1]))) / 2
    bm.free()
    if uv_area <= 0 or world_area <= 0:
        return obj
    scale = math.sqrt(world_area / uv_area) / metres_per_tile
    for loop in obj.data.uv_layers.active.data:
        loop.uv = loop.uv * scale
    return obj


def _role_of(name):
    """A map file's role from its name's words ("nor_gl" read as one word), or None."""
    words = name.lower().rsplit(".", 1)[0].replace("nor_gl", "normalgl").replace("_", "-").split("-")
    roles = [MAP_ROLE_WORDS[word] for word in words if word in MAP_ROLE_WORDS]
    return roles[-1] if roles else None


def scan(inputs, stem):
    """
    The maps of a fetched scan or a Genex texture set among a job's inputs, by role:
    {"diff": path, "nor_gl": path, "arm": path, ...}. `stem` is the part of the file names the set
    shares ("concrete_wall_008", "mossy-cobblestone-a1b2c3d4").
    """
    found = {}
    for label, path in inputs.items():
        name = os.path.basename(label)
        if stem.lower() not in name.lower():
            continue
        role = _role_of(name)
        if role is not None:
            found[role] = path
    return found


def image(path, colour=True):
    """An image file loaded once, in sRGB for colour or as data for normals, roughness and metalness."""
    loaded = bpy.data.images.load(path, check_existing=True)
    loaded.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return loaded


def _texture(nodes, links, path, colour, location, uv=None):
    node = nodes.new("ShaderNodeTexImage")
    node.image = image(path, colour)
    node.location = location
    if uv is not None:
        links.new(uv.outputs["UV"], node.inputs["Vector"])
    return node


def pbr(name, maps, roughness=0.6, metallic=0.0):
    """
    A Principled material from a scan's maps (`gx.scan`): diff colour, nor_gl normal, and either arm
    (occlusion, roughness, metalness packed) or rough and metal apart. Missing maps fall back to the
    given roughness and metallic factors; a material with no diff map is refused (flat colour).
    """
    if "diff" not in maps:
        raise ValueError(f"{name}: a material needs a colour map (diff); flat colour fails the Art bar")
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = nodes.get("Principled BSDF")
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metallic
    diff = _texture(nodes, links, maps["diff"], True, (-600, 300))
    links.new(diff.outputs["Color"], shader.inputs["Base Color"])
    if "nor_gl" in maps:
        normal_map = nodes.new("ShaderNodeNormalMap")
        normal_map.location = (-250, -300)
        nor = _texture(nodes, links, maps["nor_gl"], False, (-600, -300))
        links.new(nor.outputs["Color"], normal_map.inputs["Color"])
        links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    if "arm" in maps:
        arm = _texture(nodes, links, maps["arm"], False, (-600, 0))
        split = nodes.new("ShaderNodeSeparateColor")
        split.location = (-300, 0)
        links.new(arm.outputs["Color"], split.inputs["Color"])
        links.new(split.outputs["Green"], shader.inputs["Roughness"])
        links.new(split.outputs["Blue"], shader.inputs["Metallic"])
        return material
    for role, socket in (("rough", "Roughness"), ("metal", "Metallic")):
        if role in maps:
            node = _texture(nodes, links, maps[role], False, (-600, -600 if role == "metal" else -450))
            links.new(node.outputs["Color"], shader.inputs[socket])
    return material


def is_textured(material):
    """Whether `material`'s Base Color is fed by an image: anything else is flat colour."""
    if material is None or not material.use_nodes:
        return False
    shader = next((node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED"), None)
    if shader is None:
        return False
    pending = [link.from_node for link in shader.inputs["Base Color"].links]
    seen = set()
    while pending:
        node = pending.pop()
        if node.name in seen:
            continue
        seen.add(node.name)
        if node.type == "TEX_IMAGE" and node.image is not None:
            return True
        pending.extend(link.from_node for socket in node.inputs for link in socket.links)
    return False


def assign(obj, material):
    """`material` as `obj`'s only material."""
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def slab(name, size, material, location=(0.0, 0.0, 0.0), bevel_width=BEVEL_WIDTH_M, metres_per_tile=1.0):
    """
    A cuboid of `size` metres (x, y, z) standing on `location`, bevelled, weighted-normal shaded and
    unwrapped at `metres_per_tile`, with a scanned `material`. Refuses a flat-colour material.
    """
    if not is_textured(material):
        raise ValueError(f"{name}: give slab a scanned or generated material (gx.pbr); flat colour fails the Art bar")
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for vertex in bm.verts:
        vertex.co.x *= size[0]
        vertex.co.y *= size[1]
        vertex.co.z = (vertex.co.z + 0.5) * size[2]
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    obj.location = location
    bpy.context.scene.collection.objects.link(obj)
    assign(obj, material)
    smart_uv(obj)
    world_uv(obj, metres_per_tile)
    bevel(obj, width=bevel_width)
    return obj


def _atlas_image(name, size, colour):
    atlas = bpy.data.images.new(name, size, size, alpha=False, float_buffer=False)
    atlas.colorspace_settings.name = "sRGB" if colour else "Non-Color"
    return atlas


def _target(material, atlas):
    """`atlas` as the active image node of `material`: where Cycles bakes it."""
    node = material.node_tree.nodes.new("ShaderNodeTexImage")
    node.name = "gx_bake_target"
    node.image = atlas
    material.node_tree.nodes.active = node
    return node


def _add_wear(material, amount):
    """Mix the Base Color towards worn edges by curvature; returns what to undo."""
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    socket = shader.inputs["Base Color"]
    source = socket.links[0].from_socket if socket.links else None
    geometry = nodes.new("ShaderNodeNewGeometry")
    ramp = nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = WEAR_FROM
    ramp.color_ramp.elements[1].position = WEAR_FULL
    mix = nodes.new("ShaderNodeMix")
    mix.data_type = "RGBA"
    # The Mix node keeps one A, B and Result socket per data type under the same names: take the colour ones.
    colour_a, colour_b = [each for each in mix.inputs if each.type == "RGBA"][:2]
    result = next(each for each in mix.outputs if each.type == "RGBA")
    links.new(geometry.outputs["Pointiness"], ramp.inputs["Fac"])
    scaled = nodes.new("ShaderNodeMath")
    scaled.operation = "MULTIPLY"
    scaled.inputs[1].default_value = amount
    links.new(ramp.outputs["Color"], scaled.inputs[0])
    links.new(scaled.outputs["Value"], mix.inputs[0])
    if source is not None:
        links.new(source, colour_a)
    else:
        colour_a.default_value = socket.default_value
    colour_b.default_value = WEAR_COLOUR
    links.new(result, socket)
    return (material, source, [geometry, ramp, scaled, mix])


def _remove_wear(undo):
    material, source, added = undo
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    for node in added:
        nodes.remove(node)
    if source is not None:
        links.new(source, shader.inputs["Base Color"])


def _metal_as_emission(material):
    """Route Metallic into an emission-only output for an EMIT bake; returns what to undo."""
    nodes, links = material.node_tree.nodes, material.node_tree.links
    shader = next(node for node in nodes if node.type == "BSDF_PRINCIPLED")
    output = next(node for node in nodes if node.type == "OUTPUT_MATERIAL")
    old = output.inputs["Surface"].links[0].from_socket if output.inputs["Surface"].links else None
    emission = nodes.new("ShaderNodeEmission")
    metal = shader.inputs["Metallic"]
    if metal.links:
        links.new(metal.links[0].from_socket, emission.inputs["Color"])
    else:
        value = metal.default_value
        emission.inputs["Color"].default_value = (value, value, value, 1.0)
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return (material, output, old, emission)


def _restore_surface(undo):
    material, output, old, emission = undo
    material.node_tree.nodes.remove(emission)
    if old is not None:
        material.node_tree.links.new(old, output.inputs["Surface"])


def _pack_arm(roughness, metalness, size):
    """One metallic-roughness image (R occlusion 1, G roughness, B metalness) from two baked ones."""
    import numpy

    count = size * size * 4
    rough = numpy.empty(count, dtype=numpy.float32)
    metal = numpy.empty(count, dtype=numpy.float32)
    roughness.pixels.foreach_get(rough)
    metalness.pixels.foreach_get(metal)
    packed = numpy.ones(count, dtype=numpy.float32)
    packed[1::4] = rough[0::4]
    packed[2::4] = metal[0::4]
    arm = _atlas_image("gx_atlas_arm", size, False)
    arm.pixels.foreach_set(packed)
    return arm


def _bake(kind, pass_filter=None):
    options = {"type": kind, "margin": BAKE_MARGIN_PX, "use_clear": True}
    if pass_filter is not None:
        options["pass_filter"] = pass_filter
    bpy.ops.object.bake(**options)


def _bake_into(materials, atlas, kind, pass_filter=None):
    targets = [(material, _target(material, atlas)) for material in materials]
    _bake(kind, pass_filter)
    for material, node in targets:
        material.node_tree.nodes.remove(node)


def bake_atlas(objects, size=ATLAS_PX, wear=0.0, samples=BAKE_SAMPLES, name="atlas"):
    """
    Bake every material of `objects` into one atlas per object set: colour (with curvature edge wear
    when `wear` > 0, 0..1), tangent-space normal and metallic-roughness, on a fresh non-overlapping
    UV set that becomes each object's only one; each object then carries one material sampling the
    atlas. Uses Cycles on the CPU; a 1024 atlas of a 10k-triangle prop takes seconds.
    """
    meshes = _meshes(objects)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    materials = list({slot.material for obj in meshes for slot in obj.material_slots if slot.material})
    for material in materials:
        material.use_nodes = True
    for obj in meshes:
        smart_uv(obj, uv_name=ATLAS_UV)
    _select_only(meshes)
    colour = _atlas_image(f"{name}_diff", size, True)
    normal = _atlas_image(f"{name}_nor", size, False)
    rough = _atlas_image(f"{name}_rough", size, False)
    metal = _atlas_image(f"{name}_metal", size, False)
    worn = [_add_wear(material, wear) for material in materials] if wear > 0 else []
    _bake_into(materials, colour, "DIFFUSE", {"COLOR"})
    for undo in worn:
        _remove_wear(undo)
    _bake_into(materials, normal, "NORMAL")
    _bake_into(materials, rough, "ROUGHNESS")
    emitting = [_metal_as_emission(material) for material in materials]
    _bake_into(materials, metal, "EMIT")
    for undo in emitting:
        _restore_surface(undo)
    arm = _pack_arm(rough, metal, size)
    for baked in (colour, normal, arm):
        baked.pack()
    atlas = bpy.data.materials.new(name)
    atlas.use_nodes = True
    nodes, links = atlas.node_tree.nodes, atlas.node_tree.links
    shader = nodes.get("Principled BSDF")
    diff_node = nodes.new("ShaderNodeTexImage")
    diff_node.image = colour
    links.new(diff_node.outputs["Color"], shader.inputs["Base Color"])
    nor_node = nodes.new("ShaderNodeTexImage")
    nor_node.image = normal
    normal_map = nodes.new("ShaderNodeNormalMap")
    links.new(nor_node.outputs["Color"], normal_map.inputs["Color"])
    links.new(normal_map.outputs["Normal"], shader.inputs["Normal"])
    arm_node = nodes.new("ShaderNodeTexImage")
    arm_node.image = arm
    split = nodes.new("ShaderNodeSeparateColor")
    links.new(arm_node.outputs["Color"], split.inputs["Color"])
    links.new(split.outputs["Green"], shader.inputs["Roughness"])
    links.new(split.outputs["Blue"], shader.inputs["Metallic"])
    for obj in meshes:
        for layer in [layer for layer in obj.data.uv_layers if layer.name != ATLAS_UV]:
            obj.data.uv_layers.remove(layer)
        obj.data.uv_layers[ATLAS_UV].active_render = True
        assign(obj, atlas)
    for image_ in (rough, metal):
        bpy.data.images.remove(image_)
    return atlas


def untextured(objects):
    """The names of the objects' materials whose colour is flat (no image feeds Base Color)."""
    names = []
    for obj in _meshes(objects):
        for slot in obj.material_slots:
            if slot.material is not None and not is_textured(slot.material) and slot.material.name not in names:
                names.append(slot.material.name)
    return names
