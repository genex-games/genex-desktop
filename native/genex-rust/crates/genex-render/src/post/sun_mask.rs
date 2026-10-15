//! The sun-shadow screen mask (renderer pass 2, B.7, finding SH-04): the sun's soft-shadow
//! visibility made once per pixel after the prepass, accumulated over frames by its own temporal
//! filter and filtered edge-aware, then read by the forward pass instead of evaluating PCSS inline.
//!
//! Before it, the forward pass evaluated PCSS for every opaque fragment with a tap pattern the
//! frame key turned under TAA, and left the noise to the colour TAA: its clip box, made of every
//! lighting term at once, held a shadow edge badly over textured ground, so soft edges boiled on
//! a still camera and popped on pans, orbits and dollies (the Lakeside's D9 rows). The mask is the
//! AAA practice (FidelityFX Shadow Denoiser, MIT, `ffx-shadows-dnsr`, ported to WGSL fragment
//! passes in `shaders/post/sun_mask_denoise.wgsl`):
//!
//! 1. **Visibility** (`shaders/post/sun_mask_visibility.wgsl`, appended to the forward module so
//!    the chunk shades exactly as the forward pass would): `sun_shadow` at the prepass's world
//!    position and normal, its taps turning with the frame key, into [`RAW_LABEL`].
//! 2. **Temporal**: last frame's state along the prepass's motion, depth-checked, clamped to the
//!    3x3 neighbourhood's mean and deviation, blended at [`HISTORY_FLOOR`] (still) or more (moving)
//!    once it is eight frames long, into one of two [`STATE_LABELS`].
//! 3. **Spatial**: one 3x3 a-trous step (one texel apart, two for a history under four frames old)
//!    weighed by the shadow's and the view depth's similarity, the shadow's bounded by the variance
//!    of the accumulated estimate (a converged history is barely filtered), written beside the
//!    contact shadow ([`MASK_LABEL`], `rgba8unorm`: r contact, g the sun's visibility, a 0 marks
//!    the mask).
//!
//! The mask shares the forward frame group's `contact_shadow_mask` slot (binding 19), so it takes
//! no new binding (TIER-AB plan §2: 14 of 16 sampled textures stay). The forward pass reads it only
//! for opaque surfaces of a pipeline whose taps turn under TAA (`GX_SHADOW_TEMPORAL`), and only
//! where the bound texel says it is the mask (alpha 0): the transparent pipeline, a frame without
//! TAA, the contact shadows' own `r8unorm` mask and the neutral white texel all shade the sun inline,
//! as before ([`key`]). It runs in graph node 10a after the contact shadows, on frames that draw
//! them (desktop high and ultra), with PCSS and TAA on the HDR scene; its targets come from the
//! renderer's target pool. A capture starts its history over and Live takes its own back after
//! ([`SunMaskNode::stash_live`]), as AO does.

use glam::Mat4;
use wgpu::{BindGroup, Buffer, BufferUsages, Device, Queue, RenderPipeline, Sampler, Texture, TextureFormat, TextureUsages, TextureView};

use crate::compile::Compiled;
use crate::error::RenderError;
use crate::settings::{Quality, ShadowFilter};
use crate::tables::buffer;
use crate::target_pool::TargetDesc;

/// Whether the forward pass's soft sun shadows come from the screen mask where [`key`] allows it.
pub const LANDED: bool = true;
/// The visibility pass's target: x the visibility, y the view depth (0: sky), z the view depth
/// last frame's camera saw the point at, w the history's depth tolerance there.
pub const RAW_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The temporal state: x the accumulated visibility, y its variance, z the sample count, w the
/// view depth it was made at.
pub const STATE_FORMAT: TextureFormat = TextureFormat::Rgba16Float;
/// The mask the forward pass reads: r the contact shadow, g the sun's visibility, a 0 (the mask's
/// mark).
pub const MASK_FORMAT: TextureFormat = TextureFormat::Rgba8Unorm;
/// The visibility pass's pool label.
pub const RAW_LABEL: &str = "sun mask raw";
/// The two temporal states' pool labels (written in turn: one is last frame's history).
pub const STATE_LABELS: [&str; 2] = ["sun mask state 0", "sun mask state 1"];
/// The mask's pool label (what the forward pass binds).
pub const MASK_LABEL: &str = "sun mask";
/// Every pool label the mask may hold (released when it does not run).
pub const LABELS: [&str; 4] = [RAW_LABEL, STATE_LABELS[0], STATE_LABELS[1], MASK_LABEL];
/// The usages of every target, and the states' copies (the Live stash).
const USAGE: TextureUsages = TextureUsages::RENDER_ATTACHMENT.union(TextureUsages::TEXTURE_BINDING);
const STATE_COPY_USAGE: TextureUsages = TextureUsages::COPY_SRC.union(TextureUsages::COPY_DST);

