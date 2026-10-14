//! RQ6.2: spot lights and binned local-light shading with the windowed inverse-square falloff.
//!
//! The binned path lights points and spots of the depth-sorted local-light table (the preset's cap
//! applied nearest first, shadow slots kept in scene order) with the Frostbite/UE window
//! `saturate(1 - (d/r)^4)^2 / max(d^2, 0.01^2)` and the smooth cone, walking the fragment's tile
//! mask intersected with its z-bin's index range in light-index order. The legacy (`off`) path
//! keeps its falloff (the part1/part2 goldens).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test local_lights -- --ignored metal
//!
//! The GPU probes run the chunk's own functions (`gx_local_light`, `gx_spot_cone`,
//! `gx_light_window`, `gx_light_tile`, `gx_light_zbin`, `gx_light_word_bits`) from the forward
//! shader's source, walking the bins of `cluster::LightBinFrame`'s CPU reference (graph node 4
//! writes the same, bit for bit; `cluster::lights_at` is the walk's CPU mirror). The renderer rows
//! (goldens `lights/spot` and `lights/many`, raw BGRA top row first, 128x72) draw through the
//! forward pass's binned walk; `metal_the_binned_walk_equals_the_brute_force_loop_for_64_lights`
//! holds the walk to an independent all-lights loop over the same rows. `GENEX_RENDER_GOLDEN_UPDATE=1` rewrites goldens; `GENEX_RENDER_EVIDENCE_DIR`
//! writes each compared frame there; `GENEX_RENDER_PERF_DIR` receives the cost row.

use std::path::{Path, PathBuf};

use genex_render::capture::Capture;
use genex_render::cluster::{LIGHT_BIN_HEADER_WORDS, LIGHT_ZBINS, lights_at};
use genex_render::layout::{GpuLight, GpuLightExt, GpuLocalLight, LIGHT_KIND_SPOT, MAX_LOCAL_LIGHTS, NO_SHADOW_SLOT};
use genex_render::lights::{
    BinnedFrame, Lighting, PointLight, SpotLight, binned_frame, legacy_falloff, local_lights, spot_cone, windowed_falloff,
};
use genex_render::settings::LightQuality;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled};
use genex_render::settings::{Look, Quality, SceneFormat, Tonemapper};
use genex_render::{CullPath, Gpu, RenderOptions, Renderer};
use glam::{Vec3, Vec4};

/// The 30° spot of the red-first row: its outer and inner half-angles.
const SPOT_OUTER_DEGREES: f32 = 30.0;
const SPOT_INNER_DEGREES: f32 = 20.0;
/// The equivalence row's light count (the golden pair).
const PAIR_LIGHTS: usize = 64;
/// The stress row's light count and the main-pass budget at 1080p on high (plan §2.5).
const STRESS_LIGHTS: usize = MAX_LOCAL_LIGHTS;
const STRESS_BUDGET_MS: f32 = 2.5;
const STRESS_SAMPLES: usize = 30;
/// Passes drawn before the measured ones, to warm the pipeline up.
const STRESS_WARMUP: usize = 3;
/// The probe's render size and tile side.
const PROBE_SIZE: (u32, u32) = (320, 180);
const PROBE_TILE_PX: u32 = 16;
/// Renderer rows: frame size and golden tolerances (another Apple GPU family rounds differently).
const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
const GOLDEN_CHANNEL_TOLERANCE: u8 = 2;
const GOLDEN_OUTLIER_PIXELS: usize = 46;

// ---------------------------------------------------------------------------------------------
// CPU rows: falloff and cone

#[test]
fn the_window_reaches_zero_exactly_at_the_range_and_is_inverse_square_near_the_light() {
    let range = 5.0;
    assert_eq!(windowed_falloff(range, range), 0.0);
    assert_eq!(windowed_falloff(range * 1.5, range), 0.0, "nothing past the range");
    // Close to the light the window is ~1: the falloff is the inverse square.
    let near = windowed_falloff(0.5, range);
    assert!((near * 0.25 - 1.0).abs() < 2e-3, "1/d² near the light ({near})");
    // Monotone from the clamp outwards.
    let samples: Vec<f32> = (1..100).map(|i| windowed_falloff(i as f32 * 0.05, range)).collect();
    assert!(samples.windows(2).all(|w| w[1] <= w[0]), "falls off monotonically");
    // At the centre the distance clamp holds it finite: 1 / 0.01².
    assert_eq!(windowed_falloff(0.0, range), 1.0 / (0.01 * 0.01));
    // The legacy falloff is kept for the off path: (1 - d/r)² / max(d², 0.01).
    assert_eq!(legacy_falloff(2.0, 4.0), 0.25 / 4.0);
    assert!(windowed_falloff(2.0, 4.0) != legacy_falloff(2.0, 4.0), "the binned path's falloff is the window");
}

#[test]
fn the_cone_is_full_inside_the_inner_angle_dark_past_the_outer_and_smooth_between() {
    let (outer, inner) = (libm::cosf(SPOT_OUTER_DEGREES.to_radians()), libm::cosf(SPOT_INNER_DEGREES.to_radians()));
    let at = |degrees: f32| spot_cone(libm::cosf(degrees.to_radians()), outer, inner);
    assert_eq!(at(0.0), 1.0);
    assert_eq!(at(SPOT_INNER_DEGREES - 0.5), 1.0);
    assert_eq!(at(SPOT_OUTER_DEGREES + 0.5), 0.0);
    let between: Vec<f32> = (0..=20).map(|i| at(SPOT_INNER_DEGREES + i as f32 * 0.5)).collect();
    assert!(between.windows(2).all(|w| w[1] <= w[0]), "falls smoothly from inner to outer: {between:?}");
    assert!(between[10] > 0.0 && between[10] < 1.0);
    // An inner angle equal to the outer one is a hard edge, never a division by zero.
    assert_eq!(spot_cone(outer + 1e-3, outer, outer), 1.0);
    assert_eq!(spot_cone(outer - 1e-3, outer, outer), 0.0);
}

