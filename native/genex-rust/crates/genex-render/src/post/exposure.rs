//! Exposure (graph node 20): manual EV, or auto exposure from a fixed
//! [`crate::settings::EXPOSURE_HISTOGRAM_BINS`]-bin log-luminance histogram over the HDR scene at
//! the preset's downsample, adapted by a fixed step per simulated tick (never wall time) or at
//! once for settled captures. The state lives in a GPU buffer laid out as
//! [`crate::layout::GpuExposureState`], read only by shaders and never by the Sim; its `exposure`
//! (offset 0) is the exposure the next frame writes its scene with, `GxFrameV2::pre_exposure`.
//!
//! Shaders: [`crate::shaders::EXPOSURE_HISTOGRAM`], [`crate::shaders::EXPOSURE_ADAPT`].
//!
//! # Metering
//!
//! The scene holds pre-exposed radiance (`radiance × pre_exposure`, where `pre_exposure` is the
//! state's `exposure` when the frame began), so the histogram divides it back out. One sample per
//! `exposure_input_divisor`² texel cell (its centre texel, `textureLoad`: no sampler, any float
//! scene format) is weighted by the look's [`Metering`] and counted into the bin of its scene EV,
//! `log2(luminance / 0.18)`, over the look's `ev_min..ev_max` (1/8 EV per bin at the default
//! limits; values outside land in the edge bins, whose centres lie half a bin inside the limits;
//! black, NaN and infinite samples are not counted). Counting uses workgroup `u32` atomics
//! (WebGPU core), so the counts, and everything computed from them, are independent of invocation
//! order; the adaptation reduces them with exact integer prefix sums and a fixed-order tree sum
//! (no invocation loops over the bins). The metered EV is the mean of the bin centres between the
//! [`EXPOSURE_LOW_PERCENTILE`] and [`EXPOSURE_HIGH_PERCENTILE`] of the weighted samples, clamped to
//! `ev_min..=ev_max`; a frame with no counted sample keeps the last target.
//!
//! # Adaptation
//!
//! The adapted EV moves towards the metered one by at most `adaptation_up` (the image brightens)
//! or `adaptation_down` (the image darkens) EV per simulated second, `speed / 60` per tick times
//! the ticks the rendered frame ran ([`crate::pacing::FrameGate`]), so a 120 Hz display adapts as
//! a 60 Hz one does and a frame with no tick does not adapt. It lands exactly on the target once
//! within one step. Instant mode (settled captures, history resets, a new history) sets it to the
//! target at once. The exposure is `2^(ev_compensation - ev)`: a scene twice as bright meters
//! 1 EV higher and is drawn at half the exposure. A change of `ΔEV` therefore settles within
//! [`ticks_to_adapt`] ticks.
//!
//! # Manual exposure
//!
//! Manual EV (and the `exposure` quality switch off: 1.0) writes the state from the CPU when it
//! changes and dispatches nothing; the state's `ev` is set so that switching to auto continues
//! from the same exposure.
//!
//! # Use
//!
//! One [`ExposurePass`] per device; one [`ExposureHistory`] per history set (Live, and a
//! capture-owned one for settled captures). Per frame: [`ExposureHistory::copy_into_frame_v2`]
//! before the scene passes (the frame uniform gets the state's exposure and its inverse), then
//! [`ExposurePass::encode`] after the HDR scene is final (after TAA and the `post-hdr` stage).
//! The params uniform is written with `queue.write_buffer`, so a history is encoded at most once
//! per submission.
//!
//! The exposure a frame meters reaches the picture on the next frame (its pre-exposure); the
//! tonemap divides by nothing. A settled capture with auto exposure therefore renders the metered
//! frame before the one it reads back (instant mode on the first); it re-meters once more at about
//! the final exposure first, since a scene far from the look's initial exposure does not meter
//! right the first time ([`crate::settle::AUTO_EXPOSURE_SETTLE_FRAMES`]).

