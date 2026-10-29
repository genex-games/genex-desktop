//! AAA materials lane (review WP-13, 3.5): lit particles (the sun through its shadows and the sky),
//! size variance, gusts, flutter, camera-following fields, and the weather presets built on them
//! with their densities and the cover they lay. The CPU rows hold the rows and the presets' numbers;
//! the `metal` rows draw.
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --release --test weather --offline --locked -- --include-ignored

use genex_render::capture::Capture;
use genex_render::device_class::{DeviceClass, FormFactor, PerformanceTier};
use genex_render::immediate::ImmediateFrame;
use genex_render::layers::Cover;
use genex_render::limits::PARTICLES_PER_EMITTER_MAX;
use genex_render::particles::{EmitterDesc, GUST_PERIOD_MIN_TICKS, SIZE_VARIANCE_MAX, flags};
use genex_render::scene::{CameraDesc, Material, MeshId, scaled};
use genex_render::settings::{QualityPreset, SceneFormat};
use genex_render::weather::WeatherKind;
use genex_render::{CullPath, FrameRenderer, Gpu, Quality, RenderOptions};

/// Ticks a second: velocities are world units a tick.
const TICKS_PER_SECOND: f32 = 60.0;

// ---------------------------------------------------------------------------------------------
// CPU rows

#[test]
fn an_emitter_without_weather_keeps_its_rows_and_flags() {
    let fountain = EmitterDesc::fountain([0.0; 3], 7).to_gpu(30);
    assert_eq!(fountain.weather, [0.0; 4]);
    assert_eq!(fountain.flutter, [0.0; 4]);
    assert_eq!(fountain.flags[0], 0, "no lit or follow-camera bit");
    let snow = EmitterDesc::snow([0.0, 10.0, 0.0], [12.0, 0.0, 12.0], 1).to_gpu(30);
    assert_eq!((snow.weather, snow.flutter), ([0.0; 4], [0.0; 4]), "the plain snow preset draws as before");
}

#[test]
fn weather_fields_reach_the_emitter_rows_held_in_range() {
    let desc = EmitterDesc {
        size_variance: 0.4,
        lit: 0.8,
        gust: [0.02, 0.0, 0.01],
        gust_period: 300.0,
        flutter: [0.1, 120.0],
        follow_camera: true,
        ..EmitterDesc::fountain([0.0; 3], 1)
    };
    let row = desc.to_gpu(10);
    assert_eq!(row.weather, [0.02, 0.0, 0.01, 300.0]);
    assert_eq!(row.flutter, [0.1, 120.0, 0.4, 0.8]);
    assert_eq!(row.flags[0] & (flags::LIT | flags::FOLLOW_CAMERA), flags::LIT | flags::FOLLOW_CAMERA);
    let hostile = EmitterDesc {
        size_variance: 7.0,
        lit: f32::NAN,
        gust: [f32::INFINITY, 0.01, 0.0],
        gust_period: 0.0,
        flutter: [-1.0, f32::NAN],
        ..desc
    };
    let row = hostile.to_gpu(10);
    assert_eq!(row.flutter, [0.0, 0.0, SIZE_VARIANCE_MAX, 0.0]);
    assert_eq!(row.flags[0] & flags::LIT, 0, "a lit share that is not a number is unlit");
    assert_eq!(row.weather, [0.0, 0.01, 0.0, GUST_PERIOD_MIN_TICKS], "an infinite gust is dropped and the period held");
}

#[test]
fn every_weather_preset_is_two_lit_camera_following_layers_within_an_emitter_s_cap() {
    for kind in WeatherKind::ALL {
        let layers = kind.layers(1);
        for (at, layer) in layers.iter().enumerate() {
            assert!(layer.check().is_ok(), "{kind:?} layer {at}");
            assert!(layer.slots() <= PARTICLES_PER_EMITTER_MAX, "{kind:?} layer {at}: {}", layer.slots());
            assert!(layer.follow_camera && layer.lit > 0.0, "{kind:?} layer {at} follows the camera, lit");
            assert!(layer.gust != [0.0; 3] && layer.gust_period >= GUST_PERIOD_MIN_TICKS, "{kind:?} layer {at} gusts");
        }
        let [near, far] = layers;
        assert!(far.extent[0] >= 3.0 * near.extent[0], "{kind:?}: the far box reaches far past the near one");
        let [near_density, far_density] = kind.densities();
        println!("{kind:?}: near {near_density:.2}/m³ ({} alive), far {far_density:.3}/m³ ({} alive)", near.slots(), far.slots());
        assert!(near_density > 10.0 * far_density, "{kind:?}: the near layer is the dense one");
    }
}

