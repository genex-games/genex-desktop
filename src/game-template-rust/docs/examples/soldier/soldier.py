"""A rigged soldier for shooters, as one GLB for `blender__model` with `rig: true`: Quaternius'
Universal Animation Library mannequin (CC0) in combat clothes, a plate carrier with pouches, a
helmet and knee pads, holding the arms kit's AK-pattern rifle on a `weapon` bone, with the clips a
remote soldier plays.

Run it on the UAL's Godot GLB: `blender__model {name: "soldier", rig: true, model:
"assets/cc0/ual/AnimationLibrary_Godot_Standard.glb", inputs: "assets/src/fps_arms.py,<scans>"}`.
It imports the mannequin and its clips (`ASSET_INPUTS["model"]`) and the rifle and scan helpers
from `fps_arms.py`.

- Bones: the body's 22 are renamed to the humanoid names Genex reads (`hips`, `spine`, `chest`,
  `upper_chest`, `neck`, `head`, `left_shoulder` … `right_toes`), so a graph can mask the upper body
  and `plant_feet` finds the legs. The rifle hangs on `weapon` under `upper_chest`, with the arms
  kit's `magazine`, `charging_handle`, `trigger` and sockets (`muzzle`, `sight`, `eject`).
- Base clips (every bone but the aiming upper body): Idle, Walk, Run, Sprint, CrouchIdle,
  CrouchWalk and Death from the UAL; StrafeLeft and StrafeRight made from its walk with the hips
  turned toward the step and the spine and chest turned back, so the torso keeps facing ahead.
  Walking backwards is Walk played at a negative speed.
- Upper-body clips (`upper_chest` and below it): RifleLow, RifleAim, RifleAimUp and
  RifleAimDown (the aim tilted 30° up or down), RifleFire (0.1 s of kick, additive over RifleAim's
  first frame), RifleReload (2.4 s: the magazine out and a new one in). The hands are solved onto
  the rifle by IK here and baked in.
- Hit clips, additive over HitFront's first frame (the rest pose): HitFront, HitBack, HitLeft and
  HitRight, 0.4 s each.

Blender is +Z up and the mannequin faces -Y, so in the GLB (+Y up) the soldier faces +Z.
"""

import math

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Quaternion, Vector

import fps_arms

fps_arms.ASSET_INPUTS = ASSET_INPUTS
fps_arms.HIP = Vector()

# The UAL's Rigify deform bones and the humanoid names they take.
HUMANOID = {
    "DEF-hips": "hips",
    "DEF-spine.001": "spine",
    "DEF-spine.002": "chest",
    "DEF-spine.003": "upper_chest",
    "DEF-neck": "neck",
    "DEF-head": "head",
    "DEF-thigh.L": "left_upper_leg",
    "DEF-shin.L": "left_lower_leg",
    "DEF-foot.L": "left_foot",
    "DEF-toe.L": "left_toes",
    "DEF-thigh.R": "right_upper_leg",
    "DEF-shin.R": "right_lower_leg",
    "DEF-foot.R": "right_foot",
    "DEF-toe.R": "right_toes",
}
for side, letter in (("left", "L"), ("right", "R")):
    HUMANOID.update({f"DEF-shoulder.{letter}": f"{side}_shoulder", f"DEF-upper_arm.{letter}": f"{side}_upper_arm", f"DEF-forearm.{letter}": f"{side}_lower_arm", f"DEF-hand.{letter}": f"{side}_hand"})
# The UAL clips kept, under the names the game reads.
KEEP = {
    "Idle_Loop": "Idle",
    "Walk_Loop": "Walk",
    "Jog_Fwd_Loop": "Run",
    "Sprint_Loop": "Sprint",
    "Crouch_Idle_Loop": "CrouchIdle",
    "Crouch_Fwd_Loop": "CrouchWalk",
    "Death01": "Death",
}
ARMS = ("left", "right")

