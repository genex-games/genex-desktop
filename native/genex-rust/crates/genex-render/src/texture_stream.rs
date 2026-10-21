//! Texture mip streaming (game systems STR-17): which mip rung each streamed texture is resident
//! at, what to load next and what to drop under a pool cut. Pure and GPU-free: the presenter feeds
//! each frame's sight (screen pixels per metre at the texture's nearest use), writes the layers a
//! [`StreamPlan`] asks for and reports each one landed; the plan never shows a rung whose layer has
//! not landed, so a swap is never one black frame.
//!
//! - **Rungs.** A texture is resident at its tail (the levels up to [`TAIL_SIDE`], loaded with its
//!   cell) or at a size class's whole chain (`layout::TEXTURE_SIZE_CLASSES`), never above its own
//!   side. KTX 2.0 stores levels smallest first, so a promotion from rung `a` to `b` reads one byte
//!   range ([`head_range`]) and the levels assembled from the tail and the head are bit-equal to the
//!   whole file's ([`crate::texture::Ktx2Index::assemble`], STR-18).
//! - **Wanted rung.** The texels a use needs across one UV unit are its screen pixels per metre over
//!   the mesh's UV density (UV units per metre, the asset index's `uvDensity`, C-29; Unity's
//!   mipmap-streaming idea): the smallest rung at least that wide.
//! - **Hysteresis.** A texture changes rung at most once per [`RUNG_CHANGE_FRAMES_MIN`] frames,
//!   jumping straight to its wanted rung, and steps down only once it needs at most
//!   [`DEMOTE_FRACTION`] of the lower rung, so a texture at a rung's edge never flickers.
//! - **Pool.** The ledger is exact: [`TextureStream::resident_bytes`] is the sum of every shown
//!   rung's chain plus every load in flight. Loads go most needed first while they fit the pool; a
//!   pool cut cancels loads in flight, then drops the least needed (farthest) textures to their
//!   tails at once (the tail is always resident).
//! - Deterministic: textures are kept in id order and ties break by id, so the same sights give the
//!   same plans on every destination.

use std::ops::Range;

use crate::layout::TEXTURE_SIZE_CLASSES;
use crate::texture::{Ktx2Index, TextureFamily};

/// The side of the tail every streamed texture keeps resident from its cell's load.
pub const TAIL_SIDE: u32 = 64;
/// The fewest frames between two rung changes of one texture.
pub const RUNG_CHANGE_FRAMES_MIN: u64 = 8;
/// A texture steps down a rung once it needs at most this share of the lower rung's side.
pub const DEMOTE_FRACTION: f32 = 0.75;
/// The most textures one stream tracks.
pub const STREAMED_TEXTURES_MAX: usize = 4096;
/// The UV density read when a mesh has none (no UVs, or an index from before C-29).
const UV_DENSITY_DEFAULT: f32 = 1.0;

/// A streamed texture's handle.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StreamedId(u32);

/// A rung change the presenter carries out: load the chain at `to` (from the head range when
/// promoting), write it into a layer of `to`'s class and report [`TextureStream::landed`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RungChange {
    /// The texture.
    pub id: StreamedId,
    /// The rung it shows until the load lands.
    pub from: u32,
    /// The rung it shows once the load lands.
    pub to: u32,
    /// The bytes the change books in the ledger (the chain at `to`).
    pub bytes: u64,
}

/// One frame's plan.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreamPlan {
    /// Loads to start, most needed first.
    pub loads: Vec<RungChange>,
    /// Textures the pool cut dropped to their tails on this frame (their big layers may go now).
    pub dropped: Vec<RungChange>,
}

#[derive(Clone, Debug, PartialEq)]
struct Entry {
    side: u32,
    family: TextureFamily,
    uv_density: f32,
    shown: u32,
    loading: Option<u32>,
    last_change: Option<u64>,
    /// Texels per UV unit this frame's largest use needs (0: unseen).
    needed: f32,
}

/// The residency of every streamed texture.
#[derive(Clone, Debug, PartialEq)]
pub struct TextureStream {
    entries: Vec<Option<Entry>>,
    pool_bytes: u64,
    frame: u64,
}

impl TextureStream {
    /// No textures, a pool of `pool_bytes`.
    pub fn new(pool_bytes: u64) -> TextureStream {
        TextureStream { entries: Vec::new(), pool_bytes, frame: 0 }
    }

