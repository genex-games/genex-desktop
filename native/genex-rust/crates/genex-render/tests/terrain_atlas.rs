//! The terrain tile atlas (game systems STR-21, `genex_render::terrain::atlas`, a bevy_terrain
//! port): slots in one storage table, a request count per tile, released tiles kept oldest-first
//! and revived on a re-request, the nearest loaded ancestor answering for a tile still loading,
//! and a typed `stream-arena-full` where upstream panics. Pure rows run everywhere; the GPU
//! upload rows (`#[ignore]`d, every name contains `metal`) write tiles into the table and read it
//! back:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test terrain_atlas -- --include-ignored

use genex_render::device_class::FormFactor;
use genex_render::terrain::atlas::{
    DESKTOP_ATLAS_SLOTS, MAX_TILE_LEVEL, MOBILE_ATLAS_MAX_BYTES, MOBILE_ATLAS_SLOTS, TileAtlas, TileAtlasGpu, TileCoord, TileRequest, TileState, atlas_byte_cap, atlas_slot_cap, atlas_slots,
    tile_slot_words, tile_words,
};
use genex_render::terrain::gpu::maps;
use genex_render::terrain::{Heightfield, TerrainDesc, TerrainLayer};
use genex_render::{BUFFER_MAX_BYTES, Gpu, RenderCode};

/// The tile coordinate `(x, z)` at `level` (0 the finest).
fn tile(x: u32, z: u32, level: u32) -> TileCoord {
    TileCoord::new(level, x, z)
}

/// Requests `coord` and expects a fresh load into some slot; returns the slot.
fn load(atlas: &mut TileAtlas, coord: TileCoord) -> u32 {
    match atlas.request(coord).expect("a free slot") {
        TileRequest::Load { slot, .. } => slot,
        other => panic!("{coord:?} should load, got {other:?}"),
    }
}

/// Requests `coord`, then marks its load finished.
fn load_and_finish(atlas: &mut TileAtlas, coord: TileCoord) -> u32 {
    let slot = load(atlas, coord);
    assert_eq!(atlas.finish(coord), Some(slot), "the load of {coord:?} finishes into its slot");
    slot
}

// --- Coordinates ----------------------------------------------------------------------------------

#[test]
fn a_tiles_parent_is_one_level_up_at_half_the_coordinates_and_the_top_has_none() {
    assert_eq!(tile(3, 4, 0).parent(), Some(tile(1, 2, 1)));
    assert_eq!(tile(1, 2, 1).parent(), Some(tile(0, 1, 2)));
    assert_eq!(tile(u32::MAX, u32::MAX, 0).parent(), Some(tile(u32::MAX / 2, u32::MAX / 2, 1)));
    assert_eq!(tile(0, 0, MAX_TILE_LEVEL).parent(), None, "the top level has no parent");
}

// --- Red: the nearest loaded ancestor -------------------------------------------------------------

#[test]
fn a_tile_still_loading_answers_its_nearest_loaded_ancestor() {
    let mut atlas = TileAtlas::new(8).expect("atlas");
    let grandparent = tile(0, 1, 2);
    let grandparent_slot = load_and_finish(&mut atlas, grandparent);
    let parent = tile(1, 2, 1);
    load(&mut atlas, parent);
    let wanted = tile(3, 4, 0);
    load(&mut atlas, wanted);

    assert_eq!(atlas.state(wanted), Some(TileState::Loading));
    assert_eq!(atlas.state(parent), Some(TileState::Loading));
    assert_eq!(atlas.best_tile(wanted), Some((grandparent, grandparent_slot)), "(3,4) level 0 answers its level-2 ancestor");

    let parent_slot = atlas.finish(parent).expect("parent loaded");
    assert_eq!(atlas.best_tile(wanted), Some((parent, parent_slot)), "then its level-1 parent once that loads");
    let slot = atlas.finish(wanted).expect("tile loaded");
    assert_eq!(atlas.best_tile(wanted), Some((wanted, slot)), "then itself");
}

