//! Meshes: the immediate primitives are closed and bounded, and a GLB with an embedded buffer
//! loads; anything else is refused `mesh-invalid` without panicking. A GLB's materials and
//! embedded textures load as one part per material (RQ1.4); an unusable image fails only its
//! texture. The `glb-materials` golden (`tests/fixtures/render-goldens/part1-ext/`) is a Metal row:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test mesh -- --ignored metal

use genex_render::RenderCode;
use genex_render::layout::GpuMeshlet;
use genex_render::mesh::{CUBE_TRIANGLES, GlbMaterial, GlbMeshlets, GlbModel, MeshData, MeshletWarning, SPHERE_TRIANGLES, decode_image};
use genex_render::meshlet::{MeshletFault, MeshletSet, pack_triangle, validate};
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::texture::{TextureId, TextureKind};
use glam::Vec3;
use serde_json::{Value, json};

/// A GLB holding one triangle (u16 indices) and, when `uri` is given, an external buffer instead.
fn glb(uri: Option<&str>, with_normals: bool) -> Vec<u8> {
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 2.0, 0.0];
    let normals: [f32; 9] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0];
    let indices: [u16; 4] = [0, 1, 2, 0];
    let mut bin = Vec::new();
    bin.extend(positions.iter().flat_map(|f| f.to_le_bytes()));
    bin.extend(normals.iter().flat_map(|f| f.to_le_bytes()));
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    let buffer = match uri {
        Some(uri) => format!(r#"{{"byteLength":{},"uri":"{uri}"}}"#, bin.len()),
        None => format!(r#"{{"byteLength":{}}}"#, bin.len()),
    };
    let normal_attr = if with_normals { r#","NORMAL":1"# } else { "" };
    let json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{buffer}],
        "bufferViews":[{{"buffer":0,"byteOffset":0,"byteLength":36}},{{"buffer":0,"byteOffset":36,"byteLength":36}},{{"buffer":0,"byteOffset":72,"byteLength":6}}],
        "accessors":[
          {{"bufferView":0,"componentType":5126,"count":3,"type":"VEC3","min":[0,0,0],"max":[1,2,0]}},
          {{"bufferView":1,"componentType":5126,"count":3,"type":"VEC3"}},
          {{"bufferView":2,"componentType":5123,"count":3,"type":"SCALAR"}}],
        "meshes":[{{"primitives":[{{"attributes":{{"POSITION":0{normal_attr}}},"indices":2}}]}}],
        "nodes":[{{"mesh":0}}],"scenes":[{{"nodes":[0]}}],"scene":0}}"#
    );
    let mut json = json.into_bytes();
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let embed = uri.is_none();
    let total = 12 + 8 + json.len() + if embed { 8 + bin.len() } else { 0 };
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    if embed {
        out.extend((bin.len() as u32).to_le_bytes());
        out.extend(b"BIN\0");
        out.extend(&bin);
    }
    out
}

#[test]
fn the_cube_and_sphere_are_indexed_triangle_lists_with_unit_normals_inside_their_bounds() {
    for (name, mesh) in [("cube", MeshData::cube()), ("sphere", MeshData::sphere())] {
        assert!(!mesh.indices.is_empty() && mesh.indices.len() % 3 == 0, "{name}");
        assert!(mesh.indices.iter().all(|&i| (i as usize) < mesh.vertices.len()), "{name}");
        let (center, radius) = mesh.bounds();
        for v in &mesh.vertices {
            let n = v.normal;
            let length = (n[0] * n[0] + n[1] * n[1] + n[2] * n[2]).sqrt();
            assert!((length - 1.0).abs() < 1e-5, "{name} normal length {length}");
            let d = [v.position[0] - center[0], v.position[1] - center[1], v.position[2] - center[2]];
            assert!((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() <= radius + 1e-5, "{name} vertex outside bounds");
        }
    }
    assert_eq!(MeshData::cube().bounds().0, [0.0, 0.0, 0.0]);
}

#[test]
fn a_glb_with_an_embedded_buffer_loads_its_triangles() {
    let mesh = MeshData::from_glb(&glb(None, true)).expect("a valid GLB");
    assert_eq!(mesh.vertices.len(), 3);
    assert_eq!(mesh.indices, vec![0, 1, 2]);
    assert_eq!(mesh.vertices[2].position, [0.0, 2.0, 0.0]);
    assert_eq!(mesh.vertices[0].normal, [0.0, 0.0, 1.0]);
    let (center, radius) = mesh.bounds();
    assert_eq!(center, [0.5, 1.0, 0.0]);
    assert!((radius - 1.25_f32.sqrt()).abs() < 1e-6);
}

#[test]
fn a_glb_without_normals_gets_face_normals() {
    let mesh = MeshData::from_glb(&glb(None, false)).expect("a valid GLB");
    for v in &mesh.vertices {
        assert_eq!(v.normal, [0.0, 0.0, 1.0]);
    }
}

#[test]
fn hostile_glb_inputs_are_refused_mesh_invalid() {
    let mut truncated = glb(None, true);
    truncated.truncate(truncated.len() - 10);
    let rows: [(&str, Vec<u8>); 5] = [
        ("empty", Vec::new()),
        ("not a glb", b"hello world, not a model".to_vec()),
        ("truncated", truncated),
        ("external buffer", glb(Some("../../etc/passwd"), true)),
        ("data uri buffer", glb(Some("data:application/octet-stream;base64,AAAA"), true)),
    ];
    for (name, bytes) in rows {
        let error = MeshData::from_glb(&bytes).expect_err(name);
        assert_eq!(error.code(), RenderCode::MeshInvalid, "{name}");
        assert_eq!(error.code().wire(), "mesh-invalid");
    }
}

/// A one-triangle GLB whose accessors take the given component type, type and `normalized` flag
/// (position, normal, uv, then indices); every view holds 64 zero bytes, enough for any layout.
fn glb_with_layouts(layouts: [(u32, &str, bool); 4]) -> Vec<u8> {
    let accessors: Vec<Value> = layouts
        .iter()
        .enumerate()
        .map(|(view, (component, kind, normalized))| {
            let mut accessor = json!({"bufferView": view, "componentType": component, "count": 3, "type": kind});
            if *normalized {
                accessor["normalized"] = json!(true);
            }
            if view == 0 {
                accessor["min"] = json!([0, 0, 0]);
                accessor["max"] = json!([1, 1, 1]);
            }
            accessor
        })
        .collect();
    let views: Vec<Value> = (0..4).map(|at| json!({"buffer": 0, "byteOffset": at * 64, "byteLength": 64})).collect();
    let document = json!({
        "bufferViews": views,
        "accessors": accessors,
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2}, "indices": 3}]}],
        "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0
    });
    glb_of(document, vec![0u8; 256])
}

