//! The input track (format 1): the merged tick input of a run, tick by tick, so a replay feeds
//! `Hooks::tick` exactly what the run read, bypassing the merger. With the seed and the bindings
//! the header carries, it reproduces the checksum of every tick (the determinism promise is
//! (seed, bindings digest, TickInput rows)).
//!
//! The bytes are little-endian and LEB128 varints throughout (postcard's integer encoding), with
//! no `usize` on the wire, so a track encodes to the same bytes on every destination. f32 values
//! are carried as their bits, so a replay reads the very bits the run read (NaN payloads and the
//! sign of zero included).
//!
//! ```text
//! track    = "GXIT" format:v flags:u8 seed:v contract:v width:v height:v digest:u64le
//!            blob_len:v blob keys:v (len:v name)* segments:v segment*
//! segment  = start:v ticks:v rows:v pads_mask:u8 pad* bytes:v row*
//! row      = gap:v mask:v [held] [pressed] [released] [look] [wheel] [pointer] [lock]
//!            [pads] [text] [touches]
//! ```
//!
//! A segment starts from a known state: no key held, the pointer centred and unlocked, no finger
//! down, and the pads of the tick before it (`pad*`, so a pad edge on the first tick replays).
//! Every later tick is predicted from the one before it: the same keys held, no edge, no delta,
//! the same pointer and pads, no text, and every finger still down held. A tick equal to its
//! prediction writes no row; a row writes only the fields that differ. The first row's gap counts
//! from the segment start (it may be 0), every later row's from the row before (at least 1).
//! Segments are contiguous, so a ring journal that dropped its oldest ticks exports the rest as
//! a track starting later. Anything that does not parse, overflows a cap or a tick, or leaves a
//! byte unread is refused `input-track-invalid` as a whole: there is no partial track.

use genex_core::input::{
    Keys, MAX_KEY_NAME, MAX_PADS, MAX_TEXT_UNITS, MAX_TOUCH_ACTIONS, MAX_TOUCHES, PAD_AXES, PAD_BUTTONS, PadState,
    PadStates, Pads, TickInput, TouchPhase, TouchPoint, Vec2, canonical_key,
};
use genex_core::pad_family::PadFamily;

use crate::blob::BINDINGS_BLOB_BYTES_MAX;
use crate::error::{InputError, InputErrorCode};

/// The track format this crate writes and reads.
pub const TRACK_FORMAT: u64 = 1;
/// The bytes every track starts with.
pub const TRACK_MAGIC: [u8; 4] = *b"GXIT";
/// The largest track read, in bytes; a larger one is refused `input-track-too-large`.
pub const TRACK_BYTES_MAX: usize = 16 * 1024 * 1024;
/// The most distinct key names one track names.
pub const KEY_TABLE_MAX: usize = 256;
/// The most segments one track holds.
pub const SEGMENTS_MAX: usize = 4096;
/// The most fingers lifted on one tick a row carries (the merger's per-injection cap).
pub const TRACK_LIFTED_MAX: usize = MAX_TOUCH_ACTIONS;
/// The longest row the encoder writes: every list at its cap, every pad, the longest text.
pub const ROW_BYTES_MAX: usize = 8 * 1024;
/// The most text bytes one tick carries (four UTF-8 bytes per two UTF-16 units at most).
const TEXT_BYTES_MAX: usize = MAX_TEXT_UNITS * 4;

const FLAG_COMPLETE: u8 = 1;
const FLAG_SNAPSHOT: u8 = 1 << 1;
const FLAGS_KNOWN: u8 = FLAG_COMPLETE | FLAG_SNAPSHOT;

const ROW_HELD: u64 = 1;
const ROW_PRESSED: u64 = 1 << 1;
const ROW_RELEASED: u64 = 1 << 2;
const ROW_LOOK: u64 = 1 << 3;
const ROW_WHEEL: u64 = 1 << 4;
const ROW_POINTER: u64 = 1 << 5;
const ROW_LOCK: u64 = 1 << 6;
const ROW_PADS: u64 = 1 << 7;
const ROW_TEXT: u64 = 1 << 8;
const ROW_TOUCHES: u64 = 1 << 9;
const ROW_KNOWN: u64 = (1 << 10) - 1;

const PAD_CONNECTED: u8 = 1;
const PAD_CONNECTED_ON: u8 = 1 << 1;
const PAD_FAMILY: u8 = 1 << 2;
const PAD_BUTTONS_CHANGED: u8 = 1 << 3;
const PAD_AXES_CHANGED: u8 = 1 << 4;
const PAD_KNOWN: u8 = (1 << 5) - 1;

