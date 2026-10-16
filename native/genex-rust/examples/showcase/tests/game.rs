//! The lakeside's rules headless (no GPU): it replays from a seed, its shots are named cameras,
//! only the passes no built-in draws are registered, all at custom-pass API v2, the ground is the
//! built-in terrain with its grassy layers' grass, its look (fog included) is its own, and
//! the camera keys switch between the tour, a shot and free flight.

use genex::gpu::PassStage;
use genex::{FIXED_STEP_MS, Input, Key, Runtime, View, json};
use showcase_game::world::{SHOTS, World};
use showcase_game::{assets, game};

fn runtime() -> Runtime<World> {
    let _ = assets();
    Runtime::new(game()).expect("the showcase's registrations are valid")
}

fn run(runtime: &mut Runtime<World>, ticks: u32) {
    runtime.seed(1);
    runtime.start();
    runtime.step(f64::from(ticks) * FIXED_STEP_MS);
}

#[test]
fn ten_seconds_replay_to_the_same_checksum_and_probes() {
    let (mut a, mut b) = (runtime(), runtime());
    for r in [&mut a, &mut b] {
        run(r, 300);
        r.inject(Input::key_tap(Key::KeyF));
        r.step(300.0 * FIXED_STEP_MS);
    }
    assert_eq!(a.checksum(), b.checksum());
    assert_eq!(a.probes(), b.probes());
    assert_eq!(a.probes()["view"]["mode"], json!("free"));
}

#[test]
fn every_shot_is_a_named_camera_and_draws_the_scene() {
    let mut runtime = runtime();
    run(&mut runtime, 60);
    assert_eq!(runtime.cameras(), SHOTS.iter().map(|shot| shot.name.to_owned()).collect::<Vec<_>>());
    for shot in SHOTS {
        let camera = runtime.camera(View::Named(shot.name)).expect("the shot");
        assert_eq!(camera.position, shot.eye());
        let frame = runtime.frame(View::Named(shot.name)).expect("its frame");
        assert!(frame.draw_calls() > 500, "{}: {} draws", shot.name, frame.draw_calls());
    }
}

#[test]
fn only_the_passes_built_ins_cannot_draw_are_registered_and_all_at_api_2() {
    let mut runtime = runtime();
    let stages: Vec<(String, PassStage)> = runtime.gpu_passes();
    // The sky (RQ2.5), the height fog, the bloom and the golden-hour light are the renderer's own
    // (`frame.environment` and the look), not passes: what stays is what no built-in draws (the
    // physical sky has no clouds).
    let expected = [
        ("clouds", PassStage::AfterOpaque),
        ("lake", PassStage::AfterTransparent),
        ("lights", PassStage::AfterTransparent),
    ];
    assert_eq!(stages, expected.map(|(name, stage)| (name.to_owned(), stage)).to_vec());
    let apis = genex::gpu::host::with_passes(&mut runtime, |passes, _| passes.iter().map(|pass| pass.api()).collect::<Vec<u32>>());
    assert_eq!(apis, vec![2; expected.len()], "every pass draws in the scene format, so none keeps the frame on the LDR scene");
}

#[test]
fn the_height_fog_is_the_looks_own() {
    let runtime = runtime();
    let fog = runtime.render().borrow().look().fog;
    assert!(fog.is_on(), "the look fogs the lakeside: {fog:?}");
    assert_eq!(fog, showcase_game::showcase::look_fog());
}

#[test]
fn the_look_is_agx_punchy_with_auto_exposure_and_nothing_keeps_the_frame_ldr() {
    use genex::render::{DegradeReason, ExposureMode, Tonemap};
    let runtime = runtime();
    let render = runtime.render();
    let look = render.borrow().look();
    assert_eq!((look.tonemapper, look.exposure), (Tonemap::AgxPunchy, ExposureMode::Auto));
    assert_eq!(look.ev_compensation, showcase_game::showcase::LOOK_EV_COMPENSATION);
    assert_eq!(render.borrow().capture_frame().0.look, look, "captures draw the showcase's look on every preset");
    let degraded = render.borrow().status().degraded;
    let ldr = [DegradeReason::CustomPassV1InWorld, DegradeReason::MaterialV1InHdr];
    assert!(degraded.iter().all(|degrade| !ldr.contains(&degrade.reason)), "{degraded:?}");
}

