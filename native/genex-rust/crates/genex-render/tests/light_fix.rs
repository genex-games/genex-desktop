//! The Bodycam light fix (owner, 2026-10-28, a snowy yard at `high`): walking from the bright yard
//! into a room went far too dark for seconds; the first-person arms and rifle drew as a black
//! silhouette with the sun in front; the ground's shadows were black under a cloudy sky that read
//! deep blue; snow fell as little cubes. Real-GPU rows (`#[ignore]`d, every name contains `metal`)
//! hold each fix on Live frames at desktop `high`, and write their frames as evidence under
//! `GENEX_LIGHT_FIX_EVIDENCE_DIR` when it is set:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --offline --locked --test light_fix -- --ignored metal

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::immediate::FrameRenderer;
use genex_render::irradiance::IrradianceVolume;
use genex_render::particles::EmitterDesc;
use genex_render::probes::ReflectionProbe;
use genex_render::scene::{CameraDesc, Material, MeshId, scaled};
use genex_render::settings::{Clouds, Environment, ExposureMode, Look, QualityPreset, SceneFormat, SkyParams, Tonemapper};
use genex_render::{CullPath, Gpu, ImmediateFrame, RenderOptions};

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

const SIZE: (u32, u32) = (480, 270);
/// Body-cam's sun: towards (-0.9, 0.62, 1.0) at 7.5.
const SUN_TOWARDS: [f32; 3] = [-0.9, 0.62, 1.0];
const SUN_INTENSITY: f32 = 7.5;

/// Live frames at desktop `high` under the sky `sky`, with `look`.
fn live(gpu: &Gpu, look: Look, sky: SkyParams) -> FrameRenderer {
    let mut frames = FrameRenderer::new(gpu, SIZE.0, SIZE.1, RenderOptions { msaa: false }).expect("renderer");
    let renderer = frames.renderer_mut();
    renderer.set_scene_format(SceneFormat::Rgba16Float);
    renderer.set_device_class(DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    renderer.set_quality(&genex_render::presets::preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)));
    renderer.set_render_scale(1.0);
    renderer.set_environment(&Environment::Sky(sky));
    renderer.set_look(look);
    frames
}

/// Body-cam's look: AgX punchy, auto exposure at -0.6 EV.
fn bodycam_look() -> Look {
    let mut look = Look::default();
    look.tonemapper = Tonemapper::AgxPunchy;
    look.exposure = ExposureMode::Auto;
    look.ev_compensation = -0.6;
    look
}

/// A frame through `camera` lit by body-cam's sun.
fn sunlit(camera: CameraDesc, tick: u64) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera, [170, 182, 196, 255]);
    let lighting = frame.lighting_mut();
    lighting.sun_dir = glam::Vec3::from(SUN_TOWARDS).normalize().to_array();
    lighting.sun_color = [255, 255, 255];
    lighting.sun_intensity = SUN_INTENSITY;
    lighting.ambient = [170, 185, 210];
    lighting.ambient_intensity = 0.12;
    lighting.shadows = true;
    frame.set_tick(tick);
    frame
}

/// The mean display luma (0..255) of the pixels of `capture` in `rect` (x0, y0, x1, y1).
fn luma(capture: &Capture, (x0, y0, x1, y1): (u32, u32, u32, u32)) -> f32 {
    let width = capture.width();
    let mut sum = 0.0;
    for y in y0..y1 {
        for x in x0..x1 {
            let at = ((y * width + x) * 4) as usize;
            let [b, g, r] = [capture.bgra()[at], capture.bgra()[at + 1], capture.bgra()[at + 2]].map(f32::from);
            sum += 0.0722 * b + 0.7152 * g + 0.2126 * r;
        }
    }
    sum / ((x1 - x0) * (y1 - y0)) as f32
}

/// Write `capture` as raw BGRA named `name` under `GENEX_LIGHT_FIX_EVIDENCE_DIR`, when set.
fn write_evidence(name: &str, capture: &Capture) {
    let Ok(folder) = std::env::var("GENEX_LIGHT_FIX_EVIDENCE_DIR") else { return };
    std::fs::create_dir_all(&folder).expect("evidence folder");
    let file = format!("{name}-{}x{}.bgra", capture.width(), capture.height());
    std::fs::write(std::path::Path::new(&folder).join(file), capture.bgra()).expect("evidence written");
}

// --- 1. Eye adaptation: from the sunlit yard into a corridor ---

