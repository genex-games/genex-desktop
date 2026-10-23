//! Plain floats in a slot load back exactly through the facade: `game.save_world()` of a World with
//! f32 and f64 fields, and a `game.save_section` of body poses as plain f32 numbers (the physics
//! page's shape), each filled with random bit patterns from `ctx.rng`, load at tick 300 and replay
//! to the uninterrupted run's checksum. A NaN in the World saves as `null`, and its load is refused
//! `save-section-invalid` with the running game untouched.

use std::cell::RefCell;
use std::rc::Rc;

use genex::digest;
use genex::prelude::*;
use genex::saves::{SaveConfig, SaveErrorCode, SlotOp};
use genex::{FIXED_STEP_MS, Runtime};
use serde::{Deserialize, Serialize};

const SAVE_TICK: u64 = 300;
const END_TICK: u64 = 600;
const SLOT: &str = "floats";
/// Floats of each width the reset makes; every tick redraws a few of them.
const FLOATS: usize = 400;
/// Bodies whose poses the `bodies` section holds as plain numbers.
const BODIES: usize = 100;
/// Floats one tick redraws per field.
const REDRAWN_PER_TICK: u32 = 8;

/// A World of plain floats: the `world` section holds `f32s` and `f64s`, `bodies` holds `poses`.
#[derive(Default, Serialize, Deserialize)]
struct World {
    f32s: Vec<f32>,
    f64s: Vec<f64>,
    #[serde(skip)]
    poses: Vec<[f32; 13]>,
    nan: f32,
}

/// What a test reads back from the hooks: each slot event as `op:result`.
type Log = Rc<RefCell<Vec<String>>>;

/// A finite f32 from random bits (a non-finite pattern is folded to its finite neighbour).
fn finite_f32(bits: u32) -> f32 {
    let x = f32::from_bits(bits);
    if x.is_finite() { x } else { f32::from_bits(bits & 0xff7f_ffff) }
}

/// A finite f64 from random bits (a non-finite pattern is folded to its finite neighbour).
fn finite_f64(high: u32, low: u32) -> f64 {
    let bits = (u64::from(high) << 32) | u64::from(low);
    let x = f64::from_bits(bits);
    if x.is_finite() { x } else { f64::from_bits(bits & 0xffef_ffff_ffff_ffff) }
}

/// Awkward values every run holds: tiny, huge, subnormal, -0.0 and the f32 widening classics.
fn awkward(world: &mut World) {
    world.f32s.extend([0.1, -0.0, 1.0 / 3.0, f32::MAX, f32::MIN_POSITIVE, f32::from_bits(1), -4.5]);
    world.f64s.extend([0.1, -0.0, 1e300, 5e-324, 2.225_073_858_507_201e-308, f64::MAX, 1e23]);
}

/// Each float's bits, so -0.0 and 0.0 differ and a probe sees the exact value.
fn float_bytes(world: &World) -> Vec<u8> {
    let f32s = world.f32s.iter().chain(world.poses.iter().flatten()).flat_map(|x| x.to_bits().to_le_bytes());
    f32s.chain(world.f64s.iter().flat_map(|x| x.to_bits().to_le_bytes())).collect()
}

fn event_text(op: SlotOp, result: &Result<genex::saves::SlotInfo, genex::saves::SaveError>) -> String {
    match result {
        Ok(info) => format!("{}:{}@{}", op.wire(), info.name.as_str(), info.tick),
        Err(error) => format!("{}:{}", op.wire(), error.code.wire()),
    }
}