# The rifle shouldered at rest torso height: its origin (the bore above the trigger) and the
# pivot the aim tilts about. The rifle's own frame points along Blender -Y here (Rz 180°).
RIFLE_AT = Vector((-0.1, -0.26, 1.5))
AIM_PIVOT = Vector((-0.05, -0.05, 1.52))
AIM_PITCH = math.radians(30.0)
# How much of the aim's tilt the torso takes; the arms and head carry the rest.
TORSO_SHARE = 0.6
# The torso turned a little left of the rifle (the left shoulder forward), as a shooter stands.
BLADE = math.radians(-24.0)
# Where each hand holds the rifle, in the rifle's frame, and which way its fingers and palm face
# in the soldier's frame (+X is the soldier's left, -Y ahead).
GRIP = {"right": Vector((0.0, -0.065, -0.1)), "left": Vector((0.0, 0.12, -0.03))}
HAND_AIM = {"right": (Vector((0.35, -0.55, -0.7)), Vector((1.0, 0.0, 0.0))), "left": (Vector((-0.75, -0.55, 0.2)), Vector((0.0, 0.0, 1.0)))}
ELBOW_POLE = {"right": Vector((-0.45, 0.25, 1.05)), "left": Vector((0.45, -0.1, 1.05))}
FINGER_CURL = math.radians(55.0)
# How far a strafe turns the hips toward the step, and how much of it the spine and chest turn back.
STRAFE_TURN = math.radians(70.0)

# Each part of the outfit: its scan and tint (sRGB multipliers), and the tile it covers (m).
OUTFIT = {
    "shirt": ("book_pattern", (1.0, 1.0, 0.95), 0.25),
    "pants": ("book_pattern", (0.78, 0.8, 0.7), 0.25),
    "vest": ("leather_white", (0.5, 0.44, 0.33), 0.2),
    "helmet": ("leather_white", (0.36, 0.38, 0.29), 0.15),
    "face": ("book_pattern", (0.3, 0.3, 0.29), 0.15),
    "glove": ("leather_white", (0.33, 0.31, 0.26), 0.12),
    "boot": ("leather_white", (0.2, 0.16, 0.12), 0.12),
}
SCAN_FILES = {
    "book_pattern": fps_arms.poly_haven("book_pattern", "col1"),
    "leather_white": fps_arms.poly_haven("leather_white"),
}
OUTFIT_TEXELS = 1024
# Which part of the outfit a body vertex wears, by the bone that moves it most.
REGION = {
    "left_hand": "glove", "right_hand": "glove", "left_foot": "boot", "right_foot": "boot",
    "left_toes": "boot", "right_toes": "boot", "left_upper_leg": "pants", "right_upper_leg": "pants",
    "left_lower_leg": "pants", "right_lower_leg": "pants", "hips": "pants", "neck": "face", "head": "face",
}


# ── Import and rename ─────────────────────────────────────────────────────────────────────────


def import_mannequin():
    """The UAL's armature and mannequin, its unused clips and its preview sphere gone."""
    bpy.ops.import_scene.gltf(filepath=ASSET_INPUTS["model"])
    scene = bpy.context.scene
    for obj in [o for o in scene.objects if o.type == "MESH" and o.name != "Mannequin"]:
        bpy.data.objects.remove(obj)
    rig = next(o for o in scene.objects if o.type == "ARMATURE")
    body = next(o for o in scene.objects if o.type == "MESH")
    for bone in rig.data.bones:
        bone.name = HUMANOID.get(bone.name, bone.name)
    for group in body.vertex_groups:
        group.name = HUMANOID.get(group.name, group.name)
    data = rig.animation_data
    for track in list(data.nla_tracks):
        action = track.strips[0].action if track.strips else None
        if action is None or action.name not in KEEP:
            data.nla_tracks.remove(track)
            if action is not None:
                bpy.data.actions.remove(action)
            continue
        action.name = track.name = KEEP[action.name]
    data.action = None
    data.use_nla = False
    return rig, body


# ── The outfit ────────────────────────────────────────────────────────────────────────────────


def outfit_materials():
    """One material per part of the outfit, from its tinted scan (the made maps without one)."""
    made = {}
    for part, (scan, tint, _) in OUTFIT.items():
        files = SCAN_FILES[scan]
        colour = fps_arms.read_scan(files["color"])
        normal = fps_arms.read_scan(files["normal"])
        arm = fps_arms.read_scan(files["arm"])
        if colour is None:
            colour, normal, arm = fps_arms.MAKERS["sleeve" if scan == "book_pattern" else "glove"]()
        colour = fps_arms.fit(colour * np.array(tint), OUTFIT_TEXELS)
        normal = fps_arms.unit_normals(fps_arms.fit(normal, OUTFIT_TEXELS))
        arm = fps_arms.fit(arm, fps_arms.SURFACE_TEXELS)
        made[part] = fps_arms.material(part, fps_arms.save_map(f"{part}-color", colour, True), shared_map(f"{scan}-normal", normal), shared_map(f"{scan}-rm", arm))
    return made


