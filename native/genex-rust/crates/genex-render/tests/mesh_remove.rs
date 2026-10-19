//! Mesh removal, arena growth and device-loss replay (game systems STR-2): a removed mesh's rows
//! go to the next mesh that fits, a stale id draws nothing and is counted, the arena grows by GPU
//! copy between frames within its peak limit, and a forced device loss replays the same ids and
//! the same picture.
//!
//! The pure rows drive `MeshLibrary` and `MeshArena` through a counting device (no GPU). The
//! `metal_` rows draw:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test mesh_remove --offline --locked -- --include-ignored

use genex_render::device_loss::Resilient;
use genex_render::immediate::ImmediateFrame;
use genex_render::mesh::{LodChain, LodLevel, MeshData, Vertex};
use genex_render::mesh_arena::{ArenaDevice, ArenaSources, ArenaStream, MeshArena, Rewrite, RowAllocator};
use genex_render::scene::{CameraDesc, FramePlan, Material, MeshId, MeshLibrary, MeshletState, ModelPart, Scene, translation};
use genex_render::settings::Meshlets;
use genex_render::skin::{Skeleton, SkeletonNode, SkinnedMeshData, Trs};
use genex_render::{CullPath, Gpu, RenderCode, RenderError, RenderOptions, Renderer};

const WIDTH: u32 = 96;
const HEIGHT: u32 = 64;
/// The churn row: models added, then removed oldest first once this many are live.
const CHURN_ADDS: usize = 500;
const CHURN_REMOVES: usize = 450;
/// The acceptance: the arena's rows (live and freed) within this many times the live bytes after
/// the churn.
const CHURN_SLACK: f64 = 1.5;
/// A stream's buffer is at most this many times its rows (the doubling growth rule).
const GROWTH_SLACK: f64 = 2.0;

// --- A counting device (as `mesh_arena.rs`'s) ---------------------------------------------------

#[derive(Clone, Debug)]
struct FakeBuffer {
    id: usize,
    bytes: u64,
}

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
        self.writes.push((buffer.id, offset, bytes.len()));
        self.contents[buffer.id][offset as usize..offset as usize + bytes.len()].copy_from_slice(bytes);
    }

    fn copy(&mut self, from: &FakeBuffer, to: &FakeBuffer, bytes: u64) {
        self.copies.push((from.id, to.id, bytes));
        let prefix = self.contents[from.id][..bytes as usize].to_vec();
        self.contents[to.id][..bytes as usize].copy_from_slice(&prefix);
    }
}

/// A flat `cells` x `cells` grid at height `y`.
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

/// The library's CPU rows of `stream` as bytes, as the arena mirrors them.
fn stream_bytes(library: &MeshLibrary, stream: ArenaStream) -> Vec<u8> {
    let sources = ArenaSources::of(library, true);
    sources.bytes[stream.index()].unwrap_or_default().to_vec()
}

/// Sync `library` into `arena` with its rewrites, as the renderer does.
fn sync(arena: &mut MeshArena<FakeBuffer>, device: &mut Counting, library: &mut MeshLibrary) -> Result<(), RenderError> {
    let rewrites: Vec<Rewrite> = library.take_rewrites();
    arena.sync_with(device, &ArenaSources::of(library, true), &rewrites)
}

/// The GPU copy of every stream equals the library's rows.
fn assert_mirrored(arena: &MeshArena<FakeBuffer>, device: &Counting, library: &MeshLibrary) {
    for stream in ArenaStream::ALL {
        let rows = stream_bytes(library, stream);
        let held = &device.contents[arena.buffer(stream).id][..rows.len()];
        assert!(held == rows.as_slice(), "the GPU copy of {stream:?} differs from the library's rows");
    }
}

// --- The library: removal, reuse, refusals ----------------------------------------------------

