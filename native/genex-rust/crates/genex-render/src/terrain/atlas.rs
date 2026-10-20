//! The terrain tile atlas (game systems STR-21): many height tiles resident at once for a streamed
//! world, each in a fixed-size slot of one storage table.
//!
//! Ported from bevy_terrain (https://github.com/kurtkuehnert/bevy_terrain,
//! `src/terrain_data/tile_atlas.rs`, `TileAtlasState`; Kurt Kühnert, MIT OR Apache-2.0, used here
//! under Apache 2.0). What is kept: a request count per tile; a tile whose count falls to zero
//! stays resident with its slot appended to a queue of unused slots, oldest first, and is revived
//! without a load when it is requested again before that slot is taken; a new tile takes the slot at
//! the front of that queue (a never-used slot first, then the tile released longest ago); and
//! [`TileAtlas::best_tile`] walks up the parents to the nearest loaded tile, so a tile still loading
//! draws its ancestor (graceful degradation). Changed by Genex (Apache 2.0 §4(b)):
//! - running out of slots refuses `stream-arena-full` with nothing changed, where upstream panics
//!   "Atlas out of indices";
//! - a completion for a tile that is not loading (finished twice, evicted, never requested) is
//!   dropped and answers `None`, where upstream panics; one tile is one load (no attachment count);
//! - a request for a tile still loading tells the caller so ([`TileRequest`]'s `loading`), so a
//!   residency policy that cancelled the load can issue it again;
//! - the tile table is a `BTreeMap` and the unused queue a `VecDeque` of slots, so the same requests
//!   give the same slots and evictions on every target (no hashing); there is no list of existing
//!   tiles, no file IO and no Bevy resource: the caller loads the words and hands them to
//!   [`TileAtlasGpu::upload`];
//! - the slot count comes from the device's form factor and the WebGPU core 128 MiB storage binding
//!   ([`atlas_slots`]), not a fixed 64.
//!
//! A slot holds one tile in the single terrain's layout ([`super::gpu::maps`]): its packed heights,
//! its control words, then its normal pyramid, so the terrain shader reads a slot as it reads the
//! whole terrain, offset by [`TileAtlasGpu::slot_offset_words`] (multi-tile selection: STR-22).

use std::collections::{BTreeMap, VecDeque};

use wgpu::{Buffer, BufferUsages, Device, Queue};

use super::{TerrainDesc, check_samples, invalid, normal_level_sizes};
use crate::caps::BUFFER_MAX_BYTES;
use crate::device_class::FormFactor;
use crate::error::{RenderCode, RenderError};
use crate::tables::buffer;

/// The coarsest tile level: level 0 is the finest, each level up halves the coordinates, and the
/// walk to a loaded ancestor stops here.
pub const MAX_TILE_LEVEL: u32 = 15;
/// The most slots a desktop atlas has (fewer when its tiles are large: the binding caps it).
pub const DESKTOP_ATLAS_SLOTS: u32 = 256;
/// The most slots a phone's atlas has.
pub const MOBILE_ATLAS_SLOTS: u32 = 64;
/// The most bytes a phone's table holds: half of mobile-low's 96 MiB content pool, so large tiles
/// get fewer slots there instead of the whole 128 MiB binding.
pub const MOBILE_ATLAS_MAX_BYTES: u64 = 48 * 1024 * 1024;
/// The bytes of a table word.
const WORD_BYTES: u64 = 4;

/// A tile of the streamed terrain: its level (0 the finest) and its column and row at that level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct TileCoord {
    /// The level, 0 the finest, at most [`MAX_TILE_LEVEL`].
    pub level: u32,
    /// The column at this level.
    pub x: u32,
    /// The row at this level.
    pub z: u32,
}

impl TileCoord {
    /// The tile at column `x`, row `z` of `level`.
    pub const fn new(level: u32, x: u32, z: u32) -> TileCoord {
        TileCoord { level, x, z }
    }

    /// The tile one level up that covers this one; `None` at [`MAX_TILE_LEVEL`].
    pub const fn parent(self) -> Option<TileCoord> {
        if self.level >= MAX_TILE_LEVEL {
            return None;
        }
        Some(TileCoord { level: self.level + 1, x: self.x / 2, z: self.z / 2 })
    }
}

/// Where a tile's data stands.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileState {
    /// It has a slot and its load has not finished.
    Loading,
    /// Its words are in its slot.
    Loaded,
}

/// What a request did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileRequest {
    /// The tile was already requested: one more requester holds it.
    Held {
        /// Its slot.
        slot: u32,
        /// Its load has not finished.
        loading: bool,
    },
    /// The tile was released but still in its slot: revived without a load.
    Revived {
        /// Its slot.
        slot: u32,
        /// Its load has not finished (issue it again if it was cancelled).
        loading: bool,
    },
    /// The tile was not resident: load its words into `slot`, then [`TileAtlasGpu::upload`] them.
    Load {
        /// The slot it takes.
        slot: u32,
        /// The released tile that held the slot and is gone now.
        evicted: Option<TileCoord>,
    },
}