    /// Track a texture `side` texels wide in `family`, used by meshes of `uv_density` UV units per
    /// metre (None: 1), resident at its tail. None past [`STREAMED_TEXTURES_MAX`].
    pub fn add(&mut self, side: u32, family: TextureFamily, uv_density: Option<f32>) -> Option<StreamedId> {
        let usable = uv_density.filter(|density| density.is_finite() && *density > 0.0);
        let entry = Entry {
            side,
            family,
            uv_density: usable.unwrap_or(UV_DENSITY_DEFAULT),
            shown: tail_of(side),
            loading: None,
            last_change: None,
            needed: 0.0,
        };
        if let Some(free) = self.entries.iter().position(Option::is_none) {
            self.entries[free] = Some(entry);
            return Some(StreamedId(free as u32));
        }
        if self.entries.len() >= STREAMED_TEXTURES_MAX {
            return None;
        }
        self.entries.push(Some(entry));
        Some(StreamedId((self.entries.len() - 1) as u32))
    }

    /// Stop tracking a texture (its cell left); its bytes leave the ledger.
    pub fn remove(&mut self, id: StreamedId) {
        if let Some(slot) = self.entries.get_mut(id.0 as usize) {
            *slot = None;
        }
    }

    /// A use of `id` this frame at `pixels_per_metre` screen pixels per metre; the largest use of a
    /// frame counts. A texture nothing sees on a frame wants its tail.
    pub fn see(&mut self, id: StreamedId, pixels_per_metre: f32) {
        let Some(entry) = self.entry_mut(id) else { return };
        if pixels_per_metre.is_finite() && pixels_per_metre > 0.0 {
            entry.needed = entry.needed.max(pixels_per_metre / entry.uv_density);
        }
    }

    /// A new pool size (the device class, a memory warning); the next plan drops what no longer
    /// fits.
    pub fn set_pool(&mut self, pool_bytes: u64) {
        self.pool_bytes = pool_bytes;
    }

    /// The pool, in bytes.
    pub fn pool_bytes(&self) -> u64 {
        self.pool_bytes
    }

    /// The rung `id` shows now (what its material row samples).
    pub fn shown(&self, id: StreamedId) -> Option<u32> {
        self.entry(id).map(|entry| entry.shown)
    }

    /// The rung `id` is loading, if any.
    pub fn loading(&self, id: StreamedId) -> Option<u32> {
        self.entry(id).and_then(|entry| entry.loading)
    }

    /// Every shown chain plus every load in flight, in bytes: exact.
    pub fn resident_bytes(&self) -> u64 {
        self.entries.iter().flatten().map(entry_bytes).sum()
    }

    /// The load of `id` to `rung` landed (its layer is written): it shows `rung` from now on, and
    /// the rung it showed before leaves the ledger. A stale report changes nothing.
    pub fn landed(&mut self, id: StreamedId, rung: u32) {
        let frame = self.frame;
        let Some(entry) = self.entry_mut(id) else { return };
        if entry.loading != Some(rung) {
            return;
        }
        entry.loading = None;
        entry.shown = rung;
        entry.last_change = Some(frame);
    }

    /// End the frame: drop what the pool no longer holds, then start loads toward each texture's
    /// wanted rung while they fit. The sights are cleared for the next frame.
    pub fn plan(&mut self) -> StreamPlan {
        self.frame += 1;
        let dropped = self.cut_to_pool();
        let loads = self.start_loads();
        for entry in self.entries.iter_mut().flatten() {
            entry.needed = 0.0;
        }
        StreamPlan { loads, dropped }
    }

    /// Fit the ledger to the pool: cancel loads in flight (nothing shows them yet), then drop the
    /// least needed textures above their tails to their tails.
    fn cut_to_pool(&mut self) -> Vec<RungChange> {
        let frame = self.frame;
        let mut dropped = Vec::new();
        for id in self.order(|entry| entry.loading.is_some(), false) {
            if self.resident_bytes() <= self.pool_bytes {
                return dropped;
            }
            if let Some(entry) = self.entry_mut(id) {
                entry.loading = None;
            }
        }
        for id in self.order(|entry| entry.shown > tail_of(entry.side), false) {
            if self.resident_bytes() <= self.pool_bytes {
                break;
            }
            let Some(entry) = self.entry_mut(id) else { continue };
            let tail = tail_of(entry.side);
            dropped.push(RungChange { id, from: entry.shown, to: tail, bytes: entry.family.chain_bytes(tail) });
            entry.shown = tail;
            entry.last_change = Some(frame);
        }
        dropped
    }

