//! The LOD fade band (game systems LOD-01): an instance whose coarser level only just fits the
//! pixel threshold draws both that level (fading in) and the finer one (fading out), its shares
//! summing to one, so a level change dissolves instead of popping. The band is a pure function
//! of distance ([`lod_band`] and its WGSL twin `gx_lod_band`), and a band of zero is today's hard
//! switch bit for bit. The cull's keep rule grows a fade-batch branch ([`lod_band_keep`]): each
//! (instance, level) pair is kept by exactly one batch.
//!
//! The GPU row is `#[ignore]`d and its name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test lod_band -- --ignored metal

use genex_render::Gpu;
use genex_render::mesh::{LOD_FADE_TAG, LOD_MAX_LEVELS, LOD_SELECT_WGSL, LodBand, batch_lod, fade_batch_lod, lod_band, lod_band_keep, lod_keeps, select_lod};

/// The default fade band (design: 0.15 of the threshold).
const BETA: f32 = 0.15;
/// Random cases the GPU row compares (plan: 10^5).
const GPU_RANDOM_CASES: usize = 100_000;
/// Random cases the host rows walk.
const HOST_RANDOM_CASES: usize = 4_096;

/// One case: four errors (unused ones past `levels`), the level count, distance, pixels a unit,
/// threshold, bias and band. Laid out as the WGSL `Case` (48 bytes).
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
struct Case {
    errors: [f32; 4],
    levels: u32,
    distance: f32,
    pixels_per_unit: f32,
    threshold_px: f32,
    bias: f32,
    beta: f32,
    pad: [f32; 2],
}

impl Case {
    fn errors(&self) -> &[f32] {
        &self.errors[..self.levels as usize]
    }

    fn band(&self) -> LodBand {
        lod_band(self.errors(), self.distance, self.pixels_per_unit, self.threshold_px, self.bias, self.beta)
    }
}

/// A xorshift stream in [0, 1].
struct Stream(u32);

impl Stream {
    fn next(&mut self) -> f32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        (self.0 as f32) / (u32::MAX as f32)
    }
}

/// Deterministic cases around every boundary (`glb_lods.rs`'s table, grown by bias and band):
/// errors rising, distances on a log scale, and the exact distances where a level starts to fit
/// (q = 1) and where its band ends (q = 1 - beta).
fn cases(seed: u32, count: usize, hard: bool) -> Vec<Case> {
    let mut stream = Stream(seed);
    let mut out = Vec::with_capacity(count * 3);
    while out.len() < count {
        let levels = 1 + (stream.next() * 4.0) as u32 % LOD_MAX_LEVELS;
        let mut errors = [0.0_f32; 4];
        let mut running = 0.0;
        for error in errors.iter_mut().take(levels as usize) {
            running += stream.next() * 0.1;
            *error = running;
        }
        let pixels_per_unit = 200.0 + stream.next() * 2000.0;
        let threshold_px = 0.5 + stream.next() * 2.0;
        let (bias, beta) = if hard { (1.0, 0.0) } else { band_inputs(&mut stream) };
        let distance = libm::powf(10.0, stream.next() * 4.0 - 1.0);
        let case = Case { errors, levels, distance, pixels_per_unit, threshold_px, bias, beta, pad: [0.0; 2] };
        let at = (stream.next() * levels as f32) as usize % levels as usize;
        let fits_from = errors[at] * (pixels_per_unit * bias) / threshold_px;
        out.push(case);
        out.push(Case { distance: fits_from, ..case });
        if beta < 1.0 {
            out.push(Case { distance: fits_from / (1.0 - beta), ..case });
        }
    }
    out
}

/// A case's bias and band: mostly the defaults, sometimes anything valid.
fn band_inputs(stream: &mut Stream) -> (f32, f32) {
    let pick = stream.next();
    let bias = if pick < 0.5 { 1.0 } else { 0.25 + stream.next() * 4.0 };
    let beta = match (stream.next() * 4.0) as u32 {
        0 => 0.0,
        1 => BETA,
        2 => 0.2,
        _ => stream.next(),
    };
    (bias, beta)
}

/// Whether level `level` of `case` (0 the mesh itself, exact) fits the threshold at its distance,
/// compared as the select does.
fn fits(case: &Case, level: u32) -> bool {
    let error = if level == 0 { 0.0 } else { case.errors[level as usize - 1] };
    error * (case.pixels_per_unit * case.bias) <= case.threshold_px * case.distance
}

