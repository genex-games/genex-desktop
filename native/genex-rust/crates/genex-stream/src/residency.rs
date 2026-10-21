//! The residency policy: which streamed assets of the view set stay in memory, which load next, and
//! which go when the content pool is full.
//!
//! Requesters hold refcounts on entries (Sim, View, Kept, Ticket). An entry nobody references
//! joins an unload queue in release order, and [`Residency::drain`] evicts from its front while
//! resident bytes exceed the pool, under a time limit. [`Residency::start_loads`] starts queued
//! entries under an in-flight cap: sim-bound entries first, then by screen-space error. With
//! `forbid_holes` the nearest resident ancestor of a missing child (its HLOD) is kept until every
//! wanted child has arrived. The policy is display state: it never feeds the checksum, and it reads
//! time only through the [`ResidencyClock`] the caller passes in.
//!
//! Ported from cesium-native (https://github.com/CesiumGS/cesium-native), `TilesetContentManager`
//! (`unloadCachedTiles`, the tile reference counts and the unload list) and `TilesetOptions`
//! (`maximumCachedBytes`, `maximumSimultaneousTileLoads`, `tileCacheUnloadTimeLimit`,
//! `forbidHoles`). Copyright CesiumGS, Inc. and Contributors. Licensed under the Apache License,
//! Version 2.0 (the "License"); you may not use this file except in compliance with the License.
//! You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0. Unless
//! required by applicable law or agreed to in writing, software distributed under the License is
//! distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
//! implied.
//!
//! Changes from the original (Apache-2.0 §4(b)), made by the Genex authors in 2026:
//! - rewritten in Rust over generic keys instead of tiles, with no tileset, selection or loader;
//! - one refcount per requester kind (Sim, View, Kept, Ticket) instead of a single count;
//! - the unload list is a release-ordered map rather than an intrusive list, and evicted keys are
//!   returned to the caller, which frees the GPU memory;
//! - the time limit reads an injected clock, checked after each eviction as upstream does;
//! - sim-bound loads start first and never wait on the pool; other loads start only when they fit
//!   the pool, counting evictable bytes as room;
//! - `forbid_holes` keeps the nearest resident ancestor of a missing child out of the drain
//!   (upstream keeps refining from the parent instead), and that child never waits for room;
//! - a refused load is not retried until every requester has released it.

use std::collections::BTreeMap;
use std::hash::Hash;

use genex_core::map::{Map, Set};

/// The unload queue's default time limit per drain, in ms. cesium-native's default is 5 ms; a
/// Genex frame's whole main-thread finish budget is 1 to 2 ms, so a drain gets a fraction of it.
pub const RESIDENCY_UNLOAD_TIME_LIMIT_MS: f64 = 0.5;

/// Who holds an entry. An entry stays referenced while any requester holds it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Requester {
    /// The sim set needs it (an active cell's content): starts first, never waits, never evicted.
    Sim,
    /// The drawn camera wants it this frame.
    View,
    /// The game kept it with `keep`.
    Kept,
    /// A `require(group)` ticket waits on it: sim-bound like `Sim`.
    Ticket,
}

impl Requester {
    /// Every requester, in declaration order.
    pub const ALL: [Requester; 4] = [Requester::Sim, Requester::View, Requester::Kept, Requester::Ticket];

    /// The requester's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            Requester::Sim => "sim",
            Requester::View => "view",
            Requester::Kept => "kept",
            Requester::Ticket => "ticket",
        }
    }

    const fn slot(self) -> usize {
        match self {
            Requester::Sim => 0,
            Requester::View => 1,
            Requester::Kept => 2,
            Requester::Ticket => 3,
        }
    }
}

/// Where an entry is in its life.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum EntryState {
    /// Wanted, not started.
    Queued,
    /// Started by [`Residency::start_loads`], not finished.
    Loading,
    /// In memory, counted in the pool.
    Resident,
    /// The load failed; not retried until every requester releases it.
    Refused,
}

