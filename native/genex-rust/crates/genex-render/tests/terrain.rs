//! Heightmap terrain (renderer pass 2 A.7, `genex_render::terrain`). CPU rows hold the height
//! field, the control map and the CDLOD selection and morph (the vertex shader's CPU twin) to the
//! guarantees the draws rely on: no node beside one two levels coarser, every shared edge on its
//! neighbour's edge (no crack), and a surface that moves continuously under a moving camera (no
//! one-frame pop). Shader rows validate the terrain modules against WebGPU core. Real-GPU rows
//! (`#[ignore]`d, every name contains `metal`) draw a terrain through the renderer:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test terrain -- --ignored metal

use genex_render::terrain::{
    ControlTexel, Heightfield, MAX_TERRAIN_LAYERS, MAX_TERRAIN_SAMPLES, TERRAIN_GRID, TerrainDesc, TerrainFrame, TerrainLayer, TerrainLod, TerrainRow,
    TerrainTree, grid_indices,
};
use genex_render::{RenderCode, RenderError};

/// Rolling hills with sample-scale roughness on top (a hash per sample, 0.4 m), so a coarser
/// level's surface differs from a finer one's by decimetres and any pop or crack shows.
fn rough_hills(samples: u32, spacing: f32) -> Heightfield {
    hills(samples, spacing, 0.4)
}

/// Rolling hills with `roughness` metres of sample-scale hash on top.
fn hills(samples: u32, spacing: f32, roughness: f32) -> Heightfield {
    let half = (samples - 1) as f32 * spacing * 0.5;
    Heightfield::from_fn((samples, samples), [-half, -half], spacing, |x, z| {
        let hills = 6.0 * libm::sinf(x * 0.045) * libm::cosf(z * 0.06) + 2.5 * libm::sinf(x * 0.13 + z * 0.09);
        hills + roughness * hash(x, z)
    })
    .expect("height field")
}

fn hash(x: f32, z: f32) -> f32 {
    let bits = (x * 7.31).to_bits().wrapping_mul(0x9e37_79b9) ^ (z * 3.17).to_bits().wrapping_mul(0x85eb_ca6b);
    let mixed = bits ^ (bits >> 15);
    (mixed.wrapping_mul(0x2c1b_3c6d) >> 8) as f32 / (1u32 << 24) as f32
}

fn refused_code(result: Result<impl std::fmt::Debug, RenderError>) -> RenderCode {
    result.expect_err("refused").code()
}

// --- Height field and control map ---

#[test]
fn the_height_field_keeps_every_height_within_one_step_and_packs_two_a_word() {
    let heights = rough_hills(65, 0.5);
    let (min, step) = heights.quantization();
    assert!(step > 0.0 && step < 2e-4, "a 0.4 + 17 m range over 16 bits: {step}");
    let half = 16.0;
    for z in [0u32, 7, 33, 64] {
        for x in [0u32, 1, 40, 64] {
            let truth = {
                let (wx, wz) = (-half + x as f32 * 0.5, -half + z as f32 * 0.5);
                6.0 * libm::sinf(wx * 0.045) * libm::cosf(wz * 0.06) + 2.5 * libm::sinf(wx * 0.13 + wz * 0.09) + 0.4 * hash(wx, wz)
            };
            assert!((heights.sample(x, z) - truth).abs() <= step * 0.51, "sample ({x}, {z})");
        }
    }
    assert!(heights.sample(0, 0) >= min);
    let packed = heights.packed_heights();
    assert_eq!(packed.len(), (65 * 65usize).div_ceil(2));
    let q = heights.quantized();
    assert_eq!((packed[3] & 0xffff, packed[3] >> 16), (u32::from(q[6]), u32::from(q[7])), "sample 2i low, 2i + 1 high");
    // Between samples the height is bilinear and clamped onto the grid.
    let mid = heights.height_at_texel(10.5, 3.0);
    assert!((mid - 0.5 * (heights.sample(10, 3) + heights.sample(11, 3))).abs() < 1e-5);
    assert_eq!(heights.height_at_texel(-4.0, 99.0), heights.sample(0, 64));
}

#[test]
fn a_flat_height_field_has_one_level_and_up_normals() {
    let flat = Heightfield::from_fn((9, 9), [0.0, 0.0], 1.0, |_, _| 2.5).expect("flat");
    assert_eq!(flat.quantization(), (2.5, 0.0));
    assert_eq!(flat.sample(4, 4), 2.5);
    assert_eq!(flat.normal_at(0, 8), [0.0, 1.0, 0.0]);
    // Every level of the normal pyramid is +y, whole (length 1), 9 x 9 down to 1 x 1.
    let levels = flat.normal_levels();
    assert_eq!(levels.iter().map(|(size, _)| *size).collect::<Vec<_>>(), [(9, 9), (5, 5), (3, 3), (2, 2), (1, 1)]);
    let packed = flat.packed_normals();
    assert_eq!(packed.len(), 81 + 25 + 9 + 4 + 1);
    assert_eq!(genex_render::terrain::normal_level_offsets((9, 9)), [0, 81, 106, 115, 119]);
    for word in packed {
        assert_eq!(genex_render::terrain::unpack_normal(word), [0.0, 1.0, 0.0]);
    }
    assert_eq!(TerrainTree::new(&flat).lods(), 1);
}

