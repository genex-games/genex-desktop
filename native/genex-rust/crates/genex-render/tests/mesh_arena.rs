//! The mesh arena (game systems STR-1): adding a model writes its own bytes to the GPU, never the
//! whole library again (the head re-uploaded every mesh on each add, O(library)).
//!
//! The pure rows drive `MeshArena` through a counting device (no GPU). The `metal_` rows count
//! the renderer's own uploads and compare pictures:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test mesh_arena --offline --locked -- --include-ignored

use genex_render::caps::BUFFER_MAX_BYTES;
use genex_render::layout::GpuSkinVertex;
use genex_render::mesh::{MeshData, Vertex};
use genex_render::mesh_arena::{ArenaDevice, ArenaSources, ArenaStream, MeshArena};
use genex_render::meshlet::MESHLET_RECORD_BYTES;
use genex_render::scene::{CameraDesc, Material, MeshId, MeshLibrary, ModelPart, Scene, translation};
use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};
use genex_render::{CullPath, Gpu, RenderCode, RenderError, Renderer};

const WIDTH: u32 = 96;
const HEIGHT: u32 = 64;
/// Models added before the counted one (the plan's "50th model").
const MODELS_BEFORE: usize = 49;
/// Bytes one add may write, relative to the model's own (the WP's acceptance: within 1.1x).
const UPLOAD_SLACK: f64 = 1.1;

// --- A counting device (the plan's `Uploads` shim) ------------------------------------------

/// A buffer the counting device made: its stream and its bytes.
#[derive(Clone, Debug)]
struct FakeBuffer {
    id: usize,
    bytes: u64,
}

/// Records every buffer made, every write and every copy.
#[derive(Default)]
struct Counting {
    made: Vec<(ArenaStream, u64)>,
    writes: Vec<(usize, u64, usize)>,
    copies: Vec<(usize, usize, u64)>,
    contents: Vec<Vec<u8>>,
}

impl Counting {
    fn written(&self) -> u64 {
        self.writes.iter().map(|(_, _, len)| *len as u64).sum()
    }
}

impl ArenaDevice for Counting {
    type Buffer = FakeBuffer;

    fn create(&mut self, stream: ArenaStream, bytes: u64) -> Result<FakeBuffer, RenderError> {
        genex_render::caps::check_buffer(bytes)?;
        self.made.push((stream, bytes));
        self.contents.push(vec![0; bytes as usize]);
        Ok(FakeBuffer { id: self.contents.len() - 1, bytes })
    }

    fn write(&mut self, buffer: &FakeBuffer, offset: u64, bytes: &[u8]) {
        assert!(offset + bytes.len() as u64 <= buffer.bytes, "a write past its buffer");
        assert_eq!(offset % 4, 0, "writes are 4-aligned");
        self.writes.push((buffer.id, offset, bytes.len()));
        self.contents[buffer.id][offset as usize..offset as usize + bytes.len()].copy_from_slice(bytes);
    }

    fn copy(&mut self, from: &FakeBuffer, to: &FakeBuffer, bytes: u64) {
        assert!(bytes <= from.bytes && bytes <= to.bytes, "a copy past a buffer");
        self.copies.push((from.id, to.id, bytes));
        let prefix = self.contents[from.id][..bytes as usize].to_vec();
        self.contents[to.id][..bytes as usize].copy_from_slice(&prefix);
    }
}

/// Sources with only the vertex and index streams holding `vertices` and `indices` bytes.
fn sources<'a>(vertices: &'a [u8], indices: &'a [u8]) -> ArenaSources<'a> {
    let mut bytes = [Some(&[][..]); ArenaStream::ALL.len()];
    bytes[ArenaStream::Vertices.index()] = Some(vertices);
    bytes[ArenaStream::Indices.index()] = Some(indices);
    ArenaSources { bytes }
}

fn ramp(len: usize, seed: u8) -> Vec<u8> {
    (0..len).map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed)).collect()
}

