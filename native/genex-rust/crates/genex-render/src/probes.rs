//! Reflection probes (renderer pass 2 A.3; prior art A2.2): boxes of the world whose glossy
//! reflections come from a cube captured inside them instead of the sky, so a room's polished floor
//! mirrors its own walls and ceiling.
//!
//! - **What a game declares** ([`ReflectionProbe`], `Lighting::reflection_probes`): an axis-aligned
//!   box (a room's inside), the point inside it the cube is captured from, how far past its faces
//!   its influence fades out, and a radiance multiplier. Hostile values are held or dropped ([`ReflectionProbe::held`]).
//!   The first [`EnvironmentQuality::reflection_probes`] probes a frame declares get a cube.
//! - **Where they live** ([`ProbeMaps`]): one `rgba16float` cube array whose layer 0 is the sky's
//!   prefiltered cube and layers 1.. the probes', each at the sky's [`crate::ibl::SPECULAR_MIPS`]
//!   roughness levels and side ([`probe_side`]: the sky's cube side, at most the quality's
//!   [`EnvironmentQuality::probe_side_max`]). The forward pass binds it at binding 11
//!   (`layout::FRAME_ENV_BINDINGS`' `env_specular`, a `texture_cube_array`) in place of the sky cube,
//!   so the probes take no new sampled texture (plan section 2, D1). Without probes the sky's own
//!   cube is bound through a one-cube array view: nothing is copied and the picture is unchanged.
//! - **Rows and binning**: each probe's influence sphere is binned with the lights
//!   (`cluster::ClusterKind::Probe`, LG-16), and its row ([`GpuProbeRow`]: the box, the fade, the
//!   capture point, the layer, the multiplier) is read in binned order from one storage table
//!   (binding 22, `env_probe_rows`; the forward fragment stage's sixth storage buffer of eight).
//! - **Shading** (`shaders/forward_env.wgsl`, `gx_env_light`): the fragment walks the
//!   probes of its tile and z-bin, weighs each by its fade past the box ([`influence`]), looks it up along the
//!   reflection corrected to the box (box projection, [`parallax_direction`]; Bevy v0.20
//!   `light_probe/environment_map.wesl`, MIT OR Apache-2.0), and fills what the probes leave of the
//!   unit weight with the sky ([`blend`]): overlapping probes share their weight, so the reflection
//!   is continuous across every boundary (no seam).
//! - **Capture** (graph node 11, after the sky's bake): a probe's six faces are drawn from its
//!   capture point with the forward shading ([`face_view_proj`], every face's opaque batches through a
//!   CPU frustum cull), lit by the sun through a shadow map of the probe's own box
//!   ([`probe_light_view_proj`]) so the capture never depends on the camera; texels no geometry
//!   covers take the sky. The faces are then filtered with the sky's own prefilter (SI-01: GGX by
//!   filtered importance sampling from a box mip chain) into a staging cube and published into the
//!   probe's layer whole, so no frame samples a cube mixing two captures. A capture is
//!   [`CAPTURE_STEPS`] steps ([`CaptureStep`]): six faces, the mip chain, six prefiltered faces and
//!   the publish. A probe never captured is captured whole on the frame it appears (at most
//!   [`COLD_PROBES_PER_FRAME`] a frame; the rest wait their turn, unseen); a stale one (the sky
//!   rebaked, the probe moved, the cube size changed) is refreshed one step per frame on the
//!   quality's rebake cadence while its last capture stays bound; a settled capture recaptures
//!   everything that differs, whole, so it equals a capture after a cold start.
//!
//! [`LANDED`] stays false until the renderer's capture node and the forward binding land
//! (integration patch): until then a frame binds nothing of this module and probes are inert.

use bytemuck::{Pod, Zeroable};
use glam::{Mat4, Vec3, Vec4};
use wgpu::{
    BindGroup, BindGroupLayout, BindGroupLayoutEntry, BindingResource, Buffer, BufferUsages, ComputePipeline, Device, Queue, Sampler, Texture, TextureFormat,
    TextureUsages, TextureView, TextureViewDimension,
};

use crate::cluster::ClusterSphere;
use crate::compile::Compiled;
use crate::error::RenderError;
use crate::ibl::SPECULAR_MIPS;
use crate::layout::GpuIblBake;
use crate::settings::EnvironmentQuality;

/// Whether the renderer captures probes and the forward pass reads them.
pub const LANDED: bool = true;

/// Probes binned and shaded at most (the binning's cap, `cluster::MAX_BINNED_PROBES`); a quality
/// gives cubes to at most [`EnvironmentQuality::reflection_probes`] of them.
pub const MAX_PROBES: usize = crate::cluster::MAX_BINNED_PROBES;
/// The largest box side a probe may have, in world units (a bigger box is dropped: its cube would
/// stand for a region no single capture point sees).
pub const PROBE_EXTENT_MAX: f32 = 4096.0;
/// The smallest box side, in world units (a thinner box is dropped).
pub const PROBE_EXTENT_MIN: f32 = 1.0e-3;
/// The largest radiance multiplier a probe keeps.
pub const PROBE_INTENSITY_MAX: f32 = 64.0;
/// The capture's near plane, in world units.
pub const CAPTURE_NEAR: f32 = 0.05;
/// How far past the box's farthest corner the capture still sees, as a share of the box's diagonal
/// (a window shows what is outside).
pub const CAPTURE_REACH: f32 = 4.0;
/// The capture's shadow map side, in texels (one map, reused by every face).
pub const CAPTURE_SHADOW_PX: u32 = 1024;
/// How far toward the sun the capture's shadow map reaches past the box, in world units (casters
/// outside the box: the building's other walls, the roof).
pub const CAPTURE_CASTER_REACH: f32 = 60.0;
/// Steps of one capture: six faces, the mip chain, six prefiltered faces, the publish.
pub const CAPTURE_STEPS: u32 = 14;
/// Probes captured whole on one Live frame when they have never been captured.
pub const COLD_PROBES_PER_FRAME: usize = 2;
/// The bytes of one probe row.
pub const PROBE_ROW_BYTES: u64 = size_of::<GpuProbeRow>() as u64;
/// Cube faces.
const FACES: u32 = 6;
/// Bytes of an `rgba16float` texel.
const TEXEL_BYTES: u64 = 8;

/// A reflection probe: an axis-aligned box of the world whose glossy reflections come from a cube
/// captured at a point inside it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReflectionProbe {
    /// The box's least corner (world units): where its influence and its box projection end.
    pub min: [f32; 3],
    /// The box's greatest corner.
    pub max: [f32; 3],
    /// Where the cube is captured from (inside the box; held inside it).
    pub capture: [f32; 3],
    /// How far past the box's faces its influence fades out, in world units (0: a hard edge; held
    /// to half the box's smallest side): the box is the room's inside, so its floor, walls and
    /// ceiling reflect it whole.
    pub blend: f32,
    /// The multiplier of the probe's reflected radiance (1: as captured).
    pub intensity: f32,
}

impl ReflectionProbe {
    /// A probe over the box `min..max`, captured from its centre, fading in over a tenth of its
    /// smallest side, at full intensity.
    pub fn new(min: [f32; 3], max: [f32; 3]) -> ReflectionProbe {
        let (a, b) = (Vec3::from(min), Vec3::from(max));
        let smallest = (b - a).abs().min_element();
        ReflectionProbe { min, max, capture: ((a + b) * 0.5).to_array(), blend: 0.1 * smallest, intensity: 1.0 }
    }

    /// The probe captured from `capture`.
    pub fn with_capture(self, capture: [f32; 3]) -> ReflectionProbe {
        ReflectionProbe { capture, ..self }
    }

    /// The probe fading in over `blend` world units inside its faces.
    pub fn with_blend(self, blend: f32) -> ReflectionProbe {
        ReflectionProbe { blend, ..self }
    }

    /// The probe's radiance times `intensity`.
    pub fn with_intensity(self, intensity: f32) -> ReflectionProbe {
        ReflectionProbe { intensity, ..self }
    }

    /// The probe as the renderer keeps it, or None when it cannot be shaded: a corner that is not
    /// finite, or a box side below [`PROBE_EXTENT_MIN`] or above [`PROBE_EXTENT_MAX`] (corners in
    /// either order are sorted). The capture point is held inside the box (its centre when not
    /// finite), the fade to `0..=` half the smallest side (0 when not finite), the multiplier to
    /// `0..=`[`PROBE_INTENSITY_MAX`] (1 when not finite).
    pub fn held(&self) -> Option<ReflectionProbe> {
        let finite = |v: &[f32; 3]| v.iter().all(|c| c.is_finite());
        if !finite(&self.min) || !finite(&self.max) {
            return None;
        }
        let (a, b) = (Vec3::from(self.min), Vec3::from(self.max));
        let (min, max) = (a.min(b), a.max(b));
        let extent = max - min;
        if extent.min_element() < PROBE_EXTENT_MIN || extent.max_element() > PROBE_EXTENT_MAX {
            return None;
        }
        let centre = (min + max) * 0.5;
        let capture = if finite(&self.capture) { Vec3::from(self.capture).clamp(min, max) } else { centre };
        let blend = if self.blend.is_finite() { self.blend.clamp(0.0, 0.5 * extent.min_element()) } else { 0.0 };
        let intensity = if self.intensity.is_finite() { self.intensity.clamp(0.0, PROBE_INTENSITY_MAX) } else { 1.0 };
        Some(ReflectionProbe { min: min.to_array(), max: max.to_array(), capture: capture.to_array(), blend, intensity })
    }

    /// The sphere around its influence (the box grown by the fade): what the light binning reads.
    pub fn sphere(&self) -> ClusterSphere {
        let (a, b) = (Vec3::from(self.min), Vec3::from(self.max));
        ClusterSphere { centre: ((a + b) * 0.5).to_array(), radius: 0.5 * (b - a).length() + self.blend * 3.0_f32.sqrt() }
    }

