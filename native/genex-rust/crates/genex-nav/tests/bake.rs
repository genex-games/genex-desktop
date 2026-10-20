//! NAV-2: the tiled bake and the tile format.
//!
//! Red rows: (a) two neighbouring tiles baked apart meet on their shared edge, which a plain
//! per-tile build (no border) does not: its erosion pulls each tile back from the edge; (b)
//! `NavTile::from_bytes` refuses a hostile table `nav-tile-invalid`, a 2^31 count included,
//! without allocating for it; (c) a bake twice gives equal bytes and digests. Acceptance rows: a
//! 4 x 4 grid of tiles stitches (NAV-4's runtime) into one connected region, the tile grid is
//! anchored at world (0, 0), per-tile memory is reported, and one 32 m tile's bake time is
//! printed (advisory in a lane; NAV-18 gates it).

use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::digest::fnv1a64;
use genex_nav::bake::{BakeConfig, bake_tile, bake_tile_with_border, covering_cells};
use genex_nav::input::HeightGrid;
use genex_nav::runtime::coords::GenexCoords;
use genex_nav::runtime::island::Island;
use genex_nav::runtime::nav_data::{DEFAULT_EDGE_LINK_DISTANCE, NavigationData};
use genex_nav::runtime::util::Transform;
use genex_nav::tile::NavTile;
use genex_nav::{NavArea, NavErrorCode, NavInput};
use glam::{Mat4, Quat, Vec2, Vec3};

/// How far a corner on a shared edge may sit from the neighbour's edge.
const TWIN_TOLERANCE: f32 = 1.0e-5;
/// How far above or below the mesh an animation link may attach (none are used here).
const LINK_VERTICAL_DISTANCE: f32 = 0.5;

/// 8 m tiles of 40 cells: small enough that a debug build bakes a grid of them quickly.
fn small_config() -> BakeConfig {
    BakeConfig { tile: 8.0, ..BakeConfig::walker(0.4, 1.8) }
}

/// Ground that rises along x only (so a tile edge at a whole x is level along z), from x, z = -4
/// to 36, with a 2 m crate astride the line x = 8 (it cuts a hole both tiles must agree on).
fn ramp_with_crate() -> NavInput {
    let terrain = HeightGrid::from_fn((81, 81), [-4.0, -4.0], 0.5, |x, _| 0.05 * x).expect("terrain");
    let crate_at = Mat4::from_scale_rotation_translation(Vec3::new(2.0, 1.0, 2.0), Quat::IDENTITY, Vec3::new(8.0, 0.9, 4.0));
    NavInput::new().with_terrain(Arc::new(terrain), NavArea::WALK).expect("terrain input").with_box(crate_at, NavArea::WALK).expect("crate")
}

/// sin and cos through libm (glam's `from_angle` under scalar-math + libm), so the test
/// terrain has the same heights on every destination.
fn sin(angle: f32) -> f32 {
    Vec2::from_angle(angle).y
}

fn cos(angle: f32) -> f32 {
    Vec2::from_angle(angle).x
}

/// Rolling hills over x, z = -4 to 36.
fn hills() -> NavInput {
    let terrain = HeightGrid::from_fn((81, 81), [-4.0, -4.0], 0.5, |x, z| 0.6 * sin(0.3 * x) * cos(0.25 * z) + 0.02 * x).expect("terrain");
    NavInput::new().with_terrain(Arc::new(terrain), NavArea::WALK).expect("terrain input")
}

/// Every polygon edge of `tile` with both ends on the line x = `x`, as (start, end) corners.
fn edges_on(tile: &NavTile, x: f32) -> Vec<(Vec3, Vec3)> {
    let mesh = tile.mesh();
    let mut edges = Vec::new();
    for polygon in &mesh.polygons {
        for (k, &a) in polygon.iter().enumerate() {
            let b = polygon[(k + 1) % polygon.len()];
            let (a, b) = (mesh.vertices[usize::from(a)], mesh.vertices[usize::from(b)]);
            if a.x == x && b.x == x {
                edges.push((a, b));
            }
        }
    }
    edges
}

