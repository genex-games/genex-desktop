//! Ambient occlusion (plan §2.2 node 10; RQ4): GTAO, the one AO algorithm on every preset that has
//! AO (plan G3). RQ4.0 landed the contract (targets, the GPU row, how a look and a quality make it);
//! RQ4.4 records it: [`AoNode`] builds the AO resolution's view-depth chain from the prepass depth,
//! runs the horizon search (shaders/post/gtao.wgsl, a port of Intel's XeGTAO, MIT) into the raw
//! term, then the depth-aware bilateral denoise and, on temporal qualities, the blend with AO's own
//! reprojected history (shaders/post/ao_denoise.wgsl) into the term the lighting reads. AO
//! multiplies indirect light only (shaders/lighting/ambient.wgsl), and on qualities with
//! [`AoQuality::bent_normals`] the term carries a bent normal that drives the cone-cone specular
//! occlusion of Jimenez et al. 2016.
//!
//! - **The term** ([`term_format`]): [`AO_FORMAT`] (`r8unorm`, visibility, 1 unoccluded), or
//!   [`BENT_FORMAT`] (`rgba8unorm`: r visibility, gba the world-space bent normal as `n * 0.5 +
//!   0.5`) when the quality integrates a bent normal. Visibility is in r either way, so a reader
//!   that wants only visibility samples `.r`; `gx_ao_decode` (ambient.wgsl) reads both, and an
//!   `r8unorm` or neutral texel decodes as "no bent normal".
//! - **The raw term** holds the per-pixel estimate divided by [`RAW_SCALE`] (XeGTAO's packing). The
//!   estimate is the ratio of the slices' visible arcs to the arcs they would have unoccluded, so
//!   open flat ground reads 1 from every slice angle (one slice of XeGTAO's plain mean ranges from
//!   near 0 to about 1.6 there: medium's single slice drew a mottle, gate finding 03). Without a
//!   bent normal it is [`RAW_WEIGHTED_FORMAT`]: beside the visibility, the arcs the slices measured,
//!   by which the denoise averages, so a slice that grazes the surface (and measures almost none of
//!   the hemisphere) no longer counts in full (pass-1 fix gate, visual RED 01).
//! - **The view-depth chain** ([`VIEW_DEPTH_FORMAT`], [`DEPTH_MIPS`] mips at the AO resolution;
//!   after XeGTAO's prefilter): positive view distance, so samples far from the pixel read coarse
//!   mips and every pass reconstructs positions without a matrix per tap. Every texel holds one
//!   real pixel's distance (mip 0 the AO texel's representative render pixel, the one under its
//!   centre whose normal it reads; each coarser mip one texel of the mip above), and every pass
//!   places it at that pixel ([`GpuAoView::at_render`]). Samples sit on whole texels, off the
//!   slice, so the search slides each back onto the slice along the tangent plane of the surface
//!   the depth holds (from the depth's screen derivatives; the shading normal where they cross an
//!   edge), not the smoothed shading normal's.
//! - **Its own history** (plan G8), never TAA's: the term ping-pongs between [`AO_LABEL`] and
//!   [`HISTORY_LABEL`] (both [`history_format`], 16-bit float: an 8-bit history at weight 0.9
//!   cannot move by less than half a level a frame and froze its noise into blotches; pass 2,
//!   P3/S2) and the view-depth chain between [`DEPTH_LABEL`] and [`DEPTH_HISTORY_LABEL`], so last
//!   frame's term keeps the depth it was made at. History is found through the prepass's motion
//!   target where the frame has one ([`AoInput::motion`]: TAA frames), else through the camera, and
//!   read bilinearly in uv with each of the four texels' depth checked: a texel off screen or whose
//!   held view depth disagrees with the reprojected one by more than [`HISTORY_DEPTH_REJECT`] drops
//!   out. What is left is clamped to one standard deviation of this frame's window estimates
//!   around the term (a 5x5 window with history), so a floor a moving object left keeps none of its
//!   old occlusion. Noise is keyed to the frame index only when that history exists (plan
//!   principle 6), otherwise a static per-pixel pattern is used, so a frame without history is
//!   byte-identical to the next. A history reset (a settled capture, a camera cut, a resize)
//!   starts it over. Every frame of a temporal quality takes every step of half its slices
//!   ([`FLAG_INTERLEAVE`]: high's and ultra's one, its angle turned by the frame-keyed noise), so a
//!   frame pays for about half the horizon search; slices add up (their arcs enter a sum), so the
//!   history converges to what more slices a frame would draw, where every other step of each
//!   slice drew it lighter (a slice's horizon is the maximum over its steps; pass 2, P4). A reset
//!   frame takes the same slices, so it draws what the history converges to.
//! - All targets are fragment-written: core has no `r8unorm` storage.
//!
//! - **Targets from the pool** ([`AoNode::acquire`], RQ4 review): every target above, and at half
//!   resolution the term brought to the render size by the joint-bilateral upsample
//!   ([`AO_FULL_LABEL`], [`crate::post::upsample`], guided by the view-depth chain and the prepass
//!   normals), is allocated by the renderer's target pool, so the ledger holds what AO holds and a
//!   frame without AO gives it all back. New targets at a new size (a dynamic-resolution step)
//!   keep the previous size's last term and chain for one frame, which the step frame reads as its
//!   history in uv (pass 2, RC-05: the step no longer restarts the history and its noise); targets
//!   remade without one (another shape) start the history over at the running frame's interleaved
//!   cost ([`AoFrameFacts::step_change`]).
//!
//! The renderer records node 10 between the prepass (RQ4.1) and the world pass and binds the
//! render-size term at the forward frame group's `ao_map` slot (`layout::FRAME_EFFECT_BOUND`,
//! RQ4.6); a frame without AO binds a white texel there, so its picture is the one without AO.
//! [`ao_term_images`] runs the node on a depth and normal buffer the caller supplies, so the
//! algorithm is checked on the GPU without the prepass.

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use glam::Mat4;
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, Device, PipelineLayout, Queue, RenderPipeline, ShaderModule, Texture, TextureFormat, TextureUsages, TextureView};

use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::readback::{capture_failed, map_read_blocking};
use crate::settings::{AoQuality, AoResolution, Look};
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// Whether the graph schedules AO (node 10) and the `ao` switch changes the picture: the renderer
/// records [`AoNode`] after the prepass and binds its term in the forward frame group (RQ4.6).
pub const LANDED: bool = true;
/// The AO term's format without a bent normal (r: visibility, 1 unoccluded).
pub const AO_FORMAT: TextureFormat = TextureFormat::R8Unorm;
/// The AO term's format with a bent normal (r: visibility; gba: the world-space bent normal as
/// `n * 0.5 + 0.5`).
pub const BENT_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// The raw (pre-denoise) term's format without a bent normal: r the estimate's visibility over
/// [`RAW_SCALE`], g its weight (the arcs its slices would have unoccluded, over the most they can),
/// which the denoise averages by (one slice per pixel measures little of the hemisphere where it
/// grazes the surface; pass-1 fix gate, visual RED 01).
pub const RAW_WEIGHTED_FORMAT: TextureFormat = TextureFormat::Rg8Unorm;
/// The term's format with screen-space GI ([`AoMethod::BitmaskGi`]; pass 2 B.4): r visibility, gba
/// the light the hidden sectors send, in the scene's units (16-bit float: light is HDR). Its raw
/// term and history share it. Visibility stays in r, so every reader that samples `.r` reads it.
pub const GI_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The GI's default strength (`AoParams::gi.y`).
pub const GI_STRENGTH: f32 = 1.0;
/// AO's own history's format without a bent normal (visibility; pass 2, P3/S2).
pub const HISTORY_FORMAT: TextureFormat = TextureFormat::R16Float;
/// AO's own history's format with a bent normal (r visibility, gba the bent normal as stored).
pub const HISTORY_BENT_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The view-depth chain's format: positive distance in front of the camera, fragment-written
/// (renderable and unfilterable in core; read with `textureLoad`).
pub const VIEW_DEPTH_FORMAT: TextureFormat = TextureFormat::R32Float;
/// The view-depth chain's mips (XeGTAO's prefilter makes five).
pub const DEPTH_MIPS: u32 = 5;
/// The view depth the chain holds where the sky is (no geometry to occlude).
pub const SKY_DEPTH: f32 = 1e20;
/// Every AO target's usages.
pub const AO_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// What a temporal history's terms and chains add: Live's history is copied aside while a settled
/// capture draws on the node, and back after it.
pub const HISTORY_COPY_USAGE: TextureUsages = TextureUsages::COPY_SRC.union(TextureUsages::COPY_DST);
/// The AO term's pool label.
pub const AO_LABEL: &str = "ao";
/// The raw (pre-denoise) term's pool label.
pub const AO_RAW_LABEL: &str = "ao raw";
/// The history's pool label (the term's ping-pong partner).
pub const HISTORY_LABEL: &str = "ao history";
/// The view-depth chain's pool label.
pub const DEPTH_LABEL: &str = "ao depth";
/// Last frame's view-depth chain's pool label (the history's).
pub const DEPTH_HISTORY_LABEL: &str = "ao depth history";
/// The term brought to the render size by the joint-bilateral upsample (half-resolution AO only):
/// what the world pass reads ([`crate::post::upsample`]).
pub const AO_FULL_LABEL: &str = "ao full";
/// Every pool label AO may hold (released when AO does not run).
pub const LABELS: [&str; 6] = [AO_RAW_LABEL, AO_LABEL, DEPTH_LABEL, HISTORY_LABEL, DEPTH_HISTORY_LABEL, AO_FULL_LABEL];
/// The most GTAO slices any preset asks for (ultra).
pub const SLICES_MAX: u8 = 3;
/// The most steps per slice a quality may ask for (the presets ask for 4 or 6).
pub const STEPS_MAX: u8 = 8;
/// Where the falloff starts, as a fraction of the radius (XeGTAO's default).
pub const FALLOFF_FRACTION: f32 = 0.615;
/// XeGTAO's thin-occluder compensation (`AoParams::params.w`, read by gtao.wgsl's falloff): how
/// much a sample's depth offset from the centre counts beyond its true length, so thin geometry
/// falls off sooner than a wall. XeGTAO's default, 0: plain distance (the heightfield assumption).
pub const THICKNESS: f32 = 0.0;
/// The visibility bitmask's object thickness as a share of the AO radius (`AoParams::params.w`
/// under [`AoMethod::Bitmask`] is this times the radius, world units): how deep behind its front
/// face a depth sample hides the hemisphere. Bevy 0.20 holds 0.25 m and Filament 0.5 m whatever the
/// radius; at the default radius (0.5 m) this is 0.125 m. Rows that chose it: a 6 cm post's halo on
/// the ground behind it within 0.03 of the ray-cast ground truth (0.25 m left 0.06), the log wall's
/// grooves within 0.03 (tests/ao.rs), and the template block's base darkening without a rim in
/// settled captures (renderer pass 2 wave 2: at 0.1 m the floor's thin slabs left gaps up the wall,
/// so the occlusion bunched at the base: 16-36% of the columns fell by a cliff, now 8-12%). It
/// scales with the radius, so a game that scales its world and its AO radius keeps the same look.
pub const BITMASK_THICKNESS_PER_RADIUS: f32 = 0.25;
/// The horizon search's pipeline-overridable switch to the visibility bitmask (gtao.wgsl).
const BITMASK_CONSTANT: &str = "GX_AO_BITMASK";
/// The history's blend weight once it holds a frame.
pub const HISTORY_WEIGHT: f32 = 0.9;
/// The relative view-depth difference beyond which reprojected history is rejected.
pub const HISTORY_DEPTH_REJECT: f32 = 0.05;
/// The raw term holds visibility divided by this (XeGTAO's `XE_GTAO_OCCLUSION_TERM_SCALE`): headroom
/// over 1 for the small-radius fade XeGTAO adds.
pub const RAW_SCALE: f32 = 1.5;

