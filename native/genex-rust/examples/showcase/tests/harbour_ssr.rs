//! Renderer pass 2 B.9's acceptance on Harbour Street: the wet asphalt reflects the neon. At night
//! (the sun down, the neon and the café's pendants lit), each shot that looks along the street is
//! drawn settled through the frame renderer at desktop `high` with screen-space reflections and
//! again with them off (`Quality::ssr`, everything else the same), and the two are compared:
//!
//! - the reflections must add light where the shot's pixels look at the wet ground (a ray through
//!   the pixel meets the street's ground plane), at least [`REFLECTED_PIXELS_MIN`] of them brighter
//!   by [`REFLECTED_LEVELS`];
//! - and almost nowhere else ([`OFF_GROUND_SHARE_MAX`] of the changed pixels): the walls are rough
//!   brick and plaster, which nothing traces.
//!
//! Until the frame records the reflections (`genex_render::ssr::LANDED` false) the row holds the
//! other side: turning `ssr` on changes no pixel.
//!
//! The cost row draws the `puddle` shot on two renderers, one tracing and one not, frame for frame
//! interleaved, each timed by its own frame timer (Live's), and charges the GPU difference (the surface pass, the Hi-Z, the trace, the resolve,
//! the pyramid and the forward pass's read) to `tests/fixtures/render-perf/budgets.json`'s `ssr-high`
//! at 1080p (the table's resolution) and 1440p `high`, and `ssr-ultra` at 4K `ultra` (D15: over
//! budget at 4K ultra is reported, not refused). Over a still camera's last [`FLICKER_FRAMES`] it
//! also compares each ground pixel's luma swing with and without the reflections: they may add no
//! more than [`FLICKER_LEVELS_MAX`] at the 99th percentile.
//!
//! The rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test harbour_ssr -- --ignored metal --nocapture
//!
//! The pictures (`harbour-ssr-<shot>-{on,off}.png`) go to `GENEX_SHOWCASE_OUT`.

mod support;

use genex::{FIXED_STEP_MS, Runtime, View};
use genex_render::capture::Capture;
use genex_render::immediate::ImmediateFrame;
use showcase_game::harbour::World;
use showcase_game::{harbour_assets, harbour_game};
use support::{SHOT_TICK, gpu, out_dir, write_png};

/// How much brighter (encoded luma, 0..255) a pixel the reflections light must be.
const REFLECTED_LEVELS: f64 = 6.0;
/// The fewest such pixels a shot along the wet street shows (of its 1280 x 720).
const REFLECTED_PIXELS_MIN: usize = 2_000;
/// The largest share of the changed pixels that may lie off the ground.
const OFF_GROUND_SHARE_MAX: f64 = 0.2;
/// The shots that look along the wet street.
const SHOTS: [&str; 2] = ["puddle", "neon-alley"];

/// Harbour Street at night (the N key), tick 600 of seed 1.
fn harbour_at_night() -> Runtime<World> {
    let mut runtime = Runtime::new(harbour_game()).expect("installs");
    runtime.seed(1);
    runtime.start();
    runtime.inject(genex::Input::key_tap(genex::Key::KeyN));
    runtime.step(f64::from(SHOT_TICK) * FIXED_STEP_MS);
    assert_eq!(runtime.probes()["view"]["time"], genex::json!("night"));
    runtime
}

/// Encoded luma (BT.709, 0..255) of each pixel of `capture`, row by row.
fn lumas(capture: &Capture) -> Vec<f64> {
    capture.bgra().chunks(4).map(|p| 0.2126 * f64::from(p[2]) + 0.7152 * f64::from(p[1]) + 0.0722 * f64::from(p[0])).collect()
}

