//! NAV-18: navigation's perf, memory and web-size rows (the NAV budget table, plan section 10).
//!
//! Every row is `#[ignore]`d: the timings are the gate's on a quiet machine (GE), a lane's run is
//! advisory, and the size row needs wasm32 builds.
//!
//! - `--ignored perf` (release): `nav.update` with 100 agents walking a pillar field of about 1k
//!   polygons (p95 ≤ [`UPDATE_P95_MS`]); one path search across it, which the 2,048-node search
//!   budget bounds (median ≤ [`SEARCH_MS`]); one 32 m tile baked at cells of 0.2 m (median ≤
//!   [`TILE_BAKE_MS`]); a whole bake of a 128 m terrain under a walled market of stalls and an
//!   upper floor, the bake a game runs at reset (median ≤ [`RESET_BAKE_MS`], each repeat a new input
//!   so the bake memo never answers); the nav-crowd reset itself; bytes per tile (typical ≤
//!   [`TILE_BYTES_TYPICAL`]) and the nav world's resident bytes (≤ [`NAV_RESIDENCY_BYTES`]).
//! - `--ignored wasm_size`: the genex-nav code (function bodies whose symbol names `genex_nav`) in
//!   the raw wasm32 modules `GENEX_NAV_FREE_WASM` (a game that never calls nav: the pond) and
//!   `GENEX_NAV_WASM` (nav-crowd), built with the export size profile and their name section
//!   (`.studio-dev/evidence/rust-wgpu-run/game-systems/nav/web-size.sh`). A nav-free game must link
//!   none of it (+0 KB); a game that uses nav at most [`NAV_WEB_BYTES_MAX`] of raw code.
//!
//! Each row writes its record to `GENEX_NAV_PERF_OUT` / `GENEX_NAV_SIZE_OUT` when set.
//!
//!   node scripts/toolchains/rust-env.ts -- cargo test -p nav-crowd --release --offline --test perf \
//!     -- --ignored perf --nocapture
#![allow(clippy::disallowed_types, reason = "a perf harness reads the wall clock; the simulation never does")]

use std::sync::Arc;
use std::time::Instant;

use genex::glam::{Mat4, Vec3};
use genex::nav::{HeightGrid, Nav, NavAgent, NavArea, NavConfig, NavFilter, NavInput, NavMesh};
use genex::{CellId, FIXED_STEP_MS, Runtime, Value, json};
use nav_crowd_game::game;

/// `nav.update` with 100 agents, p95, native (the M4 Max target).
const UPDATE_P95_MS: f64 = 0.6;
/// One path search over 2,048 nodes, native.
const SEARCH_MS: f64 = 0.15;
/// One 32 m tile at cells of 0.2 m, native.
const TILE_BAKE_MS: f64 = 6.0;
/// The reset bake of a 128 m terrain and the market, native.
const RESET_BAKE_MS: f64 = 120.0;
/// A typical tile's bytes (polygons, detail and links).
const TILE_BYTES_TYPICAL: usize = 64 * 1024;
/// A phone's nav residency (tiles and caches).
const NAV_RESIDENCY_BYTES: usize = 4 * 1024 * 1024;
/// The raw genex-nav code a game that uses nav may link (the plan's +250 KB is gzip; raw is the
/// gate's stand-in until the export's own gzip row lands at GE).
const NAV_WEB_BYTES_MAX: u64 = 1024 * 1024;

/// Agents the update row moves.
const AGENTS: usize = 100;
/// Ticks the update row warms up, then measures.
const WARM_TICKS: usize = 120;
const MEASURED_TICKS: usize = 600;
/// Repeats of the search, tile and reset rows.
const SEARCH_REPEATS: usize = 200;
const BAKE_REPEATS: usize = 7;
const RESET_REPEATS: usize = 3;
/// The pillar field: its half side, pillar spacing and pillar half width, metres.
const FIELD_HALF: f32 = 48.0;
const PILLAR_STEP: f32 = 5.5;
const PILLAR_HALF: f32 = 0.6;
/// The market input: terrain half side, wall half side, stall rows.
const TERRAIN_HALF: f32 = 64.0;
const WALL_HALF: f32 = 22.0;
const STALL_ROWS: [f32; 4] = [-15.0, -7.5, 7.5, 15.0];

