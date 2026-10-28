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
//! `exposure_input_divisor`² texel cell, the mean radiance of the cell's centred block of at most
//! [`CELL_SIDE_MAX`]² texels (every texel of a 4² or 8² cell, the centre 8² of a 16² cell), read as
//! one bilinear tap at the shared corner of each 2² of it (4 taps on high, 16 on medium and low;
//! the HDR scene formats filter in WebGPU core), so a lantern or a glint counts wherever it falls in
//! its cell instead of only on the centre texel, and a panning camera meters a steady EV (P2-0.10,
//! C3). It is weighted by the look's [`Metering`] at the cell's centre and counted into the bin of its scene EV,
//! `log2(luminance / 0.18)`, over the look's `ev_min..ev_max` (1/8 EV per bin at the default
//! limits; values outside land in the edge bins, whose centres lie half a bin inside the limits;
//! black, NaN and infinite samples are not counted). Counting uses workgroup `u32` atomics
//! (WebGPU core), so the counts, and everything computed from them, are independent of invocation
//! order; the adaptation reduces them with exact integer prefix sums and a fixed-order tree sum
//! (no invocation loops over the bins). The metered EV is the mean of the bin centres between the
//! [`EXPOSURE_LOW_PERCENTILE`] and [`EXPOSURE_HIGH_PERCENTILE`] of the weighted samples, clamped to
//! `ev_min..=ev_max`. The target the exposure adapts towards is that EV minus the look's
//! [`crate::settings::CompensationCurve`] at it ([`aim_ev`]); a frame with no counted sample keeps
//! the last target.
//!
//! # Adaptation
//!
//! The adapted EV moves towards the target by at most `adaptation_up` (the image brightens) or
//! `adaptation_down` (the image darkens) EV per simulated second, one step of `speed / 60` for each
//! tick the rendered frame ran ([`crate::pacing::FrameGate`]), so a 120 Hz or a 30 Hz display adapts
//! as a 60 Hz one does and a frame with no tick does not adapt. Within the look's
//! `adaptation_transition` EV of the target the step is the remaining distance times
//! `speed / transition` (Bevy 0.20's hybrid adaptation, `auto_exposure.wesl`, MIT OR Apache-2.0):
//! linear far away, exponential near, so the small target changes of a moving camera no longer make
//! the frame breathe. It snaps onto the target once within [`ADAPT_SNAP_EV`]. Instant mode (settled
//! captures, history resets, a new history) sets it to the target at once; a frame that counts
//! nothing (a black boot frame) keeps the exposure and leaves instant mode to the next frame that
//! does. The exposure is `2^(ev_compensation - ev)`: a scene twice as bright meters
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

/// The widest side of the texel block one histogram sample averages (a 16² cell meters its centre
/// 8²).
pub const CELL_SIDE_MAX: u32 = 8;
/// The adapted EV snaps onto the target once this close (a settled exposure is a fixed point).
pub const ADAPT_SNAP_EV: f32 = 1.0e-4;
/// The most simulated ticks one frame adapts by (ten seconds: a frame after a longer stall lands
/// where ten seconds would have taken it).
pub const ADAPT_TICKS_PER_FRAME_MAX: u32 = 600;
/// The most ticks [`ticks_to_adapt`] simulates before it calls a change one that never settles.
const ADAPT_TICKS_MAX: u32 = 1_000_000;

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
/// How many times faster auto exposure adapts just after the camera crosses into or out of a room
/// a game declares (an irradiance volume's or a reflection probe's box): stepping from a sunlit
/// yard into a corridor, the eye adjusts in a moment instead of the picture sitting dark for
/// seconds ([`RoomAdaptation`]).
pub const ROOM_ADAPT_BOOST: f32 = 8.0;
/// Simulated ticks the boost lasts after a crossing (half a second).
pub const ROOM_ADAPT_TICKS: u32 = 30;
/// The histogram's bilinear sampler binding (clamped to the edge: the edge texel repeats).
pub const HISTOGRAM_SAMPLER_BINDING: u32 = 4;
/// Bytes of the histogram buffer.
pub const HISTOGRAM_BYTES: u64 = EXPOSURE_HISTOGRAM_BINS as u64 * 4;