// ---------------------------------------------------------------------------------------------
// CPU rows: the binned rows and bins

/// A deterministic generator (the same lights on every run and destination).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        ((self.0 >> 40) as f32) / ((1u64 << 24) as f32)
    }

    fn range(&mut self, lo: f32, hi: f32) -> f32 {
        lo + (hi - lo) * self.next()
    }
}

/// `count` local lights over the ground around the origin, every fourth a downward spot (some
/// asking for shadows), coloured, deterministic.
fn scattered(count: usize, half_extent: f32, seed: u64) -> Lighting {
    let mut rng = Lcg(seed);
    let mut lighting = Lighting { sun_intensity: 0.0, ambient_intensity: 0.0, shadows: false, ..Lighting::default() };
    for i in 0..count {
        let position = [rng.range(-half_extent, half_extent), rng.range(0.3, 1.8), rng.range(-half_extent, half_extent)];
        let range = rng.range(1.0, 3.5);
        let color = [rng.range(80.0, 255.0) as u8, rng.range(80.0, 255.0) as u8, rng.range(80.0, 255.0) as u8];
        let intensity = rng.range(0.5, 3.0);
        if i % 4 == 3 {
            let outer = rng.range(0.4, 0.9);
            let direction = [rng.range(-0.3, 0.3), -1.0, rng.range(-0.3, 0.3)];
            lighting.spots.push(SpotLight { position, direction, range, color, intensity, inner_angle: outer * 0.6, outer_angle: outer, shadow: i % 8 == 3 });
        } else {
            lighting.points.push(PointLight { position, range, color, intensity });
        }
    }
    lighting
}

/// The probe's camera: above and behind the origin, looking down at the ground.
fn probe_camera() -> CameraDesc {
    CameraDesc::look_at([0.0, 6.0, 12.0], [0.0, 0.0, 0.0])
}

fn forward_of(camera: &CameraDesc) -> [f32; 3] {
    (Vec3::from(camera.target) - Vec3::from(camera.eye)).normalize().to_array()
}

/// The binned path's light quality: every light kept, `tile_px` tiles, `shadowed_spots` slots.
fn all_lights(tile_px: u32, shadowed_spots: u8) -> LightQuality {
    let mut quality = Quality::off().lights;
    quality.clustered = true;
    quality.cap = MAX_LOCAL_LIGHTS as u32;
    quality.tile_px = tile_px;
    quality.shadowed_spots = shadowed_spots;
    quality
}

/// The tables a binned frame binds: the lights and extension rows, and the masks and z-bins of
/// the binning's CPU reference.
struct Tables {
    lights: Vec<GpuLight>,
    ext: Vec<GpuLightExt>,
    masks: Vec<u32>,
    zbins: Vec<u32>,
}

fn tables(frame: &BinnedFrame) -> Tables {
    Tables { lights: frame.lights.clone(), ext: frame.ext.clone(), masks: frame.bins.reference_masks(), zbins: frame.bins.reference_zbins() }
}

/// A point of the ground (y = 0) under each pixel the ray through it hits, with its pixel and view
/// depth: (world, pixel centre, view depth).
fn ground_samples(camera: &CameraDesc, render: (u32, u32), step: u32) -> Vec<([f32; 3], [f32; 2], f32)> {
    let inverse = camera.view_proj(render.0 as f32 / render.1 as f32).inverse();
    let forward = Vec3::from(forward_of(camera));
    let eye = Vec3::from(camera.eye);
    let mut samples = Vec::new();
    for y in (0..render.1).step_by(step as usize) {
        for x in (0..render.0).step_by(step as usize) {
            let pixel = [x as f32 + 0.5, y as f32 + 0.5];
            let ndc = [pixel[0] / render.0 as f32 * 2.0 - 1.0, 1.0 - pixel[1] / render.1 as f32 * 2.0];
            let far = inverse * Vec4::new(ndc[0], ndc[1], 1.0, 1.0);
            let direction = (far.truncate() / far.w - eye).normalize();
            if direction.y >= -1e-4 {
                continue;
            }
            let world = eye + direction * (-eye.y / direction.y);
            samples.push((world.to_array(), pixel, (world - eye).dot(forward)));
        }
    }
    samples
}

#[test]
fn binned_rows_keep_the_cap_nearest_first_in_depth_order_and_shadow_requests_in_scene_order() {
    let camera = probe_camera();
    let lighting = scattered(80, 8.0, 7);
    let mut quality = all_lights(PROBE_TILE_PX, 2);
    quality.cap = 32;
    let frame = binned_frame(&lighting, &quality, &camera, PROBE_SIZE);
    assert_eq!((frame.lights.len(), frame.ext.len()), (32, 32), "the preset's cap");
    let eye = Vec3::from(camera.eye);
    let depth = |light: &GpuLight| (Vec3::from_slice(&light.position_range[..3]) - eye).dot(Vec3::from(forward_of(&camera)));
    assert!(frame.lights.windows(2).all(|w| depth(&w[0]) <= depth(&w[1])), "sorted by view depth");
    // Every kept row is a scene row with its own extension row (the last kept ones fade towards
    // the cut, `cluster::cap_fade`, so their radiance may be lower); the dropped ones reach no
    // nearer the camera than any kept one. RQ6 review: every shadow request is marked (the slots
    // are granted after binning), so the scene rows are `local_lights(.., usize::MAX)`.
    let all = local_lights(&lighting, MAX_LOCAL_LIGHTS, usize::MAX);
    let kept: Vec<GpuLocalLight> = frame.lights.iter().zip(&frame.ext).map(|(light, ext)| GpuLocalLight { light: *light, ext: *ext }).collect();
    let same_row = |a: &GpuLocalLight, b: &GpuLocalLight| a.light.position_range == b.light.position_range && a.ext == b.ext;
    assert!(kept.iter().all(|row| all.iter().any(|scene| same_row(row, scene))), "rows keep their extension rows");
    let dimmer = kept.iter().filter(|row| !all.contains(row)).count();
    assert!(dimmer > 0 && dimmer <= 4, "the last tenth of the cap fades ({dimmer} rows)");
    let reach = |row: &GpuLocalLight| ((Vec3::from_slice(&row.light.position_range[..3]) - eye).length() - row.light.position_range[3]).max(0.0);
    let farthest_kept = kept.iter().map(reach).fold(0.0f32, f32::max);
    let dropped: Vec<&GpuLocalLight> = all.iter().filter(|scene| !kept.iter().any(|row| same_row(row, scene))).collect();
    assert_eq!(dropped.len(), all.len() - 32);
    assert!(dropped.iter().all(|row| reach(row) >= farthest_kept), "lights past the cap drop farthest first");
    // Shadow requests were marked in scene order, before sorting.
    let requests: Vec<f32> = local_lights(&lighting, MAX_LOCAL_LIGHTS, 2).iter().map(|row| row.ext.params[2]).filter(|slot| *slot != NO_SHADOW_SLOT).collect();
    assert_eq!(requests, [0.0, 1.0]);
    assert_eq!(frame, binned_frame(&lighting, &quality, &camera, PROBE_SIZE), "the same tables every run");
}

