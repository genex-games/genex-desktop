//! NAV-11: the nav world, its config, `.navmesh` bytes, the bake memo and refusals (new
//! behaviour: `world.rs`, `config.rs` and `memo.rs` were stubs).
//!
//! - A refusal table, one row per code the world refuses with, each asserting nothing changed
//!   (tile count and digest).
//! - Baking the same input twice in one process hits the memo with an equal digest.
//! - Old bytes for a changed input bake afresh and say so (`nav-bake-stale`); bytes for the same
//!   input are taken as they are.
//! - The memo is an LRU by bytes under its cap.
//! - Tile ids are `CellId`s on the nav tile grid anchored at the origin.
//! - Carving runs through `Nav::update` by the budget's stage units.

use std::sync::Arc;

use genex_core::cell::CellId;
use genex_nav::bake::{BakeConfig, covering_cells};
use genex_nav::carve::{NAV_REBUILD_STAGES, NavObstacle};
use genex_nav::config::NavConfig;
use genex_nav::error::NavErrorCode;
use genex_nav::filter::NavFilter;
use genex_nav::input::{HeightGrid, NavArea, NavInput};
use genex_nav::memo::{BakeMemo, MemoKey, tiles_bytes};
use genex_nav::runtime::coords::{FromAgentRadius, PointSampleDistance3d};
use genex_nav::tile::{NavTile, TileMesh};
use genex_nav::world::{NAV_TILES_MAX, Nav, NavBudget, NavMesh, NavMeshSource};
use glam::{Mat4, Quat, Vec2, Vec3};

const DT: f32 = 1.0 / 60.0;

fn config() -> NavConfig {
    NavConfig::walker(0.4, 1.8).with_tile(8.0)
}

/// A gentle 16 × 16 m slope with a crate on it, `lift` metres up (each test lifts its own, so
/// memo rows in parallel tests never share an input).
fn ground(lift: f32) -> NavInput {
    let terrain = HeightGrid::from_fn((33, 33), [0.0, 0.0], 0.5, move |x, z| lift + 0.02 * x + 0.01 * z).expect("terrain");
    NavInput::new()
        .with_terrain(Arc::new(terrain), NavArea::WALK)
        .expect("terrain input")
        .with_box(Mat4::from_scale_rotation_translation(Vec3::splat(1.2), Quat::from_rotation_y(0.3), Vec3::new(5.0, lift + 0.6, 11.0)), NavArea::WALK)
        .expect("a crate")
}