#[test]
fn nothing_loaded_on_the_way_up_answers_none() {
    let mut atlas = TileAtlas::new(4).expect("atlas");
    load(&mut atlas, tile(3, 4, 0));
    assert_eq!(atlas.best_tile(tile(3, 4, 0)), None);
    assert_eq!(atlas.best_tile(tile(9, 9, MAX_TILE_LEVEL)), None, "the walk stops at the top level");
}

// --- Red: release and revive ----------------------------------------------------------------------

#[test]
fn releasing_and_re_requesting_revives_the_tile_without_a_load() {
    let mut atlas = TileAtlas::new(4).expect("atlas");
    let coord = tile(5, 6, 0);
    let slot = load_and_finish(&mut atlas, coord);
    assert!(atlas.release(coord), "released");
    assert_eq!(atlas.requests(coord), 0);
    assert_eq!(atlas.state(coord), Some(TileState::Loaded), "a released tile stays resident until its slot is needed");
    assert_eq!(atlas.best_tile(coord), Some((coord, slot)), "and still answers");

    assert_eq!(atlas.request(coord), Ok(TileRequest::Revived { slot, loading: false }), "re-requested: revived, no load");
    assert_eq!(atlas.requests(coord), 1);
    assert_eq!(atlas.finish(coord), None, "nothing is loading, so no completion is taken");
}

#[test]
fn a_second_request_holds_the_tile_and_one_release_keeps_it_requested() {
    let mut atlas = TileAtlas::new(4).expect("atlas");
    let coord = tile(1, 1, 0);
    let slot = load_and_finish(&mut atlas, coord);
    assert_eq!(atlas.request(coord), Ok(TileRequest::Held { slot, loading: false }));
    assert_eq!(atlas.requests(coord), 2);
    assert!(atlas.release(coord));
    assert_eq!(atlas.requests(coord), 1, "one requester remains");
    assert_eq!(atlas.free_slots(), 3, "a requested tile's slot is never reused");
}

#[test]
fn a_tile_released_while_loading_is_revived_still_loading_and_its_load_completes() {
    let mut atlas = TileAtlas::new(4).expect("atlas");
    let coord = tile(2, 2, 0);
    let slot = load(&mut atlas, coord);
    assert!(atlas.release(coord));
    assert_eq!(atlas.request(coord), Ok(TileRequest::Revived { slot, loading: true }), "the caller re-issues a load it cancelled");
    assert_eq!(atlas.finish(coord), Some(slot));
}

#[test]
fn releasing_a_tile_nobody_requested_changes_nothing() {
    let mut atlas = TileAtlas::new(2).expect("atlas");
    assert!(!atlas.release(tile(0, 0, 0)), "unknown tile");
    let coord = tile(1, 0, 0);
    load_and_finish(&mut atlas, coord);
    assert!(atlas.release(coord));
    assert!(!atlas.release(coord), "already released: the count never wraps");
    assert_eq!(atlas.requests(coord), 0);
    assert_eq!(atlas.free_slots(), 2);
}

// --- Red: slot exhaustion -------------------------------------------------------------------------

#[test]
fn slot_exhaustion_refuses_stream_arena_full_and_changes_nothing() {
    let mut atlas = TileAtlas::new(3).expect("atlas");
    let held: Vec<TileCoord> = (0..3).map(|x| tile(x, 0, 0)).collect();
    let slots: Vec<u32> = held.iter().map(|&coord| load_and_finish(&mut atlas, coord)).collect();
    assert_eq!(slots, vec![0, 1, 2], "fresh slots go out in order");

    let refusal = atlas.request(tile(9, 9, 0)).expect_err("every slot is requested");
    assert_eq!(refusal.code(), RenderCode::StreamArenaFull, "{refusal}");
    assert_eq!(refusal.code().wire(), "stream-arena-full");
    assert_eq!(atlas.state(tile(9, 9, 0)), None, "the refused tile is not recorded");
    assert_eq!(atlas.free_slots(), 0);
    for (coord, slot) in held.iter().zip(&slots) {
        assert_eq!(atlas.best_tile(*coord), Some((*coord, *slot)), "held tiles keep their slots");
        assert_eq!(atlas.requests(*coord), 1);
    }
}

