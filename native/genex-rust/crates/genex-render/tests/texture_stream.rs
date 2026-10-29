//! Texture mip streaming (STR-17), the residency policy: an approaching quad promotes its texture
//! 64 -> 256 -> 1024 with at most one rung change per 8 frames; a pool cut drops the farthest
//! textures first; a texture shows its old rung until the new layer landed (no black frame); the
//! ledger is exact; a promotion's head range, assembled with the resident tail, is bit-equal to
//! the whole file's chain at that rung.
//!
//! New behaviour (section 0 of the game systems plan): nothing streamed textures before.

use genex_render::texture::{KTX2_PREFIX_BYTES, Ktx2Index, TextureFamily, read_ktx2};
use genex_render::texture_stream::{
    DEMOTE_FRACTION, RUNG_CHANGE_FRAMES_MIN, STREAMED_TEXTURES_MAX, StreamedId, TAIL_SIDE, TextureStream, head_range, rungs, wanted_rung,
};

const FAMILY: TextureFamily = TextureFamily::Bc7;
/// A pool that never binds.
const POOL_ANY: u64 = 1 << 40;

/// One frame: `id` seen at `pixels_per_metre`, the plan, and every load landing at once (the
/// upload finishes before the next frame). Answers the rung shown after the frame.
fn frame(stream: &mut TextureStream, id: StreamedId, pixels_per_metre: f32) -> u32 {
    stream.see(id, pixels_per_metre);
    let plan = stream.plan();
    for load in plan.loads {
        stream.landed(load.id, load.to);
    }
    stream.shown(id).expect("tracked")
}

#[test]
fn the_rungs_are_the_tail_then_the_size_classes_up_to_the_texture() {
    assert_eq!(rungs(2048), [TAIL_SIDE, 256, 512, 1024, 2048]);
    assert_eq!(rungs(8192), [TAIL_SIDE, 256, 512, 1024, 2048, 4096, 8192], "a native 8K map streams to its own side (WP-9)");
    assert_eq!(rungs(1024), [64, 256, 512, 1024]);
    assert_eq!(rungs(32), [32]);
    assert_eq!(wanted_rung(1024, 0.0), 64);
    assert_eq!(wanted_rung(1024, 200.0), 256);
    assert_eq!(wanted_rung(1024, 300.0), 512);
    assert_eq!(wanted_rung(1024, 5000.0), 1024);
}

#[test]
fn an_approaching_quad_promotes_64_256_1024_with_at_most_one_change_per_8_frames() {
    let mut stream = TextureStream::new(POOL_ANY);
    let id = stream.add(1024, FAMILY, Some(1.0)).expect("added");
    // Far: the tail. Then near enough for 256, then (two frames later, too soon to move again)
    // close enough for 1024.
    let mut sights = vec![10.0_f32; 4];
    sights.extend([200.0; 2]);
    sights.extend([900.0; 20]);
    let mut changes = vec![(0_usize, stream.shown(id).expect("tracked"))];
    for (at, sight) in sights.into_iter().enumerate() {
        let shown = frame(&mut stream, id, sight);
        if shown != changes.last().expect("a rung").1 {
            changes.push((at + 1, shown));
        }
    }
    let rungs: Vec<u32> = changes.iter().map(|(_, rung)| *rung).collect();
    assert_eq!(rungs, [64, 256, 1024], "{changes:?}");
    for pair in changes.windows(2).skip(1) {
        assert!((pair[1].0 - pair[0].0) as u64 >= RUNG_CHANGE_FRAMES_MIN, "changes at frames {changes:?}");
    }
}

#[test]
fn a_texture_on_a_rungs_edge_does_not_flicker() {
    let mut stream = TextureStream::new(POOL_ANY);
    let id = stream.add(1024, FAMILY, Some(1.0)).expect("added");
    assert_eq!(frame(&mut stream, id, 300.0), 512);
    // Wobbling across the 256 rung's edge: it needs the 256 rung on every other frame, yet never
    // as little as DEMOTE_FRACTION of it, so it keeps 512.
    let wobble = [250.0, 262.0];
    assert!(wobble.iter().all(|sight| *sight > 256.0 * DEMOTE_FRACTION));
    for at in 0..40 {
        assert_eq!(frame(&mut stream, id, wobble[at % 2]), 512, "frame {at}: a texture at a rung's edge keeps its rung");
    }
}

#[test]
fn the_old_rung_shows_until_the_new_layer_landed() {
    let mut stream = TextureStream::new(POOL_ANY);
    let id = stream.add(1024, FAMILY, None).expect("added");
    stream.see(id, 2000.0);
    let plan = stream.plan();
    assert_eq!(plan.loads.len(), 1);
    assert_eq!((plan.loads[0].from, plan.loads[0].to), (64, 1024));
    for _ in 0..5 {
        stream.see(id, 2000.0);
        assert!(stream.plan().loads.is_empty(), "one load at a time");
        assert_eq!(stream.shown(id), Some(64), "the tail shows while the 1024 layer loads: never a black frame");
    }
    stream.landed(id, 512);
    assert_eq!(stream.shown(id), Some(64), "a stale report changes nothing");
    stream.landed(id, 1024);
    assert_eq!(stream.shown(id), Some(1024));
}

