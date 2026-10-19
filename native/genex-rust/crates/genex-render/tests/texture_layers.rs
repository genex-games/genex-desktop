//! Texture layers that come and go (game systems STR-3): each material array keeps a free list and
//! a reference count per layer, so a removed texture's layer is reused by the next add with no new
//! allocation, the layer cap counts live layers only, the growing arrays' refill cache keeps no
//! chain for a removed layer, and the budget ledger's reservation stays exact through the churn.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test texture_layers -- --include-ignored

use genex_render::budget::MaterialClass;
use genex_render::device_class::DeviceClass;
use genex_render::settings::{QualityPreset, TextureClass, TextureQuality};
use genex_render::texture::{
    ClassArrays, MAX_TEXTURE_LAYERS, TextureData, TextureFamily, TextureId, TextureKind, TextureLayers, class_layer_caps, material_arrays, mip_level_count,
    preset_textures, read_ktx2,
};
use genex_render::{Gpu, RenderCode};
use ktx2::Format;

// ---------------------------------------------------------------------------------------------
// CPU: the layer book

#[test]
fn a_released_layer_is_taken_again_before_a_new_one_lowest_first() {
    let mut layers = TextureLayers::new(8);
    let taken: Vec<u32> = (0..5).map(|_| layers.take().expect("room")).collect();
    assert_eq!(taken, [0, 1, 2, 3, 4]);
    assert_eq!(layers.release(3), Some(0), "the last reference frees it");
    assert_eq!(layers.release(1), Some(0));
    assert_eq!((layers.live(), layers.high_water()), (3, 5));
    assert_eq!(layers.take(), Some(1), "the lowest free layer first");
    assert_eq!(layers.take(), Some(3));
    assert_eq!(layers.take(), Some(5), "then a new one");
    assert_eq!((layers.live(), layers.high_water()), (6, 6));
}

#[test]
fn a_layer_lives_while_any_reference_holds_it() {
    let mut layers = TextureLayers::new(4);
    let layer = layers.take().expect("room");
    assert_eq!(layers.refs(layer), 1);
    assert_eq!(layers.retain(layer), Some(2));
    assert_eq!(layers.retain(layer), Some(3));
    assert_eq!(layers.release(layer), Some(2));
    assert_eq!(layers.release(layer), Some(1));
    assert!(layers.is_live(layer));
    assert_eq!(layers.release(layer), Some(0));
    assert!(!layers.is_live(layer));
    // A free or never-taken layer refuses both, and nothing changes.
    let before = layers.clone();
    assert_eq!((layers.release(layer), layers.retain(layer)), (None, None));
    assert_eq!((layers.release(7), layers.retain(7)), (None, None));
    assert_eq!(layers, before);
}

#[test]
fn the_cap_counts_live_layers_only() {
    let mut layers = TextureLayers::new(MAX_TEXTURE_LAYERS);
    for _ in 0..MAX_TEXTURE_LAYERS {
        layers.take().expect("room");
    }
    assert_eq!(layers.take(), None, "full");
    for layer in [10, 20, 30] {
        layers.release(layer);
    }
    let again: Vec<u32> = (0..3).map(|_| layers.take().expect("three layers were freed")).collect();
    assert_eq!(again, [10, 20, 30]);
    assert_eq!(layers.take(), None);
    assert_eq!((layers.live(), layers.high_water()), (MAX_TEXTURE_LAYERS, MAX_TEXTURE_LAYERS));
}

/// 2,000 random takes, retains and releases against a brute-force model: the same layers, the same
/// counts, and never more live layers than the cap.
#[test]
fn random_churn_matches_a_brute_force_book() {
    let mut layers = TextureLayers::new(16);
    let mut model: Vec<u32> = Vec::new();
    let mut state = 0x2545_f491_u32;
    let mut next = || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state
    };
    for _ in 0..2000 {
        let roll = next();
        let layer = next() % 18;
        match roll % 3 {
            0 => {
                let expected = model.iter().position(|refs| *refs == 0).or((model.len() < 16).then_some(model.len()));
                if let Some(at) = expected {
                    if at == model.len() {
                        model.push(0);
                    }
                    model[at] = 1;
                }
                assert_eq!(layers.take(), expected.map(|at| at as u32));
            }
            1 => {
                let live = model.get(layer as usize).is_some_and(|refs| *refs > 0);
                let expected = live.then(|| {
                    model[layer as usize] += 1;
                    model[layer as usize]
                });
                assert_eq!(layers.retain(layer), expected);
            }
            _ => {
                let live = model.get(layer as usize).is_some_and(|refs| *refs > 0);
                let expected = live.then(|| {
                    model[layer as usize] -= 1;
                    model[layer as usize]
                });
                assert_eq!(layers.release(layer), expected);
            }
        }
        assert_eq!(layers.live(), model.iter().filter(|refs| **refs > 0).count() as u32);
        assert!(layers.live() <= 16);
    }
}

