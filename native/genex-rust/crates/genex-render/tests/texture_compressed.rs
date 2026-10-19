//! Compressed material textures (renderer pass 2, A6.4): a KTX2 file in one fixed GPU format
//! (BC7, ASTC 4x4 or ETC2 RGBA8, each sRGB or linear, or plain RGBA8) is read and checked with the
//! `ktx2` crate, and its stored mip chain goes into size-class arrays of that family as it is, at
//! a quarter of RGBA8's bytes. The compression features are renderer-owned: requested whenever
//! the adapter offers them.
//!
//! Wired in (A6.4): a renderer set to a family (`Renderer::set_texture_family`, before its first
//! texture) stores its larger size classes in it and keeps class 0 (256) RGBA8, so an image
//! without a family file still loads there; the facade loads `<stem>.<family>.ktx2` beside a
//! texture when the game ships one.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test texture_compressed -- --ignored metal

use genex_render::budget::MaterialClass;
use genex_render::device_class::DeviceClass;
use genex_render::floor::RENDERER_FEATURES;
use genex_render::settings::{QualityPreset, TextureClass};
use genex_render::texture::{
    ClassArrays, CompressedTexture, TextureData, TextureFamily, TextureKind, family_file, material_arrays, mip_level_count, preset_textures,
    read_ktx2,
};
use genex_render::{Gpu, RenderCode};
use ktx2::{Format, SupercompressionScheme};
use wgpu::Features;

/// What a test KTX2 file holds: its header fields and its levels as stored.
struct Ktx2 {
    format: Option<Format>,
    width: u32,
    height: u32,
    depth: u32,
    layers: u32,
    faces: u32,
    supercompression: u32,
    levels: Vec<Vec<u8>>,
}

impl Ktx2 {
    /// A square texture of `side` texels with its whole chain, block `b` of every level filled
    /// with `seed + level` so each level and block is told apart.
    fn chain(format: Format, side: u32, seed: u8) -> Ktx2 {
        let family = family_of(format);
        let levels = (0..mip_level_count(side))
            .map(|level| {
                let px = (side >> level).max(1);
                let bytes = family.level_bytes(px, px) as usize;
                (0..bytes).map(|at| seed.wrapping_add(level as u8).wrapping_add((at / 16) as u8)).collect()
            })
            .collect();
        Ktx2 { format: Some(format), width: side, height: side, depth: 0, layers: 0, faces: 1, supercompression: 0, levels }
    }

    /// The file: header, level index, a basic DFD for the format and the levels, smallest last.
    fn bytes(&self) -> Vec<u8> {
        let dfd = match self.format {
            Some(format) => ktx2::dfd::Block::Basic(ktx2::dfd::Basic::from_format(format).expect("a DFD for the format").0).to_vec(),
            None => ktx2::dfd::Block::Basic(ktx2::dfd::Basic::from_format(Format::R8G8B8A8_UNORM).expect("dfd").0).to_vec(),
        };
        let index_end = 80 + 24 * self.levels.len();
        let dfd_at = index_end;
        let dfd_len = 4 + dfd.len();
        let mut at = (dfd_at + dfd_len).next_multiple_of(16);
        let mut index = Vec::new();
        for level in &self.levels {
            index.push((at as u64, level.len() as u64));
            at += level.len().next_multiple_of(16);
        }
        let mut out = vec![0xAB, 0x4B, 0x54, 0x58, 0x20, 0x32, 0x30, 0xBB, 0x0D, 0x0A, 0x1A, 0x0A];
        let header = [
            self.format.map_or(0, |format| format.value()),
            1,
            self.width,
            self.height,
            self.depth,
            self.layers,
            self.faces,
            self.levels.len() as u32,
            self.supercompression,
            dfd_at as u32,
            dfd_len as u32,
            0,
            0,
        ];
        for word in header {
            out.extend(word.to_le_bytes());
        }
        out.extend(0u64.to_le_bytes());
        out.extend(0u64.to_le_bytes());
        for (offset, length) in &index {
            out.extend(offset.to_le_bytes());
            out.extend(length.to_le_bytes());
            out.extend(length.to_le_bytes());
        }
        out.extend((dfd_len as u32).to_le_bytes());
        out.extend(&dfd);
        for (level, (offset, _)) in self.levels.iter().zip(&index) {
            out.resize(*offset as usize, 0);
            out.extend(level);
        }
        out
    }
}

