//! The mesh arena: one growable buffer each for vertices, slots, indices, skin and meshlets, sub-allocated
//! per mesh, so adding a model uploads only its own bytes and removing one frees its rows for the next.
//!
//! The library ([`crate::scene::MeshLibrary`]) is the CPU mirror and places every mesh: each stream's
//! rows come from a [`RowAllocator`] (best fit over the freed ranges, else the end), so a removed
//! mesh's rows go to the next mesh that fits (game systems STR-2). Each sync writes only the rows the
//! library appended past those held and the freed rows it filled again, at their offsets, so the
//! 50th model costs its own bytes, not the library's (the renderer re-uploaded every mesh on each
//! add before STR-1).
//!
//! - A full stream grows as Bevy's slab allocator grows a slab (MIT OR Apache-2.0, the rule ported,
//!   no code): a new buffer at twice the size, the live prefix copied buffer to buffer on the GPU.
//!   The CPU never uploads it again. Growth is queue work recorded between frames (adds and removes
//!   take the renderer whole), so it lands before the next frame's commands and never inside a pass.
//! - No stream passes [`BUFFER_MAX_BYTES`] (WebGPU core's 128 MiB storage binding, inside its
//!   256 MiB buffer): past it the sync is refused `buffer-too-large` with nothing written.
//! - Growth holds the old and the new buffer at once until the copy is done. An arena with a peak
//!   limit ([`MeshArena::set_peak_limit`]: WebGPU and phones, [`ARENA_PEAK_MAX_BYTES_CONSTRAINED`])
//!   refuses a growth whose peak would pass it `stream-arena-full`, with nothing made or written,
//!   so the caller evicts first.

use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;

use wgpu::{Buffer, BufferUsages, CommandEncoder, Device, Queue};

use crate::caps::BUFFER_MAX_BYTES;
use crate::error::{RenderCode, RenderError};

/// The smallest stream buffer, so a stream with no rows still binds (as the frame tables').
const STREAM_MIN_BYTES: u64 = 256;
/// Stream buffers are sized in multiples of this (wgpu's copy alignment is 4).
const STREAM_ALIGN_BYTES: u64 = 16;
/// A full stream's buffer is remade this many times larger (Bevy's slab doubling): a library of
/// n bytes copies O(n) bytes on the GPU over all its growth.
const GROWTH_FACTOR: u64 = 2;
/// The peak bytes a mesh arena may hold during a growth (old and new buffers at once) on WebGPU and
/// phones: WebGPU's default `maxBufferSize`, the STREAM design's arena ceiling (3.3).
pub const ARENA_PEAK_MAX_BYTES_CONSTRAINED: u64 = 256 * 1024 * 1024;

/// One of the library's GPU streams.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ArenaStream {
    /// Vertices (also the skinning source and the meshlet draws' pulled vertices).
    Vertices,
    /// Each vertex's slot (its mesh id).
    Slots,
    /// Indices, mesh-local.
    Indices,
    /// Skinned meshes' joints and weights.
    Skin,
    /// The meshlet table.
    Meshlets,
    /// The meshlet vertex ids (library vertex ids).
    MeshletVertices,
    /// The packed meshlet triangles.
    MeshletTriangles,
}

impl ArenaStream {
    /// Every stream, in index order.
    pub const ALL: [ArenaStream; 7] = [
        ArenaStream::Vertices,
        ArenaStream::Slots,
        ArenaStream::Indices,
        ArenaStream::Skin,
        ArenaStream::Meshlets,
        ArenaStream::MeshletVertices,
        ArenaStream::MeshletTriangles,
    ];
    /// The meshlet tables, synced only while they are up.
    pub const MESHLET: [ArenaStream; 3] = [ArenaStream::Meshlets, ArenaStream::MeshletVertices, ArenaStream::MeshletTriangles];

    /// Its place in [`ArenaStream::ALL`] and [`ArenaSources::bytes`].
    pub const fn index(self) -> usize {
        self as usize
    }

    /// Bytes of one row.
    pub const fn stride(self) -> u32 {
        match self {
            ArenaStream::Vertices => size_of::<crate::mesh::Vertex>() as u32,
            ArenaStream::Skin => size_of::<crate::layout::GpuSkinVertex>() as u32,
            ArenaStream::Meshlets => crate::meshlet::MESHLET_RECORD_BYTES,
            ArenaStream::Slots | ArenaStream::Indices | ArenaStream::MeshletVertices | ArenaStream::MeshletTriangles => 4,
        }
    }

