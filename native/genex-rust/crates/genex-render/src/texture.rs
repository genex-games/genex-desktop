//! Textures: RGBA8 images resampled to one layer size and stored, with their whole mip chain, as
//! layers of two `texture_2d_array`s, one sRGB (base colour) and one linear (normal and
//! metallic-roughness maps). WebGPU core has no binding arrays, so a material names a texture by
//! its layer ([`TextureId`]) and every material shares one bind group.
//!
//! Resampling and mips run on the CPU in f32 with libm, so a texture's every level has the same
//! bits on every destination; colour averages in linear light, data averages its bytes.
//!
//! Texture quality (RQ6.4): with [`TextureQuality::OFF`] every texture is resampled to the one
//! 256 class as above. With texture quality on, [`ClassArrays`] keeps one array pair per size class
//! (`layout::TEXTURE_SIZE_CLASSES`): a texture goes in the smallest class that holds its source
//! (capped per preset, [`preset_textures`], and device class, [`class_layer_caps`]), each array is
//! allocated at its layer cap on its first texture (never grown by copy) and reserved in the
//! budget ledger ([`material_arrays`]); the degrade ladder drops the largest class first
//! ([`fitted_textures`]). Normal-map mips ([`TextureKind::Normal`]) renormalize and keep the
//! averaged length in alpha (Toksvig, [`normal_mip_chain`]), which [`toksvig_roughness`] (and the
//! surface chunk's `gx_toksvig_roughness`) folds into roughness.
//!
//! The renderer (RQ6.7) makes its [`ClassArrays`] for the quality and device class in effect at its
//! first texture and keeps them; a material's texture reference carries its class
//! (`layout::texture_ref`) and the forward pass samples the class arrays while any texture lives
//! past class 0. Level-2 v2 materials and immediate quads sample class 0 only.
//!
//! Layers come and go (game systems STR-3): each array books its layers in a [`TextureLayers`], a
//! reference count per layer and a free list, so [`ClassArrays::remove`] frees a layer once its
//! last reference goes and the next texture of that array takes the lowest free layer before a new
//! one, with no allocation. The layer cap counts live layers; a growing array's refill cache keeps
//! no chain for a free layer.

use std::collections::BTreeSet;

use wgpu::{Device, Queue, Texture, TextureView};

// KTX2 and the compressed families (A6.4) live beside the arrays they fill.
#[path = "texture_ktx2.rs"]
mod texture_ktx2;
pub use texture_ktx2::{CompressedTexture, KTX2_PREFIX_BYTES, Ktx2Index, TextureFamily, family_file, read_ktx2};

use crate::budget::MaterialClass;
use crate::caps::check_texture;
use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
use crate::error::{RenderCode, RenderError};
use crate::layout::texture_ref;
use crate::settings::{QualityPreset, TextureClass, TextureQuality};

/// Every layer's side: textures are resampled to it.
pub const TEXTURE_LAYER_PX: u32 = 256;
/// Layers per array (each kind); a texture past this is refused `texture-too-large`.
pub const MAX_TEXTURE_LAYERS: u32 = 64;

/// Which array a texture lives in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextureKind {
    /// sRGB-encoded colour (base colour): sampled through an `*Srgb` format, mipped in linear light.
    Color,
    /// Linear data (normal maps, metallic-roughness): sampled and mipped as stored.
    Data,
    /// A tangent-space normal map: stored in the data arrays like [`TextureKind::Data`], its mips
    /// renormalized with the lost length kept for roughness (Toksvig, [`normal_mip_chain`]) when
    /// the texture quality asks, else mipped as data.
    Normal,
    /// An alpha-tested material's base colour (P2-0.12): sRGB colour in the colour arrays like
    /// [`TextureKind::Color`], its mips' alpha scaled so each level keeps level 0's coverage at
    /// [`CUTOUT_COVERAGE_ALPHA`] ([`cutout_mip_chain`]): a cutout keeps its shape far away.
    Cutout,
}

/// The alpha a [`TextureKind::Cutout`] texture's mips keep the coverage of: glTF's default
/// `alphaCutoff`.
pub const CUTOUT_COVERAGE_ALPHA: f32 = 0.5;

impl TextureKind {
    /// The array the texture lives in: [`TextureKind::Color`] or [`TextureKind::Data`] (normal
    /// maps are data).
    pub const fn array(self) -> TextureKind {
        match self {
            TextureKind::Color | TextureKind::Cutout => TextureKind::Color,
            TextureKind::Data | TextureKind::Normal => TextureKind::Data,
        }
    }

    /// Whether it lives in the data arrays (a data texture or a normal map).
    pub const fn is_data(self) -> bool {
        matches!(self.array(), TextureKind::Data)
    }
}

/// A texture a renderer holds: its array (kind and size class) and layer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TextureId {
    kind: TextureKind,
    class: TextureClass,
    layer: u32,
}

impl TextureId {
    /// The texture at `layer` of the 256 class's `kind` array (it may name no texture).
    pub const fn new(kind: TextureKind, layer: u32) -> TextureId {
        TextureId { kind, class: TextureClass::S256, layer }
    }

    /// The texture at `layer` of size class `class`'s `kind` array.
    pub const fn in_class(kind: TextureKind, class: TextureClass, layer: u32) -> TextureId {
        TextureId { kind, class, layer }
    }

    /// Its array.
    pub const fn kind(self) -> TextureKind {
        self.kind
    }

    /// Its size class.
    pub const fn class(self) -> TextureClass {
        self.class
    }

    /// Its layer.
    pub const fn layer(self) -> u32 {
        self.layer
    }

    /// The material texture reference naming it (`layout::texture_ref`): class 0 is the bare layer.
    pub const fn reference(self) -> u32 {
        texture_ref(self.class.index(), self.layer)
    }
}

/// An RGBA8 image, rows top-down.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextureData {
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

