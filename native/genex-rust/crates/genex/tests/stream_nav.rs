//! STR-11: streamed nav islands through the commit slot. A cell builder reads the cell's offline
//! nav bake (`.navmesh` bytes of its tiles) into a `NavIsland` part; a `StreamCommit` hook hands
//! leaving and entering cells to genex-stream's `StreamNav` slot, first with a fake nav that
//! records the order, then with the real genex-nav (`StreamedNav` over `sim.nav` and a
//! `NavIslands` ledger kept in facet state).
//!
//! - Every tick, leaves go out descending before enters come in ascending.
//! - A late island (a slow builder) holds the frame: its tiles are in on the tick the cell enters.
//! - An agent on a cell that streams out goes `off-mesh` and freezes; streamed back in, it walks on
//!   along the same path to the same target (owner call X1).
//! - Checksums are equal with 1 and 8 workers and with inline builds (the web's pool).
//! - Four cells entering on one tick read and add their islands within the inline finish slice.
//!
//! Every row is new behaviour (section 0 of the game systems plan). genex-nav does not depend on
//! genex-stream, so this file joins them with a small bridge until the integrator adds that
//! dependency and the impl.

use std::collections::BTreeMap;
use std::sync::Arc;
#[cfg(not(target_arch = "wasm32"))]
use std::time::Duration;

use genex::nav::{NavArea, NavConfig, NavInput};
use genex::prelude::*;
use genex::{CellBuild, CellId, CellInputs, CellPart, EnteredCell, FIXED_STEP_MS, Runtime, STREAM_HOLD_LIVE_SLICE_MS, StreamCommit, Streaming};
use genex_core::digest::hex64;
use genex_nav::AgentId;
use genex_nav::agents_api::{NavAgent, NavStatus};
use genex_nav::filter::NavFilter;
use genex_nav::stream::{NavIsland, NavIslands, StreamedNav};
use genex_render::jobs::Pool;
use genex_stream::nav::{StreamNav, commit};
use serde_json::json;

const CELL: f32 = 16.0;
/// Cells of ground along x (and two along z).
const GROUND_CELLS: i32 = 12;
const HOME: Vec3 = vec3(8.0, 0.0, 8.0);
const AWAY: Vec3 = vec3(8.0 + 8.0 * CELL, 0.0, 8.0);
const LEAVE_TICK: u64 = 40;
const RETURN_TICK: u64 = 80;
const TICKS: u64 = 200;

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// Flat ground over `GROUND_CELLS` × 2 cells.
fn ground() -> NavInput {
    let (x1, z1) = (GROUND_CELLS as f32 * CELL, 2.0 * CELL);
    let vertices = [vec3(0.0, 0.0, 0.0), vec3(x1, 0.0, 0.0), vec3(x1, 0.0, z1), vec3(0.0, 0.0, z1)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the ground")
}

/// The offline bake: every cell's island as the bytes `bakeAssets` kind `nav` would store.
fn offline_bake() -> Arc<BTreeMap<CellId, Vec<u8>>> {
    let input = ground();
    let mut out = BTreeMap::new();
    for z in 0..2 {
        for x in 0..GROUND_CELLS {
            let cell = CellId { x, z };
            let island = NavIsland::bake_cell(&input, &walker(), cell, CELL).expect("the cell bakes");
            out.insert(cell, island.to_bytes(&walker()));
        }
    }
    Arc::new(out)
}

/// A cell's island, carried as a part.
struct IslandPart(NavIsland);

impl CellPart for IslandPart {}

/// A nav that records what the slot asked of it.
#[derive(Default)]
struct FakeNav {
    heard: Vec<(bool, CellId)>,
}

impl StreamNav for FakeNav {
    type Island = NavIsland;

    fn island_leave(&mut self, cell: CellId) -> usize {
        self.heard.push((false, cell));
        0
    }

    fn island_enter(&mut self, cell: CellId, island: &NavIsland) -> usize {
        self.heard.push((true, cell));
        island.tiles().len()
    }
}

/// genex-nav's side of the slot.
struct RealNav<'a>(StreamedNav<'a>);

