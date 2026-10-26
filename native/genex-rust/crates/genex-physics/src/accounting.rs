//! Per-world allocator accounting (CONTRACT.md §11.1).
//!
//! [`CountingAllocator`] wraps a binary's global allocator. The WASM binding installs it
//! (`#[global_allocator]`); while a world's call runs, every allocation is charged to that world,
//! and a header in front of each allocation names its world, so a free credits the world that
//! allocated it whichever call is running then (a result a call handed back, freed later by the
//! caller, included). `stats().memoryBytes` is then the bytes the world's live allocations asked
//! for, exact per world even when many worlds share one instance.
//!
//! A binary that does not install it (a native host, these crate's own tests) gets the core's
//! fixed per-object model instead (`memory`), which is the same on every target. Either way a
//! command is judged before it allocates: the world's bytes now plus the model's estimate of what
//! the command adds (`ledger`).
//!
//! Attribution is per thread: a world's calls run on one thread (§1.1), and a call on another
//! thread is charged to the world running there, or to none.

use std::alloc::{GlobalAlloc, Layout};
use std::cell::Cell;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

/// How many worlds one instance accounts at once; a world created past it gets the model.
pub const ACCOUNT_SLOTS: usize = 1024;
/// The bytes of the header in front of every allocation: the owner's slot and generation.
pub const HEADER_BYTES: usize = 8;
/// The slot of an allocation no world's call made.
const NO_SLOT: u32 = u32::MAX;

/// One world's counter.
struct Slot {
    in_use: AtomicBool,
    /// Bumped when a world takes or gives back the slot, so a late free never credits a later world.
    generation: AtomicU32,
    bytes: AtomicU64,
}

impl Slot {
    const fn new() -> Self {
        Self { in_use: AtomicBool::new(false), generation: AtomicU32::new(0), bytes: AtomicU64::new(0) }
    }
}

static SLOTS: [Slot; ACCOUNT_SLOTS] = [const { Slot::new() }; ACCOUNT_SLOTS];
/// Set by the first allocation through a [`CountingAllocator`].
static INSTALLED: AtomicBool = AtomicBool::new(false);

thread_local! {
    /// The world whose call this thread runs: its slot and generation, packed.
    static CURRENT: Cell<u64> = const { Cell::new(pack(NO_SLOT, 0)) };
}

const fn pack(slot: u32, generation: u32) -> u64 {
    ((slot as u64) << 32) | generation as u64
}

const fn unpack(owner: u64) -> (u32, u32) {
    ((owner >> 32) as u32, owner as u32)
}

fn current_owner() -> u64 {
    CURRENT.try_with(Cell::get).unwrap_or(pack(NO_SLOT, 0))
}

/// Whether the running binary installed a [`CountingAllocator`] (seen once it allocated through it).
pub fn installed() -> bool {
    INSTALLED.load(Ordering::Relaxed)
}

/// A global allocator that charges each allocation to the world whose call is running (§11.1).
/// Install it in the binary: `#[global_allocator] static A: CountingAllocator<System> =
/// CountingAllocator::new(System);`.
pub struct CountingAllocator<A> {
    inner: A,
}

impl<A> CountingAllocator<A> {
    /// Wraps `inner`, which does the allocating.
    pub const fn new(inner: A) -> Self {
        Self { inner }
    }
}

/// The block `inner` hands out for a caller's `layout`: room for the header in front, aligned for
/// both. Returns it and the caller's offset into it, or `None` when the size overflows.
fn outer_layout(layout: Layout) -> Option<(Layout, usize)> {
    let align = layout.align().max(HEADER_BYTES);
    let offset = align;
    let size = layout.size().checked_add(offset)?;
    Some((Layout::from_size_align(size, align).ok()?, offset))
}

fn charge(owner: u64, bytes: usize) {
    let (slot, generation) = unpack(owner);
    let Some(slot) = SLOTS.get(slot as usize) else { return };
    if slot.generation.load(Ordering::Relaxed) == generation {
        slot.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }
}

fn credit(owner: u64, bytes: usize) {
    let (slot, generation) = unpack(owner);
    let Some(slot) = SLOTS.get(slot as usize) else { return };
    if slot.generation.load(Ordering::Relaxed) == generation {
        slot.bytes.fetch_sub(bytes as u64, Ordering::Relaxed);
    }
}

