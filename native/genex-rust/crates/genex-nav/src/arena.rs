//! A deterministic generational arena, in place of slotmap: keys carry a slot index and a
//! generation, a removed key stays dead (its slot comes back with the next generation), and
//! iteration is insertion order even after interleaved removes. Nothing depends on the process,
//! so two runs that make the same calls hand out the same keys and iterate the same way.
//!
//! Slots are reused last-freed first (slotmap's rule; the idea only, no slotmap code). Insertion
//! order is a doubly linked list through the slots, so insert, remove and lookup are O(1).

use core::marker::PhantomData;

/// The slot index no live value has: the "null" key ([`ArenaKey::null`]).
const NULL_INDEX: u32 = u32::MAX;

/// A key type an [`Arena`] hands out. Declare one with [`crate::arena_key!`].
pub trait ArenaKey: Copy + Eq + Ord + core::fmt::Debug {
    /// The key for `index` at `generation`.
    fn from_parts(index: u32, generation: u32) -> Self;
    /// The slot index.
    fn index(self) -> u32;
    /// The slot's generation when this key was handed out.
    fn generation(self) -> u32;
    /// A key no arena ever hands out (a placeholder, slotmap's `Key::null`).
    fn null() -> Self {
        Self::from_parts(NULL_INDEX, 0)
    }
    /// Whether this is the [`ArenaKey::null`] key.
    fn is_null(self) -> bool {
        self.index() == NULL_INDEX
    }
    /// The key as one number (generation high, index low), for probes, digests and saves.
    fn raw(self) -> u64 {
        (u64::from(self.generation()) << 32) | u64::from(self.index())
    }
}

/// Declares a key type for an [`Arena`]: a `Copy` newtype ordered by (index, generation), whose
/// `Default` is the null key.
#[macro_export]
macro_rules! arena_key {
    ($(#[$meta:meta])* $vis:vis struct $name:ident;) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        $vis struct $name {
            index: u32,
            generation: u32,
        }

        impl $crate::arena::ArenaKey for $name {
            fn from_parts(index: u32, generation: u32) -> Self {
                Self { index, generation }
            }
            fn index(self) -> u32 {
                self.index
            }
            fn generation(self) -> u32 {
                self.generation
            }
        }

        impl Default for $name {
            fn default() -> Self {
                <Self as $crate::arena::ArenaKey>::null()
            }
        }
    };
}

/// One slot: its current generation, its value when live, and its neighbours in insertion order
/// (when live) or the next free slot (when free, in `next`).
#[derive(Clone, Debug)]
struct Slot<V> {
    generation: u32,
    value: Option<V>,
    prev: u32,
    next: u32,
}

/// A generational arena with insertion-order iteration.
#[derive(Clone, Debug)]
pub struct Arena<K: ArenaKey, V> {
    slots: Vec<Slot<V>>,
    /// The most recently freed slot (the head of the free list), or `NULL_INDEX`.
    free: u32,
    /// The oldest live slot, or `NULL_INDEX`.
    head: u32,
    /// The newest live slot, or `NULL_INDEX`.
    tail: u32,
    len: usize,
    marker: PhantomData<K>,
}

impl<K: ArenaKey, V> Default for Arena<K, V> {
    fn default() -> Self {
        Self::new()
    }
}

impl<K: ArenaKey, V> Arena<K, V> {
    /// An empty arena.
    pub const fn new() -> Self {
        Self { slots: Vec::new(), free: NULL_INDEX, head: NULL_INDEX, tail: NULL_INDEX, len: 0, marker: PhantomData }
    }

    /// The number of live values.
    pub fn len(&self) -> usize {
        self.len
    }

    /// Whether no value is live.
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// A free slot's index, its generation already advanced; a new slot when none is free.
    fn take_slot(&mut self) -> u32 {
        if self.free == NULL_INDEX {
            let index = u32::try_from(self.slots.len()).ok().filter(|&i| i < NULL_INDEX).expect("arena slots fit u32");
            self.slots.push(Slot { generation: 0, value: None, prev: NULL_INDEX, next: NULL_INDEX });
            return index;
        }
        let index = self.free;
        let slot = &mut self.slots[index as usize];
        self.free = slot.next;
        slot.generation = slot.generation.wrapping_add(1);
        index
    }