impl StreamNav for RealNav<'_> {
    type Island = NavIsland;

    fn island_leave(&mut self, cell: CellId) -> usize {
        self.0.island_leave(cell)
    }

    fn island_enter(&mut self, cell: CellId, island: &NavIsland) -> usize {
        self.0.island_enter(cell, island)
    }
}

#[derive(Default)]
struct World {
    /// (tick, entered?, cell, tiles of the cell in the nav right after).
    heard: Vec<(u64, bool, CellId, usize)>,
    agent: Option<AgentId>,
    tick: u64,
}

/// The commit hook: the fake nav, or the real one.
struct NavHook {
    fake: bool,
}

impl NavHook {
    fn slot(&self, sim: &mut Sim<World>, cell: CellId, island: Option<&NavIsland>) -> usize {
        let (left, entered): (Vec<CellId>, Vec<(CellId, &NavIsland)>) = match island {
            Some(island) => (Vec::new(), vec![(cell, island)]),
            None => (vec![cell], Vec::new()),
        };
        if self.fake {
            let mut fake = FakeNav::default();
            commit(&mut fake, &left, &entered);
            return fake.heard.len();
        }
        let islands = sim.facets.get_mut::<NavIslands>();
        let mut real = RealNav(StreamedNav { nav: &mut sim.nav, islands });
        commit(&mut real, &left, &entered);
        sim.facets.get::<NavIslands>().tiles(cell).len()
    }
}

impl StreamCommit<World> for NavHook {
    fn leave(&self, sim: &mut Sim<World>, cell: CellId) {
        let tiles = self.slot(sim, cell, None);
        let tick = sim.world.tick;
        sim.world.heard.push((tick, false, cell, if self.fake { 0 } else { tiles }));
    }

    fn enter(&self, sim: &mut Sim<World>, cell: &EnteredCell) {
        let island = cell.parts::<IslandPart>().next().map(|part| part.0.clone()).unwrap_or_default();
        let tiles = self.slot(sim, cell.cell(), Some(&island));
        let tick = sim.world.tick;
        sim.world.heard.push((tick, true, cell.cell(), if self.fake { island.tiles().len() } else { tiles }));
    }
}

fn anchor_at(tick: u64) -> Vec3 {
    if (LEAVE_TICK..RETURN_TICK).contains(&tick) { AWAY } else { HOME }
}

fn streamed_game(fake: bool, slow_cell: Option<CellId>) -> Game<World> {
    let bake = offline_bake();
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(0).prefetch(0));
    game.navigation(walker());
    game.cell_content(move |cell: CellId, _: &CellInputs| {
        #[cfg(not(target_arch = "wasm32"))]
        if slow_cell == Some(cell) {
            std::thread::sleep(Duration::from_millis(40));
        }
        let _ = slow_cell;
        let island = bake.get(&cell).map(|bytes| NavIsland::from_bytes(bytes).expect("the offline bake reads"));
        CellBuild::<u32>::default().part(IslandPart(island.unwrap_or_default()))
    });
    game.facet_state::<NavIslands>();
    game.stream_commit(NavHook { fake });
    game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", HOME).expect("anchor"));
    game.on_update(|sim, ctx| {
        sim.world.tick = ctx.tick + 1;
        if sim.world.agent.is_none() && sim.nav.tile_count() > 0 {
            sim.nav.update(ctx.dt);
            let agent = sim.nav.add_agent(NavAgent::new(vec3(3.0, 0.0, 3.0)).with_speed(0.15, 0.3)).expect("an agent");
            sim.nav.move_to(agent, vec3(13.0, 0.0, 13.0));
            sim.world.agent = Some(agent);
        }
        sim.nav.update(ctx.dt);
        if let Some(agent) = sim.world.agent {
            let velocity = sim.nav.desired_velocity(agent);
            let position = sim.nav.position(agent).unwrap_or_default() + velocity * ctx.dt;
            sim.nav.set_position(agent, position, velocity);
        }
        sim.stream.set_anchor("player", anchor_at(ctx.tick + 1)).expect("anchor");
    });
    game.probe("nav", |sim| serde_json::Value::from(&sim.nav.probe()));
    game.probe("islands", |sim| json!(hex64(sim.facets.get::<NavIslands>().digest(&sim.nav))));
    game
}

