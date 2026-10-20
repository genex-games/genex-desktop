//! Injected input (the studio's `input` verb, a demo's `inject`) and the merger that turns it
//! into one tick's [`Keys`], [`Touches`], [`Pads`] and pointer state.
//!
//! The merge is genex-core's golden-checked port of `input.cpp` (canonical key names, caps, edges
//! on the first tick after the input arrived, echoes, pads, committed text) plus contract v2's
//! touches; this module only turns the facade's [`Input`] builder into a genex-core
//! [`Injection`] and the merged [`CoreTick`] into the facade's types.

use crate::ctx::{Key, Keys, Pads, Touch, TouchPhase, Touches};
use genex_core::input::{
    FrameSample, Injection, InputMerger, TickInput as CoreTick, TouchAction, TouchPhase as CorePhase, TouchStep, Vec2 as CoreVec2,
};
use glam::Vec2;

/// Input to inject, built from the constructors and combined with [`Input::and`].
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Input {
    injection: Injection,
}

fn core_vec(x: f32, y: f32) -> CoreVec2 {
    CoreVec2 { x, y }
}

impl Input {
    fn keys(list: fn(&mut Injection) -> &mut Vec<String>, key: Key) -> Input {
        let mut injection = Injection::default();
        list(&mut injection).push(key.code().to_owned());
        Input { injection }
    }

    /// Press `key` and keep it held.
    pub fn key_down(key: Key) -> Input {
        Input::keys(|i| &mut i.down, key)
    }

    /// Release `key`.
    pub fn key_up(key: Key) -> Input {
        Input::keys(|i| &mut i.up, key)
    }

    /// Press and release `key` before the next tick.
    pub fn key_tap(key: Key) -> Input {
        Input::keys(|i| &mut i.tap, key)
    }

    /// Move the pointer to a fraction of the frame (x right, y down).
    pub fn pointer(x: f32, y: f32) -> Input {
        Input { injection: Injection { pointer: Some(core_vec(x, y)), ..Injection::default() } }
    }

    /// Move the pointer there and tap Mouse1 (which also taps touch 0).
    pub fn click_at(x: f32, y: f32) -> Input {
        Input::pointer(x, y).and(Input::key_tap(Key::Mouse1))
    }

    /// Mouse-look movement, in pixels.
    pub fn look(dx: f32, dy: f32) -> Input {
        Input { injection: Injection { look: core_vec(dx, dy), ..Injection::default() } }
    }

    /// Wheel movement.
    pub fn wheel(dx: f32, dy: f32) -> Input {
        Input { injection: Injection { wheel: core_vec(dx, dy), ..Injection::default() } }
    }

    /// Committed text.
    pub fn text(text: &str) -> Input {
        Input { injection: Injection { text: text.as_bytes().to_vec(), ..Injection::default() } }
    }

    fn touch(step: TouchStep, id: u32, x: f32, y: f32) -> Input {
        let touch = TouchAction { id, step, x, y };
        Input { injection: Injection { touches: vec![touch], ..Injection::default() } }
    }

    /// Finger `id` goes down at world pixel (`x`, `y`).
    pub fn touch_start(id: u32, x: f32, y: f32) -> Input {
        Input::touch(TouchStep::Start, id, x, y)
    }

    /// Finger `id` moves to world pixel (`x`, `y`).
    pub fn touch_move(id: u32, x: f32, y: f32) -> Input {
        Input::touch(TouchStep::Move, id, x, y)
    }

    /// Finger `id` lifts at world pixel (`x`, `y`).
    pub fn touch_end(id: u32, x: f32, y: f32) -> Input {
        Input::touch(TouchStep::End, id, x, y)
    }

    /// The studio's checked `input` verb as facade input.
    pub fn from_injection(injection: Injection) -> Input {
        Input { injection }
    }

    /// This input followed by `other` (lists concatenate, deltas add, the later pointer wins).
    pub fn and(mut self, other: Input) -> Input {
        let (into, more) = (&mut self.injection, other.injection);
        into.down.extend(more.down);
        into.up.extend(more.up);
        into.tap.extend(more.tap);
        into.look = core_vec(into.look.x + more.look.x, into.look.y + more.look.y);
        into.wheel = core_vec(into.wheel.x + more.wheel.x, into.wheel.y + more.wheel.y);
        into.pointer = more.pointer.or(into.pointer);
        into.pads.extend(more.pads);
        into.text.extend(more.text);
        into.touches.extend(more.touches);
        into.ignored += more.ignored;
        self
    }

