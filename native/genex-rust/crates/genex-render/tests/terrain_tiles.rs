//! Multi-tile terrain (game systems STR-22, `genex_render::terrain`): A.7's quadtree and morph per
//! tile under one set of world ranges and one height quantization, so vertices on a border two
//! tiles share land on the same bits; a missing tile draws its overview window (coarse far away,
//! full near) with its loaded neighbours' border samples, so it leaves no hole; and a dolly over a
//! 4x4-tile world moves the surface without a one-frame pop. CPU rows are the vertex shader's twin;
//! the GPU rows (`#[ignore]`d, every name contains `metal`) build the tiles' groups over the atlas:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test terrain_tiles -- --include-ignored

use std::collections::BTreeSet;

use genex_render::device_class::FormFactor;
use genex_render::settings::QualityPreset;
use genex_render::terrain::gpu::{maps, terrain_row, tile_terrain_row};
use genex_render::terrain::{
    Heightfield, MAX_TERRAIN_TILES, MOBILE_LOW_TILE_SAMPLES_MAX, TERRAIN_GRID, TerrainDesc, TerrainLayer, TerrainLod, TerrainTiles, TerrainTiling, TerrainTree, TileRow, TileSource,
    TiledFrame, tile_samples_cap,
};
use genex_render::{RenderCode, RenderError};

/// FNV-1a over 32-bit words.
fn digest(words: impl IntoIterator<Item = u32>) -> u64 {
    words.into_iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, word| {
        word.to_le_bytes().iter().fold(hash, |h, byte| (h ^ u64::from(*byte)).wrapping_mul(0x0100_0000_01b3))
    })
}

fn single_hills() -> Heightfield {
    let (samples, spacing) = (257, 0.5);
    let half = (samples - 1) as f32 * spacing * 0.5;
    Heightfield::from_fn((samples, samples), [-half, -half], spacing, |x, z| 6.0 * libm::sinf(x * 0.045) * libm::cosf(z * 0.06) + 0.4 * libm::sinf(x * 1.7 + z * 2.3))
        .expect("height field")
}

#[test]
fn the_single_tile_path_keeps_a7s_bytes() {
    let heights = single_hills();
    let tree = TerrainTree::new(&heights);
    let desc = TerrainDesc::new(heights.clone(), TerrainLayer::flat([0.4, 0.5, 0.3]));
    let mut words = maps(&desc);
    for detail in [1.0, 1.25, 2.0] {
        let lod = TerrainLod::new(&tree, detail);
        words.extend(lod.ranges.iter().map(|r| r.to_bits()));
        words.extend(bytemuck::cast_slice::<_, u32>(&[terrain_row(&desc, &lod)]).iter().copied());
        for camera in [[-90.0, 1.7, -70.0], [0.0, 6.0, 3.3], [12.9, 25.0, 48.0], [140.0, 80.0, 101.0]] {
            for row in tree.select(&lod, camera) {
                words.extend(row.gpu());
                for (gx, gz) in [(0, 0), (1, 0), (3, 5), (row.quads, row.quads)] {
                    words.extend(tree.vertex(&heights, &lod, row, gx, gz, camera).map(f32::to_bits));
                }
            }
        }
    }
    assert_eq!(digest(words), 13_710_602_647_394_775_842, "A.7's maps, ranges, terrain rows, selection and morph");
}

// --- A 4x4-tile world ---------------------------------------------------------------------------

/// Tiles of 129 samples 0.5 m apart: 64 m tiles, a 256 m world from (0, 0).
const SAMPLES: u32 = 129;
const SPACING: f32 = 0.5;
const RANGE: (f32, f32) = (-12.0, 12.0);

/// Rolling hills with 0.4 m of sample-scale hash on top (any pop or crack shows), a function of
/// the position alone, so tiles sharing a sample compute the same height.
fn ground(x: f32, z: f32) -> f32 {
    let hills = 6.0 * libm::sinf(x * 0.045) * libm::cosf(z * 0.06) + 2.5 * libm::sinf(x * 0.13 + z * 0.09);
    hills + 0.4 * hash(x, z)
}

fn hash(x: f32, z: f32) -> f32 {
    let bits = (x * 7.31).to_bits().wrapping_mul(0x9e37_79b9) ^ (z * 3.17).to_bits().wrapping_mul(0x85eb_ca6b);
    let mixed = bits ^ (bits >> 15);
    (mixed.wrapping_mul(0x2c1b_3c6d) >> 8) as f32 / (1u32 << 24) as f32
}

fn tiling() -> TerrainTiling {
    TerrainTiling::new((4, 4), SAMPLES, [0.0, 0.0], SPACING, RANGE).expect("tiling")
}

/// The 4x4 world with every tile loaded except `missing` (slot = tile index).
fn world(missing: &[[u32; 2]]) -> TerrainTiles {
    let tiling = tiling();
    let overview = tiling.overview_from_fn(ground).expect("overview");
    let mut tiles = TerrainTiles::new(tiling.clone(), overview).expect("tiles");
    for tz in 0..4 {
        for tx in 0..4 {
            if missing.contains(&[tx, tz]) {
                continue;
            }
            let heights = tiling.tile_heights([tx, tz], ground).expect("tile");
            tiles.insert([tx, tz], tz * 4 + tx, heights).expect("insert");
        }
    }
    tiles
}

/// A grid of camera positions over and around the world at three heights.
fn cameras() -> Vec<[f32; 3]> {
    let mut out = Vec::new();
    for i in 0..13 {
        for j in 0..13 {
            let (x, z) = (-20.0 + i as f32 * 24.7, -20.0 + j as f32 * 24.3);
            out.push([x, [1.7, 9.0, 40.0][(i + j) % 3], z]);
        }
    }
    out
}

