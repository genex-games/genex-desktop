//! STR-9: the sim set in the tick. Anchors move the sim set at the next tick's commit; entered
//! cells are listed ascending with their builders' things in build order, left cells descending;
//! builds run on any number of workers (inline on the web) and the state is the same; a late build
//! holds the frame, never the commit; the hold is capped so a held step answers in time.

use std::cell::Cell;
use std::rc::Rc;
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

use genex::prelude::*;
use genex::{
    CellBuild, CellId, CellInputs, EnteredCell, InstallErrorCode, Runtime, STREAM_CELL_THINGS_MAX, Sim, StreamCommit, StreamErrorCode, Streaming,
};
#[cfg(not(target_arch = "wasm32"))]
use genex::{STREAM_HOLD_MAX_MS, STREAM_HOLD_OVERLAY_MS};
use genex_render::jobs::Pool;
use serde_json::json;

const CELL: f32 = 64.0;

/// One tick that heard the commit: the tick, the entered cells with their `u32` things, and the
/// left cells.
type Heard = (u64, Vec<(CellId, Vec<u32>)>, Vec<CellId>);

/// The world a test game keeps: what each tick heard from the commit.
#[derive(Default)]
struct World {
    heard: Vec<Heard>,
    /// The things the world holds, by cell (spawned on enter, dropped on leave).
    things: Vec<(CellId, u32)>,
}

fn cell_things(cell: CellId, inputs: &CellInputs) -> CellBuild<u32> {
    let mut rng = inputs.rng();
    let base = ((cell.x + 50) * 1000 + (cell.z + 50)) as u32 * 10;
    let mut build = CellBuild::default();
    for i in 0..3 {
        build = build.thing(base + i + rng.below(1) * 7);
    }
    if (cell.x + cell.z) % 2 == 0 {
        let _ = inputs.model(&format!("cells/{}_{}.glb", cell.x, cell.z));
    }
    build
}

/// Anchor "player" walks one cell along x every `every` ticks from x0, starting at reset.
fn walking_game(every: u64, x0: f32) -> Game<World> {
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1));
    game.cell_content(cell_things);
    game.on_reset(move |sim, _, _, _| sim.stream.set_anchor("player", vec3(x0, 0.0, 10.0)).expect("anchor"));
    game.on_update(move |sim, ctx| {
        let entered = sim.stream.entered().iter().map(|e| (e.cell(), e.things::<u32>().copied().collect())).collect::<Vec<(CellId, Vec<u32>)>>();
        let left = sim.stream.left().to_vec();
        for (cell, things) in &entered {
            sim.world.things.extend(things.iter().map(|t| (*cell, *t)));
        }
        sim.world.things.retain(|(cell, _)| !left.contains(cell));
        if !entered.is_empty() || !left.is_empty() {
            sim.world.heard.push((ctx.tick, entered, left));
        }
        let x = x0 + CELL * (ctx.tick / every) as f32;
        sim.stream.set_anchor("player", vec3(x, 0.0, 10.0)).expect("anchor");
    });
    game.probe("things", |sim| json!(sim.world.things.len()));
    game.probe("digest", |sim| {
        let sum = sim
            .world
            .things
            .iter()
            .fold(0u64, |h, (c, t)| h.wrapping_mul(31).wrapping_add((c.x as i64 * 7 + c.z as i64) as u64).wrapping_add(u64::from(*t)));
        json!(sum)
    });
    game
}

fn runtime_on(game: Game<World>, pool: Pool) -> Runtime<World> {
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    runtime.seed(7);
    runtime
}

/// `state()` without `volatile` (stalls and held time are display state).
fn sim_state(runtime: &Runtime<World>) -> serde_json::Value {
    let mut state = runtime.state();
    state.as_object_mut().expect("object").remove("volatile");
    state
}

fn c(x: i32, z: i32) -> CellId {
    CellId::new(x, z)
}

