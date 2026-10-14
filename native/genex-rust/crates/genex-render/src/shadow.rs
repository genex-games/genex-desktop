//! Cascaded sun shadows, 1 to [`MAX_CASCADES`] cascades (RQ3.1). The camera's view depth up to
//! the shadow distance is split by the practical split (`split_lambda` weighs a logarithmic split
//! against a uniform one); each slice gets a bounding sphere and an orthographic light frustum
//! around it, snapped to whole shadow texels so shadows do not shimmer as the camera moves. Each
//! cascade is a cull view: its casters are culled by the compute pass against the light frustum
//! and drawn depth-only through the same indirect path as the camera.
//!
//! Two fits share that frame:
//! - [`cascades`], the legacy fit: two 1024 px cascades, a sphere around the slice's corners and a
//!   light depth that reaches [`CASTER_REACH`] towards the sun. Today's goldens hold its bits.
//! - [`fit`], the fit every other [`ShadowSettings`] gets: an analytic slice sphere (the same
//!   radius, bit for bit, however the camera turns), the settings' cascade count, map size and
//!   split, and a **receiver-tight** light depth: only the depth span of the geometry inside the
//!   cascade's sphere, so `depth16unorm` keeps its precision. The normal offset is a fixed number
//!   of each cascade's texels ([`Cascades::normal_offsets`]); the comparison's one NDC bias
//!   ([`DEPTH_BIAS`]) is a share of each cascade's own light depth ([`Cascades::depth_bias_world`])
//!   and the casters' slope-scaled bias is per texel of slope.
//!
//! Both **pancake**: casters nearer the sun than a cascade's near plane are not culled (the near
//! cull plane is open) and land on the near plane, so they still shadow everything behind them.
//! A caster pipeline ([`caster_pipeline`]) draws with unclipped depth where the device has the
//! optional `DEPTH_CLIP_CONTROL` ([`CasterDepth::Unclipped`]); elsewhere the vertex clamps onto the
//! near plane and a fragment writes the true depth ([`CasterDepth::Fragment`]), so a caster that
//! crosses the near plane keeps its depth past it either way (shaders/shadow_caster.wgsl).
//!
//! [`CascadeHistory`] applies the far-cascade cadence: a cascade that is not redrawn this frame
//! keeps last frame's map and matrix, unless that map no longer covers its fresh slice or its
//! receivers' light depth (a camera cut, a vertical jump). It holds Live frames' maps only: a
//! settled capture's re-renders redraw every cascade, and the history starts over after them and
//! on a history reset ([`CascadeHistory::reset`]). [`ShadowMaps`] holds the depth array the
//! settings size.
//!
//! All of it is CPU f32 with libm, so the cascade matrices have the same bits on every target.

use crate::compile::Compiled;
use glam::{Mat4, Vec3, Vec4Swizzles};
use wgpu::{Device, Features, RenderPipeline, ShaderModule, Texture, TextureFormat, TextureView};

use crate::cull::frustum_planes;
use crate::layout::{GpuFrame, MAX_CASCADES, SHADOW_CASCADES};
use crate::scene::{CameraDesc, FramePlan};
use crate::settings::{DEFAULT_SHADOW_SPLIT_LAMBDA, ShadowFormat, ShadowSettings};

