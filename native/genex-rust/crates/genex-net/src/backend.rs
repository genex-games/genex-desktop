//! NetBackend: pump, cut a frame for a tick, apply a tick's writes, report the mode.
//!
//! The runtime pumps every shell frame (paused or not, so a seat stays alive), cuts one frame per
//! tick before the update hooks, and applies the tick's writes after them. Backends are chosen by
//! the build, never by game code.

use crate::frame::NetFrame;
use crate::vocab::NetMode;
use crate::writes::NetWrites;

/// A source of frames and a sink of writes.
pub trait NetBackend {
    /// Move IO along: poll the socket, keep the seat alive. Called every shell frame.
    fn pump(&mut self);

    /// The frame `tick` reads: every change and event since the last cut.
    fn cut(&mut self, tick: u64) -> NetFrame;

    /// The writes `tick` made; their effects arrive in a later frame.
    fn apply(&mut self, tick: u64, writes: NetWrites);

    /// Which backend this is.
    fn mode(&self) -> NetMode;
}