fn family_of(format: Format) -> TextureFamily {
    match format {
        Format::BC7_SRGB_BLOCK | Format::BC7_UNORM_BLOCK => TextureFamily::Bc7,
        Format::ASTC_4x4_SRGB_BLOCK | Format::ASTC_4x4_UNORM_BLOCK => TextureFamily::Astc4x4,
        Format::ETC2_R8G8B8A8_SRGB_BLOCK | Format::ETC2_R8G8B8A8_UNORM_BLOCK => TextureFamily::Etc2Rgba8,
        _ => TextureFamily::Rgba8,
    }
}

#[test]
fn every_family_reads_its_srgb_and_linear_formats_with_the_whole_chain_as_stored() {
    let rows = [
        (Format::BC7_SRGB_BLOCK, TextureFamily::Bc7, true),
        (Format::BC7_UNORM_BLOCK, TextureFamily::Bc7, false),
        (Format::ASTC_4x4_SRGB_BLOCK, TextureFamily::Astc4x4, true),
        (Format::ASTC_4x4_UNORM_BLOCK, TextureFamily::Astc4x4, false),
        (Format::ETC2_R8G8B8A8_SRGB_BLOCK, TextureFamily::Etc2Rgba8, true),
        (Format::ETC2_R8G8B8A8_UNORM_BLOCK, TextureFamily::Etc2Rgba8, false),
        (Format::R8G8B8A8_SRGB, TextureFamily::Rgba8, true),
        (Format::R8G8B8A8_UNORM, TextureFamily::Rgba8, false),
    ];
    for (format, family, srgb) in rows {
        let file = Ktx2::chain(format, 256, 7);
        let texture = read_ktx2(&file.bytes()).unwrap_or_else(|error| panic!("{format:?}: {error}"));
        assert_eq!((texture.family(), texture.is_srgb(), texture.side()), (family, srgb, 256), "{format:?}");
        assert_eq!(texture.levels().len(), 9, "{format:?}: 256 down to 1");
        for (level, stored) in texture.levels().iter().zip(&file.levels) {
            assert_eq!(level, stored, "{format:?}: levels kept byte for byte");
        }
    }
    assert_eq!(TextureFamily::Bc7.level_bytes(1, 1), 16, "a mip under one block still takes a whole block");
    assert_eq!(TextureFamily::Rgba8.level_bytes(3, 2), 24);
}

#[test]
fn hostile_ktx2_files_are_refused_with_a_typed_code_and_never_panic() {
    let good = || Ktx2::chain(Format::BC7_SRGB_BLOCK, 256, 1);
    let mut truncated = good().bytes();
    truncated.truncate(200);
    let mut short_level = good();
    short_level.levels[3].pop();
    let mut missing_levels = good();
    missing_levels.levels.truncate(4);
    let rows: Vec<(&str, Vec<u8>, RenderCode)> = vec![
        ("not ktx2", b"PNG, not a texture container at all.....".to_vec(), RenderCode::TextureInvalid),
        ("truncated", truncated, RenderCode::TextureInvalid),
        ("basis universal", Ktx2 { format: None, ..good() }.bytes(), RenderCode::TextureInvalid),
        ("zstd levels", Ktx2 { supercompression: SupercompressionScheme::Zstandard.value(), ..good() }.bytes(), RenderCode::TextureInvalid),
        ("a float format", Ktx2 { format: Some(Format::R16G16B16A16_SFLOAT), ..good() }.bytes(), RenderCode::TextureInvalid),
        ("an array", Ktx2 { layers: 2, ..good() }.bytes(), RenderCode::TextureInvalid),
        ("a cube", Ktx2 { faces: 6, ..good() }.bytes(), RenderCode::TextureInvalid),
        ("a 3d texture", Ktx2 { depth: 4, ..good() }.bytes(), RenderCode::TextureInvalid),
        ("a 1d texture", Ktx2 { height: 0, ..good() }.bytes(), RenderCode::TextureInvalid),
        ("a level shorter than its blocks", short_level.bytes(), RenderCode::TextureInvalid),
        ("a chain that stops above 1 x 1", missing_levels.bytes(), RenderCode::TextureInvalid),
        ("past the texture cap", Ktx2 { width: 1 << 15, height: 1 << 15, ..good() }.bytes(), RenderCode::TextureTooLarge),
    ];
    for (name, bytes, code) in rows {
        let error = read_ktx2(&bytes).err().unwrap_or_else(|| panic!("{name} is refused"));
        assert_eq!(error.code(), code, "{name}: {error}");
    }
}