    /// What identifies the probe's capture across frames: its box and capture point, bit for bit
    /// (the fade and the multiplier change only its row).
    pub fn capture_key(&self) -> [u32; 9] {
        let mut key = [0; 9];
        for (slot, value) in key.iter_mut().zip(self.min.iter().chain(&self.max).chain(&self.capture)) {
            *slot = value.to_bits();
        }
        key
    }
}

/// `probes` as the renderer keeps them, in declaration order: [`ReflectionProbe::held`] of each,
/// the dropped ones left out, at most [`MAX_PROBES`].
pub fn held_probes(probes: &[ReflectionProbe]) -> Vec<ReflectionProbe> {
    probes.iter().filter_map(ReflectionProbe::held).take(MAX_PROBES).collect()
}

/// One probe's row in the forward pass's probe table (`GxProbeRow` in
/// `shaders/forward_env_probes.wgsl`), in binned order.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuProbeRow {
    /// xyz: the box's least corner; w: the fade distance past its faces.
    pub min_blend: [f32; 4],
    /// xyz: the box's greatest corner; w: the cube array layer (1..; 0: not captured, no weight).
    pub max_layer: [f32; 4],
    /// xyz: the capture point; w: the radiance multiplier.
    pub capture_intensity: [f32; 4],
}

impl GpuProbeRow {
    /// The row of `probe` reading array layer `layer` (0: not captured yet, the row weighs nothing).
    pub fn of(probe: &ReflectionProbe, layer: u32) -> GpuProbeRow {
        let [x0, y0, z0] = probe.min;
        let [x1, y1, z1] = probe.max;
        let [cx, cy, cz] = probe.capture;
        GpuProbeRow { min_blend: [x0, y0, z0, probe.blend], max_layer: [x1, y1, z1, layer as f32], capture_intensity: [cx, cy, cz, probe.intensity] }
    }

    /// Whether the row weighs anything (a captured layer).
    pub fn active(&self) -> bool {
        self.max_layer[3] >= 1.0
    }
}

// --- CPU twins of the shading ---

/// The probe's weight at `p` (`gx_probe_influence`): 1 inside its box (a room's floor, walls and
/// ceiling included: they are its faces), falling smoothly to 0 over the fade distance past the
/// box (into the walls and beyond; a smoothstep per axis, multiplied over the three axes), so it is
/// continuous at every face and corner; 0 farther out. A fade of 0 is a hard edge.
pub fn influence(row: &GpuProbeRow, p: [f32; 3]) -> f32 {
    let blend = row.min_blend[3];
    let mut weight = 1.0;
    for ((at, min), max) in p.iter().zip(&row.min_blend).zip(&row.max_layer) {
        let inside = (at - (min - blend)).min((max + blend) - at);
        if inside < 0.0 {
            return 0.0;
        }
        if blend > 0.0 {
            // Smoothstep: the weight leaves 0 with zero slope, where the box projection turns
            // fastest (a ray grazing the influence's face).
            let t = (inside / blend).min(1.0);
            weight *= t * t * (3.0 - 2.0 * t);
        }
    }
    weight
}

/// The direction to look the probe's cube up in for a reflection leaving `p` along unit `dir`
/// (`gx_probe_parallax`): where the ray leaves the box, seen from the capture point (box
/// projection; Bevy v0.20 `light_probe/environment_map.wesl` `compute_cubemap_sample_dir`, MIT OR
/// Apache-2.0), so a wall in the cube is seen where it stands, not at infinity. Unnormalized. The
/// box projected onto is the probe's influence, its box grown by the fade distance: where the
/// projection turns fastest (a ray grazing a face, where the reflected point runs across the whole
/// cube within a pixel) the probe weighs nothing, so two probes splitting an open corridor blend
/// without a seam; a room's walls are seen the fade distance farther than they stand. A point
/// outside is taken to the box's nearest point; a degenerate direction keeps `dir`.
pub fn parallax_direction(row: &GpuProbeRow, p: [f32; 3], dir: [f32; 3]) -> [f32; 3] {
    let d = Vec3::from(dir);
    let blend = Vec3::splat(row.min_blend[3]);
    let min = Vec3::new(row.min_blend[0], row.min_blend[1], row.min_blend[2]) - blend;
    let max = Vec3::new(row.max_layer[0], row.max_layer[1], row.max_layer[2]) + blend;
    let p = Vec3::from(p).clamp(min, max);
    // Each axis's exit plane ahead of the ray: the far face the ray moves towards (WGSL forbids
    // infinity, so a parallel axis's distance is FLOAT_MAX there, as Bevy's is).
    let exit = |axis: usize| {
        let (component, from) = (d[axis], p[axis]);
        if component.abs() < 1.0e-6 {
            return f32::MAX;
        }
        let plane = if component > 0.0 { max[axis] } else { min[axis] };
        (plane - from) / component
    };
    let distance = exit(0).min(exit(1)).min(exit(2));
    if !(distance.is_finite() && distance >= 0.0) || distance == f32::MAX {
        return dir;
    }
    let capture = Vec3::new(row.capture_intensity[0], row.capture_intensity[1], row.capture_intensity[2]);
    let hit = p + d * distance;
    let corrected = hit - capture;
    if corrected.length_squared() < 1.0e-12 { dir } else { corrected.to_array() }
}

/// How the probes at a point share its reflection (`gx_env_light`'s reflection weights): each row's
/// [`influence`] (an inactive row weighs nothing), divided by their sum when it passes 1, and the
/// sky's what is left of 1. Returns the probes' weights in row order and the sky's.
pub fn blend(rows: &[GpuProbeRow], p: [f32; 3]) -> (Vec<f32>, f32) {
    let mut weights: Vec<f32> = rows.iter().map(|row| if row.active() { influence(row, p) } else { 0.0 }).collect();
    let total: f32 = weights.iter().sum();
    if total > 1.0 {
        for weight in &mut weights {
            *weight /= total;
        }
    }
    (weights, (1.0 - total).max(0.0))
}

// --- Capture geometry ---

/// The forward, right and up vectors of cube face `face` (+X, -X, +Y, -Y, +Z, -Z), such that a
/// direction `forward + s · right + t · up` lands at normalized device coordinate (s, t) of the
/// face's render and so at the texel `ibl::cube_direction` names: the face's image is the cube's
/// texel for texel. Its basis is left-handed (a cube face is a mirror image of a right-handed
/// camera's view), so the capture's pipelines take clockwise triangles as front faces.
pub fn face_basis(face: u32) -> (Vec3, Vec3, Vec3) {
    match face {
        0 => (Vec3::X, Vec3::NEG_Z, Vec3::Y),
        1 => (Vec3::NEG_X, Vec3::Z, Vec3::Y),
        2 => (Vec3::Y, Vec3::X, Vec3::NEG_Z),
        3 => (Vec3::NEG_Y, Vec3::X, Vec3::Z),
        4 => (Vec3::Z, Vec3::X, Vec3::Y),
        _ => (Vec3::NEG_Z, Vec3::NEG_X, Vec3::Y),
    }
}

/// How far a probe's capture sees: past the box's diagonal by [`CAPTURE_REACH`] diagonals.
pub fn capture_far(probe: &ReflectionProbe) -> f32 {
    let diagonal = (Vec3::from(probe.max) - Vec3::from(probe.min)).length();
    (diagonal * (1.0 + CAPTURE_REACH)).max(CAPTURE_NEAR * 16.0)
}

/// The view-projection face `face` of `probe`'s cube is drawn with: a 90-degree square frustum
/// from the capture point along [`face_basis`], from [`CAPTURE_NEAR`] to [`capture_far`], depth
/// 0..1 (reversed when `reversed`, as the HDR scene's).
pub fn face_view_proj(probe: &ReflectionProbe, face: u32, reversed: bool) -> Mat4 {
    let (forward, right, up) = face_basis(face);
    let eye = Vec3::from(probe.capture);
    // Rows of the view: x along `right`, y along `up`, z against `forward` (the camera looks down
    // -z), so the projection's (x, y) / -z is (s, t).
    let view = Mat4::from_cols(
        Vec4::new(right.x, up.x, -forward.x, 0.0),
        Vec4::new(right.y, up.y, -forward.y, 0.0),
        Vec4::new(right.z, up.z, -forward.z, 0.0),
        Vec4::new(-right.dot(eye), -up.dot(eye), forward.dot(eye), 1.0),
    );
    let far = capture_far(probe);
    let projection = if reversed {
        glam::camera::rh::proj::directx::perspective(core::f32::consts::FRAC_PI_2, 1.0, far, CAPTURE_NEAR)
    } else {
        glam::camera::rh::proj::directx::perspective(core::f32::consts::FRAC_PI_2, 1.0, CAPTURE_NEAR, far)
    };
    projection * view
}

/// The sun's orthographic view-projection the capture's shadow map is drawn with: the probe's
/// box, seen from the sun towards `sun_dir` (unit, towards the sun), its depth range reaching
/// [`CAPTURE_CASTER_REACH`] towards the sun past the box (casters outside it), depth 0..1 (the
/// shadow maps' convention: standard depth). Its texel in world units is the second value.
pub fn probe_light_view_proj(probe: &ReflectionProbe, sun_dir: [f32; 3]) -> (Mat4, f32) {
    let sun = Vec3::from(sun_dir).try_normalize().unwrap_or(Vec3::Y);
    let (min, max) = (Vec3::from(probe.min), Vec3::from(probe.max));
    let centre = (min + max) * 0.5;
    let radius = 0.5 * (max - min).length();
    let up = if sun.y.abs() > 0.99 { Vec3::Z } else { Vec3::Y };
    let eye = centre + sun * (radius + CAPTURE_CASTER_REACH);
    let view = glam::camera::rh::view::look_at_mat4(eye, centre, up);
    let projection = glam::camera::rh::proj::directx::orthographic(-radius, radius, -radius, radius, 0.0, 2.0 * radius + CAPTURE_CASTER_REACH);
    (projection * view, 2.0 * radius / CAPTURE_SHADOW_PX as f32)
}

