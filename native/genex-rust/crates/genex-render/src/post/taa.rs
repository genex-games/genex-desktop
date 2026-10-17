//! Temporal anti-aliasing (plan §2.2 nodes 15a and 17; RQ5). RQ5.0 landed the contract: the
//! rgba16float history pair at render size ([`history_targets`]), the reactive r8unorm mask
//! ([`reactive_target`]), the GPU row ([`GpuTaaParams`], `TaaParams` in shaders/post/taa.wgsl), the
//! accumulation rule ([`accumulation_weight`]). RQ5.2 fills the resolve ([`TaaNode`]) and the
//! reactive coverage ([`ReactiveNode`], [`REACTIVE`], [`REACTIVE_PARTICLES`]).
//!
//! The resolve (shaders/post/taa.wgsl), per pixel of the jittered HDR scene at render size:
//! - **dilation:** the motion vector of the closest depth in the 3x3 neighbourhood, so an edge
//!   reprojects with the object in front of it;
//! - **history:** Catmull-Rom (five bilinear taps) at `uv - motion`, sharpened by
//!   [`HISTORY_SHARPEN`] under motion and held inside the four texels around the sample (B.7),
//!   rescaled by exposure now / exposure then ([`GpuTaaParams::params`] y), so an exposure change
//!   never resets it;
//! - **rectification** (renderer pass 2, P2-0.8a: S10 and T-02, after FidelityFX FSR 2.2, MIT): the
//!   neighbourhood's colour box is built in reversibly tonemapped space `c / (1 + max3(c))`, YCoCg:
//!   mean ± [`VARIANCE_GAMMA`] σ inside the neighbourhood's min/max ([`TaaFlags::CLIP`]), so one
//!   bright pixel no longer stretches it over everything beside a highlight. History outside the
//!   box is clipped towards it softly: the clip is undone by how much the pixel is **locked**
//!   (FSR 2.2's thin-feature confidence: a lightness ridge no 2x2 block of similar neighbours
//!   explains; or an oscillation; held for a jitter cycle in the [`LOCK_FORMAT`] side history) or
//!   **luma-unstable** (its quantised luma over the last four frames, the [`LUMA_HISTORY_FORMAT`]
//!   side history, rose and fell), scaled by `1 - sqrt(reactive)` (motion counts as reactive up to
//!   [`MOTION_REACTIVE`]). A sub-pixel feature the jitter
//!   shows in some frames only keeps its history instead of being clipped away on the frames that
//!   miss it. On a settled pixel (no motion of its own, no reactive coverage) the box also grows by
//!   the pixel's temporal noise and a floor ([`NOISE_BOX_SCALE`], renderer pass 2, B.7);
//! - **rejection:** off-screen history, depth disocclusion and the reactive mask take the current
//!   frame filtered around the unjittered pixel centre (a 3x3 Gaussian over the jittered taps,
//!   [`FILTER_FALLOFF`]), so a rejected region neither aliases nor wobbles by the jitter; motion
//!   raises the current weight by [`MOTION_REJECTION_PER_PX`] per pixel. Disocclusion: the history's
//!   depth key (last frame's farthest surface in the 3x3) lies nearer, by more than
//!   [`DISOCCLUSION_TOLERANCE`], than the closest key the neighbourhood had last frame if it stayed
//!   put (the camera's own motion, [`GpuTaaParams::reproject`], last frame's view_proj × this
//!   frame's inverse, scales it): what stood in front went away. A camera dollying or turning keeps
//!   the history of every static surface (RQ5 review: compared with the current keys, a 6 m/s
//!   dolly threw away the ground's history within about 2 m), and a sub-pixel feature the jitter
//!   shows in some frames only is never a disocclusion (P2-0.8a: the history carried the centre's
//!   key, and the range was tested both ways, so such features vanished and the far tree line
//!   flickered). A surface that came in front is left to the colour box;
//! - **accumulation:** `max(1 / (n + 1), alpha_min)` after the history's reset (n frames since;
//!   the floor is [`STILL_ALPHA_SHARE`] of `alpha_min` on a pixel moving under
//!   [`STILL_MOTION_PX`]), blended with weights `1 / (1 + max(luma - 1, 0))` in pre-exposed space,
//!   so highlights cannot flicker and display-range values average exactly (a box filter over the
//!   jitter cycle). Still transparents write no reactive coverage, under a moving camera too, and
//!   moving ones their alpha capped at [`TRANSPARENT_COVERAGE`] ([`transparent_coverage`]), so
//!   still ones accumulate too.
//!
//! The resolved colour is the history written this frame (rgb), and its alpha carries the 3x3
//! neighbourhood's farthest depth key (`d` under reverse-Z, `1 - d` under standard Z: both
//! proportional to 1 / view depth), which the next frame's disocclusion test reads. Readers
//! downstream of TAA (L3 `post-hdr`, bloom, exposure, the tonemap) read `.rgb`. The luma and lock
//! side histories ping-pong with it, made and read at the same size.
//!
//! TAA is a pipeline knob ([`crate::settings::AntiAliasing`]: MSAA is off while it runs); its
//! jitter cycle, accumulation floor and LOD bias are resource knobs
//! ([`crate::settings::TaaQuality`]). The jitter is Halton(2, 3) keyed to the frame index
//! ([`crate::jitter`]); history starts over on every [`crate::settle::HistoryReset`] (a camera cut
//! among them, [`resets_history`]), when the node's history was (re)allocated, and never on an
//! exposure change. Captures settle one whole jitter cycle on capture-owned history (RQ5.4).
//!
//! The renderer encodes nodes 15a and 17 since RQ5.6: the jitter reaches `FrameUniforms::jitter`
//! and every camera depth writer's `gx_clip_position`, the histories are the renderer's
//! ([`crate::settle::TaaHistories`], Live's and a capture's own), the scene is `rgba16float` and
//! one sample, and the later nodes (exposure, bloom, the tonemap) read the resolve; `post-hdr`
//! passes draw over a copy of it in the scene, never over the history.

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroupLayout, Buffer, BufferUsages, Device, Queue, RenderPipeline, Sampler, Texture, TextureFormat, TextureUsages, TextureView};

use crate::error::RenderError;
use crate::gpu::Gpu;
use crate::readback::{capture_failed, map_read_blocking};
use crate::settings::{FrameConfig, TaaQuality};
use crate::settle::HistoryReset;
use crate::tables::{buffer, pipeline_layout};
use crate::target_pool::TargetDesc;

/// Whether the graph schedules TAA and its reactive coverage (nodes 17 and 15a) and the `taa`
/// switch changes the picture. True once the renderer encodes [`TaaNode`] and [`ReactiveNode`].
pub const LANDED: bool = true;
/// The history's format on every class (plan §2.4: never the scene's smaller format).
pub const HISTORY_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The history's usages: written by the resolve's fragment pass, sampled by the next frame's.
pub const HISTORY_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The history pair's pool labels: one is read while the other is written, then they swap.
pub const HISTORY_LABELS: [&str; 2] = ["taa history a", "taa history b"];
/// Bytes of one history texel.
pub const HISTORY_TEXEL_BYTES: u64 = 8;
/// The luma side history (T-02): the last four frames' quantised box-centre luma, x the newest
/// (FSR 2.2's luma history, for its luma instability).
pub const LUMA_HISTORY_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// The lock side history (T-02): x the lock's remaining lifetime / 2 (0..2 jitter cycles' worth),
/// y the shading luma it was locked at (FSR 2.2's lock status), z how recently the pixel moved (1
/// at a render pixel of motion, falling to 0 over a jitter cycle: a pixel an object just passed
/// over is not protected), w its temporal noise (renderer pass 2, B.7: a running mean, at
/// [`NOISE_RATE`], of how far its raw sample strayed from the history the colour box keeps, in
/// tonemapped luma; cleared where a surface moves over the pixel, [`NOISE_RESET_OWN_MOTION_PX`]).
pub const LOCK_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// The luma side history's labels, a pair like the colour history's.
pub const LUMA_HISTORY_LABELS: [&str; 2] = ["taa luma history a", "taa luma history b"];
/// The lock side history's labels.
pub const LOCK_LABELS: [&str; 2] = ["taa lock a", "taa lock b"];
/// Bytes of one texel of both side histories.
pub const SIDE_TEXEL_BYTES: u64 = 4 + 4;
/// The reactive mask's format (1: the current sample wins), fragment-written.
pub const REACTIVE_FORMAT: TextureFormat = TextureFormat::R8Unorm;
/// The reactive mask's usages.
pub const REACTIVE_USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
/// The reactive mask's pool label.
pub const REACTIVE_LABEL: &str = "taa reactive";