// ---------------------------------------------------------------------------------------------
// GPU: the arrays

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

fn class(wire: &str) -> DeviceClass {
    DeviceClass::from_wire(wire).unwrap_or_else(|| panic!("{wire} is a class"))
}

fn flat(side: u32, value: u8) -> TextureData {
    TextureData::rgba8(side, side, vec![value; (side * side * 4) as usize]).expect("texture")
}

fn finish(gpu: &Gpu) {
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("uploads finish");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_remove_then_add_reuses_the_layer_with_no_new_allocation() {
    let Some(gpu) = gpu() else { return };
    let desktop_high = class("desktop-high");
    let mut arrays = ClassArrays::new(&gpu.device, desktop_high, preset_textures(QualityPreset::High, desktop_high));
    let first = arrays.add(&gpu.device, &gpu.queue, &flat(1024, 40), TextureKind::Color).expect("first");
    let second = arrays.add(&gpu.device, &gpu.queue, &flat(1024, 80), TextureKind::Color).expect("second");
    assert_eq!((first.class(), first.layer(), second.layer()), (TextureClass::S1024, 0, 1));
    let array = arrays.texture(TextureClass::S1024, TextureKind::Color).clone();
    let (allocated, extent) = (arrays.allocated_bytes(), arrays.extent(TextureClass::S1024, TextureKind::Color));

    assert_eq!(arrays.remove(first).expect("live"), 0, "its one reference was dropped");
    assert_eq!(arrays.live_layers(TextureClass::S1024, TextureKind::Color), 1);
    let third = arrays.add(&gpu.device, &gpu.queue, &flat(1024, 120), TextureKind::Color).expect("third");
    assert_eq!((third.class(), third.layer()), (TextureClass::S1024, 0), "the freed layer, not layer 2");
    assert_eq!(arrays.texture(TextureClass::S1024, TextureKind::Color), &array, "the same GPU array: nothing was allocated");
    assert_eq!(arrays.extent(TextureClass::S1024, TextureKind::Color), extent);
    assert_eq!(arrays.allocated_bytes(), allocated);
    finish(&gpu);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_retained_layer_survives_one_remove_and_a_free_one_refuses() {
    let Some(gpu) = gpu() else { return };
    let desktop_high = class("desktop-high");
    let mut arrays = ClassArrays::new(&gpu.device, desktop_high, preset_textures(QualityPreset::High, desktop_high));
    let shared = arrays.add(&gpu.device, &gpu.queue, &flat(512, 9), TextureKind::Data).expect("shared");
    assert_eq!(arrays.retain(shared).expect("live"), 2, "two materials name it");
    assert_eq!(arrays.remove(shared).expect("live"), 1);
    assert_eq!(arrays.live_layers(TextureClass::S512, TextureKind::Data), 1, "still held");
    let next = arrays.add(&gpu.device, &gpu.queue, &flat(512, 10), TextureKind::Data).expect("next");
    assert_eq!(next.layer(), 1, "a held layer is not reused");
    assert_eq!(arrays.remove(shared).expect("live"), 0);
    for refused in [arrays.remove(shared), arrays.retain(shared), arrays.remove(TextureId::in_class(TextureKind::Data, TextureClass::S512, 9))] {
        assert_eq!(refused.expect_err("not live").code(), RenderCode::TextureInvalid);
    }
    finish(&gpu);
}

/// Today's growing 256 class: the cap of 64 counts live layers, so after removes the array takes
/// that many again without growing, and the refill cache drops each removed layer's chain.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_layer_cap_counts_live_layers_and_the_refill_cache_skips_removed_ones() {
    let Some(gpu) = gpu() else { return };
    let mut arrays = ClassArrays::new(&gpu.device, class("desktop-high"), TextureQuality::OFF);
    let ids: Vec<TextureId> = (0..MAX_TEXTURE_LAYERS).map(|n| arrays.add(&gpu.device, &gpu.queue, &flat(64, n as u8), TextureKind::Color).expect("room")).collect();
    let full = arrays.add(&gpu.device, &gpu.queue, &flat(64, 0), TextureKind::Color).expect_err("64 live layers");
    assert_eq!(full.code(), RenderCode::TextureTooLarge);
    let cached = arrays.cached_bytes();
    let chain = cached / u64::from(MAX_TEXTURE_LAYERS);
    for id in &ids[5..15] {
        arrays.remove(*id).expect("live");
    }
    assert_eq!(arrays.cached_bytes(), cached - 10 * chain, "a removed layer's chain is not kept to refill");
    assert_eq!(arrays.held_bytes(), 54 * TextureFamily::Rgba8.chain_bytes(256));
    let extent = arrays.extent(TextureClass::S256, TextureKind::Color);
    let again: Vec<u32> = (0..10).map(|n| arrays.add(&gpu.device, &gpu.queue, &flat(64, 200 + n), TextureKind::Color).expect("freed room").layer()).collect();
    assert_eq!(again, (5..15).collect::<Vec<u32>>());
    assert_eq!(arrays.extent(TextureClass::S256, TextureKind::Color), extent, "no growth");
    assert_eq!(arrays.cached_bytes(), cached);
    assert_eq!(arrays.add(&gpu.device, &gpu.queue, &flat(64, 0), TextureKind::Color).expect_err("full again").code(), RenderCode::TextureTooLarge);
    finish(&gpu);
}

/// The growing class grows by copy from its refill cache: a layer removed and taken again before
/// a growth is refilled with its new chain, every other live layer with its own.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_growth_after_churn_refills_only_live_chains() {
    let Some(gpu) = gpu() else { return };
    let mut arrays = ClassArrays::new(&gpu.device, class("desktop-high"), TextureQuality::OFF);
    let ids: Vec<TextureId> = (0..4).map(|n| arrays.add(&gpu.device, &gpu.queue, &flat(64, n), TextureKind::Color).expect("room")).collect();
    assert_eq!(arrays.extent(TextureClass::S256, TextureKind::Color).1, 4);
    arrays.remove(ids[1]).expect("live");
    arrays.remove(ids[2]).expect("live");
    assert_eq!(arrays.cached_bytes(), 2 * TextureFamily::Rgba8.chain_bytes(256));
    let layers: Vec<u32> = (0..3).map(|n| arrays.add(&gpu.device, &gpu.queue, &flat(64, 50 + n), TextureKind::Color).expect("room").layer()).collect();
    assert_eq!(layers, [1, 2, 4], "two freed layers, then a new one that grows the array");
    assert_eq!(arrays.extent(TextureClass::S256, TextureKind::Color).1, 8);
    assert_eq!(arrays.cached_bytes(), 5 * TextureFamily::Rgba8.chain_bytes(256), "one chain per live layer");
    finish(&gpu);
}

