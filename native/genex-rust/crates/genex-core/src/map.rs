//! `Map` and `Set`: insertion-ordered collections with a fixed-key hasher, so iteration order (and
//! anything a probe or checksum derives from it) is the same on every run and target. They live
//! below the facade so the engine crates under it (genex-anim, genex-nav, genex-stream) use the
//! same types a game does; the facade re-exports them as `genex::Map` and `genex::Set`.

use core::hash::BuildHasherDefault;
use std::hash::DefaultHasher;

/// SipHash with fixed zero keys: no OS randomness, the same hashes everywhere.
pub type DeterministicState = BuildHasherDefault<DefaultHasher>;

/// An insertion-ordered map. Build it with `Map::default()`.
pub type Map<K, V> = indexmap::IndexMap<K, V, DeterministicState>;

/// An insertion-ordered set. Build it with `Set::default()`.
pub type Set<T> = indexmap::IndexSet<T, DeterministicState>;

#[cfg(test)]
mod tests {
    use super::{Map, Set};

    #[test]
    fn iteration_is_insertion_order_after_interleaved_removes() {
        let mut map: Map<u32, &str> = Map::default();
        for (key, value) in [(9, "a"), (1, "b"), (5, "c"), (3, "d")] {
            map.insert(key, value);
        }
        map.shift_remove(&1);
        map.insert(7, "e");
        assert_eq!(map.keys().copied().collect::<Vec<_>>(), [9, 5, 3, 7]);
        let set: Set<u32> = [4, 2, 8].into_iter().collect();
        assert_eq!(set.iter().copied().collect::<Vec<_>>(), [4, 2, 8]);
    }
}
