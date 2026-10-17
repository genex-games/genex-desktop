//! A GLB material's `KHR_materials_*` extensions (renderer pass 2, A6.1): read from the raw JSON
//! beside the core material, each with the specification's defaults, every factor finite and in
//! its range whatever the file says, and textures named by their image only on TEXCOORD_0. The
//! shading of these terms is the materials tier's; the values ride along on each part.

use genex_render::mesh::{GlbAnisotropy, GlbClearcoat, GlbMaterialExt, GlbModel, GlbSheen, GlbSpecular, GlbTexture, GlbVolume};
use serde_json::{Value, json};

/// A one-triangle GLB with one primitive per material (in order) and `images` texture slots, each
/// texture `i` sampling image `images - 1 - i` so a texture index is never its image index.
fn glb(materials: Value, images: usize) -> Vec<u8> {
    let positions: [f32; 9] = [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0];
    let mut bin: Vec<u8> = positions.iter().flat_map(|f| f.to_le_bytes()).collect();
    bin.extend([0u8, 0, 1, 0, 2, 0, 0, 0]);
    let count = materials.as_array().map_or(0, Vec::len);
    let primitives: Vec<Value> = (0..count).map(|m| json!({"attributes": {"POSITION": 0}, "indices": 1, "material": m})).collect();
    let mut gltf = json!({
        "asset": {"version": "2.0"},
        "buffers": [{"byteLength": bin.len()}],
        "bufferViews": [{"buffer": 0, "byteLength": 36}, {"buffer": 0, "byteOffset": 36, "byteLength": 6}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [0, 0, 0], "max": [1, 1, 0]},
            {"bufferView": 1, "componentType": 5123, "count": 3, "type": "SCALAR"}
        ],
        "meshes": [{"primitives": primitives}],
        "nodes": [{"mesh": 0}], "scenes": [{"nodes": [0]}], "scene": 0,
        "materials": materials,
    });
    if images > 0 {
        gltf["images"] = Value::Array((0..images).map(|_| json!({"uri": "unused.png"})).collect());
        gltf["textures"] = Value::Array((0..images).map(|i| json!({"source": images - 1 - i})).collect());
    }
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

fn ext_of(materials: Value, images: usize) -> Vec<Option<GlbMaterialExt>> {
    let model = GlbModel::from_glb(&glb(materials, images)).expect("a valid GLB");
    model.parts().iter().map(|part| part.material_ext).collect()
}

#[test]
fn every_extension_the_tier_reads_is_parsed_with_its_textures_named_by_image() {
    let material = json!([{
        "extensions": {
            "KHR_materials_ior": {"ior": 1.33},
            "KHR_materials_specular": {
                "specularFactor": 0.5, "specularTexture": {"index": 0},
                "specularColorFactor": [1.0, 0.9, 0.8], "specularColorTexture": {"index": 1}
            },
            "KHR_materials_clearcoat": {
                "clearcoatFactor": 0.8, "clearcoatTexture": {"index": 2},
                "clearcoatRoughnessFactor": 0.1, "clearcoatRoughnessTexture": {"index": 3},
                "clearcoatNormalTexture": {"index": 4, "scale": 0.5}
            },
            "KHR_materials_sheen": {
                "sheenColorFactor": [0.2, 0.3, 0.4], "sheenColorTexture": {"index": 0},
                "sheenRoughnessFactor": 0.6, "sheenRoughnessTexture": {"index": 1}
            },
            "KHR_materials_transmission": {"transmissionFactor": 0.9, "transmissionTexture": {"index": 2}},
            "KHR_materials_volume": {
                "thicknessFactor": 0.25, "thicknessTexture": {"index": 3},
                "attenuationDistance": 2.0, "attenuationColor": [0.9, 0.5, 0.1]
            },
            "KHR_materials_anisotropy": {"anisotropyStrength": 0.7, "anisotropyRotation": 1.5, "anisotropyTexture": {"index": 4}}
        }
    }]);
    let [Some(ext)] = ext_of(material, 5)[..] else { panic!("one material with extensions") };
    let image = |texture: u32| Some(GlbTexture { image: 4 - texture });
    assert_eq!(ext.ior, 1.33);
    assert_eq!(ext.specular, Some(GlbSpecular { factor: 0.5, texture: image(0), color: [1.0, 0.9, 0.8], color_texture: image(1) }));
    assert_eq!(
        ext.clearcoat,
        Some(GlbClearcoat { factor: 0.8, texture: image(2), roughness: 0.1, roughness_texture: image(3), normal_texture: image(4), normal_scale: 0.5 })
    );
    assert_eq!(ext.sheen, Some(GlbSheen { color: [0.2, 0.3, 0.4], color_texture: image(0), roughness: 0.6, roughness_texture: image(1) }));
    assert_eq!(ext.transmission, Some(0.9));
    assert_eq!(ext.volume, Some(GlbVolume { thickness: 0.25, attenuation_distance: 2.0, attenuation_color: [0.9, 0.5, 0.1] }));
    assert_eq!(ext.anisotropy, Some(GlbAnisotropy { strength: 0.7, rotation: 1.5, texture: image(4) }));
}