    /// Its buffer's label (the labels the library's buffers always had).
    pub const fn label(self) -> &'static str {
        match self {
            ArenaStream::Vertices => "vertices",
            ArenaStream::Slots => "slots",
            ArenaStream::Indices => "indices",
            ArenaStream::Skin => "skin",
            ArenaStream::Meshlets => "meshlets",
            ArenaStream::MeshletVertices => "meshlet vertices",
            ArenaStream::MeshletTriangles => "meshlet triangles",
        }
    }

    /// How the frame binds it (copies in and out are added for writes and growth).
    pub const fn usage(self) -> BufferUsages {
        match self {
            ArenaStream::Vertices => BufferUsages::VERTEX.union(BufferUsages::STORAGE),
            ArenaStream::Slots => BufferUsages::VERTEX,
            ArenaStream::Indices => BufferUsages::INDEX,
            ArenaStream::Skin | ArenaStream::Meshlets | ArenaStream::MeshletVertices | ArenaStream::MeshletTriangles => BufferUsages::STORAGE,
        }
    }
}

/// What the arena does to a GPU: make a buffer, write bytes into one, copy a prefix between two.
/// The renderer's is [`QueueDevice`]; the rows count through their own.
pub trait ArenaDevice {
    /// The device's buffer.
    type Buffer;
    /// A buffer of `bytes` for `stream` (refused past [`BUFFER_MAX_BYTES`]).
    fn create(&mut self, stream: ArenaStream, bytes: u64) -> Result<Self::Buffer, RenderError>;
    /// Write `bytes` at `offset` (both multiples of 4).
    fn write(&mut self, buffer: &Self::Buffer, offset: u64, bytes: &[u8]);
    /// Copy the first `bytes` of `from` into `to`.
    fn copy(&mut self, from: &Self::Buffer, to: &Self::Buffer, bytes: u64);
}

/// Per stream, the library's rows as bytes now; `None` leaves the stream as it is (the meshlet
/// tables while they are down).
#[derive(Clone, Copy, Debug)]
pub struct ArenaSources<'a> {
    /// By [`ArenaStream::index`].
    pub bytes: [Option<&'a [u8]>; 7],
}

impl<'a> ArenaSources<'a> {
    /// The library's streams; its meshlet tables only when `meshlets` (they are up).
    pub fn of(library: &'a crate::scene::MeshLibrary, meshlets: bool) -> ArenaSources<'a> {
        let tables = library.meshlets();
        let meshlet = |bytes: &'a [u8]| meshlets.then_some(bytes);
        ArenaSources {
            bytes: [
                Some(bytemuck::cast_slice(library.vertices())),
                Some(bytemuck::cast_slice(library.slots())),
                Some(bytemuck::cast_slice(library.indices())),
                Some(bytemuck::cast_slice(library.skin())),
                meshlet(bytemuck::cast_slice(&tables.meshlets)),
                meshlet(bytemuck::cast_slice(&tables.vertices)),
                meshlet(bytemuck::cast_slice(&tables.triangles)),
            ],
        }
    }
}

/// The arena's running counts since it was made.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ArenaStats {
    /// Bytes written from the CPU.
    pub uploaded_bytes: u64,
    /// Bytes copied buffer to buffer on the GPU when a stream grew.
    pub copied_bytes: u64,
    /// Times a stream's buffer was remade larger.
    pub grows: u64,
    /// Syncs that wrote or grew anything.
    pub syncs: u64,
    /// The most bytes the arena's buffers held at once: during a growth, the old buffers and the
    /// new ones together (game systems STR-2).
    pub peak_bytes: u64,
}

/// One stream: its buffer and the rows written into it.
struct Stream<B> {
    buffer: B,
    capacity: u64,
    rows: u32,
}

/// The library's streams on a GPU, each written only where the library changed.
pub struct MeshArena<B> {
    streams: Vec<Stream<B>>,
    stats: ArenaStats,
    /// The peak a growth may reach ([`MeshArena::set_peak_limit`]); None: only the per-stream cap.
    peak_limit: Option<u64>,
}

/// Rows of one stream the library wrote again inside the rows it held (a freed range filled by a
/// new mesh), for [`MeshArena::sync_with`].
pub type Rewrite = (ArenaStream, Range<u32>);

/// `bytes` as a buffer size: aligned, at least [`STREAM_MIN_BYTES`].
fn sized(bytes: u64) -> u64 {
    bytes.max(STREAM_MIN_BYTES).next_multiple_of(STREAM_ALIGN_BYTES)
}

