//! NAV-9: Detour-style surface queries on the archipelago (raycast, move along, random point,
//! distance to the wall).
//!
//! The room is 20 × 20 m with a 4 × 4 m pillar in the middle, as a 3 × 3 grid of cells without the
//! centre one, split into two islands at x = 8 (the right one built in its own frame and moved
//! there), so every query also crosses a stitched border. A second mesh, 30 × 10 m, holds two areas
//! (WALK on 20 × 10, ROAD on 10 × 10) for the random-point histogram.

use std::sync::Arc;

use genex_core::digest::fnv1a64;
use genex_core::rng::Pcg32;
use genex_nav::filter::NavFilter;
use genex_nav::input::NavArea;
use genex_nav::runtime::archipelago::{Archipelago, ArchipelagoOptions};
use genex_nav::runtime::coords::{FromAgentRadius, PointSampleDistance3d, XYZ};
use genex_nav::runtime::island::Island;
use genex_nav::runtime::nav_mesh::NavigationMesh;
use genex_nav::runtime::util::Transform;
use glam::Vec3;

/// Positions and fractions agree to this.
const CLOSE: f32 = 1e-4;
/// How far a query point is sampled onto the mesh.
const REACH: f32 = 0.5;
const WALK: usize = 1;
const ROAD: usize = 2;
/// FNV-1a 64 of the 1,000 seed-7 points' bits (x, y, z, area), pinned on the host and wasm32.
const POINTS_DIGEST: &str = "416fddf76c30227a";

/// A mesh of axis-aligned cells `(x0, y0, x1, y1, type index)`, each counter-clockwise seen from
/// above, sharing the vertices of equal corners, shifted by `-offset_x`.
fn mesh(cells: &[(f32, f32, f32, f32, usize)], offset_x: f32) -> NavigationMesh<XYZ> {
    let mut vertices: Vec<Vec3> = Vec::new();
    let mut index = |x: f32, y: f32| {
        let point = Vec3::new(x - offset_x, y, 0.0);
        vertices.iter().position(|known| *known == point).unwrap_or_else(|| {
            vertices.push(point);
            vertices.len() - 1
        })
    };
    let mut polygons = Vec::new();
    for &(x0, y0, x1, y1, _) in cells {
        polygons.push(vec![index(x0, y0), index(x1, y0), index(x1, y1), index(x0, y1)]);
    }
    let polygon_type_indices = cells.iter().map(|cell| cell.4).collect();
    NavigationMesh { vertices, polygons, polygon_type_indices, height_mesh: None }
}

fn island(mesh: NavigationMesh<XYZ>, at_x: f32) -> Island<XYZ> {
    let transform = Transform { translation: Vec3::new(at_x, 0.0, 0.0), rotation: 0.0 };
    Island::new(transform, Arc::new(mesh.validate().expect("a valid cell mesh")))
}

fn archipelago(islands: Vec<Island<XYZ>>) -> Archipelago<XYZ> {
    let mut archipelago = Archipelago::new(ArchipelagoOptions::from_agent_radius(0.5));
    for island in islands {
        archipelago.add_island(island);
    }
    archipelago.update(1.0 / 60.0);
    archipelago
}

/// The room with the pillar: left island x 0..8, right island x 8..20 built about its own origin.
fn room() -> Archipelago<XYZ> {
    let xs = [0.0, 8.0, 12.0, 20.0];
    let cell = |i: usize, j: usize| (xs[i], xs[j], xs[i + 1], xs[j + 1], WALK);
    let left: Vec<_> = (0..3).map(|j| cell(0, j)).collect();
    let right: Vec<_> = [(1, 0), (1, 2), (2, 0), (2, 1), (2, 2)].into_iter().map(|(i, j)| cell(i, j)).collect();
    archipelago(vec![island(mesh(&left, 0.0), 0.0), island(mesh(&right, 8.0), 8.0)])
}

/// 30 × 10 m: WALK on x 0..20 (two cells), ROAD on x 20..30.
fn two_areas() -> Archipelago<XYZ> {
    let cells = [(0.0, 0.0, 10.0, 10.0, WALK), (10.0, 0.0, 20.0, 10.0, WALK), (20.0, 0.0, 30.0, 10.0, ROAD)];
    archipelago(vec![island(mesh(&cells, 0.0), 0.0)])
}

fn p(x: f32, y: f32) -> Vec3 {
    Vec3::new(x, y, 0.0)
}

fn close(a: Vec3, b: Vec3) -> bool {
    a.distance(b) <= CLOSE * 10.0
}

