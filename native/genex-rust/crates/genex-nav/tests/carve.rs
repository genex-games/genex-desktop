//! NAV-10: obstacles and carving with a sliced dirty-tile queue (new behaviour: `carve.rs` was a
//! stub).
//!
//! - A crate carved across a corridor: once `pending() == 0` no path crosses it; before the swap
//!   the old tile stays and the path still runs through.
//! - The ticks from `add` to settled are equal across 8 replicas and equal
//!   `ceil(tiles × 7 ÷ units per tick)`.
//! - Removing the obstacle gives back every tile's original digest.
//! - Compact heightfields are cached only for tiles under a carving obstacle, and a moved
//!   obstacle rebuilds from the cache; an avoid disc never rebuilds anything.
//! - Hostile obstacles are refused with nothing changed.

use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::map::Map;
use genex_nav::bake::{BakeConfig, bake_tile, covering_cells};
use genex_nav::carve::{Carving, NAV_OBSTACLES_MAX, NAV_REBUILD_STAGES, NavObstacle, Rebuilt};
use genex_nav::error::NavErrorCode;
use genex_nav::filter::NavFilter;
use genex_nav::input::{NavArea, NavInput};
use genex_nav::runtime::archipelago::{Archipelago, ArchipelagoOptions};
use genex_nav::runtime::coords::{FromAgentRadius, GenexCoords, PointSampleDistance3d};
use genex_nav::runtime::island::{Island, IslandId};
use genex_nav::runtime::query::PathStep;
use genex_nav::runtime::util::Transform;
use genex_nav::tile::NavTile;
use glam::{Mat4, Quat, Vec2, Vec3};

const RADIUS: f32 = 0.4;
const DT: f32 = 1.0 / 60.0;
const REPLICAS: usize = 8;

fn config() -> BakeConfig {
    BakeConfig { tile: 8.0, ..BakeConfig::walker(RADIUS, 1.8) }
}

/// A flat corridor 24 m long (x 0..24) and 3 m wide (z 0..3), over three 8 m tiles.
fn corridor() -> NavInput {
    let vertices = [Vec3::new(0.0, 0.0, 0.0), Vec3::new(24.0, 0.0, 0.0), Vec3::new(24.0, 0.0, 3.0), Vec3::new(0.0, 0.0, 3.0)];
    NavInput::new().with_triangles(&vertices, &[0, 2, 1, 0, 3, 2], NavArea::WALK).expect("the corridor")
}

/// A crate straddling the line between tiles 0 and 1, wider than the corridor.
fn crate_box() -> NavObstacle {
    NavObstacle::CarveBox { transform: Mat4::from_scale_rotation_translation(Vec3::new(1.0, 1.0, 4.0), Quat::IDENTITY, Vec3::new(8.0, 0.5, 1.5)) }
}

/// The resident tiles in an archipelago, and the carving that rebuilds them.
struct World {
    archipelago: Archipelago<GenexCoords>,
    islands: Map<CellId, IslandId>,
    tiles: Map<CellId, NavTile>,
    carving: Carving,
}

impl World {
    fn new(input: NavInput, config: BakeConfig, cells: &[CellId]) -> World {
        let input = Arc::new(input);
        let mut world = World {
            archipelago: Archipelago::new(ArchipelagoOptions::from_agent_radius(RADIUS)),
            islands: Map::default(),
            tiles: Map::default(),
            carving: Carving::new(input.clone(), config.clone()).expect("a carving"),
        };
        for &cell in cells {
            let tile = bake_tile(&input, &config, cell).expect("a tile");
            let id = world.archipelago.add_island(island(&tile));
            world.islands.insert(cell, id);
            world.tiles.insert(cell, tile);
            world.carving.tile_added(cell);
        }
        world.archipelago.update(DT);
        world
    }

    /// One update: work `units` of the queue, swap in what finished, restitch.
    fn tick(&mut self, units: u32) -> Vec<Rebuilt> {
        let finished = self.carving.advance(units);
        for rebuilt in &finished {
            let tile = rebuilt.tile.clone().expect("the rebuild succeeds");
            let id = self.islands[&rebuilt.cell];
            let mesh = tile.navigation_mesh().validate().expect("a valid island mesh");
            self.archipelago.get_island_mut(id).expect("live").set_nav_mesh(Arc::new(mesh));
            self.tiles.insert(rebuilt.cell, tile);
        }
        self.archipelago.update(DT);
        finished
    }

