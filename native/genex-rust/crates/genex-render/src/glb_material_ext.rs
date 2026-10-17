//! A GLB material's `KHR_materials_*` extensions (renderer pass 2, A6.1): `ior`, `specular`,
//! `clearcoat`, `sheen`, `transmission`, `volume` and `anisotropy`, read from the material's raw
//! extension JSON (`gltf`'s `extensions` feature, as Bevy's `bevy_gltf` reads clearcoat,
//! anisotropy and specular, which `gltf` 1.4.1 does not type). `emissive_strength` is
//! [`crate::mesh::GlbEmission`]'s.
//!
//! Each value takes the specification's default when the file leaves it out or states something
//! that is not one (a string, a non-finite number, the wrong length), and is clamped into its range
//! otherwise; nothing here refuses a model. A texture is named by the image its texture samples,
//! and only on TEXCOORD_0, the one uv set a vertex carries. Shading these terms is the materials
//! tier's: until then they ride along on each [`crate::mesh::GlbPart`].

use gltf::json::Value;

const IOR: &str = "KHR_materials_ior";
const SPECULAR: &str = "KHR_materials_specular";
const CLEARCOAT: &str = "KHR_materials_clearcoat";
const SHEEN: &str = "KHR_materials_sheen";
const TRANSMISSION: &str = "KHR_materials_transmission";
const VOLUME: &str = "KHR_materials_volume";
const ANISOTROPY: &str = "KHR_materials_anisotropy";
/// The extensions this module reads: a material carrying none of them has no row.
const READ: [&str; 7] = [IOR, SPECULAR, CLEARCOAT, SHEEN, TRANSMISSION, VOLUME, ANISOTROPY];
/// glTF's default index of refraction (and `KHR_materials_ior`'s).
pub const DEFAULT_IOR: f32 = 1.5;

/// A texture an extension samples: the image its texture names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GlbTexture {
    /// The image's index in the file.
    pub image: u32,
}

/// `KHR_materials_specular`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbSpecular {
    /// `specularFactor`, 0..=1 (default 1).
    pub factor: f32,
    /// `specularTexture` (its alpha channel).
    pub texture: Option<GlbTexture>,
    /// `specularColorFactor`, linear rgb, each ≥ 0 (default white).
    pub color: [f32; 3],
    /// `specularColorTexture` (sRGB).
    pub color_texture: Option<GlbTexture>,
}

/// `KHR_materials_clearcoat`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbClearcoat {
    /// `clearcoatFactor`, 0..=1 (default 0).
    pub factor: f32,
    /// `clearcoatTexture` (red channel).
    pub texture: Option<GlbTexture>,
    /// `clearcoatRoughnessFactor`, 0..=1 (default 0).
    pub roughness: f32,
    /// `clearcoatRoughnessTexture` (green channel).
    pub roughness_texture: Option<GlbTexture>,
    /// `clearcoatNormalTexture`.
    pub normal_texture: Option<GlbTexture>,
    /// That normal texture's `scale` (default 1).
    pub normal_scale: f32,
}

/// `KHR_materials_sheen`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbSheen {
    /// `sheenColorFactor`, linear rgb 0..=1 (default black: no sheen).
    pub color: [f32; 3],
    /// `sheenColorTexture` (sRGB).
    pub color_texture: Option<GlbTexture>,
    /// `sheenRoughnessFactor`, 0..=1 (default 0).
    pub roughness: f32,
    /// `sheenRoughnessTexture` (alpha channel).
    pub roughness_texture: Option<GlbTexture>,
}

/// `KHR_materials_volume`, factors only (its thickness texture waits for the tier).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbVolume {
    /// `thicknessFactor` in the mesh's units, ≥ 0 (default 0: thin-walled).
    pub thickness: f32,
    /// `attenuationDistance`, > 0 (default infinity: no attenuation).
    pub attenuation_distance: f32,
    /// `attenuationColor`, linear rgb 0..=1 (default white).
    pub attenuation_color: [f32; 3],
}

/// `KHR_materials_anisotropy`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbAnisotropy {
    /// `anisotropyStrength`, 0..=1 (default 0).
    pub strength: f32,
    /// `anisotropyRotation` in radians (default 0).
    pub rotation: f32,
    /// `anisotropyTexture` (rg direction, b strength).
    pub texture: Option<GlbTexture>,
}

/// The `KHR_materials_*` extensions of one material; each `None` when the material does not carry it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbMaterialExt {
    /// `KHR_materials_ior`'s `ior`: 0, or 1 and above (default [`DEFAULT_IOR`], also without the extension).
    pub ior: f32,
    /// `KHR_materials_specular`.
    pub specular: Option<GlbSpecular>,
    /// `KHR_materials_clearcoat`.
    pub clearcoat: Option<GlbClearcoat>,
    /// `KHR_materials_sheen`.
    pub sheen: Option<GlbSheen>,
    /// `KHR_materials_transmission`'s `transmissionFactor`, 0..=1 (factor only).
    pub transmission: Option<f32>,
    /// `KHR_materials_volume`.
    pub volume: Option<GlbVolume>,
    /// `KHR_materials_anisotropy`.
    pub anisotropy: Option<GlbAnisotropy>,
}

/// One extension's JSON object and the document its textures resolve in.
struct ExtensionReader<'a> {
    /// Always a JSON object.
    object: &'a Value,
    document: &'a gltf::Document,
}

