//! The Off backend: the API compiles, the status is offline and the reason net-disabled.
//!
//! A game built without `[net]` gets this backend. Every frame is the same empty, offline view;
//! writes that reach it (only session steps can: the rest refuse `net-not-joined`) are counted and
//! dropped.

use crate::backend::NetBackend;
use crate::frame::{NetFrame, NetRoom};
use crate::vocab::{NetMode, NetOffline};
use crate::writes::NetWrites;

/// The backend of a game without networking.
#[derive(Clone, Debug)]
pub struct OffBackend {
    room: NetRoom,
    dropped: u64,
}

impl OffBackend {
    /// An offline room, reason `net-disabled`.
    pub fn new() -> OffBackend {
        OffBackend { room: NetRoom::new(Some(NetOffline::Disabled)), dropped: 0 }
    }

    /// How many writes reached this backend and were dropped (`__net.writesDropped`).
    pub fn dropped(&self) -> u64 {
        self.dropped
    }
}

impl Default for OffBackend {
    fn default() -> OffBackend {
        OffBackend::new()
    }
}

impl NetBackend for OffBackend {
    fn pump(&mut self) {}

    fn cut(&mut self, tick: u64) -> NetFrame {
        self.room.cut(tick, NetMode::Off)
    }

    fn apply(&mut self, _tick: u64, writes: NetWrites) {
        self.dropped += writes.len() as u64;
    }

    fn mode(&self) -> NetMode {
        NetMode::Off
    }
}
