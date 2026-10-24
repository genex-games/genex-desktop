//! The web's streaming while playing (game systems STR-14b, gate GR's web streaming finding): the
//! shell asks the game what it streams each frame ([`GameHandle::stream_wants`]), wants those files
//! from the plan ([`WebStream::frame`]), and hands what arrived to the sim's source at the next
//! frame boundary, so a named group a game waits on stops holding once it arrives and a pack's cells
//! and terrain tiles around the player reach the sim's reads, as the asset folder holds them
//! natively. Plain Rust: the wasm32 exports (`studio_assets_wanted`, `studio_assets_arrived`) are
//! thin calls into these.

use genex::prelude::*;
use genex::{AssetSource, CellId, FIXED_STEP_MS, Runtime, STREAM_GROUP_PREFETCH_TICKS, StreamTicket, Streaming};
use genex_core::digest::{fnv1a64, hex64};
use genex_platform_web::GameHandle;
use genex_platform_web::assets::{AssetRefusal, Fetch, WebAssets};
use genex_platform_web::web_stream::{self, WebStream};
use serde_json::{Value, json};

/// The package step's index: one group, "interior", of a level file.
const INDEX: &str = r#"{"version":1,"assets":[],"groups":[{"name":"interior","assets":["interior/room.json"]}]}"#;
const ROOM: &[u8] = br#"{"doors": 2}"#;
/// The tick the game requires the interior on.
const REQUIRE_TICK: u64 = 3;
/// The frame the shell's fetches of the interior land on (well after the group is due).
const ARRIVAL_FRAME: u32 = 20;
/// The streamed grid's cell side, in metres.
const CELL: f32 = 64.0;
/// A cell far from the start, past every ring around it.
const FAR: CellId = CellId { x: 10, z: 0 };

fn digest(bytes: &[u8]) -> String {
    hex64(fnv1a64(bytes))
}

/// A file of `length` bytes whose content is its position plus `salt`, so every file has its own digest.
fn file(length: usize, salt: u8) -> Vec<u8> {
    (0..length).map(|at| (at % 251) as u8 ^ salt).collect()
}

fn entry(path: &str, bytes: &[u8], group: &str) -> Value {
    json!({"path": path, "bytes": bytes.len(), "fnv1a64": digest(bytes), "group": group})
}

fn named(path: &str, bytes: &[u8], name: &str) -> Value {
    json!({"path": path, "bytes": bytes.len(), "fnv1a64": digest(bytes), "group": "named", "name": name})
}

fn map(files: Vec<Value>) -> Vec<u8> {
    serde_json::to_vec(&json!({"version": 2, "files": files})).expect("JSON")
}

/// `studio_boot`'s hand-over after the shell preloaded `preloaded`: the sim's source and the
/// shell's streaming state.
fn booted(map: &[u8], preloaded: &[(&str, &[u8])]) -> (genex_platform_web::studio::WebSource, WebStream) {
    let mut assets = WebAssets::plan(map).expect("a v2 map");
    for (path, bytes) in preloaded {
        assets.admit(path, bytes.to_vec()).expect("a preloaded file");
    }
    web_stream::boot(&[], assets)
}

fn paths(fetches: &[Fetch]) -> Vec<&str> {
    fetches.iter().map(|fetch| fetch.path.as_str()).collect()
}

// ── named groups ──

#[derive(Default)]
struct Interior {
    tick: u64,
    ticket: Option<StreamTicket>,
    ready_at: Option<u64>,
    doors: Option<i64>,
}

/// A game that requires "interior" on [`REQUIRE_TICK`] and reads its level file once ready.
fn interior_game() -> Game<Interior> {
    let mut game = Game::new(Interior::default()).title("Web groups");
    game.on_update(|sim, _| {
        sim.world.tick += 1;
        if sim.world.tick == REQUIRE_TICK {
            sim.world.ticket = Some(sim.stream.require("interior").expect("a declared group"));
        }
        let Some(ticket) = sim.world.ticket else { return };
        if sim.world.ready_at.is_some() {
            return;
        }
        if let Some(handles) = sim.stream.ready(ticket) {
            let room: Value = serde_json::from_slice(handles.bytes("interior/room.json").expect("the member's bytes")).expect("JSON");
            sim.world.doors = room["doors"].as_i64();
            sim.world.ready_at = Some(sim.world.tick);
        }
    });
    game
}

fn interior_map() -> Vec<u8> {
    map(vec![entry("genex-asset-index.json", INDEX.as_bytes(), "sim"), named("interior/room.json", ROOM, "interior")])
}