#[test]
fn loading_tiles_hold_their_slots_too() {
    let mut atlas = TileAtlas::new(2).expect("atlas");
    load(&mut atlas, tile(0, 0, 0));
    load(&mut atlas, tile(1, 0, 0));
    assert_eq!(atlas.request(tile(2, 0, 0)).map_err(|e| e.code()), Err(RenderCode::StreamArenaFull));
}

#[test]
fn a_full_atlas_evicts_the_tile_released_first() {
    let mut atlas = TileAtlas::new(3).expect("atlas");
    let (a, b, c) = (tile(0, 0, 0), tile(1, 0, 0), tile(2, 0, 0));
    let slot_a = load_and_finish(&mut atlas, a);
    let slot_b = load_and_finish(&mut atlas, b);
    load_and_finish(&mut atlas, c);
    assert!(atlas.release(b));
    assert!(atlas.release(a));

    let d = tile(3, 0, 0);
    assert_eq!(atlas.request(d), Ok(TileRequest::Load { slot: slot_b, evicted: Some(b) }), "b was released first");
    assert_eq!(atlas.state(b), None, "the evicted tile is gone");
    assert_eq!(atlas.best_tile(b), None);
    assert_eq!(atlas.state(a), Some(TileState::Loaded), "a stays until its turn");

    let e = tile(4, 0, 0);
    assert_eq!(atlas.request(e), Ok(TileRequest::Load { slot: slot_a, evicted: Some(a) }));
}

#[test]
fn a_revived_tile_leaves_the_unused_queue() {
    let mut atlas = TileAtlas::new(2).expect("atlas");
    let (a, b) = (tile(0, 0, 0), tile(1, 0, 0));
    load_and_finish(&mut atlas, a);
    let slot_b = load_and_finish(&mut atlas, b);
    assert!(atlas.release(a));
    assert!(atlas.release(b));
    assert!(matches!(atlas.request(a), Ok(TileRequest::Revived { .. })));
    assert_eq!(atlas.request(tile(5, 5, 0)), Ok(TileRequest::Load { slot: slot_b, evicted: Some(b) }), "a was revived, so b goes");
    assert_eq!(atlas.request(tile(6, 6, 0)).map_err(|e| e.code()), Err(RenderCode::StreamArenaFull), "a is held again");
}

#[test]
fn a_completion_for_an_evicted_load_is_dropped() {
    let mut atlas = TileAtlas::new(1).expect("atlas");
    let stale = tile(0, 0, 0);
    load(&mut atlas, stale);
    assert!(atlas.release(stale));
    let fresh = tile(1, 0, 0);
    assert_eq!(atlas.request(fresh), Ok(TileRequest::Load { slot: 0, evicted: Some(stale) }));
    assert_eq!(atlas.finish(stale), None, "the evicted tile's late load writes nothing");
    assert_eq!(atlas.state(fresh), Some(TileState::Loading), "and leaves the new owner loading");
    assert_eq!(atlas.finish(fresh), Some(0));
    assert_eq!(atlas.finish(fresh), None, "a second completion is dropped");
    assert_eq!(atlas.finish(tile(7, 7, 3)), None, "so is one for a tile never requested");
}

#[test]
fn an_atlas_of_no_slots_is_refused() {
    assert_eq!(TileAtlas::new(0).map(|_| ()).map_err(|e| e.code()), Err(RenderCode::StreamArenaFull));
}

#[test]
fn the_same_requests_give_the_same_slots_and_evictions() {
    let run = || {
        let mut atlas = TileAtlas::new(5).expect("atlas");
        let mut log = Vec::new();
        for step in 0u32..200 {
            let coord = tile(step.wrapping_mul(7) % 11, step.wrapping_mul(3) % 5, step % 3);
            if step % 4 == 3 {
                log.push(format!("release {coord:?} {}", atlas.release(coord)));
                continue;
            }
            log.push(format!("{coord:?} {:?}", atlas.request(coord).map_err(|e| e.code())));
            log.push(format!("finish {:?}", atlas.finish(coord)));
        }
        log
    };
    assert_eq!(run(), run());
}

