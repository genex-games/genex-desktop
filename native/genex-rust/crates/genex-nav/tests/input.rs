//! NAV-3: bake input. Hostile input is refused `nav-input-invalid` (or `nav-too-large` past the
//! triangle cap) and leaves the input exactly as it was; a terrain is triangulated one tile
//! window at a time, and the window of tile (1, 2) is the matching slice of the whole field's
//! triangulation; a 2049² terrain gathered tile by tile never holds 8 MB of input triangles;
//! triangle soups are picked per tile by their bounds; Recast's walkable-slope rule and convex
//! area volumes behave as Recast's do.

// The counting allocator below implements `GlobalAlloc`, which is an unsafe trait; it only
// forwards to the system allocator and counts on the calling thread.
#![allow(unsafe_code)]

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::sync::Arc;

use genex_nav::NavErrorCode;
use genex_nav::input::{
    AreaVolume, HeightGrid, NAV_AREA_OUTLINE_POINTS_MAX, NAV_AREA_VOLUMES_MAX, NAV_INPUT_TRIANGLES_MAX, NavArea, NavInput, TerrainHeights, TileInput, terrain_cells,
    tile_region, triangulate_cells,
};
use glam::{Mat4, Quat, Vec2, Vec3};

/// Bytes live and the most live at once, per thread, so parallel tests do not count each other.
struct Counting;

thread_local! {
    static LIVE: Cell<usize> = const { Cell::new(0) };
    static PEAK: Cell<usize> = const { Cell::new(0) };
}

fn grew(bytes: usize) {
    let _ = LIVE.try_with(|live| {
        live.set(live.get() + bytes);
        let _ = PEAK.try_with(|peak| peak.set(peak.get().max(live.get())));
    });
}

fn shrank(bytes: usize) {
    let _ = LIVE.try_with(|live| live.set(live.get().saturating_sub(bytes)));
}

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        grew(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        shrank(layout.size());
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        shrank(layout.size());
        grew(new_size);
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// The most bytes `run` held live at once above what was live before it.
fn peak_bytes(run: impl FnOnce()) -> usize {
    let before = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(before));
    run();
    PEAK.with(Cell::get) - before
}

/// Bytes of input triangles a tile holds: three f32 corners of three components each.
const TRIANGLE_BYTES: usize = 36;
/// The acceptance limit for input triangles held at once (plan NAV-3).
const TILE_INPUT_LIMIT: usize = 8 * 1024 * 1024;

fn quad() -> (Vec<Vec3>, Vec<u32>) {
    (vec![Vec3::new(0.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 0.0), Vec3::new(4.0, 0.0, 4.0), Vec3::new(0.0, 0.0, 4.0)], vec![0, 3, 1, 1, 3, 2])
}

/// An input with something in it, so "unchanged" means more than "still empty".
fn seeded() -> NavInput {
    let (vertices, indices) = quad();
    let terrain = HeightGrid::from_fn((9, 9), [-4.0, -4.0], 1.0, |x, z| 0.1 * x + 0.05 * z).expect("terrain");
    NavInput::new()
        .with_triangles(&vertices, &indices, NavArea::WALK)
        .and_then(|input| input.with_terrain(Arc::new(terrain), NavArea::GRASS))
        .and_then(|input| input.with_area_volume(&[Vec2::new(0.0, 0.0), Vec2::new(2.0, 0.0), Vec2::new(2.0, 2.0)], -1.0, 1.0, NavArea::ROAD))
        .expect("a seeded input")
}

fn assert_refused(code: NavErrorCode, what: &str, edit: impl FnOnce(&mut NavInput) -> Result<(), genex_nav::error::NavError>) {
    let mut input = seeded();
    let before = input.clone();
    let error = edit(&mut input).expect_err(what);
    assert_eq!(error.code, code, "{what}: {}", error.detail);
    assert_eq!(input, before, "{what}: the input is unchanged");
}

// ---- Red row 1: hostile input is refused and changes nothing ----