/// A corridor 24 m long and 3 m wide, `lift` metres up.
fn corridor(lift: f32) -> NavInput {
    let v = |x: f32, z: f32| Vec3::new(x, lift, z);
    let vertices = [v(0.0, 0.0), v(24.0, 0.0), v(24.0, 3.0), v(0.0, 3.0)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the corridor")
}

fn nav_with(mesh: &NavMesh) -> Nav {
    let mut nav = Nav::new(&config());
    nav.add_mesh(mesh).expect("the mesh");
    nav.update(DT);
    nav
}

fn unchanged(nav: &Nav, before: (usize, u64), row: &str) {
    assert_eq!((nav.tile_count(), nav.digest()), before, "{row}: nothing changed");
}

#[test]
fn every_world_refusal_leaves_the_nav_unchanged() {
    let mesh = NavMesh::bake(&ground(0.0), &config()).expect("a mesh");
    let mut nav = nav_with(&mesh);
    let before = (nav.tile_count(), nav.digest());
    assert_eq!(before.0, 4, "a 16 m square over 8 m tiles");

    // nav-input-invalid: an obstacle that is not finite.
    let refused = nav.add_obstacle(NavObstacle::Avoid { position: Vec3::NAN, radius: 1.0 }).expect_err("refused");
    assert_eq!(refused.code, NavErrorCode::InputInvalid);
    unchanged(&nav, before, "input");
    assert_eq!((nav.obstacles().count(), nav.pending_rebuilds()), (0, 0));

    // nav-config-invalid: a mesh and a tile baked for another walker.
    let other = NavConfig::walker(0.3, 1.8).with_tile(8.0);
    let foreign = NavMesh::bake(&ground(0.0), &other).expect("a mesh for another walker");
    assert_eq!(nav.add_mesh(&foreign).expect_err("refused").code, NavErrorCode::ConfigInvalid);
    assert_eq!(nav.add_tile(&foreign.tiles()[0]).expect_err("refused").code, NavErrorCode::ConfigInvalid);
    unchanged(&nav, before, "config");
    let broken = NavConfig::walker(0.4, 1.8).with_tile(7.9);
    assert_eq!(NavMesh::bake(&ground(0.0), &broken).expect_err("refused").code, NavErrorCode::ConfigInvalid);
    let mut unusable = Nav::new(&broken);
    assert_eq!(unusable.add_mesh(&mesh).expect_err("refused").code, NavErrorCode::ConfigInvalid);
    assert_eq!(unusable.add_obstacle(NavObstacle::Avoid { position: Vec3::ZERO, radius: 1.0 }).expect_err("refused").code, NavErrorCode::ConfigInvalid);

    // nav-tile-invalid: `.navmesh` bytes with a flipped bit never reach the nav.
    let mut bytes = mesh.to_bytes();
    bytes[40] ^= 1;
    assert_eq!(NavMesh::from_bytes(&bytes).expect_err("refused").code, NavErrorCode::TileInvalid);
    unchanged(&nav, before, "tile");

    // nav-too-large: past NAV_TILES_MAX resident tiles (empty tiles far away fill the nav).
    let mut full = Nav::new(&config());
    for k in 0..NAV_TILES_MAX as i32 {
        let empty = NavTile::new(CellId::new(1000 + k % 64, 1000 + k / 64), config().digest(), 0, TileMesh::default()).expect("an empty tile");
        full.add_tile(&empty).expect("under the cap");
    }
    let full_before = (full.tile_count(), full.digest());
    assert_eq!(full.add_mesh(&mesh).expect_err("refused").code, NavErrorCode::TooLarge);
    assert_eq!(full.add_tile(&mesh.tiles()[0]).expect_err("refused").code, NavErrorCode::TooLarge);
    unchanged(&full, full_before, "too large");
    let huge = NavInput::new().with_bounds(Vec3::splat(-1.0e6), Vec3::splat(1.0e6)).expect("bounds").with_triangles(&[Vec3::ZERO, Vec3::X, Vec3::Z], &[0, 2, 1], NavArea::WALK).expect("a triangle");
    assert_eq!(NavMesh::bake(&huge, &config()).expect_err("refused before baking").code, NavErrorCode::TooLarge);

    // nav-cost-invalid: zero, negative, NaN and infinite costs, and the null area.
    for (area, cost) in [(NavArea::WALK, 0.0), (NavArea::WALK, -1.0), (NavArea::ROAD, f32::NAN), (NavArea::GRASS, f32::INFINITY), (NavArea::NONE, 1.0)] {
        assert_eq!(nav.set_area_cost(area, cost).expect_err("refused").code, NavErrorCode::CostInvalid, "{cost} for {}", area.raw());
        assert_eq!(nav.area_cost(area), 1.0, "the cost stays");
    }
    unchanged(&nav, before, "cost");
    nav.set_area_cost(NavArea::ROAD, 0.8).expect("a usable cost");
    assert_eq!(nav.area_cost(NavArea::ROAD), 0.8);
    assert_eq!(NavErrorCode::CostInvalid.wire(), "nav-cost-invalid");
}

#[test]
fn baking_the_same_input_twice_hits_the_memo_with_an_equal_digest() {
    let input = ground(3.25);
    let first = NavMesh::bake(&input, &config()).expect("a mesh");
    assert_eq!(first.source(), NavMeshSource::Baked);
    let rebuilt = ground(3.25);
    assert_eq!(rebuilt.digest(), input.digest(), "an input built again has the same digest");
    let second = NavMesh::bake(&rebuilt, &config()).expect("a mesh");
    assert_eq!(second.source(), NavMeshSource::Memo);
    assert_eq!(second.digest(), first.digest());
    assert_eq!(second, first);
    // Another config is another key.
    let wider = NavMesh::bake(&input, &config().with_climb(0.3)).expect("a mesh");
    assert_eq!(wider.source(), NavMeshSource::Baked);
}

#[test]
fn old_bytes_for_a_changed_input_bake_afresh_and_report_it() {
    let (old, new) = (corridor(1.5), corridor(1.75));
    assert_ne!(old.digest(), new.digest());
    let bytes = NavMesh::bake(&old, &config()).expect("a mesh").to_bytes();

    let same = NavMesh::from_bytes_for(&old, &config(), &bytes).expect("the bytes");
    assert_eq!(same.source(), NavMeshSource::Bytes);
    assert_eq!(same.source().volatile_code(), None);
    assert_eq!(same.digest(), NavMesh::bake(&old, &config()).expect("a mesh").digest());
    assert!(same.input().is_some(), "bytes read for an input keep it, so the nav can carve");

    let stale = NavMesh::from_bytes_for(&new, &config(), &bytes).expect("a fresh bake");
    assert_eq!(stale.source(), NavMeshSource::Rebaked);
    assert_eq!(stale.source().volatile_code(), Some("nav-bake-stale"));
    assert_eq!(stale.digest(), NavMesh::bake(&new, &config()).expect("a mesh").digest());
    assert_eq!(stale.input_digest(), new.digest());

    let other_walker = NavMesh::from_bytes_for(&old, &config().with_slope(30.0), &bytes).expect("a fresh bake");
    assert_eq!(other_walker.source(), NavMeshSource::Rebaked, "another config is stale too");

    let alone = NavMesh::from_bytes(&bytes).expect("the bytes");
    assert_eq!(alone.digest(), same.digest());
    assert!(alone.input().is_none());
    assert_eq!(NavMesh::from_bytes(&alone.to_bytes()).expect("round trip").to_bytes(), bytes, "bytes round-trip exactly");
}

fn redigest(mut bytes: Vec<u8>) -> Vec<u8> {
    let body = bytes.len() - 8;
    let digest = genex_core::digest::fnv1a64(&bytes[..body]);
    bytes[body..].copy_from_slice(&digest.to_le_bytes());
    bytes
}

#[test]
fn hostile_navmesh_bytes_are_refused_tile_invalid() {
    let mesh = NavMesh::bake(&corridor(0.0), &config()).expect("a mesh");
    let bytes = mesh.to_bytes();
    let first_length = u32::from_le_bytes(bytes[28..32].try_into().expect("four bytes")) as usize;
    let mut cases: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("short", bytes[..20].to_vec()),
        ("truncated", bytes[..bytes.len() - 1].to_vec()),
        ("magic", redigest([b"XXNM".as_slice(), &bytes[4..]].concat())),
        ("version", redigest([&bytes[..4], &2u16.to_le_bytes(), &bytes[6..]].concat())),
        ("digest", {
            let mut b = bytes.clone();
            b[30] ^= 0x10;
            b
        }),
        ("count over the cap", redigest([&bytes[..24], &(NAV_TILES_MAX as u32 + 1).to_le_bytes(), &bytes[28..]].concat())),
        ("count past the bytes", redigest([&bytes[..24], &u32::MAX.to_le_bytes(), &bytes[28..]].concat())),
        ("count one more", redigest([&bytes[..24], &(mesh.tiles().len() as u32 + 1).to_le_bytes(), &bytes[28..]].concat())),
        ("length past the bytes", redigest([&bytes[..28], &u32::MAX.to_le_bytes(), &bytes[32..]].concat())),
        ("trailing byte", redigest([&bytes[..bytes.len() - 8], &[0u8], &bytes[bytes.len() - 8..]].concat())),
        ("another config", redigest([&bytes[..8], &1u64.to_le_bytes(), &bytes[16..]].concat())),
    ];
    // A tile repeated in place of the second gives two tiles at one cell.
    let first_tile = &bytes[28..32 + first_length];
    let mut repeated = [&bytes[..32 + first_length], first_tile].concat();
    let rest_start = 32 + first_length;
    let second_length = u32::from_le_bytes(bytes[rest_start..rest_start + 4].try_into().expect("four bytes")) as usize;
    repeated.extend_from_slice(&bytes[rest_start + 4 + second_length..]);
    cases.push(("repeated cell", redigest(repeated)));
    for (name, case) in cases {
        let refused = NavMesh::from_bytes(&case).expect_err(name);
        assert_eq!(refused.code, NavErrorCode::TileInvalid, "{name}: {refused}");
    }
    assert!(mesh.tiles().len() >= 2, "the corridor spans tiles");
}

