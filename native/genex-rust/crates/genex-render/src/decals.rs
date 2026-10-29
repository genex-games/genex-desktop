//! Clustered decals (renderer pass 2 A.10; prior art A7.4): boxes of the world that project a
//! texture onto every surface inside them, before lighting, so a poster on a wall, a puddle on the
//! road or grime along a kerb is part of the surface it lies on.
//!
//! - **What a game declares** ([`Decal`], `Lighting::decals`): the box (a model matrix over the unit
//!   cube centred at the origin; it projects along its local -y, so its local +y is the face a decal
//!   looks out of), up to three textures of the material arrays (an sRGB base colour whose alpha
//!   is the decal's shape, a tangent-space normal map, a glTF occlusion-roughness-metallic map), a
//!   tint and opacity, how much of the surface's colour, normal, roughness and metallic it replaces,
//!   and how it fades towards the box's top and bottom faces and on surfaces turned away from it.
//!   Hostile values are held or the decal dropped ([`Decal::held`]).
//! - **Which are drawn** ([`held_decals`]): at most the preset's `LightQuality::decals` (64 on
//!   desktops, 16 on phones; [`MAX_BINNED_DECALS`] whatever the preset), nearest the camera first;
//!   the last tenth of the kept decals fade out towards the first dropped one's distance
//!   ([`CAP_FADE_SHARE`]), so a decal crossing the cap fades instead of popping.
//! - **Rows and binning**: each decal's bounding sphere is binned with the lights
//!   (`cluster::ClusterKind::Decal`, LG-16: its own z-bins, the shared tile masks), and its row
//!   ([`GpuDecal`], [`DECAL_ROW_VEC4S`] `vec4<f32>`s) is written into the `light_ext` table after the
//!   light rows and every shadowed spot's matrix slot ([`rows_base`]). The decals take no binding of
//!   their own: the forward pass and the Level-2 v2 prelude already read `light_ext` and the bins, so
//!   the forward fragment stage stays at 6 storage buffers of 8 and every texture of a decal is a
//!   layer of the material size-class arrays (no sampled texture more).
//! - **Shading** (`shaders/lighting/decals.wgsl`, `gx_decals`; Godot 4.7.2
//!   `scene_forward_clustered.glsl` decal loop, MIT): before the ambient chunk, the fragment walks
//!   the decals of its tile and z-bin, projects its position into each box and samples the textures
//!   with explicit gradients of the projected position (taken in uniform control flow), then blends
//!   colour, normal, roughness, metallic and occlusion into the surface. Overlapping decals are
//!   blended in an order-independent way (each channel's weighted mean over the decals, covering
//!   `1 - prod(1 - alpha)`), so the picture never depends on the binned order, which follows the
//!   camera.
//!
//! A decal is not geometry: it cannot z-fight, and it follows the surface it lands on through every
//! level of detail. The prepass's normals are the meshes' own, so a decal's normal map reaches the
//! lighting, not GTAO or contact shadows (as in Godot).

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3, Vec4};

use crate::cluster::{CAP_FADE_SHARE, ClusterSphere, MAX_BINNED_DECALS};
use crate::layout::{LIGHT_EXT_VEC4S, MAX_SHADOW_SLOTS, NO_TEXTURE, SPOT_MATRIX_VEC4S};
use crate::texture::{TextureId, TextureKind, srgb_to_linear};

/// `vec4<f32>`s one decal takes in the `light_ext` table ([`GpuDecal`]; `GX_DECAL_ROW_VEC4S`).
pub const DECAL_ROW_VEC4S: usize = 7;
/// Decals a desktop preset draws at most (plan A.10: 64 on desktop).
pub const DESKTOP_DECALS: u32 = 64;
/// Decals a phone draws at most, whatever the preset (plan A.10: 16 on phones).
pub const MOBILE_DECALS: u32 = 16;
/// The opacity below which a decal is not drawn (a decal faded out by the cap, or declared clear).
pub const MIN_OPACITY: f32 = 1.0 / 1024.0;
/// The largest side of a decal's box, world units: a box past it is dropped (it could not be binned
/// usefully and is hostile input).
pub const MAX_SIDE: f32 = 4096.0;
/// The smallest side of a decal's box, world units: a flatter box is held to it (a box of zero depth
/// would project nothing and divide by zero).
pub const MIN_SIDE: f32 = 1e-3;
/// The default angle fade: surfaces turned up to this many degrees from the decal's face take it
/// whole ([`Decal::angle_fade`]).
pub const DEFAULT_ANGLE_FULL_DEGREES: f32 = 60.0;
/// The default angle fade: surfaces turned this many degrees or more from the decal's face take
/// none of it (no streaks down a wall from a decal on the floor).
pub const DEFAULT_ANGLE_NONE_DEGREES: f32 = 80.0;
/// The default share of the box's half-height over which a decal fades towards its top and bottom
/// faces ([`Decal::depth_fade`]).
pub const DEFAULT_DEPTH_FADE: f32 = 0.25;

