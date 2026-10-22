//! `Map` and `Set`: insertion-ordered collections with a fixed-key hasher, so iteration order (and
//! anything a probe or checksum derives from it) is the same on every run and target. They live
//! below the facade so the engine crates under it (genex-anim, genex-nav, genex-stream) use the
//! same types a game does; the facade re-exports them as `genex::Map` and `genex::Set`.

use core::hash::{BuildHasherDefault, Hasher};
use std::hash::DefaultHasher;

/// SipHash with fixed zero keys: no OS randomness, the same hashes everywhere.
pub type DeterministicState = BuildHasherDefault<DefaultHasher>;

/// The Fx hash's multiplier (rustc's `FxHasher`, after Firefox's hash).
const FAST_HASH_SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;

/// A fast fixed-seed hasher (a word-at-a-time multiply-rotate hash, as rustc's `FxHasher`): the
/// same hashes on every run and target, a fraction of SipHash's cost on small keys, and no
/// protection against chosen keys. For engine tables keyed by engine ids on hot paths.
///
/// Ported from rustc-hash 1.1.0 `src/lib.rs` (`FxHasher`, MIT OR Apache-2.0, used under Apache
/// 2.0; Copyright The Rust Project Developers). Changed: byte strings are hashed 8 bytes at a
/// time, little-endian, then byte by byte, on every target (upstream reads native-endian words of
/// the pointer width).
#[derive(Clone, Copy, Debug, Default)]
pub struct FastHasher {
    hash: u64,
}

impl FastHasher {
    fn add(&mut self, word: u64) {
        self.hash = (self.hash.rotate_left(5) ^ word).wrapping_mul(FAST_HASH_SEED);
    }
}

impl Hasher for FastHasher {
    fn write(&mut self, bytes: &[u8]) {
        let (words, rest) = bytes.as_chunks::<8>();
        for word in words {
            self.add(u64::from_le_bytes(*word));
        }
        for byte in rest {
            self.add(u64::from(*byte));
        }
    }

    fn write_u8(&mut self, value: u8) {
        self.add(u64::from(value));
    }

    fn write_u32(&mut self, value: u32) {
        self.add(u64::from(value));
    }

    fn write_u64(&mut self, value: u64) {
        self.add(value);
    }

    fn write_usize(&mut self, value: usize) {
        self.add(value as u64);
    }

    fn write_isize(&mut self, value: isize) {
        self.add(value as u64);
    }

    fn finish(&self) -> u64 {
        self.hash
    }
}

/// [`FastHasher`] as a map's hasher.
pub type FastState = BuildHasherDefault<FastHasher>;

/// An insertion-ordered map hashed with [`FastHasher`]: [`Map`]'s order, for hot engine lookups.
pub type FastMap<K, V> = indexmap::IndexMap<K, V, FastState>;

/// An insertion-ordered set hashed with [`FastHasher`]: [`Set`]'s order, for hot engine lookups.
pub type FastSet<T> = indexmap::IndexSet<T, FastState>;

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
