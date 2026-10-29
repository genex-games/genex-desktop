"""The character check's numbers and verdict. Pure Python: poses come in as {bone: (location,
rotation)} in component space (cm, (x, y, z, w) quaternions), so it is tested outside the engine.

The bones come from the IK Rig Unreal's auto-characterisation makes (chains LeftArm, RightArm,
LeftLeg, RightLeg, Neck, Head, Spine and the retarget root), walked through the skeleton:

- upper arm, forearm, hand: the arm chain's start, its end's parent, its end;
- thigh, knee, foot, toe: the leg chain from its start down (a chain ending at the foot has no toe);
- neck: the Neck chain's start, else the Head chain's, else the Spine chain's end;
- fingers: every bone under the hand.

Per sampled frame it measures, in the body's own frame (pose_math.body_frame, so any facing and any
axes compare): how far each upper arm stands out to the side of the torso (in the body's front
plane, so an arm swinging forward is not "out"), its angle to the torso, how far each hand is from
its thigh, how wide the skeleton is across the body against the character's height, and how low the
feet are. Across a clip it adds how far the feet float or sink against the reference pose, how far
the fingers move, how far any mesh edge stretches against the bind pose (a strip of cloth weighted to
the wrong bone stretches many times its length), and, with a driver skeleton playing the same clip,
how far each limb points away from the driver's at the same frame.
"""

from genex_build import pose_math as pm

SIDES = ('Left', 'Right')
# Thresholds: a character passes with every number within them.
MAX_ARM_OUT_IDLE_DEG = 20.0
MAX_ARM_OUT_WALK_DEG = 30.0
MAX_HAND_TO_THIGH_OF_HEIGHT = 0.15
MAX_WIDTH_TO_HEIGHT = 0.45
MAX_FEET_GROUND_CM = 5.0
MAX_EDGE_STRETCH = 2.5
MAX_CHAIN_ERROR_DEG = 20.0
# Fingers that move less than this (in the hand's own frame) across a clip don't move.
MIN_FINGER_MOVE_CM = 0.3
# Bind-pose edges shorter than this are not measured for stretch.
MIN_EDGE_CM = 0.05
# An edge counts as stretched only once it is this long posed: a fold at a joint grows tiny edges many times
# over and stays invisible, while a strip of cloth pulled away from the body is centimetres long.
MIN_STRETCHED_CM = 5.0
LIMBS = (('upperArm', 'forearm'), ('forearm', 'hand'), ('thigh', 'knee'), ('knee', 'foot'))
DIGITS = 1


def bone_path(start: str, end: str, parent_of) -> list | None:
    """[start, ..., end] walking up from end through parent_of(bone) (None at the root); None if start isn't above."""
    path, bone, seen = [], end, set()
    while bone is not None and bone not in seen:
        seen.add(bone)
        path.append(bone)
        if bone == start:
            return list(reversed(path))
        bone = parent_of(bone)
    return None


def lowest_below(end: str, root: str, parent_of) -> str | None:
    """The bone right under `root` on the way up from `end` (the lowest spine bone, for a spine chain ending at
    `end` over a pelvis `root`); None when `end` isn't under `root`."""
    bone, seen = end, set()
    while bone is not None and bone not in seen:
        seen.add(bone)
        parent = parent_of(bone)
        if parent == root:
            return bone
        bone = parent
    return None


def descendants(bone: str, children_of) -> list:
    found, stack = [], list(children_of(bone))
    while stack:
        child = stack.pop()
        if child not in found:
            found.append(child)
            stack.extend(children_of(child))
    return sorted(found)


def _limb_roles(chains: dict, side: str, parent_of, children_of) -> dict | None:
    arm = chains.get(f'{side}Arm')
    leg = chains.get(f'{side}Leg')
    arm_path = bone_path(arm[0], arm[1], parent_of) if arm else None
    leg_path = bone_path(leg[0], leg[1], parent_of) if leg else None
    if not arm_path or len(arm_path) < 3 or not leg_path or len(leg_path) < 3:
        return None
    return {'upperArm': arm_path[0], 'forearm': arm_path[-2], 'hand': arm_path[-1],
            'thigh': leg_path[0], 'knee': leg_path[1], 'foot': leg_path[2],
            'toe': leg_path[3] if len(leg_path) > 3 else None,
            'fingers': descendants(arm_path[-1], children_of)}


