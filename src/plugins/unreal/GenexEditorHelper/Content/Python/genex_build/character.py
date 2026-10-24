"""character_check: whether a rigged character looks right when it stands and walks, in numbers and
pictures, before it goes into the game.

It finds the character's bones with a throwaway IK Rig (Unreal's auto-characterisation; nothing is
saved), samples its idle clip at IDLE_FRACTIONS and its walk at WALK_FRACTIONS of their length with
Unreal's AnimPose evaluation (no play session), and answers character_math's numbers and verdict:
arms out from the body, hands from the thighs, width against height, feet against the ground, the
most any mesh edge stretches against the bind pose (the mesh's own vertices skinned to each sampled
pose), finger bones and their motion, and, given a driver (the hidden mannequin a runtime retarget
copies), each limb's direction against the driver's at the same frame.

With pictures, a temporary copy of the character stands at the level's PlayerStart (the world
origin without one) and is shot from the front, the side and the back at its idle's first frame,
then from the side at the walk's frames; the shots land one after another and the copy and its
camera are removed afterwards. The answer names the sheet's record file; the bridge waits for it and
shows the shots as one contact sheet.
"""

import json
import math
import os
import time

import unreal

from genex_build import args, character_math, imports, outs, pose_math, shots
from genex_loop import editor
from genex_loop.errors import Refused

IDLE_FRACTIONS = (0.0, 0.34, 0.67)
WALK_FRACTIONS = (0.0, 0.25, 0.5, 0.75)
# Meshes with more vertices than this are not skinned for the stretch check (pure Python, a few seconds each).
MAX_STRETCH_VERTICES = 60_000
SHEET_PREFIX = 'character-'
SHEET_SIZE = (640, 720)
CAMERA_FOV_DEG = 40.0
# The camera stands at this share of the character's height, and frames this much more than its height.
CAMERA_HEIGHT_SHARE = 0.55
FRAMING = 1.15
# Seconds a pose is left to settle before its shot, and the longest one shot may take to land.
SHOT_DELAY_S = 0.5
SHOT_WAIT_S = 20.0
CHECK_LABEL = 'GX_CharacterCheck'
PLAYER_START = 'PlayerStart'
NO_BONE = 'None'

MESSAGE = {
    'mesh': ('mesh must be a SkeletalMesh asset (/Game/...) or the label of a level actor with a skeletal mesh.'),
    'clip': '{field} must be an AnimSequence asset (/Game/...) or empty.',
    'skeleton': '{field} plays on another skeleton ({clip}); give a clip of this character\'s own skeleton.',
    'roles': ('Unreal found no arm and leg chains on {mesh}: its skeleton isn\'t one auto-characterisation knows, '
              'so the check can\'t tell its arms from its legs.'),
    'driver': 'driver must be JSON {"mesh": "/Game/...", "idle": "/Game/...", "walk": "/Game/..."} or empty.',
    'pictures': 'pictures must be true or false.',
    'busy': 'A character sheet is still being taken; wait for it to finish.',
}


def _mesh(target: object) -> tuple:
    """(the SkeletalMesh, its level actor or None) for a mesh path or an actor's label; else Refused."""
    if isinstance(target, str) and target.startswith(('/Game/', '/Engine/')):
        loaded = unreal.load_asset(target)
        if isinstance(loaded, unreal.SkeletalMesh):
            return loaded, None
    if isinstance(target, str) and target:
        for actor in editor.actors().get_all_level_actors():
            if actor.get_actor_label() != target:
                continue
            component = actor.get_component_by_class(unreal.SkeletalMeshComponent)
            mesh = component.get_skinned_asset() if component is not None else None
            if isinstance(mesh, unreal.SkeletalMesh):
                return mesh, actor
    raise Refused(MESSAGE['mesh'], mesh=target)


def _path(asset) -> str:
    return asset.get_path_name().split('.')[0]


