//! Game systems AN-25: skinned levels of detail. A skinned mesh with levels skins only the level its
//! distance picks (the cull's own choice): compute near, the vertex path far. Inside the fade band
//! the two crossfading levels are both skinned and drawn through the LOD-03 fade batches, so a
//! dolly through a switch never draws an instance twice or not at all. Levels keep the base
//! vertices' `JOINTS_0`/`WEIGHTS_0` and pose with the base palette.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test skinned_lod -- --include-ignored
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the dolly's captures (PNG) and its coverage numbers.

use std::path::PathBuf;

use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::{LOD_FADE_TAG, LodChain, LodLevel, MeshData, Vertex};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PlanOptions, Scene, scaled, translation};
use genex_render::skin::{Skeleton, SkeletonNode, SkinId, SkinPart, SkinnedMeshData, SkinnedModel, Trs};
use genex_render::skin_vertex::SkinVertexPolicy;
use genex_render::skinned_lod::{SkinnedLevel, skinned_levels};
use genex_render::{CullPath, Gpu, Renderer};

/// Rows of the fixture strip (64 quads); level `k` keeps every `2^k`-th row.
const ROWS: u32 = 65;
/// The fixture's level errors in metres: level 1 from about 4 m, 2 from 19 m, 3 from 94 m, 4 from
/// 190 m at 1 px on a 1080-pixel, 60-degree view.
const ERRORS: [f32; 4] = [0.004, 0.02, 0.1, 0.2];
/// The fade band the presets draw (desktop high).
const BAND: f32 = 0.15;
/// A fade share is a whole number of 1024ths.
const SHARE_STEP: f32 = 1.0 / 1024.0;
const WIDTH: u32 = 192;
const HEIGHT: u32 = 192;

// ---------------------------------------------------------------------------------------------
// Fixtures

/// A two-joint strip of 2 x [`ROWS`] vertices, 0.4 m wide and 1.8 m tall (a knee at mid height).
fn strip() -> SkinnedMeshData {
    let mut vertices = Vec::new();
    let mut skin = Vec::new();
    for r in 0..ROWS {
        for c in 0..2 {
            let (u, v) = (c as f32, r as f32 / (ROWS - 1) as f32);
            vertices.push(Vertex { position: [(u - 0.5) * 0.4, v * 1.8, 0.0], normal: [0.0, 0.0, 1.0], uv: [u, 1.0 - v], tangent: [1.0, 0.0, 0.0, 1.0] });
            let upper = ((v - 0.35) / 0.3).clamp(0.0, 1.0);
            skin.push(GpuSkinVertex { joints: [0, 1, 0, 0], weights: [1.0 - upper, upper, 0.0, 0.0] });
        }
    }
    let indices = rows_every(1);
    let nodes = vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }, SkeletonNode { parent: Some(0), rest: Trs::IDENTITY }];
    let skeleton = Skeleton { nodes, joints: vec![0, 1], inverse_bind: vec![translation(0.0, 0.0, 0.0), translation(0.0, 0.0, 0.0)], mesh_node: None };
    SkinnedMeshData { mesh: MeshData { vertices, indices }, skin, skeleton, animations: Vec::new() }
}

/// The strip's triangles over every `step`-th row.
fn rows_every(step: u32) -> Vec<u32> {
    let mut indices = Vec::new();
    for r in (0..ROWS - 1).step_by(step as usize) {
        let (a, b, d, e) = (2 * r, 2 * r + 1, 2 * (r + step), 2 * (r + step) + 1);
        indices.extend([a, b, e, a, e, d]);
    }
    indices
}

/// The strip's four levels.
fn chain() -> LodChain {
    LodChain { casters: 0, levels: (1..=4).map(|k| LodLevel { indices: rows_every(1 << k), error: ERRORS[k - 1] }).collect() }
}

fn levels(data: &SkinnedMeshData) -> Vec<SkinnedLevel> {
    skinned_levels(&data.mesh, &data.skin, &[SkinPart::whole(&data.mesh)], &[Some(chain())])
}

/// The strip's palette with its knee bent by `angle` radians about z at 0.9 m.
fn bent(angle: f32) -> Vec<[f32; 16]> {
    let (s, c) = (libm::sinf(angle), libm::cosf(angle));
    let knee = 0.9;
    let upper = [c, s, 0.0, 0.0, -s, c, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, knee * s, knee - knee * c, 0.0, 1.0];
    vec![translation(0.0, 0.0, 0.0), upper]
}

