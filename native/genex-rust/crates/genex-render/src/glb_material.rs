//! A GLB's metallic-roughness materials and their embedded textures: [`GlbModel`] is a GLB as one
//! mesh per material it names (in first-use order, primitives sharing a material merged), each
//! with its [`GlbMaterial`], and the images those materials sample decoded to RGBA8.
//!
//! Only what WebGPU core draws today is read: the base-colour factor and texture, the metallic and
//! roughness factors and their texture, the normal texture and its scale, and emission (RQ6.3: the
//! emissive factor and texture and `KHR_materials_emissive_strength`, as each part's
//! [`GlbEmission`]), and (renderer pass 2, P2-0.12) `MASK` with its `alphaCutoff`, `doubleSided`
//! and the occlusion texture with its strength. A texture on another uv set than TEXCOORD_0 is
//! ignored; `OPAQUE` draws opaque, `MASK` keeps the factor's alpha for its alpha test and `BLEND`
//! for blending. Other extensions wait for their tiers. An image is read only from
//! a buffer view of the embedded `BIN` chunk, never by URI (no file beside the GLB, no data URI),
//! and decoded through the PNG and JPEG decoders the glTF loader already links, after its header's
//! size passed the texture cap. An image that cannot be used fails only its texture: the material
//! then draws untextured (neutral), never the missing-asset checker.

use crate::caps::check_texture;
use crate::error::{RenderCode, RenderError};
use crate::mesh::glb_material_ext::read_material_ext;
use crate::mesh::mesh_lod::{LodMerge, read_lod_extras};
use crate::mesh::{GlbMaterialExt, LodChain, LodWarning, MeshData, MeshletMerge, MeshletWarning, for_each_primitive, invalid, open_glb};
use crate::meshlet::MeshletSet;
use crate::pbr::Material;
use crate::subsurface::Subsurface;
use crate::texture::{TextureData, TextureId, TextureKind, linear_to_srgb, srgb_to_linear};

/// The PNG file signature.
const PNG_SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
/// Where a PNG's IHDR width and height sit (big-endian u32 each).
const PNG_SIZE_AT: usize = 16;
/// The JPEG start-of-image marker.
const JPEG_START: &[u8] = &[0xFF, 0xD8];

/// A glTF metallic-roughness material as a GLB states it, its textures named by `T`: the image
/// index in the file, or the renderer's [`TextureId`] once uploaded.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbMaterial<T = u32> {
    /// Linear RGBA factor (`baseColorFactor`); alpha is 1 unless the material blends or masks.
    pub base_color: [f32; 4],
    /// Metallic factor, 0..1 (times the metallic-roughness map's blue channel).
    pub metallic: f32,
    /// Roughness factor, 0..1 (times the map's green channel).
    pub roughness: f32,
    /// How strongly the normal map tilts the normal (`normalTexture.scale`).
    pub normal_scale: f32,
    /// Base-colour map (sRGB).
    pub base_texture: Option<T>,
    /// Tangent-space normal map (linear data).
    pub normal_texture: Option<T>,
    /// Metallic-roughness map (linear data): green roughness, blue metallic.
    pub metal_rough_texture: Option<T>,
    /// `MASK`'s `alphaCutoff` (0.5 by default); `None` for `OPAQUE` and `BLEND` (P2-0.12).
    pub alpha_cutoff: Option<f32>,
    /// `doubleSided` (P2-0.12).
    pub double_sided: bool,
    /// Ambient-occlusion map (linear data, red channel; often the metallic-roughness map's image:
    /// an ORM texture) (P2-0.12).
    pub occlusion_texture: Option<T>,
    /// `occlusionTexture.strength`, 0..1 (1 by default).
    pub occlusion_strength: f32,
    /// How it lets light through: `KHR_materials_diffuse_transmission` as the subsurface chunk
    /// shades it ([`GlbMaterialExt::subsurface`], renderer pass 2 B.1); `None` is opaque to light.
    pub subsurface: Option<Subsurface>,
}

