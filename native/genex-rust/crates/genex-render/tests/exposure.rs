//! Auto and manual exposure (graph node 20, RQ1.2). CPU rows hold the reference arithmetic, the
//! tick model and the shaders' core limits; real-GPU rows (`#[ignore]`d, every name contains
//! `metal`) hold the GPU node to the reference:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked -- --ignored metal
//!
//! The GPU rows stand in for the renderer's loop: each frame writes a fixed radiance image times
//! the state's current exposure (the scene's pre-exposure) into an `rgba16float` scene, then
//! encodes the node and reads the state back.

use genex_core::clock::FIXED_STEP_MS;
use genex_render::Gpu;
use genex_render::abi::{GX_FRAME_V2_PRE_EXPOSURE_OFFSET, GxFrameV2};
use genex_render::layout::GpuExposureState;
use genex_render::pacing::{FrameAction, FrameGate, FramePacer};
use genex_render::post::exposure::{
    EXPOSURE_FLAG_INSTANT, EXPOSURE_KEY_LUMINANCE, ExposureHistory, ExposureInput, ExposurePass, ExposureRun, ExposureSource, GpuExposureParams,
    GpuPreExposure, TICKS_PER_SECOND, adapt_ev, aim_ev, cpu_histogram, exposure_of_ev, exposure_source, meter_ev, metering_id, metering_weight,
    ticks_to_adapt,
};
use genex_render::settings::{CompensationCurve, EXPOSURE_HISTOGRAM_BINS, ExposureMode, Look, Metering, Quality};
use genex_render::shaders::{EXPOSURE_ADAPT, EXPOSURE_HISTOGRAM};
use naga::proc::Layouter;

const WIDTH: u32 = 320;
const HEIGHT: u32 = 180;
/// Bins per EV of the default look (`-8..8` over 128 bins).
const BINS_PER_EV: f32 = 8.0;
/// WebGPU core's `maxComputeWorkgroupStorageSize`, which the plan holds the histogram to.
const WORKGROUP_BYTES_MAX: u32 = 16 * 1024;

fn auto_look() -> Look {
    let mut look = Look::default();
    look.exposure = ExposureMode::Auto;
    look
}

fn quality(divisor: u8) -> Quality {
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.exposure = true;
    quality.exposure_input_divisor = divisor;
    quality
}

/// The scene EV at the centre of default-look bin `bin`.
fn bin_centre_ev(bin: u32) -> f32 {
    -8.0 + (bin as f32 + 0.5) / BINS_PER_EV
}

/// A grey radiance image whose every texel's EV is a bin centre (bins 40..90), constant over each
/// 16² block so every metered cell averages one value: fp16 rounding and GPU `log2` never move a
/// sample across a bin edge.
fn binned_scene() -> Vec<[f32; 3]> {
    (0..HEIGHT)
        .flat_map(|y| (0..WIDTH).map(move |x| 40 + ((x / 16) * 7 + (y / 16) * 13) % 50))
        .map(|bin| {
            let l = EXPOSURE_KEY_LUMINANCE * libm::exp2f(bin_centre_ev(bin));
            [l, l, l]
        })
        .collect()
}

/// A smooth horizontal ramp from EV -2 to +2 with a vertical tint: the same mean at any sampling.
fn ramp_scene() -> Vec<[f32; 3]> {
    (0..HEIGHT)
        .flat_map(|y| {
            (0..WIDTH).map(move |x| {
                let ev = -2.0 + 4.0 * (x as f32 + 0.5) / WIDTH as f32;
                let l = EXPOSURE_KEY_LUMINANCE * libm::exp2f(ev);
                [l * (0.8 + 0.4 * y as f32 / HEIGHT as f32), l, l]
            })
        })
        .collect()
}

/// A hash of `(x, y)` in `0..1` (a fixed integer mix: the same texture on every run).
fn hash01(x: u32, y: u32) -> f32 {
    let mut h = x.wrapping_mul(0x8da6_b343) ^ y.wrapping_mul(0xd816_3841) ^ 0x9e37_79b9;
    h ^= h >> 15;
    h = h.wrapping_mul(0x2c1b_3c6d);
    h ^= h >> 12;
    (h >> 8) as f32 / (1u32 << 24) as f32
}

/// A wide world of fine detail: every texel's EV is spread over ±2 EV around middle grey (grass,
/// bark, gravel at a texel each), with one texel in 97 a small light 5 EV up (a lantern, a glint).
fn detailed_world(x: u32, y: u32) -> [f32; 3] {
    let lantern = hash01(x ^ 0x55, y) < 1.0 / 97.0;
    let ev = if lantern { 5.0 } else { -2.0 + 4.0 * hash01(x, y) };
    let l = EXPOSURE_KEY_LUMINANCE * libm::exp2f(ev);
    [l, l, l]
}

/// A `size` view of [`detailed_world`] panned `offset` texels to the right.
fn panned(size: (u32, u32), offset: u32) -> Vec<[f32; 3]> {
    (0..size.1).flat_map(|y| (0..size.0).map(move |x| detailed_world(x + offset, y))).collect()
}

