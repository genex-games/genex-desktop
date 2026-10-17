"""Synthetic rigged characters for the character check's and the retarget's tests: a 180 cm body with
an auto-rigger's bone names, facing +X (Unreal's forward) with its left along -Y, its upper arms held
`arm_out` degrees out from the body and its elbows bent `elbow` degrees forward, as a stub
SkeletalMesh with the chains Unreal's auto-characterisation would find, its reference pose and a
small skinned mesh, and clips whose every frame is a pose the test chooses."""

import math

import unreal

from genex_build import pose_math as pm

ROOT = 'Hips'
SIDES = (('Left', 1.0), ('Right', -1.0))


def parents(fingers: bool = False) -> dict:
    """An auto-rigger's hierarchy: its spine runs Hips > Spine02 > Spine01 > Spine."""
    found = {'Hips': None, 'Spine02': 'Hips', 'Spine01': 'Spine02', 'Spine': 'Spine01', 'neck': 'Spine', 'Head': 'neck'}
    for side, _ in SIDES:
        found.update({f'{side}Shoulder': 'Spine', f'{side}Arm': f'{side}Shoulder', f'{side}ForeArm': f'{side}Arm',
                      f'{side}Hand': f'{side}ForeArm', f'{side}UpLeg': 'Hips', f'{side}Leg': f'{side}UpLeg',
                      f'{side}Foot': f'{side}Leg', f'{side}ToeBase': f'{side}Foot'})
        if fingers:
            found[f'{side}HandIndex1'] = f'{side}Hand'
    return found


def chains(fingers: bool = False) -> dict:
    """The chains auto-characterisation finds on it: like the template it matches, the Spine chain holds
    only the top spine bone."""
    found = {'Spine': ('Spine', 'Spine'), 'Neck': ('neck', 'neck'), 'Head': ('Head', 'Head')}
    for side, _ in SIDES:
        found[f'{side}Arm'] = (f'{side}Arm', f'{side}Hand')
        found[f'{side}Leg'] = (f'{side}UpLeg', f'{side}ToeBase')
        if fingers:
            found[f'{side}Index'] = (f'{side}HandIndex1', f'{side}HandIndex1')
    return found


def _body_points(arm_out: float, elbow: float, feet_up: float, fingers: bool, curl: float) -> dict:
    """Each bone's place as (left, forward, up) in cm."""
    points = {'Hips': (0.0, 0.0, 100.0), 'Spine02': (0.0, 0.0, 108.0), 'Spine01': (0.0, 0.0, 116.0),
              'Spine': (0.0, 0.0, 125.0), 'neck': (0.0, 0.0, 150.0), 'Head': (0.0, 0.0, 162.0)}
    for side, sign in SIDES:
        out, bend = math.radians(arm_out), math.radians(elbow)
        shoulder = (sign * 18.0, 0.0, 145.0)
        upper = (sign * math.sin(out), 0.0, -math.cos(out))
        elbow_at = pm.add(shoulder, pm.scaled(upper, 30.0))
        forearm = pm.unit((upper[0] * math.cos(bend), math.sin(bend), upper[2] * math.cos(bend)))
        hand = pm.add(elbow_at, pm.scaled(forearm, 25.0))
        points.update({f'{side}Shoulder': (sign * 5.0, 0.0, 145.0), f'{side}Arm': shoulder,
                       f'{side}ForeArm': elbow_at, f'{side}Hand': hand,
                       f'{side}UpLeg': (sign * 10.0, 0.0, 95.0), f'{side}Leg': (sign * 10.0, 0.0, 52.0),
                       f'{side}Foot': (sign * 10.0, 0.0, 8.0 + feet_up),
                       f'{side}ToeBase': (sign * 10.0, 12.0, 2.0 + feet_up)})
        if fingers:
            points[f'{side}HandIndex1'] = pm.add(hand, (0.0, curl, -8.0))
    return points


def pose(arm_out: float = 8.0, elbow: float = 10.0, yaw: float = 0.0, feet_up: float = 0.0, fingers: bool = False,
         curl: float = 0.0) -> dict:
    """{bone: ((x, y, z), quat)} in component space; each bone with one child points its local +X at it."""
    turn = pm.quat_axis_angle((0.0, 0.0, 1.0), yaw)
    points = {bone: pm.rotate(turn, (forward, -left, up))
              for bone, (left, forward, up) in _body_points(arm_out, elbow, feet_up, fingers, curl).items()}
    tree = parents(fingers)
    found = {}
    for bone, location in points.items():
        children = [child for child, parent in tree.items() if parent == bone]
        rotation = pm.quat_between((1.0, 0.0, 0.0), pm.sub(points[children[0]], location)) if len(children) == 1 else turn
        found[bone] = (location, rotation)
    return found


def _quad(around: tuple, size: float) -> list:
    x, y, z = around
    return [(x, y - size, z + size), (x, y + size, z + size), (x, y - size, z - size), (x, y + size, z - size)]


def character(path: str, bind: dict | None = None, strip: bool = False, fingers: bool = False) -> unreal.SkeletalMesh:
    """A stub SkeletalMesh bound in `bind` (an A-pose by default, as auto-riggers bind): a skin patch on the hips
    and one on the left forearm; with `strip`, the hip patch's lower edge is weighted to the left hand."""
    reference = bind or pose(arm_out=55.0, elbow=100.0, fingers=fingers)
    mesh = unreal.SkeletalMesh(path, unreal.Vector(30.0, 15.0, 90.0), parents(fingers), chains=chains(fingers),
                               root=ROOT, reference=reference)
    hips = _quad(pm.add(reference['Hips'][0], (12.0, 0.0, -10.0)), 6.0)
    sleeve = _quad(reference['LeftForeArm'][0], 3.0)
    mesh.vertices = hips + sleeve
    mesh.triangles = [(0, 1, 2), (1, 3, 2), (4, 5, 6), (5, 7, 6)]
    lower = 'LeftHand' if strip else 'Hips'
    mesh.weights = [[('Hips', 1.0)], [('Hips', 1.0)], [(lower, 1.0)], [(lower, 1.0)]] + [[('LeftForeArm', 1.0)]] * 4
    unreal.state['loaded'][path] = mesh
    return mesh


def clip(path: str, mesh: unreal.SkeletalMesh, at, seconds: float = 1.0) -> unreal.AnimSequence:
    """A clip on the mesh's skeleton whose pose at t seconds is at(t)."""
    made = unreal.AnimSequence(path, seconds, mesh.skeleton, at)
    unreal.state['loaded'][path] = made
    unreal.state['registry'].append(unreal.AssetData(path, 'AnimSequence', asset=made))
    return made