/// The lights that reach `world` (window and cone above 0), by sorted index.
fn reaching(frame: &BinnedFrame, world: [f32; 3]) -> Vec<u32> {
    let at = Vec3::from(world);
    let reaches = |(light, ext): (&GpuLight, &GpuLightExt)| {
        let to_light = Vec3::from_slice(&light.position_range[..3]) - at;
        let distance = to_light.length();
        let cone = if ext.params[1] == LIGHT_KIND_SPOT { spot_cone((-to_light / distance).dot(Vec3::from_slice(&ext.spot[..3])), ext.spot[3], ext.params[0]) } else { 1.0 };
        windowed_falloff(distance, light.position_range[3]) * cone > 0.0
    };
    frame.lights.iter().zip(&frame.ext).enumerate().filter(|(_, row)| reaches(*row)).map(|(i, _)| i as u32).collect()
}

/// The walk's lights at a sample (`cluster::lights_at`, the pixel's integer coordinates).
fn walk_at(tables: &Tables, pixel: [f32; 2], depth: f32) -> Vec<u32> {
    lights_at(&tables.masks, &tables.zbins, (pixel[0] as u32, pixel[1] as u32), depth)
}

#[test]
fn every_light_the_window_lets_reach_a_fragment_is_in_its_walk_and_the_bins_cull() {
    let camera = probe_camera();
    let frame = binned_frame(&scattered(PAIR_LIGHTS, 6.0, 11), &all_lights(PROBE_TILE_PX, 0), &camera, PROBE_SIZE);
    let tables = tables(&frame);
    assert_eq!(tables.zbins.len(), (LIGHT_BIN_HEADER_WORDS + LIGHT_ZBINS) as usize);
    assert_eq!(frame.bins.params.depth[1], PAIR_LIGHTS as u32);
    let samples = ground_samples(&camera, PROBE_SIZE, 3);
    let (mut walked, mut reached) = (0usize, 0usize);
    for (world, pixel, depth) in &samples {
        let visited = walk_at(&tables, *pixel, *depth);
        assert!(visited.windows(2).all(|w| w[0] < w[1]), "light-index order");
        let lit = reaching(&frame, *world);
        for light in &lit {
            assert!(visited.contains(light), "light {light} reaches {world:?} (pixel {pixel:?}) but is not in its walk");
        }
        walked += visited.len();
        reached += lit.len();
    }
    assert!(reached > 0, "the lights reach the ground");
    assert!(walked < samples.len() * PAIR_LIGHTS / 4, "the bins cull: {walked} walked of {} brute force", samples.len() * PAIR_LIGHTS);
}

#[test]
fn hostile_lights_are_walked_nowhere() {
    let camera = probe_camera();
    let sane = PointLight { position: [0.0, 0.5, 0.0], range: 2.0, color: [255; 3], intensity: 1.0 };
    let hostile = [
        PointLight { position: [f32::NAN, 0.0, 0.0], ..sane },
        PointLight { range: -1.0, ..sane },
        PointLight { range: f32::NAN, ..sane },
        // Behind the camera: lights nothing in front of it.
        PointLight { position: [0.0, 6.0, 30.0], ..sane },
    ];
    let lighting = Lighting { points: hostile.iter().copied().chain([sane]).collect(), ..Lighting::default() };
    let frame = binned_frame(&lighting, &all_lights(PROBE_TILE_PX, 0), &camera, PROBE_SIZE);
    let tables = tables(&frame);
    let sane_index = frame.lights.iter().position(|light| light.position_range == [0.0, 0.5, 0.0, 2.0]).expect("the sane light is kept") as u32;
    let samples = ground_samples(&camera, PROBE_SIZE, 4);
    let mut lit = 0;
    for (_, pixel, depth) in &samples {
        let visited = walk_at(&tables, *pixel, *depth);
        assert!(visited.iter().all(|light| *light == sane_index), "only the sane light walks at {pixel:?}: {visited:?}");
        lit += visited.len();
    }
    assert!(lit > 0, "the sane light is binned");
}

// ---------------------------------------------------------------------------------------------
// GPU rows

/// The GPU rows run one at a time: the cost row times its pass, and a probe on another thread
/// would share the GPU with it.
static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu_row() -> std::sync::MutexGuard<'static, ()> {
    GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

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

fn storage(gpu: &Gpu, label: &str, bytes: &[u8]) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    // A storage binding is at least 4 bytes (an empty table binds one zero word).
    let contents = if bytes.is_empty() { &[0u8; 16][..] } else { bytes };
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some(label),
        contents,
        usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::UNIFORM,
    })
}

