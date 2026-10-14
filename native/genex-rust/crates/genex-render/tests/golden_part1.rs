//! Renderer V1 part 1 (M2.5): GPU-driven tables and culling, PBR with normal maps, a point-light
//! table, two-cascade shadows, compute skinning, instancing, sorted transparency, mips and MSAA.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! Each golden row renders its scene twice, through the GPU-culled indirect path and through the
//! CPU-culled direct-draw reference, and holds the two frames equal at tolerance 0 before comparing
//! the GPU frame with its golden in `tests/fixtures/render-goldens/part1/<name>.bgra` (raw BGRA,
//! top row first). `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites the goldens instead; review the diff.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::layout::{MAX_LIGHTS, NO_TEXTURE};
use genex_render::mesh::{MeshData, Vertex};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, PointLight, Scene, scaled, translation};
use genex_render::shadow::cascades;
use genex_render::skin::{MAX_JOINTS, SkinnedMeshData, skin_vertices_cpu};
use genex_render::texture::{TEXTURE_LAYER_PX, TextureData, TextureKind, mip_chain};
use genex_render::transparent::back_to_front;
use genex_render::{CullPath, Gpu, RenderCode, RenderOptions, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;
/// Compute skinning against the CPU reference.
const SKIN_TOLERANCE: f32 = 1e-5;

// ---------------------------------------------------------------------------------------------
// Fixtures

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

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/part1")
}

fn write_evidence(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    write_evidence(&format!("{name}.bgra"), capture.bgra());
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path)
        .unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len(), "{name}: golden size");
    let mut outliers = 0;
    let mut worst = 0u8;
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(x, y)| x.abs_diff(*y)).max().unwrap_or(0);
        worst = worst.max(diff);
        if diff > GOLDEN_CHANNEL_TOLERANCE {
            outliers += 1;
        }
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

type Build = fn(&mut Renderer, &Gpu) -> Scene;

/// Render `build` through both cull paths (fresh renderers) and hold them equal at tolerance 0.
fn render_both(build: Build, options: RenderOptions) -> Option<(Capture, Renderer, Gpu)> {
    let gpu = gpu()?;
    let mut indirect = Renderer::with_options(&gpu, WIDTH, HEIGHT, options).expect("renderer");
    let scene = build(&mut indirect, &gpu);
    indirect.render(&gpu, &scene, CullPath::Gpu).expect("gpu-culled frame");
    let gpu_frame = indirect.capture(&gpu).expect("capture");
    let mut direct = Renderer::with_options(&gpu, WIDTH, HEIGHT, options).expect("renderer");
    let scene = build(&mut direct, &gpu);
    direct.render(&gpu, &scene, CullPath::Cpu).expect("cpu-culled frame");
    let cpu_frame = direct.capture(&gpu).expect("capture");
    assert!(gpu_frame.bgra() == cpu_frame.bgra(), "the GPU-culled indirect frame differs from the CPU-culled direct frame");
    let (gpu_stats, cpu_stats) = (indirect.last_stats(), direct.last_stats());
    assert_eq!(gpu_stats.logical_draws, cpu_stats.logical_draws);
    assert_eq!(gpu_stats.direct_opaque_draws, 0, "the GPU path draws every opaque batch indirectly");
    assert_eq!(cpu_stats.indirect_draws, 0);
    Some((gpu_frame, indirect, gpu))
}

fn golden(name: &str, build: Build) {
    let Some((capture, _, _)) = render_both(build, RenderOptions::default()) else { return };
    check_golden(name, &capture);
}

fn pixel(capture: &Capture, x: u32, y: u32) -> [u8; 4] {
    let i = ((y * capture.width() + x) * 4) as usize;
    capture.bgra()[i..i + 4].try_into().expect("pixel")
}

fn luma(capture: &Capture) -> f64 {
    let sum: u64 = capture.bgra().chunks(4).map(|p| u64::from(p[0]) + u64::from(p[1]) + u64::from(p[2])).sum();
    sum as f64 / (capture.bgra().len() / 4) as f64
}

/// Pixels well between the black clear and the face (its darkest interior pixel, which a lit
/// flat face keeps within a few levels of its brightest): partially covered edge pixels.
const FACE_SHADING_LEVELS: u8 = 8;

fn edge_pixels(capture: &Capture) -> usize {
    let face = capture.bgra().chunks(4).map(|p| p[1]).max().unwrap_or(0).saturating_sub(FACE_SHADING_LEVELS);
    capture.bgra().chunks(4).filter(|p| p[1] > 0 && p[1] < face).count()
}