/// A projected decal.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Decal {
    /// The box: the unit cube centred at the origin under this column-major model matrix (its
    /// scale is the box's size). It projects along its local -y: its local x is the textures' u,
    /// its local z their v.
    pub model: [f32; 16],
    /// Base colour (the colour arrays, sRGB): rgb times [`Decal::color`]; its alpha is the decal's
    /// shape. `None`: the box's whole cross-section in [`Decal::color`].
    pub albedo: Option<TextureId>,
    /// Tangent-space normal map (the data arrays, OpenGL convention: green up in the image).
    pub normal: Option<TextureId>,
    /// glTF occlusion (red), roughness (green) and metallic (blue) map (the data arrays).
    pub orm: Option<TextureId>,
    /// Linear rgb tint of the base colour.
    pub color: [f32; 3],
    /// The decal's opacity, 0..1 (times the base colour's alpha).
    pub opacity: f32,
    /// How much of the surface's base colour it replaces where it lies whole, 0..1 (0: a decal that
    /// only changes the normal or the roughness, a puddle's ripples).
    pub albedo_mix: f32,
    /// How strongly its normal map tilts the surface, 0..1 or more (0: no normal change).
    pub normal_strength: f32,
    /// How far it eases the surface's shading normal towards its geometric normal before its own
    /// normal map tilts it, 0..1: a puddle's film is flat over a bumpy road (1), a poster follows
    /// the wall's bumps (0).
    pub flatten: f32,
    /// The roughness it gives the surface (times the ORM map's green), `None`: the surface's own.
    pub roughness: Option<f32>,
    /// The metallic it gives the surface (times the ORM map's blue), `None`: the surface's own.
    pub metallic: Option<f32>,
    /// How strongly the ORM map's occlusion darkens the surface's indirect light, 0..1.
    pub occlusion: f32,
    /// The share of the box's half-height over which it fades towards the top and bottom faces,
    /// 0..1 (0: a hard cut at the faces).
    pub depth_fade: f32,
    /// The angles in degrees between a surface's normal and the decal's face (its local +y) at
    /// which it starts to fade and has faded out: (full, none).
    pub angle_fade: [f32; 2],
}

impl Decal {
    /// A decal of `color` over the box `model`, whole, replacing the surface's colour, with the
    /// default fades and no textures.
    pub fn new(model: [f32; 16]) -> Decal {
        Decal {
            model,
            albedo: None,
            normal: None,
            orm: None,
            color: [1.0; 3],
            opacity: 1.0,
            albedo_mix: 1.0,
            normal_strength: 1.0,
            flatten: 0.0,
            roughness: None,
            metallic: None,
            occlusion: 0.0,
            depth_fade: DEFAULT_DEPTH_FADE,
            angle_fade: [DEFAULT_ANGLE_FULL_DEGREES, DEFAULT_ANGLE_NONE_DEGREES],
        }
    }

    /// The decal with `albedo` as its base colour map.
    pub fn with_albedo(self, albedo: TextureId) -> Decal {
        Decal { albedo: Some(albedo), ..self }
    }

    /// The decal with `normal` as its normal map, tilting by `strength`.
    pub fn with_normal(self, normal: TextureId, strength: f32) -> Decal {
        Decal { normal: Some(normal), normal_strength: strength, ..self }
    }

    /// The decal with `orm` as its occlusion-roughness-metallic map.
    pub fn with_orm(self, orm: TextureId) -> Decal {
        Decal { orm: Some(orm), ..self }
    }