impl<T: Copy> GlbMaterial<T> {
    /// This material with each texture replaced by what `upload` answers for it and the array
    /// kind its slot samples (`None` leaves the slot untextured).
    pub fn map_textures<U>(&self, mut upload: impl FnMut(T, TextureKind) -> Option<U>) -> GlbMaterial<U> {
        GlbMaterial {
            base_color: self.base_color,
            metallic: self.metallic,
            roughness: self.roughness,
            normal_scale: self.normal_scale,
            base_texture: self.base_texture.and_then(|t| upload(t, self.base_kind())),
            normal_texture: self.normal_texture.and_then(|t| upload(t, TextureKind::Normal)),
            metal_rough_texture: self.metal_rough_texture.and_then(|t| upload(t, TextureKind::Data)),
            alpha_cutoff: self.alpha_cutoff,
            double_sided: self.double_sided,
            occlusion_texture: self.occlusion_texture.and_then(|t| upload(t, TextureKind::Data)),
            occlusion_strength: self.occlusion_strength,
            subsurface: self.subsurface,
        }
    }

    /// The kind its base colour map uploads as: [`TextureKind::Cutout`] (mips that keep the
    /// alpha test's coverage) for a masked material, else [`TextureKind::Color`].
    fn base_kind(&self) -> TextureKind {
        if self.alpha_cutoff.is_some() { TextureKind::Cutout } else { TextureKind::Color }
    }

    /// Every texture with the array kind its slot samples, base colour first (an occlusion map
    /// that is the metallic-roughness map's image is that one upload).
    pub fn textures(&self) -> impl Iterator<Item = (T, TextureKind)>
    where
        T: PartialEq,
    {
        let packed = self.occlusion_texture.is_some() && self.occlusion_texture == self.metal_rough_texture;
        let occlusion = if packed { None } else { self.occlusion_texture };
        let slots = [
            (self.base_texture, self.base_kind()),
            (self.normal_texture, TextureKind::Normal),
            (self.metal_rough_texture, TextureKind::Data),
            (occlusion, TextureKind::Data),
        ];
        slots.into_iter().filter_map(|(texture, kind)| Some((texture?, kind)))
    }
}

impl GlbMaterial<TextureId> {
    /// The renderer's material: this one with its base colour multiplied by the sRGB `tint` (in
    /// linear light; alpha multiplied as stored).
    pub fn to_material(&self, tint: [u8; 4]) -> Material {
        let [r, g, b, a] = self.base_color;
        let channel = |factor: f32, tint: u8| linear_to_srgb(factor * srgb_to_linear(tint));
        let alpha = (a.clamp(0.0, 1.0) * f32::from(tint[3])).round() as u8;
        let mut material = Material::color([channel(r, tint[0]), channel(g, tint[1]), channel(b, tint[2]), alpha])
            .with_pbr(self.metallic, self.roughness);
        material.base_texture = self.base_texture;
        material.metal_rough_texture = self.metal_rough_texture;
        if let Some(normal) = self.normal_texture {
            material = material.with_normal_map(normal, self.normal_scale);
        }
        if let Some(cutoff) = self.alpha_cutoff {
            material = material.with_alpha_cutoff(cutoff);
        }
        if let Some(occlusion) = self.occlusion_texture {
            material = material.with_occlusion_texture(occlusion, self.occlusion_strength);
        }
        if let Some(subsurface) = self.subsurface {
            material = material.with_subsurface(subsurface);
        }
        material.with_double_sided(self.double_sided)
    }
}

/// A glTF material's emission as a GLB states it (RQ6.3), its map named by `T` like
/// [`GlbMaterial`]'s: emitted radiance is `factor × strength × map`, in the renderer's scene units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlbEmission<T = u32> {
    /// Linear rgb `0..=1` (`emissiveFactor`).
    pub factor: [f32; 3],
    /// `KHR_materials_emissive_strength.emissiveStrength`: 1 without the extension, never negative.
    pub strength: f32,
    /// Emissive map (sRGB).
    pub texture: Option<T>,
}

impl<T: Copy> GlbEmission<T> {
    /// This emission with its map replaced by what `upload` answers for it (a colour texture).
    pub fn map_textures<U>(&self, mut upload: impl FnMut(T, TextureKind) -> Option<U>) -> GlbEmission<U> {
        GlbEmission { factor: self.factor, strength: self.strength, texture: self.texture.and_then(|t| upload(t, TextureKind::Color)) }
    }

    /// Its map with the array kind it samples.
    pub fn textures(&self) -> impl Iterator<Item = (T, TextureKind)> {
        self.texture.map(|texture| (texture, TextureKind::Color)).into_iter()
    }
}

impl GlbEmission<TextureId> {
    /// `material` emitting this (its base colour and the rest kept).
    pub fn apply(&self, material: Material) -> Material {
        let material = Material { emissive: self.factor, emissive_strength: self.strength, ..material };
        match self.texture {
            Some(texture) => material.with_emissive_texture(texture),
            None => material,
        }
    }
}