/// A resident tile's slot, state and request count.
#[derive(Clone, Copy, Debug)]
struct TileEntry {
    slot: u32,
    state: TileState,
    requests: u32,
}

/// The atlas's bookkeeping: which tile holds which slot, what is requested, what may be evicted.
/// Pure (no GPU), so the same requests give the same slots on every target.
#[derive(Clone, Debug)]
pub struct TileAtlas {
    slots: u32,
    tiles: BTreeMap<TileCoord, TileEntry>,
    /// Each slot's tile, if any.
    owners: Vec<Option<TileCoord>>,
    /// Slots a new tile may take, front first: never-used slots in order, then released tiles'
    /// slots in release order.
    unused: VecDeque<u32>,
}

impl TileAtlas {
    /// An atlas of `slots` slots, all unused; refused `stream-arena-full` for none.
    pub fn new(slots: u32) -> Result<TileAtlas, RenderError> {
        if slots == 0 {
            return Err(RenderError::refused(RenderCode::StreamArenaFull, "terrain atlas: no slots"));
        }
        Ok(TileAtlas { slots, tiles: BTreeMap::new(), owners: vec![None; slots as usize], unused: (0..slots).collect() })
    }

    /// One more requester of `coord`: held, revived, or a load into a free slot (evicting the tile
    /// released longest ago). Refused `stream-arena-full`, with nothing changed, when every slot
    /// is held by a requested tile.
    pub fn request(&mut self, coord: TileCoord) -> Result<TileRequest, RenderError> {
        if let Some(entry) = self.tiles.get_mut(&coord) {
            let loading = entry.state == TileState::Loading;
            let slot = entry.slot;
            entry.requests += 1;
            if entry.requests > 1 {
                return Ok(TileRequest::Held { slot, loading });
            }
            self.unused.retain(|&unused| unused != slot);
            return Ok(TileRequest::Revived { slot, loading });
        }
        let Some(slot) = self.unused.pop_front() else {
            return Err(RenderError::refused(RenderCode::StreamArenaFull, format!("terrain atlas: all {} slots hold requested tiles", self.slots)));
        };
        let evicted = self.owners[slot as usize].replace(coord);
        if let Some(gone) = evicted {
            self.tiles.remove(&gone);
        }
        self.tiles.insert(coord, TileEntry { slot, state: TileState::Loading, requests: 1 });
        Ok(TileRequest::Load { slot, evicted })
    }

    /// One requester fewer of `coord`. At none the tile stays in its slot (still answering
    /// [`TileAtlas::best_tile`]) until a new tile needs the slot. False, with nothing changed, when
    /// nobody requested it.
    pub fn release(&mut self, coord: TileCoord) -> bool {
        let Some(entry) = self.tiles.get_mut(&coord) else { return false };
        if entry.requests == 0 {
            return false;
        }
        entry.requests -= 1;
        if entry.requests == 0 {
            self.unused.push_back(entry.slot);
        }
        true
    }

    /// Mark `coord`'s load finished: its slot, or `None` (the completion is dropped) when the tile
    /// is not loading: finished already, evicted, or never requested.
    pub fn finish(&mut self, coord: TileCoord) -> Option<u32> {
        let entry = self.tiles.get_mut(&coord)?;
        if entry.state != TileState::Loading {
            return None;
        }
        entry.state = TileState::Loaded;
        Some(entry.slot)
    }

    /// The nearest loaded tile at or above `coord` and its slot: the tile itself once loaded,
    /// otherwise its closest loaded ancestor; `None` when none up to [`MAX_TILE_LEVEL`] is.
    pub fn best_tile(&self, coord: TileCoord) -> Option<(TileCoord, u32)> {
        let mut at = Some(coord);
        while let Some(tile) = at {
            if let Some(entry) = self.tiles.get(&tile).filter(|entry| entry.state == TileState::Loaded) {
                return Some((tile, entry.slot));
            }
            at = tile.parent();
        }
        None
    }

    /// Where `coord`'s data stands, `None` when it has no slot.
    pub fn state(&self, coord: TileCoord) -> Option<TileState> {
        self.tiles.get(&coord).map(|entry| entry.state)
    }

    /// How many requesters hold `coord` (0 when released or not resident).
    pub fn requests(&self, coord: TileCoord) -> u32 {
        self.tiles.get(&coord).map_or(0, |entry| entry.requests)
    }

    /// The slots in all.
    pub const fn slots(&self) -> u32 {
        self.slots
    }

    /// The slots a new tile may take (never used, or held by a released tile).
    pub fn free_slots(&self) -> u32 {
        self.unused.len() as u32
    }
}

/// The most slots an atlas has on a device of `form` (phones fewer).
pub const fn atlas_slot_cap(form: FormFactor) -> u32 {
    match form {
        FormFactor::Desktop => DESKTOP_ATLAS_SLOTS,
        FormFactor::Mobile => MOBILE_ATLAS_SLOTS,
    }
}