/// The levels a band draws, each with its share.
fn drawn(band: LodBand) -> Vec<(u32, f32)> {
    if band.share >= 1.0 {
        return vec![(band.level, 1.0)];
    }
    vec![(band.level - 1, 1.0 - band.share), (band.level, band.share)]
}

// ---------------------------------------------------------------------------------------------
// Instances under the cull's keep rule

/// A chain's whole and fade batch rows, level 0 first.
fn chain_rows(errors: &[f32]) -> (Vec<[u32; 3]>, Vec<[u32; 3]>) {
    let levels = 0..=errors.len() as u32;
    (levels.clone().map(|level| batch_lod(level, errors, 1.0)).collect(), levels.map(|level| fade_batch_lod(level, errors, 1.0)).collect())
}

/// A camera at the origin with a 60 degree vertical field of view over 1080 rows.
fn view() -> [f32; 4] {
    [0.0, 0.0, 0.0, 540.0 / libm::tanf(30.0f32.to_radians())]
}

/// Unit spheres receding from the camera.
fn receding() -> impl Iterator<Item = [f32; 4]> {
    (0..2_000).map(|step| [0.0, 0.0, -(step as f32) * 0.05 - 0.1, 1.0])
}

#[test]
fn band_zero_is_todays_hard_switch_bit_for_bit() {
    for (at, case) in cases(0x2545_f491, HOST_RANDOM_CASES, true).iter().enumerate() {
        let band = case.band();
        let today = select_lod(case.errors(), case.distance, case.pixels_per_unit, case.threshold_px);
        assert_eq!((band.level, band.share.to_bits()), (today, 1.0f32.to_bits()), "case {at}: {case:?}");
    }
    let errors = [0.01, 0.04, 0.16];
    let (whole, _) = chain_rows(&errors);
    for bounds in receding() {
        for row in &whole {
            let kept = lod_band_keep(*row, bounds, view(), 1.0, 0.0);
            assert_eq!(kept.is_some(), lod_keeps(*row, bounds, view()), "{row:?} at {bounds:?}");
            assert!(kept.is_none_or(|value| value.to_bits() == 1.0f32.to_bits()), "a whole keep is 1.0");
        }
    }
    assert!(lod_band_keep([0; 3], [0.0, 0.0, -3.0, 1.0], view(), 1.0, 0.0) == Some(1.0) && lod_keeps([0; 3], [0.0, 0.0, -3.0, 1.0], view()));
}

#[test]
fn without_a_band_the_fade_batches_keep_nothing() {
    let errors = [0.01, 0.04, 0.16];
    let (_, fade) = chain_rows(&errors);
    for bounds in receding() {
        for row in &fade {
            assert!(lod_band_keep(*row, bounds, view(), 1.0, 0.0).is_none() && !lod_keeps(*row, bounds, view()), "no band: fade batches stay empty");
        }
    }
}

#[test]
fn shares_of_an_instance_sum_to_one_and_each_pair_is_kept_once() {
    let errors = [0.01, 0.04, 0.16];
    let (whole, fade) = chain_rows(&errors);
    let mut fading = 0;
    for bias in [1.0, 2.0, 0.5] {
        for bounds in receding() {
            let whole_kept: Vec<(usize, f32)> = whole.iter().enumerate().filter_map(|(level, row)| lod_band_keep(*row, bounds, view(), bias, BETA).map(|v| (level, v))).collect();
            let fade_kept: Vec<(usize, f32)> = fade.iter().enumerate().filter_map(|(level, row)| lod_band_keep(*row, bounds, view(), bias, BETA).map(|v| (level, v))).collect();
            let at = format!("bias {bias} at {bounds:?}: whole {whole_kept:?} fade {fade_kept:?}");
            if fade_kept.is_empty() {
                assert!(whole_kept.len() == 1 && whole_kept[0].1 == 1.0, "{at}");
                continue;
            }
            fading += 1;
            assert!(whole_kept.is_empty() && fade_kept.len() == 2, "a fading instance is kept by its two fade batches only: {at}");
            let [(finer, out), (coarser, fade_in)] = [fade_kept[0], fade_kept[1]];
            assert!(coarser == finer + 1 && out >= 0.0 && fade_in <= 0.0, "{at}");
            assert!((out - fade_in - 1.0).abs() <= f32::EPSILON, "shares sum to one: {at}");
            // Kansei's rule: the finer level keeps thresholds below `out`, the coarser those at
            // or above `1 + fade_in`; each pixel threshold is drawn by exactly one of them.
            for step in 0..64 {
                let threshold = step as f32 / 64.0;
                assert!((threshold < out) != (threshold >= 1.0 + fade_in), "threshold {threshold}: {at}");
            }
        }
    }
    assert!(fading > 100, "instances cross the band ({fading})");
}