/// Each legacy cascade's shadow map side, in texels.
pub const SHADOW_MAP_PX: u32 = 1024;
/// The legacy shadow map format.
pub const SHADOW_FORMAT: TextureFormat = TextureFormat::Depth32Float;
/// How far towards the sun, beyond a cascade's slice, the legacy fit's light depth reaches.
/// Casters beyond it still shadow: they are pancaked onto the near plane.
pub const CASTER_REACH: f32 = 60.0;
/// Normal offset in shadow texels (pulls the lookup off the surface against acne).
const NORMAL_OFFSET_TEXELS: f32 = 1.5;
/// Constant depth bias in the comparison (the pipeline adds a slope-scaled one).
pub const DEPTH_BIAS: f32 = 0.0015;
/// A slice sphere's radius is rounded up to whole 1/this world units, so float noise in the
/// slice never changes a cascade's texel size.
const RADIUS_STEPS_PER_UNIT: f32 = 16.0;
/// Texels of light depth kept in front of and behind the receivers of a tight cascade (the slope
/// bias and the normal offset push lookups this far at most).
const DEPTH_MARGIN_TEXELS: f32 = 4.0;
/// A tight cascade's light depth is never thinner than this many texels.
const MIN_DEPTH_TEXELS: f32 = 16.0;
/// How far, as a share of a held cascade's light depth, the fresh fit's receiver span may reach
/// past the held map's near or far plane before the cascade redraws: a step of the camera shifts
/// the receiver-tight span a little (held a frame, the shift reads as lit for that frame at most);
/// a jump along the light (a vertical teleport under a high sun) moves it whole.
const HELD_DEPTH_SLACK: f32 = 0.25;
/// The cull plane every point is inside of: a cascade's open near plane (pancaking).
const OPEN_PLANE: [f32; 4] = [0.0, 0.0, 0.0, 1.0];
/// A cascade frustum's near plane among [`frustum_planes`]'s six (left, right, bottom, top, near, far).
const NEAR_PLANE: usize = 4;

/// The casters' constant depth bias, in units of the map's depth resolution.
pub(crate) const CASTER_CONSTANT_BIAS: i32 = 2;
/// The casters' slope-scaled depth bias (against acne on sloped receivers).
pub(crate) const CASTER_SLOPE_BIAS: f32 = 2.0;
/// The depth resolution of a `depth16unorm` map (`r` of the constant bias).
const DEPTH16_UNIT: f64 = 1.0 / 65536.0;

/// How a caster pipeline lands casters nearer the sun than the cascade's near plane on it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CasterDepth {
    /// Unclipped depth (`DEPTH_CLIP_CONTROL`): the rasterizer clamps each fragment's depth, with
    /// the hardware bias and early depth testing.
    Unclipped,
    /// The vertex clamps onto the near plane and `fs_shadow_caster` writes the true depth, biased
    /// in the shader (every device without the feature).
    Fragment,
}

impl CasterDepth {
    /// The way a device with `features` draws casters.
    pub fn for_features(features: Features) -> CasterDepth {
        if features.contains(Features::DEPTH_CLIP_CONTROL) { CasterDepth::Unclipped } else { CasterDepth::Fragment }
    }
}

/// One caster pipeline: `vertex` of `module` (its fragment `fs_shadow_caster` under
/// [`CasterDepth::Fragment`]) into a depth map of `format`.
pub(crate) struct CasterSpec<'a> {
    pub(crate) label: &'a str,
    pub(crate) module: &'a ShaderModule,
    pub(crate) vertex: &'a str,
    pub(crate) buffers: &'a [Option<wgpu::VertexBufferLayout<'a>>],
    pub(crate) layout: &'a wgpu::PipelineLayout,
    pub(crate) format: TextureFormat,
    pub(crate) depth: CasterDepth,
}