/// The float game, saving `SLOT` at the end of tick 299 and loading it on `KeyL`.
fn floats_game(log: &Log, nan: bool) -> Game<World> {
    let mut game = Game::new(World::default()).title("Floats").world_size(400, 300);
    game.saves(SaveConfig::schema(1));
    game.on_reset(move |sim, _seed, rng, _gfx| {
        let w = &mut sim.world;
        w.f32s = (0..FLOATS).map(|_| finite_f32(rng.next_u32())).collect();
        w.f64s = (0..FLOATS).map(|_| finite_f64(rng.next_u32(), rng.next_u32())).collect();
        w.poses = (0..BODIES).map(|_| [0; 13].map(|_: u32| finite_f32(rng.next_u32()))).collect();
        awkward(w);
        w.nan = if nan { f32::NAN } else { 0.0 };
    });
    let events = Rc::clone(log);
    game.on_update(move |sim, ctx| {
        for event in ctx.slots().events() {
            events.borrow_mut().push(event_text(event.op, &event.result));
        }
        let w = &mut sim.world;
        for _ in 0..REDRAWN_PER_TICK {
            let at = ctx.rng.below(FLOATS as u32) as usize;
            w.f32s[at] = finite_f32(ctx.rng.next_u32());
            w.f64s[at] = finite_f64(ctx.rng.next_u32(), ctx.rng.next_u32());
            let body = ctx.rng.below(BODIES as u32) as usize;
            w.poses[body][at % 13] = finite_f32(ctx.rng.next_u32());
        }
        if ctx.tick + 1 == SAVE_TICK {
            ctx.slots().save(SLOT, "Floats").expect("the save is queued");
        }
        if ctx.keys.pressed(Key::KeyL) {
            ctx.slots().load(SLOT).expect("the load is queued");
        }
    });
    game.save_world();
    game.save_section("bodies", |sim| json!(sim.world.poses), |sim, value, _gfx| {
        sim.world.poses = Vec::<[f32; 13]>::deserialize(value).map_err(|error| error.to_string())?;
        Ok(())
    });
    game.probe("floats", |sim| json!(digest::hex64(digest::fnv1a64(&float_bytes(&sim.world)))));
    game
}

fn runtime(game: Game<World>, name: &str) -> Runtime<World> {
    let dir = std::env::temp_dir().join(format!("genex-saves-floats-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("a temp folder");
    let mut state = dir.to_str().expect("a UTF-8 temp path").to_owned();
    state.push('/');
    let mut rt = Runtime::new(game).expect("the float game installs");
    rt.use_studio_saves(&state);
    rt.seed(5);
    rt
}

fn run_to(rt: &mut Runtime<World>, tick: u64) {
    while rt.tick() < tick {
        rt.step(FIXED_STEP_MS);
    }
}

/// Tap `KeyL`, run the tick it queues the load on and the tick it restores before.
fn load_and_restore(rt: &mut Runtime<World>) {
    rt.inject(Input::key_tap(Key::KeyL));
    rt.step(FIXED_STEP_MS);
    rt.step(FIXED_STEP_MS);
}

#[test]
fn a_world_and_a_section_of_plain_random_floats_load_back_exactly() {
    let log = Log::default();
    let mut rt = runtime(floats_game(&log, false), "plain");
    run_to(&mut rt, END_TICK);
    let uninterrupted = rt.checksum();
    assert!(log.borrow().contains(&format!("save:{SLOT}@{SAVE_TICK}")), "{:?}", log.borrow());

    load_and_restore(&mut rt);
    assert!(log.borrow().contains(&format!("load:{SLOT}@{SAVE_TICK}")), "{:?}", log.borrow());
    assert_eq!(rt.state()["volatile"]["saves"]["lastLoad"]["checksumMatch"], json!(true));
    run_to(&mut rt, END_TICK);
    assert_eq!(rt.checksum(), uninterrupted, "every float came back with its bits");
}

#[test]
fn a_nan_in_the_world_saves_as_null_and_its_load_is_refused_with_the_game_untouched() {
    let (log, twin_log) = (Log::default(), Log::default());
    let mut rt = runtime(floats_game(&log, true), "nan");
    let mut twin = runtime(floats_game(&twin_log, true), "nan-twin");
    run_to(&mut rt, END_TICK);
    run_to(&mut twin, END_TICK);
    assert!(log.borrow().contains(&format!("save:{SLOT}@{SAVE_TICK}")), "{:?}", log.borrow());

    rt.inject(Input::key_tap(Key::KeyL));
    // The twin gets a key on the same tick but never asks for a load.
    twin.inject(Input::key_tap(Key::KeyK));
    for _ in 0..3 {
        rt.step(FIXED_STEP_MS);
        twin.step(FIXED_STEP_MS);
    }
    let refused = format!("load:{}", SaveErrorCode::SectionInvalid.wire());
    assert!(log.borrow().contains(&refused), "{:?}", log.borrow());
    assert_eq!(rt.tick(), twin.tick(), "the refused load rewound nothing");
    assert_eq!(rt.checksum(), twin.checksum(), "the running game is untouched");
    assert_eq!(rt.state()["volatile"]["saves"]["lastLoad"], serde_json::Value::Null);
}