impl TextureData {
    /// An image of exactly `width * height * 4` bytes; empty or mismatched data is refused
    /// `texture-invalid`, one above the texture cap `texture-too-large`.
    pub fn rgba8(width: u32, height: u32, rgba: Vec<u8>) -> Result<TextureData, RenderError> {
        if width == 0 || height == 0 {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("{width}×{height} is empty")));
        }
        check_texture(width, height, 4)?;
        let expected = u64::from(width) * u64::from(height) * 4;
        if rgba.len() as u64 != expected {
            return Err(RenderError::refused(
                RenderCode::TextureInvalid,
                format!("{} bytes for {width}×{height} RGBA8 ({expected} expected)", rgba.len()),
            ));
        }
        Ok(TextureData { width, height, rgba })
    }

    /// Width in texels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Height in texels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The texels.
    pub fn rgba(&self) -> &[u8] {
        &self.rgba
    }
}

/// The longest side a texture source is kept at once decoded: the largest size class
/// (`layout::TEXTURE_SIZE_CLASSES`), since no array stores more. Bodycam B1: a 4K map was kept
/// whole for device-loss replay, 64 MiB of a browser's heap per map.
pub const SOURCE_TEXTURE_MAX_SIDE: u32 = TextureClass::S2048.side();

/// `texture` with its longer side held to [`SOURCE_TEXTURE_MAX_SIDE`] (aspect kept, filtered as
/// `kind` says); borrowed untouched when it already fits, so its texels are the same bits.
pub fn capped_source(texture: &TextureData, kind: TextureKind) -> std::borrow::Cow<'_, TextureData> {
    let side = texture.width.max(texture.height);
    if side <= SOURCE_TEXTURE_MAX_SIDE {
        return std::borrow::Cow::Borrowed(texture);
    }
    let shrink = |px: u32| ((u64::from(px) * u64::from(SOURCE_TEXTURE_MAX_SIDE) / u64::from(side)) as u32).max(1);
    std::borrow::Cow::Owned(resample(texture, shrink(texture.width), shrink(texture.height), kind))
}

/// Mip levels of a `px`-sided square down to one texel.
pub fn mip_level_count(px: u32) -> u32 {
    px.max(1).ilog2() + 1
}

/// One sRGB byte as linear light (libm, the same bits on every target).
pub fn srgb_to_linear(channel: u8) -> f32 {
    let c = f32::from(channel) / 255.0;
    if c <= 0.04045 { c / 12.92 } else { libm::powf((c + 0.055) / 1.055, 2.4) }
}

/// Linear light as the nearest sRGB byte.
pub fn linear_to_srgb(linear: f32) -> u8 {
    let c = linear.clamp(0.0, 1.0);
    let encoded = if c <= 0.003_130_8 { c * 12.92 } else { 1.055 * libm::powf(c, 1.0 / 2.4) - 0.055 };
    (encoded * 255.0).round() as u8
}

/// The source texels and weights that make destination texel `i` of `dst` from `src`: the
/// covered texels averaged when shrinking, two bilinear taps when growing.
fn taps(src: u32, dst: u32, i: u32) -> Vec<(u32, f32)> {
    if src >= dst {
        let start = (u64::from(i) * u64::from(src) / u64::from(dst)) as u32;
        let end = ((u64::from(i + 1) * u64::from(src)).div_ceil(u64::from(dst)) as u32).max(start + 1);
        let weight = 1.0 / (end - start) as f32;
        return (start..end).map(|s| (s, weight)).collect();
    }
    let x = ((i as f32 + 0.5) * src as f32 / dst as f32 - 0.5).clamp(0.0, (src - 1) as f32);
    let left = x.floor() as u32;
    let right = (left + 1).min(src - 1);
    let t = x - left as f32;
    vec![(left, 1.0 - t), (right, t)]
}

/// `texture` resampled to `width` × `height`, filtered as `kind` says.
fn resample(texture: &TextureData, width: u32, height: u32, kind: TextureKind) -> TextureData {
    if (texture.width, texture.height) == (width, height) {
        return texture.clone();
    }
    let decode = |c: usize, byte: u8| if kind.array() == TextureKind::Color && c < 3 { srgb_to_linear(byte) } else { f32::from(byte) / 255.0 };
    let encode = |c: usize, value: f32| {
        if kind.array() == TextureKind::Color && c < 3 { linear_to_srgb(value) } else { (value.clamp(0.0, 1.0) * 255.0).round() as u8 }
    };
    let columns: Vec<Vec<(u32, f32)>> = (0..width).map(|x| taps(texture.width, width, x)).collect();
    let mut rgba = Vec::with_capacity((width * height * 4) as usize);
    for y in 0..height {
        let rows = taps(texture.height, height, y);
        for column in &columns {
            let mut sum = [0.0_f32; 4];
            for &(sy, wy) in &rows {
                for &(sx, wx) in column {
                    let at = ((sy * texture.width + sx) * 4) as usize;
                    for (c, total) in sum.iter_mut().enumerate() {
                        *total += decode(c, texture.rgba[at + c]) * wx * wy;
                    }
                }
            }
            rgba.extend((0..4).map(|c| encode(c, sum[c])));
        }
    }
    TextureData { width, height, rgba }
}

/// The mip chain of `texture` as a `px`-sided layer: level 0 resampled to `px` × `px`, then each
/// level a 2 × 2 average of the one above, down to one texel.
pub fn mip_chain(texture: &TextureData, kind: TextureKind, px: u32) -> Vec<TextureData> {
    let mut levels = vec![resample(texture, px, px, kind)];
    while let Some(last) = levels.last()
        && last.width > 1
    {
        let side = last.width / 2;
        let next = resample(last, side, side, kind);
        levels.push(next);
    }
    levels
}

/// The share of `level`'s texels whose alpha is at least `cutoff` (what an alpha test at `cutoff`
/// keeps).
pub fn alpha_coverage(level: &TextureData, cutoff: f32) -> f32 {
    let texels = level.rgba.len() / 4;
    if texels == 0 {
        return 0.0;
    }
    let kept = level.rgba.as_chunks::<4>().0.iter().filter(|texel| f32::from(texel[3]) / 255.0 >= cutoff).count();
    kept as f32 / texels as f32
}