    /// Stores `value` and returns its new key. A reused slot gets the next generation, so keys of
    /// removed values never come back.
    ///
    /// # Panics
    ///
    /// When the arena already holds `u32::MAX - 1` slots.
    pub fn insert(&mut self, value: V) -> K {
        let index = self.take_slot();
        let tail = self.tail;
        let slot = &mut self.slots[index as usize];
        slot.value = Some(value);
        slot.prev = tail;
        slot.next = NULL_INDEX;
        let generation = slot.generation;
        if tail == NULL_INDEX {
            self.head = index;
        } else {
            self.slots[tail as usize].next = index;
        }
        self.tail = index;
        self.len += 1;
        K::from_parts(index, generation)
    }

    fn live_slot(&self, key: K) -> Option<&Slot<V>> {
        self.slots.get(key.index() as usize).filter(|slot| slot.generation == key.generation() && slot.value.is_some())
    }

    /// Whether `key` names a live value.
    pub fn contains_key(&self, key: K) -> bool {
        self.live_slot(key).is_some()
    }

    /// The value `key` names, when it is live.
    pub fn get(&self, key: K) -> Option<&V> {
        self.live_slot(key).and_then(|slot| slot.value.as_ref())
    }

    /// The value `key` names, mutably, when it is live.
    pub fn get_mut(&mut self, key: K) -> Option<&mut V> {
        self.slots
            .get_mut(key.index() as usize)
            .filter(|slot| slot.generation == key.generation())
            .and_then(|slot| slot.value.as_mut())
    }

    /// Removes and returns the value `key` names. Its slot is freed for the next insert.
    pub fn remove(&mut self, key: K) -> Option<V> {
        self.live_slot(key)?;
        let index = key.index();
        let slot = &mut self.slots[index as usize];
        let value = slot.value.take();
        let (prev, next) = (slot.prev, slot.next);
        slot.prev = NULL_INDEX;
        slot.next = self.free;
        self.free = index;
        if prev == NULL_INDEX {
            self.head = next;
        } else {
            self.slots[prev as usize].next = next;
        }
        if next == NULL_INDEX {
            self.tail = prev;
        } else {
            self.slots[next as usize].prev = prev;
        }
        self.len -= 1;
        value
    }

    /// The live keys and values, oldest first.
    pub fn iter(&self) -> impl Iterator<Item = (K, &V)> + '_ {
        let mut cursor = self.head;
        core::iter::from_fn(move || {
            if cursor == NULL_INDEX {
                return None;
            }
            let index = cursor;
            let slot = &self.slots[index as usize];
            cursor = slot.next;
            slot.value.as_ref().map(|value| (K::from_parts(index, slot.generation), value))
        })
    }

    /// The live keys, oldest first.
    pub fn keys(&self) -> impl Iterator<Item = K> + '_ {
        self.iter().map(|(key, _)| key)
    }

    /// The arena's layout for a save: every slot's generation, and the free slots from the next
    /// one an insert takes. With the live keys in order, [`Arena::from_layout`] rebuilds an arena
    /// that hands out the same keys from then on.
    pub(crate) fn layout(&self) -> (Vec<u32>, Vec<u32>) {
        let generations = self.slots.iter().map(|slot| slot.generation).collect();
        let mut free = Vec::new();
        let mut cursor = self.free;
        while cursor != NULL_INDEX && free.len() < self.slots.len() {
            free.push(cursor);
            cursor = self.slots[cursor as usize].next;
        }
        (generations, free)
    }

    /// The arena [`Arena::layout`] described, holding `live` in the order given. `None` when the
    /// parts disagree: a live key past the slots or of another generation, a slot both live and
    /// free or named twice, a slot neither live nor free, or more slots than `u32` indexes.
    pub(crate) fn from_layout(generations: &[u32], free: &[u32], live: Vec<(K, V)>) -> Option<Self> {
        if generations.len() >= NULL_INDEX as usize || live.len() + free.len() != generations.len() {
            return None;
        }
        let mut slots: Vec<Slot<V>> = generations.iter().map(|&generation| Slot { generation, value: None, prev: NULL_INDEX, next: NULL_INDEX }).collect();
        let mut seen = vec![false; slots.len()];
        let mut arena = Self { slots: Vec::new(), free: NULL_INDEX, head: NULL_INDEX, tail: NULL_INDEX, len: 0, marker: PhantomData };
        for (key, value) in live {
            let index = key.index() as usize;
            let fits = index < slots.len() && !seen[index] && slots[index].generation == key.generation();
            if !fits {
                return None;
            }
            seen[index] = true;
            let slot = &mut slots[index];
            slot.value = Some(value);
            slot.prev = arena.tail;
            if arena.tail == NULL_INDEX {
                arena.head = key.index();
            } else {
                slots[arena.tail as usize].next = key.index();
            }
            arena.tail = key.index();
            arena.len += 1;
        }
        for (position, &index) in free.iter().enumerate() {
            if index as usize >= slots.len() || seen[index as usize] {
                return None;
            }
            seen[index as usize] = true;
            slots[index as usize].next = free.get(position + 1).copied().unwrap_or(NULL_INDEX);
        }
        arena.free = free.first().copied().unwrap_or(NULL_INDEX);
        arena.slots = slots;
        Some(arena)
    }

    /// Calls `f` on every live value, oldest first, mutably.
    pub fn for_each_mut(&mut self, mut f: impl FnMut(K, &mut V)) {
        let keys: Vec<K> = self.keys().collect();
        for key in keys {
            if let Some(value) = self.get_mut(key) {
                f(key, value);
            }
        }
    }
}

