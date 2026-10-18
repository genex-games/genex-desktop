//! B.9 Hi-Z screen-space reflections: the presets, the targets, the trace's CPU twin on an analytic
//! street (a wet road, a wall with a neon sign), the hand-over to the probes, and on the GPU the
//! trace against its twin, the neon in the wet road, the seamless fade and the cost.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test ssr -- --ignored metal --test-threads=1
//!
//! The street's depth, normals and colours are ray cast on the CPU through the renderer's reverse-Z
//! infinite projection. `GENEX_PERF_OUT` receives the cost rows as JSON lines; `GENEX_SSR_DUMP`
//! receives the seam row's confidence image (640 x 360 little-endian f32).

use genex_render::Gpu;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::hiz::{self, HizLevel};
use genex_render::presets::preset_quality;
use genex_render::screen_inputs::{ScreenInputs, pack_normal_roughness, unpack_normal_roughness};
use genex_render::settings::{AntiAliasing, Quality, QualityPreset};
use genex_render::ssr::twin::Screen;
use genex_render::ssr::{self, GpuSsrParams, SsrBench, SsrCamera, SsrQuality};
use glam::{Mat4, Vec2, Vec3, Vec4};

const NEAR: f32 = 0.1;
const FOV_Y_DEG: f32 = 60.0;
const PRESETS: [QualityPreset; 4] = [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High, QualityPreset::Ultra];
const LUMA: Vec3 = Vec3::new(0.2126, 0.7152, 0.0722);

/// The camera: a person's eye height on the road, looking down the street, tilted down a little.
const EYE: Vec3 = Vec3::new(0.0, 1.6, 0.0);
const TILT_DEG: f32 = -8.0;
/// The wall across the street.
const WALL_Z: f32 = -12.0;
/// The neon sign on it: x and y extents and its radiance (magenta, bright).
const NEON_X: (f32, f32) = (-2.0, 2.0);
const NEON_Y: (f32, f32) = (2.1, 2.9);
const NEON: Vec3 = Vec3::new(12.0, 2.0, 9.0);
const WALL: Vec3 = Vec3::new(0.08, 0.08, 0.1);
const ROAD: Vec3 = Vec3::new(0.03, 0.03, 0.035);
/// Wet asphalt's perceptual roughness (the trace runs below `ssr::ROUGHNESS_CUTOFF`).
const WET_ROAD_ROUGHNESS: f32 = 0.08;
const WALL_ROUGHNESS: f32 = 0.85;

fn desktop(tier: PerformanceTier) -> DeviceClass {
    DeviceClass::new(FormFactor::Desktop, tier)
}

fn proj(size: (u32, u32)) -> Mat4 {
    glam::camera::rh::proj::directx::perspective_infinite_reverse(FOV_Y_DEG.to_radians(), size.0 as f32 / size.1 as f32, NEAR)
}

fn view() -> Mat4 {
    view_from(EYE)
}

/// The street camera's view from `eye` (the same direction from anywhere: a pan moves the eye).
fn view_from(eye: Vec3) -> Mat4 {
    let forward = Vec3::new(0.0, libm::sinf(TILT_DEG.to_radians()), -libm::cosf(TILT_DEG.to_radians()));
    glam::camera::rh::view::look_to_mat4(eye, forward, Vec3::Y)
}

fn camera(size: (u32, u32)) -> SsrCamera {
    let (proj, view) = (proj(size), view());
    SsrCamera { proj, view, view_proj: proj * view, prev_view_proj: proj * view, reversed: true, orthographic: false }
}

// ---------------------------------------------------------------------------------------------
// The street, ray cast

/// What a ray from the eye meets first.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Hit {
    Road(Vec3),
    Wall(Vec3),
    Sky,
}

/// The street: a road (y = 0) and a wall (z = `WALL_Z`) up to `wall_top` (`f32::INFINITY`: no sky).
#[derive(Clone, Copy, Debug)]
struct Street {
    wall_top: f32,
    /// One colour for everything (the seam row's uniform world), or the street's own colours.
    uniform: Option<Vec3>,
    /// The road's perceptual roughness (wet asphalt's by default).
    road_roughness: f32,
}

impl Street {
    const NEON: Street = Street { wall_top: 6.0, uniform: None, road_roughness: WET_ROAD_ROUGHNESS };

    fn cast(&self, origin: Vec3, dir: Vec3) -> Hit {
        let t_road = if dir.y < 0.0 { -origin.y / dir.y } else { f32::INFINITY };
        let t_wall = if dir.z < 0.0 { (WALL_Z - origin.z) / dir.z } else { f32::INFINITY };
        if t_road < t_wall {
            return Hit::Road(origin + dir * t_road);
        }
        let at = origin + dir * t_wall;
        if t_wall.is_finite() && at.y < self.wall_top { Hit::Wall(at) } else { Hit::Sky }
    }

    fn color(&self, hit: Hit) -> Vec3 {
        if let Some(color) = self.uniform {
            return if hit == Hit::Sky { Vec3::ZERO } else { color };
        }
        match hit {
            Hit::Road(_) => ROAD,
            Hit::Wall(p) if in_neon(p, 0.0) => NEON,
            Hit::Wall(_) => WALL,
            Hit::Sky => Vec3::ZERO,
        }
    }
}

fn in_neon(p: Vec3, inset: f32) -> bool {
    p.x > NEON_X.0 + inset && p.x < NEON_X.1 - inset && p.y > NEON_Y.0 + inset && p.y < NEON_Y.1 - inset
}

/// The world ray through screen point `uv` (y down).
fn eye_ray(size: (u32, u32), uv: Vec2) -> Vec3 {
    eye_ray_from(EYE, size, uv)
}