/// A square RGBA8 image from a per-pixel function.
fn image(size: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> TextureData {
    let mut rgba = Vec::with_capacity((size * size * 4) as usize);
    for y in 0..size {
        for x in 0..size {
            rgba.extend(f(x, y));
        }
    }
    TextureData::rgba8(size, size, rgba).expect("texture")
}

fn checker(size: u32, cell: u32) -> TextureData {
    image(size, |x, y| if (x / cell + y / cell).is_multiple_of(2) { [235, 235, 235, 255] } else { [20, 20, 20, 255] })
}

/// A tangent-space normal map of round bumps on a grid.
fn bumps(size: u32, cells: u32) -> TextureData {
    let cell = size / cells;
    image(size, |x, y| {
        let (u, v) = ((x % cell) as f32 / cell as f32 - 0.5, (y % cell) as f32 / cell as f32 - 0.5);
        let (nx, ny) = (u * 1.6, v * 1.6);
        let nz = (1.0 - (nx * nx + ny * ny).min(0.95)).sqrt();
        let enc = |c: f32| ((c * 0.5 + 0.5) * 255.0).round() as u8;
        [enc(nx), enc(ny), enc(nz), 255]
    })
}

fn ground() -> [f32; 16] {
    scaled([0.0, -0.6, 0.0], [14.0, 0.2, 14.0])
}

// ---------------------------------------------------------------------------------------------
// A skinned glTF: a bar of two segments along +Y skinned to a root joint and a child joint at
// y = 1, with one animation turning the child 90° about +Z over one second.

const BAR_RINGS: usize = 3;
const BAR_HALF: f32 = 0.25;

fn push_f32(bin: &mut Vec<u8>, values: &[f32]) {
    bin.extend(values.iter().flat_map(|f| f.to_le_bytes()));
}

fn skinned_bar_glb(joint_index_override: Option<u16>) -> Vec<u8> {
    let corners = [(BAR_HALF, BAR_HALF), (-BAR_HALF, BAR_HALF), (-BAR_HALF, -BAR_HALF), (BAR_HALF, -BAR_HALF)];
    let (mut positions, mut normals, mut joints, mut weights) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for ring in 0..BAR_RINGS {
        let y = ring as f32;
        for (x, z) in corners {
            positions.extend([x, y, z]);
            let length = (x * x + z * z).sqrt();
            normals.extend([x / length, 0.0, z / length]);
            let child = ring as f32 / 2.0;
            joints.extend([0u16, joint_index_override.unwrap_or(1), 0, 0]);
            weights.extend([1.0 - child, child, 0.0, 0.0]);
        }
    }
    let mut indices: Vec<u16> = Vec::new();
    for ring in 0..BAR_RINGS as u16 - 1 {
        for side in 0..4u16 {
            let (a, b) = (ring * 4 + side, ring * 4 + (side + 1) % 4);
            let (c, d) = (a + 4, b + 4);
            indices.extend([a, d, b, a, c, d]); // counter-clockwise seen from outside
        }
    }
    let mut bin = Vec::new();
    push_f32(&mut bin, &positions); // 0: 144
    push_f32(&mut bin, &normals); // 144: 144
    bin.extend(joints.iter().flat_map(|j| j.to_le_bytes())); // 288: 96
    push_f32(&mut bin, &weights); // 384: 192
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes())); // 576: 96
    let identity = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];
    push_f32(&mut bin, &identity); // 672: 128
    let mut child_ibm = identity;
    child_ibm[13] = -1.0;
    push_f32(&mut bin, &child_ibm);
    push_f32(&mut bin, &[0.0, 1.0]); // 800: 8
    let half = std::f32::consts::FRAC_1_SQRT_2;
    push_f32(&mut bin, &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, half, half]); // 808: 32
    let vertex_count = BAR_RINGS * 4;
    let json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{len}}}],
        "bufferViews":[
          {{"buffer":0,"byteOffset":0,"byteLength":144}},{{"buffer":0,"byteOffset":144,"byteLength":144}},
          {{"buffer":0,"byteOffset":288,"byteLength":96}},{{"buffer":0,"byteOffset":384,"byteLength":192}},
          {{"buffer":0,"byteOffset":576,"byteLength":96}},{{"buffer":0,"byteOffset":672,"byteLength":128}},
          {{"buffer":0,"byteOffset":800,"byteLength":8}},{{"buffer":0,"byteOffset":808,"byteLength":32}}],
        "accessors":[
          {{"bufferView":0,"componentType":5126,"count":{vc},"type":"VEC3","min":[-0.25,0,-0.25],"max":[0.25,2,0.25]}},
          {{"bufferView":1,"componentType":5126,"count":{vc},"type":"VEC3"}},
          {{"bufferView":2,"componentType":5123,"count":{vc},"type":"VEC4"}},
          {{"bufferView":3,"componentType":5126,"count":{vc},"type":"VEC4"}},
          {{"bufferView":4,"componentType":5123,"count":48,"type":"SCALAR"}},
          {{"bufferView":5,"componentType":5126,"count":2,"type":"MAT4"}},
          {{"bufferView":6,"componentType":5126,"count":2,"type":"SCALAR","min":[0],"max":[1]}},
          {{"bufferView":7,"componentType":5126,"count":2,"type":"VEC4"}}],
        "meshes":[{{"primitives":[{{"attributes":{{"POSITION":0,"NORMAL":1,"JOINTS_0":2,"WEIGHTS_0":3}},"indices":4}}]}}],
        "skins":[{{"joints":[1,2],"inverseBindMatrices":5}}],
        "nodes":[{{"mesh":0,"skin":0}},{{"children":[2]}},{{"translation":[0,1,0]}}],
        "animations":[{{"name":"bend","channels":[{{"sampler":0,"target":{{"node":2,"path":"rotation"}}}}],
          "samplers":[{{"input":6,"output":7,"interpolation":"LINEAR"}}]}}],
        "scenes":[{{"nodes":[0,1]}}],"scene":0}}"#,
        len = bin.len(),
        vc = vertex_count,
    );
    glb(json, &bin)
}