/// The least weight the current frame takes once a still pixel's history is eight frames long: two
/// fifths of FidelityFX's 0.05 (the rows' still fence flickered a pixel a frame at 0.05; TAA's still
/// pixels take a share of its floor the same way, `post::taa::STILL_ALPHA_SHARE`).
pub const HISTORY_FLOOR: f32 = 0.02;
/// A moving pixel's least current weight (FidelityFX's floor).
pub const MOVING_FLOOR: f32 = 0.05;
/// The current weight each render pixel of motion adds, and the most it reaches: a 2 px a frame
/// pan takes 0.1 (each frame of motion resamples the history bilinearly, and a long history blurs
/// thin far penumbrae as the pan starts).
pub const MOTION_WEIGHT_PER_PX: f32 = 0.05;
/// The most current weight motion raises a pixel to.
pub const MOTION_WEIGHT_MAX: f32 = 0.5;
/// The motion, render pixels a frame, below which a pixel keeps the still floor (the creeping
/// camera's 0.02 px).
pub const STILL_MOTION_PX: f32 = 0.05;
/// The temporal clamp's half width in the 3x3 neighbourhood's standard deviations (FidelityFX's
/// 0.5 is for one ray's hit bit, whose deviation is the whole 0..1; a filtered PCSS visibility's
/// spread is mostly the turning taps' noise, which the clamp must let through to average).
pub const CLAMP_SIGMA: f32 = 1.0;
/// The history's depth tolerance, relative, facing the camera (FidelityFX's).
pub const DEPTH_TOLERANCE_FACING: f32 = 0.01;
/// The history's depth tolerance, relative, edge-on to the camera (FidelityFX's).
pub const DEPTH_TOLERANCE_EDGE_ON: f32 = 0.1;
/// The a-trous depth similarity's scale: relative view depth per step.
pub const DEPTH_SIGMA: f32 = 0.03;
/// The a-trous normal similarity's power (FidelityFX's).
pub const NORMAL_POWER: f32 = 32.0;
/// The least standard deviation the shadow similarity divides by (a converged history's variance
/// falls to nothing, and the edge-stopping would then keep every last LSB of noise).
pub const SHADOW_SIGMA_FLOOR: f32 = 0.01;

/// The pipeline constants the visibility pass shares with the forward pass's sun chunk: the
/// filter, whether the cascades blend and fade, how many the quality draws.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct SunMaskKey {
    /// `GX_SHADOW_FILTER`: PCSS-lite or PCSS.
    pub filter: ShadowFilter,
    /// `GX_SUN_SOFT_EDGES`.
    pub soft_edges: bool,
    /// `GX_SUN_CASCADES`.
    pub cascades: u8,
}

/// Whether the mask runs under `quality` on a frame of the HDR scene (`hdr`) that TAA resolves
/// (`taa`), and with what constants: a soft filter (PCSS-lite or PCSS: the static PCF of the low
/// and medium rows has no noise to average), the prepass, and the contact shadows' node 10a it
/// runs in (desktop high and ultra; phones cap PCSS to 3x3 PCF), unless the degrade ladder's
/// `sun-mask` rung turned `shadows.screen_mask` off. None: the forward pass shades the sun inline.
pub fn key(quality: &Quality, hdr: bool, taa: bool) -> Option<SunMaskKey> {
    let soft = matches!(quality.shadows.filter, ShadowFilter::PcssLite | ShadowFilter::Pcss);
    let frame = LANDED && hdr && taa && quality.prepass;
    let shadows = quality.shadows.enabled && quality.shadows.screen_mask && soft && crate::post::contact_shadow::runs(quality, true);
    (frame && shadows).then_some(SunMaskKey {
        filter: quality.shadows.filter,
        soft_edges: quality.shadows.blend_percent > 0 || quality.shadows.fade_percent > 0,
        cascades: quality.shadows.cascades.clamp(1, crate::layout::MAX_CASCADES as u8),
    })
}

/// Every pooled target of the mask at `render` size.
pub fn targets(render: (u32, u32)) -> Vec<TargetDesc> {
    let size = (render.0.max(1), render.1.max(1));
    let target = |label, format, usage| TargetDesc { label, format, usage, samples: 1, size, mips: 1, srgb_view: false };
    vec![
        target(RAW_LABEL, RAW_FORMAT, USAGE),
        target(STATE_LABELS[0], STATE_FORMAT, USAGE | STATE_COPY_USAGE),
        target(STATE_LABELS[1], STATE_FORMAT, USAGE | STATE_COPY_USAGE),
        target(MASK_LABEL, MASK_FORMAT, USAGE | TextureUsages::COPY_SRC),
    ]
}