    /// The genex-core injection this input is.
    pub fn injection(&self) -> &Injection {
        &self.injection
    }
}

/// The merged input one tick runs with.
#[derive(Clone, Debug, Default)]
pub(crate) struct TickInput {
    /// genex-core's merged tick itself: what the actions evaluate and the journal records (G6
    /// input keeps one tick type; the fields below are the facade's view of it).
    pub core: CoreTick,
    pub keys: Keys,
    pub touches: Touches,
    pub pads: Pads,
    pub pointer: Vec2,
    pub look: Vec2,
    pub wheel: Vec2,
    pub pointer_lock: bool,
    pub text: String,
}

/// genex-core's merger behind the facade's types.
#[derive(Debug, Default)]
pub(crate) struct Merger {
    core: InputMerger,
}

impl Merger {
    /// Queue an injection; answers the keys now held.
    pub fn inject(&mut self, input: Input) -> Vec<String> {
        self.core.inject(&input.injection);
        self.core.held()
    }

    /// Real input a shell sampled for the frame about to run.
    pub fn sample(&mut self, sample: &FrameSample) {
        self.core.sample(sample);
    }

    /// The keys held now, canonical and sorted.
    pub fn held(&self) -> Vec<String> {
        self.core.held()
    }

    /// The input for the next tick; edges, deltas and touch steps are consumed.
    pub fn next_tick(&mut self, world_size: [u32; 2]) -> TickInput {
        TickInput::from_core(self.core.next_tick(), world_size)
    }
}

impl TickInput {
    /// The facade's view of one merged genex-core tick (a merger's, or a replayed track row).
    pub fn from_core(tick: CoreTick, world_size: [u32; 2]) -> TickInput {
        let keys = Keys {
            held: tick.keys.held().to_vec(),
            pressed: tick.keys.pressed_keys().to_vec(),
            released: tick.keys.released_keys().to_vec(),
        };
        let pointer = Vec2::new(tick.pointer.x, tick.pointer.y);
        let touches = touches_of(&tick, &keys, pointer, world_size);
        TickInput {
            keys,
            touches,
            pads: Pads::from_core(tick.pads),
            pointer,
            look: Vec2::new(tick.look.x, tick.look.y),
            wheel: Vec2::new(tick.wheel.x, tick.wheel.y),
            pointer_lock: tick.pointer_lock,
            text: tick.text.clone(),
            core: tick,
        }
    }
}

fn phase_of(phase: CorePhase) -> TouchPhase {
    match phase {
        CorePhase::Began => TouchPhase::Began,
        CorePhase::Held => TouchPhase::Held,
        CorePhase::Ended => TouchPhase::Ended,
        CorePhase::Tapped => TouchPhase::Tapped,
    }
}

/// The tick's fingers, by id, and touch 0 following Mouse1 (so play scripts and desktop players
/// reach touch controls) unless a real finger 0 is down.
fn touches_of(tick: &CoreTick, keys: &Keys, pointer: Vec2, world_size: [u32; 2]) -> Touches {
    let mut list: Vec<Touch> = tick
        .touches
        .iter()
        .map(|t| Touch { id: t.id, position: Vec2::new(t.x, t.y), phase: phase_of(t.phase) })
        .collect();
    if !list.iter().any(|touch| touch.id == 0)
        && let Some(touch) = emulated_touch(keys, pointer, world_size)
    {
        list.insert(0, touch);
    }
    Touches { list }
}

/// Touch 0 from Mouse1's edges, at the pointer, in world pixels.
fn emulated_touch(keys: &Keys, pointer: Vec2, world_size: [u32; 2]) -> Option<Touch> {
    let mouse = Key::Mouse1.code();
    let down = keys.down_code(mouse);
    let pressed = keys.pressed_code(mouse);
    let released = keys.released.iter().any(|k| k == mouse);
    let phase = match (pressed, released, down) {
        (true, true, false) => TouchPhase::Tapped,
        (true, _, _) => TouchPhase::Began,
        (false, true, _) => TouchPhase::Ended,
        (false, false, true) => TouchPhase::Held,
        (false, false, false) => return None,
    };
    let size = Vec2::new(world_size[0] as f32, world_size[1] as f32);
    Some(Touch { id: 0, position: pointer * size, phase })
}