/// Touch phases in wire order.
const PHASES: [TouchPhase; 4] = [TouchPhase::Began, TouchPhase::Held, TouchPhase::Ended, TouchPhase::Tapped];

/// Where a track's first tick stands.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TrackAnchor {
    /// Tick 0 after `seed()`: a replay resets the world on the seed and runs from there.
    #[default]
    Seed,
    /// A save snapshot's tick: a replay restores that snapshot first.
    Snapshot,
}

impl TrackAnchor {
    /// The display spelling (`state().__input.journal`, a crash record).
    pub const fn as_str(self) -> &'static str {
        match self {
            TrackAnchor::Seed => "seed",
            TrackAnchor::Snapshot => "snapshot",
        }
    }
}

/// What a replay must match before it reads a track's rows.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct TrackHeader {
    /// The seed the run started on.
    pub seed: u32,
    /// The runtime contract version.
    pub contract: u32,
    /// The world size in pixels.
    pub world: [u32; 2],
    /// The bindings digest (`ActionMap::digest`) the run evaluated with.
    pub bindings_digest: u64,
    /// The bindings file (`ActionMap::to_blob`) behind that digest; empty for defaults.
    pub bindings: Vec<u8>,
}

/// One contiguous run of ticks, its rows still encoded (validated when read).
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Segment {
    pub(crate) start: u64,
    pub(crate) ticks: u64,
    pub(crate) rows: u64,
    pub(crate) before: PadStates,
    pub(crate) bytes: Vec<u8>,
}

/// A recorded run's tick input: a header, the key names its rows index, and contiguous segments.
#[derive(Clone, Debug, PartialEq)]
pub struct InputTrack {
    pub(crate) header: TrackHeader,
    pub(crate) anchor: TrackAnchor,
    pub(crate) complete: bool,
    pub(crate) keys: Vec<String>,
    pub(crate) segments: Vec<Segment>,
}

impl InputTrack {
    /// The header a replay checks.
    pub fn header(&self) -> &TrackHeader {
        &self.header
    }

    /// Whether the first tick is the seed's or a snapshot's.
    pub fn anchor(&self) -> TrackAnchor {
        self.anchor
    }

    /// Whether every tick since the anchor is here (false once a ring dropped its oldest ticks).
    pub fn complete(&self) -> bool {
        self.complete
    }

    /// The first tick the track holds.
    pub fn start_tick(&self) -> u64 {
        self.segments.first().map_or(0, |segment| segment.start)
    }

    /// How many ticks the track holds.
    pub fn ticks(&self) -> u64 {
        self.segments.iter().map(|segment| segment.ticks).sum()
    }

    /// `input-track-mismatch` unless the track was recorded for this seed, contract, world size
    /// and bindings digest.
    pub fn check(&self, seed: u32, contract: u32, world: [u32; 2], bindings_digest: u64) -> Result<(), InputError> {
        let header = &self.header;
        let same = header.seed == seed
            && header.contract == contract
            && header.world == world
            && header.bindings_digest == bindings_digest;
        if same {
            return Ok(());
        }
        Err(InputError::new(InputErrorCode::TrackMismatch, "the track was recorded for another seed, contract, world or bindings"))
    }

    /// The track's bytes (format 1); equal tracks encode to equal bytes on every destination.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        write_header(&mut out, &self.header, self.anchor, self.complete);
        put_varint(&mut out, self.keys.len() as u64);
        for name in &self.keys {
            put_bytes(&mut out, name.as_bytes());
        }
        put_varint(&mut out, self.segments.len() as u64);
        for segment in &self.segments {
            write_segment(&mut out, segment);
        }
        out
    }

    /// Read a track whole: a hostile or damaged one is refused and nothing of it is kept.
    pub fn decode(bytes: &[u8]) -> Result<InputTrack, InputError> {
        if bytes.len() > TRACK_BYTES_MAX {
            let detail = format!("{} bytes is over the {TRACK_BYTES_MAX}-byte track cap", bytes.len());
            return Err(InputError::new(InputErrorCode::TrackTooLarge, detail));
        }
        let mut reader = Reader { bytes, at: 0 };
        let (header, anchor, complete) = read_header(&mut reader)?;
        let keys = read_keys(&mut reader)?;
        let count = reader.count(SEGMENTS_MAX, "segments")?;
        let mut segments = Vec::with_capacity(count);
        let mut next: Option<u64> = None;
        for _ in 0..count {
            let segment = read_segment(&mut reader, &keys)?;
            if next.is_some_and(|tick| tick != segment.start) {
                return Err(invalid("segments are not contiguous"));
            }
            next = Some(segment.start.checked_add(segment.ticks).ok_or_else(|| invalid("the tick count overflows"))?);
            segments.push(segment);
        }
        if reader.at != bytes.len() {
            return Err(invalid("bytes follow the last segment"));
        }
        Ok(InputTrack { header, anchor, complete, keys, segments })
    }

    /// Every tick's input in order, with its tick number: what `Hooks::tick` reads on replay.
    pub fn inputs(&self) -> TrackInputs<'_> {
        TrackInputs { track: self, segment: 0, cursor: None }
    }
}