/// A finite `f32`, or `None` for anything else (out of `f32`'s range included).
fn finite(value: Option<&Value>) -> Option<f32> {
    let number = value?.as_f64()? as f32;
    number.is_finite().then_some(number)
}

impl ExtensionReader<'_> {
    /// The number at `key`, clamped into `low..=high`, or `default`.
    fn number(&self, key: &str, default: f32, low: f32, high: f32) -> f32 {
        finite(self.object.get(key)).map_or(default, |value| value.clamp(low, high))
    }

    /// The three numbers at `key`, each clamped into `low..=high` or `default` when it is not
    /// one; all `default` unless it is an array of three.
    fn rgb(&self, key: &str, default: f32, low: f32, high: f32) -> [f32; 3] {
        match self.object.get(key).and_then(Value::as_array) {
            Some(values) if values.len() == 3 => std::array::from_fn(|c| finite(values.get(c)).map_or(default, |v| v.clamp(low, high))),
            _ => [default; 3],
        }
    }

    /// The image the texture at `key` samples, when it is on TEXCOORD_0 and names a texture.
    fn texture(&self, key: &str) -> Option<GlbTexture> {
        let info = self.object.get(key)?.as_object()?;
        let tex_coord = info.get("texCoord").map_or(Some(0), Value::as_u64)?;
        if tex_coord != 0 {
            return None;
        }
        let index = usize::try_from(info.get("index")?.as_u64()?).ok()?;
        let texture = self.document.textures().nth(index)?;
        Some(GlbTexture { image: u32::try_from(texture.source().index()).ok()? })
    }
}

/// The reader of `material`'s extension `name`, when it carries one that is a JSON object.
fn extension<'a>(material: &'a gltf::Material<'_>, document: &'a gltf::Document, name: &str) -> Option<ExtensionReader<'a>> {
    let object = material.extension_value(name).filter(|value| value.is_object())?;
    Some(ExtensionReader { object, document })
}

/// The `KHR_materials_*` extensions of `material`, or `None` when it carries none of them.
pub(crate) fn read_material_ext(material: &gltf::Material<'_>, document: &gltf::Document) -> Option<GlbMaterialExt> {
    let carries = READ.iter().any(|name| material.extension_value(name).is_some());
    if !carries {
        return None;
    }
    let read = |name: &str| extension(material, document, name);
    Some(GlbMaterialExt {
        ior: read(IOR).map_or(DEFAULT_IOR, |ior| read_ior(&ior)),
        specular: read(SPECULAR).map(|e| GlbSpecular {
            factor: e.number("specularFactor", 1.0, 0.0, 1.0),
            texture: e.texture("specularTexture"),
            color: e.rgb("specularColorFactor", 1.0, 0.0, f32::MAX),
            color_texture: e.texture("specularColorTexture"),
        }),
        clearcoat: read(CLEARCOAT).map(|e| read_clearcoat(&e)),
        sheen: read(SHEEN).map(|e| GlbSheen {
            color: e.rgb("sheenColorFactor", 0.0, 0.0, 1.0),
            color_texture: e.texture("sheenColorTexture"),
            roughness: e.number("sheenRoughnessFactor", 0.0, 0.0, 1.0),
            roughness_texture: e.texture("sheenRoughnessTexture"),
        }),
        transmission: read(TRANSMISSION).map(|e| e.number("transmissionFactor", 0.0, 0.0, 1.0)),
        volume: read(VOLUME).map(|e| read_volume(&e)),
        anisotropy: read(ANISOTROPY).map(|e| GlbAnisotropy {
            strength: e.number("anisotropyStrength", 0.0, 0.0, 1.0),
            rotation: finite(e.object.get("anisotropyRotation")).unwrap_or(0.0),
            texture: e.texture("anisotropyTexture"),
        }),
    })
}

/// `ior`: 0 (glTF's perfect reflector) or at least 1; anything else is the default.
fn read_ior(ior: &ExtensionReader<'_>) -> f32 {
    match finite(ior.object.get("ior")) {
        Some(value) if value == 0.0 || value >= 1.0 => value,
        _ => DEFAULT_IOR,
    }
}

fn read_clearcoat(e: &ExtensionReader<'_>) -> GlbClearcoat {
    let normal_scale = e.object.get("clearcoatNormalTexture").and_then(|info| finite(info.get("scale"))).unwrap_or(1.0);
    GlbClearcoat {
        factor: e.number("clearcoatFactor", 0.0, 0.0, 1.0),
        texture: e.texture("clearcoatTexture"),
        roughness: e.number("clearcoatRoughnessFactor", 0.0, 0.0, 1.0),
        roughness_texture: e.texture("clearcoatRoughnessTexture"),
        normal_texture: e.texture("clearcoatNormalTexture"),
        normal_scale,
    }
}

fn read_volume(e: &ExtensionReader<'_>) -> GlbVolume {
    let distance = finite(e.object.get("attenuationDistance")).filter(|d| *d > 0.0);
    GlbVolume {
        thickness: e.number("thicknessFactor", 0.0, 0.0, f32::MAX),
        attenuation_distance: distance.unwrap_or(f32::INFINITY),
        attenuation_color: e.rgb("attenuationColor", 1.0, 0.0, 1.0),
    }
}
