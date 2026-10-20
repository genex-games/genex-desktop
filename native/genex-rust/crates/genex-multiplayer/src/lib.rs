//! # genex-multiplayer
//!
//! A Genex relay protocol 3 client for Rust (`packages/multiplayer/PROTOCOL.md` is normative).
//!
//! - **`native`** (default): a thin layer over the official Colyseus 0.18 native core
//!   (colyseus/native-sdk v0.18.10, linked statically) in polled mode. No threads: call
//!   [`Session::poll`] once per frame.
//! - **`web`** (`wasm32-unknown-unknown`): binds the JS bridge `@genex-ai/multiplayer/bridge`
//!   (see `BRIDGE.md`), so identity, reconnection and interpolation stay in the TypeScript SDK.
//!
//! ```no_run
//! # #[cfg(all(feature = "native", not(target_arch = "wasm32")))]
//! # fn main() {
//! use genex_multiplayer::{ConnectOptions, Event, Session};
//! use serde_json::json;
//!
//! let opts = ConnectOptions::new("wss://relay.genex.games", "my-game").name("ada");
//! // Called right before every join: return a FRESH embed token (never cache one).
//! let mut session = Session::connect(opts, || Ok(std::env::var("GENEX_EMBED_TOKEN").unwrap_or_default()));
//! loop {
//!     for event in session.poll() {
//!         if let Event::Disconnected { .. } | Event::JoinFailed { .. } = event { return; }
//!     }
//!     session.set_me(json!({ "x": 1.0, "y": 2.0 })).ok();
//!     for p in session.players() { /* p.state is smoothed for remote players */ }
//!     # break;
//! }
//! # }
//! # #[cfg(not(all(feature = "native", not(target_arch = "wasm32"))))]
//! # fn main() {}
//! ```

pub mod interp;
pub mod msgpack;
pub mod pose;
pub mod protocol;
pub mod stamp;
pub mod types;

pub use pose::PoseFields;
pub use types::{
    ChatMessage, ConnectOptions, ControlResult, Error, Event, JoinFailure, ObjectView, PlayerView, RoomTarget,
};

#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
mod native;
#[cfg(all(feature = "native", not(target_arch = "wasm32")))]
pub use native::{
    poll_network, DeviceCode, DevicePoll, EmbedIdentity, IdentityError, IdentityProvider, Session, TICKET_ENV,
};

#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub mod web;
#[cfg(all(feature = "web", target_arch = "wasm32"))]
pub use web::Session;
