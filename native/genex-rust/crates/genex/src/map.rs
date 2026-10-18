//! `genex::Map` and `genex::Set`: insertion-ordered collections with a fixed-key hasher, so
//! iteration order (and anything a probe or checksum derives from it) is the same on every run
//! and target. The lane's clippy gate refuses std's `HashMap` and `HashSet` in game code.
//!
//! They are genex-core's, re-exported, so a map an engine crate below the facade hands a game is
//! the game's own type:
//!
//! ```
//! let engine: genex_core::map::Map<u32, &str> = genex_core::map::Map::default();
//! let game: genex::Map<u32, &str> = engine;
//! let set: genex::Set<u32> = genex_core::map::Set::default();
//! assert!(game.is_empty() && set.is_empty());
//! ```

pub use genex_core::map::{DeterministicState, Map, Set};