/// What auto exposure reads besides the histogram (`ExposureParams` in both exposure shaders).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Pod, Zeroable)]
pub struct GpuExposureParams {
    /// x: the EV of bin 0's lower edge; y: bins per EV; z, w: the low and high percentiles.
    pub histogram: [f32; 4],
    /// x: `ev_min`; y: `ev_max`; z: `ev_compensation`; w: the compensation curve's points.
    pub limits: [f32; 4],
    /// x: EV per tick while the image brightens; y: EV per tick while it darkens; z: the
    /// exponential transition in EV (0: linear); w: unused.
    pub speed: [f32; 4],
    /// x: input divisor; y: metering id ([`metering_id`]); z: ticks this frame; w: flags
    /// ([`EXPOSURE_FLAG_INSTANT`]).
    pub control: [u32; 4],
    /// The look's compensation curve ([`crate::settings::CompensationCurve`]): its points as
    /// (metered EV, compensation EV) pairs, two a row (xy, zw), in EV order; `limits.w` is how many.
    pub curve: [[f32; 4]; 4],
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
        Metering::Ground => 3,
    }
}

impl GpuExposureParams {
    /// The params of one auto exposure frame: `look`'s limits and speeds, the input `divisor`
    /// (at least 1), the `ticks` the frame ran and whether it adapts instantly.
    pub fn new(look: &Look, divisor: u8, ticks: u32, instant: bool) -> GpuExposureParams {
        let span = (look.ev_max - look.ev_min).max(HISTOGRAM_EV_SPAN_MIN);
        let flags = if instant { EXPOSURE_FLAG_INSTANT } else { 0 };
        let points = look.compensation_curve.points();
        let mut curve = [[0.0; 4]; 4];
        for (i, point) in points.iter().enumerate() {
            curve[i / 2][(i % 2) * 2] = point[0];
            curve[i / 2][(i % 2) * 2 + 1] = point[1];
        }
        GpuExposureParams {
            histogram: [look.ev_min, EXPOSURE_HISTOGRAM_BINS as f32 / span, EXPOSURE_LOW_PERCENTILE, EXPOSURE_HIGH_PERCENTILE],
            limits: [look.ev_min, look.ev_max, look.ev_compensation, points.len() as f32],
            speed: [look.adaptation_up / TICKS_PER_SECOND, look.adaptation_down / TICKS_PER_SECOND, look.adaptation_transition, 0.0],
            control: [u32::from(divisor.max(1)), metering_id(look.metering), ticks, flags],
            curve,
        }
    }

    /// The input divisor.
    pub fn divisor(&self) -> u32 {
        self.control[0].max(1)
    }

    /// The params adapting `boost` times faster both ways ([`RoomAdaptation`]; 1: as they are).
    pub fn boosted(mut self, boost: f32) -> GpuExposureParams {
        self.speed[0] *= boost;
        self.speed[1] *= boost;
        self
    }
}

/// The rooms around the camera at `eye`: one bit per declared irradiance volume (bits 0..32) and
/// reflection probe (bits 32..64) whose box holds it, in declaration order.
pub fn rooms_around(eye: [f32; 3], volumes: &[crate::irradiance::IrradianceVolume], probes: &[crate::probes::ReflectionProbe]) -> u64 {
    let inside = |min: [f32; 3], max: [f32; 3]| (0..3).all(|axis| eye[axis] >= min[axis].min(max[axis]) && eye[axis] <= min[axis].max(max[axis]));
    let volume_bits = volumes.iter().take(32).enumerate().filter(|(_, volume)| inside(volume.min, volume.max)).fold(0, |bits, (i, _)| bits | (1u64 << i));
    let probe_bits = probes.iter().take(32).enumerate().filter(|(_, probe)| inside(probe.min, probe.max)).fold(0, |bits, (i, _)| bits | (1u64 << (32 + i)));
    volume_bits | probe_bits
}

/// Auto exposure's quick adjustment at a doorway: when the rooms around the camera change, Live
/// frames adapt [`ROOM_ADAPT_BOOST`] times faster for [`ROOM_ADAPT_TICKS`] simulated ticks, so the
/// exposure meets the room the camera stepped into (or the yard it stepped out to) at once.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoomAdaptation {
    /// The rooms around the camera on the last frame ([`rooms_around`]; None before the first).
    inside: Option<u64>,
    /// Ticks the boost still lasts.
    left: u32,
}

impl RoomAdaptation {
    /// The speed multiplier of a frame that ran `ticks` with the camera in `rooms`: the boost from
    /// the frame that crosses until its ticks run out, else 1.
    pub fn step(&mut self, rooms: u64, ticks: u32) -> f32 {
        if self.inside.is_some_and(|before| before != rooms) {
            self.left = ROOM_ADAPT_TICKS;
        }
        self.inside = Some(rooms);
        if self.left == 0 {
            return 1.0;
        }
        self.left = self.left.saturating_sub(ticks);
        ROOM_ADAPT_BOOST
    }
}