/// The world ray from `eye` through screen point `uv` (y down).
fn eye_ray_from(eye: Vec3, size: (u32, u32), uv: Vec2) -> Vec3 {
    let inv = (proj(size) * view_from(eye)).inverse();
    let ndc = Vec2::new(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let far = inv * Vec4::new(ndc.x, ndc.y, 0.5, 1.0);
    ((far.truncate() / far.w) - eye).normalize()
}

fn pixel_uv(p: (u32, u32), size: (u32, u32)) -> Vec2 {
    Vec2::new((p.0 as f32 + 0.5) / size.0 as f32, (p.1 as f32 + 0.5) / size.1 as f32)
}

/// The depth, packed surface and hit of every pixel at `render`.
struct Frame {
    render: (u32, u32),
    depths: Vec<f32>,
    surface: Vec<[u8; 4]>,
    hits: Vec<Hit>,
}

fn frame(street: Street, render: (u32, u32)) -> Frame {
    jittered_frame(street, render, Vec2::ZERO)
}

/// [`frame`] with every pixel sampled `jitter` render pixels off its centre (x right, y down): the
/// prepass of a TAA frame, whose depth and normals are drawn jittered while the trace's camera is
/// not.
fn jittered_frame(street: Street, render: (u32, u32), jitter: Vec2) -> Frame {
    let view_proj = proj(render) * view();
    let mut out = Frame { render, depths: Vec::new(), surface: Vec::new(), hits: Vec::new() };
    let offset = jitter / Vec2::new(render.0 as f32, render.1 as f32);
    for y in 0..render.1 {
        for x in 0..render.0 {
            let hit = street.cast(EYE, eye_ray(render, pixel_uv((x, y), render) + offset));
            let (depth, texel) = match hit {
                Hit::Road(p) => (device_depth(view_proj, p), pack_normal_roughness([0.0, 1.0, 0.0], street.road_roughness)),
                Hit::Wall(p) => (device_depth(view_proj, p), pack_normal_roughness([0.0, 0.0, 1.0], WALL_ROUGHNESS)),
                Hit::Sky => (0.0, pack_normal_roughness([0.0, 0.0, 1.0], 1.0)),
            };
            out.depths.push(depth);
            out.surface.push(texel);
            out.hits.push(hit);
        }
    }
    out
}

fn device_depth(view_proj: Mat4, p: Vec3) -> f32 {
    let clip = view_proj * p.extend(1.0);
    clip.z / clip.w
}

/// A colour pyramid (half the render size, `mips` mips) of the street's colours, each mip ray cast
/// at its own texel centres (the history a static camera's TAA converged on).
fn street_history(street: Street, render: (u32, u32), mips: u32) -> Vec<ssr::HistoryMip> {
    street_history_from(EYE, street, render, mips)
}

/// [`street_history`] seen from `eye` (last frame's, before a pan).
fn street_history_from(eye: Vec3, street: Street, render: (u32, u32), mips: u32) -> Vec<ssr::HistoryMip> {
    let base = hiz::base_size(render);
    (0..mips)
        .map(|mip| {
            let size = hiz::level_size(base, mip);
            let texels = (0..size.1).flat_map(|y| (0..size.0).map(move |x| (x, y))).map(|p| street.color(street.cast(eye, eye_ray_from(eye, render, pixel_uv(p, size)))).extend(1.0).to_array()).collect();
            (size, texels)
        })
        .collect()
}

/// A colour pyramid whose colour is its own uv (red u, green v): bilinear filtering keeps it
/// exact, so a reflection's colour names the point it reflects.
fn uv_history(render: (u32, u32), mips: u32) -> Vec<ssr::HistoryMip> {
    let base = hiz::base_size(render);
    let f16 = |v: f32| genex_render::post::tonemap::f16_to_f32(genex_render::post::tonemap::f32_to_f16(v));
    (0..mips)
        .map(|mip| {
            let size = hiz::level_size(base, mip);
            let texels = (0..size.1).flat_map(|y| (0..size.0).map(move |x| (x, y))).map(|p| pixel_uv(p, size)).map(|uv| [f16(uv.x), f16(uv.y), 0.0, 1.0]).collect();
            (size, texels)
        })
        .collect()
}

fn bench(frame: &Frame, history: Vec<ssr::HistoryMip>, quality: SsrQuality) -> SsrBench {
    let params = ssr::params(&camera(frame.render), quality, frame.render, history.len() as u32, 1.0);
    SsrBench { render: frame.render, depths: frame.depths.clone(), surface: frame.surface.clone(), history, params, reversed: true }
}

/// The twin's inputs for `bench`: the nearest-depth Hi-Z and the unpacked surfaces.
struct TwinInputs {
    hiz: Vec<HizLevel>,
    surface: Vec<Vec4>,
    history: Vec<((u32, u32), Vec<Vec4>)>,
}

fn twin_inputs(bench: &SsrBench) -> TwinInputs {
    let hiz = hiz::reference(ssr::hiz_reduce(bench.reversed), bench.render, &bench.depths).expect("hi-z");
    let surface = bench.surface.iter().map(|t| unpack_normal_roughness(*t)).map(|(n, r)| Vec3::from(n).extend(r)).collect();
    let history = bench.history.iter().map(|(size, texels)| (*size, texels.iter().map(|t| Vec4::from(*t)).collect())).collect();
    TwinInputs { hiz, surface, history }
}

fn screen<'a>(bench: &'a SsrBench, inputs: &'a TwinInputs) -> Screen<'a> {
    Screen { params: &bench.params, hiz: &inputs.hiz, depth: &bench.depths, surface: &inputs.surface, history: &inputs.history }
}

/// A trace texel's validity and the colour it reflects (its tone map and validity undone).
fn decode(texel: Vec4) -> (f32, Vec3) {
    let rgb = texel.truncate() / (1.0 - texel.truncate().dot(LUMA)).max(1e-4);
    (texel.w, if texel.w > 0.0 { rgb / texel.w } else { Vec3::ZERO })
}

// ---------------------------------------------------------------------------------------------
// CPU rows: presets, frames, targets

#[test]
fn the_reflections_run_on_desktop_high_and_ultra_only() {
    for tier in PerformanceTier::ALL {
        for preset in PRESETS {
            let quality = preset_quality(preset, desktop(tier));
            let expected = match preset {
                QualityPreset::High => SsrQuality::HIGH,
                QualityPreset::Ultra => SsrQuality::ULTRA,
                _ => SsrQuality::OFF,
            };
            assert_eq!(quality.ssr, expected, "desktop {tier:?} {preset:?}");
            let phone = preset_quality(preset, DeviceClass::new(FormFactor::Mobile, tier));
            assert_eq!(phone.ssr, SsrQuality::OFF, "phone {tier:?} {preset:?}: probes or the sky reflect on phones");
        }
    }
    assert_eq!(Quality::off().ssr, SsrQuality::OFF);
}

#[test]
fn a_frame_traces_only_with_taa_on_the_hdr_scene() {
    let high = preset_quality(QualityPreset::High, desktop(PerformanceTier::High));
    assert_eq!(high.ssr.asks(), ScreenInputs::SSR);
    assert_eq!(SsrQuality::OFF.asks(), ScreenInputs::NONE);
    assert!(ssr::frame_ssr(&high, true), "desktop high traces");
    assert!(!ssr::frame_ssr(&high, false), "not on the legacy LDR scene");
    let mut no_taa = high;
    no_taa.anti_aliasing = AntiAliasing::Msaa4;
    assert!(!ssr::frame_ssr(&no_taa, true), "no colour pyramid without TAA");
    let medium = preset_quality(QualityPreset::Medium, desktop(PerformanceTier::High));
    assert!(!ssr::frame_ssr(&medium, true));
}

#[test]
fn the_targets_are_core_and_ledgered_exactly() {
    let render = (1920, 1080);
    let rows = ssr::targets(render);
    let labels: Vec<_> = rows.iter().map(|r| (r.label, r.format, r.size, r.mips)).collect();
    assert_eq!(
        labels,
        vec![
            (ssr::HIZ_LABEL, wgpu::TextureFormat::R32Float, (960, 540), 10),
            (ssr::TRACE_LABEL, wgpu::TextureFormat::Rgba16Float, (960, 540), 1),
            (ssr::REFLECTIONS_LABEL, wgpu::TextureFormat::Rgba16Float, (1920, 1080), 1),
        ]
    );
    for row in &rows {
        assert!(row.usage.contains(wgpu::TextureUsages::STORAGE_BINDING | wgpu::TextureUsages::TEXTURE_BINDING), "{}", row.label);
        assert!(row.format.guaranteed_format_features(wgpu::Features::empty()).allowed_usages.contains(wgpu::TextureUsages::STORAGE_BINDING), "{}: core storage", row.label);
    }
    // r32float 960x540 chain (1/3 more for the mips, floored per level) + rgba16f half + rgba16f full.
    assert_eq!(ssr::target_bytes(render), rows.iter().map(|r| r.bytes()).sum::<u64>());
    assert_eq!(rows[1].bytes(), 960 * 540 * 8);
    assert_eq!(rows[2].bytes(), 1920 * 1080 * 8);
    assert_eq!(ssr::trace_size((1, 1)), (1, 1));
}

#[test]
fn the_hi_z_keeps_the_nearest_depth_of_either_convention() {
    let depths = [0.25, 0.75, 0.5, 1.0];
    assert_eq!(ssr::hiz_reduce(true).reduce(depths), 1.0, "reverse-Z: the largest is nearest");
    assert_eq!(ssr::hiz_reduce(false).reduce(depths), 0.25, "standard Z: the smallest is nearest");
    assert_ne!(ssr::hiz_reduce(true), hiz::reduction(true), "the cull's chain keeps the farthest");
}

#[test]
fn the_params_are_the_wgsl_struct_and_carry_the_frame() {
    assert_eq!(size_of::<GpuSsrParams>(), 4 * 64 + 4 * 16, "four matrices and four vec4 rows (std140, no padding)");
    let params = ssr::params(&camera((640, 360)), SsrQuality::HIGH, (640, 360), 5, 1.0);
    assert_eq!(params.size, [320, 180, 640, 360]);
    assert_eq!(params.knobs, [ssr::STEPS_HIGH, 9, 1, 0]);
    assert_eq!(params.extra[0], 4.0, "the colour pyramid's last mip");
    let identity = Mat4::from_cols_array_2d(&params.reprojection);
    assert!(identity.abs_diff_eq(Mat4::IDENTITY, 1e-4), "a still camera reprojects onto itself");
}

// ---------------------------------------------------------------------------------------------
// CPU rows: the twin on the street

#[test]
fn the_twin_reflects_the_wall_into_the_wet_road_where_the_mirror_says() {
    let render = (320, 180);
    let frame = frame(Street::NEON, render);
    let bench = bench(&frame, uv_history(render, 5), SsrQuality::HIGH);
    let inputs = twin_inputs(&bench);
    let screen = screen(&bench, &inputs);
    let trace = hiz::base_size(render);
    let view_proj = proj(render) * view();
    let (mut checked, mut within) = (0, 0);
    for y in 0..trace.1 {
        for x in 0..trace.0 {
            let full = (x * 2, y * 2);
            let Hit::Road(p) = frame.hits[(full.1 * render.0 + full.0) as usize] else { continue };
            // The mirror: the eye's ray off the road, cast on.
            let incoming = (p - EYE).normalize();
            let Hit::Wall(q) = Street::NEON.cast(p, Vec3::new(incoming.x, -incoming.y, incoming.z)) else { continue };
            let clip = view_proj * q.extend(1.0);
            let expected = Vec2::new(clip.x / clip.w * 0.5 + 0.5, 0.5 - clip.y / clip.w * 0.5);
            let (validity, uv) = decode(screen.trace((x as i32, y as i32)));
            if validity < 0.25 {
                continue;
            }
            checked += 1;
            let px = (uv.truncate() - expected) * Vec2::new(trace.0 as f32, trace.1 as f32);
            within += usize::from(px.length() <= 1.5);
        }
    }
    println!("{{\"row\":\"ssr-twin-mirror\",\"checked\":{checked},\"within_1_5px\":{within}}}");
    assert!(checked > 2000, "{checked} sure road reflections of the wall");
    assert!(within as f32 >= checked as f32 * 0.98, "{within} of {checked} within 1.5 trace px of the mirror");
}

#[test]
fn the_twin_does_not_trace_rough_surfaces_or_the_sky() {
    let render = (160, 90);
    let frame = frame(Street::NEON, render);
    let bench = bench(&frame, uv_history(render, 4), SsrQuality::HIGH);
    let inputs = twin_inputs(&bench);
    let screen = screen(&bench, &inputs);
    let trace = hiz::base_size(render);
    for y in 0..trace.1 {
        for x in 0..trace.0 {
            let hit = frame.hits[(y * 2 * render.0 + x * 2) as usize];
            if matches!(hit, Hit::Wall(_) | Hit::Sky) {
                assert_eq!(screen.trace((x as i32, y as i32)), Vec4::ZERO, "({x}, {y}) {hit:?}");
            }
        }
    }
}

#[test]
fn a_ray_that_leaves_the_screen_has_no_validity() {
    // A wall with no top: the road reflects it everywhere, so only rays that leave through the top
    // edge miss. Looking straight down the road from very low, rays leave the top for the far road.
    let render = (160, 90);
    let street = Street { wall_top: 0.5, uniform: None, road_roughness: WET_ROAD_ROUGHNESS };
    let frame = frame(street, render);
    let bench = bench(&frame, uv_history(render, 4), SsrQuality::HIGH);
    let inputs = twin_inputs(&bench);
    let screen = screen(&bench, &inputs);
    let trace = hiz::base_size(render);
    let mut sky_rays = 0;
    for y in 0..trace.1 {
        for x in 0..trace.0 {
            let Hit::Road(p) = frame.hits[(y * 2 * render.0 + x * 2) as usize] else { continue };
            let incoming = (p - EYE).normalize();
            if street.cast(p, Vec3::new(incoming.x, -incoming.y, incoming.z)) != Hit::Sky {
                continue;
            }
            sky_rays += 1;
            let (validity, _) = decode(screen.trace((x as i32, y as i32)));
            assert!(validity < 0.05, "({x}, {y}) reflects the sky with validity {validity}");
        }
    }
    assert!(sky_rays > 100, "{sky_rays} road texels reflect the sky");
}

/// The most a bright texel's glow may differ along an axis and along a diagonal at the same
/// distance, as a share of its peak (a round spread; bilinear taps of a coarse mip spread it as a
/// square, measured 0.086).
const GLOW_ANISOTROPY_MAX: f32 = 0.04;

/// A rough reflection of a small bright light (one texel of a coarse mip of the colour pyramid)
/// spreads as a round glow: the trace reads mip 1 and up with a cubic B-spline. Night shots showed
/// a soft square around each reflected pendant bulb (look pass, lane R).
#[test]
fn a_rough_reflection_spreads_a_small_light_round_not_square() {
    let sizes = [(64u32, 64u32), (32, 32), (16, 16)];
    let history: Vec<ssr::twin::Mip> = sizes
        .iter()
        .enumerate()
        .map(|(mip, &(w, h))| {
            let mut texels = vec![Vec4::ZERO; (w * h) as usize];
            if mip == 2 {
                texels[(8 * w + 8) as usize] = Vec4::ONE;
            }
            ((w, h), texels)
        })
        .collect();
    let centre = Vec2::splat(8.5 / 16.0);
    let at = |dx: f32, dy: f32| ssr::twin::sample_pyramid(&history, centre + Vec2::new(dx, dy) / 16.0, 2.0).x;
    let peak = at(0.0, 0.0);
    let worst = (1..=25)
        .map(|i| {
            let r = i as f32 * 0.1;
            let d = r * std::f32::consts::FRAC_1_SQRT_2;
            (at(r, 0.0) - at(d, d)).abs() / peak
        })
        .fold(0.0f32, f32::max);
    assert!(peak > 0.0, "the light is seen at its own texel");
    assert!(worst <= GLOW_ANISOTROPY_MAX, "the glow differs by {worst:.3} of its peak between an axis and a diagonal");
    // Mip 0 stays bilinear: a mirror keeps its sharpness.
    let sharp: Vec<ssr::twin::Mip> = vec![((4, 4), (0..16).map(|i| Vec4::splat(i as f32)).collect())];
    let texel = |x: u32, y: u32| Vec2::new((x as f32 + 0.5) / 4.0, (y as f32 + 0.5) / 4.0);
    assert_eq!(ssr::twin::sample_pyramid(&sharp, texel(1, 2), 0.0), Vec4::splat(9.0), "a mirror reads its texel");
}

#[test]
fn the_hand_over_to_the_probes_has_no_seam() {
    // Where the probe's radiance is the screen's, the sum is that radiance at every confidence.
    let radiance = Vec3::new(0.4, 0.3, 0.2);
    for step in 0..=100 {
        let confidence = step as f32 / 100.0;
        let out = ssr::apply(radiance, (radiance * confidence).extend(confidence));
        assert!(out.abs_diff_eq(radiance, 1e-6), "{confidence}: {out}");
    }
    // No screen reflection: the probe alone; a sure one: the screen alone.
    assert_eq!(ssr::apply(radiance, Vec4::ZERO), radiance);
    assert_eq!(ssr::apply(radiance, Vec4::new(1.0, 2.0, 3.0, 1.0)), Vec3::new(1.0, 2.0, 3.0));
}

#[test]
fn the_passes_validate_against_webgpu_core_and_are_registered() {
    use naga::back::{hlsl, msl, spv};
    for (name, source) in [("ssr-trace", ssr::SSR_TRACE), ("ssr-resolve", ssr::SSR_RESOLVE)] {
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
        let info = naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).unwrap_or_else(|error| panic!("{name}: {error:?}"));
        assert!(source.len() <= genex_render::WGSL_MAX_BYTES, "{name}: {} bytes", source.len());
        let mut hlsl_source = String::new();
        let options = hlsl::Options { shader_model: hlsl::ShaderModel::V5_1, ..Default::default() };
        hlsl::Writer::new(&mut hlsl_source, &options, &hlsl::PipelineOptions::default()).write(&module, &info, None).unwrap_or_else(|error| panic!("{name}: HLSL: {error:?}"));
        let options = msl::Options { lang_version: (2, 4), ..Default::default() };
        msl::write_string(&module, &info, &options, &msl::PipelineOptions::default()).unwrap_or_else(|error| panic!("{name}: MSL: {error:?}"));
        let options = spv::Options { lang_version: (1, 3), ..Default::default() };
        spv::write_vec(&module, &info, &options, None).unwrap_or_else(|error| panic!("{name}: SPIR-V: {error:?}"));
        assert!(genex_render::shaders::SHADERS.iter().any(|(n, s)| *n == name && *s == source), "{name} is a registered renderer shader");
        println!("{{\"row\":\"ssr-web-bytes\",\"module\":\"{name}\",\"minified\":{}}}", genex_render::shaders::minify::minified_len(source));
    }
    // The hand-over chunk compiles inside a forward-like fragment.
    let kernel = format!("{}\n@fragment fn fs(@location(0) e: vec3<f32>, @location(1) s: vec4<f32>) -> @location(0) vec4<f32> {{ return vec4<f32>(gx_ssr_apply(e, s), 1.0); }}", ssr::SSR_APPLY);
    let module = naga::front::wgsl::parse_str(&kernel).expect("apply chunk");
    naga::valid::Validator::new(naga::valid::ValidationFlags::all(), naga::valid::Capabilities::empty()).validate(&module).expect("apply chunk validates");
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

fn perf_line(line: &str) {
    println!("{line}");
    if let Ok(path) = std::env::var("GENEX_PERF_OUT") {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).expect("perf out");
        writeln!(file, "{line}").expect("perf line");
    }
}

