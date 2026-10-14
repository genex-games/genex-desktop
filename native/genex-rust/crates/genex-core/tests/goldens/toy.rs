//! The toy game the C++ driver's `session` unit runs (golden_driver.cpp's `Toy`), mirrored line
//! for line so the recorded sessions' checksums can be compared.

use genex_core::input::{PadButton, TickInput};
use genex_core::json::Value;
use genex_core::rng::Pcg32;
use genex_core::session::Hooks;

/// What the toy keeps between ticks.
#[derive(Clone, Debug, Default)]
pub struct Toy {
    seed: u32,
    x: f64,
    wheel: f64,
    jumps: i32,
    walked: i32,
    rolls: i32,
    drift: f64,
    text_bytes: i32,
    pad_presses: i32,
    pointer_x: f64,
    last_tick: i64,
    resets: i32,
}

impl Toy {
    /// A toy before any seed.
    pub fn new() -> Toy {
        Toy { last_tick: -1, ..Toy::default() }
    }

    /// The probes the driver reports, in its order.
    pub fn probes(&self) -> Value {
        let mut probes = Value::object();
        probes.set("x", Value::from(self.x));
        probes.set("wheel", Value::from(self.wheel));
        probes.set("jumps", Value::from(self.jumps));
        probes.set("walked", Value::from(self.walked));
        probes.set("rolls", Value::from(self.rolls));
        probes.set("drift", Value::from(self.drift));
        probes.set("textBytes", Value::from(self.text_bytes));
        probes.set("padPresses", Value::from(self.pad_presses));
        probes.set("pointerX", Value::from(self.pointer_x));
        probes.set("lastTick", Value::from(self.last_tick as f64));
        probes.set("resets", Value::from(self.resets));
        probes.set("frame", Value::from(999));
        let mut wall = Value::object();
        wall.set("ms", Value::from(self.last_tick as f64 * 0.25));
        probes.set("volatile", wall);
        probes
    }
}

impl Hooks for Toy {
    fn reset(&mut self, seed: u32) {
        let resets = self.resets + 1;
        *self = Toy { seed, resets, ..Toy::new() };
    }

    fn tick(&mut self, input: &TickInput, tick: u64, rng: &mut Pcg32) {
        self.x += f64::from(input.look.x);
        self.wheel += f64::from(input.wheel.y);
        if input.keys.pressed("Space") {
            self.jumps += 1;
        }
        if input.keys.down("w") {
            self.walked += 1;
        }
        self.rolls += rng.range_i32(1, 6);
        self.drift += f64::from(rng.range_f32(-0.5, 0.5));
        self.text_bytes += input.text.len() as i32;
        if input.pads.pressed(0, PadButton::A) {
            self.pad_presses += 1;
        }
        self.pointer_x = f64::from(input.pointer.x);
        self.last_tick = tick as i64;
        let _ = self.seed;
    }
}
