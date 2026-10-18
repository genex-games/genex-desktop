//! The game side of embedded Live: hold the ring the host announced, blit each finished frame
//! into a free slot, send it once the GPU finished it, and keep the slot until the host releases
//! it. [`FrameSender::present`] waits for the GPU; [`FrameSender::submit`] and
//! [`FrameSender::poll_sent`] do not (review F8: the game's frame thread waited on the GPU for
//! every Live frame, so CPU and GPU never overlapped): one frame is in flight at a time, and a
//! later poll sends it once its submission is done.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// A frame submitted and not sent yet: its slot, its sequence number and whether the GPU is done.
struct InFlight {
    slot: u16,
    seq: u64,
    done: Arc<AtomicBool>,
}

/// The frames sender of one run.
pub struct FrameSender {
    connection: Connection,
    blit: BottomUpBlit,
    ring: Option<Ring>,
    seq: SeqCounter,
    in_flight: Option<InFlight>,
}

impl FrameSender {
    /// A sender on `connection` drawing with `device` (wgpu's Metal backend).
    pub fn new(device: &wgpu::Device, connection: Connection) -> FrameSender {
        FrameSender { connection, blit: BottomUpBlit::new(device), ring: None, seq: SeqCounter::default(), in_flight: None }
    }

    /// The `surface` op: replaces the ring with `spec`'s generation (fresh IOSurfaces, no slot
    /// held; releases for the retired generation are ignored from now on).
    pub fn set_ring(&mut self, device: &wgpu::Device, spec: RingSpec) -> Result<Vec<SlotInfo>, FramesError> {
        self.ring = None;
        self.in_flight = None;
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

    /// The slot the next frame would use, or `None` (no ring, the host holds every slot, or a
    /// submitted frame is still in flight).
    pub fn free_slot(&self) -> Option<u16> {
        if self.in_flight.is_some() {
            return None;
        }
        self.ring.as_ref().and_then(|ring| ring.ledger.next_free())
    }

    /// Whether a submitted frame waits for the GPU (a [`FrameSender::poll_sent`] sends it).
    pub fn in_flight(&self) -> bool {
        self.in_flight.is_some()
    }

    /// Bit `n` set while the host holds slot `n`.
    pub fn held_mask(&self) -> u8 {
        self.ring.as_ref().map_or(0, |ring| ring.ledger.held_mask())
    }

    /// The ring's slot `slot`, if any (tests read its IOSurface back).
    pub fn slot(&self, slot: u16) -> Option<&SlotSurface> {
        self.ring.as_ref().and_then(|ring| ring.slots.get(usize::from(slot)))
    }

    /// Presents a finished frame. `Ok(None)`: the host holds every slot (or a submitted frame is
    /// still in flight), so the frame is skipped and nothing is sent. Otherwise the frame is blitted bottom-up into the free slot, the GPU
    /// finishes it, and only then is it sent; the slot is held only once the host has it.
    pub fn present(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source: &wgpu::TextureView,
    ) -> Result<Option<Sent>, FramesError> {
        let ring = self.ring.as_mut().ok_or_else(|| FramesError::new(FramesCode::NoRing, "no surface op yet"))?;
        if self.in_flight.is_some() {
            return Ok(None);
        }
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

impl FrameSender {
    /// Blits a finished frame bottom-up into the free slot and submits it without waiting for the
    /// GPU; answers its sequence number. `Ok(None)`: nothing was submitted (the host holds every
    /// slot, or the last frame is still in flight).
    pub fn submit(
        &mut self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        source: &wgpu::TextureView,
    ) -> Result<Option<u64>, FramesError> {
        let ring = self.ring.as_ref().ok_or_else(|| FramesError::new(FramesCode::NoRing, "no surface op yet"))?;
        if self.in_flight.is_some() {
            return Ok(None);
        }
        let Some(slot) = ring.ledger.next_free() else { return Ok(None) };
        self.blit.draw(device, queue, source, &ring.slots[usize::from(slot)]);
        let done = Arc::new(AtomicBool::new(false));
        let finished = Arc::clone(&done);
        queue.on_submitted_work_done(move || finished.store(true, Ordering::Release));
        let seq = self.seq.next()?;
        self.in_flight = Some(InFlight { slot, seq, done });
        Ok(Some(seq))
    }

    /// Sends the frame in flight once the GPU finished it, without blocking: `Ok(None)` while it
    /// is not done (or none is in flight). The slot is held only once the host has it.
    pub fn poll_sent(&mut self, device: &wgpu::Device) -> Result<Option<Sent>, FramesError> {
        if self.in_flight.is_none() {
            return Ok(None);
        }
        device.poll(wgpu::PollType::Poll).map_err(|error| FramesError::new(FramesCode::GpuWaitFailed, error.to_string()))?;
        let Some(InFlight { slot, seq, .. }) = self.in_flight.take_if(|frame| frame.done.load(Ordering::Acquire)) else {
            return Ok(None);
        };
        let ring = self.ring.as_mut().ok_or_else(|| FramesError::new(FramesCode::NoRing, "no surface op yet"))?;
        let ts_us = realtime_us();
        let payload = FramePayload::for_ring(&ring.spec, slot, seq, ts_us);
        let kr = self.connection.send_surface(ring.slots[usize::from(slot)].surface(), payload, SEND_TIMEOUT_MS);
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
