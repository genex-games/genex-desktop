//! What a world reports (CONTRACT.md §8, §9.1): step results, events and body states, in the caller
//! frame and key order.

use crate::error::{PhysicsError, PhysicsFailure, fail};
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
    /// The sleep timer (contract 1.1 draft, §20.3): how long, in seconds, the body has been still
    /// enough to sleep. An export always gives it; an import without it (`None`) leaves the timer
    /// as waking or sleeping the body leaves it, exactly as 1.0 does.
    pub rest: Option<f64>,
}

/// The numbers per body in [`ChangedExport::data`]: p(3), q(4), v(3), w(3), sleeping(1).
pub const EXPORT_STRIDE: usize = 14;
/// The numbers per body in an export or import with the sleep timer (§20.3): the 14, then rest.
pub const EXPORT_STRIDE_REST: usize = 15;

/// Where `sleeping` sits in one body's [`EXPORT_STRIDE`] numbers.
const SLEEPING_SLOT: usize = EXPORT_STRIDE - 1;

impl NetBodyState {
    /// One body's numbers in [`ChangedExport::data`]'s layout (§9.1) as a network state (§19.1): the
    /// first [`EXPORT_STRIDE`] of `values`, each widened exactly; `sleeping` must be 0 or 1 and
    /// anything else (NaN included) is `BadCommand`, as a non-boolean is in the JSON form. The
    /// numbers are left for the import to judge (`NonFinite`, `OutOfRange`), so the codes match
    /// `importBodyState`'s.
    pub fn from_flat(values: &[f32]) -> Result<NetBodyState, PhysicsFailure> {
        let Some(values) = values.get(..EXPORT_STRIDE) else {
            return fail(PhysicsError::BadCommand, "a network state is 14 numbers");
        };
        let sleeping = match values[SLEEPING_SLOT] {
            0.0 => false,
            1.0 => true,
            _ => return fail(PhysicsError::BadCommand, "sleeping is 0 or 1"),
        };
        let v = |at: usize| f64::from(values[at]);
        Ok(NetBodyState {
            p: [v(0), v(1), v(2)],
            q: [v(3), v(4), v(5), v(6)],
            v: [v(7), v(8), v(9)],
            w: [v(10), v(11), v(12)],
            sleeping,
            rest: None,
        })
    }

    /// One body's numbers in the layout with the sleep timer (§20.3): the first
    /// [`EXPORT_STRIDE_REST`] of `values`, as [`NetBodyState::from_flat`] reads the first 14, then
    /// the timer.
    pub fn from_flat_rest(values: &[f32]) -> Result<NetBodyState, PhysicsFailure> {
        let Some(rest) = values.get(EXPORT_STRIDE) else {
            return fail(PhysicsError::BadCommand, "a network state with its timer is 15 numbers");
        };
        Ok(NetBodyState { rest: Some(f64::from(*rest)), ..Self::from_flat(values)? })
    }
}

/// What `canonicalize` does besides the rebuild (contract 1.1 draft, §20.1).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CanonicalizeOptions {
    /// Snap every simulated body onto its wire row first (§20.2).
    pub quantize: bool,
}

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