/// Simulated ticks auto exposure needs to move `delta_ev` (positive: the scene got brighter) at
/// `look`'s speeds and transition, landing exactly on the target: the documented settle time of a
/// change, counted by stepping [`adapt_ev`] itself (about `(|ΔEV| - transition) × 60 / speed` linear
/// ticks, then `ln(transition / ADAPT_SNAP_EV) × 60 × transition / speed` exponential ones).
/// `u32::MAX` when the speed is 0 (it never adapts).
pub fn ticks_to_adapt(delta_ev: f32, look: &Look) -> u32 {
    let speed = if delta_ev > 0.0 { look.adaptation_down } else { look.adaptation_up };
    if delta_ev == 0.0 {
        return 0;
    }
    if speed <= 0.0 {
        return u32::MAX;
    }
    let tick = GpuExposureParams::new(look, 1, 1, false);
    let mut ev = 0.0;
    let mut ticks = 0;
    while ev != delta_ev && ticks < ADAPT_TICKS_MAX {
        ev = adapt_ev(ev, delta_ev, &tick);
        ticks += 1;
    }
    if ev == delta_ev { ticks } else { u32::MAX }
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

/// The weight of a sample at `uv` (0..1 over the scene, y down) under metering `id`.
pub fn metering_weight(id: u32, uv: [f32; 2]) -> u32 {
    let d = [uv[0] * 2.0 - 1.0, uv[1] * 2.0 - 1.0];
    let r2 = (d[0] * d[0] + d[1] * d[1]) * 0.5;
    match id {
        1 => 1 + libm::floorf(15.0 * (1.0 - r2).max(0.0)) as u32,
        2 if r2 <= SPOT_RADIUS * SPOT_RADIUS => METERING_WEIGHT_MAX,
        2 => 0,
        3 => 1 + libm::floorf(15.0 * uv[1].clamp(0.0, 1.0)) as u32,
        _ => METERING_WEIGHT_MAX,
    }
}

/// The input cells (samples) of a `size` scene at `divisor`, per side.
pub fn input_cells(size: (u32, u32), divisor: u32) -> (u32, u32) {
    (size.0.div_ceil(divisor.max(1)), size.1.div_ceil(divisor.max(1)))
}

/// The scene texel at cell `(x, y)`'s centre, clamped into the scene: where its metering weight is
/// taken.
pub fn cell_texel(cell: (u32, u32), size: (u32, u32), divisor: u32) -> (u32, u32) {
    let half = divisor / 2;
    ((cell.0 * divisor + half).min(size.0.saturating_sub(1)), (cell.1 * divisor + half).min(size.1.saturating_sub(1)))
}

/// The mean of cell `(x, y)`'s centred block of `min(divisor, CELL_SIDE_MAX)`² texels of `scene`
/// (row-major, `size`), each texel clamped into the scene, in the shader's order: each 2² averaged
/// (the bilinear tap at its shared corner), the taps summed row by row. The GPU's filter weights
/// are exact at a corner; its filtering precision may differ in the last bits.
pub fn cell_mean(scene: &[[f32; 3]], size: (u32, u32), cell: (u32, u32), divisor: u32) -> [f32; 3] {
    let side = divisor.clamp(1, CELL_SIDE_MAX);
    let extent = side.min(2);
    let taps = side / extent;
    let start = (cell.0 * divisor + (divisor - side) / 2, cell.1 * divisor + (divisor - side) / 2);
    let texel = |x: u32, y: u32| scene[(y.min(size.1.saturating_sub(1)) * size.0 + x.min(size.0.saturating_sub(1))) as usize];
    let mut sum = [0.0f32; 3];
    for ty in 0..taps {
        for tx in 0..taps {
            let (x, y) = (start.0 + tx * extent, start.1 + ty * extent);
            let block = [texel(x, y), texel(x + extent - 1, y), texel(x, y + extent - 1), texel(x + extent - 1, y + extent - 1)];
            let tap: [f32; 3] = std::array::from_fn(|c| (block[0][c] + block[1][c] + block[2][c] + block[3][c]) * 0.25);
            sum = [sum[0] + tap[0], sum[1] + tap[1], sum[2] + tap[2]];
        }
    }
    let count = (taps * taps) as f32;
    sum.map(|c| c / count)
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
            let texel = cell_mean(scene, size, (cx, cy), divisor);
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

/// The compensation of `params`' curve at metered scene EV `ev` (the adaptation shader's
/// `gx_compensation`: [`crate::settings::CompensationCurve::at`] over the uniform's rows).
pub fn curve_compensation(ev: f32, params: &GpuExposureParams) -> f32 {
    let count = params.limits[3] as usize;
    let point = |i: usize| [params.curve[i / 2][(i % 2) * 2], params.curve[i / 2][(i % 2) * 2 + 1]];
    if count == 0 {
        return 0.0;
    }
    let (first, last) = (point(0), point(count - 1));
    if ev <= first[0] {
        return first[1];
    }
    if ev >= last[0] {
        return last[1];
    }
    let upper = (1..count).find(|&i| ev < point(i)[0]).unwrap_or(count - 1);
    let (a, b) = (point(upper - 1), point(upper));
    a[1] + (b[1] - a[1]) * ((ev - a[0]) / (b[0] - a[0]))
}

/// The EV the exposure aims at for metered scene EV `metered` under `params`: the metered EV less
/// the compensation curve's EV at it, so the exposure `2^(ev_compensation - ev)` adds that
/// compensation once adapted.
pub fn aim_ev(metered: f32, params: &GpuExposureParams) -> f32 {
    metered - curve_compensation(metered, params)
}

/// The adapted EV one frame after `ev` with target `target`, under `params` (ticks, speeds,
/// transition, instant): one [`adapt_tick`] per simulated tick the frame ran (at most
/// [`ADAPT_TICKS_PER_FRAME_MAX`]), so a 30 Hz device adapts as a 60 Hz one does.
pub fn adapt_ev(ev: f32, target: f32, params: &GpuExposureParams) -> f32 {
    if params.control[3] & EXPOSURE_FLAG_INSTANT != 0 {
        return target;
    }
    let ticks = params.control[2].min(ADAPT_TICKS_PER_FRAME_MAX);
    (0..ticks).fold(ev, |ev, _| adapt_tick(ev, target, params))
}

/// One simulated tick's step from `ev` towards `target`: linear (`speed` EV a tick) beyond the
/// transition, `distance × speed / transition` within it, never past the target (a speed boosted
/// past the transition, the doorway's, would otherwise overshoot and ring), snapped onto the
/// target within [`ADAPT_SNAP_EV`].
pub fn adapt_tick(ev: f32, target: f32, params: &GpuExposureParams) -> f32 {
    let (up, down) = (params.speed[0], params.speed[1]);
    let delta = target - ev;
    let transition = params.speed[2];
    let step = match (transition > 0.0, delta > 0.0) {
        (false, _) => delta.max(-up).min(down),
        (true, true) => down.min(delta * down / transition).min(delta),
        (true, false) => (-up).max(delta * up / transition).max(delta),
    };
    let next = ev + step;
    if (target - next).abs() < ADAPT_SNAP_EV { target } else { next }
}

// --- Telemetry (AAA review WP-5: `state().__render.exposure`) ---

/// Bins of the telemetry's histogram (`EXPOSURE_TELEMETRY_BINS` in `src/shared/render-look.ts`):
/// the GPU's [`EXPOSURE_HISTOGRAM_BINS`] summed in runs of eight.
pub const TELEMETRY_BINS: usize = 16;
/// Live frames between two read-backs of the exposure state and histogram.
pub const READBACK_EVERY: u32 = 4;
/// Staging buffers in flight at most (a frame whose slot is still mapped skips its read-back).
const READBACK_RING: usize = 2;
/// Bytes of one read-back: the state, then the histogram.
const READBACK_BYTES: u64 = size_of::<GpuExposureState>() as u64 + HISTOGRAM_BYTES;

/// What the engine warns about a look's exposure (`ExposureWarning` in the contract). Wire values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExposureWarning {
    /// `ev_min` is raised above [`crate::settings::DEFAULT_EV_MIN`] with doorway adaptation on: a
    /// dark room meters at the floor, so the exposure stops brightening and the room stays dark.
    EvMinRaisedWithDoorwayAdaptation,
    /// Doorway adaptation is on under manual exposure, where nothing adapts.
    DoorwayAdaptationUnderManual,
}

impl ExposureWarning {
    /// Its wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ExposureWarning::EvMinRaisedWithDoorwayAdaptation => "ev-min-raised-with-doorway-adaptation",
            ExposureWarning::DoorwayAdaptationUnderManual => "doorway-adaptation-under-manual",
        }
    }
}