// --- Sizes and memory ---

/// The side of the probe cubes for a sky cube of `sky_side` under `quality`: the sky's, at most
/// [`EnvironmentQuality::probe_side_max`] (0: no cap), never below the last roughness mip's texel.
pub fn probe_side(sky_side: u32, quality: &EnvironmentQuality) -> u32 {
    let cap = if quality.probe_side_max == 0 { sky_side } else { quality.probe_side_max };
    sky_side.min(cap).max(crate::ibl::CUBE_SIZE_MIN)
}

/// Bytes of one cube of `side` with every roughness mip.
pub fn cube_bytes(side: u32) -> u64 {
    (0..SPECULAR_MIPS).map(|mip| u64::from((side >> mip).max(1)).pow(2)).sum::<u64>() * u64::from(FACES) * TEXEL_BYTES
}

/// Bytes of a cube of `side` with its full box mip chain (the capture's source).
fn chain_bytes(side: u32) -> u64 {
    let mips = u32::BITS - side.max(1).leading_zeros();
    (0..mips).map(|mip| u64::from((side >> mip).max(1)).pow(2)).sum::<u64>() * u64::from(FACES) * TEXEL_BYTES
}

/// The bytes the probes hold with `count` cubes of `side` (0 without probes): the array (the sky's
/// layer and one per probe), the capture's source cube with its chain and depth, the staging cube,
/// the shadow map and the row table.
pub fn probe_bytes(side: u32, count: u32) -> u64 {
    if count == 0 {
        return 0;
    }
    let array = u64::from(count + 1) * cube_bytes(side);
    let depth = u64::from(side) * u64::from(side) * 4;
    let shadow = u64::from(CAPTURE_SHADOW_PX) * u64::from(CAPTURE_SHADOW_PX) * 4;
    array + chain_bytes(side) + depth + cube_bytes(side) + shadow + MAX_PROBES as u64 * PROBE_ROW_BYTES
}

// --- The capture schedule ---

/// One step of a probe's capture ([`CAPTURE_STEPS`] in a fixed order).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum CaptureStep {
    /// Draw one face (0..6) into the capture's source cube: its shadow map, the face, the sky
    /// behind it.
    Face(u32),
    /// The source cube's box mip chain and its mip 0 into the staging cube.
    Chain,
    /// The GGX prefilter of one face's roughness mips (1..) into the staging cube.
    Prefilter(u32),
    /// The staging cube into the probe's layer, every face and mip at once.
    Publish,
}

impl CaptureStep {
    /// Step `index` of a capture (`0..CAPTURE_STEPS`; later indices publish).
    pub const fn at(index: u32) -> CaptureStep {
        match index {
            0..FACES => CaptureStep::Face(index),
            FACES => CaptureStep::Chain,
            7..13 => CaptureStep::Prefilter(index - 7),
            _ => CaptureStep::Publish,
        }
    }

    /// Texel samples the step reads or writes for cubes of `side` (the capture's work model): a
    /// face's drawn texels and its sky fill, the chain's, the prefilter's samples, the copy's.
    pub fn work(self, side: u32) -> u64 {
        let texels = |side: u32| u64::from(side) * u64::from(side);
        match self {
            CaptureStep::Face(_) => 2 * texels(side),
            CaptureStep::Chain => {
                let mips = u32::BITS - side.max(1).leading_zeros();
                (1..mips).map(|mip| 4 * texels((side >> mip).max(1))).sum::<u64>() * u64::from(FACES) + u64::from(FACES) * texels(side)
            }
            CaptureStep::Prefilter(_) => {
                let samples = u64::from(crate::ibl::prefilter_samples(side));
                (1..SPECULAR_MIPS).map(|mip| texels((side >> mip).max(1)) * samples).sum()
            }
            CaptureStep::Publish => cube_bytes(side) / TEXEL_BYTES,
        }
    }
}

/// The most texel work one time-sliced frame does for cubes of `side`: its largest step.
pub fn capture_slice_budget(side: u32) -> u64 {
    (0..CAPTURE_STEPS).map(|index| CaptureStep::at(index).work(side)).max().unwrap_or(0)
}

/// What one probe slot holds.
#[derive(Clone, Debug, PartialEq)]
struct Slot {
    probe: ReflectionProbe,
    key: [u32; 9],
    /// Whether the layer holds a published capture (the row weighs it).
    captured: bool,
    /// Whether the capture no longer matches what it would draw now (it stays bound until its
    /// refresh publishes).
    stale: bool,
}

/// What the capture does on one frame: the probe slots (array layer - 1) and their steps, in order.
pub type CaptureWork = Vec<(usize, CaptureStep)>;

/// The probes' schedule: which declared probe holds which layer, which captures are due, and the
/// rows the forward pass reads. Pure state, no GPU (`ProbeMaps` encodes what it says).
#[derive(Clone, Debug, Default)]
pub struct ProbeSchedule {
    slots: Vec<Option<Slot>>,
    /// The capture in progress: its slot and next step.
    job: Option<(usize, u32)>,
    /// The cube side and slot count the layers were captured at.
    shape: (u32, usize),
    /// What the captures were lit by (the sky's bake generation): a new one makes every capture
    /// stale.
    lit_by: u64,
}

/// What one frame asks of the probe schedule.
#[derive(Clone, Copy, Debug)]
pub struct ProbeFrame<'a> {
    /// The probes the frame declares, held ([`held_probes`]), in declaration order.
    pub probes: &'a [ReflectionProbe],
    /// The cube side ([`probe_side`]).
    pub side: u32,
    /// Most probes given a cube ([`EnvironmentQuality::reflection_probes`]).
    pub cap: usize,
    /// What lights the captures (the sky bake's generation): a change makes them stale.
    pub lit_by: u64,
    /// The frame index (the rebake cadence's key).
    pub frame_index: u64,
    /// A refresh step runs every this many frames (0 and 1: every frame).
    pub cadence: u8,
    /// A settled capture's frame: recapture whole whatever differs.
    pub settle: bool,
}

impl ProbeSchedule {
    /// The layer (1..) the declared probe `index` reads this frame, or 0 when it has no published
    /// capture.
    pub fn layer_of(&self, frames: &[ReflectionProbe], index: usize) -> u32 {
        let Some(probe) = frames.get(index) else { return 0 };
        let key = probe.capture_key();
        self.slots
            .iter()
            .position(|slot| slot.as_ref().is_some_and(|slot| slot.key == key && slot.captured))
            .map_or(0, |slot| slot as u32 + 1)
    }

    /// Slots in use.
    pub fn held(&self) -> usize {
        self.slots.iter().flatten().count()
    }

    /// Whether every held probe has a published, current capture.
    pub fn settled(&self) -> bool {
        self.job.is_none() && self.slots.iter().flatten().all(|slot| slot.captured && !slot.stale)
    }

    /// Advance to `frame`: give the first `cap` declared probes slots (keeping a probe's slot while
    /// its box and capture point stay), drop the others, and return the capture steps due this
    /// frame in encode order. A new cube shape or a new light makes every capture stale; a shape
    /// change also drops what the layers held (they are made again).
    pub fn advance(&mut self, frame: &ProbeFrame<'_>) -> CaptureWork {
        let wanted: Vec<&ReflectionProbe> = frame.probes.iter().take(frame.cap.min(MAX_PROBES)).collect();
        if self.shape != (frame.side, frame.cap) {
            self.slots = vec![None; frame.cap.min(MAX_PROBES)];
            self.job = None;
            self.shape = (frame.side, frame.cap);
        }
        if self.lit_by != frame.lit_by {
            self.lit_by = frame.lit_by;
            for slot in self.slots.iter_mut().flatten() {
                slot.stale = true;
            }
        }
        self.assign(&wanted);
        let mut work = CaptureWork::new();
        if frame.settle {
            // Every capture that differs, whole (in slot order), the job in progress included.
            self.job = None;
            for (index, slot) in self.slots.iter_mut().enumerate() {
                if let Some(slot) = slot.as_mut().filter(|slot| !slot.captured || slot.stale) {
                    work.extend((0..CAPTURE_STEPS).map(|step| (index, CaptureStep::at(step))));
                    slot.captured = true;
                    slot.stale = false;
                }
            }
            return work;
        }
        // Probes never captured: whole, a few a frame.
        let cold: Vec<usize> = self.slots.iter().enumerate().filter(|(_, slot)| slot.as_ref().is_some_and(|slot| !slot.captured)).map(|(index, _)| index).take(COLD_PROBES_PER_FRAME).collect();
        for index in cold {
            if self.job.is_some_and(|(slot, _)| slot == index) {
                self.job = None;
            }
            work.extend((0..CAPTURE_STEPS).map(|step| (index, CaptureStep::at(step))));
            if let Some(slot) = self.slots[index].as_mut() {
                slot.captured = true;
                slot.stale = false;
            }
        }
        if !work.is_empty() {
            return work;
        }
        // A stale capture's refresh: one step on the cadence, the first stale slot when idle.
        if self.job.is_none() {
            self.job = self.slots.iter().position(|slot| slot.as_ref().is_some_and(|slot| slot.stale)).map(|slot| (slot, 0));
        }
        let Some((index, step)) = self.job else { return work };
        if !crate::sky::lut_due(frame.frame_index, frame.cadence) {
            return work;
        }
        work.push((index, CaptureStep::at(step)));
        if step + 1 == CAPTURE_STEPS {
            self.job = None;
            if let Some(slot) = self.slots[index].as_mut() {
                slot.stale = false;
            }
        } else {
            self.job = Some((index, step + 1));
        }
        work
    }