#[test]
fn a_required_named_group_is_fetched_and_its_hold_ends_once_it_arrives() {
    let (source, mut stream) = booted(&interior_map(), &[("genex-asset-index.json", INDEX.as_bytes())]);
    let mut runtime = Runtime::with_assets(interior_game(), Box::new(source)).expect("a valid game");
    let mut asked: Vec<Fetch> = Vec::new();
    let mut held = 0;
    for frame in 1..=ARRIVAL_FRAME + 10 {
        // The shell's frame: the pieces fetched since are handed over, then what the game wants.
        if frame == ARRIVAL_FRAME {
            for fetch in &asked {
                stream.arrived(&fetch.path, fetch.offset, ROOM.to_vec()).expect("the planned bytes");
            }
        }
        asked.extend(stream.frame(&GameHandle::stream_wants(&runtime)));
        if runtime.step(FIXED_STEP_MS).ticks == 0 {
            held += 1;
        }
    }
    assert_eq!(paths(&asked), ["interior/room.json"], "the required group's member is fetched, once");
    let world = &runtime.sim().world;
    assert_eq!(world.ready_at, Some(REQUIRE_TICK + STREAM_GROUP_PREFETCH_TICKS), "ready on the tick a native run is");
    assert_eq!(world.doors, Some(2), "the handles carry the fetched bytes");
    assert!(held > 0, "the frames before the arrival were held");
    assert!(world.tick > REQUIRE_TICK + STREAM_GROUP_PREFETCH_TICKS, "the hold ended once the member arrived: tick {}", world.tick);
}

#[test]
fn a_group_member_fetched_by_ranges_reaches_the_sim_whole_once_every_range_arrived() {
    let level = file(300, 7);
    let ranged = json!({"path": "interior/room.json", "bytes": 300, "fnv1a64": digest(&level), "group": "named", "name": "interior",
        "ranges": [{"offset": 0, "bytes": 100, "fnv1a64": digest(&level[..100])}, {"offset": 100, "bytes": 200, "fnv1a64": digest(&level[100..])}]});
    let (source, mut stream) = booted(&map(vec![entry("genex-asset-index.json", INDEX.as_bytes(), "sim"), ranged]), &[("genex-asset-index.json", INDEX.as_bytes())]);
    let wants = web_stream::StreamWants { groups: vec!["interior".to_owned()], cells: Vec::new() };
    let fetches = stream.frame(&wants);
    assert_eq!(fetches.iter().map(|fetch| (fetch.offset, fetch.bytes)).collect::<Vec<_>>(), [(0, 100), (100, 200)]);
    stream.arrived("interior/room.json", 0, level[..100].to_vec()).expect("the first range");
    assert!(stream.frame(&wants).is_empty(), "nothing asked twice while a range is on its way");
    assert!(source.read("interior/room.json").is_err(), "half a file never reaches the sim");
    stream.arrived("interior/room.json", 100, level[100..].to_vec()).expect("the second range");
    assert!(source.read("interior/room.json").is_err(), "arrivals reach the sim at the next frame boundary, never inside a frame");
    assert!(stream.frame(&wants).is_empty(), "a delivered file is never asked again");
    assert_eq!(source.read("interior/room.json").expect("delivered").as_ref(), level.as_slice(), "the whole file");
}

// ── cells and terrain tiles ──

#[derive(Default)]
struct Walker;

/// A streamed world of `CELL`-metre cells with the player anchored in cell (0, 0).
fn walker_game() -> Game<Walker> {
    let mut game = Game::new(Walker).title("Web cells");
    game.streaming(Streaming::grid(CELL).sim_radius(1));
    game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", vec3(CELL / 2.0, 0.0, CELL / 2.0)).expect("inside the world"));
    game
}

/// A cell pack `valley`: its index in `sim`, the bodies and tiles of cells (0, 0) and [`FAR`] in `stream`.
fn valley() -> (Vec<u8>, Vec<(String, Vec<u8>)>) {
    let world = br#"{"format":"genex-cell-pack"}"#.to_vec();
    let terrain = br#"{"format":"genex-terrain-tiles"}"#.to_vec();
    let mut streamed = Vec::new();
    for (salt, cell) in [(1, CellId { x: 0, z: 0 }), (2, FAR)] {
        streamed.push((format!("valley/cells/{}_{}.cell", cell.x, cell.z), file(40, salt)));
        streamed.push((format!("valley/terrain/{}_{}.r16", cell.x, cell.z), file(64, salt + 8)));
    }
    let mut files = vec![entry("valley/world.json", &world, "sim"), entry("valley/terrain/terrain.json", &terrain, "sim")];
    files.extend(streamed.iter().map(|(path, bytes)| entry(path, bytes, "stream")));
    let preloaded = vec![("valley/world.json".to_owned(), world), ("valley/terrain/terrain.json".to_owned(), terrain)];
    (map(files), [preloaded, streamed].concat())
}

fn bytes_of<'a>(files: &'a [(String, Vec<u8>)], path: &str) -> &'a [u8] {
    files.iter().find(|(known, _)| known == path).map(|(_, bytes)| bytes.as_slice()).expect("a valley file")
}