#[test]
fn entered_is_ascending_with_things_in_build_order_and_left_is_descending() {
    // New behaviour.
    let mut runtime = runtime_on(walking_game(1000, 10.0), Pool::new(2));
    runtime.step(1000.0 / 60.0);
    let heard = &runtime.sim().world.heard;
    assert_eq!(heard.len(), 1, "tick 0 heard the first commit");
    let (tick, entered, left) = &heard[0];
    assert_eq!(*tick, 0);
    let cells: Vec<CellId> = entered.iter().map(|(cell, _)| *cell).collect();
    let mut sorted = cells.clone();
    sorted.sort();
    assert_eq!(cells, sorted, "ascending");
    assert_eq!(cells.len(), 9, "the 3x3 square around the anchor's cell");
    assert_eq!(cells[0], c(-1, -1));
    for (cell, things) in entered {
        let base = ((cell.x + 50) * 1000 + (cell.z + 50)) as u32 * 10;
        assert_eq!(things, &vec![base, base + 1, base + 2], "build order in {cell:?}");
    }
    assert!(left.is_empty());

    // An anchor walking one cell a tick leaves cells behind, descending, at each next commit.
    let mut walker = runtime_on(walking_game(1, 10.0), Pool::new(2));
    walker.step(1000.0 / 60.0 * 4.0);
    let heard = &walker.sim().world.heard;
    let left: Vec<CellId> = heard.iter().flat_map(|(_, _, left)| left.iter().copied()).collect();
    assert!(!left.is_empty(), "walking one cell a tick leaves cells behind: {heard:?}");
    for (_, _, left) in heard {
        let mut descending = left.clone();
        descending.sort_by(|a, b| b.cmp(a));
        assert_eq!(left, &descending, "descending");
    }
    // An anchor set during tick T takes effect at T+1: tick 1's commit follows tick 0's anchor.
    assert_eq!(heard[0].0, 0);
    assert!(heard.iter().skip(1).all(|(tick, _, _)| *tick >= 1));
}

// Native only: worker threads, a held pool or a sleeping builder (the web runs builds inline).
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn state_and_assets_order_are_equal_with_1_and_8_workers_inline_and_shuffled_completion() {
    // New behaviour (owner call S7): builders on workers, merged in cell order.
    let run = |pool: Pool, shuffle: bool| {
        let mut game = walking_game(3, 10.0);
        if shuffle {
            // A second builder that sleeps by cell, so builds finish in a scrambled order.
            game.cell_content(|cell: CellId, inputs: &CellInputs| {
                let micros = (cell.x.unsigned_abs() * 37 + cell.z.unsigned_abs() * 101) % 1500;
                std::thread::sleep(Duration::from_micros(u64::from(micros)));
                let _ = inputs.model("shared/rock.glb");
                CellBuild::<&'static str>::default().thing("rock")
            });
        } else {
            game.cell_content(|_: CellId, inputs: &CellInputs| {
                let _ = inputs.model("shared/rock.glb");
                CellBuild::<&'static str>::default().thing("rock")
            });
        }
        let mut runtime = runtime_on(game, pool);
        runtime.step(1000.0 / 60.0 * 40.0);
        (runtime.checksum(), sim_state(&runtime))
    };
    let (one, one_state) = run(Pool::new(1), false);
    let (eight, eight_state) = run(Pool::new(8), true);
    let (inline, inline_state) = run(Pool::inline(), false);
    assert_eq!(one, eight, "1 vs 8 workers with shuffled completion");
    assert_eq!(one, inline, "threads vs inline (the web's pool)");
    assert_eq!(one_state, eight_state);
    assert_eq!(one_state, inline_state);
    let assets = one_state["assets"].as_array().expect("assets").clone();
    assert!(assets.len() > 5, "cell models are listed: {assets:?}");
    assert_eq!(assets[0], json!("cells/-1_-1.glb"), "cell order: the first cell's model first");
    assert!(one_state["__stream"]["active"].as_u64().is_some_and(|n| n >= 9), "{one_state}");
}