#[test]
fn hostile_triangles_are_refused_and_leave_the_input_unchanged() {
    let (vertices, _) = quad();
    let invalid = NavErrorCode::InputInvalid;
    assert_refused(invalid, "an index past the vertices", |input| input.add_triangles(&vertices, &[0, 1, 4], NavArea::WALK));
    assert_refused(invalid, "an index count not a multiple of 3", |input| input.add_triangles(&vertices, &[0, 1, 2, 3], NavArea::WALK));
    for bad in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
        let mut hostile = vertices.clone();
        hostile[2].y = bad;
        assert_refused(invalid, "a non-finite vertex", |input| input.add_triangles(&hostile, &[0, 1, 2], NavArea::WALK));
    }
    // An unused non-finite vertex is refused too: every vertex is checked, not only the used.
    let mut unused = vertices.clone();
    unused.push(Vec3::new(f32::NAN, 0.0, 0.0));
    assert_refused(invalid, "an unused non-finite vertex", |input| input.add_triangles(&unused, &[0, 1, 2], NavArea::WALK));
    let flipped = Mat4::from_cols_array(&[f32::NAN; 16]);
    assert_refused(invalid, "a non-finite mesh placement", |input| input.add_mesh(&vertices, &[0, 1, 2], flipped, NavArea::WALK));
    assert_refused(invalid, "a non-finite box", |input| input.add_box(Mat4::from_translation(Vec3::new(f32::INFINITY, 0.0, 0.0)), NavArea::WALK));
}