/// Refused `buffer-too-large` when `bytes` of `stream` pass the cap.
fn check_cap(stream: ArenaStream, bytes: usize) -> Result<(), RenderError> {
    if bytes as u64 > BUFFER_MAX_BYTES {
        let detail = format!("{bytes} bytes of mesh {}, past the {BUFFER_MAX_BYTES}-byte binding", stream.label());
        return Err(RenderError::refused(RenderCode::BufferTooLarge, detail));
    }
    Ok(())
}

impl<B> MeshArena<B> {
    /// The streams of `sources` on `device`, each buffer exactly its rows (aligned) and written
    /// whole; a stream `sources` leaves out starts empty.
    pub fn new<D: ArenaDevice<Buffer = B>>(device: &mut D, sources: &ArenaSources<'_>) -> Result<MeshArena<B>, RenderError> {
        let mut streams = Vec::with_capacity(ArenaStream::ALL.len());
        let mut stats = ArenaStats::default();
        for stream in ArenaStream::ALL {
            let bytes = sources.bytes[stream.index()].unwrap_or_default();
            let mut held = Stream::made(device, stream, bytes.len())?;
            stats.uploaded_bytes += held.append(device, stream, bytes);
            streams.push(held);
        }
        let mut arena = MeshArena { streams, stats, peak_limit: None };
        arena.stats.peak_bytes = arena.bytes();
        Ok(arena)
    }

    /// Refuse a growth whose peak (the buffers held plus the new ones, the old still alive until
    /// their copy is done) would pass `limit` bytes, `stream-arena-full` (None: no limit but the
    /// per-stream cap).
    pub fn set_peak_limit(&mut self, limit: Option<u64>) {
        self.peak_limit = limit;
    }

    /// Bytes every stream's buffer holds room for.
    pub fn bytes(&self) -> u64 {
        self.streams.iter().map(|held| held.capacity).sum()
    }