/// The ticks of a track in order (see [`InputTrack::inputs`]).
pub struct TrackInputs<'a> {
    track: &'a InputTrack,
    segment: usize,
    cursor: Option<Cursor<'a>>,
}

impl Iterator for TrackInputs<'_> {
    type Item = (u64, TickInput);

    fn next(&mut self) -> Option<(u64, TickInput)> {
        loop {
            if self.cursor.is_none() {
                let segment = self.track.segments.get(self.segment)?;
                self.segment += 1;
                self.cursor = Some(Cursor::new(segment, &self.track.keys));
            }
            let cursor = self.cursor.as_mut()?;
            // The track was validated whole when it was decoded or built, so a cursor never fails.
            match cursor.next_tick() {
                Ok(Some(item)) => return Some(item),
                Ok(None) | Err(_) => self.cursor = None,
            }
        }
    }
}

/// A refusal of a damaged or hostile track.
fn invalid(detail: &str) -> InputError {
    InputError::new(InputErrorCode::TrackInvalid, detail)
}

/// Why the encoder could not write a tick: the journal starts a new segment after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Unencodable {
    /// A key name past the key table's cap.
    KeyTableFull,
    /// More fingers down or lifted than a row carries, or longer text.
    OverCap,
}

/// The key names rows index, in first-use order.
#[derive(Clone, Debug, Default)]
pub(crate) struct KeyTable {
    pub(crate) names: Vec<String>,
}

impl KeyTable {
    fn index(&mut self, name: &str) -> Result<u64, Unencodable> {
        if let Some(at) = self.names.iter().position(|known| known == name) {
            return Ok(at as u64);
        }
        if self.names.len() >= KEY_TABLE_MAX || name.len() > MAX_KEY_NAME {
            return Err(Unencodable::KeyTableFull);
        }
        if self.names.capacity() == 0 {
            self.names.reserve_exact(KEY_TABLE_MAX);
        }
        self.names.push(name.to_owned());
        Ok((self.names.len() - 1) as u64)
    }

    /// Heap bytes the table holds.
    pub(crate) fn allocated(&self) -> usize {
        self.names.capacity() * size_of::<String>() + self.names.iter().map(String::capacity).sum::<usize>()
    }
}

/// The input of a segment's tick before its first: nothing held, the pads of the tick before.
pub(crate) fn segment_base(before: &PadStates) -> TickInput {
    let mut base = TickInput::default();
    base.pads.assign(*before, *before);
    base
}

/// The prediction for the tick after `previous` (see the module docs).
pub(crate) fn predict(previous: &TickInput) -> TickInput {
    let mut next = TickInput::default();
    next.keys.assign(previous.keys.held().to_vec(), Vec::new(), Vec::new());
    next.pointer = previous.pointer;
    next.pointer_lock = previous.pointer_lock;
    let now = *previous.pads.states();
    next.pads.assign(now, now);
    next.touches = previous
        .touches
        .iter()
        .filter(|point| is_down(point.phase))
        .map(|point| TouchPoint { phase: TouchPhase::Held, ..*point })
        .collect();
    next
}

/// Whether `pads` reads as `now` after `before` (the merger's pads always do).
pub(crate) fn pads_follow(pads: &Pads, before: &PadStates) -> bool {
    let mut expected = Pads::default();
    expected.assign(*pads.states(), *before);
    expected == *pads
}

fn is_down(phase: TouchPhase) -> bool {
    matches!(phase, TouchPhase::Began | TouchPhase::Held)
}

fn same_vec2(a: Vec2, b: Vec2) -> bool {
    a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits()
}

fn same_touches(a: &[TouchPoint], b: &[TouchPoint]) -> bool {
    let same = |p: &TouchPoint, q: &TouchPoint| {
        p.id == q.id && p.phase == q.phase && p.x.to_bits() == q.x.to_bits() && p.y.to_bits() == q.y.to_bits()
    };
    a.len() == b.len() && a.iter().zip(b).all(|(p, q)| same(p, q))
}

fn same_pad(a: &PadState, b: &PadState) -> bool {
    pad_changes(a, b) == 0
}