#[test]
fn the_memo_is_an_lru_by_bytes_under_its_cap() {
    let tiles = |lift: f32| -> Arc<[NavTile]> { NavMesh::bake(&corridor(lift), &config()).expect("a mesh").tiles().to_vec().into() };
    let (a, b, c) = (tiles(10.0), tiles(11.0), tiles(12.0));
    let one = tiles_bytes(&a);
    assert!(one > 0 && tiles_bytes(&b) == one && tiles_bytes(&c) == one, "equal corridors weigh the same");
    let mut memo = BakeMemo::new(2 * one + one / 2);
    let key = |n: u64| MemoKey::new(n, config().digest());
    memo.insert(key(1), a.clone());
    memo.insert(key(2), b.clone());
    assert!(memo.get(key(1)).is_some(), "a read moves the first entry to the back");
    memo.insert(key(3), c.clone());
    assert!(memo.contains(key(1)) && memo.contains(key(3)));
    assert!(!memo.contains(key(2)), "the least recently used entry went");
    let stats = memo.stats();
    assert_eq!((stats.entries, stats.evictions, stats.hits), (2, 1, 1));
    assert!(stats.bytes <= stats.cap);
    assert!(memo.get(key(2)).is_none());
    assert_eq!(memo.stats().misses, 1);

    memo.set_cap(one);
    assert_eq!(memo.stats().entries, 1, "a smaller cap evicts down to it");
    assert!(memo.contains(key(3)), "the most recent stays");
    let big: Arc<[NavTile]> = [a.as_ref(), b.as_ref()].concat().into();
    memo.insert(key(4), big);
    assert!(!memo.contains(key(4)), "an entry over the whole cap is never kept");
    assert!(memo.stats().bytes <= memo.stats().cap);
    assert_eq!(genex_nav::memo::NAV_MEMO_BYTES_MAX_PHONE, 8 * 1024 * 1024);
}

