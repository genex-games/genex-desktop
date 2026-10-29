//! The scene's lights and the tables they become (RQ6.0, split out of `pbr.rs`): the sun and
//! ambient light (frame uniforms), and local lights, points and spots, as the light table
//! ([`GpuLight`]) plus its parallel extension table ([`GpuLightExt`]). The binned path (RQ6.1,
//! RQ6.2; every preset, on the HDR and the LDR scene) shades [`binned_frame`]'s lights through
//! per-tile masks and z-bins (`crate::cluster`); the legacy loop (the `off` quality, the
//! `clustered` switch off) shades [`legacy_lights`], points and spots, in scene order.
//!
//! Shading (RQ6.2, `shaders/lighting/local_lights.wgsl`): the legacy path keeps its range falloff
//! ([`legacy_falloff`]); the binned path lights points and spots with the windowed inverse-square
//! falloff ([`windowed_falloff`]) and the smooth cone ([`spot_cone`]), walking the fragment's tile
//! mask intersected with its z-bin's index range in light-index order. [`binned_frame`] gives a
//! frame's tables: the lights in binned order and their bins (`crate::cluster::LightBinFrame`,
//! built by graph node 4 or its CPU reference). [`BINNED_SHADING_LANDED`] says whether the
//! renderer's forward pass draws through them.

use crate::cluster::{ClusterInput, LightBinFrame};
use crate::layout::{GpuLight, GpuLightExt, GpuLocalLight, LIGHT_KIND_POINT, LIGHT_KIND_SPOT, MAX_LIGHTS, MAX_LOCAL_LIGHTS, NO_SHADOW_SLOT, SPOT_SHADOW_UNFADED};
#[cfg(doc)]
use crate::layout::MAX_SHADOWED_SPOTS;
use crate::scene::CameraDesc;
use crate::settings::LightQuality;
use crate::probes::ReflectionProbe;
use crate::texture::srgb_to_linear;

/// Whether the renderer's forward pass shades local lights through the bins (RQ6.2's forward seam:
/// the pass declares the binned tables and the frame uploads [`binned_frame`] with their bins).
/// Until it does, every frame shades the legacy light table.
pub const BINNED_SHADING_LANDED: bool = true;

/// The shortest distance the windowed falloff divides by, in world units (`max(d², 0.01²)`), so a
/// surface at a light's centre stays finite.
pub const LIGHT_MIN_DISTANCE: f32 = 0.01;
/// The narrowest cone transition the smooth cone divides by (`cos inner - cos outer`): an inner
/// angle equal to the outer one is a hard edge, never a division by zero.
pub const SPOT_MIN_TRANSITION: f32 = 1e-4;

/// The widest spot cone, as a half-angle in radians: just under 90 degrees, so a shadowed spot's
/// perspective projection stays finite.
pub const SPOT_OUTER_ANGLE_MAX: f32 = 1.5533; // 89 degrees
/// The narrowest spot cone, as a half-angle in radians.
pub const SPOT_OUTER_ANGLE_MIN: f32 = 0.001;

/// What a local light is (`LightExt::params.y` on the GPU).
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LightKind {
    /// Light in every direction from a point.
    Point,
    /// A point light inside a cone.
    Spot,
}

/// A point light.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PointLight {
    /// Position.
    pub position: [f32; 3],
    /// Distance at which it fades to nothing.
    pub range: f32,
    /// sRGB colour.
    pub color: [u8; 3],
    /// Radiance multiplier.
    pub intensity: f32,
}