def shared_map(name, field):
    """One image per scan for the maps tints leave alone, however many parts use it."""
    return bpy.data.images.get(name) or fps_arms.save_map(name, field, False)


def dominant_group(obj, vert):
    names = obj.vertex_groups
    best = max(vert.groups, key=lambda g: g.weight, default=None)
    return names[best.group].name if best is not None else ""


def dress_body(body, materials):
    """The mannequin's faces take the outfit part of the bone that moves them most, with
    world-scale UVs."""
    mesh = body.data
    mesh.materials.clear()
    parts = list(OUTFIT)
    for part in parts:
        mesh.materials.append(materials[part])
    regions = []
    for vert in mesh.vertices:
        name = dominant_group(body, vert)
        regions.append("glove" if name.startswith(("DEF-f_", "DEF-thumb")) else REGION.get(name, "shirt"))
    for poly in mesh.polygons:
        votes = [regions[i] for i in poly.vertices]
        poly.material_index = parts.index(max(set(votes), key=votes.count))
    bm = bmesh.new()
    bm.from_mesh(mesh)
    project_by_part(bm, bm.loops.layers.uv.active or bm.loops.layers.uv.new())
    bm.to_mesh(mesh)
    bm.free()


def project_by_part(bm, uv):
    """World-scale UVs on each part's faces at its own tile, through the arms kit's projection
    (which reads its UV layer from `fps_arms.UV`: borrowed here and given back)."""
    kit_uv, fps_arms.UV = fps_arms.UV, uv
    for index, part in enumerate(OUTFIT):
        fps_arms.project_uvs([f for f in bm.faces if f.material_index == index], OUTFIT[part][2], (0.0, 0.0))
    fps_arms.UV = kit_uv


def gear_part(bm, slot, weights, build, offset=0.008):
    """One piece of gear: built and bevelled on its own, then added to `bm` with its outfit part
    and its vertices weighted by `weights(co)`."""
    piece = bmesh.new()
    build(piece)
    if offset:
        fps_arms.bevel(piece, offset, segments=2)
    for face in piece.faces:
        face.material_index = list(OUTFIT).index(slot)
        face.smooth = True
    mesh = bpy.data.meshes.new("piece")
    piece.to_mesh(mesh)
    piece.free()
    first = len(bm.verts)
    bm.from_mesh(mesh)
    bpy.data.meshes.remove(mesh)
    bm.verts.ensure_lookup_table()
    deform = bm.verts.layers.deform.verify()
    for vert in bm.verts[first:]:
        for group, weight in weights(vert.co):
            vert[deform][group] = weight


def helmet_shell(bm, center):
    """A combat helmet: the top of a slightly long sphere cut above the brow, with a thick rim."""
    rings = []
    for i in range(7):
        polar = math.radians(8.0 + 82.0 * i / 6)
        ring = []
        for j in range(24):
            yaw = 2.0 * math.pi * j / 24
            ring.append(center + Vector((0.128 * math.sin(polar) * math.cos(yaw), 0.142 * math.sin(polar) * math.sin(yaw), 0.115 * math.cos(polar) - (0.012 if i == 6 else 0.0))))
        rings.append(ring)
    lip = [center + (v - center) * 1.06 - Vector((0.0, 0.0, 0.01)) for v in rings[-1]]
    inner = [center + (v - center) * 0.94 for v in rings[-1]]
    fps_arms.sweep_open(bm, rings + [lip, inner])