/// The caster pipeline of `spec`: depth only, back faces culled, the casters' bias.
pub(crate) fn caster_pipeline(device: &Device, spec: &CasterSpec<'_>) -> Compiled<RenderPipeline> {
    let unclipped = spec.depth == CasterDepth::Unclipped;
    let unit = if spec.format == TextureFormat::Depth16Unorm { DEPTH16_UNIT } else { 0.0 };
    let constants = [
        ("GX_UNCLIPPED_DEPTH", f64::from(u8::from(unclipped))),
        ("GX_SHADOW_DEPTH_UNIT", unit),
        ("GX_SHADOW_BIAS_CONSTANT", f64::from(CASTER_CONSTANT_BIAS)),
        ("GX_SHADOW_BIAS_SLOPE", f64::from(CASTER_SLOPE_BIAS)),
    ];
    let options = wgpu::PipelineCompilationOptions { constants: &constants, ..Default::default() };
    // A fragment that writes its depth gets no hardware bias: `fs_shadow_caster` applies it.
    let bias = if unclipped {
        wgpu::DepthBiasState { constant: CASTER_CONSTANT_BIAS, slope_scale: CASTER_SLOPE_BIAS, clamp: 0.0 }
    } else {
        wgpu::DepthBiasState::default()
    };
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(spec.label),
        layout: Some(spec.layout),
        vertex: wgpu::VertexState { module: spec.module, entry_point: Some(spec.vertex), compilation_options: options.clone(), buffers: spec.buffers },
        primitive: wgpu::PrimitiveState { cull_mode: Some(wgpu::Face::Back), unclipped_depth: unclipped, ..Default::default() },
        depth_stencil: Some(wgpu::DepthStencilState {
            format: spec.format,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Less),
            stencil: wgpu::StencilState::default(),
            bias,
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: (!unclipped).then_some(wgpu::FragmentState { module: spec.module, entry_point: Some("fs_shadow_caster"), compilation_options: options, targets: &[] }),
        multiview_mask: None,
        cache: None,
    })
}

/// The cascades of one frame. Lanes past [`Cascades::count`] are 0 (a split of 0 ends the run).
#[derive(Clone, Debug, PartialEq)]
pub struct Cascades {
    /// Light projection × view of each cascade, column-major.
    pub view_proj: [[f32; 16]; MAX_CASCADES],
    /// Inward planes of each cascade's light frustum (its cull view); the near plane is open.
    pub planes: [[[f32; 4]; 6]; MAX_CASCADES],
    /// The view depth where each cascade ends; the last one is the shadow distance.
    pub splits: [f32; MAX_CASCADES],
    /// The eight world corners of each cascade's slice of the camera frustum.
    pub slice_corners: [[[f32; 3]; 8]; MAX_CASCADES],
    /// One shadow texel of each cascade in world units.
    pub texel_world: [f32; MAX_CASCADES],
    /// Each cascade's light depth range (far minus near plane) in world units.
    pub depth_range: [f32; MAX_CASCADES],
    /// Each cascade's map side in texels.
    pub map_px: u32,
}

impl Cascades {
    fn empty(map_px: u32) -> Cascades {
        Cascades {
            view_proj: [[0.0; 16]; MAX_CASCADES],
            planes: [[[0.0; 4]; 6]; MAX_CASCADES],
            splits: [0.0; MAX_CASCADES],
            slice_corners: [[[0.0; 3]; 8]; MAX_CASCADES],
            texel_world: [0.0; MAX_CASCADES],
            depth_range: [0.0; MAX_CASCADES],
            map_px,
        }
    }

    /// The cascades this set holds: the leading run of positive splits.
    pub fn count(&self) -> usize {
        self.splits.iter().take_while(|end| **end > 0.0).count()
    }

    /// The normal offset of each cascade, in world units (a fixed number of its texels).
    pub fn normal_offsets(&self) -> [f32; MAX_CASCADES] {
        self.texel_world.map(|texel| texel * NORMAL_OFFSET_TEXELS)
    }

    /// The constant depth bias [`DEPTH_BIAS`] of each cascade in world units: its light depth
    /// range times the NDC bias, 0 past the drawn cascades.
    pub fn depth_bias_world(&self) -> [f32; MAX_CASCADES] {
        self.depth_range.map(|range| range * DEPTH_BIAS)
    }

