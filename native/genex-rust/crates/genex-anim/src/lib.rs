//! genex-anim: skeletal animation for genex games, below the facade. It imports rigs and clips,
//! samples and blends them, runs layered state machines with transitions, blend spaces, events,
//! root motion, IK and foot placement, retargets humanoids, and (with `physics`) drives characters
//! and ragdolls. Everything here is simulation state: deterministic on every destination (glam
//! scalar-math and libm, `Map`, no clock, rand or thread), saveable and probe-visible.
//!
//! Every planned module is declared now so each work package fills one body (game systems
//! EP-0a1); a module that names its work package is still a stub.

pub mod error;
pub mod ids;
pub mod math;
pub mod skeleton;
pub mod import;
pub mod clip;
pub mod sample;
pub mod compact;
pub mod blend;
pub mod mask;
pub mod humanoid;
pub mod clip_set;
pub mod pose_check;
pub mod weapon;
pub mod params;
pub mod graph;
pub mod machine;
pub mod events;
pub mod transition;
pub mod inertial;
pub mod blendspace;
pub mod sync;
pub mod root_motion;
pub mod ik;
pub mod foot;
pub mod retarget;
pub mod animator;
pub mod evaluate;
pub mod character;
pub mod simple;
pub mod vat;
#[cfg(feature = "physics")]
pub mod ragdoll;
#[cfg(feature = "physics")]
pub mod ragdoll_profile;

pub use error::{AnimationError, AnimationErrorCode};
pub use ids::{ClipId, EventId, JointId, LayerId, ParamId, StateId};