#[test]
fn absent_extensions_are_none_and_present_but_empty_ones_take_the_specifications_defaults() {
    let materials = json!([
        {"pbrMetallicRoughness": {"baseColorFactor": [1, 1, 1, 1]}},
        {"extensions": {
            "KHR_materials_specular": {}, "KHR_materials_clearcoat": {}, "KHR_materials_sheen": {},
            "KHR_materials_transmission": {}, "KHR_materials_volume": {}, "KHR_materials_anisotropy": {}
        }}
    ]);
    let found = ext_of(materials, 0);
    assert_eq!(found[0], None, "a material without KHR_materials_* has no extension row");
    let ext = found[1].expect("the second material has extensions");
    assert_eq!(ext.ior, 1.5, "glTF's default ior");
    assert_eq!(ext.specular, Some(GlbSpecular { factor: 1.0, texture: None, color: [1.0; 3], color_texture: None }));
    assert_eq!(
        ext.clearcoat,
        Some(GlbClearcoat { factor: 0.0, texture: None, roughness: 0.0, roughness_texture: None, normal_texture: None, normal_scale: 1.0 })
    );
    assert_eq!(ext.sheen, Some(GlbSheen { color: [0.0; 3], color_texture: None, roughness: 0.0, roughness_texture: None }));
    assert_eq!(ext.transmission, Some(0.0));
    assert_eq!(ext.volume, Some(GlbVolume { thickness: 0.0, attenuation_distance: f32::INFINITY, attenuation_color: [1.0; 3] }));
    assert_eq!(ext.anisotropy, Some(GlbAnisotropy { strength: 0.0, rotation: 0.0, texture: None }));
}

#[test]
fn hostile_extension_values_fall_back_or_clamp_and_never_refuse_the_model() {
    let materials = json!([{
        "extensions": {
            "KHR_materials_ior": {"ior": 0.5},
            "KHR_materials_specular": {"specularFactor": -1.0, "specularColorFactor": [1e40, "x", -2.0], "specularTexture": {"index": 99}},
            "KHR_materials_clearcoat": {"clearcoatFactor": 7.0, "clearcoatRoughnessFactor": "rough", "clearcoatTexture": {"index": 0, "texCoord": 1}},
            "KHR_materials_sheen": {"sheenColorFactor": [0.5, 0.5], "sheenRoughnessFactor": 2.0},
            "KHR_materials_transmission": {"transmissionFactor": null},
            "KHR_materials_volume": {"thicknessFactor": -3.0, "attenuationDistance": 0.0, "attenuationColor": [2.0, 0.5, -1.0]},
            "KHR_materials_anisotropy": {"anisotropyStrength": 1.5, "anisotropyRotation": 1e40, "anisotropyTexture": {"index": -1}}
        }
    }, {"extensions": {"KHR_materials_ior": {"ior": 0.0}, "KHR_materials_volume": "not an object"}}]);
    let found = ext_of(materials, 1);
    let ext = found[0].expect("extensions");
    assert_eq!(ext.ior, 1.5, "an ior below 1 (other than 0) is not one glTF allows");
    let specular = ext.specular.expect("specular");
    assert_eq!((specular.factor, specular.texture), (0.0, None), "clamped; a texture index past the file names nothing");
    assert_eq!(specular.color, [1.0, 1.0, 0.0], "a colour that is not three finite numbers ≥ 0 is the default per channel");
    let clearcoat = ext.clearcoat.expect("clearcoat");
    assert_eq!((clearcoat.factor, clearcoat.roughness, clearcoat.texture), (1.0, 0.0, None), "clamped, defaulted, another uv set ignored");
    let sheen = ext.sheen.expect("sheen");
    assert_eq!((sheen.color, sheen.roughness), ([0.0; 3], 1.0), "a two-channel colour is the default");
    assert_eq!(ext.transmission, Some(0.0));
    let volume = ext.volume.expect("volume");
    assert_eq!((volume.thickness, volume.attenuation_distance), (0.0, f32::INFINITY), "a distance that is not > 0 is the default");
    assert_eq!(volume.attenuation_color, [1.0, 0.5, 0.0], "clamped to 0..=1");
    let anisotropy = ext.anisotropy.expect("anisotropy");
    assert_eq!((anisotropy.strength, anisotropy.rotation, anisotropy.texture), (1.0, 0.0, None), "a rotation that is not a finite f32 is 0");
    let second = found[1].expect("ior 0 is an extension row");
    assert_eq!(second.ior, 0.0, "glTF lets ior be 0 (a perfect reflector's)");
    assert_eq!(second.volume, None, "an extension that is not an object is absent");
}