/// The population standard deviation of `values`.
fn std_dev(values: &[f32]) -> f32 {
    let n = values.len() as f32;
    let mean = values.iter().sum::<f32>() / n;
    libm::sqrtf(values.iter().map(|v| (v - mean) * (v - mean)).sum::<f32>() / n)
}

fn doubled(scene: &[[f32; 3]]) -> Vec<[f32; 3]> {
    scene.iter().map(|c| [c[0] * 2.0, c[1] * 2.0, c[2] * 2.0]).collect()
}

// --- CPU rows ---

#[test]
fn ticks_per_second_is_the_sim_rate() {
    assert_eq!(TICKS_PER_SECOND, libm::round(1000.0 / FIXED_STEP_MS) as f32);
}

#[test]
fn the_exposure_source_follows_the_look_and_the_quality_switch() {
    let mut manual = Look::default();
    manual.ev_compensation = 1.0;
    assert_eq!(exposure_source(&manual, &quality(8)), ExposureSource::Fixed(2.0));
    assert_eq!(exposure_source(&Look::default(), &quality(8)), ExposureSource::Fixed(1.0), "the default look is exposure 1.0");
    assert_eq!(exposure_source(&auto_look(), &quality(8)), ExposureSource::Auto);
    let mut off = quality(8);
    off.exposure = false;
    assert_eq!(exposure_source(&auto_look(), &off), ExposureSource::Fixed(1.0), "the switch off draws at 1.0");
}

#[test]
fn twice_the_radiance_meters_one_ev_higher_and_draws_at_half_the_exposure() {
    let params = GpuExposureParams::new(&auto_look(), 4, 1, false);
    let scene = binned_scene();
    let base = meter_ev(&cpu_histogram(&scene, (WIDTH, HEIGHT), 1.0, &params), &params).expect("metered");
    let bright = meter_ev(&cpu_histogram(&doubled(&scene), (WIDTH, HEIGHT), 1.0, &params), &params).expect("metered");
    assert!((bright - base - 1.0).abs() < 1e-4, "{base} -> {bright}");
    let ratio = exposure_of_ev(bright, 0.0) / exposure_of_ev(base, 0.0);
    assert!((ratio - 0.5).abs() < 1e-4, "{ratio}");
}

#[test]
fn the_histogram_divides_the_pre_exposure_back_out() {
    let params = GpuExposureParams::new(&auto_look(), 8, 1, false);
    let scene = binned_scene();
    let exposed: Vec<[f32; 3]> = scene.iter().map(|c| [c[0] * 4.0, c[1] * 4.0, c[2] * 4.0]).collect();
    assert_eq!(cpu_histogram(&scene, (WIDTH, HEIGHT), 1.0, &params), cpu_histogram(&exposed, (WIDTH, HEIGHT), 4.0, &params));
}

#[test]
fn black_and_non_finite_samples_are_not_metered() {
    let params = GpuExposureParams::new(&auto_look(), 1, 1, false);
    let scene = vec![[0.0, 0.0, 0.0], [f32::NAN, 0.0, 0.0], [f32::INFINITY, 1.0, 1.0], [0.18, 0.18, 0.18]];
    let bins = cpu_histogram(&scene, (4, 1), 1.0, &params);
    assert_eq!(bins.iter().sum::<u32>(), 16, "only the grey sample counts, at full weight");
    assert_eq!(meter_ev(&[0; 128], &params), None, "an empty histogram keeps the last target");
}

#[test]
fn metered_ev_is_clamped_to_the_look_limits() {
    let params = GpuExposureParams::new(&auto_look(), 1, 1, false);
    let scene = vec![[1.0e4, 1.0e4, 1.0e4]; 4];
    let top_bin_centre = 8.0 - 0.5 / BINS_PER_EV;
    let metered = meter_ev(&cpu_histogram(&scene, (2, 2), 1.0, &params), &params).expect("metered");
    assert!((metered - top_bin_centre).abs() < 1e-5, "the top bin, inside ev_max: {metered}");
}

#[test]
fn adaptation_moves_a_fixed_step_per_tick_and_lands_on_the_target() {
    // The linear tracker (transition 0): what every look did before P2-0.10's hybrid step.
    let mut look = auto_look().with_adaptation_transition(0.0);
    look.adaptation_up = 3.0;
    look.adaptation_down = 1.0;
    // P2-0.10 flipped 61 and 31: the settle time is now counted by stepping the reference, and the
    // snap onto the target absorbs the f32 sum's shortfall that cost the extra tick.
    assert_eq!(ticks_to_adapt(1.0, &look), 60, "1 EV darker at 1 EV/s");
    assert_eq!(ticks_to_adapt(-1.5, &look), 30, "1.5 EV brighter at 3 EV/s");
    let tick = GpuExposureParams::new(&look, 8, 1, false);
    let mut ev = 0.0;
    for frame in 1..=61 {
        ev = adapt_ev(ev, 1.0, &tick);
        if frame < 59 {
            assert!(ev < 1.0, "still adapting at tick {frame}: {ev}");
        }
    }
    assert_eq!(ev, 1.0, "lands exactly on the target");
    assert_eq!(adapt_ev(0.25, 3.0, &GpuExposureParams::new(&look, 8, 0, false)), 0.25, "a frame with no tick does not adapt");
    assert_eq!(adapt_ev(0.25, 3.0, &GpuExposureParams::new(&look, 8, 0, true)), 3.0, "instant");
}

