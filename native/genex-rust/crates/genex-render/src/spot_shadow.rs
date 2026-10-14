//! Shadowed spot lights (RQ6.0 contracts, RQ6.5 draws them). Up to
//! [`MAX_SHADOWED_SPOTS`] spots (the preset's `LightQuality::shadowed_spots`: 0 on low and
//! medium, 2 on high, 4 on ultra) that ask for a shadow get a perspective depth map each. The maps
//! are the tiles of a depth atlas, [`SPOT_ATLAS_TILES`] by [`SPOT_ATLAS_TILES`], in **one** extra
//! layer of the shared shadow depth array after the drawn sun cascades ([`spot_layer`]), so no
//! binding is added and four spots cost one layer of the cascades' side and format, drawn in one
//! render pass. Each spot is culled through one of the cull views RQ3.0 reserved, after the
//! cascades' views ([`spot_view`]).
//!
//! A frame's spots come from its binned local lights ([`grant`]): of the rows that ask for a
//! shadow, the ones whose cones reach the screen, nearest first, up to the preset's
//! `LightQuality::shadowed_spots`, get slots 0, 1, .. after binning; a frame that draws no spot
//! maps (shadows switched off, no slot granted) clears every slot, so the forward pass never
//! reads a map that was not drawn. Each spot's light view-projection ([`spot_view_proj`]: the cone, widened
//! by [`SPOT_EDGE_TEXELS`] so the filter's taps at its edge stay in its tile, from a near plane of
//! [`SPOT_NEAR_SHARE`] of the range out to the range) follows the light rows in the `light_ext`
//! table ([`light_ext_bytes`], at [`spot_matrix_vec4`]).
//!
//! The forward pass (`gx_spot_shadow` in `shaders/lighting/local_lights.wgsl`) reads a slotted
//! spot's tile with a 3x3 PCF of bilinear comparison taps, its receiver pulled
//! `GX_SPOT_NORMAL_OFFSET_TEXELS` texels along the surface normal; the casters carry the shadow
//! pipelines' constant and slope-scaled depth bias. Spots are deterministic: every map is redrawn
//! each frame (no cadence, no history) and the matrices are libm f32, so a capture's spot shadows
//! are the same bits on the same adapter.
//!
//! [`LANDED`] says whether the renderer draws the maps and the forward pass reads them.

use crate::compile::Compiled;
use glam::{Mat4, Vec3};
use wgpu::{BindGroup, BindGroupLayout, Buffer, Device, RenderPipeline, TextureFormat};

use crate::cull::{active_views, frustum_planes};
use crate::error::RenderError;
use crate::layout::{
    GpuCullViews, GpuFrame, GpuLight, GpuLightExt, LIGHT_EXT_VEC4S, LIGHT_KIND_SPOT, MAX_CASCADES, MAX_SHADOWED_SPOTS, MAX_VIEWS, NO_SHADOW_SLOT,
    SPOT_MATRIX_VEC4S,
};
use crate::lights::{BinnedFrame, SPOT_OUTER_ANGLE_MAX};
use crate::settings::{ShadowFormat, ShadowSettings};
use crate::shadow::{CASTER_CONSTANT_BIAS, CASTER_SLOPE_BIAS, ShadowMapDesc};
use crate::tables::{entry, pipeline_layout, storage, uniform};

/// Whether shadowed spots are drawn in this build: the renderer grants the slots, draws the maps
/// and the forward pass reads them (RQ6.5's renderer seam). Until then the
/// forward pass reads no spot map and a slot changes no pixel.
pub const LANDED: bool = true;

/// The spot shadow depth pass: the casters of one spot's cull view into its atlas tile.
pub const SPOT_SHADOW: &str = concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/spot_shadow.wgsl"));
/// The spot shadow depth pass's vertex entry point.
pub const SPOT_SHADOW_VERTEX_ENTRY: &str = "vs_spot_shadow";

