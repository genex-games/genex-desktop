//! The humanoid profile: the 22 bones a humanoid rig must have, named as Godot's
//! `SkeletonProfileHumanoid` names them (MIT), and one alias table per rig family that maps a
//! file's joint names onto them. `tests/fixtures/humanoid-aliases.json` is the same table for the
//! host's character facts; genex-anim's `tests/blend.rs` holds the two equal.
//!
//! A name matches a joint by its exact name first, then by the part after its last `:` or `|`
//! ignoring ASCII case ("mixamorig:LeftArm", "Armature|LeftArm" and "leftarm" all match
//! "LeftArm"). Each bone tries its aliases in order and never takes a joint an earlier bone took,
//! so one table covers a family's variants (UE4's three spine bones and UE5's five).

use crate::ids::JointId;
use crate::skeleton::Skeleton;

/// Bones the humanoid profile requires.
pub const HUMANOID_BONES: usize = 22;

/// A required humanoid bone, parents before children.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum HumanoidBone {
    /// The pelvis: the root of the humanoid.
    Hips,
    /// The lowest spine bone.
    Spine,
    /// The middle spine bone.
    Chest,
    /// The top spine bone, parent of the neck and shoulders.
    UpperChest,
    /// The neck.
    Neck,
    /// The head.
    Head,
    /// The left clavicle.
    LeftShoulder,
    /// The left upper arm.
    LeftUpperArm,
    /// The left forearm.
    LeftLowerArm,
    /// The left hand.
    LeftHand,
    /// The right clavicle.
    RightShoulder,
    /// The right upper arm.
    RightUpperArm,
    /// The right forearm.
    RightLowerArm,
    /// The right hand.
    RightHand,
    /// The left thigh.
    LeftUpperLeg,
    /// The left shin.
    LeftLowerLeg,
    /// The left foot.
    LeftFoot,
    /// The left toes (the ball of the foot).
    LeftToes,
    /// The right thigh.
    RightUpperLeg,
    /// The right shin.
    RightLowerLeg,
    /// The right foot.
    RightFoot,
    /// The right toes (the ball of the foot).
    RightToes,
}

impl HumanoidBone {
    /// Every bone, in profile order.
    pub const ALL: [HumanoidBone; HUMANOID_BONES] = [
        HumanoidBone::Hips,
        HumanoidBone::Spine,
        HumanoidBone::Chest,
        HumanoidBone::UpperChest,
        HumanoidBone::Neck,
        HumanoidBone::Head,
        HumanoidBone::LeftShoulder,
        HumanoidBone::LeftUpperArm,
        HumanoidBone::LeftLowerArm,
        HumanoidBone::LeftHand,
        HumanoidBone::RightShoulder,
        HumanoidBone::RightUpperArm,
        HumanoidBone::RightLowerArm,
        HumanoidBone::RightHand,
        HumanoidBone::LeftUpperLeg,
        HumanoidBone::LeftLowerLeg,
        HumanoidBone::LeftFoot,
        HumanoidBone::LeftToes,
        HumanoidBone::RightUpperLeg,
        HumanoidBone::RightLowerLeg,
        HumanoidBone::RightFoot,
        HumanoidBone::RightToes,
    ];

    /// The profile name (Godot's `SkeletonProfileHumanoid` spelling).
    pub const fn name(self) -> &'static str {
        match self {
            HumanoidBone::Hips => "Hips",
            HumanoidBone::Spine => "Spine",
            HumanoidBone::Chest => "Chest",
            HumanoidBone::UpperChest => "UpperChest",
            HumanoidBone::Neck => "Neck",
            HumanoidBone::Head => "Head",
            HumanoidBone::LeftShoulder => "LeftShoulder",
            HumanoidBone::LeftUpperArm => "LeftUpperArm",
            HumanoidBone::LeftLowerArm => "LeftLowerArm",
            HumanoidBone::LeftHand => "LeftHand",
            HumanoidBone::RightShoulder => "RightShoulder",
            HumanoidBone::RightUpperArm => "RightUpperArm",
            HumanoidBone::RightLowerArm => "RightLowerArm",
            HumanoidBone::RightHand => "RightHand",
            HumanoidBone::LeftUpperLeg => "LeftUpperLeg",
            HumanoidBone::LeftLowerLeg => "LeftLowerLeg",
            HumanoidBone::LeftFoot => "LeftFoot",
            HumanoidBone::LeftToes => "LeftToes",
            HumanoidBone::RightUpperLeg => "RightUpperLeg",
            HumanoidBone::RightLowerLeg => "RightLowerLeg",
            HumanoidBone::RightFoot => "RightFoot",
            HumanoidBone::RightToes => "RightToes",
        }
    }

    /// The bone's slot in [`HumanoidBone::ALL`].
    pub const fn index(self) -> usize {
        self as usize
    }
}