/// How far (relative) the history's depth key may sit outside the neighbourhood's range before
/// the pixel counts as disoccluded and takes the current sample. Keys are proportional to
/// 1 / view depth, so this is a relative depth change.
pub const DISOCCLUSION_TOLERANCE: f32 = 0.05;
/// The current sample's extra weight per render pixel of motion (fully current at 100 px).
pub const MOTION_REJECTION_PER_PX: f32 = 0.01;
/// How much the history sample is sharpened against its four outer Catmull-Rom taps where it fell
/// halfway between texel centres on both axes (`GX_TAA_HISTORY_SHARPEN`; none on a texel centre,
/// so a still camera's history is untouched). Every frame of motion resamples the history, and a
/// fractional resample loses high frequencies the next one loses again: G0 (2026-10-15), panned at
/// 1 and 4 px a frame bench-outdoor kept 49% and 57% of its still sharpness at high. At 0.2 it keeps
/// 100% and 86% (ultra 102% and 89%) with the 1 px pan's flicker 0.061% -> 0.066%; 0.3 overshot
/// at 1 px (122%), the feedback sharpening every frame of the history's memory. Renderer pass 2,
/// B.7: the resample and the sharpened history are held inside the four history texels around the
/// sample (Catmull-Rom's overshoot and the sharpening rang on sub-pixel detail into one-frame
/// pops), and the colour box grows on settled pixels ([`NOISE_BOX_SCALE`]), so less of the
/// sharpening is clipped away: 0.15 keeps 90% and 98% (ultra 94% and 111%).
pub const HISTORY_SHARPEN: f32 = 0.15;
/// The motion (render pixels a frame) over which the history's sharpening fades in, from none
/// under the first (`GX_TAA_SHARPEN_MOTION_PX`): under a creep the sharpening fed back on itself
/// every frame and an edge's history rang (B.7: bench-outdoor's lake box flickered on 323 pixels
/// creeping a fiftieth of a pixel a frame against 21 still at high; 0 against 0 without it).
pub const SHARPEN_MOTION_PX: [f32; 2] = [0.05, 0.2];
/// How fast a pixel's temporal noise (the lock history's w, [`LOCK_FORMAT`]) follows this frame's,
/// a running mean (`GX_TAA_NOISE_RATE`).
pub const NOISE_RATE: f32 = 0.15;
/// How far a settled pixel's colour box grows by its temporal noise (`GX_TAA_NOISE_BOX_SCALE`),
/// and the growth it always has (`GX_TAA_NOISE_BOX_FLOOR`, tonemapped YCoCg): a sub-pixel detail
/// the jitter hits in some frames only (a far tree tip against the sky, a sparkle in a canopy) was
/// clipped out of its history on every frame the jitter missed it and came back on the next hit,
/// a one-frame pop on every Lakeside path (B.7: pan, orbit and dolly worst 14, 13 and 39 popped
/// pixels a frame at high against 1, 2 and 2); and a sharp shadow mask's texel clipped back and
/// forth by a few levels under a still camera (the fence row: 0.0004% of pixels a frame at high
/// against medium's none, now none).
pub const NOISE_BOX_SCALE: f32 = 3.0;
/// See [`NOISE_BOX_SCALE`].
pub const NOISE_BOX_FLOOR: f32 = 0.01;
/// The motion of its own (render pixels a frame, beyond the camera's at the closest surface) over
/// which a pixel stops counting as settled, fully at the second (`GX_TAA_SETTLED_OWN_MOTION_PX`):
/// a swaying tree is settled, a near grass blade swaying across the ground is not, so the history
/// it leaves behind is clipped (the Live-TAA trails row).
pub const SETTLED_OWN_MOTION_PX: [f32; 2] = [0.15, 0.5];
/// The motion of its own (render pixels a frame) that clears a pixel's temporal noise
/// (`GX_TAA_NOISE_RESET_OWN_MOTION_PX`): a surface moving over it says nothing about its noise.
pub const NOISE_RESET_OWN_MOTION_PX: f32 = 0.3;
/// How fast reactive coverage takes the colour box's growth away (`GX_TAA_NOISE_REACTIVE_CUT`):
/// none from an eighth of coverage.
pub const NOISE_REACTIVE_CUT: f32 = 8.0;
/// History this many growths outside the colour box, fading from the first to the second, is
/// clipped without the growth (`GX_TAA_NOISE_HOLD_REACH`): a whole surface gone (a moved object's
/// edge, an object without motion vectors) is no detail the jitter missed. A history reset
/// clears the noise too: measured against the stale history of a reset frame, a cube's first
/// outline was held as a faint ring after it moved away (tests/taa_frame.rs).
pub const NOISE_HOLD_REACH: [f32; 2] = [2.0, 4.0];
/// The colour box: the neighbourhood's mean ± this many standard deviations (tonemapped YCoCg),
/// intersected with its min/max (`GX_TAA_VARIANCE_GAMMA` in taa.wgsl). FSR 2.2 weighs its samples
/// `exp(-(2..3) d²)` by their distance from the unjittered centre at one deviation; measured here
/// (P2-0.8a), that box clipped static edges within the first jitter cycle (edge error against the
/// cycle's even mean 0.075 at 1.0 weighted, 0.018 at 1.0 unweighted, 0.004 at 1.25 unweighted), so
/// a settled capture would alias, and the box stays unweighted at 1.25.
pub const VARIANCE_GAMMA: f32 = 1.25;
/// Two neighbours' lock lumas are similar within this ratio of their perceived lightness: FSR 2.2's
/// 1.05 on lightness^(1/6) (`ffx_fsr2_lock.h`), to the sixth (`GX_TAA_LOCK_SIMILAR_RATIO`).
pub const LOCK_SIMILAR_RATIO: f32 = 1.340_095_6;
/// A lock whose shading luma changed by more than this share (1 - min/max) dies, and the change
/// raises the reactive factor (FSR 2.2's UpdateLockStatus; `GX_TAA_LOCK_SHADING_CHANGE`).
pub const LOCK_SHADING_CHANGE: f32 = 0.1;
/// The luma deviation at which the colour box (or the swing of the last five frames' box-centre
/// luma) counts as wide enough for luma instability (FSR 2.2: `pow(saturate(sigma / 0.1), 6)`;
/// `GX_TAA_INSTABILITY_BOX_SIGMA`).
pub const INSTABILITY_BOX_SIGMA: f32 = 0.1;
/// The reactive factor a pixel moving a render pixel or more a frame (its own motion or the
/// camera's, the sky included) counts as for its lock and luma instability, reached linearly from
/// still (FSR 2.2's ComputeTemporalReactiveFactor; `GX_TAA_MOTION_REACTIVE`). Without it a lock
/// or an oscillation held smeared history through a pan: bench-outdoor at 4 px a frame streaked
/// the trees across the sky (P2-0.8a).
pub const MOTION_REACTIVE: f32 = 0.4;
/// Where [`GpuTaaParams::counts`] w keeps the jitter cycle's frames (bits 8..15; the flags hold
/// bits 0..7): a lock lives one cycle of frames.
pub const JITTER_CYCLE_SHIFT: u32 = 8;
/// The flag bits of [`GpuTaaParams::counts`] w.
const FLAG_BITS: u32 = (1 << JITTER_CYCLE_SHIFT) - 1;
/// The rejected-pixel filter's falloff `k` (`GX_TAA_FILTER_FALLOFF`): each tap of the 3x3
/// neighbourhood weighs `exp(-k d²)` at `d` render pixels from the unjittered pixel centre.
pub const FILTER_FALLOFF: f32 = 2.29;
/// The wider falloff a pixel whose history lies off the screen takes its current frame with
/// (`GX_TAA_EDGE_FILTER_FALLOFF`; renderer pass 2, B.7): what enters at the frame's edge has no
/// history, and its sharp first sample was a one-frame pop beside the softer resolve of the next
/// frame (a dark mote entering the Lakeside orbit's right edge). Disoccluded pixels keep
/// [`FILTER_FALLOFF`].
pub const EDGE_FILTER_FALLOFF: f32 = 0.8;
/// The motion (render pixels, the 3x3 neighbourhood's closest surface's) under which a pixel
/// stands still (`GX_TAA_STILL_MOTION_PX` in taa.wgsl): a still camera on a still surface, or a
/// creep (B.7: a fiftieth of a pixel a frame took twice the still floor's current weight, and the
/// jitter's edge noise with it, at 0.01).
pub const STILL_MOTION_PX: f32 = 0.05;
/// A still pixel's accumulation floor as a share of `alpha_min` (`GX_TAA_STILL_ALPHA_SHARE`): it
/// averages over twice as many frames, so a sub-pixel edge's jittered sample moves its history by
/// half as much each frame (pass-1 gate finding 04: grass tufts and far tree tips against the sky
/// flickered by more than 3 levels under a still camera). The colour box still clips a change.
pub const STILL_ALPHA_SHARE: f32 = 0.5;
/// The 4x4 identity, column-major: [`GpuTaaParams::reproject`] of a still camera.
pub const IDENTITY: [f32; 16] = [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0];

/// The resolve's switches (`TaaParams.counts.w` bits).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TaaFlags(u32);

impl TaaFlags {
    /// No rectification: history is only rejected (tests and debugging).
    pub const NONE: TaaFlags = TaaFlags(0);
    /// The history's rectification against the colour box, with the locks and the luma
    /// instability (always on in the renderer).
    pub const CLIP: TaaFlags = TaaFlags(1);

    /// The bits the shader reads.
    pub const fn bits(self) -> u32 {
        self.0
    }
}