/// The largest alpha scale [`cutout_mip_chain`]'s search tries (NVTT's).
const COVERAGE_SCALE_MAX: f32 = 4.0;
/// Bisection steps of that search (NVTT takes 10 on its continuous coverage; 8-bit alpha needs a
/// few more to land on the nearest step).
const COVERAGE_SEARCH_STEPS: u32 = 16;

/// `level`'s coverage at `cutoff` once its alpha is multiplied by `scale` (clamped to 1).
fn scaled_coverage(level: &TextureData, cutoff: f32, scale: f32) -> f32 {
    let texels = (level.rgba.len() / 4).max(1);
    let kept = level.rgba.as_chunks::<4>().0.iter().filter(|texel| (f32::from(texel[3]) / 255.0 * scale).min(1.0) >= cutoff).count();
    kept as f32 / texels as f32
}

/// The alpha scale that brings `level`'s coverage at `cutoff` closest to `target`: a bisection
/// over 0..[`COVERAGE_SCALE_MAX`] (coverage only grows with the scale), the closest scale tried.
fn coverage_scale(level: &TextureData, cutoff: f32, target: f32) -> f32 {
    let (mut low, mut high, mut scale) = (0.0f32, COVERAGE_SCALE_MAX, 1.0f32);
    let mut best = (f32::INFINITY, 1.0f32);
    for _ in 0..COVERAGE_SEARCH_STEPS {
        let coverage = scaled_coverage(level, cutoff, scale);
        let error = (coverage - target).abs();
        if error < best.0 {
            best = (error, scale);
        }
        if coverage < target {
            low = scale;
        } else if coverage > target {
            high = scale;
        } else {
            break;
        }
        scale = (low + high) * 0.5;
    }
    best.1
}

/// A [`TextureKind::Cutout`] texture's mip chain as a `px`-sided layer (P2-0.12; the method of
/// NVIDIA Texture Tools' `scaleAlphaToCoverage`, Castaño 2010, written anew): the colour chain
/// filtered as [`mip_chain`] filters it, then each level's alpha scaled so an alpha test at
/// [`CUTOUT_COVERAGE_ALPHA`] keeps the share of texels the source keeps. A box-filtered mip of thin
/// blades or leaves averages their alpha under the cutoff, so far-away foliage would thin out and
/// vanish.
pub fn cutout_mip_chain(texture: &TextureData, px: u32) -> Vec<TextureData> {
    let mut chain = mip_chain(texture, TextureKind::Color, px);
    let target = alpha_coverage(texture, CUTOUT_COVERAGE_ALPHA);
    for level in chain.iter_mut().skip(1) {
        let scale = coverage_scale(level, CUTOUT_COVERAGE_ALPHA, target);
        for texel in level.rgba.as_chunks_mut::<4>().0 {
            texel[3] = (f32::from(texel[3]) * scale).round().min(255.0) as u8;
        }
    }
    chain
}

/// The mip chain of `texture` at its own size: level 0 is the texture, then each level halves
/// both sides (at least one texel) from the one above, filtered as `kind` says, down to 1 × 1. A
/// Level-2 game texture (any size) is uploaded with it, so a tiled texture read far smaller than a
/// pixel averages instead of aliasing.
pub fn rect_mip_chain(texture: &TextureData, kind: TextureKind) -> Vec<TextureData> {
    let mut levels = vec![texture.clone()];
    while let Some(last) = levels.last()
        && (last.width > 1 || last.height > 1)
    {
        let next = resample(last, (last.width / 2).max(1), (last.height / 2).max(1), kind);
        levels.push(next);
    }
    levels
}

/// A normal map's mip chain as a `px`-sided layer. With `toksvig` off it is [`mip_chain`] of a
/// [`TextureKind::Data`] texture, today's method. With it on, every level stores the averaged unit
/// normals it covers, their direction renormalized and their averaged length in alpha, which
/// [`toksvig_roughness`] turns into the roughness the lost detail would have shown. Level 0 of a
/// source larger than its class (placed in a smaller size class) is already such an average of the
/// source's unit normals, so the detail the class drops shows as roughness too; a source of the
/// class's size (or a smaller one, resampled up) keeps its texels with alpha 255. Each coarser
/// level averages the unnormalized averages of the one above.
pub fn normal_mip_chain(texture: &TextureData, px: u32, toksvig: bool) -> Vec<TextureData> {
    if !toksvig {
        return mip_chain(texture, TextureKind::Data, px);
    }
    let (top, mut vectors) = normal_top_level(texture, px);
    let (mut width, mut height) = (top.width, top.height);
    let mut levels = vec![top];
    while width > 1 || height > 1 {
        let (next_width, next_height) = ((width / 2).max(1), (height / 2).max(1));
        vectors = box_average(&vectors, (width, height), (next_width, next_height));
        let rgba = vectors.iter().flat_map(|average| encode_normal(*average)).collect();
        levels.push(TextureData { width: next_width, height: next_height, rgba });
        (width, height) = (next_width, next_height);
    }
    levels
}

/// A Toksvig chain's level 0 at `px` and the vectors the next level averages: the source's unit
/// normals box-averaged to `px` (their length in alpha) when the source is larger on both sides,
/// else the source resampled with alpha 255 and its unit normals.
fn normal_top_level(texture: &TextureData, px: u32) -> (TextureData, Vec<[f32; 3]>) {
    let shrinks = texture.width >= px && texture.height >= px && (texture.width, texture.height) != (px, px);
    if shrinks {
        let source: Vec<[f32; 3]> = texture.rgba.as_chunks::<4>().0.iter().map(unit_normal).collect();
        let averages = box_average(&source, (texture.width, texture.height), (px, px));
        let rgba = averages.iter().flat_map(|average| encode_normal(*average)).collect();
        return (TextureData { width: px, height: px, rgba }, averages);
    }
    let mut top = resample(texture, px, px, TextureKind::Data);
    for texel in top.rgba.as_chunks_mut::<4>().0 {
        texel[3] = u8::MAX;
    }
    let vectors = top.rgba.as_chunks::<4>().0.iter().map(unit_normal).collect();
    (top, vectors)
}

