//! Save slots on the facade (G6 saves, UIS-9): `game.saves`, `game.save_section`,
//! `game.save_world`, `ctx.slots()`, the end-of-tick save, the swap-in load with its checksum
//! self-check, the `genex.nav` section, `state().volatile.saves` and the install refusals.
//!
//! New behaviour (section 0 of the game systems plan), except the two characterization rows:
//! `ctx.save`/`ctx.load` bytes and `state()` without `game.saves` are what they were before.

use std::cell::RefCell;
use std::rc::Rc;

use genex::nav::{NavArea, NavConfig, NavInput, NavMesh};
use genex::prelude::*;
use genex::saves::{SaveConfig, SaveErrorCode, SlotOp};
use genex::{FIXED_STEP_MS, InstallErrorCode, Runtime};
use genex_nav::agents_api::NavAgent;
use genex_nav::filter::NavFilter;
use serde::{Deserialize, Serialize};

const SAVE_TICK: u64 = 300;
const END_TICK: u64 = 600;
const SLOT: &str = "pond";

/// The pond: fish, casts and catches, all drawn from the tick rng.
#[derive(Default, Serialize, Deserialize)]
struct World {
    fish: u32,
    casts: u32,
    caught: u32,
    ripples: Vec<u32>,
    quests: u32,
}

/// One install refusal row: its name, the registrations and the code `install` answers.
type RefusalRow<'a> = (&'a str, &'a dyn Fn(&mut Game<World>), InstallErrorCode);

/// What a test reads back from the hooks: each slot event as `op:result`.
type Log = Rc<RefCell<Vec<String>>>;

/// A fresh, empty folder standing in for a Studio run's `state/`.
fn state_dir(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("genex-saves-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut text = dir.to_str().expect("a UTF-8 temp path").to_owned();
    text.push('/');
    text
}

fn event_text(op: SlotOp, result: &Result<genex::saves::SlotInfo, genex::saves::SaveError>) -> String {
    match result {
        Ok(info) => format!("{}:{}@{}", op.wire(), info.name.as_str(), info.tick),
        Err(error) => format!("{}:{}", op.wire(), error.code.wire()),
    }
}

/// The pond, saving `SLOT` at the end of tick 299 (it holds tick 300) and loading it on `KeyL`.
fn pond(log: &Log) -> Game<World> {
    let mut game = Game::new(World::default()).title("Pond").world_size(400, 300);
    game.saves(SaveConfig::schema(1));
    game.on_reset(|sim, seed, rng, _gfx| {
        sim.world.fish = seed % 7 + rng.below(5);
    });
    let events = Rc::clone(log);
    game.on_update(move |sim, ctx| {
        for event in ctx.slots().events() {
            events.borrow_mut().push(event_text(event.op, &event.result));
        }
        let w = &mut sim.world;
        if ctx.rng.below(9) == 0 {
            w.casts += 1;
            if ctx.rng.unit() < 0.4 && w.fish > 0 {
                w.caught += 1;
                w.fish -= 1;
            }
        }
        if ctx.tick.is_multiple_of(37) {
            w.ripples.push(ctx.rng.below(1000));
            w.fish += 1;
        }
        if ctx.tick + 1 == SAVE_TICK {
            ctx.slots().save(SLOT, "Chapter 2").expect("the save is queued");
        }
        if ctx.keys.pressed(Key::KeyL) {
            ctx.slots().load(SLOT).expect("the load is queued");
        }
    });
    game.probe("pond", |sim| {
        let w = &sim.world;
        json!({ "fish": w.fish, "casts": w.casts, "caught": w.caught, "ripples": w.ripples, "quests": w.quests })
    });
    game
}

fn runtime(game: Game<World>, name: &str) -> Runtime<World> {
    let mut rt = Runtime::new(game).expect("a consistent game installs");
    rt.use_studio_saves(&state_dir(name));
    rt.seed(1);
    rt
}

fn run_to(rt: &mut Runtime<World>, tick: u64) {
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
    }
}

/// Tap `KeyL` on the next tick and run it: the load is restored before the tick after.
fn press_load(rt: &mut Runtime<World>) {
    rt.inject(Input::key_tap(Key::KeyL));
    rt.step(FIXED_STEP_MS);
}

fn volatile_saves(rt: &Runtime<World>) -> serde_json::Value {
    rt.state()["volatile"]["saves"].clone()
}