use crate::compile::Compiled;
use bytemuck::{Pod, Zeroable};
use wgpu::{BindGroup, BindGroupLayout, Buffer, BufferUsages, CommandEncoder, ComputePassTimestampWrites, ComputePipeline, Device, Queue, TextureView};

use crate::error::RenderError;
use crate::layout::GpuExposureState;
use crate::settings::{EXPOSURE_HISTOGRAM_BINS, ExposureMode, Look, Metering, Quality};
use crate::tables::{buffer, compute_storage, compute_uniform, entry, pipeline_layout};

/// The scene luminance auto exposure draws at exposure 1 (EV 0): middle grey.
pub const EXPOSURE_KEY_LUMINANCE: f32 = 0.18;
/// The share of the darkest weighted samples the metered mean leaves out.
pub const EXPOSURE_LOW_PERCENTILE: f32 = 0.10;
/// The share of the weighted samples below the brightest ones the metered mean leaves out.
pub const EXPOSURE_HIGH_PERCENTILE: f32 = 0.90;
/// Simulated ticks per second (genex-core's fixed 60 Hz step): adaptation speeds are EV per
/// second, applied as `speed / TICKS_PER_SECOND` per tick.
pub const TICKS_PER_SECOND: f32 = 60.0;
/// The narrowest EV span the histogram covers (a look with `ev_min == ev_max` still bins).
pub const HISTOGRAM_EV_SPAN_MIN: f32 = 1.0;
/// Scene luminance at or below this counts as black and is not metered (an empty or loading frame
/// holds the exposure instead of snapping to the brightest).
pub const EXPOSURE_BLACK_LUMINANCE: f32 = 1.0e-6;
/// Scene luminance at or above this is not metered (beyond fp16, or infinite).
pub const EXPOSURE_LUMINANCE_MAX: f32 = 1.0e30;
/// Side of the histogram workgroup (`@workgroup_size(16, 16)`): one invocation per input cell.
pub const HISTOGRAM_WORKGROUP_SIDE: u32 = 16;
/// Invocations of the adaptation workgroup: one per bin.
pub const ADAPT_WORKGROUP: u32 = EXPOSURE_HISTOGRAM_BINS;
/// The weight of a sample metered at full weight (average metering, the centre of centre-weighted).
pub const METERING_WEIGHT_MAX: u32 = 16;
/// Spot metering counts the samples within this share of the half diagonal from the centre.
pub const SPOT_RADIUS: f32 = 0.2;
/// [`GpuExposureState::flags`] and [`GpuExposureParams::control`] `w`: adapt instantly.
pub const EXPOSURE_FLAG_INSTANT: u32 = 1;
/// Bytes of the histogram buffer.
pub const HISTOGRAM_BYTES: u64 = EXPOSURE_HISTOGRAM_BINS as u64 * 4;

/// What auto exposure reads besides the histogram (`ExposureParams` in both exposure shaders).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuExposureParams {
    /// x: the EV of bin 0's lower edge; y: bins per EV; z, w: the low and high percentiles.
    pub histogram: [f32; 4],
    /// x: `ev_min`; y: `ev_max`; z: `ev_compensation`; w: unused.
    pub limits: [f32; 4],
    /// x: EV per tick while the image brightens; y: EV per tick while it darkens; z, w: unused.
    pub speed: [f32; 4],
    /// x: input divisor; y: metering id ([`metering_id`]); z: ticks this frame; w: flags
    /// ([`EXPOSURE_FLAG_INSTANT`]).
    pub control: [u32; 4],
}

/// The exposure a frame's scene is written with and its inverse (`PreExposure` in
/// `exposure_adapt.wgsl`): the same order as `GxFrameV2::pre_exposure` and `inv_pre_exposure`, so
/// one 8-byte copy fills both.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuPreExposure {
    /// The exposure.
    pub pre_exposure: f32,
    /// `1 / pre_exposure`.
    pub inv_pre_exposure: f32,
}

