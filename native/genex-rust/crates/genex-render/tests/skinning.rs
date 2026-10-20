//! Game systems AN-16a: a skinned GLB loads every primitive of every node its skin binds, one part
//! per material, and each part skins and draws on its own under its own material.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test skinning -- --include-ignored
//!
//! `GENEX_RENDER_EVIDENCE_DIR` receives the drawn frame (raw BGRA, top row first).

use std::path::PathBuf;

use genex_render::scene::{CameraDesc, FramePlan, Material, MeshLibrary, Scene, translation};
use genex_render::skin::{SkinPart, SkinnedMeshData, SkinnedModel};
use genex_render::{CullPath, Gpu, RenderCode, Renderer};

const RED: [u8; 4] = [230, 30, 30, 255];
const BLUE: [u8; 4] = [30, 60, 230, 255];
const WIDTH: u32 = 160;
const HEIGHT: u32 = 90;

// ---------------------------------------------------------------------------------------------
// Fixtures: a skinned GLB of quads, each one primitive bound to one joint

/// One quad primitive: x from `x0` to `x1`, y from 0 to 1, facing +Z, naming `material`.
#[derive(Clone, Copy)]
struct Quad {
    x0: f32,
    x1: f32,
    material: Option<u32>,
}

const LEFT_RED: Quad = Quad { x0: -1.0, x1: -0.1, material: Some(0) };
const RIGHT_BLUE: Quad = Quad { x0: 0.1, x1: 1.0, material: Some(1) };