fn read_buffer(gpu: &Gpu, buffer: &wgpu::Buffer, bytes: u64) -> Vec<u8> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("local lights readback"),
        size: bytes,
        usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
        mapped_at_creation: false,
    });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("local lights readback") });
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, bytes);
    gpu.queue.submit([encoder.finish()]);
    staging.slice(..).map_async(wgpu::MapMode::Read, |result| result.expect("mapped"));
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
    let data = staging.slice(..).get_mapped_range().expect("mapped range").to_vec();
    staging.unmap();
    data
}

/// The probe's bindings past every slot the forward frame group uses (0-29), so the forward
/// source stays as it is and the auto layout holds exactly what the probe touches.
const PROBE_WGSL: &str = r"
@group(0) @binding(40) var<storage, read_write> probe_rows: array<vec4<f32>>;
@group(0) @binding(41) var<storage, read> probe_lights: array<Light>;
@group(0) @binding(42) var<storage, read> probe_ext: array<vec4<f32>>;
@group(0) @binding(43) var<storage, read> probe_tiles: array<u32>;
@group(0) @binding(44) var<storage, read> probe_zbins: array<u32>;

// A rough white dielectric facing up, seen from straight above.
fn probe_surface(world: vec3<f32>) -> Surface {
    let up = vec3<f32>(0.0, 1.0, 0.0);
    return Surface(world, up, up, up, vec3<f32>(1.0), 1.0, 0.0, 1.0);
}

fn probe_ext_of(i: u32) -> LightExt {
    return LightExt(probe_ext[i * GX_LIGHT_EXT_VEC4S], probe_ext[i * GX_LIGHT_EXT_VEC4S + 1u]);
}

// The binned walk over the probe's tables: the fragment's tile mask intersected with its z-bin's
// index range, in light-index order (the forward walk's loop, over the chunk's helpers).
fn probe_binned(s: Surface, pixel: vec2<f32>, view_depth: f32) -> vec4<f32> {
    let grid = vec4<u32>(probe_zbins[0], probe_zbins[1], probe_zbins[2], probe_zbins[3]);
    let depth = vec4<u32>(probe_zbins[4], probe_zbins[5], probe_zbins[6], probe_zbins[7]);
    var lit = vec3<f32>(0.0);
    var visited = 0u;
    if depth.y == 0u {
        return vec4<f32>(lit, 0.0);
    }
    let zbin = probe_zbins[GX_LIGHT_BIN_HEADER_WORDS + gx_light_zbin(view_depth, depth)];
    let lowest = zbin & 0xffffu;
    let highest = zbin >> GX_ZBIN_INDEX_BITS;
    if lowest > highest {
        return vec4<f32>(lit, 0.0);
    }
    let base = gx_light_tile(pixel, grid) * grid.z;
    for (var word = lowest / 32u; word <= highest / 32u; word++) {
        var bits = probe_tiles[base + word] & gx_light_word_bits(word, lowest, highest);
        while bits != 0u {
            let i = word * 32u + firstTrailingBit(bits);
            bits &= bits - 1u;
            lit += gx_local_light(s, probe_lights[i], probe_ext_of(i));
            visited++;
        }
    }
    return vec4<f32>(lit, f32(visited));
}

// Rows of four vec4: in (world xyz, view depth), in (pixel xy, 0, 0), out brute force (rgb, n),
// out binned (rgb, lights walked). Also writes the window and cone of light 0 into the in rows' zw.
@compute @workgroup_size(64)
fn cs_local_lights_probe(@builtin(global_invocation_id) id: vec3<u32>) {
    let rows = arrayLength(&probe_rows) / 4u;
    if id.x >= rows {
        return;
    }
    let at = id.x * 4u;
    let world = probe_rows[at].xyz;
    let s = probe_surface(world);
    let count = arrayLength(&probe_lights);
    var brute = vec3<f32>(0.0);
    for (var i = 0u; i < count; i++) {
        brute += gx_local_light(s, probe_lights[i], probe_ext_of(i));
    }
    probe_rows[at + 2u] = vec4<f32>(brute, f32(count));
    probe_rows[at + 3u] = probe_binned(s, probe_rows[at + 1u].xy, probe_rows[at].w);
    let to_light = probe_lights[0].position_range.xyz - world;
    let distance = length(to_light);
    let window = gx_light_window(distance, probe_lights[0].position_range.w);
    let cone = gx_spot_cone(probe_ext_of(0u), to_light / max(distance, 0.0001));
    probe_rows[at + 1u] = vec4<f32>(probe_rows[at + 1u].xy, window, cone);
}
";

/// What the probe returns per sample.
struct ProbeRow {
    brute: [f32; 3],
    binned: [f32; 3],
    walked: u32,
    window: f32,
    cone: f32,
}

/// Run the probe over `samples` with a binned frame's `tables`.
fn run_probe(gpu: &Gpu, tables: &Tables, samples: &[([f32; 3], [f32; 2], f32)]) -> Vec<ProbeRow> {
    let source = format!("{}\n{PROBE_WGSL}", genex_render::shaders::FORWARD);
    let module = gpu.device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("local lights probe"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = gpu.device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("local lights probe"),
        layout: None,
        module: &module,
        entry_point: Some("cs_local_lights_probe"),
        compilation_options: Default::default(),
        cache: None,
    });
    let data: Vec<[f32; 4]> = samples
        .iter()
        .flat_map(|(world, pixel, depth)| [[world[0], world[1], world[2], *depth], [pixel[0], pixel[1], 0.0, 0.0], [0.0; 4], [0.0; 4]])
        .collect();
    let probe = storage(gpu, "probe rows", bytemuck::cast_slice(&data));
    let buffers = [
        storage(gpu, "probe lights", bytemuck::cast_slice(&tables.lights)),
        storage(gpu, "probe ext", bytemuck::cast_slice(&tables.ext)),
        storage(gpu, "probe tiles", bytemuck::cast_slice(&tables.masks)),
        storage(gpu, "probe zbins", bytemuck::cast_slice(&tables.zbins)),
    ];
    let mut entries = vec![wgpu::BindGroupEntry { binding: 40, resource: probe.as_entire_binding() }];
    entries.extend(buffers.iter().enumerate().map(|(i, buffer)| wgpu::BindGroupEntry { binding: 41 + i as u32, resource: buffer.as_entire_binding() }));
    let group = gpu.device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("local lights probe"), layout: &pipeline.get_bind_group_layout(0), entries: &entries });
    let mut encoder = gpu.device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("local lights probe") });
    {
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("local lights probe"), timestamp_writes: None });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((samples.len() as u32).div_ceil(64), 1, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    let bytes = read_buffer(gpu, &probe, (data.len() * 16) as u64);
    bytemuck::cast_slice::<u8, [f32; 4]>(&bytes)
        .chunks(4)
        .map(|row| ProbeRow {
            brute: [row[2][0], row[2][1], row[2][2]],
            binned: [row[3][0], row[3][1], row[3][2]],
            walked: row[3][3] as u32,
            window: row[1][2],
            cone: row[1][3],
        })
        .collect()
}

