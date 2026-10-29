//! Pose validation: does a character's rig and each of its clips keep a human body? A generated
//! rig with kit animations retargeted onto it can pass the importer and still fold the torso into
//! the legs, knot the arms or float above the floor; nothing else looks. [`PoseCheck`] samples
//! every clip on the rig's humanoid map and reports typed diagnostics ([`PoseCode`]) with the
//! worst frame, the measured value, its limit and a likely cause, so import code can fix, swap
//! clips or regenerate before the character reaches a game. All distances are measured against the
//! rig's own rest pose and leg length, so one set of limits fits a child, a robot and a giant.

use glam::{Mat4, Vec3};

use crate::clip::Clip;
use crate::clip_set::{ClipRole, ClipSet};
use crate::humanoid::{HumanoidBone, HumanoidMap};
use crate::ids::JointId;
use crate::math::Trs;
use crate::sample::{SampleCursor, Wrap, sample};
use crate::skeleton::Skeleton;

/// Frames sampled per second of a clip.
const SAMPLES_PER_SECOND: f32 = 20.0;
/// The fewest and most frames sampled from one clip.
const SAMPLES_MIN: usize = 8;
const SAMPLES_MAX: usize = 120;
/// Below this a rest length is zero and its ratio meaningless.
const TINY: f32 = 1e-5;

/// What a check found wrong.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum PoseCode {
    /// The rig lacks a humanoid bone the engine needs.
    BoneMissing,
    /// A clip drives a bone to a non-finite transform.
    ClipNonFinite,
    /// A limb is longer or shorter than the rig's rest pose.
    LimbStretch,
    /// The head comes too close to the hips: the torso folded into the legs.
    TorsoCollapse,
    /// An elbow folds shut, a hand sinks into the torso or the forearms cross.
    LimbsKnotted,
    /// The lowest foot hangs above the ground.
    FeetFloating,
    /// The lowest foot is below the ground.
    FeetSunk,
    /// The hands of a two-handed clip are too far apart to hold one weapon.
    HandsOffWeapon,
    /// No clip fills a role of the set.
    ClipRoleMissing,
}

impl PoseCode {
    /// Every code, in declaration order.
    pub const ALL: [PoseCode; 9] = [
        PoseCode::BoneMissing,
        PoseCode::ClipNonFinite,
        PoseCode::LimbStretch,
        PoseCode::TorsoCollapse,
        PoseCode::LimbsKnotted,
        PoseCode::FeetFloating,
        PoseCode::FeetSunk,
        PoseCode::HandsOffWeapon,
        PoseCode::ClipRoleMissing,
    ];

    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            PoseCode::BoneMissing => "bone-missing",
            PoseCode::ClipNonFinite => "clip-nonfinite",
            PoseCode::LimbStretch => "limb-stretch",
            PoseCode::TorsoCollapse => "torso-collapse",
            PoseCode::LimbsKnotted => "limbs-knotted",
            PoseCode::FeetFloating => "feet-floating",
            PoseCode::FeetSunk => "feet-sunk",
            PoseCode::HandsOffWeapon => "hands-off-weapon",
            PoseCode::ClipRoleMissing => "clip-role-missing",
        }
    }

    /// The most likely reason, for the code that says one.
    pub const fn cause(self) -> PoseCause {
        match self {
            PoseCode::BoneMissing | PoseCode::LimbStretch | PoseCode::FeetFloating | PoseCode::FeetSunk | PoseCode::ClipRoleMissing => PoseCause::BoneMismatch,
            PoseCode::TorsoCollapse | PoseCode::ClipNonFinite => PoseCause::BadRig,
            PoseCode::LimbsKnotted | PoseCode::HandsOffWeapon => PoseCause::WrongPose,
        }
    }
}

/// Where to look first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PoseCause {
    /// The generated rig itself is broken: regenerate it.
    BadRig,
    /// The rig was made in a pose its clips do not expect (A pose against T pose): re-pose, regenerate.
    WrongPose,
    /// The clip and the rig disagree about proportions or bones: retarget again or pick other clips.
    BoneMismatch,
}

impl PoseCause {
    /// The cause's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            PoseCause::BadRig => "bad-rig",
            PoseCause::WrongPose => "wrong-pose",
            PoseCause::BoneMismatch => "bone-mismatch",
        }
    }
}