fn push_f32(bin: &mut Vec<u8>, values: &[f32]) {
    bin.extend(values.iter().flat_map(|v| v.to_le_bytes()));
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

/// A GLB with one skinned node per entry of `meshes` (each a mesh of those quads), all bound to
/// skin 0 of one joint (the last node), the red and blue materials, and `extra` unskinned quads
/// on a node of their own.
fn skinned_glb(meshes: &[&[Quad]], extra: Option<Quad>) -> Vec<u8> {
    let mut bin = Vec::new();
    let mut views = Vec::new();
    let mut accessors = Vec::new();
    let mut view = |bin: &mut Vec<u8>, bytes: &[u8]| {
        views.push(format!(r#"{{"buffer":0,"byteOffset":{},"byteLength":{}}}"#, bin.len(), bytes.len()));
        bin.extend(bytes);
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        views.len() - 1
    };
    let mut primitive = |bin: &mut Vec<u8>, quad: &Quad, skinned: bool| {
        let (x0, x1) = (quad.x0, quad.x1);
        let mut positions = Vec::new();
        push_f32(&mut positions, &[x0, 0.0, 0.0, x1, 0.0, 0.0, x1, 1.0, 0.0, x0, 1.0, 0.0]);
        let mut normals = Vec::new();
        push_f32(&mut normals, &[0.0, 0.0, 1.0].repeat(4));
        let joints: Vec<u8> = [0u16; 16].iter().flat_map(|j| j.to_le_bytes()).collect();
        let mut weights = Vec::new();
        push_f32(&mut weights, &[1.0, 0.0, 0.0, 0.0].repeat(4));
        let indices: Vec<u8> = [0u16, 1, 2, 0, 2, 3].iter().flat_map(|i| i.to_le_bytes()).collect();
        let base = accessors.len();
        let (p, n) = (view(bin, &positions), view(bin, &normals));
        accessors.push(format!(r#"{{"bufferView":{p},"componentType":5126,"count":4,"type":"VEC3","min":[{x0},0,0],"max":[{x1},1,0]}}"#));
        accessors.push(format!(r#"{{"bufferView":{n},"componentType":5126,"count":4,"type":"VEC3"}}"#));
        let i = view(bin, &indices);
        accessors.push(format!(r#"{{"bufferView":{i},"componentType":5123,"count":6,"type":"SCALAR"}}"#));
        let mut attributes = format!(r#""POSITION":{base},"NORMAL":{}"#, base + 1);
        if skinned {
            let (j, w) = (view(bin, &joints), view(bin, &weights));
            accessors.push(format!(r#"{{"bufferView":{j},"componentType":5123,"count":4,"type":"VEC4"}}"#));
            accessors.push(format!(r#"{{"bufferView":{w},"componentType":5126,"count":4,"type":"VEC4"}}"#));
            attributes.push_str(&format!(r#","JOINTS_0":{},"WEIGHTS_0":{}"#, base + 3, base + 4));
        }
        let material = quad.material.map_or(String::new(), |m| format!(r#","material":{m}"#));
        format!(r#"{{"attributes":{{{attributes}}},"indices":{}{material}}}"#, base + 2)
    };
    let mut gltf_meshes = Vec::new();
    for quads in meshes {
        let primitives: Vec<String> = quads.iter().map(|quad| primitive(&mut bin, quad, true)).collect();
        gltf_meshes.push(format!(r#"{{"primitives":[{}]}}"#, primitives.join(",")));
    }
    if let Some(quad) = extra {
        gltf_meshes.push(format!(r#"{{"primitives":[{}]}}"#, primitive(&mut bin, &quad, false)));
    }
    let mut ibm = Vec::new();
    push_f32(&mut ibm, &[1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
    let ibm_view = view(&mut bin, &ibm);
    accessors.push(format!(r#"{{"bufferView":{ibm_view},"componentType":5126,"count":1,"type":"MAT4"}}"#));
    let ibm_accessor = accessors.len() - 1;
    let mut nodes: Vec<String> = (0..meshes.len()).map(|m| format!(r#"{{"mesh":{m},"skin":0}}"#)).collect();
    if extra.is_some() {
        nodes.push(format!(r#"{{"mesh":{}}}"#, meshes.len()));
    }
    nodes.push(r#"{"name":"joint"}"#.to_owned());
    let joint = nodes.len() - 1;
    let json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{}}}],"bufferViews":[{}],"accessors":[{}],
        "materials":[{{"pbrMetallicRoughness":{{"baseColorFactor":[0.8,0.05,0.05,1]}}}},{{"pbrMetallicRoughness":{{"baseColorFactor":[0.05,0.1,0.8,1]}}}}],
        "meshes":[{}],"nodes":[{}],"skins":[{{"joints":[{joint}],"inverseBindMatrices":{ibm_accessor}}}],
        "scenes":[{{"nodes":[{}]}}],"scene":0}}"#,
        bin.len(),
        views.join(","),
        accessors.join(","),
        gltf_meshes.join(","),
        nodes.join(","),
        (0..nodes.len()).map(|n| n.to_string()).collect::<Vec<_>>().join(","),
    );
    glb(json, &bin)
}

fn two_material_model() -> SkinnedModel {
    SkinnedModel::from_glb(&skinned_glb(&[&[LEFT_RED, RIGHT_BLUE]], None)).expect("the two-material GLB loads")
}

const IDENTITY: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

fn camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 0.5, 2.6], [0.0, 0.5, 0.0])
}

// ---------------------------------------------------------------------------------------------
// The loader

#[test]
fn a_two_material_skinned_glb_loads_one_part_per_material() {
    let model = two_material_model();
    assert_eq!(model.data.mesh.vertices.len(), 8);
    assert_eq!(
        model.parts,
        [
            SkinPart { first_vertex: 0, vertex_count: 4, first_index: 0, index_count: 6, material: Some(0) },
            SkinPart { first_vertex: 4, vertex_count: 4, first_index: 6, index_count: 6, material: Some(1) },
        ]
    );
    // The merged mesh is what SkinnedMeshData::from_glb answers.
    let merged = SkinnedMeshData::from_glb(&skinned_glb(&[&[LEFT_RED, RIGHT_BLUE]], None)).expect("merged");
    assert_eq!(merged, model.data);
}

#[test]
fn primitives_of_one_material_gather_into_one_part_in_first_use_order() {
    let middle_red = Quad { x0: -0.05, x1: 0.05, material: Some(0) };
    let model = SkinnedModel::from_glb(&skinned_glb(&[&[RIGHT_BLUE, LEFT_RED, middle_red]], None)).expect("loads");
    let materials: Vec<Option<u32>> = model.parts.iter().map(|part| part.material).collect();
    assert_eq!(materials, [Some(1), Some(0)], "blue is used first");
    assert_eq!((model.parts[1].first_vertex, model.parts[1].vertex_count, model.parts[1].index_count), (4, 8, 12));
    let mesh = &model.data.mesh;
    for part in &model.parts {
        let own = &mesh.indices[part.first_index as usize..(part.first_index + part.index_count) as usize];
        let range = part.first_vertex..part.first_vertex + part.vertex_count;
        assert!(own.iter().all(|index| range.contains(index)), "a part's triangles use its own vertices");
    }
    // The red part's vertices are the left quad's, then the middle quad's.
    assert_eq!(mesh.vertices[4].position[0], -1.0);
    assert_eq!(mesh.vertices[8].position[0], -0.05);
}

#[test]
fn every_node_the_skin_binds_loads_and_unskinned_nodes_stay_out() {
    // Body and clothes: two nodes on one skin. Today only the first node's triangles loaded.
    let model = SkinnedMeshData::from_glb(&skinned_glb(&[&[LEFT_RED], &[RIGHT_BLUE]], Some(Quad { x0: 2.0, x1: 3.0, material: None }))).expect("loads");
    assert_eq!(model.mesh.indices.len(), 12, "both skinned nodes' quads, not the unskinned one");
    assert_eq!(model.skin.len(), 8);
    assert!(model.mesh.vertices.iter().all(|v| v.position[0] < 2.0), "the unskinned quad is not part of the skin");
}

#[test]
fn a_glb_naming_no_material_is_one_part_holding_the_whole_mesh() {
    let plain = Quad { x0: -1.0, x1: 1.0, material: None };
    let model = SkinnedModel::from_glb(&skinned_glb(&[&[plain]], None)).expect("loads");
    assert_eq!(model.parts, [SkinPart::whole(&model.data.mesh)]);
}

// ---------------------------------------------------------------------------------------------
// The library and the plan

#[test]
fn hostile_part_lists_are_refused_mesh_invalid_and_add_nothing() {
    let model = two_material_model();
    let part = |first_vertex, vertex_count, first_index, index_count| SkinPart { first_vertex, vertex_count, first_index, index_count, material: None };
    let cases: [(&str, Vec<SkinPart>); 7] = [
        ("no part", vec![]),
        ("no vertices", vec![part(0, 0, 0, 12)]),
        ("no indices", vec![part(0, 8, 0, 0)]),
        ("past the vertices", vec![part(4, 8, 0, 6)]),
        ("past the indices", vec![part(0, 8, 6, 12)]),
        ("not whole triangles", vec![part(0, 8, 0, 4)]),
        ("an index outside the part", vec![part(0, 4, 0, 12)]),
    ];
    for (name, parts) in cases {
        let mut library = MeshLibrary::new();
        let meshes = library.len();
        let error = library.add_skinned_parts(&model.data, &parts).expect_err(name);
        assert_eq!(error.code(), RenderCode::MeshInvalid, "{name}");
        assert_eq!(library.len(), meshes, "{name}: nothing added");
        assert!(library.skin().is_empty(), "{name}: no skin rows added");
    }
}

#[test]
fn each_part_runs_its_own_job_and_draws_its_own_batch_with_its_own_material() {
    let model = two_material_model();
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned_parts(&model.data, &model.parts).expect("added");
    assert_eq!(skin.part_count(), 2);
    assert_eq!(library.skin_parts(skin), model.parts.as_slice());
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned_parts(skin, IDENTITY, vec![IDENTITY], vec![Material::color(RED), Material::color(BLUE)]);
    let plan = FramePlan::build(&scene, &library, 16.0 / 9.0).expect("plan");
    assert_eq!(plan.skin_jobs.len(), 2, "one job per part");
    assert_eq!(plan.joints.len(), 1, "the palette once for the draw");
    assert_eq!(plan.skinned_vertices, 8);
    let (red, blue) = (&plan.skin_jobs[0], &plan.skin_jobs[1]);
    assert_eq!((red.count, red.dst_base, blue.count, blue.dst_base), (4, 0, 4, 4));
    assert_eq!(blue.skin_base, red.skin_base + 4);
    assert_ne!(red.slot, blue.slot, "each part's vertices carry their own slot");
    let skinned = &plan.batches[plan.static_batches as usize..plan.plain_batches as usize];
    assert_eq!(skinned.len(), 2, "one batch per part");
    // Each batch's indices land on its own part's output: index (first vertex + k) at dst + k.
    assert_eq!(skinned[1].base_vertex + 4, blue.dst_base as i32);
    let rows: Vec<u32> = skinned.iter().map(|batch| plan.instances[batch.first_row as usize].material).collect();
    assert_ne!(rows[0], rows[1], "the parts draw with their own material rows");
    let colour = |row: u32| plan.materials[row as usize].base_color;
    assert!(colour(rows[0])[0] > colour(rows[0])[2] && colour(rows[1])[2] > colour(rows[1])[0], "red, then blue");
    // The same draw with one material: the old single-material draw, two parts.
    let mut one = Scene::new(camera(), [0, 0, 0, 255]);
    one.draw_skinned(skin, IDENTITY, vec![IDENTITY], Material::color(RED));
    let plan = FramePlan::build(&one, &library, 16.0 / 9.0).expect("plan");
    let skinned = &plan.batches[plan.static_batches as usize..plan.plain_batches as usize];
    assert_eq!(plan.instances[skinned[0].first_row as usize].material, plan.instances[skinned[1].first_row as usize].material);
}

#[test]
fn a_draw_naming_the_wrong_number_of_materials_is_refused_mesh_invalid() {
    let model = two_material_model();
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned_parts(&model.data, &model.parts).expect("added");
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned_parts(skin, IDENTITY, vec![IDENTITY], vec![Material::color(RED)]);
    let error = FramePlan::build(&scene, &library, 1.0).expect_err("one material for two parts");
    assert_eq!(error.code(), RenderCode::MeshInvalid);
}

#[test]
fn a_skin_of_another_library_is_refused_mesh_invalid() {
    let model = two_material_model();
    let mut theirs = MeshLibrary::new();
    let skin = theirs.add_skinned_parts(&model.data, &model.parts).expect("added");
    // Ours holds a one-part skin on the same mesh slot: the two-part id names parts it lacks.
    let mut ours = MeshLibrary::new();
    ours.add_skinned(&model.data).expect("added");
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned(skin, IDENTITY, vec![IDENTITY], Material::color(RED));
    let error = FramePlan::build(&scene, &ours, 1.0).expect_err("parts it does not hold");
    assert_eq!(error.code(), RenderCode::MeshInvalid);
}

#[test]
fn a_transparent_part_sorts_with_the_glass_and_the_opaque_part_stays_batched() {
    let model = two_material_model();
    let mut library = MeshLibrary::new();
    let skin = library.add_skinned_parts(&model.data, &model.parts).expect("added");
    let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
    scene.draw_skinned_parts(skin, IDENTITY, vec![IDENTITY], vec![Material::color(RED), Material::color([30, 60, 230, 128])]);
    let plan = FramePlan::build(&scene, &library, 16.0 / 9.0).expect("plan");
    assert_eq!(plan.plain_batches - plan.static_batches, 1, "the red part's batch");
    assert_eq!(plan.transparent.len(), 1, "the blue part is glass");
    assert!(plan.transparent_sources[0].skinned);
    assert_eq!(plan.transparent_sources[0].index_count, 6);
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

fn write_evidence(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

/// The BGRA pixel at (`x`, `y`) of a capture as RGB.
fn rgb(bgra: &[u8], x: u32, y: u32) -> [u8; 3] {
    let i = ((y * WIDTH + x) * 4) as usize;
    [bgra[i + 2], bgra[i + 1], bgra[i]]
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_two_material_skinned_glb_draws_both_parts_with_their_own_materials() {
    let Some(gpu) = gpu() else { return };
    let model = two_material_model();
    let picture = |cull: CullPath| {
        let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
        let skin = renderer.add_skinned_model(&gpu, &model).expect("skinned model");
        let mut scene = Scene::new(camera(), [0, 0, 0, 255]);
        scene.lighting.shadows = false;
        // The joint lifts the quads 0.1 m: the skinning moved them.
        scene.draw_skinned_parts(skin, IDENTITY, vec![translation(0.0, 0.1, 0.0)], vec![Material::color(RED), Material::color(BLUE)]);
        renderer.render(&gpu, &scene, cull).expect("frame");
        assert_eq!(renderer.last_stats().skin_jobs, 2);
        renderer.capture(&gpu).expect("capture").bgra().to_vec()
    };
    let (indirect, direct) = (picture(CullPath::Gpu), picture(CullPath::Cpu));
    assert!(indirect == direct, "the GPU-culled frame equals the CPU-culled one");
    write_evidence("an16a-two-material.bgra", &indirect);
    let (left, right) = (rgb(&indirect, WIDTH / 4, HEIGHT / 2), rgb(&indirect, WIDTH * 3 / 4, HEIGHT / 2));
    eprintln!("left {left:?}, right {right:?}");
    assert!(left[0] > 2 * left[2].max(8), "the left part is red: {left:?}");
    assert!(right[2] > 2 * right[0].max(8), "the right part is blue: {right:?}");
}