// Native only: worker threads, a held pool or a sleeping builder (the web runs builds inline).
#[cfg(not(target_arch = "wasm32"))]
#[test]
#[allow(clippy::disallowed_methods, reason = "the test releases the held pool from another thread, as a slow worker would")]
fn a_late_build_holds_the_frame_counts_one_stall_and_leaves_the_checksum() {
    // New behaviour.
    let mut plain = runtime_on(walking_game(1000, 10.0), Pool::new(2));
    plain.step(1000.0 / 60.0 * 3.0);

    let pool = Arc::new(Pool::new(2));
    let mut runtime = Runtime::new(walking_game(1000, 10.0)).expect("installs");
    let hold = pool.hold();
    runtime.use_stream_pool(Arc::clone(&pool));
    runtime.seed(7);
    let released = Arc::new(AtomicBool::new(false));
    let flag = Arc::clone(&released);
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(120));
        flag.store(true, Ordering::SeqCst);
        drop(hold);
    });
    let result = runtime.step(1000.0 / 60.0 * 3.0);
    release.join().expect("joins");
    assert!(released.load(Ordering::SeqCst), "the step waited for the build");
    assert_eq!(result.ticks, 3, "a hold under the cap runs every tick");
    let state = runtime.state();
    assert_eq!(state["volatile"]["__stream"]["stalls"], json!(1), "{}", state["volatile"]);
    assert!(state["volatile"]["__stream"]["heldMs"].as_f64().is_some_and(|ms| ms >= 100.0), "{}", state["volatile"]);
    assert_eq!(runtime.checksum(), plain.checksum(), "a held frame changes nothing the sim sees");
    assert_eq!(sim_state(&runtime), sim_state(&plain));
}

#[test]
fn seed_2_then_seed_1_equals_a_fresh_seed_1() {
    // New behaviour (plan 4.4 rule 4): the resident set and its things are rebuilt.
    let mut fresh = runtime_on(walking_game(2, 10.0), Pool::new(4));
    fresh.seed(1);
    fresh.step(1000.0 / 60.0 * 12.0);
    let mut reseeded = runtime_on(walking_game(2, 10.0), Pool::new(4));
    reseeded.seed(2);
    reseeded.step(1000.0 / 60.0 * 20.0);
    reseeded.seed(1);
    reseeded.step(1000.0 / 60.0 * 12.0);
    assert_eq!(reseeded.checksum(), fresh.checksum());
    assert_eq!(sim_state(&reseeded), sim_state(&fresh));
    assert_eq!(reseeded.sim().stream.active().collect::<Vec<_>>(), fresh.sim().stream.active().collect::<Vec<_>>());
}

#[test]
fn two_facets_cell_content_add_to_a_cell_in_registration_order() {
    // New behaviour (review A8): each facet registers its own builder.
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(0));
    game.cell_content(|cell: CellId, _: &CellInputs| CellBuild::default().thing(1_u32).thing(2).thing(cell.x.unsigned_abs()));
    game.cell_content(|_: CellId, _: &CellInputs| CellBuild::<&'static str>::default().thing("tree"));
    game.cell_content(|_: CellId, _: &CellInputs| CellBuild::default().thing(30_u32).thing(40));
    game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", vec3(10.0, 0.0, 10.0)).expect("anchor"));
    let seen = Rc::new(Cell::new(false));
    let saw = Rc::clone(&seen);
    game.on_update(move |sim, _| {
        let Some(entered) = sim.stream.entered().first() else { return };
        assert_eq!(entered.cell(), c(0, 0));
        assert_eq!(entered.things::<u32>().copied().collect::<Vec<_>>(), [1, 2, 0, 30, 40], "registration order, then build order");
        assert_eq!(entered.things::<&'static str>().copied().collect::<Vec<_>>(), ["tree"]);
        saw.set(true);
    });
    let mut runtime = runtime_on(game, Pool::new(2));
    runtime.step(1000.0 / 60.0);
    assert!(seen.get(), "the cell entered at tick 0");
}

#[test]
fn a_builder_over_a_cap_refuses_the_cell_with_nothing_committed() {
    // New behaviour.
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1));
    game.cell_content(|cell: CellId, inputs: &CellInputs| {
        let _ = inputs.model(&format!("cells/{}_{}.glb", cell.x, cell.z));
        let count = if cell == CellId::new(0, 0) { STREAM_CELL_THINGS_MAX } else { 2 };
        (0..count as u32).fold(CellBuild::default(), CellBuild::thing)
    });
    // A second builder pushes cell (0, 0) one thing past the cap together.
    game.cell_content(|_: CellId, _: &CellInputs| CellBuild::default().thing(9_u32));
    game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", vec3(10.0, 0.0, 10.0)).expect("anchor"));
    game.on_update(|sim, _| {
        for entered in sim.stream.entered() {
            let things: Vec<u32> = entered.things::<u32>().copied().collect();
            sim.world.things.extend(things.iter().map(|t| (entered.cell(), *t)));
            if entered.cell() == CellId::new(0, 0) {
                assert_eq!(entered.refused(), Some(StreamErrorCode::Invalid));
                assert!(things.is_empty(), "nothing of a refused cell is committed");
            } else {
                assert_eq!(entered.refused(), None);
            }
        }
    });
    let mut runtime = runtime_on(game, Pool::new(2));
    runtime.step(1000.0 / 60.0);
    assert!(runtime.sim().stream.is_active(c(0, 0)), "the refused cell is active (the sim set is the anchors')");
    assert_eq!(runtime.sim().world.things.len(), 8 * 3, "eight cells of 2 + 1 things");
    let state = runtime.state();
    let assets = state["assets"].as_array().expect("assets");
    assert!(!assets.contains(&json!("cells/0_0.glb")), "a refused cell's models are not recorded: {assets:?}");
    assert!(assets.contains(&json!("cells/1_1.glb")));
    assert_eq!(state["volatile"]["__stream"]["refused"], json!([{"cell": [0, 0], "code": "stream-invalid"}]));
}