fn glb(json: String, bin: &[u8]) -> Vec<u8> {
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
    out.extend(bin);
    out
}

fn bar() -> SkinnedMeshData {
    SkinnedMeshData::from_glb(&skinned_bar_glb(None)).expect("the skinned bar loads")
}

fn close(a: [f32; 3], b: [f32; 3], tolerance: f32) -> bool {
    a.iter().zip(&b).all(|(x, y)| (x - y).abs() <= tolerance)
}

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn a_skinned_gltf_loads_its_mesh_skin_skeleton_and_animation() {
    let bar = bar();
    assert_eq!(bar.mesh.vertices.len(), BAR_RINGS * 4);
    assert_eq!(bar.mesh.indices.len(), 48);
    assert_eq!(bar.skin.len(), bar.mesh.vertices.len());
    assert_eq!(bar.skeleton.joints.len(), 2);
    assert_eq!(bar.animations.len(), 1);
    assert_eq!(bar.animations[0].name.as_deref(), Some("bend"));
    assert_eq!(bar.animations[0].duration, 1.0);
    let top = bar.skin[BAR_RINGS * 4 - 1];
    assert_eq!(top.joints[1], 1);
    assert_eq!(top.weights, [0.0, 1.0, 0.0, 0.0]);
    assert!(bar.mesh.vertices.iter().all(|v| v.uv == [0.0, 0.0]), "no TEXCOORD_0: uv zero");
}

#[test]
fn the_rest_pose_skins_to_the_bind_pose_and_the_animation_bends_the_child_joint() {
    let bar = bar();
    let rest = bar.skeleton.joint_matrices(&bar.skeleton.rest_pose());
    let skinned = skin_vertices_cpu(&bar.mesh, &bar.skin, &rest);
    for (a, b) in skinned.iter().zip(&bar.mesh.vertices) {
        assert!(close(a.position, b.position, 1e-6), "rest pose moved {:?} to {:?}", b.position, a.position);
    }
    let pose = bar.animations[0].sample(&bar.skeleton, 1.0);
    let bent = skin_vertices_cpu(&bar.mesh, &bar.skin, &bar.skeleton.joint_matrices(&pose));
    // The top ring (all weight on the child) turns 90° about +Z around (0, 1, 0): (x, y) → (1 - y, 1 + x) offsets.
    let top = BAR_RINGS * 4 - 4;
    assert!(close(bent[top].position, [-1.0, 1.25, 0.25], 1e-5), "{:?}", bent[top].position);
    let length = |n: [f32; 3]| (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
    assert!(bent.iter().all(|v| (length(v.normal) - 1.0).abs() < 1e-5));
    // The root ring (all weight on the root) does not move.
    assert!(close(bent[0].position, bar.mesh.vertices[0].position, 1e-6));
    // Halfway through, the child has turned 45°.
    let half = bar.animations[0].sample(&bar.skeleton, 0.5);
    let r = half[2].rotation;
    let (sin, cos) = (libm::sinf(std::f32::consts::FRAC_PI_8), libm::cosf(std::f32::consts::FRAC_PI_8));
    assert!((r[2] - sin).abs() < 1e-5 && (r[3] - cos).abs() < 1e-5, "{r:?}");
}

#[test]
fn hostile_skins_are_refused_mesh_invalid() {
    let out_of_range = SkinnedMeshData::from_glb(&skinned_bar_glb(Some(7))).expect_err("joint 7 of 2");
    assert_eq!(out_of_range.code(), RenderCode::MeshInvalid);
    let rigid = MeshData::from_glb(&skinned_bar_glb(None)).expect("the bar as a rigid mesh");
    assert_eq!(rigid.vertices.len(), BAR_RINGS * 4);
    let error = SkinnedMeshData::from_glb(&glb(r#"{"asset":{"version":"2.0"},"buffers":[{"byteLength":4}],"meshes":[],"nodes":[]}"#.to_owned(), &[0; 4]))
        .expect_err("no skin");
    assert_eq!(error.code(), RenderCode::MeshInvalid);
    let mut bar = bar();
    bar.skin.pop();
    let mut library = MeshLibrary::new();
    assert_eq!(library.add_skinned(&bar).expect_err("one skin row short").code(), RenderCode::MeshInvalid);
    let mut too_many = self::bar();
    too_many.skeleton.joints = vec![1; MAX_JOINTS + 1];
    too_many.skeleton.inverse_bind = vec![[0.0; 16]; MAX_JOINTS + 1];
    assert_eq!(library.add_skinned(&too_many).expect_err("too many joints").code(), RenderCode::MeshInvalid);
}

#[test]
fn a_skinned_draw_with_the_wrong_joint_count_is_refused_before_any_table_is_built() {
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned(&bar()).expect("added");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 6.0], [0.0, 1.0, 0.0]), [0, 0, 0, 255]);
    scene.draw_skinned(skin, translation(0.0, 0.0, 0.0), vec![[0.0; 16]; 3], Material::color([255, 255, 255, 255]));
    let error = FramePlan::build(&scene, &library, 16.0 / 9.0).expect_err("3 matrices for 2 joints");
    assert_eq!(error.code(), RenderCode::MeshInvalid);
}