/// `AoParams::counts.w` flag: AO keeps its own history.
pub const FLAG_TEMPORAL: u32 = 1;
/// `AoParams::counts.w` flag: GTAO integrates a bent normal.
pub const FLAG_BENT_NORMALS: u32 = 1 << 1;
/// `AoParams::counts.w` flag: depth is reversed.
pub const FLAG_REVERSE_Z: u32 = 1 << 2;
/// `AoParams::counts.w` flag: the normals target holds view-space normals (world-space otherwise).
pub const FLAG_VIEW_NORMALS: u32 = 1 << 3;
/// `AoParams::counts.w` flag: the frame takes every step of half the slices (rounded down, at
/// least one), their angles turned from frame to frame by the frame-keyed noise: every frame of a
/// temporal quality, its resets too, so a reset frame draws what the history converges to (XeGTAO's
/// final power is convex: an estimate of more slices drew darker) at a running frame's cost. A
/// quality without history takes every slice.
pub const FLAG_INTERLEAVE: u32 = 1 << 4;
/// `AoParams::counts.w` flag: the denoise finds history through the prepass's motion target
/// (bound at its motion binding) instead of the camera alone.
pub const FLAG_MOTION: u32 = 1 << 5;
/// `AoParams::counts.w` flag: the term carries screen-space GI in gba ([`GI_FORMAT`]).
pub const FLAG_GI: u32 = 1 << 6;
/// The horizon search's pipeline-overridable switch to screen-space GI (gtao.wgsl).
const GI_CONSTANT: &str = "GX_AO_GI";

/// AO's uniform (`AoParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuAoParams {
    /// xy: the AO target's size in pixels; zw: 1 / it.
    pub size: [f32; 4],
    /// x: radius (world units); y: intensity; z: falloff (fraction of the radius); w: thickness.
    pub params: [f32; 4],
    /// x: slices; y: steps per slice; z: the frame index its noise keys to (0 without history);
    /// w: flags ([`FLAG_TEMPORAL`], [`FLAG_BENT_NORMALS`], [`FLAG_REVERSE_Z`], [`FLAG_VIEW_NORMALS`],
    /// [`FLAG_INTERLEAVE`], [`FLAG_MOTION`]).
    pub counts: [u32; 4],
    /// x: the history's blend weight (0 on a history reset); y: the depth difference that rejects
    /// history; z: the denoise window's half width in texels ([`denoise_radius`]); w: its spatial
    /// falloff in texels ([`denoise_sigma`]).
    pub history: [f32; 4],
    /// Screen-space GI ([`FLAG_GI`]): x what the light texture's texels are multiplied by (to the
    /// scene's own units; [`AoLight::scale`]), y the GI's strength ([`GI_STRENGTH`]); zw unused.
    pub gi: [f32; 4],
}

impl GpuAoParams {
    /// The row for AO at `size` under `look` and `quality`, on frame `frame_index` (noise keys to it
    /// only with a history), `history_reset` and `depth_reversed` as the frame has them.
    pub fn new(look: &Look, quality: &AoQuality, size: (u32, u32), frame_index: u64, history_reset: bool, depth_reversed: bool) -> GpuAoParams {
        let settings = AoSettings { radius: look.ao_radius, intensity: look.ao_intensity, thickness: THICKNESS, quality: *quality, method: AoMethod::Horizons };
        GpuAoParams::for_frame(&settings, size, AoFrameFacts { frame_index, history_reset, depth_reversed, ..AoFrameFacts::default() })
    }

    /// The row for `settings` at `size` on a frame with `facts`.
    pub fn for_frame(settings: &AoSettings, size: (u32, u32), facts: AoFrameFacts) -> GpuAoParams {
        let quality = &settings.quality;
        let (w, h) = (size.0.max(1) as f32, size.1.max(1) as f32);
        let blends_history = quality.temporal && !facts.history_reset && !facts.step_change;
        // Every frame of a temporal quality takes the same slices a pixel, its resets too: the
        // final power is convex, so a frame of more slices (less noise) drew darker than the
        // history converged to (pass 2, P4), and a cut no longer pays for every slice.
        let interleaved = quality.temporal;
        let gi = settings.method.gi();
        let flags = [
            (quality.temporal, FLAG_TEMPORAL),
            (quality.bent_normals() && !gi, FLAG_BENT_NORMALS),
            (gi, FLAG_GI),
            (facts.depth_reversed, FLAG_REVERSE_Z),
            (facts.view_normals, FLAG_VIEW_NORMALS),
            (interleaved, FLAG_INTERLEAVE),
            (facts.motion, FLAG_MOTION),
        ]
        .into_iter()
        .filter(|(on, _)| *on)
        .fold(0, |all, (_, flag)| all | flag);
        let noise_frame = if quality.temporal { (facts.frame_index % u64::from(u32::MAX)) as u32 } else { 0 };
        let weight = match (blends_history, facts.history_frames) {
            (false, _) => 0.0,
            (true, None) => HISTORY_WEIGHT,
            (true, Some(frames)) => HISTORY_WEIGHT.min(frames as f32 / (frames as f32 + 1.0)),
        };
        GpuAoParams {
            size: [w, h, 1.0 / w, 1.0 / h],
            params: [settings.radius, settings.intensity, FALLOFF_FRACTION, settings.thickness],
            counts: [u32::from(quality.slices.clamp(1, SLICES_MAX)), u32::from(quality.steps.clamp(1, STEPS_MAX)), noise_frame, flags],
            history: [weight, HISTORY_DEPTH_REJECT, f32::from(denoise_radius(quality)), denoise_sigma(quality)],
            gi: [1.0, GI_STRENGTH, 0.0, 0.0],
        }
    }
}

/// The cameras AO reconstructs and reprojects with (`AoView` in gtao.wgsl and ao_denoise.wgsl),
/// column-major. Not in the golden layout table yet: tests/ao.rs holds it to naga's layout.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuAoView {
    /// This frame's projection, the one the depth was drawn with: view space to clip.
    pub proj: [f32; 16],
    /// Its inverse: NDC and device depth to view space.
    pub inv_proj: [f32; 16],
    /// World to view (turns the prepass's world-space normals to view space).
    pub view: [f32; 16],
    /// This frame's view space to last frame's (identity on a history reset).
    pub prev_view_from_view: [f32; 16],
    /// Last frame's projection (this frame's on a history reset).
    pub prev_proj: [f32; 16],
    /// x, y: 1 / `proj[0][0]` and 1 / `proj[1][1]` (positions from view depth without a divide);
    /// zw: the render size, which places each AO texel's representative pixel
    /// ([`GpuAoView::at_render`]; 0 until set: full resolution's texel centres).
    pub unproject: [f32; 4],
}

/// A frame's camera as AO sees it: world to view and the projection the depth was drawn with.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AoCamera {
    /// World to view (right-handed, looking down -z).
    pub view: Mat4,
    /// View to clip (depth 0..1, standard or reversed).
    pub proj: Mat4,
}

impl GpuAoView {
    /// The row for `camera`, reprojecting to `previous` (None: a history reset, no reprojection).
    pub fn new(camera: AoCamera, previous: Option<AoCamera>) -> GpuAoView {
        let previous = previous.unwrap_or(camera);
        GpuAoView {
            proj: camera.proj.to_cols_array(),
            inv_proj: camera.proj.inverse().to_cols_array(),
            view: camera.view.to_cols_array(),
            prev_view_from_view: (previous.view * camera.view.inverse()).to_cols_array(),
            prev_proj: previous.proj.to_cols_array(),
            unproject: [1.0 / camera.proj.x_axis.x, 1.0 / camera.proj.y_axis.y, 0.0, 0.0],
        }
    }

    /// This row for a `render`-sized frame: each AO texel stands for one render pixel (the one under
    /// its centre, whose normal it reads), and the passes place it where that pixel is.
    pub fn at_render(self, render: (u32, u32)) -> GpuAoView {
        let mut unproject = self.unproject;
        unproject[2] = render.0.max(1) as f32;
        unproject[3] = render.1.max(1) as f32;
        GpuAoView { unproject, ..self }
    }
}

/// What AO needs from the frame besides its settings.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AoFrameFacts {
    /// The frame index the temporal noise keys to.
    pub frame_index: u64,
    /// Whether history starts over (a settled capture, a camera cut, a resize).
    pub history_reset: bool,
    /// Whether depth is reversed (the HDR path).
    pub depth_reversed: bool,
    /// Whether the normals target holds view-space normals (world-space otherwise).
    pub view_normals: bool,
    /// Whether the targets were made again this frame without a history to carry over (another
    /// shape): the history starts over, but the frame keeps the interleaved half of the horizon
    /// search a running frame takes, so a step down to recover frame time does not cost a full
    /// search. A dynamic-resolution step of the same shape carries the previous size's history
    /// instead and is a running frame.
    pub step_change: bool,
    /// Whether the prepass's motion target is bound ([`FLAG_MOTION`]).
    pub motion: bool,
    /// Frames the history has blended since it started over, when the node counts them: the
    /// history's weight follows the running average `n / (n + 1)` up to [`HISTORY_WEIGHT`], so a
    /// settled capture's frames weigh alike (None: [`HISTORY_WEIGHT`] from the first frame on).
    pub history_frames: Option<u32>,
}

/// How the horizon search turns depth into occlusion (the quality's vocabulary).
pub use crate::settings::AoMethod;

/// The frame's AO: the look's radius and intensity at the quality's sampling.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AoSettings {
    /// World-space radius of the horizon search.
    pub radius: f32,
    /// Strength (0 none, 1 GTAO's own).
    pub intensity: f32,
    /// Thin-occluder compensation ([`THICKNESS`] by default: none).
    pub thickness: f32,
    /// Resolution, slices, steps and history.
    pub quality: AoQuality,
    /// Horizons or the visibility bitmask ([`AoMethod::Horizons`] by default).
    pub method: AoMethod,
}

impl AoSettings {
    /// The AO a frame draws under `look` and `quality`; None when AO is off or has no strength.
    pub fn new(look: &Look, quality: &AoQuality) -> Option<AoSettings> {
        let on = quality.resolution != AoResolution::Off && quality.slices > 0 && quality.steps > 0 && look.ao_intensity > 0.0;
        on.then_some(AoSettings { radius: look.ao_radius, intensity: look.ao_intensity, thickness: THICKNESS, quality: *quality, method: AoMethod::Horizons })
    }