/// Component types (glTF accessor `componentType`).
const BYTE: u32 = 5120;
const UNSIGNED_BYTE: u32 = 5121;
const SHORT: u32 = 5122;
const UNSIGNED_SHORT: u32 = 5123;
const UNSIGNED_INT: u32 = 5125;
const FLOAT: u32 = 5126;

#[test]
fn accessor_layouts_the_reader_would_misread_or_panic_on_are_refused_mesh_invalid_naming_the_attribute() {
    // gltf-rs #478: the reader trusts the accessor's layout. A quantized attribute
    // (KHR_mesh_quantization) is the import step's to dequantize; here it is refused, never read.
    let plain = [(FLOAT, "VEC3", false), (FLOAT, "VEC3", false), (FLOAT, "VEC2", false), (UNSIGNED_SHORT, "SCALAR", false)];
    let rows: [(&str, usize, (u32, &str, bool)); 7] = [
        ("POSITION", 0, (UNSIGNED_SHORT, "VEC3", false)),
        ("POSITION", 0, (FLOAT, "VEC2", false)),
        ("NORMAL", 1, (BYTE, "VEC3", true)),
        ("TEXCOORD_0", 2, (SHORT, "VEC2", false)),
        ("TEXCOORD_0", 2, (UNSIGNED_INT, "VEC2", false)),
        ("TEXCOORD_0", 2, (UNSIGNED_SHORT, "VEC2", false)),
        ("indices", 3, (FLOAT, "SCALAR", false)),
    ];
    assert!(MeshData::from_glb(&glb_with_layouts(plain)).is_ok(), "the float layout loads");
    for (name, at, layout) in rows {
        let mut layouts = plain;
        layouts[at] = layout;
        let what = format!("{name} as {layout:?}");
        let error = MeshData::from_glb(&glb_with_layouts(layouts)).expect_err(&what);
        assert_eq!(error.code(), RenderCode::MeshInvalid, "{what}");
        assert!(error.to_string().contains(name), "{what}: {error}");
    }
    let mut normalized_uv = plain;
    normalized_uv[2] = (UNSIGNED_BYTE, "VEC2", true);
    assert!(MeshData::from_glb(&glb_with_layouts(normalized_uv)).is_ok(), "core glTF's normalized u8 uvs load");
}

/// The repository's asset-import fixtures.
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

#[test]
fn gltfpacks_quantized_suzanne_loads_once_the_import_step_dequantized_it() {
    // `quantized.glb` is gltfpack 1.3.0's output; `quantized.plain.glb` is the import step's
    // (`tests/conformance/rust-assets.test.ts` holds it to `normalizeGltf`).
    let error = MeshData::from_glb(&import_fixture("quantized.glb")).expect_err("the runtime does not read KHR_mesh_quantization");
    assert_eq!(error.code(), RenderCode::MeshInvalid);
    let mesh = MeshData::from_glb(&import_fixture("quantized.plain.glb")).expect("the dequantized GLB loads");
    assert_eq!(mesh.indices.len(), 968 * 3);
    let (min, max) = mesh.vertices.iter().fold(([f32::MAX; 3], [f32::MIN; 3]), |(lo, hi), v| {
        (std::array::from_fn(|c| lo[c].min(v.position[c])), std::array::from_fn(|c| hi[c].max(v.position[c])))
    });
    // Blender's Suzanne: ±1.367 wide, 0.984 tall above and below her centre, placed by the node's scale.
    for (c, (lo, hi)) in [(-1.367, 1.367), (-0.984, 0.984), (-0.852, 0.852)].into_iter().enumerate() {
        assert!((min[c] - lo).abs() < 2e-3 && (max[c] - hi).abs() < 2e-3, "axis {c}: {min:?} {max:?}");
    }
    let model = GlbModel::from_glb(&import_fixture("quantized.plain.glb")).expect("its material and texture load");
    let [part] = model.parts() else { panic!("one material, one part") };
    let texture = part.material.and_then(|m| m.base_texture).expect("a base-colour texture");
    assert!(matches!(model.image(texture), Some(Ok(_))), "the embedded checker decodes");
    assert!(part.mesh.vertices.iter().all(|v| v.uv.iter().all(|t| (-0.01..=1.01).contains(t))), "uvs in 0..1 once the transform is baked");
}

// ---------------------------------------------------------------------------------------------
// GLB materials and embedded textures (RQ1.4)