/// Ticks the CPU reference takes to move from EV 0 to `target` at `look`'s speeds.
fn ticks_to_settle(look: &Look, target: f32) -> u32 {
    let tick = GpuExposureParams::new(look, 8, 1, false);
    let mut ev = 0.0;
    let mut ticks = 0;
    while ev != target && ticks < 100_000 {
        ev = adapt_ev(ev, target, &tick);
        ticks += 1;
    }
    ticks
}

/// How close to a +8 EV step into sunlight the exposure is 3 s later (P2-0.10 flipped "lands
/// exactly within 3 s": the hybrid step's last 1e-4 EV take longer, invisibly).
const SUN_SETTLE_EV: f32 = 1.0 / 32.0;

#[test]
fn by_default_the_image_brightens_faster_than_it_darkens_and_neither_lingers() {
    // Flipped by the Bodycam light fix (was "darkens fast and brightens slowly"): walking from a
    // sunlit yard into a room (-8 EV) left the picture dark for seconds, so the image now brightens
    // at 4 EV/s; walking out into sunlight (+8 EV) still leaves it bright for under 3 s.
    let look = auto_look();
    let into_the_sun = ticks_to_settle(&look, 8.0);
    let into_the_dark = ticks_to_settle(&look, -8.0);
    assert!(into_the_dark < into_the_sun, "-8 EV settles in {into_the_dark} ticks, +8 EV in {into_the_sun}");
    let tick = GpuExposureParams::new(&look, 8, 1, false);
    let after_3_s = (0..3 * 60).fold(0.0, |ev, _| adapt_ev(ev, 8.0, &tick));
    assert!(8.0 - after_3_s <= SUN_SETTLE_EV, "+8 EV is within {SUN_SETTLE_EV} EV after 3 s ({after_3_s})");
    assert!(ticks_to_adapt(8.0, &look) >= into_the_sun, "the documented settle time bounds it");
}

/// The ticks of each rendered frame of `frames` display frames at `hz`.
fn rendered_ticks(hz: f64, frames: u32) -> Vec<u32> {
    let mut pacer = FramePacer::default();
    let mut gate = FrameGate::default();
    let mut rendered = Vec::new();
    for _ in 0..frames {
        let paced = pacer.display_frame(1000.0 / hz);
        if gate.frame(paced.ticks) == FrameAction::Render {
            rendered.push(paced.ticks);
        }
    }
    rendered
}

#[test]
fn a_120_hz_display_adapts_as_a_60_hz_one() {
    let mut look = auto_look();
    look.adaptation_down = 0.5;
    let run = |ticks: Vec<u32>| ticks.into_iter().fold(0.0_f32, |ev, t| adapt_ev(ev, 2.0, &GpuExposureParams::new(&look, 8, t, false)));
    let fast = rendered_ticks(120.0, 120);
    let slow = rendered_ticks(60.0, 60);
    assert_eq!(fast.iter().sum::<u32>(), slow.iter().sum::<u32>(), "one second of ticks either way");
    assert_eq!(run(fast).to_bits(), run(slow).to_bits());
}

/// The most of the linear tracker's wobble the hybrid adaptation may keep when the metered target
/// wobbles by a sixteenth of an EV every tick (P2-0.10 acceptance: the wobble falls by half or more).
const JITTER_SHARE_MAX: f32 = 0.5;

/// The adapted EV after each of 600 ticks while the metered target wobbles within ±`amplitude` EV
/// around 0 (a fixed pseudo-random sequence), from a settled start.
fn wobbling_run(look: &Look, amplitude: f32) -> Vec<f32> {
    let tick = GpuExposureParams::new(look, 8, 1, false);
    let mut ev = 0.0;
    (0..600u32)
        .map(|k| {
            ev = adapt_ev(ev, amplitude * (2.0 * hash01(k, 7) - 1.0), &tick);
            ev
        })
        .collect()
}

#[test]
fn a_target_wobbling_by_a_sixteenth_of_an_ev_barely_moves_the_exposure() {
    let mut linear = auto_look();
    linear.adaptation_transition = 0.0;
    let (steady, chasing) = (std_dev(&wobbling_run(&auto_look(), 1.0 / 16.0)), std_dev(&wobbling_run(&linear, 1.0 / 16.0)));
    eprintln!("adapted EV std over 600 ticks: hybrid {steady:.5}, linear {chasing:.5}");
    assert!(steady <= JITTER_SHARE_MAX * chasing, "hybrid {steady} against linear {chasing}");
}