#[test]
fn the_raycast_table_in_the_room_with_the_pillar() {
    let room = room();
    let filter = NavFilter::new();
    let left = Vec3::new(-1.0, 0.0, 0.0);
    let right = Vec3::new(1.0, 0.0, 0.0);
    let down = Vec3::new(0.0, -1.0, 0.0);
    let up = Vec3::new(0.0, 1.0, 0.0);
    // (name, from, to, fraction, normal); a zero normal is a clear ray.
    let table = [
        ("east into the pillar's west face", p(2.0, 10.0), p(18.0, 10.0), 0.375, left),
        ("west into the pillar's east face", p(18.0, 10.0), p(2.0, 10.0), 0.375, right),
        ("north into the pillar's south face", p(10.0, 2.0), p(10.0, 18.0), 0.375, down),
        ("diagonal into the pillar's west face", p(2.0, 4.0), p(14.0, 16.0), 0.5, left),
        ("north through the outer wall", p(10.0, 18.0), p(10.0, 25.0), 2.0 / 7.0, down),
        ("south through the outer wall", p(5.0, 15.0), p(5.0, -5.0), 0.75, up),
        ("east through the outer wall", p(19.0, 10.0), p(25.0, 13.0), 1.0 / 6.0, left),
        ("east across the island border", p(2.0, 2.0), p(18.0, 2.0), 1.0, Vec3::ZERO),
        ("along the island border", p(8.0, 1.0), p(8.0, 7.0), 1.0, Vec3::ZERO),
        ("south past the pillar's east side", p(15.0, 15.0), p(15.0, 3.0), 1.0, Vec3::ZERO),
        ("of zero length", p(3.0, 3.0), p(3.0, 3.0), 1.0, Vec3::ZERO),
    ];
    for (name, from, to, fraction, normal) in table {
        let ray = room.raycast(from, to, REACH, &filter).unwrap_or_else(|| panic!("{name}: no result"));
        println!("{name}: fraction {} normal {} at {}", ray.fraction, ray.normal, ray.position);
        assert!((ray.fraction - fraction).abs() <= CLOSE, "{name}: fraction {} not {fraction}", ray.fraction);
        assert!(close(ray.normal, normal), "{name}: normal {} not {normal}", ray.normal);
        assert_eq!(ray.blocked, normal != Vec3::ZERO, "{name}");
        assert!(close(ray.position, from + (to - from) * fraction), "{name}: stopped at {}", ray.position);
    }
}

#[test]
fn a_ray_across_the_border_ends_on_the_far_island() {
    let room = room();
    let ray = room.raycast(p(2.0, 2.0), p(18.0, 2.0), REACH, &NavFilter::new()).expect("a result");
    let start = room.sample_point(p(2.0, 2.0), &sample(REACH)).expect("on the mesh");
    assert_ne!(ray.node.island_id, start.island(), "the ray crossed the stitched border");
}

fn sample(reach: f32) -> PointSampleDistance3d {
    PointSampleDistance3d {
        horizontal_distance: reach,
        distance_above: reach,
        distance_below: reach,
        vertical_preference_ratio: 1.0,
        animation_link_max_vertical_distance: reach,
    }
}

/// Whether `point` is on the room's floor (inside the walls, outside the pillar).
fn on_room_floor(room: &Archipelago<XYZ>, point: Vec3) -> bool {
    let inside_room = (-CLOSE..=20.0 + CLOSE).contains(&point.x) && (-CLOSE..=20.0 + CLOSE).contains(&point.y);
    let pillar = 8.0 + 1e-3..12.0 - 1e-3;
    let in_pillar = pillar.contains(&point.x) && pillar.contains(&point.y);
    let sampled = room.sample_point(point, &sample(1e-3)).ok();
    let on_mesh = sampled.is_some_and(|sampled| sampled.point().distance(point) <= 1e-3);
    inside_room && !in_pillar && on_mesh && point.z.abs() <= CLOSE
}

#[test]
fn move_along_never_leaves_the_mesh_over_10k_seeded_moves() {
    let room = room();
    let filter = NavFilter::new();
    let mut rng = Pcg32::seeded(7);
    let mut at = p(2.0, 2.0);
    let (mut arrived, mut slid) = (0, 0);
    for step in 0..10_000 {
        let target = at + Vec3::new(rng.range_f32(-3.0, 3.0), rng.range_f32(-3.0, 3.0), 0.0);
        let moved = room.move_along(at, target, REACH, &filter).unwrap_or_else(|| panic!("move {step} from {at}: no result"));
        assert!(on_room_floor(&room, moved.position), "move {step}: {at} toward {target} left the mesh at {}", moved.position);
        if moved.position == target {
            arrived += 1;
        } else {
            slid += 1;
        }
        at = moved.position;
    }
    println!("10k moves: {arrived} reached their target, {slid} slid along a wall");
    assert!(arrived > 0 && slid > 0, "both outcomes were exercised");
}

