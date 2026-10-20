//! Two-bone and aim IK, ported from ozz-animation 0.17.0's `IKTwoBoneJob` and `IKAimJob` (MIT,
//! Copyright (c) 2020 Guillaume Blanc; altered: AoS glam scalar, half-angle quaternions instead of
//! `acos`, and a look-at chain that splits the turn by share).
//!
//! - [`solve_two_bone`] bends a start-mid-end chain (hip-knee-ankle, shoulder-elbow-wrist) so the
//!   end reaches a target: the law of cosines gives the mid joint's angle, the start joint turns
//!   the chain onto the target, and a turn about the start-to-target axis puts the mid joint
//!   toward the pole. Past a share of the chain's length (`soften`) the target is pulled in
//!   smoothly, so the knee never snaps straight as the target crosses full reach.
//! - [`solve_aim`] turns one joint so its forward axis (from an offset point, such as the eyes)
//!   passes through a target, its up axis kept toward a pole.
//! - [`apply_look_at`] aims a chain base first (spine, neck, head): each joint takes its share of
//!   the turn that remains, and the last takes all of it, so the head ends on the target.
//!
//! Corrections are local rotations, post-multiplied (`local.rotation × correction`), as ozz
//! applies them. Angles come from half-angle formulas over `sqrt`, never `acos`, so the solve
//! gives the same bits on every destination (glam's libm covers the twist and limits). Every
//! degenerate case, the ones ozz 0.17 fixed among them (a pole along the target line, a target on
//! the start joint, zero-length bones, non-finite input), solves to no correction rather than a
//! NaN. Weight 0 changes nothing, bit for bit.

use glam::{Mat4, Quat, Vec3, Vec4};

use crate::ids::JointId;
use crate::math::{Trs, normalize_quat, same_hemisphere};
use crate::skeleton::{MAX_JOINTS, Skeleton};

/// The share of a chain's length past which [`TwoBoneIk::new`] softens the target.
pub const DEFAULT_SOFTEN: f32 = 0.97;

/// A solved length within this share of the chain's length of the target's counts as reached.
pub const REACH_TOLERANCE: f32 = 1e-4;

/// The sine of the largest angle by which a look-at still counts as on target (about 0.06°).
pub const LOOK_TOLERANCE: f32 = 1e-3;

/// The sine of the interior-angle supplement under which a chain counts as straight.
const BENT_SINE: f32 = 1e-4;

/// Below this a squared length is zero.
const TINY: f32 = 1e-12;

/// The softening curve's order: `1 - (k / (r + k))^k` rises with slope 1 at 0 and never reaches 1.
const SOFTEN_ORDER: f32 = 4.0;

/// A start-mid-end chain of joints and the axis its mid joint bends about.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TwoBoneChain {
    /// The start joint (hip, shoulder).
    pub start: JointId,
    /// The mid joint (knee, elbow): a descendant of `start`.
    pub mid: JointId,
    /// The end joint (ankle, wrist): a descendant of `mid`.
    pub end: JointId,
    /// The axis the mid joint bends about, in its own local frame, used when the chain is
    /// straight; a bent chain bends in its own plane. The pole picks which way it bends.
    pub mid_axis: Vec3,
}

/// Where a two-bone chain should reach.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TwoBoneIk {
    /// The end joint's goal, model space.
    pub target: Vec3,
    /// The direction the mid joint should point, model space.
    pub pole: Vec3,
    /// How much of the correction to apply, `[0, 1]`; 0 (or NaN) changes nothing.
    pub weight: f32,
    /// The share of the chain's length past which the target is softened, `[0, 1]`; 1 is none.
    pub soften: f32,
    /// A turn about the start-to-target axis, radians.
    pub twist: f32,
}

impl TwoBoneIk {
    /// Reach `target` with the mid joint toward `pole`: full weight, [`DEFAULT_SOFTEN`], no twist.
    pub const fn new(target: Vec3, pole: Vec3) -> TwoBoneIk {
        TwoBoneIk { target, pole, weight: 1.0, soften: DEFAULT_SOFTEN, twist: 0.0 }
    }
}

/// A two-bone solve: the local corrections of the start and mid joints.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TwoBoneCorrection {
    /// Post-multiplied onto the start joint's local rotation.
    pub start: Quat,
    /// Post-multiplied onto the mid joint's local rotation.
    pub mid: Quat,
    /// The target lies within the chain's reach and was not softened.
    pub reached: bool,
}

