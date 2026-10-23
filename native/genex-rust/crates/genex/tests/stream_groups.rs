//! Named asset groups (game systems STR-29, release R-9): `sim.stream.require(group)` on a tick,
//! `sim.stream.ready(ticket)` on the tick the simulation decides, `release_group`. The groups come
//! from the build's asset index (`genex-asset-index.json`, the package step's, C-30).
//!
//! The web is modelled by a source whose group members arrive late (the page still fetching them):
//! the group is ready on the same tick as natively, and the frames in between are held. Every row
//! is new behaviour (section 0 of the game systems plan): `stream_groups.rs` was a stub.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use genex::prelude::*;
use genex::{
    AssetError, AssetErrorCode, AssetGroup, AssetSource, AssetTable, FIXED_STEP_MS, GroupHandles, Runtime, STREAM_GROUP_PREFETCH_TICKS, StreamErrorCode,
    StreamTicket, Streaming,
};
use genex_render::jobs::Pool;

/// A real GLB the importer suite writes, as the group's model member.
const CHAIR: &[u8] = include_bytes!("../../../../../tests/fixtures/asset-import/lods-sphere.glb");
const ROOM: &[u8] = br#"{"doors": 2, "lights": [1, 2, 3]}"#;
/// The package step's index: one asset group, "interior", of a level file and a model.
const INDEX: &[u8] = br#"{"version":1,"assets":[],"groups":[{"name":"interior","assets":["interior/chair.glb","interior/room.json"]}]}"#;
const TABLE: AssetTable = &[("genex-asset-index.json", INDEX), ("interior/chair.glb", CHAIR), ("interior/room.json", ROOM)];
/// The tick the game requires the interior on.
const REQUIRE_TICK: u64 = 100;
/// Ticks each run plays.
const RUN_TICKS: u64 = 130;

/// What the game saw of the group.
#[derive(Default)]
struct World {
    tick: u64,
    ticket: Option<StreamTicket>,
    ready_at: Option<u64>,
    doors: Option<i64>,
    handles: Option<GroupHandles>,
    refused: Option<StreamErrorCode>,
    attic: Option<StreamTicket>,
    cellar: Option<StreamErrorCode>,
}

/// A game that requires "interior" on [`REQUIRE_TICK`] and reads its handles in `on_update`.
fn game(streaming: bool) -> Game<World> {
    let mut game = Game::new(World::default()).title("Stream groups");
    if streaming {
        game.streaming(Streaming::grid(32.0));
    }
    game.on_update(|sim, _| {
        let world = &mut sim.world;
        world.tick += 1;
        if world.tick == REQUIRE_TICK {
            world.ticket = Some(sim.stream.require("interior").expect("a declared group"));
            // The groups are not known yet: the commit refuses the undeclared one.
            world.attic = Some(sim.stream.require("attic").expect("checked at the commit"));
        }
        if world.tick == REQUIRE_TICK + 10 {
            world.cellar = sim.stream.require("cellar").err().map(|error| error.code);
        }
        if let Some(attic) = sim.world.attic {
            assert!(sim.stream.ready(attic).is_none(), "an undeclared group is never ready");
            sim.world.refused = sim.stream.group_refusal(attic);
        }
        let Some(ticket) = sim.world.ticket else { return };
        if sim.world.ready_at.is_some() {
            return;
        }
        if let Some(handles) = sim.stream.ready(ticket) {
            let room = handles.bytes("interior/room.json").expect("the level file's bytes");
            let text: genex::Value = serde_json::from_slice(room).expect("json");
            sim.world.doors = text["doors"].as_i64();
            sim.world.ready_at = Some(sim.world.tick);
            sim.world.handles = Some(handles);
        }
    });
    game
}

/// The table, with the group's members missing until `arrived` (the web's late fetch).
struct Late {
    arrived: Arc<AtomicBool>,
}

impl AssetSource for Late {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        if path.starts_with("interior/") && !self.arrived.load(Ordering::SeqCst) {
            return Err(AssetError::new(AssetErrorCode::Missing, format!("{path} was not fetched")));
        }
        TABLE.read(path)
    }

    fn group(&self, path: &str) -> AssetGroup {
        if path.starts_with("interior/") { AssetGroup::Named } else { AssetGroup::Sim }
    }
}

/// What a run gives: the tick the group was ready on, the doors read, the frames held and the
/// handles.
struct Run {
    ready_at: Option<u64>,
    doors: Option<i64>,
    held: u32,
    handles: Option<GroupHandles>,
    refused: Option<StreamErrorCode>,
    cellar: Option<StreamErrorCode>,
    checksum: String,
}

/// Play `RUN_TICKS` ticks one frame at a time; `arrive` is called each frame with the frame number
/// (the late source's members arrive when it says so).
fn play(mut runtime: Runtime<World>, arrive: impl Fn(u32)) -> Run {
    runtime.seed(1);
    let mut held = 0;
    let mut frame = 0;
    while runtime.sim().world.tick < RUN_TICKS {
        frame += 1;
        arrive(frame);
        if runtime.step(FIXED_STEP_MS).ticks == 0 {
            held += 1;
        }
        assert!(frame < 1000, "the run finished");
    }
    let world = &runtime.sim().world;
    Run { ready_at: world.ready_at, doors: world.doors, held, handles: world.handles.clone(), refused: world.refused, cellar: world.cellar, checksum: runtime.checksum() }
}