#[test]
#[ignore = "needs a GPU: GENEX_REQUIRE_METAL=1 cargo test --test ssr -- --ignored metal"]
fn metal_the_trace_finds_what_its_cpu_twin_finds() {
    let Some(gpu) = gpu() else { return };
    let render = (320, 180);
    let frame = frame(Street::NEON, render);
    let bench = bench(&frame, uv_history(render, 5), SsrQuality::HIGH);
    let out = ssr::ssr_run(&gpu, &bench).expect("ssr");
    let inputs = twin_inputs(&bench);
    let twin = screen(&bench, &inputs).trace_all();
    let trace = hiz::base_size(render);
    let (mut sure, mut agree, mut worst_validity) = (0, 0, 0.0f32);
    for (gpu_texel, twin_texel) in out.trace.iter().zip(&twin) {
        let (gv, guv) = decode(Vec4::from(*gpu_texel));
        let (tv, tuv) = decode(*twin_texel);
        worst_validity = worst_validity.max((gv - tv).abs());
        if gv.max(tv) < 0.05 {
            continue;
        }
        sure += 1;
        let px = ((guv - tuv).truncate() * Vec2::new(trace.0 as f32, trace.1 as f32)).length();
        agree += usize::from((gv - tv).abs() <= 0.02 && px <= 1.0);
    }
    let share = agree as f32 / sure.max(1) as f32;
    perf_line(&format!("{{\"row\":\"ssr-gpu-vs-twin\",\"traced\":{sure},\"agree\":{agree},\"share\":{share:.4},\"worst_validity\":{worst_validity:.4}}}"));
    assert!(sure > 2000, "{sure} traced texels");
    assert!(share >= 0.99, "{agree} of {sure} agree (validity within 0.02, the hit within 1 trace px)");
}

