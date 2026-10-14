//! Metallic-roughness materials as the material table holds them. The shading itself is
//! `shaders/pbr.wgsl` (GGX, Smith, Schlick; normal maps in tangent space; base-colour, normal and
//! metallic-roughness maps from the texture arrays). Lights live in [`crate::lights`] (RQ6.0); the
//! re-exports below keep their old paths.
//!
//! Emission (RQ6.3) is the parallel material-extension row ([`Material::to_gpu_ext`]): radiance in
//! the relative scene units the lit colour is in (a light's colour times its intensity; emissive
//! radiance 1 at EV 0 is the legacy path's white), added after lighting and before fog, then
//! pre-exposed with it, so auto exposure meters it and bloom spreads it.

use crate::layout::{GpuMaterial, GpuMaterialExt, MATERIAL_EXT_FLAG_EMISSIVE, MATERIAL_EXT_NO_TEXTURE, NO_TEXTURE};
use crate::texture::{TextureId, TextureKind};

pub use crate::lights::{DEFAULT_SHADOW_DISTANCE, LightKind, Lighting, PointLight, SpotLight, light_table};
pub(crate) use crate::lights::radiance;
pub use crate::texture::srgb_to_linear;

/// A metallic-roughness material. A base colour alpha below 255 makes it transparent: its draws
/// leave the culled opaque batches and are sorted back to front as direct draws.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Material {
    /// sRGB base colour and alpha.
    pub base_color: [u8; 4],
    /// Metallic, 0..1 (multiplied by the metallic-roughness map's blue channel).
    pub metallic: f32,
    /// Roughness, 0..1 (multiplied by the map's green channel).
    pub roughness: f32,
    /// The missing-asset magenta checker.
    pub checker: bool,
    /// Base colour map (sRGB array), multiplied by `base_color`.
    pub base_texture: Option<TextureId>,
    /// Tangent-space normal map (data array).
    pub normal_texture: Option<TextureId>,
    /// How strongly the normal map tilts the normal (glTF `normalTexture.scale`).
    pub normal_scale: f32,
    /// glTF metallic-roughness map (data array): green roughness, blue metallic.
    pub metal_rough_texture: Option<TextureId>,
    /// Emissive colour, linear rgb `0..=1` (glTF `emissiveFactor`), multiplied by the emissive map.
    pub emissive: [f32; 3],
    /// How bright the emissive colour is in scene units (`KHR_materials_emissive_strength`; 1 by
    /// default, never negative).
    pub emissive_strength: f32,
    /// Emissive map (sRGB colour array), multiplied by `emissive`.
    pub emissive_texture: Option<TextureId>,
}

impl Material {
    /// A dielectric of this colour.
    pub fn color(base_color: [u8; 4]) -> Material {
        Material {
            base_color,
            metallic: 0.0,
            roughness: 0.6,
            checker: false,
            base_texture: None,
            normal_texture: None,
            normal_scale: 1.0,
            metal_rough_texture: None,
            emissive: [0.0; 3],
            emissive_strength: 1.0,
            emissive_texture: None,
        }
    }

    /// The missing-asset checker: loud on purpose.
    pub fn missing() -> Material {
        Material { roughness: 1.0, checker: true, ..Material::color([255, 0, 255, 255]) }
    }

    /// This material with other metallic and roughness values.
    pub fn with_pbr(self, metallic: f32, roughness: f32) -> Material {
        Material { metallic, roughness, ..self }
    }

    /// This material with a base colour map (a [`TextureKind::Color`] texture).
    pub fn with_base_texture(self, texture: TextureId) -> Material {
        Material { base_texture: Some(texture), ..self }
    }

    /// This material with a normal map (a [`TextureKind::Normal`] or [`TextureKind::Data`] texture)
    /// tilting by `scale`.
    pub fn with_normal_map(self, texture: TextureId, scale: f32) -> Material {
        Material { normal_texture: Some(texture), normal_scale: scale, ..self }
    }

    /// This material with a metallic-roughness map (a [`TextureKind::Data`] texture).
    pub fn with_metal_rough_texture(self, texture: TextureId) -> Material {
        Material { metal_rough_texture: Some(texture), ..self }
    }

    /// This material emitting the sRGB `color` at `strength` (scene units, like a light's
    /// intensity): `[255, 255, 255]` at strength 1 emits radiance 1.
    pub fn with_emissive(self, color: [u8; 3], strength: f32) -> Material {
        Material { emissive: color.map(srgb_to_linear), emissive_strength: strength, ..self }
    }