impl GpuPreExposure {
    /// The pair for `exposure`.
    pub fn of(exposure: f32) -> GpuPreExposure {
        GpuPreExposure { pre_exposure: exposure, inv_pre_exposure: 1.0 / exposure }
    }
}

/// Where a frame's exposure comes from.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ExposureSource {
    /// A fixed multiplier: the look's manual EV, or 1.0 with the `exposure` quality switch off.
    Fixed(f32),
    /// Metered and adapted on the GPU.
    Auto,
}

/// The exposure source of `look` under `quality`.
pub fn exposure_source(look: &Look, quality: &Quality) -> ExposureSource {
    if !quality.exposure {
        return ExposureSource::Fixed(1.0);
    }
    match look.exposure {
        ExposureMode::Manual => ExposureSource::Fixed(look.manual_exposure()),
        ExposureMode::Auto => ExposureSource::Auto,
    }
}

/// The shader's id of `metering` (`control.y`).
pub const fn metering_id(metering: Metering) -> u32 {
    match metering {
        Metering::Average => 0,
        Metering::Center => 1,
        Metering::Spot => 2,
    }
}

impl GpuExposureParams {
    /// The params of one auto exposure frame: `look`'s limits and speeds, the input `divisor`
    /// (at least 1), the `ticks` the frame ran and whether it adapts instantly.
    pub fn new(look: &Look, divisor: u8, ticks: u32, instant: bool) -> GpuExposureParams {
        let span = (look.ev_max - look.ev_min).max(HISTOGRAM_EV_SPAN_MIN);
        let flags = if instant { EXPOSURE_FLAG_INSTANT } else { 0 };
        GpuExposureParams {
            histogram: [look.ev_min, EXPOSURE_HISTOGRAM_BINS as f32 / span, EXPOSURE_LOW_PERCENTILE, EXPOSURE_HIGH_PERCENTILE],
            limits: [look.ev_min, look.ev_max, look.ev_compensation, 0.0],
            speed: [look.adaptation_up / TICKS_PER_SECOND, look.adaptation_down / TICKS_PER_SECOND, 0.0, 0.0],
            control: [u32::from(divisor.max(1)), metering_id(look.metering), ticks, flags],
        }
    }

    /// The input divisor.
    pub fn divisor(&self) -> u32 {
        self.control[0].max(1)
    }
}

/// Simulated ticks auto exposure needs to move `delta_ev` (positive: the scene got brighter) at
/// `look`'s speeds: the documented settle time of a change, `ceil(|ΔEV| × 60 / speed)` plus one
/// tick, because the f32 sum of the per-tick steps can fall a few ulps short of the target on the
/// last full step. `u32::MAX` when the speed is 0 (it never adapts).
pub fn ticks_to_adapt(delta_ev: f32, look: &Look) -> u32 {
    let speed = if delta_ev > 0.0 { look.adaptation_down } else { look.adaptation_up };
    if delta_ev == 0.0 {
        return 0;
    }
    if speed <= 0.0 {
        return u32::MAX;
    }
    libm::ceilf(delta_ev.abs() * TICKS_PER_SECOND / speed) as u32 + 1
}

/// The exposure multiplier of adapted scene EV `ev`: `2^(compensation - ev)`.
pub fn exposure_of_ev(ev: f32, compensation: f32) -> f32 {
    libm::exp2f(compensation - ev)
}

// --- CPU reference: the shaders' arithmetic, expression for expression ---

/// The Rec. 709 luminance of linear `rgb`.
pub fn luminance(rgb: [f32; 3]) -> f32 {
    rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}