#[test]
#[ignore = "needs a GPU: GENEX_REQUIRE_METAL=1 cargo test --test ssr -- --ignored metal"]
fn metal_the_wet_road_reflects_the_neon() {
    let Some(gpu) = gpu() else { return };
    let render = (640, 360);
    let frame = frame(Street::NEON, render);
    let bench = bench(&frame, street_history(Street::NEON, render, 5), SsrQuality::HIGH);
    let out = ssr::ssr_run(&gpu, &bench).expect("ssr");
    let (mut mirrored, mut shown, mut confidence_sum) = (0, 0, 0.0);
    for y in 0..render.1 {
        for x in 0..render.0 {
            let index = (y * render.0 + x) as usize;
            let Hit::Road(p) = frame.hits[index] else { continue };
            let incoming = (p - EYE).normalize();
            // The road pixels whose mirror lands well inside the sign (an eighth of a metre in).
            let Hit::Wall(q) = Street::NEON.cast(p, Vec3::new(incoming.x, -incoming.y, incoming.z)) else { continue };
            if !in_neon(q, 0.125) {
                continue;
            }
            mirrored += 1;
            let texel = Vec4::from(out.reflections[index]);
            confidence_sum += texel.w;
            let seen = texel.truncate() / texel.w.max(1e-4);
            let close = (seen.dot(LUMA) - NEON.dot(LUMA)).abs() <= NEON.dot(LUMA) * 0.15;
            shown += usize::from(texel.w >= 0.5 && close);
        }
    }
    let confidence = confidence_sum / mirrored.max(1) as f32;
    perf_line(&format!("{{\"row\":\"ssr-neon-in-wet-road\",\"render\":[{},{}],\"mirrored\":{mirrored},\"shown\":{shown},\"mean_confidence\":{confidence:.3}}}", render.0, render.1));
    assert!(mirrored > 1000, "{mirrored} road pixels mirror the sign");
    assert!(shown as f32 >= mirrored as f32 * 0.9, "{shown} of {mirrored} show the neon (confidence >= 0.5, luminance within 15%)");
}