#[test]
fn far_from_the_target_the_adaptation_is_linear_and_near_it_eases_on_and_lands() {
    let look = auto_look();
    let tick = GpuExposureParams::new(&look, 8, 1, false);
    let speed = look.adaptation_down / TICKS_PER_SECOND;
    assert_eq!(adapt_ev(0.0, 4.0, &tick), speed, "4 EV away: a full step");
    let near = adapt_ev(0.0, 0.1, &tick);
    assert!(near > 0.0 && near < 0.1 * speed / look.adaptation_transition * 1.0001, "0.1 EV away eases: {near}");
    // It lands exactly (a settled capture's exposure is a fixed point), within the documented time.
    let ticks = ticks_to_adapt(0.1, &look);
    let mut ev = 0.0;
    for _ in 0..ticks {
        ev = adapt_ev(ev, 0.1, &tick);
    }
    assert_eq!(ev, 0.1, "lands on the target within {ticks} ticks");
    // A frame after a stall runs a hundred ticks: it steps each one, so it lands, never past.
    assert_eq!(adapt_ev(0.0, 0.3, &GpuExposureParams::new(&look, 8, 103, false)), 0.3, "a stalled frame lands on the target");
    let two = adapt_ev(0.0, 0.3, &GpuExposureParams::new(&look, 8, 2, false));
    assert_eq!(two, adapt_ev(adapt_ev(0.0, 0.3, &tick), 0.3, &tick), "a 30 Hz frame adapts as two 60 Hz ones");
}

/// The most the metered EV of a panning view of fine detail may move, as a standard deviation over
/// 32 one-texel steps (P2-0.10, C3; recorded on the point-sampling meter: see the WP record).
/// Half of the point-sampling meter's: 0.0162, 0.0631 and 0.0957.
const PAN_METER_STD_MAX: [(u8, f32); 3] = [(4, 0.0081), (8, 0.0316), (16, 0.0479)];

#[test]
fn a_panning_view_of_fine_detail_meters_a_steady_ev() {
    let look = auto_look();
    let spreads: Vec<(u8, f32, f32)> = PAN_METER_STD_MAX
        .iter()
        .map(|&(divisor, limit)| {
            let params = GpuExposureParams::new(&look, divisor, 1, true);
            let meter = |step| meter_ev(&cpu_histogram(&panned((WIDTH, HEIGHT), step), (WIDTH, HEIGHT), 1.0, &params), &params).expect("metered");
            let spread = std_dev(&(0..32).map(meter).collect::<Vec<f32>>());
            eprintln!("1/{divisor}: metered EV std over a 32-texel pan {spread:.5}");
            (divisor, spread, limit)
        })
        .collect();
    for (divisor, spread, limit) in spreads {
        assert!(spread <= limit, "1/{divisor}: {spread} EV");
    }
}

#[test]
fn the_compensation_curve_is_aimed_at_by_the_adaptation() {
    let curve = CompensationCurve::new(&[(0.0, 0.0), (-4.0, -2.0), (f32::NAN, 1.0)]);
    assert_eq!(curve.points(), &[[-4.0, -2.0], [0.0, 0.0]], "sorted, the NaN point left out");
    assert_eq!((curve.at(-6.0), curve.at(-2.0), curve.at(3.0)), (-2.0, -1.0, 0.0), "flat beyond the ends, linear between");
    let look = auto_look().with_compensation_curve(curve);
    let params = GpuExposureParams::new(&look, 8, 1, false);
    // A dusk scene metered at EV -3 is drawn 1.5 EV darker than middle grey: it stays a dusk.
    assert_eq!(aim_ev(-3.0, &params), -3.0 + 1.5);
    assert_eq!(aim_ev(2.0, &params), 2.0, "a day scene is untouched");
    assert_eq!(aim_ev(-3.0, &GpuExposureParams::new(&auto_look(), 8, 1, false)), -3.0, "no curve, no compensation");
}

#[test]
fn ground_metering_weighs_the_lower_rows_more() {
    let id = metering_id(Metering::Ground);
    assert_eq!(metering_weight(id, [0.5, 1.0]), 16, "the bottom row at full weight");
    assert_eq!(metering_weight(id, [0.5, 0.0]), 1, "the top row at a sixteenth");
    assert!(metering_weight(id, [0.1, 0.25]) < metering_weight(id, [0.9, 0.75]));
}

#[test]
fn the_params_carry_metering_ticks_and_the_instant_flag() {
    let mut look = auto_look();
    look.metering = Metering::Spot;
    let params = GpuExposureParams::new(&look, 0, 3, true);
    assert_eq!(params.control, [1, metering_id(Metering::Spot), 3, EXPOSURE_FLAG_INSTANT], "a zero divisor reads as 1");
    assert_eq!(params.histogram[1], EXPOSURE_HISTOGRAM_BINS as f32 / 16.0);
}

