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
//! Other commands follow the same shape: key syntax, numbers, then `UnknownKey`, `WrongBodyType`,
//! `DuplicateKey` and the `Limit*` codes (`core::ops`). The static world checks `upAxis`, then
//! §17.7's rules, then `DuplicateKey`, `LimitStatic` and `LimitMemory` (`static_world`).
//!
//! # Events (§8.1)
//!
//! A contact pair reports when either collider has `events: true`; a sensor always reports. A
//! begin's `point` is the midpoint of the two surfaces' points at the pair's deepest active contact
//! on the sub-step it began, its `normal` points from `a` to `b`, and its `impulse` is the pair's
//! total normal impulse from that sub-step to the end of the step (or to its end within the step),
//! summed in f32. Contacts are the backend's active contacts, which include its speculative ones, so
//! a begin can come a sub-step before the shapes meet. Removing a body reports no `contactEnd` or
//! `triggerExit` for it: removals are the caller's own (§9.1). Sensors pair with every body type, so
//! a fixed or kinematic sensor sees a kinematic body; two solid colliders pair only when one of them
//! is on a dynamic body, so a kinematic body touching a fixed one reports nothing. When both
//! colliders of a trigger are sensors, the lower body key is the `sensor`.
//!
//! # Queries (§13)
//!
//! A query sees the world as of the last step plus every command applied since (a spawned or moved
//! body is found where it is now). Its origin or pose lies within `worldExtent`, its direction is
//! normalised in f32 and must not be zero, and `maxDist` is at least 0; `dist` runs along the
//! normalised direction. A hit's `point` is on the hit collider and its `normal` is that collider's
//! outward normal; a ray or cast that starts inside a solid hits it at 0. Only box, sphere, capsule
//! and hull shapes are swept or overlapped (`OutOfRange` otherwise). A query counts toward
//! `queriesPerStep` only when it succeeds.
//!
//! # Time (§11.4)
//!
//! The core reads no clock. `stats().stepMs` reports what a binding recorded with
//! [`World::record_step_ms`] around its own call to `step()`, and 0 until one does.
//!
//! # Snapshots (§9.4)
//!
//! [`World::snapshot`] writes a `GXPH` header (contract version, buildId, tick, FNV-1a 64 of the
//! payload, its length) and a postcard payload: the resolved description, the static world as
//! given, every record the core keeps and the backend's own state with its solver caches, so a
//! restored world steps on bit for bit, on any target of the same build. [`World::restore`]
//! checks the header (`BadSnapshot`, `BuildMismatch`), then every record against the others and
//! against its own limits (`BadSnapshot` for anything no world could hold), then `LimitMemory`
//! by the core's model, and only then reads the backend's state. The checksum catches damage, not
//! forgery: a resealed payload that passes these checks can still hold backend state the backend
//! cannot step, which a native build reports as `internal` (§11.3).
//!
//! # Memory (§11.1)
//!
//! A binary that installs [`accounting::CountingAllocator`] (the WASM binding) gets each world's
//! exact live bytes: its calls are charged to it and a per-allocation header credits frees to the
//! world that allocated. A binary that does not (a native host) gets the model in [`memory`], the
//! same on every target; [`World::memory_is_measured`] says which. Either way a command is judged
//! before it allocates, from the world's bytes now plus the model's estimate of what it adds, so a
//! refusal never relies on an allocation failing. Near the limit, a measured world can end a call
//! slightly past what the estimate allowed; `memoryExceeded` reports it after the next step.
//!
//! # Failure (§11.3)
//!
//! A native build catches a backend panic, poisons the world and returns `internal` from then on
//! ([`World::check`]); see [`World`].
//!
//! # Joints
//!
//! A joint's coordinate is `a` relative to `b` (or to the world when `b` is `None`): a positive
//! hinge angle or motor velocity turns `a` about `+axis` right-handedly, and a slider position is
//! `a`'s anchor along `+axis` from `b`'s. A fixed joint holds the two bodies' local axes parallel.
//! The readings of `axis`, `limits` and `motor` the contract leaves open are listed in `joint`.

// `GlobalAlloc` is an unsafe trait, and the header lives in front of the caller's block: the
// accounting module is the crate's only unsafe code, each block with its reason beside it.
#[allow(unsafe_code)]
pub mod accounting;
mod axes;
mod backend;
pub mod body;
mod build_id;
mod canon;
pub mod command;
mod core;
pub mod error;
mod hash;
pub mod joint;
mod json;
mod kinematic;
pub mod key;
mod ledger;
pub mod limits;
pub mod memory;
mod num;
pub mod query;
mod shape;
mod snapshot;
pub mod state;
pub mod static_world;
pub mod types;
mod world;
pub mod world_desc;

pub use body::{BodyDesc, ColliderDesc, Groups, Shape};
pub use build_id::{CORE_VERSION, build_id, build_id_without_target, target_name};
pub use canon::es_number;
pub use command::{Command, CommandOutcome, SetPoseOptions};
pub use error::{PhysicsError, PhysicsFailure};
pub use hash::{fnv1a64, hex16};
pub use joint::{JointDesc, JointType, Motor};
pub use limits::Limits;
pub use snapshot::{SNAPSHOT_CONTRACT, SNAPSHOT_MAGIC};
pub use query::{EXCLUDE_BODIES_MAX, Hit, Query, QueryAnswer, QueryFilter};
pub use state::{BodyFilter, BodyState, ChangedExport, EXPORT_STRIDE, NetBodyState, PhysicsEvent, Stats, StepResult};
pub use static_world::StaticWorld;
pub use types::{Axis, BodyType, Pose, QUAT_IDENTITY, Quat, UpAxis, Vec3};
pub use world::World;
pub use world_desc::{CONTRACT_VERSION, LimitsDesc, ResolvedWorldDesc, SolverDesc, WorldDesc};