/// What `look` deserves a warning for.
pub fn exposure_warnings(look: &Look) -> Vec<ExposureWarning> {
    if !look.doorway_adaptation {
        return Vec::new();
    }
    match look.exposure {
        ExposureMode::Manual => vec![ExposureWarning::DoorwayAdaptationUnderManual],
        ExposureMode::Auto if look.ev_min > crate::settings::DEFAULT_EV_MIN => vec![ExposureWarning::EvMinRaisedWithDoorwayAdaptation],
        ExposureMode::Auto => Vec::new(),
    }
}

/// One read-back of an exposure history: its state and histogram after a frame, the doorway boost
/// that frame adapted at and the frame's number.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ExposureReading {
    /// The history's state.
    pub state: GpuExposureState,
    /// The metered frame's histogram.
    pub bins: [u32; EXPOSURE_HISTOGRAM_BINS as usize],
    /// The doorway boost the frame adapted at (1: none).
    pub boost: f32,
    /// The frame it was taken after.
    pub frame: u64,
}

/// What the exposure metered and drew (`ExposureTelemetry` in the contract).
#[derive(Clone, Debug, PartialEq)]
pub struct ExposureTelemetry {
    /// Auto exposure metered the frame (false: a fixed exposure).
    pub auto: bool,
    /// The scene EV metered; `None` under a fixed exposure or before the first read-back.
    pub metered_ev: Option<f32>,
    /// The EV it adapts towards; `None` as `metered_ev`.
    pub target_ev: Option<f32>,
    /// The EV the frame was drawn at: exposure `2^(compensation - applied_ev)`.
    pub applied_ev: f32,
    /// The look's `ev_compensation`.
    pub compensation: f32,
    /// The look's metering floor.
    pub ev_min: f32,
    /// The look's metering ceiling (at least a span of [`HISTOGRAM_EV_SPAN_MIN`] over the floor).
    pub ev_max: f32,
    /// [`TELEMETRY_BINS`] shares summing to 1 over `ev_min..ev_max`; empty without a metered sample.
    pub histogram: Vec<f32>,
    /// Whether that frame adapted at the doorway boost.
    pub doorway_boost: bool,
    /// Frames between the read-back and the frame described.
    pub age_frames: u64,
    /// The frame the read-back was taken after (`None` before the first, or under a fixed
    /// exposure): a new value is a new reading.
    pub reading: Option<u64>,
    /// What the look deserves a warning for.
    pub warnings: Vec<ExposureWarning>,
}