/// One mesh of a [`GlbModel`]: every primitive drawn with one material, placed by its nodes.
#[derive(Clone, Debug, PartialEq)]
pub struct GlbPart {
    /// The triangles.
    pub mesh: MeshData,
    /// The material its primitives name; `None` when they name none.
    pub material: Option<GlbMaterial>,
    /// That material's emission; `None` when it emits nothing (a black emissive factor, a zero
    /// strength, or no material).
    pub emission: Option<GlbEmission>,
    /// That material's `KHR_materials_*` extensions (A6.1); `None` when it carries none of them
    /// or there is no material. Read, not yet shaded.
    pub material_ext: Option<GlbMaterialExt>,
    /// The meshlets its primitives carried (`extras.genex_meshlets`, R2.3), merged and validated
    /// against this part's mesh; `None` when any primitive had none or one was refused (the mesh
    /// is then clustered at runtime). The renderer takes them with
    /// [`crate::Renderer::add_meshes_with_meshlets`].
    pub meshlets: Option<MeshletSet>,
    /// The typed warnings of the primitives whose `genex_meshlets` were refused (their place
    /// among this part's primitives and the [`crate::meshlet::MeshletFault`]): the mesh then
    /// clusters at runtime, and a loader reports them with the asset's load warnings.
    pub meshlet_warnings: Vec<MeshletWarning>,
    /// The simplified levels its primitives carried (`extras.genex_lods`, A6.9), merged level by
    /// level; `None` when any primitive had none or one was refused (the mesh then draws whole).
    pub lods: Option<LodChain>,
    /// The typed warnings of the primitives whose `genex_lods` were refused.
    pub lod_warnings: Vec<LodWarning>,
    /// A normal-mapped primitive of it had no TANGENT, so its tangents were generated at load
    /// (MikkTSpace, game systems C-9): the Studio's import step, which writes them, was skipped.
    pub runtime_tangents: bool,
}

impl GlbPart {
    /// The part as the renderer's library takes it: its mesh, meshlets and levels of detail.
    pub fn into_model_part(self) -> crate::scene::ModelPart {
        crate::scene::ModelPart { mesh: self.mesh, meshlets: self.meshlets, lods: self.lods }
    }
}

/// A GLB as one mesh per material, and the images its materials sample.
#[derive(Clone, Debug, PartialEq)]
pub struct GlbModel {
    parts: Vec<GlbPart>,
    /// Per image index: `None` when no material samples it (or the images were left undecoded,
    /// [`GlbModel::from_glb_undecoded`]), else the decoded image or why not.
    images: Vec<Option<Result<TextureData, RenderError>>>,
    /// The image sidecars its `asset.extras.genex_textures` names (game systems C-13, C-14).
    sidecars: GlbSidecars,
}

impl GlbModel {
    /// The parts of a GLB, in the order their materials are first used (the primitive walk of
    /// [`MeshData::from_glb`], so a GLB naming one material or none is one part holding exactly
    /// `from_glb`'s mesh), and every image a material samples. Refused `mesh-invalid` as
    /// `from_glb` refuses; an unusable image fails only its texture ([`GlbModel::image`]).
    pub fn from_glb(bytes: &[u8]) -> Result<GlbModel, RenderError> {
        let gltf = open_glb(bytes)?;
        let blob = gltf.blob.as_deref();
        let parts = glb_parts(&gltf)?;
        let mut images: Vec<Option<Result<TextureData, RenderError>>> = vec![None; gltf.images().len()];
        for (index, _) in parts.iter().flat_map(part_textures) {
            let Some(slot) = images.get_mut(index as usize) else { continue };
            if slot.is_none() {
                let image = gltf.images().nth(index as usize).ok_or_else(|| invalid("a texture names no image"))?;
                *slot = Some(embedded_image(&image, blob));
            }
        }
        Ok(GlbModel { parts, images, sidecars: read_sidecars(&gltf) })
    }

    /// [`GlbModel::from_glb`] with no image decoded ([`GlbModel::image`] answers `None`): for a
    /// loader that takes an image's sidecar when it has one and decodes the embedded image only
    /// when it does not ([`GlbModel::image_from_glb`], C-14).
    pub fn from_glb_undecoded(bytes: &[u8]) -> Result<GlbModel, RenderError> {
        let gltf = open_glb(bytes)?;
        let parts = glb_parts(&gltf)?;
        Ok(GlbModel { parts, images: vec![None; gltf.images().len()], sidecars: read_sidecars(&gltf) })
    }

