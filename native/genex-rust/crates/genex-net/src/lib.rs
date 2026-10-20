//! genex-net: multiplayer for genex games, below the facade. The network is an input stream: the
//! runtime cuts one immutable `NetFrame` per tick from the backend, records it in a byte-capped
//! journal, and queues the tick's writes until after the tick. Reads take `&self` and writes
//! `&mut self`, so a read hook can draw remote players and can never send. Backends are chosen by
//! the build: `Off` (no `[net]` table), `Loopback` (Studio Live, captures, judges, demos and
//! tests, with `NetScript`'s scripted remote players), `Relay` (exports and the web draft, over the
//! vendored genex-multiplayer client) and `Replay` (a journal fed back for tests). Everything here
//! is deterministic on every destination (libm, `Map`, no clock, rand or thread).
//!
//! Every planned module is declared now so each work package fills one body (multiplayer MP-0); a
//! module that names its work package is still a stub.

pub mod vocab;
pub mod ids;
pub mod frame;
pub mod net;
pub mod writes;
pub mod journal;
pub mod backend;
pub mod off;
pub mod loopback;
pub mod script;
pub mod interp;
#[cfg(feature = "relay")]
pub mod relay;
pub mod replay;