#[test]
fn no_drawn_level_exceeds_the_threshold_inside_the_band() {
    let mut in_band = 0;
    for (at, case) in cases(0x9e37_79b9, HOST_RANDOM_CASES, false).iter().enumerate() {
        let band = case.band();
        assert_eq!(band.level, lod_band(case.errors(), case.distance, case.pixels_per_unit, case.threshold_px, case.bias, 0.0).level, "the band never changes the picked level: {case:?}");
        let levels = drawn(band);
        in_band += usize::from(levels.len() == 2);
        let total: f32 = levels.iter().map(|(_, share)| share).sum();
        assert!((total - 1.0).abs() <= f32::EPSILON, "case {at}: {levels:?}");
        for (level, share) in levels {
            assert!(share >= 0.0 && fits(case, level), "case {at}: level {level} (share {share}) exceeds the threshold: {case:?}");
        }
    }
    assert!(in_band > 200, "cases fall inside the band ({in_band})");
}

#[test]
fn the_band_moves_monotonically_with_distance() {
    let errors = [0.01, 0.04, 0.16];
    let mut last = (0, 1.0_f32);
    for step in 1..20_000 {
        let distance = step as f32 * 0.01;
        let band = lod_band(&errors, distance, 1000.0, 1.0, 1.0, BETA);
        let now = (band.level, band.share);
        let forward = now.0 > last.0 || (now.0 == last.0 && now.1 >= last.1);
        assert!(forward, "at {distance}: {last:?} then {now:?}");
        last = now;
    }
    assert_eq!(last, (3, 1.0), "far away: the coarsest level whole");
}

#[test]
fn hostile_inputs_draw_the_mesh_itself_whole() {
    let errors = [0.01, 0.04, 0.16];
    // Each row: its name, the distance and the instance bounds that give it, the bias and band.
    let hostile = [
        ("NaN distance", f32::NAN, [0.0, 0.0, f32::NAN, 1.0], 1.0, BETA),
        ("negative distance", -0.5, [0.0, 0.0, -0.5, 1.0], 1.0, BETA),
        ("zero distance", 0.0, [0.0, 0.0, -1.0, 1.0], 1.0, BETA),
        ("bias 0", 50.0, [0.0, 0.0, -51.0, 1.0], 0.0, BETA),
        ("negative bias", 50.0, [0.0, 0.0, -51.0, 1.0], -1.0, BETA),
        ("bias inf", 50.0, [0.0, 0.0, -51.0, 1.0], f32::INFINITY, BETA),
        ("bias NaN", 50.0, [0.0, 0.0, -51.0, 1.0], f32::NAN, BETA),
        ("beta > 1", 50.0, [0.0, 0.0, -51.0, 1.0], 1.0, 1.5),
        ("negative beta", 50.0, [0.0, 0.0, -51.0, 1.0], 1.0, -0.1),
        ("beta NaN", 50.0, [0.0, 0.0, -51.0, 1.0], 1.0, f32::NAN),
        ("beta inf", 50.0, [0.0, 0.0, -51.0, 1.0], 1.0, f32::INFINITY),
    ];
    let (whole, fade) = chain_rows(&errors);
    for (name, distance, bounds, bias, beta) in hostile {
        assert_eq!(lod_band(&errors, distance, 1000.0, 1.0, bias, beta), LodBand { level: 0, share: 1.0 }, "{name}");
        assert_eq!(lod_band_keep(whole[0], bounds, view(), bias, beta), Some(1.0), "{name}: level 0 whole");
        assert!(whole[1..].iter().chain(&fade).all(|row| lod_band_keep(*row, bounds, view(), bias, beta).is_none()), "{name}: nothing else");
    }
    for (name, radius) in [("zero radius", 0.0), ("negative radius", -1.0), ("NaN radius", f32::NAN)] {
        let bounds = [0.0, 0.0, -500.0, radius];
        assert_eq!(lod_band_keep(whole[0], bounds, view(), 1.0, BETA), Some(1.0), "{name}: level 0 whole");
        assert!(whole[1..].iter().chain(&fade).all(|row| lod_band_keep(*row, bounds, view(), 1.0, BETA).is_none()), "{name}: nothing else");
    }
    assert_eq!(LOD_FADE_TAG & batch_lod(3, &errors, 1.0)[0], 0, "the fade bit is free in a whole batch's tag");
}