/// A PNG of `width` × `height` RGBA8 pixels: stored (uncompressed) deflate, so the test needs no
/// encoder crate.
fn png(width: u32, height: u32, rgba: &[u8]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
        let mut crc = !0u32;
        for &byte in bytes {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = if crc & 1 == 1 { (crc >> 1) ^ 0xEDB8_8320 } else { crc >> 1 };
            }
        }
        !crc
    }
    fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
        out.extend((data.len() as u32).to_be_bytes());
        let mut body = kind.to_vec();
        body.extend(data);
        out.extend(&body);
        out.extend(crc32(&body).to_be_bytes());
    }
    let mut raw = Vec::new();
    for row in rgba.chunks((width * 4) as usize) {
        raw.push(0);
        raw.extend(row);
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(65_535).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        let len = block.len() as u16;
        zlib.extend(len.to_le_bytes());
        zlib.extend((!len).to_le_bytes());
        zlib.extend(*block);
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &byte in &raw {
        a = (a + u32::from(byte)) % 65_521;
        b = (b + a) % 65_521;
    }
    zlib.extend(((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend(width.to_be_bytes());
    ihdr.extend(height.to_be_bytes());
    ihdr.extend([8, 6, 0, 0, 0]);
    let mut out = b"\x89PNG\r\n\x1a\n".to_vec();
    chunk(&mut out, b"IHDR", &ihdr);
    chunk(&mut out, b"IDAT", &zlib);
    chunk(&mut out, b"IEND", &[]);
    out
}

/// A `size`-square image whose every pixel is `f(x, y)`.
fn pixels(size: u32, f: impl Fn(u32, u32) -> [u8; 4]) -> Vec<u8> {
    (0..size).flat_map(|y| (0..size).map(move |x| (x, y))).flat_map(|(x, y)| f(x, y)).collect()
}

/// A GLB from its JSON (buffer 0 is the BIN chunk, its length filled in) and BIN chunk.
fn glb_of(mut gltf: Value, mut bin: Vec<u8>) -> Vec<u8> {
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    gltf["asset"] = json!({ "version": "2.0" });
    gltf["buffers"] = json!([{ "byteLength": bin.len() }]);
    let mut json = serde_json::to_vec(&gltf).expect("json");
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
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

/// A unit quad in the XY plane (two triangles, uvs) facing +Z, and the images appended after it:
/// the BIN chunk, the quad's accessors and buffer views, and one buffer view per image.
fn quad_with_images(images: &[Vec<u8>]) -> (Vec<u8>, Value, Value) {
    let positions: [f32; 12] = [-0.5, -0.5, 0.0, 0.5, -0.5, 0.0, 0.5, 0.5, 0.0, -0.5, 0.5, 0.0];
    let uvs: [f32; 8] = [0.0, 1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0];
    let indices: [u16; 6] = [0, 1, 2, 0, 2, 3];
    let mut bin = Vec::new();
    bin.extend(positions.iter().flat_map(|f| f.to_le_bytes()));
    bin.extend(uvs.iter().flat_map(|f| f.to_le_bytes()));
    bin.extend(indices.iter().flat_map(|i| i.to_le_bytes()));
    let mut views = vec![
        json!({ "buffer": 0, "byteOffset": 0, "byteLength": 48 }),
        json!({ "buffer": 0, "byteOffset": 48, "byteLength": 32 }),
        json!({ "buffer": 0, "byteOffset": 80, "byteLength": 12 }),
    ];
    for image in images {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": image.len() }));
        bin.extend(image);
    }
    let accessors = json!([
        { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-0.5, -0.5, 0.0], "max": [0.5, 0.5, 0.0] },
        { "bufferView": 1, "componentType": 5126, "count": 4, "type": "VEC2" },
        { "bufferView": 2, "componentType": 5123, "count": 6, "type": "SCALAR" },
    ]);
    (bin, accessors, Value::Array(views))
}

/// A GLB with one quad mesh drawn once per entry of `materials` (a primitive each; `None` names
/// no material), the `materials`, and `images` embedded as PNG buffer views with one texture each.
fn material_glb(materials: Value, primitive_materials: &[Option<u32>], images: &[Vec<u8>]) -> Vec<u8> {
    let (bin, accessors, views) = quad_with_images(images);
    let primitives: Vec<Value> = primitive_materials
        .iter()
        .map(|material| {
            let mut primitive = json!({ "attributes": { "POSITION": 0, "TEXCOORD_0": 1 }, "indices": 2 });
            if let Some(material) = material {
                primitive["material"] = json!(material);
            }
            primitive
        })
        .collect();
    let image_rows: Vec<Value> = (0..images.len()).map(|i| json!({ "bufferView": 3 + i, "mimeType": "image/png" })).collect();
    let textures: Vec<Value> = (0..images.len()).map(|i| json!({ "source": i })).collect();
    let mut gltf = json!({
        "bufferViews": views,
        "accessors": accessors,
        "meshes": [{ "primitives": primitives }],
        "nodes": [{ "mesh": 0 }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
        "materials": materials,
    });
    if !images.is_empty() {
        gltf["images"] = Value::Array(image_rows);
        gltf["textures"] = Value::Array(textures);
    }
    glb_of(gltf, bin)
}

/// The metallic-roughness map of the red GLB: green roughness rising left to right, blue metal.
fn mr_pixels() -> Vec<u8> {
    pixels(4, |x, _| [0, (x * 60) as u8, 200, 255])
}

/// A GLB whose one material is a red base-colour factor with a metallic-roughness texture.
fn red_mr_glb() -> Vec<u8> {
    let materials = json!([{
        "pbrMetallicRoughness": {
            "baseColorFactor": [1.0, 0.0, 0.0, 1.0],
            "metallicFactor": 0.25,
            "roughnessFactor": 0.8,
            "metallicRoughnessTexture": { "index": 0 }
        }
    }]);
    material_glb(materials, &[Some(0)], &[png(4, 4, &mr_pixels())])
}

#[test]
fn a_glb_with_a_red_base_colour_and_a_metallic_roughness_texture_yields_that_material() {
    let model = GlbModel::from_glb(&red_mr_glb()).expect("a valid GLB");
    assert_eq!(model.parts().len(), 1);
    let material = model.parts()[0].material.expect("the primitive names material 0");
    assert_eq!(
        material,
        GlbMaterial {
            base_color: [1.0, 0.0, 0.0, 1.0],
            metallic: 0.25,
            roughness: 0.8,
            normal_scale: 1.0,
            base_texture: None,
            normal_texture: None,
            metal_rough_texture: Some(0),
            alpha_cutoff: None,
            double_sided: false,
            occlusion_texture: None,
            occlusion_strength: 1.0,
        }
    );
    let texture = model.image(0).expect("image 0 is used").as_ref().expect("the PNG decodes");
    assert_eq!((texture.width(), texture.height()), (4, 4));
    assert_eq!(texture.rgba(), &mr_pixels()[..]);
    // The renderer's material: the file's factors, not the facade's old 0.55 for everything.
    let mr = TextureId::new(TextureKind::Data, 3);
    let drawn = material.map_textures(|_, kind| (kind == TextureKind::Data).then_some(mr)).to_material([255; 4]);
    assert_eq!(drawn.base_color, [255, 0, 0, 255]);
    assert_eq!((drawn.metallic, drawn.roughness), (0.25, 0.8));
    assert_eq!(drawn.metal_rough_texture, Some(mr));
    assert_eq!((drawn.base_texture, drawn.normal_texture), (None, None));
    let tinted = material.map_textures(|_, _| None::<TextureId>).to_material([255, 255, 255, 128]);
    assert_eq!(tinted.base_color, [255, 0, 0, 128], "a tint multiplies the factor, alpha included");
}

#[test]
fn each_material_of_a_glb_is_its_own_part_and_a_glb_without_materials_is_one_part_like_from_glb() {
    let materials = json!([
        { "pbrMetallicRoughness": { "baseColorFactor": [0.0, 1.0, 0.0, 1.0] } },
        { "pbrMetallicRoughness": { "baseColorFactor": [0.0, 0.0, 1.0, 0.5] }, "alphaMode": "BLEND" },
        { "pbrMetallicRoughness": { "baseColorFactor": [1.0, 1.0, 1.0, 0.5] } }
    ]);
    let bytes = material_glb(materials, &[Some(0), Some(1), Some(0), None, Some(2)], &[]);
    let model = GlbModel::from_glb(&bytes).expect("a valid GLB");
    let parts = model.parts();
    let colours: Vec<Option<[f32; 4]>> = parts.iter().map(|part| part.material.map(|m| m.base_color)).collect();
    assert_eq!(
        colours,
        [Some([0.0, 1.0, 0.0, 1.0]), Some([0.0, 0.0, 1.0, 0.5]), None, Some([1.0, 1.0, 1.0, 1.0])],
        "parts in first-use order; only BLEND keeps its alpha (OPAQUE and MASK draw opaque)"
    );
    let triangles: Vec<usize> = parts.iter().map(|part| part.mesh.indices.len() / 3).collect();
    assert_eq!(triangles, [4, 2, 2, 2], "material 0's two primitives share one part");
    let whole = MeshData::from_glb(&bytes).expect("the same GLB as one mesh");
    assert_eq!(triangles.iter().sum::<usize>(), whole.indices.len() / 3);

    let plain = glb(None, true);
    let model = GlbModel::from_glb(&plain).expect("a GLB without materials");
    assert_eq!(model.parts().len(), 1);
    assert_eq!(model.parts()[0].material, None);
    assert_eq!(model.parts()[0].mesh, MeshData::from_glb(&plain).expect("mesh"), "the one part is from_glb's mesh, bit for bit");
}

#[test]
fn a_texture_on_another_uv_set_is_ignored_and_the_material_keeps_its_factors() {
    let materials = json!([{
        "pbrMetallicRoughness": { "baseColorTexture": { "index": 0, "texCoord": 1 }, "roughnessFactor": 0.3 },
        "normalTexture": { "index": 0, "scale": 0.5 }
    }]);
    let model = GlbModel::from_glb(&material_glb(materials, &[Some(0)], &[png(2, 2, &pixels(2, |_, _| [128, 128, 255, 255]))]))
        .expect("a valid GLB");
    let material = model.parts()[0].material.expect("material");
    assert_eq!(material.base_texture, None, "only TEXCOORD_0 is read");
    assert_eq!((material.normal_texture, material.normal_scale), (Some(0), 0.5));
    assert_eq!((material.metallic, material.roughness), (1.0, 0.3), "glTF's defaults for what the file leaves out");
}

/// Hostile embedded images: each makes its texture unusable (the material draws untextured), never
/// the whole model, never a panic, and no file outside the GLB is read.
#[test]
fn hostile_embedded_images_refuse_only_their_texture() {
    let mut huge = png(4, 4, &mr_pixels());
    huge[16..20].copy_from_slice(&100_000u32.to_be_bytes());
    huge[20..24].copy_from_slice(&100_000u32.to_be_bytes());
    let mut truncated = png(4, 4, &mr_pixels());
    truncated.truncate(truncated.len() / 2);
    let rows: [(&str, Vec<u8>, &str); 4] = [
        ("declares 100000 px", huge, "texture-too-large"),
        ("truncated PNG", truncated, "texture-invalid"),
        ("not an image", b"definitely not a png or a jpeg".to_vec(), "texture-invalid"),
        ("empty", Vec::new(), "texture-invalid"),
    ];
    let materials = json!([{ "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 } } }]);
    for (name, image, code) in rows {
        let model = GlbModel::from_glb(&material_glb(materials.clone(), &[Some(0)], &[image])).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(model.parts().len(), 1, "{name}: the mesh still loads");
        let error = model.image(0).expect("image 0 is used").as_ref().expect_err(name);
        assert_eq!(error.code().wire(), code, "{name}");
    }
    // An image by URI (a file beside the GLB, or a data URI) is never read: only embedded views.
    for uri in ["../../etc/passwd", "texture.png", "data:image/png;base64,AAAA"] {
        let (bin, accessors, views) = quad_with_images(&[]);
        let gltf = json!({
            "bufferViews": views, "accessors": accessors,
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0, "TEXCOORD_0": 1 }, "indices": 2, "material": 0 }] }],
            "nodes": [{ "mesh": 0 }], "scenes": [{ "nodes": [0] }], "scene": 0,
            "materials": [{ "pbrMetallicRoughness": { "baseColorTexture": { "index": 0 } } }],
            "images": [{ "uri": uri }], "textures": [{ "source": 0 }],
        });
        let model = GlbModel::from_glb(&glb_of(gltf, bin)).unwrap_or_else(|e| panic!("{uri}: {e}"));
        let error = model.image(0).expect("image 0 is used").as_ref().expect_err(uri);
        assert_eq!(error.code().wire(), "texture-invalid", "{uri}");
    }
}

#[test]
fn decode_image_reads_png_and_answers_rgba8() {
    let rgba = pixels(3, |x, y| [x as u8 * 80, y as u8 * 80, 7, 200]);
    let texture = decode_image(&png(3, 3, &rgba)).expect("a PNG");
    assert_eq!((texture.width(), texture.height(), texture.rgba()), (3, 3, &rgba[..]));
}

#[test]
fn the_primitive_triangle_counts_match_the_meshes() {
    assert_eq!(CUBE_TRIANGLES as usize, MeshData::cube().indices.len() / 3);
    assert_eq!(SPHERE_TRIANGLES as usize, MeshData::sphere().indices.len() / 3);
}

// ---------------------------------------------------------------------------------------------
// Import-time meshlets: `extras.genex_meshlets` (R2.3)

/// Quads per meshlet and meshlets of the ladder: 2 x 21 vertices and 40 triangles each.
const LADDER_QUADS: u32 = 20;
const LADDER_MESHLETS: u32 = 3;

/// A ladder (a strip of quads, two vertices per column) and the meshlets the importer would write
/// for it: each meshlet covers `LADDER_QUADS` quads and repeats the shared edge's two vertices.
struct Ladder {
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
    set: MeshletSet,
}

fn ladder() -> Ladder {
    let quads = LADDER_QUADS * LADDER_MESHLETS;
    let positions = (0..=quads).flat_map(|i| [[i as f32, 0.0, 0.0], [i as f32, 1.0, 0.0]]).collect();
    let mut indices = Vec::new();
    for q in 0..quads {
        let v = 2 * q;
        indices.extend([v, v + 1, v + 2, v + 1, v + 3, v + 2]);
    }
    let mut set = MeshletSet::default();
    for m in 0..LADDER_MESHLETS {
        let first_vertex = 2 * LADDER_QUADS * m;
        set.meshlets.push(GpuMeshlet {
            bounds: [(LADDER_QUADS * m + LADDER_QUADS / 2) as f32, 0.5, 0.0, 11.0],
            cone: [0.0, 0.0, 1.0, 0.087],
            vertex_offset: set.vertices.len() as u32,
            triangle_offset: set.triangles.len() as u32,
            vertex_count: 2 * LADDER_QUADS + 2,
            triangle_count: 2 * LADDER_QUADS,
        });
        set.vertices.extend(first_vertex..first_vertex + 2 * LADDER_QUADS + 2);
        for q in 0..LADDER_QUADS {
            let v = (2 * q) as u8;
            set.triangles.extend([pack_triangle([v, v + 1, v + 2]), pack_triangle([v + 1, v + 3, v + 2])]);
        }
    }
    Ladder { positions, indices, set }
}

fn floats(values: impl IntoIterator<Item = f32>) -> Vec<u8> {
    values.into_iter().flat_map(f32::to_le_bytes).collect()
}

fn words(values: &[u32]) -> Vec<u8> {
    values.iter().flat_map(|v| v.to_le_bytes()).collect()
}

/// The GLB of `ladder` with its `set` in the extras' three views (3, 4, 5 after the positions, the
/// u32 indices and ... views 2, 3, 4); `edit` may change the extras object and the view bytes.
struct Edit<'a> {
    extras: &'a mut Value,
    meshlets: &'a mut Vec<u8>,
    vertices: &'a mut Vec<u8>,
    triangles: &'a mut Vec<u8>,
}

fn ladder_glb(ladder: &Ladder, edit: impl FnOnce(Edit<'_>)) -> Vec<u8> {
    let mut meshlets: Vec<u8> = bytemuck::cast_slice(&ladder.set.meshlets).to_vec();
    let mut vertices = words(&ladder.set.vertices);
    let mut triangles = words(&ladder.set.triangles);
    let mut extras = json!({ "genex_meshlets": { "version": 1, "max_vertices": 64, "max_triangles": 124, "meshlets": 2, "vertices": 3, "triangles": 4 } });
    edit(Edit { extras: &mut extras, meshlets: &mut meshlets, vertices: &mut vertices, triangles: &mut triangles });
    let positions = floats(ladder.positions.iter().flatten().copied());
    let indices = words(&ladder.indices);
    let mut bin = Vec::new();
    let mut views = Vec::new();
    for part in [&positions, &indices, &meshlets, &vertices, &triangles] {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": part.len() }));
        bin.extend(part);
    }
    let gltf = json!({
        "bufferViews": views,
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": ladder.positions.len(), "type": "VEC3", "min": [0, 0, 0], "max": [60, 1, 0] },
            { "bufferView": 1, "componentType": 5125, "count": ladder.indices.len(), "type": "SCALAR" }],
        "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "indices": 1, "extras": extras }] }],
        "nodes": [{ "mesh": 0 }], "scenes": [{ "nodes": [0] }], "scene": 0,
    });
    glb_of(gltf, bin)
}

#[test]
fn a_glb_carrying_valid_meshlets_hands_them_over_validated() {
    let ladder = ladder();
    let (mesh, meshlets) = MeshData::from_glb_with_meshlets(&ladder_glb(&ladder, |_| {})).expect("the GLB loads");
    assert!(meshlets.warnings.is_empty());
    let set = meshlets.set.expect("the extras are used");
    assert_eq!(set, ladder.set, "a single primitive at the origin keeps the importer's set as it is");
    assert_eq!(mesh.indices, ladder.indices);
    assert_eq!(validate(&set, &mesh.indices, mesh.vertices.len() as u32), Ok(()));
}

#[test]
fn a_glb_without_the_extras_has_no_set_and_no_warning() {
    let (_, meshlets) = MeshData::from_glb_with_meshlets(&glb(None, true)).expect("a valid GLB");
    assert_eq!(meshlets, GlbMeshlets::default(), "the runtime clusterizer takes over without a word");
    let ladder = ladder();
    let plain = ladder_glb(&ladder, |edit| *edit.extras = json!({ "author": "someone", "tags": [1, 2] }));
    let (_, meshlets) = MeshData::from_glb_with_meshlets(&plain).expect("other extras are not ours");
    assert_eq!(meshlets, GlbMeshlets::default());
    let array = ladder_glb(&ladder, |edit| *edit.extras = json!([1, 2, 3]));
    assert_eq!(MeshData::from_glb_with_meshlets(&array).expect("array extras").1, GlbMeshlets::default());
}

/// A refusal row: its name, the fault it is refused with and the edit that makes the extras hostile.
type HostileRow = (&'static str, MeshletFault, Box<dyn Fn(Edit<'_>)>);