#[test]
fn a_required_group_is_ready_on_the_same_tick_natively_on_the_web_and_at_any_thread_count() {
    let native = play(Runtime::with_assets(game(false), Box::new(TABLE)).expect("valid"), |_| {});
    let due = REQUIRE_TICK + STREAM_GROUP_PREFETCH_TICKS;
    assert_eq!(native.ready_at, Some(due), "ready exactly the prefetch ticks after the require");
    assert_eq!(native.doors, Some(2), "the level file's bytes work in on_update");
    assert_eq!(native.held, 0, "every member was resident: no frame held");
    assert_eq!(native.refused, Some(StreamErrorCode::UnknownGroup), "an undeclared group's ticket is refused at the commit");
    assert_eq!(native.cellar, Some(StreamErrorCode::UnknownGroup), "once the groups are known, require refuses it itself");
    let handles = native.handles.as_ref().expect("handles");
    assert_eq!(handles.name(), "interior");
    assert_eq!(handles.paths().collect::<Vec<_>>(), ["interior/chair.glb", "interior/room.json"]);
    assert_eq!(handles.model("interior/chair.glb").and_then(|model| model.path()), Some("interior/chair.glb"));
    assert!(handles.model("interior/room.json").is_none(), "only model members are models");
    // The web: the members arrive 40 frames after the group is due; the frames between are held.
    let arrived = Arc::new(AtomicBool::new(false));
    let late = Late { arrived: Arc::clone(&arrived) };
    let web = play(Runtime::with_assets(game(false), Box::new(late)).expect("valid"), |frame| {
        if u64::from(frame) == due + 40 {
            arrived.store(true, Ordering::SeqCst);
        }
    });
    assert_eq!(web.ready_at, native.ready_at, "the same tick on the web");
    assert_eq!(web.doors, native.doors);
    assert!(web.held >= 39, "the late members held the frames until they came: {}", web.held);
    assert_eq!(web.checksum, native.checksum, "the same simulation");
    // Streaming registered, cell builds on 1 and 8 workers: the same tick.
    for workers in [1, 8] {
        let mut runtime = Runtime::with_assets(game(true), Box::new(TABLE)).expect("valid");
        runtime.use_stream_pool(Arc::new(Pool::new(workers)));
        let run = play(runtime, |_| {});
        assert_eq!((run.ready_at, run.doors, run.held), (native.ready_at, native.doors, 0), "{workers} workers");
    }
}

#[test]
fn release_then_require_again_gives_equal_handles() {
    let mut game = Game::new(World::default()).title("Stream groups again");
    game.on_update(|sim, _| {
        sim.world.tick += 1;
        match sim.world.tick {
            1 => sim.world.ticket = Some(sim.stream.require("interior").expect("declared")),
            10 => {
                let ticket = sim.world.ticket.expect("ticket");
                sim.world.handles = sim.stream.ready(ticket);
                assert_eq!(sim.stream.required_groups().collect::<Vec<_>>(), ["interior"]);
                sim.stream.release_group("interior");
                assert!(sim.stream.ready(ticket).is_none(), "a released ticket answers nothing");
                assert_eq!(sim.stream.required_groups().count(), 0);
                sim.world.ticket = Some(sim.stream.require("interior").expect("declared"));
            }
            20 => {
                let again = sim.stream.ready(sim.world.ticket.expect("ticket")).expect("ready again");
                assert_eq!(Some(&again), sim.world.handles.as_ref(), "equal handles");
                sim.world.ready_at = Some(20);
            }
            _ => {}
        }
    });
    let run = play(Runtime::with_assets(game, Box::new(TABLE)).expect("valid"), |_| {});
    assert_eq!(run.ready_at, Some(20));
    assert!(run.handles.is_some());
}

#[test]
fn a_reset_hook_may_require_and_a_game_without_an_index_knows_no_group() {
    let mut game = Game::new(World::default()).title("Stream groups at reset");
    game.on_reset(|sim, _, _, _| sim.world.ticket = Some(sim.stream.require("interior").expect("declared at reset")));
    game.on_update(|sim, _| {
        sim.world.tick += 1;
        if sim.world.ready_at.is_none() && sim.stream.ready(sim.world.ticket.expect("ticket")).is_some() {
            sim.world.ready_at = Some(sim.world.tick);
        }
    });
    let run = play(Runtime::with_assets(game, Box::new(TABLE)).expect("valid"), |_| {});
    assert_eq!(run.ready_at, Some(STREAM_GROUP_PREFETCH_TICKS), "required before tick 1: ready on the prefetch tick");
    let mut bare = Game::new(World::default()).title("No index");
    bare.on_update(|sim, _| {
        sim.world.tick += 1;
        sim.world.refused = sim.stream.require("interior").err().map(|error| error.code);
    });
    let empty: AssetTable = &[];
    let run = play(Runtime::with_assets(bare, Box::new(empty)).expect("valid"), |_| {});
    assert_eq!(run.refused, Some(StreamErrorCode::UnknownGroup));
}