/// The histogram bin of a sample of scene `luminance` (pre-exposure divided out), or `None` when
/// it is not metered (black, NaN or infinite).
pub fn histogram_bin(luminance: f32, params: &GpuExposureParams) -> Option<u32> {
    let metered = luminance > EXPOSURE_BLACK_LUMINANCE && luminance < EXPOSURE_LUMINANCE_MAX;
    if !metered {
        return None;
    }
    let ev = libm::log2f(luminance / EXPOSURE_KEY_LUMINANCE);
    let at = libm::floorf((ev - params.histogram[0]) * params.histogram[1]);
    Some(at.clamp(0.0, (EXPOSURE_HISTOGRAM_BINS - 1) as f32) as u32)
}

/// The weight of a sample at `uv` (0..1 over the scene) under metering `id`.
pub fn metering_weight(id: u32, uv: [f32; 2]) -> u32 {
    let d = [uv[0] * 2.0 - 1.0, uv[1] * 2.0 - 1.0];
    let r2 = (d[0] * d[0] + d[1] * d[1]) * 0.5;
    match id {
        1 => 1 + libm::floorf(15.0 * (1.0 - r2).max(0.0)) as u32,
        2 if r2 <= SPOT_RADIUS * SPOT_RADIUS => METERING_WEIGHT_MAX,
        2 => 0,
        _ => METERING_WEIGHT_MAX,
    }
}

/// The input cells (samples) of a `size` scene at `divisor`, per side.
pub fn input_cells(size: (u32, u32), divisor: u32) -> (u32, u32) {
    (size.0.div_ceil(divisor.max(1)), size.1.div_ceil(divisor.max(1)))
}

/// The scene texel cell `(x, y)` samples: its centre, clamped into the scene.
pub fn cell_texel(cell: (u32, u32), size: (u32, u32), divisor: u32) -> (u32, u32) {
    let half = divisor / 2;
    ((cell.0 * divisor + half).min(size.0.saturating_sub(1)), (cell.1 * divisor + half).min(size.1.saturating_sub(1)))
}

/// The histogram the GPU counts over `scene` (row-major linear rgb, pre-exposed by
/// `pre_exposure`) of `size`.
pub fn cpu_histogram(scene: &[[f32; 3]], size: (u32, u32), pre_exposure: f32, params: &GpuExposureParams) -> [u32; 128] {
    let mut bins = [0u32; 128];
    let divisor = params.divisor();
    let inv_exposure = 1.0 / pre_exposure;
    let (cols, rows) = input_cells(size, divisor);
    for cy in 0..rows {
        for cx in 0..cols {
            let (x, y) = cell_texel((cx, cy), size, divisor);
            let texel = scene[(y * size.0 + x) as usize];
            let uv = [(x as f32 + 0.5) / size.0 as f32, (y as f32 + 0.5) / size.1 as f32];
            let weight = metering_weight(params.control[1], uv);
            if let Some(bin) = histogram_bin(luminance(texel) * inv_exposure, params) {
                bins[bin as usize] += weight;
            }
        }
    }
    bins
}

/// The metered scene EV of `bins`: the percentile-trimmed mean of the bin centres, clamped to the
/// look's limits; `None` when nothing was counted. Sums in the shader's order: exact integer prefix
/// sums, then a tree sum of the shares where bin `i` adds bin `i + stride` for strides 64..1.
pub fn meter_ev(bins: &[u32; 128], params: &GpuExposureParams) -> Option<f32> {
    let mut prefix = [0u32; 128];
    let mut running = 0u32;
    for (slot, &count) in prefix.iter_mut().zip(bins) {
        running = running.wrapping_add(count);
        *slot = running;
    }
    let total = running as f32;
    let (low, high) = (total * params.histogram[2], total * params.histogram[3]);
    let mut sums = [[0.0_f32; 2]; 128];
    for (bin, sum) in sums.iter_mut().enumerate() {
        let count = bins[bin];
        let below = (prefix[bin] - count) as f32;
        let share = ((below + count as f32).min(high) - below.max(low)).max(0.0);
        let centre = params.histogram[0] + (bin as f32 + 0.5) * (1.0 / params.histogram[1]);
        *sum = [share * centre, share];
    }
    let mut stride = sums.len() / 2;
    while stride > 0 {
        for bin in 0..stride {
            sums[bin] = [sums[bin][0] + sums[bin + stride][0], sums[bin][1] + sums[bin + stride][1]];
        }
        stride /= 2;
    }
    let kept = sums[0];
    if total <= 0.0 || kept[1] <= 0.0 {
        return None;
    }
    Some((kept[0] / kept[1]).max(params.limits[0]).min(params.limits[1]))
}

