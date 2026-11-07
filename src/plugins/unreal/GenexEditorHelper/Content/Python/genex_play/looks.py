"""Animation and look checks on the characters near the player (genex_play.detect runs them): a body
that slides along without stepping, one that stands in a T-pose (no animation plays on it), and feet
that float over the ground or sink into it. A few times a second, every character within NEAR_CM
but the player's own is read by its skeleton's feet, shoulders and hands; a ragdoll is left alone.
The body read is the one the player sees (visible_body): a Motion Matching character's own mesh is a
driver whose pose another mesh copies, and that mesh is the one that may slide, even when the driver
is left shown under it. The arithmetic is in looks_math.
"""

import math

import unreal

from genex_play import looks_math, play

SLIDING = 'sliding'
T_POSE = 't-pose'
FLOATING = 'floating'
SUNK = 'sunk'
CODES = (SLIDING, T_POSE, FLOATING, SUNK)

# The checks run this often (game seconds), on characters this near the player (cm).
EVERY_S = 0.2
NEAR_CM = 3000.0
# A slide is judged over this stretch; a T-pose or a gap to the ground must last this long.
WINDOW_S = 1.2
HOLD_S = 1.0
# A ground under a character is looked for this far down (cm) from its middle.
DOWN_CM = 400.0
# BreakHitResult's sixth output: where the trace hit.
HIT_POINT = 5
# A bone is a foot, a shoulder or a hand by these words in its name; these words rule one out.
FOOT, SHOULDER, HAND = ('foot',), ('upperarm', 'leftarm', 'rightarm'), ('hand',)
NOT_A_PART = ('ik', 'twist', 'ball', 'toe', 'vb', 'corrective', 'index', 'thumb', 'middle', 'ring', 'pinky', 'lower', 'fore')

_state: dict = {'next': -math.inf, 'bodies': {}, 'parts': {}}


def reset() -> None:
    """Forgets every body; the next play starts afresh."""
    _state.update(next=-math.inf, bodies={}, parts={})


def _side(name: str) -> str | None:
    # A rig's prefix (mixamorig:LeftFoot) is not part of the bone's own name.
    low = name.lower().rsplit(':', 1)[-1]
    if low.endswith(('_l', '.l')) or low.startswith('left'):
        return 'l'
    if low.endswith(('_r', '.r')) or low.startswith('right'):
        return 'r'
    return None


def _named(names: list, words: tuple) -> dict:
    """{side: bone} of the bones whose name holds one of words and none of NOT_A_PART."""
    found = {}
    for name in names:
        low = name.lower()
        if any(w in low for w in words) and not any(w in low for w in NOT_A_PART):
            side = _side(name)
            if side and side not in found:
                found[side] = name
    return found


def parts(mesh) -> dict:
    """The mesh's feet, shoulders and hands by side, read once per mesh."""
    key = mesh.get_path_name()
    if key not in _state['parts']:
        names = [str(n) for n in mesh.get_all_socket_names()]
        _state['parts'][key] = {'feet': _named(names, FOOT), 'shoulders': _named(names, SHOULDER),
                                'hands': _named(names, HAND)}
    return _state['parts'][key]


def shown(mesh) -> bool:
    """Whether a mesh is drawn in the game: visible, not hidden in game, and drawn in the main pass."""
    if not mesh.is_visible() or mesh.get_editor_property('hidden_in_game'):
        return False
    try:
        return bool(mesh.get_editor_property('render_in_main_pass'))
    except Exception:  # noqa: BLE001 - a component without the flag is drawn
        return True


def _own_mesh(actor):
    try:
        return actor.get_editor_property('mesh')
    except Exception:  # noqa: BLE001 - an actor that is no Character has no mesh property
        return None


def _first_person(mesh) -> bool:
    """Whether a mesh is drawn only for its owner's own view (first-person arms), not as the body."""
    try:
        if mesh.get_editor_property('only_owner_see'):
            return True
        kinds = getattr(unreal, 'FirstPersonPrimitiveType', None)
        return kinds is not None and mesh.get_editor_property('first_person_primitive_type') == kinds.FIRST_PERSON
    except Exception:  # noqa: BLE001 - a mesh without these flags is drawn for everyone
        return False


def visible_body(actor):
    """The skeletal mesh a player sees on a character: the first shown one with feet besides its own
    mesh and its first-person arms (a Motion Matching character's Body copies its own mesh's pose, and
    a game may leave that driver shown under it), else its own mesh when shown with feet; None without one."""
    own = _own_mesh(actor)
    meshes = list(actor.get_components_by_class(unreal.SkeletalMeshComponent))
    others = [m for m in meshes if m is not own and not _first_person(m)]
    for mesh in others + ([own] if own in meshes else []):
        if shown(mesh) and parts(mesh)['feet']:
            return mesh
    return None


