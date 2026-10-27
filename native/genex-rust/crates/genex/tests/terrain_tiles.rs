//! Streamed terrain tiles (game systems STR-23): `TerrainTiles` one per cell, procedural or
//! authored by the import (`terrain/terrain.json` and `terrain/<x>_<z>.r16`), its ground read by
//! `sim.stream.ground` and its colliders streamed through the collider slot (STR-10).
//!
//! The rows: authored ground is `None` outside the sim-active cells and bit-equal to the tile's
//! `Terrain::height` inside (and to a plain `Terrain` of the same heights); neighbours share their
//! border samples bit for bit; tile colliders enter and leave in canonical order, the same handles
//! whatever order the builds finish in; a hostile tile or index is refused
//! `terrain-heights-invalid` with nothing made (an oversized file is never read); and a ball
//! walking a tile border for 1000 ticks never falls through. Every row is new behaviour.

use std::cell::Cell as Counter;

use genex::prelude::*;
use genex::{CellId, FIXED_STEP_MS, Runtime, Streaming, TERRAIN_TILE_BYTES_MAX, Terrain, TerrainErrorCode, TerrainTiles};
use genex_core::digest::{fnv1a64, hex64};
use serde_json::json;

/// The fixture's cell side and tile samples.
const CELL: f32 = 32.0;
const SAMPLES: u32 = 65;
/// The authored range.
const MIN: f32 = -2.0;
const MAX: f32 = 6.0;

/// The authored height at world (x, z): gentle hills inside the range.
fn hills(x: f32, z: f32) -> f32 {
    2.0 + 3.0 * genex::math::sin(x * 0.11) * genex::math::cos(z * 0.07)
}

/// World metres of sample `i` of cell `c` (the import's rule).
fn metres(c: i32, i: u32) -> f32 {
    let quads = (SAMPLES - 1) as f32;
    ((c as f32) * quads + i as f32) * CELL / quads
}

/// One `.r16` tile of `cell` as the import writes it; tile (0, 0) holds the range's ends at two
/// corners, so its own span is the world's.
fn r16(cell: CellId) -> Vec<u8> {
    let mut out = Vec::with_capacity((SAMPLES * SAMPLES * 2) as usize);
    for row in 0..SAMPLES {
        for column in 0..SAMPLES {
            let h = hills(metres(cell.x, column), metres(cell.z, row));
            let mut value = (((h - MIN) / (MAX - MIN)) * 65_535.0).round().clamp(0.0, 65_535.0) as u16;
            let corner = cell == CellId::new(0, 0);
            if corner && (row, column) == (0, 0) {
                value = 0;
            }
            if corner && (row, column) == (SAMPLES - 1, SAMPLES - 2) {
                value = u16::MAX;
            }
            out.extend(value.to_le_bytes());
        }
    }
    out
}

/// The authored cells.
fn cells() -> [CellId; 2] {
    [CellId::new(0, 0), CellId::new(1, 0)]
}

fn index_of(tiles: &[(CellId, Vec<u8>)]) -> serde_json::Value {
    let listed: Vec<serde_json::Value> = tiles.iter().map(|(cell, bytes)| json!({"x": cell.x, "z": cell.z, "fnv": hex64(fnv1a64(bytes))})).collect();
    json!({"format": "genex-terrain-tiles", "version": 1, "cellSize": CELL, "samples": SAMPLES, "min": MIN, "max": MAX, "tiles": listed})
}

/// Tile files by cell.
type Files = Vec<(CellId, Vec<u8>)>;

fn tile_files() -> Files {
    cells().iter().map(|cell| (*cell, r16(*cell))).collect()
}