#[test]
fn the_normal_pyramid_keeps_how_much_the_normals_below_agree() {
    let heights = rough_hills(65, 0.5);
    let levels = heights.normal_levels();
    assert_eq!(levels.len(), 8, "65, 33, 17, 9, 5, 3, 2, 1");
    let length = |v: [f32; 3]| (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    // Level 0 is unit length; the rough ground's upper levels are shorter (the normals disagree).
    assert!(levels[0].1.iter().all(|v| (length(*v) - 1.0).abs() < 1e-5));
    let mean = |level: &[[f32; 3]]| level.iter().map(|v| length(*v)).sum::<f32>() / level.len() as f32;
    assert!(mean(&levels[1].1) < 0.995 && mean(&levels[3].1) < mean(&levels[1].1), "{} {}", mean(&levels[1].1), mean(&levels[3].1));
    // Each texel is the mean of the (up to) four below it: an odd side's last texel has two.
    let (below, above) = (&levels[0].1, &levels[1].1);
    let expected: Vec<f32> = (0..3).map(|c| (below[64][c] + below[64 + 65][c]) / 2.0).collect();
    assert!((0..3).all(|c| (above[32][c] - expected[c]).abs() < 1e-6));
    // Packed to 10-bit snorms and back within half a step.
    for v in levels[2].1.iter().take(40) {
        let back = genex_render::terrain::unpack_normal(genex_render::terrain::pack_normal(*v));
        assert!((0..3).all(|c| (back[c] - v[c]).abs() <= 0.5 / 511.0 + 1e-6), "{v:?} {back:?}");
    }
}

#[test]
fn hostile_height_fields_are_refused_mesh_invalid() {
    let ok = vec![0.0; 16];
    let cases: Vec<(&str, Result<Heightfield, RenderError>)> = vec![
        ("one sample a side", Heightfield::new((1, 16), [0.0; 2], 1.0, &[0.0; 16])),
        ("past the largest side", Heightfield::new((MAX_TERRAIN_SAMPLES + 1, 2), [0.0; 2], 1.0, &vec![0.0; 2 * (MAX_TERRAIN_SAMPLES as usize + 1)])),
        ("too few heights", Heightfield::new((4, 4), [0.0; 2], 1.0, &ok[..15])),
        ("a height that is not a number", Heightfield::new((4, 4), [0.0; 2], 1.0, &[[f32::NAN].as_slice(), &ok[1..]].concat())),
        ("an infinite height", Heightfield::new((4, 4), [0.0; 2], 1.0, &[[f32::INFINITY].as_slice(), &ok[1..]].concat())),
        ("no spacing", Heightfield::new((4, 4), [0.0; 2], 0.0, &ok)),
        ("negative spacing", Heightfield::new((4, 4), [0.0; 2], -1.0, &ok)),
        ("an origin that is not a number", Heightfield::new((4, 4), [f32::NAN, 0.0], 1.0, &ok)),
    ];
    for (case, result) in cases {
        assert_eq!(refused_code(result), RenderCode::MeshInvalid, "{case}");
    }
}

#[test]
fn a_control_texel_keeps_its_four_fields() {
    let texel = ControlTexel::blend(3, 17, 200).with_wetness(77);
    assert_eq!((texel.base(), texel.overlay(), texel.blend_weight(), texel.wetness()), (3, 17, 200, 77));
    assert_eq!(texel.bits() >> 26, 0, "the reserved bits stay 0");
    assert_eq!(ControlTexel::layer(5).with_wetness(255).with_wetness(1).wetness(), 1, "wetness is replaced, not or-ed");
    assert_eq!(ControlTexel::blend(40, 0, 0).base(), 40 & 31, "five bits a layer");
}

#[test]
fn a_terrain_refuses_control_maps_and_layers_it_cannot_draw() {
    let heights = Heightfield::from_fn((4, 4), [0.0; 2], 1.0, |_, _| 0.0).expect("heights");
    let layer = TerrainLayer::flat([0.3, 0.4, 0.2]);
    let mut ok = TerrainDesc::new(heights.clone(), layer);
    ok.check().expect("one flat layer");
    assert_eq!(ok.control_words(), vec![0; 16], "no map: layer 0 everywhere");
    let with = |change: &dyn Fn(&mut TerrainDesc)| {
        let mut desc = TerrainDesc::new(heights.clone(), layer);
        change(&mut desc);
        desc.check().map(|()| desc)
    };
    let cases: Vec<(&str, Result<TerrainDesc, RenderError>)> = vec![
        ("no layer", with(&|desc| desc.layers.clear())),
        ("too many layers", with(&|desc| desc.layers = vec![layer; MAX_TERRAIN_LAYERS + 1])),
        ("a layer that does not tile", with(&|desc| desc.layers[0].tile = 0.0)),
        ("a tile that is not a number", with(&|desc| desc.layers[0].tile = f32::NAN)),
        ("a control map of the wrong size", with(&|desc| desc.control = vec![ControlTexel::layer(0); 15])),
        ("a texel naming a missing base", with(&|desc| desc.control = vec![ControlTexel::layer(1); 16])),
        ("a texel naming a missing overlay", with(&|desc| desc.control = vec![ControlTexel::blend(0, 2, 9); 16])),
    ];
    for (case, result) in cases {
        assert_eq!(refused_code(result), RenderCode::MeshInvalid, "{case}");
    }
    ok.control = vec![ControlTexel::blend(0, 0, 128).with_wetness(9); 16];
    ok.check().expect("a full map");
    assert_eq!(ok.control_words()[5], ControlTexel::blend(0, 0, 128).with_wetness(9).bits());
}

// --- Selection and morph ---

/// Cameras over and around a 257-sample terrain (128 m at 0.5 m): low and high, inside and
/// outside, looking every way (the selection ignores the view).
fn cameras() -> Vec<[f32; 3]> {
    let mut out = Vec::new();
    for (i, x) in [-90.0, -40.0, -7.3, 0.0, 12.9, 55.0, 140.0].iter().enumerate() {
        for (j, z) in [-70.0, -21.1, 3.3, 48.0, 101.0].iter().enumerate() {
            let y = [1.7, 6.0, 25.0, 80.0][(i + j) % 4];
            out.push([*x, y, *z]);
        }
    }
    out
}

/// The sample rectangle a row covers: x0, z0, x1, z1 (clamped onto the grid).
fn rect(row: TerrainRow, last: u32) -> [u32; 4] {
    [row.texel[0], row.texel[1], (row.texel[0] + row.span()).min(last), (row.texel[1] + row.span()).min(last)]
}

/// Pairs of rows sharing an edge of positive length: (a, b, axis, at, from, to), the shared edge
/// at sample coordinate `at` across `axis` (0: x = at, 1: z = at), from..to along the other axis.
fn shared_edges(rows: &[TerrainRow], last: u32) -> Vec<(usize, usize, usize, u32, u32, u32)> {
    let mut out = Vec::new();
    for (a, ra) in rows.iter().enumerate() {
        for (b, rb) in rows.iter().enumerate().skip(a + 1) {
            let (p, q) = (rect(*ra, last), rect(*rb, last));
            for axis in 0..2 {
                let other = 1 - axis;
                let touching = p[axis + 2] == q[axis] || q[axis + 2] == p[axis];
                let from = p[other].max(q[other]);
                let to = p[other + 2].min(q[other + 2]);
                if touching && to > from {
                    let at = if p[axis + 2] == q[axis] { q[axis] } else { p[axis] };
                    out.push((a, b, axis, at, from, to));
                }
            }
        }
    }
    out
}

/// The surface height a row's edge polyline gives at sample coordinate `t` along the edge at `at`
/// across `axis`.
fn edge_height(tree: &TerrainTree, heights: &Heightfield, lod: &TerrainLod, row: TerrainRow, (axis, at, t): (usize, u32, u32), camera: [f32; 3]) -> f32 {
    let index_at = (at - row.texel[axis]) >> row.lod;
    let mut points: Vec<[f32; 3]> = (0..=row.quads)
        .map(|k| {
            let (gx, gz) = if axis == 0 { (index_at, k) } else { (k, index_at) };
            tree.vertex(heights, lod, row, gx, gz, camera)
        })
        .collect();
    let along = if axis == 0 { 2 } else { 0 };
    points.sort_by(|p, q| p[along].total_cmp(&q[along]));
    let (origin, spacing) = (heights.origin()[if axis == 0 { 1 } else { 0 }], heights.spacing());
    let w = origin + t as f32 * spacing;
    for pair in points.windows(2) {
        let (p, q) = (pair[0], pair[1]);
        if w >= p[along] - 1e-4 && w <= q[along] + 1e-4 {
            let span = q[along] - p[along];
            return if span < 1e-6 { p[1].max(q[1]) } else { p[1] + (q[1] - p[1]) * ((w - p[along]) / span).clamp(0.0, 1.0) };
        }
    }
    panic!("{t} is not on the row's edge");
}

#[test]
fn a_node_is_never_beside_one_two_levels_coarser_and_shared_edges_meet() {
    let heights = rough_hills(257, 0.5);
    let tree = TerrainTree::new(&heights);
    assert_eq!(tree.lods(), 5, "256 quads at 16 a node: levels of 16, 32, 64, 128 and 256");
    let last = 256;
    for detail in [1.0, 1.25, 2.0] {
        let lod = TerrainLod::new(&tree, detail);
        let mut edges_checked = 0;
        for camera in cameras() {
            let rows = tree.select(&lod, camera);
            // Every sample is covered exactly once by the rows (no hole, no overlap).
            let mut covered = vec![0u8; (last * last) as usize];
            for row in &rows {
                let r = rect(*row, last);
                for z in r[1]..r[3] {
                    for x in r[0]..r[2] {
                        covered[(z * last + x) as usize] += 1;
                    }
                }
            }
            assert!(covered.iter().all(|&c| c == 1), "camera {camera:?}: every quad drawn once");
            for (a, b, axis, at, from, to) in shared_edges(&rows, last) {
                let (ra, rb) = (rows[a], rows[b]);
                assert!(ra.lod.abs_diff(rb.lod) <= 1, "camera {camera:?} detail {detail}: {ra:?} beside {rb:?}");
                for t in from..=to {
                    let ha = edge_height(&tree, &heights, &lod, ra, (axis, at, t), camera);
                    let hb = edge_height(&tree, &heights, &lod, rb, (axis, at, t), camera);
                    assert!((ha - hb).abs() < 1e-4, "camera {camera:?}: crack of {} m between {ra:?} and {rb:?} at {t}", (ha - hb).abs());
                    edges_checked += 1;
                }
            }
        }
        assert!(edges_checked > 10_000, "detail {detail}: {edges_checked} edge samples");
    }
}

/// The surface height at world (x, z) from the drawn rows' morphed triangles, or None outside.
fn surface_height(tree: &TerrainTree, heights: &Heightfield, lod: &TerrainLod, rows: &[TerrainRow], camera: [f32; 3], (x, z): (f32, f32)) -> Option<f32> {
    let (origin, spacing) = (heights.origin(), heights.spacing());
    let (u, v) = ((x - origin[0]) / spacing, (z - origin[1]) / spacing);
    for row in rows {
        let span = row.span() as f32;
        let (ru, rv) = (u - row.texel[0] as f32, v - row.texel[1] as f32);
        if ru < 0.0 || rv < 0.0 || ru > span || rv > span {
            continue;
        }
        let step = (1u32 << row.lod) as f32;
        let (qu, qv) = ((ru / step) as i32, (rv / step) as i32);
        // Morphed vertices slide at most one quad towards lower indices: the point is in a quad
        // within one of where it would be unmorphed.
        for gz in (qv - 1).max(0)..=(qv + 1).min(row.quads as i32 - 1) {
            for gx in (qu - 1).max(0)..=(qu + 1).min(row.quads as i32 - 1) {
                let at = |dx: u32, dz: u32| tree.vertex(heights, lod, *row, gx as u32 + dx, gz as u32 + dz, camera);
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

#[test]
fn a_dolly_over_the_terrain_moves_the_surface_without_a_pop() {
    let heights = rough_hills(257, 0.5);
    let tree = TerrainTree::new(&heights);
    let lod = TerrainLod::new(&tree, 1.0);
    // A dolly of 0.2 m steps from far outside across the terrain at walking height + 1.5 m.
    let steps = 900;
    let camera = |i: u32| [-130.0 + i as f32 * 0.2, heights.height(-130.0 + i as f32 * 0.2, 9.0).max(0.0) + 3.0, 9.0];
    let probes: Vec<(f32, f32)> = (0..48).map(|i| (-60.0 + (i % 8) as f32 * 17.3, -50.0 + (i / 8) as f32 * 19.1)).collect();
    let mut last: Option<(Vec<TerrainRow>, Vec<f32>)> = None;
    let (mut worst, mut switches) = (0.0_f32, 0);
    for i in 0..steps {
        let at = camera(i);
        let rows = tree.select(&lod, at);
        let surface: Vec<f32> = probes.iter().map(|p| surface_height(&tree, &heights, &lod, &rows, at, *p).expect("on the terrain")).collect();
        if let Some((rows_before, before)) = &last {
            if *rows_before != rows {
                switches += 1;
            }
            for (now, then) in surface.iter().zip(before) {
                worst = worst.max((now - then).abs());
            }
        }
        last = Some((rows, surface));
    }
    assert!(switches >= 20, "the dolly crosses level changes: {switches}");
    // A pop moves a probe by the difference between two levels' surfaces (decimetres on this
    // ground); the morph moves it by at most the step over the morph band times a quad's rise.
    assert!(worst < 0.02, "the largest one-step change of the surface is {worst} m");
}

#[test]
fn the_ranges_are_floored_crack_free_and_the_top_never_morphs() {
    let heights = rough_hills(257, 0.5);
    let tree = TerrainTree::new(&heights);
    let least = TerrainLod::range0(&tree);
    let lod = TerrainLod::new(&tree, 0.25);
    assert_eq!(lod.ranges[0], least, "a detail under 1 keeps the least crack-free range");
    assert!(lod.ranges[0] >= 4.0 * TERRAIN_GRID as f32 * 0.5, "about 4.3 leaf sizes on gentle ground: {least}");
    assert!(lod.ranges[4].is_infinite() && lod.ranges[3].is_finite(), "the top level is always selected");
    assert_eq!(lod.morph_k(4, 1e6), 0.0, "and never morphs");
    let (start, end) = lod.morph(1);
    assert!(start > lod.ranges[0] && end < lod.ranges[1]);
    assert_eq!((lod.morph_k(1, start - 0.01), lod.morph_k(1, end + 0.01)), (0.0, 1.0));
    assert!((lod.morph_k(1, 0.5 * (start + end)) - 0.5).abs() < 1e-3);
}

#[test]
fn each_view_keeps_the_rows_in_its_frustum() {
    let heights = rough_hills(257, 0.5);
    let tree = TerrainTree::new(&heights);
    let lod = TerrainLod::new(&tree, 1.0);
    let camera = [0.0, 10.0, 0.0];
    // View 0 keeps x >= 0 (one plane), view 1 everything (zero planes pass).
    let mut half = [[0.0; 4]; 6];
    half[0] = [1.0, 0.0, 0.0, 0.0];
    let frame = TerrainFrame::plan(&tree, &lod, camera, &[half, [[0.0; 4]; 6]]);
    assert_eq!(frame.views.len(), 2);
    let [first, full, quarters_first, quarters] = frame.views[1];
    assert_eq!((first, full + quarters), (frame.views[0][1] + frame.views[0][3], frame.selected), "view 1 holds every selected row");
    assert_eq!(quarters_first, first + full);
    let view0 = &frame.rows[..(frame.views[0][1] + frame.views[0][3]) as usize];
    assert!(view0.len() < frame.selected as usize && !view0.is_empty());
    for row in view0 {
        let (_, max) = tree.row_box(*row);
        assert!(max[0] >= 0.0, "{row:?} reaches x >= 0");
    }
    for row in &frame.rows[first as usize..(first + full) as usize] {
        assert_eq!(row.quads, TERRAIN_GRID, "full rows first");
    }
    let _ = quarters;
}

#[test]
fn the_grid_winds_counter_clockwise_from_above_with_one_diagonal() {
    let full = grid_indices(TERRAIN_GRID);
    assert_eq!(full.len() as u32, TERRAIN_GRID * TERRAIN_GRID * 6);
    assert_eq!(grid_indices(TERRAIN_GRID / 2).len() as u32, TERRAIN_GRID * TERRAIN_GRID * 6 / 4);
    let width = TERRAIN_GRID + 1;
    let position = |i: u32| [(i % width) as f32, (i / width) as f32];
    for tri in full.chunks(3) {
        let (a, b, c) = (position(tri[0]), position(tri[1]), position(tri[2]));
        // Normal y of (b - a) x (c - a) in x, z: positive is up (+y).
        let up = (b[1] - a[1]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[1] - a[1]);
        assert!(up > 0.0, "{tri:?} faces up");
    }
    // Every quad's diagonal runs from its lowest to its highest corner (one diagonal everywhere).
    for quad in full.chunks(6) {
        assert_eq!((quad[0], quad[2]), (quad[3], quad[4]));
        assert_eq!(quad[2], quad[0] + width + 1);
    }
}

// --- Shaders ---

use genex_render::terrain::gpu::{DETILE_CONSTANT, GpuTerrain, TERRAIN, TERRAIN_SHADOW, layout_entries};
use naga::back::{hlsl, msl, spv};
use naga::valid::{Capabilities, ModuleInfo, ValidationFlags, Validator};

fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

fn validated(name: &str, module: &naga::Module) -> ModuleInfo {
    Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES)
        .validate(module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"))
}

/// Emit `module` with `variant`'s overrides through HLSL SM 5.1, MSL 2.4 and SPIR-V 1.3 (the
/// destinations' compilers, as tests/layout.rs emits every renderer shader).
fn emit(name: &str, module: &naga::Module, info: &ModuleInfo, variant: &[(&str, f64)]) {
    let constants: naga::back::PipelineConstants = variant.iter().map(|(key, value)| ((*key).to_owned(), *value)).collect();
    let (module, info) = naga::back::pipeline_constants::process_overrides(module, info, None, &constants).unwrap_or_else(|error| panic!("{name} {variant:?}: {error:?}"));
    let mut hlsl_source = String::new();
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name} {variant:?}: HLSL: {error:?}"));
    let options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name} {variant:?}: MSL: {error:?}"));
    let options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &options, None).unwrap_or_else(|error| panic!("{name} {variant:?}: SPIR-V: {error:?}"));
}

#[test]
fn the_terrain_modules_validate_against_core_and_emit_every_variant() {
    let terrain = parse("terrain", TERRAIN);
    let info = validated("terrain", &terrain);
    let variants: [&[(&str, f64)]; 5] = [
        &[],
        &[(DETILE_CONSTANT, 1.0), ("GX_SCENE_HDR", 1.0)],
        &[(DETILE_CONSTANT, 1.0), ("GX_SCENE_HDR", 1.0), ("GX_SPECULAR_AA", 1.0), ("GX_TEXTURE_CLASSES", 1.0), ("GX_SHADOW_FILTER", 4.0)],
        &[("GX_SCENE_HDR", 1.0), ("GX_ROUGHNESS_FLOOR", 0.089), ("GX_SCENE_RG11B10", 1.0)],
        &[("GX_SHADOW_FILTER", 2.0)],
    ];
    for variant in variants {
        emit("terrain", &terrain, &info, variant);
    }
    let shadow = parse("terrain-shadow", TERRAIN_SHADOW);
    let shadow_info = validated("terrain-shadow", &shadow);
    for variant in [&[][..], &[("GX_UNCLIPPED_DEPTH", 1.0)][..], &[("GX_SHADOW_DEPTH_UNIT", 1.0 / 65536.0)][..]] {
        emit("terrain-shadow", &shadow, &shadow_info, variant);
    }
    // Every depth-writing entry point writes an invariant position through gx_clip_position (the
    // prepass and an `Equal` world pass agree bit for bit).
    for entry in ["vs_terrain", "vs_terrain_motion"] {
        let point = terrain.entry_points.iter().find(|point| point.name == entry).unwrap_or_else(|| panic!("{entry}"));
        let result = point.function.result.as_ref().expect("an output");
        let naga::TypeInner::Struct { members, .. } = &terrain.types[result.ty].inner else { panic!("{entry} returns a struct") };
        let invariant = members.iter().any(|member| matches!(member.binding, Some(naga::Binding::BuiltIn(naga::BuiltIn::Position { invariant: true }))));
        assert!(invariant, "{entry}: @builtin(position) @invariant");
    }
    assert!(TERRAIN.len() < genex_render::WGSL_MAX_BYTES && TERRAIN_SHADOW.len() < genex_render::WGSL_MAX_BYTES);
}

#[test]
fn the_terrain_row_is_the_size_naga_lays_out() {
    let module = parse("terrain", TERRAIN);
    let mut layouter = naga::proc::Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    let (handle, _) = module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some("GxTerrain")).expect("GxTerrain");
    assert_eq!(layouter[handle].size as usize, size_of::<GpuTerrain>());
}

/// The bound globals of `module` that `stage`'s entry points use: (sampled textures, storage
/// buffers, uniform buffers).
fn stage_counts(module: &naga::Module, info: &ModuleInfo, stage: naga::ShaderStage) -> (u32, u32, u32) {
    let entries: Vec<usize> = module.entry_points.iter().enumerate().filter(|(_, entry)| entry.stage == stage).map(|(index, _)| index).collect();
    let mut counts = (0, 0, 0);
    for (handle, global) in module.global_variables.iter().filter(|(_, global)| global.binding.is_some()) {
        if !entries.iter().any(|index| !info.get_entry_point(*index)[handle].is_empty()) {
            continue;
        }
        match (&module.types[global.ty].inner, global.space) {
            (naga::TypeInner::Image { class: naga::ImageClass::Storage { .. }, .. }, _) => {}
            (naga::TypeInner::Image { .. }, _) => counts.0 += 1,
            (_, naga::AddressSpace::Storage { .. }) => counts.1 += 1,
            (_, naga::AddressSpace::Uniform) => counts.2 += 1,
            _ => {}
        }
    }
    counts
}

#[test]
fn the_terrain_adds_no_sampled_texture_and_one_fragment_storage_buffer() {
    let core = wgpu::Limits::defaults();
    let module = parse("terrain", TERRAIN);
    let info = validated("terrain", &module);
    let forward = parse("forward", genex_render::shaders::FORWARD);
    let forward_info = validated("forward", &forward);
    let (textures, storage, uniforms) = stage_counts(&module, &info, naga::ShaderStage::Fragment);
    let (forward_textures, forward_storage, _) = stage_counts(&forward, &forward_info, naga::ShaderStage::Fragment);
    assert!(textures <= forward_textures, "the terrain's fragment samples the forward frame group's textures only: {textures}");
    assert_eq!(storage, forward_storage + 1, "the maps are the one storage buffer the terrain adds to the fragment stage");
    assert!(textures <= core.max_sampled_textures_per_shader_stage && storage <= core.max_storage_buffers_per_shader_stage);
    assert!(uniforms <= core.max_uniform_buffers_per_shader_stage);
    let (_, vertex_storage, _) = stage_counts(&module, &info, naga::ShaderStage::Vertex);
    assert!(vertex_storage <= core.max_storage_buffers_per_shader_stage, "vertex: {vertex_storage}");
    // The pipeline layout counted the WebGPU way (every binding a stage can see): the frame group,
    // the pass view and the terrain group, plus the motion node's group on the motion prepass.
    let frame = genex_render::renderer::frame_layout_entries();
    let terrain = layout_entries();
    let count = |stage: wgpu::ShaderStages, storage: bool| {
        frame
            .iter()
            .chain(terrain.iter())
            .filter(|entry| entry.visibility.contains(stage))
            .filter(|entry| match entry.ty {
                wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { .. }, .. } => storage,
                wgpu::BindingType::Texture { .. } => !storage,
                _ => false,
            })
            .count() as u32
    };
    assert!(count(wgpu::ShaderStages::FRAGMENT, true) <= core.max_storage_buffers_per_shader_stage);
    assert!(count(wgpu::ShaderStages::FRAGMENT, false) <= core.max_sampled_textures_per_shader_stage);
    assert!(count(wgpu::ShaderStages::VERTEX, true) + 2 <= core.max_storage_buffers_per_shader_stage, "the motion group's two vertex tables fit too");
}