/// A rig family with its own joint names.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum RigProfile {
    /// The profile's own names (Godot, VRM and Unity humanoid spelling).
    Humanoid,
    /// Mixamo's auto-rigger (`mixamorig:` prefixes).
    Mixamo,
    /// Meshy's rigged characters.
    Meshy,
    /// Tripo's own rig spec.
    Tripo,
    /// Uthana's auto-rigged humanoids.
    Uthana,
    /// Unreal Engine's mannequin (UE4 and UE5), and Quaternius' Universal Animation Library,
    /// which ships that skeleton.
    UeMannequin,
}

impl RigProfile {
    /// The family's wire spelling (the alias JSON's `id`).
    pub const fn wire(self) -> &'static str {
        match self {
            RigProfile::Humanoid => "humanoid",
            RigProfile::Mixamo => "mixamorig",
            RigProfile::Meshy => "meshy",
            RigProfile::Tripo => "tripo",
            RigProfile::Uthana => "uthana",
            RigProfile::UeMannequin => "ue-mannequin",
        }
    }
}

/// One rig family's aliases: for each bone in [`HumanoidBone::ALL`] order, the names to try.
#[derive(Clone, Copy, Debug)]
pub struct ProfileAliases {
    /// The family.
    pub profile: RigProfile,
    /// The names to try per bone, first match wins.
    pub aliases: [&'static [&'static str]; HUMANOID_BONES],
}

/// Every family's aliases, in detection tie-break order.
pub const PROFILES: [ProfileAliases; 6] = [
    ProfileAliases {
        profile: RigProfile::Humanoid,
        aliases: [
            &["Hips"],
            &["Spine"],
            &["Chest"],
            &["UpperChest"],
            &["Neck"],
            &["Head"],
            &["LeftShoulder"],
            &["LeftUpperArm"],
            &["LeftLowerArm"],
            &["LeftHand"],
            &["RightShoulder"],
            &["RightUpperArm"],
            &["RightLowerArm"],
            &["RightHand"],
            &["LeftUpperLeg"],
            &["LeftLowerLeg"],
            &["LeftFoot"],
            &["LeftToes"],
            &["RightUpperLeg"],
            &["RightLowerLeg"],
            &["RightFoot"],
            &["RightToes"],
        ],
    },
    ProfileAliases {
        profile: RigProfile::Mixamo,
        aliases: [
            &["Hips"],
            &["Spine"],
            &["Spine1"],
            &["Spine2"],
            &["Neck"],
            &["Head"],
            &["LeftShoulder"],
            &["LeftArm"],
            &["LeftForeArm"],
            &["LeftHand"],
            &["RightShoulder"],
            &["RightArm"],
            &["RightForeArm"],
            &["RightHand"],
            &["LeftUpLeg"],
            &["LeftLeg"],
            &["LeftFoot"],
            &["LeftToeBase"],
            &["RightUpLeg"],
            &["RightLeg"],
            &["RightFoot"],
            &["RightToeBase"],
        ],
    },
    ProfileAliases {
        profile: RigProfile::Meshy,
        aliases: [
            &["Hips"],
            &["Spine"],
            &["Spine01"],
            &["Spine02"],
            &["neck"],
            &["Head"],
            &["LeftShoulder"],
            &["LeftArm"],
            &["LeftForeArm"],
            &["LeftHand"],
            &["RightShoulder"],
            &["RightArm"],
            &["RightForeArm"],
            &["RightHand"],
            &["LeftUpLeg"],
            &["LeftLeg"],
            &["LeftFoot"],
            &["LeftToeBase"],
            &["RightUpLeg"],
            &["RightLeg"],
            &["RightFoot"],
            &["RightToeBase"],
        ],
    },
    ProfileAliases {
        profile: RigProfile::Tripo,
        aliases: [
            &["Pelvis", "Hip"],
            &["Waist"],
            &["Spine01"],
            &["Spine02"],
            &["NeckTwist01", "Neck"],
            &["Head"],
            &["L_Clavicle"],
            &["L_Upperarm"],
            &["L_Forearm"],
            &["L_Hand"],
            &["R_Clavicle"],
            &["R_Upperarm"],
            &["R_Forearm"],
            &["R_Hand"],
            &["L_Thigh"],
            &["L_Calf"],
            &["L_Foot"],
            &["L_ToeBase"],
            &["R_Thigh"],
            &["R_Calf"],
            &["R_Foot"],
            &["R_ToeBase"],
        ],
    },
    ProfileAliases {
        profile: RigProfile::Uthana,
        aliases: [
            &["hips"],
            &["spine"],
            &["chest"],
            &["upper_chest"],
            &["neck"],
            &["head"],
            &["left_shoulder"],
            &["left_upper_arm"],
            &["left_lower_arm"],
            &["left_hand"],
            &["right_shoulder"],
            &["right_upper_arm"],
            &["right_lower_arm"],
            &["right_hand"],
            &["left_upper_leg"],
            &["left_lower_leg"],
            &["left_foot"],
            &["left_toes"],
            &["right_upper_leg"],
            &["right_lower_leg"],
            &["right_foot"],
            &["right_toes"],
        ],
    },
    ProfileAliases {
        profile: RigProfile::UeMannequin,
        aliases: [
            &["pelvis"],
            &["spine_01"],
            &["spine_02"],
            &["spine_05", "spine_03"],
            &["neck_01"],
            &["head"],
            &["clavicle_l"],
            &["upperarm_l"],
            &["lowerarm_l"],
            &["hand_l"],
            &["clavicle_r"],
            &["upperarm_r"],
            &["lowerarm_r"],
            &["hand_r"],
            &["thigh_l"],
            &["calf_l"],
            &["foot_l"],
            &["ball_l"],
            &["thigh_r"],
            &["calf_r"],
            &["foot_r"],
            &["ball_r"],
        ],
    },
];