impl<A: GlobalAlloc> CountingAllocator<A> {
    /// Allocates through `inner` (zeroed or not), writes the header and charges the owner.
    fn alloc_with(&self, layout: Layout, zeroed: bool) -> *mut u8 {
        INSTALLED.store(true, Ordering::Relaxed);
        let Some((outer, offset)) = outer_layout(layout) else { return std::ptr::null_mut() };
        // SAFETY: `outer` has a non-zero size (it holds the header), as `GlobalAlloc` requires.
        let base = unsafe { if zeroed { self.inner.alloc_zeroed(outer) } else { self.inner.alloc(outer) } };
        if base.is_null() {
            return base;
        }
        let owner = current_owner();
        // SAFETY: `base` holds `offset + layout.size()` bytes, and `offset >= HEADER_BYTES`, so the
        // header slot `[offset - 8, offset)` is inside the block and 8-aligned (`offset` is a multiple
        // of 8 and `base` is aligned to at least 8).
        unsafe {
            base.add(offset - HEADER_BYTES).cast::<u64>().write(owner);
        }
        charge(owner, layout.size());
        // SAFETY: `offset < outer.size()` unless `layout.size()` is 0, where one-past-the-end is valid.
        unsafe { base.add(offset) }
    }
}

// SAFETY: every block handed out is `inner`'s block offset by a multiple of the caller's alignment,
// of at least the caller's size; `dealloc` and `realloc` undo the offset before calling `inner`.
unsafe impl<A: GlobalAlloc> GlobalAlloc for CountingAllocator<A> {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        self.alloc_with(layout, false)
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        self.alloc_with(layout, true)
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let Some((outer, offset)) = outer_layout(layout) else { return };
        // SAFETY: `ptr` came from `alloc_with` with this `layout`, so the block starts `offset`
        // bytes before it and its header sits just in front of it.
        unsafe {
            let base = ptr.sub(offset);
            credit(base.add(offset - HEADER_BYTES).cast::<u64>().read(), layout.size());
            self.inner.dealloc(base, outer);
        }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let Some((outer, offset)) = outer_layout(layout) else { return std::ptr::null_mut() };
        let Some(new_outer) = new_size.checked_add(offset) else { return std::ptr::null_mut() };
        // SAFETY: as in `dealloc`; `inner.realloc` keeps the header's bytes, which stay at the same
        // offset, and `new_outer` is non-zero.
        unsafe {
            let base = self.inner.realloc(ptr.sub(offset), outer, new_outer);
            if base.is_null() {
                return base;
            }
            let owner = base.add(offset - HEADER_BYTES).cast::<u64>().read();
            credit(owner, layout.size());
            charge(owner, new_size);
            base.add(offset)
        }
    }
}

/// One world's claim on a slot; gives the slot back when dropped. A world that found no free slot
/// holds none and reports the model.
pub(crate) struct Account {
    owner: Option<u64>,
}

impl Account {
    /// Takes a free slot, its counter at 0.
    pub(crate) fn open() -> Self {
        let free = SLOTS.iter().enumerate().find(|(_, slot)| {
            slot.in_use.compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed).is_ok()
        });
        let owner = free.map(|(index, slot)| {
            slot.bytes.store(0, Ordering::Relaxed);
            let generation = slot.generation.fetch_add(1, Ordering::AcqRel).wrapping_add(1);
            pack(index as u32, generation)
        });
        Self { owner }
    }

    /// The bytes the world's live allocations asked for, when a [`CountingAllocator`] counts them.
    pub(crate) fn live_bytes(&self) -> Option<u64> {
        let (slot, _) = unpack(self.owner?);
        if !installed() {
            return None;
        }
        Some(SLOTS[slot as usize].bytes.load(Ordering::Relaxed))
    }

    /// Charges this thread's allocations to the world until the returned scope is dropped.
    pub(crate) fn enter(&self) -> Scope {
        let owner = self.owner.unwrap_or(pack(NO_SLOT, 0));
        let previous = CURRENT.try_with(|current| current.replace(owner)).unwrap_or(pack(NO_SLOT, 0));
        Scope { previous }
    }
}

impl Drop for Account {
    fn drop(&mut self) {
        let Some(owner) = self.owner else { return };
        let slot = &SLOTS[unpack(owner).0 as usize];
        slot.generation.fetch_add(1, Ordering::AcqRel);
        slot.in_use.store(false, Ordering::Release);
    }
}

/// While alive, this thread's allocations are charged to one world (see [`Account::enter`]).
pub(crate) struct Scope {
    previous: u64,
}

impl Drop for Scope {
    fn drop(&mut self) {
        let _ = CURRENT.try_with(|current| current.set(self.previous));
    }
}