#[test]
fn a_save_at_300_loaded_and_replayed_equals_the_uninterrupted_run() {
    let log = Log::default();
    let mut game = pond(&log);
    game.save_world();
    let mut rt = runtime(game, "replay");
    run_to(&mut rt, END_TICK);
    let uninterrupted = rt.checksum();
    assert!(log.borrow().contains(&format!("save:{SLOT}@{SAVE_TICK}")), "{:?}", log.borrow());
    assert_eq!(volatile_saves(&rt)["lastSave"]["tick"], json!(SAVE_TICK));

    press_load(&mut rt);
    // The load swapped in at the start of the tick after the press, which then ran as tick 300.
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.tick(), SAVE_TICK + 1);
    run_to(&mut rt, END_TICK);
    assert_eq!(rt.checksum(), uninterrupted);
    let last = &volatile_saves(&rt)["lastLoad"];
    assert_eq!(last["slot"], json!(SLOT));
    assert_eq!(last["tick"], json!(SAVE_TICK));
    assert_eq!(last["checksumMatch"], json!(true));
    assert!(log.borrow().contains(&format!("load:{SLOT}@{SAVE_TICK}")), "{:?}", log.borrow());
}

#[test]
fn two_loads_of_one_slot_replay_equal() {
    let log = Log::default();
    let mut game = pond(&log);
    game.save_world();
    let mut rt = runtime(game, "twice");
    run_to(&mut rt, END_TICK);
    let mut replays = Vec::new();
    for _ in 0..2 {
        press_load(&mut rt);
        rt.step(FIXED_STEP_MS);
        let mut checksums = Vec::new();
        while rt.tick() < END_TICK {
            rt.step(FIXED_STEP_MS);
            if rt.tick().is_multiple_of(50) {
                checksums.push(rt.checksum());
            }
        }
        replays.push(checksums);
    }
    assert_eq!(replays[0], replays[1]);
    assert_eq!(replays[0].len(), 6);
}

#[test]
fn a_section_whose_load_errors_leaves_the_running_sim_untouched() {
    let build = |fail: bool, log: &Log| {
        let mut game = pond(log);
        game.save_world();
        game.save_section("quests", |sim| json!({ "done": sim.world.quests }), move |sim, value, _gfx| {
            if fail {
                return Err("the quest log is unreadable".to_owned());
            }
            sim.world.quests = value["done"].as_u64().unwrap_or_default() as u32;
            Ok(())
        });
        game
    };
    let (log, twin_log) = (Log::default(), Log::default());
    let mut rt = runtime(build(true, &log), "section-fails");
    let mut twin = runtime(build(true, &twin_log), "section-fails-twin");
    run_to(&mut rt, END_TICK);
    run_to(&mut twin, END_TICK);
    press_load(&mut rt);
    // The twin gets the same key on the same tick but never asks for a load.
    twin.inject(Input::key_tap(Key::KeyK));
    twin.step(FIXED_STEP_MS);
    let before = rt.checksum();
    assert_eq!(before, twin.checksum());
    rt.step(FIXED_STEP_MS);
    twin.step(FIXED_STEP_MS);
    assert_eq!(rt.tick(), END_TICK + 2, "the refused load ran the tick on the running sim");
    assert_eq!(rt.checksum(), twin.checksum());
    rt.step(FIXED_STEP_MS);
    let refused = format!("load:{}", SaveErrorCode::SectionInvalid.wire());
    assert!(log.borrow().contains(&refused), "{:?}", log.borrow());
    assert_eq!(volatile_saves(&rt)["lastLoad"], serde_json::Value::Null);
}

#[test]
fn a_game_that_saves_no_world_diverges_while_the_load_still_applies() {
    let log = Log::default();
    let mut rt = runtime(pond(&log), "no-world");
    run_to(&mut rt, END_TICK);
    press_load(&mut rt);
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.tick(), SAVE_TICK + 1, "the load applied");
    let saves = volatile_saves(&rt);
    assert_eq!(saves["lastLoad"]["checksumMatch"], json!(false));
    assert_eq!(saves["issues"], json!(["save-restore-diverged"]));
}