    /// The image sidecars a GLB names and whether its materials sample any image, read from its
    /// JSON only (no mesh or image is decoded): what a loader chooses its texture family by before
    /// it loads the model (C-14). Refused as [`GlbModel::from_glb`] refuses a file it cannot open.
    pub fn sidecars_of_glb(bytes: &[u8]) -> Result<(GlbSidecars, bool), RenderError> {
        let gltf = open_glb(bytes)?;
        let samples_images = gltf.materials().any(|material| material_samples_image(&material));
        Ok((read_sidecars(&gltf), samples_images))
    }

    /// The image sidecars its `asset.extras.genex_textures` names (C-14).
    pub fn sidecars(&self) -> &GlbSidecars {
        &self.sidecars
    }

    /// The meshes and meshlets of [`GlbModel::from_glb`]'s parts, in its order, with no image
    /// decoded: what a renderer replays a model's upload from (review F6).
    pub fn parts_from_glb(bytes: &[u8]) -> Result<Vec<crate::scene::ModelPart>, RenderError> {
        let gltf = open_glb(bytes)?;
        Ok(glb_parts(&gltf)?.into_iter().map(GlbPart::into_model_part).collect())
    }

    /// The parts as the renderer takes them: each mesh with its meshlets and levels of detail.
    pub fn model_parts(&self) -> Vec<crate::scene::ModelPart> {
        self.parts.iter().cloned().map(GlbPart::into_model_part).collect()
    }

    /// Image `index` of a GLB decoded as [`GlbModel::from_glb`] decodes it (refused
    /// `texture-invalid` when the GLB names no such image): what a renderer replays the image's
    /// upload from.
    pub fn image_from_glb(bytes: &[u8], index: u32) -> Result<TextureData, RenderError> {
        let gltf = open_glb(bytes)?;
        let image = gltf.images().nth(index as usize).ok_or_else(|| texture_invalid("the GLB names no such image"))?;
        embedded_image(&image, gltf.blob.as_deref())
    }

    /// The parts, in first-use order of their materials.
    pub fn parts(&self) -> &[GlbPart] {
        &self.parts
    }

    /// The decoded image at `index`, or why it cannot be used; `None` when no material samples it.
    pub fn image(&self, index: u32) -> Option<&Result<TextureData, RenderError>> {
        self.images.get(index as usize)?.as_ref()
    }
}

/// The parts of `gltf`: one mesh per material in first-use order, empty parts dropped (refused
/// `mesh-invalid` with no triangles at all).
fn glb_parts(gltf: &gltf::Gltf) -> Result<Vec<GlbPart>, RenderError> {
    let blob = gltf.blob.as_deref();
    let mut groups: Vec<(Option<usize>, MeshData, MeshletMerge, LodMerge, bool)> = Vec::new();
    for_each_primitive(gltf, &mut |primitive, world| {
        let key = primitive.material().index();
        let at = match groups.iter().position(|(known, ..)| *known == key) {
            Some(at) => at,
            None => {
                groups.push((key, MeshData::default(), MeshletMerge::default(), LodMerge::default(), false));
                groups.len() - 1
            }
        };
        let (_, mesh, merge, lods, runtime_tangents) = &mut groups[at];
        let base = mesh.vertices.len() as u32;
        *runtime_tangents |= mesh.append_with_meshlets(gltf, primitive, world, blob, merge)?;
        let vertex_count = mesh.vertices.len() as u32 - base;
        lods.visit(read_lod_extras(gltf, primitive, blob, vertex_count), world, base);
        Ok(())
    })?;
    groups.retain(|(_, mesh, ..)| !mesh.indices.is_empty());
    if groups.is_empty() {
        return Err(invalid("the GLB has no triangles"));
    }
    let parts = groups
        .into_iter()
        .map(|(key, mesh, merge, lods, runtime_tangents)| {
            let material = key.and_then(|index| gltf.materials().nth(index));
            let merged = merge.finish();
            let (lods, lod_warnings) = lods.finish();
            let material_ext = material.as_ref().and_then(|material| read_material_ext(material, &gltf.document));
            let subsurface = material_ext.as_ref().and_then(GlbMaterialExt::subsurface);
            GlbPart {
                mesh,
                material: material.as_ref().map(|material| GlbMaterial { subsurface, ..read_material(material) }),
                emission: material.as_ref().and_then(read_emission),
                material_ext,
                meshlets: merged.set,
                meshlet_warnings: merged.warnings,
                lods,
                lod_warnings,
                runtime_tangents,
            }
        })
        .collect();
    Ok(parts)
}