/// Authored tiles from `index` and `files`, counting the reads.
fn authored(index: &serde_json::Value, files: &[(CellId, Vec<u8>)], reads: &Counter<u32>) -> Result<TerrainTiles, genex::TerrainError> {
    let find = |cell: CellId| files.iter().find(|(at, _)| *at == cell).map(|(_, bytes)| bytes.clone());
    let size = |cell: CellId| find(cell).map(|bytes| bytes.len() as u64);
    let read = |cell: CellId| {
        reads.set(reads.get() + 1);
        find(cell)
    };
    TerrainTiles::authored(&serde_json::to_vec(index).expect("json"), size, read)
}

fn fixture_tiles() -> TerrainTiles {
    authored(&index_of(&tile_files()), &tile_files(), &Counter::new(0)).expect("the fixture's tiles")
}

#[derive(Default)]
struct World {
    #[cfg(feature = "physics-raw")]
    ball: Option<genex::physics::RigidBodyHandle>,
    #[cfg(feature = "physics-raw")]
    lowest: f32,
}

/// A game streaming `tiles` on a 32 m grid around the anchor "player" at `at` (sim radius
/// `radius`, no hysteresis).
fn streaming_game(tiles: TerrainTiles, radius: u32, at: Vec3) -> Game<World> {
    let mut game = Game::new(World::default());
    game.streaming(Streaming::grid(CELL).sim_radius(radius).hysteresis(0).prefetch(0).terrain(tiles));
    game.on_reset(move |sim, _, _, _| sim.stream.set_anchor("player", at).expect("anchor"));
    game
}

fn step(runtime: &mut Runtime<World>, ticks: u32) {
    runtime.step(f64::from(ticks) * FIXED_STEP_MS);
}

#[test]
fn authored_ground_is_none_outside_sim_active_cells_and_bit_equal_to_terrain_height_inside() {
    let tiles = fixture_tiles();
    let mut runtime = Runtime::new(streaming_game(tiles.clone(), 0, vec3(16.0, 0.0, 16.0))).expect("installs");
    runtime.seed(1);
    step(&mut runtime, 2);
    let active: Vec<CellId> = runtime.sim().stream.active().collect();
    assert_eq!(active, vec![CellId::new(0, 0)]);

    let tile = tiles.tile(CellId::new(0, 0), CELL).expect("tile (0, 0)");
    // A plain terrain of the same heights: tile (0, 0) spans the whole range, so its quantization
    // is the tiles' own.
    let heights: Vec<f32> = r16(CellId::new(0, 0)).chunks(2).map(|b| MIN + f32::from(u16::from_le_bytes([b[0], b[1]])) / 65_535.0 * (MAX - MIN)).collect();
    let plain = Terrain::from_heights([SAMPLES, SAMPLES], Vec2::ZERO, CELL / (SAMPLES - 1) as f32, &heights).expect("a plain terrain");
    let stream = &runtime.sim().stream;
    for (x, z) in [(0.0, 0.0), (10.3, 20.7), (31.99, 5.5), (16.0, 31.9), (0.25, 0.75)] {
        let ground = stream.ground(x, z).expect("inside a sim-active cell");
        assert_eq!(ground.to_bits(), tile.height(x, z).to_bits(), "({x}, {z}): the tile's Terrain::height");
        assert_eq!(ground.to_bits(), plain.height(x, z).to_bits(), "({x}, {z}): a plain Terrain of the same heights");
    }
    assert_eq!(stream.ground(40.0, 10.0), None, "an authored tile outside the sim-active cells");
    assert_eq!(stream.ground(-10.0, 5.0), None, "no tile there");
    assert_eq!(stream.ground(f32::NAN, 5.0), None);

    // The anchor moves on: the next commit swaps the active cell, and the ground follows.
    runtime.sim_mut().stream.set_anchor("player", vec3(48.0, 0.0, 16.0)).expect("anchor");
    step(&mut runtime, 1);
    let stream = &runtime.sim().stream;
    assert_eq!(stream.ground(10.3, 20.7), None, "(0, 0) left the sim set");
    let next = tiles.tile(CellId::new(1, 0), CELL).expect("tile (1, 0)");
    assert_eq!(stream.ground(40.0, 10.0).map(f32::to_bits), Some(next.height(40.0, 10.0).to_bits()));
}