/// The adapted EV one frame after `ev` with target `target`, under `params` (ticks, speeds, instant).
pub fn adapt_ev(ev: f32, target: f32, params: &GpuExposureParams) -> f32 {
    if params.control[3] & EXPOSURE_FLAG_INSTANT != 0 {
        return target;
    }
    let ticks = params.control[2] as f32;
    let (up, down) = (params.speed[0] * ticks, params.speed[1] * ticks);
    ev + (target - ev).max(-up).min(down)
}

// --- GPU ---

/// What one frame's exposure node reads.
pub struct ExposureInput<'a> {
    /// The final HDR scene (1x, after the MSAA resolve, TAA and `post-hdr`), pre-exposed.
    pub scene: &'a TextureView,
    /// Its size in texels.
    pub scene_size: (u32, u32),
    /// The game's look.
    pub look: &'a Look,
    /// The preset's quality (`exposure` switch, `exposure_input_divisor`).
    pub quality: &'a Quality,
    /// Simulated ticks the frame ran (0 for a stale re-render: no adaptation).
    pub ticks: u32,
    /// Adapt at once (a settled capture).
    pub instant: bool,
    /// The node's timestamps (`GpuTimer::compute_writes`), when timed.
    pub timestamp_writes: Option<ComputePassTimestampWrites<'a>>,
}

/// What [`ExposurePass::encode`] did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExposureRun {
    /// A fixed exposure: nothing dispatched (the state was written only if it changed).
    Fixed,
    /// One compute pass: the histogram and the adaptation.
    Metered,
}

/// One history set's exposure buffers (Live, or a capture's own).
pub struct ExposureHistory {
    state: Buffer,
    pre_exposure: Buffer,
    histogram: Buffer,
    params: Buffer,
    /// The fixed exposure last written from the CPU (bits), `None` after a metered frame.
    fixed_written: Option<u32>,
    /// The next metered frame adapts instantly.
    instant_pending: bool,
    /// The histogram's bind group and the scene view it reads (rebuilt when the view is replaced:
    /// a scale step or a new target).
    histogram_group: Option<(TextureView, BindGroup)>,
    /// The adaptation's bind group (this history's own buffers: made once).
    adapt_group: Option<BindGroup>,
}

impl ExposureHistory {
    /// Buffers starting at `look`'s manual exposure, with the first metered frame adapting at once.
    pub fn new(device: &Device, queue: &Queue, look: &Look) -> Result<ExposureHistory, RenderError> {
        let readable = BufferUsages::STORAGE | BufferUsages::COPY_DST | BufferUsages::COPY_SRC;
        let history = ExposureHistory {
            state: buffer(device, "exposure state", size_of::<GpuExposureState>() as u64, readable)?,
            pre_exposure: buffer(device, "pre-exposure", size_of::<GpuPreExposure>() as u64, readable)?,
            histogram: buffer(device, "exposure histogram", HISTOGRAM_BYTES, readable)?,
            params: buffer(device, "exposure params", size_of::<GpuExposureParams>() as u64, BufferUsages::UNIFORM | BufferUsages::COPY_DST)?,
            fixed_written: None,
            instant_pending: true,
            histogram_group: None,
            adapt_group: None,
        };
        let exposure = look.manual_exposure();
        let state = GpuExposureState { exposure, ev: 0.0, target_ev: 0.0, flags: EXPOSURE_FLAG_INSTANT };
        queue.write_buffer(&history.state, 0, bytemuck::bytes_of(&state));
        queue.write_buffer(&history.pre_exposure, 0, bytemuck::bytes_of(&GpuPreExposure::of(exposure)));
        Ok(history)
    }