    /// Keep each wanted probe's slot (by capture key), free the slots of probes no longer wanted
    /// (a refresh in progress on one is dropped), and give the new ones free slots.
    fn assign(&mut self, wanted: &[&ReflectionProbe]) {
        let keys: Vec<[u32; 9]> = wanted.iter().map(|probe| probe.capture_key()).collect();
        for (index, slot) in self.slots.iter_mut().enumerate() {
            if slot.as_ref().is_some_and(|held| !keys.contains(&held.key)) {
                *slot = None;
                if self.job.is_some_and(|(job, _)| job == index) {
                    self.job = None;
                }
            }
        }
        for (probe, key) in wanted.iter().zip(&keys) {
            if let Some(slot) = self.slots.iter_mut().flatten().find(|slot| slot.key == *key) {
                // Same capture; its fade and multiplier may change freely.
                slot.probe = **probe;
                continue;
            }
            if let Some(free) = self.slots.iter_mut().find(|slot| slot.is_none()) {
                *free = Some(Slot { probe: **probe, key: *key, captured: false, stale: true });
            }
        }
    }

    /// The probe slot `slot` holds (what its capture draws).
    pub fn probe(&self, slot: usize) -> Option<&ReflectionProbe> {
        self.slots.get(slot)?.as_ref().map(|slot| &slot.probe)
    }

    /// The forward pass's rows for `probes` (declared order) in the binned order `order` (each a
    /// declared index): each probe's row reading its layer, inactive while it has no published
    /// capture or no slot.
    pub fn rows(&self, probes: &[ReflectionProbe], order: &[u32]) -> Vec<GpuProbeRow> {
        order.iter().map(|index| probes.get(*index as usize).map_or_else(GpuProbeRow::default, |probe| GpuProbeRow::of(probe, self.layer_of(probes, *index as usize)))).collect()
    }
}

// --- The forward pass's bindings ---

/// The forward frame group's name for the probe cube array at binding 11 (layer 0 the sky).
pub const ENV_PROBES: &str = "env_probes";
/// The forward frame group's name for the probe rows at binding 22.
pub const ENV_PROBE_ROWS: &str = "env_probe_rows";
/// The forward frame group's reflection-probe bindings, as (binding, WGSL name): the cube array
/// takes the sky cube's binding 11 (0 new sampled textures), the rows binding 22 (the forward
/// fragment stage's sixth storage buffer of eight; plan section 2).
pub const FRAME_PROBE_BINDINGS: [(u32, &str); 2] = [(11, ENV_PROBES), (22, ENV_PROBE_ROWS)];

/// The forward frame layout's entry of probe binding `name` at `binding` (fragment stage): the
/// filterable `texture_cube_array<f32>`, the read-only row table, or the irradiance volumes'
/// atlas (`irradiance::frame_env_entry`); None for another name.
pub fn frame_env_entry(binding: u32, name: &str) -> Option<BindGroupLayoutEntry> {
    let ty = match name {
        ENV_PROBES => wgpu::BindingType::Texture {
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
            view_dimension: TextureViewDimension::CubeArray,
            multisampled: false,
        },
        ENV_PROBE_ROWS => wgpu::BindingType::Buffer {
            ty: wgpu::BufferBindingType::Storage { read_only: true },
            has_dynamic_offset: false,
            min_binding_size: wgpu::BufferSize::new(PROBE_ROW_BYTES),
        },
        // The irradiance volumes' atlas (renderer pass 2 A.4) rides the probes' entry point.
        _ => return crate::irradiance::frame_env_entry(binding, name),
    };
    Some(BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None })
}

// --- GPU state ---

/// The capture's compute passes (shaders/ibl/probe.wgsl) after the common structs.
pub const PROBE_PASSES: &str = crate::shaders::minify::shipped_wgsl!(concat!(include_str!("../shaders/common.wgsl"), include_str!("../shaders/ibl/probe.wgsl")));
/// The sky-fill entry point.
pub const SKY_FILL_ENTRY: &str = "cs_probe_sky_fill";
/// The copy entry point.
pub const COPY_ENTRY: &str = "cs_probe_copy";
/// The most probe cubes one array holds whatever a quality asks (with the sky's layer, six layers
/// each, within WebGPU core's 256 array layers).
pub const MAX_PROBE_CUBES: usize = 32;
/// The capture's depth format (the HDR scene's: `depth32float`).
pub const CAPTURE_DEPTH_FORMAT: TextureFormat = TextureFormat::Depth32Float;
/// The capture's colour format (the cubes', `ibl::ENV_CUBE_FORMAT`).
pub const CAPTURE_COLOR_FORMAT: TextureFormat = crate::ibl::ENV_CUBE_FORMAT;
/// The probe array's usages: written as storage (the sky's layer) and copied into (a publish),
/// sampled as a cube array, read back by tests.
const ARRAY_USAGE: TextureUsages = TextureUsages::STORAGE_BINDING.union(TextureUsages::TEXTURE_BINDING).union(TextureUsages::COPY_DST).union(TextureUsages::COPY_SRC);
/// The capture source's usages: drawn into, its sky filled and its chain built as storage, sampled
/// by the prefilter, its mip 0 copied out.
const SOURCE_USAGE: TextureUsages =
    TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::STORAGE_BINDING).union(TextureUsages::TEXTURE_BINDING).union(TextureUsages::COPY_SRC);
/// The staging cube's usages: prefiltered into, copied in and out.
const STAGING_USAGE: TextureUsages = TextureUsages::STORAGE_BINDING.union(TextureUsages::COPY_DST).union(TextureUsages::COPY_SRC);
/// Workgroup side of the capture's 2D compute passes.
const WORKGROUP_SIDE: u32 = 8;
/// Bytes between the uniform slots (core's uniform offset alignment).
const SLOT_BYTES: u64 = 256;
/// Uniform slots: the sky fill per face, the downsample, the copy, the prefilter per face and
/// roughness mip.
const SLOT_SKY_FILL: u64 = 0;
const SLOT_DOWNSAMPLE: u64 = SLOT_SKY_FILL + FACES as u64;
const SLOT_COPY: u64 = SLOT_DOWNSAMPLE + 1;
const SLOT_PREFILTER: u64 = SLOT_COPY + 1;
const SLOTS: u64 = SLOT_PREFILTER + FACES as u64 * SPECULAR_MIPS as u64;

/// The reflection probes' GPU state and schedule, held by the environment
/// (`ibl::EnvironmentMaps::probes`): the probe array the forward pass binds, the capture's
/// scratch targets, the row table and the passes that fill them.
pub struct ProbeMaps {
    schedule: ProbeSchedule,
    /// The frame's held probes, in declaration order.
    probes: Vec<ReflectionProbe>,
    rows: Buffer,
    /// The rows last written (rewritten only when they change).
    written_rows: Vec<GpuProbeRow>,
    /// A one-cube black array: what binds while no sky is baked.
    neutral: TextureView,
    gpu: Option<ProbeGpu>,
    /// The sky bake (`EnvironmentMaps::generation`) layer 0 holds.
    sky_copied: Option<u64>,
    /// Bumped whenever a bound resource is replaced (the array): the frame group is rebuilt.
    generation: u64,
    /// The work the last frame did.
    work: CaptureWork,
    /// What the renderer's capture draws keep between frames.
    store: CaptureStore,
}

/// What the renderer's capture draws keep between frames (its pipeline and the per-face rows),
/// held with the probes so they live and die with them.
#[derive(Default)]
pub struct CaptureStore {
    pipeline: Option<(Vec<u64>, Compiled<wgpu::RenderPipeline>)>,
    uniforms: Option<Buffer>,
    visible: Option<Buffer>,
}

impl CaptureStore {
    /// The capture pipeline made for `key` (its constants, as bits), if it was.
    pub fn pipeline(&self, key: &[u64]) -> Option<Compiled<wgpu::RenderPipeline>> {
        self.pipeline.as_ref().filter(|(held, _)| held == key).map(|(_, pipeline)| pipeline.clone())
    }

    /// Keep `pipeline`, made for `key`.
    pub fn set_pipeline(&mut self, key: Vec<u64>, pipeline: Compiled<wgpu::RenderPipeline>) {
        self.pipeline = Some((key, pipeline));
    }

    /// The per-face frame rows and visible lists, at least `uniform_bytes` and `visible_bytes`
    /// (grown by doubling; never shrunk while probes are held).
    pub fn buffers(&mut self, device: &Device, uniform_bytes: u64, visible_bytes: u64) -> Result<(Buffer, Buffer), RenderError> {
        let grow = |held: &mut Option<Buffer>, bytes: u64, label: &str, usage: BufferUsages| -> Result<Buffer, RenderError> {
            if held.as_ref().is_none_or(|buffer| buffer.size() < bytes) {
                let size = bytes.max(held.as_ref().map_or(0, |buffer| buffer.size() * 2)).next_multiple_of(SLOT_BYTES);
                *held = Some(crate::tables::buffer(device, label, size, usage | BufferUsages::COPY_DST)?);
            }
            Ok(held.clone().expect("made above"))
        };
        let uniforms = grow(&mut self.uniforms, uniform_bytes, "probe capture frames", BufferUsages::UNIFORM)?;
        let visible = grow(&mut self.visible, visible_bytes, "probe capture visible", BufferUsages::STORAGE)?;
        Ok((uniforms, visible))
    }

    /// The bytes it holds.
    pub fn bytes(&self) -> u64 {
        self.uniforms.as_ref().map_or(0, Buffer::size) + self.visible.as_ref().map_or(0, Buffer::size)
    }
}