#[test]
fn remove_then_add_reuses_the_range_and_the_slot() {
    let mut library = MeshLibrary::new();
    let a = library.add(grid(4, 0.0)).expect("a");
    let b = library.add(grid(6, 0.0)).expect("b");
    let c = library.add(grid(4, 1.0)).expect("c");
    let b_entry = *library.entry(b).expect("b's entry");
    let (vertices, indices) = (library.vertices().len(), library.indices().len());
    assert_eq!(library.remove(b).expect("removed"), vec![b]);
    assert!(library.entry(b).is_none() && library.is_removed(b), "b names nothing now");
    let d = library.add(grid(6, 2.0)).expect("d");
    assert_eq!(d.raw(), b.raw(), "d took b's slot");
    assert_eq!(d.generation(), b.generation() + 1, "in its next generation");
    assert_ne!(d, b, "so b's id stays stale");
    let d_entry = *library.entry(d).expect("d's entry");
    assert_eq!((d_entry.base_vertex, d_entry.first_index), (b_entry.base_vertex, b_entry.first_index), "d's rows are b's");
    assert_eq!((library.vertices().len(), library.indices().len()), (vertices, indices), "the library did not grow");
    assert!(library.entry(a).is_some() && library.entry(c).is_some(), "the others stay");
    assert!(library.slots()[d_entry.base_vertex as usize..][..d_entry.vertex_count as usize].iter().all(|slot| *slot == d.raw()), "d's vertices carry its slot");
    // A smaller mesh fills a freed range from its start, and the rest stays free for the next.
    library.remove(d).expect("d removed");
    let e = library.add(grid(2, 0.0)).expect("e");
    assert_eq!(library.entry(e).expect("e").base_vertex, b_entry.base_vertex, "e fills the freed range");
}

#[test]
fn a_library_without_removals_packs_back_to_back_as_before() {
    let mut library = MeshLibrary::new();
    let mut expected = (library.vertices().len() as i32, library.indices().len() as u32);
    for i in 0..30u32 {
        let id = library.add(grid(1 + i % 7, 0.0)).expect("mesh");
        let entry = library.entry(id).expect("entry");
        assert_eq!((entry.base_vertex, entry.first_index), expected, "mesh {i} sits right after the last");
        assert_eq!((id.raw(), id.generation()), (i + 2, 0), "ids count up from 2 in generation 0");
        expected = (expected.0 + entry.vertex_count as i32, expected.1 + entry.index_count);
    }
}

#[test]
fn removal_refusals_leave_the_library_as_it_was() {
    let mut library = MeshLibrary::new();
    let chain = LodChain { levels: vec![LodLevel { indices: vec![0, 4, 1], error: 0.1 }] };
    let part = library.add_part(ModelPart { mesh: grid(2, 0.0), meshlets: None, lods: Some(chain) }).expect("part");
    let level = library.lods(part).expect("levels").levels[0];
    let mesh = grid(1, 0.0);
    let skin = vec![genex_render::layout::GpuSkinVertex { joints: [0; 4], weights: [1.0, 0.0, 0.0, 0.0] }; mesh.vertices.len()];
    let skeleton = Skeleton { nodes: vec![SkeletonNode { parent: None, rest: Trs::IDENTITY }], joints: vec![0], inverse_bind: vec![translation(0.0, 0.0, 0.0)], mesh_node: None };
    let skinned = library.add_skinned(&SkinnedMeshData { mesh, skin, skeleton, animations: Vec::new() }).expect("skinned");
    let live = library.live_meshes();
    for (id, why) in [
        (MeshId::CUBE, "the cube"),
        (MeshId::SPHERE, "the sphere"),
        (level, "a level"),
        (skinned.mesh(), "a skinned mesh"),
        (MeshId::from_raw(999), "an unknown id"),
    ] {
        let refusal = library.remove(id).expect_err(why);
        assert_eq!(refusal.code(), RenderCode::MeshInvalid, "{why}: {refusal}");
    }
    assert_eq!(library.live_meshes(), live, "nothing was removed");
    assert_eq!(library.remove(part).expect("the part"), vec![part, level], "the part takes its levels with it");
    let twice = library.remove(part).expect_err("removed twice");
    assert_eq!(twice.code(), RenderCode::MeshInvalid);
    assert!(library.entry(level).is_none() && library.lods(part).is_none());
}

