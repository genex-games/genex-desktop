//! What a world reports (CONTRACT.md §8, §9.1): step results, events and body states, in the caller
//! frame and key order.

use crate::types::{BodyType, Pose, Quat, Vec3};

/// A body's state in the caller frame (§9.1). Numbers are the f32 values the core holds.
#[derive(Clone, Debug, PartialEq)]
pub struct BodyState {
    /// The body's key.
    pub key: String,
    /// Its kind tag, if any.
    pub kind: Option<String>,
    /// Its type.
    pub body_type: BodyType,
    /// Its pose.
    pub pose: Pose,
    /// Linear velocity.
    pub linvel: Vec3,
    /// Angular velocity, rad/s.
    pub angvel: Vec3,
    /// Asleep. Fixed and escaped bodies always report true: neither is simulated.
    pub sleeping: bool,
}

/// Which bodies `bodies()` lists (§9.1); the default lists every body.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BodyFilter {
    /// Only bodies whose kind is one of these.
    pub kinds: Option<Vec<String>>,
    /// Only bodies that are awake.
    pub awake_only: bool,
    /// Only bodies changed after this tick.
    pub changed_since_tick: Option<u64>,
}

/// A contact or trigger event (§8.1).
#[derive(Clone, Debug, PartialEq)]
pub enum PhysicsEvent {
    /// A pair with an opted-in collider started touching.
    ContactBegin {
        /// The lower body key.
        a: String,
        /// The higher body key.
        b: String,
        /// `a`'s collider.
        ca: String,
        /// `b`'s collider.
        cb: String,
        /// `a`'s kind.
        ka: Option<String>,
        /// `b`'s kind.
        kb: Option<String>,
        /// The total normal impulse over the step.
        impulse: f64,
        /// The deepest contact point.
        point: Vec3,
        /// The normal, from a to b.
        normal: Vec3,
    },
    /// A pair with an opted-in collider stopped touching.
    ContactEnd {
        /// The lower body key.
        a: String,
        /// The higher body key.
        b: String,
        /// `a`'s collider.
        ca: String,
        /// `b`'s collider.
        cb: String,
        /// `a`'s kind.
        ka: Option<String>,
        /// `b`'s kind.
        kb: Option<String>,
    },
    /// A collider entered a sensor.
    TriggerEnter {
        /// The sensor's body.
        sensor: String,
        /// The sensor collider.
        sc: String,
        /// The other body.
        other: String,
        /// The other collider.
        oc: String,
        /// The sensor body's kind.
        ks: Option<String>,
        /// The other body's kind.
        ko: Option<String>,
    },
    /// A collider left a sensor.
    TriggerExit {
        /// The sensor's body.
        sensor: String,
        /// The sensor collider.
        sc: String,
        /// The other body.
        other: String,
        /// The other collider.
        oc: String,
        /// The sensor body's kind.
        ks: Option<String>,
        /// The other body's kind.
        ko: Option<String>,
    },
}

/// What one `step()` produced (§8).
#[derive(Clone, Debug, PartialEq)]
pub struct StepResult {
    /// The world's tick after this step.
    pub tick: u64,
    /// Events in §8.1's order.
    pub events: Vec<PhysicsEvent>,
    /// Events were dropped past `limits.eventsPerStep`.
    pub overflowed: bool,
    /// Bodies that escaped on this step, in key order (§8.2).
    pub escaped: Vec<String>,
    /// The world ended this step over `limits.memoryBytes` (§11.1).
    pub memory_exceeded: bool,
}

/// The replicated fields of a body (§9.2), as the f32 values the core holds, in the caller frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NetBodyState {
    /// Position.
    pub p: Vec3,
    /// Rotation `[x, y, z, w]`.
    pub q: Quat,
    /// Linear velocity.
    pub v: Vec3,
    /// Angular velocity, rad/s.
    pub w: Vec3,
    /// Asleep.
    pub sleeping: bool,
}

/// The numbers per body in [`ChangedExport::data`]: p(3), q(4), v(3), w(3), sleeping(1).
pub const EXPORT_STRIDE: usize = 14;

/// The flat per-tick read (§9.1): [`EXPORT_STRIDE`] numbers per body, in `keys` order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ChangedExport {
    /// The changed bodies, in key order.
    pub keys: Vec<String>,
    /// p(3), q(4), v(3), w(3) and sleeping (0 or 1) per body.
    pub data: Vec<f32>,
}

/// The world's counters (§11). `step_ms` is wall time for display only and in no hash.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Stats {
    /// The tick counter.
    pub tick: u64,
    /// Bodies of every type; static pieces excluded.
    pub bodies: usize,
    /// Bodies that are awake.
    pub awake: usize,
    /// The bodies' colliders; static pieces excluded.
    pub colliders: usize,
    /// Joints.
    pub joints: usize,
    /// Contact pairs the backend held at the end of the last step.
    pub contact_pairs: usize,
    /// Queries counted toward this step's `limits.queriesPerStep`.
    pub queries_this_step: u32,
    /// Wall time of the last `step()` as the binding recorded it (`World::record_step_ms`); 0 until then.
    pub step_ms: f64,
    /// The accounted memory (§11.1).
    pub memory_bytes: u64,
}