#[test]
fn the_one_sim_cap_and_the_radii_are_checked_at_registration() {
    // New behaviour (review C2): one cap, never by device class.
    let refused = |streaming: Streaming| {
        let mut game = Game::new(World::default());
        game.streaming(streaming);
        game.cell_content(|_: CellId, _: &CellInputs| CellBuild::<[u8; 256]>::default());
        Runtime::new(game).err().map(|error| error.code())
    };
    assert_eq!(refused(Streaming::grid(CELL)), None, "the defaults fit");
    assert_eq!(refused(Streaming::grid(CELL).sim_radius(8).hysteresis(4).anchors(8)), Some(InstallErrorCode::StreamingInvalid), "past the sim cap");
    assert_eq!(refused(Streaming::grid(CELL).sim_radius(9)), Some(InstallErrorCode::StreamingInvalid), "radius past its cap");
    assert_eq!(refused(Streaming::grid(CELL).anchors(0)), Some(InstallErrorCode::StreamingInvalid));
    assert_eq!(refused(Streaming::grid(CELL).anchors(9)), Some(InstallErrorCode::StreamingInvalid));
}

#[test]
fn anchors_refuse_with_typed_codes_and_change_nothing() {
    // New behaviour: a hostile table.
    let mut plain = Runtime::new(Game::new(World::default())).expect("installs");
    assert_eq!(plain.sim_mut().stream.set_anchor("p", Vec3::ZERO).unwrap_err().code, StreamErrorCode::NotRegistered);
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).anchors(2));
    let mut runtime = Runtime::new(game).expect("installs");
    let stream = &mut runtime.sim_mut().stream;
    let rows: [(&str, Vec3, StreamErrorCode); 5] = [
        ("", Vec3::ZERO, StreamErrorCode::Invalid),
        ("a\u{7}", Vec3::ZERO, StreamErrorCode::Invalid),
        ("p", vec3(f32::NAN, 0.0, 0.0), StreamErrorCode::Invalid),
        ("p", vec3(0.0, 0.0, f32::INFINITY), StreamErrorCode::Invalid),
        ("p", vec3(9000.0, 0.0, 0.0), StreamErrorCode::OutOfWorld),
    ];
    for (name, at, code) in rows {
        assert_eq!(stream.set_anchor(name, at).unwrap_err().code, code, "{name:?} {at}");
        assert_eq!(stream.anchors().count(), 0, "nothing changed");
    }
    assert_eq!(stream.set_anchor(&"x".repeat(65), Vec3::ZERO).unwrap_err().code, StreamErrorCode::Invalid);
    stream.set_anchor("a", Vec3::ZERO).expect("first");
    stream.set_anchor("b", Vec3::ZERO).expect("second");
    stream.set_anchor("a", vec3(100.0, 0.0, 0.0)).expect("moving a held anchor");
    assert_eq!(stream.set_anchor("c", Vec3::ZERO).unwrap_err().code, StreamErrorCode::TooManyAnchors);
    assert_eq!(stream.anchors().collect::<Vec<_>>(), [("a", c(1, 0)), ("b", c(0, 0))]);
    stream.clear_anchor("b");
    stream.set_anchor("c", Vec3::ZERO).expect("room again");
}