// --- Slots per class and the 128 MiB binding ------------------------------------------------------

/// A square tile of `samples` with one flat layer.
fn tile_desc(samples: u32) -> TerrainDesc {
    let heights = Heightfield::from_fn((samples, samples), [0.0, 0.0], 1.0, |x, z| 0.25 * x + 0.5 * z).expect("heights");
    TerrainDesc::new(heights, TerrainLayer::flat([0.4, 0.5, 0.3]))
}

#[test]
fn a_slot_holds_one_tiles_heights_control_words_and_normal_pyramid() {
    for samples in [65, 129, 257] {
        let desc = tile_desc(samples);
        let words = tile_words(&desc, samples).expect("words");
        assert_eq!(words, maps(&desc), "the single-terrain layout, so the shader reads a slot like the whole terrain");
        assert_eq!(words.len() as u64, tile_slot_words(samples).expect("slot words"));
    }
}

#[test]
fn tile_words_refuse_a_tile_of_another_size_or_shape() {
    let desc = tile_desc(65);
    assert_eq!(tile_words(&desc, 129).map_err(|e| e.code()), Err(RenderCode::MeshInvalid));
    let heights = Heightfield::from_fn((65, 33), [0.0, 0.0], 1.0, |_, _| 0.0).expect("heights");
    let oblong = TerrainDesc::new(heights, TerrainLayer::flat([1.0; 3]));
    assert_eq!(tile_words(&oblong, 65).map_err(|e| e.code()), Err(RenderCode::MeshInvalid), "tiles are square");
    assert_eq!(tile_slot_words(1).map_err(|e| e.code()), Err(RenderCode::MeshInvalid));
    assert_eq!(tile_slot_words(5000).map_err(|e| e.code()), Err(RenderCode::MeshInvalid));
}

#[test]
fn phones_get_fewer_slots_and_no_class_passes_the_binding() {
    assert!(atlas_slot_cap(FormFactor::Mobile) < atlas_slot_cap(FormFactor::Desktop));
    assert_eq!(atlas_byte_cap(FormFactor::Desktop), BUFFER_MAX_BYTES, "a desktop table fills the 128 MiB binding at most");
    assert_eq!(atlas_byte_cap(FormFactor::Mobile), MOBILE_ATLAS_MAX_BYTES);
    assert_eq!(atlas_slot_cap(FormFactor::Desktop), DESKTOP_ATLAS_SLOTS);
    assert_eq!(atlas_slot_cap(FormFactor::Mobile), MOBILE_ATLAS_SLOTS);
    for form in FormFactor::ALL {
        for samples in [65, 129, 257, 513, 1025, 2049] {
            let slots = atlas_slots(form, samples).expect("slots");
            let bytes = u64::from(slots) * tile_slot_words(samples).expect("words") * 4;
            assert!(slots >= 1, "{form:?} {samples}: at least one slot");
            assert!(slots <= atlas_slot_cap(form), "{form:?} {samples}: {slots} slots past the class cap");
            assert!(bytes <= atlas_byte_cap(form), "{form:?} {samples}: {bytes} bytes past the class's table cap");
        }
        eprintln!("{form:?}: {:?}", [65, 129, 257, 513].map(|s| atlas_slots(form, s).expect("slots")));
    }
    assert!(atlas_slots(FormFactor::Mobile, 129).expect("slots") < atlas_slots(FormFactor::Desktop, 129).expect("slots"));
    assert!(atlas_slots(FormFactor::Desktop, 513).expect("slots") < DESKTOP_ATLAS_SLOTS, "513-sample tiles are bound by the binding");
    assert!(atlas_slots(FormFactor::Mobile, 513).expect("slots") < atlas_slots(FormFactor::Desktop, 513).expect("slots"), "and by the phone cap below it");
}

// --- GPU upload rows ------------------------------------------------------------------------------

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