/// A skeleton's humanoid bones: which joint each required bone is, under one rig family's names.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HumanoidMap {
    profile: RigProfile,
    joints: [Option<JointId>; HUMANOID_BONES],
}

impl HumanoidMap {
    /// The map under the family that maps the most bones; a tie goes to the earlier family in
    /// [`PROFILES`]. A skeleton with no humanoid bones gives an empty map.
    pub fn of(skeleton: &Skeleton) -> HumanoidMap {
        let mut best = HumanoidMap::with_aliases(skeleton, &PROFILES[0]);
        for aliases in &PROFILES[1..] {
            let candidate = HumanoidMap::with_aliases(skeleton, aliases);
            if candidate.mapped() > best.mapped() {
                best = candidate;
            }
        }
        best
    }

    /// The map under one family's names.
    pub fn with_profile(skeleton: &Skeleton, profile: RigProfile) -> HumanoidMap {
        let aliases = PROFILES.iter().find(|p| p.profile == profile).unwrap_or(&PROFILES[0]);
        HumanoidMap::with_aliases(skeleton, aliases)
    }

    fn with_aliases(skeleton: &Skeleton, aliases: &ProfileAliases) -> HumanoidMap {
        let mut joints = [None; HUMANOID_BONES];
        for (slot, names) in aliases.aliases.iter().enumerate() {
            joints[slot] = names.iter().find_map(|name| find_free(skeleton, name, &joints));
        }
        HumanoidMap { profile: aliases.profile, joints }
    }

    /// The family whose names this map used.
    pub fn profile(&self) -> RigProfile {
        self.profile
    }

    /// The joint a bone is, if the rig has it.
    pub fn joint(&self, bone: HumanoidBone) -> Option<JointId> {
        self.joints[bone.index()]
    }

    /// Bones the rig has.
    pub fn mapped(&self) -> usize {
        self.joints.iter().filter(|joint| joint.is_some()).count()
    }

    /// Every required bone is mapped.
    pub fn is_complete(&self) -> bool {
        self.mapped() == HUMANOID_BONES
    }

    /// The bones the rig lacks, in profile order.
    pub fn missing(&self) -> impl Iterator<Item = HumanoidBone> + '_ {
        HumanoidBone::ALL.into_iter().filter(|bone| self.joint(*bone).is_none())
    }
}

/// The joint `name` matches that no earlier bone took: the exact name first, then the short name
/// ignoring ASCII case.
fn find_free(skeleton: &Skeleton, name: &str, taken: &[Option<JointId>]) -> Option<JointId> {
    let free = |joint: &JointId| !taken.contains(&Some(*joint));
    let exact = skeleton.joints().filter(free).find(|joint| skeleton.name(*joint) == name);
    exact.or_else(|| skeleton.joints().filter(free).find(|joint| short_name(skeleton.name(*joint)).eq_ignore_ascii_case(name)))
}

/// The part of a joint name after its last `|` or `:` ("Armature|mixamorig:Hips" → "Hips").
fn short_name(name: &str) -> &str {
    name.rsplit(['|', ':']).next().unwrap_or(name)
}