/// Which of a pad's parts differ from `predicted`, as `PAD_*` bits (without the value bit).
fn pad_changes(actual: &PadState, predicted: &PadState) -> u8 {
    let mut bits = 0;
    if actual.connected != predicted.connected {
        bits |= PAD_CONNECTED;
    }
    if actual.family != predicted.family {
        bits |= PAD_FAMILY;
    }
    if bit_mask(&actual.buttons, &predicted.buttons) != 0 {
        bits |= PAD_BUTTONS_CHANGED;
    }
    if bit_mask(&actual.axes, &predicted.axes) != 0 {
        bits |= PAD_AXES_CHANGED;
    }
    bits
}

/// Which values differ bit for bit, as a mask by index.
fn bit_mask(actual: &[f32], predicted: &[f32]) -> u64 {
    actual
        .iter()
        .zip(predicted)
        .enumerate()
        .filter(|(_, (a, p))| a.to_bits() != p.to_bits())
        .fold(0, |mask, (at, _)| mask | (1 << at))
}

/// Which row fields of `actual` differ from `predicted`.
fn row_mask(predicted: &TickInput, actual: &TickInput) -> u64 {
    let fields = [
        (ROW_HELD, actual.keys.held() != predicted.keys.held()),
        (ROW_PRESSED, !actual.keys.pressed_keys().is_empty()),
        (ROW_RELEASED, !actual.keys.released_keys().is_empty()),
        (ROW_LOOK, !same_vec2(actual.look, predicted.look)),
        (ROW_WHEEL, !same_vec2(actual.wheel, predicted.wheel)),
        (ROW_POINTER, !same_vec2(actual.pointer, predicted.pointer)),
        (ROW_LOCK, actual.pointer_lock != predicted.pointer_lock),
        (ROW_PADS, !pads_same(actual.pads.states(), predicted.pads.states())),
        (ROW_TEXT, !actual.text.is_empty()),
        (ROW_TOUCHES, !same_touches(&actual.touches, &predicted.touches)),
    ];
    fields.iter().filter(|(_, differs)| *differs).fold(0, |mask, (bit, _)| mask | bit)
}

fn pads_same(a: &PadStates, b: &PadStates) -> bool {
    a.iter().zip(b).all(|(p, q)| same_pad(p, q))
}

/// Append the row for `actual` after `predicted` at `gap`; `Ok(false)` (nothing written) when
/// the tick is its prediction. On an error `out` is left as it was.
pub(crate) fn encode_row(
    out: &mut Vec<u8>,
    gap: u64,
    predicted: &TickInput,
    actual: &TickInput,
    keys: &mut KeyTable,
) -> Result<bool, Unencodable> {
    let mask = row_mask(predicted, actual);
    if mask == 0 {
        return Ok(false);
    }
    let mark = out.len();
    let written = write_row(out, gap, mask, predicted, actual, keys);
    if written.is_err() {
        out.truncate(mark);
    }
    written.map(|()| true)
}

fn write_row(
    out: &mut Vec<u8>,
    gap: u64,
    mask: u64,
    predicted: &TickInput,
    actual: &TickInput,
    keys: &mut KeyTable,
) -> Result<(), Unencodable> {
    put_varint(out, gap);
    put_varint(out, mask);
    let lists = [
        (ROW_HELD, actual.keys.held()),
        (ROW_PRESSED, actual.keys.pressed_keys()),
        (ROW_RELEASED, actual.keys.released_keys()),
    ];
    for (bit, names) in lists {
        if mask & bit != 0 {
            write_key_list(out, names, keys)?;
        }
    }
    let vectors = [(ROW_LOOK, actual.look), (ROW_WHEEL, actual.wheel), (ROW_POINTER, actual.pointer)];
    for (bit, value) in vectors {
        if mask & bit != 0 {
            put_f32(out, value.x);
            put_f32(out, value.y);
        }
    }
    if mask & ROW_LOCK != 0 {
        out.push(u8::from(actual.pointer_lock));
    }
    if mask & ROW_PADS != 0 {
        write_pads(out, actual.pads.states(), predicted.pads.states());
    }
    if mask & ROW_TEXT != 0 {
        if actual.text.len() > TEXT_BYTES_MAX || utf16_units(&actual.text) > MAX_TEXT_UNITS {
            return Err(Unencodable::OverCap);
        }
        put_bytes(out, actual.text.as_bytes());
    }
    if mask & ROW_TOUCHES != 0 {
        write_touches(out, &actual.touches)?;
    }
    Ok(())
}