/// The 30° spot straight down from `height` over the ground, unshadowed.
fn down_spot(height: f32) -> SpotLight {
    SpotLight {
        position: [0.0, height, 0.0],
        direction: [0.0, -1.0, 0.0],
        range: 10.0,
        color: [255, 255, 255],
        intensity: 4.0,
        inner_angle: SPOT_INNER_DEGREES.to_radians(),
        outer_angle: SPOT_OUTER_DEGREES.to_radians(),
        shadow: false,
    }
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_30_degree_spot_lights_a_disc_whose_edge_falls_between_its_inner_and_outer_angles() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let height = 2.0;
    let spot = down_spot(height);
    let lighting = Lighting { spots: vec![spot], ..Lighting::default() };
    let camera = probe_camera();
    let frame = tables(&binned_frame(&lighting, &all_lights(PROBE_TILE_PX, 0), &camera, PROBE_SIZE));
    assert_eq!(frame.ext[0].params[1], LIGHT_KIND_SPOT);
    // The same light as a point: the cone is the only difference.
    let point = Tables { ext: vec![GpuLightExt::POINT], ..tables(&binned_frame(&lighting, &all_lights(PROBE_TILE_PX, 0), &camera, PROBE_SIZE)) };
    // Samples along the ground from under the light outwards, past the outer angle.
    let samples: Vec<([f32; 3], [f32; 2], f32)> = (0..400).map(|i| ([i as f32 * 0.005, 0.0, 0.0], [0.0; 2], 1.0)).collect();
    let lit = run_probe(&gpu, &frame, &samples);
    let bare = run_probe(&gpu, &point, &samples);
    let angle = |x: f32| libm::atanf(x / height).to_degrees();
    let (outer, inner) = (libm::cosf(SPOT_OUTER_DEGREES.to_radians()), libm::cosf(SPOT_INNER_DEGREES.to_radians()));
    let mut half_edge = None;
    for ((sample, spot_row), point_row) in samples.iter().zip(&lit).zip(&bare) {
        let x = sample.0[0];
        let degrees = angle(x);
        let distance = (x * x + height * height).sqrt();
        // The chunk's window and cone equal their CPU mirrors.
        let window = windowed_falloff(distance, spot.range);
        assert!((spot_row.window - window).abs() <= window * 1e-4, "window at {x}: {} vs {window}", spot_row.window);
        let cone = spot_cone(height / distance, outer, inner);
        assert!((spot_row.cone - cone).abs() <= 2e-4, "cone at {degrees}°: {} vs {cone}", spot_row.cone);
        let ratio = spot_row.brute[0] / point_row.brute[0].max(f32::MIN_POSITIVE);
        if degrees < SPOT_INNER_DEGREES - 0.2 {
            assert!((ratio - 1.0).abs() < 1e-3, "full strength inside the inner angle ({degrees}°: {ratio})");
        }
        if degrees > SPOT_OUTER_DEGREES + 0.2 {
            assert_eq!(spot_row.brute, [0.0; 3], "dark past the outer angle ({degrees}°)");
        }
        if half_edge.is_none() && ratio < 0.5 {
            half_edge = Some(degrees);
        }
    }
    // The disc's edge (half its centre's strength) falls inside [inner, outer].
    let edge = half_edge.expect("the disc has an edge");
    assert!((SPOT_INNER_DEGREES..=SPOT_OUTER_DEGREES).contains(&edge), "the disc's edge at {edge}° is not inside [{SPOT_INNER_DEGREES}°, {SPOT_OUTER_DEGREES}°]");
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_binned_walk_equals_the_brute_force_loop_for_64_lights() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let camera = probe_camera();
    let frame = tables(&binned_frame(&scattered(PAIR_LIGHTS, 6.0, 11), &all_lights(PROBE_TILE_PX, 0), &camera, PROBE_SIZE));
    assert_eq!(frame.lights.len(), PAIR_LIGHTS);
    let samples = ground_samples(&camera, PROBE_SIZE, 2);
    let probed = run_probe(&gpu, &frame, &samples);
    let (mut worst, mut walked, mut lit) = (0.0f32, 0u64, 0usize);
    for (sample, row) in samples.iter().zip(&probed) {
        // The GPU walk visits exactly the lights the CPU mirror of the walk lists.
        assert_eq!(row.walked as usize, walk_at(&frame, sample.1, sample.2).len(), "walk at pixel {:?}", sample.1);
        for (binned, brute) in row.binned.iter().zip(row.brute) {
            let error = (binned - brute).abs() / brute.abs().max(1e-3);
            worst = worst.max(error);
        }
        walked += u64::from(row.walked);
        lit += usize::from(row.brute.iter().any(|c| *c > 1e-3));
    }
    assert!(lit > samples.len() / 4, "the lights light the ground ({lit} of {} samples)", samples.len());
    assert!(worst <= 1e-4, "binned and brute force differ by {worst} (relative)");
    let brute_force = samples.len() as u64 * PAIR_LIGHTS as u64;
    assert!(walked * 4 < brute_force, "the walk culls: {walked} of {brute_force} light evaluations");
    eprintln!("walked {walked} of {brute_force} light evaluations ({:.1}%)", walked as f64 * 100.0 / brute_force as f64);
}