fn median(values: &mut [f64]) -> f64 {
    percentile(values, 0.5)
}

fn percentile(values: &mut [f64], share: f64) -> f64 {
    values.sort_by(f64::total_cmp);
    let at = ((values.len() as f64 - 1.0) * share).round() as usize;
    values.get(at).copied().unwrap_or(0.0)
}

fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}

fn rounded(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn walker() -> NavConfig {
    NavConfig::walker(0.4, 1.8)
}

/// The pillar field's config: 16 m tiles.
fn field_config() -> NavConfig {
    walker().with_tile(16.0)
}

/// A box of half extents `half` standing on y 0 at (`x`, `z`), raised by `lift` metres.
fn block(x: f32, z: f32, half: Vec3, lift: f32) -> Mat4 {
    Mat4::from_scale_rotation_translation(half * 2.0, genex::glam::Quat::IDENTITY, Vec3::new(x, half.y + lift, z))
}

fn flat(half: f32) -> Arc<HeightGrid> {
    let samples = (half * 2.0) as u32 + 1;
    Arc::new(HeightGrid::from_fn((samples, samples), [-half, -half], 1.0, |_, _| 0.0).expect("a flat grid"))
}

/// A flat field with a pillar every [`PILLAR_STEP`] metres: about a thousand polygons wind
/// between them.
fn pillar_field() -> NavInput {
    let mut input = NavInput::new().with_terrain(flat(FIELD_HALF), NavArea::WALK).expect("terrain");
    let count = (FIELD_HALF * 2.0 / PILLAR_STEP) as i32;
    for i in 1..count {
        for j in 1..count {
            let (x, z) = (-FIELD_HALF + i as f32 * PILLAR_STEP, -FIELD_HALF + j as f32 * PILLAR_STEP);
            input.add_box(block(x, z, Vec3::new(PILLAR_HALF, 1.5, PILLAR_HALF), 0.0), NavArea::NONE).expect("a pillar");
        }
    }
    input
}

/// A market like nav-crowd's on a 128 m terrain: walls with gates, 16 stalls and an upper floor.
/// `nudge` moves one stall (metres) so each repeat is a new input.
fn market(nudge: f32) -> NavInput {
    let terrain = Arc::new(
        HeightGrid::from_fn((129, 129), [-TERRAIN_HALF, -TERRAIN_HALF], 1.0, |x: f32, z: f32| {
            let edge = (x.abs().max(z.abs()) - 40.0).max(0.0) / 24.0;
            5.0 * edge * edge
        })
        .expect("a terrain"),
    );
    let mut input = NavInput::new().with_terrain(terrain, NavArea::WALK).expect("terrain");
    let wall = Vec3::new(WALL_HALF / 2.0 - 1.0, 1.25, 0.25);
    for side in [-1.0f32, 1.0] {
        for half in [-1.0f32, 1.0] {
            let along = half * (WALL_HALF / 2.0 + 1.0);
            input.add_box(block(along, side * WALL_HALF, wall, 0.0), NavArea::NONE).expect("a wall");
            input.add_box(block(side * WALL_HALF, along, Vec3::new(wall.z, wall.y, wall.x), 0.0), NavArea::NONE).expect("a wall");
        }
    }
    for (row, z) in STALL_ROWS.iter().enumerate() {
        for (column, x) in STALL_ROWS.iter().enumerate() {
            let shift = if row + column == 0 { nudge } else { 0.0 };
            input.add_box(block(*x + shift, *z, Vec3::new(1.5, 0.6, 1.0), 0.0), NavArea::NONE).expect("a stall");
        }
    }
    input.add_box(block(0.0, 0.0, Vec3::new(4.0, 1.5, 4.0), 0.0), NavArea::WALK).expect("the upper floor");
    input
}

fn timed_bake(input: &NavInput, config: &NavConfig) -> (f64, NavMesh) {
    let start = Instant::now();
    let mesh = NavMesh::bake(input, config).expect("bakes");
    (ms(start), mesh)
}

/// The agents' spots: a ring of starts and the opposite side of the field as targets.
fn spot(i: usize, far: bool) -> Vec3 {
    let turn = i as f32 / AGENTS as f32 * std::f32::consts::TAU + if far { std::f32::consts::PI } else { 0.0 };
    let radius = FIELD_HALF - 6.0 - (i % 5) as f32 * 3.0;
    Vec3::new(radius * genex::math::cos(turn) + PILLAR_STEP * 0.5, 0.0, radius * genex::math::sin(turn) + PILLAR_STEP * 0.5)
}

fn update_row(mesh: &NavMesh) -> Value {
    let mut nav = Nav::new(&field_config());
    nav.add_mesh(mesh).expect("the mesh goes in");
    let agents: Vec<_> = (0..AGENTS)
        .map(|i| {
            let agent = nav.add_agent(NavAgent::new(spot(i, false)).with_speed(2.4, 3.2)).expect("an agent");
            nav.move_to(agent, spot(i, true));
            agent
        })
        .collect();
    let dt = (FIXED_STEP_MS / 1000.0) as f32;
    let mut samples = Vec::new();
    for tick in 0..WARM_TICKS + MEASURED_TICKS {
        let start = Instant::now();
        nav.update(dt);
        let took = ms(start);
        if tick >= WARM_TICKS {
            samples.push(took);
        }
        for agent in &agents {
            let velocity = nav.desired_velocity(*agent);
            let at = nav.position(*agent).unwrap_or_default();
            nav.set_position(*agent, at + velocity * dt, velocity);
        }
    }
    let moving = agents.iter().filter(|agent| nav.desired_velocity(**agent).length() > 0.1).count();
    let p95 = percentile(&mut samples.clone(), 0.95);
    json!({ "agents": AGENTS, "moving": moving, "p50Ms": rounded(median(&mut samples)), "p95Ms": rounded(p95), "budgetMs": UPDATE_P95_MS, "residentBytes": nav.memory_bytes() })
}

fn search_row(mesh: &NavMesh) -> (Value, f64) {
    let mut nav = Nav::new(&field_config());
    nav.add_mesh(mesh).expect("the mesh goes in");
    // Queries answer from the mesh as of the last update.
    nav.update((FIXED_STEP_MS / 1000.0) as f32);
    let (from, to) = (Vec3::new(-FIELD_HALF + 2.0, 0.0, -FIELD_HALF + 2.0), Vec3::new(FIELD_HALF - 2.0, 0.0, FIELD_HALF - 2.0));
    let filter = NavFilter::new();
    let path = nav.path(from, to, &filter).expect("a path corner to corner");
    let mut samples: Vec<f64> = (0..SEARCH_REPEATS)
        .map(|_| {
            let start = Instant::now();
            let found = nav.path(from, to, &filter);
            let took = ms(start);
            assert!(found.is_some());
            took
        })
        .collect();
    let took = median(&mut samples);
    (json!({ "steps": path.steps.len(), "lengthM": rounded(f64::from(path.length)), "partial": path.partial, "medianMs": rounded(took), "budgetMs": SEARCH_MS }), took)
}

fn tile_row(input: &NavInput) -> (Value, f64) {
    let config = walker().with_cells(0.2, 0.1).with_tile(32.0);
    let mut bytes = 0;
    let mut polygons = 0;
    let mut samples: Vec<f64> = (0..BAKE_REPEATS)
        .map(|_| {
            let start = Instant::now();
            let tile = NavMesh::bake_tile(input, &config, CellId::new(0, 0)).expect("a tile");
            let took = ms(start);
            (bytes, polygons) = (tile.memory_bytes(), tile.polygon_count());
            took
        })
        .collect();
    let took = median(&mut samples);
    (json!({ "tileM": 32, "cellM": 0.2, "polygons": polygons, "bytes": bytes, "medianMs": rounded(took), "budgetMs": TILE_BAKE_MS }), took)
}

fn reset_rows() -> (Value, f64) {
    let config = walker().with_tile(16.0);
    let mut tiles = Vec::new();
    let mut samples: Vec<f64> = (0..BAKE_REPEATS)
        .map(|repeat| {
            let (took, mesh) = timed_bake(&market(repeat as f32 * 0.001), &config);
            tiles = mesh.tiles().iter().map(|tile| tile.memory_bytes()).collect();
            took
        })
        .collect();
    let took = median(&mut samples);
    let mut resets: Vec<f64> = (0..RESET_REPEATS)
        .map(|seed| {
            // The reset (and its bake) runs when the started runtime is seeded, as the crowd row does.
            let mut runtime = Runtime::new(game()).expect("installs");
            let start = Instant::now();
            assert!(runtime.start());
            runtime.seed(seed as u32 + 1);
            runtime.step(FIXED_STEP_MS);
            ms(start)
        })
        .collect();
    let mut sorted = tiles.clone();
    sorted.sort_unstable();
    let typical = sorted.get(sorted.len() / 2).copied().unwrap_or(0);
    let row = json!({
        "bakeMedianMs": rounded(took),
        "budgetMs": RESET_BAKE_MS,
        "tiles": tiles.len(),
        "tileBytesTypical": typical,
        "tileBytesMax": sorted.last().copied().unwrap_or(0),
        "tileBytesBudget": TILE_BYTES_TYPICAL,
        "navCrowdResetAndFirstTickMedianMs": rounded(median(&mut resets)),
    });
    (row, took)
}

fn write(var: &str, record: &Value) {
    if let Some(path) = std::env::var_os(var) {
        std::fs::write(path, format!("{record:#}\n")).expect("the record writes");
    }
}

#[test]
#[ignore = "timings: run in release with --ignored perf"]
fn perf_nav_rows_fit_the_budget_table() {
    let (field_ms, field) = timed_bake(&pillar_field(), &field_config());
    let polygons: usize = field.tiles().iter().map(|tile| tile.polygon_count()).sum();
    let update = update_row(&field);
    let (search, search_ms) = search_row(&field);
    let (tile, tile_ms) = tile_row(&pillar_field());
    let (reset, reset_ms) = reset_rows();
    let mut failures = Vec::new();
    let update_p95 = update["p95Ms"].as_f64().unwrap_or(f64::MAX);
    let resident = update["residentBytes"].as_u64().unwrap_or(u64::MAX) as usize;
    let typical = reset["tileBytesTypical"].as_u64().unwrap_or(u64::MAX) as usize;
    for (over, what) in [
        (update_p95 > UPDATE_P95_MS, format!("update p95 {update_p95} ms")),
        (search_ms > SEARCH_MS, format!("search {search_ms:.3} ms")),
        (tile_ms > TILE_BAKE_MS, format!("tile bake {tile_ms:.3} ms")),
        (reset_ms > RESET_BAKE_MS, format!("reset bake {reset_ms:.3} ms")),
        (typical > TILE_BYTES_TYPICAL, format!("typical tile {typical} B")),
        (resident > NAV_RESIDENCY_BYTES, format!("resident {resident} B")),
    ] {
        if over {
            failures.push(what);
        }
    }
    let record = json!({
        "harness": "nav-perf",
        "field": { "polygons": polygons, "tiles": field.tiles().len(), "bakeMs": rounded(field_ms) },
        "update": update,
        "search": search,
        "tile": tile,
        "reset": reset,
        "passed": failures.is_empty(),
        "failures": failures,
    });
    println!("{record:#}");
    write("GENEX_NAV_PERF_OUT", &record);
    assert!((500..=4000).contains(&polygons), "the field is about a thousand polygons ({polygons})");
    assert!(failures.is_empty(), "nav is over its budget table: {failures:?}");
}

/// A cursor over a wasm module's bytes.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Reader<'_> {
    fn byte(&mut self) -> u8 {
        let byte = self.bytes[self.at];
        self.at += 1;
        byte
    }

    fn leb(&mut self) -> u64 {
        let (mut value, mut shift) = (0u64, 0);
        loop {
            let byte = self.byte();
            value |= u64::from(byte & 0x7f) << shift;
            if byte & 0x80 == 0 {
                return value;
            }
            shift += 7;
        }
    }

    fn name(&mut self) -> String {
        let length = self.leb() as usize;
        let text = String::from_utf8_lossy(&self.bytes[self.at..self.at + length]).into_owned();
        self.at += length;
        text
    }

    fn limits(&mut self) {
        let flags = self.byte();
        self.leb();
        if flags & 1 == 1 {
            self.leb();
        }
    }
}