/// The resolve (graph node 17): a full-screen fragment pass.
pub const TAA: &str = crate::shaders::minify::shipped_wgsl!(include_str!("../../shaders/post/taa.wgsl"));
/// The reactive coverage (graph node 15a): the transparent draws as coverage.
pub const REACTIVE: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/clip_position.wgsl"),
    // Mirrors `layout::GpuPrevModel` (`motion::PREV_MODEL_WGSL`, held to it by tests/layout.rs).
    "
struct PrevModel {
    model: mat4x4<f32>,
    flags: vec4<u32>,
}
",
    include_str!("../../shaders/post/reactive.wgsl")
));
/// The particles' reactive coverage: their billboards (`particle_billboard.wgsl`, the draw's own
/// quads: turned, or stretched along the motion as rain is; renderer pass 2 A.11) as soft coverage
/// into the same mask, jittered like the mesh entry ([`REACTIVE`]).
pub const REACTIVE_PARTICLES: &str = crate::shaders::minify::shipped_wgsl!(concat!(
    include_str!("../../shaders/common.wgsl"),
    include_str!("../../shaders/part2/particle.wgsl"),
    include_str!("../../shaders/part2/particle_billboard.wgsl"),
    include_str!("../../shaders/clip_position.wgsl"),
    "
// The particles' reactive coverage (graph node 15a; RQ5.2): each billboard's soft dot as coverage,
// jittered as the scene was. Same frame (group 0) and particle (group 1) bindings as the draw.
@group(0) @binding(0) var<uniform> frame: FrameUniforms;
@group(1) @binding(0) var<storage, read> particles_drawn: array<Particle>;
// Mirrors `post::taa::GpuReactiveJitter`.
struct ReactiveJitter {
    // xy: this frame's jitter in NDC (y up); z: the coverage of a transparent mesh; w: reserved.
    ndc: vec4<f32>,
    // xy: the render size; z: the motion (px) below which a mesh writes none; w: 1 when a mesh's
    // coverage follows its motion (particles take theirs whole).
    motion: vec4<f32>,
}
@group(2) @binding(0) var<uniform> gx_reactive_jitter: ReactiveJitter;

struct ReactiveParticleOut {
    @builtin(position) clip: vec4<f32>,
    @location(0) corner: vec2<f32>,
    @location(1) alpha: f32,
}

@vertex
fn vs_reactive_particle(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> ReactiveParticleOut {
    let p = particles_drawn[instance];
    let corner = particle_quad_corner(vertex);
    let world = particle_corner_world(p, particle_shapes_drawn[instance], corner);
    let clip = gx_clip_position(frame.view_proj, vec4<f32>(world, 1.0), gx_reactive_jitter.ndc.xy);
    return ReactiveParticleOut(clip, corner, p.color.a);
}

@fragment
fn fs_reactive_particle(in: ReactiveParticleOut) -> @location(0) vec4<f32> {
    let fade = 1.0 - smoothstep(0.5, 1.0, length(in.corner));
    return vec4<f32>(in.alpha * fade, 0.0, 0.0, 1.0);
}
"
));

/// The most coverage a transparent mesh writes into the reactive mask where it needs any: its
/// material's alpha, capped here, so a moving transparent keeps at least a tenth of its history
/// (renderer pass 2, P2-0.2, T-01 step 2; FSR2's reactive-mask guidance: write alpha, clamped to
/// about 0.9, since a reactive value near 1 never resolves well). It was whole coverage: the
/// current sample every frame, with no anti-aliasing of the edges.
pub const TRANSPARENT_COVERAGE: f32 = 0.9;
/// The coverage the transparent meshes write on a frame where every one of them stood still since
/// the last ([`transparent_coverage`]): none, so they accumulate and clip as opaque surfaces do,
/// whether the camera moved or not (the camera's reprojection holds for a still surface). Whole
/// coverage there took the current sample every frame, and a reactive pixel's current sample moves
/// with the jitter wherever an edge crosses it: a still lake's shore and the trees standing in it
/// flickered by more than 3 levels frame to frame (pass-1 gate finding 04: about 60% of a still
/// camera's flickering pixels at high), and while the camera moved the lake's shadows showed every
/// frame's raw noise (pass 2, T-01: its box 179 pixels still, 4,724 creeping at high). The core
/// materials draw no time-driven change, so a still transparent draw looks the same next frame.
pub const SETTLED_TRANSPARENT_COVERAGE: f32 = 0.0;

/// How far (render pixels a frame) a moved transparent must move under a pixel for it to write the
/// whole of [`ReactiveCoverage::cap`]; a slower one writes its share of it above
/// [`REACTIVE_STILL_MOTION_PX`] (shaders/post/reactive.wgsl).
pub const REACTIVE_FULL_MOTION_PX: f32 = 1.0;
/// The motion (render pixels a frame) below which a moved transparent writes no coverage: less
/// than the history's own bilinear reprojection moves a value, so TAA keeps it as a still one.
pub const REACTIVE_STILL_MOTION_PX: f32 = 1.0 / 32.0;

/// What this frame's transparent meshes write into the reactive mask at most, each its material's
/// alpha below it ([`transparent_coverage`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReactiveCoverage {
    /// The most coverage a transparent mesh writes.
    pub cap: f32,
    /// Whether a mesh writes its share of the cap by how far its surface moved under each pixel
    /// since last frame (its model against last frame's, through this frame's camera), whole from
    /// [`REACTIVE_FULL_MOTION_PX`]: when every row has last frame's model and none is skinned.
    pub by_motion: bool,
}

/// This frame's transparent rows and their previous-model entries.
#[derive(Clone, Copy, Debug)]
pub struct TransparentRows<'a> {
    /// Whether the frame has last frame's history.
    pub history: bool,
    /// The transparent rows (indices into `prev_models`).
    pub rows: &'a [u32],
    /// Last frame's model of every row and its motion flags.
    pub prev_models: &'a [crate::layout::GpuPrevModel],
    /// The draws the transparent rows come from.
    pub sources: &'a [crate::scene::DrawSource],
}

/// The coverage this frame's transparent meshes write into the reactive mask: a cap of
/// [`SETTLED_TRANSPARENT_COVERAGE`] when the frame has last frame's history and every transparent
/// row stood still (its model matched last frame's: `MOTION_FLAG_STILL` without
/// `MOTION_FLAG_NO_HISTORY`, and it is not skinned: its vertices may move under a still model),
/// else [`TRANSPARENT_COVERAGE`]; scaled by each pixel's motion ([`ReactiveCoverage::by_motion`])
/// unless the frame has no history, a row has none (or the table does not hold it) or a draw is
/// skinned. The camera's motion does not count. G0 (2026-10-15): a lake drifting a tenth of a
/// millimetre a frame (a hundredth of a pixel) wrote the whole cap, so its flat water showed every
/// frame's jittered sample: 602 flickering pixels in the lake box against none still at high.
pub fn transparent_coverage(frame: &TransparentRows<'_>) -> ReactiveCoverage {
    let whole = ReactiveCoverage { cap: TRANSPARENT_COVERAGE, by_motion: false };
    if !frame.history || frame.sources.iter().any(|source| source.skinned) {
        return whole;
    }
    let mut moved = false;
    for row in frame.rows {
        let Some(prev) = frame.prev_models.get(*row as usize) else { return whole };
        let flags = prev.flags[0];
        if flags & crate::motion::MOTION_FLAG_NO_HISTORY != 0 {
            return whole;
        }
        moved |= flags & crate::motion::MOTION_FLAG_STILL == 0;
    }
    if moved { ReactiveCoverage { cap: TRANSPARENT_COVERAGE, by_motion: true } } else { ReactiveCoverage { cap: SETTLED_TRANSPARENT_COVERAGE, by_motion: false } }
}

const SCENE_BINDING: u32 = 0;
const HISTORY_BINDING: u32 = 1;
const DEPTH_BINDING: u32 = 2;
const MOTION_BINDING: u32 = 3;
const REACTIVE_BINDING: u32 = 4;
const SAMPLER_BINDING: u32 = 5;
const PARAMS_BINDING: u32 = 6;
const LUMA_HISTORY_BINDING: u32 = 7;
const LOCK_BINDING: u32 = 8;

/// The resolve's uniform (`TaaParams`).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuTaaParams {
    /// xy: the render size in pixels; zw: 1 / it.
    pub size: [f32; 4],
    /// xy: this frame's jitter in render pixels (x right, y down); zw: the previous frame's.
    pub jitter: [f32; 4],
    /// x: the accumulation floor (alpha_min); y: exposure now / exposure then; z: the
    /// disocclusion tolerance ([`DISOCCLUSION_TOLERANCE`]); w: the current weight per pixel of
    /// motion ([`MOTION_REJECTION_PER_PX`]).
    pub params: [f32; 4],
    /// x: frames since the history's reset (n, saturating; the node writes its own count, so a
    /// frame index restarted by a dynamic-resolution step does not restart the accumulation); y: 1
    /// when this frame resets it; z: 1 under reverse-Z; w: [`TaaFlags`] bits in bits 0..7 and the
    /// jitter cycle's frames from [`JITTER_CYCLE_SHIFT`].
    pub counts: [u32; 4],
    /// Last frame's unjittered view_proj × this frame's unjittered inverse, column-major: where a
    /// pixel's NDC point (x, y, device depth) sat in last frame's clip space ([`IDENTITY`] for a
    /// still camera, after a reset or without motion).
    pub reproject: [f32; 16],
}