impl TwoBoneCorrection {
    /// No correction.
    pub const NONE: TwoBoneCorrection = TwoBoneCorrection { start: Quat::IDENTITY, mid: Quat::IDENTITY, reached: false };
}

/// What one joint should aim at.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AimIk {
    /// The point to aim at, model space.
    pub target: Vec3,
    /// The joint's forward axis, its local frame.
    pub forward: Vec3,
    /// The joint's up axis, its local frame.
    pub up: Vec3,
    /// Where the forward ray starts, its local frame (the eyes for a head).
    pub offset: Vec3,
    /// The direction up should lean toward, model space.
    pub pole: Vec3,
    /// How much of the correction to apply, `[0, 1]`.
    pub weight: f32,
    /// A turn about the joint-to-target axis, radians.
    pub twist: f32,
}

/// An aim solve: the joint's local correction.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AimCorrection {
    /// Post-multiplied onto the joint's local rotation.
    pub rotation: Quat,
    /// The forward ray can pass through the target (it lies outside the offset's reach).
    pub reached: bool,
}

impl AimCorrection {
    /// No correction.
    pub const NONE: AimCorrection = AimCorrection { rotation: Quat::IDENTITY, reached: false };
}

/// One joint of a look-at chain.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AimJoint {
    /// The joint.
    pub joint: JointId,
    /// Its share of the turn (head 0.5, neck 0.3, spine 0.2); shares need not sum to 1.
    pub share: f32,
    /// The most it may turn, radians.
    pub limit: f32,
}

/// What a look-at chain should look at. `forward`, `up` and `offset` are in the last joint's
/// (the head's) local frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LookAt {
    /// The point to look at, model space.
    pub target: Vec3,
    /// The head's forward axis.
    pub forward: Vec3,
    /// The head's up axis.
    pub up: Vec3,
    /// The eyes, from the head joint.
    pub offset: Vec3,
    /// The direction up should lean toward, model space.
    pub pole: Vec3,
    /// How much of the look to apply, `[0, 1]`.
    pub weight: f32,
}

/// A weight in `[0, 1]`; NaN is 0.
fn unit_weight(weight: f32) -> f32 {
    if weight.is_nan() { 0.0 } else { weight.clamp(0.0, 1.0) }
}

/// The rotation by `acos(cos)` about the unit `axis`, from half-angle formulas.
fn half_angle(axis: Vec3, cos: f32) -> Quat {
    let cos = cos.clamp(-1.0, 1.0);
    let sin_half = ((1.0 - cos) * 0.5).max(0.0).sqrt();
    let cos_half = ((1.0 + cos) * 0.5).max(0.0).sqrt();
    Quat::from_xyzw(axis.x * sin_half, axis.y * sin_half, axis.z * sin_half, cos_half)
}

/// The shortest rotation taking direction `from` onto direction `to`; none when either is zero.
fn arc(from: Vec3, to: Vec3) -> Quat {
    let (from, to) = (from.normalize_or_zero(), to.normalize_or_zero());
    if from == Vec3::ZERO || to == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    Quat::from_rotation_arc(from, to)
}

/// The rotation about `axis` that takes `from`'s part across the axis onto `to`'s; none when the
/// axis or either part is zero (ozz 0.17's NaN fix: a pole along the axis leaves no plane).
fn plane_rotation(axis: Vec3, from: Vec3, to: Vec3) -> Quat {
    let axis = axis.normalize_or_zero();
    let from = (from - axis * axis.dot(from)).normalize_or_zero();
    let to = (to - axis * axis.dot(to)).normalize_or_zero();
    if axis == Vec3::ZERO || from == Vec3::ZERO || to == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    let side = if from.cross(to).dot(axis) < 0.0 { -axis } else { axis };
    half_angle(side, from.dot(to))
}

/// A turn of `angle` radians about `axis`; none when either is zero or not finite.
fn twist(axis: Vec3, angle: f32) -> Quat {
    let axis = axis.normalize_or_zero();
    if !angle.is_finite() || angle == 0.0 || axis == Vec3::ZERO {
        return Quat::IDENTITY;
    }
    Quat::from_axis_angle(axis, angle)
}

/// `rotation` at `weight`: nlerp from the identity the short way (ozz's weight blend).
fn weighted(rotation: Quat, weight: f32) -> Quat {
    if weight >= 1.0 {
        return rotation;
    }
    let rotation = same_hemisphere(rotation, Quat::IDENTITY);
    normalize_quat(Quat::from_vec4(Vec4::W.lerp(Vec4::from(rotation), weight)))
}