// --- Real-GPU rows ---

use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::presets::preset_quality;
use genex_render::scene::{CameraDesc, Scene};
use genex_render::settings::{AntiAliasing, AoResolution, Environment, Quality, QualityPreset, SceneFormat, SkyParams};
use genex_render::texture::{TextureData, TextureKind};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::Vec3;

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

fn evidence_dir() -> Option<std::path::PathBuf> {
    let dir = std::path::PathBuf::from(std::env::var_os("GENEX_RENDER_EVIDENCE_DIR")?);
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn desktop_high() -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)
}

/// The low sun the rows light the terrain with (about 14 degrees up).
const SUN: [f32; 3] = [0.7, 0.25, 0.45];

/// A layer texture pair of `side` texels: a base colour around `color` with hashed value noise at
/// two scales and its height in alpha, and a data texture (normal from the height's slope,
/// roughness, occlusion from the height).
fn layer_textures(side: u32, color: [f32; 3], seed: u32) -> (TextureData, TextureData) {
    let noise = |x: u32, y: u32, cell: u32| {
        let h = ((x / cell).wrapping_add(seed).wrapping_mul(374_761_393) ^ (y / cell).wrapping_mul(668_265_263)).wrapping_mul(1_274_126_177);
        ((h >> 16) & 0xff) as f32 / 255.0
    };
    let height = |x: u32, y: u32| 0.55 * noise(x % side, y % side, 2) + 0.45 * noise(x % side, y % side, 8);
    let mut albedo = Vec::with_capacity((side * side * 4) as usize);
    let mut data = Vec::with_capacity((side * side * 4) as usize);
    for y in 0..side {
        for x in 0..side {
            let h = height(x, y);
            let shade = 0.7 + 0.6 * h;
            for c in color {
                albedo.push(((c * shade).clamp(0.0, 1.0) * 255.0) as u8);
            }
            albedo.push((h * 255.0) as u8);
            let dx = height(x + 1, y) - height(x + side - 1, y);
            let dy = height(x, y + 1) - height(x, y + side - 1);
            let n = Vec3::new(-dx * 1.5, -dy * 1.5, 1.0).normalize();
            data.extend_from_slice(&[((n.x * 0.5 + 0.5) * 255.0) as u8, ((n.y * 0.5 + 0.5) * 255.0) as u8, 210, (180.0 + 75.0 * h) as u8]);
        }
    }
    (TextureData::rgba8(side, side, albedo).expect("albedo"), TextureData::rgba8(side, side, data).expect("data"))
}