/// Tiles across (and down) the spot atlas layer: 2 × 2 tiles hold [`MAX_SHADOWED_SPOTS`] spots,
/// each half the shared array's side (`GX_SPOT_ATLAS_TILES` in local_lights.wgsl).
pub const SPOT_ATLAS_TILES: u32 = 2;
/// A spot's near plane as a share of its range (perspective depth keeps its precision, also in a
/// `depth16unorm` array).
pub const SPOT_NEAR_SHARE: f32 = 0.01;
/// The nearest a spot's near plane comes, world units.
pub const SPOT_NEAR_MIN: f32 = 0.05;
/// Texels of its tile kept outside a spot's cone on each side: the 3x3 filter's bilinear taps at
/// the cone's edge read inside the tile, never a neighbour's.
pub const SPOT_EDGE_TEXELS: f32 = 2.0;
/// The widest half field of view of a spot's map, radians (just under 90 degrees, so the
/// projection stays finite whatever the cone; [`SPOT_OUTER_ANGLE_MAX`] keeps cones inside it).
const SPOT_HALF_FOV_MAX: f32 = 1.5621; // 89.5 degrees

const _: () = assert!(SPOT_ATLAS_TILES * SPOT_ATLAS_TILES >= MAX_SHADOWED_SPOTS as u32);
const _: () = assert!(SPOT_OUTER_ANGLE_MAX < SPOT_HALF_FOV_MAX);

/// The shared shadow array's layer the spot atlas takes when `cascades` sun cascades are drawn:
/// the one after them (every shadow slot's tile is in it).
pub const fn spot_layer(cascades: u32) -> u32 {
    cascades
}

/// Layers the shared shadow array needs for `cascades` cascades and `spots` shadowed spots: one
/// atlas layer whatever the spot count, none without spots.
pub const fn shadow_array_layers(cascades: u32, spots: u32) -> u32 {
    cascades + if spots > 0 { 1 } else { 0 }
}

/// The cull view of shadow slot `slot`: after the camera (view 0) and the drawn cascades.
pub const fn spot_view(cascades: u32, slot: u32) -> u32 {
    1 + cascades + slot
}

/// The first `vec4<f32>` of shadow slot `slot`'s light view-projection in the `light_ext` table
/// of a frame with `lights` local lights.
pub const fn spot_matrix_vec4(lights: usize, slot: usize) -> usize {
    LIGHT_EXT_VEC4S * lights + SPOT_MATRIX_VEC4S * slot
}

/// The side, in texels, of each spot's tile in an array of side `side`.
pub const fn tile_side(side: u32) -> u32 {
    side / SPOT_ATLAS_TILES
}

/// Shadow slot `slot`'s tile in an array of side `side`: its top-left texel and its side.
pub const fn tile_rect(slot: u32, side: u32) -> (u32, u32, u32) {
    let tile = tile_side(side);
    ((slot % SPOT_ATLAS_TILES) * tile, (slot / SPOT_ATLAS_TILES) * tile, tile)
}

// Every cascade and every shadowed spot has a reserved cull view.
const _: () = assert!(spot_view(MAX_CASCADES as u32, MAX_SHADOWED_SPOTS as u32 - 1) < MAX_VIEWS as u32);

/// One shadowed spot of a frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SpotShadow {
    /// Its shadow slot (its atlas tile, its matrix and its cull view after the cascades').
    pub slot: u32,
    /// Its row in the frame's binned local-light table.
    pub row: u32,
    /// Light projection × view, column-major: perspective, standard depth 0..1.
    pub view_proj: [f32; 16],
    /// The inward planes of its frustum: its cull view.
    pub planes: [[f32; 4]; 6],
}

