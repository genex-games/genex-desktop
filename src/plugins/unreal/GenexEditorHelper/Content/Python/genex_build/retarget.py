"""retarget: animations made for one skeletal mesh played by another, set up so that on 5.8 an
auto-rigged character takes Unreal's mannequins' clips with its arms pointing as theirs do:

- an IK Rig per mesh (made or refreshed) by Unreal's auto-characterisation (it knows the UE4 and UE5
  mannequins, Mixamo, CC4, Rigify and some twenty other skeletons), then its auto full-body IK; the
  Spine chain is made to start at the lowest spine bone (the template an auto-rig matches maps it to
  the top bone only, which leaves the lower spine bones unretargeted);
- an IK Retargeter between them with the default op stack and nothing else (pelvis motion, FK chains,
  Run IK Rig, root motion, curves: in 5.8 Run IK Rig does what the deprecated IK chains op did, and a
  Copy Base Pose op adds nothing on such a rig), every op on the target's rig; chains mapped by
  exact name first, then by fuzzy name for the rest; FK chains copy the arms and legs bone for bone
  (One to One, instead of spreading the elbow's bend into the upper arm), and IK is off on the arms
  (the feet keep theirs);
- the retarget pose reset, then auto-aligned chain to chain (mesh to mesh leaves the arms further off), then the
  arm fix: each target upper arm and forearm turned to the direction of the source's in the source's
  retarget pose (a mesh bound with bent elbows otherwise keeps them 25 degrees or more off), then
  the finger chains aligned again, since turning a forearm turns the hand under it;

then copies the clips onto the target in `dest` with run_batch_retarget. Answers the new clips, the
rigs' facts, each arm bone's degrees off before and after the fix and, as Unreal made the first new
clip, how far each limb points from its source clip's at the clip's start and middle (each played on
its own mesh, in its own body frame); a skeleton Unreal can't characterise is an error naming which
mesh. Never give a source's own retargeter the target in its place."""

import time

import unreal

from genex_build import character, character_math, imports, pose_math
from genex_loop import editor, paths
from genex_loop.errors import Refused

RIG_FOLDER = '/Game/GX/Retarget'
MAX_ANIMATIONS = 64
# 5.8's op that solves the IK goals of the retargeted chains, added if a stack lacks it.
RUN_IK_RIG_OP = '/Script/IKRig.IKRetargetRunIKRigOp'
SPINE_CHAIN = 'Spine'
ARM_CHAINS = ('LeftArm', 'RightArm')
LIMB_CHAINS = ('LeftArm', 'RightArm', 'LeftLeg', 'RightLeg')
FINGER_CHAINS = ('Thumb', 'Index', 'Middle', 'Ring', 'Pinky')
ARM_LIMBS = (('upperArm', 'forearm'), ('forearm', 'hand'))
# The arm fix aims at component-space directions: the frame whose axes are the component's own.
COMPONENT_FRAME = ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))
# Where in the first new clip its limbs are held against the source clip's, as shares of its length.
CHECK_FRACTIONS = (0.0, 0.5)

MESSAGE = {
    'mesh': '{field} must be an existing SkeletalMesh asset.',
    'animations': f'animations must be 1 to {MAX_ANIMATIONS} AnimSequence (or AnimMontage) asset paths.',
    'chains': ('Unreal found no retarget chains on {mesh}: its skeleton isn\'t one auto-characterisation knows. '
               'Play its own clips, or retarget in the editor.'),
    'made': 'Unreal did not make {path}.',
    'nothing': 'The retarget made no clips; see the editor log.',
    'off': ('{limbs} of {clip} point more than {limit:g}° from its source clip\'s: check the retargeter\'s retarget pose '
            'before using these clips.'),
}


def skeletal_mesh(path: object, field: str) -> unreal.SkeletalMesh:
    """The SkeletalMesh at a /Game/ or /Engine/ path, or Refused naming the field."""
    loaded = unreal.load_asset(path) if isinstance(path, str) and path.startswith(('/Game/', '/Engine/')) else None
    if not isinstance(loaded, unreal.SkeletalMesh):
        raise Refused(MESSAGE['mesh'].format(field=field), **{field: path})
    return loaded