fn module(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

fn struct_size(module: &naga::Module, name: &str) -> Option<u32> {
    let mut layouter = Layouter::default();
    layouter.update(module.to_ctx()).expect("layout");
    module.types.iter().find(|(_, ty)| ty.name.as_deref() == Some(name)).map(|(handle, _)| layouter[handle].size)
}

#[test]
fn both_shaders_fit_core_workgroup_memory_and_invocations() {
    let limits = wgpu::Limits::defaults();
    for (name, source) in [("exposure-histogram", EXPOSURE_HISTOGRAM), ("exposure-adapt", EXPOSURE_ADAPT)] {
        let module = module(name, source);
        let mut layouter = Layouter::default();
        layouter.update(module.to_ctx()).expect("layout");
        let shared: u32 = module
            .global_variables
            .iter()
            .filter(|(_, var)| var.space == naga::AddressSpace::WorkGroup)
            .map(|(_, var)| layouter[var.ty].size)
            .sum();
        assert!(shared <= WORKGROUP_BYTES_MAX && shared <= limits.max_compute_workgroup_storage_size, "{name}: {shared} B shared");
        assert_eq!(module.entry_points.len(), 1, "{name}");
        let [x, y, z] = module.entry_points[0].workgroup_size;
        assert!(x * y * z <= limits.max_compute_invocations_per_workgroup, "{name}: {x}x{y}x{z}");
    }
    let histogram = module("exposure-histogram", EXPOSURE_HISTOGRAM);
    let bins = histogram.global_variables.iter().find(|(_, var)| var.space == naga::AddressSpace::WorkGroup).map(|(_, var)| var.ty);
    let bins = &histogram.types[bins.expect("a workgroup histogram")].inner;
    assert!(
        matches!(bins, naga::TypeInner::Array { size: naga::ArraySize::Constant(n), .. } if n.get() == EXPOSURE_HISTOGRAM_BINS),
        "fixed {EXPOSURE_HISTOGRAM_BINS} bins: {bins:?}"
    );
}

#[test]
fn the_params_and_pre_exposure_structs_equal_naga_layouts() {
    for (name, source) in [("exposure-histogram", EXPOSURE_HISTOGRAM), ("exposure-adapt", EXPOSURE_ADAPT)] {
        let module = module(name, source);
        assert_eq!(struct_size(&module, "ExposureParams"), Some(size_of::<GpuExposureParams>() as u32), "{name}");
        assert_eq!(struct_size(&module, "ExposureState"), Some(size_of::<GpuExposureState>() as u32), "{name}");
    }
    let adapt = module("exposure-adapt", EXPOSURE_ADAPT);
    assert_eq!(struct_size(&adapt, "PreExposure"), Some(size_of::<GpuPreExposure>() as u32));
    // One 8-byte copy fills GxFrameV2's pre_exposure and inv_pre_exposure.
    assert_eq!(std::mem::offset_of!(GxFrameV2, pre_exposure) as u64, GX_FRAME_V2_PRE_EXPOSURE_OFFSET);
    assert_eq!(std::mem::offset_of!(GxFrameV2, inv_pre_exposure) as u64, GX_FRAME_V2_PRE_EXPOSURE_OFFSET + 4);
}

// --- GPU rows ---

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => {
            if require {
                assert_eq!(gpu.receipt().backend, "metal", "GENEX_REQUIRE_METAL=1 but the adapter is not Metal");
            }
            Some(gpu)
        }
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// f32 to IEEE half, round to nearest even (normal range; tiny values flush to zero).
fn f16_bits(value: f32) -> u16 {
    let bits = value.to_bits();
    let sign = ((bits >> 16) & 0x8000) as u16;
    let exponent = ((bits >> 23) & 0xff) as i32 - 127 + 15;
    let mantissa = bits & 0x7f_ffff;
    if exponent <= 0 {
        return sign;
    }
    if exponent >= 31 {
        return sign | 0x7c00;
    }
    let mut half = u32::from(sign) | ((exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) {
        half += 1;
    }
    half as u16
}

/// IEEE half (normal or zero) to f32.
fn f16_value(half: u16) -> f32 {
    let sign = u32::from(half & 0x8000) << 16;
    let exponent = u32::from((half >> 10) & 0x1f);
    if exponent == 0 {
        return f32::from_bits(sign);
    }
    let mantissa = u32::from(half & 0x3ff);
    f32::from_bits(sign | ((exponent + 127 - 15) << 23) | (mantissa << 13))
}

/// The node, a history and a scene texture: one frame of the renderer's loop per [`Rig::frame`].
struct Rig {
    gpu: Gpu,
    pass: ExposurePass,
    scene: wgpu::Texture,
    view: wgpu::TextureView,
    size: (u32, u32),
}

impl Rig {
    fn new(gpu: Gpu, size: (u32, u32)) -> Rig {
        let pass = ExposurePass::new(&gpu.device).expect("exposure pipelines");
        let scene = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("hdr scene"),
            size: wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        let view = scene.create_view(&Default::default());
        Rig { gpu, pass, scene, view, size }
    }

    fn history(&self, look: &Look) -> ExposureHistory {
        ExposureHistory::new(&self.gpu.device, &self.gpu.queue, look).expect("exposure history")
    }

    /// Upload `radiance × pre_exposure` as fp16; returns the texels the GPU reads, as f32.
    fn write_scene(&self, radiance: &[[f32; 3]], pre_exposure: f32) -> Vec<[f32; 3]> {
        let halves: Vec<[u16; 4]> =
            radiance.iter().map(|c| [f16_bits(c[0] * pre_exposure), f16_bits(c[1] * pre_exposure), f16_bits(c[2] * pre_exposure), 0x3c00]).collect();
        self.gpu.queue.write_texture(
            self.scene.as_image_copy(),
            bytemuck::cast_slice(&halves),
            wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(self.size.0 * 8), rows_per_image: None },
            wgpu::Extent3d { width: self.size.0, height: self.size.1, depth_or_array_layers: 1 },
        );
        halves.iter().map(|h| [f16_value(h[0]), f16_value(h[1]), f16_value(h[2])]).collect()
    }

    fn read(&self, buffer: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
        let staging = self.gpu.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("exposure readback"),
            size: bytes,
            usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, bytes);
        self.gpu.queue.submit([encoder.finish()]);
        staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("map"));
        self.gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let data = staging.slice(..).get_mapped_range().expect("mapped").to_vec();
        staging.unmap();
        data
    }

    fn state(&self, history: &ExposureHistory) -> GpuExposureState {
        *bytemuck::from_bytes(&self.read(history.state_buffer(), size_of::<GpuExposureState>() as u64))
    }

    /// One frame: the scene at the state's exposure, then the node.
    fn frame(&self, history: &mut ExposureHistory, radiance: &[[f32; 3]], look: &Look, quality: &Quality, ticks: u32, instant: bool) -> Frame {
        let pre_exposure = self.state(history).exposure;
        let texels = self.write_scene(radiance, pre_exposure);
        let mut encoder = self.gpu.device.create_command_encoder(&Default::default());
        let input =
            ExposureInput { scene: &self.view, scene_size: self.size, look, quality, ticks, instant, boost: 1.0, timestamp_writes: None };
        let run = self.pass.encode(&self.gpu.device, &self.gpu.queue, &mut encoder, history, input);
        self.gpu.queue.submit([encoder.finish()]);
        Frame { run, pre_exposure, texels, state: self.state(history) }
    }
}