#[test]
fn a_clustered_mesh_frees_its_meshlet_rows_for_the_next() {
    let meshlets = Meshlets::DEFAULT.with_min_triangles(genex_render::meshlet::MESHLET_MAX_TRIANGLES).with_occlusion(false);
    let mut library = MeshLibrary::with_meshlets(meshlets);
    let a = library.add(grid(8, 0.0)).expect("a");
    let b = library.add(grid(10, 0.0)).expect("b");
    let Some(MeshletState::Clustered(b_range)) = library.meshlet_state(b) else { panic!("b is clustered") };
    let tables = library.meshlets().meshlets.len();
    library.remove(b).expect("b removed");
    let c = library.add(grid(10, 1.0)).expect("c");
    let Some(MeshletState::Clustered(c_range)) = library.meshlet_state(c) else { panic!("c is clustered") };
    assert_eq!(c_range, b_range, "c's meshlets took b's rows");
    assert_eq!(library.meshlets().meshlets.len(), tables, "the table did not grow");
    let entry = library.entry(c).expect("c");
    let first = library.meshlets().meshlets[c_range.first_meshlet as usize];
    let ids = &library.meshlets().vertices[first.vertex_offset as usize..][..first.vertex_count as usize];
    let range = entry.base_vertex as u32..entry.base_vertex as u32 + entry.vertex_count;
    assert!(ids.iter().all(|id| range.contains(id)), "c's meshlets name c's vertices");
    assert!(matches!(library.meshlet_state(a), Some(MeshletState::Clustered(_))));
}

// --- The plan: a stale id is skipped and counted ----------------------------------------------

#[test]
fn a_draw_of_a_removed_id_is_skipped_and_counted_never_refused() {
    let mut library = MeshLibrary::new();
    let a = library.add(grid(4, 0.0)).expect("a");
    let b = library.add(grid(4, 0.0)).expect("b");
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 4.0], [0.0, 0.0, 0.0]), [0, 0, 0, 255]);
    scene.draw(a, translation(0.0, 0.0, 0.0), Material::color([200, 80, 80, 255]));
    scene.draw(b, translation(1.0, 0.0, 0.0), Material::color([80, 200, 80, 255]));
    scene.draw_instanced(b, &[translation(2.0, 0.0, 0.0), translation(3.0, 0.0, 0.0)], Material::color([80, 80, 200, 255]));
    let before = FramePlan::build(&scene, &library, 1.5).expect("plan");
    assert_eq!((before.stale_rows, before.instances.len()), (0, 4));
    library.remove(b).expect("b removed");
    let reused = library.add(grid(4, 0.0)).expect("a mesh in b's slot");
    assert_eq!(reused.raw(), b.raw());
    let plan = FramePlan::build(&scene, &library, 1.5).expect("a stale draw does not refuse the frame");
    assert_eq!(plan.stale_rows, 3, "b's three rows were skipped and counted");
    assert_eq!(plan.instances.len(), 1, "only a is drawn; b's slot's new mesh is not drawn for b");
    assert_eq!(plan.batches.len(), 1);
    // An id the library never handed out is still refused.
    scene.draw(MeshId::from_raw(77), translation(0.0, 0.0, 0.0), Material::color([255; 4]));
    let refused = FramePlan::build(&scene, &library, 1.5).expect_err("unknown mesh");
    assert_eq!(refused.code(), RenderCode::MeshInvalid);
}

// --- The arena: rewrites, growth, peak limit, churn -------------------------------------------

#[test]
fn a_filled_range_is_written_again_and_only_it() {
    let mut library = MeshLibrary::new();
    let mut device = Counting::default();
    let ids: Vec<MeshId> = (0..6).map(|i| library.add(grid(3 + i, 0.0)).expect("mesh")).collect();
    let mut arena = MeshArena::new(&mut device, &ArenaSources::of(&library, true)).expect("arena");
    library.take_rewrites();
    library.remove(ids[2]).expect("removed");
    sync(&mut arena, &mut device, &mut library).expect("a removal syncs nothing");
    let before = device.written();
    let filler = grid(5, 7.0);
    let own = (filler.vertices.len() * (size_of::<Vertex>() + 4) + filler.indices.len() * 4) as u64;
    library.add(filler).expect("a mesh in the freed range");
    sync(&mut arena, &mut device, &mut library).expect("sync");
    assert_eq!(device.written() - before, own, "the filled rows went up, nothing else");
    assert_mirrored(&arena, &device, &library);
}