#[test]
fn an_append_writes_only_the_new_rows_at_their_offsets() {
    let mut device = Counting::default();
    let stride = ArenaStream::Vertices.stride() as usize;
    let (mut vertices, mut indices) = (ramp(stride * 10, 1), ramp(4 * 30, 2));
    let mut arena = MeshArena::new(&mut device, &sources(&vertices, &indices)).expect("arena");
    let first = device.written();
    assert_eq!(first, (vertices.len() + indices.len()) as u64, "the first library goes up whole");
    for round in 0..50u8 {
        let before = device.written();
        let (more_v, more_i) = (ramp(stride * (3 + round as usize), round), ramp(4 * (9 + round as usize), round ^ 0x5a));
        vertices.extend_from_slice(&more_v);
        indices.extend_from_slice(&more_i);
        arena.sync(&mut device, &sources(&vertices, &indices)).expect("sync");
        assert_eq!(device.written() - before, (more_v.len() + more_i.len()) as u64, "round {round} wrote only its rows");
    }
    let held = |stream: ArenaStream| {
        let buffer = arena.buffer(stream);
        device.contents[buffer.id][..arena.rows(stream) as usize * stream.stride() as usize].to_vec()
    };
    assert_eq!(held(ArenaStream::Vertices), vertices, "the GPU copy equals the library's vertices");
    assert_eq!(held(ArenaStream::Indices), indices, "the GPU copy equals the library's indices");
    let stats = arena.stats();
    assert!(stats.grows > 0, "the arena grew: {stats:?}");
    assert_eq!(stats.uploaded_bytes, device.written(), "the stats count every written byte");
    assert_eq!(stats.copied_bytes, device.copies.iter().map(|(_, _, b)| b).sum::<u64>(), "and every copied byte");
}

#[test]
fn growth_doubles_copies_the_live_prefix_and_stays_within_the_webgpu_binding() {
    let mut device = Counting::default();
    let mut indices = ramp(4 * 64, 3);
    let mut arena = MeshArena::new(&mut device, &sources(&[], &indices)).expect("arena");
    let start = arena.capacity(ArenaStream::Indices);
    indices.extend_from_slice(&ramp(4 * 4, 4));
    arena.sync(&mut device, &sources(&[], &indices)).expect("sync");
    let grown = arena.capacity(ArenaStream::Indices);
    assert_eq!(grown, start * 2, "a full stream doubles (Bevy's slab rule)");
    assert_eq!(device.copies.last().map(|c| c.2), Some(4 * 64), "the live prefix moved on the GPU, not from the CPU");
    // A need past twice the capacity takes exactly what it needs (aligned).
    indices.extend_from_slice(&ramp(4 * 4096, 5));
    arena.sync(&mut device, &sources(&[], &indices)).expect("sync");
    let need = indices.len() as u64;
    assert!(arena.capacity(ArenaStream::Indices) >= need && arena.capacity(ArenaStream::Indices) < need + 64, "{}", arena.capacity(ArenaStream::Indices));
    for (_, bytes) in &device.made {
        assert!(*bytes <= BUFFER_MAX_BYTES, "a buffer of {bytes} bytes passes WebGPU's 128 MiB binding (and its 256 MiB buffer)");
    }
}

#[test]
fn a_reserve_takes_a_class_start_size_once_and_keeps_the_rows() {
    let mut device = Counting::default();
    let indices = ramp(4 * 8, 10);
    let mut arena = MeshArena::new(&mut device, &sources(&[], &indices)).expect("arena");
    let start = 8 << 20;
    arena.reserve(&mut device, ArenaStream::Indices, start).expect("reserve");
    assert_eq!(arena.capacity(ArenaStream::Indices), start);
    assert_eq!(device.copies.last().map(|c| c.2), Some(32), "the rows moved on the GPU");
    let made = device.made.len();
    arena.reserve(&mut device, ArenaStream::Indices, 1024).expect("a smaller reserve");
    arena.reserve(&mut device, ArenaStream::Indices, u64::MAX).expect("a reserve past the cap is clamped");
    assert_eq!(arena.capacity(ArenaStream::Indices), BUFFER_MAX_BYTES);
    assert_eq!(device.made.len(), made + 1, "the smaller reserve made nothing");
    let held = arena.buffer(ArenaStream::Indices);
    assert_eq!(&device.contents[held.id][..32], &indices[..], "the rows survived both moves");
}

