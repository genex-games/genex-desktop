//! Sim-side asset reads (`gfx.assets().bytes`, `.triangles`, `.info`): the source a shell attaches
//! before the first seed, the reset-only and preloaded-group rules, the hostile-path table (no read
//! and no side effect) and the cache that keeps a re-seed from reading again.

use genex::prelude::*;
use genex::{AssetError, AssetErrorCode, AssetFiles, AssetGroup, AssetGroups, AssetSource, AssetTable, DEFAULT_SEED, ModelTriangles, Runtime};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// A real GLB the importer suite writes (three levels of detail of a sphere).
const SPHERE: &[u8] = include_bytes!("../../../../../tests/fixtures/asset-import/lods-sphere.glb");
const LEVEL: &[u8] = br#"{"enemies": 3, "spawn": [1.5, 0.0, -2.0]}"#;
const TABLE: AssetTable = &[("levels/one.json", LEVEL), ("lods-sphere.glb", SPHERE)];

/// What a reset read, kept in the world so probes and later hooks see it.
#[derive(Default)]
struct World {
    enemies: i64,
    level_digest: u64,
    outcome: Vec<String>,
    triangles: Option<Arc<ModelTriangles>>,
}

/// A source that counts the reads that reach it and names each path it was asked for.
struct Counting {
    inner: Box<dyn AssetSource>,
    reads: Arc<AtomicUsize>,
    asked: Asked,
}

impl AssetSource for Counting {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.asked.lock().expect("asked").push(path.to_owned());
        self.inner.read(path)
    }

    fn size(&self, path: &str) -> Result<u64, AssetError> {
        self.inner.size(path)
    }

    fn group(&self, path: &str) -> AssetGroup {
        self.inner.group(path)
    }
}

/// The paths a [`Counting`] source was asked for, in order.
type Asked = Arc<Mutex<Vec<String>>>;

fn counting(inner: Box<dyn AssetSource>) -> (Box<dyn AssetSource>, Arc<AtomicUsize>, Asked) {
    let reads = Arc::new(AtomicUsize::new(0));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let source = Counting { inner, reads: Arc::clone(&reads), asked: Arc::clone(&asked) };
    (Box::new(source), reads, asked)
}

/// A game whose reset parses `levels/one.json` into its world.
fn level_game() -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let bytes = gfx.assets().bytes("levels/one.json").expect("the level reads at reset");
        let level = bytes.json().expect("the level is JSON");
        sim.world.enemies = level["enemies"].as_i64().unwrap_or(-1);
        sim.world.level_digest = bytes.digest();
    });
    game.on_update(|sim, _| sim.world.enemies += 1);
    game.probe("enemies", |sim| json!(sim.world.enemies));
    game
}

/// A game whose reset reads each of `paths` and records each answer's code (`ok` for a read).
fn reading_game(paths: &'static [&'static str]) -> Game<World> {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(move |sim, _, _, gfx| {
        for path in paths {
            let answer = gfx.assets().bytes(path);
            sim.world.outcome.push(answer.map_or_else(|error| error.code().wire().to_owned(), |_| "ok".to_owned()));
        }
    });
    game.probe("outcome", |sim| json!(sim.world.outcome));
    game
}

/// A fresh scratch folder for one test (removed first, so a rerun starts clean).
fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-assets-read-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("assets/levels")).expect("assets folder");
    dir
}

fn write(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).expect("fixture file");
}

#[test]
fn the_first_seed_reads_the_level_under_an_attached_source() {
    // Before SF-1a `Runtime::new` seeded before any source existed, so the first reset could not read.
    let runtime = Runtime::with_assets(level_game(), Box::new(TABLE)).expect("valid game");
    assert_eq!(runtime.tick(), 0, "the first seed, not a re-seed");
    assert_eq!(runtime.sim().world.enemies, 3);
    assert_eq!(runtime.sim().world.level_digest, genex_core_digest(LEVEL));
    assert_eq!(runtime.state()["assets"], json!(["levels/one.json"]), "state().assets lists the read");

    let dir = scratch("first-seed");
    write(&dir.join("assets/levels/one.json"), LEVEL);
    let files = AssetFiles::new(&[], Some(dir.join("assets")));
    let from_disk = Runtime::with_assets(level_game(), Box::new(files)).expect("valid game");
    assert_eq!(from_disk.sim().world.enemies, 3, "the asset folder serves the first seed too");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_runtime_without_a_source_answers_missing() {
    let runtime = Runtime::new(reading_game(&["levels/one.json"])).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, ["missing"]);
}

