//! `genex::Map` and `genex::Set`: insertion-ordered collections with a fixed-key hasher, so
//! iteration order (and anything a probe or checksum derives from it) is the same on every run
//! and target. The lane's clippy gate refuses std's `HashMap` and `HashSet` in game code.

use core::hash::BuildHasherDefault;
use std::hash::DefaultHasher;

/// SipHash with fixed zero keys: no OS randomness, the same hashes everywhere.
pub type DeterministicState = BuildHasherDefault<DefaultHasher>;

/// An insertion-ordered map. Build it with `Map::default()`.
pub type Map<K, V> = indexmap::IndexMap<K, V, DeterministicState>;

/// An insertion-ordered set. Build it with `Set::default()`.
pub type Set<T> = indexmap::IndexSet<T, DeterministicState>;