    /// Ticks until nothing is pending (capped).
    fn settle(&mut self, units: u32) -> usize {
        let mut ticks = 0;
        while self.carving.pending() > 0 {
            self.tick(units);
            ticks += 1;
            assert!(ticks < 10_000, "the queue settles");
        }
        ticks
    }

    fn digests(&self) -> Vec<(CellId, u64)> {
        self.tiles.iter().map(|(cell, tile)| (*cell, tile.digest())).collect()
    }

    /// The path's corners from `from` to `to`, `None` when no full path exists.
    fn path(&self, from: Vec3, to: Vec3) -> Option<Vec<Vec3>> {
        let distance = PointSampleDistance3d::from_agent_radius(RADIUS);
        let start = self.archipelago.sample_point(from, &distance).ok()?;
        let end = self.archipelago.sample_point(to, &distance).ok()?;
        let found = self.archipelago.find_path(&start, &end, &NavFilter::new()).ok()?;
        if found.partial {
            return None;
        }
        Some(found.steps.iter().filter_map(|step| if let PathStep::Waypoint(p) = step { Some(*p) } else { None }).collect())
    }
}

fn island(tile: &NavTile) -> Island<GenexCoords> {
    Island::new(Transform::default(), Arc::new(tile.navigation_mesh().validate().expect("a valid island mesh")))
}

fn corridor_cells() -> Vec<CellId> {
    covering_cells(Vec2::ZERO, Vec2::new(24.0, 3.0), 8.0)
}

/// Whether the polyline crosses the x band 7.5..8.5 (the crate's footprint) anywhere.
fn crosses_crate(corners: &[Vec3]) -> bool {
    corners.windows(2).any(|pair| pair[0].x.min(pair[1].x) <= 8.5 && pair[0].x.max(pair[1].x) >= 7.5)
}

const WEST: Vec3 = Vec3::new(2.0, 0.0, 1.5);
const EAST: Vec3 = Vec3::new(22.0, 0.0, 1.5);

#[test]
fn a_crate_carved_into_a_corridor_blocks_it_once_settled_and_not_before() {
    let mut world = World::new(corridor(), config(), &corridor_cells());
    assert_eq!(world.tiles.len(), 3);
    let open = world.path(WEST, EAST).expect("the corridor is open");
    assert!(crosses_crate(&open), "the open path runs through where the crate goes");

    world.carving.add(crate_box()).expect("the crate");
    assert_eq!(world.carving.pending(), 2, "the crate touches the build regions of tiles 0 and 1 only");
    let before = world.digests();
    // Before the swap: a partial update finishes nothing, the old tiles stay, the path runs on.
    let finished = world.tick(NAV_REBUILD_STAGES - 1);
    assert!(finished.is_empty());
    assert_eq!(world.digests(), before, "agents keep the old tiles until the swap");
    assert!(world.path(WEST, EAST).is_some(), "no hole before the swap");

    world.settle(3);
    assert_eq!(world.carving.pending(), 0);
    assert_ne!(world.digests(), before, "the carved tiles changed");
    if let Some(corners) = world.path(WEST, EAST) {
        panic!("a path crosses the crate: {corners:?}");
    }
    // Each side is still walkable on its own.
    assert!(world.path(WEST, Vec3::new(6.0, 0.0, 1.5)).is_some());
    assert!(world.path(EAST, Vec3::new(10.0, 0.0, 1.5)).is_some());
}

#[test]
fn ticks_to_settled_are_equal_across_replicas_and_follow_the_unit_count() {
    for units in [1, 3, 5, 7, 10, 14, 30] {
        let mut ticks = Vec::new();
        let mut digests = Vec::new();
        for _ in 0..REPLICAS {
            let mut world = World::new(corridor(), config(), &corridor_cells());
            world.carving.add(crate_box()).expect("the crate");
            let tiles = world.carving.pending() as u32;
            ticks.push(world.settle(units));
            digests.push(world.digests());
            assert_eq!(ticks[ticks.len() - 1] as u32, (tiles * NAV_REBUILD_STAGES).div_ceil(units), "{tiles} tiles at {units} units a tick");
        }
        assert!(ticks.windows(2).all(|w| w[0] == w[1]), "{units} units: {ticks:?}");
        assert!(digests.windows(2).all(|w| w[0] == w[1]), "{units} units: equal tiles in every replica");
        let bytes: Vec<u8> = digests[0].iter().flat_map(|(_, digest)| digest.to_le_bytes()).collect();
        assert_eq!(genex_core::digest::fnv1a64(&bytes), CARVED_DIGEST, "the carved tiles are the pinned ones (host and wasm32)");
    }
}