#[test]
fn mips_halve_down_to_one_texel_and_average_colour_in_linear_light() {
    let two = TextureData::rgba8(2, 2, [[255u8; 4], [0, 0, 0, 255], [0, 0, 0, 255], [255; 4]].concat()).expect("2x2");
    let data = mip_chain(&two, TextureKind::Data, 2);
    assert_eq!(data.iter().map(|m| m.width()).collect::<Vec<_>>(), vec![2, 1]);
    assert_eq!(data[1].rgba(), &[128, 128, 128, 255], "data textures average their bytes");
    let color = mip_chain(&two, TextureKind::Color, 2);
    assert_eq!(color[1].rgba(), &[188, 188, 188, 255], "colour textures average in linear light (0.5 → sRGB 188)");
    let layer = mip_chain(&checker(64, 8), TextureKind::Color, TEXTURE_LAYER_PX);
    assert_eq!(layer[0].width(), TEXTURE_LAYER_PX, "resampled to the layer size");
    assert_eq!(layer.len() as u32, TEXTURE_LAYER_PX.ilog2() + 1);
    assert_eq!(layer.last().map(|m| (m.width(), m.height())), Some((1, 1)));
}

/// FNV-1a over every level of a mip chain: the bytes the arrays are filled with.
fn chain_digest(chain: &[TextureData]) -> u64 {
    chain.iter().flat_map(|level| level.rgba().iter()).fold(0xcbf2_9ce4_8422_2325, |hash, &byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3))
}

#[test]
fn part1_mip_chains_of_256_sources_keep_their_bytes() {
    // Characterized before RQ6.4's size classes and Toksvig mips: the 256 layer's chains (and a
    // smaller source resampled up to it) are today's method, bit for bit, with texture quality off.
    let rows = [
        ("checker colour", mip_chain(&checker(256, 16), TextureKind::Color, TEXTURE_LAYER_PX), 0xf233_3cd5_3654_632b_u64),
        ("checker data", mip_chain(&checker(256, 16), TextureKind::Data, TEXTURE_LAYER_PX), 0x1e91_2de2_878f_68b8),
        ("bumps data", mip_chain(&bumps(256, 8), TextureKind::Data, TEXTURE_LAYER_PX), 0xf332_4c2f_6406_eaf2),
        ("small checker colour", mip_chain(&checker(64, 8), TextureKind::Color, TEXTURE_LAYER_PX), 0xb91b_23dd_f5da_43a2),
    ];
    for (name, chain, digest) in rows {
        assert_eq!(chain_digest(&chain), digest, "{name}");
    }
}

#[test]
fn texture_data_is_refused_when_its_bytes_do_not_match_or_it_is_too_large() {
    assert_eq!(TextureData::rgba8(4, 4, vec![0; 63]).expect_err("short").code(), RenderCode::TextureInvalid);
    assert_eq!(TextureData::rgba8(0, 4, Vec::new()).expect_err("empty").code(), RenderCode::TextureInvalid);
    assert_eq!(TextureData::rgba8(8192, 1, vec![0; 8192 * 4]).expect_err("too wide").code(), RenderCode::TextureTooLarge);
}

#[test]
fn transparent_draws_sort_back_to_front_and_ties_keep_draw_order() {
    let eye = [0.0, 0.0, 10.0];
    let centers = [[0.0, 0.0, -1.0], [0.0, 0.0, -5.0], [1.0, 0.0, -3.0], [-1.0, 0.0, -3.0]];
    assert_eq!(back_to_front(eye, &centers), vec![1, 2, 3, 0]);
}

#[test]
fn transparent_materials_leave_the_opaque_batches_and_sort_into_their_own_rows() {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, -1.0), Material::color([255, 0, 0, 128]));
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([255, 255, 255, 255]));
    scene.draw(MeshId::SPHERE, translation(0.0, 0.0, -4.0), Material::color([0, 0, 255, 100]));
    scene.draw(MeshId::SPHERE, translation(0.0, 0.0, 50.0), Material::color([0, 255, 0, 100])); // behind the camera
    let plan = FramePlan::build(&scene, &MeshLibrary::new(), 16.0 / 9.0).expect("plan");
    assert_eq!(plan.batches.len(), 1, "only the opaque cube is batched");
    assert_eq!(plan.opaque_instances, 1);
    let sorted: Vec<f32> = plan.transparent.iter().map(|&row| plan.instances[row as usize].model[14]).collect();
    assert_eq!(sorted, vec![-4.0, -1.0], "back to front, the one behind the camera culled");
    assert_eq!(plan.logical_draws, 4, "culling never changes the logical draw count");
}