/// A tangent-space normal-map texel as a unit vector (a zero texel is the flat normal).
fn unit_normal(texel: &[u8; 4]) -> [f32; 3] {
    let v = [0, 1, 2].map(|c| f32::from(texel[c]) / 255.0 * 2.0 - 1.0);
    let length = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if length <= f32::EPSILON {
        return [0.0, 0.0, 1.0];
    }
    v.map(|c| c / length)
}

/// An averaged normal as a texel: its direction renormalized, its length in alpha.
fn encode_normal(average: [f32; 3]) -> [u8; 4] {
    let length = (average[0] * average[0] + average[1] * average[1] + average[2] * average[2]).sqrt();
    let direction = if length <= f32::EPSILON { [0.0, 0.0, 1.0] } else { average.map(|c| c / length) };
    let byte = |value: f32| (value.clamp(0.0, 1.0) * 255.0).round() as u8;
    let [x, y, z] = direction.map(|c| byte(c * 0.5 + 0.5));
    [x, y, z, byte(length)]
}

/// `vectors` (`from` texels) box-averaged to `to` texels with [`taps`]' weights.
fn box_average(vectors: &[[f32; 3]], from: (u32, u32), to: (u32, u32)) -> Vec<[f32; 3]> {
    let columns: Vec<Vec<(u32, f32)>> = (0..to.0).map(|x| taps(from.0, to.0, x)).collect();
    let mut out = Vec::with_capacity((to.0 * to.1) as usize);
    for y in 0..to.1 {
        let rows = taps(from.1, to.1, y);
        for column in &columns {
            let mut sum = [0.0_f32; 3];
            for &(sy, wy) in &rows {
                for &(sx, wx) in column {
                    let v = vectors[(sy * from.0 + sx) as usize];
                    for (total, c) in sum.iter_mut().zip(v) {
                        *total += c * wx * wy;
                    }
                }
            }
            out.push(sum);
        }
    }
    out
}

/// The perceptual roughness a normal-mapped texel shades with when its normal map's mip kept
/// `normal_length` of the averaged unit normals (Toksvig; the von Mises-Fisher fit of Neubelt and
/// Pettineo 2013): the spread `1 / kappa`, `kappa = (3L - L^3) / (1 - L^2)`, widens GGX alpha
/// squared, capped at 1. A full-length normal returns `roughness` unchanged.
pub fn toksvig_roughness(roughness: f32, normal_length: f32) -> f32 {
    if normal_length >= 1.0 {
        return roughness;
    }
    let length = normal_length.max(TOKSVIG_MIN_LENGTH);
    let kappa = (3.0 * length - length * length * length) / (1.0 - length * length);
    let alpha = roughness * roughness;
    (alpha * alpha + 1.0 / kappa).min(1.0).sqrt().sqrt()
}

/// The shortest averaged normal [`toksvig_roughness`] reads (a zero length has no direction).
const TOKSVIG_MIN_LENGTH: f32 = 1.0 / 255.0;

// ---------------------------------------------------------------------------------------------
// Size classes (RQ6.4)

/// Layers per kind of each size class, by device class (before the preset's cap): what a class
/// pre-sizes on its first texture and reserves in the budget ledger, sized so each class's default
/// preset with its arrays fits the class budget at its reference resolution
/// (tests/texture_classes.rs). Phones hold no 2048 class and mobile-mid no 1024 class.
const fn device_layer_caps(class: DeviceClass) -> [u32; 4] {
    match (class.form, class.tier) {
        (FormFactor::Desktop, PerformanceTier::Ultra) => [64, 16, 8, 2],
        (FormFactor::Desktop, PerformanceTier::High) => [32, 8, 4, 1],
        (FormFactor::Desktop, PerformanceTier::Mid) => [32, 8, 2, 1],
        (FormFactor::Desktop, PerformanceTier::Low) => [32, 8, 2, 0],
        (FormFactor::Mobile, PerformanceTier::Ultra | PerformanceTier::High) => [32, 8, 2, 0],
        (FormFactor::Mobile, PerformanceTier::Mid) => [32, 8, 0, 0],
        (FormFactor::Mobile, PerformanceTier::Low) => [16, 4, 0, 0],
    }
}

/// The texture quality `preset` gives `class`: the largest size class (512 on low, 1024 on
/// medium, 2048 from high on desktops; phones stop at 1024 and clamp to 512 on low) and Toksvig
/// normal-map mips on every preset. [`TextureQuality::OFF`] is today's single 256 class.
pub fn preset_textures(preset: QualityPreset, class: DeviceClass) -> TextureQuality {
    let max_class = match (class.form, preset) {
        (_, QualityPreset::Low) => TextureClass::S512,
        (FormFactor::Mobile, _) | (FormFactor::Desktop, QualityPreset::Medium) => TextureClass::S1024,
        _ => TextureClass::S2048,
    };
    TextureQuality { max_class, toksvig: true }
}

/// The smallest size class whose side holds the longer side of a `width` × `height` source,
/// capped at `max_class`.
pub fn class_for_source(width: u32, height: u32, max_class: TextureClass) -> TextureClass {
    let side = width.max(height);
    TextureClass::ALL.into_iter().find(|class| *class >= max_class || class.side() >= side).unwrap_or(max_class)
}

/// Layers per kind of each size class (by class index) on `class` at `quality`: zero above the
/// quality's largest class; [`TextureQuality::OFF`] is today's one growing 256 class of
/// [`MAX_TEXTURE_LAYERS`].
pub fn class_layer_caps(class: DeviceClass, quality: TextureQuality) -> [u32; 4] {
    if quality == TextureQuality::OFF {
        return [MAX_TEXTURE_LAYERS, 0, 0, 0];
    }
    let caps = device_layer_caps(class);
    let mut held = [0; 4];
    for texture_class in TextureClass::ALL.into_iter().filter(|texture_class| *texture_class <= quality.max_class) {
        let at = texture_class.index() as usize;
        held[at] = caps[at];
    }
    held
}