impl GpuTaaParams {
    /// The row for the frame `config` describes, with `taa`'s floor, the previous frame's jitter
    /// and the exposure ratio its history is rescaled by (1 when unknown or not finite).
    pub fn new(taa: &TaaQuality, config: &FrameConfig, prev_jitter: [f32; 2], exposure_ratio: f32) -> GpuTaaParams {
        let (w, h) = (config.render_size.0.max(1) as f32, config.render_size.1.max(1) as f32);
        let ratio = if exposure_ratio.is_finite() && exposure_ratio > 0.0 { exposure_ratio } else { 1.0 };
        let frames = u32::try_from(config.frame_index).unwrap_or(u32::MAX);
        GpuTaaParams {
            size: [w, h, 1.0 / w, 1.0 / h],
            jitter: [config.jitter[0], config.jitter[1], prev_jitter[0], prev_jitter[1]],
            params: [taa.alpha_min, ratio, DISOCCLUSION_TOLERANCE, MOTION_REJECTION_PER_PX],
            counts: [frames, u32::from(config.history_reset), u32::from(config.depth_reversed), TaaFlags::CLIP.bits() | taa.jitter_cycle.frames() << JITTER_CYCLE_SHIFT],
            reproject: IDENTITY,
        }
    }

    /// The row with the camera's reprojection `reproject` (column-major; see
    /// [`GpuTaaParams::reproject`]): [`reprojection`] of last frame's and this frame's unjittered
    /// view_proj. A matrix with a non-finite entry keeps the identity.
    pub fn with_reproject(mut self, reproject: [f32; 16]) -> GpuTaaParams {
        if reproject.iter().all(|value| value.is_finite()) {
            self.reproject = reproject;
        }
        self
    }

    /// The row with `flags` instead (the jitter cycle kept).
    pub const fn with_flags(mut self, flags: TaaFlags) -> GpuTaaParams {
        self.counts[3] = (self.counts[3] & !FLAG_BITS) | flags.bits();
        self
    }

    /// The jitter cycle's frames the row carries (a lock lives that many frames).
    pub const fn jitter_cycle_frames(&self) -> u32 {
        self.counts[3] >> JITTER_CYCLE_SHIFT
    }

    /// The row starting history over: frame 0, the reset bit set, the previous jitter this one's.
    pub const fn reset(mut self) -> GpuTaaParams {
        self.counts[0] = 0;
        self.counts[1] = 1;
        self.jitter[2] = self.jitter[0];
        self.jitter[3] = self.jitter[1];
        self
    }

    /// Whether the row starts history over.
    pub const fn resets(&self) -> bool {
        self.counts[1] != 0
    }
}

/// The reactive coverage's uniform (`ReactiveJitter`, group 2 of both reactive entry points).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuReactiveJitter {
    /// xy: this frame's jitter in NDC (y up, [`crate::jitter::offset_ndc`]); z: the most coverage
    /// a transparent mesh writes (its material's alpha below it; [`ReactiveCoverage::cap`]); w:
    /// reserved.
    pub ndc: [f32; 4],
    /// xy: the render size in pixels; z: [`REACTIVE_STILL_MOTION_PX`]; w: 1 when a mesh writes its
    /// share of the cap by its motion under the pixel ([`ReactiveCoverage::by_motion`]), else 0
    /// (the share reaches all of it at [`REACTIVE_FULL_MOTION_PX`]).
    pub motion: [f32; 4],
}

impl GpuReactiveJitter {
    /// The row for a frame jittered by `jitter_px` (render pixels, y down) at `render` size.
    pub fn new(jitter_px: [f32; 2], render: (u32, u32)) -> GpuReactiveJitter {
        let [x, y] = crate::jitter::offset_ndc(jitter_px, render);
        let motion = [render.0 as f32, render.1 as f32, REACTIVE_STILL_MOTION_PX, 0.0];
        GpuReactiveJitter { ndc: [x, y, TRANSPARENT_COVERAGE, 0.0], motion }
    }

    /// This row with the transparent meshes writing `coverage` ([`transparent_coverage`]).
    pub fn with_coverage(self, coverage: ReactiveCoverage) -> GpuReactiveJitter {
        let [x, y, _, w] = self.ndc;
        let [width, height, per_px, _] = self.motion;
        GpuReactiveJitter { ndc: [x, y, coverage.cap, w], motion: [width, height, per_px, f32::from(u8::from(coverage.by_motion))] }
    }
}

fn reactive_group(device: &Device, layout: &BindGroupLayout, jitter: &Buffer, prev_models: &Buffer) -> wgpu::BindGroup {
    device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("taa reactive jitter"),
        layout,
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: jitter.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: prev_models.as_entire_binding() }],
    })
}

/// Last frame's unjittered `prev_view_proj` × the inverse of this frame's `view_proj` (both
/// column-major): [`GpuTaaParams::reproject`]. A singular `view_proj` answers [`IDENTITY`].
pub fn reprojection(prev_view_proj: &[f32; 16], view_proj: &[f32; 16]) -> [f32; 16] {
    let now = glam::Mat4::from_cols_array(view_proj);
    if now.determinant().abs() <= f32::MIN_POSITIVE || !now.is_finite() {
        return IDENTITY;
    }
    (glam::Mat4::from_cols_array(prev_view_proj) * now.inverse()).to_cols_array()
}

/// The current frame's weight after `frames` frames of history since its reset:
/// `max(1 / (frames + 1), alpha_min)`, so the first frame after a reset takes the current sample
/// whole and the weight settles at the floor (a moving pixel's; a still one's floor is
/// [`STILL_ALPHA_SHARE`] of it).
pub fn accumulation_weight(frames: u64, alpha_min: f32) -> f32 {
    let average = 1.0 / (frames.min(u64::from(u32::MAX)) as f32 + 1.0);
    average.max(alpha_min)
}

/// Whether `reason` starts TAA's history over: a cut, a resize, a pipeline-shaping settings
/// change, a new device, a rewind and a capture's own history do. A dynamic-resolution step does
/// not (RQ5 review): the history is read in uv, so the next resolve reprojects it from its old
/// size into the new one instead of popping to an aliased frame and re-converging. Exposure is not
/// a reason either: history is rescaled by exposure now / exposure then instead.
pub const fn resets_history(reason: HistoryReset) -> bool {
    match reason {
        HistoryReset::ScaleStep => false,
        HistoryReset::CameraCut
        | HistoryReset::Resize
        | HistoryReset::Settings
        | HistoryReset::DeviceRecreated
        | HistoryReset::Rewind
        | HistoryReset::Capture => true,
    }
}

/// The depth key the history's alpha carries for device depth `depth`: proportional to
/// 1 / view depth under either convention (`d` reversed, `1 - d` standard), 0 at the far plane.
pub fn depth_key(depth: f32, reversed: bool) -> f32 {
    if reversed { depth } else { 1.0 - depth }
}

fn render_size(render: (u32, u32)) -> (u32, u32) {
    (render.0.max(1), render.1.max(1))
}

/// The history pair at `render` size.
pub fn history_targets(render: (u32, u32)) -> [TargetDesc; 2] {
    let size = render_size(render);
    HISTORY_LABELS.map(|label| TargetDesc { label, format: HISTORY_FORMAT, usage: HISTORY_USAGE, samples: 1, size, mips: 1, srgb_view: false })
}

/// The reactive mask at `render` size.
pub fn reactive_target(render: (u32, u32)) -> TargetDesc {
    TargetDesc { label: REACTIVE_LABEL, format: REACTIVE_FORMAT, usage: REACTIVE_USAGE, samples: 1, size: render_size(render), mips: 1, srgb_view: false }
}

/// The side histories' pairs at `render` size (the luma history's, then the lock's): the resolve
/// makes them beside its colour history, so only the layout check reads these.
pub fn side_history_targets(render: (u32, u32)) -> [TargetDesc; 4] {
    let size = render_size(render);
    let desc = |label, format| TargetDesc { label, format, usage: HISTORY_USAGE, samples: 1, size, mips: 1, srgb_view: false };
    [desc(LUMA_HISTORY_LABELS[0], LUMA_HISTORY_FORMAT), desc(LUMA_HISTORY_LABELS[1], LUMA_HISTORY_FORMAT), desc(LOCK_LABELS[0], LOCK_FORMAT), desc(LOCK_LABELS[1], LOCK_FORMAT)]
}

/// What TAA holds at `render` size, for the budget ledger: the colour history pair, its side
/// histories and the mask.
pub fn bytes(render: (u32, u32)) -> u64 {
    let (w, h) = render_size(render);
    let texels = u64::from(w) * u64::from(h);
    2 * texels * (HISTORY_TEXEL_BYTES + SIDE_TEXEL_BYTES) + texels
}

// ---------------------------------------------------------------------------------------------
// The resolve node

