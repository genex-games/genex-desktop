//! A.6 screen inputs and the SSR helper: the march helper against its CPU twin, the opaque copy,
//! the previous frame's colour pyramid, the prepass's normal and roughness packing and the screen
//! reflections' slot (binding 30).
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test screen_inputs -- --ignored metal --test-threads=1
//!
//! The march rows trace rays over a synthetic scene (a floor, a back wall and pillars, its depth
//! computed on the CPU through the renderer's reverse-Z infinite projection) on both sides: the
//! helper in a compute kernel and its CPU twin. `GENEX_PERF_OUT` receives the cost rows as JSON
//! lines.

use genex_render::Gpu;
use genex_render::abi::FORWARD_FRAGMENT_TEXTURES_MAX;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::layout::{FRAME_EFFECT_BINDINGS, FRAME_ENV_BOUND, FRAME_INSTANCE_FADE_BINDING, FRAME_LIGHT_BINDINGS, FRAME_MATERIAL_CLASS_BINDINGS};
use genex_render::presets::preset_quality;
use genex_render::screen_inputs::march::{self, DepthImage, SsrHit, SsrMarch};
use genex_render::screen_inputs::{
    FRAME_REFLECTIONS_BINDING, HISTORY_PYRAMID, NORMAL_ROUGHNESS, NORMAL_ROUGHNESS_FORMAT, OPAQUE_COPY_MS_MAX, PYRAMID_FORMAT, PYRAMID_MIPS_MAX, PyramidInput, PyramidNode, PyramidStamps,
    SSR_MARCH, ScreenInputs, encode_opaque_copy, frame_inputs, pack_normal_roughness, pyramid_mips, pyramid_reference, pyramid_size, target_bytes, targets, unpack_normal_roughness,
};
use genex_render::settings::{AntiAliasing, Quality, QualityPreset};
use glam::{Mat4, Vec3, Vec4};

const NEAR: f32 = 0.1;
const FOV_Y_DEG: f32 = 60.0;
const PRESETS: [QualityPreset; 4] = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];
/// Copies a cost sample records back to back (a lone copy after an idle wait pays the GPU's wake-up).
const COST_COPIES_PER_SAMPLE: u32 = 16;
/// Pyramid builds a cost sample records back to back.
const COST_BUILDS_PER_SAMPLE: u32 = 16;
/// Cost samples per row (the row reports their median).
const COST_SAMPLES: usize = 15;
/// Samples drawn and dropped before the measured ones (the GPU's clocks ramp up over them).
const COST_WARM_UP_SAMPLES: usize = 5;

fn desktop(tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, tier)
}

fn high() -> Quality {
    preset_quality(QualityPreset::High, desktop(PerformanceTier::High))
}

/// The renderer's HDR camera projection: reverse-Z, infinite far plane.
fn proj(size: (u32, u32)) -> Mat4 {
    glam::camera::rh::proj::directx::perspective_infinite_reverse(FOV_Y_DEG.to_radians(), size.0 as f32 / size.1 as f32, NEAR)
}

// ---------------------------------------------------------------------------------------------
// CPU rows: presets, frames, targets, the slot

#[test]
fn the_screen_inputs_run_on_desktop_and_web_high_and_ultra_only() {
    for tier in PerformanceTier::ALL {
        for preset in PRESETS {
            let expected = if matches!(preset, QualityPreset::High | QualityPreset::Ultra) { ScreenInputs::ALL } else { ScreenInputs::NONE };
            assert_eq!(preset_quality(preset, desktop(tier)).screen_inputs, expected, "desktop {tier:?} {preset:?}");
            let phone = DeviceClass::new(FormFactor::Mobile, tier);
            assert_eq!(preset_quality(preset, phone).screen_inputs, ScreenInputs::NONE, "phone {tier:?} {preset:?}");
        }
    }
    assert_eq!(Quality::off().screen_inputs, ScreenInputs::NONE);
}

#[test]
fn a_frame_produces_only_what_a_consumer_asks_and_the_preset_allows() {
    let quality = high();
    assert_eq!(frame_inputs(&quality, true, ScreenInputs::NONE), ScreenInputs::NONE, "nobody asks: nothing runs");
    assert_eq!(frame_inputs(&quality, true, ScreenInputs::WATER), ScreenInputs::WATER);
    assert_eq!(frame_inputs(&quality, true, ScreenInputs::SSR), ScreenInputs::SSR);
    assert_eq!(frame_inputs(&quality, true, ScreenInputs::WATER.union(ScreenInputs::SSR)), ScreenInputs::ALL);
    assert_eq!(frame_inputs(&quality, false, ScreenInputs::ALL), ScreenInputs::NONE, "the legacy LDR scene has none");
    let medium = preset_quality(QualityPreset::Medium, desktop(PerformanceTier::High));
    assert_eq!(frame_inputs(&medium, true, ScreenInputs::ALL), ScreenInputs::NONE, "the preset allows none");
    let mut no_taa = quality;
    no_taa.anti_aliasing = AntiAliasing::Off;
    let expected = ScreenInputs { history_pyramid: false, ..ScreenInputs::WATER };
    assert_eq!(frame_inputs(&no_taa, true, ScreenInputs::WATER), expected, "the pyramid's source is TAA's output");
    no_taa.anti_aliasing = AntiAliasing::Msaa4;
    assert_eq!(frame_inputs(&no_taa, true, ScreenInputs::ALL), ScreenInputs { normal_roughness: true, ..ScreenInputs::NONE }, "no copy of a multisampled world pass");
    assert_eq!(ScreenInputs::ALL.wires(), ["opaque copy", "history pyramid", "prepass normal roughness"]);
    assert!(ScreenInputs::NONE.is_empty() && !ScreenInputs::SSR.is_empty());
}

#[test]
fn the_targets_are_core_formats_and_ledgered_exactly() {
    for render in [(1920, 1080), (1000, 563), (2560, 1440), (3840, 2160), (1, 1)] {
        for target in targets(render, wgpu::TextureFormat::Rgba16Float, ScreenInputs::ALL) {
            genex_render::target_pool::validate(&target).unwrap_or_else(|refusal| panic!("{render:?}: {refusal}"));
        }
    }
    let rows = targets((1920, 1080), wgpu::TextureFormat::Rgba16Float, ScreenInputs::ALL);
    let shapes: Vec<_> = rows.iter().map(|t| (t.label, t.format, t.size, t.mips)).collect();
    assert_eq!(
        shapes,
        [
            ("opaque copy", wgpu::TextureFormat::Rgba16Float, (1920, 1080), 1),
            ("history pyramid", PYRAMID_FORMAT, (960, 540), PYRAMID_MIPS_MAX),
            ("prepass normal roughness", NORMAL_ROUGHNESS_FORMAT, (1920, 1080), 1),
        ]
    );
    // The opaque copy 1920 x 1080 x 8; the pyramid 960 x 540 x 8 plus a quarter a mip; the normal
    // and roughness 1920 x 1080 x 4.
    let pyramid = (0..PYRAMID_MIPS_MAX).map(|mip| 4_147_200u64 >> (2 * mip)).sum::<u64>();
    assert_eq!(target_bytes((1920, 1080), wgpu::TextureFormat::Rgba16Float, ScreenInputs::ALL), 16_588_800 + pyramid + 8_294_400);
    assert_eq!(target_bytes((1920, 1080), wgpu::TextureFormat::Rgba16Float, ScreenInputs::NONE), 0);
    assert_eq!(targets((1920, 1080), wgpu::TextureFormat::Rg11b10Ufloat, ScreenInputs::WATER)[0].format, wgpu::TextureFormat::Rg11b10Ufloat, "the copy is the scene's format");
}