#[test]
#[ignore = "needs a GPU: GENEX_REQUIRE_METAL=1 cargo test --test ssr -- --ignored metal"]
fn metal_the_fade_to_the_probes_has_no_seam() {
    let Some(gpu) = gpu() else { return };
    let render = (640, 360);
    let color = Vec3::new(0.4, 0.3, 0.2);
    let street = Street { wall_top: f32::INFINITY, uniform: Some(color), road_roughness: WET_ROAD_ROUGHNESS };
    let frame = frame(street, render);
    let bench = bench(&frame, street_history(street, render, 5), SsrQuality::HIGH);
    let out = ssr::ssr_run(&gpu, &bench).expect("ssr");
    if let Ok(path) = std::env::var("GENEX_SSR_DUMP") {
        let bytes: Vec<u8> = out.reflections.iter().flat_map(|t| t[3].to_le_bytes()).collect();
        std::fs::write(path, bytes).expect("dump");
    }
    let mut worst = 0.0f32;
    let mut worst_step = 0.0f32;
    let mut faded = 0;
    for y in 0..render.1 {
        for x in 0..render.0 {
            let index = (y * render.0 + x) as usize;
            let texel = Vec4::from(out.reflections[index]);
            // The probe sees the same uniform world: every pixel must read the same radiance.
            let lit = ssr::apply(color, texel);
            worst = worst.max(((lit - color).abs() / color).max_element());
            faded += usize::from(texel.w > 0.02 && texel.w < 0.98);
            let road = |i: usize| matches!(frame.hits[i], Hit::Road(p) if p.z > WALL_Z + 1.0);
            if x + 1 < render.0 && road(index) && road(index + 1) {
                worst_step = worst_step.max((out.reflections[index + 1][3] - texel.w).abs());
            }
            if y + 1 < render.1 && road(index) && road(index + render.0 as usize) {
                worst_step = worst_step.max((out.reflections[index + render.0 as usize][3] - texel.w).abs());
            }
        }
    }
    perf_line(&format!("{{\"row\":\"ssr-no-seam\",\"worst_relative\":{worst:.5},\"worst_confidence_step\":{worst_step:.4},\"faded_pixels\":{faded}}}"));
    assert!(faded > 1000, "{faded} pixels fade between screen and probes");
    assert!(worst <= 0.01, "the hand-over moves a uniform world by {worst}");
    assert!(worst_step <= 0.1, "the confidence steps by {worst_step} between neighbouring road pixels");
}