/// The light view-projection of the spot `light`/`ext` with a map of `tile_px` texels: a
/// right-handed look along the cone's axis and a square perspective over the cone widened by
/// [`SPOT_EDGE_TEXELS`] texels each side, depth 0..1 from `SPOT_NEAR_SHARE` of the range (at
/// least [`SPOT_NEAR_MIN`]) to the range. libm f32, so the same bits on every target.
pub fn spot_view_proj(light: &GpuLight, ext: &GpuLightExt, tile_px: u32) -> Mat4 {
    let [x, y, z, range] = light.position_range;
    let eye = Vec3::new(x, y, z);
    let axis = Vec3::new(ext.spot[0], ext.spot[1], ext.spot[2]).normalize_or(Vec3::NEG_Y);
    let up = if libm::fabsf(axis.y) > 0.99 { Vec3::Z } else { Vec3::Y };
    let view = glam::camera::rh::view::look_at_mat4(eye, eye + axis, up);
    // A cosine that is not a number is the widest cone (the light table never writes one).
    let cos_outer = if ext.spot[3].is_finite() { ext.spot[3].clamp(-1.0, 1.0) } else { -1.0 };
    let outer = libm::acosf(cos_outer).clamp(0.0, SPOT_OUTER_ANGLE_MAX);
    let edge = 1.0 + 2.0 * SPOT_EDGE_TEXELS / tile_px.max(1) as f32;
    let tan_half = (libm::tanf(outer) * edge).clamp(f32::EPSILON, libm::tanf(SPOT_HALF_FOV_MAX));
    let far = range.max(f32::MIN_POSITIVE);
    let near = (far * SPOT_NEAR_SHARE).max(SPOT_NEAR_MIN).min(far * 0.5);
    let focal = 1.0 / tan_half;
    let depth = far / (near - far);
    let proj = Mat4::from_cols_array(&[focal, 0.0, 0.0, 0.0, 0.0, focal, 0.0, 0.0, 0.0, 0.0, depth, -1.0, 0.0, 0.0, depth * near, 0.0]);
    proj * view
}

/// Whether `ext` is a spot holding a shadow slot.
fn slotted(ext: &GpuLightExt) -> bool {
    ext.params[1] == LIGHT_KIND_SPOT && ext.params[2] >= 0.0
}

/// The frame's shadowed spots from its binned local lights. Every row marked as a shadow request
/// (`lights::local_lights`) loses its mark; with `tile_px` (the frame draws spot maps of that
/// side), up to `slots` (and [`MAX_SHADOWED_SPOTS`]) of them get a slot, 0, 1, .., taken by the
/// requests whose cones reach the screen (a bounds row other than `cluster::BOUNDS_EMPTY`) whose
/// spheres come nearest the camera at `eye` (equal distances in request order, then row order):
/// a spot behind the camera or outside the view draws no map, and a nearer one on screen is never
/// passed over for one listed first. Without (`None`: shadows switched off, or not landed), every
/// slot is cleared and no spot is shadowed. Deterministic: the same rows and camera give the same
/// slots on every run and destination.
pub fn grant(binned: &mut BinnedFrame, tile_px: Option<u32>, slots: usize, eye: [f32; 3]) -> Vec<SpotShadow> {
    let requests: Vec<(f32, usize)> = binned.ext.iter().enumerate().filter(|(_, ext)| slotted(ext)).map(|(row, ext)| (ext.params[2], row)).collect();
    for (_, row) in &requests {
        binned.ext[*row].params[2] = NO_SHADOW_SLOT;
    }
    let Some(tile_px) = tile_px else { return Vec::new() };
    let on_screen = |row: usize| binned.bins.bounds.get(row).is_none_or(|bounds| *bounds != crate::cluster::BOUNDS_EMPTY);
    let mut visible: Vec<(f32, f32, usize)> = requests
        .iter()
        .filter(|(_, row)| on_screen(*row))
        .filter_map(|(request, row)| binned.lights.get(*row).map(|light| (reach_distance(light, eye), *request, *row)))
        .collect();
    visible.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.total_cmp(&b.1)).then(a.2.cmp(&b.2)));
    let mut spots = Vec::with_capacity(visible.len().min(MAX_SHADOWED_SPOTS));
    for (slot, (_, _, row)) in visible.into_iter().take(slots.min(MAX_SHADOWED_SPOTS)).enumerate() {
        let (Some(light), Some(ext)) = (binned.lights.get(row), binned.ext.get_mut(row)) else { continue };
        ext.params[2] = slot as f32;
        let view_proj = spot_view_proj(light, ext, tile_px);
        spots.push(SpotShadow { slot: slot as u32, row: row as u32, view_proj: view_proj.to_cols_array(), planes: frustum_planes(view_proj) });
    }
    spots
}