/// The mask's bytes at `render` size (the pool's ledger entries): 28 a pixel.
pub fn mask_bytes(render: (u32, u32)) -> u64 {
    targets(render).iter().map(TargetDesc::bytes).sum()
}

/// The visibility module: the forward pass's own source with the mask's row and entry point
/// appended (its group 0 is the forward frame group's; its group 1 the mask's, past `pass_view`).
pub fn visibility_source() -> String {
    format!(
        "{}\n{}\n{}",
        crate::shaders::FORWARD,
        include_str!("../../shaders/post/sun_mask_common.wgsl"),
        include_str!("../../shaders/post/sun_mask_visibility.wgsl")
    )
}

/// The denoise module: the mask's row and the temporal and spatial passes.
pub const DENOISE: &str = concat!(
    include_str!("../../shaders/post/sun_mask_common.wgsl"),
    include_str!("../../shaders/post/sun_mask_denoise.wgsl")
);

/// The mask's uniform (`SunMaskParams` in shaders/post/sun_mask_common.wgsl).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, bytemuck::Pod, bytemuck::Zeroable)]
pub struct GpuSunMaskParams {
    /// This frame's unjittered clip to world.
    pub inv_view_proj: [f32; 16],
    /// World to this frame's view.
    pub view: [f32; 16],
    /// World to last frame's view (this frame's after a reset).
    pub prev_view: [f32; 16],
    /// xy: the render size; zw: 1 / it.
    pub size: [f32; 4],
    /// [`HISTORY_FLOOR`], [`CLAMP_SIGMA`], [`DEPTH_TOLERANCE_FACING`], [`DEPTH_TOLERANCE_EDGE_ON`].
    pub temporal: [f32; 4],
    /// [`DEPTH_SIGMA`], [`NORMAL_POWER`], [`SHADOW_SIGMA_FLOOR`], reserved.
    pub spatial: [f32; 4],
    /// [`MOVING_FLOOR`], [`MOTION_WEIGHT_PER_PX`], [`MOTION_WEIGHT_MAX`], [`STILL_MOTION_PX`].
    pub motion: [f32; 4],
    /// x: 1 under reverse-Z; y: 1 when last frame's state is history; z: 1 when the prepass wrote
    /// motion; w: reserved.
    pub flags: [u32; 4],
}

impl GpuSunMaskParams {
    /// The row for a `render`-sized frame seen through `view` and `proj` (unjittered), last frame
    /// through `prev_view`.
    pub fn new(render: (u32, u32), view: Mat4, proj: Mat4, prev_view: Mat4, reversed: bool, history: bool, motion: bool) -> GpuSunMaskParams {
        let (w, h) = (render.0.max(1) as f32, render.1.max(1) as f32);
        GpuSunMaskParams {
            inv_view_proj: (proj * view).inverse().to_cols_array(),
            view: view.to_cols_array(),
            prev_view: prev_view.to_cols_array(),
            size: [w, h, 1.0 / w, 1.0 / h],
            temporal: [HISTORY_FLOOR, CLAMP_SIGMA, DEPTH_TOLERANCE_FACING, DEPTH_TOLERANCE_EDGE_ON],
            spatial: [DEPTH_SIGMA, NORMAL_POWER, SHADOW_SIGMA_FLOOR, 0.0],
            motion: [MOVING_FLOOR, MOTION_WEIGHT_PER_PX, MOTION_WEIGHT_MAX, STILL_MOTION_PX],
            flags: [u32::from(reversed), u32::from(history), u32::from(motion), 0],
        }
    }
}

/// What [`SunMaskNode::encode`] reads this frame.
pub struct SunMaskInput<'a> {
    /// The prepass depth (render size).
    pub depth: &'a TextureView,
    /// The prepass's octahedral normals.
    pub normals: &'a TextureView,
    /// The prepass's motion (NDC current - previous); None: no history is read.
    pub motion: Option<&'a TextureView>,
    /// The forward frame uniforms (`FrameUniforms`), written for this frame.
    pub frame_uniforms: &'a Buffer,
    /// The sun's cascaded shadow maps, drawn this frame.
    pub shadow_map: &'a TextureView,
    /// The forward pass's comparison sampler.
    pub shadow_sampler: &'a Sampler,
    /// PCSS's blocker sampler (non-filtering).
    pub point_sampler: &'a Sampler,
    /// The contact-shadow mask (render size, or any size: read at the pixel's share).
    pub contact: &'a TextureView,
    /// The render size.
    pub render: (u32, u32),
    /// World to view.
    pub view: Mat4,
    /// The projection the depth was drawn with (unjittered).
    pub proj: Mat4,
    /// Whether depth is reversed.
    pub depth_reversed: bool,
    /// The sun chunk's constants.
    pub key: SunMaskKey,
}

