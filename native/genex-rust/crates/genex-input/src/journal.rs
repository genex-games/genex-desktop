//! The input journal: every tick's merged input since the seed or a snapshot anchor, encoded as
//! it is recorded into an [`InputTrack`]'s segments, within a hard memory cap.
//!
//! The journal records into chunks of at most [`JOURNAL_CHUNK_TICKS`] ticks, each a self-contained
//! track segment. Its buffers (the chunks, the key table and the row scratch) never hold more than
//! [`JOURNAL_BYTES_MAX`]: before any growth it checks the cap, and past it the journal turns into a
//! ring that drops whole oldest chunks and keeps about the last [`JOURNAL_RING_TICKS`] ticks, with
//! `complete` false. A ring replays only from a snapshot anchor; otherwise it is a diagnostic.
//!
//! A tick the format cannot carry (a 257th key name, more fingers than a row holds) or a skipped
//! tick restarts the journal at the next tick it can carry, also with `complete` false. The facade
//! records each tick after the merge, before the update hooks run (the tick order in G6 INPUT).

use std::collections::VecDeque;

use genex_core::input::{MAX_KEY_NAME, PadStates, TickInput};

use crate::track::{
    InputTrack, KEY_TABLE_MAX, KeyTable, ROW_BYTES_MAX, Segment, TrackAnchor, TrackHeader, encode_row, pads_follow,
    predict, segment_base,
};

/// The most bytes the journal's buffers hold (1 MiB, a phone's budget).
pub const JOURNAL_BYTES_MAX: usize = 1024 * 1024;
/// The ticks a ring keeps at least, when its bytes allow (two minutes at 60 Hz).
pub const JOURNAL_RING_TICKS: u64 = 7200;
/// The most ticks one chunk holds: the ring's and the tail export's granularity.
pub const JOURNAL_CHUNK_TICKS: u64 = 1200;
/// The most row bytes one chunk holds, so a burst of heavy input still drops in small steps.
pub const JOURNAL_CHUNK_BYTES: usize = 64 * 1024;
/// The smallest step a chunk's buffer grows by.
const CHUNK_GROWTH_MIN: usize = 256;
/// What the key table and the row scratch may come to hold, kept free of chunks.
const FIXED_RESERVE: usize = KEY_TABLE_MAX * (size_of::<String>() + MAX_KEY_NAME) + ROW_BYTES_MAX;

/// What `state().__input.journal` shows.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct JournalView {
    /// Ticks the journal holds.
    pub ticks: u64,
    /// Encoded row bytes it holds.
    pub bytes: u64,
    /// Whether it holds every tick since its anchor.
    pub complete: bool,
}

/// One chunk: a track segment being written or closed.
#[derive(Clone, Debug)]
struct Chunk {
    start: u64,
    ticks: u64,
    rows: u64,
    last_row: Option<u64>,
    before: PadStates,
    bytes: Vec<u8>,
}

impl Chunk {
    fn new(start: u64, before: PadStates) -> Chunk {
        Chunk { start, ticks: 0, rows: 0, last_row: None, before, bytes: Vec::new() }
    }

    fn segment(&self) -> Segment {
        Segment { start: self.start, ticks: self.ticks, rows: self.rows, before: self.before, bytes: self.bytes.clone() }
    }
}

/// Records a run's tick input into a capped, replayable track.
#[derive(Clone, Debug)]
pub struct InputJournal {
    header: TrackHeader,
    anchor: TrackAnchor,
    complete: bool,
    ring: bool,
    keys: KeyTable,
    chunks: VecDeque<Chunk>,
    scratch: Vec<u8>,
    /// The next tick `record` expects.
    next_tick: u64,
    /// The prediction base: the last recorded tick's input (or the open chunk's start state).
    previous: TickInput,
}

impl InputJournal {
    /// A journal of the run since `seed()` (tick 0).
    pub fn new(header: TrackHeader) -> InputJournal {
        let mut journal = InputJournal {
            header,
            anchor: TrackAnchor::Seed,
            complete: true,
            ring: false,
            keys: KeyTable::default(),
            chunks: VecDeque::new(),
            scratch: Vec::new(),
            next_tick: 0,
            previous: TickInput::default(),
        };
        journal.restart(0, PadStates::default(), true);
        journal
    }

    /// Forget everything and journal from a snapshot taken before tick `tick`, whose previous tick
    /// left the pads at `before` (complete again).
    pub fn anchor_snapshot(&mut self, tick: u64, before: PadStates) {
        self.anchor = TrackAnchor::Snapshot;
        self.restart(tick, before, true);
    }

    /// Record tick `tick`'s merged input. A tick that does not follow the last one (or whose pads'
    /// edges do not follow the last tick's) restarts the journal at the tick after it and clears
    /// `complete`.
    pub fn record(&mut self, tick: u64, input: &TickInput) {
        let before = *self.previous.pads.states();
        if tick != self.next_tick || !pads_follow(&input.pads, &before) {
            self.skip(tick, input);
            return;
        }
        if self.open_is_full() {
            self.open_chunk(tick, before);
        }
        if self.write(tick, input).is_err() {
            self.skip(tick, input);
            return;
        }
        self.next_tick = tick.saturating_add(1);
        self.previous = input.clone();
    }

    /// The journal as a track (all it holds).
    pub fn track(&self) -> InputTrack {
        self.track_of(self.chunks.len())
    }

    /// The newest ticks that encode within `bytes_max` (a crash record's tail): whole chunks from
    /// the newest back; `complete` is false when any was left out.
    pub fn track_within(&self, bytes_max: usize) -> InputTrack {
        let mut count = self.chunks.len();
        while count > 0 && self.track_of(count).encode().len() > bytes_max {
            count -= 1;
        }
        self.track_of(count)
    }

