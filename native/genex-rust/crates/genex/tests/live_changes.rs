//! Live settings changes never hold the frame thread for the new configuration's compiles (pass-1
//! gate: a native game in Studio was killed leaving the Medium preset, its loop past the host's
//! 5 s heartbeat while every pipeline of the new configuration compiled cold in the game box).
//!
//! The compile pool is held ([`genex_render::compile::hold`]) to stand in the box's cold shader
//! compiler: a frame that waited for a compile would wait until the hold is let go. A watchdog
//! lets it go after [`HOLD_RELEASE`], so a frame that waited takes at least that long and a frame
//! that did not returns at once.
//!
//! Metal rows (`--ignored metal`), one GPU row at a time.
#![allow(clippy::disallowed_types, reason = "test timing: the rows measure how long a draw held the thread")]
#![allow(clippy::disallowed_methods, reason = "host glue under test: a watchdog thread lets the held compile pool go")]

use std::time::{Duration, Instant};

use genex::View;
use genex::prelude::*;
use genex::present::Presenter;
use genex::render::{ClassOverride, PresetChoice, QualityPreset, RenderChange};
use genex::Runtime;

/// When the watchdog lets a held compile pool go.
const HOLD_RELEASE: Duration = Duration::from_secs(3);
/// The longest a draw that compiles nothing may take (a 160x90 frame is a few ms).
const NO_WAIT: Duration = Duration::from_millis(1500);
/// The time a game's pass install takes in the boot row (the warm-up compiles meanwhile).
const INSTALL_STAND_IN: Duration = Duration::from_secs(2);
/// How long a capture row waits between captures for a warmed renderer to land.
const WARM_LANDS: Duration = Duration::from_millis(1500);
/// How long the new configuration may take to arrive once the pool runs.
const ARRIVES_WITHIN: Duration = Duration::from_secs(60);

static GPU_ROWS: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn gpu_rows() -> std::sync::MutexGuard<'static, ()> {
    GPU_ROWS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn required() -> bool {
    std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|value| value == "1")
}