    /// Where each cascade starts blending into the next (the reference of the sun chunk's band):
    /// `band` of the cascade's view-depth range before its end, the first cascade starting at
    /// `near`. A band of 0 starts at the end (a hard switch); 0 past the drawn cascades.
    pub fn blend_starts(&self, near: f32, band: f32) -> [f32; MAX_CASCADES] {
        let mut starts = [0.0; MAX_CASCADES];
        let mut begin = near;
        for (c, end) in self.splits.iter().copied().enumerate().take(self.count()) {
            starts[c] = end - band * (end - begin);
            begin = end;
        }
        starts
    }
}

/// The camera's orthonormal basis: forward, right, up.
fn basis(camera: &CameraDesc) -> (Vec3, Vec3, Vec3) {
    let forward = (Vec3::from(camera.target) - Vec3::from(camera.eye)).normalize_or(Vec3::NEG_Z);
    let right = forward.cross(Vec3::from(camera.up)).normalize_or(Vec3::X);
    (forward, right, right.cross(forward))
}

/// The camera's unit view direction.
pub fn camera_forward(camera: &CameraDesc) -> [f32; 3] {
    basis(camera).0.to_array()
}

fn slice_corners(camera: &CameraDesc, aspect: f32, near: f32, far: f32) -> [[f32; 3]; 8] {
    let (forward, right, up) = basis(camera);
    let eye = Vec3::from(camera.eye);
    let mut corners = [[0.0; 3]; 8];
    for (i, depth) in [near, far].into_iter().enumerate() {
        let half_h = camera.half_height_at(depth);
        let half_w = half_h * aspect;
        for (j, (sx, sy)) in [(-1.0, -1.0), (1.0, -1.0), (1.0, 1.0), (-1.0, 1.0)].into_iter().enumerate() {
            corners[i * 4 + j] = (eye + forward * depth + right * (sx * half_w) + up * (sy * half_h)).to_array();
        }
    }
    corners
}

/// The view depths where each of `count` cascades ends between `near` and `far`: the practical
/// split, `lambda` of the logarithmic split plus the rest of the uniform one; the last is `far`.
pub fn split_depths(near: f32, far: f32, count: usize, lambda: f32) -> [f32; MAX_CASCADES] {
    let count = count.clamp(1, MAX_CASCADES);
    let mut splits = [0.0; MAX_CASCADES];
    for (i, split) in splits.iter_mut().enumerate().take(count - 1) {
        let p = (i + 1) as f32 / count as f32;
        let logarithmic = near * libm::powf(far / near, p);
        let uniform = near + (far - near) * p;
        *split = lambda * logarithmic + (1.0 - lambda) * uniform;
    }
    splits[count - 1] = far;
    splits
}

/// The shadowed view depth range of `camera` up to `distance`: its near plane to the distance
/// clamped to its far plane (and at least twice the near plane).
fn shadow_range(camera: &CameraDesc, distance: f32) -> (f32, f32) {
    let near = camera.near;
    (near, distance.min(camera.far).max(near * 2.0))
}

/// A radius rounded up to whole [`RADIUS_STEPS_PER_UNIT`]ths.
fn quantized(radius: f32) -> f32 {
    libm::ceilf(radius * RADIUS_STEPS_PER_UNIT) / RADIUS_STEPS_PER_UNIT
}

/// The light's view of a sphere at `center`, from `front` (where the light depth starts).
fn light_view(front: Vec3, center: Vec3, sun: Vec3) -> Mat4 {
    let up = if sun.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y };
    glam::camera::rh::view::look_at_mat4(front, center, up)
}

/// `proj` moved so the world origin lands on a whole texel of a `map_px` map: the map's grid then
/// stays put in the world while the cascade follows the camera.
fn snapped(mut proj: Mat4, view: Mat4, map_px: u32) -> Mat4 {
    let half = map_px as f32 * 0.5;
    let origin = (proj * view).w_axis.xy() * half;
    let offset = (origin.round() - origin) / half;
    proj.w_axis.x += offset.x;
    proj.w_axis.y += offset.y;
    proj
}

/// A cascade's light frustum.
struct Fitted {
    view_proj: Mat4,
    texel: f32,
    depth_range: f32,
}