    /// The AO a frame of `quality` draws under `look`: [`AoSettings::new`] by the quality's method
    /// ([`Quality::ao_method`](crate::settings::Quality::ao_method)).
    pub fn of(look: &Look, quality: &crate::settings::Quality) -> Option<AoSettings> {
        AoSettings::new(look, &quality.ao).map(|settings| settings.with_method(quality.ao_method))
    }

    /// These settings drawn with `method`, at its own thickness ([`THICKNESS`] for the horizons,
    /// [`BITMASK_THICKNESS_PER_RADIUS`] of the radius for the bitmask).
    pub fn with_method(self, method: AoMethod) -> AoSettings {
        let thickness = match method {
            AoMethod::Horizons => THICKNESS,
            AoMethod::Bitmask | AoMethod::BitmaskGi => BITMASK_THICKNESS_PER_RADIUS * self.radius,
        };
        AoSettings { method, thickness, ..self }
    }
}

/// The denoise window's half width in texels under `quality`: 5x5 with history (its estimates'
/// spread bounds the history, and one slice a frame needs that many: ultra's 3x3 skewed it; pass 2,
/// P2-0.6), 3x3 at full resolution without (a texel covers a quarter of the area), 7x7 at half
/// resolution without (as a disc of 37 texels, ao_denoise.wgsl: the corners' weights are the smallest, and medium's AO stays
/// within its 0.6 ms). Each slice's estimate is measured against its own unoccluded arc (gate
/// finding 03), so open ground carries no slice-angle noise; a crease does, since how much of the
/// floor a wall's slice sees depends on the slice's angle, and medium's one slice has no frames
/// to average it (5x5 drew drip-like blotches along the template block's base: pass-1 fix gate,
/// live-app finding 1).
pub const fn denoise_radius(quality: &AoQuality) -> u8 {
    match (quality.resolution, quality.temporal) {
        (_, true) => 2,
        (AoResolution::Full, false) => 1,
        (_, false) => 3,
    }
}

/// The denoise's spatial falloff (sigma, texels) under `quality`: tight where AO keeps its own
/// history (the frames average the noise, and a crease stays as narrow as the term draws it; RQ4
/// review), wide without (three quarters of the window: medium's one slice needs the area).
pub fn denoise_sigma(quality: &AoQuality) -> f32 {
    if quality.temporal { DENOISE_SIGMA_TEMPORAL } else { DENOISE_SIGMA_PER_TEXEL * f32::from(denoise_radius(quality)) }
}

/// The denoise's spatial falloff with history, in texels.
pub const DENOISE_SIGMA_TEMPORAL: f32 = 1.0;
/// The denoise's spatial falloff without history, per texel of the window's half width.
pub const DENOISE_SIGMA_PER_TEXEL: f32 = 0.75;

/// The AO resolution's size for a `render`-sized scene (None when AO is off).
pub fn ao_size(render: (u32, u32), resolution: AoResolution) -> Option<(u32, u32)> {
    match resolution {
        AoResolution::Full => Some((render.0.max(1), render.1.max(1))),
        AoResolution::Half => Some(((render.0 / 2).max(1), (render.1 / 2).max(1))),
        _ => None,
    }
}

/// The term's format under `quality`: with a bent normal or without.
pub const fn term_format(quality: &AoQuality) -> TextureFormat {
    if quality.bent_normals() { BENT_FORMAT } else { AO_FORMAT }
}

/// AO's own history's format under `quality` (the accumulated term at the AO resolution, last
/// frame's), which the term it ping-pongs with shares: 16-bit float on a temporal quality
/// ([`HISTORY_FORMAT`], [`HISTORY_BENT_FORMAT`]; pass 2, P3/S2), the term's own without history.
pub const fn history_format(quality: &AoQuality) -> TextureFormat {
    match (quality.temporal, quality.bent_normals()) {
        (false, _) => term_format(quality),
        (true, true) => HISTORY_BENT_FORMAT,
        (true, false) => HISTORY_FORMAT,
    }
}

/// The raw term's format under `quality`: the bent term's, or visibility with its weight.
pub const fn raw_format(quality: &AoQuality) -> TextureFormat {
    if quality.bent_normals() { BENT_FORMAT } else { RAW_WEIGHTED_FORMAT }
}

/// AO's pooled targets at `render` size: the raw and the denoised term and the view-depth chain,
/// with a temporal quality the history and last frame's chain (the term and the history in
/// [`history_format`]), and at half resolution the term upsampled to the render size
/// ([`AO_FULL_LABEL`], in [`term_format`]); empty when AO is off.
pub fn targets(render: (u32, u32), quality: &AoQuality) -> Vec<TargetDesc> {
    targets_with_usage(render, quality, false, TextureUsages::empty())
}

/// [`targets`] for `settings`: with screen-space GI ([`AoMethod::BitmaskGi`]) every term is
/// [`GI_FORMAT`].
pub fn targets_for(render: (u32, u32), settings: &AoSettings) -> Vec<TargetDesc> {
    targets_with_usage(render, &settings.quality, settings.method.gi(), TextureUsages::empty())
}

/// The raw term's, the written term's (and history's) and the render-size term's formats under
/// `quality`, with screen-space GI (`gi`) or not.
const fn formats(quality: &AoQuality, gi: bool) -> (TextureFormat, TextureFormat, TextureFormat) {
    if gi { (GI_FORMAT, GI_FORMAT, GI_FORMAT) } else { (raw_format(quality), history_format(quality), term_format(quality)) }
}

/// [`targets`] with screen-space GI (`gi`) or not, the terms also carrying `extra_usage` (a
/// readback's `COPY_SRC`).
fn targets_with_usage(render: (u32, u32), quality: &AoQuality, gi: bool, extra_usage: TextureUsages) -> Vec<TargetDesc> {
    let Some(size) = ao_size(render, quality.resolution) else {
        return Vec::new();
    };
    let target = |label, format, mips, usage| TargetDesc { label, format, usage, samples: 1, size, mips, srgb_view: false };
    let (raw, written, term) = formats(quality, gi);
    let mips = depth_mips(size);
    // A temporal history's pairs are copied aside around a settled capture (`AoNode::stash_live`).
    let copies = if quality.temporal { HISTORY_COPY_USAGE } else { TextureUsages::empty() };
    let (terms, chains) = (AO_USAGE | extra_usage | copies, AO_USAGE | copies);
    let mut all = vec![target(AO_RAW_LABEL, raw, 1, AO_USAGE | extra_usage), target(AO_LABEL, written, 1, terms), target(DEPTH_LABEL, VIEW_DEPTH_FORMAT, mips, chains)];
    if quality.temporal {
        all.extend([target(HISTORY_LABEL, written, 1, terms), target(DEPTH_HISTORY_LABEL, VIEW_DEPTH_FORMAT, mips, chains)]);
    }
    if size != (render.0.max(1), render.1.max(1)) {
        all.push(TargetDesc { size: (render.0.max(1), render.1.max(1)), ..target(AO_FULL_LABEL, term, 1, terms) });
    }
    all
}

/// The bytes of AO's targets at `render` size under `quality` (the pool's ledger entries), split
/// into the frame's own and the history it keeps.
pub fn target_bytes(render: (u32, u32), quality: &AoQuality) -> (u64, u64) {
    targets(render, quality).iter().fold((0, 0), |(frame, history), desc| match desc.label {
        HISTORY_LABEL | DEPTH_HISTORY_LABEL => (frame, history + desc.bytes()),
        _ => (frame + desc.bytes(), history),
    })
}

/// The view-depth chain's mips at AO size `size`: [`DEPTH_MIPS`], fewer on a tiny target.
pub fn depth_mips(size: (u32, u32)) -> u32 {
    (32 - size.0.max(size.1).max(1).leading_zeros()).min(DEPTH_MIPS)
}

/// Bytes a texel of `format` holds among AO's formats.
fn texel_bytes(format: TextureFormat) -> u64 {
    match format {
        TextureFormat::R8Unorm => 1,
        TextureFormat::Rg8Unorm | TextureFormat::R16Float => 2,
        TextureFormat::Rgba16Float => 8,
        _ => 4,
    }
}

/// Bytes of a view-depth chain at AO size `size`.
fn chain_bytes(size: (u32, u32)) -> u64 {
    (0..depth_mips(size)).map(|mip| u64::from((size.0 >> mip).max(1)) * u64::from((size.1 >> mip).max(1)) * texel_bytes(VIEW_DEPTH_FORMAT)).sum()
}

/// The history's bytes at `render` size (0 without a temporal quality): last frame's term and the
/// view-depth chain it is reprojected against, at the AO resolution.
pub fn history_bytes(render: (u32, u32), quality: &AoQuality) -> u64 {
    match ao_size(render, quality.resolution) {
        Some((w, h)) if quality.temporal => u64::from(w) * u64::from(h) * texel_bytes(history_format(quality)) + chain_bytes((w, h)),
        _ => 0,
    }
}

// ---------------------------------------------------------------------------------------------
// The node

/// The bindings of gtao.wgsl's group 0 (the view-depth chain's passes use 2 to 5).
const GTAO_DEPTH: u32 = 0;
const GTAO_NORMALS: u32 = 1;
const GTAO_PARAMS: u32 = 2;
const GTAO_VIEW: u32 = 3;
const GTAO_DEVICE_DEPTH: u32 = 4;
const GTAO_DEPTH_SOURCE: u32 = 5;
const GTAO_LIGHT: u32 = 6;
/// The bindings of ao_denoise.wgsl's group 0.
const DENOISE_RAW: u32 = 0;
const DENOISE_HISTORY: u32 = 1;
const DENOISE_DEPTH: u32 = 2;
const DENOISE_PARAMS: u32 = 3;
const DENOISE_VIEW: u32 = 4;
const DENOISE_DEPTH_HISTORY: u32 = 5;
const DENOISE_NORMALS: u32 = 6;
const DENOISE_MOTION: u32 = 7;
/// AO cost rows record this many nodes back to back per sample (as bloom's: a lone pass after an
/// idle wait pays the GPU's wake-up).
pub const COST_NODES_PER_SAMPLE: u32 = 32;

/// What [`AoNode::encode`] reads this frame.
pub struct AoInput<'a> {
    /// The prepass depth (render size, sampleable).
    pub depth: &'a TextureView,
    /// The prepass's octahedral normals (render size).
    pub normals: &'a TextureView,
    /// The render size.
    pub render: (u32, u32),
    /// The frame's camera.
    pub camera: AoCamera,
    /// The frame's AO.
    pub settings: &'a AoSettings,
    /// Frame index, history reset, depth convention, normals' space.
    pub facts: AoFrameFacts,
    /// The prepass's motion target (render size, NDC current − previous; None: the frame has none
    /// and history is found through the camera).
    pub motion: Option<&'a TextureView>,
    /// The inputs' identity: bind groups are rebuilt when it changes.
    pub generation: u64,
    /// The light screen-space GI gathers ([`AoMethod::BitmaskGi`]; None: black, no GI).
    pub light: Option<AoLight<'a>>,
}

