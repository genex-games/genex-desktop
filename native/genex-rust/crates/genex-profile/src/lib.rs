//! genex-profile: profiling for genex games and the engine, below the facade. Typed scopes record
//! into puffin with an injected clock, frames summarize to the slowest scopes, counters and hitches
//! are capped per device class, and reports carry the GPU lanes, memory rows and a Chrome trace.
//! Profiling never enters the checksum.
//!
//! The recorder, its scope vocabulary, caps, counters and summary (PROF-1a), and the hitches, the
//! GPU lane, memory rows, ProfileReport v2 and the Chrome trace (PROF-1b) are filled.

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

pub use caps::{CapsClass, ProfileCaps};
pub use counters::Counters;
pub use gpu_lane::{GpuLane, GpuNodeSample, GpuNodeTime, WORLD_NODE};
pub use hitch::{Hitch, HitchCause, HitchDetector};
pub use memory::{MemoryClass, MemoryRows};
pub use report::{ProfileReport, ReportMeta};
pub use trace::{chrome_trace, trace_digest};
pub use recorder::{Clock, Profiler, ProfilerConfig, WorkerLane, counter, default_clock, detach_thread};
pub use scope::{EngineScope, ScopeGuard, ScopeKey, ScopeName, scope};
pub use summary::{GpuTimeSource, NodeTiming, ProfileSummary};