/// The budget-ledger entries of the material arrays `class` reserves at `quality`: one entry per
/// held size class, smallest class first, holding its colour and its data array at their layer
/// cap (both rgba8, so the pair is one array of twice the layers). The degrade rung halves the
/// largest entry first, so a class's pair always drops together.
pub fn material_arrays(class: DeviceClass, quality: TextureQuality) -> Vec<MaterialClass> {
    let caps = class_layer_caps(class, quality);
    TextureClass::ALL
        .into_iter()
        .map(|texture_class| (texture_class.side(), caps[texture_class.index() as usize]))
        .filter(|(_, layers)| *layers > 0)
        .map(|(size_px, layers)| MaterialClass { size_px, layers: 2 * layers })
        .collect()
}

/// `quality` after the budget's degrade ladder turned the `reserved` material arrays
/// ([`material_arrays`]) into `fitted` (`budget::Fitted::materials`): a size class survives while
/// as many fitted entries as reserved ones are at least its side, so the material rung, which
/// halves the largest entry first, drops the largest class first. Class 0 is never dropped.
pub fn fitted_textures(quality: TextureQuality, reserved: &[MaterialClass], fitted: &[MaterialClass]) -> TextureQuality {
    let at_least = |arrays: &[MaterialClass], side: u32| arrays.iter().filter(|array| array.size_px >= side).count();
    let survives = |class: &TextureClass| {
        let needed = at_least(reserved, class.side());
        needed > 0 && at_least(fitted, class.side()) >= needed
    };
    let max_class = TextureClass::ALL
        .into_iter()
        .rev()
        .filter(|class| *class <= quality.max_class)
        .find(survives)
        .unwrap_or(TextureClass::S256);
    TextureQuality { max_class, ..quality }
}

/// The size class whose arrays are `side` texels.
fn class_of_side(side: u32) -> TextureClass {
    TextureClass::ALL.into_iter().find(|class| class.side() == side).unwrap_or(TextureClass::S256)
}

/// The layer book of one texture array (STR-3): a reference count per layer and a free list.
/// [`TextureLayers::take`] hands out the lowest free layer, else the next new one while fewer than
/// the cap are live; a layer is free again when its last reference is released. Everything is
/// ordered, so the same adds and removes give the same layers on every destination.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextureLayers {
    cap: u32,
    /// References per layer ever taken (0: free); its length is the high-water mark.
    refs: Vec<u32>,
    free: BTreeSet<u32>,
}

impl TextureLayers {
    /// A book of at most `cap` live layers, none taken.
    pub fn new(cap: u32) -> TextureLayers {
        TextureLayers { cap, refs: Vec::new(), free: BTreeSet::new() }
    }

    /// A layer with one reference: the lowest free one, else a new one; None when `cap` are live.
    pub fn take(&mut self) -> Option<u32> {
        if let Some(layer) = self.free.pop_first() {
            self.refs[layer as usize] = 1;
            return Some(layer);
        }
        let layer = u32::try_from(self.refs.len()).ok().filter(|layer| *layer < self.cap)?;
        self.refs.push(1);
        Some(layer)
    }

    /// One more reference to a live `layer`: its count after, or None when it is not live.
    pub fn retain(&mut self, layer: u32) -> Option<u32> {
        let refs = self.refs.get_mut(layer as usize).filter(|refs| **refs > 0)?;
        *refs += 1;
        Some(*refs)
    }

    /// One reference fewer to a live `layer`: the count left (0: the layer is free again), or None
    /// when it is not live.
    pub fn release(&mut self, layer: u32) -> Option<u32> {
        let refs = self.refs.get_mut(layer as usize).filter(|refs| **refs > 0)?;
        *refs -= 1;
        let left = *refs;
        if left == 0 {
            self.free.insert(layer);
        }
        Some(left)
    }

    /// References to `layer` (0 for a free or never-taken one).
    pub fn refs(&self, layer: u32) -> u32 {
        self.refs.get(layer as usize).copied().unwrap_or(0)
    }

    /// Whether `layer` holds a texture.
    pub fn is_live(&self, layer: u32) -> bool {
        self.refs(layer) > 0
    }

    /// Layers holding a texture.
    pub fn live(&self) -> u32 {
        self.high_water() - self.free.len() as u32
    }

    /// Layers ever taken (the array holds at least this many).
    pub fn high_water(&self) -> u32 {
        self.refs.len() as u32
    }

    /// Whether another layer can be taken.
    fn has_room(&self) -> bool {
        self.live() < self.cap
    }
}

/// One kind's texture array of one size class on the GPU. Today's arrays (`growing`) start at
/// one layer and grow by copy to a power of two, keeping each live layer's mip chain to refill; a
/// pre-sized size-class array is a 1 × 1 placeholder until its first texture, then allocated at
/// its cap. A compressed family's array (A6.4) is always pre-sized.
pub(crate) struct TextureArray {
    kind: TextureKind,
    family: TextureFamily,
    side: u32,
    cap: u32,
    growing: bool,
    layers: TextureLayers,
    /// A growing array's refill cache, by layer: None for a free layer.
    chains: Vec<Option<Vec<TextureData>>>,
    texture: Texture,
    view: TextureView,
}

impl TextureArray {
    /// Today's array: 256 layers growing to [`MAX_TEXTURE_LAYERS`], one blank layer so the bind
    /// group is valid before any texture is added.
    pub(crate) fn new(device: &Device, kind: TextureKind) -> TextureArray {
        TextureArray::growing(device, kind, MAX_TEXTURE_LAYERS)
    }

    /// An RGBA8 256 array growing by copy to at most `cap` layers, one blank layer to start.
    fn growing(device: &Device, kind: TextureKind, cap: u32) -> TextureArray {
        let family = TextureFamily::Rgba8;
        let (texture, view) = array_texture(device, kind, family, TEXTURE_LAYER_PX, 1);
        let layers = TextureLayers::new(cap);
        TextureArray { kind, family, side: TEXTURE_LAYER_PX, cap, growing: true, layers, chains: Vec::new(), texture, view }
    }

    /// A size-class array of `side` texels holding at most `cap` layers, allocated on its first
    /// texture.
    fn presized(device: &Device, kind: TextureKind, family: TextureFamily, side: u32, cap: u32) -> TextureArray {
        let placeholder = family.block_side();
        let (texture, view) = array_texture(device, kind, family, placeholder, 1);
        TextureArray { kind, family, side, cap, growing: false, layers: TextureLayers::new(cap), chains: Vec::new(), texture, view }
    }