#[test]
fn the_pyramid_halves_the_render_down_at_most_six_times() {
    assert_eq!(pyramid_size((1920, 1080)), (960, 540));
    assert_eq!(pyramid_size((1, 1)), (1, 1));
    assert_eq!(pyramid_mips((1920, 1080)), 6);
    assert_eq!(pyramid_mips((3840, 2160)), 6);
    assert_eq!(pyramid_mips((16, 8)), 4, "8 x 4 halves to 1 x 1 in 3 more mips");
    assert_eq!(pyramid_mips((1, 1)), 1);
}

/// `source` parsed by naga (panics with the error).
fn parse(name: &str, source: &str) -> naga::Module {
    naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)))
}

#[test]
fn the_screen_reflections_slot_is_binding_30_and_fits_the_forward_stage() {
    let (slot, name) = FRAME_REFLECTIONS_BINDING;
    assert_eq!((slot, name), (30, "screen_reflections"));
    let taken: Vec<u32> = FRAME_ENV_BOUND
        .iter()
        .chain(FRAME_EFFECT_BINDINGS.iter())
        .chain(FRAME_LIGHT_BINDINGS.iter())
        .chain(FRAME_MATERIAL_CLASS_BINDINGS.iter())
        .chain(std::iter::once(&FRAME_INSTANCE_FADE_BINDING))
        .map(|(binding, _)| *binding)
        .collect();
    assert!(!taken.contains(&slot), "binding 30 is free in the frame group: {taken:?}");
    let forward = parse("forward", genex_render::shaders::FORWARD);
    let group_zero = |binding: &Option<naga::ResourceBinding>| binding.as_ref().is_some_and(|b| b.group == 0);
    assert!(!forward.global_variables.iter().any(|(_, g)| g.binding.as_ref().is_some_and(|b| b.group == 0 && b.binding == slot)), "the forward pass does not declare binding 30 yet");
    let textures = forward.global_variables.iter().filter(|(_, g)| group_zero(&g.binding) && matches!(forward.types[g.ty].inner, naga::TypeInner::Image { .. })).count() as u32;
    assert!(textures < FORWARD_FRAGMENT_TEXTURES_MAX, "the reflections take the stage's last sampled texture: {textures} today");
    assert_eq!(textures + 1, FORWARD_FRAGMENT_TEXTURES_MAX, "D1: 16 of 16 once B.9 binds them");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: normal and roughness packing

/// Unit normals spread over the sphere (a Fibonacci spiral) plus the axes and octahedron edges.
fn normals() -> Vec<[f32; 3]> {
    let mut out = vec![[1.0, 0.0, 0.0], [-1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0]];
    let s = std::f32::consts::FRAC_1_SQRT_2;
    out.extend([[s, s, 0.0], [-s, s, 0.0], [s, -s, 0.0], [-s, -s, 0.0], [s, 0.0, -s], [0.0, -s, -s]]);
    let count = 4000;
    let golden = std::f32::consts::PI * (3.0 - 5f32.sqrt());
    for i in 0..count {
        let y = 1.0 - 2.0 * (i as f32 + 0.5) / count as f32;
        let r = (1.0 - y * y).sqrt();
        let a = golden * i as f32;
        out.push([r * libm::cosf(a), y, r * libm::sinf(a)]);
    }
    out
}

/// The angle between two unit vectors (atan2 of the cross and dot products in f64: acos of a dot
/// product near 1 loses the small angles this file measures).
fn angle_deg(a: [f32; 3], b: [f32; 3]) -> f32 {
    let [a, b] = [a, b].map(|v| v.map(f64::from));
    let cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    let sin = (cross[0] * cross[0] + cross[1] * cross[1] + cross[2] * cross[2]).sqrt();
    let cos = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    sin.atan2(cos).to_degrees() as f32
}

#[test]
fn the_normal_and_roughness_survive_their_eight_bit_texel_within_six_hundredths_of_a_degree() {
    let mut worst = 0.0f32;
    for (i, n) in normals().into_iter().enumerate() {
        let roughness = (i % 256) as f32 / 255.0;
        let (decoded, r) = unpack_normal_roughness(pack_normal_roughness(n, roughness));
        worst = worst.max(angle_deg(n, decoded));
        assert!((r - roughness).abs() <= 0.5 / 255.0, "roughness {roughness} -> {r}");
    }
    // Plain rounding of 12-bit octahedral coordinates (Cigolle et al.'s oct24 without the search
    // over neighbouring codes); 8-bit xyz, Godot's layout, is off by up to about half a degree.
    assert!(worst < 0.06, "worst normal error {worst} degrees");
    assert_eq!(pack_normal_roughness([0.0, 0.0, 1.0], 2.0)[3], 255, "roughness is held to 0..1");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: the march's twin on analytic cases

/// A synthetic scene seen from the origin looking down -z: a floor at y = -1, a wall at z = -12
/// and pillars standing on the floor. Each pixel holds the reverse-Z depth of the nearest surface
/// (0 where it sees the sky).
#[derive(Clone, Copy)]
struct Pillar {
    x: f32,
    z: f32,
    half: f32,
    top: f32,
}

const FLOOR_Y: f32 = -1.0;
const WALL_Z: f32 = -12.0;
const PILLARS: [Pillar; 3] = [Pillar { x: -1.5, z: -6.0, half: 0.4, top: 1.5 }, Pillar { x: 1.2, z: -8.0, half: 0.15, top: 0.5 }, Pillar { x: 3.0, z: -4.0, half: 0.6, top: 3.0 }];

/// The distance along unit ray `d` from the origin to the scene's first surface (None: sky).
fn scene_hit(d: Vec3, wall: bool) -> Option<f32> {
    let mut best: Option<f32> = None;
    let mut take = |t: f32| {
        if t > 0.0 && best.is_none_or(|b| t < b) {
            best = Some(t);
        }
    };
    if d.y < 0.0 {
        take(FLOOR_Y / d.y);
    }
    if wall && d.z < 0.0 {
        let t = WALL_Z / d.z;
        let p = d * t;
        if p.x.abs() < 20.0 && p.y < 6.0 {
            take(t);
        }
    }
    for pillar in PILLARS {
        let lo = Vec3::new(pillar.x - pillar.half, FLOOR_Y, pillar.z - pillar.half);
        let hi = Vec3::new(pillar.x + pillar.half, pillar.top, pillar.z + pillar.half);
        let inv = d.recip();
        let a = lo * inv;
        let b = hi * inv;
        let near = a.min(b).max_element();
        let far = a.max(b).min_element();
        if near <= far && far > 0.0 {
            take(near);
        }
    }
    best
}

/// The scene's depth image at `size` (rays through pixel centres; the inverse projection).
fn scene_depth(size: (u32, u32), wall: bool) -> DepthImage {
    let p = proj(size);
    let inv = p.inverse();
    let mut texels = Vec::with_capacity((size.0 * size.1) as usize);
    for y in 0..size.1 {
        for x in 0..size.0 {
            let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
            let far = inv * ndc;
            let d = (far.truncate() / far.w).normalize();
            texels.push(scene_hit(d, wall).map_or(0.0, |t| {
                let clip = p * (d * t).extend(1.0);
                clip.z / clip.w
            }));
        }
    }
    DepthImage { size, texels }
}

fn reflect(v: Vec3, n: Vec3) -> Vec3 {
    v - 2.0 * v.dot(n) * n
}

/// A march over the scene from world point `origin` along `direction` with SSR's knobs.
fn ssr_march(size: (u32, u32), origin: Vec3, direction: Vec3) -> SsrMarch {
    let mut m = march::world(proj(size), proj(size), true, origin, direction);
    m.linear_steps = 64;
    m.bisection_steps = 6;
    m.secant = true;
    m.thickness = 0.5;
    m
}

#[test]
fn the_twin_finds_the_wall_a_floor_reflection_reaches() {
    let size = (320, 180);
    let depth = scene_depth(size, true);
    // A floor point straight ahead, the view ray reflected up off the floor: it climbs to the wall.
    let origin = Vec3::new(0.0, FLOOR_Y + 0.01, -5.0);
    let direction = reflect(origin.normalize(), Vec3::Y);
    let hit = march::run(&depth, &ssr_march(size, origin, direction));
    assert!(hit.hit, "{hit:?}");
    // Where the reflected ray meets the wall, seen through the projection.
    let along = (WALL_Z - origin.z) / direction.z;
    let expected = proj(size) * (origin + direction * along).extend(1.0);
    let uv = [expected.x / expected.w * 0.5 + 0.5, 0.5 - expected.y / expected.w * 0.5];
    let px = [(hit.uv[0] - uv[0]) * size.0 as f32, (hit.uv[1] - uv[1]) * size.1 as f32];
    assert!(px[0].abs() <= 1.0 && px[1].abs() <= 1.0, "hit {:?} vs the wall at {uv:?}: {px:?} px", hit.uv);
    assert!(hit.penetration < 0.5 && (0.0..=1.0).contains(&hit.penetration_share), "{hit:?}");
}

#[test]
fn the_twin_does_not_leak_behind_a_pillar_unless_asked_to_march_behind_surfaces() {
    let size = (320, 180);
    let depth = scene_depth(size, true);
    // A ray level with the camera, 8 m out, heading right: it crosses the 6 m pillar at x = -1.5
    // on the screen 2 m behind it, then runs into the thin pillar standing at x = 1.2, z = -8.
    let origin = Vec3::new(-4.0, 0.0, -8.0);
    let direction = Vec3::X;
    let base = ssr_march(size, origin, direction);
    let hit = march::run(&depth, &base);
    assert!(!hit.hit, "2 m behind a surface is not a hit on it: {hit:?}");
    let thick = march::run(&depth, &SsrMarch { thickness: 3.0, ..base });
    assert!(thick.hit, "a 3 m thickness takes the first pillar: {thick:?}");
    // The pillar's silhouette on the screen is its front left edge.
    let first_pillar = proj(size) * Vec3::new(-1.9, 0.0, -5.6).extend(1.0);
    let edge = (first_pillar.x / first_pillar.w * 0.5 + 0.5 - thick.uv[0]) * size.0 as f32;
    assert!(edge.abs() <= 1.5, "at the first pillar's silhouette ({edge} px off)");
    let behind = march::run(&depth, &SsrMarch { behind_surfaces: true, linear_steps: 256, ..base });
    assert!(behind.hit && behind.t > thick.t, "marching behind surfaces passes the first pillar: {behind:?}");
    let second_pillar = proj(size) * Vec3::new(1.05, 0.0, -8.0).extend(1.0);
    let face = (second_pillar.x / second_pillar.w * 0.5 + 0.5 - behind.uv[0]) * size.0 as f32;
    assert!(face.abs() <= 1.0, "and finds the second pillar's face ({face} px off): {behind:?}");
}

#[test]
fn the_twin_clips_a_ray_to_the_screen_and_misses_the_sky() {
    let size = (320, 180);
    let depth = scene_depth(size, false);
    // Up into the sky (no wall): a miss that travels to the frustum's edge.
    let origin = Vec3::new(0.0, FLOOR_Y + 0.01, -5.0);
    let m = ssr_march(size, origin, Vec3::new(0.0, 1.0, -0.2).normalize());
    let hit = march::run(&depth, &m);
    assert!(!hit.hit, "{hit:?}");
    assert!((hit.t - 1.0).abs() < 1e-6, "a miss travels the whole ray: {hit:?}");
    assert!(hit.uv[1] <= 1e-4, "the ray ends at the screen's top edge: {:?}", hit.uv);
    for c in [m.start, m.end] {
        assert!(c.x.abs() <= 1.0 + 1e-5 && c.y.abs() <= 1.0 + 1e-5 && (0.0..=1.0).contains(&c.z), "inside the frustum: {c:?}");
    }
    // A finite march to an NDC point stops there.
    let to = march::to(march::new(Vec3::new(-0.5, -0.5, 0.01), proj(size), true), Vec3::new(0.5, -0.5, 0.01));
    assert!((to.end - Vec3::new(0.5, -0.5, 0.01)).length() < 1e-6, "{to:?}");
}

// ---------------------------------------------------------------------------------------------
// The helper's modules: WebGPU core and every back end

/// The test kernel: one march a ray (the helper inside a compute entry point), and the packing
/// round trip of one normal.
const KERNEL: &str = r"
struct MarchRay {
    origin: vec4<f32>,
    direction: vec4<f32>,
}

struct MarchView {
    view_proj: mat4x4<f32>,
    proj: mat4x4<f32>,
    // x: reversed; y: linear steps; z: bisection steps; w: secant.
    counts: vec4<u32>,
    // x: thickness; y: jitter; z: exponent; w: behind surfaces.
    knobs: vec4<f32>,
    // x: sloppy.
    flags: vec4<u32>,
}

struct MarchOut {
    // x: hit; y: t; zw: uv.
    hit: vec4<f32>,
    // x: penetration; y: its share.
    depth: vec4<f32>,
    start: vec4<f32>,
    end: vec4<f32>,
}

@group(0) @binding(0) var march_depth: texture_depth_2d;
@group(0) @binding(1) var<storage, read> march_rays: array<MarchRay>;
@group(0) @binding(2) var<storage, read_write> march_out: array<MarchOut>;
@group(0) @binding(3) var<uniform> march_view: MarchView;

@compute @workgroup_size(64)
fn march_kernel(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= arrayLength(&march_rays) {
        return;
    }
    let ray = march_rays[id.x];
    var m = gx_ssr_march_world(march_view.view_proj, march_view.proj, march_view.counts.x, ray.origin.xyz, ray.direction.xyz);
    m.linear_steps = march_view.counts.y;
    m.bisection_steps = march_view.counts.z;
    m.secant = march_view.counts.w;
    m.thickness = march_view.knobs.x;
    m.jitter = march_view.knobs.y;
    m.exponent = u32(march_view.knobs.z);
    m.behind_surfaces = u32(march_view.knobs.w);
    m.sloppy = march_view.flags.x;
    let hit = gx_ssr_march_run(march_depth, m);
    march_out[id.x] = MarchOut(vec4<f32>(f32(hit.hit), hit.t, hit.uv), vec4<f32>(hit.penetration, hit.penetration_share, 0.0, 0.0), vec4<f32>(m.start, 0.0), vec4<f32>(m.end, 0.0));
}

struct PackIn {
    // xyz: the normal; w: the roughness.
    value: vec4<f32>,
}

@group(0) @binding(0) var<storage, read> pack_in: array<PackIn>;
@group(0) @binding(1) var<storage, read_write> pack_out: array<vec4<u32>>;

@compute @workgroup_size(64)
fn pack_kernel(@builtin(global_invocation_id) id: vec3<u32>) {
    if id.x >= arrayLength(&pack_in) {
        return;
    }
    let v = pack_in[id.x].value;
    let texel = gx_pack_normal_roughness(v.xyz, v.w);
    let decoded = gx_unpack_normal(texel);
    pack_out[id.x] = vec4<u32>(pack4x8unorm(texel), bitcast<vec3<u32>>(decoded));
}
";

fn kernel_source() -> String {
    [include_str!("../shaders/common.wgsl"), include_str!("../shaders/effects.wgsl"), SSR_MARCH, NORMAL_ROUGHNESS, KERNEL].concat()
}

/// Whether `source` validates against WebGPU core and emits HLSL SM 5.1, MSL 2.4 and SPIR-V 1.3.
fn emits_everywhere(name: &str, source: &str) {
    use naga::back::{hlsl, msl, spv};
    let module = parse(name, source);
    let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty())
        .validate(&module)
        .unwrap_or_else(|error| panic!("{name} needs more than WebGPU core: {error:?}"));
    assert!(source.len() <= genex_render::WGSL_MAX_BYTES, "{name}: {} bytes", source.len());
    let mut hlsl_source = String::new();
    let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
    hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name}: HLSL: {error:?}"));
    let options = msl::Options { lang_version: (2, 4), ..Default::default() };
    msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name}: MSL: {error:?}"));
    let options = spv::Options { lang_version: (1, 3), ..Default::default() };
    spv::write_vec(&module, &info, &options, None).unwrap_or_else(|error| panic!("{name}: SPIR-V: {error:?}"));
}

