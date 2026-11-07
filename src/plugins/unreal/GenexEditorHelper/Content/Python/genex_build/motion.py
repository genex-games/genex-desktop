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

The mannequin is hidden in the editor and hidden in game: the sample's character makes its own mesh
visible again as play starts, so a mannequin hidden only in the editor showed through the Body in
play as white patches. An older helper hid it only in the editor; hide_old_drivers, which the helper
runs once the editor has its level, hides those in game too.

A project without the sample's content is refused (the Unreal button's Motion Matching step adds it),
as is a call during play. Check the result with character_check, the sample's mannequin as its driver.
"""

import json
import os
import re
import time

import unreal

from genex_build import imports, retarget, shots
from genex_loop import blueprints, editor, paths
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
# How the mannequin is hidden: not drawn in the editor, and hidden in game, where the sample's character
# makes its own mesh visible again.
DRIVER_HIDDEN = {'visible': False, 'hidden_in_game': True}
# The characters' Blueprint files, as motion_character names them, and the record in Saved/Genex of the
# ones hide_old_drivers has checked.
CHARACTER_FILE = re.compile(r'BP_[A-Za-z][A-Za-z0-9_]{0,47}')
BLUEPRINT_SUFFIX = '.uasset'
CHECKED_RECORD = 'motion-characters-checked.json'
# What checking one older character found: changed and saved, nothing to change, or no answer yet.
FIXED, FINE, RETRY = 'fixed', 'fine', 'retry'
# How long, once the helper loads, it waits for the editor's level before checking the characters anyway.
LEVEL_WAIT_S = 120.0

MESSAGE = {
    'no_sample': ('This project has no Game Animation Sample content ({missing}). Add it first with the Unreal '
                  'plugin\'s add-motion-matching (it needs the sample from Fab or the Epic Games Launcher).'),
    'name': 'name must be a letter, then up to 47 letters, digits or _ (Guard, Prisoner_1).',
    'no_driver': 'The sample\'s character has no {mesh} component to hide; its content may be from another version.',
    'compile': '{blueprint} did not compile: {why}',
    'map': 'Unreal did not keep the map entry {tag} on {abp}.',
    'meshes': ('Mesh is the hidden mannequin that moves: Motion Matching, its AnimBP and every montage you play '
               'run on it. Body is the character players see, copying Mesh\'s pose each frame: put props on Body '
               '(attach_to_socket picks it) and measure feet and hands on Body. When every move of the game is a '
               'root-motion montage (a sword fight), give Mesh a plain AnimBP instead, an idle pose into Slot '
               '\'DefaultSlot\' into Output Pose, with SetAnimInstanceClass: the sample\'s AnimBP blends its own '
               'locomotion over the montages and the feet slide.'),
    'old_hidden': 'Genex editor helper: hid the Motion Matching mannequin in game too for {blueprints}.',
    'old_failed': 'Genex editor helper: could not check the motion characters an older helper made: {why}',
    'old_retry': (f'Genex editor helper: could not check {{blueprints}} in {CHARACTER_FOLDER} yet (not loaded, the '
                  'sample\'s character missing, or not compiled or saved); it tries again at the next start.'),
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


def _component(blueprint, name: str):
    """The Blueprint's component `name` (inherited ones too) as the Blueprint overrides it, or None."""
    subsystem = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    library = unreal.SubobjectDataBlueprintFunctionLibrary
    for handle in subsystem.k2_gather_subobject_data_for_blueprint(blueprint):
        data = library.get_data(handle)
        if str(library.get_variable_name(data)) == name:
            return library.get_object_for_blueprint(data, blueprint)
    return None


def _hide(driver) -> None:
    """The mannequin hidden in the editor and in game, still posing every frame for the Body to copy."""
    for name, value in DRIVER_HIDDEN.items():
        driver.set_editor_property(name, value)
    driver.set_editor_property('visibility_based_anim_tick_option',
                               unreal.VisibilityBasedAnimTickOption.ALWAYS_TICK_POSE_AND_REFRESH_BONES)


def _hide_driver(blueprint) -> None:
    """The inherited mannequin mesh, as this Blueprint overrides it: hidden, still posing every frame."""
    driver = _component(blueprint, DRIVER_MESH)
    if driver is None:
        raise Refused(MESSAGE['no_driver'].format(mesh=DRIVER_MESH))
    _hide(driver)


def _body(blueprint, mesh: unreal.SkeletalMesh, abp, tag: str) -> None:
    """The Body mesh under the mannequin: the character, playing the ABP that copies the mannequin's pose."""
    body = blueprints.add_component(blueprint, 'SkeletalMeshComponent', BODY, DRIVER_MESH)
    body.set_editor_property('skeletal_mesh_asset', mesh)
    body.set_editor_property('animation_mode', unreal.AnimationMode.ANIMATION_BLUEPRINT)
    body.set_editor_property('anim_class', abp.generated_class())
    body.set_editor_property('component_tags', [tag])


def motion_character(mesh: str, name: str) -> dict:
    """Gives `mesh` the sample's Motion Matching (see the module notes); {blueprint, retargeter, tag, fbik,
    spineFrom, oneToOne, ikOff, armFixDeg, fingersAligned, skinnedMaterials?, meshes, next, ms}."""
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
            'meshes': MESSAGE['meshes'],
            'next': (f'Use {path} as the game mode\'s default pawn (or place it), then run character_check on '
                     f'{mesh} with the mannequin as its driver.'),
            'ms': editor.elapsed_ms(started)}


def _hidden_only_in_editor(driver) -> bool:
    """Whether a mannequin is as an older helper left it: not drawn in the editor, not hidden in game. One
    someone made visible again is not."""
    return not driver.get_editor_property('visible') and not driver.get_editor_property('hidden_in_game')