#[test]
fn a_need_past_the_binding_cap_refuses_with_nothing_written() {
    let mut device = Counting::default();
    let indices = ramp(4 * 8, 6);
    let mut arena = MeshArena::new(&mut device, &sources(&[], &indices)).expect("arena");
    let before = (device.written(), device.made.len(), arena.stats());
    // The check reads lengths only: a slice header past the cap without 128 MiB of memory.
    let past = vec![0u8; (BUFFER_MAX_BYTES + 4) as usize];
    let error = arena.sync(&mut device, &sources(&past, &indices)).expect_err("past the cap");
    assert_eq!(error.code(), RenderCode::BufferTooLarge, "{error}");
    assert_eq!((device.written(), device.made.len(), arena.stats()), before, "nothing written, made or counted");
    assert_eq!(arena.rows(ArenaStream::Vertices), 0, "the stream kept its rows");
}

#[test]
fn a_shrunk_stream_is_refused_not_mirrored() {
    let mut device = Counting::default();
    let indices = ramp(4 * 8, 7);
    let mut arena = MeshArena::new(&mut device, &sources(&[], &indices)).expect("arena");
    let error = arena.sync(&mut device, &sources(&[], &indices[..16])).expect_err("rows only grow in STR-1");
    assert_eq!(error.code(), RenderCode::MeshInvalid, "{error}");
    // A replace (a re-clustered meshlet table) takes the new rows whole.
    let before = device.written();
    arena.replace(&mut device, ArenaStream::Indices, &indices[..16]).expect("replace");
    assert_eq!(device.written() - before, 16);
    assert_eq!(arena.rows(ArenaStream::Indices), 4);
}

#[test]
fn a_stream_not_synced_this_time_is_left_alone() {
    let mut device = Counting::default();
    let indices = ramp(4 * 8, 8);
    let mut arena = MeshArena::new(&mut device, &sources(&[], &indices)).expect("arena");
    let mut later = sources(&[], &indices);
    let longer = ramp(4 * 20, 9);
    later.bytes[ArenaStream::Meshlets.index()] = None;
    later.bytes[ArenaStream::Skin.index()] = Some(&longer[..GpuSkinVertexBytes::ROW * 2]);
    let before = device.written();
    arena.sync(&mut device, &later).expect("sync");
    assert_eq!(device.written() - before, GpuSkinVertexBytes::ROW as u64 * 2, "only the skin rows went up");
    assert_eq!(arena.rows(ArenaStream::Meshlets), 0);
}

/// The skin stream's row bytes.
struct GpuSkinVertexBytes;
impl GpuSkinVertexBytes {
    const ROW: usize = size_of::<GpuSkinVertex>();
}

#[test]
fn stream_strides_are_the_library_rows() {
    assert_eq!(ArenaStream::Vertices.stride() as usize, size_of::<Vertex>());
    assert_eq!(ArenaStream::Skin.stride() as usize, size_of::<GpuSkinVertex>());
    assert_eq!(ArenaStream::Meshlets.stride(), MESHLET_RECORD_BYTES);
    for stream in [ArenaStream::Slots, ArenaStream::Indices, ArenaStream::MeshletVertices, ArenaStream::MeshletTriangles] {
        assert_eq!(stream.stride(), 4, "{stream:?}");
    }
}

// --- The library's adds are all-or-nothing without a clone ------------------------------------