fn write_key_list(out: &mut Vec<u8>, names: &[String], keys: &mut KeyTable) -> Result<(), Unencodable> {
    if names.len() > KEY_TABLE_MAX {
        return Err(Unencodable::KeyTableFull);
    }
    put_varint(out, names.len() as u64);
    for name in names {
        put_varint(out, keys.index(name)?);
    }
    Ok(())
}

fn write_pads(out: &mut Vec<u8>, actual: &PadStates, predicted: &PadStates) {
    let changed: u8 = (0..MAX_PADS).filter(|&at| !same_pad(&actual[at], &predicted[at])).fold(0, |m, at| m | (1 << at));
    out.push(changed);
    for at in (0..MAX_PADS).filter(|at| changed & (1 << at) != 0) {
        write_pad(out, &actual[at], &predicted[at]);
    }
}

fn write_pad(out: &mut Vec<u8>, actual: &PadState, predicted: &PadState) {
    let mut bits = pad_changes(actual, predicted);
    if bits & PAD_CONNECTED != 0 && actual.connected {
        bits |= PAD_CONNECTED_ON;
    }
    out.push(bits);
    if bits & PAD_FAMILY != 0 {
        out.push(family_index(actual.family));
    }
    if bits & PAD_BUTTONS_CHANGED != 0 {
        let mask = bit_mask(&actual.buttons, &predicted.buttons);
        put_varint(out, mask);
        put_masked(out, &actual.buttons, mask);
    }
    if bits & PAD_AXES_CHANGED != 0 {
        let mask = bit_mask(&actual.axes, &predicted.axes);
        out.push(mask as u8);
        put_masked(out, &actual.axes, mask);
    }
}

fn put_masked(out: &mut Vec<u8>, values: &[f32], mask: u64) {
    for (at, value) in values.iter().enumerate() {
        if mask & (1 << at) != 0 {
            put_f32(out, *value);
        }
    }
}

fn write_touches(out: &mut Vec<u8>, touches: &[TouchPoint]) -> Result<(), Unencodable> {
    let down = touches.iter().filter(|point| is_down(point.phase)).count();
    if down > MAX_TOUCHES || touches.len() - down > TRACK_LIFTED_MAX {
        return Err(Unencodable::OverCap);
    }
    put_varint(out, touches.len() as u64);
    for point in touches {
        put_varint(out, u64::from(point.id));
        out.push(PHASES.iter().position(|phase| *phase == point.phase).unwrap_or(0) as u8);
        put_f32(out, point.x);
        put_f32(out, point.y);
    }
    Ok(())
}

fn family_index(family: PadFamily) -> u8 {
    PadFamily::ALL.iter().position(|known| *known == family).unwrap_or(0) as u8
}

fn utf16_units(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

fn write_header(out: &mut Vec<u8>, header: &TrackHeader, anchor: TrackAnchor, complete: bool) {
    out.extend_from_slice(&TRACK_MAGIC);
    put_varint(out, TRACK_FORMAT);
    let mut flags = 0;
    if complete {
        flags |= FLAG_COMPLETE;
    }
    if anchor == TrackAnchor::Snapshot {
        flags |= FLAG_SNAPSHOT;
    }
    out.push(flags);
    put_varint(out, u64::from(header.seed));
    put_varint(out, u64::from(header.contract));
    put_varint(out, u64::from(header.world[0]));
    put_varint(out, u64::from(header.world[1]));
    out.extend_from_slice(&header.bindings_digest.to_le_bytes());
    put_bytes(out, &header.bindings);
}

fn write_segment(out: &mut Vec<u8>, segment: &Segment) {
    put_varint(out, segment.start);
    put_varint(out, segment.ticks);
    put_varint(out, segment.rows);
    let defaults = PadState::default();
    let present: u8 =
        (0..MAX_PADS).filter(|&at| !same_pad(&segment.before[at], &defaults)).fold(0, |m, at| m | (1 << at));
    out.push(present);
    for at in (0..MAX_PADS).filter(|at| present & (1 << at) != 0) {
        write_pad(out, &segment.before[at], &defaults);
    }
    put_bytes(out, &segment.bytes);
}

/// Append `value` as a LEB128 varint.
pub(crate) fn put_varint(out: &mut Vec<u8>, value: u64) {
    let mut rest = value;
    while rest >= 0x80 {
        out.push((rest as u8) | 0x80);
        rest >>= 7;
    }
    out.push(rest as u8);
}

fn put_f32(out: &mut Vec<u8>, value: f32) {
    out.extend_from_slice(&value.to_bits().to_le_bytes());
}

fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_varint(out, bytes.len() as u64);
    out.extend_from_slice(bytes);
}