/// What one resolve reads: the jittered HDR scene and its depth at render size, the motion target
/// and the reactive mask (a neutral zero texture when the frame has none), and the frame's row.
pub struct TaaInput<'a> {
    /// The 1x HDR scene (after the MSAA resolve when there was one; TAA forces MSAA off).
    pub scene: &'a TextureView,
    /// The scene's depth (`Depth32Float`, sampled as `texture_depth_2d`).
    pub depth: &'a TextureView,
    /// The motion target (NDC, current − previous, jitter removed); None reads zero motion.
    pub motion: Option<&'a TextureView>,
    /// The reactive mask; None reads zero (no reactive pixel).
    pub reactive: Option<&'a TextureView>,
    /// The render size (the history's).
    pub render: (u32, u32),
    /// The frame's row ([`GpuTaaParams::new`]).
    pub row: GpuTaaParams,
}

/// What one resolve wrote.
pub struct TaaOutput {
    /// The resolved scene: this frame's history (rgb; alpha the depth key).
    pub view: TextureView,
    /// Whether the resolve started history over (asked by the row, or a fresh history).
    pub reset: bool,
    /// The history slot it wrote (0 or 1: the slots alternate, so readers caching a bind group
    /// key it by the slot).
    pub slot: usize,
}

/// One history slot: the colour history and its luma and lock side histories, at the render size
/// they were written at.
struct Slot {
    size: (u32, u32),
    texture: Texture,
    view: TextureView,
    luma: TextureView,
    lock: TextureView,
}

struct History {
    /// The ping-pong pair; each slot is (re)made at the render size of the resolve that writes it,
    /// so after a dynamic-resolution step the history read is the old size (sampled in uv).
    slots: [Option<Slot>; 2],
    /// The slot the last resolve wrote; None until one did (the next resolve resets).
    written: Option<usize>,
    /// Resolves since the history's reset (n of the accumulation `max(1 / (n + 1), alpha_min)`):
    /// the node's own count, so an index restarted by a dynamic-resolution step does not restart
    /// the accumulation.
    frames: u32,
}

/// Graph node 17: the resolve's pipeline, its history pair (each slot made at the render size of
/// the resolve that writes it, so a dynamic-resolution step reprojects the old size's history in
/// uv instead of resetting it) and its neutral inputs.
pub struct TaaNode {
    pipeline: Compiled<RenderPipeline>,
    layout: BindGroupLayout,
    sampler: Sampler,
    params: Buffer,
    neutral_motion: TextureView,
    neutral_reactive: TextureView,
    /// The history a fresh resolve binds (it reads it with weight 0): one black texel; and the
    /// side histories' (no luma, no lock).
    neutral_history: TextureView,
    neutral_luma: TextureView,
    neutral_lock: TextureView,
    history: Option<History>,
    extra_usage: TextureUsages,
}

fn fragment_entry(binding: u32, ty: wgpu::BindingType) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry { binding, visibility: wgpu::ShaderStages::FRAGMENT, ty, count: None }
}

fn float_texture(binding: u32) -> wgpu::BindGroupLayoutEntry {
    let ty = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: true }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
    fragment_entry(binding, ty)
}

fn neutral_texture(gpu_device: &Device, queue: &Queue, label: &str, format: TextureFormat, texel: &[u8]) -> TextureView {
    let texture = gpu_device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    queue.write_texture(
        texture.as_image_copy(),
        texel,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(texel.len() as u32), rows_per_image: Some(1) },
        wgpu::Extent3d { width: 1, height: 1, depth_or_array_layers: 1 },
    );
    texture.create_view(&Default::default())
}

fn slot_texture(device: &Device, desc: &TargetDesc, extra_usage: TextureUsages) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(desc.label),
        size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: desc.format,
        usage: desc.usage | extra_usage,
        view_formats: &[],
    })
}

/// History slot `index` of the pair at `size`, its colour carrying `extra_usage` beside the
/// history's own.
fn history_slot(device: &Device, index: usize, size: (u32, u32), extra_usage: TextureUsages) -> Slot {
    let texture = slot_texture(device, &history_targets(size)[index], extra_usage);
    let view = texture.create_view(&Default::default());
    let side = side_history_targets(size);
    let luma = slot_texture(device, &side[index], TextureUsages::empty()).create_view(&Default::default());
    let lock = slot_texture(device, &side[2 + index], TextureUsages::empty()).create_view(&Default::default());
    Slot { size, texture, view, luma, lock }
}

impl TaaNode {
    /// The node, its pipeline built for the history's format.
    pub fn new(device: &Device, queue: &Queue) -> Result<TaaNode, RenderError> {
        TaaNode::with_usage(device, queue, TextureUsages::empty())
    }

    /// A node whose history also carries `extra_usage` (a readback's `COPY_SRC`; the renderer's,
    /// which copies a resolve into the scene for `post-hdr` passes).
    pub(crate) fn with_usage(device: &Device, queue: &Queue, extra_usage: TextureUsages) -> Result<TaaNode, RenderError> {
        let module = crate::shaders::module(device, "taa", TAA)?;
        let depth = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Depth, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
        let params_size = wgpu::BufferSize::new(size_of::<GpuTaaParams>() as u64);
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("taa"),
            entries: &[
                float_texture(SCENE_BINDING),
                float_texture(HISTORY_BINDING),
                fragment_entry(DEPTH_BINDING, depth),
                float_texture(MOTION_BINDING),
                float_texture(REACTIVE_BINDING),
                fragment_entry(SAMPLER_BINDING, wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering)),
                fragment_entry(PARAMS_BINDING, wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: params_size }),
                float_texture(LUMA_HISTORY_BINDING),
                float_texture(LOCK_BINDING),
            ],
        });
        let pipeline_layout = pipeline_layout(device, "taa", &[&layout]);
        let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some("taa resolve"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_taa"), compilation_options: Default::default(), buffers: &[] },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_taa"),
                compilation_options: Default::default(),
                targets: &[
                    Some(wgpu::ColorTargetState { format: HISTORY_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL }),
                    Some(wgpu::ColorTargetState { format: LUMA_HISTORY_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL }),
                    Some(wgpu::ColorTargetState { format: LOCK_FORMAT, blend: None, write_mask: wgpu::ColorWrites::ALL }),
                ],
            }),
            multiview_mask: None,
            cache: None,
        });
        // Clamped at the edges: Catmull-Rom's outer taps never wrap to the far side.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("taa history"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        let params = buffer(device, "taa params", size_of::<GpuTaaParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let zero_motion = [0u8; 4];
        Ok(TaaNode {
            pipeline,
            layout,
            sampler,
            params,
            neutral_motion: neutral_texture(device, queue, "taa no motion", crate::motion::MOTION_FORMAT, &zero_motion),
            neutral_reactive: neutral_texture(device, queue, "taa no reactive", REACTIVE_FORMAT, &[0u8; 4][..1]),
            neutral_history: neutral_texture(device, queue, "taa no history", HISTORY_FORMAT, &[0u8; 8]),
            neutral_luma: neutral_texture(device, queue, "taa no luma history", LUMA_HISTORY_FORMAT, &[0u8; 4]),
            neutral_lock: neutral_texture(device, queue, "taa no lock", LOCK_FORMAT, &[0u8; 4]),
            history: None,
            extra_usage,
        })
    }

    /// Forget the history: the next resolve starts over (a new device, an explicit reset).
    pub fn reset(&mut self) {
        if let Some(history) = &mut self.history {
            history.written = None;
        }
    }

    /// The bytes the history pair and its side histories hold now (the ledger counts them with
    /// [`bytes`]).
    pub fn history_bytes(&self) -> u64 {
        let slots = self.history.as_ref().map_or(&[None, None], |history| &history.slots);
        slots.iter().flatten().map(|slot| u64::from(slot.size.0) * u64::from(slot.size.1) * (HISTORY_TEXEL_BYTES + SIDE_TEXEL_BYTES)).sum()
    }

    /// The history with slot `write` at `render` size (remade when its size differs: a
    /// dynamic-resolution step remakes one slot a frame, and the slot read keeps its old size).
    fn history(&mut self, device: &Device, render: (u32, u32), write: usize) -> &mut History {
        let size = render_size(render);
        let extra_usage = self.extra_usage;
        let history = self.history.get_or_insert(History { slots: [None, None], written: None, frames: 0 });
        if history.slots[write].as_ref().is_none_or(|slot| slot.size != size) {
            history.slots[write] = Some(history_slot(device, write, size, extra_usage));
        }
        history
    }

    /// Record the resolve of `input` into the history slot the last frame did not write, and swap.
    /// A row asking for a reset, or a history that was just (re)allocated, starts over.
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: TaaInput<'_>) -> TaaOutput {
        self.encode_timed(device, queue, encoder, input, None)
    }

    fn encode_timed(
        &mut self,
        device: &Device,
        queue: &Queue,
        encoder: &mut wgpu::CommandEncoder,
        input: TaaInput<'_>,
        timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>,
    ) -> TaaOutput {
        let read = self.history.as_ref().and_then(|history| history.written).unwrap_or(1);
        let write = 1 - read;
        let neutral = [self.neutral_history.clone(), self.neutral_luma.clone(), self.neutral_lock.clone()];
        let history = self.history(device, input.render, write);
        let fresh = history.written.is_none() || history.slots[read].is_none();
        history.written = Some(write);
        let [read_view, read_luma, read_lock] = history.slots[read].as_ref().map_or(neutral, |slot| [slot.view.clone(), slot.luma.clone(), slot.lock.clone()]);
        let written = history.slots[write].as_ref().expect("made above");
        let (write_view, write_luma, write_lock) = (written.view.clone(), written.luma.clone(), written.lock.clone());
        let reset = fresh || input.row.resets();
        history.frames = if reset { 0 } else { history.frames.saturating_add(1) };
        let mut row = if reset { input.row.reset() } else { input.row };
        row.counts[0] = history.frames;
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let motion = input.motion.unwrap_or(&self.neutral_motion);
        let reactive = input.reactive.unwrap_or(&self.neutral_reactive);
        let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("taa"),
            layout: &self.layout,
            entries: &[
                wgpu::BindGroupEntry { binding: SCENE_BINDING, resource: wgpu::BindingResource::TextureView(input.scene) },
                wgpu::BindGroupEntry { binding: HISTORY_BINDING, resource: wgpu::BindingResource::TextureView(&read_view) },
                wgpu::BindGroupEntry { binding: DEPTH_BINDING, resource: wgpu::BindingResource::TextureView(input.depth) },
                wgpu::BindGroupEntry { binding: MOTION_BINDING, resource: wgpu::BindingResource::TextureView(motion) },
                wgpu::BindGroupEntry { binding: REACTIVE_BINDING, resource: wgpu::BindingResource::TextureView(reactive) },
                wgpu::BindGroupEntry { binding: SAMPLER_BINDING, resource: wgpu::BindingResource::Sampler(&self.sampler) },
                wgpu::BindGroupEntry { binding: PARAMS_BINDING, resource: self.params.as_entire_binding() },
                wgpu::BindGroupEntry { binding: LUMA_HISTORY_BINDING, resource: wgpu::BindingResource::TextureView(&read_luma) },
                wgpu::BindGroupEntry { binding: LOCK_BINDING, resource: wgpu::BindingResource::TextureView(&read_lock) },
            ],
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("taa resolve"),
                // Every texel of each is written: nothing to load (free on tile GPUs).
                color_attachments: &[&write_view, &write_luma, &write_lock].map(|view| {
                    Some(wgpu::RenderPassColorAttachment {
                        view,
                        depth_slice: None,
                        resolve_target: None,
                        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT), store: wgpu::StoreOp::Store },
                    })
                }),
                timestamp_writes,
                ..Default::default()
            });
            pass.set_pipeline(&self.pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        TaaOutput { view: write_view, reset: row.resets(), slot: write }
    }

    fn written_texture(&self) -> Option<&Texture> {
        let history = self.history.as_ref()?;
        history.slots[history.written?].as_ref().map(|slot| &slot.texture)
    }

    /// The history texture of `slot` (what a resolve's [`TaaOutput::slot`] names).
    pub(crate) fn slot_texture(&self, slot: usize) -> Option<&Texture> {
        self.history.as_ref()?.slots.get(slot)?.as_ref().map(|slot| &slot.texture)
    }
}