#[test]
fn the_cells_around_the_player_are_fetched_and_a_far_cell_reaches_the_sim_after_a_teleport() {
    let (map, files) = valley();
    let preloaded: Vec<(&str, &[u8])> = files[..2].iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())).collect();
    let (source, mut stream) = booted(&map, &preloaded);
    let mut runtime = Runtime::with_assets(walker_game(), Box::new(source.clone())).expect("a valid game");
    runtime.step(FIXED_STEP_MS);
    let home = stream.frame(&GameHandle::stream_wants(&runtime));
    assert_eq!(paths(&home), ["valley/cells/0_0.cell", "valley/terrain/0_0.r16"], "the start cell's body and tile, nothing far");
    // The player teleports: the far cell's files are asked for before the commit that enters it.
    runtime.sim_mut().stream.set_anchor("player", vec3(FAR.x as f32 * CELL + CELL / 2.0, 0.0, CELL / 2.0)).expect("inside the world");
    let far = stream.frame(&GameHandle::stream_wants(&runtime));
    assert_eq!(paths(&far), ["valley/cells/10_0.cell", "valley/terrain/10_0.r16"]);
    runtime.step(FIXED_STEP_MS);
    assert!(stream.frame(&GameHandle::stream_wants(&runtime)).is_empty(), "nothing is asked twice while it is on its way");
    for path in ["valley/cells/10_0.cell", "valley/terrain/10_0.r16", "valley/cells/0_0.cell"] {
        stream.arrived(path, 0, bytes_of(&files, path).to_vec()).expect("the planned bytes");
    }
    assert!(source.read("valley/cells/10_0.cell").is_err(), "not inside the frame it arrived in");
    stream.frame(&GameHandle::stream_wants(&runtime));
    for path in ["valley/cells/10_0.cell", "valley/terrain/10_0.r16"] {
        assert_eq!(source.read(path).expect("the far cell's file reached the sim").as_ref(), bytes_of(&files, path), "{path}");
    }
    assert!(source.read("valley/cells/0_0.cell").is_err(), "a cell the player left is dropped, even when its fetch lands late");
    let receipt = stream.delivered().receipt();
    assert_eq!(receipt["cells"], json!([[FAR.x, FAR.z]]), "the receipt names the far cell resident: {receipt}");
    assert_eq!(receipt["inFlight"], json!(0), "the start cell's fetches were dropped with it: {receipt}");
}

#[test]
fn a_game_without_streaming_asks_for_no_cell() {
    let (map, files) = valley();
    let preloaded: Vec<(&str, &[u8])> = files[..2].iter().map(|(path, bytes)| (path.as_str(), bytes.as_slice())).collect();
    let (source, mut stream) = booted(&map, &preloaded);
    let mut runtime = Runtime::with_assets(Game::new(Walker).title("No streaming"), Box::new(source)).expect("a valid game");
    runtime.step(FIXED_STEP_MS);
    let wants = GameHandle::stream_wants(&runtime);
    assert!(wants.cells.is_empty() && wants.groups.is_empty(), "{wants:?}");
    assert!(stream.frame(&wants).is_empty());
}

// ── hostile arrivals ──

/// One hostile arrival: its name, path, offset and bytes, and the refusal it gets (None: dropped).
type Hostile = (&'static str, &'static str, u64, Vec<u8>, Option<AssetRefusal>);

#[test]
fn a_refused_or_unasked_arrival_reaches_nothing_and_a_refused_piece_is_not_asked_again() {
    let (source, mut stream) = booted(&interior_map(), &[("genex-asset-index.json", INDEX.as_bytes())]);
    let wants = web_stream::StreamWants { groups: vec!["interior".to_owned()], cells: Vec::new() };
    assert_eq!(paths(&stream.frame(&wants)), ["interior/room.json"]);
    let rows: [Hostile; 4] = [
        ("another digest", "interior/room.json", 0, b"{\"doors\": 9}".to_vec(), Some(AssetRefusal::DigestMismatch)),
        ("an unplanned path", "interior/attic.json", 0, ROOM.to_vec(), None),
        ("a preloaded file", "genex-asset-index.json", 0, INDEX.as_bytes().to_vec(), None),
        ("an offset never asked", "interior/room.json", 4, ROOM.to_vec(), None),
    ];
    for (name, path, offset, bytes, refusal) in rows {
        let answer = stream.arrived(path, offset, bytes);
        assert_eq!(answer.err().map(|error| error.code()), refusal, "{name}");
    }
    assert!(stream.frame(&wants).is_empty(), "a refused piece is not fetched again every frame");
    assert!(source.read("interior/room.json").is_err(), "nothing reached the sim");
    assert_eq!(source.read("genex-asset-index.json").expect("preloaded").as_ref(), INDEX.as_bytes(), "the preloaded file is untouched");
}
