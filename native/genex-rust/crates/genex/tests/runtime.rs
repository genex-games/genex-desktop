//! Hook semantics of the headless reference runtime: seeding, ticking, the input edges, read
//! hooks that never move the checksum, demos, physics and the egui input path.

use genex::physics::{ColliderBuilder, RigidBodyBuilder, RigidBodyHandle};
use genex::prelude::*;
use genex::{FIXED_STEP_MS, MAX_STEP_TICKS, Runtime, step_ticks};

#[derive(Default)]
struct World {
    rolls: Vec<u32>,
    presses: u32,
    taps: u32,
    ticks: u32,
    order: Vec<&'static str>,
    ball: Option<RigidBodyHandle>,
    bought: u32,
    name: String,
}

fn dice_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Dice");
    game.on_reset(|sim, seed, rng, _gfx| {
        sim.world.rolls.push(seed);
        sim.world.rolls.push(rng.below(1000));
    });
    game.on_update(|sim, ctx| {
        sim.world.ticks += 1;
        sim.world.rolls.push(ctx.rng.below(1000));
        if ctx.keys.pressed(Key::Space) {
            sim.world.presses += 1;
        }
        if ctx.touches.tapped() {
            sim.world.taps += 1;
        }
    });
    game.probe("dice", |sim| json!({ "rolls": sim.world.rolls, "presses": sim.world.presses }));
    game.probe_volatile("debug", |sim| json!(sim.world.ticks));
    game
}

fn runtime(game: Game<World>) -> Runtime<World> {
    Runtime::new(game).expect("a consistent game installs")
}

#[test]
fn step_runs_rounded_fixed_ticks_with_at_least_one_and_a_cap() {
    assert_eq!(step_ticks(0.0), 1);
    assert_eq!(step_ticks(FIXED_STEP_MS), 1);
    assert_eq!(step_ticks(1000.0), 60);
    assert_eq!(step_ticks(2000.0), 120);
    assert_eq!(step_ticks(f64::NAN), 1);
    assert_eq!(step_ticks(-50.0), 1);
    assert_eq!(step_ticks(1.0e12), MAX_STEP_TICKS);
    let mut rt = runtime(dice_game());
    rt.seed(1);
    let step = rt.step(1000.0);
    assert_eq!((step.ticks, step.frame), (60, 60));
    assert_eq!(rt.sim().world.ticks, 60);
}

#[test]
fn live_frames_pace_like_genex_core_frame_clock_and_start_resets_the_carry() {
    let mut game = runtime(dice_game());
    assert_eq!(game.advance_live(250.0), 0, "a paused game runs no live ticks");
    game.start();
    // 250 ms is 14.999… steps in floats: the golden-checked clock (and C++ clock.cpp) runs 15.
    assert_eq!(game.advance_live(250.0), 15);
    assert_eq!(game.advance_live(1000.0), 15, "a stalled frame counts at most 250 ms");
    assert_eq!(game.advance_live(f64::NAN), 0);
    assert_eq!(game.advance_live(-5.0), 0);
    assert_eq!(game.advance_live(10.0), 0, "10 ms is carried");
    game.pause();
    game.start();
    assert_eq!(game.advance_live(10.0), 0, "start forgot the carry: 10 + 10 ms would have ticked");
    let mut replay = runtime(dice_game());
    replay.start();
    let mut paced = genex_core_clock();
    for frame_ms in [16.0, 17.0, 16.5, 33.4, 8.3, 250.0, 0.1, 16.6] {
        assert_eq!(replay.advance_live(frame_ms), paced.advance(frame_ms), "{frame_ms} ms");
    }
}

fn genex_core_clock() -> genex_core::clock::FrameClock {
    genex_core::clock::FrameClock::default()
}

#[test]
fn the_same_seed_gives_the_same_stream_and_checksum() {
    let mut a = runtime(dice_game());
    let mut b = runtime(dice_game());
    for rt in [&mut a, &mut b] {
        rt.seed(42);
        rt.step(500.0);
    }
    assert_eq!(a.sim().world.rolls, b.sim().world.rolls);
    assert_eq!(a.checksum(), b.checksum());
    b.seed(43);
    b.step(500.0);
    assert_ne!(a.sim().world.rolls, b.sim().world.rolls);
    assert_ne!(a.checksum(), b.checksum());
}

#[test]
fn seed_rebuilds_the_world_from_default_and_pauses() {
    let mut rt = runtime(dice_game());
    rt.seed(7);
    rt.start();
    rt.step(200.0);
    rt.seed(7);
    assert!(!rt.running());
    assert_eq!(rt.sim().world.ticks, 0);
    assert_eq!(rt.sim().world.rolls.first(), Some(&7));
    assert_eq!(rt.sim().world.rolls.len(), 2);
}