def _clip(path: object, field: str, mesh) -> unreal.AnimSequenceBase | None:
    """The clip at `path` (None for ''), refused unless it plays on the mesh's skeleton."""
    if path == '':
        return None
    loaded = unreal.load_asset(path) if isinstance(path, str) and path.startswith(('/Game/', '/Engine/')) else None
    if not isinstance(loaded, unreal.AnimSequenceBase):
        raise Refused(MESSAGE['clip'].format(field=field), **{field: path})
    skeleton = loaded.get_skeleton()
    own = mesh.get_editor_property('skeleton')
    if skeleton is None or own is None or _path(skeleton) != _path(own):
        raise Refused(MESSAGE['skeleton'].format(field=field, clip=_path(skeleton) if skeleton else 'none'),
                      **{field: path})
    return loaded


def parent_of(mesh):
    """The mesh's bone-parent lookup: a bone's parent name, None at the root."""
    def parent(bone: str) -> str | None:
        found = mesh.get_bone_parent(bone)
        return None if found is None or str(found) == NO_BONE else str(found)
    return parent


def rig(mesh) -> tuple:
    """(a throwaway IK Rig's controller for the mesh, its bones' roles); Refused when it has no arms and legs."""
    definition = unreal.new_object(unreal.IKRigDefinition)
    controller = unreal.IKRigController.get_controller(definition)
    controller.set_skeletal_mesh(mesh)
    controller.apply_auto_generated_retarget_definition()
    chains = {}
    for chain in controller.get_retarget_chains():
        name = chain.get_editor_property('chain_name')
        chains[str(name)] = (str(controller.get_retarget_chain_start_bone(name)),
                             str(controller.get_retarget_chain_end_bone(name)))
    found = character_math.roles(chains, str(controller.get_retarget_root()), parent_of(mesh),
                                 lambda bone: [str(child) for child in mesh.get_bone_children(bone)])
    if found is None:
        raise Refused(MESSAGE['roles'].format(mesh=_path(mesh)))
    return controller, found


def transform_pose(transform) -> tuple:
    """((x, y, z), (x, y, z, w)) of an unreal.Transform."""
    t, q = transform.translation, transform.rotation
    return (t.x, t.y, t.z), (q.x, q.y, q.z, q.w)


def reference_pose(controller, bones: list) -> dict:
    """The mesh's reference pose, component space, for `bones`."""
    return {bone: transform_pose(controller.get_ref_pose_transform_of_bone(bone)) for bone in bones}


def clip_pose(mesh, clip, seconds: float, bones: list) -> dict:
    """The clip's pose at `seconds` on the mesh's proportions, component space, for `bones`."""
    options = unreal.AnimPoseEvaluationOptions()
    options.set_editor_property('optional_skeletal_mesh', mesh)
    evaluated = unreal.AnimPoseExtensions.get_anim_pose_at_time(clip, seconds, options)
    pose = outs.pick(evaluated, unreal.AnimPose, f'pose of {_path(clip)} at {seconds:.2f} s')
    space = unreal.AnimPoseSpaces.WORLD
    return {bone: transform_pose(unreal.AnimPoseExtensions.get_bone_pose(pose, bone, space)) for bone in bones}


def _times(clip, fractions: tuple) -> list:
    length = clip.get_play_length()
    return [round(length * fraction, 3) for fraction in fractions]


def _samples(mesh, controller, clip, fractions: tuple, bones: list) -> list:
    """[(seconds, pose)] of the clip at its fractions; the reference pose alone when there is no clip."""
    if clip is None:
        return [(0.0, reference_pose(controller, bones))]
    return [(t, clip_pose(mesh, clip, t, bones)) for t in _times(clip, fractions)]


def _height(mesh) -> float:
    return mesh.get_bounds().box_extent.z * 2.0