#[test]
fn neighbours_share_their_border_samples_bit_for_bit_and_procedural_ground_answers_anywhere() {
    let tiles = fixture_tiles();
    let (left, right) = (tiles.tile_heights(CellId::new(0, 0), CELL).expect("left"), tiles.tile_heights(CellId::new(1, 0), CELL).expect("right"));
    for row in 0..SAMPLES {
        assert_eq!(left.sample(SAMPLES - 1, row).to_bits(), right.sample(0, row).to_bits(), "border row {row}");
    }
    assert_eq!(tiles.tile_heights(CellId::new(0, 0), 64.0), None, "authored tiles fit only their own cell size");

    let procedural = TerrainTiles::procedural(SAMPLES, hills).expect("procedural").with_height_range(MIN, MAX).expect("range");
    let (a, b) = (procedural.tile_heights(CellId::new(3, -2), CELL).expect("a"), procedural.tile_heights(CellId::new(4, -2), CELL).expect("b"));
    for row in 0..SAMPLES {
        assert_eq!(a.sample(SAMPLES - 1, row).to_bits(), b.sample(0, row).to_bits(), "procedural border row {row}");
    }
    // Procedural ground needs no active cell, and is the tile's height.
    let runtime = Runtime::new(streaming_game(procedural.clone(), 0, vec3(16.0, 0.0, 16.0))).expect("installs");
    let ground = runtime.sim().stream.ground(100.5, -50.25).expect("procedural ground anywhere");
    let tile = procedural.tile(CellId::new(3, -2), CELL).expect("tile");
    assert_eq!(ground.to_bits(), tile.height(100.5, -50.25).to_bits());
}

#[test]
fn a_hostile_tile_or_index_is_refused_terrain_heights_invalid_with_nothing_made() {
    let files = tile_files();
    let good = index_of(&files);
    let with = |key: &str, value: serde_json::Value| {
        let mut index = good.clone();
        index[key] = value;
        index
    };
    let short: Files = files.iter().map(|(cell, bytes)| (*cell, bytes[..bytes.len() - 2].to_vec())).collect();
    let mut flipped = files.clone();
    flipped[1].1[10] ^= 1;
    let duplicate = with("tiles", json!([good["tiles"][0], good["tiles"][0]]));
    let cases: Vec<(&str, serde_json::Value, Files)> = vec![
        ("a tile short of its samples", index_of(&short), short.clone()),
        ("a NaN-like height range", with("min", json!(1e39)), files.clone()),
        ("a range out of order", with("min", json!(10.0)), files.clone()),
        ("a sample count not a tile size", with("samples", json!(100)), files.clone()),
        ("another format", with("format", json!("heights")), files.clone()),
        ("another version", with("version", json!(2)), files.clone()),
        ("a cell size under the stream minimum", with("cellSize", json!(3.0)), files.clone()),
        ("a tile listed twice", duplicate, files.clone()),
        ("a missing tile", good.clone(), files[..1].to_vec()),
        ("bytes not matching the digest", good.clone(), flipped),
        ("not JSON", json!("terrain"), files.clone()),
    ];
    for (name, index, tiles) in cases {
        let error = authored(&index, &tiles, &Counter::new(0)).expect_err(name);
        assert_eq!(error.code, TerrainErrorCode::HeightsInvalid, "{name}: {error}");
        assert_eq!(error.code.wire(), "terrain-heights-invalid");
    }

    // An oversized file is refused from its size alone: it is never read.
    let reads = Counter::new(0);
    let size = |_: CellId| Some(TERRAIN_TILE_BYTES_MAX + 1);
    let read = |_: CellId| {
        reads.set(reads.get() + 1);
        Some(Vec::new())
    };
    let error = TerrainTiles::authored(&serde_json::to_vec(&good).expect("json"), size, read).expect_err("oversized");
    assert_eq!(error.code, TerrainErrorCode::HeightsInvalid, "{error}");
    assert_eq!(reads.get(), 0, "nothing read");
    let huge = vec![b' '; (genex::TERRAIN_INDEX_BYTES_MAX + 1) as usize];
    assert!(TerrainTiles::authored(&huge, |_| None, |_| None).is_err(), "an oversized index");

    assert_eq!(TerrainTiles::procedural(100, hills).expect_err("samples").code, TerrainErrorCode::HeightsInvalid);
    let procedural = TerrainTiles::procedural(SAMPLES, hills).expect("procedural");
    assert!(procedural.with_height_range(f32::NAN, 1.0).is_err());
    assert!(fixture_tiles().with_height_range(0.0, 1.0).is_err(), "authored tiles keep the import's range");
}