#[test]
fn draw_instanced_is_one_logical_draw_and_one_batch() {
    let models: Vec<[f32; 16]> = (0..100).map(|i| translation(i as f32, 0.0, 0.0)).collect();
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.draw_instanced(MeshId::CUBE, &models, Material::color([255, 255, 255, 255]));
    scene.line([0.0; 3], [1.0; 3], [255; 4]);
    let plan = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    assert_eq!(plan.logical_draws, 2, "one instanced draw and one line");
    assert_eq!((plan.batches.len(), plan.instances.len()), (1, 100));
    assert!(plan.cpu_cull().counts[0] < 100, "culling drops instances, not logical draws");
}

#[test]
fn the_light_table_holds_every_point_light_up_to_its_cap() {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    for i in 0..MAX_LIGHTS + 20 {
        scene.lighting.points.push(PointLight { position: [i as f32, 1.0, 0.0], range: 5.0, color: [255, 128, 0], intensity: 1.0 });
    }
    let plan = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    assert_eq!(plan.lights.len(), MAX_LIGHTS);
    assert_eq!(plan.frame.counts[0] as usize, MAX_LIGHTS);
    assert_eq!(plan.lights[3].position_range, [3.0, 1.0, 0.0, 5.0], "in scene order");
}

#[test]
fn materials_carry_their_texture_layers_and_none_is_no_texture() {
    let plain = Material::color([255, 255, 255, 255]).to_gpu();
    assert_eq!(plain.textures, [NO_TEXTURE; 4]);
    let base = genex_render::texture::TextureId::new(TextureKind::Color, 3);
    let normal = genex_render::texture::TextureId::new(TextureKind::Data, 1);
    let textured = Material::color([255; 4]).with_base_texture(base).with_normal_map(normal, 0.5).to_gpu();
    assert_eq!(textured.textures, [3, 1, NO_TEXTURE, NO_TEXTURE]);
    assert_eq!(textured.params[3], 0.5);
}

#[test]
fn shadow_cascades_split_the_view_and_each_light_frustum_holds_its_slice() {
    let camera = CameraDesc::look_at([0.0, 4.0, 12.0], [0.0, 0.0, 0.0]);
    let set = cascades(&camera, 16.0 / 9.0, [0.4, 1.0, 0.3], 40.0);
    assert!(camera.near < set.splits[0] && set.splits[0] < set.splits[1] && set.splits[1] <= 40.0, "{:?}", set.splits);
    for (c, slice) in set.slice_corners.iter().enumerate() {
        for corner in slice {
            let inside = set.planes[c].iter().all(|p| p[0] * corner[0] + p[1] * corner[1] + p[2] * corner[2] + p[3] >= -1e-3);
            assert!(inside, "cascade {c} misses {corner:?}");
        }
    }
}

#[test]
fn a_scene_with_sun_shadows_culls_three_views_and_one_without_culls_one() {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 4.0, 12.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material::color([255; 4]));
    let shadowed = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    assert_eq!(shadowed.views, 3);
    scene.lighting.shadows = false;
    let unshadowed = FramePlan::build(&scene, &MeshLibrary::new(), 1.0).expect("plan");
    assert_eq!(unshadowed.views, 1);
    assert_eq!(shadowed.cpu_cull(), unshadowed.cpu_cull(), "the camera view is the same either way");
}

#[test]
fn library_meshes_carry_uvs_and_unit_tangents_orthogonal_to_their_normals() {
    for mesh in [MeshData::cube(), MeshData::sphere()] {
        for Vertex { normal, tangent, uv, .. } in &mesh.vertices {
            let dot = normal[0] * tangent[0] + normal[1] * tangent[1] + normal[2] * tangent[2];
            let length = (tangent[0] * tangent[0] + tangent[1] * tangent[1] + tangent[2] * tangent[2]).sqrt();
            assert!(dot.abs() < 1e-4 && (length - 1.0).abs() < 1e-4, "{normal:?} {tangent:?}");
            assert!(tangent[3] == 1.0 || tangent[3] == -1.0);
            assert!((0.0..=1.0).contains(&uv[0]) && (0.0..=1.0).contains(&uv[1]));
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Goldens on the GPU

fn pbr_scene(renderer: &mut Renderer, gpu: &Gpu) -> Scene {
    let base = renderer.add_texture(gpu, &checker(64, 16), TextureKind::Color).expect("base texture");
    let normal = renderer.add_texture(gpu, &bumps(64, 4), TextureKind::Data).expect("normal map");
    let rough = renderer.add_texture(gpu, &image(16, |x, _| [0, (x * 16) as u8, 0, 255]), TextureKind::Data).expect("mr");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 2.2, 6.5], [0.0, 0.3, 0.0]), [18, 20, 28, 255]);
    scene.lighting.shadows = false;
    for i in 0..5 {
        let x = i as f32 * 1.1 - 2.2;
        let roughness = 0.1 + 0.2 * i as f32;
        scene.draw(MeshId::SPHERE, scaled([x, 1.4, 0.0], [0.5; 3]), Material::color([230, 180, 60, 255]).with_pbr(1.0, roughness));
        scene.draw(MeshId::SPHERE, scaled([x, 0.3, 0.0], [0.5; 3]), Material::color([60, 120, 230, 255]).with_pbr(0.0, roughness));
    }
    let floor = Material::color([255; 4]).with_base_texture(base).with_normal_map(normal, 1.0).with_metal_rough_texture(rough);
    scene.draw(MeshId::CUBE, scaled([0.0, -0.4, 0.0], [6.0, 0.2, 3.0]), floor);
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_pbr_metallic_roughness_with_normal_and_material_maps() {
    golden("pbr", pbr_scene);
}

fn lights_scene(_: &mut Renderer, _: &Gpu) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 6.0, 9.0], [0.0, 0.0, 0.0]), [4, 4, 6, 255]);
    scene.lighting.sun_intensity = 0.0;
    scene.lighting.ambient_intensity = 0.02;
    scene.lighting.shadows = false;
    let palette = [[255, 60, 60], [60, 255, 60], [60, 60, 255], [255, 220, 60]];
    for i in 0..24 {
        let (x, z) = ((i % 6) as f32 * 2.0 - 5.0, (i / 6) as f32 * 2.0 - 3.0);
        scene.lighting.points.push(PointLight { position: [x, 0.6, z], range: 2.5, color: palette[i % 4], intensity: 2.0 });
    }
    scene.draw(MeshId::CUBE, ground(), Material::color([200, 200, 200, 255]));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_twenty_four_point_lights_from_the_light_table() {
    golden("point-lights", lights_scene);
}