#[test]
fn weather_densities_and_speeds_are_plausible() {
    let fall = |kind: WeatherKind| -kind.layers(1)[0].velocity[1] * TICKS_PER_SECOND;
    let near = |kind: WeatherKind| kind.densities()[0];
    // Snow: light under heavy under a blizzard, falling about 1 m/s (0.5..2).
    assert!(near(WeatherKind::LightSnow) < near(WeatherKind::HeavySnow) && near(WeatherKind::HeavySnow) < near(WeatherKind::Blizzard));
    for kind in [WeatherKind::LightSnow, WeatherKind::HeavySnow, WeatherKind::Blizzard] {
        assert!((0.5..=2.0).contains(&fall(kind)), "{kind:?} falls {}", fall(kind));
        assert!(kind.layers(1)[0].size_variance >= 0.4, "{kind:?} flakes vary in size");
    }
    // Rain falls near its terminal 9 m/s, drizzle slower; both streak.
    assert!((7.0..=10.0).contains(&fall(WeatherKind::Rain)));
    assert!((2.0..=5.0).contains(&fall(WeatherKind::Drizzle)));
    assert!(WeatherKind::Rain.layers(1)[0].stretch > 0.0 && WeatherKind::Drizzle.layers(1)[0].stretch > 0.0);
    // A blizzard's wind drives the snow sideways faster than it falls.
    let blizzard = WeatherKind::Blizzard.layers(1)[0];
    let [vx, _, vz] = blizzard.velocity;
    let wind = (vx * vx + vz * vz).sqrt() * TICKS_PER_SECOND;
    assert!(wind > 3.0 * fall(WeatherKind::Blizzard), "blizzard wind {wind} m/s");
    // Gen3 had about 0.1 flakes per m³: every snow preset's near layer is two orders above it.
    assert!(near(WeatherKind::LightSnow) >= 8.0);
}

#[test]
fn weather_lays_its_cover_as_it_falls() {
    assert_eq!(WeatherKind::HeavySnow.cover_after(0.0), None);
    assert_eq!(WeatherKind::HeavySnow.cover_after(f32::NAN), None);
    let half = WeatherKind::HeavySnow.cover_after(WeatherKind::HeavySnow.seconds_to_cover() * 0.5).expect("snow");
    assert_eq!(Cover { amount: 0.5, ..Cover::SNOW }, half);
    assert_eq!(WeatherKind::HeavySnow.cover_after(1e6).map(|c| c.amount), Some(1.0));
    assert_eq!(WeatherKind::Rain.cover_after(30.0).map(|c| c.opacity), Some(0.0), "rain wets, keeping the colour");
    assert_eq!(WeatherKind::Dust.cover_after(30.0).map(|c| c.color), Some(Cover::DUST.color));
    assert!(WeatherKind::Blizzard.seconds_to_cover() < WeatherKind::HeavySnow.seconds_to_cover());
    assert!(WeatherKind::HeavySnow.seconds_to_cover() < WeatherKind::LightSnow.seconds_to_cover());
}

// ---------------------------------------------------------------------------------------------
// GPU rows

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

fn renderer(gpu: &Gpu, size: (u32, u32), shadows: bool) -> FrameRenderer {
    let mut renderer = FrameRenderer::new(gpu, size.0, size.1, RenderOptions::default()).expect("renderer");
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    if shadows {
        quality.shadows = genex_render::presets::preset_quality(QualityPreset::Medium, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)).shadows;
    }
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
    renderer
}