/// The light screen-space GI gathers: the previous frame's lit scene (the colour pyramid's top or
/// the opaque copy, `crate::screen_inputs`), reprojected through last frame's camera.
#[derive(Clone, Copy)]
pub struct AoLight<'a> {
    /// The texture (any size, filterable or not: read with `textureLoad`).
    pub view: &'a TextureView,
    /// What its texels are multiplied by to reach the scene's own units (1 / the exposure it was
    /// drawn with, when it holds pre-exposed light).
    pub scale: f32,
}

/// The term the lighting reads.
#[derive(Clone, Debug)]
pub struct AoOutput {
    /// The term at the AO resolution ([`term_format`]).
    pub view: TextureView,
    /// Whether it carries a bent normal.
    pub bent_normals: bool,
    /// Whether it carries screen-space GI in gba ([`GI_FORMAT`]).
    pub gi: bool,
}

/// The pipelines writing one term format.
/// The denoise's pipeline-overridable switch for the convex-edge normal weight
/// (`GX_AO_CONVEX_NORMALS` in ao_denoise.wgsl).
const CONVEX_NORMALS_CONSTANT: &str = "GX_AO_CONVEX_NORMALS";

/// What a term holds besides visibility: nothing, a bent normal or screen-space GI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TermShape {
    bent: bool,
    gi: bool,
}

/// The slot of [`AoNode`]'s term pipelines for `shape`, at half resolution or not, by horizons or
/// the visibility bitmask.
const fn term_pipelines_slot(shape: TermShape, half: bool, bitmask: bool) -> usize {
    let kind = if shape.gi { 2 } else { shape.bent as usize };
    kind * 4 + (bitmask as usize) * 2 + half as usize
}

/// How many term pipeline slots [`term_pipelines_slot`] spans.
const TERM_PIPELINE_SLOTS: usize = 12;

struct TermPipelines {
    gtao: Compiled<RenderPipeline>,
    denoise: Compiled<RenderPipeline>,
    temporal: Compiled<RenderPipeline>,
}

/// A target and its view.
#[derive(Clone)]
struct Target {
    texture: Texture,
    view: TextureView,
}

/// A view-depth chain: the texture, a view of every mip (read) and one per mip (written).
#[derive(Clone)]
struct Chain {
    texture: Texture,
    all: TextureView,
    mips: Vec<TextureView>,
}

/// The node's targets at one AO size and quality shape, from the target pool. Temporal qualities
/// hold two terms and two chains and alternate which pair this frame writes; half-resolution AO
/// also holds the render-size term the upsample writes.
struct Targets {
    size: (u32, u32),
    bent: bool,
    gi: bool,
    temporal: bool,
    raw: Target,
    terms: Vec<Target>,
    chains: Vec<Chain>,
    full: Option<Target>,
    id: u64,
}

impl Targets {
    /// Its textures in the order [`targets`] names them (raw, term, chain, then the history's
    /// term and chain, then the render-size term): what the pool handed out.
    fn textures(&self) -> Vec<Texture> {
        let mut all = vec![self.raw.texture.clone(), self.terms[0].texture.clone(), self.chains[0].texture.clone()];
        if let (Some(term), Some(chain)) = (self.terms.get(1), self.chains.get(1)) {
            all.extend([term.texture.clone(), chain.texture.clone()]);
        }
        all.extend(self.full.iter().map(|full| full.texture.clone()));
        all
    }
}

/// One parity's bind groups: the chain's mip 0 and downsamples, GTAO, the denoise.
#[derive(Clone)]
struct ParityGroups {
    depth: BindGroup,
    down: Vec<BindGroup>,
    gtao: BindGroup,
    denoise: BindGroup,
}

/// The layouts of the node's passes.
struct Layouts {
    gtao: BindGroupLayout,
    depth: BindGroupLayout,
    down: BindGroupLayout,
    denoise: BindGroupLayout,
}

/// What the node's bind groups are cached by: the input's generation, the targets' identity, and
/// whether a motion target and a light are bound.
type GroupsKey = (u64, u64, (bool, bool));

/// AO (graph node 10): the view-depth chain, GTAO into the raw term, then the bilateral denoise
/// (and the temporal blend) into the term. Holds its pipelines, targets, history parity and last
/// frame's camera.
pub struct AoNode {
    gtao_module: ShaderModule,
    denoise_module: ShaderModule,
    layouts: Layouts,
    gtao_pipeline_layout: PipelineLayout,
    denoise_pipeline_layout: PipelineLayout,
    depth_pipeline: Compiled<RenderPipeline>,
    down_pipeline: Compiled<RenderPipeline>,
    /// By [`term_pipelines_slot`]: with or without a bent normal, at half or full resolution, by
    /// horizons or the bitmask.
    term_pipelines: [Option<TermPipelines>; TERM_PIPELINE_SLOTS],
    params: Buffer,
    view: Buffer,
    targets: Option<Targets>,
    next_id: u64,
    /// Whether the targets were made again since the last frame (their history is gone).
    remade: bool,
    /// Which term and chain this frame writes (temporal qualities alternate).
    parity: usize,
    previous: Option<AoCamera>,
    extra_usage: TextureUsages,
    groups: Option<(GroupsKey, Vec<ParityGroups>)>,
    upsample: crate::post::upsample::JointUpsample,
    /// Live's history put aside while a settled capture draws on the node (RQ5 review).
    live_stash: Option<LiveStash>,
    /// Frames the history has blended since it started over ([`AoFrameFacts::history_frames`]).
    history_frames: u32,
    /// The previous size's last term and view-depth chain, kept from a dynamic-resolution step's
    /// remake until the step frame has read them as its history (pass 2, RC-05).
    carried: Option<(Target, Chain)>,
    /// A texel of no motion, bound at the motion binding of frames without a motion target.
    neutral_motion: TextureView,
    /// A black texel, bound at the GI's light binding of frames without one.
    neutral_light: TextureView,
}

/// Live's AO history kept aside while a settled capture runs on the node, so the capture's
/// re-renders never become Live's history: the term and the view-depth chain the next Live frame
/// reads, the parity and the camera, copied out at the capture's start
/// ([`AoNode::stash_live`]) and back before the next Live frame ([`AoNode::restore_live`]).
struct LiveStash {
    /// The targets' shape it was taken at: AO size, bent normals, temporal, GI.
    shape: ((u32, u32), bool, bool, bool),
    term: Texture,
    chain: Texture,
    parity: usize,
    previous: Option<AoCamera>,
    /// Frames its history had blended.
    history_frames: u32,
    /// Whether the capture ended and the next Live frame restores it.
    restore: bool,
}

fn fragment_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn float_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let sample_type = wgpu::TextureSampleType::Float { filterable: false };
    fragment_entry(binding, wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false })
}

fn depth_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let sample_type = wgpu::TextureSampleType::Depth;
    fragment_entry(binding, wgpu::BindingType::Texture { sample_type, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false })
}

fn uniform_entry<T>(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let min_binding_size = wgpu::BufferSize::new(size_of::<T>() as u64);
    fragment_entry(binding, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size })
}

fn color_target(format: TextureFormat) -> Option<wgpu::ColorTargetState> {
    Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })
}

fn layout(device: &Device, label: &str, entries: &[wgpu::BindGroupLayoutEntry]) -> BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some(label), entries })
}

/// A full-screen pipeline of `module` (entry points `entries`: vertex, fragment) writing `format`.
fn screen_pipeline(device: &Device, layout: &PipelineLayout, module: &ShaderModule, entries: (&str, &str), format: TextureFormat) -> Compiled<RenderPipeline> {
    screen_pipeline_with(device, layout, module, entries, format, &[])
}

/// [`screen_pipeline`] with the fragment stage's pipeline-overridable `constants`.
fn screen_pipeline_with(device: &Device, layout: &PipelineLayout, module: &ShaderModule, entries: (&str, &str), format: TextureFormat, constants: &[(&str, f64)]) -> Compiled<RenderPipeline> {
    let (vertex, fragment) = entries;
    let fragment_options = wgpu::PipelineCompilationOptions { constants, ..Default::default() };
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(fragment),
        layout: Some(layout),
        vertex: wgpu::VertexState { module, entry_point: Some(vertex), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module, entry_point: Some(fragment), compilation_options: fragment_options, targets: &[color_target(format)] }),
        multiview_mask: None,
        cache: None,
    })
}

fn texture(binding: u32, view: &TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

fn make_texture(device: &Device, label: &str, size: (u32, u32), format: TextureFormat, mips: u32, usage: TextureUsages) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage,
        view_formats: &[],
    })
}

fn make_target(device: &Device, label: &str, size: (u32, u32), format: TextureFormat, usage: TextureUsages) -> Target {
    let texture = make_texture(device, label, size, format, 1, usage);
    let view = texture.create_view(&Default::default());
    Target { texture, view }
}

/// A pooled target as the node holds it.
fn pooled_target(pooled: &crate::target_pool::PooledTarget) -> Target {
    Target { texture: pooled.texture().clone(), view: pooled.view().clone() }
}

/// A pooled view-depth chain with a view of every mip.
fn pooled_chain(pooled: &crate::target_pool::PooledTarget) -> Chain {
    let texture = pooled.texture().clone();
    let mips = (0..texture.mip_level_count())
        .map(|mip| texture.create_view(&wgpu::TextureViewDescriptor { base_mip_level: mip, mip_level_count: Some(1), ..Default::default() }))
        .collect();
    Chain { all: pooled.view().clone(), mips, texture }
}

/// A texture like `source` (size, mips, format) that copies can fill.
fn stash_copy(device: &Device, label: &str, source: &Texture) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: source.size(),
        mip_level_count: source.mip_level_count(),
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: source.format(),
        usage: TextureUsages::COPY_SRC | TextureUsages::COPY_DST,
        view_formats: &[],
    })
}

/// Copy every mip of `from` into `to` (the same size, mips and format).
fn copy_all_mips(encoder: &mut wgpu::CommandEncoder, from: &Texture, to: &Texture) {
    for mip in 0..from.mip_level_count() {
        let size = from.size().mip_level_size(mip, wgpu::TextureDimension::D2);
        let source = wgpu::TexelCopyTextureInfo { texture: from, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All };
        let target = wgpu::TexelCopyTextureInfo { texture: to, ..source };
        encoder.copy_texture_to_texture(source, target, size);
    }
}

/// The bytes of a 2D texture with its mips, at AO's formats.
fn texture_bytes(texture: &Texture) -> u64 {
    (0..texture.mip_level_count())
        .map(|mip| texture.size().mip_level_size(mip, wgpu::TextureDimension::D2))
        .map(|size| u64::from(size.width) * u64::from(size.height) * texel_bytes(texture.format()))
        .sum()
}

fn screen_pass(encoder: &mut wgpu::CommandEncoder, label: &str, target: &TextureView, timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>, pipeline: &RenderPipeline, group: &BindGroup) {
    // Every pass covers every texel of its target: nothing to load.
    let attachment = wgpu::RenderPassColorAttachment {
        view: target,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store },
    };
    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some(label), color_attachments: &[Some(attachment)], timestamp_writes, ..Default::default() });
    pass.set_pipeline(pipeline);
    pass.set_bind_group(0, group, &[]);
    pass.draw(0..3, 0..1);
}

impl AoNode {
    /// The node, its shaders compiled and its layouts made; targets come with the first frame.
    pub fn new(device: &Device) -> Result<AoNode, RenderError> {
        AoNode::with_usage(device, TextureUsages::empty())
    }