/// The member of a GLB's `asset.extras` naming its image sidecars, never an extension (the
/// Studio's import step writes it, `glb-textures.ts`; schema in this crate's README).
pub const GLB_TEXTURES_EXTRAS_KEY: &str = "genex_textures";
/// The `genex_textures` schema version the runtime reads.
pub const GLB_TEXTURES_SCHEMA_VERSION: u64 = 1;
/// The longest sidecar stem a block may name.
pub const GLB_TEXTURE_STEM_MAX_CHARS: usize = 200;

/// The members of the `genex_textures` object: its schema version and its images.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlbTexturesKey {
    /// `v`: the schema version.
    Version,
    /// `images`: one row per encoded (image, usage).
    Images,
}

impl GlbTexturesKey {
    /// Every key, in the writer's order.
    pub const ALL: [GlbTexturesKey; 2] = [GlbTexturesKey::Version, GlbTexturesKey::Images];

    /// Wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            GlbTexturesKey::Version => "v",
            GlbTexturesKey::Images => "images",
        }
    }
}

/// The members of one `genex_textures` image row.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlbTextureImageKey {
    /// `image`: the glTF image index.
    Image,
    /// `kind`: the usage it was encoded for.
    Kind,
    /// `stem`: the sidecar's file name stem in the GLB's own folder.
    Stem,
}

impl GlbTextureImageKey {
    /// Every key, in the writer's order.
    pub const ALL: [GlbTextureImageKey; 3] = [GlbTextureImageKey::Image, GlbTextureImageKey::Kind, GlbTextureImageKey::Stem];

    /// Wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            GlbTextureImageKey::Image => "image",
            GlbTextureImageKey::Kind => "kind",
            GlbTextureImageKey::Stem => "stem",
        }
    }
}

/// The usage a sidecar was encoded for: `color` files are sRGB, the others linear.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GlbTextureUsage {
    /// Base colour and emissive.
    Color,
    /// Metallic-roughness and occlusion.
    Data,
    /// A tangent-space normal map.
    Normal,
}

impl GlbTextureUsage {
    /// Every usage, in the writer's order.
    pub const ALL: [GlbTextureUsage; 3] = [GlbTextureUsage::Color, GlbTextureUsage::Data, GlbTextureUsage::Normal];

    /// Wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            GlbTextureUsage::Color => "color",
            GlbTextureUsage::Data => "data",
            GlbTextureUsage::Normal => "normal",
        }
    }

    /// The usage a slot sampling `kind` reads (an alpha-tested base colour is `color`).
    pub const fn of(kind: TextureKind) -> GlbTextureUsage {
        match kind {
            TextureKind::Color | TextureKind::Cutout => GlbTextureUsage::Color,
            TextureKind::Data => GlbTextureUsage::Data,
            TextureKind::Normal => GlbTextureUsage::Normal,
        }
    }

    fn from_wire(wire: &str) -> Option<GlbTextureUsage> {
        GlbTextureUsage::ALL.into_iter().find(|usage| usage.wire() == wire)
    }
}

/// One image a GLB ships as family files beside it: `<stem>.<family>.ktx2` in its folder.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlbSidecar {
    /// The glTF image index.
    pub image: u32,
    /// The usage its family files were encoded for.
    pub usage: GlbTextureUsage,
    /// The file name stem in the GLB's own folder (checked: no folder, no leading dot).
    pub stem: String,
}

/// What a GLB's `asset.extras.genex_textures` gave (C-14).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum GlbSidecars {
    /// No such block: the GLB was not imported, or none of its images could be encoded.
    #[default]
    Absent,
    /// A block that passed every check.
    Named(Vec<GlbSidecar>),
    /// A block refused as a whole, and why: a loader then decodes the embedded images, as for a GLB
    /// without one, and says so in its log.
    Malformed(String),
}

impl GlbSidecars {
    /// The stem of image `image`'s family files for a slot sampling `kind`, if the block names one.
    pub fn stem(&self, image: u32, kind: TextureKind) -> Option<&str> {
        let GlbSidecars::Named(rows) = self else { return None };
        let usage = GlbTextureUsage::of(kind);
        rows.iter().find(|row| row.image == image && row.usage == usage).map(|row| row.stem.as_str())
    }

    /// Every row of a block that passed its checks (none otherwise).
    pub fn rows(&self) -> &[GlbSidecar] {
        match self {
            GlbSidecars::Named(rows) => rows,
            GlbSidecars::Absent | GlbSidecars::Malformed(_) => &[],
        }
    }
}