/// A studio-style presenter: settings changes are warmed off the frame thread.
fn presenter() -> Option<Presenter> {
    match Presenter::open([160, 90], &[]) {
        Ok(mut presenter) => {
            presenter.set_off_thread_changes(true);
            Some(presenter)
        }
        Err(error) if required() => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

#[derive(Default)]
struct Scene;

fn scene_game() -> Game<Scene> {
    let mut game = Game::new(Scene).world_size(160, 90).background(Color::rgb(30, 40, 60));
    game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
    game.on_draw(|_, frame, _| {
        frame.cube(Transform::from_xyz(0.0, 0.5, 0.0), Color::RED);
        frame.cube(Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(6.0, 0.2, 6.0)), Color::rgb(90, 160, 90));
    });
    game
}

fn person_preset(preset: QualityPreset) -> ClassOverride {
    ClassOverride { preset: Some(preset), ..ClassOverride::default() }
}

/// Whether the presenter's last frame resolved TAA, and its world pass's samples.
fn drawn_aa(presenter: &Presenter) -> (bool, u32) {
    let renderer = presenter.resilient.renderer().renderer();
    (renderer.last_scene().is_some_and(|scene| scene.taa), renderer.sample_count())
}

/// `work` with the compile pool held; the hold is let go after [`HOLD_RELEASE`] whatever `work`
/// does. Answers what `work` answered and how long it took.
fn held<T>(work: impl FnOnce() -> T) -> (T, Duration) {
    let hold = genex_render::compile::hold();
    let watchdog = std::thread::spawn(move || {
        std::thread::sleep(HOLD_RELEASE);
        drop(hold);
    });
    let from = Instant::now();
    let answer = work();
    let took = from.elapsed();
    watchdog.join().expect("the watchdog lets the pool go");
    (answer, took)
}

fn live(presenter: &mut Presenter, runtime: &mut Runtime<Scene>) {
    presenter.draw_view(runtime, View::Game).expect("a view").expect("a Live frame");
}

/// Live frames until `drawn` shows what the presenter's last frame drew, within [`ARRIVES_WITHIN`].
fn live_until(presenter: &mut Presenter, runtime: &mut Runtime<Scene>, drawn: (bool, u32)) {
    let from = Instant::now();
    while drawn_aa(presenter) != drawn {
        assert!(from.elapsed() < ARRIVES_WITHIN, "the new configuration arrives once the pool runs");
        live(presenter, runtime);
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_live_preset_change_keeps_drawing_the_old_preset_while_the_new_one_compiles_off_the_frame_thread() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = Runtime::new(scene_game()).expect("installs");
    for _ in 0..3 {
        live(&mut presenter, &mut runtime);
    }
    assert_eq!(drawn_aa(&presenter), (true, 1), "the boot preset (high) resolves TAA on one sample");
    runtime.render().borrow_mut().set_person(person_preset(QualityPreset::Medium));
    let (drawn, took) = held(|| {
        live(&mut presenter, &mut runtime);
        drawn_aa(&presenter)
    });
    assert!(took < NO_WAIT, "the frame after the change waited {took:?} for the new preset's compiles");
    assert_eq!(drawn, (true, 1), "and drew the preset already compiled");
    live_until(&mut presenter, &mut runtime, (false, 4));
    // And back: the renderer medium replaced is the spare, so high draws again at once.
    runtime.render().borrow_mut().set_person(person_preset(QualityPreset::High));
    let (drawn, took) = held(|| {
        live(&mut presenter, &mut runtime);
        drawn_aa(&presenter)
    });
    assert!(took < NO_WAIT, "going back waited {took:?}");
    assert!(drawn == (true, 1) || drawn == (false, 4), "a compiled preset was drawn: {drawn:?}");
    live_until(&mut presenter, &mut runtime, (true, 1));
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_pinned_capture_after_live_left_its_samples_compiles_nothing_and_live_comes_back_at_once() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = Runtime::new(scene_game()).expect("installs");
    for _ in 0..3 {
        live(&mut presenter, &mut runtime);
    }
    let capture = |presenter: &mut Presenter, runtime: &mut Runtime<Scene>| {
        presenter.set_capturing(true);
        presenter.draw_view(runtime, View::Game).expect("a view").expect("a capture");
        presenter.set_capturing(false);
        presenter.resilient.capture().expect("readback").digest()
    };
    let first = capture(&mut presenter, &mut runtime);
    runtime.render().borrow_mut().set_person(person_preset(QualityPreset::Medium));
    live(&mut presenter, &mut runtime);
    live_until(&mut presenter, &mut runtime, (false, 4));
    for _ in 0..3 {
        live(&mut presenter, &mut runtime);
    }
    let ((again, back), took) = held(|| {
        let again = capture(&mut presenter, &mut runtime);
        live(&mut presenter, &mut runtime);
        (again, drawn_aa(&presenter))
    });
    assert!(took < NO_WAIT, "the pinned capture and the Live frame after it waited {took:?} for compiles");
    assert_eq!(again, first, "the pinned profile's picture, whatever Live draws");
    assert_eq!(back, (false, 4), "Live is back on medium's MSAA");
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_boot_compiles_the_first_frame_while_the_game_installs_its_passes() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = Runtime::new(scene_game()).expect("installs");
    presenter.warm_boot(&mut runtime);
    // The game's passes install meanwhile on the frame thread (Lakeside's take seconds).
    std::thread::sleep(INSTALL_STAND_IN);
    let (drawn, took) = held(|| {
        live(&mut presenter, &mut runtime);
        drawn_aa(&presenter)
    });
    assert!(took < NO_WAIT, "the first frame waited {took:?} for compiles the install could have covered");
    assert_eq!(drawn, (true, 1), "the boot preset");
}

#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_boot_on_another_samples_than_the_pinned_profile_warms_the_capture_renderer_ahead_of_the_capture() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let mut runtime = Runtime::new(scene_game()).expect("installs");
    // A person's saved Medium: Live boots on MSAA, the pinned profile (high) draws one sample.
    runtime.boot_render(presenter.gpu().device_facts().clone(), None);
    runtime.render().borrow_mut().set_person(person_preset(QualityPreset::Medium));
    live(&mut presenter, &mut runtime);
    assert_eq!(drawn_aa(&presenter), (false, 4), "Live boots on medium's MSAA");
    let from = Instant::now();
    while !presenter.resilient.spare().is_some_and(|(_, spare)| spare.settled_captures() > 0) {
        assert!(from.elapsed() < ARRIVES_WITHIN, "the pinned profile's renderer is warmed as the spare");
        live(&mut presenter, &mut runtime);
        std::thread::sleep(Duration::from_millis(5));
    }
    let (back, took) = held(|| {
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a capture");
        presenter.set_capturing(false);
        live(&mut presenter, &mut runtime);
        drawn_aa(&presenter)
    });
    assert!(took < NO_WAIT, "the first capture waited {took:?} for the pinned profile's compiles");
    assert_eq!(back, (false, 4), "Live is back on medium's MSAA");
}

/// A v2 material the renderer shades (sun, environment, fog), with a glow on top: the
/// every-feature fixture's statue.
const GLOW_V2_WGSL: &str = "struct Params { color: vec4<f32>, glow: vec4<f32> }\n\
@group(2) @binding(0) var<uniform> params: Params;\n\
@fragment fn fs_material(in: GxMaterialInV2) -> @location(0) vec4<f32> {\n\
    let s = gx_surface_v2(in.world_position, normalize(in.normal), gx_srgb_to_linear(params.color.rgb), 0.2, 0.35);\n\
    return vec4<f32>(gx_shade_pbr(s) + gx_expose(params.glow.rgb * params.glow.w), 1.0);\n\
}\n";
/// The statue's colour and glow.
const GLOW_UNIFORMS: [f32; 8] = [0.3, 0.55, 0.9, 1.0, 0.2, 0.5, 1.0, 0.08];

/// The courtyard's game folder: its `genex.toml` declares the v2 material.
struct Courtyard {
    root: std::path::PathBuf,
}

impl Courtyard {
    fn new() -> Courtyard {
        let root = std::env::temp_dir().join(format!("genex-live-changes-courtyard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("shaders")).expect("game folder");
        let toml = "[game]\ntitle = \"Courtyard\"\n\n[[wgsl]]\npath = \"shaders/glow.wgsl\"\nkind = \"material\"\napi = 2\n";
        std::fs::write(root.join("genex.toml"), toml).expect("genex.toml");
        std::fs::write(root.join("shaders/glow.wgsl"), GLOW_V2_WGSL).expect("source");
        Courtyard { root }
    }
}

impl Drop for Courtyard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

#[derive(Default)]
struct Statue {
    glow: genex::CustomMaterial,
}

/// The every-feature fixture's courtyard, cut down to what its render-presets row needs: the
/// physical sky, a sun, fog lit by the sky, auto exposure and a v2 material.
fn courtyard_game(folder: &Courtyard) -> Game<Statue> {
    let mut game = Game::new(Statue::default()).world_size(160, 90);
    game.wgsl_root(&folder.root);
    let fog = genex::render::Fog::default().with_density(0.02).with_height(0.3, 0.0);
    game.render_settings(genex::render::RenderConfig::new().exposure(genex::render::Exposure::auto()).fog(fog));
    game.on_reset(|sim, _, _, gfx| sim.world.glow = gfx.material("shaders/glow.wgsl", &GLOW_UNIFORMS));
    game.camera(|_| Camera::look_at(vec3(7.0, 4.5, 9.0), vec3(0.0, 0.8, 0.0)));
    game.on_draw(|sim, frame, _| {
        frame.environment(genex::render::Environment::Sky(genex::render::SkyParams::default()));
        frame.sun(vec3(-0.6, 0.35, 0.4), Color::rgb(255, 255, 255), 2.5);
        frame.cube(Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(16.0, 1.0, 16.0)), Color::rgb(150, 145, 135));
        frame.custom(CustomMesh::Sphere, Transform::from_xyz(0.0, 1.2, 0.0).with_scale(vec3(1.2, 1.2, 1.2)), &sim.world.glow, Color::rgb(255, 255, 255));
    });
    game
}

/// The verb's preset change (`renderSettings {set: {preset}}`), which the pinned capture follows.
fn verb_preset(preset: QualityPreset) -> RenderChange {
    RenderChange { preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() }
}

/// A capture as the studio takes one of a paused game: the pinned profile drawn settled and read
/// back, then Live drawn again when the capture left another picture in the world target.
fn studio_capture<W: Default + 'static>(presenter: &mut Presenter, runtime: &mut Runtime<W>) -> u64 {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("a view").expect("a capture");
    presenter.set_capturing(false);
    let digest = presenter.resilient.capture().expect("readback").digest();
    if !presenter.last_draw_is_live() {
        presenter.draw_view(runtime, View::Game).expect("a view").expect("a Live frame");
    }
    digest
}

/// Pass-1 fix (gate round 1, extensibility): the every-feature fixture's render-presets row went
/// low, then medium, and two captures of one paused state at medium differed by one level on 2.4%
/// of the frame. The second was the first drawn by the renderer warmed off the frame thread for
/// medium and swapped in between them: the warm-up drew its frame without the frame's sky, and the
/// v2 material's fog on the next frame came from that frame. Which renderer draws a capture must
/// never show in it.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_captures_of_one_paused_state_are_equal_whichever_renderer_draws_them() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let folder = Courtyard::new();
    let mut runtime = Runtime::new(courtyard_game(&folder)).expect("installs");
    for _ in 0..3 {
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a Live frame");
    }
    for preset in [QualityPreset::Low, QualityPreset::Medium, QualityPreset::High] {
        runtime.render().borrow_mut().apply(&verb_preset(preset));
        let mut digests = Vec::new();
        for _ in 0..4 {
            digests.push(studio_capture(&mut presenter, &mut runtime));
            // Time for the change's renderer to warm and land between captures, as a studio's
            // verbs give it.
            std::thread::sleep(WARM_LANDS);
        }
        assert!(digests.iter().all(|digest| *digest == digests[0]), "{preset:?}: captures of one state differ: {digests:x?}");
    }
}