fn run(game: Game<World>, pool: Pool, ticks: u64) -> Runtime<World> {
    let mut runtime = Runtime::new(game).expect("installs");
    runtime.use_stream_pool(Arc::new(pool));
    runtime.seed(5);
    runtime.step(FIXED_STEP_MS * ticks as f64);
    runtime
}

/// Each tick's slot calls leave descending before entering ascending.
fn assert_canonical(heard: &[(u64, bool, CellId, usize)]) {
    let mut ticks: BTreeMap<u64, Vec<(bool, CellId)>> = BTreeMap::new();
    for (tick, entered, cell, _) in heard {
        ticks.entry(*tick).or_default().push((*entered, *cell));
    }
    assert!(ticks.values().any(|calls| calls.iter().any(|(e, _)| !e) && calls.iter().any(|(e, _)| *e)), "some tick both left and entered");
    for (tick, calls) in ticks {
        let first_enter = calls.iter().position(|(entered, _)| *entered).unwrap_or(calls.len());
        assert!(calls[first_enter..].iter().all(|(entered, _)| *entered), "tick {tick}: a leave after an enter: {calls:?}");
        let leaves: Vec<CellId> = calls[..first_enter].iter().map(|(_, cell)| *cell).collect();
        let enters: Vec<CellId> = calls[first_enter..].iter().map(|(_, cell)| *cell).collect();
        assert!(leaves.windows(2).all(|w| w[0] > w[1]), "tick {tick}: leaves descending: {leaves:?}");
        assert!(enters.windows(2).all(|w| w[0] < w[1]), "tick {tick}: enters ascending: {enters:?}");
    }
}

#[test]
fn leaves_descend_before_enters_ascend_with_a_fake_nav_and_with_the_real_one() {
    let fake = run(streamed_game(true, None), Pool::inline(), TICKS);
    assert_canonical(&fake.sim().world.heard);
    let real = run(streamed_game(false, None), Pool::inline(), TICKS);
    assert_canonical(&real.sim().world.heard);
    let order = |runtime: &Runtime<World>| runtime.sim().world.heard.iter().map(|(tick, entered, cell, _)| (*tick, *entered, *cell)).collect::<Vec<_>>();
    assert_eq!(order(&fake), order(&real), "the real nav is driven in the fake's order");
    let sim = real.sim();
    let islands = sim.facets.get::<NavIslands>();
    let active: Vec<CellId> = sim.stream.active().filter(|cell| (0..GROUND_CELLS).contains(&cell.x) && (0..2).contains(&cell.z)).collect();
    assert_eq!(islands.cells().filter(|cell| !islands.tiles(*cell).is_empty()).collect::<Vec<_>>(), active, "every active ground cell's island is in, no other");
    assert_eq!(sim.nav.tile_count(), active.len() * 4, "four 8 m tiles a 16 m cell");
}

#[test]
fn a_real_island_streamed_out_freezes_its_agent_and_streamed_back_resumes_the_same_path() {
    let mut runtime = Runtime::new(streamed_game(false, None)).expect("installs");
    runtime.use_stream_pool(Arc::new(Pool::inline()));
    runtime.seed(5);
    let corners = |runtime: &Runtime<World>| {
        let sim = runtime.sim();
        let agent = sim.world.agent.expect("the agent");
        let at = sim.nav.position(agent).expect("live");
        (at, sim.nav.target(agent), sim.nav.path(at, vec3(13.0, 0.0, 13.0), &NavFilter::new()).map(|path| path.steps))
    };
    runtime.step(FIXED_STEP_MS * (LEAVE_TICK - 2) as f64);
    let agent = runtime.sim().world.agent.expect("the agent");
    assert_eq!(runtime.sim().nav.status(agent), Some(NavStatus::Moving));
    let before = corners(&runtime);
    assert!(before.2.is_some(), "a path before the cell leaves");
    runtime.step(FIXED_STEP_MS * 10.0);
    let sim = runtime.sim();
    assert_eq!(sim.nav.status(agent), Some(NavStatus::OffMesh), "streamed out: off the mesh");
    assert_eq!(sim.nav.desired_velocity(agent), Vec3::ZERO, "and frozen");
    let frozen_at = sim.nav.position(agent);
    runtime.step(FIXED_STEP_MS * 20.0);
    assert_eq!(runtime.sim().nav.position(agent), frozen_at, "it stays where it stood");
    runtime.step(FIXED_STEP_MS * (RETURN_TICK - LEAVE_TICK - 28) as f64);
    assert_eq!(runtime.sim().nav.position(agent), frozen_at, "still where it stood when its cell comes back");
    let mut resumed_after = None;
    for extra in 1..=5 {
        runtime.step(FIXED_STEP_MS);
        if runtime.sim().nav.status(agent) == Some(NavStatus::Moving) {
            resumed_after = Some(extra);
            break;
        }
    }
    assert!(resumed_after.is_some(), "back in: it walks on within 5 ticks");
    let back = corners(&runtime);
    assert_eq!(back.1, before.1, "toward the same target");
    let frozen_at = frozen_at.expect("live");
    let toward = (vec3(13.0, 0.0, 13.0) - frozen_at).normalize();
    assert!((back.0 - frozen_at).dot(toward) >= 0.0, "from where it froze, toward its target");
    // Open ground: the path is the straight line to the same end, before and after.
    assert_eq!(back.2, before.2, "the same path");
}