#[cfg(feature = "physics-raw")]
mod physics {
    use std::sync::Arc;

    use super::*;
    use genex::physics::{ColliderBuilder, RigidBodyBuilder, Vector};
    use genex::{StreamColliders, TerrainTiles};
    use genex_render::jobs::Pool;

    /// Cells the anchor walks out along x and back.
    const WALK_CELLS: u32 = 6;
    const TICKS_PER_CELL: u32 = 3;
    /// The acceptance walk.
    const BORDER_TICKS: u32 = 1000;
    /// How far below the ground a ball's bottom may dip (the collider is the samples' triangles,
    /// the ground bilinear between them) before it counts as falling through.
    const THROUGH_METRES: f32 = 0.1;
    const BALL_RADIUS: f32 = 0.4;

    fn procedural() -> TerrainTiles {
        TerrainTiles::procedural(SAMPLES, hills).expect("procedural").with_height_range(MIN, MAX).expect("range")
    }

    fn anchor_x(tick: u64) -> f32 {
        let walk = u64::from(WALK_CELLS * TICKS_PER_CELL);
        let at = if tick <= walk { tick } else { (2 * walk).saturating_sub(tick) };
        (at / u64::from(TICKS_PER_CELL)) as f32 * CELL + 16.0
    }

    fn walking_game(tiles: TerrainTiles) -> Game<World> {
        let mut game = Game::new(World::default());
        game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1).terrain(tiles.clone()));
        game.cell_content(tiles.colliders_content(CELL));
        game.stream_colliders();
        game.on_reset(|sim, _, _, _| sim.stream.set_anchor("player", vec3(anchor_x(0), 0.0, 16.0)).expect("anchor"));
        game.on_update(|sim, ctx| sim.stream.set_anchor("player", vec3(anchor_x(ctx.tick + 1), 0.0, 16.0)).expect("anchor"));
        game.probe("streamed", |sim| json!(hex64(sim.facets.get::<StreamColliders>().digest(&sim.physics))));
        game
    }

    fn walk(pool: Pool) -> (Vec<String>, Runtime<World>) {
        let mut runtime = Runtime::new(walking_game(procedural())).expect("installs");
        runtime.use_stream_pool(Arc::new(pool));
        runtime.seed(1);
        let mut digests = Vec::new();
        for _ in 0..(2 * WALK_CELLS * TICKS_PER_CELL + 3) {
            step(&mut runtime, 1);
            let ledger = runtime.sim().facets.get::<StreamColliders>();
            let active: Vec<CellId> = runtime.sim().stream.active().collect();
            assert_eq!(ledger.cells().collect::<Vec<_>>(), active, "one tile's colliders per sim-active cell");
            assert!(active.iter().all(|cell| ledger.handles(*cell).len() == 1), "one heightfield a tile");
            digests.push(runtime.probes()["streamed"].as_str().expect("digest").to_owned());
        }
        (digests, runtime)
    }

    #[test]
    fn tile_colliders_enter_and_leave_in_canonical_order_whatever_order_builds_finish() {
        let (inline, _) = walk(Pool::new(0));
        let (threaded, runtime) = walk(Pool::new(4));
        assert_eq!(inline, threaded, "the same handles and shapes on every tick, built inline or on 4 workers");
        let mut again = Runtime::new(walking_game(procedural())).expect("installs");
        again.use_stream_pool(Arc::new(Pool::new(2)));
        again.seed(2);
        again.seed(1);
        step(&mut again, 2 * WALK_CELLS * TICKS_PER_CELL + 3);
        assert_eq!(again.checksum(), runtime.checksum(), "seed(2) then seed(1) rebuilds the same colliders");
        assert_eq!(again.probes()["streamed"], runtime.probes()["streamed"]);

        // A tile's collider spans its cell and the tiles' range, placed in world space.
        let tiles = procedural();
        let collider = tiles.collider(CellId::new(2, 1), CELL).expect("a collider");
        let bounds = collider.compute_aabb();
        assert_eq!([bounds.mins.x, bounds.mins.z, bounds.maxs.x, bounds.maxs.z], [64.0, 32.0, 96.0, 64.0]);
        assert!(bounds.mins.y >= MIN && bounds.maxs.y <= MAX, "{bounds:?}");
        assert!(tiles.with_colliders(false).collider(CellId::new(2, 1), CELL).is_none(), "colliders off");
    }

    #[test]
    fn a_ball_walking_a_tile_border_for_1000_ticks_never_falls_through() {
        let tiles = procedural();
        let mut game = Game::new(World::default());
        game.streaming(Streaming::grid(CELL).sim_radius(1).hysteresis(1).prefetch(1).terrain(tiles.clone()));
        game.cell_content(tiles.colliders_content(CELL));
        game.stream_colliders();
        game.on_reset(|sim, _, _, _| {
            sim.stream.set_anchor("player", vec3(CELL, 0.0, 4.0)).expect("anchor");
            let ground = sim.stream.ground(CELL, 4.0).expect("procedural ground");
            let ball = RigidBodyBuilder::dynamic().translation(Vector::new(CELL, ground + BALL_RADIUS + 0.05, 4.0));
            let (body, _) = sim.physics.insert(ball, ColliderBuilder::ball(BALL_RADIUS));
            sim.world.ball = Some(body);
            sim.world.lowest = f32::INFINITY;
        });
        game.on_update(|sim, ctx| {
            let Some(handle) = sim.world.ball else { return };
            let at = sim.physics.bodies[handle].translation();
            // Walk along the border x = 32 at 3 m/s, turning back every 20 m.
            let forward = if (ctx.tick / 400).is_multiple_of(2) { 3.0 } else { -3.0 };
            if let Some(body) = sim.physics.bodies.get_mut(handle) {
                let fall = body.linvel().y;
                body.set_linvel(Vector::new((CELL - at.x) * 4.0, fall, forward), true);
            }
            sim.stream.set_anchor("player", vec3(at.x, 0.0, at.z)).expect("anchor");
            if let Some(ground) = sim.stream.ground(at.x, at.z) {
                sim.world.lowest = sim.world.lowest.min(at.y - BALL_RADIUS - ground);
            }
        });
        let mut runtime = Runtime::new(game).expect("installs");
        runtime.use_stream_pool(Arc::new(Pool::new(0)));
        runtime.seed(1);
        step(&mut runtime, BORDER_TICKS);
        let world = &runtime.sim().world;
        let at = runtime.sim().physics.bodies[world.ball.expect("ball")].translation();
        eprintln!("str23 border walk: lowest bottom-to-ground {:.4} m, ball at ({:.2}, {:.2}, {:.2})", world.lowest, at.x, at.y, at.z);
        assert!(world.lowest > -THROUGH_METRES, "the ball dipped {} m below the ground", -world.lowest);
        assert!((at.x - CELL).abs() < 1.0, "it stayed on the border: x {}", at.x);
        let ground = runtime.sim().stream.ground(at.x, at.z).expect("ground");
        assert!(at.y - BALL_RADIUS > ground - THROUGH_METRES, "it ends on the ground, not under it");
    }
}