#[test]
fn the_ledger_is_the_shown_chains_plus_the_loads_in_flight() {
    let mut stream = TextureStream::new(POOL_ANY);
    let a = stream.add(1024, FAMILY, None).expect("added");
    let b = stream.add(2048, TextureFamily::Rgba8, None).expect("added");
    assert_eq!(stream.resident_bytes(), FAMILY.chain_bytes(64) + TextureFamily::Rgba8.chain_bytes(64));
    stream.see(a, 1000.0);
    stream.see(b, 300.0);
    let plan = stream.plan();
    assert_eq!(plan.loads.len(), 2);
    let in_flight = FAMILY.chain_bytes(64) + FAMILY.chain_bytes(1024) + TextureFamily::Rgba8.chain_bytes(64) + TextureFamily::Rgba8.chain_bytes(512);
    assert_eq!(stream.resident_bytes(), in_flight);
    stream.landed(a, 1024);
    stream.landed(b, 512);
    assert_eq!(stream.resident_bytes(), FAMILY.chain_bytes(1024) + TextureFamily::Rgba8.chain_bytes(512));
    stream.remove(a);
    assert_eq!(stream.resident_bytes(), TextureFamily::Rgba8.chain_bytes(512));
    assert_eq!(stream.shown(a), None);
}

#[test]
fn a_pool_cut_drops_the_farthest_textures_to_their_tails_first() {
    let mut stream = TextureStream::new(POOL_ANY);
    let near = stream.add(1024, FAMILY, None).expect("added");
    let middle = stream.add(1024, FAMILY, None).expect("added");
    let far = stream.add(1024, FAMILY, None).expect("added");
    let sights = [(near, 3000.0), (middle, 2000.0), (far, 1500.0)];
    for (id, sight) in sights {
        stream.see(id, sight);
    }
    for load in stream.plan().loads {
        stream.landed(load.id, load.to);
    }
    assert!([near, middle, far].iter().all(|id| stream.shown(*id) == Some(1024)));
    // Room for two 1024 chains and a tail.
    stream.set_pool(FAMILY.chain_bytes(1024) * 2 + FAMILY.chain_bytes(64));
    for (id, sight) in sights {
        stream.see(id, sight);
    }
    let plan = stream.plan();
    assert_eq!(plan.dropped.iter().map(|change| change.id).collect::<Vec<_>>(), [far], "the farthest goes first");
    assert_eq!((stream.shown(near), stream.shown(middle), stream.shown(far)), (Some(1024), Some(1024), Some(64)));
    assert!(stream.resident_bytes() <= stream.pool_bytes());
    assert!(plan.loads.is_empty(), "the far texture waits: its 1024 does not fit");
}

#[test]
fn a_load_that_does_not_fit_the_pool_waits_and_the_most_needed_goes_first() {
    let mut stream = TextureStream::new(FAMILY.chain_bytes(64) * 2 + FAMILY.chain_bytes(1024));
    let small = stream.add(1024, FAMILY, None).expect("added");
    let big = stream.add(1024, FAMILY, None).expect("added");
    stream.see(small, 1500.0);
    stream.see(big, 4000.0);
    let plan = stream.plan();
    assert_eq!(plan.loads.iter().map(|change| change.id).collect::<Vec<_>>(), [big]);
    assert!(stream.resident_bytes() <= stream.pool_bytes());
}

#[test]
fn an_unseen_texture_steps_back_to_its_tail_after_the_hysteresis() {
    let mut stream = TextureStream::new(POOL_ANY);
    let id = stream.add(1024, FAMILY, None).expect("added");
    assert_eq!(frame(&mut stream, id, 1000.0), 1024);
    let mut shown = Vec::new();
    for _ in 0..12 {
        stream.see(id, 0.0);
        let plan = stream.plan();
        for load in plan.loads {
            stream.landed(load.id, load.to);
        }
        shown.push(stream.shown(id).expect("tracked"));
    }
    let first_tail = shown.iter().position(|rung| *rung == 64).expect("it steps down");
    assert!(first_tail as u64 + 1 >= RUNG_CHANGE_FRAMES_MIN, "not before the hysteresis: {shown:?}");
}

#[test]
fn the_stream_tracks_at_most_its_cap_and_reuses_removed_slots() {
    let mut stream = TextureStream::new(POOL_ANY);
    let ids: Vec<StreamedId> = (0..STREAMED_TEXTURES_MAX).map(|_| stream.add(256, FAMILY, None).expect("under the cap")).collect();
    assert_eq!(stream.add(256, FAMILY, None), None);
    stream.remove(ids[7]);
    assert_eq!(stream.add(256, FAMILY, None), Some(ids[7]));
}

fn fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn a_promotions_head_range_with_the_resident_tail_is_bit_equal_to_the_whole_files_chain() {
    for name in ["basis-uastc-64.bc.ktx2", "basis-uastc-64.astc.ktx2", "basis-uastc-64.etc2.ktx2", "basis-uastc-64.rgba8.ktx2"] {
        let file = fixture(name);
        let index = Ktx2Index::parse(&file[..KTX2_PREFIX_BYTES.min(file.len())], file.len() as u64).expect("the prefix parses");
        let whole = read_ktx2(&file).expect("the whole file reads");
        let (tail, to) = (16, 64);
        let resident = index.chain(tail).expect("the tail is a level");
        let head = head_range(&index, tail, to).expect("a head above the tail");
        assert_eq!(head.start, resident.end, "{name}: the head starts where the tail ends");
        let chunks = [(resident.start, &file[resident.start as usize..resident.end as usize]), (head.start, &file[head.start as usize..head.end as usize])];
        let levels = index.level_count() - (64_u32 / to).trailing_zeros();
        let assembled = index.assemble(levels, &chunks).expect("the chain is inside the tail and the head");
        assert_eq!(Some(assembled.levels()), whole.chain_from(to), "{name}: bit-equal to the whole file at {to}");
        assert_eq!(head_range(&index, to, tail), None, "{name}: no head going down");
        assert_eq!(head_range(&index, 48, to), None, "{name}: 48 is not a level");
    }
}