    /// Start the loads toward wanted rungs, the most needed first, while they fit the pool.
    fn start_loads(&mut self) -> Vec<RungChange> {
        let frame = self.frame;
        let mut loads = Vec::new();
        for id in self.order(|entry| entry.loading.is_none(), true) {
            let used = self.resident_bytes();
            let pool = self.pool_bytes;
            let Some(entry) = self.entry_mut(id) else { continue };
            let settled = entry.last_change.is_none_or(|last| frame.saturating_sub(last) >= RUNG_CHANGE_FRAMES_MIN);
            let Some(to) = settled.then(|| next_rung(entry)).flatten() else { continue };
            let bytes = entry.family.chain_bytes(to);
            if used + bytes > pool {
                continue;
            }
            entry.loading = Some(to);
            loads.push(RungChange { id, from: entry.shown, to, bytes });
        }
        loads
    }

    /// The live ids that pass `keep`, by need (most needed first when `most_needed_first`), ties
    /// by id.
    fn order(&self, keep: impl Fn(&Entry) -> bool, most_needed_first: bool) -> Vec<StreamedId> {
        let mut ids: Vec<(f32, StreamedId)> = self
            .entries
            .iter()
            .enumerate()
            .filter_map(|(at, slot)| slot.as_ref().filter(|entry| keep(entry)).map(|entry| (entry.needed, StreamedId(at as u32))))
            .collect();
        ids.sort_by(|(a, id_a), (b, id_b)| {
            let by_need = if most_needed_first { b.total_cmp(a) } else { a.total_cmp(b) };
            by_need.then(id_a.cmp(id_b))
        });
        ids.into_iter().map(|(_, id)| id).collect()
    }

    fn entry(&self, id: StreamedId) -> Option<&Entry> {
        self.entries.get(id.0 as usize).and_then(Option::as_ref)
    }

    fn entry_mut(&mut self, id: StreamedId) -> Option<&mut Entry> {
        self.entries.get_mut(id.0 as usize).and_then(Option::as_mut)
    }
}

/// An entry's ledger bytes: its shown chain plus its load in flight.
fn entry_bytes(entry: &Entry) -> u64 {
    entry.family.chain_bytes(entry.shown) + entry.loading.map_or(0, |rung| entry.family.chain_bytes(rung))
}

/// The tail of a texture `side` texels wide.
fn tail_of(side: u32) -> u32 {
    TAIL_SIDE.min(side)
}

/// The rungs of a texture `side` texels wide, smallest first: its tail, then each size class up
/// to its own side.
pub fn rungs(side: u32) -> Vec<u32> {
    let tail = tail_of(side);
    std::iter::once(tail).chain(TEXTURE_SIZE_CLASSES.into_iter().filter(|class| *class > tail && *class <= side)).collect()
}

/// The smallest rung of a `side` texture at least `needed` texels wide (its largest when none is).
pub fn wanted_rung(side: u32, needed: f32) -> u32 {
    let rungs = rungs(side);
    let largest = rungs.last().copied().unwrap_or(side);
    rungs.into_iter().find(|rung| *rung as f32 >= needed).unwrap_or(largest)
}

/// The rung an entry should move to now, if any: up to its wanted rung, or down once it needs at
/// most [`DEMOTE_FRACTION`] of the rung below the one shown.
fn next_rung(entry: &Entry) -> Option<u32> {
    let wanted = wanted_rung(entry.side, entry.needed);
    if wanted > entry.shown {
        return Some(wanted);
    }
    let below = rungs(entry.side).into_iter().rev().find(|rung| *rung < entry.shown)?;
    let well_below = entry.needed <= below as f32 * DEMOTE_FRACTION;
    (wanted < entry.shown && well_below).then_some(wanted)
}

/// The bytes a promotion from rung `from` to rung `to` reads past what is resident: KTX2 levels lie
/// smallest first, so it is one range from the end of `from`'s chain to the end of `to`'s. None
/// when either rung is not a level of the file or `to` is not above `from`.
pub fn head_range(index: &Ktx2Index, from: u32, to: u32) -> Option<Range<u64>> {
    let resident = index.chain(from)?;
    let wanted = index.chain(to)?;
    (to > from && wanted.end > resident.end).then_some(resident.end..wanted.end)
}