/// The policy's limits. The per-class numbers live with the presets (`ClassDefaults::stream`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ResidencyLimits {
    /// The content pool: the bytes resident entries may hold after a drain.
    pub pool_bytes: u64,
    /// Loads started and not finished, at most.
    pub loads_in_flight: u32,
    /// A drain's time limit in ms; zero (or not positive) drains without a limit.
    pub unload_time_limit_ms: f64,
    /// Keep the nearest resident ancestor of a wanted, missing child.
    pub forbid_holes: bool,
}

impl ResidencyLimits {
    /// A pool and an in-flight cap, with the default time limit and `forbid_holes` off.
    pub const fn new(pool_bytes: u64, loads_in_flight: u32) -> ResidencyLimits {
        ResidencyLimits { pool_bytes, loads_in_flight, unload_time_limit_ms: RESIDENCY_UNLOAD_TIME_LIMIT_MS, forbid_holes: false }
    }
}

/// What a request says about the entry it wants.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Want<K> {
    /// The screen-space error in pixels ([`screen_space_error_px`]): higher loads sooner.
    pub priority_px: f32,
    /// The bytes the entry will hold when resident, as the asset index sizes it.
    pub estimated_bytes: u64,
    /// The coarser entry drawn in its place while it is missing (its HLOD), if any.
    pub parent: Option<K>,
}

impl<K> Want<K> {
    /// A want with a priority and an estimate, and no parent.
    pub const fn new(priority_px: f32, estimated_bytes: u64) -> Want<K> {
        Want { priority_px, estimated_bytes, parent: None }
    }

    /// The same want under `parent`.
    pub fn under(self, parent: K) -> Want<K> {
        Want { parent: Some(parent), ..self }
    }
}

/// The time source a drain's limit reads. The presenter passes its frame clock; tests a fake one.
pub trait ResidencyClock {
    /// Milliseconds since an arbitrary origin.
    fn now_ms(&mut self) -> f64;
}

/// Counts for `state().volatile.__stream.view` (the presenter's view set, STR-16).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResidencyStats {
    /// Bytes of resident entries.
    pub resident_bytes: u64,
    /// Resident bytes no drain may evict: referenced entries and HLODs kept by `forbid_holes`.
    pub held_bytes: u64,
    /// Estimated bytes of loads in flight.
    pub loading_bytes: u64,
    /// Loads in flight.
    pub in_flight: u32,
    /// Entries wanted and not started.
    pub queued: u32,
    /// Entries evicted since the policy was made.
    pub evicted: u64,
    /// Entries whose load failed and are still referenced.
    pub refused: u32,
    /// Queued entries the last [`Residency::start_loads`] left waiting for room in the pool.
    pub waiting_for_room: u32,
}

/// The screen-space error of `error` world units seen at `distance`, in pixels: the metric
/// genex-render's `select_lod` compares with its threshold (`error * pixels_per_unit <= threshold *
/// distance`). A distance that is not positive is the most urgent; a NaN error the least.
pub fn screen_space_error_px(error: f32, distance: f32, pixels_per_unit: f32) -> f32 {
    if distance.is_nan() || distance <= 0.0 {
        return f32::MAX;
    }
    let px = error * pixels_per_unit / distance;
    if px.is_nan() { 0.0 } else { px }
}

#[derive(Clone, Debug)]
struct Entry<K> {
    refs: [u32; 4],
    state: EntryState,
    priority_px: f32,
    estimated_bytes: u64,
    bytes: u64,
    parent: Option<K>,
    /// Request order, the last tie-break when starting loads.
    order: u64,
    /// The entry's place in the unload queue while it waits there.
    unload_at: Option<u64>,
}

impl<K> Entry<K> {
    fn referenced(&self) -> bool {
        self.refs.iter().any(|count| *count > 0)
    }

    /// Held by the sim set or a ticket: starts first and never waits for room.
    fn sim_bound(&self) -> bool {
        self.refs[Requester::Sim.slot()] > 0 || self.refs[Requester::Ticket.slot()] > 0
    }
}