#[test]
fn reset_hooks_run_in_registration_order() {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, _, _, _| sim.world.order.push("first"));
    game.on_reset(|sim, _, _, _| sim.world.order.push("second"));
    let mut rt = runtime(game);
    rt.seed(1);
    assert_eq!(rt.sim().world.order, ["first", "second"]);
}

#[test]
fn reading_state_frames_cameras_and_probes_never_moves_the_checksum() {
    let mut game = dice_game();
    game.on_draw(|sim, frame, _camera| {
        frame.tag("dice");
        for _ in &sim.world.rolls {
            frame.cube(Transform::IDENTITY, Color::WHITE);
        }
    });
    game.named_camera("top", |_| Camera::look_at(vec3(0.0, 20.0, 0.1), Vec3::ZERO));
    let mut rt = runtime(game);
    rt.seed(9);
    rt.step(100.0);
    let before = rt.checksum();
    for _ in 0..5 {
        let frame = rt.frame(View::Named("top")).expect("the named camera exists");
        assert_eq!(frame.draw_calls(), rt.sim().world.rolls.len() as u32);
        assert_eq!(frame.tags().get("dice"), Some(&frame.draw_calls()));
        let _ = rt.state();
        let _ = rt.probes();
    }
    assert_eq!(rt.checksum(), before);
}

#[test]
fn volatile_probes_are_reported_but_left_out_of_the_checksum() {
    let mut game = Game::new(World::default());
    game.probe_volatile("ticks", |sim| json!(sim.world.ticks));
    let mut rt = runtime(game);
    rt.seed(1);
    let before = rt.checksum();
    rt.sim_mut().world.ticks = 99;
    assert_eq!(rt.state()["volatile"]["ticks"], json!(99));
    assert_eq!(rt.checksum(), before);
}

#[test]
fn state_merges_probes_after_the_runtime_keys_in_registration_order() {
    let mut game = Game::new(World::default());
    game.probe("zeta", |_| json!(1));
    game.probe("alpha", |_| json!(2));
    let mut rt = runtime(game);
    rt.seed(5);
    let state = rt.state();
    assert_eq!(state["seed"], json!(5));
    assert_eq!(state["frame"], json!(0));
    assert_eq!(state["zeta"], json!(1));
    let names: Vec<String> = rt.probes().keys().cloned().collect();
    assert_eq!(names, ["zeta", "alpha"]);
}

#[test]
fn a_tap_is_pressed_on_exactly_one_tick() {
    let mut rt = runtime(dice_game());
    rt.seed(1);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS * 5.0);
    assert_eq!(rt.sim().world.presses, 1);
    assert!(rt.held().is_empty());
}

#[test]
fn a_held_key_presses_once_and_is_held_until_released() {
    let mut rt = runtime(dice_game());
    rt.seed(1);
    let held = rt.inject(Input::key_down(Key::Space));
    assert_eq!(held, ["Space"]);
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.presses, 1);
    let held = rt.inject(Input::key_up(Key::Space));
    assert!(held.is_empty());
}

#[test]
fn a_mouse_click_also_arrives_as_one_touch_tap() {
    let mut rt = runtime(dice_game());
    rt.seed(1);
    rt.inject(Input::click_at(0.5, 0.5));
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.taps, 1);
}

