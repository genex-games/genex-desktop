//! The demos: each drives the game with real input (keys, the pointer, a pad, fingers) and answers
//! what happened, so a check judges the input path end to end.
//!
//! - `play`: keyboard and mouse: walk right, aim with the pointer, hold fire, dash.
//! - `rebind`: open the pause menu, walk its focus with Tab to the widget labelled "Rebind Dash",
//!   press it, press J: dash now answers J (and no longer Space), and the binding is saved.
//! - `pad_glyphs`: a PlayStation pad presses its bottom face button: the prompts switch to the pad
//!   and the dash prompt reads "Cross".
//! - `touch`: fingers on the floating move stick, the dash button and the aim stick.
//! - `replay`: plays back the recorded 600-tick session in `replay/session-600.track` (seed,
//!   bindings and tick rows): the arena ends exactly as the recorded run did.

use genex::actions::InputTrack;
use genex::prelude::*;
use genex::{DemoDriver, Input};

use crate::arena::{World, arena_probe};
use crate::WORLD_SIZE;
use crate::controls::{AIM_STICK_AT, DASH_BUTTON_AT, MOVE_STICK_AT, bottom_left, bottom_right};

/// Every demo, in registration order (the first is the one a determinism check plays).
pub const DEMOS: [&str; 5] = ["play", "rebind", "pad_glyphs", "touch", "replay"];
/// The recorded session the `replay` demo plays (written by `tests/demos.rs` with
/// `GENEX_INPUT_TWINSTICK_BLESS=1`).
pub const REPLAY_TRACK: &[u8] = include_bytes!("../replay/session-600.track");
/// The label of the Controls panel's first dash binding: what the `rebind` demo walks to.
pub const REBIND_DASH: &str = "Rebind Dash";

/// A demo's step: three ticks.
const STEP_MS: u32 = 50;
/// The most Tab presses the `rebind` demo makes looking for its widget.
const FOCUS_STEPS_MAX: u32 = 60;
/// The standard mapping's bottom face button.
const PAD_SOUTH: usize = 0;
/// Buttons in the standard mapping.
const PAD_BUTTONS: usize = 17;

fn run(d: &mut DemoDriver<'_, World>, steps: u32) {
    for _ in 0..steps {
        d.advance_ms(STEP_MS);
    }
}

/// Tap `key` and let the tick read it.
fn tap(d: &mut DemoDriver<'_, World>, key: Key) {
    d.inject(Input::key_tap(key));
    run(d, 1);
}

/// One pad at index 0 of `family` with these button values: the `input` verb's pad JSON (the
/// facade's `Input` has no pad builder yet).
pub fn pad(family: &str, buttons: &[(usize, f32)]) -> Input {
    let mut values = [0.0f32; PAD_BUTTONS];
    for (at, value) in buttons {
        values[*at] = *value;
    }
    let list: Vec<String> = values.iter().map(f32::to_string).collect();
    let text = format!(r#"{{"pads":[{{"index":0,"family":"{family}","buttons":[{}],"axes":[0,0,0,0]}}]}}"#, list.join(","));
    let Ok(arg) = genex_core::json::parse(text.as_bytes()) else { return Input::text("") };
    Input::from_injection(genex_core::input::parse_injection(&arg))
}

fn play(d: &mut DemoDriver<'_, World>) -> Value {
    d.inject(Input::key_down(Key::KeyD));
    run(d, 10);
    d.inject(Input::key_up(Key::KeyD).and(Input::pointer(0.8, 0.3)).and(Input::key_down(Key::Mouse1)));
    run(d, 20);
    d.inject(Input::key_up(Key::Mouse1));
    tap(d, Key::Space);
    run(d, 4);
    arena_probe(d.sim())
}

fn rebind(d: &mut DemoDriver<'_, World>) -> Value {
    run(d, 2);
    tap(d, Key::KeyP);
    run(d, 1);
    let mut steps = 0;
    while d.sim().world.shown.focused.as_deref() != Some(REBIND_DASH) && steps < FOCUS_STEPS_MAX {
        tap(d, Key::Tab);
        steps += 1;
    }
    let found = d.sim().world.shown.focused.as_deref() == Some(REBIND_DASH);
    // Enter presses the focused button (listen mode), then J is the new binding.
    tap(d, Key::Enter);
    tap(d, Key::KeyJ);
    let label = d.sim().world.shown.dash.clone();
    tap(d, Key::Escape);
    run(d, 2);
    let before = d.sim().world.dashes;
    tap(d, Key::Space);
    run(d, 2);
    let after_space = d.sim().world.dashes;
    tap(d, Key::KeyJ);
    run(d, 2);
    json!({
        "found": found,
        "focusSteps": steps,
        "dashLabel": label,
        "paused": d.sim().world.paused,
        "spaceDashed": after_space > before,
        "jDashed": d.sim().world.dashes > after_space,
    })
}

fn pad_glyphs(d: &mut DemoDriver<'_, World>) -> Value {
    run(d, 2);
    let keyboard = d.sim().world.shown.dash.clone();
    d.inject(pad("playstation", &[(PAD_SOUTH, 1.0)]));
    run(d, 2);
    d.inject(pad("playstation", &[]));
    run(d, 2);
    let shown = &d.sim().world.shown;
    json!({
        "keyboardDash": keyboard,
        "device": shown.device,
        "dash": shown.dash,
        "fire": shown.fire,
        "pause": shown.pause,
        "dashes": d.sim().world.dashes,
    })
}

fn touch(d: &mut DemoDriver<'_, World>) -> Value {
    let world = WORLD_SIZE;
    let walk = bottom_left(MOVE_STICK_AT, world);
    d.inject(Input::touch_start(1, walk[0], walk[1]));
    run(d, 1);
    d.inject(Input::touch_move(1, walk[0] + 60.0, walk[1]));
    run(d, 10);
    d.inject(Input::touch_end(1, walk[0] + 60.0, walk[1]));
    let dash = bottom_right(DASH_BUTTON_AT, world);
    d.inject(Input::touch_start(2, dash[0], dash[1]));
    run(d, 1);
    d.inject(Input::touch_end(2, dash[0], dash[1]));
    run(d, 2);
    let aim = bottom_right(AIM_STICK_AT, world);
    d.inject(Input::touch_start(3, aim[0], aim[1] - 50.0));
    run(d, 12);
    d.inject(Input::touch_end(3, aim[0], aim[1] - 50.0));
    run(d, 1);
    let mut answer = arena_probe(d.sim());
    answer["device"] = json!(d.sim().world.shown.device);
    answer
}

fn replay(d: &mut DemoDriver<'_, World>) -> Value {
    let played = InputTrack::decode(REPLAY_TRACK).and_then(|track| d.replay(&track));
    match played {
        Ok(step) => json!({ "ticks": step.ticks, "arena": arena_probe(d.sim()) }),
        Err(error) => json!({ "error": error.code.as_str(), "detail": error.detail }),
    }
}

/// Register every demo on `game`.
pub fn wire(game: &mut Game<World>) {
    game.demo("play", play);
    game.demo("rebind", rebind);
    game.demo("pad_glyphs", pad_glyphs);
    game.demo("touch", touch);
    game.demo("replay", replay);
}
