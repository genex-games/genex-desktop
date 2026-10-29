"""Rebuild the interior kit the Rust template ships (`docs/examples/interior-kit/assets/kit/`): every
piece of `interior_kit.py` exported as `blender__model` exports it (one GLB each, +Y up, the same
glTF flags), then its trim sheet, props atlas and decals made by `kit_sheets.py` from CC0 scans and
the images `generated.json` lists.

  blender --background --factory-startup --python build_kit.py -- <scans> <generated> [<out folder>]

`<scans>` is laid out as a game's `assets/` after the `cc0__fetch` calls `kit_sheets.py` names;
`<generated>` holds each of `generated.json`'s images as `<name>.png` (download its `url`);
`<out folder>` defaults to the template's `assets/kit/`. Blender 4.2 or later. The hero models
(`assets/kit/hero/`) are not rebuilt here: `generated.json` says how each was made.
"""

import math
import os
import sys

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE_KIT = os.path.join(HERE, "../../../../../src/game-template-rust/docs/examples/interior-kit")
SCRIPT = os.path.join(TEMPLATE_KIT, "interior_kit.py")


def export(name, out):
    """One piece through the kit script, exported with `blender__model`'s glTF flags."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    source = open(SCRIPT, encoding="utf-8").read()
    exec(compile(source, SCRIPT, "exec"), {"__name__": "__main__", "bpy": bpy, "math": math, "ASSET_NAME": name, "ASSET_INPUTS": {}})
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    bpy.ops.object.select_all(action="DESELECT")
    for o in meshes:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(out, f"{name}.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        # The pieces' `_WEAR` edge-wear attribute (custom attributes start with an underscore).
        export_attributes=True,
    )


def main():
    args = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    scans, generated = (args[0], args[1]) if len(args) > 1 else (None, None)
    out = os.path.abspath(args[2] if len(args) > 2 else os.path.join(TEMPLATE_KIT, "assets/kit"))
    os.makedirs(out, exist_ok=True)
    names = {"__name__": "kit", "bpy": bpy, "math": math}
    exec(compile(open(SCRIPT, encoding="utf-8").read(), SCRIPT, "exec"), names)
    for name in names["PIECES"]:
        export(name, out)
    print("KIT", len(names["PIECES"]), "pieces into", out)
    if scans:
        sys.path.insert(0, HERE)
        # No __pycache__ beside the script in the repository.
        sys.dont_write_bytecode = True
        import kit_sheets

        kit_sheets.make(scans, out, names["STRIPS"], names["REGIONS"], generated)


main()