/// The legacy light frustum: a sphere around the slice's corners, the light depth reaching
/// [`CASTER_REACH`] beyond it towards the sun.
fn legacy_light(corners: &[[f32; 3]; 8], sun: Vec3) -> Fitted {
    let center = corners.iter().map(|c| Vec3::from(*c)).sum::<Vec3>() / 8.0;
    let radius = corners.iter().map(|c| Vec3::from(*c).distance(center)).fold(0.0_f32, f32::max);
    let radius = quantized(radius);
    let view = light_view(center + sun * (radius + CASTER_REACH), center, sun);
    let depth = 2.0 * radius + CASTER_REACH;
    // One texel of margin each side: the snap moves the map by up to half a texel.
    let extent = radius * (1.0 + 2.0 / SHADOW_MAP_PX as f32);
    let proj = glam::camera::rh::proj::directx::orthographic(-extent, extent, -extent, extent, 0.0, depth);
    let proj = snapped(proj, view, SHADOW_MAP_PX);
    Fitted { view_proj: proj * view, texel: 2.0 * extent / SHADOW_MAP_PX as f32, depth_range: depth }
}

/// The smallest sphere around the camera slice from view depth `near` to `far`, analytically:
/// its centre on the view axis and its radius depend only on the depths, the field of view and
/// the aspect, never on where the camera looks, so a turning camera keeps its texel size bit for bit.
fn slice_sphere(camera: &CameraDesc, aspect: f32, near: f32, far: f32) -> (Vec3, f32) {
    let diagonal = |depth: f32| {
        let half_h = camera.half_height_at(depth);
        half_h * half_h * (1.0 + aspect * aspect)
    };
    let (near_sq, far_sq) = (diagonal(near), diagonal(far));
    // Equidistant from both rectangles' corners, held inside the slice (a wide far rectangle
    // centres the sphere on it).
    let along = ((far * far - near * near + far_sq - near_sq) / (2.0 * (far - near))).clamp(near, far);
    let radius = libm::sqrtf((far - along) * (far - along) + far_sq).max(libm::sqrtf((along - near) * (along - near) + near_sq));
    let (forward, _, _) = basis(camera);
    (Vec3::from(camera.eye) + forward * along, quantized(radius))
}

/// The light depth span `(near, far)`, from the sphere's sun-side point, of the `bounds` (world
/// spheres: centre, radius) that touch the cascade's sphere, held to the sphere's own span.
fn receiver_span(bounds: impl Iterator<Item = [f32; 4]>, center: Vec3, radius: f32, sun: Vec3) -> Option<(f32, f32)> {
    let front = center + sun * radius;
    let mut span: Option<(f32, f32)> = None;
    for b in bounds {
        let at = Vec3::new(b[0], b[1], b[2]);
        if at.distance(center) > b[3] + radius {
            continue;
        }
        let depth = (front - at).dot(sun);
        let (lo, hi) = ((depth - b[3]).max(0.0), (depth + b[3]).min(2.0 * radius));
        span = Some(span.map_or((lo, hi), |(a, z)| (a.min(lo), z.max(hi))));
    }
    span
}

/// The receiver-tight light frustum of a cascade at `map_px`: the slice sphere's extent, the light
/// depth the geometry inside the sphere spans (its whole diameter without any), a margin each side,
/// rounded out to whole texels.
fn tight_light(center: Vec3, radius: f32, sun: Vec3, map_px: u32, bounds: impl Iterator<Item = [f32; 4]>) -> Fitted {
    let extent = radius * (1.0 + 2.0 / map_px as f32);
    let texel = 2.0 * extent / map_px as f32;
    let (lo, hi) = receiver_span(bounds, center, radius, sun).unwrap_or((0.0, 2.0 * radius));
    let margin = DEPTH_MARGIN_TEXELS * texel;
    let near = libm::floorf((lo - margin) / texel) * texel;
    let far = libm::ceilf((hi + margin) / texel) * texel;
    let far = far.max(near + MIN_DEPTH_TEXELS * texel);
    let view = light_view(center + sun * radius, center, sun);
    let proj = glam::camera::rh::proj::directx::orthographic(-extent, extent, -extent, extent, near, far);
    Fitted { view_proj: snapped(proj, view, map_px) * view, texel, depth_range: far - near }
}

