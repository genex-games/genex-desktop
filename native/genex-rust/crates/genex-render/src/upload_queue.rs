//! The soft upload queue: per-frame upload bytes held to a class budget, so a streamed frame never
//! hitches (game systems STR-5).
//!
//! Streamed assets (a cell's meshes, a texture's levels) are queued whole, each with its byte size,
//! on the job pool's three [`Priority`] lanes. Once a frame [`UploadQueue::drain`] hands them to the
//! caller's upload, most urgent lane first and each lane in order, and stops:
//! - before the first asset that would take the frame past its byte budget (the class's
//!   [`crate::presets::StreamBudget::upload_bytes`]): it waits, at the front of its lane, for the
//!   next frame, and nothing behind it jumps ahead;
//! - after the asset that brings the time spent, by the caller's clock, to the millisecond budget;
//! - or when nothing waits.
//!
//! An asset larger than the whole byte budget goes alone, in a frame that has uploaded nothing
//! yet, so it is never starved. Every other frame stays within the budget. The budget is soft: the
//! hard per-frame refusal of the frame's own tables ([`crate::caps::UploadBudget`], 32 MiB) is a
//! separate cap and does not move.
//!
//! Job threads hand uploads in through an [`UploadInbox`]; they join the lanes at the next drain.
//! A queued upload can be cancelled by its [`UploadTicket`] (a cell left before its meshes went).
//! The queue is view-side only: what a drain uploads never reaches the simulation, so frame timing
//! cannot change a checksum.
//!
//! The idea is Bevy's `RenderAssetBytesPerFrame` (MIT OR Apache-2.0; no code taken): whole assets
//! against a per-frame byte limit, reset every frame.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

use crate::jobs::{FinishClock, Priority};

/// Names one queued upload, so it can be cancelled before it goes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct UploadTicket(u64);

/// Why an [`UploadQueue::drain`] stopped.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum UploadStop {
    /// Nothing was left to upload.
    #[default]
    Empty,
    /// The next upload would have crossed the byte budget, or one larger than the budget went alone.
    Bytes,
    /// The time spent reached the millisecond budget.
    Time,
}

/// What one [`UploadQueue::drain`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct UploadReport {
    /// Uploads handed to the caller.
    pub uploaded: usize,
    /// Their bytes.
    pub bytes: u64,
    /// Uploads still queued for a later frame.
    pub left: usize,
    /// Their bytes.
    pub left_bytes: u64,
    /// Milliseconds the drain spent, by its clock.
    pub spent_ms: f64,
    /// Why it stopped.
    pub stop: UploadStop,
}

/// One queued upload.
struct Pending<T> {
    ticket: UploadTicket,
    bytes: u64,
    item: T,
}

type Lanes<T> = [VecDeque<Pending<T>>; 3];

fn empty_lanes<T>() -> Lanes<T> {
    [VecDeque::new(), VecDeque::new(), VecDeque::new()]
}

/// The lane of `priority` (most urgent first, [`Priority::ALL`]'s order).
const fn lane(priority: Priority) -> usize {
    match priority {
        Priority::Sim => 0,
        Priority::Visible => 1,
        Priority::Prefetch => 2,
    }
}

/// What the queue and its inboxes share: the ticket counter and the handed-in lanes.
struct Shared<T> {
    next_ticket: AtomicU64,
    handed_in: Mutex<Lanes<T>>,
}

impl<T> Shared<T> {
    fn ticket(&self) -> UploadTicket {
        UploadTicket(self.next_ticket.fetch_add(1, Ordering::Relaxed))
    }

    fn handed_in(&self) -> MutexGuard<'_, Lanes<T>> {
        self.handed_in.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

/// Streamed uploads waiting for the frame thread, drained once a frame under a byte budget and a
/// millisecond budget.
pub struct UploadQueue<T> {
    lanes: Lanes<T>,
    shared: Arc<Shared<T>>,
}

impl<T> Default for UploadQueue<T> {
    fn default() -> Self {
        let shared = Shared { next_ticket: AtomicU64::new(0), handed_in: Mutex::new(empty_lanes()) };
        UploadQueue { lanes: empty_lanes(), shared: Arc::new(shared) }
    }
}

impl<T> std::fmt::Debug for UploadQueue<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UploadQueue").field("len", &self.len()).field("bytes", &self.bytes()).finish()
    }
}