struct Frame {
    run: ExposureRun,
    pre_exposure: f32,
    texels: Vec<[f32; 3]>,
    state: GpuExposureState,
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_gpu_histogram_and_metered_ev_equal_the_cpu_reference() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (WIDTH, HEIGHT));
    let scene = binned_scene();
    for metering in Metering::ALL {
        for divisor in [4u8, 8, 16] {
            let mut look = auto_look();
            look.metering = metering;
            let mut history = rig.history(&look);
            let frame = rig.frame(&mut history, &scene, &look, &quality(divisor), 1, true);
            assert_eq!(frame.run, ExposureRun::Metered);
            let params = GpuExposureParams::new(&look, divisor, 1, true);
            let expected = cpu_histogram(&frame.texels, rig.size, frame.pre_exposure, &params);
            let bins: Vec<u32> = bytemuck::cast_slice(&rig.read(history.histogram_buffer(), 512)).to_vec();
            assert_eq!(bins, expected.to_vec(), "{metering:?} at 1/{divisor}");
            let target = meter_ev(&expected, &params).expect("metered");
            assert!((frame.state.target_ev - target).abs() < 1e-3, "{metering:?} 1/{divisor}: gpu {} cpu {target}", frame.state.target_ev);
            assert_eq!(frame.state.ev, frame.state.target_ev, "instant");
            assert_eq!(frame.state.flags & EXPOSURE_FLAG_INSTANT, 0, "the instant request is consumed");
            let expected_exposure = exposure_of_ev(frame.state.ev, 0.0);
            assert!((frame.state.exposure / expected_exposure - 1.0).abs() < 1e-5, "{} vs {expected_exposure}", frame.state.exposure);
            let pair: GpuPreExposure = *bytemuck::from_bytes(&rig.read(history.pre_exposure_buffer(), 8));
            assert_eq!(pair.pre_exposure, frame.state.exposure);
            assert!((pair.pre_exposure * pair.inv_pre_exposure - 1.0).abs() < 1e-6);
        }
    }
}

/// The state after every frame of: one instant frame on `binned_scene`, then `frames` one-tick
/// frames on it doubled.
fn doubling_run(rig: &Rig, look: &Look, frames: u32) -> Vec<GpuExposureState> {
    let scene = binned_scene();
    let bright = doubled(&scene);
    let quality = quality(8);
    let mut history = rig.history(look);
    let mut states = vec![rig.frame(&mut history, &scene, look, &quality, 1, false).state];
    for _ in 0..frames {
        states.push(rig.frame(&mut history, &bright, look, &quality, 1, false).state);
    }
    states
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_doubled_radiance_converges_to_half_the_exposure_deterministically() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (WIDTH, HEIGHT));
    let look = auto_look();
    let settle = ticks_to_adapt(1.0, &look);
    let states = doubling_run(&rig, &look, settle + 2);
    let start = states[0];
    assert!(start.exposure.is_finite() && start.exposure > 0.0);
    let halfway = states[(settle / 2) as usize];
    assert!(halfway.exposure < start.exposure && halfway.exposure > start.exposure * 0.5, "adapting, not jumping: {halfway:?}");
    let settled = states[settle as usize];
    assert!((settled.exposure / start.exposure - 0.5).abs() < 1e-3, "within {settle} ticks: {start:?} -> {settled:?}");
    assert_eq!(states[settle as usize + 2], settled, "stays put once settled");
    let again = doubling_run(&rig, &look, settle + 2);
    assert_eq!(bytemuck::cast_slice::<_, u8>(&states), bytemuck::cast_slice::<_, u8>(&again), "identical exposure bytes on two runs");

    // Instant mode lands on the converged value at once.
    let mut history = rig.history(&look);
    let instant = rig.frame(&mut history, &doubled(&binned_scene()), &look, &quality(8), 1, true).state;
    assert!((instant.exposure / settled.exposure - 1.0).abs() < 1e-5, "{instant:?} vs {settled:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_120_hz_display_adapts_as_a_60_hz_one() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (WIDTH, HEIGHT));
    let mut look = auto_look();
    look.adaptation_down = 0.5;
    let scene = binned_scene();
    let bright = doubled(&scene);
    let quality = quality(8);
    let run = |hz: f64, frames: u32| {
        let mut history = rig.history(&look);
        rig.frame(&mut history, &scene, &look, &quality, 1, true);
        let mut last = None;
        for ticks in rendered_ticks(hz, frames) {
            last = Some(rig.frame(&mut history, &bright, &look, &quality, ticks, false).state);
        }
        last.expect("a rendered frame")
    };
    let fast = run(120.0, 120);
    let slow = run(60.0, 60);
    assert_eq!(fast, slow, "same exposure after one second of either display");
    assert!(fast.ev < fast.target_ev, "mid-adaptation, so the cadence matters: {fast:?}");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_low_and_high_quality_meter_within_an_eighth_ev() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (WIDTH, HEIGHT));
    let look = auto_look();
    let scene = ramp_scene();
    let meter = |divisor: u8| {
        let mut history = rig.history(&look);
        rig.frame(&mut history, &scene, &look, &quality(divisor), 1, true).state.ev
    };
    let (low, high) = (meter(16), meter(4));
    assert!((low - high).abs() <= 0.125, "low {low} high {high}");
}

