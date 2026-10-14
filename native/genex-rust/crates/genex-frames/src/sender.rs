//! The game side of embedded Live: hold the ring the host announced, blit each finished frame
//! into a free slot, wait for the GPU, send it, and keep the slot until the host releases it.

use std::time::{SystemTime, UNIX_EPOCH};

use mach2::message::{MACH_MSG_SUCCESS, mach_msg_timeout_t};

use crate::blit::BottomUpBlit;
use crate::connection::Connection;
use crate::error::{FramesCode, FramesError};
use crate::ring::{RingSpec, SeqCounter, SlotLedger};
use crate::surface::SlotSurface;
use crate::wire::FramePayload;

/// How long one frame message may wait for space in the host's queue before it is dropped.
pub const SEND_TIMEOUT_MS: mach_msg_timeout_t = 200;

/// One slot as the `surface` op reports it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SlotInfo {
    /// The slot index.
    pub slot: u16,
    /// Its IOSurface's global id.
    pub surface_id: u32,
}

/// A frame the host received.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sent {
    /// The slot it occupies until released.
    pub slot: u16,
    /// Its sequence number.
    pub seq: u64,
    /// Its CLOCK_REALTIME timestamp in microseconds.
    pub ts_us: u64,
}

struct Ring {
    spec: RingSpec,
    slots: Vec<SlotSurface>,
    ledger: SlotLedger,
}

/// The frames sender of one run.
pub struct FrameSender {
    connection: Connection,
    blit: BottomUpBlit,
    ring: Option<Ring>,
    seq: SeqCounter,
}

impl FrameSender {
    /// A sender on `connection` drawing with `device` (wgpu's Metal backend).
    pub fn new(device: &wgpu::Device, connection: Connection) -> FrameSender {
        FrameSender { connection, blit: BottomUpBlit::new(device), ring: None, seq: SeqCounter::default() }
    }

    /// The `surface` op: replaces the ring with `spec`'s generation (fresh IOSurfaces, no slot
    /// held; releases for the retired generation are ignored from now on).
    pub fn set_ring(&mut self, device: &wgpu::Device, spec: RingSpec) -> Result<Vec<SlotInfo>, FramesError> {
        self.ring = None;
        let slots = (0..spec.slots())
            .map(|_| SlotSurface::create(device, spec.width(), spec.height()))
            .collect::<Result<Vec<_>, _>>()?;
        let info = slots.iter().zip(0u16..).map(|(slot, index)| SlotInfo { slot: index, surface_id: slot.surface_id() });
        let info = info.collect();
        self.ring = Some(Ring { ledger: SlotLedger::new(&spec), spec, slots });
        Ok(info)
    }

    /// The host's `release` op. False (nothing changes) for a stale generation, a slot outside
    /// the ring, or a slot not held.
    pub fn release(&mut self, generation: u32, slot: u32) -> bool {
        self.ring.as_mut().is_some_and(|ring| ring.ledger.release(generation, slot))
    }

    /// The slot the next frame would use, or `None` (no ring, or the host holds every slot).
    pub fn free_slot(&self) -> Option<u16> {
        self.ring.as_ref().and_then(|ring| ring.ledger.next_free())
    }

    /// Bit `n` set while the host holds slot `n`.
    pub fn held_mask(&self) -> u8 {
        self.ring.as_ref().map_or(0, |ring| ring.ledger.held_mask())
    }

    /// The ring's slot `slot`, if any (tests read its IOSurface back).
    pub fn slot(&self, slot: u16) -> Option<&SlotSurface> {
        self.ring.as_ref().and_then(|ring| ring.slots.get(usize::from(slot)))
    }

    /// Presents a finished frame. `Ok(None)`: the host holds every slot, so the frame is skipped
    /// and nothing is sent. Otherwise the frame is blitted bottom-up into the free slot, the GPU
    /// finishes it, and only then is it sent; the slot is held only once the host has it.
    pub fn present(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source: &wgpu::TextureView,
    ) -> Result<Option<Sent>, FramesError> {
        let ring = self.ring.as_mut().ok_or_else(|| FramesError::new(FramesCode::NoRing, "no surface op yet"))?;
        let Some(slot) = ring.ledger.next_free() else { return Ok(None) };
        let surface = &ring.slots[usize::from(slot)];
        self.blit.draw_and_wait(device, queue, source, surface)?;
        let seq = self.seq.next()?;
        let ts_us = realtime_us();
        let payload = FramePayload::for_ring(&ring.spec, slot, seq, ts_us);
        let kr = self.connection.send_surface(surface.surface(), payload, SEND_TIMEOUT_MS);
        if kr != MACH_MSG_SUCCESS {
            let detail = format!("mach_msg {kr:#x} for seq {seq}");
            return Err(FramesError::new(FramesCode::SendFailed, detail).with_kern_return(kr));
        }
        ring.ledger.hold(slot);
        Ok(Some(Sent { slot, seq, ts_us }))
    }
}

/// CLOCK_REALTIME in microseconds (comparable with the host's `receivedAt`).
pub fn realtime_us() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |since| since.as_micros() as u64)
}