def _clips(animations: object) -> list:
    if not isinstance(animations, (list, tuple)) or not 0 < len(animations) <= MAX_ANIMATIONS:
        raise Refused(MESSAGE['animations'])
    found = []
    for path in animations:
        loaded = unreal.load_asset(path) if isinstance(path, str) and path.startswith(('/Game/', '/Engine/')) else None
        if not isinstance(loaded, unreal.AnimSequenceBase):
            raise Refused(MESSAGE['animations'], animation=path)
        found.append(unreal.EditorAssetLibrary.find_asset_data(path))
    return found


def _asset(name: str, cls, factory):
    path = f'{RIG_FOLDER}/{name}'
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        existing = unreal.load_asset(path)
        if isinstance(existing, cls):
            return existing
    made = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, RIG_FOLDER, cls, factory)
    if not isinstance(made, cls):
        raise Refused(MESSAGE['made'].format(path=path))
    return made


def _chain_bones(controller) -> dict:
    """{chain: (start bone, end bone)} of an IK Rig's retarget chains."""
    found = {}
    for chain in controller.get_retarget_chains():
        name = chain.get_editor_property('chain_name')
        found[str(name)] = (str(controller.get_retarget_chain_start_bone(name)),
                            str(controller.get_retarget_chain_end_bone(name)))
    return found


def _spine_from_bottom(controller, mesh) -> str | None:
    """Starts the Spine chain at the lowest spine bone when it starts higher; the bone it now starts at, or None."""
    spine = _chain_bones(controller).get(SPINE_CHAIN)
    if spine is None:
        return None
    lowest = character_math.lowest_below(spine[1], str(controller.get_retarget_root()), character.parent_of(mesh))
    if lowest is None or lowest == spine[0]:
        return None
    return lowest if controller.set_retarget_chain_start_bone(SPINE_CHAIN, lowest) else None


def ik_rig(mesh: unreal.SkeletalMesh) -> tuple:
    """(the IK Rig IK_<mesh name>, made or refreshed as the module notes say; {fbik, spineFrom?})."""
    rig = _asset(f'IK_{mesh.get_name()}', unreal.IKRigDefinition, unreal.IKRigDefinitionFactory())
    controller = unreal.IKRigController.get_controller(rig)
    controller.set_skeletal_mesh(mesh)
    controller.apply_auto_generated_retarget_definition()
    if not controller.get_retarget_chains():
        raise Refused(MESSAGE['chains'].format(mesh=mesh.get_path_name().split('.')[0]))
    fbik = controller.get_num_solvers() > 0 or bool(controller.apply_auto_fbik())
    spine = _spine_from_bottom(controller, mesh)
    unreal.EditorAssetLibrary.save_loaded_asset(rig, False)
    return rig, {'fbik': fbik, **({'spineFrom': spine} if spine else {})}


def _ensure_ik_op(controller) -> None:
    """Adds the Run IK Rig op when the stack has none (add_default_ops adds it to an empty stack)."""
    for index in range(controller.get_num_retarget_ops()):
        if isinstance(controller.get_op_controller(index), unreal.IKRetargetRunIKRigController):
            return
    controller.add_retarget_op(RUN_IK_RIG_OP)


def _set_chains(op, field: str, chosen: tuple, setting: str, value) -> list:
    """Sets `setting` to `value` on the op's chain settings (in `field`) of the target chains `chosen`; their names."""
    settings = op.get_settings()
    chains = list(settings.get_editor_property(field))
    changed = []
    for chain in chains:
        name = str(chain.get_editor_property('target_chain_name'))
        if name in chosen:
            chain.set_editor_property(setting, value)
            changed.append(name)
    settings.set_editor_property(field, chains)
    op.set_settings(settings)
    return sorted(changed)


def tune_ops(controller) -> dict:
    """FK chains One to One on the arms and legs, IK off on the arms; {oneToOne, ikOff}: the chains changed."""
    tuned = {'oneToOne': [], 'ikOff': []}
    for index in range(controller.get_num_retarget_ops()):
        op = controller.get_op_controller(index)
        if isinstance(op, unreal.IKRetargetFKChainsController):
            tuned['oneToOne'] += _set_chains(op, 'chains_to_retarget', LIMB_CHAINS, 'rotation_mode',
                                             unreal.FKChainRotationMode.ONE_TO_ONE)
        elif isinstance(op, unreal.IKRetargetRunIKRigController):
            tuned['ikOff'] += _set_chains(op, 'chains', ARM_CHAINS, 'enable_ik', False)
    return tuned