def build_gear(rig, materials):
    """Helmet, plate carrier, pouches, belt and knee pads, skinned to the bones they ride on."""
    groups = ["head", "upper_chest", "chest", "spine", "hips", "left_lower_leg", "right_lower_leg"]
    index = {name: i for i, name in enumerate(groups)}
    bm = bmesh.new()
    head = rig.data.bones["head"].head_local
    rigid = lambda bone: (lambda co: [(index[bone], 1.0)])

    def torso(co):
        up = fps_arms.smoothstep(1.2, 1.36, co.z)
        return [(index["upper_chest"], up), (index["chest"], 1.0 - up)]

    parts = list(OUTFIT)
    piece = lambda slot, weights, build: gear_part(bm, slot, weights, build, 0.0 if slot == "helmet" and build is helmet else 0.008)
    helmet = lambda b: helmet_shell(b, head + Vector((0.0, 0.01, 0.105)))

    piece("helmet", rigid("head"), helmet)
    piece("face", rigid("head"), lambda b: fps_arms.box(b, head + Vector((0.0, -0.105, 0.075)), (0.15, 0.025, 0.035)))
    for y, depth in ((-0.135, 0.035), (0.125, 0.03)):
        piece("vest", torso, lambda b, y=y, d=depth: fps_arms.box(b, Vector((0.0, y, 1.31)), (0.3, d, 0.3)))
    piece("vest", lambda co: [(index["chest"], 1.0)], lambda b: fps_arms.box(b, Vector((0.0, 0.0, 1.2)), (0.34, 0.27, 0.08)))
    for x in (-0.085, 0.0, 0.085):
        piece("vest", lambda co: [(index["chest"], 1.0)], lambda b, x=x: fps_arms.box(b, Vector((x, -0.17, 1.24)), (0.075, 0.05, 0.12)))
    piece("pants", rigid("hips"), lambda b: fps_arms.box(b, Vector((0.0, 0.0, 0.96)), (0.36, 0.26, 0.05)))
    piece("vest", rigid("hips"), lambda b: fps_arms.box(b, Vector((-0.16, -0.06, 0.93)), (0.06, 0.1, 0.12)))
    for side, x in (("left", 0.089), ("right", -0.089)):
        piece("helmet", rigid(f"{side}_lower_leg"), lambda b, x=x: fps_arms.box(b, Vector((x, -0.06, 0.5)), (0.1, 0.05, 0.11)))
    mesh = bpy.data.meshes.new("gear")
    bm.to_mesh(mesh)
    bm.free()
    gear = bpy.data.objects.new("gear", mesh)
    bpy.context.scene.collection.objects.link(gear)
    for part in parts:
        mesh.materials.append(materials[part])
    for name in groups:
        gear.vertex_groups.new(name=name)
    uv_bm = bmesh.new()
    uv_bm.from_mesh(mesh)
    project_by_part(uv_bm, uv_bm.loops.layers.uv.verify())
    uv_bm.to_mesh(mesh)
    uv_bm.free()
    return gear


def build_rifle(rig, materials):
    """The arms kit's rifle at its shouldered rest, skinned to the soldier's rifle bones."""
    fps_arms.receiver()
    fps_arms.barrel()
    fps_arms.furniture()
    fps_arms.moving_parts()
    mesh = bpy.data.meshes.new("rifle")
    fps_arms.KIT.transform(rifle_rest())
    fps_arms.KIT.to_mesh(mesh)
    for mat in materials:
        mesh.materials.append(mat)
    rifle = bpy.data.objects.new("rifle", mesh)
    bpy.context.scene.collection.objects.link(rifle)
    for name in fps_arms.GROUPS:
        rifle.vertex_groups.new(name=name)
    return rifle


def rifle_material(surface):
    """One of the arms kit's rifle surfaces, from its scans (or made maps)."""
    colour, normal, rough_metal = fps_arms.surface_maps(surface)
    return fps_arms.material(surface, fps_arms.save_map(f"{surface}-color", colour, True), fps_arms.save_map(f"{surface}-normal", normal, False), fps_arms.save_map(f"{surface}-rm", rough_metal, False))


def rifle_rest():
    return Matrix.Translation(RIFLE_AT) @ Matrix.Rotation(math.pi, 4, "Z")


# ── Rig ───────────────────────────────────────────────────────────────────────────────────────