/// The corridor: x 0..12, z -1.5..1.5, 3 high inside, open at x = 12 onto a snowy yard on the
/// side away from the sun (towards -x), so no sunlight falls in: the sky through its mouth and the
/// bounce of the snow light it.
const CORRIDOR: ([f32; 3], [f32; 3]) = ([0.0, 0.0, -1.5], [12.0, 3.0, 1.5]);

/// The camera `x` along the corridor's axis looking down it towards -x, `turn` radians from there
/// towards the sunlit yard (+x, -z).
fn corridor_frame(x: f32, turn: f32, tick: u64, rooms: bool) -> ImmediateFrame {
    let ahead = glam::Vec3::new(-libm::cosf(turn), -0.05, -libm::sinf(turn));
    let eye = glam::Vec3::new(x, 1.6, 0.0);
    let camera = CameraDesc::look_at(eye.to_array(), (eye + ahead * 5.0).to_array());
    let mut frame = sunlit(camera, tick);
    let plaster = Material::color([180, 178, 170, 255]).with_pbr(0.0, 0.9);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [80.0, 0.1, 80.0]), Material::color([225, 230, 236, 255]).with_pbr(0.0, 0.8));
    frame.mesh(MeshId::CUBE, scaled([6.0, 3.1, 0.0], [12.0, 0.2, 3.4]), plaster);
    frame.mesh(MeshId::CUBE, scaled([6.0, 1.5, -1.6], [12.0, 3.0, 0.2]), plaster);
    frame.mesh(MeshId::CUBE, scaled([6.0, 1.5, 1.6], [12.0, 3.0, 0.2]), plaster);
    frame.mesh(MeshId::CUBE, scaled([-0.1, 1.5, 0.0], [0.2, 3.0, 3.4]), plaster);
    if rooms {
        let (min, max) = CORRIDOR;
        let lighting = frame.lighting_mut();
        lighting.reflection_probes.push(ReflectionProbe::new(min, max).with_capture([6.0, 1.6, 0.0]).with_blend(0.25));
        lighting.irradiance_volumes.push(IrradianceVolume::new(min, max).with_blend(0.25));
    }
    frame
}

/// Ticks outside facing the sunlit yard (two seconds: the yard's exposure settled), turning to
/// the corridor's mouth, walking in at 3 m/s (no camera cut, as a player walks), then inside.
const OUTSIDE_TICKS: u64 = 120;
const TURN_TICKS: u64 = 60;
const WALK_TICKS: u64 = 160;
const INSIDE_TICKS: u64 = 180;
/// Where the walk starts and ends along the corridor's axis (its mouth is at x 12).
const WALK_FROM_X: f32 = 18.0;
const WALK_TO_X: f32 = 10.0;

/// The corridor's mean display luma on each frame from the one the camera crosses into the
/// corridor (x 12) as it walks in from the sunlit yard, with `look`; the corridor is declared as a
/// room (a probe and a volume).
fn step_inside(gpu: &Gpu, look: Look, name: &str) -> Vec<f32> {
    let rooms = true;
    let mut frames = live(gpu, look, SkyParams::default());
    let mut trace = Vec::new();
    let mut crossed: Option<u64> = None;
    let facing_yard = 2.4;
    for tick in 0..OUTSIDE_TICKS + TURN_TICKS + WALK_TICKS + INSIDE_TICKS {
        let turning = (tick.saturating_sub(OUTSIDE_TICKS) as f32 / TURN_TICKS as f32).min(1.0);
        let walked = (tick.saturating_sub(OUTSIDE_TICKS + TURN_TICKS) as f32 / WALK_TICKS as f32).min(1.0);
        let x = WALK_FROM_X + (WALK_TO_X - WALK_FROM_X) * walked;
        let frame = corridor_frame(x, facing_yard * (1.0 - turning), tick, rooms);
        frames.render(gpu, &frame, CullPath::Gpu, None).expect("frame");
        if x < CORRIDOR.1[0] && crossed.is_none() {
            crossed = Some(tick);
        }
        if let Some(at) = crossed {
            let capture = frames.capture(gpu).expect("capture");
            let since = tick - at;
            if matches!(since, 0 | 6 | 15 | 30 | 60 | 120 | 179) {
                write_evidence(&format!("adapt-{name}-{since:03}"), &capture);
            }
            trace.push(luma(&capture, (60, 40, 420, 230)));
            if trace.len() as u64 >= INSIDE_TICKS {
                break;
            }
        }
    }
    trace
}

/// Frames until the corridor reads within this share of where it settles.
const SETTLED_SHARE: f32 = 0.85;
/// The most frames (60 a second) the corridor may take to read after the step: a quarter second.
const READS_WITHIN_FRAMES: usize = 15;

