"""What a play shot can hide, measured in the running play session for the judge: whether the pawns
stand on the ground and face where they move (probe_characters), and whether the player's own
meshes clear the camera's near clip plane and the post-process stays sane (probe_view).

Read only: property reads and line traces drawn nowhere; nothing in the editor changes. An engine
call this engine version names differently becomes a refusal carrying the engine's message, so a
probe answers {error} instead of failing the queue's call.
"""

import itertools
import math
import os
from typing import NamedTuple

import unreal

from genex_loop import editor, paths
from genex_loop.errors import Refused, short_message

PAWNS_CAP = 30
MESHES_CAP = 40
BONES_CAP = 400
VOLUMES_CAP = 20
# The ground trace starts this far above a pawn's bottom (inside its body), so a bottom sunk a little
# still finds the ground under it, and looks this far down.
TRACE_LIFT_CM = 50.0
TRACE_DROP_CM = 5000.0
# With nothing under it, a trace from this far above tells "under the ground" from "over nothing".
TRACE_ABOVE_CM = 2000.0
# Slower than this, a pawn has no direction of travel.
MIN_DIRECTION_CM_S = 1.0
# Unreal's own near clip plane when the project sets none.
DEFAULT_NEAR_CLIP_CM = 10.0
# Where a project sets its near clip plane (Unreal's Python has no Engine object to read it from), and how much of
# that file is read.
NEAR_CLIP_SECTION = '[/Script/Engine.Engine]'
NEAR_CLIP_KEY = 'NearClipPlane='
INI_CAP = 512 * 1024
# The shots are 16:9, and Unreal's field of view is the horizontal one.
VIEW_ASPECT = 16 / 9
# A mesh further than this from the camera doesn't count as in the player's view.
VIEW_RANGE_CM = 1500.0
# A bone stands for the flesh around it, about this thick.
BONE_RADIUS_CM = 4.0
EPSILON = 1e-6
# Unreal's BreakHitResult outputs: (blocking hit, initial overlap, time, distance, location, impact point, ...).
HIT_BLOCKING = 0
HIT_IMPACT_POINT = 5

MESSAGE = {
    'no_play': 'No play session is running; start one first.',
    'no_camera': 'The play session has no player camera yet.',
    'failed': 'The probe could not read the play session.',
}


class Ground:
    """Where the ground is against a pawn's bottom."""
    BELOW = 'below'
    ABOVE = 'above'
    NONE = 'none'


class PawnKind:
    CHARACTER = 'character'
    VEHICLE = 'vehicle'
    PAWN = 'pawn'


class MeshKind:
    STATIC = 'static'
    SKELETAL = 'skeletal'
    OTHER = 'other'


class NearFrom:
    """Where the near clip plane's distance came from."""
    CAMERA = 'camera'
    PROJECT = 'project'
    DEFAULT = 'default'


class Source:
    """What a post-process setting comes from."""
    VOLUME = 'volume'
    CAMERA = 'camera'


# The audited post-process settings: (key in the answer, PostProcessSettings property).
AUDITED = (
    ('motionBlurAmount', 'motion_blur_amount'),
    ('motionBlurMax', 'motion_blur_max'),
    ('exposureBias', 'auto_exposure_bias'),
    ('exposureMinBrightness', 'auto_exposure_min_brightness'),
    ('exposureMaxBrightness', 'auto_exposure_max_brightness'),
    ('bloomIntensity', 'bloom_intensity'),
    ('vignetteIntensity', 'vignette_intensity'),
    ('chromaticAberration', 'scene_fringe_intensity'),
    ('dofFocalDistance', 'depth_of_field_focal_distance'),
    ('dofFstop', 'depth_of_field_fstop'),
)
# The range a setting stays readable in, (lowest, highest or None); outside it, it is extreme.
FINE = {
    'motionBlurAmount': (0.0, 0.7),
    'motionBlurMax': (0.0, 10.0),
    'exposureBias': (-3.0, 4.0),
    'bloomIntensity': (0.0, 3.0),
    'vignetteIntensity': (0.0, 0.8),
    'chromaticAberration': (0.0, 2.0),
    'dofFocalDistance': (500.0, None),
}
# A focal distance of 0 turns depth of field off.
OFF_AT_ZERO = {'dofFocalDistance'}
# The project's rendering defaults that decide blur and exposure when no volume overrides them.
DEFAULT_FEATURES = (
    ('motionBlur', 'r.DefaultFeature.MotionBlur'),
    ('motionBlurQuality', 'r.MotionBlurQuality'),
    ('autoExposure', 'r.DefaultFeature.AutoExposure'),
    ('bloom', 'r.DefaultFeature.Bloom'),
)


