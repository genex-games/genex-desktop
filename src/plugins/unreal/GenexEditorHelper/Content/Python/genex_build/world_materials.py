"""gx.world_material: world-aligned materials that need no textures or UVs. Each kind has one master
material /Game/GX/Materials/M_GX_<Kind> (made once, and again when the helper ships a new version of
it), built from 3D noise over the world position, so a wall a hundred metres long never shows a seam
or a tile; gx.world_material answers an instance /Game/GX/Materials/MI_<name> of it with its
parameters set. Asking for an instance of the same name again updates it in place.

Kinds and their parameters (colours are (r, g, b) from 0 to 1, linear):
    concrete   dark, light, scale (noise features per cm, about 0.002), roughness, grime (0 to 1)
    steel      steel, rust (colours), rusted (0 to 1: how much of it is rust), scale, roughness
    grime      dark, dust (the colour that settles on top faces), scale, roughness
    emissive   color, intensity (about 5 to 50; pair it with a real light for its glow on the world)
"""

import math

import unreal

from genex_loop import paths
from genex_loop.errors import Refused

MATERIAL_FOLDER = '/Game/GX/Materials'
# Bumped when a master's graph changes, so a project's old master is rebuilt.
MASTER_VERSION = '3'
VERSION_TAG = 'GenexMasterVersion'
# Each kind's parameters: name -> (the material's parameter, default: a number or an (r, g, b) colour).
PARAMETERS = {
    'concrete': {'dark': ('Dark', (0.1, 0.104, 0.108)), 'light': ('Light', (0.2, 0.203, 0.207)),
                 'scale': ('Scale', 0.002), 'roughness': ('Roughness', 0.9), 'grime': ('Grime', 0.5)},
    'steel': {'steel': ('Steel', (0.16, 0.165, 0.17)), 'rust': ('Rust', (0.16, 0.06, 0.025)),
              'rusted': ('Rusted', 0.4), 'scale': ('Scale', 0.004), 'roughness': ('Roughness', 0.45)},
    'grime': {'dark': ('Dark', (0.025, 0.026, 0.028)), 'dust': ('Dust', (0.16, 0.15, 0.13)),
              'scale': ('Scale', 0.003), 'roughness': ('Roughness', 0.95)},
    'emissive': {'color': ('Color', (1.0, 0.55, 0.2)), 'intensity': ('Intensity', 20.0)},
}
KINDS = tuple(PARAMETERS)
MAX_SCALAR = 10_000.0
COLOR_RANGE = (0.0, 100.0)
# Noise: octaves of the coarse and the fine layer.
COARSE_LEVELS = 4
FINE_LEVELS = 3
FINE_FACTOR = 12.0
# Concrete's rain streaks: noise stretched along world Z, so stains run down a wall, never across it.
STREAK_STRETCH = (6.0, 6.0, 0.35)
STREAK_LEVELS = 3
# How much of a streak's darkness grime 1 lets through, and the fine speckle's darkest share.
STREAK_DEPTH = 0.6
SPECKLE_FLOOR = 0.9
# The Noise node's input for the position it samples, as Unreal names it.
NOISE_POSITION = 'World Position'
# Where the nodes sit in the graph, left to right, so a person opening it can read it.
COLUMN = (-1400, -1100, -800, -500, -250)

MESSAGE = {
    'kind': f'kind must be one of {", ".join(KINDS)}.',
    'param': 'world_material({kind}) takes {names}; it has no {name}.',
    'scalar': '{name} must be a number from 0 to {high:g}.',
    'color': '{name} must be (r, g, b), each from 0 to 100 (linear; above 1 only for emissive).',
    'other': '{path} is not a material; choose another name.',
    'made': 'Unreal did not make {path}.',
}


def check(kind: object, name: object, params: dict) -> tuple:
    """(kind, name, {parameter: value}) checked, or Refused; nothing in the editor changes."""
    if kind not in PARAMETERS:
        raise Refused(MESSAGE['kind'], kind=kind)
    chosen = name if name is not None else kind.capitalize()
    if not paths.is_name(chosen):
        raise Refused(paths.MESSAGE['name'], name=name)
    table = PARAMETERS[kind]
    values = {}
    for key, value in params.items():
        if key not in table:
            raise Refused(MESSAGE['param'].format(kind=kind, names=', '.join(table), name=key))
        material_name, default = table[key]
        values[material_name] = _color(key, value) if isinstance(default, tuple) else _scalar(key, value)
    return kind, chosen, values


def _scalar(name: str, value: object) -> float:
    ok = isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)
    if not ok or not 0 <= value <= MAX_SCALAR:
        raise Refused(MESSAGE['scalar'].format(name=name, high=MAX_SCALAR), **{name: repr(value)[:40]})
    return float(value)


def _color(name: str, value: object) -> tuple:
    ok = isinstance(value, (tuple, list)) and len(value) == 3
    if not ok or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
                         and COLOR_RANGE[0] <= v <= COLOR_RANGE[1] for v in value):
        raise Refused(MESSAGE['color'].format(name=name), **{name: repr(value)[:60]})
    return tuple(float(v) for v in value)