/// The FNV-1a 64 of the three corridor tiles' digests once the crate has carved them, equal on
/// every destination (recorded on the host, checked on wasm32).
const CARVED_DIGEST: u64 = 0xe844_41be_e8a7_ff0f;

#[test]
fn removing_the_obstacle_restores_every_original_tile_digest() {
    let mut world = World::new(corridor(), config(), &corridor_cells());
    let original = world.digests();
    let id = world.carving.add(crate_box()).expect("the crate");
    world.settle(5);
    assert_ne!(world.digests(), original);
    assert!(world.carving.remove(id));
    assert!(!world.carving.remove(id), "a removed id stays dead");
    world.settle(5);
    assert_eq!(world.digests(), original, "the tiles are byte-equal to their first bake");
    assert!(world.path(WEST, EAST).is_some(), "the corridor is open again");
}

#[test]
fn compact_heightfields_are_cached_only_under_carving_and_moves_rebuild_from_the_cache() {
    let mut world = World::new(corridor(), config(), &corridor_cells());
    let avoid = world.carving.add(NavObstacle::Avoid { position: Vec3::new(4.0, 0.0, 1.5), radius: 0.5 }).expect("a disc");
    assert_eq!(world.carving.pending(), 0, "an avoid disc never rebuilds a tile");
    assert!(world.carving.set(avoid, NavObstacle::Avoid { position: Vec3::new(20.0, 0.0, 1.5), radius: 0.5 }).expect("moved"));
    assert_eq!(world.carving.pending(), 0);

    let id = world.carving.add(crate_box()).expect("the crate");
    world.settle(7);
    let cached: Vec<CellId> = world.carving.cached_cells().collect();
    assert_eq!(cached, vec![CellId::new(0, 0), CellId::new(1, 0)], "only the tiles under the crate");
    assert!(world.carving.cached_bytes() > 0);
    assert_eq!(world.carving.cache_hits(), 0);

    // Move the crate within tile 0: both tiles rebuild (old and new footprints), from the cache.
    let moved = NavObstacle::CarveCylinder { base: Vec3::new(4.0, 0.0, 1.5), radius: 1.6, height: 1.0 };
    assert!(world.carving.set(id, moved).expect("moved"));
    world.settle(7);
    assert_eq!(world.carving.cache_hits(), 1, "tile 0 still has carving and rebuilt from its cache");
    assert_eq!(world.carving.cached_cells().collect::<Vec<_>>(), vec![CellId::new(0, 0)], "tile 1 has no carving left");
    let fresh = bake_tile(world.carving.input().expect("an input"), &config(), CellId::new(1, 0)).expect("a tile");
    assert_eq!(world.tiles[&CellId::new(1, 0)].digest(), fresh.digest(), "an uncarved tile equals its bake");
    assert!(world.path(Vec3::new(1.0, 0.0, 1.5), Vec3::new(10.0, 0.0, 1.5)).is_none(), "the pillar blocks the corridor in tile 0");

    assert!(world.carving.remove(id));
    world.settle(7);
    assert_eq!(world.carving.cached_cells().count(), 0, "no carving, no cache");
}

#[test]
fn a_tile_streamed_in_under_a_carving_obstacle_is_carved_and_one_streamed_out_drops_its_work() {
    let input = corridor();
    let mut world = World::new(input, config(), &corridor_cells()[..1]);
    world.carving.add(crate_box()).expect("the crate");
    assert_eq!(world.carving.pending(), 1, "only tile 0 is resident");
    world.carving.tile_added(CellId::new(1, 0));
    assert_eq!(world.carving.pending(), 2, "the tile that streamed in queues its carving");
    world.carving.tile_removed(CellId::new(1, 0));
    assert_eq!(world.carving.pending(), 1, "the tile that left drops its rebuild");
    world.settle(7);
    assert_eq!(world.carving.cached_cells().collect::<Vec<_>>(), vec![CellId::new(0, 0)]);
}