/// A bounds-checked reader over a track's bytes.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn remaining(&self) -> usize {
        self.bytes.len() - self.at
    }

    fn byte(&mut self) -> Result<u8, InputError> {
        let byte = *self.bytes.get(self.at).ok_or_else(|| invalid("the track is truncated"))?;
        self.at += 1;
        Ok(byte)
    }

    fn varint(&mut self) -> Result<u64, InputError> {
        let mut value: u64 = 0;
        for shift in (0..64).step_by(7) {
            let byte = self.byte()?;
            let part = u64::from(byte & 0x7f);
            if shift == 63 && part > 1 {
                return Err(invalid("a varint overflows 64 bits"));
            }
            value |= part << shift;
            if byte & 0x80 == 0 {
                return Ok(value);
            }
        }
        Err(invalid("a varint is longer than ten bytes"))
    }

    fn u32(&mut self) -> Result<u32, InputError> {
        u32::try_from(self.varint()?).map_err(|_| invalid("a value overflows 32 bits"))
    }

    fn f32(&mut self) -> Result<f32, InputError> {
        let bytes = self.take(4)?;
        Ok(f32::from_bits(u32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]])))
    }

    fn take(&mut self, len: usize) -> Result<&'a [u8], InputError> {
        if len > self.remaining() {
            return Err(invalid("the track is truncated"));
        }
        let taken = &self.bytes[self.at..self.at + len];
        self.at += len;
        Ok(taken)
    }

    /// A length prefix of at most `max`.
    fn count(&mut self, max: usize, what: &str) -> Result<usize, InputError> {
        let value = self.varint()?;
        usize::try_from(value).ok().filter(|&count| count <= max).ok_or_else(|| invalid(&format!("too many {what}")))
    }

    fn bytes(&mut self, max: usize, what: &str) -> Result<&'a [u8], InputError> {
        let len = self.count(max, what)?;
        self.take(len)
    }
}

fn read_header(reader: &mut Reader<'_>) -> Result<(TrackHeader, TrackAnchor, bool), InputError> {
    if reader.take(TRACK_MAGIC.len())? != TRACK_MAGIC {
        return Err(invalid("not an input track"));
    }
    if reader.varint()? != TRACK_FORMAT {
        return Err(invalid("an input track format this runtime does not read"));
    }
    let flags = reader.byte()?;
    if flags & !FLAGS_KNOWN != 0 {
        return Err(invalid("unknown track flags"));
    }
    let anchor = if flags & FLAG_SNAPSHOT != 0 { TrackAnchor::Snapshot } else { TrackAnchor::Seed };
    let seed = reader.u32()?;
    let contract = reader.u32()?;
    let world = [reader.u32()?, reader.u32()?];
    let digest = reader.take(8)?;
    let mut digest_bytes = [0; 8];
    digest_bytes.copy_from_slice(digest);
    let bindings = reader.bytes(BINDINGS_BLOB_BYTES_MAX, "bindings bytes")?.to_vec();
    let header = TrackHeader { seed, contract, world, bindings_digest: u64::from_le_bytes(digest_bytes), bindings };
    Ok((header, anchor, flags & FLAG_COMPLETE != 0))
}

fn read_keys(reader: &mut Reader<'_>) -> Result<Vec<String>, InputError> {
    let count = reader.count(KEY_TABLE_MAX, "key names")?;
    let mut keys = Vec::with_capacity(count);
    for _ in 0..count {
        let bytes = reader.bytes(MAX_KEY_NAME, "key name bytes")?;
        let name = std::str::from_utf8(bytes).map_err(|_| invalid("a key name is not UTF-8"))?;
        // Only canonical names replay as the run read them.
        if name.is_empty() || canonical_key(name) != name || keys.iter().any(|known| known == name) {
            return Err(invalid("a key name is not a canonical key or repeats"));
        }
        keys.push(name.to_owned());
    }
    Ok(keys)
}

fn read_segment(reader: &mut Reader<'_>, keys: &[String]) -> Result<Segment, InputError> {
    let start = reader.varint()?;
    let ticks = reader.varint()?;
    let rows = reader.varint()?;
    if ticks == 0 {
        return Err(invalid("a segment holds no tick"));
    }
    let present = reader.byte()?;
    if present >> MAX_PADS != 0 {
        return Err(invalid("a pad past the table"));
    }
    let defaults = PadStates::default();
    let mut before = defaults;
    for at in (0..MAX_PADS).filter(|at| present & (1 << at) != 0) {
        before[at] = read_pad(reader, &defaults[at])?;
    }
    let bytes = reader.bytes(TRACK_BYTES_MAX, "segment bytes")?.to_vec();
    // Every row takes at least two bytes (a gap and a mask): refuse a count the bytes cannot hold
    // before walking them.
    if rows > ticks || rows > (bytes.len() / 2) as u64 {
        return Err(invalid("a segment's row count overflows its bytes"));
    }
    let segment = Segment { start, ticks, rows, before, bytes };
    validate_segment(&segment, keys)?;
    Ok(segment)
}