#[test]
fn hostile_area_volumes_are_refused_and_leave_the_input_unchanged() {
    let invalid = NavErrorCode::InputInvalid;
    let square = [Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(1.0, 1.0), Vec2::new(0.0, 1.0)];
    assert_refused(invalid, "two points", |input| input.add_area_volume(&square[..2], 0.0, 1.0, NavArea::WATER));
    assert_refused(invalid, "no points", |input| input.add_area_volume(&[], 0.0, 1.0, NavArea::WATER));
    let dart = [Vec2::new(0.0, 0.0), Vec2::new(2.0, 1.0), Vec2::new(4.0, 0.0), Vec2::new(2.0, 3.0)];
    assert_refused(invalid, "a non-convex outline", |input| input.add_area_volume(&dart, 0.0, 1.0, NavArea::WATER));
    let star: Vec<Vec2> = [0, 2, 4, 1, 3].iter().map(|&k| Vec2::from_angle(k as f32 * std::f32::consts::TAU / 5.0) * 3.0).collect();
    assert_refused(invalid, "a pentagram (turns one way, crosses itself)", |input| input.add_area_volume(&star, 0.0, 1.0, NavArea::WATER));
    let collinear = [Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(2.0, 0.0)];
    assert_refused(invalid, "a flat outline", |input| input.add_area_volume(&collinear, 0.0, 1.0, NavArea::WATER));
    let repeated = [Vec2::new(0.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(1.0, 0.0), Vec2::new(0.0, 1.0)];
    assert_refused(invalid, "a repeated point", |input| input.add_area_volume(&repeated, 0.0, 1.0, NavArea::WATER));
    assert_refused(invalid, "min_y above max_y", |input| input.add_area_volume(&square, 2.0, 1.0, NavArea::WATER));
    assert_refused(invalid, "a NaN height", |input| input.add_area_volume(&square, f32::NAN, 1.0, NavArea::WATER));
    let mut far = square;
    far[1].x = f32::INFINITY;
    assert_refused(invalid, "an infinite point", |input| input.add_area_volume(&far, 0.0, 1.0, NavArea::WATER));
    let many: Vec<Vec2> = (0..=NAV_AREA_OUTLINE_POINTS_MAX).map(|k| Vec2::from_angle(k as f32 * std::f32::consts::TAU / (NAV_AREA_OUTLINE_POINTS_MAX + 1) as f32)).collect();
    assert_refused(invalid, "more outline points than the cap", |input| input.add_area_volume(&many, 0.0, 1.0, NavArea::WATER));
    let mut full = NavInput::new();
    for _ in 0..NAV_AREA_VOLUMES_MAX {
        full.add_area_volume(&square, 0.0, 1.0, NavArea::WATER).expect("under the cap");
    }
    let before = full.clone();
    let error = full.add_area_volume(&square, 0.0, 1.0, NavArea::WATER).expect_err("one past the cap");
    assert_eq!(error.code, NavErrorCode::TooLarge);
    assert_eq!(full, before, "one past the cap: unchanged");
    // Either winding of a convex outline is accepted.
    let mut input = seeded();
    let reversed: Vec<Vec2> = square.iter().rev().copied().collect();
    input.add_area_volume(&reversed, 0.0, 1.0, NavArea::WATER).expect("clockwise is fine");
    input.add_area_volume(&square, 0.0, 0.0, NavArea::WATER).expect("a zero-height prism is fine");
}

#[test]
fn hostile_terrain_and_bounds_are_refused_and_leave_the_input_unchanged() {
    let invalid = NavErrorCode::InputInvalid;
    assert!(HeightGrid::new((1, 4), [0.0; 2], 1.0, vec![0.0; 4]).is_err(), "one sample across");
    assert!(HeightGrid::new((2, 2), [0.0; 2], 0.0, vec![0.0; 4]).is_err(), "zero spacing");
    assert!(HeightGrid::new((2, 2), [f32::NAN, 0.0], 1.0, vec![0.0; 4]).is_err(), "a NaN origin");
    assert!(HeightGrid::new((2, 2), [0.0; 2], 1.0, vec![0.0; 3]).is_err(), "too few heights");
    assert!(HeightGrid::new((2, 2), [0.0; 2], 1.0, vec![0.0, f32::NAN, 0.0, 0.0]).is_err(), "a NaN height");
    let error = HeightGrid::new((2, 2), [0.0; 2], -1.0, vec![0.0; 4]).expect_err("negative spacing");
    assert_eq!(error.code, invalid);
    let flat = Arc::new(HeightGrid::from_fn((3, 3), [0.0; 2], 1.0, |_, _| 0.0).expect("terrain"));
    assert_refused(invalid, "a second terrain", |input| input.add_terrain(flat.clone(), NavArea::WALK));
    assert_refused(invalid, "bounds min above max", |input| input.set_bounds(Vec3::ONE, Vec3::ZERO));
    assert_refused(invalid, "NaN bounds", |input| input.set_bounds(Vec3::splat(f32::NAN), Vec3::ONE));

    // A terrain whose own sampler returns NaN is refused when a tile reads it, not later in a bake.
    #[derive(Debug)]
    struct Holey;
    impl TerrainHeights for Holey {
        fn samples(&self) -> (u32, u32) {
            (4, 4)
        }
        fn origin(&self) -> [f32; 2] {
            [0.0, 0.0]
        }
        fn spacing(&self) -> f32 {
            1.0
        }
        fn sample(&self, x: u32, _z: u32) -> f32 {
            if x == 2 { f32::NAN } else { 0.0 }
        }
    }
    let input = NavInput::new().with_terrain(Arc::new(Holey), NavArea::WALK).expect("the shape is fine");
    let error = input.tile(Vec2::ZERO, Vec2::splat(3.0)).expect_err("a NaN height");
    assert_eq!(error.code, invalid);
    let error = input.tile(Vec2::new(1.0, 0.0), Vec2::ZERO).expect_err("a region with min past max");
    assert_eq!(error.code, invalid);
}

#[test]
fn more_triangles_than_the_cap_are_refused_too_large_before_anything_is_read() {
    let one = [Vec3::ZERO];
    let indices = vec![0u32; (NAV_INPUT_TRIANGLES_MAX + 1) * 3];
    let mut input = seeded();
    let before = input.clone();
    let mut error = None;
    let held = peak_bytes(|| error = input.add_triangles(&one, &indices, NavArea::WALK).err());
    let error = error.expect("refused");
    assert_eq!(error.code, NavErrorCode::TooLarge, "{}", error.detail);
    assert_eq!(input, before, "unchanged");
    assert!(held < 1024, "the refusal allocates only its message, {held} B");
    // The cap counts what the input already holds.
    let at_cap = vec![0u32; (NAV_INPUT_TRIANGLES_MAX - 2) * 3];
    let mut input = NavInput::new();
    input.add_triangles(&one, &at_cap, NavArea::WALK).expect("under the cap");
    let (vertices, quad_indices) = quad();
    let mut extra = quad_indices.clone();
    extra.extend([0, 1, 2]);
    let error = input.add_triangles(&vertices, &extra, NavArea::WALK).expect_err("over the cap together");
    assert_eq!(error.code, NavErrorCode::TooLarge);
    assert_eq!(input.triangle_count(), NAV_INPUT_TRIANGLES_MAX - 2);
    input.add_triangles(&vertices, &quad_indices, NavArea::WALK).expect("exactly at the cap");
    assert_eq!(input.triangle_count(), NAV_INPUT_TRIANGLES_MAX);
}

#[test]
fn the_wire_spellings_are_the_designs() {
    assert_eq!(NavErrorCode::InputInvalid.wire(), "nav-input-invalid");
    assert_eq!(NavErrorCode::TooLarge.wire(), "nav-too-large");
    assert_eq!(NavErrorCode::ALL, [NavErrorCode::InputInvalid, NavErrorCode::TooLarge]);
}

// ---- Red row 2: a terrain window is the matching slice of the whole triangulation ----

#[test]
fn the_window_of_tile_1_2_is_the_matching_slice_of_the_whole_triangulation() {
    let samples = (97u32, 129u32);
    let terrain = HeightGrid::from_fn(samples, [-3.5, 2.25], 0.5, |x, z| 0.3 * x - 0.2 * z + 0.01 * x * z).expect("terrain");
    let cells_across = (samples.0 - 1) as usize;
    let whole = terrain_cells(&terrain, Vec2::splat(-1e6), Vec2::splat(1e6));
    assert_eq!((whole.x.clone(), whole.z.clone()), (0..samples.0 - 1, 0..samples.1 - 1), "the whole field");
    let full = triangulate_cells(&terrain, &whole).expect("full");
    assert_eq!(full.len(), cells_across * (samples.1 - 1) as usize * 2);

    let (min, max) = tile_region([1, 2], 16.0, 1.5).expect("region");
    assert_eq!((min, max), (Vec2::new(14.5, 30.5), Vec2::new(33.5, 49.5)), "tile (1, 2) of 16 m plus a 1.5 m border");
    let window = terrain_cells(&terrain, min, max);
    assert!(!window.x.is_empty() && !window.z.is_empty());
    assert!(window.x.end < samples.0 - 1 || window.z.end < samples.1 - 1, "a window, not the whole field");
    let got = triangulate_cells(&terrain, &window).expect("window");
    let mut want = Vec::new();
    for z in window.z.clone() {
        let row = z as usize * cells_across;
        want.extend_from_slice(&full[(row + window.x.start as usize) * 2..(row + window.x.end as usize) * 2]);
    }
    let bits = |triangles: &[[Vec3; 3]]| triangles.iter().flat_map(|t| t.iter().flat_map(|v| v.to_array().map(f32::to_bits))).collect::<Vec<u32>>();
    assert_eq!(bits(&got), bits(&want), "the window equals its slice bit for bit");
    // The window covers the region: every cell overlapping it, and the corners use the field's
    // own heights, never re-sampled.
    let first = got[0][0];
    assert!(first.x <= min.x && first.z <= min.y, "the window starts at or before the region");
    let x = window.x.start;
    let z = window.z.start;
    assert_eq!(first.y.to_bits(), terrain.sample(x, z).to_bits());
    let tile = NavInput::new().with_terrain(Arc::new(terrain), NavArea::GRASS).and_then(|input| input.tile(min, max)).expect("tile");
    assert_eq!(bits(&tile.triangles), bits(&want), "a tile's terrain triangles are its window");
    assert!(tile.areas.iter().all(|&area| area == NavArea::GRASS));
}

// ---- Acceptance: a 2049² terrain, tile by tile, under 8 MB of input triangles ----

#[test]
fn a_2049_squared_terrain_gathered_per_tile_never_holds_8_mb_of_input_triangles() {
    let terrain = HeightGrid::from_fn((2049, 2049), [-1024.0, -1024.0], 1.0, |x, z| 2.0 * glam::Vec2::from_angle(0.01 * x).y + 0.002 * z).expect("terrain");
    let input = NavInput::new().with_terrain(Arc::new(terrain), NavArea::WALK).expect("input");
    let (tile, border) = (32.0, 2.0);
    let mut most_triangles = 0;
    let mut total = 0usize;
    let mut tiles = 0;
    let held = peak_bytes(|| {
        for z in -32..32 {
            for x in -32..32 {
                let (min, max) = tile_region([x, z], tile, border).expect("region");
                let gathered = input.tile(min, max).expect("tile");
                most_triangles = most_triangles.max(gathered.triangles.len());
                total += gathered.triangles.len();
                tiles += 1;
            }
        }
    });
    let whole = 2048 * 2048 * 2 * TRIANGLE_BYTES;
    println!(
        "{tiles} tiles: at most {most_triangles} triangles ({} B) in one tile, {held} B peak live while gathering, {total} triangles in all; the whole field at once would be {whole} B",
        most_triangles * TRIANGLE_BYTES
    );
    assert_eq!(tiles, 4096);
    assert!(total >= 2048 * 2048 * 2, "every cell is in some tile");
    assert!(most_triangles * TRIANGLE_BYTES < TILE_INPUT_LIMIT, "triangle count x 36 B under 8 MB");
    assert!(held < TILE_INPUT_LIMIT, "{held} B live at once, over 8 MB");
}

// ---- Soups per tile, bounds, boxes, slope and volumes ----

#[test]
fn a_tile_takes_the_soup_triangles_whose_bounds_overlap_it_in_input_order() {
    let mut vertices = Vec::new();
    let mut indices = Vec::new();
    for k in 0..10u32 {
        let x = k as f32 * 10.0;
        vertices.extend([Vec3::new(x, 0.0, 0.0), Vec3::new(x, 0.0, 2.0), Vec3::new(x + 2.0, 0.0, 0.0)]);
        indices.extend([3 * k, 3 * k + 1, 3 * k + 2]);
    }
    let input = NavInput::new().with_triangles(&vertices, &indices, NavArea::ROAD).expect("input");
    let tile = input.tile(Vec2::new(19.0, -1.0), Vec2::new(41.0, 1.0)).expect("tile");
    let starts: Vec<f32> = tile.triangles.iter().map(|t| t[0].x).collect();
    assert_eq!(starts, vec![20.0, 30.0, 40.0], "the three overlapping triangles, in input order");
    assert!(tile.areas.iter().all(|&area| area == NavArea::ROAD));
    let touching = input.tile(Vec2::new(12.0, 0.0), Vec2::new(18.0, 1.0)).expect("tile");
    assert_eq!(touching.triangles.len(), 1, "a triangle whose bounds touch the region edge is in (Recast clips)");
    let empty = input.tile(Vec2::new(200.0, 0.0), Vec2::new(210.0, 1.0)).expect("tile");
    assert!(empty.triangles.is_empty());

    let bounded = input.clone().with_bounds(Vec3::new(-1.0, -1.0, -1.0), Vec3::new(25.0, 1.0, 3.0)).expect("bounds");
    let tile = bounded.tile(Vec2::new(-100.0, -100.0), Vec2::new(100.0, 100.0)).expect("tile");
    assert_eq!(tile.triangles.len(), 3, "bounds cut the triangles outside them");
    let below = input.clone().with_bounds(Vec3::new(-100.0, 5.0, -100.0), Vec3::new(100.0, 9.0, 100.0)).expect("bounds");
    assert!(below.tile(Vec2::splat(-100.0), Vec2::splat(100.0)).expect("tile").triangles.is_empty(), "and those under them");
    assert_eq!(input.bounds(), Some((Vec3::new(0.0, 0.0, 0.0), Vec3::new(92.0, 0.0, 2.0))), "the input's own bounds");
    assert_eq!(bounded.bounds(), Some((Vec3::new(-1.0, -1.0, -1.0), Vec3::new(25.0, 1.0, 3.0))));
    assert_eq!(NavInput::new().bounds(), None);
}

#[test]
fn a_mesh_is_placed_and_a_box_walks_on_its_top_with_recast_winding() {
    let (vertices, indices) = quad();
    let place = Mat4::from_scale_rotation_translation(Vec3::splat(2.0), Quat::from_rotation_y(0.5), Vec3::new(10.0, 1.0, -3.0));
    let input = NavInput::new().with_mesh(&vertices, &indices, place, NavArea::WALK).expect("mesh");
    let tile = input.tile(Vec2::splat(-100.0), Vec2::splat(100.0)).expect("tile");
    let want: Vec<Vec3> = indices.iter().map(|&i| place.transform_point3(vertices[i as usize])).collect();
    let got: Vec<Vec3> = tile.triangles.iter().flatten().copied().collect();
    assert_eq!(got, want, "the placed corners");

    // A mirrored box still faces up on top: a negative determinant flips the winding back.
    for transform in [Mat4::from_translation(Vec3::new(0.0, 0.5, 0.0)), Mat4::from_scale(Vec3::new(-3.0, 1.0, 2.0))] {
        let input = NavInput::new().with_box(transform, NavArea::DOOR).expect("box");
        assert_eq!(input.triangle_count(), 12);
        let mut tile = input.tile(Vec2::splat(-10.0), Vec2::splat(10.0)).expect("tile");
        tile.clear_steep(45.0).expect("slope");
        let walkable: Vec<&[Vec3; 3]> = tile.triangles.iter().zip(&tile.areas).filter(|(_, area)| **area != NavArea::NONE).map(|(t, _)| t).collect();
        assert_eq!(walkable.len(), 2, "only the top face is walkable");
        let top = transform.transform_point3(Vec3::new(0.0, 0.5, 0.0)).y;
        assert!(walkable.iter().all(|t| t.iter().all(|v| v.y == top)), "and it is the top");
    }
}

#[test]
fn the_walkable_slope_rule_is_recasts() {
    // Recast: a triangle is walkable when its unit normal's y is above cos(slope), with the
    // normal of (v1 - v0) x (v2 - v0).
    let ramp = |rise: f32| [Vec3::ZERO, Vec3::new(0.0, 0.0, 1.0), Vec3::new(1.0, rise, 0.0)];
    let mut tile = TileInput { triangles: vec![ramp(0.0), ramp(0.9), ramp(1.1), [Vec3::ZERO, Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.0, 0.0, 1.0)], [Vec3::ZERO; 3]], areas: vec![NavArea::WALK; 5], volumes: Vec::new() };
    tile.clear_steep(45.0).expect("slope");
    assert_eq!(tile.areas, vec![NavArea::WALK, NavArea::WALK, NavArea::NONE, NavArea::NONE, NavArea::NONE], "flat, 42°, 48°, facing down, degenerate");
    for slope in [0.0, -1.0, 90.5, f32::NAN] {
        let error = tile.clear_steep(slope).expect_err("a slope outside (0, 90]");
        assert_eq!(error.code, NavErrorCode::InputInvalid);
    }
}