/// A pooled target and its view.
struct Held {
    texture: Texture,
    view: TextureView,
}

impl Held {
    fn pooled(target: &crate::target_pool::PooledTarget) -> Held {
        Held { texture: target.texture().clone(), view: target.view().clone() }
    }
}

struct Targets {
    size: (u32, u32),
    raw: Held,
    states: [Held; 2],
    mask: Held,
}

/// Live's state put aside while a capture draws on the node.
struct LiveStash {
    size: (u32, u32),
    state: Texture,
    parity: usize,
    history: bool,
    prev_view: Option<Mat4>,
    restore: bool,
}

/// The denoise pipelines.
struct Denoise {
    temporal: Compiled<RenderPipeline>,
    compose: Compiled<RenderPipeline>,
}

/// The mask's node (inside graph node 10a). Its targets come from the target pool
/// ([`SunMaskNode::acquire`]); it keeps its history in two of them.
pub struct SunMaskNode {
    visibility_module: wgpu::ShaderModule,
    visibility: Option<(SunMaskKey, Compiled<RenderPipeline>)>,
    denoise: Denoise,
    params: Buffer,
    targets: Option<Targets>,
    /// The state written last frame (history for this one).
    parity: usize,
    /// Whether the state at `parity` is history.
    history: bool,
    /// Last frame's world to view.
    prev_view: Option<Mat4>,
    live_stash: Option<LiveStash>,
}

/// A fullscreen pipeline of `entry` in `module` writing `format`, with `constants`.
fn fullscreen(device: &Device, module: &wgpu::ShaderModule, entry: &str, format: TextureFormat, constants: &[(&str, f64)]) -> Compiled<RenderPipeline> {
    crate::compile::render_pipeline(device, &wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: None,
        vertex: wgpu::VertexState { module, entry_point: Some("vs_sun_mask"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entry),
            compilation_options: wgpu::PipelineCompilationOptions { constants, ..Default::default() },
            targets: &[Some(wgpu::ColorTargetState { format, blend: None, write_mask: wgpu::ColorWrites::ALL })],
        }),
        multiview_mask: None,
        cache: None,
    })
}

/// The visibility pipeline's constants for `key`.
pub fn visibility_constants(key: SunMaskKey) -> [(&'static str, f64); 4] {
    [
        ("GX_SHADOW_FILTER", f64::from(key.filter.shader_id())),
        ("GX_SHADOW_TEMPORAL", 1.0),
        ("GX_SUN_SOFT_EDGES", f64::from(u8::from(key.soft_edges))),
        ("GX_SUN_CASCADES", f64::from(key.cascades)),
    ]
}

fn texture_entry(binding: u32, view: &TextureView) -> wgpu::BindGroupEntry<'_> {
    wgpu::BindGroupEntry { binding, resource: wgpu::BindingResource::TextureView(view) }
}

/// Timestamp writes around some of the node's passes: (query set, stamp the first timed pass's
/// beginning, stamp the last timed pass's end, the passes timed).
type Stamps<'a> = Option<(&'a wgpu::QuerySet, bool, bool, std::ops::Range<u32>)>;

/// The timestamp writes of the node's pass `index` of [`PASSES`] under `stamps`.
fn stamp(stamps: Stamps<'_>, index: u32) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
    let (query_set, first, last, timed) = stamps?;
    let begin = (first && index == timed.start).then_some(0);
    let end = (last && index + 1 == timed.end).then_some(1);
    (begin.is_some() || end.is_some()).then_some(wgpu::RenderPassTimestampWrites { query_set, beginning_of_pass_write_index: begin, end_of_pass_write_index: end })
}

/// One fullscreen pass of `pipeline` with `groups` into `target`.
fn pass(encoder: &mut wgpu::CommandEncoder, label: &str, pipeline: &RenderPipeline, groups: &[&BindGroup], target: &TextureView, timestamp_writes: Option<wgpu::RenderPassTimestampWrites<'_>>) {
    let attachment = wgpu::RenderPassColorAttachment {
        view: target,
        depth_slice: None,
        resolve_target: None,
        ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::WHITE), store: wgpu::StoreOp::Store },
    };
    let descriptor = wgpu::RenderPassDescriptor { label: Some(label), color_attachments: &[Some(attachment)], timestamp_writes, ..Default::default() };
    let mut pass = encoder.begin_render_pass(&descriptor);
    pass.set_pipeline(pipeline);
    for (index, group) in groups.iter().enumerate() {
        pass.set_bind_group(index as u32, *group, &[]);
    }
    pass.draw(0..3, 0..1);
}