# Vectors as (x, y, z) tuples.
def _xyz(v) -> tuple[float, float, float]:
    return float(v.x), float(v.y), float(v.z)


def _sub(a: tuple, b: tuple) -> tuple:
    return a[0] - b[0], a[1] - b[1], a[2] - b[2]


def _add(a: tuple, b: tuple) -> tuple:
    return a[0] + b[0], a[1] + b[1], a[2] + b[2]


def _mul(a: tuple, k: float) -> tuple:
    return a[0] * k, a[1] * k, a[2] * k


def _dot(a: tuple, b: tuple) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _cross(a: tuple, b: tuple) -> tuple:
    return a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]


def _length(a: tuple) -> float:
    return math.sqrt(_dot(a, a))


def _axes(rotation) -> tuple[tuple, tuple, tuple]:
    """A rotation's forward (X), right (Y) and up (Z) axes, as Unreal's FRotationMatrix makes them."""
    sp, cp = math.sin(math.radians(rotation.pitch)), math.cos(math.radians(rotation.pitch))
    sy, cy = math.sin(math.radians(rotation.yaw)), math.cos(math.radians(rotation.yaw))
    sr, cr = math.sin(math.radians(rotation.roll)), math.cos(math.radians(rotation.roll))
    return ((cp * cy, cp * sy, sp), (sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, -sr * cp),
            (-(cr * sp * cy + sr * sy), cy * sr - cr * sp * sy, cr * cp))


def _prop(thing, name: str, default=None):
    """An editor property, or the default where this engine version has no such property."""
    try:
        return thing.get_editor_property(name)
    except Exception:  # Unreal raises a plain Exception for an unknown property name
        return default


def _round(value: float | None, digits: int | None = None):
    return None if value is None else round(value, digits) if digits else round(value)


def _play_world() -> unreal.World:
    world = editor.play_world()
    if world is None:
        raise Refused(MESSAGE['no_play'])
    return world


def _guarded(step, *args) -> dict:
    """The step's answer; an engine call that fails becomes a refusal with the engine's message."""
    try:
        return step(*args)
    except Refused:
        raise
    except Exception as error:  # an engine call this engine version names differently
        raise Refused(MESSAGE['failed'], detail=short_message(error)) from error


def _shown(component) -> bool:
    return bool(component.is_visible()) and not _prop(component, 'hidden_in_game', False)


def _bottom(component) -> float:
    origin, extent, _radius = unreal.SystemLibrary.get_component_bounds(component)
    return float(origin.z - extent.z)


def _main_mesh(pawn):
    """A character's or vehicle's own `mesh`, else its first skeletal or static mesh, else None."""
    mesh = _prop(pawn, 'mesh')
    if mesh:
        return mesh
    return pawn.get_component_by_class(unreal.SkeletalMeshComponent) or pawn.get_component_by_class(unreal.StaticMeshComponent)


# probe_characters

def _kind(pawn) -> str:
    if isinstance(pawn, unreal.Character):
        return PawnKind.CHARACTER
    vehicle = getattr(unreal, 'WheeledVehiclePawn', None)
    if vehicle is not None and isinstance(pawn, vehicle):
        return PawnKind.VEHICLE
    return PawnKind.PAWN


