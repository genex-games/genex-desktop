//! The demos: each drives the lab with real input and answers what happened.
//!
//! - `play`: hold Overload for a while, let go, run on: the movers grow and the scopes and counters
//!   have frames to report. Never crashes.
//! - `panic_at_300`: hold Overload from the first tick and run past tick 300: the update hook panics
//!   on purpose (a `panic` record: `fatal: true`, `handled: false`, located in `src/lab.rs`). It
//!   never answers.
//! - `wasm_trap`: on the web, a WebAssembly `unreachable` trap with no Rust panic before it (the
//!   shell's own `wasm-trap` record). Off the web it answers `{"trapped": false}` and does nothing.

use genex::prelude::*;
use genex::{DemoDriver, Input};

use crate::lab::{OVERLOAD_KEY, PANIC_TICK, World, lab_probe};

/// Every demo, in registration order (the first is the one a determinism check plays).
pub const DEMOS: [&str; 3] = ["play", "panic_at_300", "wasm_trap"];

/// A demo's step: three ticks.
const STEP_MS: u32 = 50;
/// `play`: steps with Overload held, then steps after.
const PLAY_HELD_STEPS: u32 = 40;
const PLAY_AFTER_STEPS: u32 = 20;
/// `panic_at_300`: steps past the panic tick (three ticks a step, a margin of a few).
const PANIC_STEPS: u32 = (PANIC_TICK as u32) / 3 + 5;

fn run(d: &mut DemoDriver<'_, World>, steps: u32) {
    for _ in 0..steps {
        d.advance_ms(STEP_MS);
    }
}

fn play(d: &mut DemoDriver<'_, World>) -> Value {
    d.inject(Input::key_down(OVERLOAD_KEY));
    run(d, PLAY_HELD_STEPS);
    d.inject(Input::key_up(OVERLOAD_KEY));
    run(d, PLAY_AFTER_STEPS);
    lab_probe(d.sim())
}

fn panic_at_300(d: &mut DemoDriver<'_, World>) -> Value {
    d.inject(Input::key_down(OVERLOAD_KEY));
    run(d, PANIC_STEPS);
    // Not reached: the update hook panicked at tick 300.
    json!({ "panicked": false, "lab": lab_probe(d.sim()) })
}

#[cfg(target_arch = "wasm32")]
fn wasm_trap(_d: &mut DemoDriver<'_, World>) -> Value {
    core::arch::wasm32::unreachable()
}

#[cfg(not(target_arch = "wasm32"))]
fn wasm_trap(_d: &mut DemoDriver<'_, World>) -> Value {
    json!({ "trapped": false, "reason": "a WebAssembly trap exists on the web only" })
}

/// Register every demo.
pub fn wire(game: &mut Game<World>) {
    game.demo("play", play);
    game.demo("panic_at_300", panic_at_300);
    game.demo("wasm_trap", wasm_trap);
}