/// Every refusal row: the edit that makes the extras hostile and the fault it is refused with.
fn hostile_rows() -> Vec<HostileRow> {
    let edit_record = |change: fn(&mut GpuMeshlet)| -> Box<dyn Fn(Edit<'_>)> {
        Box::new(move |edit| {
            let records: &mut [GpuMeshlet] = bytemuck::cast_slice_mut(edit.meshlets.as_mut_slice());
            change(&mut records[1]);
        })
    };
    vec![
        ("a vertex index past the mesh", MeshletFault::VertexOutOfMesh, Box::new(|edit| edit.vertices[4..8].copy_from_slice(&9999u32.to_le_bytes()))),
        ("200 triangles in one meshlet", MeshletFault::OverLimit, edit_record(|m| m.triangle_count = 200)),
        ("no triangles in a meshlet", MeshletFault::OverLimit, edit_record(|m| m.triangle_count = 0)),
        ("65 vertices in a meshlet", MeshletFault::OverLimit, edit_record(|m| m.vertex_count = 65)),
        ("a range past the triangle buffer", MeshletFault::RangeOutOfBounds, edit_record(|m| m.triangle_offset = 119)),
        ("a range at the end of u32", MeshletFault::RangeOutOfBounds, edit_record(|m| m.vertex_offset = u32::MAX)),
        ("overlapping ranges", MeshletFault::RangesNotTiled, edit_record(|m| m.vertex_offset -= 1)),
        ("a gap between ranges", MeshletFault::RangesNotTiled, edit_record(|m| m.triangle_offset += 1)),
        ("a local index past the meshlet", MeshletFault::LocalIndexOutOfMeshlet, Box::new(|edit| edit.triangles[0..4].copy_from_slice(&pack_triangle([0, 1, 60]).to_le_bytes()))),
        ("a fourth byte in a packed triangle", MeshletFault::LocalIndexOutOfMeshlet, Box::new(|edit| edit.triangles[3] = 1)),
        ("a flipped winding", MeshletFault::TrianglesDiffer, Box::new(|edit| edit.triangles[0..4].copy_from_slice(&pack_triangle([0, 2, 1]).to_le_bytes()))),
        ("a triangle twice and another never", MeshletFault::TrianglesDiffer, Box::new(|edit| {
            let first: [u8; 4] = edit.triangles[0..4].try_into().expect("a word");
            edit.triangles[4..8].copy_from_slice(&first);
        })),
        ("a triangle buffer shorter than its last range", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.triangles.truncate(edit.triangles.len() - 4))),
        ("the last meshlet missing from the table", MeshletFault::RangesNotTiled, Box::new(|edit| edit.meshlets.truncate(edit.meshlets.len() - size_of::<GpuMeshlet>()))),
        ("an unknown version", MeshletFault::UnknownVersion, Box::new(|edit| edit.extras["genex_meshlets"]["version"] = json!(2))),
        ("no version", MeshletFault::UnknownVersion, Box::new(|edit| drop(edit.extras["genex_meshlets"].as_object_mut().expect("object").remove("version")))),
        ("a vertex limit past 64", MeshletFault::OverLimit, Box::new(|edit| edit.extras["genex_meshlets"]["max_vertices"] = json!(65))),
        ("a triangle limit of 0", MeshletFault::OverLimit, Box::new(|edit| edit.extras["genex_meshlets"]["max_triangles"] = json!(0))),
        ("a buffer view that does not exist", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.extras["genex_meshlets"]["vertices"] = json!(99))),
        ("a view index that is not a number", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.extras["genex_meshlets"]["triangles"] = json!("four"))),
        ("a negative view index", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.extras["genex_meshlets"]["meshlets"] = json!(-1))),
        ("meshlet records that are not whole", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.meshlets.truncate(edit.meshlets.len() - 1))),
        ("vertex ids that are not whole words", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.vertices.truncate(edit.vertices.len() - 2))),
        ("a meshlet table pointing at the positions", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.extras["genex_meshlets"]["meshlets"] = json!(0))),
        ("NaN bounds", MeshletFault::RangeOutOfBounds, edit_record(|m| m.bounds[3] = f32::NAN)),
        ("a negative radius", MeshletFault::RangeOutOfBounds, edit_record(|m| m.bounds[3] = -1.0)),
        ("an infinite cone axis", MeshletFault::RangeOutOfBounds, edit_record(|m| m.cone[0] = f32::INFINITY)),
        ("a cone cutoff past 1", MeshletFault::RangeOutOfBounds, edit_record(|m| m.cone[3] = 2.0)),
        ("the meshlets member not an object", MeshletFault::RangeOutOfBounds, Box::new(|edit| edit.extras["genex_meshlets"] = json!(7))),
    ]
}