/// How far `light`'s sphere is from `eye`: 0 when it reaches the camera; a row that is not a
/// number is the farthest.
fn reach_distance(light: &GpuLight, eye: [f32; 3]) -> f32 {
    crate::cluster::reach_distance(&crate::layout::GpuLocalLight { light: *light, ext: GpuLightExt::POINT }, eye)
}

/// What a frame's cull and frame uniforms say about its shadowed spots, for a frame drawing
/// `cascades` sun cascades: the active views (the camera, the cascades, then one per spot), each
/// spot's cull planes at [`spot_view`], and the spot count (`shadow_counts.y`).
pub fn apply_views(frame: &mut GpuFrame, cull: &mut GpuCullViews, cascades: usize, spots: &[SpotShadow]) -> u32 {
    let views = active_views(cascades, spots.len());
    for spot in spots {
        cull.planes[spot_view(cascades as u32, spot.slot) as usize] = spot.planes;
    }
    cull.params[2] = views;
    frame.counts[2] = views;
    frame.shadow_counts[1] = spots.len() as u32;
    views
}

/// The `light_ext` table's bytes: every local light's extension row, then each shadowed spot's
/// light view-projection by slot ([`spot_matrix_vec4`]).
pub fn light_ext_bytes(ext: &[GpuLightExt], spots: &[SpotShadow]) -> Vec<u8> {
    let mut bytes = bytemuck::cast_slice(ext).to_vec();
    let mut ordered: Vec<&SpotShadow> = spots.iter().collect();
    ordered.sort_by_key(|spot| spot.slot);
    for spot in ordered {
        bytes.extend_from_slice(bytemuck::cast_slice(&spot.view_proj));
    }
    bytes
}

/// The shared shadow array a frame draws: the sun cascades' (`cascades`, `None` without sun
/// shadows) plus the spot atlas layer when `spots` > 0, at the cascades' side and format, or at
/// `settings`' when only spots are shadowed (an unlit sun at night); the placeholder with neither.
pub fn map_desc(cascades: Option<ShadowMapDesc>, settings: &ShadowSettings, spots: usize) -> ShadowMapDesc {
    match (cascades, spots) {
        (cascades, 0) => cascades.unwrap_or(ShadowMapDesc::PLACEHOLDER),
        (Some(desc), _) => ShadowMapDesc { layers: shadow_array_layers(desc.layers, 1), ..desc },
        (None, _) => ShadowMapDesc { layers: shadow_array_layers(0, 1), ..ShadowMapDesc::for_settings(settings) },
    }
}

/// The spot casters' depth pass: its frame group layout (frame, instances, visible list, slot
/// bases, the `light_ext` table) and one pipeline per shadow format. The renderer makes it on the
/// first frame that draws a spot map.
pub struct SpotShadowPipelines {
    layout: BindGroupLayout,
    depth32: Compiled<RenderPipeline>,
    depth16: Compiled<RenderPipeline>,
}

/// The buffers a spot pass's frame group binds.
pub struct SpotShadowInputs<'a> {
    /// The frame uniforms (`FrameUniforms`).
    pub frame: &'a Buffer,
    /// The instance table.
    pub instances: &'a Buffer,
    /// The visible list the cull wrote (each spot's view has its region).
    pub visible: &'a Buffer,
    /// The slot-base table.
    pub slot_base: &'a Buffer,
    /// The `light_ext` table: the light rows' extensions, then the spots' matrices.
    pub light_ext: &'a Buffer,
}