/// The most bytes an atlas table holds on a device of `form`: the 128 MiB storage binding on a
/// desktop, [`MOBILE_ATLAS_MAX_BYTES`] on a phone.
pub const fn atlas_byte_cap(form: FormFactor) -> u64 {
    match form {
        FormFactor::Desktop => BUFFER_MAX_BYTES,
        FormFactor::Mobile => MOBILE_ATLAS_MAX_BYTES,
    }
}

/// The words one square tile of `samples` a side holds in a slot: its packed heights, a control
/// word per sample and its normal pyramid. Refused `mesh-invalid` outside the terrain's sample
/// range.
pub fn tile_slot_words(samples: u32) -> Result<u64, RenderError> {
    check_samples((samples, samples))?;
    let count = u64::from(samples) * u64::from(samples);
    let normals: u64 = normal_level_sizes((samples, samples)).iter().map(|&(w, d)| u64::from(w) * u64::from(d)).sum();
    Ok(count.div_ceil(2) + count + normals)
}

/// The slots an atlas of `samples`-a-side tiles has on a device of `form`: the class cap, fewer
/// when the table would pass its byte cap ([`atlas_byte_cap`]), and at least one (a 2049-sample
/// tile is 46 MB, under every cap).
pub fn atlas_slots(form: FormFactor, samples: u32) -> Result<u32, RenderError> {
    let slot_bytes = tile_slot_words(samples)? * WORD_BYTES;
    let fit = (atlas_byte_cap(form) / slot_bytes).clamp(1, u64::from(u32::MAX)) as u32;
    Ok(fit.min(atlas_slot_cap(form)))
}

/// One tile's slot words ([`super::gpu::maps`]); refused `mesh-invalid` when the tile is not
/// square at `samples` a side or does not check.
pub fn tile_words(desc: &TerrainDesc, samples: u32) -> Result<Vec<u32>, RenderError> {
    let got = desc.heights.samples();
    if got != (samples, samples) {
        return Err(invalid(format!("a tile of {} x {} samples in an atlas of {samples} x {samples}", got.0, got.1)));
    }
    desc.check()?;
    Ok(super::gpu::maps(desc))
}

/// The atlas on the GPU: its bookkeeping and the one storage table its slots live in.
pub struct TileAtlasGpu {
    atlas: TileAtlas,
    slot_words: u64,
    table: Buffer,
}

impl TileAtlasGpu {
    /// An atlas of `samples`-a-side tiles with the slots [`atlas_slots`] gives a device of `form`,
    /// its table made (`mesh-invalid` for a sample count out of range).
    pub fn new(device: &Device, form: FormFactor, samples: u32) -> Result<TileAtlasGpu, RenderError> {
        let slot_words = tile_slot_words(samples)?;
        let atlas = TileAtlas::new(atlas_slots(form, samples)?)?;
        let bytes = u64::from(atlas.slots()) * slot_words * WORD_BYTES;
        let table = buffer(device, "terrain atlas", bytes, BufferUsages::STORAGE | BufferUsages::COPY_DST | BufferUsages::COPY_SRC)?;
        Ok(TileAtlasGpu { atlas, slot_words, table })
    }

    /// The bookkeeping.
    pub const fn atlas(&self) -> &TileAtlas {
        &self.atlas
    }

    /// The bookkeeping, to request and release tiles.
    pub const fn atlas_mut(&mut self) -> &mut TileAtlas {
        &mut self.atlas
    }

    /// Finish `coord`'s load with `words` ([`tile_words`]): written into its slot, whose index
    /// comes back. `Ok(None)`, with nothing written, when the tile is not loading (its load
    /// finished, it was evicted or never requested); refused `mesh-invalid`, with nothing changed,
    /// when `words` is not one slot long.
    pub fn upload(&mut self, queue: &Queue, coord: TileCoord, words: &[u32]) -> Result<Option<u32>, RenderError> {
        if words.len() as u64 != self.slot_words {
            return Err(invalid(format!("{} words for a {}-word atlas slot", words.len(), self.slot_words)));
        }
        let Some(slot) = self.atlas.finish(coord) else { return Ok(None) };
        queue.write_buffer(&self.table, self.slot_offset_words(slot) * WORD_BYTES, bytemuck::cast_slice(words));
        Ok(Some(slot))
    }

    /// Where `slot` starts in the table, in words.
    pub const fn slot_offset_words(&self, slot: u32) -> u64 {
        slot as u64 * self.slot_words
    }

    /// The words of one slot.
    pub const fn slot_words(&self) -> u64 {
        self.slot_words
    }

    /// The table (bound as a read-only storage buffer).
    pub const fn buffer(&self) -> &Buffer {
        &self.table
    }

    /// The table's bytes, all held from creation (the content pool's terrain row counts these).
    pub fn resident_bytes(&self) -> u64 {
        self.table.size()
    }
}