#[test]
fn an_area_volume_holds_points_inside_its_prism_and_a_tile_names_the_volumes_it_overlaps() {
    let outline = [Vec2::new(0.0, 0.0), Vec2::new(4.0, 0.0), Vec2::new(4.0, 4.0), Vec2::new(0.0, 4.0)];
    let volume = AreaVolume::new(&outline, 1.0, 3.0, NavArea::WATER).expect("volume");
    assert!(volume.contains(Vec3::new(2.0, 2.0, 2.0)));
    assert!(!volume.contains(Vec3::new(2.0, 3.5, 2.0)), "above");
    assert!(!volume.contains(Vec3::new(2.0, 0.5, 2.0)), "below");
    assert!(!volume.contains(Vec3::new(5.0, 2.0, 2.0)), "outside the outline");
    assert_eq!(volume.area(), NavArea::WATER);
    let input = NavInput::new()
        .with_area_volume(&outline, 1.0, 3.0, NavArea::WATER)
        .and_then(|input| input.with_area_volume(&[Vec2::new(20.0, 0.0), Vec2::new(22.0, 0.0), Vec2::new(21.0, 2.0)], 0.0, 1.0, NavArea::DOOR))
        .expect("volumes");
    assert_eq!(input.volumes().len(), 2);
    assert_eq!(input.tile(Vec2::new(-1.0, -1.0), Vec2::new(10.0, 10.0)).expect("tile").volumes, vec![0]);
    assert_eq!(input.tile(Vec2::new(-1.0, -1.0), Vec2::new(30.0, 10.0)).expect("tile").volumes, vec![0, 1]);
}

#[test]
fn areas_are_the_designs() {
    let named = [NavArea::NONE, NavArea::WALK, NavArea::ROAD, NavArea::GRASS, NavArea::WATER, NavArea::DOOR];
    let raws: Vec<u8> = named.iter().map(|area| area.raw()).collect();
    assert_eq!(raws, vec![0, 1, 2, 3, 4, 5]);
    assert_eq!(NavArea::custom(7), None);
    assert_eq!(NavArea::custom(8).map(NavArea::raw), Some(8));
    assert_eq!(NavArea::custom(62).map(NavArea::raw), Some(62));
    assert_eq!(NavArea::custom(63), None);
}