/// `rotation` turned at most `limit` radians about its own axis.
fn limited(rotation: Quat, limit: f32) -> Quat {
    if !limit.is_finite() || limit >= core::f32::consts::PI {
        return rotation;
    }
    let rotation = same_hemisphere(rotation, Quat::IDENTITY);
    let most = Quat::from_axis_angle(Vec3::X, limit.max(0.0)).w;
    if rotation.w >= most {
        return rotation;
    }
    let axis = rotation.xyz().normalize_or_zero();
    if axis == Vec3::ZERO { Quat::IDENTITY } else { Quat::from_axis_angle(axis, limit.max(0.0)) }
}

/// The length a target `distance` from the start joint is solved at, and whether it is reached:
/// past `soften × (l0 + l1)` it is pulled in along `1 - (k / (r + k))^k`, which leaves the
/// unsoftened length with slope 1 and never reaches the full chain.
fn soften(distance: f32, l0: f32, l1: f32, soften: f32) -> (f32, bool) {
    let chain = l0 + l1;
    let soften = if soften.is_finite() { soften.clamp(0.0, 1.0) } else { 1.0 };
    let near = chain * soften;
    let far = chain - near;
    let solved = if distance > near && far * far > TINY {
        let ratio = (distance - near) / far;
        let k = SOFTEN_ORDER / (ratio + SOFTEN_ORDER);
        let k2 = k * k;
        near + far * (1.0 - k2 * k2)
    } else {
        distance
    };
    let tolerance = REACH_TOLERANCE * chain;
    let reached = solved >= (l0 - l1).abs() - tolerance && solved <= chain + tolerance && distance - solved <= tolerance;
    (solved, reached)
}

/// The axis a chain bends about, start space: across both bones. A bent chain bends about its
/// own plane's normal, `to_start × mid_end` (bevy_animation_graph infers the plane the same way),
/// so the knee keeps the hinge the animation gave it; a straight one about `mid_axis` made
/// across the bones. `None` when neither gives an axis.
fn bend_axis(to_start: Vec3, mid_end: Vec3, mid_axis: Vec3) -> Option<Vec3> {
    let normal = to_start.cross(mid_end);
    let bent = BENT_SINE * to_start.length() * mid_end.length();
    if normal.length_squared() > bent * bent {
        return Some(normal.normalize());
    }
    let along = mid_end.normalize_or_zero();
    let axis = if mid_axis.is_finite() { (mid_axis - along * along.dot(mid_axis)).normalize_or_zero() } else { Vec3::ZERO };
    (axis != Vec3::ZERO).then_some(axis)
}

/// The two local corrections that bend the chain at model matrices `start`, `mid` and `end`
/// onto `ik`'s target; see the module docs.
pub fn solve_two_bone(start: &Mat4, mid: &Mat4, end: &Mat4, mid_axis: Vec3, ik: &TwoBoneIk) -> TwoBoneCorrection {
    let weight = unit_weight(ik.weight);
    let (inv_start, inv_mid) = (start.inverse(), mid.inverse());
    let usable = weight > 0.0 && inv_start.is_finite() && inv_mid.is_finite() && ik.target.is_finite();
    if !usable {
        return TwoBoneCorrection::NONE;
    }
    let (start_ms, mid_ms, end_ms) = (start.w_axis.truncate(), mid.w_axis.truncate(), end.w_axis.truncate());
    let start_mid = inv_start.transform_vector3(mid_ms - start_ms);
    let mid_end = inv_start.transform_vector3(end_ms - mid_ms);
    let (l0, l1) = (start_mid.length(), mid_end.length());
    if l0 * l1 <= TINY {
        return TwoBoneCorrection::NONE;
    }
    let to_start = -start_mid;
    let Some(axis_start) = bend_axis(to_start, mid_end, inv_start.transform_vector3(mid.transform_vector3(mid_axis))) else {
        return TwoBoneCorrection::NONE;
    };
    let axis_mid = inv_mid.transform_vector3(start.transform_vector3(axis_start)).normalize_or_zero();
    let target = inv_start.transform_point3(ik.target);
    let distance = target.length();
    let (solved, reached) = soften(distance, l0, l1, ik.soften);

    // The mid joint: from the interior angle now to the one the law of cosines asks for, turning
    // about the bend axis (across both bones, so the turn changes the angle by exactly itself).
    let cos_now = to_start.dot(mid_end) / (l0 * l1);
    let cos_goal = (l0 * l0 + l1 * l1 - solved * solved) / (2.0 * l0 * l1);
    let mid_rotation = half_angle(axis_mid, cos_goal) * half_angle(axis_mid, cos_now).conjugate();

    // The start joint: turn the corrected chain onto the target, then about the target axis so
    // the mid joint points toward the pole, then the twist.
    let mid_end_local = inv_mid.transform_vector3(end_ms - mid_ms);
    let corrected_end = start_mid + inv_start.transform_vector3(mid.transform_vector3(mid_rotation * mid_end_local));
    let toward = if distance * distance > TINY { target * (solved / distance) } else { corrected_end };
    let aim = arc(corrected_end, toward);
    let pole = inv_start.transform_vector3(ik.pole);
    let plane = if pole.is_finite() { plane_rotation(toward, aim * axis_start, toward.cross(pole)) } else { Quat::IDENTITY };
    let start_rotation = twist(toward, ik.twist) * plane * aim;
    let corrected = TwoBoneCorrection { start: weighted(start_rotation, weight), mid: weighted(mid_rotation, weight), reached };
    if corrected.start.is_finite() && corrected.mid.is_finite() { corrected } else { TwoBoneCorrection::NONE }
}