def _bind_mesh(mesh) -> tuple:
    """(bind positions, triangles, [(bone name, weight)] per vertex, bone names) of LOD 0, by Geometry Script."""
    made = unreal.GeometryScript_AssetUtils.copy_mesh_from_skeletal_mesh(
        mesh, unreal.DynamicMesh(), unreal.GeometryScriptCopyMeshFromAssetOptions(), unreal.GeometryScriptMeshReadLOD())
    dynamic = outs.pick(made, unreal.DynamicMesh, 'copy of the skeletal mesh')
    listed = outs.pick(unreal.GeometryScript_MeshQueries.get_all_vertex_positions(dynamic, False),
                       unreal.GeometryScriptVectorList, 'vertex list')
    vertices = outs.pick(unreal.GeometryScript_List.convert_vector_list_to_array(listed), unreal.Array, 'vertices')
    positions = [(v.x, v.y, v.z) for v in vertices]
    if len(positions) > MAX_STRETCH_VERTICES:
        return positions, [], [], []
    found = outs.pick(unreal.GeometryScript_MeshQueries.get_all_triangle_indices(dynamic, False),
                      unreal.GeometryScriptTriangleList, 'triangle list')
    triangles = [(t.x, t.y, t.z) for t in outs.pick(unreal.GeometryScript_List.convert_triangle_list_to_array(found),
                                                    unreal.Array, 'triangles')]
    infos = outs.pick(unreal.GeometryScript_BoneWeights.get_all_bones_info(dynamic), unreal.Array, 'bones')
    names = {info.index: str(info.name) for info in infos}
    weights = []
    for vertex in range(len(positions)):
        listed = outs.pick(unreal.GeometryScript_BoneWeights.get_vertex_bone_weights(dynamic, vertex), unreal.Array,
                           'bone weights')
        weights.append([(names.get(w.bone_index, ''), w.weight) for w in listed])
    return positions, triangles, weights, sorted(set(names.values()))


def stretch(mesh, controller, poses: list) -> dict:
    """The worst edge stretch over the poses, [(clip, seconds)] ({stretch, bindCm, posedCm, at, clip, seconds}),
    or {unmeasured: why}."""
    if not poses:
        return {'unmeasured': 'no clip to pose the mesh with'}
    positions, triangles, weights, bones = _bind_mesh(mesh)
    if not triangles:
        return {'unmeasured': f'{len(positions)} vertices, more than the {MAX_STRETCH_VERTICES} the check skins'}
    bind = reference_pose(controller, bones)
    worst = {'stretch': 1.0}
    for clip, seconds in poses:
        posed = clip_pose(mesh, clip, seconds, bones)
        found = character_math.edge_stretch(positions, character_math.skin(
            positions, weights, character_math.bone_matrices(bind, posed)), triangles)
        if found['stretch'] > worst['stretch']:
            worst = {**found, 'clip': _path(clip), 'seconds': seconds}
    return worst


def _driver(driver: object, mesh_poses: dict, bones_found: dict) -> tuple:
    """({limb: worst degrees} against the driver's own clip of the same name at the same frames, the driver's mesh
    path), or (None, None) without one."""
    if driver == '':
        return None, None
    spec = args.json_object(driver, 'driver')
    if not isinstance(spec.get('mesh'), str):
        raise Refused(MESSAGE['driver'])
    driver_mesh, _ = _mesh(spec['mesh'])
    _, driver_found = rig(driver_mesh)
    bones = character_math.role_bones(driver_found)
    worst: dict = {}
    for name, samples in mesh_poses.items():
        if not spec.get(name):
            continue
        clip = _clip(spec[name], f'driver {name}', driver_mesh)
        for seconds, pose in samples:
            theirs = clip_pose(driver_mesh, clip, seconds, bones)
            for limb, error in character_math.chain_errors(pose, bones_found, theirs, driver_found).items():
                worst[limb] = max(worst.get(limb, 0.0), error)
    return worst, _path(driver_mesh)