/// The telemetry of frame `frame` drawn with `look` from `source`, from the latest `reading` of
/// its history (auto exposure only).
pub fn exposure_telemetry(look: &Look, source: ExposureSource, reading: Option<&ExposureReading>, frame: u64) -> ExposureTelemetry {
    let span = (look.ev_max - look.ev_min).max(HISTOGRAM_EV_SPAN_MIN);
    let base = ExposureTelemetry {
        auto: source == ExposureSource::Auto,
        metered_ev: None,
        target_ev: None,
        applied_ev: 0.0,
        compensation: look.ev_compensation,
        ev_min: look.ev_min,
        ev_max: look.ev_min + span,
        histogram: Vec::new(),
        doorway_boost: false,
        age_frames: 0,
        reading: None,
        warnings: exposure_warnings(look),
    };
    let reading = match source {
        ExposureSource::Fixed(exposure) => return ExposureTelemetry { applied_ev: look.ev_compensation - libm::log2f(exposure.max(f32::MIN_POSITIVE)), ..base },
        ExposureSource::Auto => reading,
    };
    let Some(reading) = reading else { return base };
    let params = GpuExposureParams::new(look, 1, 1, false);
    let metered = meter_ev(&reading.bins, &params);
    ExposureTelemetry {
        metered_ev: metered,
        target_ev: metered.map(|_| reading.state.target_ev),
        applied_ev: reading.state.ev,
        histogram: telemetry_bins(&reading.bins),
        doorway_boost: reading.boost > 1.0,
        age_frames: frame.saturating_sub(reading.frame),
        reading: Some(reading.frame),
        ..base
    }
}

/// The GPU's bins summed into [`TELEMETRY_BINS`] shares of their total; empty when it is 0.
pub fn telemetry_bins(bins: &[u32; EXPOSURE_HISTOGRAM_BINS as usize]) -> Vec<f32> {
    let total: u64 = bins.iter().map(|&count| u64::from(count)).sum();
    if total == 0 {
        return Vec::new();
    }
    let run = bins.len() / TELEMETRY_BINS;
    bins.chunks_exact(run).map(|chunk| (chunk.iter().map(|&count| u64::from(count)).sum::<u64>() as f64 / total as f64) as f32).collect()
}

/// One staging buffer of the read-back ring.
struct ReadbackSlot {
    buffer: Buffer,
    ready: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The boost and frame of the copy in flight; `None` when free.
    pending: Option<(f32, u64)>,
}