    /// A node whose terms also carry `extra_usage` (a readback's `COPY_SRC`).
    fn with_usage(device: &Device, extra_usage: TextureUsages) -> Result<AoNode, RenderError> {
        let gtao_module = crate::shaders::module(device, "gtao", crate::shaders::GTAO)?;
        let denoise_module = crate::shaders::module(device, "ao denoise", crate::shaders::AO_DENOISE)?;
        let params = uniform_entry::<GpuAoParams>(GTAO_PARAMS);
        let view = uniform_entry::<GpuAoView>(GTAO_VIEW);
        let layouts = Layouts {
            gtao: layout(device, "gtao", &[float_entry(GTAO_DEPTH), float_entry(GTAO_NORMALS), params, view, float_entry(GTAO_LIGHT)]),
            depth: layout(device, "ao depth", &[params, view, depth_entry(GTAO_DEVICE_DEPTH)]),
            down: layout(device, "ao depth down", &[params, float_entry(GTAO_DEPTH_SOURCE)]),
            denoise: layout(
                device,
                "ao denoise",
                &[
                    float_entry(DENOISE_RAW),
                    float_entry(DENOISE_HISTORY),
                    float_entry(DENOISE_DEPTH),
                    uniform_entry::<GpuAoParams>(DENOISE_PARAMS),
                    uniform_entry::<GpuAoView>(DENOISE_VIEW),
                    float_entry(DENOISE_DEPTH_HISTORY),
                    float_entry(DENOISE_NORMALS),
                    float_entry(DENOISE_MOTION),
                ],
            ),
        };
        let depth_layout = pipeline_layout(device, "ao depth", &[&layouts.depth]);
        let down_layout = pipeline_layout(device, "ao depth down", &[&layouts.down]);
        let uniform = BufferUsages::UNIFORM | BufferUsages::COPY_DST;
        Ok(AoNode {
            depth_pipeline: screen_pipeline(device, &depth_layout, &gtao_module, ("vs_ao", "fs_ao_depth"), VIEW_DEPTH_FORMAT),
            down_pipeline: screen_pipeline(device, &down_layout, &gtao_module, ("vs_ao", "fs_ao_depth_down"), VIEW_DEPTH_FORMAT),
            gtao_pipeline_layout: pipeline_layout(device, "gtao", &[&layouts.gtao]),
            denoise_pipeline_layout: pipeline_layout(device, "ao denoise", &[&layouts.denoise]),
            params: buffer(device, "ao params", size_of::<GpuAoParams>() as u64, uniform)?,
            view: buffer(device, "ao view", size_of::<GpuAoView>() as u64, uniform)?,
            gtao_module,
            denoise_module,
            layouts,
            term_pipelines: Default::default(),
            targets: None,
            next_id: 1,
            remade: false,
            parity: 0,
            previous: None,
            extra_usage,
            groups: None,
            upsample: crate::post::upsample::JointUpsample::new(device)?,
            live_stash: None,
            history_frames: 0,
            carried: None,
            neutral_motion: make_target(device, "ao no motion", (1, 1), crate::motion::MOTION_FORMAT, AO_USAGE).view,
            neutral_light: make_target(device, "ao no light", (1, 1), GI_FORMAT, AO_USAGE).view,
        })
    }

    /// Put Live's history aside before a settled capture draws on the node: the last written term
    /// and chain copied out (into textures kept for the next capture), with the parity and the
    /// camera. Nothing to keep without a temporal history.
    pub fn stash_live(&mut self, device: &Device, queue: &Queue) {
        let Some(targets) = self.targets.as_ref().filter(|targets| targets.temporal && self.previous.is_some()) else {
            self.live_stash = None;
            return;
        };
        let shape = (targets.size, targets.bent, targets.temporal, targets.gi);
        let last = 1 - self.parity;
        let (term, chain) = (&targets.terms[last].texture, &targets.chains[last].texture);
        let fits = self.live_stash.as_ref().is_some_and(|stash| stash.shape == shape);
        let (stash_term, stash_chain) = match self.live_stash.take() {
            Some(stash) if fits => (stash.term, stash.chain),
            _ => (stash_copy(device, "ao live term (capture)", term), stash_copy(device, "ao live chain (capture)", chain)),
        };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ao live stash") });
        copy_all_mips(&mut encoder, term, &stash_term);
        copy_all_mips(&mut encoder, chain, &stash_chain);
        queue.submit([encoder.finish()]);
        self.live_stash = Some(LiveStash { shape, term: stash_term, chain: stash_chain, parity: self.parity, previous: self.previous, history_frames: self.history_frames, restore: false });
    }

    /// The capture is over: the next Live frame takes the stashed history back.
    pub fn restore_live(&mut self) {
        if let Some(stash) = self.live_stash.as_mut() {
            stash.restore = true;
        }
    }

    /// Bytes AO holds outside the pool: the Live stash (a term and a view-depth chain at AO size),
    /// and for the frame after a dynamic-resolution step the previous size's term and chain it
    /// carries.
    pub fn stash_bytes(&self) -> u64 {
        let stash = self.live_stash.as_ref().map_or(0, |stash| texture_bytes(&stash.term) + texture_bytes(&stash.chain));
        let carried = self.carried.as_ref().map_or(0, |(term, chain)| texture_bytes(&term.texture) + texture_bytes(&chain.texture));
        stash + carried
    }

    /// Before a Live frame after a capture: copy the stash back into the slot the frame reads as
    /// its history (the targets of the stash's shape, remade or not) and resume Live's parity and
    /// camera. A shape that changed meanwhile starts Live over, as a step change would.
    fn take_back_live(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let Some(stash) = self.live_stash.as_mut().filter(|stash| stash.restore) else { return };
        stash.restore = false;
        let Some(targets) = self.targets.as_ref() else { return };
        if (targets.size, targets.bent, targets.temporal, targets.gi) != stash.shape {
            return;
        }
        let last = 1 - stash.parity;
        copy_all_mips(encoder, &stash.term, &targets.terms[last].texture);
        copy_all_mips(encoder, &stash.chain, &targets.chains[last].texture);
        self.parity = stash.parity;
        self.previous = stash.previous;
        self.history_frames = stash.history_frames;
        self.remade = false;
    }

    /// Make the pipelines writing a term with (`bent`) or without a bent normal, by horizons or the
    /// visibility bitmask (`bitmask`), on first use.
    fn ensure_term_pipelines(&mut self, device: &Device, shape: TermShape, half: bool, bitmask: bool) {
        let (format, history, raw) = match (shape.gi, shape.bent) {
            (true, _) => (GI_FORMAT, GI_FORMAT, GI_FORMAT),
            (false, true) => (BENT_FORMAT, HISTORY_BENT_FORMAT, BENT_FORMAT),
            (false, false) => (AO_FORMAT, HISTORY_FORMAT, RAW_WEIGHTED_FORMAT),
        };
        let (gtao_layout, denoise_layout) = (&self.gtao_pipeline_layout, &self.denoise_pipeline_layout);
        let (gtao_module, denoise_module) = (&self.gtao_module, &self.denoise_module);
        // Only a half-resolution window weighs normals past a convex edge (ao_denoise.wgsl): the
        // full-resolution pipelines compile that path out (ultra's 5x5 window with history reaches
        // two pixels past an edge; the normals' reads cost 0.23 ms at 1080p, over its budget).
        let convex = [(CONVEX_NORMALS_CONSTANT, if half { 1.0 } else { 0.0 })];
        // The horizons' pipeline keeps the shader's default (no constant), so it compiles as before.
        let method: &[(&str, f64)] = match (bitmask, shape.gi) {
            (_, true) => &[(BITMASK_CONSTANT, 1.0), (GI_CONSTANT, 1.0)],
            (true, false) => &[(BITMASK_CONSTANT, 1.0)],
            (false, false) => &[],
        };
        self.term_pipelines[term_pipelines_slot(shape, half, bitmask)].get_or_insert_with(|| TermPipelines {
            gtao: screen_pipeline_with(device, gtao_layout, gtao_module, ("vs_ao", "fs_gtao"), raw, method),
            denoise: screen_pipeline_with(device, denoise_layout, denoise_module, ("vs_ao_denoise", "fs_ao_denoise"), format, &convex),
            temporal: screen_pipeline_with(device, denoise_layout, denoise_module, ("vs_ao_denoise", "fs_ao_temporal"), history, &convex),
        });
    }