/// A row's grid step on the world's sample grid.
fn global_step(tiles: &TerrainTiles, row: TileRow) -> u32 {
    let rect = tiles.row_rect(row);
    (rect[2] - rect[0]) / row.row.quads
}

/// Pairs of rows in different tiles sharing an edge of positive length: (a, b, axis, at, from, to).
fn border_pairs(tiles: &TerrainTiles, rows: &[TileRow]) -> Vec<(usize, usize, usize, u32, u32, u32)> {
    let quads = SAMPLES - 1;
    let rects: Vec<[u32; 4]> = rows.iter().map(|row| tiles.row_rect(*row)).collect();
    let on_border: Vec<usize> = (0..rows.len()).filter(|i| rects[*i].iter().any(|v| v % quads == 0)).collect();
    let mut out = Vec::new();
    for (n, &a) in on_border.iter().enumerate() {
        for &b in &on_border[n + 1..] {
            if rows[a].tile == rows[b].tile {
                continue;
            }
            let (p, q) = (rects[a], rects[b]);
            for axis in 0..2 {
                let other = 1 - axis;
                let touching = p[axis + 2] == q[axis] || q[axis + 2] == p[axis];
                let (from, to) = (p[other].max(q[other]), p[other + 2].min(q[other + 2]));
                if touching && to > from {
                    let at = if p[axis + 2] == q[axis] { q[axis] } else { p[axis] };
                    out.push((a, b, axis, at, from, to));
                }
            }
        }
    }
    out
}

/// A row's morphed vertices on its edge at world sample `at` across `axis` whose unmorphed sample
/// lies in from..=to, as bits, with each odd vertex's morph.
fn edge_vertices(tiles: &TerrainTiles, lod: &TerrainLod, row: TileRow, (axis, at, from, to): (usize, u32, u32, u32), camera: [f32; 3]) -> (BTreeSet<[u32; 3]>, Vec<f32>) {
    let rect = tiles.row_rect(row);
    let step = global_step(tiles, row);
    let index_at = (at - rect[axis]) / step;
    let (mut points, mut morphs) = (BTreeSet::new(), Vec::new());
    for k in 0..=row.row.quads {
        let along = rect[1 - axis] + k * step;
        if along < from || along > to {
            continue;
        }
        let (gx, gz) = if axis == 0 { (index_at, k) } else { (k, index_at) };
        let v = tiles.vertex(lod, row, gx, gz, camera);
        points.insert(v.map(f32::to_bits));
        if k % 2 == 1 {
            let tiling = tiles.tiling();
            let origin = tiling.tile_origin(row.tile)[1 - axis];
            let local = along - row.tile[1 - axis] * (SAMPLES - 1);
            let unmorphed = origin + local as f32 * SPACING;
            let moved = unmorphed - v[if axis == 0 { 2 } else { 0 }];
            morphs.push(moved / (step as f32 * SPACING));
        }
    }
    (points, morphs)
}

#[test]
fn vertices_on_a_shared_tile_border_coincide_bit_for_bit_at_every_morph_value() {
    for missing in [&[][..], &[[1, 1], [2, 1], [3, 3]][..]] {
        let mut tiles = world(missing);
        let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
        let (mut same_level, mut one_apart, mut morph_bins) = (0, 0, [0u32; 10]);
        for camera in cameras() {
            tiles.prepare(&lod, camera);
            let rows = tiles.select(&lod, camera);
            for (a, b, axis, at, from, to) in border_pairs(&tiles, &rows) {
                let (ra, rb) = (rows[a], rows[b]);
                let (la, lb) = (tiles.row_level(ra), tiles.row_level(rb));
                assert!(la.abs_diff(lb) <= 1, "camera {camera:?}: {ra:?} (level {la}) beside {rb:?} (level {lb})");
                let (pa, ka) = edge_vertices(&tiles, &lod, ra, (axis, at, from, to), camera);
                let (pb, kb) = edge_vertices(&tiles, &lod, rb, (axis, at, from, to), camera);
                assert_eq!(pa, pb, "camera {camera:?} missing {missing:?}: the border of {ra:?} and {rb:?} at {at} ({from}..{to})");
                if la == lb {
                    same_level += 1;
                    for k in ka.iter().chain(&kb) {
                        morph_bins[((k * 10.0) as usize).min(9)] += 1;
                    }
                } else {
                    one_apart += 1;
                }
            }
        }
        println!("missing {missing:?}: {same_level} same-level and {one_apart} one-apart border pairs, border morphs by tenth {morph_bins:?}");
        assert!(same_level > 500 && one_apart > 50, "missing {missing:?}: {same_level} same-level and {one_apart} one-apart border pairs");
        assert!(morph_bins.iter().all(|&n| n > 0), "missing {missing:?}: border morphs reach every tenth of 0..1: {morph_bins:?}");
    }
}

#[test]
fn every_quad_of_the_world_is_drawn_once_with_tiles_missing() {
    let mut tiles = world(&[[0, 0], [2, 1], [3, 2]]);
    let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
    let side = 4 * (SAMPLES - 1);
    for camera in cameras() {
        tiles.prepare(&lod, camera);
        let mut covered = vec![0u8; (side * side) as usize];
        for row in tiles.select(&lod, camera) {
            let r = tiles.row_rect(row);
            for z in r[1]..r[3] {
                for x in r[0]..r[2] {
                    covered[(z * side + x) as usize] += 1;
                }
            }
        }
        assert!(covered.iter().all(|&c| c == 1), "camera {camera:?}: every quad drawn once");
    }
}