/// The pipelines and layouts of the capture's passes.
struct ProbePipelines {
    sky_fill_layout: BindGroupLayout,
    copy_layout: BindGroupLayout,
    downsample_layout: BindGroupLayout,
    prefilter_layout: BindGroupLayout,
    sky_fill: Compiled<ComputePipeline>,
    copy: Compiled<ComputePipeline>,
    downsample: Compiled<ComputePipeline>,
    prefilter: Compiled<ComputePipeline>,
    uniforms: Buffer,
    cube_sampler: Sampler,
}

/// The probe array and the capture's targets at one side and count.
struct ProbeGpu {
    side: u32,
    cubes: u32,
    pipelines: ProbePipelines,
    /// The sky copy's ratio and the clear depth (bits) the uniform slots hold.
    slots: Option<(u32, u32)>,
    array: Texture,
    /// Every layer as a cube array: what the forward pass binds.
    array_view: TextureView,
    /// Each mip of every layer, as a storage array.
    array_mips: Vec<TextureView>,
    source: Texture,
    /// Mip 0 of each face: the capture's colour attachments.
    source_faces: Vec<TextureView>,
    /// Each mip of the six faces, as an array (the chain's reads and writes, the sky fill).
    source_mips: Vec<TextureView>,
    staging: Texture,
    depth_view: TextureView,
    shadow_attachment: TextureView,
    shadow_array: TextureView,
    /// The chain's box filter into each source mip from 1 (index `mip - 1`).
    downsample_groups: Vec<BindGroup>,
    /// The prefilter of face `f` into staging mip `m` (index `f * (SPECULAR_MIPS - 1) + m - 1`).
    prefilter_groups: Vec<BindGroup>,
    /// The sky fill of each face over the sky cube it was made for (its bake generation).
    sky_fill_groups: Option<(u64, Vec<BindGroup>)>,
}

/// One face the renderer draws for a capture step (`CaptureStep::Face`): where, from where, and the
/// sun's shadow map of the probe's box.
#[derive(Clone, Debug)]
pub struct FaceCapture {
    /// The probe slot (its layer is `slot + 1`).
    pub slot: usize,
    /// The probe.
    pub probe: ReflectionProbe,
    /// The face (0..6).
    pub face: u32,
    /// The face's view-projection ([`face_view_proj`]).
    pub view_proj: Mat4,
    /// The colour attachment: the face of the capture's source cube, `rgba16float`, the cube's side.
    pub color: TextureView,
    /// The depth attachment (`depth32float`, the cube's side), cleared to `depth_clear`.
    pub depth: TextureView,
    /// The depth the face is cleared to (the scene's far value: 0 under reverse-Z, else 1).
    pub depth_clear: f32,
    /// The sun's shadow map of the probe's box: the attachment its casters are drawn into...
    pub shadow: TextureView,
    /// ... and the same map as the one-layer array the shading reads.
    pub shadow_array: TextureView,
    /// The sun's view-projection the shadow map is drawn with and the shading reads, and its texel
    /// in world units ([`probe_light_view_proj`]).
    pub light: (Mat4, f32),
    /// Whether the shadow map already holds the box's casters for this light (an irradiance
    /// volume's cell faces after its batch's first, renderer pass 2 A.4): the face only reads it.
    pub shadow_drawn: bool,
    /// Whether the captured surfaces take the environment's (or the flat) ambient light. A probe's
    /// do; an irradiance cell's do not (A.4): its bake is the scene's first bounce, and the sky's
    /// SH9, which no wall stops, would light a closed room's walls in the capture and leak the sky
    /// into the room through them.
    pub ambient: bool,
}

/// What [`ProbeMaps::prepare`] reads of a frame.
#[derive(Clone, Copy, Debug)]
pub struct ProbePrep<'a> {
    /// The probes the scene declares (held here, [`held_probes`]).
    pub declared: &'a [ReflectionProbe],
    /// The binned order of the held probes (each a held index; `cluster::LightBinFrame::probes`).
    pub order: &'a [u32],
    /// The quality's environment knobs.
    pub quality: &'a EnvironmentQuality,
    /// The sky's bound cube (its six layers, every roughness mip) and the bake generation it is
    /// of, or None while nothing is baked.
    pub sky: Option<(&'a Texture, u64)>,
    /// The frame index.
    pub frame_index: u64,
    /// A settled capture's frame.
    pub settle: bool,
    /// The sun (unit, towards it) the captures' shadow maps are drawn for.
    pub sun_dir: [f32; 3],
    /// Whether the scene's depth is reversed (the captures clear to 0, else 1).
    pub depth_reversed: bool,
    /// The irradiance volumes' rows in declaration order (renderer pass 2 A.4,
    /// `irradiance::IrradianceMaps::rows`): binned after the reflection probes, they share the
    /// probes' table (a binned index past the held probes is a volume's).
    pub volume_rows: &'a [GpuProbeRow],
}

impl ProbeMaps {
    /// The probes' state on `device`: no probes, a black neutral array, an empty row table.
    pub fn new(device: &Device, queue: &Queue) -> ProbeMaps {
        let rows = device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("env probe rows"),
            size: MAX_PROBES as u64 * PROBE_ROW_BYTES,
            usage: BufferUsages::STORAGE | BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let neutral = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("env probes neutral"),
            size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: FACES },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: CAPTURE_COLOR_FORMAT,
            usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
            view_formats: &[],
        });
        // Zero-initialized by WebGPU: black. Written once so every backend agrees.
        queue.write_texture(
            wgpu::TexelCopyTextureInfo { texture: &neutral, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            &[0u8; 6 * 8],
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(8), rows_per_image: Some(1) },
            neutral.size(),
        );
        let neutral = neutral.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::CubeArray), ..Default::default() });
        ProbeMaps {
            schedule: ProbeSchedule::default(),
            probes: Vec::new(),
            rows,
            written_rows: Vec::new(),
            neutral,
            gpu: None,
            sky_copied: None,
            generation: 0,
            work: CaptureWork::new(),
            store: CaptureStore::default(),
        }
    }

    /// What the renderer's capture draws keep between frames.
    pub fn store(&mut self) -> &mut CaptureStore {
        &mut self.store
    }

    /// Which resources the probes bind: a new value means rebuild the frame group.
    pub fn generation(&self) -> u64 {
        self.generation
    }

    /// The forward pass's binding 11: the probe array once probes are held, else `sky` (the sky's
    /// own cube as a one-cube array, None: the neutral black array).
    pub fn cube_array<'a>(&'a self, sky: Option<&'a TextureView>) -> &'a TextureView {
        match (&self.gpu, sky) {
            (Some(gpu), _) => &gpu.array_view,
            (None, Some(sky)) => sky,
            (None, None) => &self.neutral,
        }
    }

    /// The forward pass's binding 22: the probe rows in binned order.
    pub fn rows(&self) -> &Buffer {
        &self.rows
    }

    /// The rows last written to [`ProbeMaps::rows`] (binned order; irradiance volumes' rows among
    /// them carry a negative layer): what a pass outside the forward stage reads the probes from
    /// (the water's reflection, `water::reflect::probes_for`).
    pub fn frame_rows(&self) -> &[GpuProbeRow] {
        &self.written_rows
    }

    /// The probe array, once probes are held (the sky in layer 0, probe slot `s` in layer `s + 1`).
    pub fn array(&self) -> Option<&Texture> {
        self.gpu.as_ref().map(|gpu| &gpu.array)
    }

    /// The schedule (which probe holds which layer).
    pub fn schedule(&self) -> &ProbeSchedule {
        &self.schedule
    }

    /// The capture work the last [`ProbeMaps::prepare`] scheduled.
    pub fn last_work(&self) -> &CaptureWork {
        &self.work
    }

    /// The bytes the probes hold on the GPU now (the ledger's `reflection-probes`).
    pub fn bytes(&self) -> u64 {
        self.gpu.as_ref().map_or(0, |gpu| probe_bytes(gpu.side, gpu.cubes)) + self.store.bytes()
    }

    /// Release every probe resource but the row table and the neutral array (no probes, or IBL off).
    pub fn release(&mut self) {
        if self.gpu.take().is_some() {
            self.generation += 1;
        }
        self.store = CaptureStore::default();
        self.schedule = ProbeSchedule::default();
        self.sky_copied = None;
        self.probes.clear();
    }

    /// Graph node 11's probe part, before the captures are drawn: hold `prep`'s probes, make the
    /// array and the capture's targets at the sky's side (or release them: no probes, nothing
    /// baked), copy the sky into layer 0 when its bake changed, advance the schedule and write the
    /// rows. Returns the capture work due this frame, in order (the renderer draws each
    /// [`CaptureStep::Face`] through [`ProbeMaps::face`] and encodes the rest with
    /// [`ProbeMaps::encode_step`]), and the compute passes this opened.
    pub fn prepare(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, prep: &ProbePrep<'_>) -> Result<(CaptureWork, u32), RenderError> {
        self.work.clear();
        self.probes = held_probes(prep.declared);
        let cap = usize::from(prep.quality.reflection_probes).min(MAX_PROBE_CUBES);
        let Some((sky, sky_generation)) = prep.sky.filter(|_| cap > 0 && !self.probes.is_empty() && prep.quality.ibl) else {
            self.release();
            self.write_rows(queue, prep.order, prep.volume_rows);
            return Ok((CaptureWork::new(), 0));
        };
        let side = probe_side(sky.width(), prep.quality);
        // The array keeps room for the quality's cap: a probe added later takes a free layer, not a
        // new array.
        let room = cap as u32;
        if self.gpu.as_ref().is_none_or(|gpu| gpu.side != side || gpu.cubes != room) {
            self.gpu = Some(ProbeGpu::new(device, side, room)?);
            self.generation += 1;
            self.sky_copied = None;
        }
        if let Some(gpu) = self.gpu.as_mut() {
            let slots = ((sky.width() / side).max(1), if prep.depth_reversed { 0.0_f32 } else { 1.0 }.to_bits());
            if gpu.slots != Some(slots) {
                gpu.pipelines.write_slots(queue, side, slots.0, f32::from_bits(slots.1));
                gpu.slots = Some(slots);
            }
        }
        let mut passes = 0;
        if self.sky_copied != Some(sky_generation) {
            self.copy_sky(device, encoder, sky);
            self.sky_copied = Some(sky_generation);
            passes += 1;
        }
        let frame = ProbeFrame {
            probes: &self.probes,
            side,
            cap: room as usize,
            lit_by: sky_generation,
            frame_index: prep.frame_index,
            cadence: prep.quality.rebake_cadence,
            settle: prep.settle,
        };
        self.work = self.schedule.advance(&frame);
        self.write_rows(queue, prep.order, prep.volume_rows);
        Ok((self.work.clone(), passes))
    }

    /// The face capture of `step` for slot `slot` (None for a step that is not a face, or a slot
    /// without a probe).
    pub fn face(&self, slot: usize, step: CaptureStep, prep: &ProbePrep<'_>) -> Option<FaceCapture> {
        let (CaptureStep::Face(face), Some(gpu), Some(probe)) = (step, &self.gpu, self.schedule.probe(slot)) else { return None };
        Some(FaceCapture {
            slot,
            probe: *probe,
            face,
            view_proj: face_view_proj(probe, face, prep.depth_reversed),
            color: gpu.source_faces[face as usize].clone(),
            depth: gpu.depth_view.clone(),
            depth_clear: if prep.depth_reversed { 0.0 } else { 1.0 },
            shadow: gpu.shadow_attachment.clone(),
            shadow_array: gpu.shadow_array.clone(),
            light: probe_light_view_proj(probe, prep.sun_dir),
            shadow_drawn: false,
            ambient: true,
        })
    }

    /// Encode capture step `step` of slot `slot` that is not a face's draw: after a face, its sky
    /// fill (`sky` the sky's bound cube view and its bake generation); the chain, a face's
    /// prefilter or the publish. The compute passes it opened.
    pub fn encode_step(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, slot: usize, step: CaptureStep, sky: (&TextureView, u64)) -> u32 {
        let Some(gpu) = self.gpu.as_mut() else { return 0 };
        match step {
            CaptureStep::Face(face) => {
                gpu.encode_sky_fill(device, encoder, face, sky);
                1
            }
            CaptureStep::Chain => {
                gpu.encode_chain(encoder);
                1
            }
            CaptureStep::Prefilter(face) => {
                gpu.encode_prefilter(encoder, face);
                1
            }
            CaptureStep::Publish => {
                gpu.publish(encoder, slot as u32 + 1);
                0
            }
        }
    }

    /// The sky's bound cube into layer 0 (its side over the probes' a whole number of times, the
    /// copy slot's ratio).
    fn copy_sky(&self, device: &Device, encoder: &mut wgpu::CommandEncoder, sky: &Texture) {
        let Some(gpu) = self.gpu.as_ref() else { return };
        let pipelines = &gpu.pipelines;
        let groups: Vec<BindGroup> = (0..SPECULAR_MIPS)
            .map(|mip| {
                let source = crate::ibl::array_view(sky, mip.min(sky.mip_level_count() - 1), FACES);
                group(device, "probe sky copy", &pipelines.copy_layout, &[
                    (0, pipelines.slot(SLOT_COPY)),
                    (4, BindingResource::TextureView(&gpu.array_mips[mip as usize])),
                    (5, BindingResource::TextureView(&source)),
                ])
            })
            .collect();
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("probe sky copy"), timestamp_writes: None });
        pass.set_pipeline(&pipelines.copy);
        for (mip, group) in groups.iter().enumerate() {
            let side = (gpu.side >> mip).max(1);
            pass.set_bind_group(0, group, &[]);
            pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), FACES);
        }
    }

    /// Write the rows of the held probes and the irradiance volumes (`volumes`, declaration order,
    /// binned after the probes) in binned order `order` when they changed.
    fn write_rows(&mut self, queue: &Queue, order: &[u32], volumes: &[GpuProbeRow]) {
        let order = &order[..order.len().min(MAX_PROBES)];
        let held = self.probes.len();
        let mut rows: Vec<GpuProbeRow> = self.schedule.rows(&self.probes, order);
        for (row, index) in rows.iter_mut().zip(order) {
            if let Some(volume) = (*index as usize).checked_sub(held) {
                *row = volumes.get(volume).copied().unwrap_or_default();
            }
        }
        if rows == self.written_rows {
            return;
        }
        if !rows.is_empty() {
            queue.write_buffer(&self.rows, 0, bytemuck::cast_slice(&rows));
        }
        self.written_rows = rows;
    }
}