fn frames_to_read(trace: &[f32]) -> usize {
    let settled = trace.last().copied().unwrap_or(0.0);
    trace.iter().position(|value| *value >= settled * SETTLED_SHARE).unwrap_or(trace.len())
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_stepping_from_the_yard_into_a_corridor_reads_within_a_quarter_second() {
    let Some(gpu) = gpu() else { return };
    // Before: the old brightening speed (1 EV/s), no quicker adjustment at the doorway.
    let mut old = bodycam_look();
    old.adaptation_up = 1.0;
    old.doorway_adaptation = false;
    let before = step_inside(&gpu, old, "before");
    let mut speed_only = bodycam_look();
    speed_only.doorway_adaptation = false;
    let speed_only = step_inside(&gpu, speed_only, "speed");
    let after = step_inside(&gpu, bodycam_look(), "after");
    let show = |trace: &[f32]| [0, 6, 15, 30, 60, 120, 179].map(|i| trace[i]);
    eprintln!("before (1 EV/s, no doorway boost): {:?}, reads after {} frames", show(&before), frames_to_read(&before));
    eprintln!("4 EV/s, no doorway boost: {:?}, reads after {} frames", show(&speed_only), frames_to_read(&speed_only));
    eprintln!("after (4 EV/s and the doorway): {:?}, reads after {} frames", show(&after), frames_to_read(&after));
    assert!(frames_to_read(&before) > READS_WITHIN_FRAMES * 4, "the scene shows the reported lag: {} frames before", frames_to_read(&before));
    assert!(frames_to_read(&after) <= READS_WITHIN_FRAMES, "the corridor reads after {} frames (at most {READS_WITHIN_FRAMES})", frames_to_read(&after));
}

// --- 2. The view model with the sun in front ---

/// A glove (body-cam's dark arm shade) and the rifle's steel 30 cm in front of a camera looking
/// into the sun across the snowy yard.
fn view_model_frame(view_model: bool) -> ImmediateFrame {
    let towards = glam::Vec3::from(SUN_TOWARDS).normalize();
    let ahead = glam::Vec3::new(towards.x, 0.0, towards.z).normalize();
    let eye = glam::Vec3::new(0.0, 1.6, 0.0);
    let mut frame = sunlit(CameraDesc::look_at(eye.to_array(), (eye + ahead * 5.0 - glam::Vec3::Y * 0.6).to_array()), 0);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [80.0, 0.1, 80.0]), Material::color([225, 230, 236, 255]).with_pbr(0.0, 0.8));
    let right = ahead.cross(glam::Vec3::Y).normalize();
    let glove = eye + ahead * 0.35 - glam::Vec3::Y * 0.18 + right * 0.08;
    let steel = eye + ahead * 0.45 - glam::Vec3::Y * 0.12 - right * 0.06;
    let glove_material = Material { view_model, ..Material::color([52, 52, 55, 255]).with_pbr(0.0, 0.7) };
    let steel_material = Material { view_model, ..Material::color([105, 105, 108, 255]).with_pbr(1.0, 0.45) };
    frame.mesh(MeshId::CUBE, scaled(glove.to_array(), [0.1, 0.08, 0.16]), glove_material);
    frame.mesh(MeshId::CUBE, scaled(steel.to_array(), [0.04, 0.05, 0.3]), steel_material);
    frame
}

/// The least display levels the view model's flag lifts the glove and the steel by: from the black
/// silhouette (a handful of levels) to a dark shape with its form.
const VIEW_MODEL_LIFT_MIN: f32 = 12.0;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_view_model_with_the_sun_in_front_is_never_a_black_silhouette() {
    let Some(gpu) = gpu() else { return };
    let mut shown = Vec::new();
    for view_model in [false, true] {
        let mut frames = live(&gpu, bodycam_look(), SkyParams::default());
        for _ in 0..30 {
            frames.render(&gpu, &view_model_frame(view_model), CullPath::Gpu, None).expect("frame");
        }
        let capture = frames.capture(&gpu).expect("capture");
        write_evidence(&format!("view-model-{}", if view_model { "after" } else { "before" }), &capture);
        // The glove fills the lower middle of the frame.
        let glove = luma(&capture, (240, 200, 330, 262));
        eprintln!("view model {view_model}: the glove reads {glove:.1} levels");
        shown.push(glove);
    }
    assert!(shown[1] >= shown[0] + VIEW_MODEL_LIFT_MIN, "the glove: {:.1} -> {:.1} levels (at least +{VIEW_MODEL_LIFT_MIN})", shown[0], shown[1]);
}

