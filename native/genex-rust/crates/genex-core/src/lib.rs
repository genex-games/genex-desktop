//! The pure, platform-free runtime core, ported from the C++ template's raylib-free units and held
//! to them by characterization goldens (`tests/fixtures/genex-core-goldens`, extracted from the C++
//! sources by `scripts/spike/rust-wgpu/extract-goldens.ts`; `tests/goldens/` replays them):
//!
//! - [`clock`]: the fixed 1/60 s tick, the 250 ms frame clamp, `step(ms)` rounding, the fps meter;
//! - [`rng`]: PCG32, the only randomness a simulation may use;
//! - [`input`]: key names, the `input` verb's parser and the per-tick merge of real and injected
//!   input (keys, look, wheel, pointer, pads, committed text);
//! - [`session`]: the seed/start/pause/step/frame state machine, `state()` and its checksum, the
//!   frame timings and the audio level;
//! - [`digest`]: FNV-1a 64;
//! - [`json`]: the protocol's JSON value, reader and writer (the checksum hashes its dump);
//! - [`paths`]: save roots, the asset-path rule, asset claims and capture paths;
//! - [`protocol`]: NDJSON framing and the request envelope;
//! - [`saves`]: `save`/`load` under the destination's save root.
//!
//! Nothing here reads a wall clock or hashes with a random seed: `std::collections::HashMap`,
//! `HashSet` and `std::time::{Instant, SystemTime}` are refused by this crate's `clippy.toml`.
//!
//! The verbs of `studio.cpp` live in genex-studio (they need the transport), and its demo and
//! advance-guard semantics in the genex facade, where `advance` outside a demo is a compile error.

pub mod clock;
pub mod digest;
pub mod input;
pub mod json;
pub mod paths;
pub mod protocol;
pub mod rng;
pub mod saves;
pub mod session;