    /// The decal tinted by the sRGB colour `rgb`.
    pub fn with_srgb(self, rgb: [u8; 3]) -> Decal {
        Decal { color: rgb.map(srgb_to_linear), ..self }
    }

    /// The decal giving the surfaces it covers `roughness` (and, with `metallic`, that metallic).
    pub fn with_surface(self, roughness: Option<f32>, metallic: Option<f32>) -> Decal {
        Decal { roughness, metallic, ..self }
    }

    /// Its box's centre and the sphere around the box (what binning reads), or `None` for a
    /// matrix that is not finite.
    pub fn sphere(&self) -> ClusterSphere {
        let model = Mat4::from_cols_array(&self.model);
        let centre = model.w_axis.truncate();
        let half = 0.5 * (model.x_axis.truncate().length_squared() + model.y_axis.truncate().length_squared() + model.z_axis.truncate().length_squared()).sqrt();
        ClusterSphere { centre: centre.to_array(), radius: half }
    }

    /// The decal with every value held to what the shading takes, or `None` when it cannot be
    /// drawn: a matrix that is not finite or not invertible (a box side past [`MAX_SIDE`], or a
    /// sheared one), or an opacity that is not a positive number. Sides below [`MIN_SIDE`] are held
    /// to it; the mixes, strengths and fades are clamped to their ranges; a texture of the wrong
    /// array is left out.
    pub fn held(&self) -> Option<Decal> {
        let model = Mat4::from_cols_array(&self.model);
        let visible = self.opacity.is_finite() && self.opacity > 0.0;
        if !model.is_finite() || !visible {
            return None;
        }
        let axes = [model.x_axis.truncate(), model.y_axis.truncate(), model.z_axis.truncate()];
        let lengths = axes.map(Vec3::length);
        if lengths.iter().any(|length| !length.is_finite() || *length > MAX_SIDE) {
            return None;
        }
        // A side below the floor (a zero-depth box) keeps its direction where it has one; a
        // degenerate axis takes the one the other two leave.
        let units = [axes[0].normalize_or_zero(), axes[1].normalize_or_zero(), axes[2].normalize_or_zero()];
        let held_axes = held_axes(units, lengths)?;
        let held_model = Mat4::from_cols(held_axes[0].extend(0.0), held_axes[1].extend(0.0), held_axes[2].extend(0.0), model.w_axis);
        if held_model.determinant().abs() < MIN_SIDE * MIN_SIDE * MIN_SIDE * 0.5 {
            return None;
        }
        let unit = |value: f32| if value.is_finite() { value.clamp(0.0, 1.0) } else { 0.0 };
        let kind = |texture: Option<TextureId>, kind: TextureKind| texture.filter(|t| t.kind().array() == kind);
        let angles = self.angle_fade.map(|degrees| if degrees.is_finite() { degrees.clamp(0.0, 180.0) } else { DEFAULT_ANGLE_NONE_DEGREES });
        Some(Decal {
            model: held_model.to_cols_array(),
            albedo: kind(self.albedo, TextureKind::Color),
            normal: kind(self.normal, TextureKind::Data),
            orm: kind(self.orm, TextureKind::Data),
            color: self.color.map(|c| if c.is_finite() { c.max(0.0) } else { 0.0 }),
            opacity: self.opacity.min(1.0),
            albedo_mix: unit(self.albedo_mix),
            normal_strength: if self.normal_strength.is_finite() { self.normal_strength.clamp(0.0, 4.0) } else { 0.0 },
            flatten: unit(self.flatten),
            roughness: self.roughness.filter(|r| r.is_finite()).map(|r| r.clamp(0.0, 1.0)),
            metallic: self.metallic.filter(|m| m.is_finite()).map(|m| m.clamp(0.0, 1.0)),
            occlusion: unit(self.occlusion),
            depth_fade: unit(self.depth_fade),
            angle_fade: [angles[0].min(angles[1]), angles[0].max(angles[1])],
        })
    }