/// The residency policy over entries keyed by `K` (a cell, a lock id, a texture).
#[derive(Clone, Debug)]
pub struct Residency<K> {
    limits: ResidencyLimits,
    entries: Map<K, Entry<K>>,
    /// Unreferenced resident entries, oldest release first.
    unload: BTreeMap<u64, K>,
    next_order: u64,
    next_unload: u64,
    resident_bytes: u64,
    loading_bytes: u64,
    in_flight: u32,
    evicted: u64,
    waiting_for_room: u32,
}

impl<K: Copy + Eq + Hash + Ord> Residency<K> {
    /// An empty policy under `limits`.
    pub fn new(limits: ResidencyLimits) -> Residency<K> {
        Residency {
            limits,
            entries: Map::default(),
            unload: BTreeMap::new(),
            next_order: 0,
            next_unload: 0,
            resident_bytes: 0,
            loading_bytes: 0,
            in_flight: 0,
            evicted: 0,
            waiting_for_room: 0,
        }
    }

    /// The limits in force.
    pub fn limits(&self) -> ResidencyLimits {
        self.limits
    }

    /// Replaces the limits (a class change, memory pressure); the next drain enforces a smaller pool.
    pub fn set_limits(&mut self, limits: ResidencyLimits) {
        self.limits = limits;
    }

    /// `requester` takes a reference on `key`. A new key is queued; a resident one waiting in the
    /// unload queue revives without a reload. The priority is refreshed, a queued entry's estimate
    /// too, and the parent when one is given. Returns the entry's state after the call.
    pub fn request(&mut self, key: K, requester: Requester, want: Want<K>) -> EntryState {
        let priority_px = if want.priority_px.is_nan() { f32::NEG_INFINITY } else { want.priority_px };
        if !self.entries.contains_key(&key) {
            let order = self.next_order;
            self.next_order += 1;
            let entry = Entry {
                refs: [0; 4],
                state: EntryState::Queued,
                priority_px,
                estimated_bytes: want.estimated_bytes,
                bytes: 0,
                parent: None,
                order,
                unload_at: None,
            };
            self.entries.insert(key, entry);
        }
        let Some(entry) = self.entries.get_mut(&key) else { return EntryState::Queued };
        let slot = requester.slot();
        entry.refs[slot] = entry.refs[slot].saturating_add(1);
        entry.priority_px = priority_px;
        if entry.state == EntryState::Queued {
            entry.estimated_bytes = want.estimated_bytes;
        }
        if want.parent.is_some() {
            entry.parent = want.parent;
        }
        if let Some(at) = entry.unload_at.take() {
            self.unload.remove(&at);
        }
        entry.state
    }

    /// `requester` drops one reference on `key`. When nobody references it any more, a queued entry
    /// is forgotten, a refused one too, a resident one joins the back of the unload queue, and a
    /// loading one joins it when it finishes. Returns false (and changes nothing) when `requester`
    /// held no reference.
    pub fn release(&mut self, key: K, requester: Requester) -> bool {
        let slot = requester.slot();
        let Some(entry) = self.entries.get_mut(&key) else { return false };
        if entry.refs[slot] == 0 {
            return false;
        }
        entry.refs[slot] -= 1;
        if entry.referenced() {
            return true;
        }
        match entry.state {
            EntryState::Queued | EntryState::Refused => {
                self.entries.swap_remove(&key);
            }
            EntryState::Resident => self.enqueue_unload(key),
            EntryState::Loading => {}
        }
        true
    }