#[test]
fn the_helper_and_the_pyramid_validate_against_webgpu_core_and_emit_hlsl_msl_and_spirv() {
    emits_everywhere("history-pyramid", HISTORY_PYRAMID);
    emits_everywhere("ssr-march kernel", &kernel_source());
    assert!(genex_render::shaders::SHADERS.iter().any(|(name, source)| *name == "history-pyramid" && *source == HISTORY_PYRAMID), "the pyramid is a registered renderer shader");
}

/// The most bytes the pyramid's minified WGSL adds to a web build (Lakeside's wasm budget has
/// about 16 KB of headroom, A.12).
const PYRAMID_WEB_BYTES_MAX: usize = 1200;

#[test]
fn the_pyramid_adds_little_to_a_web_build_and_the_chunks_ship_only_with_their_consumers() {
    let minified = genex_render::shaders::minify::minified_len(HISTORY_PYRAMID);
    println!("{{\"row\":\"screen-inputs-web-bytes\",\"history_pyramid\":{minified},\"ssr_march\":{},\"normal_roughness\":{}}}", genex_render::shaders::minify::minified_len(SSR_MARCH), genex_render::shaders::minify::minified_len(NORMAL_ROUGHNESS));
    assert!(minified <= PYRAMID_WEB_BYTES_MAX, "{minified} bytes");
    // The march and packing chunks are no renderer shader of their own: a consumer's module
    // includes them (water, B.9, the prepass's SSR entry points), so they cost a web build nothing
    // until one does.
    for (name, source) in genex_render::shaders::SHADERS {
        assert!(!source.contains("fn gx_ssr_march_run") && !source.contains("fn gx_pack_normal_roughness"), "{name} includes a chunk no pass calls yet");
    }
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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

fn storage(gpu: &Gpu, label: &str, bytes: &[u8], usage: wgpu::BufferUsages) -> wgpu::Buffer {
    use wgpu::util::DeviceExt;
    gpu.device.create_buffer_init(&wgpu::util::BufferInitDescriptor { label: Some(label), contents: bytes, usage })
}

fn read_buffer(gpu: &Gpu, buffer: &wgpu::Buffer) -> Vec<u8> {
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: buffer.size(), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_buffer_to_buffer(buffer, 0, &staging, 0, buffer.size());
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    slice.get_mapped_range().expect("mapped").to_vec()
}

fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes.as_chunks::<4>().0.iter().map(|c| f32::from_le_bytes(*c)).collect()
}