impl<K: ArenaKey, V> core::ops::Index<K> for Arena<K, V> {
    type Output = V;

    /// # Panics
    ///
    /// When `key` is not live.
    fn index(&self, key: K) -> &V {
        self.get(key).expect("a live arena key")
    }
}

impl<K: ArenaKey, V> core::ops::IndexMut<K> for Arena<K, V> {
    fn index_mut(&mut self, key: K) -> &mut V {
        self.get_mut(key).expect("a live arena key")
    }
}

impl<'a, K: ArenaKey, V> IntoIterator for &'a Arena<K, V> {
    type Item = (K, &'a V);
    type IntoIter = Box<dyn Iterator<Item = (K, &'a V)> + 'a>;

    fn into_iter(self) -> Self::IntoIter {
        Box::new(self.iter())
    }
}

#[cfg(test)]
mod tests {
    use super::{Arena, ArenaKey};

    crate::arena_key! {
        /// A test key.
        struct TestKey;
    }

    #[test]
    fn a_removed_key_stays_dead_and_its_slot_comes_back_with_a_new_generation() {
        let mut arena: Arena<TestKey, &str> = Arena::new();
        let a = arena.insert("a");
        assert_eq!(arena.remove(a), Some("a"));
        let b = arena.insert("b");
        assert_eq!(b.index(), a.index());
        assert_ne!(b.generation(), a.generation());
        assert_eq!(arena.get(a), None);
        assert_eq!(arena.remove(a), None);
        assert_eq!(arena.get(b), Some(&"b"));
        assert!(TestKey::default().is_null());
    }

    #[test]
    fn an_arena_rebuilt_from_its_layout_iterates_and_hands_out_keys_as_the_original() {
        let mut arena: Arena<TestKey, u32> = Arena::new();
        let keys: Vec<TestKey> = (0..6).map(|v| arena.insert(v)).collect();
        arena.remove(keys[1]);
        arena.remove(keys[4]);
        arena.insert(10);
        arena.remove(keys[2]);
        let (generations, free) = arena.layout();
        let live: Vec<(TestKey, u32)> = arena.iter().map(|(key, value)| (key, *value)).collect();
        let mut rebuilt = Arena::from_layout(&generations, &free, live.clone()).expect("a consistent layout");
        assert_eq!(rebuilt.iter().map(|(k, v)| (k, *v)).collect::<Vec<_>>(), live);
        assert_eq!(rebuilt.len(), arena.len());
        for value in 20..24 {
            assert_eq!(rebuilt.insert(value), arena.insert(value), "the next keys agree");
        }
        assert_eq!(rebuilt.layout(), arena.layout());
        // Layouts that do not hold together.
        assert!(Arena::<TestKey, u32>::from_layout(&[0], &[0], vec![(TestKey::from_parts(0, 0), 1)]).is_none(), "live and free");
        assert!(Arena::<TestKey, u32>::from_layout(&[0, 0], &[], vec![(TestKey::from_parts(0, 0), 1)]).is_none(), "a slot neither");
        assert!(Arena::<TestKey, u32>::from_layout(&[3], &[], vec![(TestKey::from_parts(0, 2), 1)]).is_none(), "another generation");
        assert!(Arena::<TestKey, u32>::from_layout(&[0], &[], vec![(TestKey::from_parts(5, 0), 1)]).is_none(), "past the slots");
    }

    #[test]
    fn iteration_is_insertion_order_after_interleaved_removes() {
        let mut arena: Arena<TestKey, u32> = Arena::new();
        let keys: Vec<TestKey> = (0..5).map(|v| arena.insert(v)).collect();
        arena.remove(keys[1]);
        arena.remove(keys[3]);
        arena.insert(10);
        arena.insert(11);
        arena.remove(keys[0]);
        let values: Vec<u32> = arena.iter().map(|(_, v)| *v).collect();
        assert_eq!(values, [2, 4, 10, 11]);
        assert_eq!(arena.len(), 4);
    }
}