#[test]
fn the_nav_restores_through_its_own_section() {
    #[derive(Default, Serialize, Deserialize)]
    struct Walk {
        agents: u32,
    }
    let build = || {
        let mut game = Game::new(Walk::default()).world_size(400, 300);
        game.saves(SaveConfig::schema(1));
        game.save_world();
        game.navigation(NavConfig::walker(0.4, 1.8).with_tile(8.0));
        game.on_reset(|sim, _seed, rng, _gfx| {
            let vertices = [vec3(0.0, 0.0, 0.0), vec3(16.0, 0.0, 0.0), vec3(16.0, 0.0, 16.0), vec3(0.0, 0.0, 16.0)];
            let input = NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("a quad");
            let mesh = NavMesh::bake(&input, &NavConfig::walker(0.4, 1.8).with_tile(8.0)).expect("the floor bakes");
            sim.nav.add_mesh(&mesh).expect("the tiles");
            sim.nav.update(FIXED_STEP_MS as f32 / 1000.0);
            for _ in 0..4 {
                let start = sim.nav.random_point(rng, vec3(8.0, 0.0, 8.0), 8.0, &NavFilter::new()).expect("a start").position;
                sim.nav.add_agent(NavAgent::new(start)).expect("an agent");
                sim.world.agents += 1;
            }
        });
        game.on_update(|sim, ctx| {
            if ctx.tick.is_multiple_of(90) {
                let corners = [vec3(2.0, 0.0, 2.0), vec3(14.0, 0.0, 14.0), vec3(2.0, 0.0, 14.0), vec3(14.0, 0.0, 2.0)];
                let agents: Vec<_> = sim.nav.agents().collect();
                for (i, agent) in agents.into_iter().enumerate() {
                    let corner = corners[(i + ctx.rng.below(4) as usize) % corners.len()];
                    if let Some(point) = sim.nav.closest_point(corner, 2.0) {
                        sim.nav.move_to(agent, point.position);
                    }
                }
            }
            sim.nav.update(ctx.dt);
            if ctx.tick + 1 == SAVE_TICK {
                ctx.slots().save("walk", "").expect("queued");
            }
            if ctx.keys.pressed(Key::KeyL) {
                ctx.slots().load("walk").expect("queued");
            }
        });
        game.probe("nav", |sim| serde_json::Value::from(&sim.nav.probe()));
        game
    };
    let mut rt = Runtime::new(build()).expect("installs");
    rt.use_studio_saves(&state_dir("nav"));
    rt.seed(3);
    while rt.tick() < END_TICK {
        rt.step(FIXED_STEP_MS);
    }
    let uninterrupted = rt.checksum();
    rt.inject(Input::key_tap(Key::KeyL));
    rt.step(FIXED_STEP_MS);
    rt.step(FIXED_STEP_MS);
    assert_eq!(rt.tick(), SAVE_TICK + 1, "the load applied");
    while rt.tick() < END_TICK {
        rt.step(FIXED_STEP_MS);
    }
    assert_eq!(rt.checksum(), uninterrupted);
    assert_eq!(rt.state()["volatile"]["saves"]["lastLoad"]["checksumMatch"], json!(true));
    let body = rt.saves().load("slots/walk.sav").expect("the slot body");
    let envelope = genex::saves::decode(&body).expect("an envelope");
    let names: Vec<&str> = envelope.sections.keys().map(String::as_str).collect();
    assert_eq!(names, ["genex.nav", "world"]);
}

#[test]
fn install_refuses_inconsistent_save_registrations() {
    let refused = |build: &dyn Fn(&mut Game<World>)| {
        let mut game = Game::new(World::default());
        build(&mut game);
        Runtime::new(game).err().map(|error| error.code())
    };
    let section = |game: &mut Game<World>, name: &str| {
        game.save_section(name, |_| json!(null), |_, _, _| Ok(()));
    };
    let table: [RefusalRow<'_>; 7] = [
        ("schema 0", &|g| _ = g.saves(SaveConfig::schema(0)), InstallErrorCode::SaveSchemaInvalid),
        (
            "a step gap",
            &|g| _ = g.saves(SaveConfig::schema(4).migrate(1, Ok).migrate(3, Ok)),
            InstallErrorCode::SaveSchemaInvalid,
        ),
        ("a step at the schema", &|g| _ = g.saves(SaveConfig::schema(3).migrate(3, Ok)), InstallErrorCode::SaveSchemaInvalid),
        ("a genex. section", &|g| section(g, "genex.nav"), InstallErrorCode::SaveSectionReserved),
        (
            "two sections of one name",
            &|g| {
                section(g, "quests");
                section(g, "quests");
            },
            InstallErrorCode::DuplicateSaveSection,
        ),
        (
            "the world twice",
            &|g| {
                g.save_world();
                section(g, "world");
            },
            InstallErrorCode::DuplicateSaveSection,
        ),
        (
            "two game.saves",
            &|g| {
                g.saves(SaveConfig::schema(1));
                g.saves(SaveConfig::schema(2));
            },
            InstallErrorCode::DuplicateSaves,
        ),
    ];
    for (name, build, code) in table {
        assert_eq!(refused(build), Some(code), "{name}");
    }
    assert_eq!(refused(&|g| _ = g.saves(SaveConfig::schema(3).migrate(1, Ok).migrate(2, Ok))), None);
}