/// `point` lies on one of `edges` (within the tolerance along z and in height).
fn on_some_edge(point: Vec3, edges: &[(Vec3, Vec3)]) -> bool {
    edges.iter().any(|&(a, b)| {
        let (low, high) = (a.z.min(b.z), a.z.max(b.z));
        let within = point.z >= low - TWIN_TOLERANCE && point.z <= high + TWIN_TOLERANCE;
        let t = if high > low { (point.z - a.z) / (b.z - a.z) } else { 0.0 };
        within && (a.y + t * (b.y - a.y) - point.y).abs() <= TWIN_TOLERANCE
    })
}

/// The total length along z the edges cover.
fn covered_length(edges: &[(Vec3, Vec3)]) -> f32 {
    edges.iter().map(|(a, b)| (a.z - b.z).abs()).sum()
}

// ---- Red row (a): neighbours meet on the shared edge; an unbordered build cracks ----

#[test]
fn two_neighbouring_tiles_baked_apart_meet_on_their_shared_edge() {
    let (input, config) = (ramp_with_crate(), small_config());
    let left = bake_tile(&input, &config, CellId::new(0, 0)).expect("left tile");
    let right = bake_tile(&input, &config, CellId::new(1, 0)).expect("right tile");
    let (left_edges, right_edges) = (edges_on(&left, 8.0), edges_on(&right, 8.0));
    assert!(!left_edges.is_empty() && !right_edges.is_empty(), "both tiles reach x = 8");
    for (mine, theirs, name) in [(&left_edges, &right_edges, "left"), (&right_edges, &left_edges, "right")] {
        for &(a, b) in mine.iter() {
            for corner in [a, b] {
                assert!(on_some_edge(corner, theirs), "the {name} tile's corner {corner} has no twin on the neighbour's edge");
            }
        }
    }
    let (l, r) = (covered_length(&left_edges), covered_length(&right_edges));
    assert!((l - r).abs() <= 1.0e-4, "the shared edge covers {l} m on the left and {r} m on the right");
    assert!(l < 8.0 - 1.0, "the crate's hole cuts the shared edge ({l} m of 8 covered)");
}

#[test]
fn an_unbordered_per_tile_build_cracks_at_the_shared_edge() {
    let (input, config) = (ramp_with_crate(), small_config());
    let left = bake_tile_with_border(&input, &config, CellId::new(0, 0), 0).expect("left tile");
    let right = bake_tile_with_border(&input, &config, CellId::new(1, 0), 0).expect("right tile");
    assert!(edges_on(&left, 8.0).is_empty() && edges_on(&right, 8.0).is_empty(), "with no border neither tile reaches x = 8");
    let left_max = left.mesh().vertices.iter().map(|v| v.x).fold(f32::NEG_INFINITY, f32::max);
    let right_min = right.mesh().vertices.iter().map(|v| v.x).fold(f32::INFINITY, f32::min);
    let gap = right_min - left_max;
    assert!(gap >= config.radius, "the crack between the tiles is {gap} m, at least one radius");
    println!("unbordered crack: {gap:.2} m between x = {left_max:.2} and x = {right_min:.2}");
}

// ---- Red row (b): hostile tile bytes are refused, nothing allocated for them ----

/// Offsets into a tile's bytes (see the layout in `tile.rs`).
const HEADER_BYTES: usize = 32;
const VERSION_AT: usize = 4;
const VERTEX_COUNT_AT: usize = HEADER_BYTES;

fn redigest(mut bytes: Vec<u8>) -> Vec<u8> {
    let body = bytes.len() - 8;
    let digest = fnv1a64(&bytes[..body]);
    bytes[body..].copy_from_slice(&digest.to_le_bytes());
    bytes
}

fn u32_at(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes(bytes[at..at + 4].try_into().expect("four bytes"))
}