class _Graph:
    """A material's nodes being wired, each placed in a column of the graph."""

    def __init__(self, material: unreal.Material) -> None:
        self.material = material
        self.rows = [0] * len(COLUMN)

    def node(self, cls, column: int, **props):
        y = self.rows[column]
        self.rows[column] += 160
        made = unreal.MaterialEditingLibrary.create_material_expression(self.material, cls, COLUMN[column], y)
        for key, value in props.items():
            made.set_editor_property(key, value)
        return made

    def param(self, name: str, default):
        if isinstance(default, tuple):
            return self.node(unreal.MaterialExpressionVectorParameter, 0, parameter_name=name,
                             default_value=unreal.LinearColor(r=default[0], g=default[1], b=default[2], a=1.0))
        return self.node(unreal.MaterialExpressionScalarParameter, 0, parameter_name=name, default_value=float(default))

    def op(self, cls, column: int, first, second=None, a_pin: str = 'A', b_pin: str = 'B', **props):
        made = self.node(cls, column, **props)
        unreal.MaterialEditingLibrary.connect_material_expressions(first, '', made, a_pin)
        if second is not None:
            unreal.MaterialEditingLibrary.connect_material_expressions(second, '', made, b_pin)
        return made

    def out(self, node, prop) -> None:
        unreal.MaterialEditingLibrary.connect_material_property(node, '', prop)


def _noise(graph: _Graph, scale, levels: int, factor: float = 1.0):
    """3D noise (0 to 1) over the world position times `scale` (a parameter node) times `factor`."""
    position = graph.node(unreal.MaterialExpressionWorldPosition, 0)
    scaled = graph.op(unreal.MaterialExpressionMultiply, 1, position, scale)
    if factor != 1.0:
        scaled = graph.op(unreal.MaterialExpressionMultiply, 1, scaled, graph.node(unreal.MaterialExpressionConstant, 0, r=factor))
    return graph.op(unreal.MaterialExpressionNoise, 2, scaled, a_pin=NOISE_POSITION, scale=1.0, levels=levels,
                    output_min=0.0, output_max=1.0)


def _lerp(graph: _Graph, a, b, alpha, column: int = 3):
    made = graph.op(unreal.MaterialExpressionLinearInterpolate, column, a, b)
    unreal.MaterialEditingLibrary.connect_material_expressions(alpha, '', made, 'Alpha')
    return made


def _streaks(graph: _Graph, scale):
    """Noise stretched along world Z (STREAK_STRETCH): water stains that run down a wall."""
    position = graph.node(unreal.MaterialExpressionWorldPosition, 0)
    stretch = graph.node(unreal.MaterialExpressionConstant3Vector, 0,
                         constant=unreal.LinearColor(r=STREAK_STRETCH[0], g=STREAK_STRETCH[1], b=STREAK_STRETCH[2], a=1.0))
    scaled = graph.op(unreal.MaterialExpressionMultiply, 1, graph.op(unreal.MaterialExpressionMultiply, 1, position, scale),
                      stretch)
    return graph.op(unreal.MaterialExpressionNoise, 2, scaled, a_pin=NOISE_POSITION, scale=1.0, levels=STREAK_LEVELS,
                    output_min=0.0, output_max=1.0)


def _concrete(graph: _Graph, p: dict) -> None:
    """Pale-to-mid concrete: a quiet coarse mottle, rain streaks down the walls (Grime), a fine speckle."""
    coarse, fine = _noise(graph, p['Scale'], COARSE_LEVELS), _noise(graph, p['Scale'], FINE_LEVELS, FINE_FACTOR)
    mottled = _lerp(graph, p['Dark'], p['Light'], coarse)
    depth = graph.op(unreal.MaterialExpressionMultiply, 3, p['Grime'], graph.node(unreal.MaterialExpressionConstant, 2,
                                                                                   r=STREAK_DEPTH))
    stains = graph.op(unreal.MaterialExpressionMultiply, 3, _streaks(graph, p['Scale']), depth)
    darken = graph.op(unreal.MaterialExpressionOneMinus, 3, stains, a_pin='')
    speckle = _lerp(graph, graph.node(unreal.MaterialExpressionConstant, 2, r=SPECKLE_FLOOR),
                    graph.node(unreal.MaterialExpressionConstant, 2, r=1.0), fine)
    weathered = graph.op(unreal.MaterialExpressionMultiply, 4, mottled, darken)
    graph.out(graph.op(unreal.MaterialExpressionMultiply, 4, weathered, speckle), unreal.MaterialProperty.MP_BASE_COLOR)
    graph.out(p['Roughness'], unreal.MaterialProperty.MP_ROUGHNESS)