/// A spot light (RQ6.0; shaded from RQ6.2, shadowed from RQ6.5): a point light inside a cone that
/// fades from its inner to its outer half-angle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpotLight {
    /// Position.
    pub position: [f32; 3],
    /// The direction the cone points along (normalized when the table is built; a zero vector
    /// points down).
    pub direction: [f32; 3],
    /// Distance at which it fades to nothing.
    pub range: f32,
    /// sRGB colour.
    pub color: [u8; 3],
    /// Radiance multiplier.
    pub intensity: f32,
    /// Half-angle in radians inside which the light is at full strength (at most `outer_angle`).
    pub inner_angle: f32,
    /// Half-angle in radians past which the light is dark, within
    /// [`SPOT_OUTER_ANGLE_MIN`]..=[`SPOT_OUTER_ANGLE_MAX`].
    pub outer_angle: f32,
    /// Whether it asks for a shadow map (granted after binning to the asking spots whose cones
    /// reach the screen, nearest first, up to the preset's `LightQuality::shadowed_spots`; the
    /// legacy loop draws no spot shadow).
    pub shadow: bool,
}

/// The view depth over which the legacy renderer's sun casts shadows (`Quality::off()`'s
/// `ShadowQuality::distance`).
pub const DEFAULT_SHADOW_DISTANCE: f32 = 40.0;
/// A scene's shadow distance by default: 0, the quality's (each preset's own, the legacy
/// renderer's [`DEFAULT_SHADOW_DISTANCE`]).
pub const QUALITY_SHADOW_DISTANCE: f32 = 0.0;

/// The scene's lights: a sun (casting cascaded shadows), ambient light, point lights and spot
/// lights. The binned path shades up to the preset's cap of them (`LightQuality::cap`, nearest
/// first); the legacy loop ([`legacy_lights`]) up to the cap and [`MAX_LIGHTS`].
#[derive(Clone, Debug, PartialEq)]
pub struct Lighting {
    /// Direction towards the sun.
    pub sun_dir: [f32; 3],
    /// sRGB sun colour.
    pub sun_color: [u8; 3],
    /// Sun radiance multiplier.
    pub sun_intensity: f32,
    /// sRGB ambient colour.
    pub ambient: [u8; 3],
    /// Ambient multiplier.
    pub ambient_intensity: f32,
    /// Point lights.
    pub points: Vec<PointLight>,
    /// The indices into `points` of the point lights asking for a cube shadow map (AAA review
    /// WP-15): granted after binning to the asking ones that reach the screen, nearest first, up to
    /// the preset's `LightQuality::shadowed_points`; the legacy loop draws none.
    pub shadowed_points: Vec<usize>,
    /// Spot lights.
    pub spots: Vec<SpotLight>,
    /// Whether the sun casts shadows (cascades drawn through the culled indirect path).
    pub shadows: bool,
    /// The reflection probes (renderer pass 2 A.3, [`crate::probes`]): binned with the lights,
    /// the first the quality's `reflection_probes` of them captured into cubes.
    pub reflection_probes: Vec<ReflectionProbe>,
    /// The irradiance volumes (renderer pass 2 A.4, [`crate::irradiance`]): binned with the lights
    /// after the reflection probes, the first the quality's `irradiance_volumes` of them baked.
    pub irradiance_volumes: Vec<crate::irradiance::IrradianceVolume>,
    /// The projected decals (renderer pass 2 A.10, [`crate::decals`]): binned with the lights on
    /// the binned path, the nearest the quality's `decals` of them drawn.
    pub decals: Vec<crate::decals::Decal>,
    /// How far from the camera, in view depth, shadows reach; 0 (the default) takes the quality's
    /// distance (`ShadowQuality::distance`: 40 on the legacy renderer, longer on higher presets).
    pub shadow_distance: f32,
}

impl Default for Lighting {
    fn default() -> Self {
        Lighting {
            sun_dir: [0.4, 1.0, 0.3],
            sun_color: [255, 255, 255],
            sun_intensity: 2.5,
            ambient: [255, 255, 255],
            ambient_intensity: 0.08,
            points: Vec::new(),
            shadowed_points: Vec::new(),
            spots: Vec::new(),
            shadows: true,
            shadow_distance: QUALITY_SHADOW_DISTANCE,
            reflection_probes: Vec::new(),
            irradiance_volumes: Vec::new(),
            decals: Vec::new(),
        }
    }
}