/// The most the adapted EV may wobble (standard deviation over 600 one-tick frames) while the
/// camera pans 2 texels a tick over [`detailed_world`], by input divisor (medium 8, low 16): half of
/// what the point-sampling meter with the linear tracker gave (P2-0.10 acceptance; the WP record
/// has both runs: 0.0333 and 0.0409 EV on the M4 Max).
const PAN_EXPOSURE_STD_MAX: [(u8, f32); 2] = [(8, 0.0166), (16, 0.0205)];

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_camera_panning_over_fine_detail_and_small_lights_holds_the_exposure_steady() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (WIDTH, HEIGHT));
    let look = auto_look();
    let mut record = Vec::new();
    for (divisor, limit) in PAN_EXPOSURE_STD_MAX {
        let quality = quality(divisor);
        let mut history = rig.history(&look);
        rig.frame(&mut history, &panned(rig.size, 0), &look, &quality, 1, true);
        let evs: Vec<f32> = (1..=600).map(|tick| rig.frame(&mut history, &panned(rig.size, 2 * tick), &look, &quality, 1, false).state.ev).collect();
        let wobble = std_dev(&evs);
        eprintln!("1/{divisor}: adapted EV std over a 600-tick pan {wobble:.5}");
        record.push((divisor, wobble, limit, format!("{{\"divisor\": {divisor}, \"ev_std\": {wobble}, \"evs\": {evs:?}}}")));
    }
    if let Ok(dir) = std::env::var("GENEX_EXPOSURE_OUT") {
        std::fs::create_dir_all(&dir).expect("evidence dir");
        let rows: Vec<&str> = record.iter().map(|row| row.3.as_str()).collect();
        std::fs::write(std::path::Path::new(&dir).join("pan-jitter.json"), format!("[{}]\n", rows.join(", "))).expect("record");
    }
    for (divisor, wobble, limit, _) in record {
        assert!(wobble <= limit, "1/{divisor}: the exposure wobbles by {wobble} EV (std)");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_gpu_aims_at_the_compensation_curve_as_the_cpu_does() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (64, 64));
    let look = auto_look().with_compensation_curve(CompensationCurve::new(&[(-4.0, -2.0), (0.0, 0.0)]));
    // A dusk scene: every texel at the centre of the bin around EV -3.
    let dusk = EXPOSURE_KEY_LUMINANCE * libm::exp2f(bin_centre_ev(40));
    let scene = vec![[dusk; 3]; 64 * 64];
    let mut history = rig.history(&look);
    let frame = rig.frame(&mut history, &scene, &look, &quality(8), 1, true);
    let params = GpuExposureParams::new(&look, 8, 1, true);
    let metered = meter_ev(&cpu_histogram(&frame.texels, rig.size, frame.pre_exposure, &params), &params).expect("metered");
    let aim = aim_ev(metered, &params);
    assert!(aim > metered + 1.0, "the curve keeps the dusk dark: metered {metered}, aimed {aim}");
    assert!((frame.state.target_ev - aim).abs() < 1e-3, "gpu {} cpu {aim}", frame.state.target_ev);
    assert_eq!(frame.state.ev, frame.state.target_ev, "instant");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_manual_ev_writes_the_state_and_dispatches_nothing() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (64, 64));
    let mut look = Look::default();
    look.ev_compensation = -1.0;
    let scene = vec![[1.0, 1.0, 1.0]; 64 * 64];
    let mut history = rig.history(&look);
    let frame = rig.frame(&mut history, &scene, &look, &quality(8), 1, false);
    assert_eq!(frame.run, ExposureRun::Fixed);
    assert_eq!(frame.state.exposure, 0.5);
    let pair: GpuPreExposure = *bytemuck::from_bytes(&rig.read(history.pre_exposure_buffer(), 8));
    assert_eq!(pair, GpuPreExposure { pre_exposure: 0.5, inv_pre_exposure: 2.0 });
    // Switching to auto continues from the manual exposure's EV.
    look.exposure = ExposureMode::Auto;
    look.adaptation_up = 0.0;
    look.adaptation_down = 0.0;
    let auto = rig.frame(&mut history, &scene, &look, &quality(8), 1, false);
    assert_eq!(auto.run, ExposureRun::Metered);
    assert_eq!(auto.state.exposure, 0.5, "no speed: the exposure holds");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_frame_copy_fills_pre_exposure_and_its_inverse() {
    let Some(gpu) = gpu() else { return };
    let rig = Rig::new(gpu, (64, 64));
    let look = auto_look();
    let mut history = rig.history(&look);
    rig.frame(&mut history, &vec![[3.0, 3.0, 3.0]; 64 * 64], &look, &quality(4), 1, true);
    let frame = rig.gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("frame v2"),
        size: size_of::<GxFrameV2>() as u64,
        usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let mut encoder = rig.gpu.device.create_command_encoder(&Default::default());
    history.copy_into_frame_v2(&mut encoder, &frame);
    rig.gpu.queue.submit([encoder.finish()]);
    let bytes = rig.read(&frame, size_of::<GxFrameV2>() as u64);
    let at = GX_FRAME_V2_PRE_EXPOSURE_OFFSET as usize;
    let pair: GpuPreExposure = *bytemuck::from_bytes(&bytes[at..at + 8]);
    let state = rig.state(&history);
    assert_eq!(pair.pre_exposure, state.exposure);
    assert!((pair.pre_exposure * pair.inv_pre_exposure - 1.0).abs() < 1e-6);
}