def _xyz(vector) -> tuple:
    return (float(vector.x), float(vector.y), float(vector.z))


def _label(actor) -> str:
    try:
        return str(actor.get_actor_label())
    except Exception:  # noqa: BLE001 - a runtime actor has no editor label
        return str(actor.get_name())


def _ground(actor, at: tuple) -> float | None:
    # Anything solid below, whatever channels it lets through: a floor that ignores the sight channel is
    # still what the character stands on.
    hit = unreal.SystemLibrary.line_trace_single_for_objects(
        actor, unreal.Vector(*at), unreal.Vector(at[0], at[1], at[2] - DOWN_CM),
        [unreal.ObjectTypeQuery.OBJECT_TYPE_QUERY1, unreal.ObjectTypeQuery.OBJECT_TYPE_QUERY2],
        False, [actor, *actor.get_attached_actors()], unreal.DrawDebugTrace.NONE, True)
    if hit is None:
        return None
    return float(hit.to_tuple()[HIT_POINT].z)


def _standing(actor) -> bool:
    movement = actor.get_component_by_class(unreal.CharacterMovementComponent)
    return movement is not None and not movement.is_falling()


def _held(body: dict, key: str, now: float, on: bool) -> bool:
    """Whether a condition has held HOLD_S (told once per stretch): `on` this check."""
    if not on:
        body[key] = None
        return False
    if body.get(key) is None:
        body[key] = now
    if body[key] is not False and now - body[key] >= HOLD_S:
        body[key] = False  # told; quiet until the condition breaks
        return True
    return False


def _check_body(actor, now: float, note) -> None:
    mesh = visible_body(actor)
    if mesh is None or mesh.is_simulating_physics():
        return
    bones = parts(mesh)
    label = _label(actor)
    at, yaw = _xyz(actor.get_actor_location()), float(actor.get_actor_rotation().yaw)
    body = _state['bodies'].setdefault(label, {'samples': []})
    feet = {side: _xyz(mesh.get_socket_location(bone)) for side, bone in bones['feet'].items()}
    sample = (now, at, {side: looks_math.local(p, at, yaw) for side, p in feet.items()})
    samples = body['samples'] = [s for s in body['samples'] if now - s[0] <= WINDOW_S] + [sample]
    if feet and len(samples) >= 3 and now - samples[0][0] >= WINDOW_S - EVERY_S:
        travelled = math.dist(samples[0][1][:2], at[:2])
        tracks = {side: [s[2][side] for s in samples if side in s[2]] for side in feet}
        if _held(body, 'slide', now, looks_math.slides(tracks, travelled)):
            note(SLIDING, f'{label} slides along ({travelled / 100:.1f} m in {WINDOW_S:g} s) without moving its feet', now)
    arms = [looks_math.arm_out(_xyz(mesh.get_socket_location(bones['shoulders'][s])),
                               _xyz(mesh.get_socket_location(bones['hands'][s])), yaw)
            for s in ('l', 'r') if s in bones['shoulders'] and s in bones['hands']]
    if _held(body, 'tpose', now, len(arms) == 2 and all(arms)):
        note(T_POSE, f'{label} stands in a T-pose, arms straight out: no animation plays on it', now)
    ground = _ground(actor, at) if feet and _standing(actor) else None
    gap = looks_math.ground_gap([p[2] for p in feet.values()], ground) if ground is not None else None
    if _held(body, 'float', now, gap is not None and gap > looks_math.GROUND_GAP_CM):
        note(FLOATING, f'{label} stands {gap:.0f} cm above the ground', now)
    if _held(body, 'sunk', now, gap is not None and gap < -looks_math.GROUND_GAP_CM):
        note(SUNK, f"{label}'s feet are {-gap:.0f} cm into the ground", now)


def check(pawn, game_now: float, note) -> None:
    """Runs the checks on the characters near the player, at most once every EVERY_S game seconds;
    note(code, detail, game_now) is told what looks wrong."""
    if game_now < _state['next']:
        return
    _state['next'] = game_now + EVERY_S
    me = _xyz(pawn.get_actor_location())
    for actor in unreal.GameplayStatics.get_all_actors_of_class(play.game_world(), unreal.Character):
        if actor == pawn or math.dist(_xyz(actor.get_actor_location()), me) > NEAR_CM:
            continue
        try:
            _check_body(actor, game_now, note)
        except Exception:  # noqa: BLE001 - one odd character never stops the others' checks
            continue