/// The strip drawn at the origin, seen from `distance` metres down +z with a fade band of `band`.
fn scene_at(skin: SkinId, distance: f32, band: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.9, distance], [0.0, 0.9, 0.0]), [20, 24, 30, 255]);
    scene.lighting.shadows = false;
    scene.lod_band = band;
    scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), bent(0.4), Material::color([230, 140, 60, 255]));
    scene
}

fn options() -> PlanOptions {
    PlanOptions { shadows: None, depth_reversed: false, sun: None }
}

/// A library holding the strip with its levels, and one without.
fn library() -> (MeshLibrary, SkinId, SkinId) {
    let data = strip();
    let mut library = MeshLibrary::new();
    let levelled = library.add_skinned(&data).expect("strip");
    library.add_skinned_levels(levelled, &data, &levels(&data)).expect("levels");
    let whole = library.add_skinned(&data).expect("strip without levels");
    (library, levelled, whole)
}

/// The plan's skinned coverage of its one draw on the CPU cull: each kept slot counts 1 whole, or
/// its fade's share; with the levels each kept slot draws.
fn coverage(plan: &FramePlan) -> (f32, Vec<u32>) {
    let cull = plan.cpu_cull();
    let mut total = 0.0;
    let mut kept = Vec::new();
    for (at, batch) in plan.batches.iter().enumerate() {
        for slot in batch.first_instance..batch.first_instance + cull.counts[at] {
            let fade = if batch.lod[0] & LOD_FADE_TAG != 0 { cull.fades[slot as usize][0] } else { 1.0 };
            total += fade.abs();
            kept.push(batch.index_count / 6);
        }
    }
    (total, kept)
}

// ---------------------------------------------------------------------------------------------
// The levels

#[test]
fn a_four_level_skinned_fixture_at_sixty_metres_skins_the_level_two_vertex_count() {
    let (library, levelled, whole) = library();
    let (base, level_two) = (2 * ROWS, 2 * (ROWS / 4 + 1));
    for band in [0.0, BAND] {
        let plan = FramePlan::build_with_skin_paths(&scene_at(levelled, 60.0, band), &library, 1.0, &options(), false, &[]).expect("plan");
        assert_eq!(plan.skinned_vertices, level_two, "band {band}: level 2 ({level_two} vertices), not level 0 ({base})");
        assert_eq!(plan.skin_jobs.len(), 1);
        // Without levels the same draw skins level 0, as every skinned mesh did before AN-25.
        let plan = FramePlan::build_with_skin_paths(&scene_at(whole, 60.0, band), &library, 1.0, &options(), false, &[]).expect("plan");
        assert_eq!(plan.skinned_vertices, base);
        assert!(plan.batches.iter().all(|batch| batch.lod == [0; 3]) && plan.fade_runs.is_empty(), "an unlevelled skin plans as before");
    }
}

#[test]
fn a_far_vertex_path_draw_draws_its_level_and_takes_no_job() {
    let (library, levelled, _) = library();
    let plan = FramePlan::build_with_skin_paths(&scene_at(levelled, 60.0, BAND), &library, 1.0, &options(), false, &[true]).expect("plan");
    assert_eq!((plan.skin_jobs.len(), plan.vertex_skinned.len()), (0, 1));
    let level_skin = plan.vertex_skinned[0].skin;
    assert_ne!(level_skin, levelled, "the level's skin, not the base");
    assert_eq!(library.skin_lods(levelled).expect("levels").levels[1], level_skin, "level 2");
    assert_eq!(library.entry(level_skin.mesh()).expect("level").vertex_count, 2 * (ROWS / 4 + 1));
}