/// The exposure state and histogram copied back from the GPU a few frames late, never stalling a
/// Live frame (the occlusion feedback's ring); a settled capture waits for its own.
pub struct ExposureReadback {
    slots: Vec<ReadbackSlot>,
    next: usize,
    latest: Option<ExposureReading>,
}

impl ExposureReadback {
    /// An empty ring on `device`.
    pub fn new(device: &Device) -> Result<ExposureReadback, RenderError> {
        let slots = (0..READBACK_RING)
            .map(|_| {
                Ok(ReadbackSlot {
                    buffer: buffer(device, "exposure readback", READBACK_BYTES, BufferUsages::MAP_READ | BufferUsages::COPY_DST)?,
                    ready: std::sync::Arc::default(),
                    pending: None,
                })
            })
            .collect::<Result<Vec<_>, RenderError>>()?;
        Ok(ExposureReadback { slots, next: 0, latest: None })
    }

    /// Copy `history`'s state and histogram after frame `frame` (adapted at `boost`) in a
    /// submission of its own and map them; `wait` blocks until they are read (a settled capture).
    /// A frame whose slot is still in flight skips its read-back.
    pub fn read_back(&mut self, device: &Device, queue: &Queue, history: &ExposureHistory, boost: f32, frame: u64, wait: bool) {
        let slot = &mut self.slots[self.next];
        if slot.pending.is_some() {
            return;
        }
        self.next = (self.next + 1) % READBACK_RING;
        let state_bytes = size_of::<GpuExposureState>() as u64;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("exposure readback") });
        encoder.copy_buffer_to_buffer(&history.state, 0, &slot.buffer, 0, state_bytes);
        encoder.copy_buffer_to_buffer(&history.histogram, 0, &slot.buffer, state_bytes, HISTOGRAM_BYTES);
        queue.submit([encoder.finish()]);
        slot.pending = Some((boost, frame));
        slot.ready.store(false, std::sync::atomic::Ordering::SeqCst);
        let ready = std::sync::Arc::clone(&slot.ready);
        slot.buffer.slice(..).map_async(wgpu::MapMode::Read, move |result| ready.store(result.is_ok(), std::sync::atomic::Ordering::SeqCst));
        if wait {
            let _ = device.poll(wgpu::PollType::wait_indefinitely());
        }
        self.take(device);
    }

    /// Read every copy that came back, keeping the newest.
    pub fn take(&mut self, device: &Device) {
        let _ = device.poll(wgpu::PollType::Poll);
        for slot in &mut self.slots {
            let Some((boost, frame)) = slot.pending.filter(|_| slot.ready.load(std::sync::atomic::Ordering::SeqCst)) else { continue };
            let words: Vec<u32> = match slot.buffer.slice(..).get_mapped_range() {
                Ok(range) => bytemuck::pod_collect_to_vec(&range[..]),
                Err(_) => Vec::new(),
            };
            slot.buffer.unmap();
            slot.pending = None;
            let Some(reading) = reading_of(&words, boost, frame) else { continue };
            if self.latest.is_none_or(|latest| latest.frame <= frame) {
                self.latest = Some(reading);
            }
        }
    }

    /// The newest reading.
    pub fn latest(&self) -> Option<&ExposureReading> {
        self.latest.as_ref()
    }
}

/// A reading from a read-back's words: the state's four, then the bins.
fn reading_of(words: &[u32], boost: f32, frame: u64) -> Option<ExposureReading> {
    let (state, bins) = (words.get(..4)?, words.get(4..4 + EXPOSURE_HISTOGRAM_BINS as usize)?);
    let state = GpuExposureState { exposure: f32::from_bits(state[0]), ev: f32::from_bits(state[1]), target_ev: f32::from_bits(state[2]), flags: state[3] };
    Some(ExposureReading { state, bins: bins.try_into().ok()?, boost, frame })
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
    /// How many times faster than the look's speeds the frame adapts ([`RoomAdaptation`]; 1: as
    /// the look says).
    pub boost: f32,
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
    /// The cell mean's bilinear sampler, clamped to the edge.
    sampler: wgpu::Sampler,
}

fn scene_texture_entry(binding: u32) -> wgpu::BindGroupLayoutEntry {
    wgpu::BindGroupLayoutEntry {
        binding,
        visibility: wgpu::ShaderStages::COMPUTE,
        ty: wgpu::BindingType::Texture {
            // Filterable: the cell mean reads bilinear taps (rgba16float and rg11b10ufloat filter
            // in core).
            sample_type: wgpu::TextureSampleType::Float { filterable: true },
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
        // A8.6: the histogram and the adaptation write their workgroup arrays first.
        compilation_options: crate::compile::written_first(),
        cache: None,
    }))
}