// --- 3. The yard's shadows under a cloudy sky; an overcast sky ---

/// The yard: snowy ground, a wall casting its shadow towards the camera, body-cam's cloud cover.
fn yard_camera() -> CameraDesc {
    CameraDesc::look_at([7.0, 1.7, 6.0], [3.0, 0.3, -1.0])
}

fn yard_frame() -> ImmediateFrame {
    let mut frame = sunlit(yard_camera(), 0);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [80.0, 0.1, 80.0]), Material::color([225, 230, 236, 255]).with_pbr(0.0, 0.8));
    // The sun is behind the wall (towards -x, +z): its shadow falls on the camera's side.
    frame.mesh(MeshId::CUBE, scaled([2.0, 1.5, -2.0], [0.4, 3.0, 8.0]), Material::color([200, 190, 175, 255]).with_pbr(0.0, 0.9));
    frame
}

/// The settled HDR scene of `frame` at a fixed exposure of 1 under `sky`.
fn hdr_of(gpu: &Gpu, sky: SkyParams, frame: &ImmediateFrame) -> Vec<[f32; 4]> {
    let mut look = bodycam_look();
    look.exposure = ExposureMode::Manual;
    look.ev_compensation = 0.0;
    let mut frames = live(gpu, look, sky);
    frames.renderer_mut().set_environment_settle(true);
    for _ in 0..30 {
        frames.render(gpu, frame, CullPath::Gpu, None).expect("frame");
    }
    frames.renderer_mut().set_environment_settle(false);
    frames.renderer().read_scene(gpu).expect("the HDR scene reads back")
}

