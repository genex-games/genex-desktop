"""Vectors, quaternions and skeleton poses as plain tuples, for the character check and the retarget
pose's arm fix. Pure Python: it never touches the engine, so it is tested outside it.

A vector is (x, y, z) in cm; a quaternion is (x, y, z, w) as Unreal's FQuat holds it, and quat_mul(a, b)
is FQuat's a * b: b is applied first. A pose maps a bone name to its (location, rotation) in component
space; `parents` maps a bone to its parent bone (None at the root).

A body frame is (side, up, forward) unit axes built from the skeleton itself (up from pelvis to
neck, side from the right shoulder to the left), so two skeletons that face different ways or use
different axes compare by the same frame.

An IK Retargeter's retarget pose stores a LOCAL rotation delta per bone, applied after the bone's
reference rotation (local' = local * delta), so a bone's delta turns it in its own frame.
"""

import math

IDENTITY = (0.0, 0.0, 0.0, 1.0)
# Directions closer than this are the same, and a turn smaller than this is no turn.
EPSILON = 1e-9


def add(a: tuple, b: tuple) -> tuple:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def sub(a: tuple, b: tuple) -> tuple:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def scaled(a: tuple, k: float) -> tuple:
    return (a[0] * k, a[1] * k, a[2] * k)


def dot(a: tuple, b: tuple) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def cross(a: tuple, b: tuple) -> tuple:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def length(a: tuple) -> float:
    return math.sqrt(dot(a, a))


def unit(a: tuple) -> tuple:
    """`a` at length 1; (0, 0, 0) stays as it is."""
    size = length(a)
    return a if size < EPSILON else scaled(a, 1.0 / size)


def angle_deg(a: tuple, b: tuple) -> float:
    """The angle between two directions, 0 to 180 degrees (0 when either has no length)."""
    if length(a) < EPSILON or length(b) < EPSILON:
        return 0.0
    cosine = max(-1.0, min(1.0, dot(unit(a), unit(b))))
    return math.degrees(math.acos(cosine))


def quat_mul(a: tuple, b: tuple) -> tuple:
    """FQuat's a * b: the rotation b, then a."""
    ax, ay, az, aw = a
    bx, by, bz, bw = b
    return (aw * bx + ax * bw + ay * bz - az * by,
            aw * by - ax * bz + ay * bw + az * bx,
            aw * bz + ax * by - ay * bx + az * bw,
            aw * bw - ax * bx - ay * by - az * bz)


def quat_inverse(q: tuple) -> tuple:
    """The inverse of a unit quaternion."""
    return (-q[0], -q[1], -q[2], q[3])


def quat_unit(q: tuple) -> tuple:
    size = math.sqrt(sum(c * c for c in q))
    return IDENTITY if size < EPSILON else tuple(c / size for c in q)


def rotate(q: tuple, v: tuple) -> tuple:
    """`v` turned by the unit quaternion `q`."""
    turned = quat_mul(quat_mul(q, (v[0], v[1], v[2], 0.0)), quat_inverse(q))
    return (turned[0], turned[1], turned[2])


def quat_angle_deg(q: tuple) -> float:
    """How far `q` turns, 0 to 180 degrees."""
    return math.degrees(2.0 * math.acos(max(-1.0, min(1.0, abs(quat_unit(q)[3])))))


def quat_axis_angle(axis: tuple, degrees: float) -> tuple:
    half = math.radians(degrees) / 2.0
    x, y, z = scaled(unit(axis), math.sin(half))
    return (x, y, z, math.cos(half))


def quat_between(a: tuple, b: tuple) -> tuple:
    """The shortest turn that takes direction `a` onto direction `b`."""
    ua, ub = unit(a), unit(b)
    cosine = dot(ua, ub)
    if cosine > 1.0 - EPSILON:
        return IDENTITY
    if cosine < -1.0 + EPSILON:
        other = (1.0, 0.0, 0.0) if abs(ua[0]) < 0.9 else (0.0, 1.0, 0.0)
        return quat_axis_angle(cross(ua, other), 180.0)
    axis = cross(ua, ub)
    return quat_unit((axis[0], axis[1], axis[2], 1.0 + cosine))


