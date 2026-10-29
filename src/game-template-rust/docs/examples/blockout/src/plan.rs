//! A level plan as data: the zones a person plays in, what joins them, where they start, how they
//! leave and what holds them in. `docs/level-plan.md` says how to write one for any kind of game;
//! this one is a small building between two yards. Write your own in `docs/LEVEL.md` first, then
//! mirror it here, and build the greybox from it (`game.rs`).

use genex::prelude::*;

/// What joins two zones, or a zone to the way out: a planned opening, never a wall. Add the kinds
/// your plan needs (stairs, ramp, ladder, lift, jump) with the geometry that makes each walkable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkKind {
    /// An opening with a head over it, 2.1 m high.
    Door,
    /// An opening the wall's full height: an arch, a gap, a missing wall.
    Opening,
    /// A way through a fence or an outer wall.
    Gate,
}

impl LinkKind {
    /// The kind as `docs/LEVEL.md` writes it.
    pub fn name(self) -> &'static str {
        match self {
            LinkKind::Door => "door",
            LinkKind::Opening => "opening",
            LinkKind::Gate => "gate",
        }
    }
}

/// What holds the player in at the edge of the playable space, and reads as the place. Add the
/// kinds your place has (an outer wall, rubble, a cliff, water).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoundaryKind {
    Fence,
    /// A door that does not open, in a wall that stays solid behind it.
    LockedDoor,
    /// What stands past the fences, out of reach: the world goes on, the level does not.
    Backdrop,
}

impl BoundaryKind {
    /// How high it stands, in metres: above the character's jump (about 1.1 m) where it must hold.
    pub fn height(self) -> f32 {
        match self {
            BoundaryKind::Fence => 2.0,
            BoundaryKind::LockedDoor => 2.1,
            BoundaryKind::Backdrop => 12.0,
        }
    }

    /// Whether it is solid: a backdrop stands past the fences, out of reach, and only draws.
    pub fn solid(self) -> bool {
        self != BoundaryKind::Backdrop
    }
}

/// One zone: an id (lowercase letters, digits and `-`), what the player does there, and its floor
/// (x and z, metres) at height 0.
#[derive(Clone, Copy, Debug)]
pub struct Zone {
    pub id: &'static str,
    pub purpose: &'static str,
    pub min: Vec2,
    pub max: Vec2,
    pub indoors: bool,
}

impl Zone {
    /// The middle of its floor, where reachability is measured to.
    pub fn centre(&self) -> Vec2 {
        (self.min + self.max) * 0.5
    }

    /// Whether `at` (x and z) is on its floor.
    pub fn holds(&self, at: Vec2) -> bool {
        (self.min.x..=self.max.x).contains(&at.x) && (self.min.y..=self.max.y).contains(&at.y)
    }
}

/// A planned connection between two zones, centred `at` on the wall line they share.
#[derive(Clone, Copy, Debug)]
pub struct Link {
    pub from: &'static str,
    pub to: &'static str,
    pub kind: LinkKind,
    pub at: Vec2,
    pub width: f32,
}

/// Where the player leaves (or finishes): the point inside `zone` they walk to.
#[derive(Clone, Copy, Debug)]
pub struct Exit {
    pub zone: &'static str,
    pub kind: LinkKind,
    pub at: Vec2,
}

/// A stretch of the world's edge, from one point to another along a zone's side.
#[derive(Clone, Copy, Debug)]
pub struct Boundary {
    pub zone: &'static str,
    pub kind: BoundaryKind,
    pub from: Vec2,
    pub to: Vec2,
}

/// The whole plan: the greybox, the cameras and the `level` probe are all built from it.
#[derive(Clone, Copy, Debug)]
pub struct Plan {
    pub zones: &'static [Zone],
    pub links: &'static [Link],
    pub spawn: Vec2,
    pub exits: &'static [Exit],
    pub boundary: &'static [Boundary],
}