#[test]
fn tile_ids_are_cells_on_the_nav_tile_grid() {
    let config = config();
    let mesh = NavMesh::bake(&ground(0.0), &config).expect("a mesh");
    let cells: Vec<CellId> = mesh.tiles().iter().map(NavTile::cell).collect();
    assert_eq!(cells, covering_cells(Vec2::ZERO, Vec2::splat(16.0), config.tile()), "row order over the grid");
    for tile in mesh.tiles() {
        let centre = tile.mesh().vertices.iter().fold(Vec3::ZERO, |sum, v| sum + *v) / tile.mesh().vertices.len() as f32;
        assert_eq!(config.tile_of(centre), tile.cell(), "a tile's corners sit in its own cell");
    }
    assert!(config.divides_stream_cell(32.0) && !config.divides_stream_cell(12.0));
    assert_eq!(config.bake_config(), &BakeConfig { tile: 8.0, ..BakeConfig::walker(0.4, 1.8) });
}

#[test]
fn carving_runs_through_the_world_update_by_the_budget() {
    let input = corridor(0.0);
    let mesh = NavMesh::bake(&input, &config()).expect("a mesh");
    let mut nav = nav_with(&mesh).with_budget(NavBudget { bake_units_per_tick: 3, ..NavBudget::default() });
    let original = nav.digest();
    let reach = PointSampleDistance3d::from_agent_radius(0.4);
    let crosses = |nav: &Nav| {
        let a = nav.archipelago().sample_point(Vec3::new(2.0, 0.0, 1.5), &reach).ok();
        let b = nav.archipelago().sample_point(Vec3::new(22.0, 0.0, 1.5), &reach).ok();
        a.zip(b).and_then(|(a, b)| nav.archipelago().find_path(&a, &b, &NavFilter::new()).ok()).is_some_and(|found| !found.partial)
    };
    assert!(crosses(&nav));
    let crate_box = NavObstacle::CarveBox { transform: Mat4::from_scale_rotation_translation(Vec3::new(1.0, 1.0, 4.0), Quat::IDENTITY, Vec3::new(8.0, 0.5, 1.5)) };
    let id = nav.add_obstacle(crate_box).expect("the crate");
    let tiles = nav.pending_rebuilds() as u32;
    assert_eq!(tiles, 2);
    let mut ticks = 0;
    while nav.pending_rebuilds() > 0 {
        if nav.digest() == original {
            assert!(crosses(&nav), "until a tile is swapped the old tiles stay, with no hole");
        }
        nav.update(DT);
        ticks += 1;
    }
    assert_eq!(ticks, (tiles * NAV_REBUILD_STAGES).div_ceil(3));
    assert!(!crosses(&nav), "the crate blocks the corridor");
    assert_eq!(nav.rebuilds_refused(), 0);

    assert!(!nav.move_obstacle(id, NavObstacle::Avoid { position: Vec3::ZERO, radius: f32::NAN }), "a refused move changes nothing");
    assert_eq!(nav.obstacle(id), Some(&crate_box));
    assert!(nav.remove_obstacle(id));
    while nav.pending_rebuilds() > 0 {
        nav.update(DT);
    }
    assert_eq!(nav.digest(), original, "removing the crate restores the baked tiles");
    assert!(crosses(&nav));

    // A tile replaced while a carving obstacle covers it comes back carved.
    nav.add_obstacle(crate_box).expect("the crate again");
    while nav.pending_rebuilds() > 0 {
        nav.update(DT);
    }
    let carved = nav.digest();
    nav.add_tile(&mesh.tiles()[0]).expect("the uncarved tile");
    assert_eq!(nav.pending_rebuilds(), 1);
    while nav.pending_rebuilds() > 0 {
        nav.update(DT);
    }
    assert_eq!(nav.digest(), carved);
}