#[test]
fn a_growth_holds_old_and_new_buffers_and_refuses_past_its_peak_limit() {
    let mut device = Counting::default();
    let mut library = MeshLibrary::new();
    let mut arena = MeshArena::new(&mut device, &ArenaSources::of(&library, true)).expect("arena");
    let start = arena.bytes();
    library.add(grid(8, 0.0)).expect("mesh");
    sync(&mut arena, &mut device, &mut library).expect("growth");
    let grown = arena.bytes();
    assert!(grown > start);
    let made_by_growth: u64 = device.made.iter().skip(ArenaStream::ALL.len()).map(|(_, bytes)| bytes).sum();
    assert_eq!(arena.stats().peak_bytes, start + made_by_growth, "the peak counts the old and the new buffers at once");
    // A limit the next growth's peak passes refuses it with nothing made or written.
    arena.set_peak_limit(Some(arena.bytes() + 1024));
    library.add(grid(40, 0.0)).expect("a large mesh");
    let (made, written, stats) = (device.made.len(), device.written(), arena.stats());
    let refusal = sync(&mut arena, &mut device, &mut library).expect_err("past the peak limit");
    assert_eq!(refusal.code(), RenderCode::StreamArenaFull, "{refusal}");
    assert_eq!(refusal.code().wire(), "stream-arena-full");
    assert_eq!((device.made.len(), device.written(), arena.stats()), (made, written, stats), "nothing made, written or counted");
    arena.set_peak_limit(None);
    // The rows the refused sync left are taken whole by the next one (a removal or the limit lifted).
    sync(&mut arena, &mut device, &mut library).expect("without the limit");
    assert_mirrored(&arena, &device, &library);
}

#[test]
fn churn_of_500_adds_and_450_removes_keeps_the_arena_rows_within_1_5x_of_the_live_bytes() {
    let mut device = Counting::default();
    let mut library = MeshLibrary::new();
    let mut arena = MeshArena::new(&mut device, &ArenaSources::of(&library, true)).expect("arena");
    let mut live: std::collections::VecDeque<MeshId> = std::collections::VecDeque::new();
    let mut removed = 0;
    let mut seed = 0x9e37_79b9u32;
    for _ in 0..CHURN_ADDS {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        live.push_back(library.add(grid(2 + (seed >> 24) % 14, 0.0)).expect("mesh"));
        if live.len() > CHURN_ADDS - CHURN_REMOVES {
            library.remove(live.pop_front().expect("oldest")).expect("removed");
            removed += 1;
        }
        sync(&mut arena, &mut device, &mut library).expect("sync");
    }
    assert_eq!((removed, live.len()), (CHURN_REMOVES, CHURN_ADDS - CHURN_REMOVES));
    assert_mirrored(&arena, &device, &library);
    let (live_bytes, span, held, peak) = (library.live_bytes(), library.span_bytes(), arena.bytes(), arena.stats().peak_bytes);
    eprintln!("churn: live {live_bytes} B, span {span} B ({:.3}x), arena {held} B ({:.3}x), peak {peak} B", span as f64 / live_bytes as f64, held as f64 / live_bytes as f64);
    assert!(span as f64 <= live_bytes as f64 * CHURN_SLACK, "the rows span {span} bytes for {live_bytes} live");
    assert!(held as f64 <= span as f64 * GROWTH_SLACK, "the buffers hold {held} bytes for rows of {span}");
}

