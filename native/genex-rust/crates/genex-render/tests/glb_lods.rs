//! Import-time LODs (renderer pass 2, A6.9): a GLB part carries the `genex_lods` levels its
//! primitives brought (`extras.genex_lods`, the Studio's import step), validated, rebased into the
//! part's vertices and merged level by level, each error scaled by its node; a refused set is a
//! typed warning and the mesh still loads whole. The level a draw takes is the coarsest whose
//! error projects to at most the threshold in pixels, the same on the CPU and in WGSL.
//!
//!
//! Drawn (A6.9 runtime): the library keeps each level as a mesh of its own, a frame plans a batch
//! per level, and the cull keeps every instance in exactly one of them, the level its distance
//! from the camera picks, in every view; the GPU cull keeps the CPU cull's levels, slot for slot.
//!
//! The GPU rows are `#[ignore]`d and their names contain `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test glb_lods -- --ignored metal

use genex_render::mesh::{GlbModel, LOD_MAX_LEVELS, LOD_SELECT_WGSL, LodFault, MeshData, select_lod};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, Scene, translation};
use genex_render::{Gpu, Renderer};
use serde_json::{Value, json};

/// The repository's asset-import fixtures.
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// A GLB's JSON and binary chunks.
fn split(glb: &[u8]) -> (Value, Vec<u8>) {
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("length")) as usize;
    let json: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    let bin_at = 20 + json_len;
    let bin_len = u32::from_le_bytes(glb[bin_at..bin_at + 4].try_into().expect("length")) as usize;
    (json, glb[bin_at + 8..bin_at + 8 + bin_len].to_vec())
}