/// Record cascade `c` of `set`: its frustum, its open-near cull planes and its slice.
fn place(set: &mut Cascades, c: usize, fitted: &Fitted, corners: [[f32; 3]; 8]) {
    let mut planes = frustum_planes(fitted.view_proj);
    planes[NEAR_PLANE] = OPEN_PLANE;
    set.view_proj[c] = fitted.view_proj.to_cols_array();
    set.planes[c] = planes;
    set.slice_corners[c] = corners;
    set.texel_world[c] = fitted.texel;
    set.depth_range[c] = fitted.depth_range;
}

/// The legacy two cascades for `camera` on a target of `aspect`, the sun towards `sun_dir`,
/// shadows up to `distance` (clamped to the camera's far plane): today's fit, bit for bit.
pub fn cascades(camera: &CameraDesc, aspect: f32, sun_dir: [f32; 3], distance: f32) -> Cascades {
    let (near, far) = shadow_range(camera, distance);
    let sun = Vec3::from(sun_dir).normalize_or(Vec3::Y);
    let mut set = Cascades::empty(SHADOW_MAP_PX);
    set.splits = split_depths(near, far, SHADOW_CASCADES, DEFAULT_SHADOW_SPLIT_LAMBDA);
    let mut begin = near;
    for c in 0..SHADOW_CASCADES {
        let corners = slice_corners(camera, aspect, begin, set.splits[c]);
        place(&mut set, c, &legacy_light(&corners, sun), corners);
        begin = set.splits[c];
    }
    set
}

/// Whether `settings` draw the legacy shadow layout (two 1024 px `depth32float` cascades at the
/// practical split), which keeps the legacy fit so existing goldens and digests hold.
pub fn keeps_legacy_fit(settings: &ShadowSettings) -> bool {
    settings.cascades as usize == SHADOW_CASCADES
        && settings.map_px == SHADOW_MAP_PX
        && settings.split_lambda == DEFAULT_SHADOW_SPLIT_LAMBDA
        && settings.format == ShadowFormat::Depth32
}

/// The cascades of `settings` for `camera` on a target of `aspect`, the sun towards `sun_dir`:
/// [`ShadowSettings::cascades`] slices at the settings' split up to their distance, each fit
/// receiver-tight around `bounds` (world spheres of the frame's opaque rows: centre, radius) at
/// [`ShadowSettings::map_px`]. The legacy layout ([`keeps_legacy_fit`]) gets [`cascades`].
pub fn fit<I>(camera: &CameraDesc, aspect: f32, sun_dir: [f32; 3], settings: &ShadowSettings, bounds: I) -> Cascades
where
    I: Iterator<Item = [f32; 4]> + Clone,
{
    if keeps_legacy_fit(settings) {
        return cascades(camera, aspect, sun_dir, settings.distance);
    }
    let (near, far) = shadow_range(camera, settings.distance);
    let sun = Vec3::from(sun_dir).normalize_or(Vec3::Y);
    let map_px = settings.map_px.max(1);
    let count = (settings.cascades as usize).clamp(1, MAX_CASCADES);
    let mut set = Cascades::empty(map_px);
    set.splits = split_depths(near, far, count, settings.split_lambda);
    let mut begin = near;
    for c in 0..count {
        let end = set.splits[c];
        let (center, radius) = slice_sphere(camera, aspect, begin, end);
        place(&mut set, c, &tight_light(center, radius, sun, map_px, bounds.clone()), slice_corners(camera, aspect, begin, end));
        begin = end;
    }
    set
}

