//! genex-stream: worlds larger than memory, below the facade. A cell grid with sim, view and
//! detail radii, the residency policy, cell packs, streamed colliders and nav islands, and save and
//! restore. The sim set changes only on ticks sim state decides, never on async completion, so a
//! streamed world replays bit for bit on every destination; what is resident for drawing is
//! display state and never enters the checksum.
//!
//! Every planned module is declared now so each work package fills one body (game systems
//! EP-0a1); a module that names its work package is still a stub.

pub mod error;
pub mod ids;
pub mod grid;
pub mod residency;
pub mod pack;
pub mod snapshot;
pub mod nav;
#[cfg(feature = "physics")]
pub mod physics;

pub use error::StreamErrorCode;
pub use genex_core::cell::CellId;
pub use ids::StreamTicket;
pub use residency::{EntryState, Requester, Residency, ResidencyClock, ResidencyLimits, ResidencyStats, Want};