/// A full-screen pass shading the ground under every pixel through the binned walk, at 1080p:
/// the forward pass's local-light cost on a surface covering the screen.
const STRESS_WGSL: &str = r"
@group(0) @binding(41) var<storage, read> probe_lights: array<Light>;
@group(0) @binding(42) var<storage, read> probe_ext: array<vec4<f32>>;
@group(0) @binding(43) var<storage, read> probe_tiles: array<u32>;
@group(0) @binding(44) var<storage, read> probe_zbins: array<u32>;
// The camera: inverse view-projection, eye (w: render width), forward (w: render height).
@group(0) @binding(45) var<uniform> stress_camera: array<vec4<f32>, 6>;

@vertex
fn vs_stress(@builtin(vertex_index) index: u32) -> @builtin(position) vec4<f32> {
    let uv = vec2<f32>(f32((index << 1u) & 2u), f32(index & 2u));
    return vec4<f32>(uv * 2.0 - 1.0, 0.0, 1.0);
}

@fragment
fn fs_stress(@builtin(position) position: vec4<f32>) -> @location(0) vec4<f32> {
    let size = vec2<f32>(stress_camera[4].w, stress_camera[5].w);
    let inverse = mat4x4<f32>(stress_camera[0], stress_camera[1], stress_camera[2], stress_camera[3]);
    let ndc = vec2<f32>(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0);
    let far = inverse * vec4<f32>(ndc, 1.0, 1.0);
    let eye = stress_camera[4].xyz;
    let direction = normalize(far.xyz / far.w - eye);
    if direction.y >= -1e-4 {
        return vec4<f32>(0.0, 0.0, 0.0, 1.0);
    }
    let world = eye + direction * (-eye.y / direction.y);
    let up = vec3<f32>(0.0, 1.0, 0.0);
    let s = Surface(world, up, up, -direction, vec3<f32>(0.8), 1.0, 0.0, 0.6);
    return vec4<f32>(probe_binned(s, position.xy, dot(world - eye, stress_camera[5].xyz)).rgb, 1.0);
}
";

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_1024_lights_shade_a_1080p_screen_within_the_main_pass_budget() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let device = &gpu.device;
    if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no TIMESTAMP_QUERY on this adapter");
        return;
    }
    let render = (1920u32, 1080u32);
    let camera = CameraDesc::look_at([0.0, 8.0, 18.0], [0.0, 0.0, -4.0]);
    let binned = binned_frame(&scattered(STRESS_LIGHTS, 16.0, 5), &all_lights(16, 0), &camera, render);
    let frame = tables(&binned);
    assert_eq!(frame.lights.len(), STRESS_LIGHTS);
    // Only the probe's helpers and walk: the probe compute entry is not part of this pipeline.
    let helpers = PROBE_WGSL.split("// Rows of four vec4").next().expect("the probe's helpers");
    let walk = helpers.lines().filter(|line| !line.contains("@binding(4")).collect::<Vec<_>>().join("\n");
    let source = format!("{}\n{STRESS_WGSL}\n{walk}", genex_render::shaders::FORWARD);
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("local lights stress"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let format = wgpu::TextureFormat::Rgba16Float;
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("local lights stress"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs_stress"), compilation_options: Default::default(), buffers: &[] },
        fragment: Some(wgpu::FragmentState {
            module: &module,
            entry_point: Some("fs_stress"),
            compilation_options: Default::default(),
            targets: &[Some(format.into())],
        }),
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview_mask: None,
        cache: None,
    });
    let inverse = camera.view_proj(render.0 as f32 / render.1 as f32).inverse().to_cols_array_2d();
    let forward = forward_of(&camera);
    let camera_rows: Vec<[f32; 4]> =
        inverse.iter().copied().chain([[camera.eye[0], camera.eye[1], camera.eye[2], render.0 as f32], [forward[0], forward[1], forward[2], render.1 as f32]]).collect();
    let buffers = [
        storage(&gpu, "stress lights", bytemuck::cast_slice(&frame.lights)),
        storage(&gpu, "stress ext", bytemuck::cast_slice(&frame.ext)),
        storage(&gpu, "stress tiles", bytemuck::cast_slice(&frame.masks)),
        storage(&gpu, "stress zbins", bytemuck::cast_slice(&frame.zbins)),
        storage(&gpu, "stress camera", bytemuck::cast_slice(&camera_rows)),
    ];
    let entries: Vec<wgpu::BindGroupEntry<'_>> =
        buffers.iter().enumerate().map(|(i, buffer)| wgpu::BindGroupEntry { binding: 41 + i as u32, resource: buffer.as_entire_binding() }).collect();
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: Some("local lights stress"), layout: &pipeline.get_bind_group_layout(0), entries: &entries });
    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("local lights stress target"),
        size: wgpu::Extent3d { width: render.0, height: render.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let view = target.create_view(&wgpu::TextureViewDescriptor::default());
    // Every sample is submitted back to back with its own pair of timestamps and resolved once the
    // queue drains. Waiting on each sample left the GPU idle between passes, so it clocked down and
    // the p95 of 30 samples read the clock ramp (1-2.9 ms against a 0.58 ms p50; 5 of 15 runs over
    // budget at gate round 2), not the pass's cost. Frames reach the GPU back to back in a game too.
    let passes = STRESS_SAMPLES + STRESS_WARMUP;
    let queries = u32::try_from(passes * 2).expect("query count");
    let query_set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("local lights stress"), ty: wgpu::QueryType::Timestamp, count: queries });
    let resolve_bytes = u64::from(queries) * 8;
    let resolve = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("local lights stress resolve"),
        size: resolve_bytes,
        usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
        mapped_at_creation: false,
    });
    let period = gpu.queue.get_timestamp_period();
    for sample in 0..passes {
        let first = u32::try_from(sample * 2).expect("query index");
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("local lights stress") });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("local lights stress"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    depth_slice: None,
                    resolve_target: None,
                    ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: Some(wgpu::RenderPassTimestampWrites {
                    query_set: &query_set,
                    beginning_of_pass_write_index: Some(first),
                    end_of_pass_write_index: Some(first + 1),
                }),
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&pipeline);
            pass.set_bind_group(0, &group, &[]);
            pass.draw(0..3, 0..1);
        }
        gpu.queue.submit([encoder.finish()]);
    }
    let _ = device.poll(wgpu::PollType::wait_indefinitely());
    // Resolved in a later submission: Metal resolves counter samples without waiting for the
    // passes that write them.
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor { label: Some("local lights stress resolve") });
    encoder.resolve_query_set(&query_set, 0..queries, &resolve, 0);
    gpu.queue.submit([encoder.finish()]);
    let data = read_buffer(&gpu, &resolve, resolve_bytes);
    let tick = |i: usize| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes"));
    // Back to back, a pass's begin stamp can fall while the passes queued before it still draw, so its
    // span is not its cost. The passes write one target and run one after another: the time between
    // two passes' end stamps is the later pass's cost. The first frames warm the pipeline up.
    let end = |sample: usize| tick(sample * 2 + 1);
    let mut costs: Vec<f32> = (STRESS_WARMUP..passes).filter_map(|sample| genex_render::timing::span_ms(end(sample - 1), end(sample), period)).collect();
    assert!(costs.len() >= STRESS_SAMPLES / 2, "timestamps resolved for {} samples", costs.len());
    costs.sort_by(f32::total_cmp);
    let at = |q: f32| costs[((costs.len() - 1) as f32 * q).round() as usize];
    let (p50, p95) = (at(0.5), at(0.95));
    let words = binned.bins.grid.words_per_tile as usize;
    let busiest = (0..(binned.bins.grid.tiles_x * binned.bins.grid.tiles_y) as usize)
        .map(|tile| frame.masks[tile * words..tile * words + words].iter().map(|w| w.count_ones()).sum::<u32>())
        .max()
        .unwrap_or(0);
    let row = format!(
        "{{\"row\":\"local-lights\",\"render\":[{},{}],\"lights\":{STRESS_LIGHTS},\"tilePx\":16,\"busiestTile\":{busiest},\"samples\":{},\"p50Ms\":{p50:.4},\"p95Ms\":{p95:.4},\"budgetMs\":{STRESS_BUDGET_MS},\"adapter\":\"{}\"}}\n",
        render.0,
        render.1,
        costs.len(),
        gpu.receipt().adapter
    );
    eprint!("{row}");
    if let Ok(dir) = std::env::var("GENEX_RENDER_PERF_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(PathBuf::from(dir).join("local-lights-1024.json"), &row).expect("perf row");
    }
    assert!(p95 <= STRESS_BUDGET_MS, "1024 lights at 1080p: p95 {p95:.3} ms over the {STRESS_BUDGET_MS} ms budget");
}