// ---------------------------------------------------------------------------------------------
// The reactive coverage node

/// Which reactive entry point a pipeline draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ReactiveEntry {
    /// Transparent mesh draws (`vs_reactive`/`fs_reactive`; the forward vertex buffers).
    Mesh,
    /// Particle billboards (`vs_reactive_particle`; no vertex buffers).
    Particles,
}

/// Graph node 15a: the reactive coverage's jitter row and its pipelines. The renderer passes its
/// own frame and pass-view (or particle) group layouts and the forward vertex buffers, so the
/// coverage draws exactly the transparent draws and particles of the world pass, depth-tested
/// against the scene's depth without writing it, max-blended into the mask (rows RQ5.1's prepass
/// flagged as having no history stay set).
pub struct ReactiveNode {
    jitter_layout: BindGroupLayout,
    jitter: Buffer,
    /// Group 2 over the jitter row and a one-row previous-model table (it holds that table).
    group: wgpu::BindGroup,
}

/// The mask's blend: the larger coverage wins, so overlapping transparents and the prepass's
/// no-history flags never cancel.
pub const REACTIVE_BLEND: wgpu::BlendState = wgpu::BlendState {
    color: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max },
    alpha: wgpu::BlendComponent { src_factor: wgpu::BlendFactor::One, dst_factor: wgpu::BlendFactor::One, operation: wgpu::BlendOperation::Max },
};

impl ReactiveNode {
    /// The node, its jitter row and its group 2 (both entry points): the row and the frame's
    /// previous-model table (the mesh entry's vertex stage reads last frame's model of its row).
    pub fn new(device: &Device) -> Result<ReactiveNode, RenderError> {
        let size = wgpu::BufferSize::new(size_of::<GpuReactiveJitter>() as u64);
        let prev_size = wgpu::BufferSize::new(size_of::<crate::layout::GpuPrevModel>() as u64);
        let jitter_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("taa reactive jitter"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Uniform, has_dynamic_offset: false, min_binding_size: size },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::VERTEX,
                    ty: wgpu::BindingType::Buffer { ty: wgpu::BufferBindingType::Storage { read_only: true }, has_dynamic_offset: false, min_binding_size: prev_size },
                    count: None,
                },
            ],
        });
        let jitter = buffer(device, "taa reactive jitter", size_of::<GpuReactiveJitter>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        let empty = buffer(device, "taa reactive no previous models", size_of::<crate::layout::GpuPrevModel>() as u64, BufferUsages::STORAGE)?;
        let group = reactive_group(device, &jitter_layout, &jitter, &empty);
        Ok(ReactiveNode { jitter_layout, jitter, group })
    }

    /// The jitter row's layout (group 2).
    pub fn jitter_layout(&self) -> &BindGroupLayout {
        &self.jitter_layout
    }

    /// Group 2 over the jitter row and a one-row previous-model table (particles, which read no
    /// model, and a frame without the table: its row then writes no motion share).
    pub fn jitter_group(&self) -> &wgpu::BindGroup {
        &self.group
    }

    /// Group 2 over the jitter row and this frame's previous-model table `prev_models`.
    pub fn group(&self, device: &Device, prev_models: &Buffer) -> wgpu::BindGroup {
        reactive_group(device, &self.jitter_layout, &self.jitter, prev_models)
    }

    /// Write this frame's jitter row.
    pub fn write(&self, queue: &Queue, row: GpuReactiveJitter) {
        queue.write_buffer(&self.jitter, 0, bytemuck::bytes_of(&row));
    }

    /// A coverage pipeline for `entry`: `groups` are the frame group and the pass-view (mesh) or
    /// particle (particles) group the world pass binds, `buffers` the forward vertex buffers
    /// (empty for particles), `depth_reversed` the scene's depth convention.
    pub fn pipeline(
        &self,
        device: &Device,
        entry: ReactiveEntry,
        groups: [&BindGroupLayout; 2],
        buffers: &[Option<wgpu::VertexBufferLayout<'_>>],
        depth_reversed: bool,
    ) -> Result<Compiled<RenderPipeline>, RenderError> {
        let (label, source, vertex, fragment) = match entry {
            ReactiveEntry::Mesh => ("taa reactive", REACTIVE, "vs_reactive", "fs_reactive"),
            ReactiveEntry::Particles => ("taa reactive particles", REACTIVE_PARTICLES, "vs_reactive_particle", "fs_reactive_particle"),
        };
        let module = crate::shaders::module(device, label, source)?;
        let layout = pipeline_layout(device, label, &[groups[0], groups[1], &self.jitter_layout]);
        let compare = if depth_reversed { wgpu::CompareFunction::GreaterEqual } else { wgpu::CompareFunction::LessEqual };
        Ok(crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
            label: Some(label),
            layout: Some(&layout),
            vertex: wgpu::VertexState { module: &module, entry_point: Some(vertex), compilation_options: Default::default(), buffers },
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: Some(wgpu::DepthStencilState {
                format: TextureFormat::Depth32Float,
                depth_write_enabled: Some(false),
                depth_compare: Some(compare),
                stencil: Default::default(),
                bias: Default::default(),
            }),
            multisample: wgpu::MultisampleState::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some(fragment),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState { format: REACTIVE_FORMAT, blend: Some(REACTIVE_BLEND), write_mask: wgpu::ColorWrites::RED })],
            }),
            multiview_mask: None,
            cache: None,
        }))
    }
}

// ---------------------------------------------------------------------------------------------
// Image-level resolves (the GPU rows of tests/taa.rs and the cost row)

/// One frame of an image-level resolve sequence, every image `size` texels row by row.
#[derive(Clone, Debug)]
pub struct TaaFrameImage {
    /// The jittered HDR scene (pre-exposed radiance; alpha ignored).
    pub scene: Vec<[f32; 4]>,
    /// Device depth.
    pub depth: Vec<f32>,
    /// NDC motion (current − previous, jitter removed); empty: none.
    pub motion: Vec<[f32; 2]>,
    /// Reactive coverage `0..=1`; empty: none.
    pub reactive: Vec<f32>,
    /// The frame's row; its size is replaced by the sequence's.
    pub row: GpuTaaParams,
}