/// `image` as a `depth32float` texture: an `r32float` copy written through `frag_depth` (WebGPU
/// copies into no depth32float).
fn depth_texture(gpu: &Gpu, image: &DepthImage) -> wgpu::Texture {
    let device = &gpu.device;
    let size = wgpu::Extent3d { width: image.size.0, height: image.size.1, depth_or_array_layers: 1 };
    let values = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ssr test depth values"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::R32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let bytes: Vec<u8> = image.texels.iter().flat_map(|d| d.to_le_bytes()).collect();
    gpu.queue.write_texture(values.as_image_copy(), &bytes, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(image.size.0 * 4), rows_per_image: None }, size);
    let depth = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ssr test depth"),
        size,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Depth32Float,
        usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let source = "@group(0) @binding(0) var values: texture_2d<f32>;\n\
        @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {\n\
            let uv = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));\n\
            return vec4<f32>(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.0, 1.0);\n}\n\
        @fragment fn fs(@builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 {\n\
            return textureLoad(values, vec2<i32>(p.xy), 0).r;\n}\n";
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ssr test depth"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("ssr test depth"),
        layout: None,
        vertex: wgpu::VertexState { module: &module, entry_point: Some("vs"), compilation_options: Default::default(), buffers: &[] },
        primitive: wgpu::PrimitiveState::default(),
        depth_stencil: Some(wgpu::DepthStencilState {
            format: wgpu::TextureFormat::Depth32Float,
            depth_write_enabled: Some(true),
            depth_compare: Some(wgpu::CompareFunction::Always),
            stencil: Default::default(),
            bias: Default::default(),
        }),
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState { module: &module, entry_point: Some("fs"), compilation_options: Default::default(), targets: &[] }),
        multiview_mask: None,
        cache: None,
    });
    let view = values.create_view(&Default::default());
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) }],
    });
    let target = depth.create_view(&Default::default());
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let attachment = wgpu::RenderPassDepthStencilAttachment {
            view: &target,
            depth_ops: Some(wgpu::Operations { load: wgpu::LoadOp::Clear(0.0), store: wgpu::StoreOp::Store }),
            stencil_ops: None,
        };
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: None, depth_stencil_attachment: Some(attachment), ..Default::default() });
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.draw(0..3, 0..1);
    }
    gpu.queue.submit([encoder.finish()]);
    depth
}