def finger_bones(rig, mesh) -> list:
    """Every bone of the rig's finger chains (LeftThumb, RightMiddle, ...)."""
    parent = character.parent_of(mesh)
    bones = []
    for chain, (start, end) in _chain_bones(unreal.IKRigController.get_controller(rig)).items():
        if chain.endswith(FINGER_CHAINS):
            bones += character_math.bone_path(start, end, parent) or []
    return bones


def _skeleton_pose(rig_controller, mesh, found: dict) -> tuple:
    """(the reference pose of the bones from the root to the neck and to each hand, their parents)."""
    parent_of = character.parent_of(mesh)
    ends = [found['neck']] + [found[side]['hand'] for side in character_math.SIDES]
    bones = sorted({bone for end in ends for bone in _ancestors(end, parent_of)})
    parents = {bone: parent_of(bone) for bone in bones}
    return character.reference_pose(rig_controller, bones), parents


def _ancestors(bone: str, parent_of) -> list:
    found, seen = [], set()
    while bone is not None and bone not in seen:
        seen.add(bone)
        found.append(bone)
        bone = parent_of(bone)
    return found


def _deltas(controller, bones: list, side) -> dict:
    """The current retarget pose's local rotation deltas of `bones` (identity ones left out)."""
    found = {}
    for bone in bones:
        q = controller.get_rotation_offset_for_retarget_pose_bone(bone, side)
        delta = (q.x, q.y, q.z, q.w)
        if pose_math.quat_angle_deg(delta) > 0.0:
            found[bone] = delta
    return found


def arm_fix(controller, source: unreal.SkeletalMesh, target: unreal.SkeletalMesh) -> dict:
    """Turns the target's upper arms and forearms in the retarget pose to the directions of the source's (see the
    module notes); {bone: [degrees off before, after]}."""
    source_rig, source_found = character.rig(source)
    target_rig, target_found = character.rig(target)
    sides = unreal.RetargetSourceOrTarget
    source_reference, source_parents = _skeleton_pose(source_rig, source, source_found)
    source_pose = pose_math.with_deltas(source_reference, source_parents,
                                        _deltas(controller, list(source_reference), sides.SOURCE))
    target_reference, target_parents = _skeleton_pose(target_rig, target, target_found)
    current = _deltas(controller, list(target_reference), sides.TARGET)
    wanted = [(target_found[side][bone], target_found[side][child],
               pose_math.limb_direction(source_pose, source_found[side][bone], source_found[side][child]))
              for side in character_math.SIDES for bone, child in ARM_LIMBS]
    deltas, report = pose_math.match_limbs(target_reference, target_parents, current, COMPONENT_FRAME, wanted)
    for bone, delta in deltas.items():
        if delta != current.get(bone):
            controller.set_rotation_offset_for_retarget_pose_bone(bone, unreal.Quat(*delta), sides.TARGET)
    return report


def retargeter(source: unreal.SkeletalMesh, target: unreal.SkeletalMesh) -> tuple:
    """(the IK Retargeter RTG_<source>_to_<target> between their rigs, set up as the module notes say; its facts)."""
    asset = _asset(f'RTG_{source.get_name()}_to_{target.get_name()}', unreal.IKRetargeter, unreal.IKRetargetFactory())
    controller = unreal.IKRetargeterController.get_controller(asset)
    (source_rig, source_facts), (target_rig, target_facts) = ik_rig(source), ik_rig(target)
    sides, align = unreal.RetargetSourceOrTarget, unreal.RetargetAutoAlignMethod.CHAIN_TO_CHAIN
    controller.set_ik_rig(sides.SOURCE, source_rig)
    controller.set_ik_rig(sides.TARGET, target_rig)
    controller.set_preview_mesh(sides.SOURCE, source)
    controller.set_preview_mesh(sides.TARGET, target)
    controller.remove_all_ops()
    controller.add_default_ops()
    _ensure_ik_op(controller)
    controller.assign_ik_rig_to_all_ops(sides.TARGET, target_rig)
    controller.auto_map_chains(unreal.AutoMapChainType.EXACT, True)
    controller.auto_map_chains(unreal.AutoMapChainType.FUZZY, False)
    tuned = tune_ops(controller)
    controller.reset_retarget_pose(controller.get_current_retarget_pose_name(sides.TARGET), [], sides.TARGET)
    controller.auto_align_all_bones(sides.TARGET, align)
    arms = arm_fix(controller, source, target)
    fingers = finger_bones(target_rig, target)
    if fingers:
        controller.auto_align_bones(fingers, align, sides.TARGET)
    unreal.EditorAssetLibrary.save_loaded_asset(asset, False)
    fbik = {'source': source_facts['fbik'], 'target': target_facts['fbik']}
    spine = {side: facts['spineFrom'] for side, facts in (('source', source_facts), ('target', target_facts))
             if 'spineFrom' in facts}
    return asset, {'fbik': fbik, 'spineFrom': spine, **tuned, 'armFixDeg': arms, 'fingersAligned': len(fingers)}