/// Linear radiance of an sRGB colour times `intensity`.
pub(crate) fn radiance(color: [u8; 3], intensity: f32) -> [f32; 4] {
    let [r, g, b] = color.map(srgb_to_linear);
    [r * intensity, g * intensity, b * intensity, 0.0]
}

/// The light-table row of a light at `position` reaching `range`.
fn light_row(position: [f32; 3], range: f32, color: [u8; 3], intensity: f32) -> GpuLight {
    let [x, y, z] = position;
    GpuLight { position_range: [x, y, z, range.max(f32::MIN_POSITIVE)], color: radiance(color, intensity) }
}

/// The light table: the first [`MAX_LIGHTS`] point lights, in scene order.
pub fn light_table(lighting: &Lighting) -> Vec<GpuLight> {
    lighting.points.iter().take(MAX_LIGHTS).map(|light| light_row(light.position, light.range, light.color, light.intensity)).collect()
}

/// `direction` normalized; a zero or non-finite vector points down.
fn unit_or_down(direction: [f32; 3]) -> [f32; 3] {
    let [x, y, z] = direction;
    let length = (x * x + y * y + z * z).sqrt();
    if !length.is_finite() || length <= f32::EPSILON {
        return [0.0, -1.0, 0.0];
    }
    [x / length, y / length, z / length]
}

/// The extension row of `spot`, holding shadow slot `slot` (or none).
fn spot_ext(spot: &SpotLight, slot: Option<usize>) -> GpuLightExt {
    let outer = if spot.outer_angle.is_finite() { spot.outer_angle.clamp(SPOT_OUTER_ANGLE_MIN, SPOT_OUTER_ANGLE_MAX) } else { SPOT_OUTER_ANGLE_MAX };
    let inner = if spot.inner_angle.is_finite() { spot.inner_angle.clamp(0.0, outer) } else { 0.0 };
    let [x, y, z] = unit_or_down(spot.direction);
    let shadow = slot.map_or(NO_SHADOW_SLOT, |slot| slot as f32);
    GpuLightExt { spot: [x, y, z, libm::cosf(outer)], params: [libm::cosf(inner), LIGHT_KIND_SPOT, shadow, SPOT_SHADOW_UNFADED] }
}

/// The local-light rows of the binned path, in scene order: every point light, then every spot
/// light, at most `cap` (and [`MAX_LOCAL_LIGHTS`]) rows. This is the table's limit, kept in scene
/// order so rows never depend on the camera; the preset's cap (`LightQuality::cap`) is applied
/// when the rows are binned, nearest first ([`crate::cluster::binned_order`]). Spots asking for a
/// shadow map are marked with their request order 0, 1, .. (scene order) while `shadow_requests`
/// last; the rest are lit unshadowed. A mark is a request, not a slot: the frame grants
/// `LightQuality::shadowed_spots` (at most [`MAX_SHADOWED_SPOTS`]) slots after binning, to the
/// requests whose cones reach the screen, nearest first (`spot_shadow::grant`). A point light's
/// base row equals its [`light_table`] row.
pub fn local_lights(lighting: &Lighting, cap: usize, shadow_requests: usize) -> Vec<GpuLocalLight> {
    let cap = cap.min(MAX_LOCAL_LIGHTS);
    let slots = shadow_requests;
    let mut asked = 0;
    let points = lighting.points.iter().enumerate().map(move |(index, light)| {
        // A shadow-asking point light is marked with its request order, as a spot is (AAA review
        // WP-15); `spot_shadow::grant_points` turns the mark into its faces' first slot or clears it.
        let request = lighting.shadowed_points.contains(&index).then(|| {
            asked += 1;
            asked - 1
        });
        let ext = match request {
            Some(request) => GpuLightExt { params: [-1.0, LIGHT_KIND_POINT, request as f32, SPOT_SHADOW_UNFADED], ..GpuLightExt::POINT },
            None => GpuLightExt::POINT,
        };
        GpuLocalLight { light: light_row(light.position, light.range, light.color, light.intensity), ext }
    });
    let mut granted = 0;
    let spots = lighting.spots.iter().map(move |spot| {
        let slot = (spot.shadow && granted < slots).then(|| {
            granted += 1;
            granted - 1
        });
        GpuLocalLight { light: light_row(spot.position, spot.range, spot.color, spot.intensity), ext: spot_ext(spot, slot) }
    });
    points.chain(spots).take(cap).collect()
}

