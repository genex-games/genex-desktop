"""Importing models, animations, sounds and textures by script, and describing what landed.

Meshes, sounds and textures import synchronously through an AssetImportTask (Interchange nests
a model's pieces as <dest>/<file>/StaticMeshes/...). Animations go through the Interchange
pipeline override onto an existing Skeleton and land asynchronously in <dest>/<name>/, so the
host polls list_assets until they appear.
"""

import time

import unreal

from genex_loop import editor, paths
from genex_loop.errors import Refused, short_message

MODELS = ('.glb', '.gltf', '.fbx', '.obj')
EXTENSIONS = {
    'static_mesh': MODELS,
    'skeletal_mesh': MODELS,
    'animation': ('.glb', '.gltf', '.fbx'),
    'sound': ('.wav',),
    'texture': ('.png', '.jpg', '.jpeg', '.tga'),
}
# The asset each kind is imported for, listed before the textures and materials that came with it.
MAIN_CLASS = {'static_mesh': 'StaticMesh', 'skeletal_mesh': 'SkeletalMesh', 'sound': 'SoundWave', 'texture': 'Texture2D'}
DESCRIBED_CAP = 12
LISTED_CAP = 200


def _task_import(file: str, dest: str, name: str, replace: bool) -> list[str]:
    task = unreal.AssetImportTask()
    task.filename = file
    task.destination_path = dest
    task.destination_name = name
    task.automated = True
    task.replace_existing = replace
    task.save = True
    unreal.AssetToolsHelpers.get_asset_tools().import_asset_tasks([task])
    return [str(path).split('.')[0] for path in task.imported_object_paths]


def _skeleton(path: str) -> unreal.Skeleton:
    skeleton = unreal.load_asset(paths.check_object_path(path, 'skeleton'))
    if not isinstance(skeleton, unreal.Skeleton):
        raise Refused('The skeleton must be an existing Skeleton asset.', skeleton=path)
    return skeleton


def _animation_import(file: str, dest: str, name: str, skeleton: unreal.Skeleton, replace: bool) -> bool:
    pipeline = unreal.InterchangeGenericAssetsPipeline()
    common = pipeline.get_editor_property('common_skeletal_meshes_and_animations_properties')
    common.set_editor_property('skeleton', skeleton)
    common.set_editor_property('import_only_animations', True)
    params = unreal.ImportAssetParameters()
    params.is_automated = True
    params.replace_existing = replace
    params.set_editor_property('override_pipelines', [unreal.SoftObjectPath(pipeline.get_path_name())])
    source = unreal.InterchangeManager.create_source_data(file)
    manager = unreal.InterchangeManager.get_interchange_manager_scripted()
    return bool(manager.import_asset(f'{dest}/{name}', source, params))


def _mesh_facts(asset: unreal.StaticMesh) -> dict:
    bounds = asset.get_bounding_box()
    materials = [slot.get_editor_property('material_interface') for slot in asset.get_editor_property('static_materials')]
    return {'triangles': asset.get_num_triangles(0),
            'boundsCm': [round(bounds.max.x - bounds.min.x), round(bounds.max.y - bounds.min.y), round(bounds.max.z - bounds.min.z)],
            'materials': [m.get_path_name() for m in materials if m]}


def describe(path: str) -> dict:
    """A short description of an asset: class, triangles and bounds, texture size, duration or length."""
    asset = unreal.load_asset(path)
    info = {'path': path, 'class': asset.get_class().get_name() if asset else None}
    if isinstance(asset, unreal.StaticMesh):
        info.update(_mesh_facts(asset))
    elif isinstance(asset, unreal.SkeletalMesh):
        bounds = asset.get_bounds().box_extent
        info['boundsCm'] = [round(bounds.x * 2), round(bounds.y * 2), round(bounds.z * 2)]
        info['skeleton'] = asset.get_editor_property('skeleton').get_path_name()
    elif isinstance(asset, unreal.Texture2D):
        info['size'] = [asset.blueprint_get_size_x(), asset.blueprint_get_size_y()]
    elif isinstance(asset, unreal.SoundWave):
        info['seconds'] = round(asset.get_editor_property('duration'), 2)
    elif isinstance(asset, unreal.AnimSequence):
        info['skeleton'] = asset.get_editor_property('skeleton').get_path_name()
        info['seconds'] = round(asset.get_play_length(), 2)
    return info


def import_asset(file: str, dest: str, name: str, kind: str, skeleton: str, replace: bool) -> dict:
    """Imports one file; the assets it made, described, or {pending} for an animation."""
    if kind not in EXTENSIONS:
        raise Refused(f'kind must be one of {", ".join(EXTENSIONS)}.', kind=kind)
    paths.check_content_path(dest)
    if not paths.is_name(name):
        raise Refused(paths.MESSAGE['name'], name=name)
    source = paths.import_source(file, EXTENSIONS[kind])
    target = _skeleton(skeleton) if kind == 'animation' else None
    started = time.perf_counter()
    try:
        if target is not None:
            queued = _animation_import(source, dest, name, target, replace)
            return {'pending': queued, 'dest': f'{dest}/{name}', 'ms': editor.elapsed_ms(started)}
        imported = _task_import(source, dest, name, replace)
    except Exception as error:  # noqa: BLE001 - Interchange and the asset tools raise RuntimeError and others
        raise Refused(f'The import failed: {short_message(error)}', file=file) from None
    if not imported:
        raise Refused('Unreal imported nothing from this file; see the editor log.', file=file)
    # The main assets first, by the registry's class (nothing loads), so the cap never hides them.
    main = MAIN_CLASS[kind]
    ordered = sorted(imported, key=lambda path: _class_name(path) != main)
    described = sorted((describe(path) for path in ordered[:DESCRIBED_CAP]), key=lambda a: a['class'] != main)
    return {'ms': editor.elapsed_ms(started), 'count': len(imported), 'assets': described}


def _class_name(path: str) -> str:
    """An asset's class name as the asset registry lists it."""
    return str(unreal.EditorAssetLibrary.find_asset_data(path).asset_class_path.asset_name)


def list_assets(path: str) -> dict:
    """The assets under a /Game/ folder with their class (anything an animation import made too)."""
    paths.check_content_path(path)
    found = editor.folder_assets(path)
    rows = []
    for asset_path in found[:LISTED_CAP]:
        data = unreal.EditorAssetLibrary.find_asset_data(asset_path)
        rows.append({'path': asset_path.split('.')[0], 'class': str(data.asset_class_path.asset_name)})
    return {'path': path, 'assets': rows, 'more': max(0, len(found) - LISTED_CAP)}