    /// The view the shaders sample.
    pub(crate) fn view(&self) -> &TextureView {
        &self.view
    }

    /// Whether another layer fits: fewer than the cap are live.
    fn has_room(&self) -> bool {
        self.layers.has_room()
    }

    /// The array's side and layers as allocated.
    fn extent(&self) -> (u32, u32) {
        (self.texture.width(), self.texture.depth_or_array_layers())
    }

    /// The bytes allocated for textures (a placeholder counts none; an array whose layers were all
    /// removed keeps its allocation).
    fn allocated_bytes(&self) -> u64 {
        if self.layers.high_water() == 0 {
            return 0;
        }
        let (side, layers) = self.extent();
        match self.family {
            TextureFamily::Rgba8 => MaterialClass { size_px: side, layers }.bytes(),
            family => family.chain_bytes(side) * u64::from(layers),
        }
    }

    /// The bytes the textures it holds take (their layers' chains, not the array's reservation).
    fn held_bytes(&self) -> u64 {
        self.family.chain_bytes(self.side) * u64::from(self.layers.live())
    }

    /// The CPU bytes the refill cache keeps (live layers' chains of a growing array).
    fn cached_bytes(&self) -> u64 {
        self.chains.iter().flatten().flatten().map(|level| level.rgba.len() as u64).sum()
    }

    /// The refusal of a texture past the cap.
    fn full(&self) -> RenderError {
        RenderError::refused(RenderCode::TextureTooLarge, format!("{} {:?} textures live already", self.cap, self.kind))
    }

    /// A layer for the next texture (the lowest free one, else a new one), with a pre-sized array
    /// allocated at its cap on its first texture: no allocation when a freed layer is reused.
    fn take_layer(&mut self, device: &Device) -> Result<u32, RenderError> {
        let first = self.layers.high_water() == 0;
        let layer = self.layers.take().ok_or_else(|| self.full())?;
        if first && !self.growing {
            (self.texture, self.view) = array_texture(device, self.kind, self.family, self.side, self.cap);
        }
        Ok(layer)
    }

    /// Add a mip chain of this array's side in the next layer ([`TextureArray::take_layer`]),
    /// named as `kind` (this array's kind, or [`TextureKind::Normal`] in a data array).
    fn add_chain(&mut self, device: &Device, queue: &Queue, chain: Vec<TextureData>, kind: TextureKind) -> Result<TextureId, RenderError> {
        let layer = self.take_layer(device)?;
        let id = TextureId::in_class(kind, class_of_side(self.side), layer);
        if !self.growing {
            upload(queue, &self.texture, layer, &chain);
            return Ok(id);
        }
        let at = layer as usize;
        if at == self.chains.len() {
            self.chains.push(None);
        }
        self.chains[at] = Some(chain);
        if layer >= self.texture.depth_or_array_layers() {
            // Grow by copy: every live layer is refilled from its cached chain; free ones are not.
            let layers = (layer + 1).next_power_of_two().min(self.cap);
            (self.texture, self.view) = array_texture(device, self.kind, self.family, self.side, layers);
            for (at, chain) in self.chains.iter().enumerate() {
                if let Some(chain) = chain {
                    upload(queue, &self.texture, at as u32, chain);
                }
            }
        } else if let Some(chain) = &self.chains[at] {
            upload(queue, &self.texture, layer, chain);
        }
        Ok(id)
    }

    /// Add a compressed chain of this array's side (its family's blocks, level 0 first) in the
    /// next layer ([`TextureArray::take_layer`]: a freed one first), named as `kind`; the array is
    /// pre-sized, so it is allocated on its first layer.
    fn add_blocks(&mut self, device: &Device, queue: &Queue, levels: &[Vec<u8>], kind: TextureKind) -> Result<TextureId, RenderError> {
        let layer = self.take_layer(device)?;
        upload_blocks(queue, &self.texture, self.family, layer, levels);
        Ok(TextureId::in_class(kind, class_of_side(self.side), layer))
    }

    /// One more reference to the texture in `layer`: its count after, or None when it is free.
    fn retain(&mut self, layer: u32) -> Option<u32> {
        self.layers.retain(layer)
    }

    /// One reference fewer to the texture in `layer`: the count left, or None when it is free. At
    /// 0 the layer is free for the next texture and its cached chain is dropped; its texels stay
    /// until a new texture overwrites them.
    fn release(&mut self, layer: u32) -> Option<u32> {
        let left = self.layers.release(layer)?;
        if left == 0
            && let Some(chain) = self.chains.get_mut(layer as usize)
        {
            *chain = None;
        }
        Some(left)
    }

    /// Layers holding a texture.
    fn layers(&self) -> u32 {
        self.layers.live()
    }
}

/// The material texture arrays of every size class (RQ6.4): one colour and one data array per
/// class, each holding at most its [`class_layer_caps`] layers. With [`TextureQuality::OFF`] it
/// is today's single growing 256 class.
pub struct ClassArrays {
    class: DeviceClass,
    quality: TextureQuality,
    family: TextureFamily,
    arrays: Vec<[TextureArray; 2]>,
}

impl ClassArrays {
    /// The arrays `class` holds at `quality`; nothing is allocated before a class's first texture
    /// but today's one-layer 256 arrays when `quality` is off.
    pub fn new(device: &Device, class: DeviceClass, quality: TextureQuality) -> ClassArrays {
        ClassArrays::with_family(device, class, quality, TextureFamily::Rgba8)
    }