    /// This material with an emissive map (a [`TextureKind::Color`] texture) multiplying its
    /// emissive colour (which [`Material::with_emissive`] sets; black emits nothing).
    pub fn with_emissive_texture(self, texture: TextureId) -> Material {
        Material { emissive_texture: Some(texture), ..self }
    }

    /// The emitted radiance (linear rgb, scene units): the emissive colour times its strength,
    /// each channel finite and not negative (anything else emits 0).
    pub fn emissive_radiance(&self) -> [f32; 3] {
        let strength = finite_or_zero(self.emissive_strength);
        self.emissive.map(|channel| finite_or_zero(finite_or_zero(channel) * strength))
    }

    /// Whether its draws emit light: a radiance that is not 0 (an emissive map with a black
    /// emissive colour emits nothing).
    pub fn is_emissive(&self) -> bool {
        self.emissive_radiance().iter().any(|channel| *channel > 0.0)
    }

    /// Whether its draws are blended (sorted, direct) rather than batched and culled on the GPU.
    pub fn is_transparent(&self) -> bool {
        self.base_color[3] < 255
    }

    /// The material-table key: equal keys share one row.
    pub(crate) fn key(&self) -> MaterialKey {
        let layer = |texture: Option<TextureId>| texture.map(|t| (t.kind().array() == TextureKind::Color, t.reference()));
        MaterialKey {
            color: self.base_color,
            bits: [self.metallic.to_bits(), self.roughness.to_bits(), self.normal_scale.to_bits()],
            checker: self.checker,
            textures: [layer(self.base_texture), layer(self.normal_texture), layer(self.metal_rough_texture)],
            emission: self.emissive_radiance().map(f32::to_bits),
            emissive_texture: self.emissive_layer(),
        }
    }

    /// The emissive map's texture reference (`layout::texture_ref`: size class and layer of the
    /// colour arrays), when it has one of the right kind and emits.
    fn emissive_layer(&self) -> Option<u32> {
        let texture = self.emissive_texture.filter(|t| t.kind() == TextureKind::Color && self.is_emissive());
        texture.map(TextureId::reference)
    }

    /// The material-extension row ([`GpuMaterialExt`], parallel to [`Material::to_gpu`]'s row):
    /// the emitted radiance, the emissive map's layer and its size class. A material that emits
    /// nothing has [`crate::layout::MATERIAL_EXT_NONE`]'s row.
    pub fn to_gpu_ext(self) -> GpuMaterialExt {
        if !self.is_emissive() {
            return crate::layout::MATERIAL_EXT_NONE;
        }
        let [r, g, b] = self.emissive_radiance();
        let (layer, class) = self
            .emissive_layer()
            .and_then(crate::layout::texture_ref_parts)
            .map_or((MATERIAL_EXT_NO_TEXTURE, 0.0), |(class, layer)| (layer as f32, class as f32));
        GpuMaterialExt { emissive: [r, g, b, 0.0], params: [layer, class, MATERIAL_EXT_FLAG_EMISSIVE as f32, 0.0] }
    }

    /// The material-table row: each slot's texture reference (`layout::texture_ref`, its size
    /// class and layer). A texture of the wrong kind for its slot is ignored (the base colour slot
    /// reads the sRGB arrays, the others the data arrays, normal maps among them).
    pub fn to_gpu(self) -> GpuMaterial {
        let [r, g, b, a] = self.base_color;
        let layer = |texture: Option<TextureId>, kind: TextureKind| {
            texture.filter(|t| t.kind().array() == kind).map_or(NO_TEXTURE, TextureId::reference)
        };
        GpuMaterial {
            base_color: [srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), f32::from(a) / 255.0],
            params: [self.metallic, self.roughness, if self.checker { 1.0 } else { 0.0 }, self.normal_scale],
            textures: [
                layer(self.base_texture, TextureKind::Color),
                layer(self.normal_texture, TextureKind::Data),
                layer(self.metal_rough_texture, TextureKind::Data),
                NO_TEXTURE,
            ],
        }
    }
}

/// What makes two materials one material-table row.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct MaterialKey {
    color: [u8; 4],
    bits: [u32; 3],
    checker: bool,
    textures: [Option<(bool, u32)>; 3],
    /// The emitted radiance's bits (so equal emission shares the extension row too).
    emission: [u32; 3],
    emissive_texture: Option<u32>,
}

/// `value`, or 0 when it is negative or not finite.
fn finite_or_zero(value: f32) -> f32 {
    if value.is_finite() && value > 0.0 { value } else { 0.0 }
}