impl ExposurePass {
    /// The histogram and adaptation pipelines.
    pub fn new(device: &Device) -> Result<ExposurePass, RenderError> {
        let histogram_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("exposure histogram"),
            entries: &[
                scene_texture_entry(0),
                compute_storage(1, false),
                compute_uniform(2),
                compute_storage(3, true),
                wgpu::BindGroupLayoutEntry {
                    binding: HISTOGRAM_SAMPLER_BINDING,
                    visibility: wgpu::ShaderStages::COMPUTE,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let adapt_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("exposure adapt"),
            entries: &[compute_storage(0, false), compute_storage(1, true), compute_uniform(2), compute_storage(3, false)],
        });
        let histogram =
            compute_pipeline(device, "exposure histogram", crate::shaders::EXPOSURE_HISTOGRAM, "cs_exposure_histogram", &histogram_layout)?;
        let adapt = compute_pipeline(device, "exposure adapt", crate::shaders::EXPOSURE_ADAPT, "cs_exposure_adapt", &adapt_layout)?;
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("exposure cells"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            ..Default::default()
        });
        Ok(ExposurePass { histogram_layout, adapt_layout, histogram, adapt, sampler })
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
        let params = GpuExposureParams::new(input.look, input.quality.exposure_input_divisor, input.ticks, instant).boosted(input.boost);
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
                        wgpu::BindGroupEntry { binding: HISTOGRAM_SAMPLER_BINDING, resource: wgpu::BindingResource::Sampler(&self.sampler) },
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crossing_into_a_room_adapts_faster_for_half_a_second() {
        use crate::irradiance::IrradianceVolume;
        let room = [IrradianceVolume::new([0.0, 0.0, 0.0], [4.0, 3.0, 10.0])];
        let (yard, corridor) = ([-2.0, 1.6, 5.0], [1.0, 1.6, 5.0]);
        assert_eq!(rooms_around(yard, &room, &[]), 0);
        assert_eq!(rooms_around(corridor, &room, &[]), 1);
        let mut adaptation = RoomAdaptation::default();
        assert_eq!(adaptation.step(0, 1), 1.0, "the first frame has nothing to cross from");
        assert_eq!(adaptation.step(0, 1), 1.0);
        let boosted: Vec<f32> = (0..ROOM_ADAPT_TICKS + 2).map(|_| adaptation.step(1, 1)).collect();
        assert!(boosted[..ROOM_ADAPT_TICKS as usize].iter().all(|boost| *boost == ROOM_ADAPT_BOOST), "{boosted:?}");
        assert_eq!(boosted[ROOM_ADAPT_TICKS as usize], 1.0, "half a second later the look's speeds again");
        assert_eq!(adaptation.step(0, 1), ROOM_ADAPT_BOOST, "stepping back out to the yard boosts too");
    }

    #[test]
    fn warnings_name_a_raised_floor_under_doorway_adaptation_and_doorway_adaptation_under_manual() {
        let auto = Look { exposure: ExposureMode::Auto, ..Look::default() };
        let none: [ExposureWarning; 0] = [];
        assert_eq!(exposure_warnings(&auto), none, "the template's look");
        assert_eq!(exposure_warnings(&Look { ev_min: -2.5, ..auto }), [ExposureWarning::EvMinRaisedWithDoorwayAdaptation], "gen3's light facet");
        assert_eq!(exposure_warnings(&Look { ev_min: -2.5, doorway_adaptation: false, ..auto }), none);
        assert_eq!(exposure_warnings(&Look { ev_min: -12.0, ..auto }), none, "a lower floor is fine");
        assert_eq!(exposure_warnings(&Look::default()), [ExposureWarning::DoorwayAdaptationUnderManual], "the engine default is manual");
        assert_eq!(ExposureWarning::EvMinRaisedWithDoorwayAdaptation.wire(), "ev-min-raised-with-doorway-adaptation");
        assert_eq!(ExposureWarning::DoorwayAdaptationUnderManual.wire(), "doorway-adaptation-under-manual");
    }