impl Plan {
    /// How many connections touch zone `id`: its ways in and out.
    pub fn links_of(&self, id: &str) -> usize {
        self.links.iter().filter(|link| link.from == id || link.to == id).count()
    }

    /// Whether zone `id` is a dead end the plan means: one with a boundary or an exit of its own
    /// (what closes its far side, or the way out), as `docs/LEVEL.md` marks one.
    pub fn planned_end(&self, id: &str) -> bool {
        self.boundary.iter().any(|edge| edge.zone == id) || self.exits.iter().any(|exit| exit.zone == id)
    }
}

// region: plan
/// A building between a front yard and a back yard: in at the front, out at the back gate.
pub const PLAN: Plan = Plan {
    zones: &[
        Zone { id: "front-yard", purpose: "arrive, see the building", min: vec2(-12.0, 10.0), max: vec2(12.0, 22.0), indoors: false },
        Zone { id: "lobby", purpose: "first room, two ways on", min: vec2(-6.0, 4.0), max: vec2(6.0, 10.0), indoors: true },
        Zone { id: "workshop", purpose: "fight among the benches", min: vec2(-12.0, 4.0), max: vec2(-6.0, 10.0), indoors: true },
        Zone { id: "office", purpose: "the key to the back door", min: vec2(6.0, 4.0), max: vec2(12.0, 10.0), indoors: true },
        Zone { id: "hall", purpose: "the spine every room opens on", min: vec2(-12.0, 1.0), max: vec2(12.0, 4.0), indoors: true },
        Zone { id: "back-yard", purpose: "the last stretch to the gate", min: vec2(-12.0, -10.0), max: vec2(12.0, 1.0), indoors: false },
    ],
    links: &[
        Link { from: "front-yard", to: "lobby", kind: LinkKind::Door, at: vec2(0.0, 10.0), width: 1.6 },
        Link { from: "lobby", to: "hall", kind: LinkKind::Opening, at: vec2(0.0, 4.0), width: 2.0 },
        Link { from: "lobby", to: "workshop", kind: LinkKind::Door, at: vec2(-6.0, 7.0), width: 1.2 },
        Link { from: "hall", to: "workshop", kind: LinkKind::Door, at: vec2(-9.0, 4.0), width: 1.2 },
        Link { from: "hall", to: "office", kind: LinkKind::Door, at: vec2(9.0, 4.0), width: 1.2 },
        Link { from: "hall", to: "back-yard", kind: LinkKind::Door, at: vec2(0.0, 1.0), width: 1.6 },
    ],
    spawn: vec2(0.0, 18.0),
    exits: &[Exit { zone: "back-yard", kind: LinkKind::Gate, at: vec2(0.0, -9.0) }],
    boundary: &[
        Boundary { zone: "front-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, 10.0), to: vec2(-12.0, 22.0) },
        Boundary { zone: "front-yard", kind: BoundaryKind::Fence, from: vec2(12.0, 10.0), to: vec2(12.0, 22.0) },
        Boundary { zone: "front-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, 22.0), to: vec2(12.0, 22.0) },
        Boundary { zone: "front-yard", kind: BoundaryKind::Backdrop, from: vec2(-30.0, 34.0), to: vec2(30.0, 34.0) },
        Boundary { zone: "hall", kind: BoundaryKind::LockedDoor, from: vec2(-12.0, 2.0), to: vec2(-12.0, 3.0) },
        Boundary { zone: "office", kind: BoundaryKind::LockedDoor, from: vec2(12.0, 6.5), to: vec2(12.0, 7.5) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, -10.0), to: vec2(-12.0, 1.0) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(12.0, -10.0), to: vec2(12.0, 1.0) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(-12.0, -10.0), to: vec2(-1.5, -10.0) },
        Boundary { zone: "back-yard", kind: BoundaryKind::Fence, from: vec2(1.5, -10.0), to: vec2(12.0, -10.0) },
    ],
};
// endregion