    /// The decal's row as the shading reads it ([`GpuDecal`]), at `opacity` (its own times the
    /// cap's fade). The decal must be [`Decal::held`].
    pub fn to_gpu(&self, opacity: f32) -> GpuDecal {
        let model = Mat4::from_cols_array(&self.model);
        let world_to_box = model.inverse();
        let row = |i: usize| world_to_box.row(i).to_array();
        let reference = |texture: Option<TextureId>| f32::from_bits(texture.map_or(NO_TEXTURE, TextureId::reference));
        let keep = |value: Option<f32>| value.unwrap_or(-1.0);
        let [full, none] = self.angle_fade;
        GpuDecal {
            world_to_box: [row(0), row(1), row(2)],
            textures: [reference(self.albedo), reference(self.normal), reference(self.orm), self.flatten],
            color: [self.color[0], self.color[1], self.color[2], self.opacity * opacity],
            surface: [self.albedo_mix, self.normal_strength, keep(self.roughness), keep(self.metallic)],
            fade: [self.depth_fade, libm::cosf(full.to_radians()), libm::cosf(none.to_radians()), self.occlusion],
        }
    }
}

/// The box's three axes held: each at least [`MIN_SIDE`] long along its own direction, a
/// degenerate one (zero length) along the cross product of the other two; `None` when two or more
/// are degenerate.
fn held_axes(units: [Vec3; 3], lengths: [f32; 3]) -> Option<[Vec3; 3]> {
    let degenerate = units.iter().filter(|unit| **unit == Vec3::ZERO).count();
    if degenerate > 1 {
        return None;
    }
    let mut directions = units;
    for i in 0..3 {
        if directions[i] == Vec3::ZERO {
            directions[i] = directions[(i + 1) % 3].cross(directions[(i + 2) % 3]).normalize_or_zero();
        }
    }
    Some([0, 1, 2].map(|i| directions[i] * lengths[i].max(MIN_SIDE)))
}

/// One decal's row (`GX_DECAL_ROW_VEC4S` `vec4<f32>`s of the `light_ext` table, in binned order
/// from [`rows_base`]).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuDecal {
    /// The world-to-box transform's first three rows (affine): the box is -0.5..0.5 on each axis.
    pub world_to_box: [[f32; 4]; 3],
    /// The textures' references (`layout::texture_ref`) as f32 bits: x base colour, y normal map,
    /// z ORM map (`NO_TEXTURE` bits: none); w the flatten (a plain f32, [`Decal::flatten`]).
    pub textures: [f32; 4],
    /// Linear rgb tint; a: the opacity (the decal's times the cap's fade).
    pub color: [f32; 4],
    /// x: the base colour mix; y: the normal strength; z: the roughness (-1: the surface's); w: the
    /// metallic (-1: the surface's).
    pub surface: [f32; 4],
    /// x: the depth fade's share of the half-height; y, z: the cosines of the angle fade's full and
    /// none angles; w: the occlusion strength.
    pub fade: [f32; 4],
}

const _: () = assert!(size_of::<GpuDecal>() == DECAL_ROW_VEC4S * 16);

/// The first `vec4<f32>` of the decal rows in the `light_ext` table of a frame binning `lights`
/// lights: after every light's extension rows and every shadowed spot's matrix slot (filled or
/// not), so the rows' place never depends on the spots this frame shadows.
pub const fn rows_base(lights: usize) -> usize {
    LIGHT_EXT_VEC4S * lights + SPOT_MATRIX_VEC4S * MAX_SHADOW_SLOTS
}

/// The decals a frame draws: `decals` held ([`Decal::held`]; the dropped ones left out), cut to
/// `cap` (at most [`MAX_BINNED_DECALS`]) nearest `eye` first by the distance to their box's
/// sphere, the last [`CAP_FADE_SHARE`] of the kept ones faded towards the first dropped one's
/// distance. Answers each kept decal with its opacity scale (1: whole), in declaration order.
/// Deterministic: the same decals and eye give the same rows on every run and destination.
pub fn held_decals(decals: &[Decal], cap: usize, eye: [f32; 3]) -> Vec<(Decal, f32)> {
    let cap = cap.min(MAX_BINNED_DECALS);
    let held: Vec<Decal> = decals.iter().filter_map(Decal::held).collect();
    if cap == 0 || held.is_empty() {
        return Vec::new();
    }
    let eye = Vec3::from(eye);
    let reach = |decal: &Decal| {
        let sphere = decal.sphere();
        (Vec3::from(sphere.centre).distance(eye) - sphere.radius).max(0.0)
    };
    let mut nearest: Vec<(f32, usize)> = held.iter().enumerate().map(|(row, decal)| (reach(decal), row)).collect();
    nearest.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    let mut scale = vec![0.0_f32; held.len()];
    for (_, row) in nearest.iter().take(cap) {
        scale[*row] = 1.0;
    }
    if nearest.len() > cap {
        let band = ((cap as f32 * CAP_FADE_SHARE).ceil() as usize).clamp(1, cap);
        let start = if cap > band { nearest[cap - band - 1].0 } else { 0.0 };
        let cut = nearest[cap].0;
        if cut > start && cut.is_finite() {
            for (distance, row) in &nearest[cap - band..cap] {
                let t = ((cut - distance) / (cut - start)).clamp(0.0, 1.0);
                scale[*row] = t * t * (3.0 - 2.0 * t);
            }
        }
    }
    held.into_iter().zip(scale).filter(|(decal, scale)| decal.opacity * scale >= MIN_OPACITY).collect()
}

