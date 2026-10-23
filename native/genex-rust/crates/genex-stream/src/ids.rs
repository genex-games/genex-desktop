//! The handles streaming hands out. Cells are genex-core's `CellId`.

/// A named asset group the sim asked for with `require`, ready at a tick sim state decides.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamTicket(pub(crate) u32);

impl StreamTicket {
    /// The raw number, for probes and saves.
    pub const fn raw(self) -> u32 {
        self.0
    }

    /// The ticket numbered `raw`: what the facade's named groups hand out (release R-9).
    pub const fn from_raw(raw: u32) -> StreamTicket {
        StreamTicket(raw)
    }
}