/// One finding: the worst frame of one problem on one bone of one clip.
#[derive(Clone, Debug, PartialEq)]
pub struct PoseDiagnostic {
    /// What is wrong.
    pub code: PoseCode,
    /// The likely reason.
    pub cause: PoseCause,
    /// The clip's name; empty for a finding about the rig or a role.
    pub clip: String,
    /// The role the clip fills, when it fills one.
    pub role: Option<ClipRole>,
    /// The time of the worst frame, seconds.
    pub time: f32,
    /// The bone the problem is on.
    pub bone: Option<HumanoidBone>,
    /// What was measured (a ratio of the rest length, an angle in degrees, or a distance).
    pub value: f32,
    /// The limit it crossed, in the same unit.
    pub limit: f32,
}

/// How far a body may stray, as shares of the rest pose.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PoseLimits {
    /// A limb's length may differ from rest by this share.
    pub stretch: f32,
    /// The head-to-hips distance stays above this share of its rest length.
    pub torso_min: f32,
    /// An elbow stays open past this angle, degrees.
    pub elbow_min_degrees: f32,
    /// A hand stays this far from the spine, in shoulder widths.
    pub hand_from_spine: f32,
    /// Forearms stay this far apart in leg lengths, unless the clip holds a weapon with both hands.
    pub forearm_gap: f32,
    /// The lowest foot may float or sink by this share of the leg.
    pub foot_slack: f32,
    /// Two hands holding a weapon stay within this share of an arm's length of each other.
    pub grip_span: f32,
    /// A foot or grip problem counts once it holds on this share of frames.
    pub persist: f32,
}

impl Default for PoseLimits {
    fn default() -> PoseLimits {
        PoseLimits { stretch: 0.08, torso_min: 0.55, elbow_min_degrees: 25.0, hand_from_spine: 0.3, forearm_gap: 0.04, foot_slack: 0.12, grip_span: 1.0, persist: 0.3 }
    }
}

/// A character's clips checked: which clip fills each role and what is wrong.
#[derive(Clone, Debug, PartialEq)]
pub struct CharacterReport {
    /// The role mapping.
    pub set: ClipSet,
    /// Every finding, rig first.
    pub diagnostics: Vec<PoseDiagnostic>,
}

impl CharacterReport {
    /// Nothing is wrong.
    pub fn pass(&self) -> bool {
        self.diagnostics.is_empty()
    }
}

/// The two-bone limbs whose lengths a clip must keep: (start, end) per segment.
const LIMBS: [(HumanoidBone, HumanoidBone); 8] = [
    (HumanoidBone::LeftUpperArm, HumanoidBone::LeftLowerArm),
    (HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand),
    (HumanoidBone::RightUpperArm, HumanoidBone::RightLowerArm),
    (HumanoidBone::RightLowerArm, HumanoidBone::RightHand),
    (HumanoidBone::LeftUpperLeg, HumanoidBone::LeftLowerLeg),
    (HumanoidBone::LeftLowerLeg, HumanoidBone::LeftFoot),
    (HumanoidBone::RightUpperLeg, HumanoidBone::RightLowerLeg),
    (HumanoidBone::RightLowerLeg, HumanoidBone::RightFoot),
];

/// Bones a rig may lack: no foot-ball bone, no fifth spine bone.
const OPTIONAL: [HumanoidBone; 3] = [HumanoidBone::LeftToes, HumanoidBone::RightToes, HumanoidBone::UpperChest];

/// A skeleton's rest measurements, ready to check clips against.
pub struct PoseCheck<'a> {
    skeleton: &'a Skeleton,
    map: HumanoidMap,
    limits: PoseLimits,
    rest: Vec<Mat4>,
    leg: f32,
}

/// One problem seen in one frame, before the worst frame is picked.
struct Finding {
    code: PoseCode,
    bone: HumanoidBone,
    value: f32,
    limit: f32,
    excess: f32,
}

/// A problem across frames: its worst frame and how many frames showed it.
struct Tally {
    finding: Finding,
    time: f32,
    frames: usize,
}