/// `json` and `bin` as a GLB.
fn join(json: &Value, mut bin: Vec<u8>) -> Vec<u8> {
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut text = serde_json::to_vec(json).expect("json");
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + text.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((text.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&text);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

/// The golden with `edit` applied to its JSON.
fn edited(edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let (mut json, bin) = split(&import_fixture("lods-sphere.glb"));
    edit(&mut json);
    join(&json, bin)
}

#[test]
fn the_import_steps_golden_loads_with_each_level_merged_across_its_primitives() {
    let bytes = import_fixture("lods-sphere.glb");
    let (json, _) = split(&bytes);
    let primitives = json["meshes"][0]["primitives"].as_array().expect("primitives");
    let levels: Vec<&Vec<Value>> = primitives.iter().map(|p| p["extras"]["genex_lods"]["levels"].as_array().expect("levels")).collect();
    let model = GlbModel::from_glb(&bytes).expect("the golden loads");
    let [part] = model.parts() else { panic!("one part: the sphere names no material") };
    assert!(part.lod_warnings.is_empty(), "{:?}", part.lod_warnings);
    let chain = part.lods.as_ref().expect("a chain");
    assert_eq!(chain.levels.len(), levels.iter().map(|l| l.len()).min().unwrap_or(0));
    for (at, level) in chain.levels.iter().enumerate() {
        let count: u64 = levels.iter().map(|l| l[at]["count"].as_u64().expect("count")).sum();
        assert_eq!(level.indices.len() as u64, count, "level {at}: every primitive's triangles");
        let error = levels.iter().map(|l| l[at]["error"].as_f64().expect("error") as f32).fold(0.0_f32, f32::max);
        assert_eq!(level.error, error, "level {at}: the largest of its primitives' errors");
        assert!(level.indices.iter().all(|&i| (i as usize) < part.mesh.vertices.len()), "level {at}: rebased into the part");
    }
    assert!(chain.levels.windows(2).all(|w| w[1].indices.len() <= w[0].indices.len() && w[1].error >= w[0].error));
    assert!(chain.levels[0].indices.len() < part.mesh.indices.len(), "level 1 is coarser than the mesh itself");
    let mesh = MeshData::from_glb(&bytes).expect("the plain loader still reads it");
    assert_eq!(mesh.indices.len(), part.mesh.indices.len());
}

#[test]
fn a_scaled_node_scales_its_levels_error() {
    let plain = GlbModel::from_glb(&import_fixture("lods-sphere.glb")).expect("loads");
    let scaled = GlbModel::from_glb(&edited(|json| json["nodes"][0]["scale"] = json!([2.0, 2.0, 2.0]))).expect("loads");
    let errors = |model: &GlbModel| model.parts()[0].lods.as_ref().expect("chain").levels.iter().map(|l| l.error).collect::<Vec<f32>>();
    let doubled: Vec<f32> = errors(&plain).iter().map(|e| e * 2.0).collect();
    assert_eq!(errors(&scaled), doubled);
}

#[test]
fn hostile_lod_extras_are_refused_with_a_typed_warning_and_the_mesh_still_loads_whole() {
    type Damage = fn(&mut Value);
    let rows: [(&str, LodFault, Damage); 8] = [
        ("another version", LodFault::UnknownVersion, |l| l["version"] = json!(99)),
        ("not an object", LodFault::UnknownVersion, |l| *l = json!("levels")),
        ("too many levels", LodFault::OverLimit, |l| {
            let first = l["levels"][0].clone();
            l["levels"] = json!(vec![first; LOD_MAX_LEVELS as usize + 1]);
        }),
        ("a view past the buffer", LodFault::RangeOutOfBounds, |l| l["indices"] = json!(999)),
        ("a level past its view", LodFault::RangeOutOfBounds, |l| l["levels"][0]["count"] = json!(3_000_000_000_u64)),
        ("a level that is not whole triangles", LodFault::NotCoarser, |l| l["levels"][0]["count"] = json!(l["levels"][0]["count"].as_u64().unwrap_or(3) - 1)),
        ("a finer level after a coarser one", LodFault::NotCoarser, |l| {
            let mut levels = l["levels"].as_array().cloned().unwrap_or_default();
            levels.reverse();
            l["levels"] = json!(levels);
        }),
        ("a negative error", LodFault::NotCoarser, |l| l["levels"][0]["error"] = json!(-1.0)),
    ];
    for (name, fault, damage) in rows {
        let bytes = edited(|json| damage(&mut json["meshes"][0]["primitives"][0]["extras"]["genex_lods"]));
        let model = GlbModel::from_glb(&bytes).unwrap_or_else(|error| panic!("{name}: the mesh loads ({error})"));
        let part = &model.parts()[0];
        assert!(part.lods.is_none(), "{name}: no chain");
        assert_eq!(part.lod_warnings.iter().map(|w| (w.primitive, w.fault)).collect::<Vec<_>>(), vec![(0, fault)], "{name}");
    }
}

#[test]
fn an_index_past_the_primitives_vertices_is_refused_vertex_out_of_mesh() {
    let positions: [f32; 12] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0];
    let mut bin: Vec<u8> = positions.iter().flat_map(|f| f.to_le_bytes()).collect();
    bin.extend([0u16, 1, 2, 2, 1, 3].iter().flat_map(|i| i.to_le_bytes()));
    bin.extend([0u32, 1, 7].iter().flat_map(|i| i.to_le_bytes()));
    let json = json!({
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": bin.len()}],
        "bufferViews": [{"buffer": 0, "byteLength": 48}, {"buffer": 0, "byteOffset": 48, "byteLength": 12}, {"buffer": 0, "byteOffset": 60, "byteLength": 12}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR"}
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 1,
            "extras": {"genex_lods": {"version": 1, "indices": 2, "levels": [{"first": 0, "count": 3, "error": 0.1}]}}}]}],
        "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0
    });
    let model = GlbModel::from_glb(&join(&json, bin)).expect("loads");
    assert!(model.parts()[0].lods.is_none());
    assert_eq!(model.parts()[0].lod_warnings[0].fault, LodFault::VertexOutOfMesh);
    assert_eq!(model.parts()[0].lod_warnings[0].fault.wire(), "lods-vertex-out-of-mesh");
}

