//! Save parity across destinations (UIS-18's GE row "save/load round trip, native equal to wasm"):
//! a keyboard-only script starts a new game, plays, pauses and saves `slot-1` through the slot
//! list, on the web's in-memory store. The stored envelope (less its wall-clock date, which only a
//! native window records) hashes to one pinned digest, and loading it back answers
//! `checksumMatch`. These rows live in the library so the same binary runs as a plain wasm32
//! libtest module (the web entry is compiled out of it) and on the host, aarch64 or x86_64.

use genex::saves::HostSavesCall;
use genex::{FIXED_STEP_MS, Input, Key, Runtime, Value};

use crate::{ASSETS, World, game};

/// The envelope digest every destination must write (FNV-1a 64 of its canonical JSON, the date
/// removed).
const ENVELOPE_DIGEST: u64 = 0x4ad1_b7eb_38cc_d558;
/// The seed the script runs.
const SEED: u32 = 7;
/// The moves the script makes once playing, one tile per press.
const MOVES: [Key; 8] = [Key::ArrowRight, Key::ArrowRight, Key::ArrowDown, Key::ArrowDown, Key::ArrowLeft, Key::ArrowUp, Key::ArrowUp, Key::ArrowRight];
/// Ticks played between moves.
const MOVE_GAP_TICKS: u32 = 20;
const SLOT: &str = "slot-1";
/// The date member a native window's envelope carries and a web one never does.
const DATE_KEY: &str = "savedAtMs";
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

fn steps(rt: &mut Runtime<World>, ticks: u32) {
    for _ in 0..ticks {
        rt.step(FIXED_STEP_MS);
    }
}

/// Press `key` for one tick and release it for one.
fn press(rt: &mut Runtime<World>, key: Key) {
    rt.inject(Input::key_down(key));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_up(key));
    rt.step(FIXED_STEP_MS);
}

fn focus(rt: &Runtime<World>) -> Value {
    rt.state()["hud"]["focus"].clone()
}

/// Remove every `savedAtMs` member, at any depth.
fn without_date(value: &mut Value) {
    match value {
        Value::Object(map) => {
            map.remove(DATE_KEY);
            map.values_mut().for_each(without_date);
        }
        Value::Array(items) => items.iter_mut().for_each(without_date),
        _ => {}
    }
}

fn fnv(bytes: &[u8]) -> u64 {
    bytes.iter().fold(FNV_OFFSET, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(FNV_PRIME))
}

/// Delete every slot: the web store is per thread, and wasm32 runs every row on one thread.
fn clear_slots(rt: &mut Runtime<World>) {
    let list = rt.host_saves(HostSavesCall::List).expect("the slots list");
    let names: Vec<String> = list["slots"].as_array().into_iter().flatten().filter_map(|slot| slot["name"].as_str().map(str::to_owned)).collect();
    for name in names {
        rt.host_saves(HostSavesCall::Delete(name)).expect("the slot deletes");
    }
}

/// The script up to the save: the runtime, and the slot's envelope as stored.
fn saved() -> (Runtime<World>, Value) {
    let mut rt = Runtime::with_assets(game(), Box::new(ASSETS)).expect("installs");
    rt.use_web_saves();
    clear_slots(&mut rt);
    rt.seed(SEED);
    steps(&mut rt, 2);
    assert_eq!(focus(&rt), genex::json!("title.new"), "Continue is disabled with no slots, so New game holds focus");
    press(&mut rt, Key::Enter);
    for key in MOVES {
        steps(&mut rt, MOVE_GAP_TICKS);
        press(&mut rt, key);
    }
    press(&mut rt, Key::Escape);
    steps(&mut rt, 1);
    press(&mut rt, Key::ArrowDown);
    press(&mut rt, Key::ArrowDown);
    assert_eq!(focus(&rt), genex::json!("pause.save"));
    press(&mut rt, Key::Enter);
    steps(&mut rt, 1);
    assert_eq!(focus(&rt), genex::json!("slots.0"), "the save list focuses slot-1");
    press(&mut rt, Key::Enter);
    steps(&mut rt, 1);
    let document = rt.host_saves(HostSavesCall::Read(SLOT.to_owned())).expect("slot-1 was saved");
    (rt, document)
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn the_saved_envelope_is_the_same_bytes_on_every_destination() {
    let (_, mut document) = saved();
    without_date(&mut document);
    let digest = fnv(document.to_string().as_bytes());
    assert_eq!(digest, ENVELOPE_DIGEST, "envelope digest {digest:#018x}: {document}");
}

#[cfg_attr(not(target_arch = "wasm32"), test)]
#[cfg_attr(target_arch = "wasm32", wasm_bindgen_test::wasm_bindgen_test)]
fn loading_the_slot_back_matches_its_checksum() {
    let (mut rt, _) = saved();
    let saved_tick = rt.state()["volatile"]["saves"]["lastSave"]["tick"].clone();
    steps(&mut rt, 90);
    let answer = rt.host_saves(HostSavesCall::Load(SLOT.to_owned())).expect("the load applies");
    assert_eq!(answer["checksumMatch"], genex::json!(true), "{answer}");
    assert_eq!(answer["tick"], saved_tick);
    assert_eq!(rt.state()["volatile"]["menus"]["screen"], genex::json!("playing"), "a load lands in play");
}