fn shadow_scene(_: &mut Renderer, _: &Gpu) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.0, -4.0]), [120, 160, 210, 255]);
    scene.lighting.sun_dir = [0.5, 1.0, 0.35];
    scene.lighting.shadow_distance = 40.0;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.6, -10.0], [16.0, 0.2, 30.0]), Material::color([210, 210, 200, 255]));
    scene.draw(MeshId::CUBE, translation(-1.0, 0.0, 1.0), Material::color([200, 60, 50, 255])); // cascade 0
    scene.draw(MeshId::SPHERE, scaled([1.4, 0.4, 0.0], [0.6; 3]), Material::color([60, 180, 80, 255]));
    scene.draw(MeshId::CUBE, scaled([0.0, 1.0, -20.0], [2.0, 3.0, 2.0]), Material::color([80, 80, 200, 255])); // cascade 1
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_two_cascade_sun_shadows_drawn_through_the_culled_indirect_path() {
    let Some((shadowed, renderer, gpu)) = render_both(shadow_scene, RenderOptions::default()) else { return };
    assert_eq!(renderer.last_stats().views, 3);
    for view in 1..3 {
        let args = renderer.read_view_args(&gpu, view).expect("cascade args");
        let drawn: u32 = args.iter().map(|a| a.instance_count).sum();
        assert!(drawn > 0, "cascade {} drew its casters through the cull", view - 1);
    }
    check_golden("shadows", &shadowed);
    let mut unshadowed = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut scene = shadow_scene(&mut unshadowed, &gpu);
    scene.lighting.shadows = false;
    unshadowed.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let lit = unshadowed.capture(&gpu).expect("capture");
    assert!(luma(&shadowed) < luma(&lit) - 1.0, "shadows darken the frame: {} vs {}", luma(&shadowed), luma(&lit));
}

fn skinned_scene(renderer: &mut Renderer, gpu: &Gpu) -> Scene {
    let bar = bar();
    let skin = renderer.add_skinned_mesh(gpu, &bar).expect("skinned mesh");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.2, 5.0], [0.0, 1.0, 0.0]), [30, 30, 36, 255]);
    scene.lighting.shadows = false;
    let bent = bar.skeleton.joint_matrices(&bar.animations[0].sample(&bar.skeleton, 0.75));
    let rest = bar.skeleton.joint_matrices(&bar.skeleton.rest_pose());
    scene.draw_skinned(skin, translation(-0.8, 0.0, 0.0), bent, Material::color([240, 140, 40, 255]));
    scene.draw_skinned(skin, translation(1.2, 0.0, 0.0), rest, Material::color([40, 160, 240, 255]));
    scene.draw(MeshId::CUBE, ground(), Material::color([90, 90, 100, 255]));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_compute_skinned_gltf() {
    golden("skinned", skinned_scene);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_compute_skinning_equals_the_cpu_reference_within_1e_5() {
    let Some(gpu) = gpu() else { return };
    let bar = bar();
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let skin = renderer.add_skinned_mesh(&gpu, &bar).expect("skinned mesh");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 6.0], [0.0, 1.0, 0.0]), [0, 0, 0, 255]);
    let mut expected = Vec::new();
    for t in [0.0, 0.3, 0.75, 1.0] {
        let joints = bar.skeleton.joint_matrices(&bar.animations[0].sample(&bar.skeleton, t));
        expected.extend(skin_vertices_cpu(&bar.mesh, &bar.skin, &joints));
        scene.draw_skinned(skin, translation(t * 2.0 - 1.0, 0.0, 0.0), joints, Material::color([255; 4]));
    }
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let skinned = renderer.read_skinned_vertices(&gpu).expect("readback");
    assert_eq!(skinned.len(), expected.len());
    let mut worst = 0.0_f32;
    for (gpu_vertex, cpu_vertex) in skinned.iter().zip(&expected) {
        let gpu_floats: &[f32] = bytemuck::cast_slice(std::slice::from_ref(gpu_vertex));
        let cpu_floats: &[f32] = bytemuck::cast_slice(std::slice::from_ref(cpu_vertex));
        for (a, b) in gpu_floats.iter().zip(cpu_floats) {
            worst = worst.max((a - b).abs());
        }
    }
    write_evidence("skinning-worst-error.txt", format!("{worst:e}\n").as_bytes());
    assert!(worst <= SKIN_TOLERANCE, "compute skinning is {worst:e} from the CPU reference");
}

