"""Fit a model Genex generated (`generated.json`'s `hero` rows) to the interior kit: its real size,
standing on y = 0, placed by the kit's rule (a piece that stands against a wall has its back at
z = 0 and faces +z; a free-standing one is centred), its textures resampled to `TEXTURE` texels
and stored as JPEG, so it weighs a megabyte or two instead of ten.

  blender --background --factory-startup --python hero.py -- <in.glb> <out.glb> <height m> <front> <wall|free>

`<front>` is the axis the generated model faces in Blender's frame after import (`+x`, `-x`, `+y`,
`-y`): the turn that brings it to the kit's +z.
"""

import math
import sys

import bpy
import mathutils

TEXTURE = 1024
JPEG_QUALITY = 85
# The turn about Blender's z that brings each facing to the game's +z (Blender's -y).
TURNS = {"-y": 0.0, "+x": -math.pi / 2, "+y": math.pi, "-x": math.pi / 2}


def bounds(objects):
    lo = mathutils.Vector((math.inf,) * 3)
    hi = -lo
    for obj in objects:
        for corner in obj.bound_box:
            world = obj.matrix_world @ mathutils.Vector(corner)
            lo = mathutils.Vector(map(min, lo, world))
            hi = mathutils.Vector(map(max, hi, world))
    return lo, hi


def main():
    source, out, height, front, stand = sys.argv[sys.argv.index("--") + 1 :]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    model = bpy.context.view_layer.objects.active
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    model.rotation_mode = "XYZ"
    model.rotation_euler.z += TURNS[front]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    lo, hi = bounds([model])
    model.scale = (float(height) / (hi.z - lo.z),) * 3
    bpy.ops.object.transform_apply(scale=True)
    lo, hi = bounds([model])
    back = hi.y if stand == "wall" else (lo.y + hi.y) / 2
    model.location = (-(lo.x + hi.x) / 2, -back, -lo.z)
    bpy.ops.object.transform_apply(location=True)
    for obj in [o for o in bpy.context.scene.objects if o != model]:
        bpy.data.objects.remove(obj)
    for image in bpy.data.images:
        if max(image.size) > TEXTURE:
            image.scale(TEXTURE, TEXTURE)
    lo, hi = bounds([model])
    print("HERO", out, tuple(round(v, 3) for v in lo), tuple(round(v, 3) for v in hi), len(model.data.polygons))
    bpy.ops.export_scene.gltf(
        filepath=out,
        export_format="GLB",
        use_selection=False,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_jpeg_quality=JPEG_QUALITY,
    )


main()