fn hdr_luminance(texels: &[[f32; 4]], camera: &CameraDesc, point: [f32; 3]) -> f32 {
    let (width, height) = SIZE;
    let clip = camera.view_proj(width as f32 / height as f32) * glam::Vec3::from(point).extend(1.0);
    let ndc = clip.truncate() / clip.w;
    let (x, y) = (((ndc.x + 1.0) * 0.5 * width as f32) as u32, ((1.0 - ndc.y) * 0.5 * height as f32) as u32);
    let mut sum = 0.0;
    for dy in 0..5u32 {
        for dx in 0..5u32 {
            let [r, g, b, _] = texels[((y + dy - 2) * width + x + dx - 2) as usize];
            sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
    }
    sum / 25.0
}

/// The least the shaded ground holds of the sunlit ground under body-cam's cloud cover (0.55):
/// about 2.6 EV under it, as a broken deck's sky fills shade, not the 4-5 EV of a full sun.
const SHADE_SHARE_MIN: f32 = 1.0 / 6.0;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_a_cloudy_yard_s_shadows_are_lit_by_the_sky() {
    let Some(gpu) = gpu() else { return };
    let frame = yard_frame();
    let camera = yard_camera();
    // The wall stands at x 2 (z -6..2); the sun, low towards -x and +z, throws its shadow towards
    // +x and -z, where the camera looks from.
    let (shade, sun) = ([3.4, 0.0, -2.0], [5.5, 0.0, 2.5]);
    let mut rows = Vec::new();
    for (name, sky) in [("clear", SkyParams::default()), ("cloudy", SkyParams::default().with_clouds(Some(Clouds::default().with_coverage(0.55))))] {
        let texels = hdr_of(&gpu, sky, &frame);
        let (in_shade, in_sun) = (hdr_luminance(&texels, &camera, shade), hdr_luminance(&texels, &camera, sun));
        eprintln!("{name}: shade {in_shade:.4}, sun {in_sun:.4}, share {:.3}", in_shade / in_sun.max(1e-6));
        rows.push(in_shade / in_sun.max(1e-6));
    }
    assert!(rows[1] >= SHADE_SHARE_MIN, "under a cloudy sky the shade holds {:.3} of the sunlit ground (at least {SHADE_SHARE_MIN:.3})", rows[1]);
    assert!(rows[1] > rows[0], "clouds fill the shade more than a clear sky: {:.3} against {:.3}", rows[1], rows[0]);
}

/// The most an overcast sky's colour may stray from grey: its chroma (spread over the largest
/// channel) above the horizon; the default clear sky's is well over half.
const OVERCAST_CHROMA_MAX: f32 = 0.2;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_an_overcast_sky_reads_grey_not_blue() {
    let Some(gpu) = gpu() else { return };
    let mut chromas = Vec::new();
    let broken = SkyParams::default().with_clouds(Some(Clouds::default()));
    for (name, sky) in [("clear", SkyParams::default()), ("overcast", SkyParams::overcast()), ("broken", broken)] {
        let mut frames = live(&gpu, bodycam_look(), sky);
        frames.renderer_mut().set_environment_settle(true);
        eprintln!("{name}: the quality's clouds {:?}", frames.renderer().quality().environment.clouds);
        let frame = sunlit(CameraDesc::look_at([0.0, 1.7, 0.0], [0.0, 6.0, -10.0]), 0);
        for _ in 0..30 {
            frames.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
        }
        let capture = frames.capture(&gpu).expect("capture");
        write_evidence(&format!("sky-{name}"), &capture);
        let (width, height) = (capture.width(), capture.height());
        let mut rgb = [0.0f32; 3];
        for y in 0..height / 3 {
            for x in 0..width {
                let at = ((y * width + x) * 4) as usize;
                for (lane, channel) in [2, 1, 0].into_iter().enumerate() {
                    rgb[lane] += f32::from(capture.bgra()[at + channel]);
                }
            }
        }
        let max = rgb.iter().copied().fold(0.0, f32::max);
        let min = rgb.iter().copied().fold(f32::MAX, f32::min);
        let chroma = (max - min) / max.max(1.0);
        eprintln!("{name}: sky chroma {chroma:.3}");
        chromas.push(chroma);
    }
    assert!(chromas[1] <= OVERCAST_CHROMA_MAX, "an overcast sky's chroma {:.3} (at most {OVERCAST_CHROMA_MAX})", chromas[1]);
    assert!(chromas[0] > chromas[1], "the clear sky is bluer than the overcast one");
    assert!(chromas[2] > chromas[1], "a broken layer's sky is bluer than the overcast one");
}

// --- 4. Snow: soft round flakes, never cubes ---

/// Flakes over the dark ground the snow preset draws in front of the camera: at least this many
/// pixels a flake whitens.
const FLAKE_PIXELS_MIN: usize = 200;
/// The longest run of whitened pixels down one column may be at most this many times the longest
/// across one row: a flake is round (a near one a dozen pixels each way), never the streak TAA drew
/// down the frame where a small falling particle had been (the reactive coverage now sweeps back
/// over its last ticks of motion).
const FLAKE_RUN_RATIO_MAX: usize = 2;

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_snow_falls_as_soft_round_flakes() {
    let Some(gpu) = gpu() else { return };
    let mut frames = live(&gpu, bodycam_look(), SkyParams::overcast());
    let snow = frames.add_emitter(&gpu, EmitterDesc::snow([0.0, 8.0, -6.0], [6.0, 0.0, 6.0], 1)).expect("snow");
    let ground = || {
        let mut frame = sunlit(CameraDesc::look_at([0.0, 1.6, 4.0], [0.0, 1.0, -6.0]), 0);
        frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [80.0, 0.1, 80.0]), Material::color([40, 42, 46, 255]).with_pbr(0.0, 0.9));
        frame
    };
    let plain = {
        let mut frames = live(&gpu, bodycam_look(), SkyParams::overcast());
        for _ in 0..10 {
            frames.render(&gpu, &ground(), CullPath::Gpu, None).expect("frame");
        }
        frames.capture(&gpu).expect("capture")
    };
    for tick in 0..600u64 {
        let mut frame = ground();
        frame.set_tick(tick);
        frame.particles(snow, tick);
        frames.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    }
    let capture = frames.capture(&gpu).expect("capture");
    write_evidence("snow", &capture);
    let lit: Vec<bool> = capture.bgra().chunks(4).zip(plain.bgra().chunks(4)).map(|(a, b)| a[1] > b[1].saturating_add(20)).collect();
    let flakes = lit.iter().filter(|lit| **lit).count();
    let (width, height) = (capture.width() as usize, capture.height() as usize);
    let run = |count: usize, len: usize, lit_at: &dyn Fn(usize, usize) -> bool| {
        (0..count).map(|line| (0..len).fold((0usize, 0usize), |(run, best), i| if lit_at(line, i) { (run + 1, best.max(run + 1)) } else { (0, best) }).1).max().unwrap_or(0)
    };
    let down = run(width, height, &|x, y| lit[y * width + x]);
    let across = run(height, width, &|y, x| lit[y * width + x]);
    eprintln!("snow whitens {flakes} pixels; the longest run down a column {down} px, across a row {across} px");
    assert!(flakes >= FLAKE_PIXELS_MIN, "the snow draws {flakes} flake pixels (at least {FLAKE_PIXELS_MIN})");
    assert!(down <= across * FLAKE_RUN_RATIO_MAX, "a flake draws as a {down} px streak against {across} px across");
}