    /// Marks queued entries loading, up to the in-flight cap, and returns them for the caller to
    /// start. Sim-bound entries go first and never wait for room; the rest go by screen-space error
    /// (ties in request order) and start only when their estimate fits the pool, counting evictable
    /// bytes as room. With `forbid_holes`, a missing child of a kept HLOD never waits for room
    /// either: the HLOD can leave only once the child arrives.
    pub fn start_loads(&mut self) -> Vec<K> {
        let pinned = self.pinned();
        let mut candidates: Vec<(K, bool, f32, u64)> = self
            .entries
            .iter()
            .filter(|(_, e)| e.state == EntryState::Queued)
            .map(|(key, e)| (*key, e.sim_bound(), e.priority_px, e.order))
            .collect();
        candidates.sort_by(|a, b| b.1.cmp(&a.1).then(b.2.total_cmp(&a.2)).then(a.3.cmp(&b.3)));
        let room = self.limits.pool_bytes.saturating_add(self.evictable_bytes(&pinned));
        let mut committed = self.resident_bytes.saturating_add(self.loading_bytes);
        let mut started = Vec::new();
        self.waiting_for_room = 0;
        for (key, sim_bound, _, _) in candidates {
            if self.in_flight >= self.limits.loads_in_flight {
                break;
            }
            let estimate = self.entries.get(&key).map_or(0, |e| e.estimated_bytes);
            let fits = committed.saturating_add(estimate) <= room;
            if !(sim_bound || fits || self.is_hole(key)) {
                self.waiting_for_room += 1;
                continue;
            }
            if let Some(entry) = self.entries.get_mut(&key) {
                entry.state = EntryState::Loading;
            }
            committed = committed.saturating_add(estimate);
            self.loading_bytes = self.loading_bytes.saturating_add(estimate);
            self.in_flight += 1;
            started.push(key);
        }
        started
    }

    /// A load finished with `bytes` resident. An entry nobody references any more joins the unload
    /// queue. Returns false (and changes nothing) when `key` was not loading.
    pub fn finish(&mut self, key: K, bytes: u64) -> bool {
        let Some(entry) = self.entries.get_mut(&key) else { return false };
        if entry.state != EntryState::Loading {
            return false;
        }
        entry.state = EntryState::Resident;
        entry.bytes = bytes;
        let estimate = entry.estimated_bytes;
        let referenced = entry.referenced();
        self.end_load(estimate);
        self.resident_bytes = self.resident_bytes.saturating_add(bytes);
        if !referenced {
            self.enqueue_unload(key);
        }
        true
    }

    /// A load failed (or was cancelled). A referenced entry is refused until every requester lets it
    /// go; an unreferenced one is forgotten. Returns false (and changes nothing) when `key` was not
    /// loading.
    pub fn fail(&mut self, key: K) -> bool {
        let Some(entry) = self.entries.get_mut(&key) else { return false };
        if entry.state != EntryState::Loading {
            return false;
        }
        let estimate = entry.estimated_bytes;
        if entry.referenced() {
            entry.state = EntryState::Refused;
        } else {
            self.entries.swap_remove(&key);
        }
        self.end_load(estimate);
        true
    }

    /// Evicts unreferenced entries, oldest release first, while resident bytes exceed the pool, and
    /// returns them in eviction order for the caller to free. HLODs kept by `forbid_holes` are
    /// skipped. With a positive time limit the clock is read once at the start and after each
    /// eviction, and the drain stops once the limit has passed; the next drain resumes.
    pub fn drain(&mut self, clock: &mut dyn ResidencyClock) -> Vec<K> {
        let mut evicted = Vec::new();
        if self.resident_bytes <= self.limits.pool_bytes {
            return evicted;
        }
        let pinned = self.pinned();
        let limit_ms = self.limits.unload_time_limit_ms;
        let throttled = limit_ms > 0.0;
        let start = clock.now_ms();
        let mut cursor = 0u64;
        while self.resident_bytes > self.limits.pool_bytes {
            let Some((&at, &key)) = self.unload.range(cursor..).next() else { break };
            cursor = at + 1;
            if pinned.contains(&key) {
                continue;
            }
            self.unload.remove(&at);
            if let Some(entry) = self.entries.swap_remove(&key) {
                self.resident_bytes = self.resident_bytes.saturating_sub(entry.bytes);
            }
            self.evicted += 1;
            evicted.push(key);
            if throttled && clock.now_ms() - start >= limit_ms {
                break;
            }
        }
        evicted
    }