fn group(device: &Device, label: &str, layout: &BindGroupLayout, entries: &[(u32, BindingResource<'_>)]) -> BindGroup {
    let entries: Vec<wgpu::BindGroupEntry<'_>> = entries.iter().map(|(binding, resource)| wgpu::BindGroupEntry { binding: *binding, resource: resource.clone() }).collect();
    device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries: &entries })
}

impl ProbePipelines {
    fn new(device: &Device) -> Result<ProbePipelines, RenderError> {
        use crate::ibl::{compute, layout, sampler_entry, storage_faces_entry, texture_entry};
        use crate::tables::compute_uniform;
        use TextureViewDimension::{Cube, D2Array};
        let depth = BindGroupLayoutEntry {
            binding: 1,
            visibility: wgpu::ShaderStages::COMPUTE,
            ty: wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: TextureViewDimension::D2, multisampled: false },
            count: None,
        };
        let sky_fill_layout = layout(device, "probe sky fill", &[compute_uniform(0), depth, texture_entry(2, true, Cube), sampler_entry(3), storage_faces_entry(4)]);
        let copy_layout = layout(device, "probe copy", &[compute_uniform(0), storage_faces_entry(4), texture_entry(5, false, D2Array)]);
        let downsample_layout = layout(device, "probe downsample", &[compute_uniform(0), storage_faces_entry(3), texture_entry(4, false, D2Array)]);
        let prefilter_layout = layout(device, "probe prefilter", &[compute_uniform(0), texture_entry(1, true, Cube), sampler_entry(2), storage_faces_entry(3)]);
        Ok(ProbePipelines {
            sky_fill: compute(device, "probe sky fill", PROBE_PASSES, SKY_FILL_ENTRY, &sky_fill_layout)?,
            copy: compute(device, "probe copy", PROBE_PASSES, COPY_ENTRY, &copy_layout)?,
            downsample: compute(device, "probe downsample", crate::shaders::IBL_EQUIRECT, "cs_downsample", &downsample_layout)?,
            prefilter: compute(device, "probe prefilter", crate::shaders::IBL_PREFILTER, "cs_prefilter", &prefilter_layout)?,
            uniforms: crate::tables::buffer(device, "probe passes", SLOTS * SLOT_BYTES, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            cube_sampler: crate::ibl::sampler(device, "probe cube", wgpu::AddressMode::ClampToEdge),
            sky_fill_layout,
            copy_layout,
            downsample_layout,
            prefilter_layout,
        })
    }

    fn slot(&self, slot: u64) -> BindingResource<'_> {
        BindingResource::Buffer(wgpu::BufferBinding { buffer: &self.uniforms, offset: slot * SLOT_BYTES, size: wgpu::BufferSize::new(size_of::<GpuIblBake>() as u64) })
    }

    /// Write every slot for cubes of `side` whose sky is `ratio` times their side, its depth
    /// cleared to `depth_clear`: each slot's values depend only on the pass, face and mip, so two
    /// captures in one frame share them.
    fn write_slots(&self, queue: &Queue, side: u32, ratio: u32, depth_clear: f32) {
        let mut bytes = vec![0u8; (SLOTS * SLOT_BYTES) as usize];
        let mut put = |slot: u64, bake: GpuIblBake| {
            let at = (slot * SLOT_BYTES) as usize;
            bytes[at..at + size_of::<GpuIblBake>()].copy_from_slice(bytemuck::bytes_of(&bake));
        };
        for face in 0..FACES {
            put(SLOT_SKY_FILL + u64::from(face), GpuIblBake { source: [depth_clear, 0.0, 0.0, 0.0], dest: [face, 0, 0, 0], ..GpuIblBake::default() });
        }
        put(SLOT_DOWNSAMPLE, GpuIblBake::default());
        put(SLOT_COPY, GpuIblBake { dest: [0, ratio, 0, 0], ..GpuIblBake::default() });
        let samples = crate::ibl::prefilter_samples(side);
        let radiance = (side / 2).max(1);
        let radiance_mips = crate::ibl::full_mips(radiance);
        for face in 0..FACES {
            for mip in 1..SPECULAR_MIPS {
                let prefilter = [crate::ibl::mip_roughness(mip), radiance as f32, radiance_mips as f32, 0.0];
                let bake = GpuIblBake { source: [1.0, 0.0, 1.0, 0.0], dest: [face, mip, SPECULAR_MIPS, samples], prefilter, schedule: [0, (side >> mip).max(1), 0, 0] };
                put(prefilter_slot(face, mip), bake);
            }
        }
        queue.write_buffer(&self.uniforms, 0, &bytes);
    }
}

/// The uniform slot of the prefilter of `face` into roughness mip `mip` (1..).
fn prefilter_slot(face: u32, mip: u32) -> u64 {
    SLOT_PREFILTER + u64::from(face) * u64::from(SPECULAR_MIPS) + u64::from(mip)
}

fn cube_layers(device: &Device, label: &str, side: u32, layers: u32, mips: u32, format: TextureFormat, usage: TextureUsages) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: side, height: side, depth_or_array_layers: layers },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

