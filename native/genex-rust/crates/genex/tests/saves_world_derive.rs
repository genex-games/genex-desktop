//! `game.save_world()` for a game crate with no serde of its own: a Studio game cannot name serde
//! (it is not on the game crate allowlist), so the facade re-exports it as `genex::serde`, with
//! the derives in the prelude, and `docs/api/saves.md` teaches
//! `#[derive(Serialize, Deserialize)] #[serde(crate = "genex::serde")]` on the world.
//!
//! This file names no serde path except through `genex`: the world it saves derives through the
//! re-export, a save at tick 30 loads back over a changed world, and the load restores every field.

use std::cell::Cell;
use std::rc::Rc;

use genex::prelude::*;
use genex::saves::{SaveConfig, SlotOp};
use genex::{FIXED_STEP_MS, Runtime};

/// The tick whose end the save holds.
const SAVE_TICK: u64 = 30;
/// The tick the load is asked on.
const LOAD_TICK: u64 = 60;

/// A world deriving serde through the facade only.
#[derive(Default, Serialize, Deserialize)]
#[serde(crate = "genex::serde")]
struct World {
    coins: u32,
    name: String,
    trail: Vec<i32>,
}

fn state_dir() -> String {
    let dir = std::env::temp_dir().join(format!("genex-saves-world-derive-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    format!("{}/", dir.to_str().expect("a UTF-8 temp path"))
}

/// Red first (GE live-app): the documented derive compiles with `genex` as the only crate, and
/// `save_world` round-trips the world through it.
#[test]
fn a_world_deriving_serde_through_genex_saves_and_loads() {
    let loaded = Rc::new(Cell::new(false));
    let seen = Rc::clone(&loaded);
    let mut game = Game::new(World::default()).title("Derive").world_size(320, 180);
    game.saves(SaveConfig::schema(1));
    game.save_world();
    game.on_update(move |sim, ctx| {
        for event in ctx.slots().events() {
            if event.op == SlotOp::Load && event.result.is_ok() {
                seen.set(true);
            }
        }
        let world = &mut sim.world;
        world.coins += 1;
        world.trail.push(i32::try_from(ctx.tick).unwrap_or(i32::MAX));
        if ctx.tick + 1 == SAVE_TICK {
            world.name = "before".to_owned();
            ctx.slots().save("a", "A").expect("the save is queued");
        }
        if ctx.tick == LOAD_TICK && world.name == "before" {
            world.name = "after".to_owned();
            ctx.slots().load("a").expect("the load is queued");
        }
    });
    let mut rt = Runtime::new(game).expect("installs");
    rt.use_studio_saves(&state_dir());
    rt.seed(1);
    // The load (asked at tick 60) swaps the tick-30 world in at the start of the next tick.
    for _ in 0..=LOAD_TICK + 1 {
        rt.step(FIXED_STEP_MS);
    }
    assert!(loaded.get(), "the load answered ok");
    let world = &rt.sim().world;
    assert_eq!(world.name, "before", "the loaded world is the saved one");
    assert_eq!(world.trail.len(), world.coins as usize, "every field came back together");
    assert!(world.coins < LOAD_TICK as u32, "the world went back to tick {SAVE_TICK}: {} coins", world.coins);
}