def _steel(graph: _Graph, p: dict) -> None:
    coarse = _noise(graph, p['Scale'], COARSE_LEVELS)
    mask = graph.op(unreal.MaterialExpressionMultiply, 3, coarse, p['Rusted'])
    mask = graph.op(unreal.MaterialExpressionSaturate, 3, graph.op(unreal.MaterialExpressionMultiply, 3, mask,
                                                                   graph.node(unreal.MaterialExpressionConstant, 2, r=2.0)),
                    a_pin='')
    graph.out(_lerp(graph, p['Steel'], p['Rust'], mask, 4), unreal.MaterialProperty.MP_BASE_COLOR)
    metal = _lerp(graph, graph.node(unreal.MaterialExpressionConstant, 2, r=0.9),
                  graph.node(unreal.MaterialExpressionConstant, 2, r=0.15), mask, 4)
    graph.out(metal, unreal.MaterialProperty.MP_METALLIC)
    rough = _lerp(graph, p['Roughness'], graph.node(unreal.MaterialExpressionConstant, 2, r=0.9), mask, 4)
    graph.out(rough, unreal.MaterialProperty.MP_ROUGHNESS)


def _grime(graph: _Graph, p: dict) -> None:
    coarse = _noise(graph, p['Scale'], COARSE_LEVELS)
    up = graph.op(unreal.MaterialExpressionComponentMask, 1, graph.node(unreal.MaterialExpressionVertexNormalWS, 0),
                  a_pin='', r=False, g=False, b=True, a=False)
    top = graph.op(unreal.MaterialExpressionSaturate, 2, up, a_pin='')
    dust = graph.op(unreal.MaterialExpressionMultiply, 3, top, coarse)
    graph.out(_lerp(graph, p['Dark'], p['Dust'], dust, 4), unreal.MaterialProperty.MP_BASE_COLOR)
    graph.out(p['Roughness'], unreal.MaterialProperty.MP_ROUGHNESS)


def _emissive(graph: _Graph, p: dict) -> None:
    graph.out(graph.node(unreal.MaterialExpressionConstant3Vector, 2,
                         constant=unreal.LinearColor(r=0.02, g=0.02, b=0.02, a=1.0)), unreal.MaterialProperty.MP_BASE_COLOR)
    glow = graph.op(unreal.MaterialExpressionMultiply, 3, p['Color'], p['Intensity'])
    graph.out(glow, unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    graph.out(graph.node(unreal.MaterialExpressionConstant, 2, r=0.5), unreal.MaterialProperty.MP_ROUGHNESS)


WIRING = {'concrete': _concrete, 'steel': _steel, 'grime': _grime, 'emissive': _emissive}


def _asset(path: str, cls, factory):
    """The asset at `path`: loaded when it exists (Refused when it is another kind), else made."""
    library = unreal.EditorAssetLibrary
    if library.does_asset_exist(path):
        existing = unreal.load_asset(path)
        if not isinstance(existing, cls):
            raise Refused(MESSAGE['other'].format(path=path), material=path)
        return existing
    folder, name = path.rsplit('/', 1)
    made = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, cls, factory)
    if not isinstance(made, cls):
        raise Refused(MESSAGE['made'].format(path=path), material=path)
    return made


def master(kind: str) -> unreal.Material:
    """The kind's master material, built when missing or made by an older helper."""
    path = f'{MATERIAL_FOLDER}/M_GX_{kind.capitalize()}'
    material = _asset(path, unreal.Material, unreal.MaterialFactoryNew())
    if unreal.EditorAssetLibrary.get_metadata_tag(material, VERSION_TAG) == MASTER_VERSION:
        return material
    unreal.MaterialEditingLibrary.delete_all_material_expressions(material)
    graph = _Graph(material)
    nodes = {name: graph.param(name, default) for name, default in PARAMETERS[kind].values()}
    WIRING[kind](graph, nodes)
    unreal.MaterialEditingLibrary.recompile_material(material)
    unreal.EditorAssetLibrary.set_metadata_tag(material, VERSION_TAG, MASTER_VERSION)
    unreal.EditorAssetLibrary.save_loaded_asset(material, False)
    return material


def world_material(kind, name=None, **params):
    """The instance MI_<name> of the kind's master with `params` set (see the module notes)."""
    kind, chosen, values = check(kind, name, params)
    parent = master(kind)
    instance = _asset(f'{MATERIAL_FOLDER}/MI_{chosen}', unreal.MaterialInstanceConstant,
                      unreal.MaterialInstanceConstantFactoryNew())
    library = unreal.MaterialEditingLibrary
    library.set_material_instance_parent(instance, parent)
    for parameter, value in values.items():
        if isinstance(value, tuple):
            color = unreal.LinearColor(r=value[0], g=value[1], b=value[2], a=1.0)
            library.set_material_instance_vector_parameter_value(instance, parameter, color)
        else:
            library.set_material_instance_scalar_parameter_value(instance, parameter, value)
    library.update_material_instance(instance)
    unreal.EditorAssetLibrary.save_loaded_asset(instance, False)
    return instance