// --- A missing tile leaves no hole (pixel coverage) ----------------------------------------------

/// A pinhole camera at `eye` looking at `target` with a vertical field of `fovy` radians.
struct Pinhole {
    eye: [f32; 3],
    right: [f32; 3],
    up: [f32; 3],
    forward: [f32; 3],
    scale: f32,
}

fn normalize(v: [f32; 3]) -> [f32; 3] {
    let l = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    [v[0] / l, v[1] / l, v[2] / l]
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

impl Pinhole {
    fn new(eye: [f32; 3], target: [f32; 3], fovy: f32) -> Pinhole {
        let forward = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
        let right = normalize(cross(forward, [0.0, 1.0, 0.0]));
        let up = cross(right, forward);
        Pinhole { eye, right, up, forward, scale: 1.0 / libm::tanf(fovy * 0.5) }
    }

    /// Per pixel of a `w` x `h` image, whether its ray meets the plane y = 0 at least `margin`
    /// metres inside the 256 m world.
    fn inside_world(&self, (w, h): (usize, usize), margin: f32) -> Vec<bool> {
        let aspect = w as f32 / h as f32;
        let mut out = Vec::with_capacity(w * h);
        for py in 0..h {
            for px in 0..w {
                let (u, v) = (((px as f32 + 0.5) / w as f32) * 2.0 - 1.0, 1.0 - ((py as f32 + 0.5) / h as f32) * 2.0);
                let (a, b) = (u * aspect / self.scale, v / self.scale);
                let dir = [0, 1, 2].map(|i| self.forward[i] + self.right[i] * a + self.up[i] * b);
                let t = -self.eye[1] / dir[1];
                let (x, z) = (self.eye[0] + dir[0] * t, self.eye[2] + dir[2] * t);
                let within = |c: f32| c > margin && c < 256.0 - margin;
                out.push(dir[1] < 0.0 && within(x) && within(z));
            }
        }
        out
    }

    /// Pixel coordinates of `p` in a `w` x `h` image, None behind the camera.
    fn project(&self, p: [f32; 3], (w, h): (usize, usize)) -> Option<[f64; 2]> {
        let d = [p[0] - self.eye[0], p[1] - self.eye[1], p[2] - self.eye[2]];
        let z = dot(d, self.forward);
        if z < 0.1 {
            return None;
        }
        let aspect = w as f32 / h as f32;
        let (u, v) = (dot(d, self.right) / z * self.scale / aspect, dot(d, self.up) / z * self.scale);
        Some([f64::from((u * 0.5 + 0.5) * w as f32), f64::from((0.5 - v * 0.5) * h as f32)])
    }
}

/// Which pixel centres of a `w` x `h` image the rows' morphed triangles cover.
fn coverage(tiles: &TerrainTiles, lod: &TerrainLod, rows: &[TileRow], camera: &Pinhole, size: (usize, usize)) -> Vec<bool> {
    let mut covered = vec![false; size.0 * size.1];
    for row in rows {
        let at = |gx: u32, gz: u32| camera.project(tiles.vertex(lod, *row, gx, gz, camera.eye), size);
        for gz in 0..row.row.quads {
            for gx in 0..row.row.quads {
                let (Some(a), Some(b), Some(c), Some(d)) = (at(gx, gz), at(gx + 1, gz), at(gx, gz + 1), at(gx + 1, gz + 1)) else { continue };
                for tri in [[a, c, d], [a, d, b]] {
                    fill(&mut covered, tri, size);
                }
            }
        }
    }
    covered
}

/// Mark the pixel centres inside triangle `t` (either winding, edges included).
fn fill(covered: &mut [bool], t: [[f64; 2]; 3], (w, h): (usize, usize)) {
    let edge = |p: [f64; 2], q: [f64; 2], x: f64, y: f64| (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    let area = edge(t[0], t[1], t[2][0], t[2][1]);
    if area == 0.0 {
        return;
    }
    let (x0, x1) = (t.iter().map(|p| p[0]).fold(f64::INFINITY, f64::min), t.iter().map(|p| p[0]).fold(f64::NEG_INFINITY, f64::max));
    let (y0, y1) = (t.iter().map(|p| p[1]).fold(f64::INFINITY, f64::min), t.iter().map(|p| p[1]).fold(f64::NEG_INFINITY, f64::max));
    let (px0, px1) = ((x0 - 0.5).ceil().max(0.0) as usize, ((x1 - 0.5).floor().min(w as f64 - 1.0)).max(-1.0));
    let (py0, py1) = ((y0 - 0.5).ceil().max(0.0) as usize, ((y1 - 0.5).floor().min(h as f64 - 1.0)).max(-1.0));
    if px1 < 0.0 || py1 < 0.0 {
        return;
    }
    for py in py0..=py1 as usize {
        for px in px0..=px1 as usize {
            let (x, y) = (px as f64 + 0.5, py as f64 + 0.5);
            let e = [edge(t[0], t[1], x, y), edge(t[1], t[2], x, y), edge(t[2], t[0], x, y)];
            let inside = if area > 0.0 { e.iter().all(|v| *v >= 0.0) } else { e.iter().all(|v| *v <= 0.0) };
            if inside {
                covered[py * w + px] = true;
            }
        }
    }
}

#[test]
fn a_missing_tile_draws_its_overview_window_with_no_hole() {
    let missing = [2, 1];
    let size = (192, 108);
    for (eye, target, window_full) in [([150.0, 40.0, 30.0], [158.0, 0.0, 100.0], true), ([-90.0, 170.0, -90.0], [150.0, 0.0, 110.0], false)] {
        let mut tiles = world(&[missing]);
        let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
        tiles.prepare(&lod, eye);
        let window = tiles.ground(missing).expect("tile");
        assert_eq!((window.source(), window.is_coarse()), (TileSource::Overview, !window_full), "camera {eye:?}");
        let camera = Pinhole::new(eye, target, 0.5);
        let rows = tiles.select(&lod, eye);
        assert!(rows.iter().any(|row| row.tile == missing), "the missing tile draws its window");
        let covered = coverage(&tiles, &lod, &rows, &camera, size);
        // The pixels the missing tile's own rows cover: it is in view.
        let own: Vec<TileRow> = rows.iter().copied().filter(|row| row.tile == missing).collect();
        let own_pixels = coverage(&tiles, &lod, &own, &camera, size).iter().filter(|c| **c).count();
        assert!(own_pixels > 300, "camera {eye:?}: the missing tile covers {own_pixels} pixels");
        // Pixels whose ray meets the ground plane well inside the world (24 m in from its edge:
        // more than the hills move a far ray's hit) must see ground.
        let inside = camera.inside_world(size, 24.0);
        let holes = covered.iter().zip(&inside).filter(|(c, i)| **i && !**c).count();
        assert!(inside.iter().filter(|i| **i).count() > size.0 * size.1 / 3, "camera {eye:?}: the world fills the view");
        assert_eq!(holes, 0, "camera {eye:?}: every pixel over the world sees ground ({holes} holes)");
        // Without its rows the same view has a hole where the tile is: the row can see one.
        let others: Vec<TileRow> = rows.iter().copied().filter(|row| row.tile != missing).collect();
        let without = coverage(&tiles, &lod, &others, &camera, size).iter().zip(&inside).filter(|(c, i)| **i && !**c).count();
        assert!(without >= own_pixels / 2, "camera {eye:?}: dropping the window leaves {without} holes");
    }
}

#[test]
fn the_coarse_and_full_windows_draw_the_same_surface_where_the_top_node_does_not_split() {
    let mut tiles = world(&[[1, 2]]);
    let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
    let far = [-300.0, 200.0, -300.0];
    tiles.prepare(&lod, far);
    let coarse: Vec<[u32; 3]> = window_top_vertices(&tiles, &lod, far);
    assert!(tiles.ground([1, 2]).expect("tile").is_coarse());
    // Make the full window (a near camera), then measure it from the far camera again.
    tiles.prepare(&lod, [96.0, 5.0, 160.0]);
    assert!(!tiles.ground([1, 2]).expect("tile").is_coarse());
    assert_eq!(window_top_vertices(&tiles, &lod, far), coarse, "the full window's top row is the coarse window, bit for bit");
}

fn window_top_vertices(tiles: &TerrainTiles, lod: &TerrainLod, camera: [f32; 3]) -> Vec<[u32; 3]> {
    let rows: Vec<TileRow> = tiles.select(lod, camera).into_iter().filter(|row| row.tile == [1, 2]).collect();
    assert_eq!(rows.len(), 1, "one top row far away");
    let mut out = Vec::new();
    for gz in 0..=TERRAIN_GRID {
        for gx in 0..=TERRAIN_GRID {
            out.push(tiles.vertex(lod, rows[0], gx, gz, camera).map(f32::to_bits));
        }
    }
    out
}

// --- A dolly over the 4x4-tile world --------------------------------------------------------------

/// The surface height at world (x, z) from the drawn rows' morphed triangles.
fn surface_height(tiles: &TerrainTiles, lod: &TerrainLod, rows: &[TileRow], camera: [f32; 3], (x, z): (f32, f32)) -> Option<f32> {
    let tile = tiles.tiling().tile_at(x, z);
    let ground = tiles.ground(tile)?;
    let (origin, spacing) = (ground.heights().origin(), ground.heights().spacing());
    let (u, v) = ((x - origin[0]) / spacing, (z - origin[1]) / spacing);
    for row in rows.iter().filter(|row| row.tile == tile) {
        let span = row.row.span() as f32;
        let (ru, rv) = (u - row.row.texel[0] as f32, v - row.row.texel[1] as f32);
        if ru < 0.0 || rv < 0.0 || ru > span || rv > span {
            continue;
        }
        let step = (1u32 << row.row.lod) as f32;
        let (qu, qv) = ((ru / step) as i32, (rv / step) as i32);
        for gz in (qv - 1).max(0)..=(qv + 1).min(row.row.quads as i32 - 1) {
            for gx in (qu - 1).max(0)..=(qu + 1).min(row.row.quads as i32 - 1) {
                let at = |dx: u32, dz: u32| tiles.vertex(lod, *row, gx as u32 + dx, gz as u32 + dz, camera);
                let (a, b, c, d) = (at(0, 0), at(1, 0), at(0, 1), at(1, 1));
                for tri in [[a, c, d], [a, d, b]] {
                    if let Some(h) = barycentric_height(tri, x, z) {
                        return Some(h);
                    }
                }
            }
        }
    }
    None
}

fn barycentric_height(t: [[f32; 3]; 3], x: f32, z: f32) -> Option<f32> {
    let (ax, az, bx, bz, cx, cz) = (t[0][0], t[0][2], t[1][0], t[1][2], t[2][0], t[2][2]);
    let det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if det.abs() < 1e-9 {
        return None;
    }
    let l1 = ((bz - cz) * (x - cx) + (cx - bx) * (z - cz)) / det;
    let l2 = ((cz - az) * (x - cx) + (ax - cx) * (z - cz)) / det;
    let l3 = 1.0 - l1 - l2;
    let eps = -1e-5;
    (l1 >= eps && l2 >= eps && l3 >= eps).then(|| l1 * t[0][1] + l2 * t[1][1] + l3 * t[2][1])
}

/// One dolly step's rows and the surface under the probes.
type Frame = (Vec<TileRow>, Vec<f32>);

/// A dolly of 0.25 m steps along x = 101 from outside the world across all four tile rows at
/// walking height + 3 m: the largest one-step change of the surface under 48 probes, and how often
/// the rows changed.
fn dolly(missing: &[[u32; 2]]) -> (f32, u32) {
    let mut tiles = world(missing);
    let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
    let probes: Vec<(f32, f32)> = (0..48).map(|i| (6.0 + (i % 8) as f32 * 33.1, 5.0 + (i / 8) as f32 * 41.3)).collect();
    let mut last: Option<Frame> = None;
    let (mut worst, mut switches) = (0.0_f32, 0_u32);
    for i in 0..1200 {
        let z = -30.0 + i as f32 * 0.25;
        let at = [101.0, tiles.height(101.0, z.clamp(0.0, 256.0)).max(0.0) + 3.0, z];
        tiles.prepare(&lod, at);
        let rows = tiles.select(&lod, at);
        let surface: Vec<f32> = probes.iter().map(|p| surface_height(&tiles, &lod, &rows, at, *p).expect("on the terrain")).collect();
        if let Some((rows_before, before)) = &last {
            switches += u32::from(*rows_before != rows);
            for (now, then) in surface.iter().zip(before) {
                worst = worst.max((now - then).abs());
            }
        }
        last = Some((rows, surface));
    }
    (worst, switches)
}

#[test]
fn a_dolly_over_a_4x4_tile_world_has_no_one_frame_pop() {
    let (worst, switches) = dolly(&[]);
    println!("4x4 dolly, every tile loaded: largest one-step change {worst} m, {switches} row changes over 1200 steps");
    assert!(switches >= 40, "the dolly crosses level changes in several tiles: {switches}");
    // A pop moves a probe by the difference between two levels' surfaces (decimetres here); the
    // morph moves it by at most a step's share of the band times a quad's rise.
    assert!(worst < 0.02, "the largest one-step change of the surface is {worst} m");
}

#[test]
fn a_dolly_past_missing_tiles_swaps_their_windows_without_a_pop() {
    let (worst, switches) = dolly(&[[1, 0], [1, 2], [2, 3]]);
    println!("4x4 dolly, three tiles missing: largest one-step change {worst} m, {switches} row changes over 1200 steps");
    assert!(switches >= 40, "{switches} row changes");
    assert!(worst < 0.02, "the largest one-step change of the surface is {worst} m");
}

// --- World ranges and quantization ----------------------------------------------------------------

#[test]
fn the_world_ranges_cover_every_tile_and_do_not_move_when_tiles_load() {
    let tiling = tiling();
    let lod = TerrainLod::tiled(&tiling, 1.0);
    assert_eq!(lod.lods, 4, "128 quads at 16 a node: levels of 16, 32, 64 and 128");
    assert!(lod.ranges[3].is_infinite() && lod.ranges[2].is_finite(), "the top level is always selected");
    let empty = world(&[[0, 0], [1, 1], [2, 2], [3, 3]]);
    let full = world(&[]);
    for tz in 0..4 {
        for tx in 0..4 {
            let tree = full.ground([tx, tz]).expect("tile").tree();
            assert!(lod.ranges[0] >= TerrainLod::range0(tree), "tile ({tx}, {tz})'s own least range fits under the world's");
        }
    }
    assert_eq!(TerrainLod::tiled(empty.tiling(), 1.0), TerrainLod::tiled(full.tiling(), 1.0));
    // Narrower tile ranges give shorter levels.
    let narrow = tiling.clone().with_tile_ranges(vec![(-9.5, 9.5); 16]).expect("ranges");
    assert!(TerrainLod::tiled(&narrow, 1.0).ranges[0] < lod.ranges[0]);
}

#[test]
fn tiles_share_the_worlds_quantization_so_border_samples_hold_the_same_bits() {
    let tiling = tiling();
    let a = tiling.tile_heights([0, 0], ground).expect("a");
    let b = tiling.tile_heights([1, 0], ground).expect("b");
    assert_eq!(a.quantization(), b.quantization());
    assert_eq!(tiling.tile_origin([1, 0])[0].to_bits(), (a.origin()[0] + (SAMPLES - 1) as f32 * SPACING).to_bits());
    for z in 0..SAMPLES {
        let (ea, wb) = (a.quantized()[(z * SAMPLES + SAMPLES - 1) as usize], b.quantized()[(z * SAMPLES) as usize]);
        assert_eq!(ea, wb, "row {z}: tile (0, 0)'s east column is tile (1, 0)'s west");
    }
    // Quantized over their own spans the two would disagree: the shared range is what holds them.
    let own_a = Heightfield::from_fn((SAMPLES, SAMPLES), a.origin(), SPACING, ground).expect("own a");
    let own_b = Heightfield::from_fn((SAMPLES, SAMPLES), b.origin(), SPACING, ground).expect("own b");
    let differs = (0..SAMPLES).any(|z| own_a.sample(SAMPLES - 1, z).to_bits() != own_b.sample(0, z).to_bits());
    assert!(differs, "per-tile quantization would crack the border");
}

#[test]
fn mobile_low_takes_tiles_of_at_most_129_samples_thinned_on_the_same_bits() {
    assert_eq!(tile_samples_cap(FormFactor::Mobile, QualityPreset::Low), MOBILE_LOW_TILE_SAMPLES_MAX);
    assert_eq!(MOBILE_LOW_TILE_SAMPLES_MAX, 129);
    for preset in [QualityPreset::Medium, QualityPreset::High] {
        assert!(tile_samples_cap(FormFactor::Mobile, preset) > 129);
    }
    assert!(tile_samples_cap(FormFactor::Desktop, QualityPreset::Low) > 129);
    let fine = TerrainTiling::new((2, 1), 257, [0.0, 0.0], 0.25, RANGE).expect("fine");
    let (a, b) = (fine.tile_heights([0, 0], ground).expect("a"), fine.tile_heights([1, 0], ground).expect("b"));
    let (ta, tb) = (a.decimate(1).expect("thin a"), b.decimate(1).expect("thin b"));
    assert_eq!((ta.samples(), ta.spacing(), ta.quantization()), ((129, 129), 0.5, a.quantization()));
    for z in 0..129 {
        assert_eq!(ta.quantized()[(z * 129 + 128) as usize], tb.quantized()[(z * 129) as usize], "thinned borders still agree");
        assert_eq!(ta.quantized()[(z * 129) as usize], a.quantized()[(2 * z * 257) as usize]);
    }
    let coarse = TerrainTiling::new((2, 1), 129, [0.0, 0.0], 0.5, RANGE).expect("coarse");
    let overview = coarse.overview_from_fn(ground).expect("overview");
    let mut tiles = TerrainTiles::new(coarse, overview).expect("tiles");
    tiles.insert([0, 0], 0, ta).expect("a thinned tile loads into the 129 tiling");
    tiles.insert([1, 0], 1, tb).expect("and its neighbour");
    assert_eq!(refused_code(Heightfield::from_fn((10, 10), [0.0; 2], 1.0, ground).expect("odd").decimate(1)), RenderCode::MeshInvalid);
}

// --- Hostile tiles and tilings --------------------------------------------------------------------

fn refused_code<T: std::fmt::Debug>(result: Result<T, RenderError>) -> RenderCode {
    result.expect_err("refused").code()
}

#[test]
fn hostile_tilings_are_refused_mesh_invalid() {
    let cases: [(&str, Result<TerrainTiling, RenderError>); 9] = [
        ("no tiles", TerrainTiling::new((0, 4), SAMPLES, [0.0; 2], SPACING, RANGE)),
        ("too many tiles", TerrainTiling::new((MAX_TERRAIN_TILES + 1, 1), SAMPLES, [0.0; 2], SPACING, RANGE)),
        ("not 16 x 2^k quads", TerrainTiling::new((4, 4), 100, [0.0; 2], SPACING, RANGE)),
        ("under one node", TerrainTiling::new((4, 4), 9, [0.0; 2], SPACING, RANGE)),
        ("past the sample cap", TerrainTiling::new((4, 4), 4097, [0.0; 2], SPACING, RANGE)),
        ("zero spacing", TerrainTiling::new((4, 4), SAMPLES, [0.0; 2], 0.0, RANGE)),
        ("NaN origin", TerrainTiling::new((4, 4), SAMPLES, [f32::NAN, 0.0], SPACING, RANGE)),
        ("reversed range", TerrainTiling::new((4, 4), SAMPLES, [0.0; 2], SPACING, (1.0, -1.0))),
        ("infinite range", TerrainTiling::new((4, 4), SAMPLES, [0.0; 2], SPACING, (f32::NEG_INFINITY, 1.0))),
    ];
    for (name, result) in cases {
        assert_eq!(refused_code(result), RenderCode::MeshInvalid, "{name}");
    }
    assert_eq!(refused_code(tiling().with_tile_ranges(vec![RANGE; 15])), RenderCode::MeshInvalid, "a range per tile");
    assert_eq!(refused_code(tiling().with_tile_ranges(vec![(-13.0, 0.0); 16])), RenderCode::MeshInvalid, "within the world's");
    let overview = tiling().overview_from_fn(ground).expect("overview");
    let other = Heightfield::from_fn(overview.samples(), [0.0; 2], 8.0, ground).expect("own quantization");
    assert_eq!(refused_code(TerrainTiles::new(tiling(), other)), RenderCode::MeshInvalid, "an overview on its own quantization");
    let small = Heightfield::from_fn_with_range((33, 33), [0.0; 2], 8.0, RANGE, ground).expect("small");
    assert_eq!(refused_code(TerrainTiles::new(tiling(), small)), RenderCode::MeshInvalid, "an overview of the wrong size");
    assert_eq!(refused_code(Heightfield::with_range((2, 2), [0.0; 2], 1.0, &[0.0, 1.0, 2.0, 13.0], RANGE)), RenderCode::MeshInvalid, "a height past the range");
}

#[test]
fn hostile_tiles_are_refused_with_nothing_changed() {
    let tiling = tiling();
    let mut tiles = world(&[[1, 1], [2, 1]]);
    let before = tiles.clone();
    let good = tiling.tile_heights([1, 1], ground).expect("tile");
    let shifted = Heightfield::from_fn_with_range((SAMPLES, SAMPLES), [64.25, 64.0], SPACING, RANGE, ground).expect("shifted");
    let own_range = Heightfield::from_fn((SAMPLES, SAMPLES), tiling.tile_origin([1, 1]), SPACING, ground).expect("own range");
    let small = Heightfield::from_fn_with_range((65, 65), tiling.tile_origin([1, 1]), 1.0, RANGE, ground).expect("small");
    // The right place and quantization, but a border sample its loaded neighbour (1, 0) disagrees on.
    let bumped = tiling.tile_heights([1, 1], |x, z| if z == 64.0 && x == 80.0 { ground(x, z) + 1.0 } else { ground(x, z) }).expect("bumped");
    let cases: [(&str, [u32; 2], Heightfield); 6] = [
        ("outside the tiling", [4, 0], good.clone()),
        ("another origin", [1, 1], shifted),
        ("its own quantization", [1, 1], own_range),
        ("another sample count", [1, 1], small),
        ("a border its neighbour disagrees on", [1, 1], bumped),
        ("another tile's place", [2, 1], good),
    ];
    for (name, tile, heights) in cases {
        assert_eq!(refused_code(tiles.insert(tile, 9, heights)), RenderCode::MeshInvalid, "{name}");
        assert_eq!(tiles, before, "{name}: nothing changed");
    }
    assert_eq!(tiles.remove([1, 1]), None, "a missing tile has no slot to free");
    assert_eq!(tiles.remove([0, 0]), Some(0), "a loaded tile frees its slot");
    assert_eq!(tiles.ground([0, 0]).expect("tile").source(), TileSource::Overview);
}

// --- The GPU rows ---------------------------------------------------------------------------------

#[test]
fn a_tiles_terrain_row_reads_its_slot() {
    let tiles = world(&[[3, 3]]);
    let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
    let layers = [TerrainLayer::flat([0.4, 0.5, 0.3])];
    let look = genex_render::terrain::TerrainLook::default();
    let loaded = tiles.ground([1, 2]).expect("tile");
    let at_zero = tile_terrain_row(loaded, &layers, look, &lod, 0);
    let base = 47_326 * 9;
    let in_slot = tile_terrain_row(loaded, &layers, look, &lod, base);
    assert_eq!(at_zero.counts[1], 0, "a group binding the tile's own maps reads from sample 0");
    assert_eq!(in_slot.counts[1], base * 2, "the heights' first sample is the slot's first word, two samples a word");
    assert_eq!(in_slot.size[2], at_zero.size[2] + base, "the control words move with the slot");
    let levels = in_slot.size[3] as usize;
    for k in 0..levels {
        assert_eq!(in_slot.normal_levels[k / 4][k % 4], at_zero.normal_levels[k / 4][k % 4] + base, "normal level {k}");
    }
    for k in levels..12 {
        assert_eq!(in_slot.normal_levels[k / 4][k % 4], 0, "unused level {k} stays 0");
    }
    assert_eq!(in_slot.origin[0].to_bits(), tiles.tiling().tile_origin([1, 2])[0].to_bits());
    assert_eq!(in_slot.morph[0], [lod.morph_constants(0)[0], lod.morph_constants(0)[1], 0.0, 0.0], "the world's ranges");
    // A coarse window's row is at the top level's spacing and never morphs.
    let window = tiles.ground([3, 3]).expect("window");
    assert!(window.is_coarse());
    let coarse = tile_terrain_row(window, &layers, look, &lod, 0);
    assert_eq!(coarse.origin[2], SPACING * 8.0);
    assert_eq!(coarse.morph[0], [1.0, 0.0, 0.0, 0.0]);
    // The single terrain's row is unchanged: counts.y is 0 there.
    let desc = TerrainDesc::new(single_hills(), layers[0]);
    let tree = TerrainTree::new(&desc.heights);
    assert_eq!(terrain_row(&desc, &TerrainLod::new(&tree, 1.0)).counts, [1, 0, 0, 0]);
}

#[test]
fn each_view_keeps_each_tiles_rows_in_its_frustum() {
    let mut tiles = world(&[[2, 2]]);
    let lod = TerrainLod::tiled(tiles.tiling(), 1.0);
    let camera = [128.0, 10.0, 128.0];
    tiles.prepare(&lod, camera);
    let mut half = [[0.0; 4]; 6];
    half[0] = [1.0, 0.0, 0.0, -128.0];
    let frame = TiledFrame::plan(&tiles, &lod, camera, &[half, [[0.0; 4]; 6]]);
    assert_eq!(frame.views.len(), 2);
    let all: u32 = frame.views[1].iter().map(|d| d.rows[1] + d.rows[3]).sum();
    assert_eq!(all, frame.selected, "view 1 keeps every selected row");
    assert_eq!(frame.views[1].len(), 16, "one draw per tile");
    for draw in &frame.views[0] {
        assert!(draw.tile[0] >= 1, "{draw:?}: the half-space x >= 128 keeps tiles from column 1 (its west edge touches)");
    }
    for draw in frame.views.iter().flatten() {
        let [first, full, quarters_first, quarters] = draw.rows;
        assert_eq!(quarters_first, first + full);
        for row in &frame.rows[first as usize..(first + full) as usize] {
            assert_eq!(row.quads, TERRAIN_GRID, "full rows first");
        }
        for row in &frame.rows[quarters_first as usize..(quarters_first + quarters) as usize] {
            assert_eq!(row.quads, TERRAIN_GRID / 2);
        }
        let expected = if draw.tile == [2, 2] { TileSource::Overview } else { TileSource::Slot(draw.tile[1] * 4 + draw.tile[0]) };
        assert_eq!(draw.source, expected, "the draw names its tile's slot");
    }
}

#[test]
#[allow(clippy::disallowed_types, reason = "an advisory cost row reads the wall clock; nothing depends on it")]
fn selecting_a_4x4_tile_world_is_cheap() {
    let mut tiles = world(&[]);
    let lod = TerrainLod::tiled(tiles.tiling(), 1.25);
    let started = std::time::Instant::now();
    let mut rows = 0;
    for camera in cameras() {
        tiles.prepare(&lod, camera);
        rows += TiledFrame::plan(&tiles, &lod, camera, &[[[0.0; 4]; 6]]).selected;
    }
    let per_frame = started.elapsed().as_secs_f64() * 1000.0 / cameras().len() as f64;
    println!("4x4 tiles of 129: {:.3} ms a frame to select and plan, {} rows a frame on average", per_frame, rows as usize / cameras().len());
}

// --- GPU rows (Metal) -----------------------------------------------------------------------------

use genex_render::Gpu;
use genex_render::terrain::atlas::TileRequest;
use genex_render::terrain::gpu::TerrainTilesGpu;
use genex_render::terrain::{TerrainLook, TerrainQuality};

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

fn read_words(gpu: &Gpu, buffer: &wgpu::Buffer) -> Vec<u32> {
    let bytes = buffer.size();
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: Some("tiles readback"), size: bytes, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("tiles readback") });
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    bytemuck::cast_slice(&data).to_vec()
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_each_tiles_group_reads_its_slot_and_the_rows_table_holds_the_frame() {
    let Some(gpu) = gpu() else { return };
    let tiling = tiling();
    let overview = tiling.overview_from_fn(ground).expect("overview");
    let tiles = TerrainTiles::new(tiling.clone(), overview).expect("tiles");
    let layer = TerrainLayer::flat([0.4, 0.5, 0.3]);
    let quality = TerrainQuality { detail: 1.25, detile: true };
    let mut terrain = TerrainTilesGpu::new(&gpu.device, &gpu.queue, FormFactor::Desktop, tiles, vec![layer], TerrainLook::default(), quality).expect("tiles on the GPU");
    let unloaded = terrain.bytes();
    let mut descs = Vec::new();
    for tz in 0..4 {
        for tx in 0..4 {
            let desc = TerrainDesc::new(tiling.tile_heights([tx, tz], ground).expect("tile"), layer);
            match terrain.request_tile(&gpu.device, &gpu.queue, [tx, tz]).expect("request") {
                TileRequest::Load { evicted: None, .. } => {}
                other => panic!("tile ({tx}, {tz}) should load into a fresh slot: {other:?}"),
            }
            descs.push(desc);
        }
    }
    // A tile whose border disagrees with a loaded neighbour is refused before its slot is written.
    assert!(terrain.upload_tile(&gpu.device, &gpu.queue, [0, 0], &descs[0]).expect("upload (0, 0)"));
    let bumped = TerrainDesc::new(tiling.tile_heights([1, 0], |x, z| if x == 64.0 { ground(x, z) + 1.0 } else { ground(x, z) }).expect("bumped"), layer);
    assert_eq!(refused_code(terrain.upload_tile(&gpu.device, &gpu.queue, [1, 0], &bumped)), RenderCode::MeshInvalid);
    assert_eq!(terrain.tiles().ground([1, 0]).expect("tile").source(), TileSource::Overview, "the refused tile still draws its window");
    for (i, desc) in descs.iter().enumerate().skip(1) {
        let tile = [i as u32 % 4, i as u32 / 4];
        assert!(terrain.upload_tile(&gpu.device, &gpu.queue, tile, desc).expect("upload"), "tile {tile:?} finishes");
    }
    assert!(!terrain.upload_tile(&gpu.device, &gpu.queue, [2, 2], &descs[10]).expect("again"), "a second completion writes nothing");
    let table = read_words(&gpu, terrain.atlas().buffer());
    for (i, desc) in descs.iter().enumerate() {
        let tile = [i as u32 % 4, i as u32 / 4];
        let row = terrain.tile_row(tile).expect("row");
        let TileSource::Slot(slot) = terrain.tiles().ground(tile).expect("tile").source() else { panic!("tile {tile:?} is loaded") };
        let base = terrain.atlas().slot_offset_words(slot) as usize;
        assert_eq!(row.counts[1] as usize, base * 2, "tile {tile:?}'s heights start at its slot");
        let heights = desc.heights.packed_heights();
        assert_eq!(&table[row.counts[1] as usize / 2..][..heights.len()], &heights[..], "tile {tile:?}'s heights");
        let control = desc.control_words();
        assert_eq!(&table[row.size[2] as usize..][..control.len()], &control[..], "tile {tile:?}'s control words");
        let normals = desc.heights.packed_normals();
        assert_eq!(&table[row.normal_levels[0][0] as usize..][..normals.len()], &normals[..], "tile {tile:?}'s normal pyramid");
    }
    let camera = [100.0, 6.0, 120.0];
    let mut half = [[0.0; 4]; 6];
    half[0] = [0.0, 0.0, 1.0, -70.0];
    terrain.prepare(&gpu.device, &gpu.queue, camera, &[[[0.0; 4]; 6], half]).expect("prepare");
    let frame = terrain.frame().clone();
    assert_eq!(frame.views[0].len(), 16, "the camera's view draws every tile");
    assert_eq!(frame.views[1].len(), 12, "the half-space z >= 70 keeps tile rows 1 to 3");
    let rows = read_words(&gpu, terrain.rows_buffer());
    let expected: Vec<u32> = frame.rows.iter().flat_map(|row| row.gpu()).collect();
    assert_eq!(&rows[..expected.len()], &expected[..], "the rows table holds the frame's rows, tile by tile");
    let loaded = terrain.bytes();
    println!("tiles on the GPU: {unloaded} bytes with 16 windows, {loaded} with 16 tiles loaded; {} rows in the frame", frame.rows.len());
    assert!(loaded < unloaded, "loaded tiles drop their windows' maps");
}