def add_rifle_bones(rig):
    """The weapon and its parts, the hands' IK targets on it, and the elbows' poles."""
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    bones = rig.data.edit_bones
    rest = rifle_rest()

    def bone(name, at, parent, deform=True):
        b = bones.new(name)
        b.head = rest @ at
        b.tail = rest @ (at + Vector((0.0, 0.05, 0.0)))
        b.align_roll(rest.to_3x3() @ Vector((0.0, 0.0, 1.0)))
        b.parent = bones[parent]
        b.use_deform = deform
        return b

    bone("weapon", Vector(), "upper_chest")
    for name, at in (("magazine", fps_arms.MAG_TOP), ("charging_handle", fps_arms.HANDLE), ("trigger", fps_arms.TRIGGER_PIVOT)):
        bone(name, at, "weapon")
    for name, at in (("muzzle", fps_arms.MUZZLE), ("sight", fps_arms.SIGHT), ("eject", fps_arms.EJECT)):
        bone(name, at, "weapon", False)
    for side in ARMS:
        hand = bones[f"{side}_hand"]
        target = bones.new(f"ik_{side}_hand")
        target.head, target.tail, target.roll = hand.head.copy(), hand.tail.copy(), hand.roll
        target.parent = bones["weapon"]
        target.use_deform = False
        pole = bones.new(f"pole_{side}")
        pole.head, pole.tail = ELBOW_POLE[side], ELBOW_POLE[side] + Vector((0.0, 0.0, 0.05))
        pole.parent = bones["upper_chest"]
        pole.use_deform = False
    bpy.ops.object.mode_set(mode="OBJECT")
    for side in ARMS:
        fore = rig.pose.bones[f"{side}_lower_arm"]
        ik = fore.constraints.new("IK")
        ik.name = "IK"
        ik.target, ik.subtarget = rig, f"ik_{side}_hand"
        ik.pole_target, ik.pole_subtarget = rig, f"pole_{side}"
        ik.chain_count = 2
        turn = rig.pose.bones[f"{side}_hand"].constraints.new("COPY_ROTATION")
        turn.name = "Hold"
        turn.target, turn.subtarget = rig, f"ik_{side}_hand"
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"


def hold_hands(rig):
    """The IK targets moved from the hands' rest onto the rifle's grip and handguard."""
    rest = rifle_rest()
    for side in ARMS:
        hand = rig.data.bones[f"{side}_hand"]
        fingers, palm = HAND_AIM[side]
        frame = aligned(hand.matrix_local.to_3x3(), fingers, palm)
        target = frame.to_4x4()
        target.translation = rest @ GRIP[side] - frame @ (hand.tail_local - hand.head_local) * 0.35
        HOLD[side] = target


HOLD = {}


def aligned(rest, fingers, palm):
    """The rotation turning a hand from `rest` so its bone points along `fingers` and its palm
    (the side that faced down in the T-pose) along `palm`."""
    local_y = (rest @ Vector((0.0, 1.0, 0.0))).normalized()
    local_palm = Vector((0.0, 0.0, -1.0))
    local_palm = (local_palm - local_y * local_palm.dot(local_y)).normalized()
    want_y = fingers.normalized()
    want_palm = (palm - want_y * palm.dot(want_y)).normalized()
    source = Matrix((local_y, local_palm, local_y.cross(local_palm))).transposed()
    target = Matrix((want_y, want_palm, want_y.cross(want_palm))).transposed()
    return target @ source.inverted() @ rest


# ── Clips ─────────────────────────────────────────────────────────────────────────────────────


def world_turn(rig, bone, axis, angle):
    """A basis rotation that turns `bone` by `angle` about the armature axis `axis` at rest."""
    rest = rig.data.bones[bone].matrix_local.to_3x3()
    return (rest.inverted() @ Matrix.Rotation(angle, 3, axis) @ rest).to_quaternion()


def set_pose(rig, frame, posed):
    """Key every bone of `posed` ({bone: basis quaternion or (location, quaternion)}) at `frame`."""
    for name, value in posed.items():
        pb = rig.pose.bones[name]
        location, turn = value if isinstance(value, tuple) else (Vector(), value)
        pb.location, pb.rotation_quaternion = location, turn
        pb.keyframe_insert("location", frame=frame)
        pb.keyframe_insert("rotation_quaternion", frame=frame)


def key_weapon(rig, frame, matrix):
    """Key `weapon` at the armature-space `matrix`, after its parents are posed."""
    bpy.context.view_layer.update()
    pb = rig.pose.bones["weapon"]
    pb.matrix = matrix
    pb.keyframe_insert("location", frame=frame)
    pb.keyframe_insert("rotation_quaternion", frame=frame)