/// The table's words, read back from the GPU.
fn read_table(gpu: &Gpu, buffer: &wgpu::Buffer) -> Vec<u32> {
    let bytes = buffer.size();
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("atlas readback"),
        size: bytes,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("atlas readback") });
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    bytemuck::cast_slice(&data).to_vec()
}

/// A tile of 65 samples whose heights depend on `seed`, as slot words.
fn seeded_words(seed: f32) -> Vec<u32> {
    let heights = Heightfield::from_fn((65, 65), [0.0, 0.0], 1.0, |x, z| seed * 3.0 + libm::sinf(x * 0.1 * seed) * libm::cosf(z * 0.07)).expect("heights");
    tile_words(&TerrainDesc::new(heights, TerrainLayer::flat([0.5; 3])), 65).expect("words")
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_uploads_land_in_their_slots_and_a_stale_one_writes_nothing() {
    let Some(gpu) = gpu() else { return };
    let mut atlas = TileAtlasGpu::new(&gpu.device, FormFactor::Mobile, 65).expect("atlas");
    let slot_words = atlas.slot_words() as usize;
    assert_eq!(atlas.resident_bytes(), u64::from(atlas.atlas().slots()) * slot_words as u64 * 4);
    let (a, b) = (tile(0, 0, 0), tile(1, 0, 0));
    let (words_a, words_b) = (seeded_words(1.0), seeded_words(2.0));
    assert_ne!(words_a, words_b);

    let slot_a = load(atlas.atlas_mut(), a) as usize;
    let slot_b = load(atlas.atlas_mut(), b) as usize;
    assert_eq!(atlas.upload(&gpu.queue, b, &words_b), Ok(Some(slot_b as u32)));
    assert_eq!(atlas.upload(&gpu.queue, a, &words_a), Ok(Some(slot_a as u32)));
    assert_eq!(atlas.atlas().state(a), Some(TileState::Loaded));
    let table = read_table(&gpu, atlas.buffer());
    assert_eq!(&table[slot_a * slot_words..(slot_a + 1) * slot_words], words_a.as_slice(), "slot a holds a's words");
    assert_eq!(&table[slot_b * slot_words..(slot_b + 1) * slot_words], words_b.as_slice(), "slot b holds b's words");
    assert_eq!(atlas.slot_offset_words(slot_b as u32), (slot_b * slot_words) as u64);

    let wrong = atlas.upload(&gpu.queue, a, &words_a[1..]).expect_err("a short tile");
    assert_eq!(wrong.code(), RenderCode::MeshInvalid, "{wrong}");
    assert_eq!(atlas.upload(&gpu.queue, a, &words_b), Ok(None), "a's load already finished: dropped");
    assert!(atlas.atlas_mut().release(b));
    let fresh = atlas.atlas().free_slots() - 1;
    for i in 0..fresh {
        load(atlas.atlas_mut(), tile(100 + i, 0, 0));
    }
    let taker = tile(99, 0, 0);
    assert_eq!(atlas.atlas_mut().request(taker), Ok(TileRequest::Load { slot: slot_b as u32, evicted: Some(b) }), "b's slot goes once the fresh ones run out");
    assert_eq!(atlas.upload(&gpu.queue, b, &words_a), Ok(None), "b's late upload is dropped");
    let after = read_table(&gpu, atlas.buffer());
    assert_eq!(after, table, "neither the finished nor the evicted tile's late upload changed the table");
}

#[test]
#[ignore = "needs a GPU: run with --include-ignored"]
fn metal_the_desktop_table_of_513_sample_tiles_fits_the_binding() {
    let Some(gpu) = gpu() else { return };
    let atlas = TileAtlasGpu::new(&gpu.device, FormFactor::Desktop, 513).expect("atlas");
    eprintln!("desktop 513: {} slots, {} bytes", atlas.atlas().slots(), atlas.resident_bytes());
    assert!(atlas.resident_bytes() <= BUFFER_MAX_BYTES);
    assert_eq!(atlas.buffer().size(), atlas.resident_bytes());
}