    /// Take AO's targets for a `render`-sized frame under `quality` from `pool` (allocated there,
    /// so the ledger holds them, and kept while their descriptors hold); a label the shape does not
    /// use is released. New textures (a step change, another quality) start the history over.
    pub fn acquire(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32), quality: &AoQuality) -> Result<(), RenderError> {
        self.acquire_shaped(device, pool, render, quality, false)
    }

    /// [`AoNode::acquire`] for `settings`: screen-space GI ([`AoMethod::BitmaskGi`]) takes
    /// [`GI_FORMAT`] terms.
    pub fn acquire_for(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32), settings: &AoSettings) -> Result<(), RenderError> {
        self.acquire_shaped(device, pool, render, &settings.quality, settings.method.gi())
    }

    fn acquire_shaped(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32), quality: &AoQuality, gi: bool) -> Result<(), RenderError> {
        let descs = targets_with_usage(render, quality, gi, self.extra_usage);
        let Some(size) = ao_size(render, quality.resolution) else {
            self.release(pool);
            return Ok(());
        };
        for label in LABELS {
            if !descs.iter().any(|desc| desc.label == label) {
                pool.release(label);
            }
        }
        let mut pooled = Vec::with_capacity(descs.len());
        for desc in descs {
            pooled.push(pool.acquire(device, desc)?.clone());
        }
        // The pool kept every texture (the usual frame): nothing to remake, no view to make.
        let textures: Vec<Texture> = pooled.iter().map(|target| target.texture().clone()).collect();
        if self.targets.as_ref().is_some_and(|held| held.textures() == textures) {
            return Ok(());
        }
        let get = |label: &str| pooled.iter().find(|target| target.desc().label == label);
        let (bent, temporal) = (quality.bent_normals() && !gi, quality.temporal);
        // A new size of the same temporal shape (a dynamic-resolution step): the last term and chain
        // the old targets wrote stay for the step frame to read in uv (RC-05).
        self.carried = self.targets.as_ref().filter(|held| held.temporal && temporal && held.bent == bent && held.gi == gi && held.size != size).map(|held| {
            let last = 1 - self.parity;
            (held.terms[last].clone(), held.chains[last].clone())
        });
        let pairs: &[(&str, &str)] = if temporal { &[(AO_LABEL, DEPTH_LABEL), (HISTORY_LABEL, DEPTH_HISTORY_LABEL)] } else { &[(AO_LABEL, DEPTH_LABEL)] };
        let held = |label| get(label).expect("acquired above");
        let fresh = Targets {
            size,
            bent,
            gi,
            temporal,
            raw: pooled_target(held(AO_RAW_LABEL)),
            terms: pairs.iter().map(|(term, _)| pooled_target(held(term))).collect(),
            chains: pairs.iter().map(|(_, chain)| pooled_chain(held(chain))).collect(),
            full: get(AO_FULL_LABEL).map(pooled_target),
            id: self.next_id,
        };
        self.next_id += 1;
        self.targets = Some(fresh);
        self.groups = None;
        self.parity = 0;
        self.remade = true;
        Ok(())
    }

    /// Give AO's targets back to `pool` (AO does not run): the ledger counts them freed and they
    /// are.
    pub fn release(&mut self, pool: &mut crate::target_pool::TargetPool) {
        for label in LABELS {
            pool.release(label);
        }
        self.targets = None;
        self.groups = None;
        self.carried = None;
    }

    /// The bind groups of parity `parity` (it writes term and chain `parity` and reads the other
    /// pair as history) for `input`.
    fn parity_groups(&self, device: &Device, input: &AoInput<'_>, parity: usize) -> ParityGroups {
        let targets = self.targets.as_ref().expect("targets are made first");
        let (params, view) = (crate::tables::entry(GTAO_PARAMS, &self.params), crate::tables::entry(GTAO_VIEW, &self.view));
        let group = |label, layout, entries: &[wgpu::BindGroupEntry<'_>]| device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout, entries });
        let chain = &targets.chains[parity];
        // Without history the raw term and this frame's chain stand in for the history the
        // shader never reads.
        let other = targets.terms.len() - 1 - parity;
        let history = if targets.temporal { &targets.terms[other].view } else { &targets.raw.view };
        ParityGroups {
            depth: group("ao depth", &self.layouts.depth, &[params.clone(), view.clone(), texture(GTAO_DEVICE_DEPTH, input.depth)]),
            down: (1..chain.mips.len()).map(|mip| group("ao depth down", &self.layouts.down, &[params.clone(), texture(GTAO_DEPTH_SOURCE, &chain.mips[mip - 1])])).collect(),
            gtao: group(
                "gtao",
                &self.layouts.gtao,
                &[texture(GTAO_DEPTH, &chain.all), texture(GTAO_NORMALS, input.normals), params.clone(), view.clone(), texture(GTAO_LIGHT, input.light.map_or(&self.neutral_light, |light| light.view))],
            ),
            denoise: self.denoise_group(device, input, &chain.all, (history, &targets.chains[other].all)),
        }
    }

    /// The denoise's bind group for `input` over this frame's view-depth chain `chain`, reading
    /// `history` (a term and the view-depth chain it was made at) as last frame's.
    fn denoise_group(&self, device: &Device, input: &AoInput<'_>, chain: &TextureView, history: (&TextureView, &TextureView)) -> BindGroup {
        let raw = &self.targets.as_ref().expect("targets are made first").raw.view;
        device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ao denoise"),
            layout: &self.layouts.denoise,
            entries: &[
                texture(DENOISE_RAW, raw),
                texture(DENOISE_HISTORY, history.0),
                texture(DENOISE_DEPTH, chain),
                crate::tables::entry(DENOISE_PARAMS, &self.params),
                crate::tables::entry(DENOISE_VIEW, &self.view),
                texture(DENOISE_DEPTH_HISTORY, history.1),
                texture(DENOISE_NORMALS, input.normals),
                texture(DENOISE_MOTION, input.motion.unwrap_or(&self.neutral_motion)),
            ],
        })
    }

    /// This frame's bind groups, cached by the input's generation, the targets' identity and
    /// whether a motion target and a light are bound.
    fn bind_groups(&mut self, device: &Device, input: &AoInput<'_>) -> ParityGroups {
        let targets = self.targets.as_ref().expect("targets are made first");
        let key = (input.generation, targets.id, (input.motion.is_some(), input.light.is_some()));
        if let Some((held, groups)) = &self.groups
            && *held == key
        {
            return groups[self.parity].clone();
        }
        let groups: Vec<ParityGroups> = (0..targets.terms.len()).map(|parity| self.parity_groups(device, input, parity)).collect();
        let chosen = groups[self.parity].clone();
        self.groups = Some((key, groups));
        chosen
    }

    /// Forget AO's history: the next frame starts over (a settled capture, a camera cut).
    pub fn reset_history(&mut self) {
        self.previous = None;
    }

    /// Record AO for `input`: the view-depth chain, GTAO into the raw term, then the denoise (with
    /// the history blend on temporal qualities) into the term the lighting reads. None when AO
    /// has no size.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: AoInput<'_>) -> Option<AoOutput> {
        self.encode_timed(device, queue, encoder, input, None)
    }

    /// Write the frame's AO rows for `input` at AO size `size`, and hand back the previous size's
    /// history when this frame is a dynamic-resolution step that carries it (RC-05). New targets
    /// without one are a step change that starts the history over at the running frame's cost;
    /// anything else that drops the history is a reset.
    fn frame_rows(&mut self, queue: &Queue, input: &AoInput<'_>, size: (u32, u32)) -> Option<(Target, Chain)> {
        let remade = std::mem::take(&mut self.remade);
        let explicit = input.facts.history_reset || self.previous.is_none();
        let carried = self.carried.take().filter(|_| remade && !explicit);
        let step_change = remade && !explicit && carried.is_none();
        let reset = (remade && carried.is_none()) || explicit;
        // A settled capture's re-renders weigh alike (G0: with the history's 0.9 from the second
        // frame on, the first frame's slices held 48% of an 8-frame capture at high, and the
        // template block's base drew their noise as dark clumps that Live's frames average away).
        self.history_frames = if reset { 0 } else { self.history_frames.saturating_add(1) };
        let facts = AoFrameFacts { history_reset: reset && !step_change, step_change, motion: input.motion.is_some(), history_frames: Some(self.history_frames), ..input.facts };
        let mut row = GpuAoParams::for_frame(input.settings, size, facts);
        row.gi[0] = input.light.map_or(0.0, |light| light.scale);
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let previous = if reset { None } else { self.previous };
        queue.write_buffer(&self.view, 0, bytemuck::bytes_of(&GpuAoView::new(input.camera, previous).at_render(input.render)));
        carried
    }

    /// [`AoNode::encode`] with `timestamps` (the query set, and whether this node stamps its first
    /// pass's beginning and its last pass's end): a cost row.
    fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: AoInput<'_>,
        timestamps: Option<(&wgpu::QuerySet, bool, bool)>,
    ) -> Option<AoOutput> {
        let quality = input.settings.quality;
        let size = ao_size(input.render, quality.resolution)?;
        let gi = input.settings.method.gi();
        let shape = (size, quality.bent_normals() && !gi, quality.temporal, gi);
        if self.targets.as_ref().is_none_or(|t| (t.size, t.bent, t.temporal, t.gi) != shape) {
            // Targets come from the pool (`acquire`) before the frame; none for this shape.
            return None;
        }
        if !input.facts.history_reset {
            self.take_back_live(encoder);
        }
        let carried = self.frame_rows(queue, &input, size);
        let bent = shape.1;
        let term_shape = TermShape { bent, gi };
        let half = size != (input.render.0.max(1), input.render.1.max(1));
        let bitmask = input.settings.method.bitmask();
        self.ensure_term_pipelines(device, term_shape, half, bitmask);
        let mut groups = self.bind_groups(device, &input);
        if let Some((term, chain)) = &carried {
            // The step frame reads the previous size's last term (in uv) as its history.
            let written = &self.targets.as_ref().expect("made above").chains[self.parity].all;
            groups.denoise = self.denoise_group(device, &input, written, (&term.view, &chain.all));
        }
        let pipelines = self.term_pipelines[term_pipelines_slot(term_shape, half, bitmask)].as_ref().expect("made above");
        let targets = self.targets.as_ref().expect("made above");
        let stamp = |first_pass: bool| {
            let (query_set, first, last) = timestamps?;
            let (begin, end) = ((first && first_pass).then_some(0), (last && !first_pass).then_some(1));
            (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites { query_set, beginning_of_pass_write_index: begin, end_of_pass_write_index: end })
        };
        let chain = &targets.chains[self.parity];
        screen_pass(encoder, "ao depth", &chain.mips[0], stamp(true), &self.depth_pipeline, &groups.depth);
        for (mip, group) in groups.down.iter().enumerate() {
            screen_pass(encoder, "ao depth down", &chain.mips[mip + 1], None, &self.down_pipeline, group);
        }
        screen_pass(encoder, "gtao", &targets.raw.view, None, &pipelines.gtao, &groups.gtao);
        let term = &targets.terms[self.parity];
        let denoise = if targets.temporal { &pipelines.temporal } else { &pipelines.denoise };
        let upsampled = targets.full.is_some();
        screen_pass(encoder, "ao denoise", &term.view, if upsampled { None } else { stamp(false) }, denoise, &groups.denoise);
        let term_view = term.view.clone();
        let mut output = AoOutput { view: term_view.clone(), bent_normals: bent, gi };
        if let Some(full) = &targets.full {
            let full_view = full.view.clone();
            let key = (input.generation.wrapping_mul(1 << 20).wrapping_add(targets.id), self.parity as u64);
            let params = crate::post::upsample::GpuUpsampleParams::new(size, input.render, input.camera.proj, input.facts.depth_reversed);
            let guide = targets.chains[self.parity].mips[0].clone();
            let upsample = crate::post::upsample::UpsampleInput { low: &term_view, depth: input.depth, normals: Some(input.normals), target: &full_view, guide: Some(&guide), params, key };
            self.upsample.encode_timed(device, queue, encoder, upsample, formats(&quality, gi).2, stamp(false));
            output.view = full_view;
        }
        if self.targets.as_ref().is_some_and(|t| t.temporal) {
            self.parity = 1 - self.parity;
        }
        self.previous = Some(input.camera);
        Some(output)
    }

    /// The texture the last frame wrote its term to.
    fn last_term(&self) -> Option<&Texture> {
        let targets = self.targets.as_ref()?;
        let written = if targets.temporal { 1 - self.parity } else { self.parity };
        Some(&targets.terms[written].texture)
    }

    /// The texture the world pass read last frame: the upsampled term at half resolution, the
    /// term itself at full.
    fn last_read(&self) -> Option<&Texture> {
        match self.targets.as_ref()?.full.as_ref() {
            Some(full) => Some(&full.texture),
            None => self.last_term(),
        }
    }
}

// ---------------------------------------------------------------------------------------------
// The node on a supplied depth and normal buffer (tests, cost rows)

/// One frame of [`ao_term_images`]: the scene's device depth and world-space unit normals, row by
/// row at render size, the camera they were drawn with and the frame's facts.
#[derive(Clone, Debug, PartialEq)]
pub struct AoFrame {
    /// Device depth per pixel (0..1, the convention `facts.depth_reversed` names).
    pub depth: Vec<f32>,
    /// World-space unit normal per pixel.
    pub normals: Vec<[f32; 3]>,
    /// The camera.
    pub camera: AoCamera,
    /// Frame index and history reset (the depth convention and normal space are taken as given).
    pub facts: AoFrameFacts,
    /// NDC motion per pixel (current − previous, as the prepass's motion target holds it); empty:
    /// no motion target (AO reprojects through the camera alone).
    pub motion: Vec<[f32; 2]>,
}