/// The two tables `lights` is written into, row for row: the light table and the extension table.
pub fn split_rows(lights: &[GpuLocalLight]) -> (Vec<GpuLight>, Vec<GpuLightExt>) {
    lights.iter().map(|row| (row.light, row.ext)).unzip()
}

/// The kind a light-extension row stores.
pub fn kind_of(ext: &GpuLightExt) -> LightKind {
    if ext.params[1] == LIGHT_KIND_SPOT { LightKind::Spot } else { LightKind::Point }
}

/// The binned path's windowed inverse-square falloff (Frostbite, Lagarde and de Rousiers 2014;
/// UE4, Karis 2013): `saturate(1 - (d / r)⁴)² / max(d², 0.01²)`. Exactly 0 from `range` on, so a
/// light past its range adds nothing and binning it by its range culls nothing it lights. The CPU
/// mirror of `gx_light_window`.
pub fn windowed_falloff(distance: f32, range: f32) -> f32 {
    let ratio = distance / range;
    let ratio2 = ratio * ratio;
    let window = (1.0 - ratio2 * ratio2).clamp(0.0, 1.0);
    window * window / (distance * distance).max(LIGHT_MIN_DISTANCE * LIGHT_MIN_DISTANCE)
}

/// The legacy forward path's range falloff, unchanged by RQ6: `saturate(1 - d / r)² / max(d², 0.01)`.
/// The CPU mirror of the legacy loop in `gx_local_lights`.
pub fn legacy_falloff(distance: f32, range: f32) -> f32 {
    let falloff = (1.0 - distance / range).clamp(0.0, 1.0);
    falloff * falloff / (distance * distance).max(0.01)
}

/// A spot's smooth cone at a direction whose cosine to the cone's axis is `cos_angle`:
/// `saturate((cos θ - cos outer) / max(cos inner - cos outer, 1e-4))²`, 1 inside the inner
/// half-angle, 0 past the outer one. The CPU mirror of `gx_spot_cone`.
pub fn spot_cone(cos_angle: f32, cos_outer: f32, cos_inner: f32) -> f32 {
    let t = ((cos_angle - cos_outer) / (cos_inner - cos_outer).max(SPOT_MIN_TRANSITION)).clamp(0.0, 1.0);
    t * t
}

/// One frame's local lights on the binned path, as the forward frame group's tables take them: the
/// light table (`lights`) and each row's extension (`light_ext`) in binned order, and the frame's
/// binning (the header, grid and bounds `light_zbins` and `light_tiles` are built from).
#[derive(Clone, Debug, PartialEq)]
pub struct BinnedFrame {
    /// The light-table rows, in binned order: row `i` is sorted light `i` of the bins.
    pub lights: Vec<GpuLight>,
    /// Their extension rows, row for row.
    pub ext: Vec<GpuLightExt>,
    /// The frame's binning (`LightBinFrame::reference_masks`/`reference_zbins` on the CPU, graph
    /// node 4 on the GPU, bit for bit equal).
    pub bins: LightBinFrame,
    /// The reflection probes binned after the lights (A.3; `probes::held_probes` of the scene's,
    /// in declaration order: `bins.probes` indexes them).
    pub reflection_probes: Vec<ReflectionProbe>,
    /// The irradiance volumes binned after the reflection probes (A.4; `irradiance::held_volumes`
    /// of the scene's, in declaration order: a `bins.probes` index past the probes is
    /// `reflection_probes.len()` plus the volume's).
    pub irradiance_volumes: Vec<crate::irradiance::IrradianceVolume>,
    /// The decals' rows in binned order (A.10; `bins.decals` indexes `decals::held_decals` of the
    /// scene's): the `light_ext` table holds them from `decals::rows_base`.
    pub decals: Vec<crate::decals::GpuDecal>,
}

