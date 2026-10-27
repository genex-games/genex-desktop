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
//! a fixed or kinematic sensor sees a kinematic body, and two sensors see each other. An opted-in
//! solid collider also pairs with every body type, so a kinematic body with `events: true` reports
//! touching a static piece, a fixed body or another kinematic body (with no response: neither is
//! dynamic); two solid colliders without the opt-in pair only when one is on a dynamic body. When
//! both colliders of a trigger are sensors, the lower body key is the `sensor`.
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
//! # Bulk calls (§19, additive to 1.0, pending sign-off)
//!
//! [`World::import_states`] takes [`World::export_changed`]'s flat layout and means one
//! `import_body_state` per key in order, judged all before any applies (atomic, the refusal naming
//! its index); [`World::query_many`] means one `query` per item, `queriesPerStep` counted the same.
//! They exist for the WASM binding, where each call is a crossing.
//!
//! # Measured worst case (§11.2)
//!
//! The required scene at default limits (512 bodies in one heap, 64 joints, 16 CCD bodies, 64
//! queries a step), on a Mac M-series (arm64), idle; `tests/bench.rs` (`cargo test --release --test
//! bench -- --ignored --nocapture`) natively, `scripts/physics-wasm-bench.ts` for wasm32 in Node 24.
//! Milliseconds a step, mean / p99:
//!
//! | Target | dt 1/60, 1 substep | dt 1/20, 3 substeps |
//! |---|---|---|
//! | native aarch64-macos | 0.494 / 0.787 | 1.437 / 2.148 |
//! | wasm32, Node 24 | 1.264 / 1.775 | 3.666 / 4.705 |
//! | native x86_64-linux | pending (the owner-approved droplet run) | pending |
//!
//! A whole tick with its commands and queries: native 0.612 / 1.054 and 1.561 / 2.425, wasm32 1.784 /
//! 2.555 and 4.207 / 5.344. The package README holds the same table.
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
//! cannot step, which a native build reports as `internal` (§11.3) and a WASM build cannot catch at
//! all. **A snapshot is trusted input**: restore only bytes this core wrote and the caller kept
//! (server replay, resync, saves on the caller's own storage), never bytes from a client or other
//! untrusted storage. Joint edits made since the last step travel in the snapshot too, so a
//! snapshot taken right after them steps on bit for bit.
//!
//! # Memory (§11.1)
//!
//! A binary that installs [`accounting::CountingAllocator`] (the WASM binding) gets each world's
//! exact live bytes: its calls are charged to it and a per-allocation header credits frees to the
//! world that allocated. A binary that does not (a native host) gets the model in [`memory`], the
//! same on every target; [`World::memory_is_measured`] says which. Either way every `LimitMemory`
//! refusal (a command, the static world, a restore) is judged before it allocates, by the model,
//! so the same calls are refused the same way on every target of the determinism row (§1.2) and a
//! refusal never relies on an allocation failing. The measured bytes are what `stats().memoryBytes`
//! and `memoryExceeded` report, so a measured world can be over its limit while the model still
//! admits a command; `memoryExceeded` tells the caller after the next step (§11.1: the caller
//! decides). This reading of §11.1 against §1.2 is the core's, pending the owner's.
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
mod hull;
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
pub use command::{ApplyMode, Command, CommandOutcome, SetPoseOptions};
pub use error::{PhysicsError, PhysicsFailure};
pub use hash::{fnv1a64, hex16};
pub use joint::{JointDesc, JointType, Motor};
pub use limits::Limits;
pub use snapshot::{SNAPSHOT_CONTRACT, SNAPSHOT_MAGIC};
pub use query::{EXCLUDE_BODIES_MAX, Hit, Query, QueryAnswer, QueryFilter, QueryOutcome};
pub use state::{BodyFilter, BodyState, ChangedExport, EXPORT_STRIDE, NetBodyState, PhysicsEvent, Stats, StepResult};
pub use static_world::StaticWorld;
pub use types::{Axis, BodyType, Pose, QUAT_IDENTITY, Quat, UpAxis, Vec3};
pub use world::World;
pub use world_desc::{CONTRACT_VERSION, LimitsDesc, ResolvedWorldDesc, SolverDesc, WorldDesc};