/// `forward` moved so that the ray from `offset` along `forward` reaches `target`'s distance
/// where it would meet it once turned (ozz's `ComputeOffsettedForward`), and whether it can.
fn offset_forward(forward: Vec3, offset: Vec3, target: Vec3) -> (Vec3, bool) {
    if !offset.is_finite() || offset == Vec3::ZERO {
        return (forward, true);
    }
    let along = forward.dot(offset);
    let across = offset.length_squared() - along * along;
    let reach = target.length_squared();
    if across > reach {
        return (forward, false);
    }
    (offset + forward * ((reach - across).sqrt() - along), true)
}

/// The local correction that aims the joint at model matrix `joint`; see the module docs.
pub fn solve_aim(joint: &Mat4, ik: &AimIk) -> AimCorrection {
    let weight = unit_weight(ik.weight);
    let inverse = joint.inverse();
    let forward = ik.forward.normalize_or_zero();
    if weight <= 0.0 || !inverse.is_finite() || !ik.target.is_finite() || forward == Vec3::ZERO {
        return AimCorrection::NONE;
    }
    let target = inverse.transform_point3(ik.target);
    if target.length_squared() <= TINY {
        return AimCorrection::NONE;
    }
    let (aimed, reached) = offset_forward(forward, ik.offset, target);
    let aim = arc(aimed, target);
    let pole = inverse.transform_vector3(ik.pole);
    let plane = if pole.is_finite() && ik.up.is_finite() { plane_rotation(target, aim * ik.up, pole) } else { Quat::IDENTITY };
    let rotation = weighted(twist(target, ik.twist) * plane * aim, weight);
    if rotation.is_finite() { AimCorrection { rotation, reached } } else { AimCorrection::NONE }
}

/// `joint`'s index when it is in the skeleton, the pose and the model matrices.
fn index(skeleton: &Skeleton, joint: JointId, pose: &[Trs], model: &[Mat4]) -> Option<usize> {
    let index = usize::from(joint.raw());
    (index < skeleton.joint_count() && index < pose.len() && index < model.len()).then_some(index)
}

/// `descendant` is `ancestor` or below it.
fn descends(skeleton: &Skeleton, descendant: JointId, ancestor: JointId) -> bool {
    let mut joint = Some(descendant);
    while let Some(current) = joint {
        if current == ancestor {
            return true;
        }
        joint = skeleton.parent(current);
    }
    false
}

/// Rewrite the model matrices of `root`'s descendants with index up to `through`, after `root`'s
/// own matrix changed. Parents come first, so one pass with a dirty bit per joint does it.
fn refresh(skeleton: &Skeleton, pose: &[Trs], model: &mut [Mat4], root: usize, through: usize) {
    let mut dirty = [0u64; MAX_JOINTS / 64];
    let mark = |dirty: &mut [u64], index: usize| dirty[index / 64] |= 1 << (index % 64);
    mark(&mut dirty, root);
    let last = through.min(MAX_JOINTS - 1).min(pose.len().saturating_sub(1)).min(model.len().saturating_sub(1));
    for index in root + 1..=last {
        let Some(parent) = skeleton.parent(JointId(index as u16)) else { continue };
        let parent = usize::from(parent.raw());
        if dirty[parent / 64] & (1 << (parent % 64)) != 0 {
            model[index] = model[parent] * pose[index].matrix();
            mark(&mut dirty, index);
        }
    }
}