/// The rows' terrain: rough hills of `samples` a side `spacing` apart, grass on the flats, rock on
/// the slopes, sand and wetness in the hollows, its layers' textures added to `renderer`.
fn terrain(gpu: &Gpu, renderer: &mut Renderer, samples: u32, spacing: f32) -> TerrainDesc {
    terrain_of(gpu, renderer, rough_hills(samples, spacing))
}

/// [`terrain`] over `heights`.
fn terrain_of(gpu: &Gpu, renderer: &mut Renderer, heights: Heightfield) -> TerrainDesc {
    let mut layers = Vec::new();
    for (color, seed, tile) in [([0.16, 0.24, 0.07], 1, 3.0), ([0.42, 0.40, 0.37], 2, 5.0), ([0.55, 0.47, 0.33], 3, 2.0)] {
        let (albedo, data) = layer_textures(256, color, seed);
        let albedo = renderer.add_texture(gpu, &albedo, TextureKind::Color).expect("albedo");
        let data = renderer.add_texture(gpu, &data, TextureKind::Data).expect("data");
        layers.push(TerrainLayer { roughness: 1.0, ..TerrainLayer::textured(Some(albedo), Some(data), tile) });
    }
    let (w, _) = heights.samples();
    let mut control = Vec::with_capacity((w * w) as usize);
    for z in 0..w {
        for x in 0..w {
            let n = heights.normal_at(x, z);
            let rock = ((0.93 - n[1]) * 12.0).clamp(0.0, 1.0);
            let h = heights.sample(x, z);
            let hollow = ((-1.0 - h) * 0.5).clamp(0.0, 1.0);
            let texel = if rock > hollow { ControlTexel::blend(0, 1, (rock * 255.0) as u8) } else { ControlTexel::blend(0, 2, (hollow * 255.0) as u8) };
            control.push(texel.with_wetness((hollow * 200.0) as u8));
        }
    }
    TerrainDesc { heights, control, layers, look: genex_render::terrain::TerrainLook::default() }
}

