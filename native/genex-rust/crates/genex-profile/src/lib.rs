//! genex-profile: profiling for genex games and the engine, below the facade. Typed scopes record
//! into puffin with an injected clock, frames summarize to the slowest scopes, counters and hitches
//! are capped per device class, and reports carry the GPU lanes, memory rows and a Chrome trace.
//! Profiling never enters the checksum.
//!
//! Every planned module is declared now so each work package fills one body (G6 profiling,
//! PROF-0d); a module that names its work package is still a stub.

pub mod scope;
pub mod recorder;
pub mod caps;
pub mod summary;
pub mod counters;
pub mod hitch;
pub mod gpu_lane;
pub mod memory;
pub mod report;
pub mod trace;