/// A term read back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AoImage {
    /// Its size (the AO resolution).
    pub size: (u32, u32),
    /// Visibility per texel (255 unoccluded), row by row.
    pub visibility: Vec<u8>,
    /// The bent normal per texel as stored (`n * 0.5 + 0.5` in 0..255), when the term has one.
    pub bent: Option<Vec<[u8; 3]>>,
    /// The screen-space GI's light per texel as stored (16-bit float bits), when the term has it.
    pub light: Option<Vec<[u16; 3]>>,
}

impl AoImage {
    /// Visibility at texel (`x`, `y`) in 0..1.
    pub fn at(&self, x: u32, y: u32) -> f32 {
        f32::from(self.visibility[(y * self.size.0 + x) as usize]) / 255.0
    }

    /// The GI's light at texel (`x`, `y`) (black without GI).
    pub fn light_at(&self, x: u32, y: u32) -> [f32; 3] {
        self.light.as_ref().map_or([0.0; 3], |light| light[(y * self.size.0 + x) as usize].map(crate::post::tonemap::f16_to_f32))
    }
}

/// Writes a render-sized depth and normals target from plain textures: the prepass's outputs for a
/// scene the caller rasterized on the CPU.
const UPLOAD_WGSL: &str = "
@group(0) @binding(0) var src_depth: texture_2d<f32>;
@group(0) @binding(1) var src_normals: texture_2d<f32>;

struct UploadOut {
    @builtin(frag_depth) depth: f32,
    @location(0) normal: vec4<f32>,
}

@vertex
fn vs_upload(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_upload(@builtin(position) position: vec4<f32>) -> UploadOut {
    let pixel = vec2<i32>(position.xy);
    let n = textureLoad(src_normals, pixel, 0).xyz;
    return UploadOut(textureLoad(src_depth, pixel, 0).r, vec4<f32>(gx_oct_encode(n), 0.0, 1.0));
}
";

/// The prepass's targets holding a CPU-made frame, with its motion when the frame has one.
struct PrepassStandIn {
    depth: Target,
    normals: Target,
    motion: Option<TextureView>,
}

/// A float texture of `texels` (`T` per texel) to read in the upload pass.
fn source_texture<T: Pod>(gpu: &Gpu, label: &str, size: (u32, u32), format: TextureFormat, texels: &[T]) -> Texture {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        texture.as_image_copy(),
        bytemuck::cast_slice(texels),
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * size_of::<T>() as u32), rows_per_image: Some(size.1) },
        wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
    );
    texture
}

/// The upload pass: plain depth and normals into the prepass's formats.
struct Upload {
    layout: BindGroupLayout,
    pipeline: Compiled<RenderPipeline>,
}

impl Upload {
    fn new(device: &Device) -> Result<Upload, RenderError> {
        let source = format!("{}{UPLOAD_WGSL}", include_str!("../../shaders/effects.wgsl"));
        let module = crate::shaders::module(device, "ao upload", &source)?;
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("ao upload"), entries: &[float_entry(0), float_entry(1)] });
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("ao upload"),
            layout: Some(&pipeline_layout(device, "ao upload", &[&layout])),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_upload"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: crate::renderer::DEPTH_FORMAT,
                depth_write_enabled: Some(true),
                depth_compare: Some(wgpu::CompareFunction::Always),
                stencil: wgpu::StencilState::default(),
                bias: wgpu::DepthBiasState::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_upload"),
                compilation_options: Default::default(),
                targets: &[color_target(crate::prepass::NORMALS_FORMAT)],
            }),
            multiview_mask: None,
            cache: None,
        });
        Ok(Upload { layout, pipeline })
    }

    /// `frame` in the prepass's targets at `size`.
    fn run(&self, gpu: &Gpu, size: (u32, u32), frame: &AoFrame) -> Result<PrepassStandIn, RenderError> {
        let texels = (size.0 * size.1) as usize;
        let motion_fits = frame.motion.is_empty() || frame.motion.len() == texels;
        if frame.depth.len() != texels || frame.normals.len() != texels || !motion_fits {
            return Err(capture_failed(format!("{} depths, {} normals and {} motions for a {}x{} frame", frame.depth.len(), frame.normals.len(), frame.motion.len(), size.0, size.1)));
        }
        let device = &gpu.device;
        let normals4: Vec<[f32; 4]> = frame.normals.iter().map(|n| [n[0], n[1], n[2], 0.0]).collect();
        let depth_source = source_texture(gpu, "ao upload depth", size, TextureFormat::R32Float, &frame.depth);
        let normal_source = source_texture(gpu, "ao upload normals", size, TextureFormat::Rgba32Float, &normals4);
        let [depth_view, normal_view] = [&depth_source, &normal_source].map(|t| t.create_view(&Default::default()));
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("ao upload"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&depth_view) },
                wgpu::BindGroupEntry { binding: 1, resource: wgpu::BindingResource::TextureView(&normal_view) },
            ],
        });
        let [depth_desc, normals_desc] = crate::prepass::targets(size);
        let stand_in = PrepassStandIn {
            depth: make_target(device, depth_desc.label, size, depth_desc.format, depth_desc.usage),
            normals: make_target(device, normals_desc.label, size, normals_desc.format, normals_desc.usage),
            motion: (!frame.motion.is_empty()).then(|| source_texture(gpu, "ao upload motion", size, TextureFormat::Rg32Float, &frame.motion).create_view(&Default::default())),
        };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ao upload") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("ao upload"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &stand_in.normals.view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                    view: &stand_in.depth.view,
                    depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                    stencil_ops: None,
                }),
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
        Ok(stand_in)
    }
}