#[test]
fn the_digit_keys_hold_a_shot_and_space_returns_to_the_tour() {
    let mut runtime = runtime();
    run(&mut runtime, 10);
    runtime.inject(Input::key_tap(Key::Digit3));
    runtime.step(2.0 * FIXED_STEP_MS);
    assert_eq!(runtime.probes()["view"]["mode"], json!("cabin"));
    assert_eq!(runtime.camera(View::Game).expect("camera").position, SHOTS[2].eye());
    runtime.inject(Input::key_tap(Key::Space));
    runtime.step(2.0 * FIXED_STEP_MS);
    assert_eq!(runtime.probes()["view"]["mode"], json!("tour"));
}

#[test]
fn the_lakeside_is_lit_by_the_physical_sky_and_b_steps_through_the_golden_map_and_the_clear_map() {
    use showcase_game::world::{Backdrop, HDRI};
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let environment = |runtime: &mut Runtime<World>| runtime.frame(View::Game).expect("its frame").declared_environment().cloned();
    assert_eq!(environment(&mut runtime), Some(Backdrop::Sky.environment()), "the renderer's sky, lit by the frame's sun");
    assert_eq!(runtime.probes()["view"]["backdrop"], json!("sky"));
    for (backdrop, label) in [(Backdrop::Golden, "golden-hdri"), (Backdrop::Map, "hdri"), (Backdrop::Sky, "sky")] {
        runtime.inject(Input::key_tap(Key::KeyB));
        runtime.step(2.0 * FIXED_STEP_MS);
        assert_eq!(environment(&mut runtime), Some(backdrop.environment()), "{label}");
        assert_eq!(runtime.probes()["view"]["backdrop"], json!(label));
    }
    assert!(assets().iter().any(|(path, _)| *path == HDRI), "the clear map ships with the game");
}

#[test]
fn the_ground_is_the_built_in_terrain_with_six_fetched_layers_over_the_layouts_heights() {
    use showcase_game::layout::{TERRAIN_HALF, TERRAIN_LAYERS, TERRAIN_SAMPLES, TERRAIN_SPACING, height};
    let mut runtime = runtime();
    run(&mut runtime, 10);
    let frame = runtime.frame(View::Game).expect("its frame");
    let ground = frame.drawn_terrain().expect("the frame draws the terrain");
    assert_eq!(frame.tags().get("terrain"), Some(&1), "the whole terrain is one draw");
    assert!(frame.custom_draws().iter().all(|draw| !draw.material.path().contains("terrain")), "no Level-2 terrain material is left");
    assert_eq!(ground.heights().samples(), (TERRAIN_SAMPLES, TERRAIN_SAMPLES));
    assert_eq!((TERRAIN_SAMPLES - 1) as f32 * TERRAIN_SPACING, 2.0 * TERRAIN_HALF, "the samples span the layout");
    // The drawn heights are the layout's, within a quantization step, between samples too.
    let (_, step) = ground.heights().quantization();
    for (x, z) in [(-30.0, 12.0), (6.0, 2.0), (-9.0, -21.0), (80.0, -60.0)] {
        let sampled = |x: f32, z: f32| height((x / TERRAIN_SPACING).round() * TERRAIN_SPACING, (z / TERRAIN_SPACING).round() * TERRAIN_SPACING);
        assert!((ground.height(x, z) - sampled(x, z)).abs() <= step, "({x}, {z})");
    }
    assert_eq!(ground.layers().len(), TERRAIN_LAYERS);
    assert_eq!(ground.control().len(), (TERRAIN_SAMPLES * TERRAIN_SAMPLES) as usize);
    let named: Vec<&str> = ground.layers().iter().flat_map(|layer| [layer.albedo(), layer.data()]).flatten().collect();
    for output in showcase_game::fetched::TERRAIN_LAYERS {
        assert!(named.contains(&format!("fetched/{}", showcase_game::fetched::layer_file(output)).as_str()), "{output}'s base colour: {named:?}");
        assert!(named.contains(&format!("fetched/{}", showcase_game::fetched::data_file(output)).as_str()), "{output}'s data: {named:?}");
    }
}