/// The march's knobs on both sides.
#[derive(Clone, Copy, Debug)]
struct Knobs {
    linear_steps: u32,
    bisection_steps: u32,
    secant: bool,
    thickness: f32,
    jitter: f32,
    exponent: u32,
    behind_surfaces: bool,
    sloppy: bool,
}

/// A colour lookup's march (water, B.9's fallback).
const SSR_KNOBS: Knobs = Knobs { linear_steps: 32, bisection_steps: 6, secant: true, thickness: 0.5, jitter: 1.0, exponent: 1, behind_surfaces: false, sloppy: false };
/// A shadow ray's march (contact shadows' shape).
const SHADOW_KNOBS: Knobs = Knobs { linear_steps: 16, bisection_steps: 0, secant: false, thickness: 0.3, jitter: 0.5, exponent: 2, behind_surfaces: true, sloppy: true };

fn twin_march(size: (u32, u32), origin: Vec3, direction: Vec3, knobs: Knobs) -> SsrMarch {
    let mut m = march::world(proj(size), proj(size), true, origin, direction);
    m.linear_steps = knobs.linear_steps;
    m.bisection_steps = knobs.bisection_steps;
    m.secant = knobs.secant;
    m.thickness = knobs.thickness;
    m.jitter = knobs.jitter;
    m.exponent = knobs.exponent;
    m.behind_surfaces = knobs.behind_surfaces;
    m.sloppy = knobs.sloppy;
    m
}

/// Rays over the scene: from visible floor, pillar and wall points (rebuilt from the depth), the
/// view ray mirrored off the surface's normal, and some steeper and grazing ones (a deterministic
/// sequence).
fn rays(image: &DepthImage) -> Vec<(Vec3, Vec3)> {
    let size = image.size;
    let inv = proj(size).inverse();
    let mut out = Vec::new();
    let mut state = 0x2545_f491u32;
    let mut next = move || {
        state ^= state << 13;
        state ^= state >> 17;
        state ^= state << 5;
        state as f32 / u32::MAX as f32
    };
    while out.len() < 4096 {
        let (x, y) = ((next() * size.0 as f32) as u32 % size.0, (next() * size.1 as f32) as u32 % size.1);
        let depth = image.texels[(y * size.0 + x) as usize];
        if depth <= 0.0 {
            continue;
        }
        let ndc = Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, depth, 1.0);
        let world = inv * ndc;
        let point = world.truncate() / world.w;
        let normal = if (point.y - FLOOR_Y).abs() < 1e-3 { Vec3::Y } else if (point.z - WALL_Z).abs() < 1e-2 { Vec3::Z } else { Vec3::new(0.0, 0.0, 1.0) };
        let view = point.normalize();
        let tilt = Vec3::new(next() - 0.5, next() - 0.5, next() - 0.5) * 0.6;
        let direction = (reflect(view, normal) + tilt).normalize();
        out.push((point + normal * 0.01, direction));
    }
    out
}