/// A fake clock: every look advances it by `step` ms.
#[cfg(not(target_arch = "wasm32"))]
fn fake_clock(step: f64) -> Box<dyn FnMut() -> f64> {
    let mut now = 0.0;
    Box::new(move || {
        now += step;
        now
    })
}

// Native only: worker threads, a held pool or a sleeping builder (the web runs builds inline).
#[cfg(not(target_arch = "wasm32"))]
#[test]
#[allow(clippy::disallowed_types, reason = "the test checks the fake clock, not the wall, bounds the wait")]
fn a_held_step_answers_after_the_hold_cap_with_the_tick_not_run() {
    // New behaviour: the hold is capped at STREAM_HOLD_MAX_MS (6 s), under the 10 s call timeout.
    let pool = Arc::new(Pool::new(1));
    let mut runtime = Runtime::new(walking_game(1000, 10.0)).expect("installs");
    let hold = pool.hold();
    runtime.use_stream_pool(Arc::clone(&pool));
    runtime.use_stream_clock(fake_clock(5.0));
    runtime.seed(7);
    let started = std::time::Instant::now();
    let result = runtime.step(1000.0 / 60.0 * 3.0);
    assert!(started.elapsed() < Duration::from_secs(5), "the fake clock bounds the wait, not the wall");
    assert_eq!(result.ticks, 0, "the commit never ran, so no tick did");
    assert_eq!(result.frame, 0);
    let volatile = runtime.state()["volatile"]["__stream"].clone();
    assert_eq!(volatile["timeout"], json!("stream-hold-timeout"), "{volatile}");
    assert_eq!(volatile["timeouts"], json!(1));
    assert!(volatile["heldMs"].as_f64().is_some_and(|ms| (STREAM_HOLD_MAX_MS..STREAM_HOLD_MAX_MS + 10.0).contains(&ms)), "{volatile}");
    assert!(runtime.sim().world.heard.is_empty(), "nothing committed");
    drop(hold);
    let result = runtime.step(1000.0 / 60.0 * 3.0);
    assert_eq!(result.ticks, 3, "released, the step runs");
    let mut plain = runtime_on(walking_game(1000, 10.0), Pool::new(1));
    plain.step(1000.0 / 60.0 * 3.0);
    assert_eq!(runtime.checksum(), plain.checksum(), "the held run equals the plain one at the same tick");
    assert!(runtime.state()["volatile"]["__stream"].get("timeout").is_none(), "the timeout clears once it commits");
}

// Native only: worker threads, a held pool or a sleeping builder (the web runs builds inline).
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn live_shows_the_loading_look_once_a_hold_passes_250_ms() {
    // New behaviour: Live waits a slice per frame and keeps drawing.
    let pool = Arc::new(Pool::new(1));
    let mut runtime = Runtime::new(walking_game(1000, 10.0)).expect("installs");
    let hold = pool.hold();
    runtime.use_stream_pool(Arc::clone(&pool));
    runtime.use_stream_clock(fake_clock(1.0));
    runtime.seed(7);
    runtime.start();
    let mut frames = 0;
    while !runtime.stream_loading() {
        assert_eq!(runtime.advance_live(1000.0 / 60.0), 0, "held frames run no tick");
        frames += 1;
        assert!(frames < 200, "the loading look never showed");
    }
    let held = runtime.state()["volatile"]["__stream"]["heldMs"].as_f64().expect("heldMs");
    assert!(held >= STREAM_HOLD_OVERLAY_MS, "{held}");
    assert!(frames > 10, "several Live frames drew before it: {frames}");
    assert_eq!(runtime.state()["volatile"]["__stream"]["stalls"], json!(1), "one hold, however many frames");
    drop(hold);
    let mut ticks = 0;
    for _ in 0..20 {
        ticks += runtime.advance_live(1000.0 / 60.0);
        if ticks > 0 {
            break;
        }
    }
    assert!(ticks > 0, "released, Live ticks again");
    assert!(!runtime.stream_loading());
}