/// One resolved frame read back: rgb the resolved radiance, alpha the depth key.
#[derive(Clone, Debug, PartialEq)]
pub struct TaaImage {
    /// Width and height.
    pub size: (u32, u32),
    /// The texels, row by row.
    pub texels: Vec<[f32; 4]>,
}

fn upload(gpu: &Gpu, label: &str, size: (u32, u32), format: TextureFormat, usage: TextureUsages, bytes: &[u8], texel_bytes: u32) -> Texture {
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: usage | TextureUsages::TEXTURE_BINDING | TextureUsages::COPY_DST,
        view_formats: &[],
    });
    gpu.queue.write_texture(
        texture.as_image_copy(),
        bytes,
        wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * texel_bytes), rows_per_image: Some(size.1) },
        wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
    );
    texture
}

/// Writes an `r32float` image into a `Depth32Float` target (depth textures take no copies).
const DEPTH_UPLOAD: &str = "
@group(0) @binding(0) var gx_depth_source: texture_2d<f32>;

@vertex
fn vs_depth(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);
}

@fragment
fn fs_depth(@builtin(position) clip: vec4<f32>) -> @builtin(frag_depth) f32 {
    return textureLoad(gx_depth_source, vec2<i32>(clip.xy), 0).r;
}
";

struct ImageInputs {
    scene: TextureView,
    depth: TextureView,
    motion: Option<TextureView>,
    reactive: Option<TextureView>,
}

fn check_len<T>(what: &str, texels: &[T], size: (u32, u32), optional: bool) -> Result<(), RenderError> {
    let expected = (size.0 * size.1) as usize;
    if texels.len() == expected || (optional && texels.is_empty()) {
        return Ok(());
    }
    Err(capture_failed(format!("{} {what} texels for a {}x{} image", texels.len(), size.0, size.1)))
}

fn image_inputs(gpu: &Gpu, size: (u32, u32), frame: &TaaFrameImage) -> Result<ImageInputs, RenderError> {
    check_len("scene", &frame.scene, size, false)?;
    check_len("depth", &frame.depth, size, false)?;
    check_len("motion", &frame.motion, size, true)?;
    check_len("reactive", &frame.reactive, size, true)?;
    let halves: Vec<u16> = frame.scene.iter().flat_map(|texel| texel.map(crate::post::tonemap::f32_to_f16)).collect();
    let scene = upload(gpu, "taa image scene", size, TextureFormat::Rgba16Float, TextureUsages::empty(), bytemuck::cast_slice(&halves), 8);
    let source = upload(gpu, "taa image depth source", size, TextureFormat::R32Float, TextureUsages::empty(), bytemuck::cast_slice(&frame.depth), 4);
    let depth = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("taa image depth"),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TextureFormat::Depth32Float,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    });
    write_depth(gpu, &source.create_view(&Default::default()), &depth.create_view(&Default::default()))?;
    let motion = (!frame.motion.is_empty()).then(|| {
        let halves: Vec<u16> = frame.motion.iter().flat_map(|m| m.map(crate::post::tonemap::f32_to_f16)).collect();
        upload(gpu, "taa image motion", size, crate::motion::MOTION_FORMAT, TextureUsages::empty(), bytemuck::cast_slice(&halves), 4).create_view(&Default::default())
    });
    let reactive = (!frame.reactive.is_empty()).then(|| {
        let bytes: Vec<u8> = frame.reactive.iter().map(|r| (r.clamp(0.0, 1.0) * 255.0).round() as u8).collect();
        upload(gpu, "taa image reactive", size, REACTIVE_FORMAT, TextureUsages::empty(), &bytes, 1).create_view(&Default::default())
    });
    Ok(ImageInputs { scene: scene.create_view(&Default::default()), depth: depth.create_view(&Default::default()), motion, reactive })
}

fn write_depth(gpu: &Gpu, source: &TextureView, target: &TextureView) -> Result<(), RenderError> {
    let device = &gpu.device;
    let module = crate::shaders::module(device, "taa depth upload", DEPTH_UPLOAD)?;
    let texture = wgpu::BindingType::Texture { sample_type: wgpu::TextureSampleType::Float { filterable: false }, view_dimension: wgpu::TextureViewDimension::D2, multisampled: false };
    let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor { label: Some("taa depth upload"), entries: &[fragment_entry(0, texture)] });
    let pipeline = crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some("taa depth upload"),
        layout: Some(&pipeline_layout(device, "taa depth upload", &[&layout])),
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_depth"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs_depth"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: Some("taa depth upload"),
        layout: &layout,
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(source) }],
    });
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taa depth upload") });
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("taa depth upload"),
            color_attachments: &[],
            depth_stencil_attachment: Some(wgpu::RenderPassDepthStencilAttachment {
                view: target,
                depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
                stencil_ops: None,
            }),
            ..Default::default()
        });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    gpu.queue.submit([encoder.finish()]);
    Ok(())
}

fn read_history(gpu: &Gpu, node: &TaaNode, size: (u32, u32)) -> Result<TaaImage, RenderError> {
    let texture = node.written_texture().ok_or_else(|| capture_failed("no resolve was recorded"))?;
    let (width, height) = size;
    let padded = (width * 8).div_ceil(wgpu::COPY_BYTES_PER_ROW_ALIGNMENT) * wgpu::COPY_BYTES_PER_ROW_ALIGNMENT;
    let staging = buffer(&gpu.device, "taa readback", u64::from(padded) * u64::from(height), BufferUsages::MAP_READ | BufferUsages::COPY_DST)?;
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taa readback") });
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(padded), rows_per_image: Some(height) } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let data = map_read_blocking(gpu, &staging, u64::from(padded) * u64::from(height))?;
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (y, x)))
        .map(|(y, x)| {
            let at = (y * padded + x * 8) as usize;
            std::array::from_fn(|c| crate::post::tonemap::f16_to_f32(u16::from_le_bytes([data[at + c * 2], data[at + c * 2 + 1]])))
        })
        .collect();
    Ok(TaaImage { size, texels })
}

/// Resolve `frames` one after another on one history at `size`, reading each resolved frame back:
/// the way to check the resolve's accumulation, clipping and rejection on the GPU. Each frame's
/// row is used as given (its size replaced by `size`); the first frame always starts history over.
pub fn taa_resolve_images(gpu: &Gpu, size: (u32, u32), frames: &[TaaFrameImage]) -> Result<Vec<TaaImage>, RenderError> {
    crate::capture::check_capture_size(size.0, size.1)?;
    let device = &gpu.device;
    let mut node = TaaNode::with_usage(device, &gpu.queue, TextureUsages::COPY_SRC)?;
    let (w, h) = (size.0 as f32, size.1 as f32);
    let mut images = Vec::with_capacity(frames.len());
    for frame in frames {
        let inputs = image_inputs(gpu, size, frame)?;
        let mut row = frame.row;
        row.size = [w, h, 1.0 / w, 1.0 / h];
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taa image") });
        let input = TaaInput { scene: &inputs.scene, depth: &inputs.depth, motion: inputs.motion.as_ref(), reactive: inputs.reactive.as_ref(), render: size, row };
        node.encode(device, &gpu.queue, &mut encoder, input);
        gpu.queue.submit([encoder.finish()]);
        images.push(read_history(gpu, &node, size)?);
    }
    Ok(images)
}

/// Resolves per cost sample: recorded back to back in one submission, so the GPU runs at a
/// frame's clocks rather than idling between samples.
pub const COST_RESOLVES_PER_SAMPLE: u32 = 64;