fn instanced_scene(_: &mut Renderer, _: &Gpu) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 14.0, 22.0], [0.0, 0.0, 0.0]), [12, 12, 16, 255]);
    let models: Vec<[f32; 16]> = (0..1024)
        .map(|i| {
            let (x, z) = ((i % 32) as f32 - 15.5, (i / 32) as f32 - 15.5);
            scaled([x, 0.0, z], [0.6, 0.3 + (i % 7) as f32 * 0.15, 0.6])
        })
        .collect();
    scene.draw_instanced(MeshId::CUBE, &models, Material::color([220, 120, 60, 255]).with_pbr(0.2, 0.5));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_a_thousand_instances_in_one_instanced_draw() {
    let Some((capture, renderer, _)) = render_both(instanced_scene, RenderOptions::default()) else { return };
    let stats = renderer.last_stats();
    assert_eq!(stats.logical_draws, 1);
    assert_eq!(stats.instances, 1024);
    check_golden("instancing", &capture);
}

fn transparent_draws(scene: &mut Scene, reversed: bool) {
    let mut glass = vec![
        (translation(-0.5, 0.6, 0.5), Material::color([255, 40, 40, 110])),
        (translation(0.0, 0.6, -0.3), Material::color([40, 255, 40, 110])),
        (translation(0.5, 0.6, -1.1), Material::color([40, 40, 255, 110])),
    ];
    if reversed {
        glass.reverse();
    }
    for (model, material) in glass {
        scene.draw(MeshId::SPHERE, model, material);
    }
}

fn transparent_scene(_: &mut Renderer, _: &Gpu) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.5, 5.0], [0.0, 0.5, 0.0]), [25, 25, 30, 255]);
    scene.lighting.shadows = false;
    scene.draw(MeshId::CUBE, scaled([0.0, 0.5, -3.0], [3.0, 2.0, 0.3]), Material::color([230, 230, 230, 255]));
    transparent_draws(&mut scene, false);
    scene.draw(MeshId::CUBE, ground(), Material::color([90, 90, 100, 255]));
    scene
}

fn transparent_scene_reversed(_: &mut Renderer, _: &Gpu) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.5, 5.0], [0.0, 0.5, 0.0]), [25, 25, 30, 255]);
    scene.lighting.shadows = false;
    scene.draw(MeshId::CUBE, scaled([0.0, 0.5, -3.0], [3.0, 2.0, 0.3]), Material::color([230, 230, 230, 255]));
    transparent_draws(&mut scene, true);
    scene.draw(MeshId::CUBE, ground(), Material::color([90, 90, 100, 255]));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_sorted_transparency_ignores_submission_order() {
    let Some((forward, renderer, _)) = render_both(transparent_scene, RenderOptions::default()) else { return };
    assert_eq!(renderer.last_stats().transparent_draws, 3);
    let Some((reversed, _, _)) = render_both(transparent_scene_reversed, RenderOptions::default()) else { return };
    assert!(forward.bgra() == reversed.bgra(), "back-to-front sorting makes submission order irrelevant");
    assert!(pixel(&forward, 0, 0)[3] == 255 && forward.bgra().chunks(4).all(|p| p[3] == 255), "captures stay opaque");
    check_golden("transparent", &forward);
}

fn mips_scene(renderer: &mut Renderer, gpu: &Gpu) -> Scene {
    let fine = renderer.add_texture(gpu, &checker(256, 2), TextureKind::Color).expect("checker");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 1.0, 6.0], [0.0, 0.6, -20.0]), [100, 140, 200, 255]);
    scene.lighting.shadows = false;
    scene.draw(MeshId::CUBE, scaled([0.0, -0.1, -40.0], [8.0, 0.2, 90.0]), Material::color([255; 4]).with_base_texture(fine));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_mipmapped_texture_on_a_receding_plane() {
    let Some((capture, _, _)) = render_both(mips_scene, RenderOptions::default()) else { return };
    // Far up the plane a texel covers many checks: the mip chain averages them to grey instead of
    // aliasing into black and white.
    let row = HEIGHT / 2 - 2;
    let greys: Vec<u8> = (WIDTH / 2 - 8..WIDTH / 2 + 8).map(|x| pixel(&capture, x, row)[1]).collect();
    let (lo, hi) = (greys.iter().min().copied().unwrap_or(0), greys.iter().max().copied().unwrap_or(0));
    assert!(hi - lo < 60, "the far plane is filtered, not aliased: {greys:?}");
    check_golden("mips", &capture);
}

