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
//! The rows are `#[ignore]`d and named `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p showcase --release \
//!     --offline --locked --test harbour_ssr -- --ignored metal --nocapture
//!
//! The pictures (`harbour-ssr-<shot>-{on,off}.png`) go to `GENEX_SHOWCASE_OUT`.

mod support;

use genex::{FIXED_STEP_MS, Runtime, View};
use genex_render::capture::Capture;
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