def _hide_placed(blueprint) -> None:
    """The level's placed copies of the Blueprint hide their mannequin in game too: a copy keeps the
    value it had, and saving the level would write it in for good. Only copies still as an older helper
    left them change; the level is not saved here."""
    path = blueprint.generated_class().get_path_name()
    for actor in editor.actors().get_all_level_actors():
        if not isinstance(actor, unreal.Character) or actor.get_class().get_path_name() != path:
            continue
        driver = actor.get_editor_property('mesh')
        if driver and _hidden_only_in_editor(driver):
            driver.set_editor_property('hidden_in_game', True)


def _check_character(path: str) -> str:
    """Checks one BP_<name> (see hide_old_drivers): FIXED, FINE (nothing to change) or RETRY (it did not
    load, it has no mannequin while the sample's character is missing, or it did not compile or save)."""
    blueprint = unreal.load_asset(path)
    if blueprint is None:
        return RETRY
    if not isinstance(blueprint, unreal.Blueprint):
        return FINE
    driver = _component(blueprint, DRIVER_MESH)
    if driver is None:
        return RETRY if unreal.load_asset(SAMPLE_CHARACTER) is None else FINE
    if _component(blueprint, BODY) is None or not _hidden_only_in_editor(driver):
        return FINE
    _hide(driver)
    compiled, _messages = blueprints.compile_status(blueprint)
    if not compiled or not unreal.EditorAssetLibrary.save_loaded_asset(blueprint, False):
        return RETRY
    _hide_placed(blueprint)
    return FIXED


def _character_files(project: str) -> list[str]:
    """The names of the BP_<name> files in CHARACTER_FOLDER, read from the disk (the asset registry may
    still be scanning as the editor starts), or [] when the folder doesn't exist."""
    folder = os.path.join(project, 'Content', *CHARACTER_FOLDER.removeprefix('/Game/').split('/'))
    try:
        files = sorted(os.listdir(folder))
    except OSError:
        return []
    stems = [file.removesuffix(BLUEPRINT_SUFFIX) for file in files if file.endswith(BLUEPRINT_SUFFIX)]
    return [stem for stem in stems if re.fullmatch(CHARACTER_FILE, stem)]


def _read_checked(record: str) -> set[str]:
    """The names the record holds; none when it is missing or not a list of names."""
    if not paths.is_regular_file(record):
        return set()
    try:
        with open(record, encoding='utf-8') as file:
            names = json.load(file).get('checked')
    except (OSError, ValueError, AttributeError):
        return set()
    return {name for name in names if isinstance(name, str)} if isinstance(names, list) else set()


def _record_path(project: str) -> str:
    """The record's real path in the project's Saved/Genex, or Refused when it leads out of it."""
    return paths.inside_genex_folder(os.path.join(project, *paths.GENEX_FOLDER, CHECKED_RECORD), project)


def _write_checked(project: str, names: set[str]) -> None:
    """Writes the record through a new file put in its place, its path checked again first, so a link
    put there meanwhile is replaced, never followed; the new file never stays behind."""
    record = _record_path(project)
    fresh = f'{record}.{os.getpid()}.tmp'
    try:
        with open(fresh, 'x', encoding='utf-8') as file:
            json.dump({'checked': sorted(names)}, file, indent=1)
        os.replace(fresh, record)
    finally:
        if os.path.lexists(fresh):
            os.remove(fresh)


def hide_old_drivers() -> list[str]:
    """Hides in game the mannequin of each motion character an older helper made (see the module
    notes), compiling and saving each, and in the level's placed copies of it; the Blueprints it
    changed. Each BP_<name> in CHARACTER_FOLDER is checked once: the names checked are kept in
    Saved/Genex, so a later start loads only new ones, and one with no answer yet is tried again at the
    next. Nothing changes during play, or when the record's place leads out of Saved/Genex (Refused)."""
    if editor.play_world() is not None:
        return []
    project = editor.project_dir()
    names = _character_files(project)
    if not names:
        return []
    checked = _read_checked(_record_path(project))
    unchecked = [name for name in names if name not in checked]
    if not unchecked:
        return []
    results = {name: _check_character(f'{CHARACTER_FOLDER}/{name}') for name in unchecked}
    _write_checked(project, checked | {name for name, result in results.items() if result != RETRY})
    retried = [name for name, result in results.items() if result == RETRY]
    if retried:
        unreal.log_warning(MESSAGE['old_retry'].format(blueprints=', '.join(retried)))
    return [f'{CHARACTER_FOLDER}/{name}' for name, result in results.items() if result == FIXED]


def _level_ready() -> bool:
    return editor.editor_subsystem().get_editor_world() is not None and editor.play_world() is None


def _hide_old_drivers_logged() -> None:
    try:
        fixed = hide_old_drivers()
    except Exception as error:  # noqa: BLE001 - checking old characters must never break the editor's start
        unreal.log_warning(MESSAGE['old_failed'].format(why=short_message(error)))
        return
    if fixed:
        unreal.log(MESSAGE['old_hidden'].format(blueprints=', '.join(fixed)))


def hide_old_drivers_soon() -> None:
    """Runs hide_old_drivers once, on an editor frame once the editor has its level and no play runs (the
    helper's init_unreal calls this as it loads), logging what it changed or why it could not. Once: a
    save's progress dialog can tick the editor again while it runs."""
    ran = []

    def run() -> None:
        if not ran:
            ran.append(True)
            _hide_old_drivers_logged()

    shots.after(_level_ready, run, LEVEL_WAIT_S)