/// A renderer at `size` drawing `quality` under the physical sky, single-sampled when `depth` (its
/// depth kept for [`Renderer::read_depth`]).
fn renderer(gpu: &Gpu, size: (u32, u32), quality: &Quality, depth: bool) -> Renderer {
    let msaa = !depth && quality.anti_aliasing == AntiAliasing::Msaa4;
    let mut renderer = Renderer::with_options(gpu, size.0, size.1, RenderOptions { msaa }).expect("renderer");
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(desktop_high());
    renderer.set_quality(quality);
    renderer.set_environment(&Environment::Sky(SkyParams::default()));
    renderer.set_depth_readback(depth);
    renderer
}

/// `preset` on desktop-high with the features that keep their own noise or meter the picture off
/// (AO, bloom, auto exposure), so a frame's change is the camera's and the terrain's.
fn steady(preset: QualityPreset) -> Quality {
    let mut quality = preset_quality(preset, desktop_high());
    quality.ao.resolution = AoResolution::Off;
    quality.bloom.enabled = false;
    quality.exposure = false;
    quality
}

fn scene(camera: CameraDesc) -> Scene {
    let mut scene = Scene::new(camera, [255, 0, 255, 255]);
    scene.lighting.sun_dir = Vec3::from(SUN).normalize().to_array();
    scene.lighting.shadow_distance = 80.0;
    scene
}

/// A camera at `eye` looking along `yaw` (radians about +y) pitched `pitch` down, `fovy` degrees.
fn camera(eye: Vec3, yaw: f32, pitch: f32, fovy: f32) -> CameraDesc {
    let ahead = Vec3::new(libm::sinf(yaw) * libm::cosf(pitch), -libm::sinf(pitch), libm::cosf(yaw) * libm::cosf(pitch));
    let mut camera = CameraDesc::look_at(eye.to_array(), (eye + ahead).to_array());
    camera.fovy_degrees = fovy;
    camera
}

/// The background's depth on the HDR scene (reverse-Z) and on the legacy one.
fn far_depth(quality: &Quality) -> f32 {
    if quality.hdr { 0.0 } else { 1.0 }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_terrain_covers_the_ground_without_a_crack_on_a_dolly_at_every_preset() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let mut rows = Vec::new();
    for (name, quality) in [("off", Quality::off()), ("low", steady(QualityPreset::Low)), ("medium", steady(QualityPreset::Medium)), ("high", steady(QualityPreset::High)), ("ultra", steady(QualityPreset::Ultra))] {
        let mut renderer = renderer(&gpu, size, &quality, true);
        let desc = terrain(&gpu, &mut renderer, 1025, 0.375);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let far = far_depth(&quality);
        let (mut holes, mut frames, mut lods_seen) = (0usize, 0, 0u32);
        // Looking down at 75 degrees with a 100 degree field: every pixel is ground (the corners'
        // rays 14 degrees below the horizon meet it well inside the 384 m terrain), across the
        // first level boundaries.
        for k in 0..48 {
            let x = -40.0 + k as f32 * 1.7;
            let ground = desc.heights.height(x, 4.0);
            let eye = Vec3::new(x, ground.max(0.0) + 14.0, 4.0);
            renderer.set_frame_index(k);
            renderer.render(&gpu, &scene(camera(eye, 0.3 + 0.05 * k as f32, 75f32.to_radians(), 100.0)), CullPath::Gpu).expect("frame");
            let depth = renderer.read_depth(&gpu).expect("depth");
            holes += depth.iter().filter(|d| **d == far).count();
            frames += 1;
            let stats = renderer.terrain_stats().expect("a terrain");
            assert!(stats.camera_rows > 0 && stats.rows >= stats.camera_rows, "{name}: {stats:?}");
            let lods: std::collections::BTreeSet<u32> = desc_rows(&renderer).into_iter().collect();
            lods_seen = lods_seen.max(lods.len() as u32);
        }
        rows.push(format!("{name}: {holes} background pixels over {frames} frames, up to {lods_seen} levels in view"));
        assert_eq!(holes, 0, "{name}: the background shows through the terrain");
        assert!(lods_seen >= 2, "{name}: the dolly crosses a level boundary in view");
    }
    eprintln!("{}", rows.join("\n"));
}