impl SpotShadowPipelines {
    /// The pipelines over the renderer's pass-view layout (`pass`, group 1) and mesh streams.
    pub fn new(device: &Device, pass: &BindGroupLayout, buffers: &[Option<wgpu::VertexBufferLayout<'_>>]) -> Result<SpotShadowPipelines, RenderError> {
        let vertex = wgpu::ShaderStages::VERTEX;
        let entries = [uniform(0, false, vertex), storage(1, true, vertex), storage(2, true, vertex), storage(3, true, vertex), storage(4, true, vertex)];
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("spot shadow"), entries: &entries });
        let module = crate::shaders::module(device, "spot shadow", SPOT_SHADOW)?;
        let pipeline_layout = pipeline_layout(device, "spot shadow", &[&layout, pass]);
        let pipeline = |format: ShadowFormat| spot_pipeline(device, &module, &pipeline_layout, buffers, format.texture_format());
        Ok(SpotShadowPipelines { depth32: pipeline(ShadowFormat::Depth32), depth16: pipeline(ShadowFormat::Depth16), layout })
    }

    /// The pipeline drawing into an array of `format`.
    pub fn pipeline(&self, format: TextureFormat) -> &RenderPipeline {
        if format == TextureFormat::Depth16Unorm { &self.depth16 } else { &self.depth32 }
    }

    /// The frame group over `inputs`.
    pub fn bind_group(&self, device: &Device, inputs: &SpotShadowInputs<'_>) -> BindGroup {
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("spot shadow"),
            layout: &self.layout,
            entries: &[
                entry(0, inputs.frame),
                entry(1, inputs.instances),
                entry(2, inputs.visible),
                entry(3, inputs.slot_base),
                entry(4, inputs.light_ext),
            ],
        })
    }
}