/// Whether `stem` may name a file in the GLB's own folder: not empty, at most
/// [`GLB_TEXTURE_STEM_MAX_CHARS`] UTF-16 units (the writer's `length`), no `/`, `\` or NUL, not
/// starting with a dot.
fn is_sidecar_stem(stem: &str) -> bool {
    let plain = !stem.contains(['/', '\\', '\0']) && !stem.starts_with('.');
    plain && !stem.is_empty() && stem.encode_utf16().count() <= GLB_TEXTURE_STEM_MAX_CHARS
}

/// One image row, checked against the GLB's `images` count.
fn sidecar_row(row: &gltf::json::Value, images: usize) -> Result<GlbSidecar, String> {
    let image = row.get(GlbTextureImageKey::Image.wire()).and_then(gltf::json::Value::as_u64).ok_or("an image row has no image index")?;
    let image = u32::try_from(image).ok().filter(|image| (*image as usize) < images).ok_or_else(|| format!("image {image} is out of range"))?;
    let kind = row.get(GlbTextureImageKey::Kind.wire()).and_then(gltf::json::Value::as_str).unwrap_or_default();
    let usage = GlbTextureUsage::from_wire(kind).ok_or_else(|| format!("kind {kind:?} is unknown"))?;
    let stem = row.get(GlbTextureImageKey::Stem.wire()).and_then(gltf::json::Value::as_str).unwrap_or_default();
    if !is_sidecar_stem(stem) {
        return Err(format!("stem {stem:?} is not a file name in the model's folder"));
    }
    Ok(GlbSidecar { image, usage, stem: stem.to_owned() })
}

/// The rows of a `genex_textures` block, or why it is malformed as a whole.
fn sidecar_rows(block: &gltf::json::Value, images: usize) -> Result<Vec<GlbSidecar>, String> {
    let version = block.get(GlbTexturesKey::Version.wire()).and_then(gltf::json::Value::as_u64);
    if version != Some(GLB_TEXTURES_SCHEMA_VERSION) {
        return Err(format!("version {version:?} is not {GLB_TEXTURES_SCHEMA_VERSION}"));
    }
    let rows = block.get(GlbTexturesKey::Images.wire()).and_then(gltf::json::Value::as_array).ok_or("it has no images list")?;
    let mut sidecars: Vec<GlbSidecar> = Vec::with_capacity(rows.len());
    for row in rows {
        let sidecar = sidecar_row(row, images)?;
        if sidecars.iter().any(|known| known.image == sidecar.image && known.usage == sidecar.usage) {
            return Err(format!("image {} as {} appears twice", sidecar.image, sidecar.usage.wire()));
        }
        sidecars.push(sidecar);
    }
    Ok(sidecars)
}

/// The sidecars `asset.extras.genex_textures` names. Extras that are not an object, or have no
/// such member, are [`GlbSidecars::Absent`]; a member that fails any check is malformed as a whole.
fn read_sidecars(gltf: &gltf::Gltf) -> GlbSidecars {
    let Some(raw) = gltf.document.as_json().asset.extras.as_deref() else { return GlbSidecars::Absent };
    let Ok(extras) = gltf::json::deserialize::from_str::<gltf::json::Value>(raw.get()) else { return GlbSidecars::Absent };
    let Some(block) = extras.get(GLB_TEXTURES_EXTRAS_KEY) else { return GlbSidecars::Absent };
    match sidecar_rows(block, gltf.images().len()) {
        Ok(rows) => GlbSidecars::Named(rows),
        Err(detail) => GlbSidecars::Malformed(detail),
    }
}

/// Whether a material samples any image on a slot this loader reads.
fn material_samples_image(material: &gltf::Material<'_>) -> bool {
    let read = read_material(material);
    let emissive = read_emission(material).is_some_and(|emission| emission.texture.is_some());
    read.textures().next().is_some() || emissive
}

/// A value in `0..=1`, or `fallback` when it is not finite.
fn unit(value: f32, fallback: f32) -> f32 {
    if value.is_finite() { value.clamp(0.0, 1.0) } else { fallback }
}

/// The image index of a texture on TEXCOORD_0 (the only uv set a vertex carries).
fn on_uv0(texture: gltf::Texture<'_>, tex_coord: u32) -> Option<u32> {
    (tex_coord == 0).then(|| texture.source().index() as u32)
}

/// glTF's `alphaCutoff` when a `MASK` material names none.
pub const GLTF_DEFAULT_ALPHA_CUTOFF: f32 = 0.5;