/// Read the node's last term back: at the AO resolution, or (`render_size`) the one the world
/// pass reads.
fn read_term(gpu: &Gpu, node: &AoNode, render_size: bool) -> Result<AoImage, RenderError> {
    let targets = node.targets.as_ref().ok_or_else(|| capture_failed("AO drew nothing"))?;
    let read = if render_size { node.last_read() } else { node.last_term() };
    let texture = read.ok_or_else(|| capture_failed("AO drew nothing"))?;
    let (width, height) = (texture.width(), texture.height());
    let channels = if targets.bent || targets.gi { 4 } else { 1 };
    // A 16-bit float history (the term at the AO resolution on a temporal quality) reads back as
    // the 8-bit levels an `unorm` term would hold.
    let format = texture.format();
    let half = format == HISTORY_FORMAT || format == HISTORY_BENT_FORMAT || format == GI_FORMAT;
    let bytes_per_texel = if half { channels * 2 } else { channels };
    let padded = (width * bytes_per_texel).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = buffer(&gpu.device, "ao readback", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ao readback") });
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
    let channel = |x: u32, y: u32, c: u32| {
        let at = (y * padded + x * bytes_per_texel) as usize;
        if !half {
            return data[at + c as usize];
        }
        let bits = u16::from_le_bytes([data[at + 2 * c as usize], data[at + 2 * c as usize + 1]]);
        (crate::post::tonemap::f16_to_f32(bits).clamp(0.0, 1.0) * 255.0).round() as u8
    };
    let coords: Vec<(u32, u32)> = (0..height).flat_map(|y| (0..width).map(move |x| (x, y))).collect();
    let visibility = coords.iter().map(|&(x, y)| channel(x, y, 0)).collect();
    let bent = targets.bent.then(|| coords.iter().map(|&(x, y)| std::array::from_fn(|c| channel(x, y, 1 + c as u32))).collect());
    let bits = |x: u32, y: u32, c: u32| {
        let at = (y * padded + x * bytes_per_texel + 2 * c) as usize;
        u16::from_le_bytes([data[at], data[at + 1]])
    };
    let light = targets.gi.then(|| coords.iter().map(|&(x, y)| std::array::from_fn(|c| bits(x, y, 1 + c as u32))).collect());
    Ok(AoImage { size: (width, height), visibility, bent, light })
}

/// The terms AO makes for `frames` in order (one node, so history carries from frame to frame)
/// at `render` size under `settings`: each frame's depth and normals are written to stand-ins for
/// the prepass's targets, then the node runs and its term is read back. `depth_reversed` and
/// world-space normals are taken from the first frame's facts. The way to check GTAO, the denoise
/// and the history on the GPU without the prepass.
pub fn ao_term_images(gpu: &Gpu, settings: &AoSettings, render: (u32, u32), frames: &[AoFrame]) -> Result<Vec<AoImage>, RenderError> {
    let sized: Vec<((u32, u32), &AoFrame)> = frames.iter().map(|frame| (render, frame)).collect();
    ao_images(gpu, settings, &sized, false, &[])
}

/// [`ao_render_images`] with the light screen-space GI gathers ([`AoMethod::BitmaskGi`]): each of
/// `lights` holds a previous frame's lit scene, one linear rgba texel per render pixel, row by row;
/// one for every frame, or one a frame.
pub fn ao_gi_images(gpu: &Gpu, settings: &AoSettings, render: (u32, u32), frames: &[AoFrame], lights: &[Vec<[f32; 4]>]) -> Result<Vec<AoImage>, RenderError> {
    let texels = (render.0 * render.1) as usize;
    if lights.is_empty() || (lights.len() != 1 && lights.len() != frames.len()) || lights.iter().any(|light| light.len() != texels) {
        return Err(capture_failed(format!("{} lights for {} frames of {}x{}", lights.len(), frames.len(), render.0, render.1)));
    }
    let sized: Vec<((u32, u32), &AoFrame)> = frames.iter().map(|frame| (render, frame)).collect();
    ao_images(gpu, settings, &sized, true, lights)
}

/// [`ao_term_images`] with each frame at its own render size (a dynamic-resolution step between
/// two frames remakes AO's targets at the new size, as the renderer's pool does).
pub fn ao_term_images_sized(gpu: &Gpu, settings: &AoSettings, frames: &[((u32, u32), &AoFrame)]) -> Result<Vec<AoImage>, RenderError> {
    ao_images(gpu, settings, frames, false, &[])
}

/// [`ao_term_images`] read at the render size: the term the world pass reads (half-resolution AO
/// through the joint-bilateral upsample, full-resolution AO as it is).
pub fn ao_render_images(gpu: &Gpu, settings: &AoSettings, render: (u32, u32), frames: &[AoFrame]) -> Result<Vec<AoImage>, RenderError> {
    let sized: Vec<((u32, u32), &AoFrame)> = frames.iter().map(|frame| (render, frame)).collect();
    ao_images(gpu, settings, &sized, true, &[])
}

/// The terms for `frames` (each at its render size), read at the render size or the AO
/// resolution, each frame gathering the light of `lights` (none, one for every frame or one a
/// frame; all at the first frame's render size).
fn ao_images(gpu: &Gpu, settings: &AoSettings, frames: &[((u32, u32), &AoFrame)], render_size: bool, lights: &[Vec<[f32; 4]>]) -> Result<Vec<AoImage>, RenderError> {
    for (render, _) in frames {
        crate::capture::check_capture_size(render.0, render.1)?;
    }
    let device = &gpu.device;
    let upload = Upload::new(device)?;
    let mut node = AoNode::with_usage(device, TextureUsages::COPY_SRC)?;
    let mut pool = crate::target_pool::TargetPool::new();
    let mut images = Vec::with_capacity(frames.len());
    let light_views: Vec<TextureView> = match frames.first() {
        Some((render, _)) => lights.iter().map(|texels| source_texture(gpu, "ao light", *render, TextureFormat::Rgba32Float, texels).create_view(&Default::default())).collect(),
        None => Vec::new(),
    };
    for (index, &(render, frame)) in frames.iter().enumerate() {
        node.acquire_for(device, &mut pool, render, settings)?;
        let stand_in = upload.run(gpu, render, frame)?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ao image") });
        let input = AoInput {
            depth: &stand_in.depth.view,
            normals: &stand_in.normals.view,
            render,
            camera: frame.camera,
            settings,
            facts: frame.facts,
            motion: stand_in.motion.as_ref(),
            generation: index as u64,
            light: light_views.get(index.min(light_views.len().saturating_sub(1))).map(|view| AoLight { view, scale: 1.0 }),
        };
        node.encode(device, &gpu.queue, &mut encoder, input).ok_or_else(|| capture_failed("AO is off"))?;
        gpu.queue.submit([encoder.finish()]);
        images.push(read_term(gpu, &node, render_size)?);
    }
    Ok(images)
}

/// The GPU milliseconds of AO (GTAO plus the denoise) over `frame` at `render` size under
/// `settings`, one per sample of `samples`, from timestamps around its passes; None without
/// `TIMESTAMP_QUERY`. Each sample records [`COST_NODES_PER_SAMPLE`] nodes back to back in one
/// submission and reports their mean. The AO cost row (plan §2.5: half <= 0.6 ms, full <= 1.5 ms at
/// 1080p).
pub fn ao_gpu_ms(gpu: &Gpu, settings: &AoSettings, render: (u32, u32), frame: &AoFrame, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let stand_in = Upload::new(device)?.run(gpu, render, frame)?;
    let mut node = AoNode::new(device)?;
    let mut pool = crate::target_pool::TargetPool::new();
    node.acquire_for(device, &mut pool, render, settings)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("ao cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "ao cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ao cost") });
        for run in 0..COST_NODES_PER_SAMPLE {
            let input = AoInput {
                depth: &stand_in.depth.view,
                normals: &stand_in.normals.view,
                render,
                camera: frame.camera,
                settings,
                facts: frame.facts,
                motion: stand_in.motion.as_ref(),
                generation: 0,
                light: None,
            };
            let stamps = (&query_set, run == 0, run + 1 == COST_NODES_PER_SAMPLE);
            node.encode_timed(device, &gpu.queue, &mut encoder, input, Some(stamps));
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission: Metal resolves counter samples without waiting for the
        // passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("ao cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_NODES_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;

    const HIGH: AoQuality = AoQuality { resolution: AoResolution::Half, slices: 2, steps: 6, temporal: true };

    #[test]
    fn ao_is_absent_when_off_and_keeps_its_own_history_when_temporal() {
        let off = crate::settings::Quality::off().ao;
        assert!(targets((1920, 1080), &off).is_empty() && history_bytes((1920, 1080), &off) == 0);
        let high = targets((1920, 1080), &HIGH);
        let labels: Vec<&str> = high.iter().map(|t| t.label).collect();
        // Half resolution adds the term upsampled to the render size (RQ4 review).
        assert_eq!(labels, [AO_RAW_LABEL, AO_LABEL, DEPTH_LABEL, HISTORY_LABEL, DEPTH_HISTORY_LABEL, AO_FULL_LABEL]);
        assert!(high[..5].iter().all(|t| t.size == (960, 540)) && high[5].size == (1920, 1080));
        assert_eq!(high.iter().map(|t| t.mips).collect::<Vec<_>>(), [1, 1, DEPTH_MIPS, 1, DEPTH_MIPS, 1]);
        let ultra = AoQuality { resolution: AoResolution::Full, slices: 3, steps: 8, ..HIGH };
        assert!(targets((1920, 1080), &ultra).iter().all(|t| t.label != AO_FULL_LABEL), "full resolution needs no upsample");
        let (frame, history) = target_bytes((1920, 1080), &HIGH);
        assert_eq!(frame + history, high.iter().map(TargetDesc::bytes).sum::<u64>(), "the ledger's bytes, split");
        assert_eq!(term_format(&HIGH), BENT_FORMAT, "two slices carry a bent normal");
        // Pass 2, P3/S2 (flipped from the term's 8 bits): the history and the term it ping-pongs
        // with are 16-bit float; the term the world pass reads at the render size stays 8-bit.
        assert_eq!((high[1].format, high[3].format), (history_format(&HIGH), history_format(&HIGH)));
        assert_eq!(history_format(&HIGH), HISTORY_BENT_FORMAT);
        assert_eq!(high[5].format, term_format(&HIGH));
        let chain: u64 = [(960, 540), (480, 270), (240, 135), (120, 67), (60, 33)].iter().map(|(w, h)| w * h * 4).sum();
        assert_eq!(history_bytes((1920, 1080), &HIGH), 960 * 540 * 8 + chain, "last frame's term and view-depth chain");
        let medium = AoQuality { slices: 1, steps: 4, temporal: false, ..HIGH };
        let medium_targets = targets((1920, 1080), &medium);
        assert_eq!(medium_targets.len(), 4, "no history without a temporal quality (the upsample's term only)");
        // Pass-1 fix gate, visual RED 01: the raw term carries its estimate's weight beside it.
        assert_eq!((medium_targets[0].format, medium_targets[1].format), (RAW_WEIGHTED_FORMAT, AO_FORMAT), "one slice: weighted raw, r8unorm visibility");
        assert_eq!(depth_mips((3, 2)), 2, "a tiny target has fewer mips");
    }

    #[test]
    fn noise_keys_to_the_frame_only_with_history_and_a_reset_drops_it() {
        let look = Look::default();
        let medium = AoQuality { slices: 1, steps: 4, temporal: false, ..HIGH };
        assert_eq!(GpuAoParams::new(&look, &medium, (960, 540), 17, false, true).counts, [1, 4, 0, FLAG_REVERSE_Z]);
        let high = GpuAoParams::new(&look, &HIGH, (960, 540), 17, false, false);
        assert_eq!(high.counts, [2, 6, 17, FLAG_TEMPORAL | FLAG_BENT_NORMALS | FLAG_INTERLEAVE], "a frame that blends history takes half the slices");
        assert_eq!(high.history[0], HISTORY_WEIGHT);
        let reset = GpuAoParams::new(&look, &HIGH, (960, 540), 17, true, false);
        assert_eq!(reset.history[0], 0.0, "a reset starts the history over");
        // Pass 2, P4 (flipped from every step): a reset takes the running frames' slices.
        assert_eq!(reset.counts[3], FLAG_TEMPORAL | FLAG_BENT_NORMALS | FLAG_INTERLEAVE, "and the running frames' slices");
        assert_eq!(high.params[..2], [look.ao_radius, look.ao_intensity]);
    }

    /// G0 visual (2026-10-15): the history's weight follows the running average from a reset, so a
    /// settled capture's frames weigh alike, and holds [`HISTORY_WEIGHT`] from the tenth frame on.
    #[test]
    fn the_history_weight_is_the_running_average_until_it_reaches_the_live_weight() {
        let look = Look::default();
        let settings = AoSettings::new(&look, &HIGH).expect("on");
        let weight = |frames: Option<u32>| GpuAoParams::for_frame(&settings, (960, 540), AoFrameFacts { frame_index: 17, history_frames: frames, ..AoFrameFacts::default() }).history[0];
        assert_eq!(weight(Some(0)), 0.0, "nothing behind the first frame");
        assert_eq!(weight(Some(1)), 0.5);
        assert_eq!(weight(Some(3)), 0.75);
        assert_eq!(weight(Some(9)), HISTORY_WEIGHT);
        assert_eq!(weight(Some(400)), HISTORY_WEIGHT);
        assert_eq!(weight(None), HISTORY_WEIGHT, "a caller that does not count keeps the Live weight");
    }

    /// RQ4 review (performance 5): targets remade without a history to carry (another shape; a
    /// dynamic-resolution step of the same shape carries the previous size's, pass 2 RC-05) start
    /// the history over at the running frame's interleaved half of the horizon search, so the frame
    /// right after a step down to recover time does not spike. Since pass 2 (P4) every frame of a
    /// temporal quality takes it, resets too.
    #[test]
    fn a_step_change_starts_the_history_over_at_the_running_frames_cost() {
        let look = Look::default();
        let settings = AoSettings::new(&look, &HIGH).expect("on");
        let step = AoFrameFacts { frame_index: 17, step_change: true, ..AoFrameFacts::default() };
        let row = GpuAoParams::for_frame(&settings, (960, 540), step);
        assert_eq!(row.history[0], 0.0, "no history crosses the step");
        assert_eq!(row.counts[3] & FLAG_INTERLEAVE, FLAG_INTERLEAVE, "half the slices, as a running frame");
        let settle = GpuAoParams::for_frame(&settings, (960, 540), AoFrameFacts { frame_index: 17, history_reset: true, ..AoFrameFacts::default() });
        // Pass 2, P4 (flipped): a reset (a settled capture, a cut) takes the running frames' slices.
        assert_eq!(settle.counts[3] & FLAG_INTERLEAVE, FLAG_INTERLEAVE, "a reset takes the running frames' slices");
        let medium = AoQuality { slices: 1, steps: 4, temporal: false, ..HIGH };
        let still = GpuAoParams::for_frame(&AoSettings::new(&look, &medium).expect("on"), (960, 540), step);
        assert_eq!(still.counts[3] & FLAG_INTERLEAVE, 0, "without history every frame takes every slice");
    }

    #[test]
    fn ao_is_drawn_only_when_on_with_strength() {
        let look = Look::default();
        assert_eq!(AoSettings::new(&look, &crate::settings::Quality::off().ao), None);
        assert_eq!(AoSettings::new(&look.with_ao(0.0, 1.0), &HIGH), None, "intensity 0 occludes nothing");
        let on = AoSettings::new(&look, &HIGH).expect("on");
        assert_eq!((on.radius, on.intensity), (look.ao_radius, look.ao_intensity));
    }

    #[test]
    fn a_reset_view_reprojects_onto_itself() {
        let camera = AoCamera {
            view: glam::camera::rh::view::look_at_mat4(glam::Vec3::new(0.0, 2.0, 5.0), glam::Vec3::ZERO, glam::Vec3::Y),
            proj: glam::camera::rh::proj::directx::perspective(1.0, 16.0 / 9.0, 100.0, 0.1),
        };
        let row = GpuAoView::new(camera, None);
        let identity = Mat4::from_cols_array(&row.prev_view_from_view);
        assert!(identity.abs_diff_eq(Mat4::IDENTITY, 1e-5), "{identity:?}");
        assert_eq!(row.prev_proj, row.proj);
        let moved = AoCamera { view: glam::camera::rh::view::look_at_mat4(glam::Vec3::new(1.0, 2.0, 5.0), glam::Vec3::ZERO, glam::Vec3::Y), ..camera };
        let point = glam::Vec4::new(0.3, -0.2, -4.0, 1.0);
        let reprojected = Mat4::from_cols_array(&GpuAoView::new(camera, Some(moved)).prev_view_from_view) * point;
        let expected = moved.view * camera.view.inverse() * point;
        assert!(reprojected.abs_diff_eq(expected, 1e-5));
    }
}