#[test]
fn a_part_with_one_primitive_lacking_levels_has_no_chain_and_no_warning() {
    let bytes = edited(|json| {
        if let Some(extras) = json["meshes"][0]["primitives"][1]["extras"].as_object_mut() {
            extras.remove("genex_lods");
        }
    });
    let model = GlbModel::from_glb(&bytes).expect("loads");
    assert!(model.parts()[0].lods.is_none() && model.parts()[0].lod_warnings.is_empty());
}

#[test]
fn the_coarsest_level_whose_error_projects_within_the_threshold_is_drawn() {
    let errors = [0.01, 0.05, 0.2];
    // 1000 pixels a world unit at distance 1, a 1-pixel threshold.
    let rows = [(5.0, 0), (20.0, 1), (60.0, 2), (250.0, 3), (1_000.0, 3), (0.0, 0), (-3.0, 0)];
    for (distance, level) in rows {
        assert_eq!(select_lod(&errors, distance, 1000.0, 1.0), level, "distance {distance}");
    }
    assert_eq!(select_lod(&[], 1e9, 1000.0, 1.0), 0, "no chain: the mesh itself");
    assert_eq!(select_lod(&[0.0], 0.001, 1000.0, 1.0), 1, "an exact level is taken even up close");
    assert_eq!(select_lod(&errors, f32::NAN, 1000.0, 1.0), 0, "a non-finite distance draws the mesh itself");
}

/// The WGSL select inside a compute entry that runs it once per case.
fn select_shader() -> String {
    format!(
        "{LOD_SELECT_WGSL}\nstruct Case {{ errors: vec4<f32>, levels: u32, distance: f32, pixels_per_unit: f32, threshold_px: f32 }}\n\
         @group(0) @binding(0) var<storage, read> cases: array<Case>;\n\
         @group(0) @binding(1) var<storage, read_write> picked: array<u32>;\n\
         @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {{\n\
           if (id.x >= arrayLength(&cases)) {{ return; }}\n\
           let c = cases[id.x];\n\
           picked[id.x] = gx_lod_select(c.errors, c.levels, c.distance, c.pixels_per_unit, c.threshold_px);\n\
         }}\n"
    )
}

#[test]
fn the_wgsl_select_validates_on_webgpu_core_and_emits_hlsl_msl_and_spirv() {
    use naga::back::{hlsl, msl, spv};
    use naga::valid::{Capabilities, ValidationFlags, Validator};
    let module = naga::front::wgsl::parse_str(&select_shader()).expect("WGSL parses");
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).expect("WebGPU core");
    let mut hlsl_source = String::new();
    let hlsl_options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &hlsl_options, &hlsl::PipelineOptions::default()).write(&module, &info, None).expect("HLSL SM 5.1");
    let msl_options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &msl_options, &msl::PipelineOptions::default()).expect("MSL 2.4");
    let spv_options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &spv_options, None).expect("SPIR-V 1.3");
}

// ---------------------------------------------------------------------------------------------
// Drawn levels (A6.9 runtime)

/// The output height the drawn rows choose levels for.
const LOD_HEIGHT: u32 = 360;
const LOD_WIDTH: u32 = 640;

/// The golden sphere's part with its levels.
fn sphere_part() -> genex_render::scene::ModelPart {
    let model = GlbModel::from_glb(&import_fixture("lods-sphere.glb")).expect("the golden loads");
    let [part] = model.parts() else { panic!("one part") };
    part.clone().into_model_part()
}

/// `count` spheres along the camera's view from 3 m to about 3 km (a geometric progression), the
/// camera at the origin looking down -z; `shadows` with the sun's shadows.
fn receding_spheres(mesh: MeshId, count: usize, shadows: bool) -> Scene {
    let mut camera = CameraDesc::look_at([0.0, 1.0, 0.0], [0.0, 1.0, -1.0]);
    camera.far = 5000.0;
    let mut scene = Scene::new(camera, [20, 24, 30, 255]);
    scene.lighting.shadows = shadows;
    for i in 0..count {
        let distance = 3.0 * libm::powf(1000.0, i as f32 / (count - 1).max(1) as f32);
        let x = ((i % 7) as f32 - 3.0) * distance * 0.06;
        scene.draw(mesh, translation(x, 1.0, -distance), Material::color([180, 170, 160, 255]));
    }
    scene
}