/// A hook that logs the order it is called in.
struct Log(&'static str);

#[derive(Default)]
struct HookLog(Vec<String>);

impl StreamCommit<World> for Log {
    fn leave(&self, sim: &mut Sim<World>, cell: CellId) {
        sim.facets.get_mut::<HookLog>().0.push(format!("{} leave {},{}", self.0, cell.x, cell.z));
    }

    fn enter(&self, sim: &mut Sim<World>, cell: &EnteredCell) {
        assert!(sim.stream.entered().is_empty(), "entered() is empty while hooks run");
        sim.facets.get_mut::<HookLog>().0.push(format!("{} enter {},{}", self.0, cell.cell().x, cell.cell().z));
    }
}

#[test]
fn commit_hooks_enter_ascending_in_order_and_leave_descending_in_reverse() {
    // New behaviour: the hook STR-10, STR-11 and STR-12 plug into.
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(0).hysteresis(0));
    game.facet_state::<HookLog>();
    game.stream_commit(Log("colliders"));
    game.stream_commit(Log("nav"));
    game.on_reset(|sim, _, _, _| sim.stream.set_anchor("p", vec3(10.0, 0.0, 10.0)).expect("anchor"));
    game.on_update(|sim, ctx| {
        if ctx.tick == 1 {
            sim.stream.set_anchor("p", vec3(10.0 + CELL, 0.0, 10.0)).expect("anchor");
        }
    });
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.use_stream_pool(Arc::new(Pool::new(2)));
    runtime.seed(1);
    runtime.step(1000.0 / 60.0 * 3.0);
    let log = &runtime.sim().facets.get::<HookLog>().0;
    assert_eq!(log, &["colliders enter 0,0", "nav enter 0,0", "nav leave 0,0", "colliders leave 0,0", "colliders enter 1,0", "nav enter 1,0"]);
}

#[test]
fn the_runtime_key_reports_the_active_cells_and_never_the_checksum() {
    // New behaviour: `__stream {active, cells}` follows the sim set.
    let mut runtime = runtime_on(walking_game(1000, 10.0), Pool::new(2));
    let before = runtime.state();
    assert_eq!(before["__stream"]["active"], json!(0), "nothing before the first commit");
    runtime.step(1000.0 / 60.0);
    let state = runtime.state();
    assert_eq!(state["__stream"]["active"], json!(9));
    assert_ne!(state["__stream"]["cells"], before["__stream"]["cells"]);
    assert_eq!(state["__stream"]["cells"].as_str().map(str::len), Some(16));
    // A game without streaming has no key and no volatile counters.
    let plain = Runtime::new(Game::new(World::default())).expect("installs");
    assert!(plain.state().get("__stream").is_none());
    assert!(plain.state()["volatile"].get("__stream").is_none());
}

/// The checksum and `__stream` digest of a pinned walk with inline builds, the web's pool. The
/// same literal is asserted natively and in the wasm32 test binary, so the two destinations agree.
#[test]
fn a_pinned_walk_has_the_same_checksum_on_every_destination() {
    // New behaviour.
    let mut runtime = runtime_on(walking_game(3, 10.0), Pool::inline());
    runtime.step(1000.0 / 60.0 * 40.0);
    let state = runtime.state();
    let pinned = (runtime.checksum(), state["__stream"]["cells"].clone(), state["things"].clone());
    assert_eq!(pinned, (PINNED_CHECKSUM.to_owned(), json!(PINNED_CELLS), json!(36)), "{state}");
}

/// What [`a_pinned_walk_has_the_same_checksum_on_every_destination`] pins.
const PINNED_CHECKSUM: &str = "813c6ea25ce0d571";
/// The `__stream.cells` digest of the same walk.
const PINNED_CELLS: &str = "2cec4c5bf27ce77d";
