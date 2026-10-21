//! The Studio's `saves` and `uiSettings` on the facade (G6 UIS-16): `Runtime::host_saves` serves
//! the dev flavour's `saves` verb between ticks (list, read, write, save, load, delete) through the
//! same slot driver as `ctx.slots()`; a load answers once applied with its checksum self-check; a
//! hostile envelope is refused with its code and nothing is written; a read past the line's
//! envelope cap answers `tooLarge`. The `uiSettings` row drives the session layer the verb sets.
//!
//! New behaviour (section 0 of the game systems plan): no host call reached the slots before.

use genex::prelude::*;
use genex::saves::{HOST_ENVELOPE_MAX_BYTES, HostSavesCall, SaveConfig};
use genex::ui::{UiConfig, UiSession};
use genex::{FIXED_STEP_MS, Runtime};
use serde::{Deserialize, Serialize};

/// The pond: fish and casts, drawn from the tick rng.
#[derive(Default, Serialize, Deserialize)]
struct World {
    fish: u32,
    casts: u32,
    notes: String,
}

/// A fresh, empty folder standing in for a Studio run's `state/`.
fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-host-saves-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    format!("{}/", dir.to_str().expect("a UTF-8 temp path"))
}

/// Every file under `dir`, recursively, sorted.
fn files(dir: &str) -> Vec<String> {
    let mut found = Vec::new();
    let mut folders = vec![std::path::PathBuf::from(dir)];
    while let Some(folder) = folders.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                folders.push(path);
            } else {
                found.push(path.display().to_string());
            }
        }
    }
    found.sort();
    found
}

fn pond() -> Game<World> {
    let mut game = Game::new(World::default()).title("Pond").world_size(400, 300);
    game.saves(SaveConfig::schema(1));
    game.save_world();
    game.on_reset(|sim, seed, rng, _gfx| {
        sim.world.fish = seed % 7 + rng.below(5);
    });
    game.on_update(|sim, ctx| {
        if ctx.rng.below(9) == 0 {
            sim.world.casts += 1;
        }
    });
    game.probe("pond", |sim| json!({ "fish": sim.world.fish, "casts": sim.world.casts, "notes": sim.world.notes.len() }));
    game
}

fn runtime(game: Game<World>, dir: &str) -> Runtime<World> {
    let mut rt = Runtime::new(game).expect("a consistent game installs");
    rt.use_studio_saves(dir);
    rt.seed(1);
    rt
}

fn run_to(rt: &mut Runtime<World>, tick: u64) {
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
    }
}

#[test]
fn a_host_load_answers_once_applied_with_its_checksum_match() {
    let dir = state_dir("load");
    let mut rt = runtime(pond(), &dir);
    run_to(&mut rt, 120);
    let saved = rt.host_saves(HostSavesCall::Save("pond".into(), "Chapter 2".into())).expect("saved");
    assert_eq!((saved["name"].as_str(), saved["tick"].as_u64(), saved["label"].as_str()), (Some("pond"), Some(120), Some("Chapter 2")));
    let checksum_at_save = rt.checksum();
    run_to(&mut rt, 400);
    assert_ne!(rt.checksum(), checksum_at_save);
    let loaded = rt.host_saves(HostSavesCall::Load("pond".into())).expect("loaded");
    assert_eq!(loaded["tick"].as_u64(), Some(120), "{loaded}");
    assert_eq!(loaded["checksumMatch"], json!(true));
    assert_eq!(rt.tick(), 120, "applied before the answer: no tick ran");
    assert_eq!(loaded["checksum"].as_str(), Some(rt.checksum().as_str()));
    assert_eq!(rt.checksum(), checksum_at_save, "the running game is the slot's");
    let listed = rt.host_saves(HostSavesCall::List).expect("listed");
    assert_eq!(listed["slots"].as_array().map(Vec::len), Some(1), "{listed}");
    assert_eq!(rt.host_saves(HostSavesCall::Delete("pond".into())).expect("deleted")["deleted"], json!("pond"));
    assert_eq!(rt.host_saves(HostSavesCall::List).expect("listed")["slots"], json!([]));
    let missing = rt.host_saves(HostSavesCall::Load("pond".into())).expect_err("gone");
    assert_eq!(missing.code.wire(), "save-slot-missing");
}