/// The level each of `draws` instances is drawn at in view `view` of `plan`: the batch whose
/// region holds the instance's row (every level's batch holds the mesh's rows, in draw order).
fn drawn_levels(plan: &FramePlan, view: usize, draws: usize) -> Vec<Option<usize>> {
    let cull = plan.cpu_cull_view(view);
    (0..draws)
        .map(|draw| {
            let mut found = plan.batches.iter().zip(&cull.counts).enumerate().filter(|(_, (batch, count))| {
                let region = &cull.visible[batch.first_instance as usize..(batch.first_instance + **count) as usize];
                region.contains(&(batch.first_row + draw as u32))
            });
            let level = found.next().map(|(level, _)| level);
            assert!(found.next().is_none(), "instance {draw} is drawn by one batch only (view {view})");
            level
        })
        .collect()
}

#[test]
fn a_part_with_levels_draws_each_instance_once_at_the_level_its_distance_picks() {
    let part = sphere_part();
    let chain = part.lods.clone().expect("a chain");
    let mut library = MeshLibrary::new();
    let mesh = library.add_part(part.clone()).expect("added");
    let lods = library.lods(mesh).expect("its levels are kept");
    assert_eq!(lods.levels.len(), chain.levels.len());
    assert_eq!(lods.errors, chain.errors());
    for (level, id) in chain.levels.iter().zip(&lods.levels) {
        let entry = library.entry(*id).expect("a level's mesh");
        let used: std::collections::BTreeSet<u32> = level.indices.iter().copied().collect();
        assert_eq!(entry.index_count as usize, level.indices.len(), "the level's triangles");
        assert_eq!(entry.vertex_count as usize, used.len(), "only the vertices the level uses");
        assert_eq!((entry.center, entry.radius), { let base = library.entry(mesh).expect("base"); (base.center, base.radius) }, "culled as the mesh is");
    }
    let count = 24;
    let scene = receding_spheres(mesh, count, true);
    let mut plan = FramePlan::build(&scene, &library, LOD_WIDTH as f32 / LOD_HEIGHT as f32).expect("plan");
    plan.set_lod_height(LOD_HEIGHT);
    assert_eq!(plan.batches.len(), 1 + chain.levels.len(), "a batch per level, each with every instance");
    assert!(plan.batches.iter().all(|batch| batch.instance_count == count as u32 && batch.first_row == 0), "every level's batch holds the mesh's rows");
    assert_eq!(plan.instances.len(), count, "the rows are written once, not once a level");
    assert_eq!(plan.visible_slots as usize, count * plan.batches.len(), "each level has slots of its own");
    let camera = drawn_levels(&plan, 0, count);
    assert!(camera.iter().all(Option::is_some), "every sphere is in view: {camera:?}");
    let camera: Vec<usize> = camera.into_iter().flatten().collect();
    assert_eq!(camera[0], 0, "the nearest draws the mesh itself");
    assert_eq!(*camera.last().expect("levels"), chain.levels.len(), "the farthest draws the coarsest level");
    assert!(camera.windows(2).all(|pair| pair[0] <= pair[1]), "farther is never finer: {camera:?}");
    // The level is the CPU select's, from the camera's distance to the bounding sphere.
    let (eye, ppu) = (scene.camera.eye, plan.cull_views.lod[3]);
    for (draw, level) in camera.iter().enumerate() {
        let bounds = plan.instances[plan.batches[0].first_row as usize + draw].bounds;
        let offset = [bounds[0] - eye[0], bounds[1] - eye[1], bounds[2] - eye[2]];
        let distance = (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]).sqrt() - bounds[3];
        let entry = library.entry(mesh).expect("base");
        let errors: Vec<f32> = chain.errors().iter().map(|error| error / entry.radius * bounds[3]).collect();
        let wanted = select_lod(&errors, distance, ppu, 1.0);
        assert!((*level as i64 - wanted as i64).abs() <= 1, "instance {draw}: drawn at {level}, the exact select gives {wanted}");
    }
    // Every shadow cascade draws an instance at the camera's level, never twice.
    for view in 1..plan.views as usize {
        for (draw, level) in drawn_levels(&plan, view, count).into_iter().enumerate() {
            assert!(level.is_none_or(|level| level == camera[draw]), "view {view}, instance {draw}: {level:?} against the camera's {}", camera[draw]);
        }
    }
    // An orthographic camera turns the levels off: every instance draws the mesh itself.
    let mut flat = scene.clone();
    flat.camera.ortho_height = Some(20.0);
    let flat_plan = FramePlan::build(&flat, &library, LOD_WIDTH as f32 / LOD_HEIGHT as f32).expect("plan");
    assert!(drawn_levels(&flat_plan, 0, count).into_iter().flatten().all(|level| level == 0));
}