#[test]
fn hostile_meshlet_extras_are_refused_with_a_typed_warning_and_the_mesh_still_loads() {
    let ladder = ladder();
    let plain = MeshData::from_glb(&ladder_glb(&ladder, |edit| *edit.extras = json!({}))).expect("the mesh alone");
    for (name, fault, edit) in hostile_rows() {
        let glb = ladder_glb(&ladder, edit);
        let (mesh, meshlets) = MeshData::from_glb_with_meshlets(&glb).unwrap_or_else(|e| panic!("{name}: the mesh must still load: {e}"));
        assert_eq!(meshlets.set, None, "{name}: no set is handed over");
        assert_eq!(meshlets.warnings, vec![MeshletWarning { primitive: 0, fault }], "{name}");
        assert_eq!(mesh, plain, "{name}: the mesh is the one without extras, bit for bit");
        assert!(fault.wire().starts_with("meshlets-"), "{name}: a typed wire code");
    }
}

/// A node placing the ladder's mesh: translated, scaled, in a scene of two nodes using one mesh.
fn placed_glb(ladder: &Ladder, nodes: Value) -> Vec<u8> {
    let glb = ladder_glb(ladder, |_| {});
    // Re-read the GLB's JSON, swap its nodes and scene, and write it back.
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("len")) as usize;
    let mut gltf: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    let count = nodes.as_array().expect("nodes").len();
    gltf["nodes"] = nodes;
    gltf["scenes"] = json!([{ "nodes": (0..count).collect::<Vec<_>>() }]);
    let bin = glb[20 + json_len + 8..].to_vec();
    glb_of(gltf, bin)
}

