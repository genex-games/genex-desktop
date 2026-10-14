//! The rust-game fixture's web module: the exports the Rust web shell (`web/shell.html`) binds,
//! answering its page contract with a frame counter and no GPU work. `studio_boot` accepts the
//! canvas and reports a fixture receipt; `studio_call` answers the shell's verbs in genex-studio's
//! web envelope (`{id:null, ok, op, result}`); `studio_frame` advances the clock while running.
//! The saves mirror's exports (`studio_saves_*`, genex-platform-web's) keep nothing: the fixture
//! never saves, so the shell's preload, flush and notice see an empty, healthy mirror.
//! The fixture stands in for a game in development profiles and tests; it is never shipped.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

/// How long one fixed simulation step lasts, in milliseconds (60 Hz, as the runtime's).
const STEP_MS: f64 = 1000.0 / 60.0;

/// What the fixture remembers between calls.
struct World {
    seed: u64,
    running: bool,
    frame: u64,
    time_ms: f64,
    taps: u64,
}

thread_local! {
    static WORLD: RefCell<World> = const {
        RefCell::new(World { seed: 0, running: false, frame: 0, time_ms: 0.0, taps: 0 })
    };
}

/// Boots against the shell's canvas; the fixture draws nothing, so any canvas is accepted.
#[wasm_bindgen]
pub fn studio_boot(_canvas: JsValue) -> String {
    r#"{"ok":true,"receipt":{"fixture":"genex-rust-fixture","renderer":"none"}}"#.to_string()
}

/// One verb of the page contract: `op` with its JSON argument, answered as a JSON envelope.
#[wasm_bindgen]
pub fn studio_call(op: &str, arg: &str) -> String {
    let result = WORLD.with(|world| answer(&mut world.borrow_mut(), op, arg));
    match result {
        Some(result) => format!(r#"{{"id":null,"ok":true,"op":{},"result":{}}}"#, quoted(op), result),
        None => format!(r#"{{"id":null,"ok":false,"op":{},"error":"unknown-op"}}"#, quoted(op)),
    }
}

/// One animation frame of `ms` milliseconds: the clock moves only while running.
#[wasm_bindgen]
pub fn studio_frame(ms: f64) {
    WORLD.with(|world| {
        let mut world = world.borrow_mut();
        if world.running {
            advance(&mut world, ms);
        }
    });
}

/// The IndexedDB database the shell opens for this game's saves.
#[wasm_bindgen]
pub fn studio_saves_database() -> String {
    "genex-saves:genex-rust-fixture".to_string()
}

/// The saved files IndexedDB held; the fixture keeps none of them.
#[wasm_bindgen]
pub fn studio_saves_preload(_entries: JsValue) {}

/// The files saved since the last take: never any.
#[wasm_bindgen]
pub fn studio_saves_take() -> Vec<JsValue> {
    Vec::new()
}

/// How a flush went; nothing was taken, so nothing changes.
#[wasm_bindgen]
pub fn studio_saves_flushed(_error: Option<String>, _names: JsValue) {}

/// IndexedDB could not be opened; the fixture saves nothing either way.
#[wasm_bindgen]
pub fn studio_saves_unavailable() {}

/// Files waiting to be written: never any.
#[wasm_bindgen]
pub fn studio_saves_pending() -> u32 {
    0
}

/// The mirror's account, in genex-platform-web's shape.
#[wasm_bindgen]
pub fn studio_saves_status() -> String {
    r#"{"store":"indexeddb","files":0,"pending":0,"inFlight":0,"error":null}"#.to_string()
}

fn answer(world: &mut World, op: &str, arg: &str) -> Option<String> {
    match op {
        "seed" => {
            world.seed = number_field(arg, "seed").map_or(0, |seed| seed as u64);
            Some(format!(r#"{{"seed":{}}}"#, world.seed))
        }
        "start" => {
            world.running = true;
            Some("{}".to_string())
        }
        "pause" => {
            world.running = false;
            Some("{}".to_string())
        }
        "step" => {
            let before = world.frame;
            advance(world, number_field(arg, "ms").unwrap_or(STEP_MS));
            Some(format!(r#"{{"steppedFrames":{},"drawCalls":0}}"#, world.frame - before))
        }
        "state" => Some(state(world)),
        "input" => {
            if arg.contains("\"tap\"") {
                world.taps += 1;
            }
            Some(state(world))
        }
        "cameras" => Some(r#"{"cameras":["main"]}"#.to_string()),
        "eyes" => Some(r#"{"eyes":[]}"#.to_string()),
        "demos" => Some(r#"{"demos":[]}"#.to_string()),
        "demo" => Some(r#"{"ok":false,"available":[]}"#.to_string()),
        "debugCamera" => Some(r#"{"camera":null}"#.to_string()),
        _ => None,
    }
}

fn advance(world: &mut World, ms: f64) {
    let ms = if ms.is_finite() && ms > 0.0 { ms } else { 0.0 };
    let frames = (ms / STEP_MS).floor().max(1.0) as u64;
    world.frame += frames;
    world.time_ms += frames as f64 * STEP_MS;
}

fn state(world: &World) -> String {
    format!(
        r#"{{"fixture":"genex-rust-fixture","seed":{},"running":{},"frame":{},"timeMs":{:.3},"taps":{}}}"#,
        world.seed, world.running, world.frame, world.time_ms, world.taps
    )
}

/// The number after `"name":` in a small JSON object, read without a JSON parser.
fn number_field(arg: &str, name: &str) -> Option<f64> {
    let key = format!("\"{name}\":");
    let at = arg.find(&key)? + key.len();
    let rest = arg[at..].trim_start();
    let end = rest
        .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == 'e' || c == 'E' || c == '+'))
        .unwrap_or(rest.len());
    rest[..end].parse().ok()
}

/// `text` as a JSON string (the ops are plain words; anything else is escaped).
fn quoted(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