/// Imported functions (they come first in the function index space).
fn imported_functions(section: &[u8]) -> u64 {
    let mut reader = Reader { bytes: section, at: 0 };
    let mut functions = 0;
    for _ in 0..reader.leb() {
        reader.name();
        reader.name();
        match reader.byte() {
            0 => {
                reader.leb();
                functions += 1;
            }
            1 => {
                reader.byte();
                reader.limits();
            }
            2 => reader.limits(),
            3 => {
                reader.byte();
                reader.byte();
            }
            _ => {
                reader.byte();
                reader.leb();
            }
        }
    }
    functions
}

/// Every function body's size, by function index.
fn bodies(section: &[u8], first: u64) -> Vec<(u64, u64)> {
    let mut reader = Reader { bytes: section, at: 0 };
    (0..reader.leb())
        .map(|i| {
            let size = reader.leb();
            reader.at += size as usize;
            (first + i, size)
        })
        .collect()
}

/// The function names of the `name` section, by function index.
fn function_names(section: &[u8]) -> std::collections::BTreeMap<u64, String> {
    let mut reader = Reader { bytes: section, at: 0 };
    let mut names = std::collections::BTreeMap::new();
    while reader.at < section.len() {
        let id = reader.byte();
        let size = reader.leb() as usize;
        let end = reader.at + size;
        if id == 1 {
            for _ in 0..reader.leb() {
                let index = reader.leb();
                names.insert(index, reader.name());
            }
        }
        reader.at = end;
    }
    names
}

