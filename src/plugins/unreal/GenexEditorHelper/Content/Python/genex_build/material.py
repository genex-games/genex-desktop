"""dirt_material: a packed-dirt material made of nodes, as it works on Unreal 5.8.3:
MaterialFactoryNew makes the asset, and MaterialEditingLibrary
wires WorldPosition into a coarse Noise (scale 0.004, 4 levels, 0 to 1) times a fine one (scale
0.08, 3 levels, 0 to 1), which blends a dark and a light colour into the base colour, with a
constant roughness; then recompile_material (about 8 s). Its default palette is grey-brown packed
dirt. A material of that name made before is emptied and wired again in place.
"""

import time

import unreal

from genex_build import args
from genex_loop import editor
from genex_loop.errors import Refused

MATERIAL_FOLDER = '/Game/Genex/Materials'
DEFAULT_PALETTE = ((0.13, 0.11, 0.09), (0.30, 0.27, 0.23))
ROUGHNESS = 0.92
# (scale, levels) of the coarse and the fine noise; both answer 0 to 1.
COARSE_NOISE = (0.004, 4)
FINE_NOISE = (0.08, 3)
NOISE_RANGE = (0.0, 1.0)
# Where the nodes sit in the material graph, so a person opening it reads it left to right.
NODE_X = (-1000, -700, -400, -200)


def _noise(material: unreal.Material, shape: tuple, y: int) -> unreal.MaterialExpression:
    node = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionNoise,
                                                                    NODE_X[1], y)
    scale, levels = shape
    node.set_editor_property('scale', scale)
    node.set_editor_property('levels', levels)
    node.set_editor_property('output_min', NOISE_RANGE[0])
    node.set_editor_property('output_max', NOISE_RANGE[1])
    return node


def _colour(material: unreal.Material, rgb: tuple, y: int) -> unreal.MaterialExpression:
    node = unreal.MaterialEditingLibrary.create_material_expression(material, unreal.MaterialExpressionConstant3Vector,
                                                                    NODE_X[2], y)
    node.set_editor_property('constant', unreal.LinearColor(r=rgb[0], g=rgb[1], b=rgb[2], a=1.0))
    return node


def _wire(material: unreal.Material, dark: tuple, light: tuple) -> None:
    """The dirt's nodes and links."""
    library = unreal.MaterialEditingLibrary
    position = library.create_material_expression(material, unreal.MaterialExpressionWorldPosition, NODE_X[0], 0)
    coarse, fine = _noise(material, COARSE_NOISE, -150), _noise(material, FINE_NOISE, 150)
    mix = library.create_material_expression(material, unreal.MaterialExpressionMultiply, NODE_X[2], 300)
    blend = library.create_material_expression(material, unreal.MaterialExpressionLinearInterpolate, NODE_X[3], 0)
    rough = library.create_material_expression(material, unreal.MaterialExpressionConstant, NODE_X[3], 300)
    rough.set_editor_property('r', ROUGHNESS)
    for noise in (coarse, fine):
        library.connect_material_expressions(position, '', noise, 'Position')
    library.connect_material_expressions(coarse, '', mix, 'A')
    library.connect_material_expressions(fine, '', mix, 'B')
    library.connect_material_expressions(_colour(material, dark, -300), '', blend, 'A')
    library.connect_material_expressions(_colour(material, light, -150), '', blend, 'B')
    library.connect_material_expressions(mix, '', blend, 'Alpha')
    library.connect_material_property(blend, '', unreal.MaterialProperty.MP_BASE_COLOR)
    library.connect_material_property(rough, '', unreal.MaterialProperty.MP_ROUGHNESS)


def _material(name: str) -> unreal.Material:
    """The material M_<name>: emptied when it exists, else made; Refused when another kind of asset has its path."""
    path = f'{MATERIAL_FOLDER}/M_{name}'
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        existing = unreal.load_asset(path)
        if not isinstance(existing, unreal.Material):
            raise Refused(f'{path} is not a material; choose another name.', material=path)
        unreal.MaterialEditingLibrary.delete_all_material_expressions(existing)
        return existing
    tools = unreal.AssetToolsHelpers.get_asset_tools()
    made = tools.create_asset(f'M_{name}', MATERIAL_FOLDER, unreal.Material, unreal.MaterialFactoryNew())
    if not isinstance(made, unreal.Material):
        raise Refused(f'Unreal did not make the material {path}.', material=path)
    return made


def dirt_material(name: str, palette: str) -> dict:
    """The dirt material M_<name> (see the module notes)."""
    checked = args.name(name)
    dark, light = args.palette(palette, DEFAULT_PALETTE)
    started = time.perf_counter()
    material = _material(checked)
    _wire(material, dark, light)
    unreal.MaterialEditingLibrary.recompile_material(material)
    return {'material': f'{MATERIAL_FOLDER}/M_{checked}', 'ms': editor.elapsed_ms(started)}