#[test]
fn the_compression_features_are_renderer_owned_and_each_family_names_its_feature_and_formats() {
    let names: Vec<&str> = RENDERER_FEATURES.iter().map(|(_, name)| *name).collect();
    for (family, feature, name) in [
        (TextureFamily::Bc7, Features::TEXTURE_COMPRESSION_BC, "texture-compression-bc"),
        (TextureFamily::Astc4x4, Features::TEXTURE_COMPRESSION_ASTC, "texture-compression-astc"),
        (TextureFamily::Etc2Rgba8, Features::TEXTURE_COMPRESSION_ETC2, "texture-compression-etc2"),
    ] {
        assert!(names.contains(&name), "{name} is requested whenever offered");
        assert_eq!(family.feature(), feature);
        assert!(family.usable(feature) && !family.usable(Features::empty()), "{family:?}");
        assert!(family.format(TextureKind::Color).is_srgb() && !family.format(TextureKind::Normal).is_srgb(), "{family:?}");
    }
    assert!(TextureFamily::Rgba8.usable(Features::empty()), "every device takes RGBA8");
}

#[test]
fn a_compressed_chain_takes_a_quarter_of_rgba8s_bytes_so_the_desktop_high_arrays_shrink_over_3_5x() {
    for side in TextureClass::ALL.map(TextureClass::side) {
        let rgba8 = MaterialClass { size_px: side, layers: 1 }.bytes();
        assert_eq!(TextureFamily::Rgba8.chain_bytes(side), rgba8, "RGBA8 is the ledger's own model");
        for family in [TextureFamily::Bc7, TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8] {
            let ratio = rgba8 as f64 / family.chain_bytes(side) as f64;
            assert!((3.99..=4.0).contains(&ratio), "{family:?} at {side}: {ratio}");
        }
    }
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let arrays = material_arrays(class, preset_textures(QualityPreset::High, class));
    let rgba8: u64 = arrays.iter().map(MaterialClass::bytes).sum();
    let bc7: u64 = arrays.iter().map(|array| TextureFamily::Bc7.chain_bytes(array.size_px) * u64::from(array.layers)).sum();
    assert!(rgba8 as f64 / bc7 as f64 >= 3.5, "the ledger's material arrays: {rgba8} -> {bc7}");
}