/// A module's code: (all function body bytes, genex-nav's body bytes, genex-nav's functions,
/// named functions).
fn nav_code(path: &std::path::Path) -> (u64, u64, usize, usize) {
    let bytes = std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert_eq!(&bytes[..4], b"\0asm", "{} is a wasm module", path.display());
    let mut reader = Reader { bytes: &bytes, at: 8 };
    let (mut imported, mut code, mut names) = (0, Vec::new(), Default::default());
    while reader.at < bytes.len() {
        let id = reader.byte();
        let size = reader.leb() as usize;
        let (start, end) = (reader.at, reader.at + size);
        match id {
            2 => imported = imported_functions(&bytes[start..end]),
            10 => code = bodies(&bytes[start..end], imported),
            0 => {
                let mut custom = Reader { bytes: &bytes[start..end], at: 0 };
                if custom.name() == "name" {
                    names = function_names(&bytes[start + custom.at..end]);
                }
            }
            _ => {}
        }
        reader.at = end;
    }
    assert!(!names.is_empty(), "{} keeps its name section", path.display());
    let total = code.iter().map(|(_, size)| size).sum();
    let nav: Vec<u64> = code.iter().filter(|(index, _)| names.get(index).is_some_and(|name| name.contains("genex_nav"))).map(|(_, size)| *size).collect();
    (total, nav.iter().sum(), nav.len(), names.len())
}