#[test]
fn placed_meshlets_follow_their_node_and_two_nodes_of_one_mesh_merge_with_rebased_ids() {
    let ladder = ladder();
    let glb = placed_glb(
        &ladder,
        json!([
            { "mesh": 0, "translation": [100.0, 0.0, 0.0], "scale": [2.0, 2.0, 2.0] },
            { "mesh": 0, "translation": [0.0, 50.0, 0.0] }]),
    );
    let (mesh, meshlets) = MeshData::from_glb_with_meshlets(&glb).expect("the GLB");
    assert!(meshlets.warnings.is_empty());
    let set = meshlets.set.expect("both placements are covered");
    assert_eq!(set.meshlets.len(), 2 * LADDER_MESHLETS as usize);
    assert_eq!(validate(&set, &mesh.indices, mesh.vertices.len() as u32), Ok(()), "against the merged mesh");
    let first = set.meshlets[0];
    assert_eq!(first.bounds, [100.0 + 2.0 * 10.0, 1.0, 0.0, 22.0], "centre placed, radius scaled");
    assert_eq!(first.cone, [0.0, 0.0, 1.0, 0.087], "a uniform scale keeps the cone");
    let second = set.meshlets[LADDER_MESHLETS as usize];
    assert_eq!(second.bounds, [10.0, 50.5, 0.0, 11.0]);
    assert!(set.vertices[ladder.set.vertices.len()..].iter().all(|v| *v >= ladder.positions.len() as u32), "the second placement indexes its own vertices");
}