#[test]
fn the_row_allocator_takes_the_best_fit_merges_neighbours_and_gives_back_the_end() {
    let mut rows = RowAllocator::default();
    let a = rows.allocate(10).expect("a");
    let b = rows.allocate(20).expect("b");
    let c = rows.allocate(5).expect("c");
    let d = rows.allocate(30).expect("d");
    assert_eq!((a, b, c, d, rows.end()), (0, 10, 30, 35, 65), "back to back while nothing is freed");
    rows.free(b, 20);
    rows.free(d, 30);
    assert_eq!(rows.end(), 35, "a freed range at the end gives the end back");
    rows.free(a, 10);
    assert_eq!(rows.free_rows(), 30, "a and b merged");
    assert_eq!(rows.allocate(30), Some(0), "an exact fit takes the merged range");
    assert_eq!(rows.allocate(1), Some(35), "nothing free below the end: the end");
    rows.free(c, 5);
    assert_eq!(rows.allocate(4), Some(30), "the smallest range that fits");
    assert_eq!(rows.allocate(0), Some(rows.end()), "no rows take nothing");
    let replay = |ops: &[(bool, u32)]| {
        let mut rows = RowAllocator::default();
        let mut held = Vec::new();
        for (add, n) in ops {
            if *add {
                held.push((rows.allocate(*n).expect("rows"), *n));
            } else if let Some((offset, n)) = held.get((*n as usize) % held.len().max(1)).copied() {
                rows.free(offset, n);
                held.retain(|h| h.0 != offset);
            }
        }
        rows
    };
    let ops: Vec<(bool, u32)> = (0..400u32).map(|i| (i % 3 != 2, (i * 37) % 23 + 1)).collect();
    assert_eq!(replay(&ops), replay(&ops), "the same operations place the same rows");
}

// --- The renderer: pictures, growth between frames, device loss -------------------------------

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

/// Raw BGRA evidence (WIDTH x HEIGHT) for the run log, when the caller names a folder.
fn write_evidence(name: &str, bytes: &[u8]) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = std::path::PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(name), bytes).expect("evidence");
    }
}

/// `ids` in a row of cells, each its own colour.
fn row_scene(ids: &[MeshId]) -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 6.0, 7.0], [0.0, 0.0, 0.0]), [18, 20, 28, 255]);
    scene.lighting.shadows = false;
    for (i, id) in ids.iter().enumerate() {
        let (x, z) = ((i % 6) as f32 * 1.2 - 3.0, (i / 6) as f32 * 1.2 - 1.5);
        scene.draw(*id, translation(x, 0.0, z), Material::color([(60 + i * 37 % 190) as u8, 120, (200 - i * 13 % 150) as u8, 255]));
    }
    scene
}

