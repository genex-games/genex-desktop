//! Web shell on WebGPU only (the designed unsupported page otherwise), async capture, IndexedDB saves mirror.
//!
//! M0a.7 fills the spike's part of this crate:
//!
//! - [`handle`]: [`GameHandle`], the object-safe view of a `genex::Runtime<W>` a shell keeps,
//!   since wasm-bindgen exports cannot be generic over the game's world type.
//! - [`draw`]: the bridge from a facade [`genex::Frame`] and [`genex::Camera`] to a
//!   [`genex_render::scene::Scene`], with GLB models loaded once from the game's asset table.
//! - [`studio`]: genex-studio's verbs over a [`GameHandle`] and a [`studio::Painter`], which the
//!   web exports answer `window.__studio` through (the C++ web build's shapes and envelope).
//! - [`selftest`]: the spike-only self-test sequence (seed, named demo, fixed ticks, captures at
//!   checkpoints) and its JSON record, shared by the native `--self-test` mode and the web
//!   export so the parity rows compare like with like.
//! - `web` (wasm32 only): the `studio_*` wasm-bindgen exports `native/genex-rust/web/shell.html`
//!   calls: `studio_call(op, arg)` for every page verb, the async `studio_capture` that resolves
//!   with top-down BGRA and its FNV-1a-64 digest from the world target, and `studio_boot`, which
//!   starts the game (its first reset, after the shell preloaded the saves mirror) and refuses a
//!   browser below WebGPU core with the typed `gpu-unsupported` code.
//!
//! - [`assets`]: the game's staged assets on the web, fetched by the shell before the first frame
//!   by the build's asset map and admitted only under the asset-path rule, the caps, and the
//!   recorded length and FNV-1a 64; the `web` module's `studio_assets_*` exports are the shell's
//!   side of it.
//!
//! - [`web_stream`]: what the web fetches while playing: each frame the named groups the game
//!   requires and the cell bodies and terrain tiles around its anchors are wanted, and what arrived
//!   reaches the sim's source at the next frame boundary (`state().volatile.webStream`).
//!
//! - [`web_saves`]: what `state()` says about the web's saves, kept in genex-core's in-memory mirror
//!   that the shell fills from IndexedDB before the first reset and drains write-behind (M2.9);
//!   the `web` module's `studio_saves_*` exports are the shell's side of it.
//!
//! - [`crash`]: crash reports on the page (game systems CRASH-3): genex-crash's hook hands the
//!   shell one `genex-crash/1` record per panic (kept in IndexedDB, read by
//!   `window.__studio.crashes()`), chained in front of our port of console_error_panic_hook.
//!
//! - The web build's facade: this crate re-exports all of `genex`, and a game's web build names it
//!   `genex` (the host-written manifest's `genex = { package = "genex-platform-web", … }`), so the
//!   template's `genex::install(game)` hands the game to this shell ([`install`]) when the module
//!   is instantiated, and every other `genex::` path is the facade's own.
//!
//! The plain-Rust modules build and test on every target. TODO(M3.x): the frame bridge moves into
//! the facade's render glue once the desktop shell presents through it too. The page's pointer
//! reaches the game as `Mouse1` (which the input merger emulates as one touch); page touch points
//! and lifecycle beyond the saves flush are not wired yet.

pub mod assets;
pub mod crash;
pub mod draw;
pub mod handle;
pub mod selftest;
pub mod studio;
// Not `audio` or `saves`: a web game's `genex::audio` and `genex::saves` are the facade's modules
// (through `pub use genex::*` below), and a shell module of the same name would shadow them.
pub mod web_audio;
pub mod web_saves;
pub mod web_stream;

#[cfg(target_arch = "wasm32")]
mod web;

/// The whole facade: a web build's `genex::` paths resolve through this crate.
pub use genex::*;

pub use draw::{AssetSource, AssetTable, MeshCache, to_scene};
pub use handle::GameHandle;
pub use selftest::{CaptureDigest, SELF_TEST_FORMAT, SelfTestPlan};

#[cfg(target_arch = "wasm32")]
pub use web::install_named;

/// `genex::install` in a web build: hand the game to the web shell, which starts it in
/// `studio_boot` once the saves mirror is loaded (its registrations checked then, as the facade's
/// `install` checks them). Off wasm32 it is the facade's own [`genex::install`].
pub fn install<W: Default + 'static>(game: Game<W>) {
    install_with_assets(game, &[]);
}

/// [`install`] for a game that compiles its assets into the binary.
pub fn install_with_assets<W: Default + 'static>(game: Game<W>, assets: AssetTable) {
    #[cfg(target_arch = "wasm32")]
    {
        let name = game.saves_name().to_owned();
        web::install_named(&name, game, assets);
    }
    #[cfg(not(target_arch = "wasm32"))]
    genex::install_with_assets(game, assets);
}