#[test]
fn a_stretched_or_mirrored_node_drops_the_cone_and_keeps_the_sphere_conservative() {
    let ladder = ladder();
    for (name, scale) in [("stretched", [1.0, 4.0, 1.0]), ("mirrored", [-1.0, 1.0, 1.0])] {
        let glb = placed_glb(&ladder, json!([{ "mesh": 0, "scale": scale }]));
        let (mesh, meshlets) = MeshData::from_glb_with_meshlets(&glb).expect(name);
        let set = meshlets.set.unwrap_or_else(|| panic!("{name}: still used"));
        for meshlet in &set.meshlets {
            assert_eq!(meshlet.cone[3], 1.0, "{name}: no cone survives a transform that is not a rotation and uniform scale");
            let [cx, cy, cz, radius] = meshlet.bounds;
            let inside = |index: u32| {
                let p = mesh.vertices[index as usize].position;
                Vec3::from(p).distance(Vec3::new(cx, cy, cz)) <= radius + 1e-3
            };
            let first = meshlet.vertex_offset as usize;
            assert!(set.vertices[first..first + meshlet.vertex_count as usize].iter().all(|v| inside(*v)), "{name}: every vertex is inside its sphere");
        }
    }
}

#[test]
fn a_mesh_with_a_primitive_lacking_the_extras_uses_none_and_a_refused_one_names_its_primitive() {
    let ladder = ladder();
    let glb = ladder_glb(&ladder, |_| {});
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("len")) as usize;
    let mut gltf: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    let bin = glb[20 + json_len + 8..].to_vec();
    let carrying = gltf["meshes"][0]["primitives"][0].clone();
    let mut bare = carrying.clone();
    bare.as_object_mut().expect("object").remove("extras");
    gltf["meshes"][0]["primitives"] = json!([carrying.clone(), bare.clone()]);
    let (_, meshlets) = MeshData::from_glb_with_meshlets(&glb_of(gltf.clone(), bin.clone())).expect("mixed");
    assert_eq!(meshlets, GlbMeshlets::default(), "a primitive without them: the runtime clusters the whole mesh");
    let mut refused = carrying.clone();
    refused["extras"]["genex_meshlets"]["version"] = json!(9);
    gltf["meshes"][0]["primitives"] = json!([bare, refused]);
    let (_, meshlets) = MeshData::from_glb_with_meshlets(&glb_of(gltf, bin)).expect("mixed with a refusal");
    assert_eq!(meshlets.set, None);
    assert_eq!(meshlets.warnings, vec![MeshletWarning { primitive: 1, fault: MeshletFault::UnknownVersion }]);
}

/// R2.6: a model's parts carry the meshlets their primitives brought, so the facade's model load
/// hands the importer's clusters to the renderer (one part: exactly `from_glb_with_meshlets`'s set;
/// one part per material: each part its own primitives' set); none without or with refused extras.
#[test]
fn a_glb_models_parts_carry_the_meshlets_their_primitives_brought() {
    let ladder = ladder();
    let model = GlbModel::from_glb(&ladder_glb(&ladder, |_| {})).expect("the model");
    assert_eq!(model.parts().len(), 1);
    assert_eq!(model.parts()[0].meshlets.as_ref(), Some(&ladder.set), "one part: the importer's set as it is");
    let plain = GlbModel::from_glb(&ladder_glb(&ladder, |edit| *edit.extras = json!({}))).expect("no extras");
    assert_eq!(plain.parts()[0].meshlets, None, "no extras: the runtime clusters");
    for (name, _, edit) in hostile_rows() {
        let model = GlbModel::from_glb(&ladder_glb(&ladder, edit)).unwrap_or_else(|e| panic!("{name}: the model must still load: {e}"));
        assert_eq!(model.parts()[0].meshlets, None, "{name}: a refused set is never handed over");
    }

    let glb = ladder_glb(&ladder, |_| {});
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("len")) as usize;
    let mut gltf: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    let bin = glb[20 + json_len + 8..].to_vec();
    let carrying = gltf["meshes"][0]["primitives"][0].clone();
    let (mut first, mut second) = (carrying.clone(), carrying);
    first["material"] = json!(0);
    second["material"] = json!(1);
    gltf["materials"] = json!([{ "name": "a" }, { "name": "b" }]);
    gltf["meshes"][0]["primitives"] = json!([first, second.clone()]);
    let two = GlbModel::from_glb(&glb_of(gltf.clone(), bin.clone())).expect("two materials");
    assert_eq!(two.parts().len(), 2);
    for part in two.parts() {
        assert_eq!(part.meshlets.as_ref(), Some(&ladder.set), "each part keeps its own primitive's set");
    }
    let mut bare = second;
    bare.as_object_mut().expect("object").remove("extras");
    let (mut first, _) = (gltf["meshes"][0]["primitives"][0].clone(), ());
    first["material"] = json!(0);
    gltf["meshes"][0]["primitives"] = json!([first, bare]);
    let mixed = GlbModel::from_glb(&glb_of(gltf, bin)).expect("one part without extras");
    assert_eq!(mixed.parts()[0].meshlets.as_ref(), Some(&ladder.set), "the carrying part keeps its set");
    assert_eq!(mixed.parts()[1].meshlets, None, "the part without extras clusters at runtime");
}