/// The levels of the camera view's rows of the last frame.
fn desc_rows(renderer: &Renderer) -> Vec<u32> {
    renderer.terrain_frame().map(|frame| {
        let [first, full, quarters_first, quarters] = frame.views[0];
        let mut lods: Vec<u32> = frame.rows[first as usize..(first + full) as usize].iter().map(|row| row.lod).collect();
        lods.extend(frame.rows[quarters_first as usize..(quarters_first + quarters) as usize].iter().map(|row| row.lod));
        lods
    })
    .unwrap_or_default()
}

/// `scene` drawn `frames` times on one pose (TAA's history settles), then captured.
fn settled(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene, frames: u64) -> genex_render::capture::Capture {
    for k in 0..frames {
        renderer.set_frame_index(k);
        renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    }
    renderer.capture(gpu).expect("capture")
}

/// A walker's view over the rows' terrain towards the hills (the horizon in view), 1.7 m up.
fn walker(desc: &TerrainDesc, x: f32, yaw: f32) -> CameraDesc {
    let ground = desc.heights.height(x, -20.0);
    camera(Vec3::new(x, ground + 1.7, -20.0), yaw, 6f32.to_radians(), 55.0)
}

fn write_capture(name: &str, capture: &genex_render::capture::Capture) {
    if let Some(dir) = evidence_dir() {
        let path = dir.join(format!("{name}-{}x{}.bgra", capture.width(), capture.height()));
        std::fs::write(&path, capture.bgra()).expect("evidence written");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_terrain_shots_for_the_look_review() {
    let Some(gpu) = gpu() else { return };
    let size: (u32, u32) = std::env::var("GENEX_TERRAIN_SHOT_SIZE")
        .ok()
        .and_then(|v| v.split_once('x').and_then(|(w, h)| Some((w.parse().ok()?, h.parse().ok()?))))
        .unwrap_or((1280, 720));
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let quality = preset_quality(preset, desktop_high());
        let mut renderer = renderer(&gpu, size, &quality, false);
        let desc = terrain(&gpu, &mut renderer, 1025, 0.375);
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        for (shot, x, yaw) in [("walk", 0.0, 0.6), ("across", 30.0, -1.2)] {
            let capture = settled(&gpu, &mut renderer, &scene(walker(&desc, x, yaw)), 24);
            let lit = capture.bgra().chunks(4).filter(|p| p[0] != 255 || p[1] != 0 || p[2] != 255).count();
            assert!(lit > 0, "{preset:?} {shot}: drew something");
            write_capture(&format!("look-{}-{shot}", preset.wire()), &capture);
        }
    }
}

/// A pixel pops when its luma (0..255) jumps by more than this for exactly one frame (SH-15, the
/// motion rows' bound).
const POP_LEVELS: f32 = 16.0;

fn lumas(capture: &genex_render::capture::Capture) -> Vec<f32> {
    capture.bgra().chunks(4).map(|p| 0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])).collect()
}

/// Per pixel, the least and the most of `values` within `radius` (the motion envelope).
fn envelope(values: &[f32], (width, height): (usize, usize), radius: usize) -> (Vec<f32>, Vec<f32>) {
    let mut least = vec![0.0; values.len()];
    let mut most = vec![0.0; values.len()];
    for y in 0..height {
        let (y0, y1) = (y.saturating_sub(radius), (y + radius).min(height - 1));
        for x in 0..width {
            let (x0, x1) = (x.saturating_sub(radius), (x + radius).min(width - 1));
            let (mut lo, mut hi) = (f32::INFINITY, f32::NEG_INFINITY);
            for row in y0..=y1 {
                for v in &values[row * width + x0..=row * width + x1] {
                    lo = lo.min(*v);
                    hi = hi.max(*v);
                }
            }
            least[y * width + x] = lo;
            most[y * width + x] = hi;
        }
    }
    (least, most)
}

fn holds(env: &(Vec<f32>, Vec<f32>), i: usize, value: f32) -> bool {
    env.0[i] - value <= POP_LEVELS && value - env.1[i] <= POP_LEVELS
}

/// The one-frame pops of each frame of `frames` (lumas) seen with a motion envelope of `radius`:
/// frame k's value is held by neither neighbour's envelope while frame k-1's value comes back in
/// frame k+1 (the motion rows' test).
fn pops(frames: &[Vec<f32>], size: (usize, usize), radius: usize) -> Vec<usize> {
    let envelopes: Vec<_> = frames.iter().map(|luma| envelope(luma, size, radius)).collect();
    (1..frames.len().saturating_sub(1))
        .map(|k| {
            (0..frames[k].len())
                .filter(|&i| {
                    let value = frames[k][i];
                    let came_back = holds(&envelopes[k + 1], i, frames[k - 1][i]) || holds(&envelopes[k - 1], i, frames[k + 1][i]);
                    !holds(&envelopes[k - 1], i, value) && !holds(&envelopes[k + 1], i, value) && came_back
                })
                .count()
        })
        .collect()
}

/// The steps of each frame of `frames`: pixels whose luma no pixel within `radius` of them held
/// in the frame before (by more than [`POP_LEVELS`]): what a level switching without a morph
/// does to the ground, persistently (a one-frame pop comes back; a step does not).
fn steps(frames: &[Vec<f32>], size: (usize, usize), radius: usize) -> Vec<usize> {
    (1..frames.len())
        .map(|k| {
            let before = envelope(&frames[k - 1], size, radius);
            (0..frames[k].len()).filter(|&i| !holds(&before, i, frames[k][i])).count()
        })
        .collect()
}

/// What one dolly drew: its frames' lumas and how often the terrain's selection changed.
struct Dolly {
    frames: Vec<Vec<f32>>,
    switches: usize,
}