def _base(pawn, kind: str, mesh) -> tuple[float, float, float]:
    """(x, y, z) of what rests on the ground: a character's capsule bottom, else its mesh's or bounds' bottom."""
    capsule = pawn.get_component_by_class(unreal.CapsuleComponent) if kind == PawnKind.CHARACTER else None
    if capsule is not None:
        x, y, z = _xyz(capsule.get_world_location())
        return x, y, z - float(capsule.get_scaled_capsule_half_height())
    x, y, _z = _xyz(pawn.get_actor_location())
    if mesh is not None:
        return x, y, _bottom(mesh)
    origin, extent = pawn.get_actor_bounds(False)
    return x, y, float(origin.z - extent.z)


def _trace_down(context, x: float, y: float, top: float, low: float, ignore: list) -> float | None:
    """The height of the first thing hit straight down from top to low, or None."""
    hit = unreal.SystemLibrary.line_trace_single(
        context, unreal.Vector(x, y, top), unreal.Vector(x, y, low), unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, True,
        ignore, unreal.DrawDebugTrace.NONE, True)
    if hit is None:
        return None
    broken = hit.to_tuple()  # a HitResult breaks through BreakHitResult: its outputs, in its order
    return float(broken[HIT_IMPACT_POINT].z) if broken[HIT_BLOCKING] else None


def _ground(pawn, x: float, y: float, bottom: float) -> tuple[float | None, str]:
    """The ground's height at (x, y) and where it is against the bottom; the pawn and what rides on it are ignored."""
    ignore = [pawn, *pawn.get_attached_actors()]
    below = _trace_down(pawn, x, y, bottom + TRACE_LIFT_CM, bottom - TRACE_DROP_CM, ignore)
    if below is not None:
        return below, Ground.BELOW
    above = _trace_down(pawn, x, y, bottom + TRACE_ABOVE_CM, bottom + TRACE_LIFT_CM, ignore)
    if above is not None:
        return above, Ground.ABOVE
    return None, Ground.NONE


def _motion(pawn) -> dict:
    """Its speed, and its facing against the direction it moves (0 to 180 degrees) while it moves."""
    vx, vy, vz = _xyz(pawn.get_velocity())
    speed = math.hypot(vx, vy)
    facing = float(pawn.get_actor_rotation().yaw)
    moving = speed >= MIN_DIRECTION_CM_S
    move = math.degrees(math.atan2(vy, vx)) if moving else None
    off = abs((facing - move + 180.0) % 360.0 - 180.0) if moving else None
    return {'speedCmS': round(speed), 'verticalCmS': round(vz), 'facingYaw': round(facing, 1),
            'moveYaw': _round(move, 1), 'facingOffDeg': _round(off, 1)}


def _falling(pawn) -> bool | None:
    movement = pawn.get_component_by_class(unreal.CharacterMovementComponent)
    return None if movement is None else bool(movement.is_falling())


def _wheels(pawn) -> dict | None:
    """{touching, count} from Chaos's wheel states, or None when the vehicle doesn't say."""
    movement_class = getattr(unreal, 'ChaosWheeledVehicleMovementComponent', None)
    movement = pawn.get_component_by_class(movement_class) if movement_class is not None else None
    if movement is None:
        return None
    try:
        count = int(movement.get_num_wheels())
        # A wheel state's fields aren't editor properties: Chaos's BreakWheelStatus hands them over, in contact first.
        touching = sum(1 for i in range(count) if movement.break_wheel_status(movement.get_wheel_state(i))[0])
    except Exception:  # wheel states this engine version doesn't hand to Python
        return None
    return {'touching': touching, 'count': count}


def _parts(pawn) -> list[str]:
    prefix = editor.PART_TAG_PREFIX
    return [str(t)[len(prefix):] for t in pawn.tags if str(t).startswith(prefix)]