def limb_check(made: list, animations: list, suffix: str, source, target) -> dict:
    """{limb: worst degrees} the first new clip's limbs point from its source clip's at CHECK_FRACTIONS, each clip
    played on its own mesh (see the module notes); {} when the pair can't be found."""
    first = str(made[0].package_name)
    leaf = first.rsplit('/', 1)[-1]
    origin = next((path for path in animations if f"{path.rsplit('/', 1)[-1]}{suffix}" == leaf), None)
    new_clip, old_clip = unreal.load_asset(first), unreal.load_asset(origin) if origin else None
    if not isinstance(new_clip, unreal.AnimSequenceBase) or not isinstance(old_clip, unreal.AnimSequenceBase):
        return {}
    (_, source_found), (_, target_found) = character.rig(source), character.rig(target)
    source_bones, target_bones = character_math.role_bones(source_found), character_math.role_bones(target_found)
    worst: dict = {}
    for fraction in CHECK_FRACTIONS:
        seconds = round(new_clip.get_play_length() * fraction, 3)
        ours = character.clip_pose(target, new_clip, seconds, target_bones)
        theirs = character.clip_pose(source, old_clip, seconds, source_bones)
        for limb, error in character_math.chain_errors(ours, target_found, theirs, source_found).items():
            worst[limb] = max(worst.get(limb, 0.0), error)
    return worst


def retarget(source_mesh: str, target_mesh: str, animations: list, dest: str) -> dict:
    """Copies `animations` (made for source_mesh) onto target_mesh, into `dest`; {animations, retargeter, fbik,
    spineFrom, oneToOne, ikOff, armFixDeg, fingersAligned, limbErrorDeg, warnings, ms}."""
    imports.refuse_during_play()
    source, target = skeletal_mesh(source_mesh, 'source_mesh'), skeletal_mesh(target_mesh, 'target_mesh')
    clips = _clips(animations)
    paths.check_content_path(dest)
    started = time.perf_counter()
    asset, facts = retargeter(source, target)
    suffix = f'_{target.get_name()}'
    inputs = unreal.IKRetargetBatchOperationInputs()
    for key, value in {'assets_to_retarget': clips, 'source_mesh': source, 'target_mesh': target,
                       'ik_retarget_asset': asset, 'target_path': dest, 'suffix': suffix,
                       'include_referenced_assets': False, 'overwrite_existing_files': True}.items():
        inputs.set_editor_property(key, value)
    made = unreal.IKRetargetBatchOperation.run_batch_retarget(inputs)
    if not made:
        raise Refused(MESSAGE['nothing'])
    errors = limb_check(list(made), list(animations), suffix, source, target)
    off = sorted(limb for limb, error in errors.items() if error > character_math.MAX_CHAIN_ERROR_DEG)
    warnings = [MESSAGE['off'].format(limbs=', '.join(off), clip=str(made[0].package_name),
                                      limit=character_math.MAX_CHAIN_ERROR_DEG)] if off else []
    return {'animations': sorted(str(data.package_name) for data in made),
            'retargeter': asset.get_path_name().split('.')[0], **facts, 'limbErrorDeg': errors, 'warnings': warnings,
            'ms': editor.elapsed_ms(started)}