/// A spot caster pipeline: depth only into `format`, back faces culled, the sun casters' constant
/// and slope-scaled bias, and clipped depth (a perspective map has a real near plane; nothing is
/// pancaked onto it).
fn spot_pipeline(
    device: &Device,
    module: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    buffers: &[Option<wgpu::VertexBufferLayout<'_>>],
    format: TextureFormat,
) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("spot shadow"),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some(SPOT_SHADOW_VERTEX_ENTRY), compilation_options: Default::default(), buffers },
        primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState {
            format,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: wgpu::StencilState::default(),
            bias: wgpu::DepthBiasState { constant: CASTER_CONSTANT_BIAS, slope_scale: CASTER_SLOPE_BIAS, clamp: 0.0 },
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: None,
        multiview_mask: None,
        cache: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::layout::{GpuLightBinParams, LIGHT_KIND_POINT};

    fn spot_row(position: [f32; 3], direction: [f32; 3], outer: f32, slot: f32) -> (GpuLight, GpuLightExt) {
        let light = GpuLight { position_range: [position[0], position[1], position[2], 10.0], color: [1.0; 4] };
        let ext = GpuLightExt { spot: [direction[0], direction[1], direction[2], libm::cosf(outer)], params: [libm::cosf(outer * 0.5), LIGHT_KIND_SPOT, slot, 0.0] };
        (light, ext)
    }

    fn project(m: Mat4, world: Vec3) -> Vec3 {
        let clip = m * world.extend(1.0);
        clip.truncate() / clip.w
    }

    #[test]
    fn the_atlas_takes_one_layer_after_the_cascades_and_a_tile_per_slot() {
        assert_eq!((spot_layer(0), spot_layer(3)), (0, 3));
        assert_eq!(shadow_array_layers(4, 4), 5, "four spots share one atlas layer");
        assert_eq!(shadow_array_layers(2, 0), 2, "no spot adds no layer");
        assert_eq!(shadow_array_layers(0, 1), 1, "spots without sun cascades");
        assert_eq!((spot_view(1, 0), spot_view(4, 3)), (2, 8));
        assert_eq!(spot_matrix_vec4(10, 0), 20);
        assert_eq!(spot_matrix_vec4(10, 3), 32);
        assert_eq!([0, 1, 2, 3].map(|slot| tile_rect(slot, 2048)), [(0, 0, 1024), (1024, 0, 1024), (0, 1024, 1024), (1024, 1024, 1024)]);
    }

    #[test]
    fn a_spots_cone_lies_inside_its_map_with_its_axis_at_the_centre_and_its_range_at_the_far_plane() {
        let outer = 40f32.to_radians();
        let (light, ext) = spot_row([1.0, 4.0, -2.0], [0.0, -1.0, 0.0], outer, 0.0);
        let m = spot_view_proj(&light, &ext, 512);
        let centre = project(m, Vec3::new(1.0, 0.0, -2.0));
        assert!(centre.x.abs() < 1e-5 && centre.y.abs() < 1e-5, "{centre:?}");
        assert!((project(m, Vec3::new(1.0, 4.0 - 10.0, -2.0)).z - 1.0).abs() < 1e-4, "the range is the far plane");
        let near = project(m, Vec3::new(1.0, 4.0 - 0.1, -2.0)).z;
        assert!(near.abs() < 1e-4, "the near plane is a hundredth of the range ({near})");
        // The cone's edge at 4 m lands just inside the map: the edge texels stay outside it.
        let edge = project(m, Vec3::new(1.0 + 4.0 * libm::tanf(outer), 0.0, -2.0));
        let inside = 1.0 / (1.0 + 2.0 * SPOT_EDGE_TEXELS / 512.0);
        assert!((edge.x.abs().max(edge.y.abs()) - inside).abs() < 1e-4, "{edge:?}");
    }

    #[test]
    fn hostile_cones_give_finite_matrices() {
        for (direction, outer) in [([0.0, 0.0, 0.0], 0.5), ([0.0, -1.0, 0.0], SPOT_OUTER_ANGLE_MAX), ([1.0, 0.0, 0.0], 1e-6), ([0.0, 1.0, 0.0], f32::NAN)] {
            let (light, mut ext) = spot_row([0.0, 2.0, 0.0], direction, 0.5, 0.0);
            ext.spot[3] = libm::cosf(outer);
            let m = spot_view_proj(&light, &ext, 1024);
            assert!(m.to_cols_array().iter().all(|v| v.is_finite()), "{direction:?} {outer}: {m:?}");
            assert!(frustum_planes(m).iter().flatten().all(|v| v.is_finite()));
        }
    }

    fn binned(ext: Vec<GpuLightExt>) -> BinnedFrame {
        let lights = vec![GpuLight { position_range: [0.0, 3.0, 0.0, 8.0], color: [1.0; 4] }; ext.len()];
        let bins = crate::cluster::LightBinFrame {
            order: (0..ext.len() as u32).collect(),
            grid: crate::cluster::LightGrid::new((64, 64), 16, ext.len() as u32),
            params: GpuLightBinParams::default(),
            bounds: Vec::new(),
        };
        BinnedFrame { lights, ext, bins }
    }

    #[test]
    fn granted_slots_are_renumbered_in_slot_order_and_cleared_without_maps() {
        let spot = |slot: f32| spot_row([0.0, 3.0, 0.0], [0.0, -1.0, 0.0], 0.6, slot).1;
        // Depth order put slot 2 first; slot 0 was cut by the cap; a point holds no slot.
        let rows = vec![spot(2.0), GpuLightExt::POINT, spot(-1.0), spot(1.0), spot(3.0)];
        let mut frame = binned(rows.clone());
        let spots = grant(&mut frame, Some(256), MAX_SHADOWED_SPOTS, [0.0; 3]);
        let slots: Vec<f32> = frame.ext.iter().map(|ext| ext.params[2]).collect();
        assert_eq!(slots, [1.0, -1.0, -1.0, 0.0, 2.0]);
        assert_eq!(spots.iter().map(|s| (s.slot, s.row)).collect::<Vec<_>>(), [(0, 3), (1, 0), (2, 4)]);
        assert_eq!(frame.ext[1].params[1], LIGHT_KIND_POINT);
        let mut off = binned(rows);
        assert!(grant(&mut off, None, MAX_SHADOWED_SPOTS, [0.0; 3]).is_empty());
        assert!(off.ext.iter().all(|ext| ext.params[2] == NO_SHADOW_SLOT), "no map, no slot");
    }

    #[test]
    fn slots_go_to_the_on_screen_requests_nearest_first_up_to_the_quality() {
        let spot_at = |x: f32, request: f32| {
            let (mut light, ext) = spot_row([x, 3.0, 0.0], [0.0, -1.0, 0.0], 0.6, request);
            light.position_range[3] = 2.0;
            (light, ext)
        };
        // Requests in scene order: far (20 m), behind the camera (off screen), near (5 m), mid (10 m).
        let rows = [spot_at(20.0, 0.0), spot_at(-5.0, 1.0), spot_at(5.0, 2.0), spot_at(10.0, 3.0)];
        let mut frame = binned(rows.iter().map(|(_, ext)| *ext).collect());
        frame.lights = rows.iter().map(|(light, _)| *light).collect();
        frame.bins.bounds = vec![[0, 0, 0, 0], crate::cluster::BOUNDS_EMPTY, [0, 0, 0, 0], [0, 0, 0, 0]];
        let spots = grant(&mut frame, Some(256), 2, [0.0, 3.0, 0.0]);
        assert_eq!(spots.iter().map(|s| (s.slot, s.row)).collect::<Vec<_>>(), [(0, 2), (1, 3)], "the near and mid spots, nearest first");
        let slots: Vec<f32> = frame.ext.iter().map(|ext| ext.params[2]).collect();
        assert_eq!(slots, [-1.0, -1.0, 0.0, 1.0], "the far request loses to the cap, the one behind never draws");
        let mut all = binned(rows.iter().map(|(_, ext)| *ext).collect());
        all.lights = frame.lights.clone();
        all.bins.bounds = frame.bins.bounds.clone();
        let rows_drawn: Vec<u32> = grant(&mut all, Some(256), 9, [0.0, 3.0, 0.0]).iter().map(|s| s.row).collect();
        assert_eq!(rows_drawn, [2, 3, 0], "at most MAX_SHADOWED_SPOTS, never the spot off screen");
    }

    #[test]
    fn the_spots_views_follow_the_drawn_cascades_and_their_matrices_follow_the_rows() {
        let mut frame = binned(vec![GpuLightExt::POINT, spot_row([0.0, 3.0, 0.0], [0.0, -1.0, 0.0], 0.6, 0.0).1, spot_row([2.0, 3.0, 0.0], [0.0, -1.0, 0.0], 0.6, 1.0).1]);
        let spots = grant(&mut frame, Some(512), MAX_SHADOWED_SPOTS, [0.0; 3]);
        let (mut uniforms, mut cull) = (GpuFrame::default(), GpuCullViews::default());
        assert_eq!(apply_views(&mut uniforms, &mut cull, 3, &spots), 6);
        assert_eq!((uniforms.counts[2], cull.params[2], uniforms.shadow_counts[1]), (6, 6, 2));
        assert_eq!(cull.planes[4], spots[0].planes);
        assert_eq!(cull.planes[5], spots[1].planes);
        let bytes = light_ext_bytes(&frame.ext, &spots);
        assert_eq!(bytes.len(), 16 * (LIGHT_EXT_VEC4S * 3 + SPOT_MATRIX_VEC4S * 2));
        let at = 16 * spot_matrix_vec4(3, 1);
        assert_eq!(&bytes[at..at + 64], bytemuck::cast_slice::<f32, u8>(&spots[1].view_proj));
    }

    #[test]
    fn a_spot_view_culls_what_its_cone_cannot_reach() {
        let (light, ext) = spot_row([0.0, 4.0, 0.0], [0.0, -1.0, 0.0], 0.5, 0.0);
        let planes = frustum_planes(spot_view_proj(&light, &ext, 1024));
        assert!(crate::cull::in_frustum(&planes, [0.5, 1.0, 0.0, 0.5]), "a cube under the spot");
        assert!(!crate::cull::in_frustum(&planes, [6.0, 1.0, 0.0, 0.5]), "a cube outside the cone");
        assert!(!crate::cull::in_frustum(&planes, [0.0, 6.0, 0.0, 0.5]), "a cube behind the spot");
        assert!(!crate::cull::in_frustum(&planes, [0.0, -8.0, 0.0, 0.5]), "a cube past its range");
    }

    #[test]
    fn the_array_gains_one_atlas_layer_only_with_spots() {
        let settings = ShadowSettings::from_quality(&crate::settings::Quality::off().shadows, 0.0, 0.0);
        let cascades = ShadowMapDesc::for_settings(&settings);
        assert_eq!(map_desc(Some(cascades), &settings, 0), cascades);
        assert_eq!(map_desc(None, &settings, 0), ShadowMapDesc::PLACEHOLDER);
        assert_eq!(map_desc(Some(cascades), &settings, 3), ShadowMapDesc { layers: cascades.layers + 1, ..cascades });
        assert_eq!(map_desc(None, &settings, 1), ShadowMapDesc { layers: 1, ..cascades }, "an unlit sun: the spot layer alone");
    }
}