/// The full extent of a 2D texture of `size`.
fn extent(size: (u32, u32)) -> wgpu::Extent3d {
    wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 }
}

impl SunMaskNode {
    /// The node, its denoise pipelines compiled; the visibility pipeline comes with the first key.
    pub fn new(device: &Device) -> Result<SunMaskNode, RenderError> {
        let visibility_module = crate::shaders::module(device, "sun mask visibility", &visibility_source())?;
        let module = crate::shaders::module(device, "sun mask denoise", DENOISE)?;
        let denoise = Denoise {
            temporal: fullscreen(device, &module, "fs_sun_mask_temporal", STATE_FORMAT, &[]),
            compose: fullscreen(device, &module, "fs_sun_mask_compose", MASK_FORMAT, &[]),
        };
        let params = buffer(device, "sun mask params", size_of::<GpuSunMaskParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
        Ok(SunMaskNode { visibility_module, visibility: None, denoise, params, targets: None, parity: 0, history: false, prev_view: None, live_stash: None })
    }

    /// Take the mask's targets for a `render`-sized frame from `pool`. A new size starts the
    /// history over (its state was made at another size).
    pub fn acquire(&mut self, device: &Device, pool: &mut crate::target_pool::TargetPool, render: (u32, u32)) -> Result<(), RenderError> {
        let descs = targets(render);
        let mut held = Vec::with_capacity(descs.len());
        for desc in &descs {
            held.push(Held::pooled(pool.acquire(device, *desc)?));
        }
        let [raw, state_0, state_1, mask]: [Held; 4] = held.try_into().map_err(|_| crate::readback::capture_failed("four sun mask targets"))?;
        let size = descs[0].size;
        let same = self.targets.as_ref().is_some_and(|targets| targets.size == size && targets.states[0].texture == state_0.texture && targets.states[1].texture == state_1.texture);
        if !same {
            self.history = false;
        }
        self.targets = Some(Targets { size, raw, states: [state_0, state_1], mask });
        Ok(())
    }

    /// Give the targets back to `pool` (the mask does not run); its history ends.
    pub fn release(&mut self, pool: &mut crate::target_pool::TargetPool) {
        for label in LABELS {
            pool.release(label);
        }
        self.targets = None;
        self.history = false;
    }

    /// The history starts over at the next frame (a camera cut, a capture's first re-render).
    pub fn reset_history(&mut self) {
        self.history = false;
        self.prev_view = None;
    }

    /// Put Live's state aside before a settled capture draws on the node (copied into a texture
    /// kept for the next capture).
    pub fn stash_live(&mut self, device: &Device, queue: &Queue) {
        let Some(targets) = self.targets.as_ref().filter(|_| self.history) else {
            self.live_stash = None;
            return;
        };
        let source = &targets.states[self.parity].texture;
        let fits = self.live_stash.as_ref().is_some_and(|stash| stash.size == targets.size);
        let state = match self.live_stash.take() {
            Some(stash) if fits => stash.state,
            _ => device.create_texture(&wgpu::TextureDescriptor {
                label: Some("sun mask live state (capture)"),
                size: extent(targets.size),
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: STATE_FORMAT,
                usage: STATE_COPY_USAGE,
                view_formats: &[],
            }),
        };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sun mask live stash") });
        encoder.copy_texture_to_texture(source.as_image_copy(), state.as_image_copy(), extent(targets.size));
        queue.submit([encoder.finish()]);
        self.live_stash = Some(LiveStash { size: targets.size, state, parity: self.parity, history: self.history, prev_view: self.prev_view, restore: false });
    }

    /// The capture is over: the next Live frame takes the stashed state back.
    pub fn restore_live(&mut self) {
        if let Some(stash) = self.live_stash.as_mut() {
            stash.restore = true;
        }
    }

    /// Bytes the node holds outside the pool (Live's stashed state).
    pub fn stash_bytes(&self) -> u64 {
        self.live_stash.as_ref().map_or(0, |stash| u64::from(stash.size.0) * u64::from(stash.size.1) * 8)
    }

    /// Copy a restored Live stash back into its state before this frame reads it.
    fn take_back_live(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let Some(targets) = self.targets.as_ref() else { return };
        let Some(stash) = self.live_stash.as_mut().filter(|stash| stash.restore) else { return };
        stash.restore = false;
        if stash.size != targets.size {
            self.history = false;
            return;
        }
        encoder.copy_texture_to_texture(stash.state.as_image_copy(), targets.states[stash.parity].texture.as_image_copy(), extent(stash.size));
        self.parity = stash.parity;
        self.history = stash.history;
        self.prev_view = stash.prev_view;
    }

    /// The visibility pipeline for `key` (rebuilt when the sun chunk's constants change).
    fn visibility(&mut self, device: &Device, key: SunMaskKey) -> Compiled<RenderPipeline> {
        if let Some((held, pipeline)) = &self.visibility
            && *held == key
        {
            return pipeline.clone();
        }
        let pipeline = fullscreen(device, &self.visibility_module, "fs_sun_mask_visibility", RAW_FORMAT, &visibility_constants(key));
        self.visibility = Some((key, pipeline.clone()));
        pipeline
    }

    /// Record the mask's three passes for `input` and return the mask the forward pass binds at its
    /// contact-shadow slot (None when no targets of this size were acquired).
    pub fn encode(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: SunMaskInput<'_>) -> Option<TextureView> {
        self.encode_timed(device, queue, encoder, input, None)
    }

    /// [`SunMaskNode::encode`] with timestamps around its passes: a cost row.
    fn encode_timed(&mut self, device: &Device, queue: &Queue, encoder: &mut wgpu::CommandEncoder, input: SunMaskInput<'_>, stamps: Stamps<'_>) -> Option<TextureView> {
        let size = (input.render.0.max(1), input.render.1.max(1));
        if self.targets.as_ref().is_none_or(|targets| targets.size != size) {
            return None;
        }
        self.take_back_live(encoder);
        let visibility = self.visibility(device, input.key);
        let prev_view = self.prev_view.filter(|_| self.history).unwrap_or(input.view);
        let row = GpuSunMaskParams::new(size, input.view, input.proj, prev_view, input.depth_reversed, self.history, input.motion.is_some());
        queue.write_buffer(&self.params, 0, bytemuck::bytes_of(&row));
        let targets = self.targets.as_ref().expect("checked above");
        let (read, write) = (self.parity, 1 - self.parity);
        let group = |label: &str, pipeline: &RenderPipeline, index: u32, entries: &[wgpu::BindGroupEntry<'_>]| {
            device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some(label), layout: &pipeline.get_bind_group_layout(index), entries })
        };
        let params = crate::tables::entry(0, &self.params);
        // 1. Visibility: the forward frame group's sun bindings, then the mask's.
        let frame = group(
            "sun mask frame",
            &visibility,
            0,
            &[
                crate::tables::entry(0, input.frame_uniforms),
                texture_entry(6, input.shadow_map),
                wgpu::BindGroupEntry { binding: 7, resource: wgpu::BindingResource::Sampler(input.shadow_sampler) },
                wgpu::BindGroupEntry { binding: 18, resource: wgpu::BindingResource::Sampler(input.point_sampler) },
            ],
        );
        let inputs = group("sun mask inputs", &visibility, 1, &[texture_entry(1, input.depth), texture_entry(2, input.normals), crate::tables::entry(3, &self.params)]);
        pass(encoder, "sun mask visibility", &visibility, &[&frame, &inputs], &targets.raw.view, stamp(stamps.clone(), 0));
        // 2. Temporal: last frame's state (the normals stand in as the motion where there is none:
        // the flag keeps it unread).
        let motion = input.motion.unwrap_or(input.normals);
        let temporal = &self.denoise.temporal;
        let entries = [params.clone(), texture_entry(1, &targets.raw.view), texture_entry(3, motion), texture_entry(4, &targets.states[read].view)];
        let temporal_group = group("sun mask temporal", temporal, 0, &entries);
        pass(encoder, "sun mask temporal", temporal, &[&temporal_group], &targets.states[write].view, stamp(stamps.clone(), 1));
        // 3. Spatial: one edge-aware step with the contact shadow into the mask.
        let compose = &self.denoise.compose;
        let entries = [params, texture_entry(5, &targets.states[write].view), texture_entry(7, input.contact)];
        let compose_group = group("sun mask compose", compose, 0, &entries);
        pass(encoder, "sun mask compose", compose, &[&compose_group], &targets.mask.view, stamp(stamps.clone(), 2));
        self.parity = write;
        self.history = true;
        self.prev_view = Some(input.view);
        Some(targets.mask.view.clone())
    }

    /// The mask's texture (a readback's source; None before the first acquire).
    pub fn mask_texture(&self) -> Option<&Texture> {
        self.targets.as_ref().map(|targets| &targets.mask.texture)
    }
}

