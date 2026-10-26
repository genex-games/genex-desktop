//! genex-physics: the Genex Physics core of the Layer 1 contract 1.0 (`CONTRACT.md` beside this
//! crate; section numbers below are its own).
//!
//! One [`World`] per caller, single-threaded and deterministic per [`build_id`]. Everything is
//! addressed by caller keys; no backend type crosses this API (§1.3). The crate is two layers:
//!
//! - a backend-neutral layer (this crate's public modules and `core`) that owns keys, validation and
//!   the f32 rounding of every number (§4.1), limits, the z-up mapping (§5), hashes (§10), errors
//!   (§14), escaped bodies (§8.2) and memory accounting (§11.1), with every ordered collection keyed
//!   by caller key;
//! - an internal `Backend` trait under it, never public, with Rapier 0.36 as its first
//!   implementation (`backend::rapier`).
//!
//! # Heightfield triangles (§6.3)
//!
//! Rapier splits each grid cell along the diagonal from sample (r + 1, c) to sample (r, c + 1) of its
//! internal grid. For `upAxis: "y"` that is the caller's grid too. For `upAxis: "z"` the core
//! reverses the row order, so in the caller's grid the diagonal runs from (r, c) to (r + 1, c + 1).
//!
//! # Validation order
//!
//! A refused call names the first failure in this order: key syntax (`InvalidKey`), then each field
//! in declaration order (`NonFinite` before `OutOfRange` for one number; `BadShape`, then
//! `DynamicMesh`, for one shape), duplicate collider keys, then the world's checks: `DuplicateKey`,
//! `LimitBodies`, `LimitColliders`, `LimitHullVertices`, `LimitTriangles`, `LimitCcd`, `LimitMemory`.

mod axes;
mod backend;
pub mod body;
mod build_id;
mod canon;
mod core;
pub mod error;
mod hash;
pub mod key;
pub mod limits;
pub mod memory;
mod num;
mod shape;
pub mod state;
pub mod types;
mod world;
pub mod world_desc;

pub use body::{BodyDesc, ColliderDesc, Groups, Shape};
pub use build_id::{CORE_VERSION, build_id, build_id_without_target, target_name};
pub use canon::es_number;
pub use error::{PhysicsError, PhysicsFailure};
pub use hash::{fnv1a64, hex16};
pub use limits::Limits;
pub use state::{BodyFilter, BodyState, PhysicsEvent, StepResult};
pub use types::{Axis, BodyType, Pose, QUAT_IDENTITY, Quat, UpAxis, Vec3};
pub use world::World;
pub use world_desc::{CONTRACT_VERSION, LimitsDesc, ResolvedWorldDesc, SolverDesc, WorldDesc};