/// Tighten the tile rectangles of `bins`' decals (renderer pass 2 A.10): binning bounds a decal by
/// its box's sphere, which for a flat box (a poster, a puddle) covers about twice the tiles the box
/// does, and every pixel of those tiles walks it. Where all eight corners of a decal's box are in
/// front of the near plane, its rectangle becomes the tiles its corners' screen rectangle touches
/// (grown by `cluster::TILE_MARGIN_PX`, as binning grows a sphere's), within the sphere's: the
/// box's projection is inside its corners' convex hull, so no pixel inside the box loses it. Its
/// z-bins stay the sphere's. `decals` are the decals binned (`bins.decals` indexes them).
pub fn tighten_bounds(bins: &mut crate::cluster::LightBinFrame, decals: &[(Decal, f32)], camera: &crate::scene::CameraDesc, render: (u32, u32)) {
    let (width, height) = (render.0.max(1) as f32, render.1.max(1) as f32);
    let view_proj = camera.view_proj(width / height);
    let grid = bins.grid;
    let first = bins.first_index(crate::cluster::ClusterKind::Decal) as usize;
    let tile = grid.tile_px.max(1) as f32;
    let last = (grid.tiles_x.saturating_sub(1), grid.tiles_y.saturating_sub(1));
    for (i, row) in bins.decals.iter().enumerate() {
        let Some(bounds) = bins.bounds.get_mut(first + i) else { continue };
        let Some((decal, _)) = decals.get(*row as usize) else { continue };
        if *bounds == crate::cluster::BOUNDS_EMPTY {
            continue;
        }
        let Some([x0, y0, x1, y1]) = corner_pixels(&view_proj, &Mat4::from_cols_array(&decal.model), camera.near, (width, height)) else { continue };
        let margin = crate::cluster::TILE_MARGIN_PX;
        let off_screen = x1 + margin < 0.0 || y1 + margin < 0.0 || x0 - margin >= width || y0 - margin >= height;
        if off_screen {
            *bounds = crate::cluster::BOUNDS_EMPTY;
            continue;
        }
        let at = |pixel: f32, last: u32| ((pixel.max(0.0) / tile) as u32).min(last);
        let tight = [at(x0 - margin, last.0), at(y0 - margin, last.1), at(x1 + margin, last.0), at(y1 + margin, last.1)];
        let held = [bounds[0] & 0xFFFF, bounds[0] >> 16, bounds[1] & 0xFFFF, bounds[1] >> 16];
        let rect = [tight[0].max(held[0]), tight[1].max(held[1]), tight[2].min(held[2]), tight[3].min(held[3])];
        if rect[0] > rect[2] || rect[1] > rect[3] {
            *bounds = crate::cluster::BOUNDS_EMPTY;
            continue;
        }
        bounds[0] = rect[0] | (rect[1] << 16);
        bounds[1] = rect[2] | (rect[3] << 16);
    }
}

