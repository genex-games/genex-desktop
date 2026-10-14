//! The ring the host announces, which of its slots the host holds, and the frame sequence.

use crate::error::{FramesCode, FramesError};
use crate::wire::{MAX_PIXELS, MAX_SEQ, MAX_SIDE, MAX_SLOTS};

/// An announced ring, checked as `gxf_ring_create` checks it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RingSpec {
    generation: u32,
    width: u32,
    height: u32,
    slots: u32,
}

impl RingSpec {
    /// Checks the `surface` op's ring; refuses [`FramesCode::InvalidRing`].
    pub fn new(generation: u32, width: u32, height: u32, slots: u32) -> Result<RingSpec, FramesError> {
        let sides = (1..=MAX_SIDE).contains(&width) && (1..=MAX_SIDE).contains(&height);
        let fits = sides && u64::from(width) * u64::from(height) <= MAX_PIXELS;
        if generation == 0 || !(1..=MAX_SLOTS).contains(&slots) || !fits {
            let detail = format!("ring generation {generation}, {width}x{height}, {slots} slots");
            return Err(FramesError::new(FramesCode::InvalidRing, detail));
        }
        Ok(RingSpec { generation, width, height, slots })
    }

    /// The host-chosen generation (never 0).
    pub fn generation(&self) -> u32 {
        self.generation
    }

    /// Width in device pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Height in device pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// Slot count, 1 to 3.
    pub fn slots(&self) -> u32 {
        self.slots
    }
}

/// Which slots of one ring generation the host holds. A sent slot is the host's until the host's
/// `release` for that generation and slot; slots are offered round-robin after the last sent.
#[derive(Clone, Debug)]
pub struct SlotLedger {
    generation: u32,
    slots: u16,
    held: [bool; MAX_SLOTS as usize],
    sent: u64,
}

impl SlotLedger {
    /// A ledger for `ring` with every slot free.
    pub fn new(ring: &RingSpec) -> SlotLedger {
        SlotLedger { generation: ring.generation, slots: ring.slots as u16, held: [false; MAX_SLOTS as usize], sent: 0 }
    }

    /// The next slot the game may draw into, or `None` while the host holds every slot.
    pub fn next_free(&self) -> Option<u16> {
        let slots = u64::from(self.slots);
        (0..slots).map(|i| ((self.sent + i) % slots) as u16).find(|&slot| !self.held[usize::from(slot)])
    }

    /// Records that `slot` was sent: the host holds it now.
    pub fn hold(&mut self, slot: u16) {
        if let Some(held) = self.held.get_mut(usize::from(slot)).filter(|_| slot < self.slots) {
            *held = true;
            self.sent = u64::from(slot) + 1;
        }
    }

    /// The host gave `slot` of `generation` back. False (and nothing changes) for another
    /// generation, a slot outside the ring, or a slot the host does not hold.
    pub fn release(&mut self, generation: u32, slot: u32) -> bool {
        if generation != self.generation || slot >= u32::from(self.slots) {
            return false;
        }
        let held = &mut self.held[slot as usize];
        std::mem::replace(held, false)
    }

    /// Bit `n` set while the host holds slot `n`.
    pub fn held_mask(&self) -> u8 {
        self.held.iter().enumerate().filter(|(_, held)| **held).fold(0, |mask, (slot, _)| mask | (1 << slot))
    }
}

/// Frame sequence numbers: 1, 2, 3, ... up to [`MAX_SEQ`], then [`FramesCode::SeqExhausted`].
#[derive(Clone, Copy, Debug, Default)]
pub struct SeqCounter {
    last: u64,
}

impl SeqCounter {
    /// A counter whose next number is `last + 1` (a resumed run, tests).
    pub fn starting_after(last: u64) -> SeqCounter {
        SeqCounter { last }
    }

    /// The next sequence number.
    #[allow(clippy::should_implement_trait, reason = "fallible, not an Iterator")]
    pub fn next(&mut self) -> Result<u64, FramesError> {
        if self.last >= MAX_SEQ {
            return Err(FramesError::new(FramesCode::SeqExhausted, format!("seq {} is the last", self.last)));
        }
        self.last += 1;
        Ok(self.last)
    }
}