def roles(chains: dict, pelvis: str, parent_of, children_of) -> dict | None:
    """{pelvis, neck, Left: {...}, Right: {...}} (see the module notes), or None when an arm or leg is missing."""
    neck = (chains.get('Neck') or chains.get('Head') or (None, None))[0]
    if neck is None and 'Spine' in chains:
        neck = chains['Spine'][1]
    found = {'pelvis': pelvis, 'neck': neck}
    for side in SIDES:
        limbs = _limb_roles(chains, side, parent_of, children_of)
        if limbs is None or not pelvis or not neck:
            return None
        found[side] = limbs
    return found


def role_bones(found: dict) -> list:
    """Every bone the check samples."""
    bones = {found['pelvis'], found['neck']}
    for side in SIDES:
        limbs = found[side]
        bones.update(limbs[k] for k in ('upperArm', 'forearm', 'hand', 'thigh', 'knee', 'foot', 'toe') if limbs[k])
        bones.update(limbs['fingers'])
    return sorted(bones)


def _at(pose: dict, bone: str) -> tuple:
    return pose[bone][0]


def frame_of(pose: dict, found: dict) -> tuple:
    return pm.body_frame(_at(pose, found['pelvis']), _at(pose, found['neck']),
                         _at(pose, found['Left']['upperArm']), _at(pose, found['Right']['upperArm']))


def segment_distance(point: tuple, a: tuple, b: tuple) -> float:
    span = pm.sub(b, a)
    size = pm.dot(span, span)
    t = 0.0 if size < pm.EPSILON else max(0.0, min(1.0, pm.dot(pm.sub(point, a), span) / size))
    return pm.length(pm.sub(point, pm.add(a, pm.scaled(span, t))))


def _arm_out(upper: tuple, frame: tuple) -> float:
    """How far the upper arm stands out to the side: its angle to straight down in the body's front plane."""
    side, up = pm.dot(upper, frame[0]), pm.dot(upper, frame[1])
    if abs(side) + abs(up) < pm.EPSILON:
        return 0.0
    return pm.angle_deg((side, up, 0.0), (0.0, -1.0, 0.0))


def _feet_low(pose: dict, found: dict) -> float:
    feet = [found[s][k] for s in SIDES for k in ('foot', 'toe') if found[s][k]]
    return min(_at(pose, bone)[2] for bone in feet)


def frame_numbers(pose: dict, found: dict) -> dict:
    """One frame's numbers (see the module notes)."""
    frame = frame_of(pose, found)
    down = pm.sub(_at(pose, found['pelvis']), _at(pose, found['neck']))
    numbers = {'armOutDeg': {}, 'armToTorsoDeg': {}, 'handToThighCm': {}}
    for side in SIDES:
        limbs = found[side]
        upper = pm.sub(_at(pose, limbs['forearm']), _at(pose, limbs['upperArm']))
        numbers['armOutDeg'][side] = round(_arm_out(upper, frame), DIGITS)
        numbers['armToTorsoDeg'][side] = round(pm.angle_deg(upper, down), DIGITS)
        hand = _at(pose, limbs['hand'])
        numbers['handToThighCm'][side] = round(segment_distance(hand, _at(pose, limbs['thigh']), _at(pose, limbs['knee'])), DIGITS)
    across = [pm.dot(_at(pose, bone), frame[0]) for bone in role_bones(found)]
    numbers['widthCm'] = round(max(across) - min(across), DIGITS)
    numbers['feetLowCm'] = round(_feet_low(pose, found), DIGITS)
    return numbers