#[test]
fn levels_keep_their_joints_and_weights_and_share_the_palette() {
    let data = strip();
    for (k, level) in levels(&data).iter().enumerate() {
        assert_eq!(level.mesh.vertices.len(), level.skin.len());
        for (vertex, row) in level.mesh.vertices.iter().zip(&level.skin) {
            let source = data.mesh.vertices.iter().position(|base| base.position == vertex.position).expect("a base vertex");
            assert_eq!(*row, data.skin[source], "level {} keeps JOINTS_0/WEIGHTS_0", k + 1);
        }
    }
    // In a band both levels skin with one palette: the joint table holds the draw's once.
    let (library, levelled, _) = library();
    let banded = (100..4000).map(|step| step as f32 * 0.05).find_map(|distance| {
        let plan = FramePlan::build_with_skin_paths(&scene_at(levelled, distance, BAND), &library, 1.0, &options(), false, &[]).expect("plan");
        (plan.skin_jobs.len() == 2).then_some(plan)
    });
    let plan = banded.expect("a distance inside a band");
    assert_eq!(plan.joints.len(), 2, "one palette of two joints");
    assert!(plan.skin_jobs.iter().all(|job| job.joint_base == 0));
    assert!(!plan.fade_runs.is_empty(), "the two levels draw through fade batches");
}

#[test]
fn a_dolly_through_every_switch_draws_the_strip_exactly_once_every_step() {
    let (library, levelled, _) = library();
    let mut seen_levels = std::collections::BTreeSet::new();
    let mut bands = 0;
    for band in [0.0, BAND] {
        for step in 0..1600 {
            let distance = 0.5 + step as f32 * 0.25;
            let plan = FramePlan::build_with_skin_paths(&scene_at(levelled, distance, band), &library, 1.0, &options(), false, &[]).expect("plan");
            let (total, kept) = coverage(&plan);
            assert!((total - 1.0).abs() <= SHARE_STEP, "band {band} at {distance} m: coverage {total}, kept {kept:?}");
            assert_eq!(kept.len(), plan.skin_jobs.len(), "at {distance} m every skinned level is drawn and nothing else");
            bands += usize::from(kept.len() == 2);
            seen_levels.extend(kept);
        }
    }
    assert_eq!(seen_levels.len(), 5, "every level is drawn on the dolly (quads per level): {seen_levels:?}");
    assert!(bands > 0, "the dolly crosses the bands");
}

#[test]
fn hostile_levels_are_refused_and_nothing_is_added() {
    let data = strip();
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&data).expect("strip");
    let before = library.len();
    let mut falling = levels(&data);
    falling[1].error = 0.0;
    let mut two_parts = levels(&data);
    let first_part = two_parts[0].parts[0];
    two_parts[0].parts.push(first_part);
    let mut leaving = levels(&data);
    leaving[0].mesh.indices[0] = 10_000;
    for (name, hostile) in [("falling errors", falling), ("parts", two_parts), ("index", leaving)] {
        assert!(library.add_skinned_levels(skin, &data, &hostile).is_err(), "{name}");
        assert_eq!(library.len(), before, "{name}: nothing added");
        assert!(library.skin_lods(skin).is_none());
    }
    library.add_skinned_levels(skin, &data, &levels(&data)).expect("levels");
    assert!(library.add_skinned_levels(skin, &data, &levels(&data)).is_err(), "a second chain");
}

// ---------------------------------------------------------------------------------------------
// The GLB

fn push_f32(bin: &mut Vec<u8>, values: &[f32]) {
    bin.extend(values.iter().flat_map(|v| v.to_le_bytes()));
}