/// The kernel's marches of `rays` over `image` with `knobs`: (hit, t, uv, penetration) a ray.
fn gpu_marches(gpu: &Gpu, image: &DepthImage, rays: &[(Vec3, Vec3)], knobs: Knobs) -> Vec<SsrHit> {
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("ssr kernel"), source: wgpu::ShaderSource::Wgsl(kernel_source().into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("ssr kernel"),
        layout: None,
        module: &module,
        entry_point: Some("march_kernel"),
        compilation_options: Default::default(),
        cache: None,
    });
    let depth = depth_texture(gpu, image);
    let depth_view = depth.create_view(&Default::default());
    let ray_bytes: Vec<u8> = rays.iter().flat_map(|(o, d)| [o.x, o.y, o.z, 0.0, d.x, d.y, d.z, 0.0]).flat_map(f32::to_le_bytes).collect();
    let ray_buffer = storage(gpu, "ssr rays", &ray_bytes, wgpu::BufferUsages::STORAGE);
    let out = device.create_buffer(&wgpu::BufferDescriptor { label: Some("ssr out"), size: rays.len() as u64 * 64, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let p = proj(image.size);
    let mut view: Vec<u8> = Vec::new();
    view.extend(p.to_cols_array().iter().flat_map(|v| v.to_le_bytes()));
    view.extend(p.to_cols_array().iter().flat_map(|v| v.to_le_bytes()));
    view.extend([1u32, knobs.linear_steps, knobs.bisection_steps, u32::from(knobs.secant)].iter().flat_map(|v| v.to_le_bytes()));
    view.extend([knobs.thickness, knobs.jitter, knobs.exponent as f32, f32::from(u8::from(knobs.behind_surfaces))].iter().flat_map(|v| v.to_le_bytes()));
    view.extend([u32::from(knobs.sloppy), 0, 0, 0].iter().flat_map(|v| v.to_le_bytes()));
    let view_buffer = storage(gpu, "ssr view", &view, wgpu::BufferUsages::UNIFORM);
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[
            wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&depth_view) },
            wgpu::BindGroupEntry { binding: 1, resource: ray_buffer.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 2, resource: out.as_entire_binding() },
            wgpu::BindGroupEntry { binding: 3, resource: view_buffer.as_entire_binding() },
        ],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((rays.len() as u32).div_ceil(64), 1, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    floats(&read_buffer(gpu, &out))
        .as_chunks::<16>()
        .0
        .iter()
        .map(|v| SsrHit { hit: v[0] == 1.0, t: v[1], uv: [v[2], v[3]], penetration: v[4], penetration_share: v[5] })
        .collect()
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_march_helper_finds_what_its_cpu_twin_finds() {
    let Some(gpu) = gpu() else { return };
    let size = (320, 180);
    let image = scene_depth(size, true);
    let rays = rays(&image);
    for (name, knobs) in [("ssr", SSR_KNOBS), ("shadow", SHADOW_KNOBS)] {
        let gpu_hits = gpu_marches(&gpu, &image, &rays, knobs);
        let (mut agree, mut hits, mut close, mut worst_px) = (0usize, 0usize, 0usize, 0.0f32);
        for (i, (origin, direction)) in rays.iter().enumerate() {
            let cpu = march::run(&image, &twin_march(size, *origin, *direction, knobs));
            let gpu_hit = gpu_hits[i];
            if cpu.hit != gpu_hit.hit {
                continue;
            }
            agree += 1;
            hits += usize::from(cpu.hit);
            let px = libm::hypotf((cpu.uv[0] - gpu_hit.uv[0]) * size.0 as f32, (cpu.uv[1] - gpu_hit.uv[1]) * size.1 as f32);
            worst_px = worst_px.max(px);
            close += usize::from(px <= 0.5);
        }
        let share = agree as f32 / rays.len() as f32;
        let close_share = close as f32 / agree.max(1) as f32;
        println!("{{\"row\":\"ssr-march-twin\",\"knobs\":\"{name}\",\"rays\":{},\"hits\":{hits},\"agree\":{share:.4},\"within_half_px\":{close_share:.4},\"worst_px\":{worst_px:.3}}}", rays.len());
        assert!(hits > rays.len() / 4, "{name}: the scene gives the rays something to hit ({hits})");
        assert!(share >= 0.995, "{name}: GPU and twin agree on hit or miss for {share} of rays");
        assert!(close_share >= 0.99, "{name}: {close_share} of agreeing rays end within half a pixel");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_packing_on_the_gpu_writes_its_twins_bytes() {
    let Some(gpu) = gpu() else { return };
    let device = &gpu.device;
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("pack kernel"), source: wgpu::ShaderSource::Wgsl(kernel_source().into()) });
    let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
        label: Some("pack kernel"),
        layout: None,
        module: &module,
        entry_point: Some("pack_kernel"),
        compilation_options: Default::default(),
        cache: None,
    });
    let normals = normals();
    let values: Vec<[f32; 4]> = normals.iter().enumerate().map(|(i, n)| [n[0], n[1], n[2], (i % 256) as f32 / 255.0]).collect();
    let input = storage(&gpu, "pack in", &values.iter().flatten().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>(), wgpu::BufferUsages::STORAGE);
    let out = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: values.len() as u64 * 16, usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor {
        label: None,
        layout: &pipeline.get_bind_group_layout(0),
        entries: &[wgpu::BindGroupEntry { binding: 0, resource: input.as_entire_binding() }, wgpu::BindGroupEntry { binding: 1, resource: out.as_entire_binding() }],
    });
    let mut encoder = device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_compute_pass(&Default::default());
        pass.set_pipeline(&pipeline);
        pass.set_bind_group(0, &group, &[]);
        pass.dispatch_workgroups((values.len() as u32).div_ceil(64), 1, 1);
    }
    gpu.queue.submit([encoder.finish()]);
    let words: Vec<u32> = read_buffer(&gpu, &out).as_chunks::<4>().0.iter().map(|c| u32::from_le_bytes(*c)).collect();
    let mut differ = 0;
    let mut worst = 0.0f32;
    for (i, value) in values.iter().enumerate() {
        let texel = pack_normal_roughness([value[0], value[1], value[2]], value[3]);
        if words[i * 4].to_le_bytes() != texel {
            differ += 1;
        }
        let decoded = [1, 2, 3].map(|c| f32::from_bits(words[i * 4 + c]));
        worst = worst.max(angle_deg(unpack_normal_roughness(texel).0, decoded));
    }
    assert_eq!(differ, 0, "texels whose bytes differ from the twin's");
    assert!(worst < 1e-3, "GPU and twin decode the same texel to the same normal (worst {worst} degrees)");
}

// --- the opaque copy

/// A float to IEEE half bits (round to nearest even; the values are finite and in range).
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
    let half = ((exponent as u32) << 10) | (mantissa >> 13);
    let rest = mantissa & 0x1fff;
    let rounded = if rest > 0x1000 || (rest == 0x1000 && half & 1 == 1) { half + 1 } else { half };
    sign | rounded as u16
}

fn f16_value(bits: u16) -> f32 {
    let sign = if bits & 0x8000 != 0 { -1.0 } else { 1.0 };
    let exponent = i32::from((bits >> 10) & 0x1f);
    let mantissa = f32::from(bits & 0x3ff);
    match exponent {
        0 => sign * libm::ldexpf(mantissa, -24),
        31 => sign * f32::INFINITY,
        _ => sign * libm::ldexpf(1.0 + mantissa / 1024.0, exponent - 15),
    }
}

/// A deterministic HDR picture: smooth gradients, a fine checker and a few bright texels.
fn picture(size: (u32, u32)) -> Vec<[f32; 4]> {
    let mut out = Vec::with_capacity((size.0 * size.1) as usize);
    for y in 0..size.1 {
        for x in 0..size.0 {
            let u = x as f32 / size.0 as f32;
            let v = y as f32 / size.1 as f32;
            let checker = if (x / 3 + y / 2) % 2 == 0 { 0.25 } else { 0.0 };
            let spark = if (x * 7 + y * 13) % 997 == 0 { 40.0 } else { 0.0 };
            out.push([u + checker + spark, v * 0.5 + checker, 0.3 + 0.2 * libm::sinf(u * 17.0 + v * 5.0), 1.0]);
        }
    }
    out
}

/// An `rgba16float` texture holding `texels`.
fn colour_texture(gpu: &Gpu, size: (u32, u32), texels: &[[f32; 4]], usage: wgpu::TextureUsages) -> wgpu::Texture {
    let extent = wgpu::Extent3d { width: size.0, height: size.1, depth_or_array_layers: 1 };
    let texture = gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some("ssr test colour"),
        size: extent,
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba16Float,
        usage: usage | wgpu::TextureUsages::COPY_DST,
        view_formats: &[],
    });
    let bytes: Vec<u8> = texels.iter().flatten().flat_map(|v| f16_bits(*v).to_le_bytes()).collect();
    gpu.queue.write_texture(texture.as_image_copy(), &bytes, wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(size.0 * 8), rows_per_image: None }, extent);
    texture
}