    /// The arrays `class` holds at `quality`, the larger size classes stored in `family` (A6.4):
    /// they take only [`CompressedTexture`]s of that family ([`ClassArrays::add_compressed`]) and
    /// are always pre-sized. Size class 0 (256) stays RGBA8 in every family, so an image without a
    /// compressed file (a generated texture, a source the import step could not encode) still
    /// loads, at most 256 texels a side; under a compressed family it holds only those fallbacks, so
    /// it grows by copy with them to its cap instead of taking the cap on the first (game systems
    /// GF, C-12). [`TextureFamily::Rgba8`] is [`ClassArrays::new`].
    pub fn with_family(device: &Device, class: DeviceClass, quality: TextureQuality, family: TextureFamily) -> ClassArrays {
        let caps = class_layer_caps(class, quality);
        let growing = quality == TextureQuality::OFF;
        let arrays = TextureClass::ALL
            .into_iter()
            .map(|texture_class| {
                let (side, cap) = (texture_class.side(), caps[texture_class.index() as usize]);
                let stored = if texture_class == TextureClass::S256 { TextureFamily::Rgba8 } else { family };
                let fallback = family != TextureFamily::Rgba8 && texture_class == TextureClass::S256;
                [TextureKind::Color, TextureKind::Data].map(|kind| {
                    if growing && texture_class == TextureClass::S256 {
                        TextureArray::new(device, kind)
                    } else if fallback {
                        TextureArray::growing(device, kind, cap)
                    } else {
                        TextureArray::presized(device, kind, stored, side, cap)
                    }
                })
            })
            .collect();
        ClassArrays { class, quality, family, arrays }
    }

    /// The family the larger size classes are stored in (class 0 is always RGBA8).
    pub fn family(&self) -> TextureFamily {
        self.family
    }

    /// The texture quality the arrays were made for.
    pub fn quality(&self) -> TextureQuality {
        self.quality
    }

    /// The device class the arrays were sized for.
    pub fn device_class(&self) -> DeviceClass {
        self.class
    }

    /// Whether no texture was added yet (the arrays can still be made again for another quality).
    /// Arrays whose textures were all removed are not empty: they keep their allocation.
    pub fn is_empty(&self) -> bool {
        self.arrays.iter().flatten().all(|array| array.layers.high_water() == 0)
    }

    /// Whether any texture lives past size class 0 (the shaders then sample the class arrays).
    pub fn uses_classes(&self) -> bool {
        self.arrays.iter().skip(1).flatten().any(|array| array.layers() > 0)
    }

    /// Add `data` to the smallest class holding its source (capped by the quality and the caps),
    /// or the next smaller class with room when that one is full, then a larger one with room;
    /// `texture-too-large` only when every class is full. A [`TextureKind::Normal`] texture goes
    /// through [`ClassArrays::add_normal_map`].
    pub fn add(&mut self, device: &Device, queue: &Queue, data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        if kind == TextureKind::Normal {
            return self.add_normal_map(device, queue, data);
        }
        if kind == TextureKind::Cutout {
            return self.place(device, queue, data, kind, |side| cutout_mip_chain(data, side));
        }
        self.place(device, queue, data, kind, |side| mip_chain(data, kind, side))
    }

    /// Add a tangent-space normal map (a [`TextureKind::Normal`] texture in the data arrays) with
    /// Toksvig mips when the quality says so ([`normal_mip_chain`]).
    pub fn add_normal_map(&mut self, device: &Device, queue: &Queue, data: &TextureData) -> Result<TextureId, RenderError> {
        let toksvig = self.quality.toksvig;
        self.place(device, queue, data, TextureKind::Normal, |side| normal_mip_chain(data, side, toksvig))
    }

    fn place(
        &mut self,
        device: &Device,
        queue: &Queue,
        data: &TextureData,
        kind: TextureKind,
        chain: impl FnOnce(u32) -> Vec<TextureData>,
    ) -> Result<TextureId, RenderError> {
        let at = usize::from(kind.is_data());
        // An image goes only where RGBA8 is stored: every class, or class 0 under a compressed
        // family (A6.4).
        let rgba8 = |class: &TextureClass| self.arrays[class.index() as usize][at].family == TextureFamily::Rgba8;
        let room = |class: &TextureClass| rgba8(class) && self.arrays[class.index() as usize][at].has_room();
        let largest = TextureClass::ALL.into_iter().rev().filter(rgba8).find(|class| self.arrays[class.index() as usize][at].cap > 0).unwrap_or(TextureClass::S256);
        let wanted = class_for_source(data.width, data.height, largest.min(self.quality.max_class));
        // The wanted class or a smaller one (resampled down), else a larger one (resampled up:
        // memory the ledger reserved anyway) rather than refusing while any class has room.
        let smaller = TextureClass::ALL.into_iter().rev().filter(|class| *class <= wanted).find(room);
        let chosen = smaller.or_else(|| TextureClass::ALL.into_iter().filter(|class| *class > wanted).find(room));
        let Some(chosen) = chosen else {
            return Err(RenderError::refused(RenderCode::TextureTooLarge, format!("every {kind:?} size class is full")));
        };
        let array = &mut self.arrays[chosen.index() as usize][at];
        let side = array.side;
        array.add_chain(device, queue, chain(side), kind)
    }