fn msaa_scene(_: &mut Renderer, _: &Gpu) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 4.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.shadows = false;
    let turn = glam::Mat4::from_rotation_z(0.3) * glam::Mat4::from_scale(glam::Vec3::splat(1.5));
    scene.draw(MeshId::CUBE, turn.to_cols_array(), Material::color([255, 255, 255, 255]));
    scene
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_msaa_four_x_smooths_edges() {
    let Some((smooth, renderer, _)) = render_both(msaa_scene, RenderOptions { msaa: true }) else { return };
    assert_eq!(renderer.sample_count(), 4, "Bgra8Unorm and Depth32Float take 4x MSAA on WebGPU core");
    let Some((aliased, single, _)) = render_both(msaa_scene, RenderOptions { msaa: false }) else { return };
    assert_eq!(single.sample_count(), 1);
    write_evidence("msaa-off.bgra", aliased.bgra());
    write_evidence("msaa-on.bgra", smooth.bgra());
    // The face is one flat colour on black: only partially covered edge pixels fall between them.
    let (blended, hard) = (edge_pixels(&smooth), edge_pixels(&aliased));
    assert!(blended > 40 && hard == 0, "partially covered edge pixels: {blended} with MSAA, {hard} without");
    check_golden("msaa", &smooth);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_every_opaque_draw_goes_through_the_tables_and_one_multi_draw_per_view() {
    let Some((_, renderer, _)) = render_both(skinned_scene, RenderOptions::default()) else { return };
    let stats = renderer.last_stats();
    assert_eq!(stats.batches, 3, "the cube batch and one per skinned draw");
    assert_eq!(stats.indirect_draws, stats.batches * stats.views, "every batch of every view is an indirect draw");
    assert_eq!(stats.multi_draws, 2 * stats.views, "static and skinned vertex sources, one multi-draw each per view");
    assert_eq!(stats.direct_opaque_draws, 0);
    assert_eq!(stats.skin_jobs, 2);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_culling_never_changes_the_tagged_draw_count() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 10.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    for i in 0..40 {
        scene.draw(MeshId::CUBE, translation(i as f32 * 10.0, 0.0, 0.0), Material::color([255; 4]));
    }
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let visible: u32 = renderer.read_indirect_args(&gpu).expect("args").iter().map(|a| a.instance_count).sum();
    assert!(visible < 40, "most cubes are culled: {visible}");
    assert_eq!(renderer.last_stats().logical_draws, 40, "the tagged count is taken before the GPU cull");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_async_capture_equals_the_blocking_capture() {
    let Some((blocking, renderer, gpu)) = render_both(pbr_scene, RenderOptions::default()) else { return };
    let awaited = pollster::block_on(renderer.capture_async(&gpu)).expect("async capture");
    assert!(awaited == blocking);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_cull_timing_one_batch_of_ten_thousand_instances() {
    let Some(gpu) = gpu() else { return };
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.0, 60.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.lighting.shadows = false;
    let models: Vec<[f32; 16]> = (0..10_000).map(|i| translation((i % 100) as f32 - 50.0, (i / 100) as f32 - 50.0, -((i % 13) as f32) * 40.0)).collect();
    scene.draw_instanced(MeshId::CUBE, &models, Material::color([255; 4]));
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    renderer.cull_only(&gpu, &scene).expect("warm-up");
    let mut samples_us = Vec::new();
    for _ in 0..20 {
        #[allow(clippy::disallowed_types, reason = "a timing row measures the wall clock on purpose")]
        let start = std::time::Instant::now();
        renderer.cull_only(&gpu, &scene).expect("cull");
        samples_us.push(start.elapsed().as_micros() as u64);
    }
    samples_us.sort_unstable();
    let counts: Vec<u32> = renderer.read_indirect_args(&gpu).expect("args").iter().map(|a| a.instance_count).collect();
    let plan = FramePlan::build(&scene, renderer.library(), WIDTH as f32 / HEIGHT as f32).expect("plan");
    assert_eq!(counts, plan.cpu_cull().counts, "the single-workgroup walk keeps the CPU cull's survivors");
    let row = format!(
        "{{\"row\":\"cull-single-batch\",\"instances\":10000,\"batches\":1,\"workgroups\":1,\"samples\":{},\"p50_us\":{},\"p95_us\":{},\"max_us\":{},\"survivors\":{},\"backend\":\"{}\",\"adapter\":\"{}\",\"measures\":\"upload + one cull dispatch + device wait (CPU wall clock; no timestamp queries on WebGPU core)\"}}\n",
        samples_us.len(),
        samples_us[samples_us.len() / 2],
        samples_us[samples_us.len() * 95 / 100],
        samples_us[samples_us.len() - 1],
        counts[0],
        gpu.receipt().backend,
        gpu.receipt().adapter,
    );
    eprintln!("{row}");
    write_evidence("cull-timing.json", row.as_bytes());
}