/// What a reflection may swing by over TAA's jitter cycle where the mirror image is flat (the
/// sign's or the wall's interior): its confidence (a hit flipping to a miss sparkles) and its
/// luminance (relative). TAA averages what is left; a swing past these is a flicker it shows.
const JITTER_CONFIDENCE_SWING_MAX: f32 = 0.2;
const JITTER_LUMA_SWING_MAX: f32 = 0.1;
/// The share of interior pixels allowed past either swing.
const JITTER_FLICKER_SHARE_MAX: f32 = 0.01;

/// B.9 follow-up: the wet road's reflection holds still under TAA's sub-pixel jitter. The prepass
/// is drawn at each of the eight Halton offsets (the trace's camera unjittered, as the renderer
/// hands it), and every road pixel whose mirror lands inside the sign or the plain wall (a quarter
/// metre from any edge) must keep its confidence and luminance over the cycle: a hit that flips
/// to a miss under a sub-pixel move is the sparkle TAA cannot settle.
#[test]
#[ignore = "needs a GPU: GENEX_REQUIRE_METAL=1 cargo test --test ssr -- --ignored metal"]
fn metal_the_wet_road_reflection_holds_still_under_taa_jitter() {
    let Some(gpu) = gpu() else { return };
    for road_roughness in JITTER_ROAD_ROUGHNESS {
        jitter_row(&gpu, Street { road_roughness, ..Street::NEON });
    }
}