def character_check(mesh: str, idle: str, walk: str, driver: str, pictures: bool) -> dict:
    """Checks a character standing and walking (see the module notes); {passed, reasons, warnings, ...}."""
    imports.refuse_during_play()
    if not isinstance(pictures, bool):
        raise Refused(MESSAGE['pictures'], pictures=pictures)
    started = time.perf_counter()
    skeletal, actor = _mesh(mesh)
    clips = {'idle': _clip(idle, 'idle', skeletal), 'walk': _clip(walk, 'walk', skeletal)}
    controller, found = rig(skeletal)
    bones = character_math.role_bones(found)
    reference = character_math.frame_numbers(reference_pose(controller, bones), found)
    fractions = {'idle': IDLE_FRACTIONS, 'walk': WALK_FRACTIONS}
    poses = {name: _samples(skeletal, controller, clip, fractions[name], bones)
             for name, clip in clips.items() if clip is not None or name == 'idle'}
    summaries = {name: character_math.clip_summary([character_math.frame_numbers(p, found) for _, p in samples],
                                                   reference) for name, samples in poses.items()}
    chains, driver_mesh = _driver(driver, poses, found)
    moving = poses.get('walk') or poses['idle']
    fingers = character_math.finger_motion([pose for _, pose in moving], found)
    stretched = stretch(skeletal, controller, [(clips[name], t) for name, samples in poses.items()
                                               if clips[name] is not None for t, _ in samples])
    measured = stretched if 'stretch' in stretched else None
    height = _height(skeletal)
    verdict = character_math.verdict(summaries, height, measured, chains, fingers)
    notes = [] if clips['idle'] is not None else ['no idle clip: the reference pose was checked as the idle']
    answer = {'mesh': _path(skeletal), 'actor': actor.get_actor_label() if actor else None, **verdict,
              'notes': notes, 'heightCm': round(height), 'clips': summaries, 'stretch': stretched,
              'fingers': fingers, 'thresholds': character_math.thresholds(),
              'bones': {k: found[k] for k in ('pelvis', 'neck', 'Left', 'Right')}}
    if chains is not None:
        answer.update({'driver': driver_mesh, 'limbErrorDeg': chains})
    if pictures:
        answer['pictures'] = sheet(skeletal, clips, found, poses)
    return {**answer, 'ms': editor.elapsed_ms(started)}


# --- the picture sheet ----------------------------------------------------------------------------------

def _facing(reference: dict, found: dict) -> tuple:
    """The character's forward, flat: where its toes point, else square to its side and up."""
    toes = [pose_math.sub(reference[found[s]['toe']][0], reference[found[s]['foot']][0])
            for s in character_math.SIDES if found[s]['toe']]
    if toes:
        flat = pose_math.unit((sum(t[0] for t in toes), sum(t[1] for t in toes), 0.0))
        if pose_math.length(flat) > 0.5:
            return flat
    side, up, _ = character_math.frame_of(reference, found)
    return pose_math.unit((pose_math.cross(up, side)[0], pose_math.cross(up, side)[1], 0.0))


def _stand() -> tuple:
    """Where the copy stands: the first PlayerStart's location, else the origin."""
    for candidate in editor.actors().get_all_level_actors():
        if candidate.get_class().get_name() == PLAYER_START:
            spot = candidate.get_actor_location()
            return spot.x, spot.y, spot.z
    return 0.0, 0.0, 0.0


def _views(forward: tuple) -> dict:
    """The camera directions (from the character towards the camera), by view."""
    across = (-forward[1], forward[0], 0.0)
    return {'front': forward, 'side': across, 'back': pose_math.scaled(forward, -1.0)}


def _camera_place(stand: tuple, toward: tuple, height: float) -> tuple:
    """(location, rotation) of a camera framing the whole character from direction `toward`."""
    aspect = SHEET_SIZE[1] / SHEET_SIZE[0]
    half_vertical = math.atan(math.tan(math.radians(CAMERA_FOV_DEG) / 2.0) * aspect)
    distance = (height * FRAMING / 2.0) / math.tan(half_vertical)
    eye = (stand[0] + toward[0] * distance, stand[1] + toward[1] * distance, stand[2] + height * CAMERA_HEIGHT_SHARE)
    yaw = math.degrees(math.atan2(-toward[1], -toward[0]))
    return eye, unreal.Rotator(roll=0.0, pitch=0.0, yaw=yaw)


