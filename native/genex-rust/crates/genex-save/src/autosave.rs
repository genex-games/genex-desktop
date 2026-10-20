//! The autosave ring: every `every_ticks` simulated ticks the runtime writes the next of `ring`
//! slots (`autosave-0`, `autosave-1`, …), chosen from the tick alone so a replay writes the same
//! slots; the save taken when the app is suspended or closed goes to the ring's oldest slot.

use crate::index::SlotIndex;
use crate::slot::{AUTOSAVE_RING_MAX, SlotName};

/// A game's autosave cadence and ring size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AutosaveRing {
    every_ticks: u64,
    ring: u8,
}

impl AutosaveRing {
    /// An autosave every `every_ticks` ticks (at least 1) into `ring` slots (1 to
    /// [`AUTOSAVE_RING_MAX`]); None outside those ranges (the facade's `save-schema-invalid`).
    pub fn new(every_ticks: u64, ring: u8) -> Option<AutosaveRing> {
        let usable = every_ticks > 0 && (1..=AUTOSAVE_RING_MAX).contains(&ring);
        usable.then_some(AutosaveRing { every_ticks, ring })
    }

    /// The ticks between autosaves.
    pub fn every_ticks(&self) -> u64 {
        self.every_ticks
    }

    /// How many slots the ring holds.
    pub fn ring(&self) -> u8 {
        self.ring
    }

    /// The slot the autosave at the end of a tick that leaves the sim at `tick` writes, if one is
    /// due: tick `every * k` writes slot `(k - 1) % ring`.
    pub fn due(&self, tick: u64) -> Option<SlotName> {
        let due = tick > 0 && tick.is_multiple_of(self.every_ticks);
        if !due {
            return None;
        }
        let index = (tick / self.every_ticks - 1) % u64::from(self.ring);
        SlotName::autosave(u8::try_from(index).ok()?).ok()
    }

    /// The ring's slots, in order.
    pub fn slots(&self) -> impl Iterator<Item = SlotName> {
        (0..self.ring).filter_map(|index| SlotName::autosave(index).ok())
    }

    /// The slot a suspend save writes: the first ring slot not in `index`, else the one saved at
    /// the lowest tick (the lowest index on a tie).
    pub fn oldest(&self, index: &SlotIndex) -> Option<SlotName> {
        let mut oldest: Option<(u64, SlotName)> = None;
        for slot in self.slots() {
            let Some(info) = index.get(slot.as_str()) else { return Some(slot) };
            if oldest.as_ref().is_none_or(|(tick, _)| info.tick < *tick) {
                oldest = Some((info.tick, slot));
            }
        }
        oldest.map(|(_, slot)| slot)
    }
}