/// `lighting`'s local lights for `camera` drawing a `render`-sized frame under `quality`: the rows of
/// [`local_lights`] (scene order: points, then spots; every shadowed spot marked as a request, the
/// slots granted after binning by `spot_shadow::grant`), cut to the preset's cap nearest first,
/// the last kept ones faded out towards the cut ([`crate::cluster::cap_fade`]), and sorted by view
/// depth ([`LightBinFrame::prepare`]), split into the two tables. Deterministic: the same lights
/// and camera give the same tables on every run and destination.
pub fn binned_frame(lighting: &Lighting, quality: &LightQuality, camera: &CameraDesc, render: (u32, u32)) -> BinnedFrame {
    let mut rows = local_lights(lighting, MAX_LOCAL_LIGHTS, usize::MAX);
    let cap = usize::try_from(quality.cap).unwrap_or(usize::MAX).min(MAX_LOCAL_LIGHTS);
    fade_past_cap(&mut rows, camera.eye, cap);
    // The reflection probes' influence spheres share the lights' index space (A.3, LG-16): a frame
    // without probes bins exactly as before.
    let reflection_probes = crate::probes::held_probes(&lighting.reflection_probes);
    // The irradiance volumes after them, in the same kind (A.4): a frame without either bins
    // exactly as before.
    let irradiance_volumes = crate::irradiance::held_volumes(&lighting.irradiance_volumes);
    let probe_spheres = reflection_probes.iter().map(ReflectionProbe::sphere);
    let spheres: Vec<crate::cluster::ClusterSphere> = probe_spheres.chain(irradiance_volumes.iter().map(crate::irradiance::IrradianceVolume::sphere)).collect();
    // The decals the quality draws (A.10), nearest first with the last ones faded, are the second
    // kind of the same index space: a frame without decals bins exactly as before.
    let decals = crate::decals::held_decals(&lighting.decals, usize::try_from(quality.decals).unwrap_or(usize::MAX), camera.eye);
    let decal_spheres: Vec<crate::cluster::ClusterSphere> = decals.iter().map(|(decal, _)| decal.sphere()).collect();
    let others = ClusterInput { decals: &decal_spheres, probes: &spheres };
    let mut bins = LightBinFrame::prepare_clusterables(&rows, &others, camera, render, quality);
    crate::decals::tighten_bounds(&mut bins, &decals, camera, render);
    let (lights, ext) = split_rows(&bins.sorted(&rows));
    let decals = bins.decals.iter().map(|row| decals[*row as usize].0.to_gpu(decals[*row as usize].1)).collect();
    BinnedFrame { lights, ext, bins, reflection_probes, irradiance_volumes, decals }
}

/// Scale the radiance of the rows the cap is about to drop ([`crate::cluster::cap_fade`]), so a
/// light crossing the preset's cap fades instead of popping.
fn fade_past_cap(rows: &mut [GpuLocalLight], eye: [f32; 3], cap: usize) {
    for (row, weight) in crate::cluster::cap_fade(rows, eye, cap) {
        if let Some(light) = rows.get_mut(row as usize) {
            for channel in &mut light.light.color[..3] {
                *channel *= weight;
            }
        }
    }
}