/// The GPU milliseconds of one resolve at `render` size, one per sample of `frames`, from
/// timestamps around [`COST_RESOLVES_PER_SAMPLE`] resolves; None without `TIMESTAMP_QUERY`. The
/// TAA cost row (plan §2.5: <= 0.3 ms at 1080p).
pub fn taa_gpu_ms(gpu: &Gpu, render: (u32, u32), frames: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let texels = (render.0 * render.1) as usize;
    let image = TaaFrameImage {
        scene: vec![[0.25, 0.2, 0.15, 1.0]; texels],
        depth: vec![0.5; texels],
        motion: vec![[0.001, 0.0]; texels],
        reactive: vec![0.0; texels],
        row: GpuTaaParams::new(&TaaQuality::DEFAULT, &crate::settings::RenderSettings::off().frame_config(render, 1.0, 1, false), [0.0; 2], 1.0),
    };
    let inputs = image_inputs(gpu, render, &image)?;
    let mut node = TaaNode::new(device, &gpu.queue)?;
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("taa cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "taa cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(frames as usize);
    for _ in 0..frames {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taa cost") });
        for k in 0..COST_RESOLVES_PER_SAMPLE {
            let (begin, end) = ((k == 0).then_some(0), (k + 1 == COST_RESOLVES_PER_SAMPLE).then_some(1));
            let stamps = (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites { query_set: &query_set, beginning_of_pass_write_index: begin, end_of_pass_write_index: end });
            let input = TaaInput { scene: &inputs.scene, depth: &inputs.depth, motion: inputs.motion.as_ref(), reactive: inputs.reactive.as_ref(), render, row: image.row };
            node.encode_timed(device, &gpu.queue, &mut encoder, input, stamps);
        }
        gpu.queue.submit([encoder.finish()]);
        // Resolved in a later submission, after the passes': Metal resolves counter samples
        // without waiting for the passes that write them (timing.rs).
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("taa cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = map_read_blocking(gpu, &staging, 16)?;
        let ticks: [u64; 2] = std::array::from_fn(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes")));
        if let Some(ms) = crate::timing::span_ms(ticks[0], ticks[1], period) {
            costs.push(ms / COST_RESOLVES_PER_SAMPLE as f32);
        }
    }
    Ok(Some(costs))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::RenderSettings;

    #[test]
    fn accumulation_starts_whole_and_settles_at_the_floor() {
        assert_eq!(accumulation_weight(0, 0.1), 1.0, "a reset takes the current sample");
        assert_eq!(accumulation_weight(1, 0.1), 0.5);
        assert_eq!(accumulation_weight(3, 0.1), 0.25);
        assert_eq!(accumulation_weight(100, 0.1), 0.1);
        assert_eq!(accumulation_weight(u64::MAX, 0.05), 0.05);
    }

    #[test]
    fn the_row_carries_the_frame_and_holds_a_bad_exposure_ratio() {
        let config = RenderSettings::off().frame_config((200, 100), 1.0, 3, false);
        let row = GpuTaaParams::new(&TaaQuality::DEFAULT, &config, [0.25, -0.25], f32::NAN);
        assert_eq!(row.size, [200.0, 100.0, 0.005, 0.01]);
        assert_eq!(row.jitter, [0.0, 0.0, 0.25, -0.25], "no jitter until TAA lands");
        assert_eq!(row.params, [TaaQuality::DEFAULT.alpha_min, 1.0, DISOCCLUSION_TOLERANCE, MOTION_REJECTION_PER_PX]);
        // RQ5.2 flipped counts.w from reserved (0) to the clip flag, on by default. Renderer pass 2
        // (P2-0.8a) flipped it again (named in the log): the jitter cycle's frames ride above the
        // flags, so a lock lives one cycle.
        let cycle = TaaQuality::DEFAULT.jitter_cycle.frames();
        assert_eq!(row.counts, [3, 0, 0, TaaFlags::CLIP.bits() | cycle << JITTER_CYCLE_SHIFT]);
        assert_eq!(row.jitter_cycle_frames(), cycle);
        assert_eq!(GpuTaaParams::new(&TaaQuality::DEFAULT, &config, [0.0; 2], 2.0).params[1], 2.0);
        let none = row.with_flags(TaaFlags::NONE);
        assert_eq!((none.counts[3] & FLAG_BITS, none.jitter_cycle_frames()), (0, cycle), "flags change, the cycle stays");
        let sixteen = TaaQuality::DEFAULT.with_jitter_cycle(crate::settings::JitterCycle::Sixteen);
        assert_eq!(GpuTaaParams::new(&sixteen, &config, [0.0; 2], 1.0).jitter_cycle_frames(), 16);
    }

    #[test]
    fn a_reset_row_starts_at_frame_zero_with_its_own_jitter_as_the_previous() {
        let mut config = RenderSettings::off().frame_config((64, 64), 1.0, 7, false);
        config.jitter = [0.125, -0.25];
        let row = GpuTaaParams::new(&TaaQuality::DEFAULT, &config, [0.3, 0.3], 1.0);
        assert!(!row.resets());
        let reset = row.reset();
        assert!(reset.resets());
        assert_eq!((reset.counts[0], reset.jitter), (0, [0.125, -0.25, 0.125, -0.25]));
    }

    #[test]
    fn every_history_reset_reason_but_a_scale_step_starts_taa_over() {
        let reasons = [HistoryReset::CameraCut, HistoryReset::Resize, HistoryReset::Settings, HistoryReset::DeviceRecreated, HistoryReset::Rewind, HistoryReset::Capture];
        assert!(reasons.into_iter().all(resets_history));
        // RQ5 review flipped (named in the log): a dynamic-resolution step reprojects the history.
        assert!(!resets_history(HistoryReset::ScaleStep));
    }

    #[test]
    fn the_depth_key_is_zero_at_the_far_plane_under_either_convention() {
        assert_eq!((depth_key(0.0, true), depth_key(1.0, false)), (0.0, 0.0));
        assert_eq!((depth_key(0.25, true), depth_key(0.75, false)), (0.25, 0.25));
    }

    #[test]
    fn the_reactive_row_is_the_jitter_in_ndc_with_the_transparent_coverage() {
        let row = GpuReactiveJitter::new([0.5, 0.25], (100, 50));
        assert_eq!(row.ndc, [0.01, -0.01, TRANSPARENT_COVERAGE, 0.0]);
    }

    /// A transparent row's previous-model entry: still, moved or without history.
    fn prev(flags: u32) -> crate::layout::GpuPrevModel {
        crate::layout::GpuPrevModel { model: IDENTITY, flags: [flags, 0, 0, 0] }
    }

    const fn source(skinned: bool) -> crate::scene::DrawSource {
        crate::scene::DrawSource { skinned, first_index: 0, index_count: 3, base_vertex: 0 }
    }

    /// Renderer pass 2, P2-0.2 (T-01 step 2) flipped "the camera moved" (named in the log): a
    /// still transparent row under a moving camera keeps its history (the camera's reprojection
    /// holds for it), so it writes no coverage; it wrote whole coverage, and the lake's shadows
    /// showed every frame's raw noise while the camera moved (lake box 179 -> 4,724 pixels at high).
    /// Where coverage is needed, it is at most [`TRANSPARENT_COVERAGE`] (0.9, FSR2's reactive cap).
    #[test]
    fn still_transparents_write_no_reactive_coverage_while_the_camera_moves() {
        use crate::motion::{MOTION_FLAG_NO_HISTORY, MOTION_FLAG_STILL};
        let prev_models = [prev(0), prev(MOTION_FLAG_STILL), prev(MOTION_FLAG_STILL | MOTION_FLAG_NO_HISTORY), prev(MOTION_FLAG_STILL)];
        let coverage = |history: bool, rows: &[u32], skinned: bool| {
            let sources: Vec<_> = rows.iter().map(|_| source(skinned)).collect();
            transparent_coverage(&TransparentRows { history, rows, prev_models: &prev_models, sources: &sources })
        };
        let settled = ReactiveCoverage { cap: SETTLED_TRANSPARENT_COVERAGE, by_motion: false };
        let whole = ReactiveCoverage { cap: TRANSPARENT_COVERAGE, by_motion: false };
        assert_eq!(coverage(true, &[1, 3], false), settled, "still rows, whether the camera moved or not");
        assert_eq!(coverage(true, &[], false), settled, "no transparent rows");
        assert_eq!(coverage(false, &[1, 3], false), whole, "no last frame");
        assert_eq!(coverage(true, &[1, 0], false), ReactiveCoverage { cap: TRANSPARENT_COVERAGE, by_motion: true }, "a row moved: its share by its motion");
        assert_eq!(coverage(true, &[1, 2], false), whole, "a row without history");
        assert_eq!(coverage(true, &[1, 9], false), whole, "a row the table does not hold");
        assert_eq!(coverage(true, &[1, 3], true), whole, "a skinned row");
        // A reactive transparent keeps a tenth of its history at least.
        const { assert!(TRANSPARENT_COVERAGE <= 0.9 && TRANSPARENT_COVERAGE > SETTLED_TRANSPARENT_COVERAGE) };
        assert_eq!(GpuReactiveJitter::new([0.5, 0.25], (100, 50)).with_coverage(settled).ndc, [0.01, -0.01, 0.0, 0.0]);
        let moving = GpuReactiveJitter::new([0.5, 0.25], (100, 50)).with_coverage(coverage(true, &[0], false));
        assert_eq!(moving.motion, [100.0, 50.0, REACTIVE_STILL_MOTION_PX, 1.0]);
    }

    /// Renderer pass 2 (P2-0.8a) flipped the ledger (named in the log): each history slot also
    /// holds its rgba8 luma and lock side histories, 8 bytes a texel.
    #[test]
    fn the_history_is_a_pair_and_the_ledger_counts_it_with_its_side_histories_and_the_mask() {
        let [a, b] = history_targets((4, 2));
        assert_ne!(a.label, b.label);
        assert_eq!(reactive_target((0, 0)).size, (1, 1));
        assert_eq!(bytes((4, 2)), 2 * 8 * (8 + 4 + 4) + 8);
        let side = side_history_targets((4, 2));
        assert_eq!(side.map(|desc| desc.format), [LUMA_HISTORY_FORMAT, LUMA_HISTORY_FORMAT, LOCK_FORMAT, LOCK_FORMAT]);
        let labels: std::collections::BTreeSet<_> = side.iter().chain(&[a, b]).map(|desc| desc.label).collect();
        assert_eq!(labels.len(), 6, "every slot is its own target");
        assert!(side.iter().all(|desc| desc.size == (4, 2) && desc.usage == HISTORY_USAGE));
    }
}