// ---------------------------------------------------------------------------------------------
// Renderer rows (goldens lights/spot and lights/many)

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/render-goldens/lights")
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let dir = PathBuf::from(dir);
        let _ = std::fs::create_dir_all(&dir);
        std::fs::write(dir.join(format!("{name}.bgra")), capture.bgra()).expect("evidence");
    }
}

/// Compare `capture` with the golden `name`, or rewrite it under `GENEX_RENDER_GOLDEN_UPDATE=1`.
fn check_golden(name: &str, capture: &Capture) {
    assert_eq!((capture.width(), capture.height()), (WIDTH, HEIGHT));
    write_evidence(name, capture);
    let path = goldens_dir().join(format!("{name}.bgra"));
    if std::env::var("GENEX_RENDER_GOLDEN_UPDATE").is_ok_and(|v| v == "1") {
        std::fs::create_dir_all(goldens_dir()).expect("goldens folder");
        std::fs::write(&path, capture.bgra()).expect("golden written");
        return;
    }
    let golden = std::fs::read(&path).unwrap_or_else(|error| panic!("golden {path:?} missing ({error}); render it with GENEX_RENDER_GOLDEN_UPDATE=1"));
    assert_eq!(golden.len(), capture.bgra().len());
    let (mut outliers, mut worst) = (0, 0u8);
    for (a, b) in golden.chunks(4).zip(capture.bgra().chunks(4)) {
        let diff = a.iter().zip(b).map(|(p, q)| p.abs_diff(*q)).max().unwrap_or(0);
        worst = worst.max(diff);
        outliers += usize::from(diff > GOLDEN_CHANNEL_TOLERANCE);
    }
    assert!(outliers <= GOLDEN_OUTLIER_PIXELS, "{name}: {outliers} pixels differ from the golden by more than {GOLDEN_CHANNEL_TOLERANCE} (worst {worst})");
}

/// A single-sampled HDR renderer at EV 0 (AgX), its local lights binned with `tile_px` tiles.
fn binned_renderer(gpu: &Gpu, tile_px: u32) -> Renderer {
    let mut renderer = Renderer::with_options(gpu, WIDTH, HEIGHT, RenderOptions { msaa: false }).expect("renderer");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.lights.clustered = true;
    quality.lights.cap = MAX_LOCAL_LIGHTS as u32;
    quality.lights.tile_px = tile_px;
    renderer.set_quality(&quality);
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    let mut look = Look::default();
    look.tonemapper = Tonemapper::Agx;
    look.ev_compensation = 0.0;
    renderer.set_look(look);
    renderer
}

/// A grey ground in the dark under `lighting`'s local lights.
fn ground_scene(camera: CameraDesc, lighting: Lighting) -> Scene {
    let mut scene = Scene::new(camera, [0, 0, 0, 255]);
    scene.lighting = Lighting { sun_intensity: 0.0, ambient_intensity: 0.0, shadows: false, ..lighting };
    scene.draw(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [24.0, 0.1, 24.0]), Material::color([180, 180, 180, 255]));
    scene
}