#[test]
fn a_refused_part_adds_none_of_its_model() {
    let mut library = MeshLibrary::new();
    let (meshes, vertices, indices) = (library.len(), library.vertices().len(), library.indices().len());
    let parts = vec![ModelPart::whole(grid(4, 0.0)), ModelPart::whole(MeshData::default())];
    let error = library.add_parts(parts).expect_err("an empty part refuses the model");
    assert_eq!(error.code(), RenderCode::MeshInvalid, "{error}");
    assert_eq!((library.len(), library.vertices().len(), library.indices().len()), (meshes, vertices, indices), "nothing was added");
    let ids = library.add_parts(vec![ModelPart::whole(grid(4, 0.0)), ModelPart::whole(grid(2, 1.0))]).expect("two parts");
    assert_eq!(ids, vec![MeshId::from_raw(meshes as u32), MeshId::from_raw(meshes as u32 + 1)]);
}

#[test]
fn a_mesh_past_the_gpu_binding_is_refused_buffer_too_large() {
    let mut library = MeshLibrary::new();
    let rows = (BUFFER_MAX_BYTES / size_of::<Vertex>() as u64) as usize + 1;
    let mesh = MeshData { vertices: vec![Vertex::default(); rows], indices: vec![0, 1, 2] };
    let error = library.add(mesh).expect_err("past the 128 MiB binding");
    assert_eq!(error.code(), RenderCode::BufferTooLarge, "{error}");
    assert_eq!(library.len(), 2, "nothing was added");
}

// --- The renderer: bytes per add and the same picture ------------------------------------------

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

/// A flat `cells` x `cells` grid at height `y`, its own size.
fn grid(cells: u32, y: f32) -> MeshData {
    let side = cells + 1;
    let vertices = (0..side * side)
        .map(|i| {
            let (x, z) = ((i % side) as f32 / cells as f32 - 0.5, (i / side) as f32 / cells as f32 - 0.5);
            Vertex { position: [x, y, z], normal: [0.0, 1.0, 0.0], uv: [x + 0.5, z + 0.5], tangent: [1.0, 0.0, 0.0, 1.0] }
        })
        .collect();
    let mut indices = Vec::new();
    for row in 0..cells {
        for col in 0..cells {
            let a = row * side + col;
            indices.extend_from_slice(&[a, a + side, a + 1, a + 1, a + side, a + side + 1]);
        }
    }
    MeshData { vertices, indices }
}

/// The bytes the library holds in every stream the arena mirrors.
fn library_bytes(library: &MeshLibrary) -> u64 {
    let meshlets = library.meshlets();
    let rows = [
        size_of_val(library.vertices()),
        library.slots().len() * 4,
        library.indices().len() * 4,
        size_of_val(library.skin()),
        meshlets.meshlets.len() * MESHLET_RECORD_BYTES as usize,
        meshlets.vertices.len() * 4,
        meshlets.triangles.len() * 4,
    ];
    rows.iter().map(|b| *b as u64).sum()
}