    /// The entry's state, or None when the policy does not know `key`.
    pub fn state(&self, key: K) -> Option<EntryState> {
        self.entries.get(&key).map(|e| e.state)
    }

    /// The references `requester` holds on `key`.
    pub fn refs(&self, key: K, requester: Requester) -> u32 {
        self.entries.get(&key).map_or(0, |e| e.refs[requester.slot()])
    }

    /// Whether any requester references `key`.
    pub fn is_referenced(&self, key: K) -> bool {
        self.entries.get(&key).is_some_and(Entry::referenced)
    }

    /// The estimate `key` was queued (and started) with.
    pub fn estimated_bytes(&self, key: K) -> Option<u64> {
        self.entries.get(&key).map(|e| e.estimated_bytes)
    }

    /// What draws for `key`: itself when resident, else its nearest resident ancestor, else None.
    pub fn stand_in(&self, key: K) -> Option<K> {
        let mut at = key;
        for _ in 0..=self.entries.len() {
            let entry = self.entries.get(&at)?;
            if entry.state == EntryState::Resident {
                return Some(at);
            }
            at = entry.parent?;
        }
        None
    }

    /// The counts for `state().volatile.__stream.view`.
    pub fn stats(&self) -> ResidencyStats {
        let pinned = self.pinned();
        let held_bytes = self
            .entries
            .iter()
            .filter(|(key, e)| e.state == EntryState::Resident && (e.referenced() || pinned.contains(*key)))
            .fold(0u64, |sum, (_, e)| sum.saturating_add(e.bytes));
        let count = |state: EntryState| self.entries.values().filter(|e| e.state == state).count() as u32;
        ResidencyStats {
            resident_bytes: self.resident_bytes,
            held_bytes,
            loading_bytes: self.loading_bytes,
            in_flight: self.in_flight,
            queued: count(EntryState::Queued),
            evicted: self.evicted,
            refused: count(EntryState::Refused),
            waiting_for_room: self.waiting_for_room,
        }
    }

    fn enqueue_unload(&mut self, key: K) {
        let at = self.next_unload;
        self.next_unload += 1;
        if let Some(entry) = self.entries.get_mut(&key) {
            entry.unload_at = Some(at);
            self.unload.insert(at, key);
        }
    }

    fn end_load(&mut self, estimate: u64) {
        self.loading_bytes = self.loading_bytes.saturating_sub(estimate);
        self.in_flight = self.in_flight.saturating_sub(1);
    }

    /// A wanted child not yet resident whose HLOD (nearest resident ancestor) `forbid_holes` keeps.
    fn hole_stand_in(&self, key: K, entry: &Entry<K>) -> Option<K> {
        let missing = matches!(entry.state, EntryState::Queued | EntryState::Loading);
        if !(self.limits.forbid_holes && missing && entry.referenced()) {
            return None;
        }
        let stand_in = self.stand_in(entry.parent?)?;
        (stand_in != key).then_some(stand_in)
    }

    fn is_hole(&self, key: K) -> bool {
        self.entries.get(&key).is_some_and(|entry| self.hole_stand_in(key, entry).is_some())
    }

    /// The HLODs `forbid_holes` keeps out of the drain this frame.
    fn pinned(&self) -> Set<K> {
        let mut pinned = Set::default();
        if !self.limits.forbid_holes {
            return pinned;
        }
        for (key, entry) in &self.entries {
            if let Some(stand_in) = self.hole_stand_in(*key, entry) {
                pinned.insert(stand_in);
            }
        }
        pinned
    }

    fn evictable_bytes(&self, pinned: &Set<K>) -> u64 {
        self.unload
            .values()
            .filter(|key| !pinned.contains(*key))
            .filter_map(|key| self.entries.get(key))
            .fold(0u64, |sum, e| sum.saturating_add(e.bytes))
    }
}