    /// The next metered frame adapts at once (a camera cut, a device re-creation, a capture).
    pub fn reset(&mut self) {
        self.instant_pending = true;
    }

    /// The state buffer ([`GpuExposureState`]; `exposure` at offset 0).
    pub fn state_buffer(&self) -> &Buffer {
        &self.state
    }

    /// The histogram buffer (128 `u32` counts of the last metered frame).
    pub fn histogram_buffer(&self) -> &Buffer {
        &self.histogram
    }

    /// The pre-exposure buffer ([`GpuPreExposure`]).
    pub fn pre_exposure_buffer(&self) -> &Buffer {
        &self.pre_exposure
    }

    /// Copy the exposure and its inverse into a `GxFrameV2` uniform (`frame`, `COPY_DST`) at
    /// [`crate::abi::GX_FRAME_V2_PRE_EXPOSURE_OFFSET`]: encode before the scene passes, after the
    /// frame uniform's `queue.write_buffer`.
    pub fn copy_into_frame_v2(&self, encoder: &mut CommandEncoder, frame: &Buffer) {
        let bytes = size_of::<GpuPreExposure>() as u64;
        encoder.copy_buffer_to_buffer(&self.pre_exposure, 0, frame, crate::abi::GX_FRAME_V2_PRE_EXPOSURE_OFFSET, bytes);
    }

    /// Copy the exposure alone (4 bytes) into `target` at `offset` (`GxPostV2::pre_exposure`, an
    /// L3 pass's uniform).
    pub fn copy_exposure_to(&self, encoder: &mut CommandEncoder, target: &Buffer, offset: u64) {
        encoder.copy_buffer_to_buffer(&self.pre_exposure, 0, target, offset, 4);
    }

    fn write_fixed(&mut self, queue: &Queue, exposure: f32, compensation: f32) {
        if self.fixed_written == Some(exposure.to_bits()) {
            return;
        }
        // The EV auto exposure would hold this exposure at, so a switch to auto starts here.
        let ev = compensation - libm::log2f(exposure);
        let state = GpuExposureState { exposure, ev, target_ev: ev, flags: 0 };
        queue.write_buffer(&self.state, 0, bytemuck::bytes_of(&state));
        queue.write_buffer(&self.pre_exposure, 0, bytemuck::bytes_of(&GpuPreExposure::of(exposure)));
        self.fixed_written = Some(exposure.to_bits());
        // The state now holds an exposure to continue from: a later switch to auto adapts from it.
        self.instant_pending = false;
    }
}

/// The exposure node's pipelines (one per device).
pub struct ExposurePass {
    histogram_layout: BindGroupLayout,
    adapt_layout: BindGroupLayout,
    histogram: Compiled<ComputePipeline>,
    adapt: Compiled<ComputePipeline>,
}

fn scene_texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            // Unfilterable: `textureLoad` only, so any float scene format binds.
            sample_type: wgpu::TextureSampleType::Float { filterable: false },
            view_dimension: wgpu::TextureViewDimension::D2,
            multisampled: false,
        },
        count: None,
    }
}

fn compute_pipeline(device: &Device, label: &str, source: &str, entry_point: &str, layout: &BindGroupLayout) -> Result<Compiled<ComputePipeline>, RenderError> {
    let module = crate::shaders::module(device, label, source)?;
    let pipeline_layout = pipeline_layout(device, label, &[layout]);
    Ok(crate::compile::compute_pipeline(device, &wgpu::ComputePipelineDescriptor {
        label: Some(label),
        layout: Some(&pipeline_layout),
        module: &module,
        entry_point: Some(entry_point),
        compilation_options: Default::default(),
        cache: None,
    }))
}

