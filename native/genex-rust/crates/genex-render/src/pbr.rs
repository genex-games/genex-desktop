//! Metallic-roughness materials as the material table holds them. The shading itself is
//! `shaders/pbr.wgsl` (GGX, Smith, Schlick; normal maps in tangent space; base-colour, normal and
//! metallic-roughness maps from the texture arrays). Lights live in [`crate::lights`] (RQ6.0); the
//! re-exports below keep their old paths.
//!
//! Emission (RQ6.3) is the parallel material-extension row ([`Material::to_gpu_ext`]): radiance in
//! the relative scene units the lit colour is in (a light's colour times its intensity; emissive
//! radiance 1 at EV 0 is the legacy path's white), added after lighting and before fog, then
//! pre-exposed with it, so auto exposure meters it and bloom spreads it.

use crate::layout::{GpuMaterial, GpuMaterialExt, MATERIAL_EXT_FLAG_EMISSIVE, MATERIAL_EXT_FLAG_SUBSURFACE, MATERIAL_EXT_NO_TEXTURE, NO_TEXTURE};
use crate::subsurface::Subsurface;
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
    /// glTF `MASK` (P2-0.12): the base colour alpha (factor times map) below which a fragment is
    /// cut away; `None` draws it whole. A masked material is never blended, whatever its alpha.
    pub alpha_cutoff: Option<f32>,
    /// glTF `doubleSided` (P2-0.12): both faces are drawn and cast, each shaded with the normal
    /// that faces the viewer.
    pub double_sided: bool,
    /// glTF `occlusionTexture` (P2-0.12, data array, red channel): baked ambient occlusion, which
    /// may be the metallic-roughness map itself (an ORM texture).
    pub occlusion_texture: Option<TextureId>,
    /// How strongly the occlusion map darkens (`occlusionTexture.strength`, 0..1; 1 by default).
    pub occlusion_strength: f32,
    /// How it lets light through (renderer pass 2 B.1): wax, skin, leaves. `None` (the default)
    /// is opaque to light, shaded exactly as before.
    pub subsurface: Option<Subsurface>,
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
            alpha_cutoff: None,
            double_sided: false,
            occlusion_texture: None,
            occlusion_strength: 1.0,
            subsurface: None,
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

    /// This material alpha-tested against `cutoff` (glTF `MASK`; P2-0.12).
    pub fn with_alpha_cutoff(self, cutoff: f32) -> Material {
        Material { alpha_cutoff: Some(cutoff), ..self }
    }

    /// This material drawn from both sides (glTF `doubleSided`; P2-0.12).
    pub fn with_double_sided(self, double_sided: bool) -> Material {
        Material { double_sided, ..self }
    }

    /// This material with an ambient-occlusion map (a [`TextureKind::Data`] texture, red channel)
    /// darkening by `strength` (P2-0.12).
    pub fn with_occlusion_texture(self, texture: TextureId, strength: f32) -> Material {
        Material { occlusion_texture: Some(texture), occlusion_strength: strength, ..self }
    }

    /// This material letting light through as `subsurface` describes (renderer pass 2 B.1).
    pub fn with_subsurface(self, subsurface: Subsurface) -> Material {
        Material { subsurface: Some(subsurface), ..self }
    }

    /// Its scattering when it lets any light through ([`Subsurface::is_visible`]), sanitized.
    fn visible_subsurface(&self) -> Option<Subsurface> {
        self.subsurface.filter(|s| s.is_visible()).map(Subsurface::sanitized)
    }

    /// Which batches and pipelines its draws take (P2-0.12): plain, double-sided, alpha-tested or
    /// both.
    pub fn draw_variant(&self) -> crate::scene::DrawVariant {
        crate::scene::DrawVariant { masked: self.alpha_cutoff.is_some(), double_sided: self.double_sided }
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

    /// Whether its draws are blended (sorted, direct) rather than batched and culled on the GPU:
    /// an alpha below 255 that is not alpha-tested.
    pub fn is_transparent(&self) -> bool {
        self.alpha_cutoff.is_none() && self.base_color[3] < 255
    }

    /// Its alpha cutoff as the extension row holds it (0: not alpha-tested), held to 0..=1.
    fn cutoff(&self) -> f32 {
        self.alpha_cutoff.map_or(0.0, |cutoff| if cutoff.is_finite() { cutoff.clamp(0.0, 1.0) } else { crate::mesh::GLTF_DEFAULT_ALPHA_CUTOFF })
    }

    /// Its occlusion map's reference (`layout::texture_ref`) when it has a data texture there.
    fn occlusion_reference(&self) -> Option<u32> {
        self.occlusion_texture.filter(|t| t.kind().array() == TextureKind::Data).map(TextureId::reference)
    }

    /// Its occlusion strength as the extension row holds it: 0..=1, 1 when not finite.
    fn occlusion_strength(&self) -> f32 {
        if self.occlusion_strength.is_finite() { self.occlusion_strength.clamp(0.0, 1.0) } else { 1.0 }
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
            cutoff: self.alpha_cutoff.map(|_| self.cutoff().to_bits()),
            double_sided: self.double_sided,
            occlusion: self.occlusion_reference().map(|reference| (reference, self.occlusion_strength().to_bits())),
            subsurface: self.visible_subsurface().map(Subsurface::key),
        }
    }

    /// The emissive map's texture reference (`layout::texture_ref`: size class and layer of the
    /// colour arrays), when it has one of the right kind and emits.
    fn emissive_layer(&self) -> Option<u32> {
        let texture = self.emissive_texture.filter(|t| t.kind() == TextureKind::Color && self.is_emissive());
        texture.map(TextureId::reference)
    }

    /// The material-extension row ([`GpuMaterialExt`], parallel to [`Material::to_gpu`]'s row):
    /// the emitted radiance, the emissive map's layer and its size class, the occlusion map's
    /// strength (`emissive.w`), the alpha cutoff (`params.w`; P2-0.12) and the scattering
    /// (`subsurface`, `transmission`; renderer pass 2 B.1), each part's flag in `params.z`. A
    /// material that emits nothing, has no occlusion map, is not alpha-tested and lets no light
    /// through has [`crate::layout::MATERIAL_EXT_NONE`]'s row.
    pub fn to_gpu_ext(self) -> GpuMaterialExt {
        let occlusion = self.occlusion_reference().map_or(0.0, |_| self.occlusion_strength());
        let mut row = crate::layout::MATERIAL_EXT_NONE;
        row.emissive[3] = occlusion;
        row.params[3] = self.cutoff();
        let mut flags = 0;
        if let Some(subsurface) = self.visible_subsurface() {
            (row.subsurface, row.transmission) = subsurface.rows();
            flags |= MATERIAL_EXT_FLAG_SUBSURFACE;
        }
        row.params[2] = flags as f32;
        if !self.is_emissive() {
            return row;
        }
        let [r, g, b] = self.emissive_radiance();
        let (layer, class) = self
            .emissive_layer()
            .and_then(crate::layout::texture_ref_parts)
            .map_or((MATERIAL_EXT_NO_TEXTURE, 0.0), |(class, layer)| (layer as f32, class as f32));
        let flags = flags | MATERIAL_EXT_FLAG_EMISSIVE;
        GpuMaterialExt { emissive: [r, g, b, occlusion], params: [layer, class, flags as f32, row.params[3]], ..row }
    }

    /// The material-table row: each slot's texture reference (`layout::texture_ref`, its size
    /// class and layer); the occlusion map is `textures[3]` (P2-0.12), equal to `textures[2]` for
    /// an ORM texture, whose metallic-roughness texel's red is then read with no second fetch. A
    /// texture of the wrong kind for its slot is ignored (the base colour slot reads the sRGB
    /// arrays, the others the data arrays, normal maps among them).
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
                layer(self.occlusion_texture, TextureKind::Data),
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
    /// The alpha cutoff's bits (P2-0.12), when alpha-tested.
    cutoff: Option<u32>,
    double_sided: bool,
    /// The occlusion map's reference and strength bits.
    occlusion: Option<(u32, u32)>,
    /// The scattering's bits (renderer pass 2 B.1), when it lets light through.
    subsurface: Option<[u32; 7]>,
}

/// `value`, or 0 when it is negative or not finite.
fn finite_or_zero(value: f32) -> f32 {
    if value.is_finite() && value > 0.0 { value } else { 0.0 }
}