/// A file the Studio's import step wrote (`tests/conformance/rust-assets-ktx2.test.ts` holds it to
/// the importer's output).
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn the_import_steps_family_files_read_here_with_the_descriptor_the_ktx2_crate_builds_for_their_format() {
    let rows = [
        ("bc", TextureFamily::Bc7, Format::BC7_SRGB_BLOCK),
        ("astc", TextureFamily::Astc4x4, Format::ASTC_4x4_SRGB_BLOCK),
        ("etc2", TextureFamily::Etc2Rgba8, Format::ETC2_R8G8B8A8_SRGB_BLOCK),
        ("rgba8", TextureFamily::Rgba8, Format::R8G8B8A8_SRGB),
    ];
    for (wire, family, format) in rows {
        let bytes = import_fixture(&format!("basis-uastc-64.{wire}.ktx2"));
        let texture = read_ktx2(&bytes).unwrap_or_else(|error| panic!("{wire}: {error}"));
        assert_eq!((texture.family(), texture.is_srgb(), texture.side(), texture.levels().len()), (family, true, 64, 7), "{wire}");
        let reader = ktx2::Reader::new(&bytes[..]).expect("a KTX2 file");
        let expected = ktx2::dfd::Basic::from_format(format).expect("a descriptor").0;
        assert_eq!(reader.basic_dfd(), Some(&expected), "{wire}: the import step's descriptor");
        // The value is NUL-terminated, as KTX 2.0 asks of KTXwriter.
        assert_eq!(reader.writer(), Some("Genex asset import\0"), "{wire}");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU

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
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(blocks) },
        },
        wgpu::Extent3d { width: physical, height: physical, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    buffer.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("readback");
    let mapped = buffer.slice(..).get_mapped_range().expect("mapped range");
    mapped.chunks(padded as usize).flat_map(|line| line[..row as usize].to_vec()).collect()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_ktx2_chain_lands_in_its_class_byte_for_byte_for_every_family_the_adapter_offers() {
    let Some(gpu) = gpu() else { return };
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let quality = preset_textures(QualityPreset::High, class);
    let rows = [
        (TextureFamily::Bc7, Format::BC7_SRGB_BLOCK, Format::BC7_UNORM_BLOCK),
        (TextureFamily::Astc4x4, Format::ASTC_4x4_SRGB_BLOCK, Format::ASTC_4x4_UNORM_BLOCK),
        (TextureFamily::Etc2Rgba8, Format::ETC2_R8G8B8A8_SRGB_BLOCK, Format::ETC2_R8G8B8A8_UNORM_BLOCK),
    ];
    let mut tested = 0;
    for (family, colour, data) in rows {
        if !family.usable(gpu.device.features()) {
            eprintln!("{family:?}: not offered by this adapter");
            continue;
        }
        tested += 1;
        let mut arrays = ClassArrays::with_family(&gpu.device, class, quality, family);
        assert_eq!(arrays.family(), family);
        let base = Ktx2::chain(colour, 512, 3);
        let base_id = arrays.add_compressed(&gpu.device, &gpu.queue, &read_ktx2(&base.bytes()).expect("colour"), TextureKind::Color).expect("placed");
        let normal = Ktx2::chain(data, 1024, 9);
        let normal_id = arrays.add_compressed(&gpu.device, &gpu.queue, &read_ktx2(&normal.bytes()).expect("data"), TextureKind::Normal).expect("placed");
        assert_eq!((base_id.class(), base_id.layer()), (TextureClass::S512, 0), "{family:?}");
        assert_eq!((normal_id.kind(), normal_id.class()), (TextureKind::Normal, TextureClass::S1024), "{family:?}");
        let texture = arrays.texture(TextureClass::S512, TextureKind::Color);
        assert_eq!(texture.format(), family.format(TextureKind::Color));
        for level in [0, 3, 8, 9] {
            assert_eq!(read_level(&gpu, texture, family, 0, level), base.levels[level as usize], "{family:?} level {level}");
        }
        let reserved: u64 = material_arrays(class, quality).iter().map(MaterialClass::bytes).sum();
        assert!(arrays.allocated_bytes() * 4 <= reserved, "{family:?}: a quarter of the RGBA8 reservation at most");
    }
    assert!(tested > 0, "the adapter offers at least one compressed family");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_larger_chain_drops_its_top_levels_into_a_capped_class_and_an_image_lands_in_the_rgba8_class() {
    let Some(gpu) = gpu() else { return };
    if !TextureFamily::Bc7.usable(gpu.device.features()) {
        eprintln!("skipped: no BC on this adapter");
        return;
    }
    let class = DeviceClass::from_wire("mobile-mid").expect("class");
    let quality = preset_textures(QualityPreset::Low, class);
    let mut arrays = ClassArrays::with_family(&gpu.device, class, quality, TextureFamily::Bc7);
    let big = Ktx2::chain(Format::BC7_SRGB_BLOCK, 2048, 5);
    let id = arrays.add_compressed(&gpu.device, &gpu.queue, &read_ktx2(&big.bytes()).expect("big"), TextureKind::Color).expect("placed");
    assert_eq!(id.class(), TextureClass::S512, "capped at 512 on mobile-mid: levels from 512 down");
    let texture = arrays.texture(TextureClass::S512, TextureKind::Color);
    assert_eq!(read_level(&gpu, texture, TextureFamily::Bc7, 0, 0), big.levels[2], "the 512 level of the 2048 chain");
    // Pass 2 A6.4 wiring flipped "BC7 arrays hold BC7 only, an image is refused texture-invalid":
    // class 0 stays RGBA8 under every family, so an image (even a large one) lands there.
    let rgba = TextureData::rgba8(1024, 1024, vec![255; 1024 * 1024 * 4]).expect("rgba");
    let image = arrays.add(&gpu.device, &gpu.queue, &rgba, TextureKind::Color).expect("an image lands in the RGBA8 class");
    assert_eq!(image.class(), TextureClass::S256, "resampled into class 0, the only RGBA8 class");
    assert_eq!(arrays.texture(TextureClass::S256, TextureKind::Color).format(), wgpu::TextureFormat::Rgba8UnormSrgb);
    let astc = read_ktx2(&Ktx2::chain(Format::ASTC_4x4_SRGB_BLOCK, 256, 1).bytes()).expect("astc");
    let refused = arrays.add_compressed(&gpu.device, &gpu.queue, &astc, TextureKind::Color).expect_err("another family");
    assert_eq!(refused.code(), RenderCode::TextureInvalid);
    let small: CompressedTexture = read_ktx2(&Ktx2::chain(Format::BC7_SRGB_BLOCK, 256, 1).bytes()).expect("small");
    let refused = arrays.add_compressed(&gpu.device, &gpu.queue, &small, TextureKind::Color).expect_err("below the family's 512 class");
    assert_eq!(refused.code(), RenderCode::TextureInvalid);
    let linear = read_ktx2(&Ktx2::chain(Format::BC7_UNORM_BLOCK, 512, 1).bytes()).expect("linear");
    let refused = arrays.add_compressed(&gpu.device, &gpu.queue, &linear, TextureKind::Color).expect_err("a linear chain for a colour slot");
    assert_eq!(refused.code(), RenderCode::TextureInvalid);
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("uploads finish");
}

/// Game systems GF (C-12): under a compressed family class 0 holds only the images that have no
/// family file (a fallback), so it grows by copy with them instead of taking its whole cap on the
/// first one: two fallback maps hold two layers, not 32 (Lakeside's GPU arrays were 2.80x smaller
/// instead of >= 3.5x because two refused maps allocated class 0's 32 layers).
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_fallback_images_under_a_compressed_family_take_only_the_class_0_layers_they_use() {
    let Some(gpu) = gpu() else { return };
    if !TextureFamily::Bc7.usable(gpu.device.features()) {
        eprintln!("skipped: no BC on this adapter");
        return;
    }
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let quality = preset_textures(QualityPreset::High, class);
    let mut arrays = ClassArrays::with_family(&gpu.device, class, quality, TextureFamily::Bc7);
    let images: Vec<TextureData> = (0..3u8)
        .map(|at| TextureData::rgba8(256, 256, (0..256 * 256 * 4).map(|i| (i as u8).wrapping_mul(7).wrapping_add(at * 40)).collect()).expect("rgba"))
        .collect();
    for (at, image) in images.iter().enumerate() {
        let id = arrays.add(&gpu.device, &gpu.queue, image, TextureKind::Data).expect("a fallback image");
        assert_eq!((id.class(), id.layer()), (TextureClass::S256, at as u32));
    }
    let (side, layers) = arrays.extent(TextureClass::S256, TextureKind::Data);
    assert_eq!((side, layers), (256, 4), "three fallback images hold the next power of two of layers, not the class's cap");
    // Nothing else is allocated: the colour fallback array and the BC classes hold no texture.
    let four_layers = MaterialClass { size_px: 256, layers: 4 }.bytes();
    assert_eq!(arrays.allocated_bytes(), four_layers, "only the four class-0 data layers are allocated");
    assert_eq!(arrays.live_layers(TextureClass::S256, TextureKind::Data), 3);
    // (Growth refills every live layer from its cached chain, as the 256 array of texture quality
    // off does: tests/texture_layers.rs; an RGBA8 array is not copied out, so it is not read back.)
    let chain: u64 = (0..mip_level_count(256)).map(|level| (256u64 >> level).pow(2) * 4).sum();
    assert_eq!(arrays.cached_bytes(), 3 * chain, "the three chains are cached for the refill");
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("uploads finish");
}

#[test]
fn a_family_file_sits_beside_its_source_named_for_its_family() {
    let cases = [
        ("textures/rock.png", TextureFamily::Bc7, "textures/rock.bc.ktx2"),
        ("rock.jpg", TextureFamily::Astc4x4, "rock.astc.ktx2"),
        ("a.b/rock", TextureFamily::Etc2Rgba8, "a.b/rock.etc2.ktx2"),
        ("a.b/rock.basis.ktx2", TextureFamily::Bc7, "a.b/rock.basis.bc.ktx2"),
        (".hidden", TextureFamily::Rgba8, ".rgba8.ktx2"),
    ];
    for (path, family, wanted) in cases {
        assert_eq!(family_file(path, family), wanted, "{path}");
    }
    // The family spellings and features are the shared texture table's (the import step and
    // genex-assets hold to the same fixture).
    let table: serde_json::Value = serde_json::from_slice(&import_fixture("texture-table.json")).expect("the texture table");
    let features = table["features"].as_object().expect("features");
    let mut wires: Vec<&str> = TextureFamily::ALL.iter().map(|family| family.wire()).collect();
    let mut listed: Vec<&str> = features.keys().map(String::as_str).collect();
    wires.sort_unstable();
    listed.sort_unstable();
    assert_eq!(wires, listed, "one spelling per family");
    for family in TextureFamily::ALL {
        let feature = features[family.wire()].as_str();
        let named = RENDERER_FEATURES.iter().find(|(f, _)| *f == family.feature()).map(|(_, name)| *name);
        assert_eq!(named, feature, "{family:?}'s feature");
    }
}

#[test]
fn a_device_takes_its_forms_compressed_families_best_first() {
    let all = Features::TEXTURE_COMPRESSION_BC | Features::TEXTURE_COMPRESSION_ASTC | Features::TEXTURE_COMPRESSION_ETC2;
    assert_eq!(TextureFamily::usable_compressed(all, false), [TextureFamily::Bc7, TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8]);
    assert_eq!(TextureFamily::usable_compressed(all, true), [TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8, TextureFamily::Bc7]);
    assert_eq!(TextureFamily::usable_compressed(Features::TEXTURE_COMPRESSION_ETC2, true), [TextureFamily::Etc2Rgba8]);
    assert!(TextureFamily::usable_compressed(Features::empty(), false).is_empty());
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_renderer_set_to_a_family_draws_its_compressed_texture_at_a_quarter_of_the_bytes() {
    use genex_render::Renderer;
    use genex_render::scene::{CameraDesc, Material, MeshId, Scene, translation};
    let Some(gpu) = gpu() else { return };
    let Some(family) = TextureFamily::usable_compressed(gpu.device.features(), false).first().copied() else {
        eprintln!("skipped: no compressed family on this adapter");
        return;
    };
    let format = match family {
        TextureFamily::Bc7 => Format::BC7_SRGB_BLOCK,
        TextureFamily::Astc4x4 => Format::ASTC_4x4_SRGB_BLOCK,
        _ => Format::ETC2_R8G8B8A8_SRGB_BLOCK,
    };
    let chain = read_ktx2(&Ktx2::chain(format, 1024, 7).bytes()).expect("a chain");
    let image = TextureData::rgba8(1024, 1024, (0..1024 * 1024 * 4).map(|i| (i % 251) as u8).collect()).expect("an image");
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let quality = genex_render::presets::preset_quality(QualityPreset::High, class);
    let scene = |texture| {
        let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.5, 3.0], [0.0, 0.0, 0.0]), [10, 10, 10, 255]);
        scene.draw(MeshId::CUBE, translation(0.0, 0.0, 0.0), Material { base_texture: Some(texture), ..Material::color([255, 255, 255, 255]) });
        scene
    };
    // The same 1024 texture as an image in RGBA8 arrays, and as the family's chain.
    let mut plain = Renderer::new(&gpu, 320, 180).expect("renderer");
    plain.set_quality(&quality);
    let id = plain.add_texture(&gpu, &image, TextureKind::Color).expect("image");
    plain.render(&gpu, &scene(id), genex_render::CullPath::Gpu).expect("frame");
    let mut compressed = Renderer::new(&gpu, 320, 180).expect("renderer");
    compressed.set_quality(&quality);
    compressed.set_texture_family(&gpu, family).expect("set before any texture");
    let id = compressed.add_compressed_texture(&gpu, &chain, TextureKind::Color).expect("chain");
    assert_eq!(id.class(), TextureClass::S1024);
    compressed.render(&gpu, &scene(id), genex_render::CullPath::Gpu).expect("frame");
    let drawn = compressed.capture(&gpu).expect("capture");
    let lit = drawn.bgra().chunks(4).filter(|px| px[0] > 20 || px[1] > 20 || px[2] > 20).count();
    assert!(lit > 1000, "the cube draws with its compressed texture ({lit} lit pixels)");
    let ratio = plain.texture_bytes() as f64 / compressed.texture_bytes() as f64;
    eprintln!("{family:?}: {} RGBA8 bytes against {} compressed ({ratio:.2}x)", plain.texture_bytes(), compressed.texture_bytes());
    assert!(ratio >= 3.5, "a quarter of the bytes: {ratio:.2}x");
    // The family is fixed with the first texture: a later change is refused, the arrays kept.
    let refused = compressed.set_texture_family(&gpu, TextureFamily::Rgba8).expect_err("too late");
    assert_eq!(refused.code(), RenderCode::TextureInvalid);
    assert_eq!(compressed.texture_family(), family);
    // An image still loads, into the RGBA8 class.
    let small = compressed.add_texture(&gpu, &image, TextureKind::Color).expect("an image beside the chain");
    assert_eq!(small.class(), TextureClass::S256);
    // A family the device does not offer is refused before any array is made.
    let mut other = Renderer::new(&gpu, 64, 64).expect("renderer");
    let missing = [TextureFamily::Bc7, TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8].into_iter().find(|family| !family.usable(gpu.device.features()));
    if let Some(missing) = missing {
        assert_eq!(other.set_texture_family(&gpu, missing).expect_err("not offered").code(), RenderCode::TextureInvalid);
    }
    other.set_texture_family(&gpu, family).expect("offered");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_device_loss_replays_the_family_and_its_compressed_textures() {
    use genex_render::device_loss::Resilient;
    use genex_render::scene::{CameraDesc, Material, MeshId, translation};
    use genex_render::{CullPath, ImmediateFrame, RenderOptions};
    let Some(gpu) = gpu() else { return };
    let Some(family) = TextureFamily::usable_compressed(gpu.device.features(), false).first().copied() else {
        eprintln!("skipped: no compressed family on this adapter");
        return;
    };
    let format = match family {
        TextureFamily::Bc7 => Format::BC7_SRGB_BLOCK,
        TextureFamily::Astc4x4 => Format::ASTC_4x4_SRGB_BLOCK,
        _ => Format::ETC2_R8G8B8A8_SRGB_BLOCK,
    };
    let bytes = Ktx2::chain(format, 512, 11).bytes();
    let mut resilient = Resilient::new(gpu, 160, 90, RenderOptions::default(), Gpu::headless).expect("resilient");
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let quality = genex_render::presets::preset_quality(QualityPreset::High, class);
    resilient.renderer_mut().renderer_mut().set_quality(&quality);
    assert!(resilient.renderer().renderer().compressed_families().contains(&family), "offered at the high preset");
    resilient.set_texture_family(family).expect("the family");
    let kept = resilient.add_compressed_texture(&read_ktx2(&bytes).expect("chain"), TextureKind::Color).expect("kept");
    let again: genex_render::device_loss::CompressedSource = std::sync::Arc::new(move || read_ktx2(&bytes));
    let sourced = resilient.add_compressed_texture_from(&again().expect("chain"), TextureKind::Color, again).expect("sourced");
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 1.5, 4.0], [0.0, 0.0, 0.0]), [20, 24, 32, 255]);
    frame.mesh(MeshId::CUBE, translation(-0.8, 0.0, 0.0), Material::color([255, 255, 255, 255]).with_base_texture(kept));
    frame.mesh(MeshId::CUBE, translation(0.8, 0.0, 0.0), Material::color([255, 255, 255, 255]).with_base_texture(sourced));
    resilient.render(&frame, CullPath::Gpu, None).expect("frame");
    let before = resilient.capture().expect("capture").digest();
    resilient.force_device_loss();
    assert!(resilient.recover().expect("recovered"));
    assert_eq!(resilient.renderer().renderer().texture_family(), family, "the family comes back before the textures");
    // A recovered renderer starts from the default settings: the caller sets its quality again.
    resilient.renderer_mut().renderer_mut().set_quality(&quality);
    resilient.render(&frame, CullPath::Gpu, None).expect("frame after recovery");
    assert_eq!(resilient.capture().expect("capture").digest(), before, "the compressed textures replay to the same picture");
}