def finger_motion(poses: list, found: dict) -> dict:
    """{side: {bones, movedCm}}: how far the fingers move in the hand's own frame across the poses."""
    motion = {}
    for side in SIDES:
        limbs = found[side]
        moved = 0.0
        for finger in limbs['fingers']:
            local = [pm.rotate(pm.quat_inverse(p[limbs['hand']][1]), pm.sub(_at(p, finger), _at(p, limbs['hand'])))
                     for p in poses]
            spread = [max(v[i] for v in local) - min(v[i] for v in local) for i in range(3)] if local else [0, 0, 0]
            moved = max(moved, pm.length(tuple(spread)))
        motion[side] = {'bones': len(limbs['fingers']), 'movedCm': round(moved, 2)}
    return motion


def chain_errors(pose: dict, found: dict, driver_pose: dict, driver_found: dict) -> dict:
    """{limb: degrees}: how far each limb points from the driver's same limb, each in its own body frame."""
    frame, driver_frame = frame_of(pose, found), frame_of(driver_pose, driver_found)
    errors = {}
    for side in SIDES:
        for bone, child in LIMBS:
            own = pm.in_frame(frame, pm.limb_direction(pose, found[side][bone], found[side][child]))
            theirs = pm.in_frame(driver_frame, pm.limb_direction(driver_pose, driver_found[side][bone],
                                                                 driver_found[side][child]))
            errors[f'{side} {bone}'] = round(pm.angle_deg(own, theirs), DIGITS)
    return errors


def bone_matrices(bind: dict, posed: dict) -> dict:
    """{bone: (3x3 rows, translation)} taking a point bound to the bone in the bind pose to where the pose puts it."""
    found = {}
    for bone, (bind_location, bind_rotation) in bind.items():
        if bone not in posed:
            continue
        location, rotation = posed[bone]
        turn = pm.quat_mul(rotation, pm.quat_inverse(bind_rotation))
        rows = [pm.rotate(turn, axis) for axis in ((1.0, 0.0, 0.0), (0.0, 1.0, 0.0), (0.0, 0.0, 1.0))]
        rows = [(rows[0][i], rows[1][i], rows[2][i]) for i in range(3)]
        moved = tuple(location[i] - pm.dot(rows[i], bind_location) for i in range(3))
        found[bone] = (rows, moved)
    return found


def skin(positions: list, weights: list, matrices: dict) -> list:
    """Linear blend skinning: each bind position moved by its bones' matrices, weighted."""
    posed = []
    for point, influences in zip(positions, weights):
        x = y = z = total = 0.0
        for bone, weight in influences:
            if bone not in matrices or weight <= 0:
                continue
            rows, moved = matrices[bone]
            x += weight * (pm.dot(rows[0], point) + moved[0])
            y += weight * (pm.dot(rows[1], point) + moved[1])
            z += weight * (pm.dot(rows[2], point) + moved[2])
            total += weight
        posed.append(point if total <= 0 else (x / total, y / total, z / total))
    return posed


def edge_stretch(bind: list, posed: list, triangles: list) -> dict:
    """{stretch, bindCm, posedCm, at}: the edge that grew most against its bind length, by ratio, among those at
    least MIN_STRETCHED_CM long posed."""
    worst = {'stretch': 1.0, 'bindCm': 0.0, 'posedCm': 0.0, 'at': None}
    seen = set()
    for triangle in triangles:
        for a, b in ((triangle[0], triangle[1]), (triangle[1], triangle[2]), (triangle[2], triangle[0])):
            edge = (min(a, b), max(a, b))
            if edge in seen:
                continue
            seen.add(edge)
            before = pm.length(pm.sub(bind[a], bind[b]))
            if before < MIN_EDGE_CM:
                continue
            after = pm.length(pm.sub(posed[a], posed[b]))
            if after >= MIN_STRETCHED_CM and after / before > worst['stretch']:
                worst = {'stretch': round(after / before, 2), 'bindCm': round(before, 2), 'posedCm': round(after, 2),
                         'at': [round(c) for c in posed[a]]}
    return worst