/// The road roughnesses the jitter row traces: a puddle's film, wet asphalt, and asphalt after the
/// rain (Harbour Street's scan at dusk: a wide cone, the trace's hardest case for hit flips).
const JITTER_ROAD_ROUGHNESS: [f32; 3] = [0.04, WET_ROAD_ROUGHNESS, 0.45];

fn jitter_row(gpu: &Gpu, street: Street) {
    let render = (640, 360);
    let history = street_history(street, render, 5);
    let cycle = genex_render::settings::JitterCycle::Eight;
    let frames: Vec<(Frame, Vec<[f32; 4]>)> = (0..u64::from(cycle.frames()))
        .map(|index| {
            let jitter = Vec2::from(genex_render::jitter::offset_px(index, cycle));
            let frame = jittered_frame(street, render, jitter);
            let out = ssr::ssr_run(gpu, &bench(&frame, history.clone(), SsrQuality::HIGH)).expect("ssr");
            (frame, out.reflections)
        })
        .collect();
    let still = frame(street, render);
    let (mut interior, mut flicker, mut worst_confidence, mut luma_swings) = (0usize, 0usize, 0.0f32, Vec::new());
    for index in 0..(render.0 * render.1) as usize {
        let Hit::Road(p) = still.hits[index] else { continue };
        let incoming = (p - EYE).normalize();
        let Hit::Wall(q) = Street::NEON.cast(p, Vec3::new(incoming.x, -incoming.y, incoming.z)) else { continue };
        let near_sign_edge = in_neon(q, -0.25) && !in_neon(q, 0.25);
        let near_wall_top = q.y > Street::NEON.wall_top - 0.25;
        // Every jittered sample of the pixel must still be road (the road's far edge moves too).
        let road_in_all = frames.iter().all(|(frame, _)| matches!(frame.hits[index], Hit::Road(_)));
        if near_sign_edge || near_wall_top || !road_in_all {
            continue;
        }
        let texels: Vec<Vec4> = frames.iter().map(|(_, reflections)| Vec4::from(reflections[index])).collect();
        let (low, high) = texels.iter().fold((f32::MAX, f32::MIN), |(lo, hi), t| (lo.min(t.w), hi.max(t.w)));
        let lumas: Vec<f32> = texels.iter().map(|t| (t.truncate() / t.w.max(1e-4)).dot(LUMA)).collect();
        let (luma_low, luma_high) = lumas.iter().fold((f32::MAX, f32::MIN), |(lo, hi), l| (lo.min(*l), hi.max(*l)));
        let luma_swing = if high >= 0.5 { (luma_high - luma_low) / luma_high.max(1e-4) } else { 0.0 };
        interior += 1;
        worst_confidence = worst_confidence.max(high - low);
        luma_swings.push(luma_swing);
        flicker += usize::from(high - low > JITTER_CONFIDENCE_SWING_MAX || luma_swing > JITTER_LUMA_SWING_MAX);
    }
    luma_swings.sort_by(f32::total_cmp);
    let luma_p99 = luma_swings.get(luma_swings.len() * 99 / 100).copied().unwrap_or(0.0);
    let share = flicker as f32 / interior.max(1) as f32;
    perf_line(&format!(
        "{{\"row\":\"ssr-jitter-flicker\",\"road_roughness\":{},\"render\":[{},{}],\"interior\":{interior},\"flicker\":{flicker},\"share\":{share:.5},\"worst_confidence_swing\":{worst_confidence:.4},\"luma_swing_p99\":{luma_p99:.4}}}",
        street.road_roughness, render.0, render.1
    ));
    assert!(interior > 20_000, "{interior} road pixels mirror a flat part of the wall");
    assert!(share <= JITTER_FLICKER_SHARE_MAX, "roughness {}: {flicker} of {interior} road pixels flicker over the jitter cycle (worst confidence swing {worst_confidence})", street.road_roughness);
}

/// How far the camera moved sideways since the colour pyramid was written in the pan rows, m per
/// frame (a walk, a run and a fast strafe at 60 Hz).
const PAN_STEPS_M: [f32; 3] = [0.025, 0.1, 0.4];
/// The wall's code: x across [-10, 10] m in red, y across the wall's height in green, blue a half.
const CODE_X: (f32, f32) = (-10.0, 10.0);

/// A colour pyramid seen from `eye` whose colour names the wall point it shows (`CODE_X`, green
/// the height over the wall's), black elsewhere: a reflection's colour says which wall point it
/// reflects.
fn wall_code_history(eye: Vec3, render: (u32, u32), mips: u32) -> Vec<ssr::HistoryMip> {
    let base = hiz::base_size(render);
    let street = Street::NEON;
    (0..mips)
        .map(|mip| {
            let size = hiz::level_size(base, mip);
            let texels = (0..size.1)
                .flat_map(|y| (0..size.0).map(move |x| (x, y)))
                .map(|p| match street.cast(eye, eye_ray_from(eye, render, pixel_uv(p, size))) {
                    Hit::Wall(q) => [(q.x - CODE_X.0) / (CODE_X.1 - CODE_X.0), q.y / street.wall_top, 0.5, 1.0],
                    _ => [0.0, 0.0, 0.0, 1.0],
                })
                .collect();
            (size, texels)
        })
        .collect()
}