/// One frame's local lights on the legacy loop (the `clustered` switch off, or the `off`
/// quality): the light table and its extension rows, row for row, in scene order (points, then
/// spots, never shadowed). Past `quality.cap` (and the legacy loop's [`MAX_LIGHTS`]) the lights
/// whose spheres come nearest the camera are kept, in scene order, the last ones faded towards the
/// cut as on the binned path. With only point lights under the cap the light table is
/// [`light_table`]'s, so the `off` quality's picture is unchanged.
pub fn legacy_lights(lighting: &Lighting, quality: &LightQuality, camera: &CameraDesc) -> (Vec<GpuLight>, Vec<GpuLightExt>) {
    let mut rows = local_lights(lighting, MAX_LOCAL_LIGHTS, 0);
    let cap = usize::try_from(quality.cap).unwrap_or(usize::MAX).min(MAX_LIGHTS);
    if rows.len() <= cap {
        return split_rows(&rows);
    }
    fade_past_cap(&mut rows, camera.eye, cap);
    let mut kept = crate::cluster::binned_order(&rows, camera.eye, [0.0, 0.0, 0.0], cap);
    kept.sort_unstable();
    let kept: Vec<GpuLocalLight> = kept.iter().map(|row| rows[*row as usize]).collect();
    split_rows(&kept)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::LIGHT_KIND_POINT;

    fn spot(shadow: bool) -> SpotLight {
        SpotLight {
            position: [0.0, 3.0, 0.0],
            direction: [0.0, -2.0, 0.0],
            range: 8.0,
            color: [255, 255, 255],
            intensity: 4.0,
            inner_angle: 0.3,
            outer_angle: 0.5,
            shadow,
        }
    }

    fn scene(points: usize, spots: &[bool]) -> Lighting {
        let point = |i: usize| PointLight { position: [i as f32, 1.0, 0.0], range: 4.0, color: [255, 128, 0], intensity: 2.0 };
        Lighting { points: (0..points).map(point).collect(), spots: spots.iter().map(|shadow| spot(*shadow)).collect(), ..Lighting::default() }
    }

    #[test]
    fn point_rows_equal_the_legacy_light_table_and_spots_follow_in_scene_order() {
        let lighting = scene(3, &[false, true]);
        let rows = local_lights(&lighting, MAX_LOCAL_LIGHTS, 0);
        let (base, ext) = split_rows(&rows);
        assert_eq!(&base[..3], light_table(&lighting).as_slice());
        assert_eq!(ext[..3], [GpuLightExt::POINT; 3]);
        assert_eq!(ext[..3].iter().map(kind_of).collect::<Vec<_>>(), [LightKind::Point; 3]);
        assert_eq!(kind_of(&ext[3]), LightKind::Spot);
        assert_eq!(ext[3].spot[..3], [0.0, -1.0, 0.0], "the cone direction is normalized");
        assert_eq!(ext[3].spot[3], libm::cosf(0.5));
        assert_eq!(ext[3].params, [libm::cosf(0.3), LIGHT_KIND_SPOT, NO_SHADOW_SLOT, 0.0]);
        assert_eq!(GpuLightExt::POINT.params[1], LIGHT_KIND_POINT);
    }

    #[test]
    fn the_legacy_table_leaves_spots_out_so_the_picture_is_unchanged() {
        let lighting = scene(2, &[true, true]);
        assert_eq!(light_table(&lighting).len(), 2);
    }

    // RQ6 review flipped: requests are marked without the MAX_SHADOWED_SPOTS cap (was
    // `shadow_slots_go_to_the_first_shadowed_spots_while_they_last`, slots(99) [0,-1,1,2,3,-1,-1]):
    // the slots are granted after binning (`spot_shadow::grant`), visible spots nearest first.
    #[test]
    fn shadow_requests_are_marked_in_scene_order_while_they_last() {
        let lighting = scene(0, &[true, false, true, true, true, true, true]);
        let slots = |granted: usize| -> Vec<f32> { local_lights(&lighting, MAX_LOCAL_LIGHTS, granted).iter().map(|row| row.ext.params[2]).collect() };
        assert_eq!(slots(2), [0.0, -1.0, 1.0, -1.0, -1.0, -1.0, -1.0]);
        assert_eq!(slots(99), [0.0, -1.0, 1.0, 2.0, 3.0, 4.0, 5.0], "every request is marked; the frame grants the slots");
        assert_eq!(slots(0), [-1.0; 7]);
    }

    fn camera_at(eye: [f32; 3]) -> CameraDesc {
        CameraDesc::look_at(eye, [eye[0], eye[1], eye[2] - 1.0])
    }

    #[test]
    fn the_legacy_loop_keeps_the_light_table_under_the_cap_and_adds_the_spots_after_it() {
        let lighting = scene(3, &[false, true]);
        let (lights, ext) = legacy_lights(&lighting, &LightQuality { cap: 64, clustered: false, tile_px: 0, shadowed_spots: 2, shadowed_points: 0, decals: 0 }, &camera_at([0.0; 3]));
        assert_eq!(&lights[..3], light_table(&lighting).as_slice(), "point rows are the legacy table's");
        assert_eq!(lights.len(), 5, "spots are shaded on the legacy loop too");
        assert_eq!(ext.iter().map(kind_of).collect::<Vec<_>>(), [LightKind::Point, LightKind::Point, LightKind::Point, LightKind::Spot, LightKind::Spot]);
        assert!(ext.iter().all(|row| row.params[2] == NO_SHADOW_SLOT), "the legacy loop draws no spot shadow");
    }

    #[test]
    fn the_legacy_loop_honours_the_cap_nearest_first_in_scene_order() {
        let mut lighting = scene(10, &[]);
        for light in &mut lighting.points {
            light.range = 0.4;
        }
        let quality = LightQuality { cap: 4, clustered: false, tile_px: 0, shadowed_spots: 0, shadowed_points: 0, decals: 0 };
        // Lights at x = 0..9 with range 0.4: from x = 9.5 the nearest are 9, 8, 7, 6.
        let (lights, _) = legacy_lights(&lighting, &quality, &camera_at([9.5, 1.0, 0.0]));
        let xs: Vec<f32> = lights.iter().map(|light| light.position_range[0]).collect();
        assert_eq!(xs, [6.0, 7.0, 8.0, 9.0]);
        let table = light_table(&lighting);
        assert_eq!(lights[3], table[9], "the nearest light keeps its full radiance");
        assert!(lights[0].color[0] < table[6].color[0], "the last kept light fades towards the cut");
    }

    #[test]
    fn the_cap_keeps_the_first_rows_and_never_exceeds_the_binned_maximum() {
        let lighting = scene(MAX_LOCAL_LIGHTS + 10, &[false]);
        assert_eq!(local_lights(&lighting, 64, 0).len(), 64);
        assert_eq!(local_lights(&lighting, usize::MAX, 0).len(), MAX_LOCAL_LIGHTS);
    }

    #[test]
    fn hostile_cones_are_clamped_and_a_zero_direction_points_down() {
        let mut wild = spot(false);
        wild.direction = [0.0; 3];
        wild.outer_angle = f32::NAN;
        wild.inner_angle = 9.0;
        let ext = spot_ext(&wild, None);
        assert_eq!(ext.spot, [0.0, -1.0, 0.0, libm::cosf(SPOT_OUTER_ANGLE_MAX)]);
        assert_eq!(ext.params[0], libm::cosf(SPOT_OUTER_ANGLE_MAX), "inner is held inside outer");
        wild.outer_angle = -1.0;
        wild.inner_angle = f32::INFINITY;
        let ext = spot_ext(&wild, None);
        assert_eq!((ext.spot[3], ext.params[0]), (libm::cosf(SPOT_OUTER_ANGLE_MIN), 1.0));
    }
}