#[test]
fn a_demo_drives_the_simulation_and_leaves_it_paused() {
    let mut game = dice_game();
    game.demo("press", |d| {
        d.inject(Input::key_tap(Key::Space));
        let step = d.advance_ms(1000);
        json!({ "ticks": step.ticks, "presses": d.sim().world.presses })
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.start();
    let result = rt.demo("press").expect("the demo exists");
    assert_eq!(result, json!({ "ticks": 60, "presses": 1 }));
    assert!(!rt.running());
    assert_eq!(rt.demos(), ["press"]);
    let unknown = rt.demo("absent").expect_err("no such demo");
    assert_eq!(unknown.available, ["press"]);
}

#[test]
fn physics_steps_once_per_tick_after_update() {
    let mut game = Game::new(World::default());
    game.on_reset(|sim, _, _, _| {
        let (body, _collider) =
            sim.physics.insert(RigidBodyBuilder::dynamic().translation(vec3(0.0, 10.0, 0.0)), ColliderBuilder::ball(0.5));
        sim.world.ball = Some(body);
    });
    game.probe("y", |sim| {
        let ball = sim.world.ball.and_then(|h| sim.physics.bodies.get(h));
        json!(ball.map(|b| b.translation().y))
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(1000.0);
    let y = rt.probes()["y"].as_f64().expect("the ball exists");
    // One second of free fall from 10 m under -9.81 m/s^2 lands near 5.1 m.
    assert!((4.5..5.6).contains(&y), "y = {y}");
}

#[test]
fn an_injected_click_on_an_egui_button_reaches_on_ui() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.on_ui(|sim, ui, _ctx| {
        if ui.button("Buy bait").clicked() {
            sim.world.bought += 1;
        }
    });
    let mut rt = runtime(game);
    rt.seed(1);
    // The button is laid out at the top-left; aim a few pixels into it.
    let (x, y) = (12.0 / 400.0, 10.0 / 300.0);
    rt.inject(Input::pointer(x, y));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!(rt.sim().world.bought, 1);
}

#[test]
fn the_keyboard_is_wanted_once_a_tap_focuses_a_hud_text_field() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.on_ui(|sim, ui, _ctx| {
        ui.text_edit_singleline(&mut sim.world.name);
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(FIXED_STEP_MS);
    assert!(!rt.keyboard_wanted(), "no field has focus before a tap");
    // The field is laid out at the top-left; aim a few pixels into it.
    let (x, y) = (12.0 / 400.0, 10.0 / 300.0);
    rt.inject(Input::pointer(x, y));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::click_at(x, y));
    rt.step(FIXED_STEP_MS * 2.0);
    assert!(rt.keyboard_wanted(), "the tapped field has focus, so a phone raises its keyboard");
}

/// Pass-1 gate: Space on a focused settings-panel switch also toggled the showcase's tour.
#[test]
fn keys_go_to_a_focused_hud_widget_and_not_to_the_update_hooks_until_escape_releases_it() {
    let mut game = Game::new(World::default()).world_size(400, 300);
    game.on_update(|sim, ctx| {
        if ctx.keys.pressed(Key::Space) {
            sim.world.presses += 1;
        }
        if ctx.keys.down(Key::KeyW) {
            sim.world.ticks += 1;
        }
    });
    game.on_ui(|sim, ui, _ctx| {
        if ui.button("Panel switch").clicked() {
            sim.world.bought += 1;
        }
    });
    let mut rt = runtime(game);
    rt.seed(1);
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS);
    assert_eq!((rt.sim().world.presses, rt.sim().world.bought), (1, 0), "nothing focused: the game has Space");
    rt.inject(Input::key_tap(Key::Tab));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS * 2.0);
    assert_eq!((rt.sim().world.presses, rt.sim().world.bought), (1, 1), "the focused switch has Space, the game does not");
    rt.inject(Input::key_down(Key::KeyW));
    rt.step(FIXED_STEP_MS * 3.0);
    assert_eq!(rt.sim().world.ticks, 0, "a key held while a widget has focus does not reach the game");
    rt.inject(Input::key_up(Key::KeyW).and(Input::key_tap(Key::Escape)));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_tap(Key::Space));
    rt.step(FIXED_STEP_MS);
    assert_eq!((rt.sim().world.presses, rt.sim().world.bought), (2, 1), "Escape gives the keys back to the game");
}

#[test]
fn an_android_shell_rebases_the_saves_onto_the_activitys_internal_data_folder() {
    let data = std::env::temp_dir().join(format!("genex-android-data-{}", std::process::id()));
    std::fs::create_dir_all(&data).expect("a private data folder");
    let data = data.to_str().expect("a UTF-8 temp folder").to_owned();
    let mut rt = runtime(dice_game());
    rt.use_android_data(&data);
    assert_eq!(rt.saves().root(), Some(format!("{data}/").as_str()));
    assert!(rt.saves().save("slot.json", b"{}"));
    assert_eq!(std::fs::read(format!("{data}/slot.json")).ok().as_deref(), Some(&b"{}"[..]));
    // Not an absolute folder: no save root at all, never one the process environment names.
    rt.use_android_data("relative/data");
    assert_eq!(rt.saves().root(), None);
    let _ = std::fs::remove_dir_all(&data);
}

#[test]
fn assets_requested_at_reset_are_listed_and_unsafe_paths_are_missing_models() {
    let mut game = Game::new(World::default());
    game.on_reset(|_, _, _, gfx| {
        assert!(!gfx.assets().model("pond.glb").is_missing());
        for hostile in ["../escape.glb", "/abs.glb", "a\\b.glb", "", "dir//x.glb", "./x.glb"] {
            assert!(gfx.assets().model(hostile).is_missing(), "{hostile}");
        }
    });
    let mut rt = runtime(game);
    rt.seed(1);
    assert_eq!(rt.state()["assets"], json!(["pond.glb"]));
}