/// B.9 follow-up: the wet road's reflection does not swim on a pan. The pyramid is last frame's,
/// seen from where the camera stood before a sideways step, and its colour names the wall point it
/// shows; the trace reprojects each hit into it (`GpuSsrParams::reprojection`), so every road pixel
/// mirroring the wall must still read the wall point its mirror ray meets. Without the
/// reprojection (`prev_view_proj` this frame's) the reflection slides by the step.
#[test]
#[ignore = "needs a GPU: GENEX_REQUIRE_METAL=1 cargo test --test ssr -- --ignored metal"]
fn metal_the_wet_road_reflection_does_not_swim_on_a_pan() {
    let Some(gpu) = gpu() else { return };
    let render = (640, 360);
    let frame = frame(Street::NEON, render);
    let mirrored: Vec<(usize, Vec3)> = frame
        .hits
        .iter()
        .enumerate()
        .filter_map(|(index, hit)| {
            let Hit::Road(p) = *hit else { return None };
            let incoming = (p - EYE).normalize();
            let Hit::Wall(q) = Street::NEON.cast(p, Vec3::new(incoming.x, -incoming.y, incoming.z)) else { return None };
            let inside = q.x > CODE_X.0 + 0.5 && q.x < CODE_X.1 - 0.5 && q.y > 0.5 && q.y < Street::NEON.wall_top - 0.5;
            inside.then_some((index, q))
        })
        .collect();
    let slide = |out: &ssr::SsrBenchOut| {
        let mut errors: Vec<f32> = mirrored
            .iter()
            .filter_map(|(index, q)| {
                let t = Vec4::from(out.reflections[*index]);
                (t.w >= 0.5).then(|| {
                    let code = t.truncate() / t.w;
                    Vec2::new(CODE_X.0 + code.x * (CODE_X.1 - CODE_X.0), code.y * Street::NEON.wall_top).distance(Vec2::new(q.x, q.y))
                })
            })
            .collect();
        errors.sort_by(f32::total_cmp);
        let at = |share: usize| errors.get(errors.len() * share / 100).copied().unwrap_or(f32::MAX);
        (errors.len(), at(50), at(95))
    };
    for step in PAN_STEPS_M {
        let before = EYE - Vec3::new(step, 0.0, 0.0);
        let mut moved = bench(&frame, wall_code_history(before, render, 5), SsrQuality::HIGH);
        let reprojected = SsrCamera { prev_view_proj: proj(render) * view_from(before), ..camera(render) };
        moved.params = ssr::params(&reprojected, SsrQuality::HIGH, render, 5, 1.0);
        let (count, median, p95) = slide(&ssr::ssr_run(&gpu, &moved).expect("ssr"));
        moved.params = ssr::params(&camera(render), SsrQuality::HIGH, render, 5, 1.0);
        let (_, unprojected_median, _) = slide(&ssr::ssr_run(&gpu, &moved).expect("ssr"));
        perf_line(&format!(
            "{{\"row\":\"ssr-pan\",\"step_m\":{step},\"reflecting\":{count},\"slide_median_m\":{median:.4},\"slide_p95_m\":{p95:.4},\"without_reprojection_median_m\":{unprojected_median:.4}}}"
        ));
        assert!(count as f32 >= mirrored.len() as f32 * 0.8 && count > 20_000, "{count} of {} wall-mirroring road pixels reflect", mirrored.len());
        assert!(median <= 0.05 && p95 <= 0.15, "a {step} m pan slid the reflection: median {median} m, p95 {p95} m");
    }
}

/// Cost samples per row (the row reports their median) and the warm-up samples dropped first.
const COST_SAMPLES: u32 = 15;
const COST_WARM_UP: usize = 5;

fn median_cost(gpu: &Gpu, render: (u32, u32), quality: SsrQuality) -> Option<f32> {
    let frame = frame(Street::NEON, render);
    let mips = genex_render::screen_inputs::pyramid_mips(render);
    let bench = bench(&frame, street_history(Street::NEON, render, mips), quality);
    let mut costs = ssr::ssr_gpu_ms(gpu, &bench, COST_SAMPLES + COST_WARM_UP as u32).expect("cost")?;
    costs.drain(..COST_WARM_UP.min(costs.len()));
    costs.sort_by(f32::total_cmp);
    costs.get(costs.len() / 2).copied()
}

#[test]
#[ignore = "needs a GPU: GENEX_REQUIRE_METAL=1 cargo test --test ssr -- --ignored metal"]
fn metal_the_reflections_cost_at_most_a_millisecond_at_high() {
    let Some(gpu) = gpu() else { return };
    let rows = [("high-1080p", (1920, 1080), SsrQuality::HIGH), ("high-1440p", (2560, 1440), SsrQuality::HIGH), ("ultra-4k", (3840, 2160), SsrQuality::ULTRA)];
    let mut measured = Vec::new();
    for (name, render, quality) in rows {
        let Some(ms) = median_cost(&gpu, render, quality) else {
            eprintln!("skipped: no timestamps");
            return;
        };
        let hiz = hiz::hiz_gpu_ms(&gpu, render, 9).expect("hi-z").map(|mut c| {
            c.sort_by(f32::total_cmp);
            c[c.len() / 2]
        });
        perf_line(&format!("{{\"row\":\"ssr-cost\",\"case\":\"{name}\",\"render\":[{},{}],\"steps\":{},\"node_ms_p50\":{ms:.3},\"hiz_ms_p50\":{}}}", render.0, render.1, quality.steps, hiz.map_or("null".into(), |v| format!("{v:.3}"))));
        measured.push((name, ms));
    }
    let high = measured.iter().find(|(name, _)| *name == "high-1440p").map(|(_, ms)| *ms).expect("1440p");
    assert!(high <= ssr::SSR_MS_MAX_HIGH, "high at 1440p: {high} ms");
    let ultra = measured.iter().find(|(name, _)| *name == "ultra-4k").map(|(_, ms)| *ms).expect("4k");
    assert!(ultra <= ssr::SSR_MS_MAX_ULTRA, "ultra at 4K: {ultra} ms");
}