fn draw(gpu: &Gpu, renderer: &mut FrameRenderer, frame: &ImmediateFrame) -> Capture {
    renderer.render(gpu, frame, CullPath::Gpu, None).expect("frame");
    renderer.capture(gpu).expect("capture")
}

fn ground(camera: CameraDesc) -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(camera, [12, 14, 20, 255]);
    frame.mesh(MeshId::CUBE, scaled([0.0, -0.05, 0.0], [80.0, 0.1, 80.0]), Material::color([60, 62, 66, 255]));
    frame
}

fn pixel_of(camera: &CameraDesc, size: (u32, u32), world: [f32; 3]) -> (i32, i32) {
    let clip = camera.view_proj(size.0 as f32 / size.1 as f32) * glam::Vec4::new(world[0], world[1], world[2], 1.0);
    let (x, y) = (clip.x / clip.w, clip.y / clip.w);
    (((x * 0.5 + 0.5) * size.0 as f32) as i32, ((0.5 - y * 0.5) * size.1 as f32) as i32)
}

fn luma(capture: &Capture, (x, y): (i32, i32)) -> f32 {
    let at = (y as usize * capture.width() as usize + x as usize) * 4;
    let p = &capture.bgra()[at..at + 4];
    0.0722 * f32::from(p[0]) + 0.7152 * f32::from(p[1]) + 0.2126 * f32::from(p[2])
}

fn write_evidence(name: &str, capture: &Capture) {
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let _ = std::fs::create_dir_all(&dir);
        let file = std::path::Path::new(&dir).join(format!("weather-{name}-{}x{}.bgra", capture.width(), capture.height()));
        std::fs::write(file, capture.bgra()).expect("evidence");
    }
}

/// One still white flake `size` across at `at`, lit by `lit`.
fn flake(at: [f32; 3], size: f32, lit: f32) -> EmitterDesc {
    EmitterDesc {
        velocity: [0.0; 3],
        speed_jitter: 0.0,
        spread: 0.0,
        gravity: [0.0; 3],
        size,
        size_end: 1.0,
        color_start: [255; 4],
        color_end: [255; 4],
        rate_per_tick: 1,
        lifetime_ticks: 1,
        lit,
        ..EmitterDesc::fountain(at, 1)
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_lit_flake_in_a_wall_s_shadow_is_darker_than_one_in_the_sun() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let camera = CameraDesc::look_at([0.0, 1.5, 7.0], [0.0, 1.0, 0.0]);
    let mut renderer = renderer(&gpu, size, true);
    // The sun high in the west-south; a tall wall casting its shadow over the left flake.
    let shade_at = [-1.5, 1.0, 0.0];
    let sun_at = [1.8, 1.0, 0.0];
    let frame_with = |lit: f32, renderer: &mut FrameRenderer| {
        let left = renderer.add_emitter(&gpu, flake(shade_at, 0.5, lit)).expect("left");
        let right = renderer.add_emitter(&gpu, flake(sun_at, 0.5, lit)).expect("right");
        let mut frame = ground(camera);
        frame.lighting_mut().sun_dir = [0.2, 0.7, -0.7];
        frame.lighting_mut().shadows = true;
        frame.mesh(MeshId::CUBE, scaled([-1.5, 2.0, -1.5], [1.6, 4.0, 0.3]), Material::color([80, 80, 80, 255]));
        frame.particles(left, 0).particles(right, 0);
        draw(&gpu, renderer, &frame)
    };
    let lit = frame_with(1.0, &mut renderer);
    let unlit = frame_with(0.0, &mut renderer);
    write_evidence("lit-shadow", &lit);
    let (shade, sun) = (luma(&lit, pixel_of(&camera, size, shade_at)), luma(&lit, pixel_of(&camera, size, sun_at)));
    let (flat_shade, flat_sun) = (luma(&unlit, pixel_of(&camera, size, shade_at)), luma(&unlit, pixel_of(&camera, size, sun_at)));
    println!("lit flakes: shade {shade:.1}, sun {sun:.1}; unlit: {flat_shade:.1}, {flat_sun:.1}");
    assert!(sun > shade + 30.0, "the wall's shadow darkens the lit flake behind it");
    assert!((flat_shade - flat_sun).abs() < 3.0, "unlit flakes keep their colour wherever they are");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_lit_flake_against_an_overcast_sky_is_not_a_dark_speck() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let camera = CameraDesc::look_at([0.0, 1.5, 6.0], [0.0, 3.0, 0.0]);
    let mut renderer = renderer(&gpu, size, false);
    let sky = genex_render::settings::Environment::Sky(genex_render::settings::SkyParams::overcast());
    let mut quality = Quality::off();
    quality.hdr = true;
    quality.tonemap = true;
    quality.prepass = true;
    // The high preset's sky, drawn behind the flake too, so the row compares it with what it is seen
    // against.
    quality.environment = genex_render::presets::preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High)).environment;
    quality.environment.sky = true;
    renderer.renderer_mut().set_quality(&quality);
    renderer.renderer_mut().set_environment(&sky);
    let at = [0.0, 2.6, 2.0];
    let snowflake = renderer.add_emitter(&gpu, flake(at, 0.3, 1.0)).expect("flake");
    let mut frame = ground(camera);
    frame.lighting_mut().sun_dir = [0.2, 0.8, -0.4];
    frame.particles(snowflake, 0);
    for _ in 0..8 {
        renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
    }
    let shot = draw(&gpu, &mut renderer, &frame);
    write_evidence("flake-overcast", &shot);
    let (x, y) = pixel_of(&camera, size, at);
    let (flake_luma, sky_luma) = (luma(&shot, (x, y)), luma(&shot, (x + 24, y)));
    println!("a lit white flake against the overcast sky: flake {flake_luma:.1}, sky beside it {sky_luma:.1}");
    assert!(sky_luma > 60.0, "the overcast sky is drawn behind the flake ({sky_luma:.1})");
    assert!(flake_luma >= 0.85 * sky_luma, "a lit flake glows with the sky behind it, never a dark speck against it");
}

