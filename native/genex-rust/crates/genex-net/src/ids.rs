//! PlayerId (ordered by its string) and NetTicket (a per-seed counter).

use std::fmt;
use std::sync::Arc;

/// A seat's id as the relay names it. Ordered by its string, so iteration is deterministic; clones
/// share one allocation.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PlayerId(Arc<str>);

impl PlayerId {
    /// The id the relay (or a script) gave the seat.
    pub fn new(id: &str) -> PlayerId {
        PlayerId(Arc::from(id))
    }

    /// The id as text.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PlayerId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

/// A claim, release or remove request's ticket: its answer arrives as a `Control` event carrying it.
/// Minted from a per-seed counter, so the same run mints the same tickets.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct NetTicket(u32);

impl NetTicket {
    /// The ticket numbered `number` (journals and tests; games receive tickets from requests).
    pub const fn new(number: u32) -> NetTicket {
        NetTicket(number)
    }

    /// The ticket's number: 1 for the first request after a seed.
    pub const fn number(self) -> u32 {
        self.0
    }
}

/// The per-seed ticket counter: the first ticket after a seed is 1.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TicketCounter {
    minted: u32,
}

impl TicketCounter {
    /// The next ticket.
    pub fn mint(&mut self) -> NetTicket {
        self.minted = self.minted.wrapping_add(1);
        NetTicket(self.minted)
    }
}