/// Which cascades a frame redraws ([`CascadeHistory::advance`]).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CascadeDraws {
    redraw: [bool; MAX_CASCADES],
}

impl CascadeDraws {
    /// Whether cascade `c` is drawn this frame.
    pub fn draws(&self, c: usize) -> bool {
        self.redraw.get(c).copied().unwrap_or(false)
    }

    /// How many cascades are drawn this frame.
    pub fn drawn(&self) -> usize {
        self.redraw.iter().filter(|draw| **draw).count()
    }
}

/// What a cascade's map was drawn for: a change redraws every cascade.
#[derive(Clone, Copy, Debug, PartialEq)]
struct MapKey {
    count: usize,
    map_px: u32,
    asked: (u8, u32),
    format: ShadowFormat,
}

/// The far-cascade cadence across frames: what each cascade's map holds, so a cascade that is not
/// redrawn keeps last frame's matrix with its map ([`ShadowSettings::cascade_redrawn`]).
#[derive(Clone, Debug, Default)]
pub struct CascadeHistory {
    held: Option<(MapKey, Cascades)>,
}

impl CascadeHistory {
    /// Plan frame `frame_index`'s cascade draws on `plan`: the cascades its settings redraw (every
    /// one when `settled`, on the first frame and after the count, size or format changed) keep
    /// the plan's fresh fit, and so does a cascade whose held map no longer covers its fresh slice
    /// (a camera cut or a jump); every other one is given back the matrix, texel and normal offset
    /// its map was drawn with, in the plan's cascades and frame uniforms. Without shadows the
    /// history resets.
    pub fn advance(&mut self, plan: &mut FramePlan, frame_index: u64, settled: bool) -> CascadeDraws {
        let (Some(fresh), Some(settings)) = (plan.cascades.as_mut(), plan.shadows.as_ref()) else {
            self.held = None;
            return CascadeDraws::default();
        };
        let key = MapKey { count: fresh.count(), map_px: fresh.map_px, asked: (settings.cascades, settings.map_px), format: settings.format };
        let held = self.held.take().filter(|(was, _)| *was == key);
        let mut draws = CascadeDraws::default();
        for c in 0..key.count {
            let margin = DEPTH_MARGIN_TEXELS * fresh.texel_world[c];
            let redraw = settings.cascade_redrawn(c as u8, frame_index, settled)
                || !held.as_ref().is_some_and(|(_, old)| covers(&old.view_proj[c], &fresh.view_proj[c], &fresh.slice_corners[c], margin));
            draws.redraw[c] = redraw;
            if let (false, Some((_, old))) = (redraw, held.as_ref()) {
                fresh.view_proj[c] = old.view_proj[c];
                fresh.planes[c] = old.planes[c];
                fresh.texel_world[c] = old.texel_world[c];
                fresh.depth_range[c] = old.depth_range[c];
                hold_frame(&mut plan.frame, c, old);
            }
        }
        // A settled capture's maps are the capture's: Live starts over after it.
        self.held = (!settled).then(|| (key, fresh.clone()));
        draws
    }

    /// Forget every held map: the next frame redraws each cascade (a history reset, the end of a
    /// settled capture).
    pub fn reset(&mut self) {
        self.held = None;
    }
}