def _pawn_row(pawn, is_player: bool) -> dict:
    kind = _kind(pawn)
    mesh = _main_mesh(pawn)
    x, y, bottom = _base(pawn, kind, mesh)
    ground_z, ground = _ground(pawn, x, y, bottom)
    feet = _bottom(mesh) if kind == PawnKind.CHARACTER and mesh is not None else None
    gap = None if ground_z is None else bottom - ground_z
    feet_gap = None if ground_z is None or feet is None else feet - ground_z
    location = pawn.get_actor_location()
    return {
        'label': pawn.get_actor_label(), 'class': pawn.get_class().get_name(), 'kind': kind, 'player': is_player,
        'parts': _parts(pawn), 'location': [round(location.x), round(location.y), round(location.z)],
        **_motion(pawn),
        'ground': ground, 'aboveGround': ground == Ground.BELOW, 'groundZ': _round(ground_z),
        'gapCm': _round(gap), 'feetGapCm': _round(feet_gap),
        'meshHidden': None if mesh is None else not _shown(mesh), 'falling': _falling(pawn),
        'wheels': _wheels(pawn) if kind == PawnKind.VEHICLE else None,
    }


def _characters(world: unreal.World, part: str) -> dict:
    tag = str(editor.part_tag(part)) if part else ''
    player = unreal.GameplayStatics.get_player_pawn(world, 0)
    pawns = [p for p in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Pawn)
             if not tag or tag in [str(t) for t in p.tags]]
    is_player = [player is not None and pawn == player for pawn in pawns]
    rows = sorted(zip(pawns, is_player), key=lambda pair: (not pair[1], pair[0].get_actor_label()))
    return {'pawns': [_pawn_row(pawn, mine) for pawn, mine in rows[:PAWNS_CAP]], 'more': max(0, len(rows) - PAWNS_CAP)}


def probe_characters(part: str) -> dict:
    """The play session's pawns (the part's, or every pawn when part is ''): the ground under each, how
    far its bottom and a character's feet are from it, its facing against its travel, a vehicle's wheels."""
    if part:
        paths.check_part(part)
    return _guarded(_characters, _play_world(), part)


# probe_view

class Lens(NamedTuple):
    """How the camera draws a mesh: from the eye along its axes, the view's half-width and half-height
    per cm of depth, the near clip plane, and the scale toward the eye first-person meshes are drawn at."""
    eye: tuple
    forward: tuple
    right: tuple
    up: tuple
    slope_w: float
    slope_h: float
    near: float
    scale: float


class Box(NamedTuple):
    """An oriented box: centre, three unit axes and the half size along each."""
    center: tuple
    axes: tuple
    half: tuple


def _lens(eye: tuple, rotation, fov: float, near: float, scale: float = 1.0) -> Lens:
    slope_w = math.tan(math.radians(fov) / 2)
    return Lens(eye, *_axes(rotation), slope_w, slope_w / VIEW_ASPECT, near, scale)


def _first_person_lens(lens: Lens, camera, rotation) -> Lens:
    """The lens Unreal draws first-person meshes with: the camera's first-person field of view and scale when set."""
    if camera is None:
        return lens
    fov = _prop(camera, 'first_person_field_of_view') if _prop(camera, 'enable_first_person_field_of_view') else None
    scale = _prop(camera, 'first_person_scale') if _prop(camera, 'enable_first_person_scale') else None
    width = math.degrees(2 * math.atan(lens.slope_w))
    return _lens(lens.eye, rotation, float(fov or width), lens.near, float(scale or 1.0))


def _drawn(lens: Lens, point: tuple) -> tuple:
    """Where the camera draws a point: scaled toward the eye for a first-person mesh."""
    return _add(lens.eye, _mul(_sub(point, lens.eye), lens.scale))


def _camera_space(lens: Lens, point: tuple) -> tuple[float, float, float]:
    """(depth, right, up) of a drawn point from the eye."""
    offset = _sub(point, lens.eye)
    return _dot(offset, lens.forward), _dot(offset, lens.right), _dot(offset, lens.up)


def _in_view(lens: Lens, point: tuple) -> bool:
    depth, right, up = _camera_space(lens, point)
    return 0 < depth <= VIEW_RANGE_CM and abs(right) <= depth * lens.slope_w and abs(up) <= depth * lens.slope_h


