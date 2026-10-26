//! A world's limits (CONTRACT.md §11): defaults, and the compile-time ceiling of 4x each default
//! that a caller may raise a limit up to.

use crate::canon::Canon;

/// The default `bodies`: every body type; static pieces excluded.
pub const DEFAULT_BODIES: u32 = 512;
/// The default `collidersPerBody`.
pub const DEFAULT_COLLIDERS_PER_BODY: u32 = 8;
/// The default `hullVertices`.
pub const DEFAULT_HULL_VERTICES: u32 = 64;
/// The default `triangles`, across all trimeshes.
pub const DEFAULT_TRIANGLES: u32 = 65_536;
/// The default `joints`.
pub const DEFAULT_JOINTS: u32 = 64;
/// The default `ccdBodies`.
pub const DEFAULT_CCD_BODIES: u32 = 16;
/// The default `queriesPerStep`.
pub const DEFAULT_QUERIES_PER_STEP: u32 = 64;
/// The default `eventsPerStep`.
pub const DEFAULT_EVENTS_PER_STEP: u32 = 64;
/// The default `heightfieldSamples`.
pub const DEFAULT_HEIGHTFIELD_SAMPLES: u32 = 1_048_576;
/// The default `staticPieces`: §17.7's 4096 boxes and 512 ramps.
pub const DEFAULT_STATIC_PIECES: u32 = 4_608;
/// The default `memoryBytes`: 64 MiB per world.
pub const DEFAULT_MEMORY_BYTES: u32 = 64 * 1024 * 1024;
/// The default `worldExtent` per caller length unit (`100_000 · lengthUnit`).
pub const DEFAULT_WORLD_EXTENT_PER_UNIT: f32 = 100_000.0;
/// The default `maxSpeed` per caller length unit (`1_000 · lengthUnit` per second).
pub const DEFAULT_MAX_SPEED_PER_UNIT: f32 = 1_000.0;
/// The default `maxAngularSpeed`, rad/s.
pub const DEFAULT_MAX_ANGULAR_SPEED: f32 = 1_000.0;
/// The ceiling a limit may be raised to, as a multiple of its default.
pub const CEILING_FACTOR: u32 = 4;

/// The resolved limits of one world (§11).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
    /// Bodies of every type; static pieces excluded.
    pub bodies: u32,
    /// Colliders per body.
    pub colliders_per_body: u32,
    /// Points per hull.
    pub hull_vertices: u32,
    /// Triangles across all trimeshes.
    pub triangles: u32,
    /// Joints.
    pub joints: u32,
    /// Bodies with CCD.
    pub ccd_bodies: u32,
    /// Queries per step.
    pub queries_per_step: u32,
    /// Events per step.
    pub events_per_step: u32,
    /// Samples per heightfield.
    pub heightfield_samples: u32,
    /// Static pieces.
    pub static_pieces: u32,
    /// The world's memory, in bytes (§11.1).
    pub memory_bytes: u32,
    /// |coordinate| bound per axis, caller units.
    pub world_extent: f32,
    /// The largest linear speed a command may set.
    pub max_speed: f32,
    /// The largest angular speed a command may set.
    pub max_angular_speed: f32,
}

impl Limits {
    /// The defaults for a world of `length_unit` (§11).
    pub fn defaults(length_unit: f32) -> Self {
        Self {
            bodies: DEFAULT_BODIES,
            colliders_per_body: DEFAULT_COLLIDERS_PER_BODY,
            hull_vertices: DEFAULT_HULL_VERTICES,
            triangles: DEFAULT_TRIANGLES,
            joints: DEFAULT_JOINTS,
            ccd_bodies: DEFAULT_CCD_BODIES,
            queries_per_step: DEFAULT_QUERIES_PER_STEP,
            events_per_step: DEFAULT_EVENTS_PER_STEP,
            heightfield_samples: DEFAULT_HEIGHTFIELD_SAMPLES,
            static_pieces: DEFAULT_STATIC_PIECES,
            memory_bytes: DEFAULT_MEMORY_BYTES,
            world_extent: DEFAULT_WORLD_EXTENT_PER_UNIT * length_unit,
            max_speed: DEFAULT_MAX_SPEED_PER_UNIT * length_unit,
            max_angular_speed: DEFAULT_MAX_ANGULAR_SPEED,
        }
    }

    /// The compile-time ceiling for a world of `length_unit`: 4x each default.
    pub fn ceiling(length_unit: f32) -> Self {
        let d = Self::defaults(length_unit);
        let factor = CEILING_FACTOR as f32;
        Self {
            bodies: d.bodies * CEILING_FACTOR,
            colliders_per_body: d.colliders_per_body * CEILING_FACTOR,
            hull_vertices: d.hull_vertices * CEILING_FACTOR,
            triangles: d.triangles * CEILING_FACTOR,
            joints: d.joints * CEILING_FACTOR,
            ccd_bodies: d.ccd_bodies * CEILING_FACTOR,
            queries_per_step: d.queries_per_step * CEILING_FACTOR,
            events_per_step: d.events_per_step * CEILING_FACTOR,
            heightfield_samples: d.heightfield_samples * CEILING_FACTOR,
            static_pieces: d.static_pieces * CEILING_FACTOR,
            memory_bytes: d.memory_bytes * CEILING_FACTOR,
            world_extent: d.world_extent * factor,
            max_speed: d.max_speed * factor,
            max_angular_speed: d.max_angular_speed * factor,
        }
    }

    /// The limits as a canonical JSON object, keyed by their contract names.
    pub(crate) fn canon(&self) -> Canon {
        let int = |value: u32| Canon::Num(value as f32);
        Canon::object([
            ("bodies", int(self.bodies)),
            ("collidersPerBody", int(self.colliders_per_body)),
            ("hullVertices", int(self.hull_vertices)),
            ("triangles", int(self.triangles)),
            ("joints", int(self.joints)),
            ("ccdBodies", int(self.ccd_bodies)),
            ("queriesPerStep", int(self.queries_per_step)),
            ("eventsPerStep", int(self.events_per_step)),
            ("heightfieldSamples", int(self.heightfield_samples)),
            ("staticPieces", int(self.static_pieces)),
            ("memoryBytes", int(self.memory_bytes)),
            ("worldExtent", Canon::Num(self.world_extent)),
            ("maxSpeed", Canon::Num(self.max_speed)),
            ("maxAngularSpeed", Canon::Num(self.max_angular_speed)),
        ])
    }
}