#[test]
fn a_hostile_envelope_write_refuses_with_its_code_and_writes_nothing() {
    let dir = state_dir("write");
    let mut rt = runtime(pond(), &dir);
    run_to(&mut rt, 30);
    rt.host_saves(HostSavesCall::Save("good".into(), String::new())).expect("saved");
    let good = rt.host_saves(HostSavesCall::Read("good".into())).expect("read");
    let before = files(&dir);
    let mut tampered = good.clone();
    tampered["tick"] = json!(31);
    let mut foreign = good.clone();
    foreign["game"] = json!("Another game");
    let mut newer = good.clone();
    newer["schema"] = json!(9);
    let rows: Vec<(&str, Vec<u8>, &str)> = vec![
        ("not json", b"{not json".to_vec(), "save-corrupt"),
        ("not a save", br#"{"hello":"world"}"#.to_vec(), "save-format-unknown"),
        ("digest mismatch", serde_json::to_vec(&tampered).expect("json"), "save-corrupt"),
        ("another game", serde_json::to_vec(&foreign).expect("json"), "save-corrupt"),
        ("a newer schema", serde_json::to_vec(&newer).expect("json"), "save-corrupt"),
        ("past the line cap", vec![b' '; HOST_ENVELOPE_MAX_BYTES + 1], "save-too-large"),
    ];
    for (what, document, code) in rows {
        let refused = rt.host_saves(HostSavesCall::Write("seeded".into(), document)).expect_err(what);
        assert_eq!(refused.code.wire(), code, "{what}: {refused}");
        assert_eq!(files(&dir), before, "{what}: nothing written");
    }
    let slot = rt.host_saves(HostSavesCall::Write("bad/slot".into(), serde_json::to_vec(&good).expect("json"))).expect_err("slot");
    assert_eq!(slot.code.wire(), "save-slot-invalid");
    assert_eq!(files(&dir), before);
    // The read envelope seeds a new slot, which loads as the original does.
    let seeded = rt.host_saves(HostSavesCall::Write("seeded".into(), serde_json::to_vec(&good).expect("json"))).expect("seeded");
    assert_eq!(seeded["name"], json!("seeded"));
    let loaded = rt.host_saves(HostSavesCall::Load("seeded".into())).expect("loaded");
    assert_eq!((loaded["tick"].as_u64(), loaded["checksumMatch"].clone()), (Some(30), json!(true)));
}

#[test]
fn a_read_past_the_line_cap_answers_too_large_with_its_size_and_digest() {
    let dir = state_dir("large");
    let mut game = pond();
    game.on_update(|sim, ctx| {
        if ctx.tick == 5 {
            // About 1.5 MiB of notes: the slot stores it deflated, the envelope document is larger.
            sim.world.notes = (0..200_000u32).map(|n| format!("{:07x}", n.wrapping_mul(2_654_435_761))).collect();
        }
    });
    let mut rt = runtime(game, &dir);
    run_to(&mut rt, 10);
    rt.host_saves(HostSavesCall::Save("big".into(), String::new())).expect("saved");
    let read = rt.host_saves(HostSavesCall::Read("big".into())).expect("read");
    assert_eq!(read["tooLarge"], json!(true), "{}", &read.to_string()[..200.min(read.to_string().len())]);
    let bytes = read["bytes"].as_u64().expect("bytes");
    assert!(bytes > HOST_ENVELOPE_MAX_BYTES as u64, "{bytes}");
    assert_eq!(read["digest"].as_str().map(str::len), Some(16));
    let small = runtime(pond(), &state_dir("small")).host_saves(HostSavesCall::List).expect("listed");
    assert_eq!(small["quota"].as_u64().map(|quota| quota > 0), Some(true));
}

#[test]
fn a_game_without_saves_refuses_save_not_configured() {
    let mut game = Game::new(World::default()).title("No saves");
    game.on_update(|_, _| {});
    let mut rt = Runtime::new(game).expect("installs");
    rt.use_studio_saves(&state_dir("none"));
    rt.seed(1);
    for call in [HostSavesCall::List, HostSavesCall::Read("a".into()), HostSavesCall::Load("a".into())] {
        assert_eq!(rt.host_saves(call).expect_err("refused").code.wire(), "save-not-configured");
    }
}

#[test]
fn a_session_pseudo_locale_shows_pseudo_text_from_the_next_tick() {
    // The `uiSettings` verb's layer (UIS-16 over UIS-10's session): `xx-pseudo` from the next tick.
    const ASSETS: genex::AssetTable = &[("lang/en.ftl", b"menu-start = Start\n")];
    let mut game = Game::new(World::default()).title("Menu");
    game.ui(UiConfig::new().locales(&["en"]).pseudo_locale(true));
    game.on_ui(|_, ui, _| {
        ui.label(genex::ui::tr("menu-start"));
    });
    let mut rt = Runtime::with_assets(game, Box::new(ASSETS)).expect("installs");
    rt.step(FIXED_STEP_MS);
    let plain = rt.state()["hud"]["items"].to_string();
    rt.ui_session(UiSession { locale: Some("xx-pseudo".into()), ..UiSession::default() }).expect("offered");
    rt.step(FIXED_STEP_MS);
    let state = rt.state();
    assert_eq!(state["volatile"]["ui"]["locale"], json!("xx-pseudo"));
    let pseudo = state["hud"]["items"].to_string();
    assert_ne!(pseudo, plain, "the HUD shows pseudo text: {pseudo}");
    let refused = rt.ui_session(UiSession { locale: Some("fr".into()), ..UiSession::default() }).expect_err("not offered");
    assert_eq!(refused.wire(), "text-locale-unknown");
}