def _near_rect(lens: Lens) -> Box:
    """The near clip plane's rectangle the player sees through, as a flat box."""
    center = _add(lens.eye, _mul(lens.forward, lens.near))
    return Box(center, (lens.forward, lens.right, lens.up), (0.0, lens.near * lens.slope_w, lens.near * lens.slope_h))


def _overlap(a: Box, b: Box) -> bool:
    """Whether two oriented boxes overlap (separating axis test)."""
    offset = _sub(b.center, a.center)
    for axis in [*a.axes, *b.axes, *(_cross(u, v) for u in a.axes for v in b.axes)]:
        size = _length(axis)
        if size < EPSILON:
            continue
        n = _mul(axis, 1 / size)
        reach = sum(h * abs(_dot(u, n)) for u, h in zip(a.axes, a.half))
        reach += sum(h * abs(_dot(v, n)) for v, h in zip(b.axes, b.half))
        if abs(_dot(offset, n)) > reach + EPSILON:
            return False
    return True


def _distance_to_box(box: Box, point: tuple) -> float:
    """0 inside the box, else the distance to its surface."""
    offset = _sub(point, box.center)
    outside = [max(0.0, abs(_dot(offset, axis)) - half) for axis, half in zip(box.axes, box.half)]
    return math.sqrt(sum(d * d for d in outside))


def _component_box(component, kind: str) -> Box:
    """A static mesh's own box turned and scaled with it, else its world bounds."""
    mesh = _prop(component, 'static_mesh') if kind == MeshKind.STATIC else None
    if not mesh:
        origin, extent, _radius = unreal.SystemLibrary.get_component_bounds(component)
        return Box(_xyz(origin), ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)), _xyz(extent))
    local = mesh.get_bounding_box()
    low, high = _xyz(local.min), _xyz(local.max)
    scale = _xyz(component.get_world_scale())
    axes = _axes(component.get_world_rotation())
    middle = [(low[i] + high[i]) / 2 * scale[i] for i in range(3)]
    center = _xyz(component.get_world_location())
    for axis, along in zip(axes, middle):
        center = _add(center, _mul(axis, along))
    return Box(center, axes, tuple(abs((high[i] - low[i]) / 2 * scale[i]) for i in range(3)))


def _box_row(lens: Lens, box: Box) -> dict:
    drawn = Box(_drawn(lens, box.center), box.axes, tuple(h * lens.scale for h in box.half))
    samples = itertools.product((-1, 0, 1), repeat=3)
    points = [_add(drawn.center, _add(_add(_mul(drawn.axes[0], i * drawn.half[0]), _mul(drawn.axes[1], j * drawn.half[1])),
                                      _mul(drawn.axes[2], k * drawn.half[2]))) for i, j, k in samples]
    nearest = _distance_to_box(drawn, lens.eye)
    return {'inView': any(_in_view(lens, p) for p in points), 'nearestCm': round(nearest, 1), 'inside': nearest == 0.0,
            'clipping': _overlap(drawn, _near_rect(lens))}


def _bones(component) -> list[tuple]:
    names = list(component.get_all_socket_names())[:BONES_CAP]
    return [_xyz(component.get_socket_location(name)) for name in names]


def _in_near_slab(lens: Lens, point: tuple) -> bool:
    """Whether a bone's flesh reaches the near clip plane's rectangle."""
    depth, right, up = _camera_space(lens, point)
    near_w, near_h = lens.near * lens.slope_w, lens.near * lens.slope_h
    return (-BONE_RADIUS_CM < depth < lens.near + BONE_RADIUS_CM and abs(right) <= near_w + BONE_RADIUS_CM
            and abs(up) <= near_h + BONE_RADIUS_CM)