impl ExposurePass {
    /// The histogram and adaptation pipelines.
    pub fn new(device: &Device) -> Result<ExposurePass, RenderError> {
        let histogram_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("exposure histogram"),
            entries: &[scene_texture_entry(0), compute_storage(1, false), compute_uniform(2), compute_storage(3, true)],
        });
        let adapt_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("exposure adapt"),
            entries: &[compute_storage(0, false), compute_storage(1, true), compute_uniform(2), compute_storage(3, false)],
        });
        let histogram =
            compute_pipeline(device, "exposure histogram", crate::shaders::EXPOSURE_HISTOGRAM, "cs_exposure_histogram", &histogram_layout)?;
        let adapt = compute_pipeline(device, "exposure adapt", crate::shaders::EXPOSURE_ADAPT, "cs_exposure_adapt", &adapt_layout)?;
        Ok(ExposurePass { histogram_layout, adapt_layout, histogram, adapt })
    }

    /// Encode the node: a fixed exposure writes the state when it changed; auto exposure clears the
    /// histogram, counts the scene and adapts the state (one compute pass, two dispatches).
    pub fn encode(&self, device: &Device, queue: &Queue, encoder: &mut CommandEncoder, history: &mut ExposureHistory, input: ExposureInput<'_>) -> ExposureRun {
        if let ExposureSource::Fixed(exposure) = exposure_source(input.look, input.quality) {
            history.write_fixed(queue, exposure, input.look.ev_compensation);
            return ExposureRun::Fixed;
        }
        history.fixed_written = None;
        let instant = input.instant || history.instant_pending;
        history.instant_pending = false;
        let params = GpuExposureParams::new(input.look, input.quality.exposure_input_divisor, input.ticks, instant);
        queue.write_buffer(&history.params, 0, bytemuck::bytes_of(&params));
        encoder.clear_buffer(&history.histogram, 0, None);
        let (histogram_group, adapt_group) = self.groups(device, history, input.scene);
        let (cols, rows) = input_cells(input.scene_size, params.divisor());
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("exposure"), timestamp_writes: input.timestamp_writes });
        pass.set_pipeline(&self.histogram);
        pass.set_bind_group(0, &histogram_group, &[]);
        pass.dispatch_workgroups(cols.div_ceil(HISTOGRAM_WORKGROUP_SIDE), rows.div_ceil(HISTOGRAM_WORKGROUP_SIDE), 1);
        // Each dispatch is its own usage scope: the adaptation sees every count.
        pass.set_pipeline(&self.adapt);
        pass.set_bind_group(0, &adapt_group, &[]);
        pass.dispatch_workgroups(1, 1, 1);
        ExposureRun::Metered
    }

    /// `history`'s bind groups over `scene`, made once and kept until the scene view is replaced
    /// (no bind group is created per frame).
    fn groups(&self, device: &Device, history: &mut ExposureHistory, scene: &TextureView) -> (BindGroup, BindGroup) {
        let histogram = match &history.histogram_group {
            Some((held, group)) if held == scene => group.clone(),
            _ => {
                let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                    label: Some("exposure histogram"),
                    layout: &self.histogram_layout,
                    entries: &[
                        wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(scene) },
                        entry(1, &history.histogram),
                        entry(2, &history.params),
                        entry(3, &history.state),
                    ],
                });
                history.histogram_group = Some((scene.clone(), group.clone()));
                group
            }
        };
        let adapt = history.adapt_group.get_or_insert_with(|| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: Some("exposure adapt"),
                layout: &self.adapt_layout,
                entries: &[entry(0, &history.state), entry(1, &history.histogram), entry(2, &history.params), entry(3, &history.pre_exposure)],
            })
        });
        (histogram, adapt.clone())
    }
}