#[test]
fn a_chain_reaching_past_its_mesh_is_dropped_and_the_mesh_draws_whole() {
    let mut part = sphere_part();
    let vertices = part.mesh.vertices.len() as u32;
    if let Some(chain) = part.lods.as_mut() {
        chain.levels[0].indices[0] = vertices;
    }
    let mut library = MeshLibrary::new();
    let before = library.len();
    let mesh = library.add_part(part).expect("the mesh is still added");
    assert!(library.lods(mesh).is_none());
    assert_eq!(library.len(), before + 1, "no level mesh is added");
    let plan = FramePlan::build(&receding_spheres(mesh, 4, false), &library, 1.0).expect("plan");
    assert_eq!(plan.batches.len(), 1);
}

// ---------------------------------------------------------------------------------------------
// GPU

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// One case: four errors (unused ones past `levels`), the level count, distance, pixels a unit, threshold.
#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Case {
    errors: [f32; 4],
    levels: u32,
    distance: f32,
    pixels_per_unit: f32,
    threshold_px: f32,
}

/// Deterministic cases around every boundary: errors rising, distances on a log scale and at the
/// exact distances each error crosses the threshold.
fn cases() -> Vec<Case> {
    let mut out = Vec::new();
    let mut seed = 0x2545_f491_u32;
    let mut next = || {
        seed ^= seed << 13;
        seed ^= seed >> 17;
        seed ^= seed << 5;
        (seed as f32) / (u32::MAX as f32)
    };
    for _ in 0..512 {
        let levels = 1 + (next() * 4.0) as u32 % 4;
        let mut errors = [0.0_f32; 4];
        let mut running = 0.0;
        for error in errors.iter_mut().take(levels as usize) {
            running += next() * 0.1;
            *error = running;
        }
        let pixels_per_unit = 200.0 + next() * 2000.0;
        let threshold_px = 0.5 + next() * 2.0;
        let distance = libm::powf(10.0, next() * 4.0 - 1.0);
        out.push(Case { errors, levels, distance, pixels_per_unit, threshold_px });
        let crossing = errors[0] * pixels_per_unit / threshold_px;
        out.push(Case { errors, levels, distance: crossing, pixels_per_unit, threshold_px });
    }
    out
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_wgsl_lod_select_picks_the_cpus_level_for_every_case() {
    let Some(gpu) = gpu() else { return };
    let cases = cases();
    let source = select_shader();
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("lod select"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let input = wgpu::util::DeviceExt::create_buffer_init(
        device,
        &wgpu::util::BufferInitDescriptor { label: Some("cases"), contents: bytemuck::cast_slice(&cases), usage: wgpu::BufferUsages::STORAGE },
    );
    let size = (cases.len() * 4) as u64;
    let output = device.create_buffer(&wgpu::BufferDescriptor { label: Some("picked"), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: Some("staging"), size, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("lod select"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: input.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: output.as_entire_binding() },
        ],
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((cases.len() as u32).div_ceil(64), 1, 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, size);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("done");
    let picked: Vec<u32> = bytemuck::cast_slice(&staging.slice(..).get_mapped_range().expect("mapped range")).to_vec();
    let mut changes = 0;
    for (at, case) in cases.iter().enumerate() {
        let cpu = select_lod(&case.errors[..case.levels as usize], case.distance, case.pixels_per_unit, case.threshold_px);
        assert_eq!(picked[at], cpu, "case {at}: {:?} at {}", &case.errors[..case.levels as usize], case.distance);
        changes += usize::from(cpu > 0 && cpu < case.levels);
    }
    assert!(changes > 50, "the cases cross level boundaries ({changes})");
}

/// Every view's indirect counts and visible-list survivors of the last GPU cull equal the CPU
/// cull's, slot for slot.
fn assert_gpu_cull_equals_cpu(gpu: &Gpu, renderer: &Renderer, plan: &FramePlan) {
    for view in 0..plan.views {
        let cpu = plan.cpu_cull_view(view as usize);
        let args = renderer.read_view_args(gpu, view).expect("args");
        let counts: Vec<u32> = args.iter().map(|a| a.instance_count).collect();
        assert_eq!(counts, cpu.counts, "view {view}'s survivors per batch (level)");
        let visible = renderer.read_view_visible(gpu, view).expect("visible");
        for (batch, count) in plan.batches.iter().zip(&cpu.counts) {
            let range = batch.first_instance as usize..(batch.first_instance + count) as usize;
            assert_eq!(visible[range.clone()], cpu.visible[range], "view {view}'s visible list, batch from row {}", batch.first_instance);
        }
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_far_instances_draw_a_coarser_level_and_the_gpu_cull_keeps_the_cpus_levels() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, LOD_WIDTH, LOD_HEIGHT).expect("renderer");
    let part = sphere_part();
    let whole_triangles = (part.mesh.indices.len() / 3) as u64;
    let mesh = renderer.add_model_parts(&gpu, vec![part.clone()]).expect("added")[0];
    let count = 300;
    let scene = receding_spheres(mesh, count, true);
    renderer.render(&gpu, &scene, genex_render::CullPath::Gpu).expect("frame");
    let mut plan = FramePlan::build(&scene, renderer.library(), LOD_WIDTH as f32 / LOD_HEIGHT as f32).expect("plan");
    plan.set_lod_height(LOD_HEIGHT);
    assert!(plan.views > 1, "the sun's cascades are culled too");
    assert_gpu_cull_equals_cpu(&gpu, &renderer, &plan);
    let args = renderer.read_view_args(&gpu, 0).expect("args");
    let drawn: u64 = args.iter().map(|a| u64::from(a.instance_count) * u64::from(a.index_count / 3)).sum();
    let instances: u64 = args.iter().map(|a| u64::from(a.instance_count)).sum();
    let per_level: Vec<u32> = args.iter().map(|a| a.instance_count).collect();
    eprintln!("{instances} spheres in view: {drawn} triangles drawn against {} whole; per level {per_level:?}", instances * whole_triangles);
    if let Ok(dir) = std::env::var("GENEX_PERF_OUT") {
        let report = json!({ "row": "lod-triangles", "instances": instances, "drawn": drawn, "whole": instances * whole_triangles, "per_level": per_level });
        std::fs::create_dir_all(&dir).expect("perf folder");
        std::fs::write(std::path::Path::new(&dir).join("A69-lod-triangles.json"), report.to_string()).expect("written");
    }
    assert_eq!(instances, count as u64, "every sphere drawn once");
    let cpu = plan.cpu_cull();
    let expected: u64 = plan.batches.iter().zip(&cpu.counts).map(|(batch, count)| u64::from(*count) * u64::from(batch.index_count / 3)).sum();
    assert_eq!(drawn, expected, "the triangles of the CPU cull's levels");
    assert!(per_level[0] > 0 && per_level.last().is_some_and(|coarsest| *coarsest > 0), "near spheres whole, far ones coarsest: {per_level:?}");
    assert!(drawn * 2 < instances * whole_triangles, "receding spheres draw under half their whole triangles ({drawn} of {})", instances * whole_triangles);
    // Near the camera every instance draws the mesh itself: the picture is the one a library
    // without levels draws.
    let near = |mesh: MeshId| receding_spheres(mesh, 1, true);
    let mut plain = Renderer::new(&gpu, LOD_WIDTH, LOD_HEIGHT).expect("renderer");
    let plain_mesh = plain.add_model_parts(&gpu, vec![genex_render::scene::ModelPart { lods: None, ..part }]).expect("added")[0];
    renderer.render(&gpu, &near(mesh), genex_render::CullPath::Gpu).expect("frame");
    plain.render(&gpu, &near(plain_mesh), genex_render::CullPath::Gpu).expect("frame");
    let (with_levels, without) = (renderer.capture(&gpu).expect("capture"), plain.capture(&gpu).expect("capture"));
    assert_eq!(with_levels.digest(), without.digest(), "level 0 is the mesh itself");
}

/// The median of `samples`.
fn median(samples: &[f32]) -> f32 {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f32::total_cmp);
    sorted[sorted.len() / 2]
}

/// Slack on the cull cost bound for timer noise, in milliseconds.
const LOD_CULL_SLACK_MS: f32 = 0.05;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_cull_of_a_field_with_levels_costs_what_its_slots_cost() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, LOD_WIDTH, LOD_HEIGHT).expect("renderer");
    let part = sphere_part();
    let with_levels = renderer.add_model_parts(&gpu, vec![part.clone()]).expect("added")[0];
    let whole = renderer.add_model_parts(&gpu, vec![genex_render::scene::ModelPart { lods: None, ..part }]).expect("added")[0];
    let field = |mesh: MeshId| {
        let mut scene = Scene::new(CameraDesc::look_at([0.0, 30.0, 220.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
        scene.lighting.shadows = true;
        let models: Vec<[f32; 16]> = (0..50_000).map(|i| translation((i % 250) as f32 * 1.6 - 200.0, 0.0, (i / 250) as f32 * 1.6 - 160.0)).collect();
        scene.draw_instanced(mesh, &models, Material::color([150, 160, 140, 255]));
        scene
    };
    let mut rows = Vec::new();
    for (name, mesh) in [("whole", whole), ("levels", with_levels)] {
        let Some(costs) = renderer.cull_gpu_ms(&gpu, &field(mesh), 40).expect("cull cost") else {
            eprintln!("skipped: no timestamp queries");
            return;
        };
        rows.push((name, median(&costs)));
    }
    eprintln!("cull of 50k spheres with shadows: {rows:?}");
    if let Ok(dir) = std::env::var("GENEX_PERF_OUT") {
        let report = json!({ "row": "lod-cull-cost", "instances": 50_000, "rows": rows.iter().map(|(name, ms)| json!({ "case": name, "median_ms": ms })).collect::<Vec<_>>() });
        std::fs::create_dir_all(&dir).expect("perf folder");
        std::fs::write(std::path::Path::new(&dir).join("A69-lod-cull-cost.json"), report.to_string()).expect("written");
    }
    // Each level has slots of its own over the field's rows: the cull may cost what that many
    // rows cost without levels (linear in slots: the batch lookup and the level pick are cheap).
    let slots_per_instance = (1 + sphere_part().lods.map_or(0, |chain| chain.levels.len())) as f32;
    let (whole_ms, levels_ms) = (rows[0].1, rows[1].1);
    assert!(levels_ms <= slots_per_instance * whole_ms + LOD_CULL_SLACK_MS, "the cull with levels took {levels_ms:.4} ms against {whole_ms:.4} ms whole ({slots_per_instance} slots an instance)");
}