/// Whether the ray from `eye` through pixel (x, y) of a `size` frame drawn with `view_proj` meets
/// the ground (y = 0) in front of the camera.
fn looks_at_ground(view_proj: genex::math::Mat4, eye: genex::math::Vec3, size: (u32, u32), x: u32, y: u32) -> bool {
    let at = view_proj.inverse() * genex::math::Vec4::new((x as f32 + 0.5) / size.0 as f32 * 2.0 - 1.0, 1.0 - (y as f32 + 0.5) / size.1 as f32 * 2.0, 0.5, 1.0);
    let dir = at.truncate() / at.w - eye;
    eye.y > 0.0 && dir.y < -1e-4
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_at_night_the_wet_asphalt_reflects_the_neon_and_nothing_else_changes() {
    use genex_platform_web::{MeshCache, to_scene};
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::settings::{Look, QualityPreset};
    use genex_render::ssr::SsrQuality;
    let Some(gpu) = gpu() else { return };
    let mut runtime = harbour_at_night();
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let on = preset_quality(QualityPreset::High, class);
    assert!(on.ssr.enabled, "desktop high traces screen-space reflections");
    let mut off = on;
    off.ssr = SsrQuality::OFF;
    let mut failures = Vec::new();
    for shot in SHOTS {
        let camera = runtime.camera(View::Named(shot)).expect("the shot's camera");
        let eye = showcase_game::harbour::SHOTS.iter().find(|s| s.name == shot).expect("a Harbour shot").eye;
        let frame = runtime.frame(View::Named(shot)).expect("the shot's frame");
        let mut captures = Vec::new();
        for (name, quality) in [("off", off), ("on", on)] {
            let capture = support::game_capture(&gpu, class, Some(&quality), &Look::default(), &|on_gpu| {
                let mut meshes = MeshCache::default();
                meshes.load(&frame, harbour_assets(), |mesh| on_gpu.renderer.add_mesh(on_gpu.gpu, mesh));
                on_gpu.renderer.set_environment(&frame.declared_environment().cloned().unwrap_or(genex_render::settings::Environment::Color));
                to_scene(&frame, &camera, &meshes)
            });
            write_png(&out_dir().join(format!("harbour-ssr-{shot}-{name}.png")), &capture);
            captures.push(capture);
        }
        let size = (captures[0].width(), captures[0].height());
        let view_proj = to_scene(&frame, &camera, &MeshCache::default()).camera.view_proj(size.0 as f32 / size.1 as f32);
        if !genex_render::ssr::LANDED {
            assert_eq!(captures[0].digest(), captures[1].digest(), "{shot}: SSR the frame does not record changes nothing");
            println!("{{\"row\":\"harbour-ssr\",\"shot\":\"{shot}\",\"landed\":false}}");
            continue;
        }
        let (without, with) = (lumas(&captures[0]), lumas(&captures[1]));
        let (mut reflected, mut changed, mut off_ground) = (0usize, 0usize, 0usize);
        for y in 0..size.1 {
            for x in 0..size.0 {
                let i = (y * size.0 + x) as usize;
                let delta = with[i] - without[i];
                if delta.abs() < REFLECTED_LEVELS {
                    continue;
                }
                changed += 1;
                let ground = looks_at_ground(view_proj, eye, size, x, y);
                reflected += usize::from(ground && delta > 0.0);
                off_ground += usize::from(!ground);
            }
        }
        let off_share = off_ground as f64 / changed.max(1) as f64;
        println!("{{\"row\":\"harbour-ssr\",\"shot\":\"{shot}\",\"reflected\":{reflected},\"changed\":{changed},\"offGroundShare\":{off_share:.4}}}");
        if reflected < REFLECTED_PIXELS_MIN {
            failures.push(format!("{shot}: {reflected} ground pixels brighter by {REFLECTED_LEVELS} levels with SSR (at least {REFLECTED_PIXELS_MIN})"));
        }
        if off_share > OFF_GROUND_SHARE_MAX {
            failures.push(format!("{shot}: {:.1}% of the changed pixels are off the ground", off_share * 100.0));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Frames each renderer draws before the measured ones (TAA's history, the pyramid, pipelines).
const COST_WARMUP: u32 = 24;
/// Measured frames per renderer, interleaved frame for frame.
const COST_FRAMES: u32 = 48;
/// The last frames of a still camera whose ground pixels the flicker row compares (one TAA jitter
/// cycle of eight).
const FLICKER_FRAMES: u32 = 8;
/// The most the reflections may add to a ground pixel's p99 luma swing over those frames (0..255).
const FLICKER_LEVELS_MAX: f64 = 3.0;

/// A frame renderer of `size` drawing Harbour's `shot` under `quality` as Live draws it (its
/// history kept frame to frame), and the frame it draws.
fn harbour_stage(gpu: &genex_render::Gpu, runtime: &mut Runtime<World>, shot: &str, size: [u32; 2], quality: &genex_render::settings::Quality) -> (genex_render::FrameRenderer, ImmediateFrame) {
    use genex_platform_web::{MeshCache, to_scene};
    use genex_render::device_class::DeviceClass;
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let options = genex_render::RenderOptions { msaa: false };
    let mut frames = genex_render::FrameRenderer::new(gpu, size[0], size[1], options).expect("frame renderer");
    let renderer = frames.renderer_mut();
    let camera = runtime.camera(View::Named(shot)).expect("the shot's camera");
    let frame = runtime.frame(View::Named(shot)).expect("the shot's frame");
    let mut meshes = MeshCache::default();
    meshes.load(&frame, harbour_assets(), |mesh| renderer.add_mesh(gpu, mesh));
    renderer.set_environment(&frame.declared_environment().cloned().unwrap_or(genex_render::settings::Environment::Color));
    let rg11b10 = renderer.device_features().contains(wgpu::Features::RG11B10UFLOAT_RENDERABLE);
    renderer.set_quality(quality);
    renderer.set_scene_format(genex_render::presets::scene_format(class, rg11b10));
    renderer.set_device_class(class);
    let scene = to_scene(&frame, &camera, &meshes);
    (frames, ImmediateFrame::from_scene(scene))
}

/// The median of `values`.
fn median(values: &mut [f64]) -> f64 {
    values.sort_by(f64::total_cmp);
    support::percentile(values, 0.5)
}

/// Each pixel's encoded luma swing (largest minus smallest) over `frames`, for the pixels `keep`
/// selects (by index), sorted.
fn swings(frames: &[Vec<f64>], keep: &dyn Fn(usize) -> bool) -> Vec<f64> {
    let pixels = frames[0].len();
    let mut out: Vec<f64> = (0..pixels)
        .filter(|i| keep(*i))
        .map(|i| {
            let (lo, hi) = frames.iter().fold((f64::MAX, f64::MIN), |(lo, hi), f| (lo.min(f[i]), hi.max(f[i])));
            hi - lo
        })
        .collect();
    out.sort_by(f64::total_cmp);
    out
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_reflections_cost_fits_their_budget_and_add_no_flicker_on_the_wet_street() {
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    use genex_render::ssr::{SSR_MS_MAX_HIGH, SSR_MS_MAX_ULTRA, SsrQuality};
    let Some(gpu) = support::admit(genex_render::Gpu::headless_with(wgpu::Features::TIMESTAMP_QUERY)) else { return };
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let mut runtime = harbour_at_night();
    let shot = "puddle";
    let eye = showcase_game::harbour::SHOTS.iter().find(|s| s.name == shot).expect("a Harbour shot").eye;
    let rows = [("ssr-high", QualityPreset::High, [1920, 1080], SSR_MS_MAX_HIGH), ("ssr-high", QualityPreset::High, [2560, 1440], SSR_MS_MAX_HIGH), ("ssr-ultra", QualityPreset::Ultra, [3840, 2160], SSR_MS_MAX_ULTRA)];
    let mut failures = Vec::new();
    for (budget, preset, size, budget_ms) in rows {
        let on = preset_quality(preset, class);
        assert!(on.ssr.enabled, "{preset:?} traces");
        let mut off = on;
        off.ssr = SsrQuality::OFF;
        let (mut traced, drawn) = harbour_stage(&gpu, &mut runtime, shot, size, &on);
        let (mut plain, _) = harbour_stage(&gpu, &mut runtime, shot, size, &off);
        let view_proj = drawn.scene().camera.view_proj(size[0] as f32 / size[1] as f32);
        let (mut with, mut without) = (Vec::new(), Vec::new());
        let (mut lit, mut unlit) = (Vec::new(), Vec::new());
        let total = COST_WARMUP + COST_FRAMES;
        for frame in 0..total {
            for (side, frames, times, lumas_kept) in [("on", &mut traced, &mut with, &mut lit), ("off", &mut plain, &mut without, &mut unlit)] {
                // The renderer's own frame timer (Live's): its times land two or three frames later.
                let landed = frames.renderer_mut().arm_frame_timer(&gpu.queue).expect("the device offers timestamps");
                frames.render(&gpu, &drawn, genex_render::CullPath::Gpu, None).expect("frame");
                frames.renderer_mut().finish_frame_timer();
                gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("the frame finished");
                if frame >= COST_WARMUP {
                    times.extend(landed.into_iter().map(f64::from));
                }
                if frame >= total - FLICKER_FRAMES && size == [1920, 1080] {
                    let capture = frames.capture(&gpu).expect("capture");
                    lumas_kept.push(lumas(&capture));
                    if frame + 1 == total {
                        write_png(&out_dir().join(format!("harbour-ssr-cost-{shot}-{side}.png")), &capture);
                    }
                }
            }
        }
        assert!(with.len() * 2 >= COST_FRAMES as usize && without.len() * 2 >= COST_FRAMES as usize, "{budget}: most measured frames landed a GPU time");
        assert!(with.iter().chain(&without).all(|ms| *ms > 0.0), "{budget}: every landed GPU time is a time");
        let (cost_on, cost_off) = (median(&mut with), median(&mut without));
        let cost = cost_on - cost_off;
        println!(
            "{{\"row\":\"ssr-cost\",\"budget\":\"{budget}\",\"preset\":\"{preset:?}\",\"size\":[{},{}],\"onMs\":{cost_on:.3},\"offMs\":{cost_off:.3},\"ssrMs\":{cost:.3},\"budgetMs\":{budget_ms}}}",
            size[0], size[1]
        );
        // D15: 4K ultra over its budget is acceptable (AAA first); it is reported above.
        if cost > f64::from(budget_ms) && preset != QualityPreset::Ultra {
            failures.push(format!("{budget} at {}x{}: {cost:.3} ms over {budget_ms} ms", size[0], size[1]));
        }
        if lit.is_empty() {
            continue;
        }
        let ground = |i: usize| looks_at_ground(view_proj, eye, (size[0], size[1]), i as u32 % size[0], i as u32 / size[0]);
        let (with_swing, without_swing) = (swings(&lit, &ground), swings(&unlit, &ground));
        let p99 = |sorted: &[f64]| support::percentile(sorted, 0.99);
        let (p99_on, p99_off) = (p99(&with_swing), p99(&without_swing));
        println!("{{\"row\":\"ssr-flicker\",\"shot\":\"{shot}\",\"groundPixels\":{},\"p99On\":{p99_on:.2},\"p99Off\":{p99_off:.2},\"p50On\":{:.2},\"p50Off\":{:.2}}}", with_swing.len(), support::percentile(&with_swing, 0.5), support::percentile(&without_swing, 0.5));
        if p99_on > p99_off + FLICKER_LEVELS_MAX {
            failures.push(format!("{shot}: the reflections swing the wet ground by {p99_on:.2} levels at p99 over {FLICKER_FRAMES} still frames, {p99_off:.2} without"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// The render scale a dynamic-resolution step lands on where TAA upscales (B.8).
const TAAU_SCALE: f32 = 0.67;
/// The least share of the scale-1 reflected pixels the scaled frame keeps: reflections must not
/// come and go with the scale steps.
const SCALED_REFLECTED_SHARE_MIN: f64 = 0.6;

/// Harbour's `shot` drawn settled at `size` under `quality` at render `scale`, and whether TAA
/// upscaled it.
fn harbour_settled(gpu: &genex_render::Gpu, runtime: &mut Runtime<World>, shot: &str, size: [u32; 2], quality: &genex_render::settings::Quality, scale: f32) -> (Capture, bool) {
    let (mut frames, drawn) = harbour_stage(gpu, runtime, shot, size, quality);
    frames.renderer_mut().set_render_scale(scale);
    let settle = frames.settle_frames();
    frames.render_settled(gpu, &drawn, genex_render::CullPath::Gpu, None, settle).expect("settled frame");
    let taau = frames.renderer().last_scene().is_some_and(|path| path.taau);
    (frames.capture(gpu).expect("capture"), taau)
}

/// The ground pixels of a `size` frame of `shot` that `with` lights by [`REFLECTED_LEVELS`] over
/// `without`.
fn reflected_pixels(runtime: &mut Runtime<World>, shot: &str, size: [u32; 2], without: &Capture, with: &Capture) -> usize {
    use genex_platform_web::{MeshCache, to_scene};
    let camera = runtime.camera(View::Named(shot)).expect("the shot's camera");
    let frame = runtime.frame(View::Named(shot)).expect("the shot's frame");
    let eye = showcase_game::harbour::SHOTS.iter().find(|s| s.name == shot).expect("a Harbour shot").eye;
    let view_proj = to_scene(&frame, &camera, &MeshCache::default()).camera.view_proj(size[0] as f32 / size[1] as f32);
    let (dark, lit) = (lumas(without), lumas(with));
    (0..dark.len()).filter(|i| lit[*i] - dark[*i] >= REFLECTED_LEVELS && looks_at_ground(view_proj, eye, (size[0], size[1]), *i as u32 % size[0], *i as u32 / size[0])).count()
}

#[test]
#[ignore = "real GPU: run with --ignored metal"]
fn metal_the_reflections_stay_when_taa_upscales_from_a_lower_render_scale() {
    use genex_render::device_class::DeviceClass;
    use genex_render::presets::preset_quality;
    use genex_render::settings::QualityPreset;
    use genex_render::ssr::SsrQuality;
    let Some(gpu) = gpu() else { return };
    if !genex_render::ssr::LANDED {
        return;
    }
    let class = DeviceClass::from_wire("desktop-high").expect("class");
    let mut runtime = harbour_at_night();
    let size = [1920, 1080];
    let mut failures = Vec::new();
    for preset in [QualityPreset::High, QualityPreset::Ultra] {
        let on = preset_quality(preset, class);
        let mut off = on;
        off.ssr = SsrQuality::OFF;
        for shot in SHOTS {
            let mut counts = Vec::new();
            for scale in [1.0, TAAU_SCALE] {
                let (without, _) = harbour_settled(&gpu, &mut runtime, shot, size, &off, scale);
                let (with, taau) = harbour_settled(&gpu, &mut runtime, shot, size, &on, scale);
                write_png(&out_dir().join(format!("harbour-ssr-{shot}-{}-s{scale:.2}.png", preset.wire())), &with);
                assert_eq!(taau, scale < 1.0, "{shot} {preset:?} at scale {scale}: TAA upscales exactly below scale 1");
                counts.push(reflected_pixels(&mut runtime, shot, size, &without, &with));
            }
            let (full, scaled) = (counts[0], counts[1]);
            println!("{{\"row\":\"ssr-scaled\",\"preset\":\"{}\",\"shot\":\"{shot}\",\"reflectedS1\":{full},\"reflectedS067\":{scaled}}}", preset.wire());
            if (scaled as f64) < full as f64 * SCALED_REFLECTED_SHARE_MIN || scaled < REFLECTED_PIXELS_MIN {
                failures.push(format!("{shot} {preset:?}: {scaled} reflected ground pixels at scale {TAAU_SCALE} against {full} at scale 1"));
            }
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