fn read_material(material: &gltf::Material<'_>) -> GlbMaterial {
    let pbr = material.pbr_metallic_roughness();
    let mut base_color = pbr.base_color_factor().map(|c| unit(c, 1.0));
    let mode = material.alpha_mode();
    if mode == gltf::material::AlphaMode::Opaque {
        base_color[3] = 1.0;
    }
    let alpha_cutoff = (mode == gltf::material::AlphaMode::Mask)
        .then(|| unit(material.alpha_cutoff().unwrap_or(GLTF_DEFAULT_ALPHA_CUTOFF), GLTF_DEFAULT_ALPHA_CUTOFF));
    let occlusion = material.occlusion_texture();
    let occlusion_texture = occlusion.as_ref().and_then(|info| on_uv0(info.texture(), info.tex_coord()));
    let occlusion_strength = occlusion.as_ref().map_or(1.0, |info| unit(info.strength(), 1.0));
    let normal = material.normal_texture();
    let scale = normal.as_ref().map_or(1.0, gltf::material::NormalTexture::scale);
    GlbMaterial {
        base_color,
        metallic: unit(pbr.metallic_factor(), 1.0),
        roughness: unit(pbr.roughness_factor(), 1.0),
        normal_scale: if scale.is_finite() { scale } else { 1.0 },
        base_texture: pbr.base_color_texture().and_then(|info| on_uv0(info.texture(), info.tex_coord())),
        normal_texture: normal.and_then(|info| on_uv0(info.texture(), info.tex_coord())),
        metal_rough_texture: pbr.metallic_roughness_texture().and_then(|info| on_uv0(info.texture(), info.tex_coord())),
        alpha_cutoff,
        double_sided: material.double_sided(),
        occlusion_texture,
        occlusion_strength,
        subsurface: None,
    }
}

/// The emission of a material that emits: its factor (each channel `0..=1`, 0 when not finite),
/// its strength (1 when not finite, never negative) and its map on TEXCOORD_0.
fn read_emission(material: &gltf::Material<'_>) -> Option<GlbEmission> {
    let factor = material.emissive_factor().map(|c| unit(c, 0.0));
    let strength = material.emissive_strength().filter(|s| s.is_finite()).map_or(1.0, |s| s.max(0.0));
    let emits = factor.iter().any(|c| *c > 0.0) && strength > 0.0;
    let texture = material.emissive_texture().and_then(|info| on_uv0(info.texture(), info.tex_coord()));
    emits.then_some(GlbEmission { factor, strength, texture })
}

/// Every image a part samples with the array kind it is sampled as: its material's, then its
/// emission's.
fn part_textures(part: &GlbPart) -> Vec<(u32, TextureKind)> {
    let material = part.material.iter().flat_map(GlbMaterial::textures);
    material.chain(part.emission.iter().flat_map(GlbEmission::textures)).collect()
}

fn texture_invalid(detail: impl Into<String>) -> RenderError {
    RenderError::refused(RenderCode::TextureInvalid, detail)
}

/// The image's bytes from its buffer view in the BIN chunk, decoded; an image by URI is refused.
fn embedded_image(image: &gltf::Image<'_>, blob: Option<&[u8]>) -> Result<TextureData, RenderError> {
    let gltf::image::Source::View { view, .. } = image.source() else {
        return Err(texture_invalid(format!("image {} is not embedded in the GLB", image.index())));
    };
    let end = view.offset().checked_add(view.length());
    let bytes = blob.zip(end).and_then(|(blob, end)| blob.get(view.offset()..end));
    let bytes = bytes.ok_or_else(|| texture_invalid(format!("image {} lies outside the BIN chunk", image.index())))?;
    decode_image(bytes)
}

/// A PNG's or JPEG's MIME type and declared size from its header, before anything is decoded.
fn sniff(bytes: &[u8]) -> Option<(&'static str, u32, u32)> {
    if bytes.starts_with(PNG_SIGNATURE) {
        let size = bytes.get(PNG_SIZE_AT..PNG_SIZE_AT + 8)?;
        let width = u32::from_be_bytes(size[..4].try_into().ok()?);
        let height = u32::from_be_bytes(size[4..].try_into().ok()?);
        return Some(("image/png", width, height));
    }
    if bytes.starts_with(JPEG_START) {
        let (width, height) = jpeg_size(bytes)?;
        return Some(("image/jpeg", width, height));
    }
    None
}

