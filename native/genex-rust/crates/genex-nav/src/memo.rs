//! Bake memos keyed by input digest, capped per device class (NAV-11).
//!
//! A bake is a pure function of (input digest, config digest, crate version), so baking the same
//! input twice may hand back the first bake's tiles. The memo saves wall time at a seed and never
//! changes a tick: what it returns is equal, tile for tile, to a fresh bake. It is an LRU by
//! bytes: an entry that is read moves to the back, the front is evicted until a new entry fits
//! the cap, and an entry larger than the whole cap is never kept. One process-wide memo serves
//! [`crate::world::NavMesh::bake`]; its cap is per device class ([`NAV_MEMO_BYTES_MAX`] on a
//! desktop, [`NAV_MEMO_BYTES_MAX_PHONE`] on a phone), set by the runtime with [`set_memo_cap`].

use std::sync::{Arc, Mutex, MutexGuard};

use genex_core::digest::fnv1a64;
use genex_core::map::Map;

use crate::tile::{NAV_TILE_VERSION, NavTile};

/// The process-wide memo's cap on a desktop, in bytes.
pub const NAV_MEMO_BYTES_MAX: usize = 32 * 1024 * 1024;
/// The process-wide memo's cap on a phone (and a phone's browser), in bytes.
pub const NAV_MEMO_BYTES_MAX_PHONE: usize = 8 * 1024 * 1024;
/// Bytes counted for each memoized tile beyond its geometry (its record and handle).
const TILE_OVERHEAD_BYTES: usize = 64;

/// What a memo entry is keyed by: one bake's input and config, and this crate's version and tile
/// format, so an upgraded crate never reuses an older bake.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct MemoKey(u64);

impl MemoKey {
    /// The key of a bake of the input with digest `input` under the config with digest `config`.
    pub fn new(input: u64, config: u64) -> MemoKey {
        let mut bytes = Vec::with_capacity(32);
        bytes.extend_from_slice(&input.to_le_bytes());
        bytes.extend_from_slice(&config.to_le_bytes());
        bytes.extend_from_slice(&NAV_TILE_VERSION.to_le_bytes());
        bytes.extend_from_slice(env!("CARGO_PKG_VERSION").as_bytes());
        MemoKey(fnv1a64(&bytes))
    }
}

/// A memo's counters.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MemoStats {
    /// Reads that found their bake.
    pub hits: u64,
    /// Reads that did not.
    pub misses: u64,
    /// Entries dropped to fit the cap.
    pub evictions: u64,
    /// Entries held.
    pub entries: usize,
    /// Bytes held (never above the cap).
    pub bytes: usize,
    /// The cap, in bytes.
    pub cap: usize,
}

/// An LRU of bakes by bytes.
#[derive(Debug, Default)]
pub struct BakeMemo {
    cap: usize,
    bytes: usize,
    entries: Map<MemoKey, (Arc<[NavTile]>, usize)>,
    hits: u64,
    misses: u64,
    evictions: u64,
}

impl BakeMemo {
    /// An empty memo holding at most `cap` bytes.
    pub fn new(cap: usize) -> BakeMemo {
        BakeMemo { cap, ..BakeMemo::default() }
    }

    /// The bake under `key`, moved to the back of the LRU.
    pub fn get(&mut self, key: MemoKey) -> Option<Arc<[NavTile]>> {
        let Some(index) = self.entries.get_index_of(&key) else {
            self.misses += 1;
            return None;
        };
        self.hits += 1;
        let last = self.entries.len() - 1;
        self.entries.move_index(index, last);
        self.entries.get_index(last).map(|(_, (tiles, _))| tiles.clone())
    }

    /// Keep `tiles` under `key`, evicting the least recently used entries until it fits. An entry
    /// larger than the cap is not kept.
    pub fn insert(&mut self, key: MemoKey, tiles: Arc<[NavTile]>) {
        if let Some((_, bytes)) = self.entries.shift_remove(&key) {
            self.bytes -= bytes;
        }
        let bytes = tiles_bytes(&tiles);
        if bytes > self.cap {
            return;
        }
        self.evict_to(self.cap - bytes);
        self.bytes += bytes;
        self.entries.insert(key, (tiles, bytes));
    }

    /// Change the cap, evicting down to it.
    pub fn set_cap(&mut self, cap: usize) {
        self.cap = cap;
        self.evict_to(cap);
    }

    /// Drop every entry (the counters stay).
    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    /// The counters and sizes.
    pub fn stats(&self) -> MemoStats {
        MemoStats { hits: self.hits, misses: self.misses, evictions: self.evictions, entries: self.entries.len(), bytes: self.bytes, cap: self.cap }
    }

    /// Whether `key` is held (without touching the LRU order).
    pub fn contains(&self, key: MemoKey) -> bool {
        self.entries.contains_key(&key)
    }

    fn evict_to(&mut self, bytes: usize) {
        while self.bytes > bytes {
            let Some((_, (_, freed))) = self.entries.shift_remove_index(0) else {
                break;
            };
            self.bytes -= freed;
            self.evictions += 1;
        }
    }
}

/// The bytes a memo counts for `tiles`: their geometry plus a record each.
pub fn tiles_bytes(tiles: &[NavTile]) -> usize {
    tiles.iter().map(|tile| tile.memory_bytes() + TILE_OVERHEAD_BYTES).sum()
}

static GLOBAL: Mutex<Option<BakeMemo>> = Mutex::new(None);

/// The process-wide memo (made at [`NAV_MEMO_BYTES_MAX`] on first use). A panic while it was
/// held leaves it usable: it only ever holds whole entries.
pub fn global() -> MutexGuard<'static, Option<BakeMemo>> {
    let mut guard = GLOBAL.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.get_or_insert_with(|| BakeMemo::new(NAV_MEMO_BYTES_MAX));
    guard
}

/// Set the process-wide memo's cap (the runtime picks it by device class), evicting down to it.
pub fn set_memo_cap(cap: usize) {
    if let Some(memo) = global().as_mut() {
        memo.set_cap(cap);
    }
}

/// The process-wide memo's counters.
pub fn memo_stats() -> MemoStats {
    global().as_ref().map(BakeMemo::stats).unwrap_or_default()
}
