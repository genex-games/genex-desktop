//! The clip set a playable character carries: nine roles (idle, walk, run, crouch, aim, fire,
//! reload, hit, death), each filled by the rig's own clip whose name says so. Import code maps a
//! file's clips onto the roles once, so a game asks for `ClipRole::Walk`, never for "Armature|
//! Walk_Rifle_01". A name matches a role by its aliases, the more specific roles first ("crouch
//! walk" is a crouch), ignoring ASCII case and any `Armature|` or `mixamo.com` prefix.

use crate::clip::Clip;

/// What a clip is for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum ClipRole {
    /// Standing still, breathing.
    Idle,
    /// Walking forward.
    Walk,
    /// Running or sprinting forward.
    Run,
    /// Crouched, still or moving.
    Crouch,
    /// Holding the weapon up to aim.
    Aim,
    /// One shot's recoil.
    Fire,
    /// Reloading.
    Reload,
    /// A flinch from a hit.
    Hit,
    /// Dying: the fall and the rest.
    Death,
}

/// How many roles there are.
pub const CLIP_ROLES: usize = 9;

impl ClipRole {
    /// Every role, in set order.
    pub const ALL: [ClipRole; CLIP_ROLES] = [
        ClipRole::Idle,
        ClipRole::Walk,
        ClipRole::Run,
        ClipRole::Crouch,
        ClipRole::Aim,
        ClipRole::Fire,
        ClipRole::Reload,
        ClipRole::Hit,
        ClipRole::Death,
    ];

    /// The role's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ClipRole::Idle => "idle",
            ClipRole::Walk => "walk",
            ClipRole::Run => "run",
            ClipRole::Crouch => "crouch",
            ClipRole::Aim => "aim",
            ClipRole::Fire => "fire",
            ClipRole::Reload => "reload",
            ClipRole::Hit => "hit",
            ClipRole::Death => "death",
        }
    }

    /// The clip plays in a loop.
    pub const fn looping(self) -> bool {
        matches!(self, ClipRole::Idle | ClipRole::Walk | ClipRole::Run | ClipRole::Crouch | ClipRole::Aim)
    }

    /// The feet stand on the ground for the whole clip (a hit or a death may leave it).
    pub const fn grounded(self) -> bool {
        !matches!(self, ClipRole::Hit | ClipRole::Death)
    }

    /// Both hands are on the weapon (a reload lets go of it for a moment).
    pub const fn two_handed(self) -> bool {
        matches!(self, ClipRole::Aim | ClipRole::Fire)
    }

    /// Names that say a clip is this role, lower case.
    const fn aliases(self) -> &'static [&'static str] {
        match self {
            ClipRole::Idle => &["idle", "stand", "breath"],
            ClipRole::Walk => &["walk"],
            ClipRole::Run => &["run", "sprint", "jog"],
            ClipRole::Crouch => &["crouch", "duck", "sneak"],
            ClipRole::Aim => &["aim"],
            ClipRole::Fire => &["fire", "shoot", "attack"],
            ClipRole::Reload => &["reload"],
            ClipRole::Hit => &["hit", "hurt", "damage", "impact"],
            ClipRole::Death => &["death", "die", "dead"],
        }
    }
}

/// The order roles claim clips in: specific before general, so "Crouch Walk" is a crouch and
/// "Aim Idle" an aim.
const CLAIM_ORDER: [ClipRole; CLIP_ROLES] = [
    ClipRole::Reload,
    ClipRole::Crouch,
    ClipRole::Death,
    ClipRole::Hit,
    ClipRole::Fire,
    ClipRole::Aim,
    ClipRole::Run,
    ClipRole::Walk,
    ClipRole::Idle,
];

/// Which clip fills each role.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ClipSet {
    clips: [Option<usize>; CLIP_ROLES],
}

impl ClipSet {
    /// Map `clips` onto the roles: each role takes the first clip whose name matches an alias (an
    /// exact short name beats a contained one), and a clip fills one role only.
    pub fn of(clips: &[Clip]) -> ClipSet {
        let names: Vec<String> = clips.iter().map(|clip| short_name(clip.name()).to_ascii_lowercase()).collect();
        let mut taken = vec![false; clips.len()];
        let mut set = ClipSet { clips: [None; CLIP_ROLES] };
        for role in CLAIM_ORDER {
            let free = |index: &usize| !taken[*index];
            let exact = (0..clips.len()).filter(free).find(|index| role.aliases().contains(&names[*index].as_str()));
            let found = exact.or_else(|| (0..clips.len()).filter(free).find(|index| role.aliases().iter().any(|alias| names[*index].contains(alias))));
            if let Some(index) = found {
                taken[index] = true;
                set.clips[role as usize] = Some(index);
            }
        }
        set
    }

    /// The index in the clip list given to [`ClipSet::of`] of the clip that fills `role`.
    pub fn clip(&self, role: ClipRole) -> Option<usize> {
        self.clips[role as usize]
    }

    /// The roles no clip fills, in set order.
    pub fn missing(&self) -> impl Iterator<Item = ClipRole> + '_ {
        ClipRole::ALL.into_iter().filter(|role| self.clip(*role).is_none())
    }

    /// The role a clip fills.
    pub fn role_of(&self, index: usize) -> Option<ClipRole> {
        ClipRole::ALL.into_iter().find(|role| self.clip(*role) == Some(index))
    }
}

/// The part of a clip name after its last `|` or `:` ("Armature|Walk" is "Walk").
fn short_name(name: &str) -> &str {
    name.rsplit(['|', ':']).next().unwrap_or(name)
}