def _bones_row(lens: Lens, bones: list[tuple]) -> dict:
    drawn = [_drawn(lens, b) for b in bones]
    return {'inView': any(_in_view(lens, p) for p in drawn),
            'nearestCm': round(min(_length(_sub(p, lens.eye)) for p in drawn), 1), 'inside': None,
            'clipping': any(_in_near_slab(lens, p) for p in drawn)}


def _first_person_type(component) -> str | None:
    """FIRST_PERSON or WORLD_SPACE_REPRESENTATION for Unreal's first-person rendering, else None."""
    kinds = getattr(unreal, 'FirstPersonPrimitiveType', None)
    value = _prop(component, 'first_person_primitive_type')
    for name in ('FIRST_PERSON', 'WORLD_SPACE_REPRESENTATION'):
        if kinds is not None and value == getattr(kinds, name, None):
            return name
    return None


def _seen_by_player(component) -> bool:
    hidden_from_owner = _prop(component, 'owner_no_see', False)
    return _shown(component) and not hidden_from_owner and _first_person_type(component) != 'WORLD_SPACE_REPRESENTATION'


def _mesh_kind(component) -> str:
    if isinstance(component, unreal.StaticMeshComponent):
        return MeshKind.STATIC
    if isinstance(component, unreal.SkeletalMeshComponent):
        return MeshKind.SKELETAL
    return MeshKind.OTHER


def _mesh_row(actor, component, lenses: tuple[Lens, Lens]) -> dict:
    kind = _mesh_kind(component)
    first_person = _first_person_type(component) == 'FIRST_PERSON'
    lens = lenses[1] if first_person else lenses[0]
    bones = _bones(component) if kind == MeshKind.SKELETAL else []
    measured = _bones_row(lens, bones) if bones else _box_row(lens, _component_box(component, kind))
    return {'actor': actor.get_actor_label(), 'component': component.get_name(), 'kind': kind,
            'firstPerson': first_person, **measured}


def _player_meshes(target, lenses: tuple[Lens, Lens]) -> list[dict]:
    """The meshes of the view target and what is attached to it that the player can see, nearest first."""
    if target is None:
        return []
    rows = []
    for actor in [target, *target.get_attached_actors()]:
        if _prop(actor, 'hidden', False):
            continue
        rows += [_mesh_row(actor, c, lenses) for c in actor.get_components_by_class(unreal.MeshComponent)
                 if _seen_by_player(c)]
    return sorted(rows, key=lambda row: (row['nearestCm'], row['actor'], row['component']))


def _camera_component(target, eye: tuple):
    """The view target's camera nearest the view's eye, or None."""
    cameras = list(target.get_components_by_class(unreal.CameraComponent)) if target is not None else []
    return min(cameras, key=lambda c: _length(_sub(_xyz(c.get_world_location()), eye)), default=None)


def _project_near_clip() -> float:
    """The project's NearClipPlane from its Config/DefaultEngine.ini, or 0 when it sets none."""
    try:
        with open(os.path.join(unreal.Paths.project_dir(), 'Config', 'DefaultEngine.ini'), encoding='utf-8',
                  errors='replace') as handle:
            text = handle.read(INI_CAP)
    except OSError:
        return 0.0
    section = ''
    for line in (raw.strip() for raw in text.splitlines()):
        if line.startswith('['):
            section = line
        elif section == NEAR_CLIP_SECTION and line.startswith(NEAR_CLIP_KEY):
            try:
                return float(line[len(NEAR_CLIP_KEY):])
            except ValueError:
                return 0.0
    return 0.0


def _near_clip(camera) -> tuple[float, str]:
    custom = _prop(camera, 'custom_near_clipping_plane', 0.0) if camera is not None else 0.0
    if camera is not None and _prop(camera, 'override_custom_near_clipping_plane', False) and custom and custom > 0:
        return float(custom), NearFrom.CAMERA
    project = _project_near_clip()
    if project and project > 0:
        return float(project), NearFrom.PROJECT
    return DEFAULT_NEAR_CLIP_CM, NearFrom.DEFAULT