/// GPU time of the node at 1080p over 600 frames, from timestamps where the adapter offers them: frames are
/// submitted back to back (the GPU stays clocked up) and read once. Printed; the acceptance budget
/// is 0.1 ms on the M4 Max, asserted loosely here because the machine is shared.
#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_auto_exposure_gpu_time_at_1080p() {
    const FRAMES: u32 = 600;
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no TIMESTAMP_QUERY");
        return;
    }
    let size = (1920, 1080);
    let rig = Rig::new(gpu, size);
    let look = auto_look();
    let scene: Vec<[f32; 3]> =
        (0..size.0 * size.1).map(|i| [0.05 + (i % 1920) as f32 / 400.0, 0.5, 0.2 + (i / 1920) as f32 / 300.0]).collect();
    rig.write_scene(&scene, 1.0);
    let queries = rig.gpu.device.create_query_set(&wgpu::QuerySetDescriptor { label: None, ty: wgpu::QueryType::Timestamp, count: FRAMES * 2 });
    let resolve_bytes = u64::from(FRAMES) * 16;
    let resolve = rig.gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: None,
        size: resolve_bytes,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let period = rig.gpu.queue.get_timestamp_period();
    let mut report = Vec::new();
    // A warm-up run first: the GPU clocks up over the first frames of an idle machine.
    for (name, divisor) in [("warm-up", 4u8), ("low", 16), ("medium", 8), ("high", 4)] {
        let quality = quality(divisor);
        let mut history = rig.history(&look);
        for frame in 0..FRAMES {
            let mut encoder = rig.gpu.device.create_command_encoder(&Default::default());
            let writes = wgpu::ComputePassTimestampWrites {
                query_set: &queries,
                beginning_of_pass_write_index: Some(frame * 2),
                end_of_pass_write_index: Some(frame * 2 + 1),
            };
            let input =
                ExposureInput { scene: &rig.view, scene_size: size, look: &look, quality: &quality, ticks: 1, instant: false, boost: 1.0, timestamp_writes: Some(writes) };
            rig.pass.encode(&rig.gpu.device, &rig.gpu.queue, &mut encoder, &mut history, input);
            rig.gpu.queue.submit([encoder.finish()]);
        }
        let mut encoder = rig.gpu.device.create_command_encoder(&Default::default());
        encoder.resolve_query_set(&queries, 0..FRAMES * 2, &resolve, 0);
        rig.gpu.queue.submit([encoder.finish()]);
        let stamps: Vec<u64> = bytemuck::cast_slice(&rig.read(&resolve, resolve_bytes)).to_vec();
        // The first frames warm the clocks and caches.
        let mut samples: Vec<f64> =
            stamps.chunks(2).skip(8).map(|pair| pair[1].saturating_sub(pair[0]) as f64 * f64::from(period) / 1.0e6).collect();
        samples.sort_by(f64::total_cmp);
        let (p50, p95) = (samples[samples.len() / 2], samples[samples.len() * 95 / 100]);
        if name == "warm-up" {
            continue;
        }
        report.push(format!("{{\"preset\":\"{name}\",\"divisor\":{divisor},\"p50_ms\":{p50:.4},\"p95_ms\":{p95:.4}}}"));
        assert!(p50 < 0.5, "{name}: {p50} ms");
    }
    eprintln!(
        "{{\"row\":\"rq1.2-auto-exposure-1080p\",\"backend\":\"{}\",\"adapter\":\"{}\",\"frames\":{FRAMES},\"presets\":[{}]}}",
        rig.gpu.receipt().backend,
        rig.gpu.receipt().adapter,
        report.join(",")
    );
}