/// Adds `mesh` and returns (bytes uploaded, the model's own bytes).
fn counted_add(gpu: &Gpu, renderer: &mut Renderer, mesh: MeshData) -> (u64, u64) {
    let (uploaded, held) = (renderer.mesh_arena_stats().uploaded_bytes, library_bytes(renderer.library()));
    renderer.add_mesh(gpu, mesh).expect("mesh");
    (renderer.mesh_arena_stats().uploaded_bytes - uploaded, library_bytes(renderer.library()) - held)
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_the_fiftieth_model_uploads_only_its_own_bytes() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let (second, second_own) = counted_add(&gpu, &mut renderer, grid(6, 0.0));
    for i in 1..MODELS_BEFORE {
        renderer.add_mesh(&gpu, grid(4 + (i as u32 % 9), i as f32 * 0.01)).expect("model");
    }
    let (fiftieth, own) = counted_add(&gpu, &mut renderer, grid(5, 1.0));
    let library = library_bytes(renderer.library());
    eprintln!("2nd add: {second} B (own {second_own} B); 50th add: {fiftieth} B (own {own} B, library {library} B)");
    assert!(second as f64 <= second_own as f64 * UPLOAD_SLACK, "the 2nd add wrote {second} bytes for a {second_own}-byte model");
    assert!(fiftieth as f64 <= own as f64 * UPLOAD_SLACK, "the 50th add wrote {fiftieth} bytes for a {own}-byte model (library {library} bytes)");
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_a_skinned_add_uploads_its_mesh_and_skin_rows_only() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    for i in 0..8 {
        renderer.add_mesh(&gpu, grid(8, i as f32)).expect("model");
    }
    let mesh = grid(3, 0.0);
    let skin = vec![GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()];
    let skeleton = Skeleton { nodes: vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }], joints: vec![0], inverse_bind: vec![translation(0.0, 0.0, 0.0)], mesh_node: None };
    let data = SkinnedMeshData { mesh, skin, skeleton, animations: Vec::new() };
    let (uploaded, held) = (renderer.mesh_arena_stats().uploaded_bytes, library_bytes(renderer.library()));
    renderer.add_skinned_mesh(&gpu, &data).expect("skinned");
    let (wrote, own) = (renderer.mesh_arena_stats().uploaded_bytes - uploaded, library_bytes(renderer.library()) - held);
    assert!(wrote as f64 <= own as f64 * UPLOAD_SLACK, "the skinned add wrote {wrote} bytes for {own}");
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_a_refused_model_uploads_nothing_and_the_next_add_still_draws() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let (stats, meshes) = (renderer.mesh_arena_stats(), renderer.library().len());
    let refused = renderer.add_meshes(&gpu, vec![grid(4, 0.0), MeshData::default()]);
    assert!(refused.is_err(), "an empty part refuses the model");
    assert_eq!((renderer.mesh_arena_stats(), renderer.library().len()), (stats, meshes), "nothing written, nothing added");
    let id = renderer.add_mesh(&gpu, grid(4, 0.0)).expect("the next model");
    assert_eq!(id, MeshId::from_raw(meshes as u32));
}

/// Raw BGRA evidence (WIDTH x HEIGHT) for the run log, when the caller names a folder.
fn write_evidence(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

/// Draws every id in a row of cells, so each model's range shows.
fn picture(gpu: &Gpu, renderer: &mut Renderer, ids: &[MeshId]) -> Vec<u8> {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 6.0, 7.0], [0.0, 0.0, 0.0]), [18, 20, 28, 255]);
    scene.lighting.shadows = false;
    for (i, id) in ids.iter().enumerate() {
        let (x, z) = ((i % 8) as f32 - 3.5, (i / 8) as f32 - 3.0);
        let (red, blue) = (60 + (i * 23) % 190, 200 - (i * 7) % 150);
        scene.draw(*id, translation(x, 0.0, z), Material::color([red as u8, 120, blue as u8, 255]));
    }
    renderer.render(gpu, &scene, CullPath::Cpu).expect("frame");
    renderer.capture(gpu).expect("capture").bgra().to_vec()
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_models_added_one_by_one_draw_the_picture_of_one_upload() {
    let Some(gpu) = gpu() else { return };
    let meshes: Vec<MeshData> = (0..40).map(|i| grid(2 + i % 7, (i % 5) as f32 * 0.1)).collect();
    let mut one_by_one = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut ids = vec![MeshId::CUBE, MeshId::SPHERE];
    for mesh in &meshes {
        ids.push(one_by_one.add_mesh(&gpu, mesh.clone()).expect("model"));
    }
    assert!(one_by_one.mesh_arena_stats().grows > 0, "the arena grew while models came in");
    let mut at_once = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut same = vec![MeshId::CUBE, MeshId::SPHERE];
    same.extend(at_once.add_meshes(&gpu, meshes).expect("models"));
    assert_eq!(ids, same, "the same ids");
    let (a, b) = (picture(&gpu, &mut one_by_one, &ids), picture(&gpu, &mut at_once, &same));
    write_evidence("one-by-one.bgra", &a);
    write_evidence("at-once.bgra", &b);
    let differing = a.iter().zip(&b).filter(|(x, y)| x != y).count();
    assert_eq!(differing, 0, "{differing} bytes differ between 40 single adds and one add of 40");
    assert!(a.chunks(4).any(|px| px[..3] != [28, 20, 18]), "the picture draws the models");
}