#[test]
fn triangles_are_the_renderers_own_reading_of_the_glb() {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let model = gfx.assets().model("lods-sphere.glb");
        sim.world.triangles = Some(gfx.assets().triangles(&model).expect("a GLB with triangles"));
    });
    let runtime = Runtime::with_assets(game, Box::new(TABLE)).expect("valid game");
    let triangles = runtime.sim().world.triangles.clone().expect("read at reset");
    let mesh = genex_render::mesh::MeshData::from_glb(SPHERE).expect("the renderer reads the fixture");
    let positions: Vec<Vec3> = mesh.vertices.iter().map(|vertex| Vec3::from_array(vertex.position)).collect();
    assert_eq!(triangles.positions, positions);
    assert_eq!(triangles.indices, mesh.indices);
    assert_eq!(triangles.triangle_count(), mesh.indices.len() / 3);
    let min = positions.iter().copied().fold(Vec3::splat(f32::INFINITY), Vec3::min);
    let max = positions.iter().copied().fold(Vec3::splat(f32::NEG_INFINITY), Vec3::max);
    assert_eq!((triangles.min, triangles.max), (min, max));
    assert!(triangles.min.cmplt(triangles.max).all(), "a sphere has volume");
}

#[test]
fn triangles_of_a_file_that_is_not_a_glb_or_a_missing_model_are_refused() {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let rows = [gfx.assets().model("levels/one.json"), gfx.assets().model("../x.glb"), gfx.assets().model("nope.glb")];
        for model in rows {
            let answer = gfx.assets().triangles(&model);
            sim.world.outcome.push(answer.map_or_else(|error| error.code().wire().to_owned(), |_| "ok".to_owned()));
        }
    });
    let runtime = Runtime::with_assets(game, Box::new(TABLE)).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, ["malformed", "unsafe-path", "missing"]);
}

/// The hostile-path table: each path is refused with its code, nothing outside the asset folder is
/// read, no hostile path reaches `state().assets`, and nothing is written.
#[cfg(unix)]
#[test]
fn hostile_paths_read_nothing_and_leave_no_trace() {
    const HOSTILE: &[&str] = &["../x.glb", "/etc/hosts", "a/../../x.glb", "leak.glb", "leaks/secret.glb", "", "levels\\one.json", "nul\0.glb"];
    let dir = scratch("hostile");
    write(&dir.join("x.glb"), b"outside");
    std::fs::create_dir_all(dir.join("outside")).expect("outside folder");
    write(&dir.join("outside/secret.glb"), b"secret");
    std::os::unix::fs::symlink(dir.join("outside/secret.glb"), dir.join("assets/leak.glb")).expect("file link");
    std::os::unix::fs::symlink(dir.join("outside"), dir.join("assets/leaks")).expect("folder link");
    let before = listing(&dir);
    let (source, reads, asked) = counting(Box::new(AssetFiles::new(&[], Some(dir.join("assets")))));
    let runtime = Runtime::with_assets(reading_game(HOSTILE), source).expect("valid game");
    let codes = ["unsafe-path"; 8];
    assert_eq!(runtime.sim().world.outcome, codes, "every hostile path is unsafe-path");
    // Only the two links pass the asset-path rule and reach the source, which refuses them by real path.
    assert_eq!(*asked.lock().expect("asked"), ["leak.glb", "leaks/secret.glb"]);
    assert_eq!(reads.load(Ordering::SeqCst), 2);
    assert_eq!(runtime.state()["assets"], json!([]), "a refused path is not listed");
    assert_eq!(listing(&dir), before, "nothing was written");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A `.gltf` whose buffer URI climbs out of the folder: its triangles are refused and the buffer
/// is never opened (the renderer's reader reads only an embedded BIN chunk).
#[test]
fn a_gltf_whose_buffer_escapes_is_refused_without_reading_the_buffer() {
    let dir = scratch("gltf-escape");
    write(&dir.join("secret.bin"), &[0u8; 36]);
    let gltf = br#"{"asset":{"version":"2.0"},"buffers":[{"uri":"../secret.bin","byteLength":36}],
        "bufferViews":[{"buffer":0,"byteLength":36}],
        "accessors":[{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[0,0,0]}],
        "meshes":[{"primitives":[{"attributes":{"POSITION":0}}]}],"nodes":[{"mesh":0}],"scenes":[{"nodes":[0]}],"scene":0}"#;
    write(&dir.join("assets/escape.gltf"), gltf);
    let (source, _, asked) = counting(Box::new(AssetFiles::new(&[], Some(dir.join("assets")))));
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let answer = gfx.assets().triangles(&gfx.assets().model("escape.gltf"));
        sim.world.outcome.push(answer.map_or_else(|error| error.code().wire().to_owned(), |_| "ok".to_owned()));
    });
    let runtime = Runtime::with_assets(game, source).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, ["malformed"]);
    assert_eq!(*asked.lock().expect("asked"), ["escape.gltf"], "the buffer's URI is never asked for");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_streamed_or_named_group_asset_refuses_not_preloaded_at_reset() {
    let groups = AssetGroups::default()
        .with("cells/a.json", AssetGroup::Stream)
        .with("arena/boss.json", AssetGroup::Named)
        .with("ui/title.json", AssetGroup::Boot);
    let table: AssetTable = &[("cells/a.json", b"{}"), ("arena/boss.json", b"{}"), ("ui/title.json", b"{}"), ("levels/one.json", LEVEL)];
    let files = AssetFiles::new(table, None).with_groups(groups);
    let (source, reads, _) = counting(Box::new(files));
    let paths: &'static [&'static str] = &["cells/a.json", "arena/boss.json", "ui/title.json", "levels/one.json"];
    let runtime = Runtime::with_assets(reading_game(paths), source).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, ["not-preloaded", "not-preloaded", "ok", "ok"]);
    assert_eq!(reads.load(Ordering::SeqCst), 2, "a refused group is never read");
    assert_eq!(runtime.state()["assets"], json!(["ui/title.json", "levels/one.json"]));
}