#[test]
#[ignore = "needs wasm32 builds: run nav/web-size.sh (--ignored wasm_size)"]
fn wasm_size_a_nav_free_game_links_no_nav_code() {
    let (Some(free), Some(used)) = (std::env::var_os("GENEX_NAV_FREE_WASM"), std::env::var_os("GENEX_NAV_WASM")) else {
        return eprintln!("skipped: GENEX_NAV_FREE_WASM and GENEX_NAV_WASM name the modules");
    };
    let (free_total, free_nav, free_functions, free_named) = nav_code(std::path::Path::new(&free));
    let (used_total, used_nav, used_functions, used_named) = nav_code(std::path::Path::new(&used));
    let record = json!({
        "harness": "nav-web-size",
        "navFree": { "module": free.to_string_lossy(), "codeBytes": free_total, "navCodeBytes": free_nav, "navFunctions": free_functions, "namedFunctions": free_named },
        "navUsed": { "module": used.to_string_lossy(), "codeBytes": used_total, "navCodeBytes": used_nav, "navFunctions": used_functions, "namedFunctions": used_named, "budgetBytes": NAV_WEB_BYTES_MAX },
    });
    println!("{record:#}");
    write("GENEX_NAV_SIZE_OUT", &record);
    assert!(used_nav > 0, "nav-crowd links genex-nav code");
    assert!(used_nav <= NAV_WEB_BYTES_MAX, "nav-crowd links {used_nav} B of nav code");
    assert_eq!(free_nav, 0, "a game that never calls nav links {free_nav} B of genex-nav code in {free_functions} functions");
}
