//! Queries (CONTRACT.md §13): ray, shape cast and overlap, their filter and results, and the JSON
//! form a query shares with the conformance vectors.

use serde_json::Value;

use crate::body::{Groups, Shape};
use crate::error::PhysicsFailure;
use crate::types::{Pose, Vec3};

/// The most bodies one filter may exclude.
pub const EXCLUDE_BODIES_MAX: usize = 64;

/// Which colliders a query sees (§13); the default sees every solid collider.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct QueryFilter {
    /// Only colliders these groups interact with (§6.2's rule); default all.
    pub groups: Option<Groups>,
    /// Bodies the query ignores, at most [`EXCLUDE_BODIES_MAX`]; static keys allowed.
    pub exclude_bodies: Vec<String>,
    /// Sensors are hit too; default false.
    pub include_sensors: bool,
}

/// A ray or shape-cast hit (§13), in the caller frame.
#[derive(Clone, Debug, PartialEq)]
pub struct Hit {
    /// The body hit (a `static:` key for a static piece).
    pub body: String,
    /// Its collider.
    pub collider: String,
    /// The distance along the normalised direction, caller units.
    pub dist: f64,
    /// The point hit, on the hit collider's surface.
    pub point: Vec3,
    /// The hit collider's outward normal there.
    pub normal: Vec3,
}

/// A query as a value: what [`crate::World::query`] runs and the JSON form reads (§13).
#[derive(Clone, Debug, PartialEq)]
pub enum Query {
    /// The nearest hit along a ray.
    Ray {
        /// Where the ray starts.
        origin: Vec3,
        /// Its direction; need not be normalised, never zero.
        dir: Vec3,
        /// How far it reaches, caller units.
        max_dist: f64,
        /// Which colliders it sees.
        filter: QueryFilter,
    },
    /// The first hit of a swept shape (box, sphere, capsule or hull).
    ShapeCast {
        /// The shape swept.
        shape: Shape,
        /// Its starting pose.
        pose: Pose,
        /// The sweep's direction; need not be normalised, never zero.
        dir: Vec3,
        /// How far it sweeps, caller units.
        max_dist: f64,
        /// Which colliders it sees.
        filter: QueryFilter,
    },
    /// Every body a shape overlaps.
    Overlap {
        /// The shape (box, sphere, capsule or hull).
        shape: Shape,
        /// Its pose.
        pose: Pose,
        /// Which colliders it sees.
        filter: QueryFilter,
    },
}

impl Query {
    /// Reads a query in its JSON form (§13); a malformed one gives `BadCommand`.
    pub fn from_json(value: &Value) -> Result<Query, PhysicsFailure> {
        crate::json::query(value)
    }
}

/// One query's outcome in a `query_many` (§19.2): its answer or its refusal, as `query` gives it.
pub type QueryOutcome = Result<QueryAnswer, PhysicsFailure>;

/// A query's answer: a hit or none for a ray or shape cast, body keys for an overlap.
#[derive(Clone, Debug, PartialEq)]
pub enum QueryAnswer {
    /// The nearest hit, if any.
    Hit(Option<Hit>),
    /// The bodies overlapped, in key order, each once.
    Keys(Vec<String>),
}