/// The ledger's reservation (`material_arrays`) is exactly what a class allocates once both its
/// arrays are in use, before and after a churn of removes and adds; the held bytes follow the live
/// layers.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_material_arrays_ledger_stays_exact_through_churn() {
    let Some(gpu) = gpu() else { return };
    let mobile_mid = class("mobile-mid");
    let quality = preset_textures(QualityPreset::Low, mobile_mid);
    let caps = class_layer_caps(mobile_mid, quality);
    let mut arrays = ClassArrays::new(&gpu.device, mobile_mid, quality);
    let mut live = Vec::new();
    for (side, kind) in [(256, TextureKind::Color), (256, TextureKind::Data), (512, TextureKind::Color), (512, TextureKind::Data)] {
        live.push(arrays.add(&gpu.device, &gpu.queue, &flat(side, 1), kind).expect("room"));
    }
    let reserved: u64 = material_arrays(mobile_mid, quality).iter().map(MaterialClass::bytes).sum();
    assert_eq!(arrays.allocated_bytes(), reserved, "every reserved array is allocated, at its cap");
    for round in 0..caps[1] * 3 {
        let id = live.remove(round as usize % live.len());
        arrays.remove(id).expect("live");
        let side = id.class().side();
        live.push(arrays.add(&gpu.device, &gpu.queue, &flat(side, round as u8), id.kind()).expect("the freed layer"));
        assert_eq!(arrays.allocated_bytes(), reserved, "round {round}");
    }
    let held: u64 = live.iter().map(|id| TextureFamily::Rgba8.chain_bytes(id.class().side())).sum();
    assert_eq!(arrays.held_bytes(), held);
    assert!(live.iter().all(|id| id.layer() == 0), "each churned texture took its class's one freed layer");
    finish(&gpu);
}