/// The strip as a skinned GLB whose primitive carries its four levels in `extras.genex_lods`.
fn strip_glb() -> Vec<u8> {
    let data = strip();
    let mut bin = Vec::new();
    let mut views = Vec::new();
    let mut view = |bin: &mut Vec<u8>, bytes: &[u8]| {
        views.push(format!(r#"{{"buffer":0,"byteOffset":{},"byteLength":{}}}"#, bin.len(), bytes.len()));
        bin.extend(bytes);
        views.len() - 1
    };
    let count = data.mesh.vertices.len();
    let mut positions = Vec::new();
    let mut normals = Vec::new();
    let mut weights = Vec::new();
    for (vertex, row) in data.mesh.vertices.iter().zip(&data.skin) {
        push_f32(&mut positions, &vertex.position);
        push_f32(&mut normals, &vertex.normal);
        push_f32(&mut weights, &row.weights);
    }
    let joints: Vec<u8> = data.skin.iter().flat_map(|row| row.joints.map(|j| j as u16)).flat_map(u16::to_le_bytes).collect();
    let indices: Vec<u8> = data.mesh.indices.iter().flat_map(|i| i.to_le_bytes()).collect();
    let (p, n, j, w, i) = (view(&mut bin, &positions), view(&mut bin, &normals), view(&mut bin, &joints), view(&mut bin, &weights), view(&mut bin, &indices));
    let mut words = Vec::new();
    let mut entries = Vec::new();
    for level in chain().levels {
        entries.push(format!(r#"{{"first":{},"count":{},"error":{}}}"#, words.len(), level.indices.len(), level.error));
        words.extend(level.indices);
    }
    let lod_bytes: Vec<u8> = words.iter().flat_map(|i| i.to_le_bytes()).collect();
    let lods = view(&mut bin, &lod_bytes);
    let mut ibm = Vec::new();
    push_f32(&mut ibm, &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0].repeat(2));
    let ibm_view = view(&mut bin, &ibm);
    let accessors = [
        format!(r#"{{"bufferView":{p},"componentType":5126,"count":{count},"type":"VEC3","min":[-0.2,0,0],"max":[0.2,1.8,0]}}"#),
        format!(r#"{{"bufferView":{n},"componentType":5126,"count":{count},"type":"VEC3"}}"#),
        format!(r#"{{"bufferView":{j},"componentType":5123,"count":{count},"type":"VEC4"}}"#),
        format!(r#"{{"bufferView":{w},"componentType":5126,"count":{count},"type":"VEC4"}}"#),
        format!(r#"{{"bufferView":{i},"componentType":5125,"count":{},"type":"SCALAR"}}"#, data.mesh.indices.len()),
        format!(r#"{{"bufferView":{ibm_view},"componentType":5126,"count":2,"type":"MAT4"}}"#),
    ];
    let extras = format!(r#"{{"genex_lods":{{"version":1,"indices":{lods},"levels":[{}]}}}}"#, entries.join(","));
    let json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"bufferViews":[{}],"accessors":[{}],
        "meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"NORMAL":1,"JOINTS_0":2,"WEIGHTS_0":3}},"indices":4,"extras":{extras}}}]}}],
        "nodes":[{{"mesh":0,"skin":0}},{{"name":"hip","children":[2]}},{{"name":"knee"}}],"skins":[{{"joints":[1,2],"inverseBindMatrices":5}}],
        "scenes":[{{"nodes":[0,1]}}],"scene":0}}"#,
        bin.len(),
        views.join(","),
        accessors.join(","),
    );
    let mut json = json.into_bytes();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut out = b"glTF".to_vec();
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

#[test]
fn a_skinned_glb_with_genex_lods_loads_its_levels() {
    let model = SkinnedModel::from_glb(&strip_glb()).expect("the strip GLB loads");
    assert_eq!(model.data.mesh.vertices.len(), (2 * ROWS) as usize);
    let counts: Vec<usize> = model.levels.iter().map(|level| level.mesh.vertices.len()).collect();
    assert_eq!(counts, [66, 34, 18, 10], "each level keeps only the rows it uses");
    let errors: Vec<f32> = model.levels.iter().map(|level| level.error).collect();
    assert_eq!(errors, ERRORS);
    assert_eq!(model.levels, levels(&model.data), "the GLB's levels are the fixture's");
}

// ---------------------------------------------------------------------------------------------
// The GPU

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

fn evidence_dir() -> Option<PathBuf> {
    std::env::var("GENEX_RENDER_EVIDENCE_DIR").ok().map(PathBuf::from)
}

/// An RGB PNG of a BGRA capture: zlib stored blocks, no compression (evidence only).
fn png(width: u32, height: u32, bgra: &[u8]) -> Vec<u8> {
    fn crc(bytes: &[u8]) -> u32 {
        let mut c = 0xffff_ffffu32;
        for byte in bytes {
            c ^= u32::from(*byte);
            for _ in 0..8 {
                c = if c & 1 == 1 { 0xedb8_8320 ^ (c >> 1) } else { c >> 1 };
            }
        }
        !c
    }
    let chunk = |out: &mut Vec<u8>, kind: &[u8], data: &[u8]| {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend_from_slice(data);
        out.extend_from_slice(&body);
        out.extend(crc(&body).to_be_bytes());
    };
    let mut raw = Vec::with_capacity(((width * 3 + 1) * height) as usize);
    for row in bgra.chunks((width * 4) as usize) {
        raw.push(0);
        raw.extend(row.chunks(4).flat_map(|p| [p[2], p[1], p[0]]));
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        let len = block.len() as u16;
        zlib.extend(len.to_le_bytes());
        zlib.extend((!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for byte in &raw {
        a = (a + u32::from(*byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut out = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    let mut header = Vec::new();
    header.extend(width.to_be_bytes());
    header.extend(height.to_be_bytes());
    header.extend([8, 2, 0, 0, 0]);
    chunk(&mut out, b"IHDR", &header);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// Pixels of a capture that differ from the clear colour.
fn covered(bgra: &[u8]) -> usize {
    bgra.chunks(4).filter(|p| p[0].abs_diff(30) > 8 || p[1].abs_diff(24) > 8 || p[2].abs_diff(20) > 8).count()
}

/// The dolly's frame at `distance`: the renderer picks levels for its 192-pixel output, so the
/// switches come at 192/1080 of the nominal distances (level 4 from about 34 m).
fn dolly_scene(skin: SkinId, distance: f32) -> Scene {
    scene_at(skin, distance, BAND)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_dolly_through_the_switches_never_pops() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let data = strip();
    let model = SkinnedModel { data: data.clone(), parts: vec![SkinPart::whole(&data.mesh)], levels: levels(&data) };
    let skin = renderer.add_skinned_model(&gpu, &model).expect("skinned");
    let mut report = String::from("distance,jobs,vertex_draws,covered\n");
    for policy in [SkinVertexPolicy::Compute, SkinVertexPolicy::Auto] {
        renderer.set_skin_vertex_policy(policy);
        let mut last: Option<usize> = None;
        for step in 0..100 {
            let distance = 2.0 * libm::powf(1.035, step as f32);
            renderer.render(&gpu, &dolly_scene(skin, distance), CullPath::Gpu).expect("frame");
            let bgra = renderer.capture(&gpu).expect("capture").bgra().to_vec();
            let pixels = covered(&bgra);
            let (jobs, vertex) = (renderer.last_stats().skin_jobs, renderer.last_vertex_skinned_draws());
            report.push_str(&format!("{policy:?} {distance:.2},{jobs},{vertex},{pixels}\n"));
            assert!(pixels > 0, "{policy:?} at {distance} m: the strip is drawn");
            if let Some(before) = last {
                // A frame that dropped or doubled a level would lose or keep a whole strip's pixels.
                let change = pixels.abs_diff(before) as f32 / before.max(1) as f32;
                assert!(change < 0.35, "{policy:?} at {distance} m: {before} -> {pixels} pixels");
            }
            last = Some(pixels);
            if let Some(dir) = evidence_dir().filter(|_| step % 20 == 0) {
                let _ = std::fs::create_dir_all(&dir);
                std::fs::write(dir.join(format!("skinned-lod-{policy:?}-{step:03}.png")), png(WIDTH, HEIGHT, &bgra)).expect("png");
            }
        }
    }
    if let Some(dir) = evidence_dir() {
        std::fs::write(dir.join("skinned-lod-dolly.csv"), report).expect("report");
    }
}

/// The shadowed dolly's frame: the strip on a grey ground under a sun behind the camera's
/// shoulder, its shadow cast onto the ground behind it where the camera sees it.
fn shadowed_scene(skin: SkinId, ground: MeshId, distance: f32) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.9, distance], [0.0, 0.9, 0.0]), [20, 24, 30, 255]);
    scene.lighting.shadows = true;
    scene.lighting.sun_dir = [0.5, 0.55, 0.65];
    scene.lod_band = BAND;
    scene.draw(ground, scaled([0.0, -0.01, 20.0], [80.0, 0.02, 120.0]), Material::color([150, 150, 150, 255]));
    scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), bent(0.4), Material::color([230, 140, 60, 255]));
    scene
}

/// A capture's strip pixels (orange) and shadow pixels (ground rows below the horizon at under
/// 60% of the lit ground's median luminance).
fn strip_and_shadow(bgra: &[u8]) -> (usize, usize) {
    let luminance = |p: &[u8]| 0.2126 * f32::from(p[2]) + 0.7152 * f32::from(p[1]) + 0.0722 * f32::from(p[0]);
    let orange = |p: &[u8]| p[2] > p[1].saturating_add(40) && p[2] > p[0].saturating_add(80);
    let strip = bgra.chunks(4).filter(|p| orange(p)).count();
    let below = &bgra[(HEIGHT / 2 + 2) as usize * WIDTH as usize * 4..];
    let mut ground: Vec<f32> = below.chunks(4).filter(|p| !orange(p)).map(luminance).collect();
    ground.sort_by(f32::total_cmp);
    let lit = ground.get(ground.len() / 2).copied().unwrap_or(0.0);
    let shadow = ground.iter().filter(|l| **l < 0.6 * lit).count();
    (strip, shadow)
}

/// The levelled strip and its shadow, dollied through the switches with shadows on, against the
/// same strip without levels: in no frame does the levelled one lose or double its strip or its
/// shadow (a level dropped for a frame, or both band levels drawn whole, in either pass).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_shadowed_dolly_keeps_the_strip_and_its_shadow_against_an_unlevelled_twin() {
    let Some(gpu) = gpu() else { return };
    let data = strip();
    let mut pair = Vec::new();
    for levelled in [true, false] {
        let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
        let levels = if levelled { levels(&data) } else { Vec::new() };
        let skin = renderer.add_skinned_model(&gpu, &SkinnedModel { data: data.clone(), parts: vec![SkinPart::whole(&data.mesh)], levels }).expect("skinned");
        let ground = renderer.add_mesh(&gpu, MeshData::cube()).expect("ground");
        pair.push((renderer, skin, ground));
    }
    let mut report = String::from("distance,strip_levels,strip_whole,shadow_levels,shadow_whole\n");
    for step in 0..80 {
        let distance = 2.0 * libm::powf(1.035, step as f32);
        let mut counts = Vec::new();
        for (at, (renderer, skin, ground)) in pair.iter_mut().enumerate() {
            renderer.render(&gpu, &shadowed_scene(*skin, *ground, distance), CullPath::Gpu).expect("frame");
            let bgra = renderer.capture(&gpu).expect("capture").bgra().to_vec();
            if let Some(dir) = evidence_dir().filter(|_| step % 20 == 0) {
                let _ = std::fs::create_dir_all(&dir);
                let name = if at == 0 { "levels" } else { "whole" };
                std::fs::write(dir.join(format!("skinned-lod-shadowed-{name}-{step:03}.png")), png(WIDTH, HEIGHT, &bgra)).expect("png");
            }
            counts.push(strip_and_shadow(&bgra));
        }
        let ((strip, shadow), (strip_whole, shadow_whole)) = (counts[0], counts[1]);
        report.push_str(&format!("{distance:.2},{strip},{strip_whole},{shadow},{shadow_whole}\n"));
        for (name, mine, twin) in [("strip", strip, strip_whole), ("shadow", shadow, shadow_whole)] {
            let off = mine.abs_diff(twin) as f32 / twin.max(1) as f32;
            assert!(twin < SHADOWED_MIN_PIXELS || off < SHADOWED_TWIN_TOLERANCE, "at {distance} m the {name} covers {mine} pixels against {twin} without levels");
        }
    }
    if let Some(dir) = evidence_dir() {
        std::fs::write(dir.join("skinned-lod-shadowed.csv"), report).expect("report");
    }
}

/// Below this many pixels the twin comparison is noise (the strip a few pixels wide).
const SHADOWED_MIN_PIXELS: usize = 40;
/// How far the levelled strip or shadow may differ from the unlevelled twin's: a coarser level
/// moves an edge by a pixel, a dropped or doubled level by the whole.
const SHADOWED_TWIN_TOLERANCE: f32 = 0.3;

/// A character-sized skinned grid: `columns` x `rows` vertices, 0.5 m wide and 1.8 m tall, with
/// levels keeping every 2nd, 4th, 8th and 16th row (`rows - 1` a multiple of 16).
fn character(columns: u32, rows: u32) -> SkinnedModel {
    let mut vertices = Vec::new();
    let mut skin = Vec::new();
    for r in 0..rows {
        for c in 0..columns {
            let (u, v) = (c as f32 / (columns - 1) as f32, r as f32 / (rows - 1) as f32);
            vertices.push(Vertex { position: [(u - 0.5) * 0.5, v * 1.8, 0.0], normal: [0.0, 0.0, 1.0], uv: [u, 1.0 - v], tangent: [1.0, 0.0, 0.0, 1.0] });
            let upper = ((v - 0.35) / 0.3).clamp(0.0, 1.0);
            skin.push(GpuSkinVertex { joints: [0, 1, 0, 0], weights: [1.0 - upper, upper, 0.0, 0.0] });
        }
    }
    let grid = |step: u32| {
        let mut indices = Vec::new();
        for r in (0..rows - 1).step_by(step as usize) {
            for c in 0..columns - 1 {
                let (a, d) = (r * columns + c, (r + step) * columns + c);
                indices.extend([a, a + 1, d + 1, a, d + 1, d]);
            }
        }
        indices
    };
    let nodes = vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }, SkeletonNode { parent: Some(0), rest: Trs::IDENTITY }];
    let skeleton = Skeleton { nodes, joints: vec![0, 1], inverse_bind: vec![translation(0.0, 0.0, 0.0), translation(0.0, 0.0, 0.0)], mesh_node: None };
    let data = SkinnedMeshData { mesh: MeshData { vertices, indices: grid(1) }, skin, skeleton, animations: Vec::new() };
    let chain = LodChain { casters: 0, levels: (1..=4).map(|k| LodLevel { indices: grid(1 << k), error: ERRORS[k - 1] }).collect() };
    let levels = skinned_levels(&data.mesh, &data.skin, &[SkinPart::whole(&data.mesh)], &[Some(chain)]);
    SkinnedModel { parts: vec![SkinPart::whole(&data.mesh)], data, levels }
}

/// Mobile-high's skinned memory for 30 characters (game systems AN-23's class: at most 48 MB
/// skinned with levels).
const MOBILE_HIGH_SKINNED_BYTES_MAX: u64 = 48 * 1024 * 1024;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_mobile_high_draws_thirty_levelled_characters_within_the_skinned_cap() {
    use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    let Some(gpu) = gpu() else { return };
    let quality = preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Mobile, PerformanceTier::High));
    let (width, height) = (1170, 540);
    let held = |renderer: &Renderer| -> u64 {
        let labels = ["skinned vertices", "previous skinned vertices", "skinned slots", "vertex skin table"];
        renderer.buffer_ledger().entries().iter().filter(|entry| labels.contains(&entry.label.as_str())).map(|entry| entry.bytes).sum()
    };
    let mut lines = String::new();
    let mut bytes = Vec::new();
    for (name, levelled, policy) in [("whole-compute", false, SkinVertexPolicy::Compute), ("levels-compute", true, SkinVertexPolicy::Compute), ("levels-auto", true, SkinVertexPolicy::Auto)] {
        let mut renderer = Renderer::new(&gpu, width, height).expect("renderer");
        renderer.set_quality(&quality);
        renderer.set_skin_vertex_policy(policy);
        let mut model = character(12, 401);
        if !levelled {
            model.levels.clear();
        }
        let skin = renderer.add_skinned_model(&gpu, &model).expect("character");
        let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.6, 4.0], [0.0, 0.9, -20.0]), [20, 24, 30, 255]);
        for i in 0..30 {
            // 6 within 6 m, the rest out to 60 m, every one its own pose (no shared job).
            let z = if i < 6 { -1.0 - i as f32 } else { -8.0 - (i - 6) as f32 * 2.2 };
            scene.set_id(Some(genex_render::motion::DrawId::from_key(&format!("character-{i}"))));
            scene.draw_skinned(skin, translation((i % 6) as f32 * 1.2 - 3.0, 0.0, z), bent(0.2 + 0.01 * i as f32), Material::color([230, 140, 60, 255]));
        }
        for frame in 0..3 {
            renderer.set_frame_index(frame);
            renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
        }
        let total = held(&renderer);
        lines.push_str(&format!("{name}: 30 x {} vertices, {width}x{height} mobile-high: skinned bytes {total}, jobs {}, vertex draws {}\n", model.data.mesh.vertices.len(), renderer.last_stats().skin_jobs, renderer.last_vertex_skinned_draws()));
        bytes.push(total);
    }
    eprint!("{lines}");
    if let Some(dir) = evidence_dir() {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join("an25-mobile-high-thirty.txt"), &lines).expect("evidence");
    }
    assert!(bytes[1] < bytes[0], "levels skin fewer vertices: {bytes:?}");
    assert!(bytes[1] <= MOBILE_HIGH_SKINNED_BYTES_MAX && bytes[2] <= MOBILE_HIGH_SKINNED_BYTES_MAX, "{bytes:?}");
}