fn picture(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene) -> Vec<u8> {
    renderer.render(gpu, scene, CullPath::Cpu).expect("frame");
    renderer.capture(gpu).expect("capture").bgra().to_vec()
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_a_mesh_in_a_freed_range_draws_as_in_a_fresh_renderer_and_the_stale_id_draws_nothing() {
    let Some(gpu) = gpu() else { return };
    let meshes: Vec<MeshData> = (0..8).map(|i| grid(2 + i % 5, (i % 3) as f32 * 0.2)).collect();
    let mut churned = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut ids: Vec<MeshId> = meshes.iter().map(|mesh| churned.add_mesh(&gpu, mesh.clone()).expect("mesh")).collect();
    let stale = ids[3];
    churned.remove_mesh(stale).expect("removed");
    let filler = grid(4, 0.5);
    ids[3] = churned.add_mesh(&gpu, filler.clone()).expect("filler");
    assert_eq!(ids[3].raw(), stale.raw(), "the filler took the freed slot");
    let mut fresh = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut same: Vec<MeshId> = meshes.iter().map(|mesh| fresh.add_mesh(&gpu, mesh.clone()).expect("mesh")).collect();
    same[3] = fresh.add_mesh(&gpu, filler).expect("filler");
    let (a, b) = (picture(&gpu, &mut churned, &row_scene(&ids)), picture(&gpu, &mut fresh, &row_scene(&same)));
    write_evidence("churned.bgra", &a);
    write_evidence("fresh.bgra", &b);
    let differing = a.iter().zip(&b).filter(|(x, y)| x != y).count();
    assert_eq!(differing, 0, "{differing} bytes differ between the churned and the fresh renderer");
    // The stale id draws nothing, is counted, and the frame is not refused.
    let mut with_stale = ids.clone();
    with_stale[3] = stale;
    let c = picture(&gpu, &mut churned, &row_scene(&with_stale));
    write_evidence("stale.bgra", &c);
    assert_eq!(churned.last_stats().stale_rows, 1, "the stale draw was counted");
    let mut without = row_scene(&ids);
    without.draws.remove(3);
    let d = picture(&gpu, &mut churned, &without);
    assert_eq!(c, d, "a stale draw draws nothing, never the slot's new mesh");
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_the_arena_grows_between_frames_never_inside_one() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut ids = vec![MeshId::CUBE];
    for i in 0..24u32 {
        ids.push(renderer.add_mesh(&gpu, grid(3 + i % 9, 0.0)).expect("mesh"));
        if i % 4 == 3 {
            renderer.remove_mesh(ids.remove(1)).expect("removed");
        }
        renderer.render(&gpu, &row_scene(&ids[ids.len().saturating_sub(12)..]), CullPath::Gpu).expect("frame");
        assert_eq!(renderer.last_stats().arena_grows, 0, "frame {i}: no growth while it was planned and drawn");
    }
    assert!(renderer.mesh_arena_stats().grows > 0, "the arena grew between frames");
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_a_forced_device_loss_replays_the_same_live_ids_and_the_same_picture() {
    let Some(gpu) = gpu() else { return };
    let mut resilient = Resilient::new(gpu, WIDTH, HEIGHT, RenderOptions::default(), Gpu::headless).expect("resilient");
    let a = resilient.add_mesh(grid(4, 0.0)).expect("a");
    let parts = vec![grid(5, 0.0), grid(3, 0.3)];
    let model_bytes: usize = parts.iter().map(|part| size_of_val(part.vertices.as_slice()) + size_of_val(part.indices.as_slice())).sum();
    let model = resilient.add_meshes(parts).expect("a model of two parts");
    let c = resilient.add_mesh(grid(6, 0.0)).expect("c");
    let kept = resilient.kept_bytes();
    let removal = size_of::<MeshId>() as u64;
    resilient.remove_mesh(model[0]).expect("one part");
    assert_eq!(resilient.kept_bytes(), kept + removal, "a model with a live part keeps its data (and the removal its id)");
    resilient.remove_mesh(model[1]).expect("the other part");
    assert_eq!(resilient.kept_bytes(), kept - model_bytes as u64 + 2 * removal, "a model whose meshes are all removed keeps nothing");
    let d = resilient.add_mesh(grid(5, 0.6)).expect("d, in a freed slot");
    let e = resilient.add_mesh(grid(2, 0.0)).expect("e");
    assert_eq!((d.raw(), e.raw()), (model[0].raw(), model[1].raw()), "d and e reused the model's slots");
    assert_eq!(e.generation(), model[1].generation() + 1);
    let draws = [a, c, d, e, model[1]];
    let frame_of = |ids: &[MeshId]| {
        let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 5.0, 6.0], [0.0, 0.0, 0.0]), [20, 24, 32, 255]);
        for (i, id) in ids.iter().enumerate() {
            frame.mesh(*id, translation(i as f32 * 1.3 - 2.6, 0.0, 0.0), Material::color([(70 + i * 40) as u8, 140, 200, 255]));
        }
        frame
    };
    // The same meshes behind the same ids; a replay packs them anew, so their rows may sit elsewhere.
    let entries = |resilient: &Resilient| draws.map(|id| resilient.renderer().renderer().library().entry(id).map(|e| (e.vertex_count, e.index_count, e.center, e.radius)));
    let before_entries = entries(&resilient);
    resilient.render(&frame_of(&draws), CullPath::Gpu, None).expect("frame");
    let before = resilient.capture().expect("capture");
    write_evidence("before-loss.bgra", before.bgra());
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovered"));
    assert_eq!(entries(&resilient), before_entries, "every live id names the same mesh, and the removed one none");
    assert!(resilient.renderer().renderer().library().is_removed(model[1]), "the removed id is still stale");
    resilient.render(&frame_of(&draws), CullPath::Gpu, None).expect("frame after recovery");
    let after = resilient.capture().expect("capture");
    write_evidence("after-loss.bgra", after.bgra());
    assert_eq!(after.digest(), before.digest(), "the replay draws the identical picture");
    assert_eq!(resilient.renderer().renderer().last_stats().stale_rows, 1, "the stale draw of the removed part was skipped and counted");
    let kept_now = resilient.kept_bytes();
    let f = resilient.add_mesh(grid(3, 0.0)).expect("f after recovery");
    assert_eq!((f.raw(), f.generation()), (6, 0), "no slot is free: the next one after a, the model's two and c, then d and e reused theirs");
    assert!(resilient.kept_bytes() > kept_now);
}