class _Sheet:
    """A character sheet being taken: its shots in order, each posed, framed and shot once the last landed."""

    def __init__(self, shots_wanted: list, record: str, copy, camera) -> None:
        self.wanted, self.record = shots_wanted, record
        self.copy, self.camera = copy, camera
        self.taken: list = []
        self.waiting: tuple | None = None
        self.owed = False
        self.done = False

    def finish(self, why: str = '') -> bool:
        if self.done:
            return True
        self.done = True
        for actor in (self.copy, self.camera):
            editor.actors().destroy_actor(actor)
        record = {'frames': [{'label': label} for label, *_ in self.taken],
                  'files': [file for _, file, *_ in self.taken]}
        if why:
            record['error'] = why
        with open(self.record, 'w', encoding='utf-8') as handle:
            json.dump(record, handle)
        shots.give_back_throttle(self.owed)
        return True

    def step(self) -> bool:
        """Advances the sheet by one editor frame; True once it is finished."""
        if self.waiting is not None:
            file, asked = self.waiting
            if not (os.path.exists(file) and os.path.getsize(file) > 0):
                return self.finish(f'{os.path.basename(file)} never landed') if time.monotonic() - asked > SHOT_WAIT_S else False
            self.waiting = None
        if len(self.taken) == len(self.wanted):
            return self.finish()
        label, file, clip, seconds, (location, rotation) = self.wanted[len(self.taken)]
        component = self.copy.skeletal_mesh_component
        if clip is not None:
            component.set_animation(clip)
            component.set_position(seconds, False)
        self.camera.set_actor_location_and_rotation(unreal.Vector(*location), rotation, False, False)
        unreal.AutomationLibrary.take_high_res_screenshot(SHEET_SIZE[0], SHEET_SIZE[1], file, self.camera, False, False,
                                                          unreal.ComparisonTolerance.LOW, '', SHOT_DELAY_S, True)
        self.taken.append(self.wanted[len(self.taken)])
        self.waiting = (file, time.monotonic())
        return False


_sheet: list = []


def _shot_list(stem: str, clips: dict, poses: dict, stand: tuple, forward: tuple, height: float) -> list:
    folder = shots.captures_folder()
    views = _views(forward)
    idle, walk = clips['idle'], clips['walk']
    wanted = [(f'idle {view}', os.path.join(folder, f'{stem}-idle-{view}.png'), idle, 0.0,
               _camera_place(stand, views[view], height)) for view in ('front', 'side', 'back')]
    for index, (seconds, _) in enumerate(poses.get('walk', [])):
        wanted.append((f'walk {seconds:.2f} s', os.path.join(folder, f'{stem}-walk-{index}.png'), walk, seconds,
                       _camera_place(stand, views['side'], height)))
    return wanted


def sheet(mesh, clips: dict, found: dict, poses: dict) -> dict:
    """Starts the character sheet (see the module notes); {record, files, waitS}."""
    if _sheet and not _sheet[0].done:
        raise Refused(MESSAGE['busy'])
    stem = f'{SHEET_PREFIX}{int(time.time() * 1000)}'
    reference = poses['idle'][0][1]
    stand, height = _stand(), _height(mesh)
    wanted = _shot_list(stem, clips, poses, stand, _facing(reference, found), height)
    copy = editor.actors().spawn_actor_from_class(unreal.SkeletalMeshActor, unreal.Vector(*stand), unreal.Rotator())
    copy.set_actor_label(CHECK_LABEL)
    component = copy.skeletal_mesh_component
    component.set_skeletal_mesh_asset(mesh)
    component.set_update_animation_in_editor(True)
    component.set_animation_mode(unreal.AnimationMode.ANIMATION_SINGLE_NODE)
    component.set_play_rate(0.0)
    camera = editor.actors().spawn_actor_from_class(unreal.CameraActor, unreal.Vector(*stand), unreal.Rotator())
    camera.set_actor_label(f'{CHECK_LABEL}_Camera')
    camera.camera_component.set_field_of_view(CAMERA_FOV_DEG)
    camera.camera_component.set_constraint_aspect_ratio(False)
    record = os.path.join(shots.captures_folder(), f'{stem}.json')
    taking = _Sheet(wanted, record, copy, camera)
    taking.owed = shots.lift_throttle()
    _sheet[:] = [taking]
    wait = len(wanted) * (SHOT_DELAY_S + SHOT_WAIT_S)
    shots.after(taking.step, lambda: taking.finish('the sheet ran out of time'), wait)
    return {'record': record, 'files': [file for _, file, *_ in wanted], 'waitS': round(wait),
            'size': list(SHEET_SIZE)}