def clip_summary(frames: list, reference: dict) -> dict:
    """The worst of a clip's frames: arm out and hand to thigh per side, width, and feet off the ground."""
    return {
        'armOutDeg': {s: max(f['armOutDeg'][s] for f in frames) for s in SIDES},
        'armToTorsoDeg': {s: max(f['armToTorsoDeg'][s] for f in frames) for s in SIDES},
        'handToThighCm': {s: max(f['handToThighCm'][s] for f in frames) for s in SIDES},
        'widthCm': max(f['widthCm'] for f in frames),
        'feetGroundErrorCm': round(max(abs(f['feetLowCm'] - reference['feetLowCm']) for f in frames), DIGITS),
    }


def _clip_reasons(name: str, summary: dict, height: float) -> list:
    reasons = []
    arm_limit = MAX_ARM_OUT_IDLE_DEG if name == 'idle' else MAX_ARM_OUT_WALK_DEG
    for side in SIDES:
        out = summary['armOutDeg'][side]
        if out > arm_limit:
            reasons.append(f'{name}: the {side.lower()} upper arm stands {out:g}° out from the body (at most '
                           f'{arm_limit:g}°): the arms hang away from the body')
    if name != 'idle':
        return reasons
    hand_limit = round(MAX_HAND_TO_THIGH_OF_HEIGHT * height, DIGITS)
    for side in SIDES:
        gap = summary['handToThighCm'][side]
        if gap > hand_limit:
            reasons.append(f'idle: the {side.lower()} hand is {gap:g} cm from its thigh (at most {hand_limit:g} cm '
                           'for this height)')
    ratio = round(summary['widthCm'] / height, 2) if height > 0 else 0.0
    if ratio > MAX_WIDTH_TO_HEIGHT:
        reasons.append(f'idle: the skeleton is {ratio:g} times as wide as the character is tall (at most '
                       f'{MAX_WIDTH_TO_HEIGHT:g}): arms held out')
    return reasons


def verdict(clips: dict, height: float, stretch: dict | None, chains: dict | None, fingers: dict | None) -> dict:
    """{passed, reasons, warnings} from each clip's summary ({name: summary}), the worst edge stretch over all
    frames, the worst limb errors against a driver and the finger motion of the walk (or idle)."""
    reasons, warnings = [], []
    for name, summary in clips.items():
        reasons += _clip_reasons(name, summary, height)
        if summary['feetGroundErrorCm'] > MAX_FEET_GROUND_CM:
            reasons.append(f'{name}: the feet float or sink by {summary["feetGroundErrorCm"]:g} cm against the '
                           f'reference pose (at most {MAX_FEET_GROUND_CM:g} cm)')
    if stretch and stretch['stretch'] > MAX_EDGE_STRETCH:
        reasons.append(f'an edge of the mesh stretches to {stretch["stretch"]:g} times its bind length (at most '
                       f'{MAX_EDGE_STRETCH:g}) near {stretch["at"]}: part of the mesh is weighted to the wrong bone, '
                       'such as a strip of cloth pulled to the floor')
    for limb, error in (chains or {}).items():
        if error > MAX_CHAIN_ERROR_DEG:
            reasons.append(f'the {limb.lower()} points {error:g}° away from the driver\'s at the same frame (at most '
                           f'{MAX_CHAIN_ERROR_DEG:g}°)')
    for side, motion in (fingers or {}).items():
        if motion['bones'] == 0:
            warnings.append(f'no {side.lower()} finger bones: the hand keeps its bind shape (a rig with fingers, '
                            'such as Genex\'s character import, fixes it)')
        elif motion['movedCm'] < MIN_FINGER_MOVE_CM:
            warnings.append(f'the {side.lower()} fingers do not move')
    return {'passed': not reasons, 'reasons': reasons, 'warnings': warnings}


def thresholds() -> dict:
    """The limits the verdict holds the numbers to, as the answer shows them."""
    return {'armOutIdleDeg': MAX_ARM_OUT_IDLE_DEG, 'armOutWalkDeg': MAX_ARM_OUT_WALK_DEG,
            'handToThighOfHeight': MAX_HAND_TO_THIGH_OF_HEIGHT, 'widthToHeight': MAX_WIDTH_TO_HEIGHT,
            'feetGroundCm': MAX_FEET_GROUND_CM, 'edgeStretch': MAX_EDGE_STRETCH, 'chainErrorDeg': MAX_CHAIN_ERROR_DEG}