// ---------------------------------------------------------------------------------------------
// The glb-materials golden (GPU)

const GOLDEN_WIDTH: u32 = 128;
const GOLDEN_HEIGHT: u32 = 72;
/// A golden pixel may differ by this much per channel (another Apple GPU family rounds differently).
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
/// Pixels allowed beyond the channel tolerance (rasterization on edges), of 9216.
const GOLDEN_OUTLIER_PIXELS: usize = 46;

fn golden_path(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(format!("../../../../tests/fixtures/render-goldens/part1-ext/{name}.bgra"))
}

/// A GLB with three materials on three quads: a red rough dielectric, a gold metal with a
/// roughness ramp, and a checker base-colour texture tinted blue-white.
fn showcase_glb() -> Vec<u8> {
    let checker = pixels(8, |x, y| if (x / 2 + y / 2) % 2 == 0 { [250, 250, 250, 255] } else { [40, 40, 40, 255] });
    let ramp = pixels(8, |x, _| [0, (x * 32) as u8, 255, 255]);
    let materials = json!([
        { "pbrMetallicRoughness": { "baseColorFactor": [0.9, 0.05, 0.05, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.9 } },
        { "pbrMetallicRoughness": { "baseColorFactor": [1.0, 0.75, 0.3, 1.0], "metallicFactor": 1.0, "roughnessFactor": 1.0, "metallicRoughnessTexture": { "index": 1 } } },
        { "pbrMetallicRoughness": { "baseColorFactor": [0.7, 0.8, 1.0, 1.0], "metallicFactor": 0.0, "roughnessFactor": 0.5, "baseColorTexture": { "index": 0 } } }
    ]);
    let (mut bin, accessors, views) = quad_with_images(&[png(8, 8, &checker), png(8, 8, &ramp)]);
    // Two more position accessors move the second and third quads; they share uvs and indices.
    let mut accessors = accessors.as_array().expect("accessors").clone();
    let mut views = views.as_array().expect("views").clone();
    for dx in [1.2f32, 2.4] {
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let start = bin.len();
        let moved: [f32; 12] = [-0.5 + dx, -0.5, 0.0, 0.5 + dx, -0.5, 0.0, 0.5 + dx, 0.5, 0.0, -0.5 + dx, 0.5, 0.0];
        bin.extend(moved.iter().flat_map(|f| f.to_le_bytes()));
        views.push(json!({ "buffer": 0, "byteOffset": start, "byteLength": 48 }));
        accessors.push(json!({ "bufferView": views.len() - 1, "componentType": 5126, "count": 4, "type": "VEC3", "min": [-0.5 + dx, -0.5, 0.0], "max": [0.5 + dx, 0.5, 0.0] }));
    }
    let primitive = |position: usize, material: usize| json!({ "attributes": { "POSITION": position, "TEXCOORD_0": 1 }, "indices": 2, "material": material });
    let gltf = json!({
        "bufferViews": views,
        "accessors": accessors,
        "meshes": [{ "primitives": [primitive(0, 0), primitive(3, 1), primitive(4, 2)] }],
        "nodes": [{ "mesh": 0, "translation": [-1.2, 0.0, 0.0] }],
        "scenes": [{ "nodes": [0] }],
        "scene": 0,
        "materials": materials,
        "images": [{ "bufferView": 3, "mimeType": "image/png" }, { "bufferView": 4, "mimeType": "image/png" }],
        "textures": [{ "source": 0 }, { "source": 1 }],
    });
    glb_of(gltf, bin)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_golden_glb_materials_and_textures() {
    use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    let gpu = match Gpu::headless() {
        Ok(gpu) => gpu,
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => return eprintln!("skipped: no WebGPU-core adapter ({error})"),
    };
    if require {
        assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
    }
    let mut renderer = Renderer::with_options(&gpu, GOLDEN_WIDTH, GOLDEN_HEIGHT, RenderOptions::default()).expect("renderer");
    let model = GlbModel::from_glb(&showcase_glb()).expect("the GLB");
    let mut uploaded: Vec<(u32, TextureKind, TextureId)> = Vec::new();
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 0.4, 2.6], [0.0, 0.0, 0.0]), [18, 20, 28, 255]);
    scene.lighting.shadows = false;
    for part in model.parts() {
        let mesh: MeshId = renderer.add_mesh(&gpu, part.mesh.clone()).expect("mesh");
        let material = part.material.expect("every part names a material").map_textures(|image, kind| {
            if let Some((_, _, id)) = uploaded.iter().find(|(i, k, _)| *i == image && *k == kind) {
                return Some(*id);
            }
            let data = model.image(image)?.as_ref().ok()?;
            let id = renderer.add_texture(&gpu, data, kind).expect("texture");
            uploaded.push((image, kind, id));
            Some(id)
        });
        scene.draw(mesh, scaled([0.0, 0.0, 0.0], [1.0; 3]), material.to_material([255; 4]));
    }
    scene.draw(MeshId::SPHERE, scaled([0.0, -0.9, 0.0], [0.3; 3]), Material::color([200, 200, 200, 255]));
    renderer.render(&gpu, &scene, CullPath::Gpu).expect("frame");
    let capture = renderer.capture(&gpu).expect("capture");
    assert_eq!((capture.width(), capture.height()), (GOLDEN_WIDTH, GOLDEN_HEIGHT));
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(std::path::Path::new(&dir).join("glb-materials.bgra"), capture.bgra()).expect("evidence");
    }
    let path = golden_path("glb-materials");
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(path.parent().expect("folder")).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len(), "golden size");
    let outliers = golden
        .chunks(4)
        .zip(capture.bgra().chunks(4))
        .filter(|(a, b)| a.iter().zip(*b).any(|(x, y)| x.abs_diff(*y) > GOLDEN_CHANNEL_TOLERANCE))
        .count();
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "glb-materials: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE}");
}