/// The raw bytes of an `rgba16float` texture's `mip`, rows packed.
fn read_rgba16f_bytes(gpu: &Gpu, texture: &wgpu::Texture, mip: u32) -> (Vec<u8>, (u32, u32)) {
    let (width, height) = ((texture.width() >> mip).max(1), (texture.height() >> mip).max(1));
    let row = (width * 8).div_ceil(256) * 256;
    let staging = gpu.device.create_buffer(&wgpu::BufferDescriptor { label: None, size: u64::from(row * height), usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        wgpu::TexelCopyTextureInfo { texture, mip_level: mip, origin: wgpu::Origin3d::ZERO, aspect: wgpu::TextureAspect::All },
        wgpu::TexelCopyBufferInfo { buffer: &staging, layout: wgpu::TexelCopyBufferLayout { offset: 0, bytes_per_row: Some(row), rows_per_image: None } },
        wgpu::Extent3d { width, height, depth_or_array_layers: 1 },
    );
    gpu.queue.submit([encoder.finish()]);
    let slice = staging.slice(..);
    slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
    let data = slice.get_mapped_range().expect("mapped");
    let mut out = Vec::with_capacity((width * height * 8) as usize);
    for y in 0..height {
        out.extend_from_slice(&data[(y * row) as usize..(y * row + width * 8) as usize]);
    }
    (out, (width, height))
}

fn texels_of(bytes: &[u8]) -> Vec<[f32; 4]> {
    bytes.as_chunks::<8>().0.iter().map(|t| std::array::from_fn(|c| f16_value(u16::from_le_bytes([t[c * 2], t[c * 2 + 1]])))).collect()
}

fn scene_usage() -> wgpu::TextureUsages {
    wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_SRC
}

/// A texture of the opaque row's shape for `render` (plus what the cost harness needs).
fn opaque_texture(gpu: &Gpu, render: (u32, u32), extra: wgpu::TextureUsages) -> wgpu::Texture {
    let desc = targets(render, wgpu::TextureFormat::Rgba16Float, ScreenInputs::WATER).into_iter().find(|t| t.label == "opaque copy").expect("opaque row");
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(desc.label),
        size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: desc.format,
        usage: desc.usage | extra,
        view_formats: &[],
    })
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_opaque_copy_is_the_scene_bit_for_bit_and_refuses_a_mismatch() {
    let Some(gpu) = gpu() else { return };
    let render = (1000, 563);
    let scene = colour_texture(&gpu, render, &picture(render), scene_usage());
    let opaque = opaque_texture(&gpu, render, wgpu::TextureUsages::COPY_SRC);
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    encode_opaque_copy(&mut encoder, &scene, &opaque).expect("copy");
    gpu.queue.submit([encoder.finish()]);
    assert_eq!(read_rgba16f_bytes(&gpu, &opaque, 0).0, read_rgba16f_bytes(&gpu, &scene, 0).0, "the copy is the scene's bytes");
    let small = opaque_texture(&gpu, (999, 563), wgpu::TextureUsages::empty());
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let refusal = encode_opaque_copy(&mut encoder, &scene, &small).expect_err("a copy of another size");
    assert_eq!(refusal.code().wire(), "texture-invalid");
}

/// A timestamp query set of two, its resolve buffer and readback (None without timestamps).
struct Stamps {
    set: wgpu::QuerySet,
    resolve: wgpu::Buffer,
    staging: wgpu::Buffer,
}

impl Stamps {
    fn new(gpu: &Gpu) -> Option<Stamps> {
        let device = &gpu.device;
        if !device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
            return None;
        }
        let set = device.create_query_set(&wgpu::QuerySetDescriptor { label: Some("screen inputs cost"), ty: wgpu::QueryType::Timestamp, count: 2 });
        let resolve = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC, mapped_at_creation: false });
        let staging = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ, mapped_at_creation: false });
        Some(Stamps { set, resolve, staging })
    }

    /// The milliseconds between the two stamps of a submitted, completed sample.
    fn span_ms(&self, gpu: &Gpu) -> Option<f32> {
        // Resolved after the passes completed (Metal's counters read stale in the same buffer).
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        encoder.resolve_query_set(&self.set, 0..2, &self.resolve, 0);
        encoder.copy_buffer_to_buffer(&self.resolve, 0, &self.staging, 0, 16);
        gpu.queue.submit([encoder.finish()]);
        let slice = self.staging.slice(..);
        slice.map_async(wgpu::MapMode::Read, |result| result.expect("map"));
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        let ticks: Vec<u64> = {
            let data = slice.get_mapped_range().expect("mapped");
            (0..2).map(|i| u64::from_le_bytes(data[i * 8..i * 8 + 8].try_into().expect("8 bytes"))).collect()
        };
        self.staging.unmap();
        genex_render::timing::span_ms(ticks[0], ticks[1], gpu.queue.get_timestamp_period())
    }
}

/// The median of `COST_SAMPLES` spans `sample` records (after the warm-up), each over `per` units.
fn median_ms(gpu: &Gpu, stamps: &Stamps, per: u32, mut sample: impl FnMut(&mut wgpu::CommandEncoder)) -> f32 {
    let mut times = Vec::new();
    for run in 0..COST_WARM_UP_SAMPLES + COST_SAMPLES {
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        sample(&mut encoder);
        gpu.queue.submit([encoder.finish()]);
        gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
        if let (true, Some(ms)) = (run >= COST_WARM_UP_SAMPLES, stamps.span_ms(gpu)) {
            times.push(ms / per.max(1) as f32);
        }
    }
    assert!(!times.is_empty(), "no usable timestamp sample");
    times.sort_by(f32::total_cmp);
    times[times.len() / 2]
}

fn perf_row(name: &str, size: (u32, u32), median: f32, budget: Option<f32>) {
    let row = format!("{{\"row\":\"{name}\",\"size\":[{},{}],\"median_ms\":{median:.4},\"budget_ms\":{}}}", size.0, size.1, budget.map_or("null".to_owned(), |b| b.to_string()));
    println!("{row}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{row}").expect("perf row");
    }
}

/// Scene and copy pairs a cost sample rotates through: their bytes together outgrow the GPU's last
/// level cache at every measured size, so a copy reads and writes memory as a frame's would.
const COST_PAIRS: usize = 4;