def new_clip(rig, name, ik):
    """A fresh action on the rig, with the arms' IK on or off for all of it."""
    action = bpy.data.actions.new(name)
    action.use_fake_user = True
    rig.animation_data.action = action
    for pb in rig.pose.bones:
        pb.location, pb.rotation_quaternion = Vector(), Quaternion()
        pb.keyframe_insert("location", frame=0)
        pb.keyframe_insert("rotation_quaternion", frame=0)
    key_ik(rig, ik)
    return action


def key_ik(rig, on):
    for side in ARMS:
        for bone, name in ((f"{side}_lower_arm", "IK"), (f"{side}_hand", "Hold")):
            con = rig.pose.bones[bone].constraints[name]
            con.influence = 1.0 if on else 0.0
            con.keyframe_insert("influence", frame=0)


def stash(rig, action):
    track = rig.animation_data.nla_tracks.new()
    track.name = action.name
    track.strips.new(action.name, 0, action)
    rig.animation_data.action = None


def torso(rig, pitch, blade=BLADE, breath=0.0):
    """The aiming upper body: turned by `blade` and tilted by `pitch` (up positive), with the
    head tipped onto the sight."""
    lateral = Vector((-1.0, 0.0, 0.0))
    return {
        "upper_chest": world_turn(rig, "upper_chest", lateral, pitch + breath) @ world_turn(rig, "upper_chest", Vector((0.0, 0.0, 1.0)), blade),
        "neck": world_turn(rig, "neck", Vector((0.0, 0.0, 1.0)), -blade * 0.6),
        "head": world_turn(rig, "head", Vector((0.0, 1.0, 0.0)), math.radians(-8.0)) @ world_turn(rig, "head", lateral, math.radians(-6.0)),
    } | fingers(rig)


def fingers(rig):
    """Every finger curled round a grip."""
    curled = {}
    for pb in rig.pose.bones:
        if pb.name.startswith(("DEF-f_", "DEF-thumb")):
            curled[pb.name] = Quaternion((1.0, 0.0, 0.0), FINGER_CURL * (0.6 if "thumb" in pb.name else 1.0))
    return curled


def aim_matrix(pitch, kick=0.0):
    """The rifle shouldered and tilted about the aim's pivot, pushed back by `kick` (m)."""
    tilt = Matrix.Translation(AIM_PIVOT) @ Matrix.Rotation(pitch, 4, Vector((-1.0, 0.0, 0.0))) @ Matrix.Translation(-AIM_PIVOT)
    return tilt @ Matrix.Translation(Vector((0.0, kick, kick * 0.2))) @ rifle_rest()


def hold_targets(rig, frame, weapon_matrix):
    """Key the hands' IK targets at their holds (in the rifle's frame they never move)."""
    for side in ARMS:
        pb = rig.pose.bones[f"ik_{side}_hand"]
        local = rifle_rest().inverted() @ HOLD[side]
        bpy.context.view_layer.update()
        pb.matrix = weapon_matrix @ local
        pb.keyframe_insert("location", frame=frame)
        pb.keyframe_insert("rotation_quaternion", frame=frame)


def aim_clip(rig, name, seconds, pose_at):
    """An upper-body clip: each frame `pose_at(t)` gives (bone poses, rifle matrix, extra bones)."""
    action = new_clip(rig, name, True)
    fps = bpy.context.scene.render.fps
    for frame in range(round(seconds * fps) + 1):
        posed, weapon, extra = pose_at(frame / fps)
        set_pose(rig, frame, posed)
        key_weapon(rig, frame, weapon)
        hold_targets(rig, frame, weapon)
        set_pose(rig, frame, extra)
    stash(rig, action)