fn draw(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene) -> (Capture, Vec<[f32; 4]>) {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    let radiance = renderer.read_scene(gpu).expect("the HDR scene reads back");
    (renderer.capture(gpu).expect("capture"), radiance)
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_forward_pass_lights_a_spot_disc_on_the_ground() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let camera = CameraDesc::look_at([0.0, 5.0, 5.0], [0.0, 0.0, 0.0]);
    let lit = Lighting { spots: vec![down_spot(2.0)], ..Lighting::default() };
    let mut renderer = binned_renderer(&gpu, 16);
    let (capture, radiance) = draw(&gpu, &mut renderer, &ground_scene(camera, lit));
    let (_, dark) = draw(&gpu, &mut renderer, &ground_scene(camera, Lighting::default()));
    let centre = radiance[(HEIGHT / 2 * WIDTH + WIDTH / 2) as usize];
    assert_ne!(radiance, dark, "the spot lights the frame");
    assert!(centre[0] > 0.05, "the disc under the spot is lit ({centre:?})");
    let lit_pixels = radiance.iter().filter(|t| t[0] > 1e-3).count();
    assert!(lit_pixels > 200 && lit_pixels < (WIDTH * HEIGHT) as usize / 2, "a disc, not the whole ground ({lit_pixels} pixels)");
    check_golden("spot", &capture);
}

#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_the_forward_pass_binned_by_tiles_equals_one_tile_for_64_lights() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let camera = CameraDesc::look_at([0.0, 6.0, 12.0], [0.0, 0.0, 0.0]);
    let scene = ground_scene(camera, scattered(PAIR_LIGHTS, 6.0, 11));
    let (capture, tiled) = draw(&gpu, &mut binned_renderer(&gpu, 16), &scene);
    // One tile covering the frame: every light in every tile, the brute-force set of the z-bins.
    let (_, whole) = draw(&gpu, &mut binned_renderer(&gpu, WIDTH.max(HEIGHT)), &scene);
    let mut worst = 0.0f32;
    for (a, b) in tiled.iter().zip(&whole) {
        for (p, q) in a[..3].iter().zip(&b[..3]) {
            worst = worst.max((p - q).abs() / q.abs().max(1e-2));
        }
    }
    assert!(worst <= 1e-3, "tiled and one-tile frames differ by {worst} (relative)");
    check_golden("many", &capture);
}

/// The mean of the BGRA capture's green channel over a `half`-pixel square around its centre and
/// over its top-left corner square.
fn centre_and_corner(capture: &Capture, half: u32) -> (f64, f64) {
    let bgra = capture.bgra();
    let mean = |x0: u32, y0: u32| -> f64 {
        let mut sum = 0u64;
        for y in y0..y0 + 2 * half {
            for x in x0..x0 + 2 * half {
                sum += u64::from(bgra[((y * WIDTH + x) * 4 + 1) as usize]);
            }
        }
        sum as f64 / f64::from(4 * half * half)
    };
    (mean(WIDTH / 2 - half, HEIGHT / 2 - half), mean(0, 0))
}

// RQ6 review: spots on every scene path. Before, a frame on the legacy LDR scene (the `hdr` switch
// off, a v1 material or pass) or with the `clustered` switch off shaded only the point lights of
// the legacy table, so every spot vanished.
#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_spot_lights_its_disc_on_the_ldr_scene_and_on_the_legacy_loop() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let camera = CameraDesc::look_at([0.0, 5.0, 5.0], [0.0, 0.0, 0.0]);
    let lit = Lighting { spots: vec![down_spot(2.0)], ..Lighting::default() };
    for (name, hdr, clustered) in [("ldr-binned", false, true), ("hdr-legacy-loop", true, false), ("ldr-legacy-loop", false, false)] {
        let mut renderer = binned_renderer(&gpu, 16);
        let mut quality = *renderer.quality();
        quality.hdr = hdr;
        quality.lights.clustered = clustered;
        renderer.set_quality(&quality);
        let spot = draw_ldr(&gpu, &mut renderer, &ground_scene(camera, lit.clone()));
        let dark = draw_ldr(&gpu, &mut renderer, &ground_scene(camera, Lighting::default()));
        let (centre, corner) = centre_and_corner(&spot, 4);
        let (dark_centre, _) = centre_and_corner(&dark, 4);
        assert!(centre > dark_centre + 20.0, "{name}: the disc under the spot is lit ({dark_centre} -> {centre})");
        assert!(corner < centre * 0.5, "{name}: a disc, not the whole ground (corner {corner}, centre {centre})");
        write_evidence(&format!("spot-{name}"), &spot);
    }
}

/// A frame drawn on whichever scene path the quality picks (the HDR scene is not read back).
fn draw_ldr(gpu: &Gpu, renderer: &mut Renderer, scene: &Scene) -> Capture {
    renderer.render(gpu, scene, CullPath::Gpu).expect("frame");
    renderer.capture(gpu).expect("capture")
}


#[test]
#[ignore = "GPU: run with -- --ignored metal"]
fn metal_a_binned_frame_records_the_light_binning_pass_and_an_unlit_one_does_not() {
    let _row = gpu_row();
    let Some(gpu) = gpu() else { return };
    let camera = CameraDesc::look_at([0.0, 6.0, 12.0], [0.0, 0.0, 0.0]);
    let mut renderer = binned_renderer(&gpu, 16);
    draw(&gpu, &mut renderer, &ground_scene(camera, Lighting::default()));
    let unlit = renderer.last_stats().compute_passes;
    draw(&gpu, &mut renderer, &ground_scene(camera, scattered(PAIR_LIGHTS, 6.0, 11)));
    let binned = renderer.last_stats().compute_passes;
    // Graph node 4 (RQ6.7): the masks and z-bins are built on the GPU, one compute pass a frame.
    assert_eq!(binned, unlit + 1, "a frame with local lights records the binning pass");
}