def _overridden(settings) -> dict:
    """The audited settings a post-process source overrides, with their values."""
    return {key: round(float(settings.get_editor_property(prop)), 3) for key, prop in AUDITED
            if settings.get_editor_property(f'override_{prop}')}


def _extremes(source: dict) -> list[dict]:
    flagged = []
    for key, value in source['settings'].items():
        if key not in FINE or (key in OFF_AT_ZERO and value == 0):
            continue
        low, high = FINE[key]
        if value < low or (high is not None and value > high):
            flagged.append({'source': source['source'], 'name': source['name'], 'setting': key, 'value': value,
                            'fine': [low, high]})
    return flagged


def _holds(volume, point: tuple) -> bool:
    """Whether the point is inside the volume's bounds (its box, not its exact brush)."""
    origin, extent = volume.get_actor_bounds(False)
    return all(abs(p - o) <= e for p, o, e in zip(point, _xyz(origin), _xyz(extent)))


def _volume_source(volume, eye: tuple) -> dict:
    enabled = bool(volume.get_editor_property('enabled'))
    unbound = bool(volume.get_editor_property('unbound'))
    weight = float(volume.get_editor_property('blend_weight'))
    reaches = unbound or _holds(volume, eye)
    return {'source': Source.VOLUME, 'name': volume.get_actor_label(), 'active': enabled and weight > 0 and reaches,
            'unbound': unbound, 'weight': round(weight, 2), 'priority': round(float(volume.get_editor_property('priority')), 2),
            'settings': _overridden(volume.get_editor_property('settings'))}


def _camera_source(camera) -> dict:
    weight = float(camera.get_editor_property('post_process_blend_weight'))
    return {'source': Source.CAMERA, 'name': camera.get_name(), 'active': weight > 0, 'weight': round(weight, 2),
            'settings': _overridden(camera.get_editor_property('post_process_settings'))}


def _post_process(world: unreal.World, eye: tuple, camera) -> dict:
    volumes = unreal.GameplayStatics.get_all_actors_of_class(world, unreal.PostProcessVolume)[:VOLUMES_CAP]
    sources = [_volume_source(v, eye) for v in volumes] + ([_camera_source(camera)] if camera is not None else [])
    defaults = {key: int(unreal.SystemLibrary.get_console_variable_int_value(name)) for key, name in DEFAULT_FEATURES}
    return {'sources': sources, 'defaults': defaults,
            'extreme': [flag for source in sources if source['active'] for flag in _extremes(source)]}


def _view(world: unreal.World, manager) -> dict:
    eye = _xyz(manager.get_camera_location())
    rotation = manager.get_camera_rotation()
    fov = float(manager.get_fov_angle())
    controller = unreal.GameplayStatics.get_player_controller(world, 0)
    target = (controller.get_view_target() if controller is not None else None) or \
        unreal.GameplayStatics.get_player_pawn(world, 0)
    camera = _camera_component(target, eye)
    near, near_from = _near_clip(camera)
    lens = _lens(eye, rotation, fov, near)
    rows = _player_meshes(target, (lens, _first_person_lens(lens, camera, rotation)))
    return {
        'camera': {'location': [round(c) for c in eye],
                   'rotation': [round(rotation.pitch, 1), round(rotation.yaw, 1), round(rotation.roll, 1)],
                   'fov': round(fov, 1), 'nearClipCm': round(near, 2), 'nearClipFrom': near_from,
                   'viewTarget': target.get_actor_label() if target is not None else None,
                   'component': camera.get_name() if camera is not None else None},
        'meshes': rows[:MESHES_CAP], 'moreMeshes': max(0, len(rows) - MESHES_CAP),
        'postProcess': _post_process(world, eye, camera),
    }


def probe_view() -> dict:
    """The player's view: its own meshes against the camera's near clip plane, and the post-process that applies."""
    world = _play_world()
    manager = unreal.GameplayStatics.get_player_camera_manager(world, 0)
    if manager is None:
        raise Refused(MESSAGE['no_camera'])
    return _guarded(_view, world, manager)