/// Post-multiply `correction` onto joint `index`'s local rotation and its model matrix.
fn correct(pose: &mut [Trs], model: &mut [Mat4], index: usize, correction: Quat) {
    let frame = model[index] * pose[index].matrix().inverse();
    if !frame.is_finite() {
        return;
    }
    pose[index].rotation = normalize_quat(pose[index].rotation * correction);
    model[index] = frame * pose[index].matrix();
}

/// Solve `chain` toward `ik` on `pose`, whose model matrices `model` must be current: the start
/// and mid joints' local rotations change, and the model matrices of the start joint and its
/// descendants up to the end joint are rewritten (later joints are left for the next
/// `local_to_model`). True when the target was reached. A chain that is not start above mid
/// above end in this skeleton, or weight 0, changes nothing.
pub fn apply_two_bone(skeleton: &Skeleton, chain: &TwoBoneChain, ik: &TwoBoneIk, pose: &mut [Trs], model: &mut [Mat4]) -> bool {
    if unit_weight(ik.weight) <= 0.0 {
        return false;
    }
    let indices = (index(skeleton, chain.start, pose, model), index(skeleton, chain.mid, pose, model), index(skeleton, chain.end, pose, model));
    let (Some(start), Some(mid), Some(end)) = indices else { return false };
    let ordered = chain.start != chain.mid && chain.mid != chain.end && descends(skeleton, chain.mid, chain.start) && descends(skeleton, chain.end, chain.mid);
    if !ordered {
        return false;
    }
    let solved = solve_two_bone(&model[start], &model[mid], &model[end], chain.mid_axis, ik);
    correct(pose, model, start, solved.start);
    pose[mid].rotation = normalize_quat(pose[mid].rotation * solved.mid);
    refresh(skeleton, pose, model, start, end);
    solved.reached
}

/// Aim `chain` (base first, each joint above the next) so the last joint's forward ray passes
/// through `look.target`; see the module docs. `model` must be current; the chain's local
/// rotations change, and the model matrices from the first joint down to the last are rewritten.
/// True when the last joint ends on target within [`LOOK_TOLERANCE`]. Weight 0, no positive
/// share, or a chain that is not a line down this skeleton changes nothing.
pub fn apply_look_at(skeleton: &Skeleton, chain: &[AimJoint], look: &LookAt, pose: &mut [Trs], model: &mut [Mat4]) -> bool {
    let weight = unit_weight(look.weight);
    let Some(head) = chain.last() else { return false };
    let Some(head_index) = index(skeleton, head.joint, pose, model) else { return false };
    let in_line = chain.windows(2).all(|pair| descends(skeleton, pair[1].joint, pair[0].joint)) && chain.iter().all(|aim| index(skeleton, aim.joint, pose, model).is_some());
    let share = |aim: &AimJoint| if aim.share.is_finite() { aim.share.max(0.0) } else { 0.0 };
    let mut remaining: f32 = chain.iter().map(share).sum();
    if weight <= 0.0 || !in_line || !look.target.is_finite() || remaining <= 0.0 {
        return false;
    }
    for aim in chain {
        let portion = (share(aim) / remaining).min(1.0);
        remaining -= share(aim);
        let joint_index = usize::from(aim.joint.raw());
        if portion <= 0.0 {
            continue;
        }
        let (head_model, inverse) = (model[head_index], model[joint_index].inverse());
        let ik = AimIk {
            target: look.target,
            forward: inverse.transform_vector3(head_model.transform_vector3(look.forward)),
            up: inverse.transform_vector3(head_model.transform_vector3(look.up)),
            offset: inverse.transform_point3(head_model.transform_point3(look.offset)),
            pole: look.pole,
            weight: weight * portion,
            twist: 0.0,
        };
        let solved = solve_aim(&model[joint_index], &ik);
        correct(pose, model, joint_index, limited(solved.rotation, aim.limit));
        refresh(skeleton, pose, model, joint_index, head_index);
    }
    let head_model = model[head_index];
    let ray = head_model.transform_vector3(look.forward).normalize_or_zero();
    let to_target = (look.target - head_model.transform_point3(look.offset)).normalize_or_zero();
    ray.dot(to_target) > 0.0 && ray.cross(to_target).length() <= LOOK_TOLERANCE
}