/// The render passes the node records a frame.
pub const PASSES: u32 = 3;
/// Cost rows record this many nodes back to back per sample (as contact shadows' and AO's: a lone
/// pass after an idle wait pays the GPU's wake-up).
pub const COST_NODES_PER_SAMPLE: u32 = 16;

/// A single-mip 2D texture of `size` cleared by its first pass.
fn cost_texture(device: &Device, label: &str, size: (u32, u32), format: TextureFormat, layers: u32) -> Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some(label),
        size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: layers },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: TextureUsages::RENDER_ATTACHMENT | TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// The GPU milliseconds of the mask's three passes at `render` size, one per sample of `samples`,
/// from timestamps around them; None without `TIMESTAMP_QUERY`. The inputs stand in for a frame:
/// every pixel a receiver at mid depth facing the camera, still, and a frame whose sun casts no
/// shadow (so the visibility pass costs its reads, not PCSS: the forward pass paid PCSS before the
/// mask and pays it no longer). Each sample records [`COST_NODES_PER_SAMPLE`] nodes back to back and
/// reports their mean. The mask's cost row (TIER-AB plan B.7: at most 0.5 ms at 1080p).
pub fn sun_mask_gpu_ms(gpu: &crate::gpu::Gpu, render: (u32, u32), key: SunMaskKey, samples: u32) -> Result<Option<Vec<f32>>, RenderError> {
    let timed = 0..PASSES;
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        return Ok(None);
    }
    let depth = cost_texture(device, "sun mask cost depth", render, crate::renderer::DEPTH_FORMAT, 1).create_view(&Default::default());
    let normals = cost_texture(device, "sun mask cost normals", render, crate::prepass::NORMALS_FORMAT, 1).create_view(&Default::default());
    let shadow = cost_texture(device, "sun mask cost shadow", (1, 1), TextureFormat::Depth32Float, 1);
    let shadow_map = shadow.create_view(&wgpu::TextureViewDescriptor { dimension: Some(wgpu::TextureViewDimension::D2Array), ..Default::default() });
    let contact = cost_texture(device, "sun mask cost contact", (1, 1), TextureFormat::R8Unorm, 1).create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sun mask cost inputs") });
    for (view, depth_value) in [(&depth, Some(0.5)), (&shadow_map, Some(1.0))] {
        let attachment = wgpu::RenderPassDepthStencilAttachment { view, depth_ops: depth_value.map(|d| wgpu::Operations { load: wgpu::LoadOp::Clear(d), store: wgpu::StoreOp::Store }), stencil_ops: None };
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("sun mask cost clear"), depth_stencil_attachment: Some(attachment), ..Default::default() }));
    }
    for (view, value) in [(&normals, wgpu::Color::BLACK), (&contact, wgpu::Color::WHITE)] {
        let attachment = wgpu::RenderPassColorAttachment { view, depth_slice: None, resolve_target: None, ops: wgpu::Operations { load: wgpu::LoadOp::Clear(value), store: wgpu::StoreOp::Store } };
        drop(encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("sun mask cost clear"), color_attachments: &[Some(attachment)], ..Default::default() }));
    }
    gpu.queue.submit([encoder.finish()]);
    let frame_uniforms = buffer(device, "sun mask cost frame", size_of::<crate::layout::GpuFrame>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?;
    let comparison = device.create_sampler(&wgpu::SamplerDescriptor { compare: Some(wgpu::CompareFunction::LessEqual), ..Default::default() });
    let point = device.create_sampler(&wgpu::SamplerDescriptor::default());
    let mut node = SunMaskNode::new(device)?;
    let mut pool = crate::target_pool::TargetPool::new();
    node.acquire(device, &mut pool, render)?;
    let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::new(0.0, 0.0, 5.0), glam::Vec3::ZERO, glam::Vec3::Y);
    let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(1.0, render.0 as f32 / render.1.max(1) as f32, 0.1);
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("sun mask cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
    let resolve = buffer(device, "sun mask cost resolve", 16, BufferUsages::QUERY_RESOLVE | BufferUsages::COPY_SRC)?;
    let period = gpu.queue.get_timestamp_period();
    let mut costs = Vec::with_capacity(samples as usize);
    for _ in 0..samples {
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sun mask cost") });
        for run in 0..COST_NODES_PER_SAMPLE {
            let input = SunMaskInput {
                depth: &depth,
                normals: &normals,
                motion: Some(&normals),
                frame_uniforms: &frame_uniforms,
                shadow_map: &shadow_map,
                shadow_sampler: &comparison,
                point_sampler: &point,
                contact: &contact,
                render,
                view,
                proj,
                depth_reversed: true,
                key,
            };
            node.encode_timed(device, &gpu.queue, &mut encoder, input, Some((&query_set, run == 0, run + 1 == COST_NODES_PER_SAMPLE, timed.clone())));
        }
        gpu.queue.submit([encoder.finish()]);
        device.poll(wgpu::PollType::wait_indefinitely()).map_err(|error| crate::readback::capture_failed(format!("poll: {error}")))?;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("sun mask cost resolve") });
        encoder.resolve_query_set(&query_set, 0..2, &resolve, 0);
        gpu.queue.submit([encoder.finish()]);
        let staging = crate::readback::stage_buffer(gpu, &resolve, 0, 16)?;
        let data = crate::readback::map_read_blocking(gpu, &staging, 16)?;
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
    use crate::device_class::{DeviceClass, FormFactor, PerformanceTier};
    use crate::presets::preset_quality;
    use crate::settings::QualityPreset;

    fn class(form: FormFactor) -> DeviceClass {
        DeviceClass::new(form, PerformanceTier::High)
    }

    #[test]
    fn the_mask_runs_at_desktop_high_and_ultra_under_taa_and_nowhere_else() {
        let high = preset_quality(QualityPreset::High, class(FormFactor::Desktop));
        let ultra = preset_quality(QualityPreset::Ultra, class(FormFactor::Desktop));
        assert_eq!(key(&high, true, true), Some(SunMaskKey { filter: ShadowFilter::PcssLite, soft_edges: true, cascades: 3 }));
        assert_eq!(key(&ultra, true, true).map(|key| (key.filter, key.cascades)), Some((ShadowFilter::Pcss, 4)));
        for preset in [QualityPreset::Low, QualityPreset::Medium] {
            assert_eq!(key(&preset_quality(preset, class(FormFactor::Desktop)), true, true), None, "{preset:?}: static PCF has no noise to average");
        }
        for preset in [QualityPreset::High, QualityPreset::Ultra] {
            assert_eq!(key(&preset_quality(preset, class(FormFactor::Mobile)), true, true), None, "phones cap PCSS");
        }
        assert_eq!(key(&high, true, false), None, "a frame TAA does not resolve shades inline");
        assert_eq!(key(&high, false, true), None, "the legacy LDR scene shades inline");
        let mut off = high;
        off.shadows.enabled = false;
        assert_eq!(key(&off, true, true), None);
        let mut no_contact = high;
        no_contact.contact_shadows = false;
        assert_eq!(key(&no_contact, true, true), None, "the mask runs in node 10a beside the contact shadows");
        assert!(key(&Quality::off(), true, true).is_none());
    }

    #[test]
    fn the_targets_are_render_sized_and_twenty_eight_bytes_a_pixel() {
        let all = targets((1920, 1080));
        assert_eq!(all.iter().map(|t| t.label).collect::<Vec<_>>(), LABELS);
        assert!(all.iter().all(|t| t.size == (1920, 1080) && t.samples == 1));
        assert_eq!(mask_bytes((1920, 1080)), 1920 * 1080 * 28);
        assert_eq!(targets((0, 0))[0].size, (1, 1));
    }

    #[test]
    fn the_row_inverts_the_camera_and_keeps_the_history_flags() {
        let view = glam::camera::rh::view::look_at_mat4(glam::Vec3::new(1.0, 2.0, 3.0), glam::Vec3::ZERO, glam::Vec3::Y);
        let proj = glam::camera::rh::proj::directx::perspective_infinite_reverse(1.0, 2.0, 0.1);
        let row = GpuSunMaskParams::new((8, 4), view, proj, view, true, false, true);
        let round_trip = Mat4::from_cols_array(&row.inv_view_proj) * proj * view;
        assert!(round_trip.abs_diff_eq(Mat4::IDENTITY, 1e-4));
        assert_eq!(row.size, [8.0, 4.0, 0.125, 0.25]);
        assert_eq!(row.flags, [1, 0, 1, 0]);
        assert_eq!(row.temporal, [HISTORY_FLOOR, CLAMP_SIGMA, DEPTH_TOLERANCE_FACING, DEPTH_TOLERANCE_EDGE_ON]);
        assert_eq!(size_of::<GpuSunMaskParams>(), 3 * 64 + 5 * 16);
    }

    #[test]
    fn both_modules_validate_against_webgpu_core() {
        for (name, source) in [("visibility", visibility_source()), ("denoise", DENOISE.to_owned())] {
            let module = naga::front::wgsl::parse_str(&source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(&source)));
            naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
                .validate(&module)
                .unwrap_or_else(|error| panic!("{name}: {error:?}"));
            assert!(source.len() <= crate::WGSL_MAX_BYTES, "{name}: {} bytes", source.len());
        }
    }
}