/// The dolly the pop row draws at `preset`: the terrain, or (`mesh`) a static mesh of its finest
/// level drawn with the plain forward material (the ground without levels of detail).
fn dolly(gpu: &Gpu, preset: QualityPreset, size: (usize, usize), mesh: bool) -> Dolly {
    let quality = steady(preset);
    let mut renderer = renderer(gpu, (size.0 as u32, size.1 as u32), &quality, false);
    // Hills with 8 cm of sample-scale roughness: decimetres between the levels' surfaces on the
    // slopes, without the white-noise ridge whose sub-pixel spikes alias on any mesh.
    let desc = terrain_of(gpu, &mut renderer, hills(1025, 0.375, 0.08));
    let ground = mesh.then(|| mesh_ground(gpu, &mut renderer, &desc, 1));
    if !mesh {
        renderer.set_terrain(gpu, Some((&desc, 1))).expect("terrain");
    }
    // A dolly at a brisk walk (0.03 m a frame) towards the hills and the low sun, the far ground
    // across the level boundaries the whole way; 30 frames to settle on the first pose.
    let at = |k: f32| walker(&desc, -10.0 + k.max(0.0) * 0.03, 0.9);
    let mut out = Dolly { frames: Vec::new(), switches: 0 };
    let mut last_rows: Option<Vec<genex_render::terrain::TerrainRow>> = None;
    for index in 0..30 + 90u64 {
        renderer.set_frame_index(index);
        let mut view = scene(at(index as f32 - 30.0));
        if let Some((mesh, material)) = ground {
            view.draw(mesh, genex_render::scene::translation(0.0, 0.0, 0.0), material);
        }
        renderer.render(gpu, &view, CullPath::Gpu).expect("frame");
        if index < 30 {
            continue;
        }
        // The selection as a set: the rows' order follows the camera within each draw.
        let rows_now = renderer.terrain_frame().map(|frame| {
            let mut rows = frame.rows.clone();
            rows.sort();
            rows
        });
        if rows_now.is_some() && last_rows != rows_now {
            out.switches += usize::from(last_rows.is_some());
        }
        last_rows = rows_now;
        out.frames.push(lumas(&renderer.capture(gpu).expect("capture")));
    }
    out
}

/// Every pixel that popped in any of `frames`, magenta over the last frame's luma (raw BGRA).
fn pop_map(frames: &[Vec<f32>], size: (usize, usize)) -> Vec<u8> {
    let envelopes: Vec<_> = frames.iter().map(|luma| envelope(luma, size, 3)).collect();
    let mut map: Vec<u8> = frames[frames.len() - 1].iter().flat_map(|l| [*l as u8, *l as u8, *l as u8, 255]).collect();
    for k in 1..frames.len() - 1 {
        for i in 0..frames[k].len() {
            let value = frames[k][i];
            let came_back = holds(&envelopes[k + 1], i, frames[k - 1][i]) || holds(&envelopes[k - 1], i, frames[k + 1][i]);
            if !holds(&envelopes[k - 1], i, value) && !holds(&envelopes[k + 1], i, value) && came_back {
                map[i * 4..i * 4 + 4].copy_from_slice(&[255, 0, 255, 255]);
            }
        }
    }
    map
}

/// The terrain's levels of detail add no one-frame pop on a dolly towards a low sun: zero under
/// TAA (`high`, `ultra`), and no more than a static mesh of its finest level draws at a preset
/// without TAA, whose silhouettes against the sun's glare alias under MSAA on any ground (the
/// static 0.375 m mesh pops 6 pixels over the path at `medium`, the terrain 3; with the morph
/// switched off the terrain pops 21 and steps 234: `wp-A.7.md`).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_dolly_over_the_terrain_has_no_one_frame_pop() {
    let Some(gpu) = gpu() else { return };
    let size = (640usize, 360usize);
    let mut rows = Vec::new();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let terrain = dolly(&gpu, preset, size, false);
        let temporal = steady(preset).anti_aliasing.temporal();
        let pops_of = |frames: &[Vec<f32>]| pops(frames, size, 3).iter().sum::<usize>();
        let total = pops_of(&terrain.frames);
        let stepped: usize = steps(&terrain.frames, size, 3).iter().sum();
        // Without TAA the bound is the static mesh's own aliasing.
        let bound = if temporal { 0 } else { pops_of(&dolly(&gpu, preset, size, true).frames) };
        if let Some(dir) = evidence_dir() {
            std::fs::write(dir.join(format!("pops-{}-{}x{}.bgra", preset.wire(), size.0, size.1)), pop_map(&terrain.frames, size)).expect("pop map");
        }
        let row = format!(
            "{}: {total} one-frame pops over {} frames (bound {bound}), {stepped} stepped pixels, {} selection changes",
            preset.wire(),
            terrain.frames.len() - 2,
            terrain.switches
        );
        rows.push((row, total, bound, terrain.switches));
    }
    for (row, _, _, _) in &rows {
        eprintln!("{row}");
    }
    for (row, total, bound, switches) in rows {
        assert!(switches > 0, "the dolly changes the terrain's selection: {row}");
        assert!(total <= bound, "the terrain popped: {row}");
    }
}

/// The terrain's budget (TIER-AB plan A.7): at most this many milliseconds of GPU time a frame.
const TERRAIN_MS_MAX: f32 = 0.8;