    /// Write what the library appended since the last sync: per stream the rows past those held,
    /// growing a full buffer first. [`MeshArena::sync_with`] with no rewritten rows.
    pub fn sync<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, sources: &ArenaSources<'_>) -> Result<(), RenderError> {
        self.sync_with(device, sources, &[])
    }

    /// Write what the library changed since the last sync: per stream the rows past those held
    /// (growing a full buffer first), then each of `rewritten` inside the rows held before (a
    /// stream `sources` leaves out skips both). Refused with nothing written when a stream would
    /// pass the cap (`buffer-too-large`), holds fewer rows than the arena (`mesh-invalid`: the
    /// library never shrinks a stream; a re-clustered table goes through [`MeshArena::replace`])
    /// or a growth's peak would pass the limit (`stream-arena-full`).
    pub fn sync_with<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, sources: &ArenaSources<'_>, rewritten: &[Rewrite]) -> Result<(), RenderError> {
        self.check_sync(sources)?;
        self.check_peak(sources)?;
        let before = self.stats;
        let held: Vec<u32> = self.streams.iter().map(|held| held.rows).collect();
        for stream in ArenaStream::ALL {
            let Some(bytes) = sources.bytes[stream.index()] else { continue };
            self.grow(device, stream, bytes.len() as u64)?;
            let held = &mut self.streams[stream.index()];
            let from = held.rows as usize * stream.stride() as usize;
            self.stats.uploaded_bytes += held.append(device, stream, &bytes[from..]);
        }
        for (stream, rows) in rewritten {
            let Some(bytes) = sources.bytes[stream.index()] else { continue };
            let end = rows.end.min(held[stream.index()]);
            if rows.start >= end {
                continue;
            }
            let stride = stream.stride() as usize;
            let range = rows.start as usize * stride..end as usize * stride;
            device.write(&self.streams[stream.index()].buffer, range.start as u64, &bytes[range.clone()]);
            self.stats.uploaded_bytes += range.len() as u64;
        }
        if self.stats != before {
            self.stats.syncs += 1;
        }
        Ok(())
    }

    /// Refused when a stream of `sources` passes the cap or holds fewer rows than the arena.
    fn check_sync(&self, sources: &ArenaSources<'_>) -> Result<(), RenderError> {
        for stream in ArenaStream::ALL {
            let Some(bytes) = sources.bytes[stream.index()] else { continue };
            check_cap(stream, bytes.len())?;
            let held = self.streams[stream.index()].rows as usize * stream.stride() as usize;
            if bytes.len() < held || bytes.len() % stream.stride() as usize != 0 {
                let detail = format!("mesh {} of {} bytes for {held} held", stream.label(), bytes.len());
                return Err(RenderError::refused(RenderCode::MeshInvalid, detail));
            }
        }
        Ok(())
    }

    /// Refused `stream-arena-full` when the growths `sources` needs would, with the buffers held,
    /// pass the peak limit; records the peak otherwise.
    fn check_peak(&mut self, sources: &ArenaSources<'_>) -> Result<(), RenderError> {
        let grown: u64 = ArenaStream::ALL
            .into_iter()
            .filter_map(|stream| sources.bytes[stream.index()].map(|bytes| self.grown_capacity(stream, bytes.len() as u64)))
            .flatten()
            .sum();
        let peak = self.bytes() + grown;
        if let Some(limit) = self.peak_limit.filter(|limit| peak > *limit) {
            let detail = format!("growing the mesh arena would hold {peak} bytes at once, past its {limit}-byte limit");
            return Err(RenderError::refused(RenderCode::StreamArenaFull, detail));
        }
        self.stats.peak_bytes = self.stats.peak_bytes.max(peak);
        Ok(())
    }

    /// Replace `stream` whole with `bytes` (a re-clustered meshlet table, or tables given back):
    /// a new buffer of exactly their size, written whole.
    pub fn replace<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, bytes: &[u8]) -> Result<(), RenderError> {
        let mut held = Stream::made(device, stream, bytes.len())?;
        self.stats.uploaded_bytes += held.append(device, stream, bytes);
        self.streams[stream.index()] = held;
        Ok(())
    }

    /// Give `stream` room for `bytes` now (a device class's start size, STREAM design 3.3, applied
    /// by whoever owns the budget), clamped to the cap; the rows it holds move on the GPU.
    pub fn reserve<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, bytes: u64) -> Result<(), RenderError> {
        let capacity = sized(bytes.min(BUFFER_MAX_BYTES));
        if capacity <= self.streams[stream.index()].capacity {
            return Ok(());
        }
        self.move_to(device, stream, capacity)
    }

    /// The capacity `stream` grows to for `need` bytes: twice its size or the need (aligned),
    /// whichever is larger, within the cap; None when it holds room already.
    fn grown_capacity(&self, stream: ArenaStream, need: u64) -> Option<u64> {
        let capacity = self.streams[stream.index()].capacity;
        (need > capacity).then(|| sized(need).max(capacity * GROWTH_FACTOR).min(BUFFER_MAX_BYTES))
    }

    /// Make `stream`'s buffer hold `need` bytes ([`MeshArena::grown_capacity`]); the rows it holds
    /// are copied on the GPU.
    fn grow<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, need: u64) -> Result<(), RenderError> {
        match self.grown_capacity(stream, need) {
            Some(capacity) => self.move_to(device, stream, capacity),
            None => Ok(()),
        }
    }

    /// Remake `stream`'s buffer at `capacity` bytes, the rows it holds copied on the GPU.
    fn move_to<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, capacity: u64) -> Result<(), RenderError> {
        let held = &mut self.streams[stream.index()];
        let buffer = device.create(stream, capacity)?;
        let live = u64::from(held.rows) * u64::from(stream.stride());
        if live > 0 {
            device.copy(&held.buffer, &buffer, live);
        }
        (held.buffer, held.capacity) = (buffer, capacity);
        self.stats.copied_bytes += live;
        self.stats.grows += 1;
        Ok(())
    }

    /// `stream`'s buffer.
    pub fn buffer(&self, stream: ArenaStream) -> &B {
        &self.streams[stream.index()].buffer
    }

    /// Bytes `stream`'s buffer holds room for.
    pub fn capacity(&self, stream: ArenaStream) -> u64 {
        self.streams[stream.index()].capacity
    }

    /// Rows written into `stream`.
    pub fn rows(&self, stream: ArenaStream) -> u32 {
        self.streams[stream.index()].rows
    }

    /// The running counts.
    pub fn stats(&self) -> ArenaStats {
        self.stats
    }
}

impl<B> Stream<B> {
    /// An empty stream whose buffer holds exactly `bytes` (aligned); refused past the cap.
    fn made<D: ArenaDevice<Buffer = B>>(device: &mut D, stream: ArenaStream, bytes: usize) -> Result<Stream<B>, RenderError> {
        check_cap(stream, bytes)?;
        let capacity = sized(bytes as u64);
        Ok(Stream { buffer: device.create(stream, capacity)?, capacity, rows: 0 })
    }