impl<T> UploadQueue<T> {
    /// An empty queue.
    pub fn new() -> Self {
        UploadQueue::default()
    }

    /// Queue `item`, an upload of `bytes`, on the `priority` lane (from the frame thread).
    pub fn push(&mut self, priority: Priority, bytes: u64, item: T) -> UploadTicket {
        let ticket = self.shared.ticket();
        self.lanes[lane(priority)].push_back(Pending { ticket, bytes, item });
        ticket
    }

    /// A handle job threads hand uploads in through; they join the lanes at the next drain.
    pub fn inbox(&self) -> UploadInbox<T> {
        UploadInbox { shared: Arc::clone(&self.shared) }
    }

    /// Uploads waiting, handed-in ones included.
    pub fn len(&self) -> usize {
        let handed_in: usize = self.shared.handed_in().iter().map(VecDeque::len).sum();
        self.lanes.iter().map(VecDeque::len).sum::<usize>() + handed_in
    }

    /// Whether nothing waits.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Bytes waiting, handed-in ones included.
    pub fn bytes(&self) -> u64 {
        let sum = |lanes: &Lanes<T>| lanes.iter().flatten().map(|pending| pending.bytes).fold(0u64, u64::saturating_add);
        sum(&self.lanes).saturating_add(sum(&self.shared.handed_in()))
    }

    /// Take the upload `ticket` names out of the queue before it goes: its item, or None when it
    /// already went or was cancelled.
    pub fn cancel(&mut self, ticket: UploadTicket) -> Option<T> {
        self.take_handed_in();
        self.lanes.iter_mut().find_map(|lane| {
            let at = lane.iter().position(|pending| pending.ticket == ticket)?;
            lane.remove(at).map(|pending| pending.item)
        })
    }

    /// Hand waiting uploads to `upload`, most urgent lane first and each lane in order, while they
    /// fit in `budget_bytes` and until the time spent by `clock` reaches `budget_ms` (the upload
    /// that reaches it is the last). An upload larger than `budget_bytes` goes alone, in a drain
    /// that has uploaded nothing yet. What is left waits for the next drain, in its place.
    pub fn drain(&mut self, budget_bytes: u64, budget_ms: f64, clock: &mut impl FinishClock, mut upload: impl FnMut(T)) -> UploadReport {
        self.take_handed_in();
        let started = clock.now_ms();
        let mut report = UploadReport::default();
        while let Some(index) = self.lanes.iter().position(|lane| !lane.is_empty()) {
            let Some(next) = self.lanes[index].front().map(|pending| pending.bytes) else { break };
            let fits = report.bytes.saturating_add(next) <= budget_bytes;
            if !fits && report.uploaded > 0 {
                report.stop = UploadStop::Bytes;
                break;
            }
            let Some(pending) = self.lanes[index].pop_front() else { break };
            upload(pending.item);
            report.uploaded += 1;
            report.bytes = report.bytes.saturating_add(next);
            report.spent_ms = clock.now_ms() - started;
            if !fits {
                report.stop = UploadStop::Bytes;
                break;
            }
            if report.spent_ms >= budget_ms {
                report.stop = UploadStop::Time;
                break;
            }
        }
        report.left = self.len();
        report.left_bytes = self.bytes();
        report
    }

    /// Move handed-in uploads onto the lanes, in the order they were handed in.
    fn take_handed_in(&mut self) {
        let mut handed_in = self.shared.handed_in();
        for (lane, from) in self.lanes.iter_mut().zip(handed_in.iter_mut()) {
            lane.append(from);
        }
    }
}

/// Hands uploads from any thread to an [`UploadQueue`] ([`UploadQueue::inbox`]).
pub struct UploadInbox<T> {
    shared: Arc<Shared<T>>,
}

impl<T> Clone for UploadInbox<T> {
    fn clone(&self) -> Self {
        UploadInbox { shared: Arc::clone(&self.shared) }
    }
}

impl<T> std::fmt::Debug for UploadInbox<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("UploadInbox")
    }
}

impl<T> UploadInbox<T> {
    /// Hand in `item`, an upload of `bytes`, on the `priority` lane.
    pub fn push(&self, priority: Priority, bytes: u64, item: T) -> UploadTicket {
        let ticket = self.shared.ticket();
        self.shared.handed_in()[lane(priority)].push_back(Pending { ticket, bytes, item });
        ticket
    }
}
