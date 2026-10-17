"""motion_character: a rigged character moved by the Game Animation Sample's Motion Matching, the way
the sample moves its own retargeted characters. The sample's character runs Motion Matching on its
UEFN mannequin; a second skeletal mesh on it, the character's, copies that pose live (Retarget Pose
From Mesh in the sample's ABP_GenericRetarget), which picks its IK Retargeter by the mesh's first
component tag in the ABP's IKRetargeter_Map. So the sample's clips, pose databases and choosers stay
as they are, and no clip is copied per character.

It makes, from a skeletal mesh already imported (import_character):
- the IK Retargeter from the UEFN mannequin to the character, as `retarget` sets one up (full-body
  IK, the whole spine, limbs copied bone for bone, the arms turned to the mannequin's);
- the map entry (tag: the retargeter's name) on ABP_GenericRetarget, kept on the asset's defaults;
- BP_<name>, a child Blueprint of the sample's SandboxCharacter_CMC whose inherited mannequin mesh is
  hidden but still poses every frame, with a Body mesh under it carrying the character, the ABP and
  the tag. Calling it again for the same name updates the same Blueprint.

A project without the sample's content is refused (the Unreal button's Motion Matching step adds it),
as is a call during play. Check the result with character_check, the sample's mannequin as its driver.
"""

import re
import time

import unreal

from genex_build import imports, retarget
from genex_loop import blueprints, editor
from genex_loop.errors import Refused, short_message

# The sample's assets this needs, where its content puts them in a game.
SAMPLE_MESH = '/Game/Characters/UEFN_Mannequin/Meshes/SKM_UEFN_Mannequin'
SAMPLE_ABP = '/Game/Blueprints/RetargetedCharacters/ABP_GenericRetarget'
SAMPLE_CHARACTER = '/Game/Blueprints/SandboxCharacter_CMC'
# ABP_GenericRetarget's map from a mesh's first component tag to its retargeter.
MAP_VARIABLE = 'IKRetargeter_Map'
CHARACTER_FOLDER = '/Game/GX/Characters'
# The sample character's own mesh (the hidden mannequin) and the character's mesh under it.
DRIVER_MESH = 'Mesh'
BODY = 'Body'
NAME = re.compile(r'[A-Za-z][A-Za-z0-9_]{0,47}')

MESSAGE = {
    'no_sample': ('This project has no Game Animation Sample content ({missing}). Add it first with the Unreal '
                  'plugin\'s add-motion-matching (it needs the sample from Fab or the Epic Games Launcher).'),
    'name': 'name must be a letter, then up to 47 letters, digits or _ (Guard, Prisoner_1).',
    'no_driver': 'The sample\'s character has no {mesh} component to hide; its content may be from another version.',
    'compile': '{blueprint} did not compile: {why}',
    'map': 'Unreal did not keep the map entry {tag} on {abp}.',
}


def _sample() -> tuple:
    """(the UEFN mannequin mesh, ABP_GenericRetarget, SandboxCharacter_CMC), or Refused naming what is missing."""
    found = {path: unreal.load_asset(path) for path in (SAMPLE_MESH, SAMPLE_ABP, SAMPLE_CHARACTER)}
    missing = [path for path, asset in found.items() if asset is None]
    if missing:
        raise Refused(MESSAGE['no_sample'].format(missing=', '.join(missing)))
    return found[SAMPLE_MESH], found[SAMPLE_ABP], found[SAMPLE_CHARACTER]


def _map_entry(abp, tag: str, retargeter) -> None:
    """Puts tag -> retargeter in the ABP's IKRetargeter_Map defaults (replacing one of that tag), then
    compiles and saves it; Refused when the entry did not stay."""
    defaults = unreal.get_default_object(abp.generated_class())
    entries = dict(defaults.get_editor_property(MAP_VARIABLE))
    entries[tag] = retargeter
    defaults.set_editor_property(MAP_VARIABLE, entries)
    unreal.BlueprintEditorLibrary.compile_blueprint(abp)
    kept = dict(unreal.get_default_object(abp.generated_class()).get_editor_property(MAP_VARIABLE))
    if tag not in [str(key) for key in kept]:
        raise Refused(MESSAGE['map'].format(tag=tag, abp=SAMPLE_ABP))
    unreal.EditorAssetLibrary.save_loaded_asset(abp, False)


