//! The mesh arena: one growable buffer each for vertices, slots, indices, skin and meshlets, sub-allocated
//! per mesh, so adding a model uploads only its own bytes.
//!
//! The library ([`crate::scene::MeshLibrary`]) is the CPU mirror. Each sync writes only the rows the
//! library gained since the last one, at their offsets, so the 50th model costs its own bytes, not the
//! library's (the renderer re-uploaded every mesh on each add before game systems STR-1).
//!
//! - Ranges come from `offset-allocator` (MIT; Sebastian Aaltonen's OffsetAllocator ported by
//!   Patrick Walton), one allocator per stream in that stream's rows. While nothing is freed it
//!   hands out ranges back to back, which is the library's packing; STR-2 frees them.
//! - A full stream grows as Bevy's slab allocator grows a slab (MIT OR Apache-2.0, the rule ported,
//!   no code): a new buffer at twice the size, the live prefix copied buffer to buffer on the GPU.
//!   The CPU never uploads it again.
//! - No stream passes [`BUFFER_MAX_BYTES`] (WebGPU core's 128 MiB storage binding, inside its
//!   256 MiB buffer): past it the sync is refused `buffer-too-large` with nothing written.

use offset_allocator::{Allocation, Allocator};
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
/// Ranges one stream's allocator tracks (offset-allocator's default): one per add.
const RANGES_MAX: u32 = 128 * 1024;
/// Each allocator spans this many times the rows the cap allows, so the allocator's bin rounding
/// never refuses a range the cap admits (the cap is checked on bytes before allocating).
const ALLOCATOR_SPAN: u64 = 2;

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

    /// The most rows the cap admits.
    const fn max_rows(self) -> u64 {
        BUFFER_MAX_BYTES / self.stride() as u64
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
}

/// One stream: its buffer, the rows written into it and their ranges.
struct Stream<B> {
    buffer: B,
    capacity: u64,
    rows: u32,
    allocator: Allocator,
    ranges: Vec<Allocation>,
}

/// The library's streams on a GPU, each written only where the library grew.
pub struct MeshArena<B> {
    streams: Vec<Stream<B>>,
    stats: ArenaStats,
}

/// `bytes` as a buffer size: aligned, at least [`STREAM_MIN_BYTES`].
fn sized(bytes: u64) -> u64 {
    bytes.max(STREAM_MIN_BYTES).next_multiple_of(STREAM_ALIGN_BYTES)
}

/// A fresh allocator for `stream`'s rows.
fn allocator(stream: ArenaStream) -> Allocator {
    let span = (stream.max_rows() * ALLOCATOR_SPAN).min(u64::from(u32::MAX));
    Allocator::with_max_allocs(span as u32, RANGES_MAX)
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
            stats.uploaded_bytes += held.append(device, stream, bytes)?;
            streams.push(held);
        }
        Ok(MeshArena { streams, stats })
    }

    /// Write what the library gained since the last sync: per stream the rows past those held,
    /// growing a full buffer first. Refused with nothing written when a stream would pass the cap
    /// (`buffer-too-large`) or holds fewer rows than the arena (`mesh-invalid`: rows only grow
    /// until meshes can be removed; a re-clustered table goes through [`MeshArena::replace`]).
    pub fn sync<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, sources: &ArenaSources<'_>) -> Result<(), RenderError> {
        for stream in ArenaStream::ALL {
            let Some(bytes) = sources.bytes[stream.index()] else { continue };
            check_cap(stream, bytes.len())?;
            let held = self.streams[stream.index()].rows as usize * stream.stride() as usize;
            if bytes.len() < held || bytes.len() % stream.stride() as usize != 0 {
                let detail = format!("mesh {} of {} bytes for {held} held", stream.label(), bytes.len());
                return Err(RenderError::refused(RenderCode::MeshInvalid, detail));
            }
        }
        let before = self.stats;
        for stream in ArenaStream::ALL {
            let Some(bytes) = sources.bytes[stream.index()] else { continue };
            self.grow(device, stream, bytes.len() as u64)?;
            let held = &mut self.streams[stream.index()];
            let from = held.rows as usize * stream.stride() as usize;
            self.stats.uploaded_bytes += held.append(device, stream, &bytes[from..])?;
        }
        if self.stats != before {
            self.stats.syncs += 1;
        }
        Ok(())
    }

    /// Replace `stream` whole with `bytes` (a re-clustered meshlet table, or tables given back):
    /// a new buffer of exactly their size, written whole, its ranges forgotten.
    pub fn replace<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, bytes: &[u8]) -> Result<(), RenderError> {
        let mut held = Stream::made(device, stream, bytes.len())?;
        self.stats.uploaded_bytes += held.append(device, stream, bytes)?;
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

    /// Make `stream`'s buffer hold `need` bytes: twice its size or the need (aligned), whichever
    /// is larger, within the cap; the rows it holds are copied on the GPU.
    fn grow<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, need: u64) -> Result<(), RenderError> {
        let capacity = self.streams[stream.index()].capacity;
        if need <= capacity {
            return Ok(());
        }
        self.move_to(device, stream, sized(need).max(capacity * GROWTH_FACTOR).min(BUFFER_MAX_BYTES))
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

    /// Ranges allocated in `stream` (one per sync that gave it rows).
    pub fn ranges(&self, stream: ArenaStream) -> usize {
        self.streams[stream.index()].ranges.len()
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
        Ok(Stream { buffer: device.create(stream, capacity)?, capacity, rows: 0, allocator: allocator(stream), ranges: Vec::new() })
    }

    /// Allocate a range for `bytes` (whole rows) right after the rows held and write it; the bytes
    /// written. Refused `mesh-invalid` when the allocator places the range anywhere else (it
    /// cannot while nothing is freed).
    fn append<D: ArenaDevice<Buffer = B>>(&mut self, device: &mut D, stream: ArenaStream, bytes: &[u8]) -> Result<u64, RenderError> {
        let rows = (bytes.len() / stream.stride() as usize) as u32;
        if rows == 0 {
            return Ok(0);
        }
        let placed = self.allocator.allocate(rows).filter(|range| range.offset == self.rows);
        let Some(range) = placed else {
            let detail = format!("mesh {}: no range of {rows} rows after row {}", stream.label(), self.rows);
            return Err(RenderError::refused(RenderCode::MeshInvalid, detail));
        };
        device.write(&self.buffer, u64::from(self.rows) * u64::from(stream.stride()), bytes);
        self.ranges.push(range);
        self.rows += rows;
        Ok(bytes.len() as u64)
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