/// Whether the map drawn through `held` still shades the cascade `fresh` fits: every corner of
/// `slice` inside the map (light-space x and y), and the fresh fit's receiver depth span (its
/// light depth less its `margin` world units at each end) inside the map's light depth give or
/// take [`HELD_DEPTH_SLACK`], so a held cascade still shades its fresh slice and its receivers.
fn covers(held: &[f32; 16], fresh: &[f32; 16], slice: &[[f32; 3]; 8], margin: f32) -> bool {
    let held = Mat4::from_cols_array(held);
    let on_map = slice.iter().all(|corner| {
        let at = held * Vec3::from(*corner).extend(1.0);
        at.x.abs() <= 1.0 && at.y.abs() <= 1.0
    });
    let inverse = Mat4::from_cols_array(fresh).inverse();
    let near = inverse.project_point3(Vec3::ZERO);
    let far = inverse.project_point3(Vec3::Z);
    let along = (far - near).normalize_or_zero() * margin;
    let depth = |point: Vec3| held.project_point3(point).z;
    let (first, last) = (depth(near + along), depth(far - along));
    let within = -HELD_DEPTH_SLACK..=1.0 + HELD_DEPTH_SLACK;
    on_map && within.contains(&first) && within.contains(&last)
}

/// Give cascade `c` of `frame` the matrix, texel and normal offset of `old`.
fn hold_frame(frame: &mut GpuFrame, c: usize, old: &Cascades) {
    let offset = old.normal_offsets()[c];
    frame.cascade_matrices[c] = old.view_proj[c];
    frame.cascade_texels[c] = old.texel_world[c];
    frame.cascade_offsets[c] = offset;
    if c < SHADOW_CASCADES {
        frame.cascade_view_proj[c] = old.view_proj[c];
        frame.shadow_params[1 + c] = offset;
    }
}

/// The shape of a shadow depth array: layers, side and format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShadowMapDesc {
    /// Array layers (one per cascade).
    pub layers: u32,
    /// Each layer's side in texels.
    pub side: u32,
    /// The depth format.
    pub format: TextureFormat,
}

impl ShadowMapDesc {
    /// The legacy maps: two 1024 px `depth32float` layers.
    pub const LEGACY: ShadowMapDesc = ShadowMapDesc { layers: SHADOW_CASCADES as u32, side: SHADOW_MAP_PX, format: SHADOW_FORMAT };
    /// What a renderer holds while no frame draws sun shadows (before the first shadowed frame,
    /// with shadows switched off or the sun unlit): one 1 px layer the frame group still binds.
    pub const PLACEHOLDER: ShadowMapDesc = ShadowMapDesc { layers: 1, side: 1, format: SHADOW_FORMAT };

    /// The maps `settings` draw: one layer per cascade at the settings' side and format.
    pub fn for_settings(settings: &ShadowSettings) -> ShadowMapDesc {
        ShadowMapDesc {
            layers: u32::from(settings.cascades).clamp(1, MAX_CASCADES as u32),
            side: settings.map_px.max(1),
            format: settings.texture_format(),
        }
    }

    /// The array's bytes (what the budget ledger's shadow row counts).
    pub fn bytes(&self) -> u64 {
        let texel = match self.format {
            TextureFormat::Depth16Unorm => 2,
            _ => 4,
        };
        u64::from(self.layers) * u64::from(self.side) * u64::from(self.side) * texel
    }
}

/// The cascades' depth targets: one array of layers, a view per layer to draw into and an array
/// view to sample.
pub(crate) struct ShadowMaps {
    _texture: Texture,
    pub(crate) layers: Vec<TextureView>,
    pub(crate) array: TextureView,
}

impl ShadowMaps {
    /// The placeholder ([`ShadowMapDesc::PLACEHOLDER`]): maps are allocated on the first frame
    /// that draws shadows.
    pub(crate) fn new(device: &Device) -> ShadowMaps {
        ShadowMaps::with_desc(device, ShadowMapDesc::PLACEHOLDER)
    }

    /// Maps of `desc`'s shape.
    pub(crate) fn with_desc(device: &Device, desc: ShadowMapDesc) -> ShadowMaps {
        let texture = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("shadow maps"),
            size: wgpu::Extent3d { width: desc.side, height: desc.side, depth_or_array_layers: desc.layers },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: desc.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let layers = (0..desc.layers)
            .map(|layer| {
                texture.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        let array = texture.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        ShadowMaps { _texture: texture, layers, array }
    }
}