/// The pixel rectangle `[x0, y0, x1, y1]` (y down) the eight corners of the unit box under `model`
/// project into for `view_proj` drawing a `size` frame, or `None` when a corner is not in front of
/// the near plane `near` (or projects to no number).
fn corner_pixels(view_proj: &Mat4, model: &Mat4, near: f32, (width, height): (f32, f32)) -> Option<[f32; 4]> {
    let mut rect = [f32::INFINITY, f32::INFINITY, f32::NEG_INFINITY, f32::NEG_INFINITY];
    for corner in 0..8 {
        let local = Vec3::new(if corner & 1 == 0 { -0.5 } else { 0.5 }, if corner & 2 == 0 { -0.5 } else { 0.5 }, if corner & 4 == 0 { -0.5 } else { 0.5 });
        let clip = *view_proj * model.transform_point3(local).extend(1.0);
        let in_front = clip.w > near;
        if !in_front {
            return None;
        }
        let (x, y) = ((clip.x / clip.w + 1.0) * 0.5 * width, (1.0 - clip.y / clip.w) * 0.5 * height);
        if !x.is_finite() || !y.is_finite() {
            return None;
        }
        rect = [rect[0].min(x), rect[1].min(y), rect[2].max(x), rect[3].max(y)];
    }
    Some(rect)
}

/// The `light_ext` table's bytes with `decals` (rows in binned order) after `light_ext`'s own
/// bytes (every light's extension rows, then the shadowed spots' matrices): the spot slots padded
/// with zeros to [`MAX_SHADOW_SLOTS`], then the rows from [`rows_base`]. Without decals the
/// bytes are `light_ext` unchanged.
pub fn append_rows(mut light_ext: Vec<u8>, lights: usize, decals: &[GpuDecal]) -> Vec<u8> {
    if decals.is_empty() {
        return light_ext;
    }
    let base = rows_base(lights) * size_of::<Vec4>();
    light_ext.resize(base.max(light_ext.len()), 0);
    light_ext.truncate(base);
    light_ext.extend_from_slice(bytemuck::cast_slice(decals));
    light_ext
}

#[cfg(test)]
mod tests {
    use super::*;

    fn box_at(x: f32, size: f32) -> [f32; 16] {
        Mat4::from_scale_rotation_translation(Vec3::splat(size), glam::Quat::IDENTITY, Vec3::new(x, 0.0, 0.0)).to_cols_array()
    }

    #[test]
    fn the_row_maps_the_box_onto_the_unit_cube() {
        let model = Mat4::from_scale_rotation_translation(Vec3::new(2.0, 0.5, 4.0), glam::Quat::from_rotation_y(0.7), Vec3::new(1.0, 2.0, 3.0));
        let row = Decal::new(model.to_cols_array()).held().expect("held").to_gpu(1.0);
        let corner = model.transform_point3(Vec3::splat(0.5));
        let local: Vec<f32> = row.world_to_box.iter().map(|r| Vec4::from(*r).dot(corner.extend(1.0))).collect();
        for value in local {
            assert!((value - 0.5).abs() < 1e-5, "{value}");
        }
    }

    #[test]
    fn hostile_boxes_are_dropped_or_held() {
        let mut nan = Decal::new(Mat4::IDENTITY.to_cols_array());
        nan.model[0] = f32::NAN;
        assert_eq!(nan.held(), None, "a matrix that is not finite");
        assert_eq!(Decal::new(box_at(0.0, 1e5)).held(), None, "a side past MAX_SIDE");
        assert_eq!(Decal::new(Mat4::from_scale(Vec3::new(0.0, 0.0, 1.0)).to_cols_array()).held(), None, "two degenerate axes");
        let flat = Decal::new(Mat4::from_scale(Vec3::new(1.0, 0.0, 1.0)).to_cols_array()).held().expect("a flat box is held");
        assert!((Mat4::from_cols_array(&flat.model).y_axis.length() - MIN_SIDE).abs() < 1e-7);
        let zero = Decal { opacity: 0.0, ..Decal::new(Mat4::IDENTITY.to_cols_array()) };
        assert_eq!(zero.held(), None, "no opacity");
    }

    #[test]
    fn without_decals_the_light_table_is_unchanged() {
        let bytes = vec![7_u8; 64];
        assert_eq!(append_rows(bytes.clone(), 2, &[]), bytes);
        let with = append_rows(bytes.clone(), 2, &[GpuDecal::default()]);
        assert_eq!(&with[..64], &bytes[..]);
        assert_eq!(with.len(), rows_base(2) * 16 + DECAL_ROW_VEC4S * 16);
    }
}