fn validate_segment(segment: &Segment, keys: &[String]) -> Result<(), InputError> {
    let mut cursor = Cursor::new(segment, keys);
    while cursor.next_tick()?.is_some() {}
    if cursor.rows_read != segment.rows || cursor.reader.remaining() != 0 {
        return Err(invalid("a segment's rows do not match its count"));
    }
    Ok(())
}

/// Walks one segment tick by tick, decoding rows as their ticks come.
struct Cursor<'a> {
    segment: &'a Segment,
    keys: &'a [String],
    reader: Reader<'a>,
    rows_read: u64,
    /// The next tick to yield.
    tick: u64,
    /// The tick of the next row, once its gap is read.
    next_row: Option<u64>,
    /// The tick of the last row read (the segment start before the first).
    last_row: Option<u64>,
    previous: TickInput,
}

impl<'a> Cursor<'a> {
    fn new(segment: &'a Segment, keys: &'a [String]) -> Cursor<'a> {
        Cursor {
            segment,
            keys,
            reader: Reader { bytes: &segment.bytes, at: 0 },
            rows_read: 0,
            tick: segment.start,
            next_row: None,
            last_row: None,
            previous: segment_base(&segment.before),
        }
    }

    fn end(&self) -> u64 {
        self.segment.start.saturating_add(self.segment.ticks)
    }

    /// The tick of the next row, reading its gap when it is due; None after the last row.
    fn peek_row(&mut self) -> Result<Option<u64>, InputError> {
        if self.next_row.is_some() || self.rows_read == self.segment.rows {
            return Ok(self.next_row);
        }
        let gap = self.reader.varint()?;
        let first = self.last_row.is_none();
        if !first && gap == 0 {
            return Err(invalid("a row's tick goes backwards or repeats"));
        }
        let from = self.last_row.unwrap_or(self.segment.start);
        let tick = from.checked_add(gap).ok_or_else(|| invalid("a row's tick gap overflows"))?;
        if tick >= self.end() {
            return Err(invalid("a row's tick is past its segment"));
        }
        self.next_row = Some(tick);
        Ok(self.next_row)
    }

    fn next_tick(&mut self) -> Result<Option<(u64, TickInput)>, InputError> {
        if self.tick >= self.end() {
            return Ok(None);
        }
        let predicted = predict(&self.previous);
        let input = if self.peek_row()? == Some(self.tick) {
            let input = read_row(&mut self.reader, self.keys, predicted)?;
            self.rows_read += 1;
            self.last_row = Some(self.tick);
            self.next_row = None;
            input
        } else {
            predicted
        };
        let tick = self.tick;
        self.tick += 1;
        self.previous = input.clone();
        Ok(Some((tick, input)))
    }
}

fn read_row(reader: &mut Reader<'_>, keys: &[String], predicted: TickInput) -> Result<TickInput, InputError> {
    let mask = reader.varint()?;
    if mask == 0 || mask & !ROW_KNOWN != 0 {
        return Err(invalid("a row's field mask is empty or unknown"));
    }
    let mut input = predicted;
    let held = read_key_list(reader, keys, mask & ROW_HELD != 0)?.unwrap_or_else(|| input.keys.held().to_vec());
    let pressed = read_key_list(reader, keys, mask & ROW_PRESSED != 0)?.unwrap_or_default();
    let released = read_key_list(reader, keys, mask & ROW_RELEASED != 0)?.unwrap_or_default();
    let mut keys_now = Keys::default();
    keys_now.assign(held, pressed, released);
    input.keys = keys_now;
    if mask & ROW_LOOK != 0 {
        input.look = read_vec2(reader)?;
    }
    if mask & ROW_WHEEL != 0 {
        input.wheel = read_vec2(reader)?;
    }
    if mask & ROW_POINTER != 0 {
        input.pointer = read_vec2(reader)?;
    }
    if mask & ROW_LOCK != 0 {
        input.pointer_lock = read_bool(reader)?;
    }
    if mask & ROW_PADS != 0 {
        let before = *input.pads.states();
        let now = read_pads(reader, &before)?;
        input.pads.assign(now, before);
    }
    if mask & ROW_TEXT != 0 {
        input.text = read_text(reader)?;
    }
    if mask & ROW_TOUCHES != 0 {
        input.touches = read_touches(reader)?;
    }
    Ok(input)
}