    /// Ticks, bytes and completeness, for display.
    pub fn view(&self) -> JournalView {
        let ticks = self.chunks.iter().map(|chunk| chunk.ticks).sum();
        let bytes = self.chunks.iter().map(|chunk| chunk.bytes.len() as u64).sum();
        JournalView { ticks, bytes, complete: self.complete }
    }

    /// Heap bytes the journal's buffers hold; never more than [`JOURNAL_BYTES_MAX`].
    pub fn allocated(&self) -> usize {
        self.chunks_allocated() + self.keys.allocated() + self.scratch.capacity()
    }

    /// The newest `count` chunks as a track.
    fn track_of(&self, count: usize) -> InputTrack {
        let skip = self.chunks.len() - count;
        let segments: Vec<Segment> =
            self.chunks.iter().skip(skip).filter(|chunk| chunk.ticks > 0).map(Chunk::segment).collect();
        InputTrack {
            header: self.header.clone(),
            anchor: self.anchor,
            complete: self.complete && skip == 0,
            keys: self.keys.names.clone(),
            segments,
        }
    }

    /// Drop everything and start an empty chunk at `tick`.
    fn restart(&mut self, tick: u64, before: PadStates, complete: bool) {
        self.complete = complete;
        self.ring = false;
        self.keys = KeyTable::default();
        self.chunks = VecDeque::new();
        self.next_tick = tick;
        self.previous = segment_base(&before);
        self.open_chunk(tick, before);
    }

    /// A tick the journal cannot carry: start over at the tick after it.
    fn skip(&mut self, tick: u64, input: &TickInput) {
        self.restart(tick.saturating_add(1), *input.pads.states(), false);
    }

    fn open_is_full(&self) -> bool {
        self.chunks.back().is_none_or(|chunk| chunk.ticks >= JOURNAL_CHUNK_TICKS)
    }

    /// Close the open chunk and open one at `tick` from the state the pads left.
    fn open_chunk(&mut self, tick: u64, before: PadStates) {
        if let Some(open) = self.chunks.back_mut() {
            open.bytes.shrink_to_fit();
        }
        self.drop_past_ring();
        if self.chunks.len() == self.chunks.capacity() {
            let growth = self.chunks.capacity().max(4);
            self.make_room(growth * size_of::<Chunk>());
            self.chunks.reserve_exact(growth);
        }
        self.chunks.push_back(Chunk::new(tick, before));
        self.previous = segment_base(&before);
    }

    /// In ring mode, drop the oldest chunks the ring no longer needs.
    fn drop_past_ring(&mut self) {
        while self.ring && self.chunks.len() > 1 {
            let held: u64 = self.chunks.iter().map(|chunk| chunk.ticks).sum();
            let oldest = self.chunks.front().map_or(0, |chunk| chunk.ticks);
            if held - oldest < JOURNAL_RING_TICKS {
                return;
            }
            self.chunks.pop_front();
        }
    }

    /// Heap bytes of the chunks and their deque.
    fn chunks_allocated(&self) -> usize {
        let chunks: usize = self.chunks.iter().map(|chunk| chunk.bytes.capacity()).sum();
        chunks + self.chunks.capacity() * size_of::<Chunk>()
    }

    /// Free whole oldest chunks until `extra` more chunk bytes fit the cap beside the key table's
    /// and the scratch's reserve (the open chunk stays).
    fn make_room(&mut self, extra: usize) -> bool {
        while self.chunks_allocated() + extra + FIXED_RESERVE > JOURNAL_BYTES_MAX {
            if self.chunks.len() <= 1 {
                return false;
            }
            self.chunks.pop_front();
            self.ring = true;
            self.complete = false;
        }
        true
    }

    /// Encode `input` into the open chunk, opening a new one when it is full.
    fn write(&mut self, tick: u64, input: &TickInput) -> Result<(), ()> {
        if self.scratch.capacity() == 0 {
            self.scratch.reserve_exact(ROW_BYTES_MAX);
        }
        let row = self.encode(tick, input)?;
        let fits = self.chunks.back().is_some_and(|open| open.bytes.len() + row <= JOURNAL_CHUNK_BYTES);
        if !fits {
            let before = *self.previous.pads.states();
            self.open_chunk(tick, before);
            self.encode(tick, input)?;
        }
        self.append(tick)
    }

    /// Encode the row for `input` into the scratch buffer; its length (0 for a predicted tick).
    fn encode(&mut self, tick: u64, input: &TickInput) -> Result<usize, ()> {
        let open = self.chunks.back().ok_or(())?;
        let gap = tick - open.last_row.unwrap_or(open.start);
        self.scratch.clear();
        encode_row(&mut self.scratch, gap, &predict(&self.previous), input, &mut self.keys).map_err(|_| ())?;
        Ok(self.scratch.len())
    }

    /// Move the scratch row into the open chunk, growing it within the cap.
    fn append(&mut self, tick: u64) -> Result<(), ()> {
        let row = self.scratch.len();
        let (len, capacity) = self.chunks.back().map(|open| (open.bytes.len(), open.bytes.capacity())).ok_or(())?;
        let needed = len + row;
        if needed > capacity {
            let wanted = (capacity * 2).clamp(CHUNK_GROWTH_MIN, JOURNAL_CHUNK_BYTES).max(needed);
            if !self.make_room(wanted - capacity) {
                return Err(());
            }
            self.chunks.back_mut().ok_or(())?.bytes.reserve_exact(wanted - len);
        }
        let open = self.chunks.back_mut().ok_or(())?;
        open.bytes.extend_from_slice(&self.scratch);
        open.ticks += 1;
        if row > 0 {
            open.rows += 1;
            open.last_row = Some(tick);
        }
        Ok(())
    }
}