def _character_blueprint(name: str, parent) -> unreal.Blueprint:
    """BP_<name> under CHARACTER_FOLDER, made as a child of the sample's character or reused."""
    path = f'{CHARACTER_FOLDER}/BP_{name}'
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.load_asset(path)
    return unreal.BlueprintEditorLibrary.create_blueprint_asset_with_parent(path, parent.generated_class())


def _hide_driver(blueprint) -> None:
    """The inherited mannequin mesh, as this Blueprint overrides it: hidden, still posing every frame."""
    subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    for handle in subsystem.k2_gather_subobject_data_for_blueprint(blueprint):
        data = library.get_data(handle)
        if str(library.get_variable_name(data)) != DRIVER_MESH:
            continue
        driver = library.get_object_for_blueprint(data, blueprint)
        driver.set_editor_property('visible', False)
        driver.set_editor_property('visibility_based_anim_tick_option',
                                   unreal.VisibilityBasedAnimTickOption.ALWAYS_TICK_POSE_AND_REFRESH_BONES)
        return
    raise Refused(MESSAGE['no_driver'].format(mesh=DRIVER_MESH))


def _body(blueprint, mesh: unreal.SkeletalMesh, abp, tag: str) -> None:
    """The Body mesh under the mannequin: the character, playing the ABP that copies the mannequin's pose."""
    body = blueprints.add_component(blueprint, 'SkeletalMeshComponent', BODY, DRIVER_MESH)
    body.set_editor_property('skeletal_mesh_asset', mesh)
    body.set_editor_property('animation_mode', unreal.AnimationMode.ANIMATION_BLUEPRINT)
    body.set_editor_property('anim_class', abp.generated_class())
    body.set_editor_property('component_tags', [tag])


def motion_character(mesh: str, name: str) -> dict:
    """Gives `mesh` the sample's Motion Matching (see the module notes); {blueprint, retargeter, tag, fbik,
    spineFrom, oneToOne, ikOff, armFixDeg, fingersAligned, skinnedMaterials?, next, ms}."""
    imports.refuse_during_play()
    if not isinstance(name, str) or re.fullmatch(NAME, name) is None:
        raise Refused(MESSAGE['name'], name=name)
    target = retarget.skeletal_mesh(mesh, 'mesh')
    source, abp, parent = _sample()
    started = time.perf_counter()
    rig, facts = retarget.retargeter(source, target)
    tag = rig.get_name()
    _map_entry(abp, tag, rig)
    blueprint = _character_blueprint(name, parent)
    try:
        _hide_driver(blueprint)
        _body(blueprint, target, abp, tag)
    except ValueError as error:
        raise Refused(short_message(error)) from None
    compiled, messages = blueprints.compile_status(blueprint)
    if not compiled:
        raise Refused(MESSAGE['compile'].format(blueprint=blueprint.get_name(), why='; '.join(messages)[:600]))
    unreal.EditorAssetLibrary.save_loaded_asset(blueprint, False)
    # A character imported before import_character marked its materials would play grey.
    skinned = imports.skinned_materials(target)
    path = blueprint.get_path_name().split('.')[0]
    return {'blueprint': path, 'retargeter': rig.get_path_name().split('.')[0], 'tag': tag, **facts,
            **({'skinnedMaterials': skinned} if skinned else {}),
            'next': (f'Use {path} as the game mode\'s default pawn (or place it), then run character_check on '
                     f'{mesh} with the mannequin as its driver.'),
            'ms': editor.elapsed_ms(started)}