    /// Write `bytes` (whole rows) right after the rows held; the bytes written.
    fn append<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, bytes: &[u8]) -> u64 {
        let rows = (bytes.len() / stream.stride() as usize) as u32;
        if rows == 0 {
            return 0;
        }
        device.write(&self.buffer, u64::from(self.rows) * u64::from(stream.stride()), bytes);
        self.rows += rows;
        bytes.len() as u64
    }
}

/// Where a library stream's rows go: best fit over the freed ranges (the smallest that holds
/// them, the lowest offset among equals), else at the end. Freed neighbours merge, and a free
/// range that reaches the end gives it back, so a library with no removals packs its meshes back
/// to back in add order, as it always did. Deterministic: ordered maps, no hashing, no time.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RowAllocator {
    /// One past the last row in use.
    end: u32,
    /// Free ranges below `end`: offset to rows.
    free: BTreeMap<u32, u32>,
    /// The same ranges by (rows, offset), for the best fit.
    by_size: BTreeSet<(u32, u32)>,
}

impl RowAllocator {
    /// The first row of a range of `rows` rows, or None when it would end past `u32::MAX` (no
    /// rows take nothing and answer the end).
    pub fn allocate(&mut self, rows: u32) -> Option<u32> {
        if rows == 0 {
            return Some(self.end);
        }
        if let Some(&(size, offset)) = self.by_size.range((rows, 0)..).next() {
            self.take_free(offset, size);
            if size > rows {
                self.put_free(offset + rows, size - rows);
            }
            return Some(offset);
        }
        let offset = self.end;
        self.end = offset.checked_add(rows)?;
        Some(offset)
    }

    /// Give back `rows` rows at `offset` (a range [`RowAllocator::allocate`] handed out).
    pub fn free(&mut self, offset: u32, rows: u32) {
        if rows == 0 {
            return;
        }
        let (mut start, mut size) = (offset, rows);
        if let Some((&before, &before_size)) = self.free.range(..start).next_back().filter(|(at, len)| **at + **len == start) {
            self.take_free(before, before_size);
            (start, size) = (before, before_size + size);
        }
        if let Some(&after_size) = self.free.get(&(start + size)) {
            self.take_free(start + size, after_size);
            size += after_size;
        }
        if start + size == self.end {
            self.end = start;
            return;
        }
        self.put_free(start, size);
    }

    /// One past the last row in use (the stream's live span).
    pub fn end(&self) -> u32 {
        self.end
    }

    /// Rows free below [`RowAllocator::end`].
    pub fn free_rows(&self) -> u64 {
        self.free.values().map(|rows| u64::from(*rows)).sum()
    }

    fn take_free(&mut self, offset: u32, rows: u32) {
        self.free.remove(&offset);
        self.by_size.remove(&(rows, offset));
    }

    fn put_free(&mut self, offset: u32, rows: u32) {
        self.free.insert(offset, rows);
        self.by_size.insert((rows, offset));
    }
}

/// The renderer's arena device: buffers from `device`, writes through `queue`, growth copies
/// recorded on one encoder that [`QueueDevice::finish`] submits.
pub struct QueueDevice<'a> {
    device: &'a Device,
    queue: &'a Queue,
    encoder: Option<CommandEncoder>,
}

impl<'a> QueueDevice<'a> {
    /// An arena device over `device` and `queue`.
    pub fn new(device: &'a Device, queue: &'a Queue) -> QueueDevice<'a> {
        QueueDevice { device, queue, encoder: None }
    }

    /// Submit the growth copies, if any. Writes queued before go first (wgpu flushes
    /// `write_buffer` ahead of the next submission), writes after land after the copy, and the
    /// two never overlap: a copy moves rows below those written into the new buffer.
    pub fn finish(self) {
        if let Some(encoder) = self.encoder {
            self.queue.submit([encoder.finish()]);
        }
    }
}

impl ArenaDevice for QueueDevice<'_> {
    type Buffer = Buffer;

    fn create(&mut self, stream: ArenaStream, bytes: u64) -> Result<Buffer, RenderError> {
        crate::tables::buffer(self.device, stream.label(), bytes, stream.usage() | BufferUsages::COPY_DST | BufferUsages::COPY_SRC)
    }

    fn write(&mut self, buffer: &Buffer, offset: u64, bytes: &[u8]) {
        self.queue.write_buffer(buffer, offset, bytes);
    }

    fn copy(&mut self, from: &Buffer, to: &Buffer, bytes: u64) {
        let device = self.device;
        let encoder = self.encoder.get_or_insert_with(|| device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("mesh arena growth") }));
        encoder.copy_buffer_to_buffer(from, 0, to, 0, bytes);
    }
}