def rifle_clips(rig):
    breath = lambda t, period: math.sin(2.0 * math.pi * t / period) * math.radians(0.6)
    aim_clip(rig, "RifleAim", 2.0, lambda t: (torso(rig, 0.0, breath=breath(t, 2.0)), aim_matrix(breath(t, 2.0)), {}))
    aim_clip(rig, "RifleAimUp", 1.0, lambda t: (torso(rig, AIM_PITCH * TORSO_SHARE), aim_matrix(AIM_PITCH), {}))
    aim_clip(rig, "RifleAimDown", 1.0, lambda t: (torso(rig, -AIM_PITCH * TORSO_SHARE), aim_matrix(-AIM_PITCH), {}))
    low = math.radians(-38.0)
    aim_clip(rig, "RifleLow", 2.0, lambda t: (torso(rig, math.radians(-8.0), blade=BLADE * 0.6, breath=breath(t, 2.0)), aim_matrix(low + breath(t, 2.0)), {}))

    def fire(t):
        kick = (t / 0.015 if t < 0.015 else math.exp(-(t - 0.015) / 0.025)) * (1.0 - fps_arms.between(t, 0.07, 0.1))
        carrier = fps_arms.between(t, 0.004, 0.03) * (1.0 - fps_arms.between(t, 0.04, 0.075))
        return torso(rig, math.radians(3.0) * kick), aim_matrix(math.radians(3.0) * kick, 0.03 * kick), {"charging_handle": (Vector((0.0, -fps_arms.CARRIER_TRAVEL * carrier, 0.0)), Quaternion())}

    aim_clip(rig, "RifleFire", 0.1, fire)

    def reload(t):
        lowered = fps_arms.between(t, 0.0, 0.35) * (1.0 - fps_arms.between(t, 2.0, 2.4))
        pose = torso(rig, math.radians(-12.0) * lowered)
        weapon = aim_matrix(math.radians(-25.0) * lowered) @ Matrix.Rotation(math.radians(35.0) * lowered, 4, "Y")
        out = fps_arms.between(t, 0.5, 0.7) * (1.0 - fps_arms.between(t, 1.5, 1.75))
        mag = (Vector((0.0, 0.03, -0.25)) * out, Quaternion((1.0, 0.0, 0.0), 0.35 * out))
        rack = fps_arms.between(t, 1.85, 1.95) * (1.0 - fps_arms.between(t, 1.97, 2.0))
        return pose, weapon, {"magazine": mag, "charging_handle": (Vector((0.0, -0.08 * rack, 0.0)), Quaternion())}

    aim_clip(rig, "RifleReload", 2.4, reload)


def hit_clips(rig):
    """Additive jolts over the rest pose: the torso thrown away from where the round came from."""
    fps = bpy.context.scene.render.fps
    lateral, ahead = Vector((1.0, 0.0, 0.0)), Vector((0.0, 1.0, 0.0))
    for name, axis, sign in (("HitFront", lateral, -1.0), ("HitBack", lateral, 1.0), ("HitLeft", ahead, -1.0), ("HitRight", ahead, 1.0)):
        action = new_clip(rig, name, False)
        for frame in range(round(0.4 * fps) + 1):
            t = frame / fps
            jolt = sign * math.radians(14.0) * (t / 0.06 if t < 0.06 else math.exp(-(t - 0.06) / 0.1)) * (1.0 - fps_arms.between(t, 0.3, 0.4))
            set_pose(rig, frame, {bone: world_turn(rig, bone, axis, jolt * share) for bone, share in (("spine", 0.3), ("chest", 0.35), ("upper_chest", 0.35), ("head", 0.4))})
        stash(rig, action)


def turned_keys(action, bone, turn):
    """Every rotation key of `bone` in `action` turned by `turn` (a basis rotation applied first)."""
    curves = sorted((c for c in fps_arms_curves(action) if c.data_path == f'pose.bones["{bone}"].rotation_quaternion'), key=lambda c: c.array_index)
    if len(curves) != 4:
        return
    frames = sorted({round(k.co.x) for c in curves for k in c.keyframe_points})
    values = {f: turn @ Quaternion([c.evaluate(f) for c in curves]) for f in frames}
    for c in curves:
        for key in c.keyframe_points:
            key.co.y = values[round(key.co.x)][c.array_index]
            key.handle_left.y = key.handle_right.y = key.co.y


def face_ahead(rig):
    """Each kept UAL clip turned at the hips so its chest faces ahead on average: the aiming upper
    body rides on the chest, and an idle that stands turned would point the rifle off to the side."""
    scene = bpy.context.scene
    rest = rig.data.bones["upper_chest"].matrix_local.to_3x3()
    for name in KEEP.values():
        if name == "Death":
            continue
        action = bpy.data.actions[name]
        rig.animation_data.action = action
        start, end = (round(f) for f in action.frame_range)
        yaws = []
        for frame in range(start, end + 1):
            scene.frame_set(frame)
            ahead = rig.pose.bones["upper_chest"].matrix.to_3x3() @ rest.inverted() @ Vector((0.0, -1.0, 0.0))
            yaws.append(math.atan2(ahead.x, -ahead.y))
        mean = math.atan2(sum(math.sin(y) for y in yaws), sum(math.cos(y) for y in yaws))
        turned_keys(action, "hips", world_turn(rig, "hips", Vector((0.0, 0.0, 1.0)), -mean))
    rig.animation_data.action = None