#[test]
fn tiles_read_from_bytes_alone_avoid_but_cannot_carve() {
    let bytes = NavMesh::bake(&corridor(0.0), &config()).expect("a mesh").to_bytes();
    let mut nav = nav_with(&NavMesh::from_bytes(&bytes).expect("the bytes"));
    let before = (nav.tile_count(), nav.digest());
    nav.add_obstacle(NavObstacle::Avoid { position: Vec3::new(4.0, 0.0, 1.5), radius: 0.5 }).expect("a disc needs no input");
    let refused = nav.add_obstacle(NavObstacle::CarveCylinder { base: Vec3::new(4.0, 0.0, 1.5), radius: 1.0, height: 1.0 }).expect_err("refused");
    assert_eq!(refused.code, NavErrorCode::InputInvalid);
    unchanged(&nav, before, "no input");
    assert_eq!((nav.obstacles().count(), nav.pending_rebuilds()), (1, 0));
}

#[test]
fn a_default_nav_is_empty_and_tiles_come_and_go() {
    let mut nav = Nav::default();
    assert_eq!((nav.tile_count(), nav.pending_rebuilds(), nav.obstacles().count()), (0, 0, 0));
    nav.update(DT);
    let mut nav_8 = Nav::new(&config());
    let mesh = NavMesh::bake(&corridor(0.0), &config()).expect("a mesh");
    nav_8.add_mesh(&mesh).expect("the mesh");
    let cells: Vec<CellId> = nav_8.tiles().collect();
    assert_eq!(cells, mesh.tiles().iter().map(NavTile::cell).collect::<Vec<_>>());
    assert!(nav_8.memory_bytes() > 0);
    assert!(nav_8.remove_tile(cells[0]));
    assert!(!nav_8.remove_tile(cells[0]), "a removed tile is gone");
    assert_eq!(nav_8.tile_count(), cells.len() - 1);
    assert!(nav_8.tile(cells[0]).is_none() && nav_8.tile(cells[1]).is_some());
    assert!(!nav.set_area_open(NavArea::DOOR, true), "areas start open");
    assert!(nav.set_area_open(NavArea::DOOR, false));
}

#[test]
fn input_digests_follow_content_not_identity() {
    let grid = || HeightGrid::from_fn((9, 9), [0.0, 0.0], 1.0, |x, z| 0.1 * x - 0.05 * z).expect("terrain");
    let a = NavInput::new().with_terrain(Arc::new(grid()), NavArea::WALK).expect("a");
    let b = NavInput::new().with_terrain(Arc::new(grid()), NavArea::WALK).expect("b");
    assert_ne!(a, b, "two terrain objects are not the same terrain");
    assert_eq!(a.digest(), b.digest(), "but the same samples digest the same");
    let grass = NavInput::new().with_terrain(Arc::new(grid()), NavArea::GRASS).expect("grass");
    assert_ne!(a.digest(), grass.digest());
    let volume = a.clone().with_area_volume(&[Vec2::ZERO, Vec2::X, Vec2::Y], 0.0, 1.0, NavArea::WATER).expect("a volume");
    assert_ne!(volume.digest(), a.digest());
    let bounded = a.clone().with_bounds(Vec3::ZERO, Vec3::splat(4.0)).expect("bounds");
    assert_ne!(bounded.digest(), a.digest());
    assert_ne!(corridor(0.0).digest(), corridor(0.0).with_triangles(&[Vec3::ZERO, Vec3::X, Vec3::Z], &[0, 2, 1], NavArea::WALK).expect("more").digest());
    assert_eq!(NavInput::new().digest(), NavInput::default().digest());
}