    /// Add a compressed texture of the arrays' family as `kind` (A6.4): its chain is never
    /// resampled, so it goes in the largest class of the family with room that its own size, the
    /// quality and the caps allow, its top levels dropped to that class's side. Refused
    /// `texture-invalid` for another family, a colour space other than `kind`'s (sRGB colour,
    /// linear data) or a texture under the family's smallest class (a caller loads its image
    /// instead), `texture-too-large` when every class it fits is full.
    pub fn add_compressed(&mut self, device: &Device, queue: &Queue, texture: &CompressedTexture, kind: TextureKind) -> Result<TextureId, RenderError> {
        let compressed = self.family != TextureFamily::Rgba8;
        if texture.family() != self.family || !compressed {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("a {:?} texture in {:?} arrays", texture.family(), self.family)));
        }
        if texture.is_srgb() != (kind.array() == TextureKind::Color) {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("an {} texture for a {kind:?} slot", if texture.is_srgb() { "sRGB" } else { "linear" })));
        }
        let at = usize::from(kind.is_data());
        let held = |class: &TextureClass| self.arrays[class.index() as usize][at].family == self.family;
        let largest = TextureClass::ALL.into_iter().rev().filter(held).find(|class| self.arrays[class.index() as usize][at].cap > 0).unwrap_or(TextureClass::S256);
        let wanted = class_for_source(texture.side(), texture.side(), largest.min(self.quality.max_class));
        let fits = |class: &TextureClass| held(class) && *class <= wanted && class.side() <= texture.side();
        if !TextureClass::ALL.iter().any(fits) {
            return Err(RenderError::refused(RenderCode::TextureInvalid, format!("{} texels is under the family's smallest size class", texture.side())));
        }
        let room = |class: &TextureClass| fits(class) && self.arrays[class.index() as usize][at].has_room();
        let Some(chosen) = TextureClass::ALL.into_iter().rev().find(room) else {
            return Err(RenderError::refused(RenderCode::TextureTooLarge, format!("every {kind:?} size class it fits is full")));
        };
        let array = &mut self.arrays[chosen.index() as usize][at];
        let levels = texture.chain_from(array.side).ok_or_else(|| RenderError::refused(RenderCode::TextureInvalid, "no level of the class's side"))?;
        array.add_blocks(device, queue, levels, kind)
    }

    /// One more reference to the texture `id` names (a second material using it): its count after.
    /// Refused `texture-invalid` when its layer holds no texture.
    pub fn retain(&mut self, id: TextureId) -> Result<u32, RenderError> {
        self.array_mut(id).retain(id.layer()).ok_or_else(|| not_live(id))
    }

    /// Drop one reference to the texture `id` names: the count left. At 0 its layer is free, and
    /// the next texture of that array takes it with no new allocation (STR-3). Refused
    /// `texture-invalid` when its layer holds no texture.
    pub fn remove(&mut self, id: TextureId) -> Result<u32, RenderError> {
        self.array_mut(id).release(id.layer()).ok_or_else(|| not_live(id))
    }

    /// Layers holding a texture in `class`'s `kind` array.
    pub fn live_layers(&self, class: TextureClass, kind: TextureKind) -> u32 {
        self.array(class, kind).layers()
    }

    /// The CPU bytes the growing arrays keep to refill on growth (each live layer's mip chain).
    pub fn cached_bytes(&self) -> u64 {
        self.arrays.iter().flatten().map(TextureArray::cached_bytes).sum()
    }

    /// The view the shaders sample for `class`'s `kind` array.
    pub fn view(&self, class: TextureClass, kind: TextureKind) -> &TextureView {
        self.array(class, kind).view()
    }

    /// The GPU texture behind `class`'s `kind` array (captures and readback tests).
    pub fn texture(&self, class: TextureClass, kind: TextureKind) -> &Texture {
        &self.array(class, kind).texture
    }

    /// `class`'s `kind` array as allocated: its side and layers (1 × 1 before its first texture).
    pub fn extent(&self, class: TextureClass, kind: TextureKind) -> (u32, u32) {
        self.array(class, kind).extent()
    }

    /// The bytes allocated for textures across every class (at most the ledger's reservation,
    /// [`material_arrays`]).
    pub fn allocated_bytes(&self) -> u64 {
        self.arrays.iter().flatten().map(TextureArray::allocated_bytes).sum()
    }

    /// The bytes the textures held take, each layer's chain in its array's family (A6.4: what a
    /// game's textures cost, beside [`ClassArrays::allocated_bytes`]' reservation of whole arrays).
    pub fn held_bytes(&self) -> u64 {
        self.arrays.iter().flatten().map(TextureArray::held_bytes).sum()
    }

    fn array(&self, class: TextureClass, kind: TextureKind) -> &TextureArray {
        &self.arrays[class.index() as usize][usize::from(kind.is_data())]
    }

    fn array_mut(&mut self, id: TextureId) -> &mut TextureArray {
        &mut self.arrays[id.class().index() as usize][usize::from(id.kind().is_data())]
    }
}

/// The refusal of a retain or remove of a layer that holds no texture.
fn not_live(id: TextureId) -> RenderError {
    RenderError::refused(RenderCode::TextureInvalid, format!("no {:?} texture lives in {:?} layer {}", id.kind(), id.class(), id.layer()))
}

/// A material array is sampled and written; a compressed one is also copied out, so its stored
/// blocks can be read back (RGBA8 arrays keep today's usage).
fn array_usage(family: TextureFamily) -> wgpu::TextureUsages {
    let usage = wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST;
    if family == TextureFamily::Rgba8 { usage } else { usage | wgpu::TextureUsages::COPY_SRC }
}

fn array_texture(device: &Device, kind: TextureKind, family: TextureFamily, side: u32, layers: u32) -> (Texture, TextureView) {
    let texture = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("texture array"),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers },
        mip_level_count: mip_level_count(side),
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: family.format(kind),
        usage: array_usage(family),
        view_formats: &[],
    });
    let view = texture.create_view(&wgpu::TextureViewDescriptor {
        dimension: Some(wgpu::TextureViewDimension::D2Array),
        ..Default::default()
    });
    (texture, view)
}

fn upload(queue: &Queue, texture: &Texture, layer: u32, chain: &[TextureData]) {
    for (level, mip) in chain.iter().enumerate() {
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: level as u32,
                origin: wgpu::Origin3d { x: 0, y: 0, z: layer },
                aspect: wgpu::TextureAspect::All,
            },
            &mip.rgba,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(mip.width * 4), rows_per_image: Some(mip.height) },
            wgpu::Extent3d { width: mip.width, height: mip.height, depth_or_array_layers: 1 },
        );
    }
}

/// Write a compressed chain (level 0 first) into `layer`: whole blocks, a mip under one block
/// written as its one block (WebGPU copies compressed levels at their block-rounded size).
fn upload_blocks(queue: &Queue, texture: &Texture, family: TextureFamily, layer: u32, levels: &[Vec<u8>]) {
    let side = family.block_side();
    for (level, data) in levels.iter().enumerate() {
        let px = (texture.width() >> level).max(1);
        let blocks = px.div_ceil(side);
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture, mip_level: level as u32, origin: wgpu::Origin3d { x: 0, y: 0, z: layer }, aspect: wgpu::TextureAspect::All },
            data,
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(blocks * family.block_bytes()), rows_per_image: Some(blocks) },
            wgpu::Extent3d { width: blocks * side, height: blocks * side, depth_or_array_layers: 1 },
        );
    }
}