def lay_rifle_down(rig):
    """In Death the rifle swings down along the body as the soldier falls, instead of standing up
    out of a chest that ends on its back."""
    action = bpy.data.actions["Death"]
    rig.animation_data.action = action
    pb = rig.pose.bones["weapon"]
    for frame, fallen in ((0, 0.0), (8, 0.0), (22, 1.0), (60, 1.0)):
        pb.location = Vector((0.0, -0.1, 0.0)) * fallen
        pb.rotation_quaternion = Quaternion((1.0, 0.0, 0.0), math.radians(100.0) * fallen) @ Quaternion((0.0, 1.0, 0.0), math.pi * fallen)
        pb.keyframe_insert("location", frame=frame)
        pb.keyframe_insert("rotation_quaternion", frame=frame)
    rig.animation_data.action = None
    pb.matrix_basis = Matrix()


def strafe_clips(rig):
    """The UAL walk with the hips turned toward the step and the spine and chest turned back."""
    walk = bpy.data.actions["Walk"]
    up = Vector((0.0, 0.0, 1.0))
    for name, sign in (("StrafeLeft", 1.0), ("StrafeRight", -1.0)):
        action = walk.copy()
        action.name = name
        action.use_fake_user = True
        for bone, angle in (("hips", sign * STRAFE_TURN), ("spine", -sign * STRAFE_TURN * 0.5), ("chest", -sign * STRAFE_TURN * 0.5)):
            turned_keys(action, bone, world_turn(rig, bone, up, angle))
        stash(rig, action)


def fps_arms_curves(action):
    """An action's curves (Blender 4.4+ keeps them in its layers' channel bags)."""
    legacy = getattr(action, "fcurves", None)
    if legacy is not None and len(legacy):
        return list(legacy)
    return [c for layer in action.layers for strip in layer.strips for bag in strip.channelbags for c in bag.fcurves]


def ik_off_in_imported(rig):
    """The UAL clips and the strafes play their own arms: the IK holds none of them."""
    for track in rig.animation_data.nla_tracks:
        if track.name.startswith(("Rifle", "Hit")):
            continue
        rig.animation_data.action = track.strips[0].action
        key_ik(rig, False)
    rig.animation_data.action = None


def build():
    rig, body = import_mannequin()
    materials = outfit_materials()
    rifle_materials = [rifle_material(surface) for surface in ("steel", "wood", "mag")]
    dress_body(body, materials)
    add_rifle_bones(rig)
    gear = build_gear(rig, materials)
    rifle = build_rifle(rig, rifle_materials)
    for obj in (gear, rifle):
        obj.parent = rig
        skin = obj.modifiers.new("skin", "ARMATURE")
        skin.object = rig
    hold_hands(rig)
    for side in ARMS:
        fore = rig.pose.bones[f"{side}_lower_arm"]
        fore.constraints["IK"].pole_angle = fps_arms_pole(rig, fore)
    face_ahead(rig)
    lay_rifle_down(rig)
    strafe_clips(rig)
    ik_off_in_imported(rig)
    rifle_clips(rig)
    hit_clips(rig)
    for pb in rig.pose.bones:
        pb.matrix_basis = Matrix()
    rig.animation_data.use_nla = True


def fps_arms_pole(rig, fore):
    """The pole angle that bends each elbow toward its pole (the arm's rest is a T-pose, so the
    angle is chosen with the hand on the rifle: the elbow nearest its pole wins)."""
    ik = fore.constraints["IK"]
    pole = rig.data.bones[ik.pole_subtarget].head_local
    target = rig.pose.bones[ik.subtarget]
    target.matrix = aim_matrix(0.0) @ rifle_rest().inverted() @ HOLD["left" if fore.name.startswith("left") else "right"]

    def error(angle):
        ik.pole_angle = angle
        bpy.context.view_layer.update()
        return (fore.head - pole).length

    best = min((math.radians(a) for a in range(-180, 180, 10)), key=error)
    target.matrix_basis = Matrix()
    return best


build()