fn assert_refused(bytes: &[u8], name: &str) {
    match NavTile::from_bytes(bytes) {
        Ok(_) => panic!("{name}: accepted"),
        Err(refusal) => assert_eq!(refusal.code, NavErrorCode::TileInvalid, "{name}: {refusal}"),
    }
}

#[test]
fn hostile_tile_bytes_are_refused_tile_invalid() {
    let tile = bake_tile(&hills(), &small_config(), CellId::new(1, 1)).expect("a tile");
    let good = tile.to_bytes();
    assert_eq!(NavTile::from_bytes(&good).expect("its own bytes read back"), tile);
    let vertices = u32_at(&good, VERTEX_COUNT_AT) as usize;
    assert!(vertices > 0 && tile.polygon_count() > 0, "the tile has geometry");
    let polygon_count_at = VERTEX_COUNT_AT + 4 + 12 * vertices;
    let first_polygon_at = polygon_count_at + 4;

    let mut table: Vec<(&str, Vec<u8>)> = vec![
        ("empty", Vec::new()),
        ("header only", good[..HEADER_BYTES].to_vec()),
        ("truncated by one byte", good[..good.len() - 1].to_vec()),
        ("truncated by half, re-digested", redigest(good[..good.len() / 2].to_vec())),
    ];
    let mut magic = good.clone();
    magic[0] = b'X';
    table.push(("wrong magic", redigest(magic)));
    let mut version = good.clone();
    version[VERSION_AT..VERSION_AT + 2].copy_from_slice(&2u16.to_le_bytes());
    table.push(("wrong version", redigest(version)));
    let mut digest = good.clone();
    digest[HEADER_BYTES + 8] ^= 0x40;
    table.push(("a body byte flipped (wrong digest)", digest));
    let mut polygons = good.clone();
    polygons[polygon_count_at..polygon_count_at + 4].copy_from_slice(&(1u32 << 31).to_le_bytes());
    table.push(("2^31 polygons", redigest(polygons)));
    let mut vertex_count = good.clone();
    vertex_count[VERTEX_COUNT_AT..VERTEX_COUNT_AT + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    table.push(("2^32 - 1 vertices", redigest(vertex_count)));
    let mut nan = good.clone();
    nan[VERTEX_COUNT_AT + 4..VERTEX_COUNT_AT + 8].copy_from_slice(&f32::NAN.to_le_bytes());
    table.push(("a NaN vertex", redigest(nan)));
    let mut infinite = good.clone();
    infinite[VERTEX_COUNT_AT + 8..VERTEX_COUNT_AT + 12].copy_from_slice(&f32::INFINITY.to_le_bytes());
    table.push(("an infinite vertex", redigest(infinite)));
    let mut corners = good.clone();
    corners[first_polygon_at] = 7;
    table.push(("a polygon of 7 corners", redigest(corners)));
    let mut area = good.clone();
    area[first_polygon_at + 1] = 64;
    table.push(("area 64", redigest(area)));
    let mut index = good.clone();
    index[first_polygon_at + 2..first_polygon_at + 4].copy_from_slice(&(vertices as u16).to_le_bytes());
    table.push(("an index past the vertices", redigest(index)));
    let mut trailing = good[..good.len() - 8].to_vec();
    trailing.push(0);
    trailing.extend_from_slice(&[0; 8]);
    table.push(("a trailing byte", redigest(trailing)));

    for (name, bytes) in &table {
        assert_refused(bytes, name);
    }
    // The 2^31-polygon row would need 2^31 polygon records (tens of GiB) if a count were trusted
    // before it is checked against the bytes left; reaching here means nothing was reserved.
}

// ---- Red row (c): a bake twice gives equal bytes and digests ----

#[test]
fn a_tile_baked_twice_has_equal_bytes_and_digest() {
    let (input, config) = (hills(), small_config());
    let first = bake_tile(&input, &config, CellId::new(2, 1)).expect("first");
    let second = bake_tile(&input, &config, CellId::new(2, 1)).expect("second");
    assert_eq!(first.to_bytes(), second.to_bytes());
    assert_eq!(first.digest(), second.digest());
    let bytes = first.to_bytes();
    assert_eq!(first.digest(), fnv1a64(&bytes[..bytes.len() - 8]), "the digest is the FNV-1a of the bytes before it");
    assert_eq!(first.config_digest(), config.digest());
    assert_eq!(first.cell(), CellId::new(2, 1));
}

#[test]
fn the_input_and_config_digests_follow_what_the_tile_was_baked_from() {
    let config = small_config();
    let plain = bake_tile(&hills(), &config, CellId::new(0, 0)).expect("plain");
    let crate_at = Mat4::from_translation(Vec3::new(4.0, 0.5, 4.0));
    let boxed = bake_tile(&hills().with_box(crate_at, NavArea::WALK).expect("box"), &config, CellId::new(0, 0)).expect("boxed");
    assert_ne!(plain.input_digest(), boxed.input_digest(), "a crate in the window changes the input digest");
    let far = bake_tile(&hills().with_box(Mat4::from_translation(Vec3::new(30.0, 0.5, 30.0)), NavArea::WALK).expect("box"), &config, CellId::new(0, 0))
        .expect("far");
    assert_eq!(plain.input_digest(), far.input_digest(), "a crate outside the window and its border does not");
    let finer = BakeConfig { cell_height: 0.05, ..config.clone() };
    assert_ne!(bake_tile(&hills(), &finer, CellId::new(0, 0)).expect("finer").config_digest(), plain.config_digest());
}

// ---- Acceptance: a 4 x 4 grid stitches into one region; the grid is anchored at (0, 0) ----

#[test]
fn a_4_by_4_grid_of_tiles_stitches_into_one_connected_region() {
    let (input, config) = (hills(), small_config());
    let cells = covering_cells(Vec2::ZERO, Vec2::splat(32.0), config.tile);
    assert_eq!(cells.len(), 16);
    let mut data = NavigationData::<GenexCoords>::new();
    let mut memory = Vec::new();
    for &cell in &cells {
        let tile = bake_tile(&input, &config, cell).expect("a tile");
        assert!(tile.polygon_count() > 0, "tile {cell:?} has ground");
        memory.push(tile.memory_bytes());
        let mesh = tile.navigation_mesh().validate().unwrap_or_else(|e| panic!("tile {cell:?} is a valid island mesh: {e}"));
        data.add_island(Island::new(Transform::default(), Arc::new(mesh)));
    }
    data.update(DEFAULT_EDGE_LINK_DISTANCE, LINK_VERTICAL_DISTANCE);
    let regions = data.region_numbers().count();
    let roots: std::collections::BTreeSet<usize> = data.region_numbers().map(|(_, number)| data.region_root(number)).collect();
    assert!(regions >= cells.len(), "every tile has a stitched region ({regions})");
    assert_eq!(roots.len(), 1, "the 16 tiles form {} separate regions", roots.len());

    // The same grid baked without borders cracks apart at every tile edge.
    let mut cracked = NavigationData::<GenexCoords>::new();
    for &cell in &cells {
        let tile = bake_tile_with_border(&input, &config, cell, 0).expect("an unbordered tile");
        cracked.add_island(Island::new(Transform::default(), Arc::new(tile.navigation_mesh().validate().expect("valid"))));
    }
    cracked.update(DEFAULT_EDGE_LINK_DISTANCE, LINK_VERTICAL_DISTANCE);
    assert!(data.off_mesh_links_by_node().count() > 0, "the bordered tiles link at their edges");
    assert_eq!(cracked.off_mesh_links_by_node().count(), 0, "unbordered tiles never link: every edge cracks");
    let total: usize = memory.iter().sum();
    println!("per-tile memory (bytes): {memory:?}; total {total}, largest {}", memory.iter().max().copied().unwrap_or(0));
    assert!(memory.iter().all(|&bytes| bytes > 0 && bytes < 64 * 1024), "an 8 m tile stays under 64 KiB");
}

#[test]
fn the_tile_grid_is_anchored_at_the_world_origin() {
    let config = small_config();
    for cell in [CellId::new(0, 0), CellId::new(3, 2), CellId::new(-1, 0)] {
        let input = if cell.x < 0 {
            let terrain = HeightGrid::from_fn((41, 41), [-12.0, -4.0], 0.5, |_, _| 0.0).expect("terrain");
            NavInput::new().with_terrain(Arc::new(terrain), NavArea::WALK).expect("terrain input")
        } else {
            hills()
        };
        let tile = bake_tile(&input, &config, cell).expect("a tile");
        assert!(tile.polygon_count() > 0);
        let (x0, z0) = (cell.x as f32 * config.tile, cell.z as f32 * config.tile);
        for v in &tile.mesh().vertices {
            let inside = v.x >= x0 && v.x <= x0 + config.tile && v.z >= z0 && v.z <= z0 + config.tile;
            assert!(inside, "tile {cell:?}: corner {v} outside [{x0}, {}] x [{z0}, {}]", x0 + config.tile, z0 + config.tile);
        }
    }
}

#[test]
fn a_tile_with_no_ground_has_no_polygons() {
    let tile = bake_tile(&hills(), &small_config(), CellId::new(10, 10)).expect("an empty tile");
    assert_eq!(tile.polygon_count(), 0);
    assert_eq!(NavTile::from_bytes(&tile.to_bytes()).expect("reads back"), tile);
}

#[test]
fn a_config_that_cannot_bake_is_refused_before_anything_is_gathered() {
    let config = BakeConfig { tile: 7.9, ..small_config() };
    let refused = bake_tile(&hills(), &config, CellId::new(0, 0)).expect_err("refused");
    assert_eq!(refused.code, NavErrorCode::ConfigInvalid);
}

#[test]
fn the_new_wire_spellings_are_the_designs() {
    assert_eq!(NavErrorCode::TileInvalid.wire(), "nav-tile-invalid");
    assert_eq!(NavErrorCode::ConfigInvalid.wire(), "nav-config-invalid");
    assert_eq!(
        NavErrorCode::ALL,
        [NavErrorCode::InputInvalid, NavErrorCode::TooLarge, NavErrorCode::TileInvalid, NavErrorCode::ConfigInvalid]
    );
}

// ---- Budget (advisory in a lane): one 32 m tile at 0.2 m cells ----

#[test]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose; nothing replays it")]
fn one_32_m_tile_bake_time_is_recorded() {
    let terrain = HeightGrid::from_fn((97, 97), [-8.0, -8.0], 0.5, |x, z| 0.8 * sin(0.2 * x) * cos(0.15 * z)).expect("terrain");
    let mut input = NavInput::new().with_terrain(Arc::new(terrain), NavArea::WALK).expect("terrain input");
    for k in 0..12 {
        let at = Vec3::new(3.0 + 2.5 * k as f32, 0.6, 5.0 + 2.0 * (k % 5) as f32);
        input.add_box(Mat4::from_scale_rotation_translation(Vec3::new(1.2, 1.2, 1.2), Quat::from_rotation_y(0.3 * k as f32), at), NavArea::WALK).expect("box");
    }
    let config = BakeConfig::walker(0.4, 1.8);
    assert_eq!(config.tile, 32.0);
    let runs = 5;
    let mut best = f64::INFINITY;
    let mut tile = None;
    for _ in 0..runs {
        let clock = std::time::Instant::now();
        tile = Some(bake_tile(&input, &config, CellId::new(0, 0)).expect("the tile"));
        best = best.min(clock.elapsed().as_secs_f64() * 1000.0);
    }
    let tile = tile.expect("baked");
    println!(
        "32 m tile at 0.2 m cells: best of {runs} {best:.2} ms ({} build), {} polygons, {} bytes",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        tile.polygon_count(),
        tile.memory_bytes()
    );
    assert!(tile.polygon_count() > 0);
}