#[test]
fn hostile_obstacles_are_refused_with_nothing_changed() {
    let mut world = World::new(corridor(), config(), &corridor_cells());
    let cases = [
        NavObstacle::Avoid { position: Vec3::new(f32::NAN, 0.0, 0.0), radius: 1.0 },
        NavObstacle::Avoid { position: Vec3::ZERO, radius: 0.0 },
        NavObstacle::Avoid { position: Vec3::ZERO, radius: -1.0 },
        NavObstacle::CarveCylinder { base: Vec3::ZERO, radius: 1.0, height: f32::INFINITY },
        NavObstacle::CarveCylinder { base: Vec3::ZERO, radius: 1.0e9, height: 1.0 },
        NavObstacle::CarveCylinder { base: Vec3::ZERO, radius: 1.0, height: -2.0 },
        NavObstacle::CarveBox { transform: Mat4::from_scale(Vec3::new(1.0, 0.0, 1.0)) },
        NavObstacle::CarveBox { transform: Mat4::from_scale(Vec3::splat(1.0e6)) },
        NavObstacle::CarveBox { transform: Mat4::from_cols_array(&[f32::NAN; 16]) },
    ];
    for obstacle in cases {
        let refused = world.carving.add(obstacle).expect_err("refused");
        assert_eq!(refused.code, NavErrorCode::InputInvalid, "{obstacle:?}");
        assert_eq!((world.carving.pending(), world.carving.obstacles().count()), (0, 0), "{obstacle:?}: nothing changed");
    }
    let id = world.carving.add(crate_box()).expect("the crate");
    world.settle(7);
    let refused = world.carving.set(id, NavObstacle::Avoid { position: Vec3::ZERO, radius: f32::NAN }).expect_err("refused");
    assert_eq!(refused.code, NavErrorCode::InputInvalid);
    assert_eq!(world.carving.get(id), Some(&crate_box()), "a refused move keeps the obstacle");
    assert_eq!(world.carving.pending(), 0);

    for k in 1..NAV_OBSTACLES_MAX {
        world.carving.add(NavObstacle::Avoid { position: Vec3::new(k as f32, 0.0, 0.0), radius: 0.1 }).expect("under the cap");
    }
    let refused = world.carving.add(NavObstacle::Avoid { position: Vec3::ZERO, radius: 0.1 }).expect_err("over the cap");
    assert_eq!(refused.code, NavErrorCode::TooLarge);
    assert_eq!(world.carving.obstacles().count(), NAV_OBSTACLES_MAX);
}

#[test]
fn a_config_that_cannot_bake_cannot_carve() {
    let refused = Carving::new(Arc::new(corridor()), BakeConfig { tile: 7.9, ..config() }).expect_err("refused");
    assert_eq!(refused.code, NavErrorCode::ConfigInvalid);
}

// ---- Budget (advisory in a lane; NAV-18 gates it): one 32 m tile rebuild ----

#[test]
#[cfg(not(target_arch = "wasm32"))]
#[allow(clippy::disallowed_types, reason = "the budget row measures the wall clock on purpose; nothing replays it")]
fn one_32_m_tile_rebuild_time_is_recorded() {
    let terrain = genex_nav::input::HeightGrid::from_fn((97, 97), [-8.0, -8.0], 0.5, |x, z| 0.02 * x + 0.01 * z).expect("terrain");
    let input = NavInput::new().with_terrain(Arc::new(terrain), NavArea::WALK).expect("terrain input");
    let config = BakeConfig::walker(RADIUS, 1.8);
    assert_eq!(config.tile, 32.0);
    let cell = CellId::new(0, 0);
    let mut world = World::new(input, config, &[cell]);
    let id = world.carving.add(NavObstacle::CarveCylinder { base: Vec3::new(16.0, 0.0, 16.0), radius: 1.0, height: 2.0 }).expect("a pillar");
    let clock = std::time::Instant::now();
    world.settle(NAV_REBUILD_STAGES);
    let first = clock.elapsed().as_secs_f64() * 1000.0;
    let mut cached = f64::INFINITY;
    for k in 0..5 {
        let pillar = NavObstacle::CarveCylinder { base: Vec3::new(10.0 + k as f32, 0.0, 16.0), radius: 1.0, height: 2.0 };
        world.carving.set(id, pillar).expect("moved");
        let clock = std::time::Instant::now();
        world.settle(NAV_REBUILD_STAGES);
        cached = cached.min(clock.elapsed().as_secs_f64() * 1000.0);
    }
    println!(
        "32 m tile rebuild ({} build): {first:.2} ms rasterized, best of 5 from the cache {cached:.2} ms, cache {} bytes, {} polygons",
        if cfg!(debug_assertions) { "debug" } else { "release" },
        world.carving.cached_bytes(),
        world.tiles[&cell].polygon_count()
    );
    assert!(world.tiles[&cell].polygon_count() > 0);
}