// ---------------------------------------------------------------------------------------------
// WGSL twin

/// The WGSL band inside a compute entry that runs it once per case.
fn band_shader() -> String {
    format!(
        "{LOD_SELECT_WGSL}\nstruct Case {{ errors: vec4<f32>, levels: u32, distance: f32, pixels_per_unit: f32, threshold_px: f32, bias: f32, beta: f32, pad: vec2<f32> }}\n\
         @group(0) @binding(0) var<storage, read> cases: array<Case>;\n\
         @group(0) @binding(1) var<storage, read_write> bands: array<vec2<f32>>;\n\
         @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>) {{\n\
           let at = id.x + id.y * 65535u * 64u;\n\
           if (at >= arrayLength(&cases)) {{ return; }}\n\
           let c = cases[at];\n\
           bands[at] = gx_lod_band(c.errors, c.levels, c.distance, c.pixels_per_unit, c.threshold_px, c.bias, c.beta);\n\
         }}\n"
    )
}

#[test]
fn the_wgsl_band_validates_on_webgpu_core_and_emits_hlsl_msl_and_spirv() {
    use naga::back::{hlsl, msl, spv};
    use naga::valid::{Capabilities, ValidationFlags, Validator};
    let module = naga::front::wgsl::parse_str(&band_shader()).expect("WGSL parses");
    let info = Validator::new(ValidationFlags::all(), Capabilities::empty()).validate(&module).expect("WebGPU core");
    let mut hlsl_source = String::new();
    let hlsl_options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &hlsl_options, &hlsl::PipelineOptions::default()).write(&module, &info, None).expect("HLSL SM 5.1");
    let msl_options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &msl_options, &msl::PipelineOptions::default()).expect("MSL 2.4");
    let spv_options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &spv_options, None).expect("SPIR-V 1.3");
}

fn gpu() -> Option<Gpu> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Gpu::headless() {
        Ok(gpu) => Some(gpu),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// Runs `gx_lod_band` over `cases` on the GPU.
fn gpu_bands(gpu: &Gpu, cases: &[Case]) -> Vec<[f32; 2]> {
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("lod band"), source: wgpu::ShaderSource::Wgsl(band_shader().into()) });
    let input = wgpu::util::DeviceExt::create_buffer_init(
        device,
        &wgpu::util::BufferInitDescriptor { label: Some("cases"), contents: bytemuck::cast_slice(cases), usage: wgpu::BufferUsages::STORAGE },
    );
    let size = (cases.len() * 8) as u64;
    let output = device.create_buffer(&wgpu::BufferDescriptor { label: Some("bands"), size, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let staging = device.create_buffer(&wgpu::BufferDescriptor { label: Some("staging"), size, usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST, mapped_at_creation: false });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("lod band"),
        layout: None,
        module: &module,
        entry_point: Some("main"),
        compilation_options: Default::default(),
        cache: None,
    });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: input.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 1, resource: output.as_entire_binding() },
        ],
    });
    let groups = (cases.len() as u32).div_ceil(64);
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor::default());
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups(groups.min(65_535), groups.div_ceil(65_535), 1);
    }
    encoder.copy_buffer_to_buffer(&output, 0, &staging, 0, size);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    device.poll(wgpu::PollType::wait_indefinitely()).expect("done");
    bytemuck::cast_slice(&staging.slice(..).get_mapped_range().expect("mapped range")).to_vec()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_wgsl_band_equals_cpu_for_every_case() {
    let Some(gpu) = gpu() else { return };
    let mut all = cases(0x2545_f491, HOST_RANDOM_CASES, true);
    all.extend(cases(0x1234_5678, GPU_RANDOM_CASES, false));
    let bands = gpu_bands(&gpu, &all);
    let (mut in_band, mut level_changes) = (0, 0);
    for (at, case) in all.iter().enumerate() {
        let cpu = case.band();
        let [level, share] = bands[at];
        assert_eq!((level.to_bits(), share.to_bits()), ((cpu.level as f32).to_bits(), cpu.share.to_bits()), "case {at}: gpu ({level}, {share}) cpu {cpu:?}: {case:?}");
        in_band += usize::from(cpu.share < 1.0);
        level_changes += usize::from(cpu.level > 0 && cpu.level < case.levels);
    }
    eprintln!("{} cases, {in_band} inside a band, {level_changes} between levels", all.len());
    assert!(all.len() >= GPU_RANDOM_CASES && in_band > 1_000 && level_changes > 1_000, "the cases cross levels and bands");
}