fn read_key_list(reader: &mut Reader<'_>, keys: &[String], present: bool) -> Result<Option<Vec<String>>, InputError> {
    if !present {
        return Ok(None);
    }
    let count = reader.count(KEY_TABLE_MAX, "keys in a list")?;
    let mut names = Vec::with_capacity(count);
    for _ in 0..count {
        let index = reader.varint()?;
        let name = usize::try_from(index).ok().and_then(|at| keys.get(at)).ok_or_else(|| invalid("a key index past the table"))?;
        names.push(name.clone());
    }
    Ok(Some(names))
}

fn read_vec2(reader: &mut Reader<'_>) -> Result<Vec2, InputError> {
    Ok(Vec2 { x: reader.f32()?, y: reader.f32()? })
}

fn read_bool(reader: &mut Reader<'_>) -> Result<bool, InputError> {
    match reader.byte()? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(invalid("a flag is neither 0 nor 1")),
    }
}

fn read_pads(reader: &mut Reader<'_>, before: &PadStates) -> Result<PadStates, InputError> {
    let changed = reader.byte()?;
    if changed == 0 || changed >> MAX_PADS != 0 {
        return Err(invalid("a pad mask is empty or names a pad past the table"));
    }
    let mut now = *before;
    for at in (0..MAX_PADS).filter(|at| changed & (1 << at) != 0) {
        now[at] = read_pad(reader, &before[at])?;
    }
    Ok(now)
}

fn read_pad(reader: &mut Reader<'_>, predicted: &PadState) -> Result<PadState, InputError> {
    let bits = reader.byte()?;
    let value_without_change = bits & PAD_CONNECTED_ON != 0 && bits & PAD_CONNECTED == 0;
    if bits == 0 || bits & !PAD_KNOWN != 0 || value_without_change {
        return Err(invalid("a pad's change bits are empty or unknown"));
    }
    let mut pad = *predicted;
    if bits & PAD_CONNECTED != 0 {
        pad.connected = bits & PAD_CONNECTED_ON != 0;
    }
    if bits & PAD_FAMILY != 0 {
        let index = usize::from(reader.byte()?);
        pad.family = *PadFamily::ALL.get(index).ok_or_else(|| invalid("an unknown pad family"))?;
    }
    if bits & PAD_BUTTONS_CHANGED != 0 {
        let mask = reader.varint()?;
        read_masked(reader, &mut pad.buttons, mask, PAD_BUTTONS)?;
    }
    if bits & PAD_AXES_CHANGED != 0 {
        let mask = u64::from(reader.byte()?);
        read_masked(reader, &mut pad.axes, mask, PAD_AXES)?;
    }
    Ok(pad)
}

fn read_masked(reader: &mut Reader<'_>, values: &mut [f32], mask: u64, len: usize) -> Result<(), InputError> {
    if mask == 0 || mask >> len != 0 {
        return Err(invalid("a pad value mask is empty or past the table"));
    }
    for (at, value) in values.iter_mut().enumerate() {
        if mask & (1 << at) != 0 {
            *value = reader.f32()?;
        }
    }
    Ok(())
}

fn read_text(reader: &mut Reader<'_>) -> Result<String, InputError> {
    let bytes = reader.bytes(TEXT_BYTES_MAX, "text bytes")?;
    let text = std::str::from_utf8(bytes).map_err(|_| invalid("text is not UTF-8"))?;
    if text.is_empty() || utf16_units(text) > MAX_TEXT_UNITS {
        return Err(invalid("text is empty or longer than a tick carries"));
    }
    Ok(text.to_owned())
}

fn read_touches(reader: &mut Reader<'_>) -> Result<Vec<TouchPoint>, InputError> {
    let count = reader.count(MAX_TOUCHES + TRACK_LIFTED_MAX, "touches")?;
    let mut touches = Vec::with_capacity(count);
    for _ in 0..count {
        let id = reader.u32()?;
        let phase = *PHASES.get(usize::from(reader.byte()?)).ok_or_else(|| invalid("an unknown touch phase"))?;
        let (x, y) = (reader.f32()?, reader.f32()?);
        touches.push(TouchPoint { id, x, y, phase });
    }
    let down = touches.iter().filter(|point| is_down(point.phase)).count();
    if down > MAX_TOUCHES || count - down > TRACK_LIFTED_MAX {
        return Err(invalid("more fingers than a tick carries"));
    }
    Ok(touches)
}