#[test]
fn slot_calls_refuse_without_game_saves_and_for_hostile_names() {
    let log = Log::default();
    let mut game = Game::new(World::default()).world_size(400, 300);
    let events = Rc::clone(&log);
    game.on_update(move |_sim, ctx| {
        if ctx.tick == 0 {
            let code = |result: Result<(), genex::saves::SaveError>| result.err().map(|e| e.code.wire());
            events.borrow_mut().push(format!("{:?}", code(ctx.slots().save("a", ""))));
            events.borrow_mut().push(format!("{:?}", code(ctx.slots().load("a"))));
        }
    });
    let mut rt = Runtime::new(game).expect("installs");
    rt.step(FIXED_STEP_MS);
    assert_eq!(*log.borrow(), ["Some(\"save-not-configured\")", "Some(\"save-not-configured\")"]);

    let log = Log::default();
    let mut game = pond(&log);
    let hostile = Rc::clone(&log);
    game.on_update(move |_sim, ctx| {
        if ctx.tick == 0 {
            for name in ["../x", "a/b", "", "autosave-1", "A", "x\0y", "con", &"a".repeat(33)] {
                let code = ctx.slots().save(name, "").err().map(|e| e.code.wire());
                hostile.borrow_mut().push(format!("{name:?}={code:?}"));
            }
        }
    });
    let dir = state_dir("hostile");
    let mut rt = Runtime::new(game).expect("installs");
    rt.use_studio_saves(&dir);
    rt.step(FIXED_STEP_MS * 3.0);
    for line in log.borrow().iter().filter(|line| line.contains('=')) {
        assert!(line.ends_with("=Some(\"save-slot-invalid\")"), "{line}");
    }
    let slots = std::path::Path::new(&dir).join("slots");
    assert!(!slots.exists() || std::fs::read_dir(&slots).expect("slots").next().is_none(), "nothing written");
}

#[test]
fn ctx_save_and_load_bytes_are_unchanged() {
    let build = |slots: bool| {
        let mut game = Game::new(World::default()).world_size(400, 300);
        if slots {
            game.saves(SaveConfig::schema(1));
            game.save_world();
        }
        game.on_update(move |sim, ctx| {
            if ctx.tick == 2 {
                assert!(ctx.save("legacy/best.bin", &[0, 1, 2, 250, 251]));
                if slots {
                    ctx.slots().save("one", "").expect("queued");
                }
            }
            if ctx.tick == 4 {
                sim.world.casts = ctx.load("legacy/best.bin").map_or(0, |bytes| bytes.len() as u32);
            }
        });
        game
    };
    for slots in [false, true] {
        let dir = state_dir(&format!("legacy-{slots}"));
        let mut rt = Runtime::new(build(slots)).expect("installs");
        rt.use_studio_saves(&dir);
        rt.step(FIXED_STEP_MS * 6.0);
        let bytes = std::fs::read(std::path::Path::new(&dir).join("legacy/best.bin")).expect("the legacy file");
        assert_eq!(bytes, [0, 1, 2, 250, 251]);
        assert_eq!(rt.sim().world.casts, 5);
    }
}

#[test]
fn state_is_unchanged_without_game_saves_and_reports_volatile_saves_with_it() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.probe("casts", |sim| json!(sim.world.casts));
    let mut rt = Runtime::new(game).expect("installs");
    rt.step(FIXED_STEP_MS * 5.0);
    let state = rt.state();
    assert!(state["volatile"].get("saves").is_none(), "{}", state["volatile"]);

    let log = Log::default();
    let mut game = pond(&log);
    game.save_world();
    let mut rt = runtime(game, "volatile");
    run_to(&mut rt, SAVE_TICK + 1);
    let saves = volatile_saves(&rt);
    let keys: Vec<&str> = saves.as_object().expect("an object").keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "store", "files", "bytes", "quota", "persistent", "pending", "inFlight", "lazy", "error", "slots", "lastSave",
            "lastLoad", "issues"
        ]
    );
    assert_eq!(saves["store"], json!("files"));
    assert_eq!(saves["quota"], json!(64 * 1024 * 1024));
    assert_eq!(saves["files"], json!(2));
    assert_eq!(saves["slots"][0]["name"], json!(SLOT));
    assert_eq!(saves["slots"][0]["label"], json!("Chapter 2"));
    assert_eq!(saves["slots"][0]["state"], json!("ready"));
    assert_eq!(saves["slots"][0]["tick"], json!(SAVE_TICK));
}