    #[test]
    fn telemetry_reads_the_metered_target_and_applied_ev_and_sums_the_bins_to_sixteen_shares() {
        let look = Look { exposure: ExposureMode::Auto, ev_compensation: 0.5, ..Look::default() };
        let manual = exposure_telemetry(&Look { ev_compensation: 1.0, ..Look::default() }, ExposureSource::Fixed(2.0), None, 9);
        assert_eq!((manual.auto, manual.metered_ev, manual.applied_ev, manual.histogram.len()), (false, None, 0.0, 0), "manual +1 EV draws at 2x: EV 0");
        let unread = exposure_telemetry(&look, ExposureSource::Auto, None, 3);
        assert_eq!((unread.auto, unread.metered_ev, unread.target_ev), (true, None, None));
        // Every weighted sample in the bin of scene EV -2 (bins of 1/8 EV over -8..8: bin 48).
        let mut bins = [0u32; EXPOSURE_HISTOGRAM_BINS as usize];
        bins[48] = 1600;
        let reading = ExposureReading { state: GpuExposureState { exposure: 1.0, ev: -1.5, target_ev: -1.9375, flags: 0 }, bins, boost: ROOM_ADAPT_BOOST, frame: 7 };
        let read = exposure_telemetry(&look, ExposureSource::Auto, Some(&reading), 9);
        assert_eq!(read.metered_ev, Some(-1.9375), "the bin's centre");
        assert_eq!((read.target_ev, read.applied_ev, read.age_frames, read.doorway_boost), (Some(-1.9375), -1.5, 2, true));
        assert_eq!(read.histogram.len(), TELEMETRY_BINS);
        assert_eq!(read.histogram[6], 1.0, "bin 48 is the seventh run of eight");
        assert_eq!(read.histogram.iter().sum::<f32>(), 1.0);
        assert_eq!((read.ev_min, read.ev_max, read.compensation), (-8.0, 8.0, 0.5));
        let words: Vec<u32> = [1.0_f32.to_bits(), (-1.5_f32).to_bits(), (-1.9375_f32).to_bits(), 0].into_iter().chain(bins).collect();
        assert_eq!(reading_of(&words, ROOM_ADAPT_BOOST, 7), Some(reading), "the read-back's layout: state, then bins");
        assert_eq!(reading_of(&words[..10], 1.0, 0), None);
    }

    /// Doorway adaptation under the template's auto exposure (AAA review WP-5): the 8x boost puts
    /// a tick's speed past the look's transition, where the exponential step (`distance × speed /
    /// transition`) overshot the target each tick, and a fast look (20 EV/s) rang around it at full
    /// speed instead of landing. Every step now stops at the target: stepping into a corridor 5 EV
    /// under the yard, the EV falls monotonically, never passes the target, and is within 1 EV of it
    /// half a second after the crossing.
    #[test]
    fn a_boosted_or_fast_adaptation_never_passes_its_target() {
        let fast = Look { adaptation_up: crate::settings::ADAPTATION_SPEED_MAX, adaptation_down: crate::settings::ADAPTATION_SPEED_MAX, ..Look::default() };
        for (name, look) in [("default", Look::default()), ("fastest", fast)] {
            for target in [-5.0_f32, 5.0] {
                let params = GpuExposureParams::new(&look, 1, 1, false).boosted(ROOM_ADAPT_BOOST);
                let mut ev = 0.0_f32;
                let mut path = vec![ev];
                for _ in 0..ROOM_ADAPT_TICKS {
                    let next = adapt_tick(ev, target, &params);
                    assert!((target - next) * target.signum() >= 0.0, "{name} towards {target}: passed the target at {next} ({path:?})");
                    assert!((next - ev) * target.signum() >= 0.0, "{name} towards {target}: turned back at {next}");
                    ev = next;
                    path.push(ev);
                }
                assert!((target - ev).abs() <= 1.0, "{name} towards {target}: {ev} half a second after the crossing");
            }
        }
    }

    #[test]
    fn the_default_look_brightens_faster_than_it_darkens_and_a_boost_scales_both() {
        let look = Look::default();
        assert!(look.adaptation_up > look.adaptation_down, "brightening (into a room) is the faster way");
        // A corridor 5 EV under the yard: within half an EV after 69 ticks of linear steps, landed
        // exactly (the exponential tail's last 1e-4 EV included) within two and a half seconds.
        assert!(ticks_to_adapt(-5.0, &look) <= 150, "{} ticks", ticks_to_adapt(-5.0, &look));
        assert!(ticks_to_adapt(-5.0, &look) < ticks_to_adapt(5.0, &look));
        let params = GpuExposureParams::new(&look, 1, 1, false);
        let boosted = params.boosted(ROOM_ADAPT_BOOST);
        assert_eq!((boosted.speed[0], boosted.speed[1]), (params.speed[0] * ROOM_ADAPT_BOOST, params.speed[1] * ROOM_ADAPT_BOOST));
        assert_eq!(params.boosted(1.0), params);
    }
}