/// GPU milliseconds of whole frames of each renderer drawing its scene, rounds interleaved (the
/// GPU's clocks and heat shared alike), median per renderer; None without timestamp queries.
fn frame_ms(gpu: &Gpu, runs: &mut [(Renderer, Scene)]) -> Option<Vec<f32>> {
    let mut landed: Vec<Vec<f32>> = vec![Vec::new(); runs.len()];
    for round in 0..6u64 {
        for (k, (renderer, scene)) in runs.iter_mut().enumerate() {
            for frame in 0..60u64 {
                let times = renderer.arm_frame_timer(&gpu.queue)?;
                if round > 0 && frame >= 8 {
                    landed[k].extend(times);
                }
                renderer.set_frame_index(frame);
                renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
                renderer.finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
    }
    Some(
        landed
            .into_iter()
            .map(|mut times| {
                times.sort_by(f32::total_cmp);
                times[times.len() / 2]
            })
            .collect(),
    )
}

/// A plain mesh of `desc`'s ground: a grid every `step` samples (the 0.75 m grid the lakeside's
/// ground was before the terrain), one textured material: what the terrain replaces.
fn mesh_ground(gpu: &Gpu, renderer: &mut Renderer, desc: &TerrainDesc, step: u32) -> (genex_render::scene::MeshId, genex_render::pbr::Material) {
    use genex_render::mesh::{MeshData, Vertex};
    let heights = &desc.heights;
    let (w, _) = heights.samples();
    let n = (w - 1) / step + 1;
    let mut vertices = Vec::with_capacity((n * n) as usize);
    for j in 0..n {
        for i in 0..n {
            let (x, z) = (i * step, j * step);
            let o = heights.origin();
            let p = [o[0] + x as f32 * heights.spacing(), heights.sample(x, z), o[1] + z as f32 * heights.spacing()];
            vertices.push(Vertex { position: p, normal: heights.normal_at(x, z), uv: [p[0] / 3.0, p[2] / 3.0], tangent: [1.0, 0.0, 0.0, 1.0] });
        }
    }
    let mut indices = Vec::with_capacity(((n - 1) * (n - 1) * 6) as usize);
    for j in 0..n - 1 {
        for i in 0..n - 1 {
            let a = j * n + i;
            indices.extend([a, a + n, a + n + 1, a, a + n + 1, a + 1]);
        }
    }
    let mesh = renderer.add_mesh(gpu, MeshData { vertices, indices }).expect("the mesh ground");
    let material = genex_render::pbr::Material::color([255, 255, 255, 255]).with_base_texture(desc.layers[0].albedo.expect("textured"));
    (mesh, material)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_terrain_costs_at_most_0_8_ms_a_frame_at_1440p() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let size = (2560, 1440);
    let mut rows = Vec::new();
    let shadows_off = std::env::var("GENEX_TERRAIN_COST_NO_SHADOWS").is_ok();
    for preset in [QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra] {
        let mut quality = preset_quality(preset, desktop_high());
        quality.shadows.enabled &= !shadows_off;
        let mut with = renderer(&gpu, size, &quality, false);
        let desc = terrain_of(&gpu, &mut with, hills(1025, 0.375, 0.08));
        with.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let mut meshed = renderer(&gpu, size, &quality, false);
        let mesh_desc = terrain_of(&gpu, &mut meshed, hills(1025, 0.375, 0.08));
        let (mesh, material) = mesh_ground(&gpu, &mut meshed, &mesh_desc, 2);
        let without = renderer(&gpu, size, &quality, false);
        // The walker's view across the hills: ground over most of the frame, the horizon in view,
        // every level of detail drawn and the cascades full of casters.
        let view = scene(walker(&desc, 0.0, -1.2));
        let mut ground = view.clone();
        ground.draw(mesh, genex_render::scene::translation(0.0, 0.0, 0.0), material);
        let Some(ms) = frame_ms(&gpu, &mut [(with, view.clone()), (meshed, ground), (without, view)]) else {
            eprintln!("skipped: no frame timer");
            return;
        };
        let [with, meshed, without] = [ms[0], ms[1], ms[2]];
        let cost = with - meshed;
        rows.push((
            format!("{}: {with:.3} ms with the terrain, {meshed:.3} ms with a 0.75 m mesh ground, {without:.3} ms with none: terrain over the mesh {cost:.3} ms (budget {TERRAIN_MS_MAX})", preset.wire()),
            cost,
        ));
    }
    for (row, _) in &rows {
        eprintln!("{row}");
    }
    if let Some(path) = std::env::var_os("GENEX_PERF_OUT") {
        let lines: String = rows.iter().map(|(row, cost)| format!("{}\n", serde_json::json!({ "row": "terrain-cost-1440p", "detail": row, "ms": cost }))).collect();
        std::fs::write(path, lines).expect("perf rows written");
    }
    for (row, cost) in rows {
        assert!(cost <= TERRAIN_MS_MAX, "{row}");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_terrain_casts_into_the_sun_cascades() {
    let Some(gpu) = gpu() else { return };
    let size = (480, 270);
    // The walker's view across the hills with the low sun behind the ridges: the terrain is the
    // only caster, so what its shadows darken is its own casting into the cascades.
    let lumas_of = |shadows: bool| {
        let mut quality = steady(QualityPreset::High);
        quality.shadows.enabled = shadows;
        quality.contact_shadows = false;
        let mut renderer = renderer(&gpu, size, &quality, false);
        let desc = terrain_of(&gpu, &mut renderer, hills(1025, 0.375, 0.08));
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let capture = settled(&gpu, &mut renderer, &scene(walker(&desc, 0.0, -1.2)), 24);
        write_capture(&format!("casts-{}", if shadows { "on" } else { "off" }), &capture);
        lumas(&capture)
    };
    let (on, off) = (lumas_of(true), lumas_of(false));
    let darker = on.iter().zip(&off).filter(|(a, b)| **b - **a > 12.0).count();
    let lighter = on.iter().zip(&off).filter(|(a, b)| **a - **b > 12.0).count();
    let share = darker as f64 / on.len() as f64;
    eprintln!("{darker} pixels darker with the shadows ({:.1}%), {lighter} lighter", share * 100.0);
    assert!(share > 0.05, "the hills shadow the ground behind them: {darker} pixels");
    assert!(lighter * 20 < darker.max(1), "shadows only darken: {lighter} lighter");
}

/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 6;
/// Pixels allowed past the tolerance (silhouette pixels where rasterization rounds differently).
const GOLDEN_OUTLIER_PIXELS: usize = 24;

fn goldens_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/terrain")
}

/// Compare `capture` with the golden `name` (raw BGRA, top row first), or rewrite it under
/// `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &genex_render::capture::Capture) {
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len());
    let mut outliers = 0;
    let mut worst = 0;
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_terrain_matches_its_settled_goldens() {
    let Some(gpu) = gpu() else { return };
    for preset in [QualityPreset::Medium, QualityPreset::High] {
        let quality = steady(preset);
        let mut renderer = renderer(&gpu, (128, 72), &quality, false);
        let desc = terrain_of(&gpu, &mut renderer, hills(1025, 0.375, 0.08));
        renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
        let capture = settled(&gpu, &mut renderer, &scene(walker(&desc, 0.0, -1.2)), 32);
        check_golden(&format!("walk-{}", preset.wire()), &capture);
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_control_map_picks_each_pixels_layers() {
    let Some(gpu) = gpu() else { return };
    // A flat 64 m square seen from above: layer 0 (red) where x < 0, layer 2 (blue) where x >= 0,
    // layer 1 (green) named by no texel.
    let quality = steady(QualityPreset::High);
    let mut renderer = renderer(&gpu, (128, 128), &quality, false);
    let heights = Heightfield::from_fn((129, 129), [-32.0, -32.0], 0.5, |_, _| 0.0).expect("flat");
    let layers = vec![TerrainLayer::flat([0.6, 0.02, 0.02]), TerrainLayer::flat([0.02, 0.6, 0.02]), TerrainLayer::flat([0.02, 0.02, 0.6])];
    let control = (0..129 * 129).map(|i| if i % 129 < 64 { ControlTexel::layer(0) } else { ControlTexel::layer(2) }).collect();
    let desc = TerrainDesc { heights, control, layers, look: genex_render::terrain::TerrainLook { macro_variation: 0.0, ..Default::default() } };
    renderer.set_terrain(&gpu, Some((&desc, 1))).expect("terrain");
    let mut top = CameraDesc::look_at([0.0, 40.0, 0.001], [0.0, 0.0, 0.0]);
    top.fovy_degrees = 60.0;
    let mut view = scene(top);
    view.lighting.sun_dir = [0.0, 1.0, 0.0];
    let capture = settled(&gpu, &mut renderer, &view, 8);
    let pixel = |x: usize, y: usize| {
        let p = &capture.bgra()[(y * 128 + x) * 4..(y * 128 + x) * 4 + 4];
        [p[2], p[1], p[0]]
    };
    // The camera looks down -y with +z up the screen... whichever way x maps, the two halves are
    // the two layers: one side red, the other blue, no green.
    let (left, right) = (pixel(20, 64), pixel(108, 64));
    let reddish = |c: [u8; 3]| c[0] > c[1].saturating_add(20) && c[0] > c[2].saturating_add(20);
    let bluish = |c: [u8; 3]| c[2] > c[0].saturating_add(20) && c[2] > c[1].saturating_add(20);
    assert!((reddish(left) && bluish(right)) || (bluish(left) && reddish(right)), "left {left:?} right {right:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_budget_ledger_holds_the_terrain_and_lets_it_go() {
    use genex_render::budget::BudgetKind;
    let Some(gpu) = gpu() else { return };
    let mut renderer = renderer(&gpu, (64, 64), &steady(QualityPreset::Medium), false);
    let row = |renderer: &Renderer| {
        renderer.buffer_ledger().entries().iter().find(|entry| entry.label == genex_render::terrain::TERRAIN_LEDGER_LABEL).map(|entry| (entry.kind, entry.bytes))
    };
    assert_eq!(row(&renderer), None, "no terrain, no row");
    let desc = TerrainDesc::new(hills(257, 0.5, 0.1), TerrainLayer::flat([0.2, 0.3, 0.1]));
    renderer.set_terrain(&gpu, Some((&desc, 7))).expect("terrain");
    let (kind, bytes) = row(&renderer).expect("the terrain's row");
    // Heights (two a word), control words and the normal pyramid (about 4/3 of a word a sample).
    let samples = 257u64 * 257;
    assert_eq!(kind, BudgetKind::Buffers);
    assert!(bytes >= samples * 2 + samples * 4 + samples * 4, "{bytes} bytes");
    assert_eq!(renderer.terrain_version(), Some(7));
    renderer.set_terrain(&gpu, None).expect("no terrain");
    assert_eq!((row(&renderer), renderer.terrain_version()), (None, None));
}