impl<'a> PoseCheck<'a> {
    /// Measure `skeleton`'s rest pose under the limits [`PoseLimits::default`].
    pub fn new(skeleton: &'a Skeleton) -> PoseCheck<'a> {
        PoseCheck::with_limits(skeleton, PoseLimits::default())
    }

    /// Measure `skeleton`'s rest pose under `limits`.
    pub fn with_limits(skeleton: &'a Skeleton, limits: PoseLimits) -> PoseCheck<'a> {
        let map = HumanoidMap::of(skeleton);
        let mut rest = vec![Mat4::IDENTITY; skeleton.joint_count()];
        skeleton.local_to_model(skeleton.rest_pose(), &mut rest);
        let mut check = PoseCheck { skeleton, map, limits, rest, leg: 0.0 };
        let leg = check.rest_distance(HumanoidBone::LeftUpperLeg, HumanoidBone::LeftFoot).max(check.rest_distance(HumanoidBone::RightUpperLeg, HumanoidBone::RightFoot));
        check.leg = leg.max(TINY);
        check
    }

    /// The rig's humanoid map.
    pub fn map(&self) -> &HumanoidMap {
        &self.map
    }

    /// The rig itself: bones it lacks and a rest pose that already folds or knots.
    pub fn check_rig(&self) -> Vec<PoseDiagnostic> {
        let mut found: Vec<PoseDiagnostic> = self.map.missing().filter(|bone| !OPTIONAL.contains(bone)).map(|bone| diagnostic(Finding { code: PoseCode::BoneMissing, bone, value: 0.0, limit: 1.0, excess: 1.0 }, "", None, 0.0)).collect();
        if found.is_empty() {
            let findings = self.frame_findings(&self.rest, None);
            found.extend(findings.into_iter().map(|finding| diagnostic(finding, "", None, 0.0)));
        }
        found
    }

    /// One clip, as the role it fills (`None` checks it as a grounded one-handed clip).
    pub fn check_clip(&self, clip: &Clip, role: Option<ClipRole>) -> Vec<PoseDiagnostic> {
        let frames = ((clip.duration() * SAMPLES_PER_SECOND).ceil() as usize).clamp(SAMPLES_MIN, SAMPLES_MAX);
        let mut pose: Vec<Trs> = self.skeleton.rest_pose().to_vec();
        let mut model = vec![Mat4::IDENTITY; pose.len()];
        let mut cursor = SampleCursor::new();
        let mut tallies: Vec<Tally> = Vec::new();
        for frame in 0..frames {
            let time = clip.duration() * frame as f32 / (frames - 1) as f32;
            pose.copy_from_slice(self.skeleton.rest_pose());
            sample(clip, time, Wrap::Clamp, &mut cursor, &mut pose);
            self.skeleton.local_to_model(&pose, &mut model);
            let findings = if model.iter().all(|m| m.is_finite()) {
                self.frame_findings(&model, role)
            } else {
                vec![Finding { code: PoseCode::ClipNonFinite, bone: HumanoidBone::Hips, value: f32::NAN, limit: 0.0, excess: f32::MAX }]
            };
            for finding in findings {
                tally(&mut tallies, finding, time);
            }
        }
        let persist = (self.limits.persist * frames as f32).ceil() as usize;
        let persists = |code: PoseCode| matches!(code, PoseCode::FeetFloating | PoseCode::FeetSunk | PoseCode::HandsOffWeapon);
        tallies.into_iter().filter(|t| !persists(t.finding.code) || t.frames >= persist.max(1)).map(|t| diagnostic(t.finding, clip.name(), role, t.time)).collect()
    }

    /// The rig, then every clip under the role it fills, then each role no clip fills.
    pub fn check(&self, clips: &[Clip]) -> CharacterReport {
        let set = ClipSet::of(clips);
        let mut diagnostics = self.check_rig();
        for (index, clip) in clips.iter().enumerate() {
            diagnostics.extend(self.check_clip(clip, set.role_of(index)));
        }
        diagnostics.extend(set.missing().map(|role| PoseDiagnostic { code: PoseCode::ClipRoleMissing, cause: PoseCode::ClipRoleMissing.cause(), clip: String::new(), role: Some(role), time: 0.0, bone: None, value: 0.0, limit: 1.0 }));
        CharacterReport { set, diagnostics }
    }

    fn joint(&self, bone: HumanoidBone) -> Option<JointId> {
        self.map.joint(bone)
    }

    fn position(&self, model: &[Mat4], bone: HumanoidBone) -> Option<Vec3> {
        self.joint(bone).and_then(|joint| model.get(usize::from(joint.raw()))).map(|m| m.w_axis.truncate())
    }

    fn rest_distance(&self, a: HumanoidBone, b: HumanoidBone) -> f32 {
        match (self.position(&self.rest, a), self.position(&self.rest, b)) {
            (Some(a), Some(b)) => a.distance(b),
            _ => 0.0,
        }
    }

    /// Everything wrong in one frame's model matrices.
    fn frame_findings(&self, model: &[Mat4], role: Option<ClipRole>) -> Vec<Finding> {
        let mut found = Vec::new();
        self.limb_lengths(model, &mut found);
        self.torso(model, &mut found);
        self.arms(model, role, &mut found);
        if role.is_none_or(ClipRole::grounded) {
            self.feet(model, &mut found);
        }
        if role.is_some_and(ClipRole::two_handed) {
            self.grip(model, &mut found);
        }
        found
    }

    fn limb_lengths(&self, model: &[Mat4], found: &mut Vec<Finding>) {
        for (start, end) in LIMBS {
            let rest = self.rest_distance(start, end);
            let (Some(a), Some(b)) = (self.position(model, start), self.position(model, end)) else { continue };
            if rest < TINY {
                continue;
            }
            let ratio = a.distance(b) / rest;
            let off = (ratio - 1.0).abs();
            if off > self.limits.stretch {
                let limit = if ratio > 1.0 { 1.0 + self.limits.stretch } else { 1.0 - self.limits.stretch };
                found.push(Finding { code: PoseCode::LimbStretch, bone: end, value: ratio, limit, excess: off - self.limits.stretch });
            }
        }
    }

    fn torso(&self, model: &[Mat4], found: &mut Vec<Finding>) {
        let rest = self.rest_distance(HumanoidBone::Hips, HumanoidBone::Head);
        let (Some(hips), Some(head)) = (self.position(model, HumanoidBone::Hips), self.position(model, HumanoidBone::Head)) else { return };
        if rest < TINY {
            return;
        }
        let ratio = hips.distance(head) / rest;
        if ratio < self.limits.torso_min {
            found.push(Finding { code: PoseCode::TorsoCollapse, bone: HumanoidBone::Head, value: ratio, limit: self.limits.torso_min, excess: self.limits.torso_min - ratio });
        }
    }

    fn arms(&self, model: &[Mat4], role: Option<ClipRole>, found: &mut Vec<Finding>) {
        let sides = [
            (HumanoidBone::LeftUpperArm, HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand),
            (HumanoidBone::RightUpperArm, HumanoidBone::RightLowerArm, HumanoidBone::RightHand),
        ];
        let spine = self.position(model, HumanoidBone::Hips).zip(self.position(model, HumanoidBone::UpperChest).or_else(|| self.position(model, HumanoidBone::Chest)));
        let width = self.rest_distance(HumanoidBone::LeftUpperArm, HumanoidBone::RightUpperArm);
        for (upper, lower, hand) in sides {
            let (Some(s), Some(e), Some(h)) = (self.position(model, upper), self.position(model, lower), self.position(model, hand)) else { continue };
            let angle = (s - e).angle_between(h - e).to_degrees();
            if angle < self.limits.elbow_min_degrees {
                found.push(Finding { code: PoseCode::LimbsKnotted, bone: lower, value: angle, limit: self.limits.elbow_min_degrees, excess: self.limits.elbow_min_degrees - angle });
            }
            if let Some((hips, chest)) = spine.filter(|_| width > TINY) {
                let gap = distance_to_segment(h, hips, chest) / width;
                if gap < self.limits.hand_from_spine {
                    found.push(Finding { code: PoseCode::LimbsKnotted, bone: hand, value: gap, limit: self.limits.hand_from_spine, excess: self.limits.hand_from_spine - gap });
                }
            }
        }
        if role.is_some_and(ClipRole::two_handed) {
            return;
        }
        let forearm = |elbow, hand| self.position(model, elbow).zip(self.position(model, hand));
        if let (Some(left), Some(right)) = (forearm(HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand), forearm(HumanoidBone::RightLowerArm, HumanoidBone::RightHand)) {
            let gap = segment_distance(left, right) / self.leg;
            if gap < self.limits.forearm_gap {
                found.push(Finding { code: PoseCode::LimbsKnotted, bone: HumanoidBone::LeftHand, value: gap, limit: self.limits.forearm_gap, excess: self.limits.forearm_gap - gap });
            }
        }
    }

    fn feet(&self, model: &[Mat4], found: &mut Vec<Finding>) {
        let height = |m: &[Mat4]| {
            let left = self.position(m, HumanoidBone::LeftFoot)?.y;
            let right = self.position(m, HumanoidBone::RightFoot)?.y;
            Some(left.min(right))
        };
        let (Some(rest), Some(now)) = (height(&self.rest), height(model)) else { return };
        let off = (now - rest) / self.leg;
        let slack = self.limits.foot_slack;
        if off > slack {
            found.push(Finding { code: PoseCode::FeetFloating, bone: HumanoidBone::LeftFoot, value: off, limit: slack, excess: off - slack });
        } else if off < -slack {
            found.push(Finding { code: PoseCode::FeetSunk, bone: HumanoidBone::LeftFoot, value: off, limit: -slack, excess: -slack - off });
        }
    }

    fn grip(&self, model: &[Mat4], found: &mut Vec<Finding>) {
        let (Some(left), Some(right)) = (self.position(model, HumanoidBone::LeftHand), self.position(model, HumanoidBone::RightHand)) else { return };
        let arm = self.rest_distance(HumanoidBone::LeftUpperArm, HumanoidBone::LeftLowerArm) + self.rest_distance(HumanoidBone::LeftLowerArm, HumanoidBone::LeftHand);
        let limit = self.limits.grip_span * arm;
        let apart = left.distance(right);
        if apart > limit {
            found.push(Finding { code: PoseCode::HandsOffWeapon, bone: HumanoidBone::LeftHand, value: apart, limit, excess: apart - limit });
        }
    }
}

/// Keep the worst frame of each (code, bone).
fn tally(tallies: &mut Vec<Tally>, finding: Finding, time: f32) {
    match tallies.iter_mut().find(|t| t.finding.code == finding.code && t.finding.bone == finding.bone) {
        Some(known) => {
            known.frames += 1;
            if finding.excess > known.finding.excess {
                known.finding = finding;
                known.time = time;
            }
        }
        None => tallies.push(Tally { finding, time, frames: 1 }),
    }
}

fn diagnostic(finding: Finding, clip: &str, role: Option<ClipRole>, time: f32) -> PoseDiagnostic {
    PoseDiagnostic { code: finding.code, cause: finding.code.cause(), clip: clip.to_owned(), role, time, bone: Some(finding.bone), value: finding.value, limit: finding.limit }
}

/// The distance from `p` to the segment `a`-`b`.
fn distance_to_segment(p: Vec3, a: Vec3, b: Vec3) -> f32 {
    let ab = b - a;
    let along = if ab.length_squared() < TINY { 0.0 } else { ((p - a).dot(ab) / ab.length_squared()).clamp(0.0, 1.0) };
    p.distance(a + ab * along)
}

/// The shortest distance between two segments (Ericson, Real-Time Collision Detection, 5.1.9).
fn segment_distance(first: (Vec3, Vec3), second: (Vec3, Vec3)) -> f32 {
    let (p1, q1) = first;
    let (p2, q2) = second;
    let (d1, d2, r) = (q1 - p1, q2 - p2, p1 - p2);
    let (a, e, f) = (d1.dot(d1), d2.dot(d2), d2.dot(r));
    if a < TINY && e < TINY {
        return r.length();
    }
    if a < TINY {
        return distance_to_segment(p1, p2, q2);
    }
    if e < TINY {
        return distance_to_segment(p2, p1, q1);
    }
    let (b, c) = (d1.dot(d2), d1.dot(r));
    let denom = a * e - b * b;
    let mut s = if denom > TINY { ((b * f - c * e) / denom).clamp(0.0, 1.0) } else { 0.0 };
    let mut t = (b * s + f) / e;
    if t < 0.0 {
        t = 0.0;
        s = (-c / a).clamp(0.0, 1.0);
    } else if t > 1.0 {
        t = 1.0;
        s = ((b - c) / a).clamp(0.0, 1.0);
    }
    (p1 + d1 * s).distance(p2 + d2 * t)
}