// Native only: worker threads and a sleeping builder (the web runs builds inline).
#[cfg(not(target_arch = "wasm32"))]
#[test]
fn checksums_are_equal_with_1_and_8_workers_and_inline_with_real_islands() {
    let one = run(streamed_game(false, None), Pool::new(1), TICKS);
    let eight = run(streamed_game(false, Some(CellId { x: 1, z: 1 })), Pool::new(8), TICKS);
    let inline = run(streamed_game(false, None), Pool::inline(), TICKS);
    assert_eq!(one.checksum(), eight.checksum(), "1 vs 8 workers");
    assert_eq!(one.checksum(), inline.checksum(), "workers vs inline (the web's pool)");
    assert_eq!(one.sim().world.heard, inline.sim().world.heard);
    assert_eq!(one.probes()["islands"], inline.probes()["islands"]);
}

#[cfg(not(target_arch = "wasm32"))]
#[test]
fn a_late_island_holds_the_frame_and_is_in_on_the_tick_its_cell_enters() {
    let slow = CellId { x: 1, z: 1 };
    let runtime = run(streamed_game(false, Some(slow)), Pool::new(2), TICKS);
    let entries: Vec<_> = runtime.sim().world.heard.iter().filter(|(_, entered, cell, _)| *entered && *cell == slow).collect();
    assert!(!entries.is_empty(), "the slow cell entered");
    assert!(entries.iter().all(|(_, _, _, tiles)| *tiles == 4), "its island was in when it entered: {entries:?}");
}

#[test]
#[allow(clippy::disallowed_types, reason = "an advisory timing row of the test, not simulation code")]
fn four_cells_entering_on_one_tick_fit_the_inline_finish_slice() {
    let bake = offline_bake();
    let cells = [CellId { x: 4, z: 0 }, CellId { x: 5, z: 0 }, CellId { x: 4, z: 1 }, CellId { x: 5, z: 1 }];
    let mut best = f64::INFINITY;
    for _ in 0..5 {
        let mut nav = genex::nav::Nav::new(&walker());
        let mut islands = NavIslands::default();
        let started = std::time::Instant::now();
        let read: Vec<(CellId, NavIsland)> = cells.iter().map(|cell| (*cell, NavIsland::from_bytes(&bake[cell]).expect("reads"))).collect();
        let entering: Vec<(CellId, &NavIsland)> = read.iter().map(|(cell, island)| (*cell, island)).collect();
        let done = commit(&mut RealNav(StreamedNav { nav: &mut nav, islands: &mut islands }), &[], &entering);
        nav.update(1.0 / 60.0);
        best = best.min(started.elapsed().as_secs_f64() * 1000.0);
        assert_eq!((done.entered, done.tiles_in), (4, 16));
    }
    println!("four cells: read + enter + stitch best of 5 = {best:.3} ms (slice {STREAM_HOLD_LIVE_SLICE_MS} ms)");
    assert!(best <= STREAM_HOLD_LIVE_SLICE_MS, "{best:.3} ms over the {STREAM_HOLD_LIVE_SLICE_MS} ms inline slice");
}