/// The opaque copy's milliseconds at `render`: the copies cleared in one pass stamped at its end,
/// `COST_COPIES_PER_SAMPLE` copies rotating through `COST_PAIRS` scenes and copies (each writes a
/// copy the clear wrote, so they run after it), then a compute pass reading one texel of every copy
/// stamped at its end; the span with no copies is subtracted.
fn copy_ms(gpu: &Gpu, stamps: &Stamps, render: (u32, u32)) -> f32 {
    let device = &gpu.device;
    let scenes: Vec<wgpu::Texture> = (0..COST_PAIRS).map(|_| colour_texture(gpu, render, &picture(render), scene_usage())).collect();
    let copies: Vec<wgpu::Texture> = (0..COST_PAIRS).map(|_| opaque_texture(gpu, render, wgpu::TextureUsages::RENDER_ATTACHMENT)).collect();
    let views: Vec<wgpu::TextureView> = copies.iter().map(|t| t.create_view(&Default::default())).collect();
    let source = "@group(0) @binding(0) var a: texture_2d<f32>;\n@group(0) @binding(1) var b: texture_2d<f32>;\n\
        @group(0) @binding(2) var c: texture_2d<f32>;\n@group(0) @binding(3) var d: texture_2d<f32>;\n\
        @group(0) @binding(4) var<storage, read_write> out: array<vec4<f32>>;\n\
        @compute @workgroup_size(1) fn main() { let p = vec2<i32>(0); out[0] = textureLoad(a, p, 0) + textureLoad(b, p, 0) + textureLoad(c, p, 0) + textureLoad(d, p, 0); }\n";
    let module = device.create_shader_module(wgpu::ShaderModuleDescriptor { label: Some("copy reader"), source: wgpu::ShaderSource::Wgsl(source.into()) });
    let reader = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor { label: None, layout: None, module: &module, entry_point: Some("main"), compilation_options: Default::default(), cache: None });
    let out = device.create_buffer(&wgpu::BufferDescriptor { label: None, size: 16, usage: wgpu::BufferUsages::STORAGE, mapped_at_creation: false });
    let mut entries: Vec<wgpu::BindGroupEntry> = views.iter().enumerate().map(|(i, view)| wgpu::BindGroupEntry { binding: i as u32, resource: wgpu::BindingResource::TextureView(view) }).collect();
    entries.push(wgpu::BindGroupEntry { binding: COST_PAIRS as u32, resource: out.as_entire_binding() });
    let group = device.create_bind_group(&wgpu::BindGroupDescriptor { label: None, layout: &reader.get_bind_group_layout(0), entries: &entries });
    let span = |count: u32| {
        median_ms(gpu, stamps, 1, |encoder| {
            {
                let attachments: Vec<Option<wgpu::RenderPassColorAttachment>> = views
                    .iter()
                    .map(|view| {
                        Some(wgpu::RenderPassColorAttachment {
                            view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations { load: wgpu::LoadOp::Clear(wgpu::Color::BLACK), store: wgpu::StoreOp::Store },
                        })
                    })
                    .collect();
                let timestamp_writes = Some(wgpu::RenderPassTimestampWrites { query_set: &stamps.set, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(0) });
                encoder.begin_render_pass(&wgpu::RenderPassDescriptor { label: Some("clear copies"), color_attachments: &attachments, timestamp_writes, ..Default::default() });
            }
            for i in 0..count as usize {
                encode_opaque_copy(encoder, &scenes[i % COST_PAIRS], &copies[i % COST_PAIRS]).expect("copy");
            }
            let timestamp_writes = Some(wgpu::ComputePassTimestampWrites { query_set: &stamps.set, beginning_of_pass_write_index: None, end_of_pass_write_index: Some(1) });
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor { label: Some("read copies"), timestamp_writes });
            pass.set_pipeline(&reader);
            pass.set_bind_group(0, &group, &[]);
            pass.dispatch_workgroups(1, 1, 1);
        })
    };
    let base = span(0);
    let with = span(COST_COPIES_PER_SAMPLE);
    (with - base).max(0.0) / COST_COPIES_PER_SAMPLE as f32
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_opaque_copy_costs_at_most_a_tenth_of_a_millisecond_at_1080p() {
    let Some(gpu) = gpu() else { return };
    let Some(stamps) = Stamps::new(&gpu) else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    let mut over = Vec::new();
    for render in [(1920, 1080), (2560, 1440), (3840, 2160)] {
        let median = copy_ms(&gpu, &stamps, render);
        let judged = (render == (1920, 1080)).then_some(OPAQUE_COPY_MS_MAX);
        perf_row("opaque-copy", render, median, judged);
        if judged.is_some_and(|budget| median > budget) {
            over.push(format!("{render:?}: {median:.3} ms > {OPAQUE_COPY_MS_MAX} ms"));
        }
    }
    assert!(over.is_empty(), "over budget: {over:?}");
}

// --- the colour pyramid

/// A pyramid texture of `targets`' row for `render` (plus `COPY_SRC` for the readback).
fn pyramid_texture(gpu: &Gpu, render: (u32, u32)) -> wgpu::Texture {
    let desc = targets(render, wgpu::TextureFormat::Rgba16Float, ScreenInputs::SSR).into_iter().find(|t| t.label == "history pyramid").expect("pyramid row");
    gpu.device.create_texture(&wgpu::TextureDescriptor {
        label: Some(desc.label),
        size: wgpu::Extent3d { width: desc.size.0, height: desc.size.1, depth_or_array_layers: 1 },
        mip_level_count: desc.mips,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: desc.format,
        usage: desc.usage | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_history_pyramid_filters_as_its_cpu_twin_mip_by_mip() {
    let Some(gpu) = gpu() else { return };
    let mut node = PyramidNode::new(&gpu.device).expect("node");
    for render in [(640, 360), (501, 283)] {
        let texels = picture(render);
        let source = colour_texture(&gpu, render, &texels, scene_usage());
        let view = source.create_view(&Default::default());
        let pyramid = pyramid_texture(&gpu, render);
        let mut encoder = gpu.device.create_command_encoder(&Default::default());
        node.encode(&gpu.device, &mut encoder, PyramidInput { source: &view, pyramid: &pyramid, render }, None).expect("build");
        gpu.queue.submit([encoder.finish()]);
        // Each mip against the twin of the GPU's own mip above it (f16 storage between mips).
        let mut above = (texels_of(&read_rgba16f_bytes(&gpu, &source, 0).0), render);
        for mip in 0..pyramid_mips(render) {
            let (bytes, size) = read_rgba16f_bytes(&gpu, &pyramid, mip);
            let got = texels_of(&bytes);
            let expected = pyramid_reference(above.1, &above.0);
            assert_eq!(expected.len(), got.len(), "{render:?} mip {mip}: {size:?}");
            let worst = got.iter().zip(&expected).flat_map(|(g, e)| (0..4).map(move |c| (g[c] - e[c]).abs() / e[c].abs().max(1.0))).fold(0.0f32, f32::max);
            assert!(worst <= 2e-3, "{render:?} mip {mip}: worst relative error {worst}");
            above = (got, size);
        }
    }
    let mut encoder = gpu.device.create_command_encoder(&Default::default());
    let wrong = pyramid_texture(&gpu, (640, 360));
    let source = colour_texture(&gpu, (642, 360), &picture((642, 360)), scene_usage());
    let view = source.create_view(&Default::default());
    let refusal = node.encode(&gpu.device, &mut encoder, PyramidInput { source: &view, pyramid: &wrong, render: (642, 360) }, None).expect_err("a pyramid for another render size");
    assert_eq!(refusal.code().wire(), "texture-invalid");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_the_history_pyramid_cost_is_recorded() {
    let Some(gpu) = gpu() else { return };
    let Some(stamps) = Stamps::new(&gpu) else {
        eprintln!("skipped: no timestamp queries");
        return;
    };
    let mut node = PyramidNode::new(&gpu.device).expect("node");
    for render in [(1920, 1080), (2560, 1440), (3840, 2160)] {
        let source = colour_texture(&gpu, render, &picture(render), scene_usage());
        let view = source.create_view(&Default::default());
        let pyramid = pyramid_texture(&gpu, render);
        let median = median_ms(&gpu, &stamps, COST_BUILDS_PER_SAMPLE, |encoder| {
            for run in 0..COST_BUILDS_PER_SAMPLE {
                let stamp = PyramidStamps { set: &stamps.set, begin: (run == 0).then_some(0), end: (run + 1 == COST_BUILDS_PER_SAMPLE).then_some(1) };
                node.encode(&gpu.device, encoder, PyramidInput { source: &view, pyramid: &pyramid, render }, Some(stamp)).expect("build");
            }
        });
        perf_row("history-pyramid", render, median, None);
    }
}