/// Whether a JPEG marker starts a frame (SOF0..SOF15, but not DHT, JPG or DAC).
fn is_start_of_frame(marker: u8) -> bool {
    (0xC0..=0xCF).contains(&marker) && !matches!(marker, 0xC4 | 0xC8 | 0xCC)
}

/// A JPEG's frame size: the first start-of-frame segment's height and width.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut at = JPEG_START.len();
    loop {
        while bytes.get(at)? != &0xFF {
            at += 1;
        }
        while bytes.get(at)? == &0xFF {
            at += 1;
        }
        let marker = *bytes.get(at)?;
        at += 1;
        if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            continue;
        }
        let length = usize::from(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]));
        if is_start_of_frame(marker) {
            let height = u16::from_be_bytes([*bytes.get(at + 3)?, *bytes.get(at + 4)?]);
            let width = u16::from_be_bytes([*bytes.get(at + 5)?, *bytes.get(at + 6)?]);
            return Some((u32::from(width), u32::from(height)));
        }
        at = at.checked_add(length)?;
    }
}

/// A PNG or JPEG file decoded to RGBA8. Its header's size is checked against the texture cap
/// first (refused `texture-too-large`); anything else that is not a whole PNG or JPEG is refused
/// `texture-invalid`. The decoder is the glTF loader's (one image crate in the build): the bytes
/// are handed to it as the one image of a one-buffer glTF document.
pub fn decode_image(bytes: &[u8]) -> Result<TextureData, RenderError> {
    let (mime, width, height) = sniff(bytes).ok_or_else(|| texture_invalid("not a PNG or JPEG file"))?;
    if width == 0 || height == 0 {
        return Err(texture_invalid(format!("{width}×{height} is empty")));
    }
    check_texture(width, height, 4)?;
    let length = bytes.len();
    let json = format!(
        r#"{{"asset":{{"version":"2.0"}},"buffers":[{{"byteLength":{length}}}],"bufferViews":[{{"buffer":0,"byteLength":{length}}}],"images":[{{"bufferView":0,"mimeType":"{mime}"}}]}}"#
    );
    let document = gltf::Gltf::from_slice(json.as_bytes()).map_err(|error| texture_invalid(error.to_string()))?;
    let image = document.images().next().ok_or_else(|| texture_invalid("no image"))?;
    let buffers = [gltf::buffer::Data(bytes.to_vec())];
    let data = gltf::image::Data::from_source(image.source(), None, &buffers).map_err(|error| texture_invalid(error.to_string()))?;
    rgba8(&data)
}

/// Channels and bytes per channel of a decoded glTF image format.
fn layout(format: gltf::image::Format) -> (usize, usize) {
    use gltf::image::Format;
    match format {
        Format::R8 => (1, 1),
        Format::R8G8 => (2, 1),
        Format::R8G8B8 => (3, 1),
        Format::R8G8B8A8 => (4, 1),
        Format::R16 => (1, 2),
        Format::R16G16 => (2, 2),
        Format::R16G16B16 => (3, 2),
        Format::R16G16B16A16 => (4, 2),
        Format::R32G32B32FLOAT => (3, 4),
        Format::R32G32B32A32FLOAT => (4, 4),
    }
}

/// One channel of a decoded image as a byte: 8 bits as stored, 16 bits rounded, floats clamped.
fn channel_byte(bytes: &[u8]) -> u8 {
    match *bytes {
        [byte] => byte,
        [a, b] => (f32::from(u16::from_ne_bytes([a, b])) / 257.0).round() as u8,
        [a, b, c, d] => (f32::from_ne_bytes([a, b, c, d]).clamp(0.0, 1.0) * 255.0).round() as u8,
        _ => 0,
    }
}

/// A decoded glTF image as RGBA8: grey replicated to RGB, alpha opaque when absent.
fn rgba8(data: &gltf::image::Data) -> Result<TextureData, RenderError> {
    let (channels, size) = layout(data.format);
    let mut rgba = Vec::with_capacity(data.pixels.len() / (channels * size) * 4);
    for pixel in data.pixels.chunks_exact(channels * size) {
        let values: Vec<u8> = pixel.chunks_exact(size).map(channel_byte).collect();
        let texel = match values[..] {
            [grey] => [grey, grey, grey, u8::MAX],
            [grey, alpha] => [grey, grey, grey, alpha],
            [r, g, b] => [r, g, b, u8::MAX],
            [r, g, b, a] => [r, g, b, a],
            _ => return Err(texture_invalid("pixel channels")),
        };
        rgba.extend(texel);
    }
    TextureData::rgba8(data.width, data.height, rgba)
}