impl ProbeGpu {
    /// The array of `cubes` probes and the sky at `side`, and the capture's targets.
    fn new(device: &Device, side: u32, cubes: u32) -> Result<ProbeGpu, RenderError> {
        let pipelines = ProbePipelines::new(device)?;
        let layers = FACES * (cubes + 1);
        let array = cube_layers(device, "env probes", side, layers, SPECULAR_MIPS, CAPTURE_COLOR_FORMAT, ARRAY_USAGE);
        let array_view = array.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::CubeArray), array_layer_count: Some(layers), ..Default::default() });
        let array_mips = (0..SPECULAR_MIPS).map(|mip| crate::ibl::array_view(&array, mip, layers)).collect();
        let source_mip_count = crate::ibl::full_mips(side);
        let source = cube_layers(device, "probe capture source", side, FACES, source_mip_count, CAPTURE_COLOR_FORMAT, SOURCE_USAGE);
        let source_faces = (0..FACES)
            .map(|face| {
                source.create_view(&wgpu::TextureViewDescriptor {
                    dimension: Some(TextureViewDimension::D2),
                    base_mip_level: 0,
                    mip_level_count: Some(1),
                    base_array_layer: face,
                    array_layer_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        let source_mips: Vec<TextureView> = (0..source_mip_count).map(|mip| crate::ibl::array_view(&source, mip, FACES)).collect();
        // The prefilter's radiance: the source's chain from mip 1 (half the side, SI-01's radiance
        // cube), sampled as a cube.
        let radiance = source.create_view(&wgpu::TextureViewDescriptor {
            dimension: Some(TextureViewDimension::Cube),
            base_mip_level: 1.min(source_mip_count - 1),
            array_layer_count: Some(FACES),
            ..Default::default()
        });
        let staging = cube_layers(device, "probe capture staging", side, FACES, SPECULAR_MIPS, CAPTURE_COLOR_FORMAT, STAGING_USAGE);
        let staging_mips: Vec<TextureView> = (0..SPECULAR_MIPS).map(|mip| crate::ibl::array_view(&staging, mip, FACES)).collect();
        let depth = cube_layers(device, "probe capture depth", side, 1, 1, CAPTURE_DEPTH_FORMAT, TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING);
        let depth_view = depth.create_view(&wgpu::TextureViewDescriptor::default());
        let shadow =
            cube_layers(device, "probe capture shadow", CAPTURE_SHADOW_PX, 1, 1, crate::shadow::SHADOW_FORMAT, TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING);
        let shadow_attachment = shadow.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::D2), ..Default::default() });
        let shadow_array = shadow.create_view(&wgpu::TextureViewDescriptor { dimension: Some(TextureViewDimension::D2Array), ..Default::default() });
        let downsample_groups = (1..source_mips.len())
            .map(|mip| {
                group(device, "probe downsample", &pipelines.downsample_layout, &[
                    (0, pipelines.slot(SLOT_DOWNSAMPLE)),
                    (3, BindingResource::TextureView(&source_mips[mip])),
                    (4, BindingResource::TextureView(&source_mips[mip - 1])),
                ])
            })
            .collect();
        let prefilter_groups = (0..FACES)
            .flat_map(|face| (1..SPECULAR_MIPS).map(move |mip| (face, mip)))
            .map(|(face, mip)| {
                group(device, "probe prefilter", &pipelines.prefilter_layout, &[
                    (0, pipelines.slot(prefilter_slot(face, mip))),
                    (1, BindingResource::TextureView(&radiance)),
                    (2, BindingResource::Sampler(&pipelines.cube_sampler)),
                    (3, BindingResource::TextureView(&staging_mips[mip as usize])),
                ])
            })
            .collect();
        Ok(ProbeGpu {
            side,
            cubes,
            pipelines,
            slots: None,
            array,
            array_view,
            array_mips,
            source,
            source_faces,
            source_mips,
            staging,
            depth_view,
            shadow_attachment,
            shadow_array,
            downsample_groups,
            prefilter_groups,
            sky_fill_groups: None,
        })
    }

    /// After face `face` is drawn: the texels no geometry covered (depth still the clear value of
    /// the slots) take `sky`'s radiance.
    fn encode_sky_fill(&mut self, device: &Device, encoder: &mut wgpu::CommandEncoder, face: u32, (sky, generation): (&TextureView, u64)) {
        if self.sky_fill_groups.as_ref().is_none_or(|(held, _)| *held != generation) {
            let pipelines = &self.pipelines;
            let groups = (0..FACES)
                .map(|face| {
                    group(device, "probe sky fill", &pipelines.sky_fill_layout, &[
                        (0, pipelines.slot(SLOT_SKY_FILL + u64::from(face))),
                        (1, BindingResource::TextureView(&self.depth_view)),
                        (2, BindingResource::TextureView(sky)),
                        (3, BindingResource::Sampler(&pipelines.cube_sampler)),
                        (4, BindingResource::TextureView(&self.source_mips[0])),
                    ])
                })
                .collect();
            self.sky_fill_groups = Some((generation, groups));
        }
        let Some((_, groups)) = &self.sky_fill_groups else { return };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("probe sky fill"), timestamp_writes: None });
        pass.set_pipeline(&self.pipelines.sky_fill);
        pass.set_bind_group(0, &groups[face as usize], &[]);
        pass.dispatch_workgroups(self.side.div_ceil(WORKGROUP_SIDE), self.side.div_ceil(WORKGROUP_SIDE), 1);
    }

    /// The source's box mip chain (every face) and its mip 0 into the staging cube's.
    fn encode_chain(&self, encoder: &mut wgpu::CommandEncoder) {
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("probe chain"), timestamp_writes: None });
            pass.set_pipeline(&self.pipelines.downsample);
            for (index, group) in self.downsample_groups.iter().enumerate() {
                let side = (self.side >> (index + 1)).max(1);
                pass.set_bind_group(0, group, &[]);
                pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), FACES);
            }
        }
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo { texture: &self.source, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::TexelCopyTextureInfo { texture: &self.staging, mip_level: 0, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
            wgpu::Extent3d { width: self.side, height: self.side, depth_or_array_layers: FACES },
        );
    }

    /// The GGX prefilter of `face` into the staging cube's roughness mips.
    fn encode_prefilter(&self, encoder: &mut wgpu::CommandEncoder, face: u32) {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("probe prefilter"), timestamp_writes: None });
        pass.set_pipeline(&self.pipelines.prefilter);
        for mip in 1..SPECULAR_MIPS {
            let side = (self.side >> mip).max(1);
            let index = (face * (SPECULAR_MIPS - 1) + mip - 1) as usize;
            pass.set_bind_group(0, &self.prefilter_groups[index], &[]);
            pass.dispatch_workgroups(side.div_ceil(WORKGROUP_SIDE), side.div_ceil(WORKGROUP_SIDE), 1);
        }
    }

    /// The staging cube into layer `layer` (1..) of the array, every face and mip.
    fn publish(&self, encoder: &mut wgpu::CommandEncoder, layer: u32) {
        for mip in 0..SPECULAR_MIPS {
            let side = (self.side >> mip).max(1);
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo { texture: &self.staging, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
                wgpu::TexelCopyTextureInfo { texture: &self.array, mip_level: mip, origin: wgpu::Origin3d { x: 0, y: 0, z: layer * FACES }, aspect: wgpu::TextureAspect::All },
                wgpu::Extent3d { width: side, height: side, depth_or_array_layers: FACES },
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room() -> ReflectionProbe {
        ReflectionProbe::new([-6.0, 0.0, 7.8], [6.0, 3.6, 15.8]).with_blend(0.5)
    }

    #[test]
    fn the_face_matrices_draw_each_texel_where_the_cube_reads_it() {
        let probe = ReflectionProbe::new([-4.0, -4.0, -4.0], [4.0, 4.0, 4.0]).with_capture([0.5, 1.0, -0.25]);
        for face in 0..FACES {
            for (u, v) in [(0.5, 0.5), (0.1, 0.2), (0.9, 0.75), (0.3, 0.95)] {
                let d = Vec3::from(crate::ibl::cube_direction(face, u, v));
                let point = Vec3::from(probe.capture) + d * 2.0;
                for reversed in [false, true] {
                    let clip = face_view_proj(&probe, face, reversed) * point.extend(1.0);
                    let ndc = clip.truncate() / clip.w;
                    let (x, y) = ((ndc.x + 1.0) * 0.5, (1.0 - ndc.y) * 0.5);
                    assert!((x - u).abs() < 1e-4 && (y - v).abs() < 1e-4, "face {face} ({u}, {v}) drew at ({x}, {y})");
                    assert!((0.0..=1.0).contains(&ndc.z), "face {face}: depth {} out of range", ndc.z);
                }
            }
            let (forward, right, up) = face_basis(face);
            assert!((right.cross(up) - forward).length() < 1e-6, "face {face}: a left-handed (mirror) basis");
        }
    }

    #[test]
    fn hostile_probes_are_held_or_dropped() {
        let nan = f32::NAN;
        let dropped = [
            ReflectionProbe::new([nan, 0.0, 0.0], [1.0; 3]),
            ReflectionProbe::new([0.0; 3], [f32::INFINITY, 1.0, 1.0]),
            ReflectionProbe::new([0.0; 3], [1.0, 1.0, 0.0]),
            ReflectionProbe::new([0.0; 3], [PROBE_EXTENT_MAX * 2.0, 1.0, 1.0]),
        ];
        for probe in dropped {
            assert_eq!(probe.held(), None, "{probe:?}");
        }
        let flipped = ReflectionProbe { min: [2.0, 2.0, 2.0], max: [0.0, 0.0, 0.0], capture: [9.0, -9.0, nan], blend: 99.0, intensity: f32::INFINITY };
        let held = flipped.held().expect("held");
        assert_eq!((held.min, held.max), ([0.0; 3], [2.0; 3]), "corners sorted");
        assert_eq!(held.capture, [1.0, 1.0, 1.0], "a capture point that is not finite takes the centre");
        assert_eq!((held.blend, held.intensity), (1.0, 1.0), "fade held to half the side, multiplier default");
        let outside = ReflectionProbe::new([0.0; 3], [2.0; 3]).with_capture([9.0, -9.0, 1.0]).with_intensity(-3.0).held().expect("held");
        assert_eq!((outside.capture, outside.intensity), ([2.0, 0.0, 1.0], 0.0), "capture held inside, multiplier non-negative");
        let many: Vec<ReflectionProbe> = (0..MAX_PROBES + 5).map(|i| ReflectionProbe::new([i as f32, 0.0, 0.0], [i as f32 + 1.0, 1.0, 1.0])).collect();
        assert_eq!(held_probes(&many).len(), MAX_PROBES);
    }

    #[test]
    fn the_box_projection_sees_a_wall_where_it_stands() {
        let row = GpuProbeRow::of(&room(), 1);
        // From the floor near the west wall, looking west and a little up: the ray leaves the
        // influence (the box grown by the 0.5 fade) at x = -6.5, seen from the capture point (the
        // centre, x = 0).
        let p = [-5.0, 0.0, 11.8];
        let dir = Vec3::new(-1.0, 0.2, 0.0).normalize();
        let corrected = Vec3::from(parallax_direction(&row, p, dir.to_array()));
        let hit = Vec3::from(p) + dir * (1.5 / dir.x.abs());
        assert!((hit.x + 6.5).abs() < 1e-5);
        let want = (hit - Vec3::from(room().capture)).normalize();
        assert!((corrected.normalize() - want).length() < 1e-5, "{corrected:?} vs {want:?}");
        // Seen from the capture point the same wall point lies far more to the side than `dir`.
        assert!(corrected.normalize().dot(dir) < 0.95, "{corrected:?}");
        // Past the box, the point is taken to the box's nearest point (continuous at its faces).
        let outside = parallax_direction(&row, [20.0, 1.0, 11.0], dir.to_array());
        let face = parallax_direction(&row, [6.5, 1.0, 11.0], dir.to_array());
        assert_eq!(outside, face);
        let up = parallax_direction(&row, [0.0, 1.0, 11.8], [0.0, 1.0, 0.0]);
        assert!((Vec3::from(up).normalize() - Vec3::Y).length() < 1e-6, "straight up from under the capture point: {up:?}");
    }

    #[test]
    fn probe_weights_are_continuous_across_every_boundary() {
        // Two rooms side by side sharing the wall at x = 0, each fading over 1 unit, and a third
        // overlapping both: walking across, no weight (the sky's included) jumps.
        let rows = [
            GpuProbeRow::of(&ReflectionProbe::new([-4.0, 0.0, -2.0], [0.0, 3.0, 2.0]).with_blend(1.0), 1),
            GpuProbeRow::of(&ReflectionProbe::new([0.0, 0.0, -2.0], [4.0, 3.0, 2.0]).with_blend(1.0), 2),
            GpuProbeRow::of(&ReflectionProbe::new([-1.0, 0.0, -1.0], [1.0, 3.0, 1.0]).with_blend(0.5), 3),
        ];
        let step = 0.001;
        let mut previous: Option<(Vec<f32>, f32)> = None;
        let mut x = -5.0;
        while x <= 5.0 {
            let (weights, sky) = blend(&rows, [x, 1.5, 0.3]);
            let sum: f32 = weights.iter().sum::<f32>() + sky;
            assert!((sum - 1.0).abs() < 1e-5, "x {x}: the weights and the sky's make 1 ({sum})");
            if let Some((was, was_sky)) = &previous {
                let jump = weights.iter().zip(was).map(|(a, b)| (a - b).abs()).fold((sky - was_sky).abs(), f32::max);
                assert!(jump < 0.03, "x {x}: a weight jumps by {jump}");
            }
            previous = Some((weights, sky));
            x += step;
        }
        // An uncaptured row weighs nothing.
        let (weights, sky) = blend(&[GpuProbeRow::of(&room(), 0)], [0.0, 1.0, 11.8]);
        assert_eq!((weights, sky), (vec![0.0], 1.0));
    }

    #[test]
    fn the_shadow_map_covers_the_box_from_the_sun() {
        let probe = room();
        let sun = Vec3::new(0.3, 0.5, -0.8).normalize();
        let (light, texel) = probe_light_view_proj(&probe, sun.to_array());
        for corner in 0..8 {
            let pick = |bit: u32, axis: usize| if corner & (1 << bit) == 0 { probe.min[axis] } else { probe.max[axis] };
            let p = Vec3::new(pick(0, 0), pick(1, 1), pick(2, 2));
            let clip = light * p.extend(1.0);
            assert!(clip.x.abs() <= 1.0 + 1e-5 && clip.y.abs() <= 1.0 + 1e-5 && (0.0..=1.0).contains(&clip.z), "corner {p:?} at {clip:?}");
            // A caster towards the sun is in front of the receiver (smaller depth).
            let caster = light * (p + sun * 10.0).extend(1.0);
            assert!(caster.z < clip.z && caster.z >= 0.0);
        }
        assert!(texel > 0.0 && texel < 0.05, "{texel}");
    }

    fn frame<'a>(probes: &'a [ReflectionProbe], frame_index: u64, settle: bool) -> ProbeFrame<'a> {
        ProbeFrame { probes, side: 128, cap: 4, lit_by: 1, frame_index, cadence: 1, settle }
    }

    #[test]
    fn the_schedule_captures_new_probes_whole_then_refreshes_stale_ones_a_step_a_frame() {
        let probes = [room(), ReflectionProbe::new([10.0, 0.0, 0.0], [14.0, 3.0, 4.0]), ReflectionProbe::new([20.0, 0.0, 0.0], [24.0, 3.0, 4.0])];
        let mut schedule = ProbeSchedule::default();
        let work = schedule.advance(&frame(&probes, 0, false));
        let whole: Vec<CaptureStep> = (0..CAPTURE_STEPS).map(CaptureStep::at).collect();
        assert_eq!(work.len(), COLD_PROBES_PER_FRAME * CAPTURE_STEPS as usize, "two cold probes whole");
        assert_eq!(work.iter().filter(|(slot, _)| *slot == 0).map(|(_, step)| *step).collect::<Vec<_>>(), whole);
        assert_eq!((schedule.layer_of(&probes, 0), schedule.layer_of(&probes, 1), schedule.layer_of(&probes, 2)), (1, 2, 0), "the third waits, unseen");
        let work = schedule.advance(&frame(&probes, 1, false));
        assert_eq!(work.len(), CAPTURE_STEPS as usize);
        assert!(schedule.settled());
        assert!(schedule.advance(&frame(&probes, 2, false)).is_empty(), "nothing changed: no work");
        // The sky rebaked: every capture is stale, refreshed one step a frame, still bound meanwhile.
        let lit = ProbeFrame { lit_by: 2, ..frame(&probes, 3, false) };
        let mut steps = Vec::new();
        for index in 0..CAPTURE_STEPS {
            let work = schedule.advance(&ProbeFrame { frame_index: 3 + u64::from(index), ..lit });
            assert_eq!(work.len(), 1);
            assert_eq!(schedule.layer_of(&probes, 0), 1, "the old capture stays bound");
            steps.push(work[0]);
        }
        assert_eq!(steps, (0..CAPTURE_STEPS).map(|step| (0, CaptureStep::at(step))).collect::<Vec<_>>());
        // A moved probe gets a fresh capture; the others keep theirs.
        let moved = [probes[0], ReflectionProbe::new([10.0, 0.0, 0.0], [14.0, 3.0, 5.0]), probes[2]];
        let work = schedule.advance(&ProbeFrame { probes: &moved, frame_index: 40, ..lit });
        assert!(work.iter().all(|(slot, _)| *slot == 1) && work.len() == CAPTURE_STEPS as usize, "{work:?}");
        // A settled capture recaptures whatever differs, whole.
        let settle = ProbeFrame { lit_by: 3, settle: true, ..frame(&moved, 50, true) };
        let work = schedule.advance(&settle);
        assert_eq!(work.len(), 3 * CAPTURE_STEPS as usize);
        assert!(schedule.settled());
        assert!(schedule.advance(&settle).is_empty(), "and nothing after");
    }

    #[test]
    fn the_rows_follow_the_binned_order_and_the_cap() {
        let probes: Vec<ReflectionProbe> = (0..6).map(|i| ReflectionProbe::new([i as f32 * 5.0, 0.0, 0.0], [i as f32 * 5.0 + 4.0, 3.0, 4.0])).collect();
        let mut schedule = ProbeSchedule::default();
        let capped = ProbeFrame { cap: 2, ..frame(&probes, 0, true) };
        schedule.advance(&capped);
        let rows = schedule.rows(&probes, &[3, 1, 0]);
        assert_eq!(rows.iter().map(|row| row.max_layer[3]).collect::<Vec<_>>(), [0.0, 2.0, 1.0], "past the cap: no layer");
        assert_eq!(rows[1].min_blend[0], 5.0);
        assert!(GpuProbeRow::of(&probes[0], 1).active());
    }

    #[test]
    fn a_slice_is_a_fraction_of_a_capture_and_the_memory_follows_the_count() {
        for side in [64, 128, 256] {
            let whole: u64 = (0..CAPTURE_STEPS).map(|index| CaptureStep::at(index).work(side)).sum();
            assert!(capture_slice_budget(side) * 4 < whole, "{side}");
        }
        assert_eq!(probe_bytes(128, 0), 0);
        assert!(probe_bytes(128, 4) > 5 * cube_bytes(128));
        assert_eq!(cube_bytes(128), (128 * 128 + 64 * 64 + 32 * 32 + 16 * 16 + 8 * 8 + 4 * 4) * 6 * 8);
    }
}