#[test]
fn a_reseed_reuses_every_read_and_parse() {
    let (source, reads, _) = counting(Box::new(TABLE));
    let mut game = level_game();
    game.on_reset(|sim, _, _, gfx| {
        let model = gfx.assets().model("lods-sphere.glb");
        sim.world.triangles = Some(gfx.assets().triangles(&model).expect("triangles"));
    });
    let mut runtime = Runtime::with_assets(game, source).expect("valid game");
    let first = runtime.sim().world.triangles.clone().expect("first seed");
    let first_checksum = runtime.checksum();
    runtime.seed(2);
    runtime.seed(DEFAULT_SEED);
    assert_eq!(reads.load(Ordering::SeqCst), 2, "one read per file over three seeds");
    let again = runtime.sim().world.triangles.clone().expect("a re-seed");
    assert!(Arc::ptr_eq(&first, &again), "the triangles are parsed once");
    assert_eq!(runtime.checksum(), first_checksum, "the same seed gives the same checksum");
    assert_eq!(runtime.state()["assets"], json!(["levels/one.json", "lods-sphere.glb"]));
}

#[test]
fn info_answers_size_and_group_without_reading_into_the_sim() {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        for path in ["lods-sphere.glb", "cells/a.json", "nope.json", "../x.json"] {
            let info = gfx.assets().info(path);
            sim.world.outcome.push(info.map_or_else(|| "none".to_owned(), |info| format!("{} {}", info.bytes, info.group.wire())));
        }
    });
    let table: AssetTable = &[("lods-sphere.glb", SPHERE), ("cells/a.json", b"{}")];
    let files = AssetFiles::new(table, None).with_groups(AssetGroups::default().with("cells/a.json", AssetGroup::Stream));
    let (source, reads, _) = counting(Box::new(files));
    let runtime = Runtime::with_assets(game, source).expect("valid game");
    let sphere = format!("{} sim", SPHERE.len());
    assert_eq!(runtime.sim().world.outcome, [sphere.as_str(), "2 stream", "none", "none"]);
    assert_eq!(reads.load(Ordering::SeqCst), 0, "info reads no bytes");
    assert_eq!(runtime.state()["assets"], json!([]), "info lists nothing");
}

#[test]
fn bytes_parse_as_json_or_refuse_malformed_and_read_as_text() {
    let mut game = Game::new(World::default()).world_size(64, 64);
    game.on_reset(|sim, _, _, gfx| {
        let level = gfx.assets().bytes("levels/one.json").expect("level");
        let glb = gfx.assets().bytes("lods-sphere.glb").expect("glb");
        sim.world.outcome.push(level.json().map_or_else(|error| error.code().wire().to_owned(), |value| value["spawn"].to_string()));
        sim.world.outcome.push(glb.json().map_or_else(|error| error.code().wire().to_owned(), |value| value.to_string()));
        sim.world.outcome.push(level.as_str().unwrap_or("not text").len().to_string());
    });
    let runtime = Runtime::with_assets(game, Box::new(TABLE)).expect("valid game");
    assert_eq!(runtime.sim().world.outcome, ["[1.5,0.0,-2.0]".to_owned(), "malformed".to_owned(), LEVEL.len().to_string()]);
}

#[test]
fn the_asset_codes_keep_their_wire_spellings() {
    let wires = AssetErrorCode::ALL.map(AssetErrorCode::wire);
    assert_eq!(wires, ["unsafe-path", "missing", "too-large", "malformed", "not-at-reset", "not-preloaded"]);
    let groups = [AssetGroup::Boot, AssetGroup::Sim, AssetGroup::Stream, AssetGroup::Named].map(AssetGroup::wire);
    assert_eq!(groups, ["boot", "sim", "stream", "named"]);
}

fn genex_core_digest(bytes: &[u8]) -> u64 {
    // FNV-1a 64, spelled out so the row does not lean on the code under test.
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3))
}

/// Every path under `dir` with its size, sorted (a folder's links listed, not followed).
fn listing(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut rows = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).expect("listing").flatten() {
            let meta = std::fs::symlink_metadata(entry.path()).expect("metadata");
            if meta.is_dir() {
                stack.push(entry.path());
            }
            rows.push((entry.path(), meta.len()));
        }
    }
    rows.sort();
    rows
}