#[test]
fn move_along_reaches_an_open_target_and_slides_on_a_wall() {
    let room = room();
    let filter = NavFilter::new();
    let open = room.move_along(p(2.0, 2.0), p(9.0, 3.0), REACH, &filter).expect("a result");
    assert!(close(open.position, p(9.0, 3.0)), "across the border to an open target: {}", open.position);
    let blocked = room.move_along(p(6.0, 10.0), p(9.0, 10.5), REACH, &filter).expect("a result");
    assert!(close(blocked.position, p(8.0, 10.5)), "stops on the pillar's face at {}", blocked.position);
}

/// 1 000 random points from seed 7 around the middle of the two-area mesh.
fn thousand_points(archipelago: &Archipelago<XYZ>, filter: &NavFilter, count: usize) -> Vec<(Vec3, usize)> {
    let mut rng = Pcg32::seeded(7);
    (0..count)
        .map(|_| {
            let point = archipelago.random_point(&mut rng, p(15.0, 5.0), 100.0, REACH, filter).expect("a point");
            (point.position, point.type_index)
        })
        .collect()
}

#[test]
fn random_points_repeat_for_a_seed_and_follow_the_area_ratio() {
    let areas = two_areas();
    let filter = NavFilter::new();
    let first = thousand_points(&areas, &filter, 1000);
    assert_eq!(first, thousand_points(&areas, &filter, 1000), "seed 7 gives the same 1,000 points twice");
    let bits: Vec<u8> = first.iter().flat_map(|(point, area)| [point.x.to_bits(), point.y.to_bits(), point.z.to_bits(), *area as u32]).flat_map(u32::to_le_bytes).collect();
    let digest = format!("{:016x}", fnv1a64(&bits));
    println!("1,000 points digest {digest}");
    assert_eq!(digest, POINTS_DIGEST, "the same points on every destination");
    for (point, _) in &first {
        assert!((0.0..=30.0).contains(&point.x) && (0.0..=10.0).contains(&point.y) && point.z == 0.0, "{point}");
    }
    let walk_share = first.iter().filter(|(_, area)| *area == WALK).count() as f32 / 1000.0;
    println!("1,000 points: WALK share {walk_share} (area share 0.6667)");
    assert!((walk_share - 2.0 / 3.0).abs() <= 0.05, "WALK share {walk_share}");
    let many = thousand_points(&areas, &filter, 10_000);
    let walk = many.iter().filter(|(_, area)| *area == WALK).count() as f32;
    let ratio = walk / (many.len() as f32 - walk);
    println!("10,000 points: WALK/ROAD {ratio} (area ratio 2)");
    assert!((ratio / 2.0 - 1.0).abs() <= 0.05, "WALK/ROAD ratio {ratio} is not within 5% of 2");
    for (point, area) in &many {
        assert_eq!(*area == ROAD, point.x >= 20.0, "{point} was reported on area {area}");
    }
}

#[test]
fn a_random_point_draws_one_number_per_polygon_and_two_more() {
    let areas = two_areas();
    let mut rng = Pcg32::seeded(7);
    let point = areas.random_point(&mut rng, p(15.0, 5.0), 100.0, REACH, &NavFilter::new()).expect("a point");
    assert_eq!(point.visited, 3);
    let mut expected = Pcg32::seeded(7);
    for _ in 0..point.visited + 2 {
        expected.next_u32();
    }
    assert_eq!(rng, expected);
}

#[test]
fn a_shut_area_is_never_picked_nor_crossed() {
    let areas = two_areas();
    let no_road = NavFilter::new().without_area(NavArea::ROAD);
    assert!(thousand_points(&areas, &no_road, 1000).iter().all(|(point, area)| *area == WALK && point.x <= 20.0));
    let ray = areas.raycast(p(15.0, 5.0), p(25.0, 5.0), REACH, &no_road).expect("a result");
    assert!(ray.blocked && (ray.fraction - 0.5).abs() <= CLOSE, "the road's edge is a wall: {ray:?}");
    assert_eq!(areas.raycast(p(25.0, 5.0), p(15.0, 5.0), REACH, &no_road), None, "a start on a shut area");
}