// Renderer pass 2 A.8: the meadow is the terrain's own grass, grown on its two grassy layers (the
// renderer's preset decides how much of it a device draws), not a Level-3 pass.
#[test]
fn the_meadow_grows_on_the_terrains_grassy_layers() {
    let terrain = showcase_game::world::terrain();
    let grassy: Vec<bool> = terrain.layers().iter().map(|layer| layer.grass().is_some()).collect();
    assert_eq!(grassy, [true, true, false, false, false, false], "lush and dry grass; soil, sand, rock and the lake bed bare");
    let lush = showcase_game::world::lush_grass().render_layer();
    let dry = showcase_game::world::dry_grass().render_layer();
    assert!(lush.usable() && dry.usable());
    assert!(dry.dry_share > lush.dry_share && dry.height[1] > lush.height[1], "the dry meadow is taller and golder");
}

/// The settings panel's switches header (genex-hud's settings panel), shown only while it is open.
const PANEL_FEATURES: &str = "Features";

/// Where the HUD widget labelled `label` is, as a fraction of the world, if the last tick drew it.
fn widget_at(runtime: &Runtime<World>, label: &str) -> Option<[f32; 2]> {
    let size = showcase_game::showcase::WORLD_SIZE;
    runtime.hud_widgets().into_iter().find(|widget| widget.label == label).map(|widget| widget.center_fraction(size))
}

/// Hover at the widget labelled `label` for a tick, then click it and run two ticks (egui's press and release).
fn click(runtime: &mut Runtime<World>, label: &str) {
    let at = widget_at(runtime, label).unwrap_or_else(|| panic!("the HUD draws {label}"));
    runtime.inject(Input::pointer(at[0], at[1]));
    runtime.step(FIXED_STEP_MS);
    runtime.inject(Input::click_at(at[0], at[1]));
    runtime.step(FIXED_STEP_MS * 2.0);
}

// Pass-1 gate: Lakeside offered no settings panel, so no preset could be chosen in Live. O and the
// HUD's settings button open the person's graphics panel, and a click on the button is not a tap
// on the scene (a tap steps to the next shot).
#[test]
fn o_and_the_settings_button_open_the_graphics_panel_and_the_click_keeps_the_shot() {
    let mut runtime = runtime();
    run(&mut runtime, 60);
    runtime.inject(Input::key_tap(Key::Digit2));
    runtime.step(FIXED_STEP_MS);
    assert!(widget_at(&runtime, PANEL_FEATURES).is_none(), "the panel starts closed");
    runtime.inject(Input::key_tap(Key::KeyO));
    runtime.step(FIXED_STEP_MS * 2.0);
    assert!(widget_at(&runtime, PANEL_FEATURES).is_some(), "O opens the graphics panel");
    runtime.inject(Input::key_tap(Key::KeyO));
    runtime.step(FIXED_STEP_MS * 2.0);
    assert!(widget_at(&runtime, PANEL_FEATURES).is_none(), "O closes it again");
    let shot = runtime.probes()["view"]["mode"].clone();
    click(&mut runtime, showcase_game::hud::SETTINGS_BUTTON);
    assert!(widget_at(&runtime, PANEL_FEATURES).is_some(), "the settings button opens the panel");
    assert_eq!(runtime.probes()["view"]["mode"], shot, "a click on the button keeps the shot");
}