/// Pass-1 fix (gate round 1, extensibility): a renderer warmed off the frame thread drew its frame
/// without the frame's environment (the presenter hands the sky only to the renderer in use), so
/// it compiled none of the sky's, the environment bake's or the fog's pipelines, and the first
/// capture under the sky on it compiled them on the frame thread. The warm-up lights its frame as
/// the frame is lit.
#[test]
#[ignore = "needs the host GPU: run with --ignored metal"]
fn metal_a_renderer_warmed_for_a_capture_under_the_sky_lights_its_frame_with_the_sky() {
    let _gpu = gpu_rows();
    let Some(mut presenter) = presenter() else { return };
    let folder = Courtyard::new();
    let mut runtime = Runtime::new(courtyard_game(&folder)).expect("installs");
    // A person's saved Medium: Live boots on MSAA, the pinned profile (high) draws one sample.
    runtime.boot_render(presenter.gpu().device_facts().clone(), None);
    runtime.render().borrow_mut().set_person(person_preset(QualityPreset::Medium));
    presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a Live frame");
    let from = Instant::now();
    while !presenter.resilient.spare().is_some_and(|(_, spare)| spare.settled_captures() > 0) {
        assert!(from.elapsed() < ARRIVES_WITHIN, "the pinned profile's renderer is warmed as the spare");
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a Live frame");
        std::thread::sleep(Duration::from_millis(5));
    }
    let lit = presenter.resilient.spare().map(|(_, spare)| spare.renderer().environment().clone());
    assert!(matches!(lit, Some(genex::render::Environment::Sky(_))), "the spare was warmed under {lit:?}");
    let ((), took) = held(|| {
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game).expect("a view").expect("a capture");
        presenter.set_capturing(false);
    });
    assert!(took < NO_WAIT, "the first capture under the sky waited {took:?} for compiles the warm-up could have made");
}