def body_frame(pelvis: tuple, neck: tuple, left: tuple, right: tuple) -> tuple:
    """(side, up, forward) unit axes of a body: up from pelvis to neck, side from the right shoulder (or hip)
    to the left one made square to up, forward square to both."""
    up = unit(sub(neck, pelvis))
    across = sub(left, right)
    side = unit(sub(across, scaled(up, dot(across, up))))
    return (side, up, unit(cross(side, up)))


def in_frame(frame: tuple, v: tuple) -> tuple:
    """`v`'s coordinates along the frame's axes."""
    return (dot(v, frame[0]), dot(v, frame[1]), dot(v, frame[2]))


def from_frame(frame: tuple, coords: tuple) -> tuple:
    """The vector with those coordinates along the frame's axes."""
    return add(add(scaled(frame[0], coords[0]), scaled(frame[1], coords[1])), scaled(frame[2], coords[2]))


def local_pose(pose: dict, parents: dict) -> dict:
    """Each bone's (location, rotation) relative to its parent, from component-space `pose`."""
    local = {}
    for bone, (location, rotation) in pose.items():
        parent = parents.get(bone)
        if parent is None or parent not in pose:
            local[bone] = (location, rotation)
            continue
        parent_location, parent_rotation = pose[parent]
        back = quat_inverse(parent_rotation)
        local[bone] = (rotate(back, sub(location, parent_location)), quat_mul(back, rotation))
    return local


def component_pose(local: dict, parents: dict) -> dict:
    """Component-space (location, rotation) of every bone in `local`, parents before children."""
    done: dict = {}

    def place(bone: str) -> tuple:
        if bone in done:
            return done[bone]
        location, rotation = local[bone]
        parent = parents.get(bone)
        if parent is None or parent not in local:
            done[bone] = (location, rotation)
        else:
            parent_location, parent_rotation = place(parent)
            done[bone] = (add(parent_location, rotate(parent_rotation, location)), quat_mul(parent_rotation, rotation))
        return done[bone]

    for bone in local:
        place(bone)
    return done


def with_deltas(reference: dict, parents: dict, deltas: dict) -> dict:
    """The component-space pose of `reference` with each bone's local rotation delta applied after its own."""
    local = local_pose(reference, parents)
    for bone, delta in deltas.items():
        if bone in local:
            location, rotation = local[bone]
            local[bone] = (location, quat_mul(rotation, delta))
    return component_pose(local, parents)


def limb_direction(pose: dict, bone: str, child: str) -> tuple:
    return unit(sub(pose[child][0], pose[bone][0]))


def match_limbs(target: dict, parents: dict, deltas: dict, target_frame: tuple, wanted: list,
                min_turn_deg: float = 0.5) -> tuple:
    """Turns target limbs to point where `wanted` says, root-most limb first.

    `wanted` is an ordered list of (bone, child, direction in body-frame coordinates). Each bone's
    delta becomes delta * (G^-1 * C * G), where G is its current component rotation and C the
    component-space turn onto the wanted direction, so the bone turns in place and its children follow.
    Returns (the new deltas, {bone: [degrees off before, degrees off after]})."""
    deltas = dict(deltas)
    report = {}
    for bone, child, coords in wanted:
        pose = with_deltas(target, parents, deltas)
        current = limb_direction(pose, bone, child)
        goal = unit(from_frame(target_frame, coords))
        before = angle_deg(current, goal)
        if before >= min_turn_deg:
            rotation = pose[bone][1]
            turn = quat_mul(quat_mul(quat_inverse(rotation), quat_between(current, goal)), rotation)
            deltas[bone] = quat_unit(quat_mul(deltas.get(bone, IDENTITY), turn))
        after = angle_deg(limb_direction(with_deltas(target, parents, deltas), bone, child), goal)
        report[bone] = [round(before, 1), round(after, 1)]
    return deltas, report