#[test]
fn the_distance_to_the_nearest_wall() {
    let room = room();
    let filter = NavFilter::new();
    // (name, at, radius, distance, wall point, normal)
    let table = [
        ("beside the pillar's west face", p(5.0, 10.0), 10.0, 3.0, p(8.0, 10.0), Vec3::new(-1.0, 0.0, 0.0)),
        ("beside the pillar's east face", p(15.0, 10.0), 10.0, 3.0, p(12.0, 10.0), Vec3::new(1.0, 0.0, 0.0)),
        ("right of the border, the south wall nearest", p(9.0, 3.0), 10.0, 3.0, p(9.0, 0.0), Vec3::new(0.0, 1.0, 0.0)),
        ("just past the border, which is no wall", p(8.2, 4.0), 10.0, 4.0, p(8.2, 0.0), Vec3::new(0.0, 1.0, 0.0)),
    ];
    for (name, at, radius, distance, wall, normal) in table {
        let found = room.distance_to_wall(at, radius, REACH, &filter).unwrap_or_else(|| panic!("{name}: no result"));
        assert!(found.found, "{name}");
        assert!((found.distance - distance).abs() <= CLOSE, "{name}: distance {}", found.distance);
        assert!(close(found.position, wall), "{name}: wall at {}", found.position);
        assert!(close(found.normal, normal), "{name}: normal {}", found.normal);
    }
    let none = room.distance_to_wall(p(4.0, 4.0), 1.0, REACH, &filter).expect("a result");
    assert!(!none.found && none.distance == 1.0 && none.normal == Vec3::ZERO, "nothing within 1 m: {none:?}");
}

#[test]
fn hostile_input_answers_none_for_every_query() {
    let room = room();
    let filter = NavFilter::new();
    let nan = Vec3::new(f32::NAN, 2.0, 0.0);
    let infinite = Vec3::new(2.0, f32::INFINITY, 0.0);
    let off = p(100.0, 100.0);
    let at = p(2.0, 2.0);
    let mut rng = Pcg32::seeded(7);
    let points = [("a NaN point", nan), ("an infinite point", infinite), ("a point off every island", off)];
    for (name, point) in points {
        assert_eq!(room.raycast(point, at, REACH, &filter), None, "raycast from {name}");
        if point.is_finite() {
            // An end off the mesh is no refusal: the ray stops at the wall on its way.
            assert!(room.raycast(at, point, REACH, &filter).is_some_and(|ray| ray.blocked), "raycast to {name}");
        } else {
            assert_eq!(room.raycast(at, point, REACH, &filter), None, "raycast to {name}");
            assert_eq!(room.move_along(at, point, REACH, &filter), None, "move_along to {name}");
        }
        assert_eq!(room.move_along(point, at, REACH, &filter), None, "move_along from {name}");
        assert_eq!(room.random_point(&mut rng, point, 5.0, REACH, &filter), None, "random_point around {name}");
        assert_eq!(room.distance_to_wall(point, 5.0, REACH, &filter), None, "distance_to_wall at {name}");
    }
    for reach in [0.0, -1.0, f32::NAN, f32::INFINITY] {
        assert_eq!(room.raycast(at, p(3.0, 3.0), reach, &filter), None, "raycast reach {reach}");
        assert_eq!(room.move_along(at, p(3.0, 3.0), reach, &filter), None, "move_along reach {reach}");
        assert_eq!(room.random_point(&mut rng, at, 5.0, reach, &filter), None, "random_point reach {reach}");
        assert_eq!(room.distance_to_wall(at, 5.0, reach, &filter), None, "distance_to_wall reach {reach}");
    }
    for radius in [0.0, -1.0, f32::NAN] {
        assert_eq!(room.random_point(&mut rng, at, radius, REACH, &filter), None, "random_point radius {radius}");
        assert_eq!(room.distance_to_wall(at, radius, REACH, &filter), None, "distance_to_wall radius {radius}");
    }
    assert_eq!(rng, Pcg32::seeded(7), "a refused random_point draws nothing");
}

#[test]
fn changed_navigation_data_answers_none_until_the_next_update() {
    let mut room = room();
    let cells = [(30.0, 0.0, 40.0, 10.0, WALK)];
    room.add_island(island(mesh(&cells, 0.0), 0.0));
    let filter = NavFilter::new();
    let at = p(2.0, 2.0);
    assert_eq!(room.raycast(at, p(3.0, 3.0), REACH, &filter), None);
    assert_eq!(room.move_along(at, p(3.0, 3.0), REACH, &filter), None);
    assert_eq!(room.random_point(&mut Pcg32::seeded(7), at, 5.0, REACH, &filter), None);
    assert_eq!(room.distance_to_wall(at, 5.0, REACH, &filter), None);
    room.update(1.0 / 60.0);
    assert!(room.raycast(at, p(3.0, 3.0), REACH, &filter).is_some());
}