/// A compressed family's arrays reuse a freed layer the same way: the new chain lands in it byte
/// for byte (read back), in the same GPU array.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_compressed_layer_is_reused_and_holds_the_new_blocks() {
    let Some(gpu) = gpu() else { return };
    let Some((family, format)) = [(TextureFamily::Bc7, Format::BC7_SRGB_BLOCK), (TextureFamily::Astc4x4, Format::ASTC_4x4_SRGB_BLOCK)]
        .into_iter()
        .find(|(family, _)| family.usable(gpu.device.features()))
    else {
        eprintln!("skipped: no BC7 or ASTC on this adapter");
        return;
    };
    let desktop_high = class("desktop-high");
    let mut arrays = ClassArrays::with_family(&gpu.device, desktop_high, preset_textures(QualityPreset::High, desktop_high), family);
    let (old, new) = (ktx2_chain(format, family, 512, 3), ktx2_chain(format, family, 512, 77));
    let first = arrays.add_compressed(&gpu.device, &gpu.queue, &read_ktx2(&old.1).expect("old"), TextureKind::Color).expect("placed");
    let other = arrays.add_compressed(&gpu.device, &gpu.queue, &read_ktx2(&old.1).expect("old"), TextureKind::Color).expect("placed");
    assert_eq!((first.layer(), other.layer()), (0, 1));
    let array = arrays.texture(TextureClass::S512, TextureKind::Color).clone();
    arrays.remove(first).expect("live");
    let reused = arrays.add_compressed(&gpu.device, &gpu.queue, &read_ktx2(&new.1).expect("new"), TextureKind::Color).expect("placed");
    assert_eq!((reused.class(), reused.layer()), (TextureClass::S512, 0));
    assert_eq!(arrays.texture(TextureClass::S512, TextureKind::Color), &array, "no new array");
    for level in [0, 4, 9] {
        assert_eq!(read_level(&gpu, &array, family, 0, level), new.0[level as usize], "level {level} holds the new chain");
        assert_eq!(read_level(&gpu, &array, family, 1, level), old.0[level as usize], "layer 1 untouched");
    }
}

/// A square KTX2 chain of `side` texels in `format` (each level's blocks filled from `seed`): the
/// levels as stored and the file.
fn ktx2_chain(format: Format, family: TextureFamily, side: u32, seed: u8) -> (Vec<Vec<u8>>, Vec<u8>) {
    let levels: Vec<Vec<u8>> = (0..mip_level_count(side))
        .map(|level| {
            let px = (side >> level).max(1);
            (0..family.level_bytes(px, px) as usize).map(|at| seed.wrapping_add(level as u8).wrapping_add((at / 16) as u8)).collect()
        })
        .collect();
    let dfd = ktx2::dfd::Block::Basic(ktx2::dfd::Basic::from_format(format).expect("a DFD for the format").0).to_vec();
    let dfd_at = 80 + 24 * levels.len();
    let dfd_len = 4 + dfd.len();
    let mut at = (dfd_at + dfd_len).next_multiple_of(16);
    let mut index = Vec::new();
    for level in &levels {
        index.push((at as u64, level.len() as u64));
        at += level.len().next_multiple_of(16);
    }
    let mut out = vec![0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
    let header = [format.value(), 1, side, side, 0, 0, 1, levels.len() as u32, 0, dfd_at as u32, dfd_len as u32, 0, 0];
    header.iter().for_each(|word| out.extend(word.to_le_bytes()));
    out.extend(0u64.to_le_bytes());
    out.extend(0u64.to_le_bytes());
    for (offset, length) in &index {
        out.extend(offset.to_le_bytes());
        out.extend(length.to_le_bytes());
        out.extend(length.to_le_bytes());
    }
    out.extend((dfd_len as u32).to_le_bytes());
    out.extend(&dfd);
    for (level, (offset, _)) in levels.iter().zip(&index) {
        out.resize(*offset as usize, 0);
        out.extend(level);
    }
    (levels, out)
}

/// The bytes of one level of one layer of `texture`, read back block row by block row.
fn read_level(gpu: &Gpu, texture: &wgpu::Texture, family: TextureFamily, layer: u32, level: u32) -> Vec<u8> {
    let px = (texture.width() >> level).max(1);
    let blocks = px.div_ceil(family.block_side());
    let row = blocks * family.block_bytes();
    let padded = row.next_multiple_of(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT);
    let buffer = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("level readback"),
        size: u64::from(padded * blocks),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    let physical = blocks * family.block_side();
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: level, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &buffer, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(blocks) } },
        wgpu::Extent3d { width: physical, height: physical, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    buffer.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("readback");
    let mapped = buffer.slice(..).get_mapped_range().expect("mapped range");
    mapped.chunks(padded as usize).flat_map(|line| line[..row as usize].to_vec()).collect()
}