/// The share of `capture`'s pixels brighter than the ground by more than 12 levels.
fn bright_share(capture: &Capture, plain: &Capture) -> f32 {
    let w = capture.width() as i32;
    let h = capture.height() as i32;
    let mut bright = 0;
    for y in 0..h {
        for x in 0..w {
            if luma(capture, (x, y)) > luma(plain, (x, y)) + 12.0 {
                bright += 1;
            }
        }
    }
    bright as f32 / (w * h) as f32
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_camera_following_snow_field_holds_its_density_wherever_the_camera_goes() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let mut renderer = renderer(&gpu, size, false);
    let [near, _] = WeatherKind::HeavySnow.layers(3);
    let field = renderer.add_emitter(&gpu, near).expect("field");
    let share_at = |x: f32, renderer: &mut FrameRenderer| {
        let camera = CameraDesc::look_at([x, 1.7, 0.0], [x, 1.2, -6.0]);
        let plain = draw(&gpu, renderer, &ground(camera));
        let mut frame = ground(camera);
        frame.particles(field, 900);
        let snowing = draw(&gpu, renderer, &frame);
        write_evidence(&format!("field-x{x}"), &snowing);
        bright_share(&snowing, &plain)
    };
    let (here, there) = (share_at(0.0, &mut renderer), share_at(250.0, &mut renderer));
    println!("snowed share of the view: at x=0 {here:.3}, at x=250 {there:.3}");
    assert!(here > 0.01, "the near layer draws flakes around the camera");
    assert!((there - here).abs() < 0.35 * here, "the same density 250 m away ({there:.3} vs {here:.3})");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_gusts_carry_the_flakes_downwind() {
    let Some(gpu) = gpu() else { return };
    let size = (256, 144);
    let camera = CameraDesc::look_at([0.0, 1.5, 9.0], [0.0, 1.5, 0.0]);
    let mut renderer = renderer(&gpu, size, false);
    let calm = EmitterDesc { extent: [1.0, 0.5, 0.5], ..flake([-2.0, 3.0, 0.0], 0.08, 0.0) };
    let calm = EmitterDesc { velocity: [0.0, -0.01, 0.0], rate_per_tick: 4, lifetime_ticks: 240, ..calm };
    let gusty = EmitterDesc { gust: [0.03, 0.0, 0.0], gust_period: 240.0, ..calm };
    let centroid = |desc: EmitterDesc, renderer: &mut FrameRenderer| {
        let id = renderer.add_emitter(&gpu, desc).expect("emitter");
        let plain = draw(&gpu, renderer, &ground(camera));
        let mut frame = ground(camera);
        frame.particles(id, 600);
        let shot = draw(&gpu, renderer, &frame);
        let (mut sum, mut count) = (0.0, 0.0);
        for y in 0..size.1 as i32 {
            for x in 0..size.0 as i32 {
                if luma(&shot, (x, y)) > luma(&plain, (x, y)) + 12.0 {
                    sum += x as f32;
                    count += 1.0;
                }
            }
        }
        assert!(count > 0.0, "flakes draw");
        sum / count
    };
    let (still, blown) = (centroid(calm, &mut renderer), centroid(gusty, &mut renderer));
    println!("flake centroid x: calm {still:.1}, gusting {blown:.1}");
    assert!(blown > still + 10.0, "gusts carry the flakes along +x");
}

/// The most a heavy snowfall (both layers: 27 840 lit, gusting, colliding flakes) may add to a
/// desktop `high` frame at 2560x1440 over the bare frame.
const HEAVY_SNOW_MS_MAX: f32 = 0.6;

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_heavy_snow_costs_at_most_0_6_ms_at_1440p_high() {
    let Some(gpu) = gpu() else { return };
    if !gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY) {
        eprintln!("skipped: no timestamp queries");
        return;
    }
    let size = (2560, 1440);
    let camera = CameraDesc::look_at([0.0, 1.7, 7.0], [0.0, 1.2, 0.0]);
    let quality = genex_render::presets::preset_quality(QualityPreset::High, DeviceClass::new(FormFactor::Desktop, PerformanceTier::High));
    let make = || {
        let mut renderer = FrameRenderer::new(&gpu, size.0, size.1, RenderOptions::default()).expect("renderer");
        renderer.renderer_mut().set_quality(&quality);
        renderer.renderer_mut().set_scene_format(SceneFormat::Rgba16Float);
        renderer
    };
    let (mut bare, mut busy) = (make(), make());
    let layers = WeatherKind::HeavySnow.layers(1);
    let ids: Vec<_> = layers.iter().map(|desc| busy.add_emitter(&gpu, *desc).expect("emitter")).collect();
    let median = |values: &mut Vec<f32>| {
        values.sort_by(f32::total_cmp);
        values[values.len() / 2]
    };
    let mut deltas = Vec::new();
    for round in 0..7 {
        let mut times = [Vec::new(), Vec::new()];
        for tick in 0..48u64 {
            for (k, renderer) in [&mut bare, &mut busy].into_iter().enumerate() {
                let mut frame = ground(camera);
                frame.lighting_mut().shadows = true;
                if k == 1 {
                    for id in &ids {
                        frame.particles(*id, 900 + tick);
                    }
                }
                let Some(landed) = renderer.renderer_mut().arm_frame_timer(&gpu.queue) else {
                    eprintln!("skipped: no frame timer");
                    return;
                };
                times[k].extend(landed);
                renderer.render(&gpu, &frame, CullPath::Gpu, None).expect("frame");
                renderer.renderer_mut().finish_frame_timer();
                let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
            }
        }
        let [mut a, mut b] = times.map(|mut landed| {
            landed.drain(..8.min(landed.len()));
            landed
        });
        if round > 0 && !a.is_empty() && !b.is_empty() {
            deltas.push(median(&mut b) - median(&mut a));
        }
    }
    let slots: u32 = layers.iter().map(EmitterDesc::slots).sum();
    let cost = median(&mut deltas);
    let row = format!("heavy snow ({slots} flakes, 2 lit camera-following layers) at 2560x1440 high: {cost:.3} ms over the bare frame (budget {HEAVY_SNOW_MS_MAX}; rounds {deltas:?})");
    eprintln!("{row}");
    assert!(cost <= HEAVY_SNOW_MS_MAX, "{row}");
}
