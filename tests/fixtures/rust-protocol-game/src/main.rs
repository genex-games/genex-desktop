//! The Rust protocol game (M2.4): a genex facade game whose sources look like a generated game's
//! (`src/main.rs` against `genex::prelude`, no manifest of its own), built as the facade crate's
//! `rust-protocol-game` example with the dev flavour's `studio` feature, and driven by
//! `tests/conformance/rust-runtime.test.ts` through the host's `NativeGamePort` the way
//! `native-real.test.ts` drives a C++ game.
//!
//! - `KeyD` held moves `x` one a tick; `KeyS` pressed saves `x` as `progress/best.txt`, and every
//!   reset loads it back into the `saves` probe.
//! - Touches are recorded by id, phase and world position in the `touch` probe.
//! - A touch-only control: `taps` counts the ticks a finger lifted (a tap or an end), Mouse1's
//!   emulated touch 0 among them, and nothing a key does reaches it (M3.9's play-script rows).
//! - A red cube sits in the upper half of the 96 x 64 world: a top-down capture has red rows above
//!   the middle and none below it.
//! - Named camera `top`, eye `eye:spawn`; demos `walk` (KeyD for 100 ms) and `crash` (a panic).
//! - `KeyH` pressed shows (or hides) an egui button labelled `Shop` at world pixels (8, 8) to
//!   (48, 28): `state().hud.items` names it, captures carry it and `shopClicks` counts its clicks.
//! - A custom GPU pass `broken` whose rebuild refuses: the run lists it in
//!   `state().volatile.customPasses` with `gpu-pass-invalid` and draws on without it.

use genex::gpu::{GpuCode, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
use genex::prelude::*;

/// The save file the `KeyS` press writes.
const BEST: &str = "progress/best.txt";

#[derive(Default)]
struct World {
    x: i32,
    saves: u32,
    loaded: String,
    touch: Option<(u32, String, f32, f32)>,
    taps: u32,
    shop: bool,
    shop_clicks: u32,
}

/// A custom pass whose rebuild refuses, as a broken pass in a generated game would.
struct Broken;

impl GpuPass<World> for Broken {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        Err(GpuError::refused(GpuCode::GpuPassInvalid, "the protocol game's pass refuses its rebuild"))
    }

    fn run(&mut self, _ctx: &mut GpuPassCtx<'_, '_, World>) {}
}

fn main() {
    let mut game = Game::new(World::default())
        .title("Protocol")
        .world_size(96, 64)
        .background(Color::rgb(8, 8, 16));
    game.on_reset(|sim, _seed, _rng, gfx| {
        let loaded = gfx.load(BEST).unwrap_or_default();
        sim.world.loaded = String::from_utf8_lossy(&loaded).into_owned();
    });
    game.on_update(|sim, ctx| {
        if ctx.keys.down(Key::KeyD) {
            sim.world.x += 1;
        }
        if ctx.keys.pressed(Key::KeyS) && ctx.save(BEST, sim.world.x.to_string().as_bytes()) {
            sim.world.saves += 1;
        }
        if ctx.keys.pressed(Key::KeyH) {
            sim.world.shop = !sim.world.shop;
        }
        if ctx.touches.tapped() {
            sim.world.taps += 1;
        }
        if let Some(touch) = ctx.touches.all().iter().find(|touch| touch.id != 0) {
            let phase = format!("{:?}", touch.phase);
            sim.world.touch = Some((touch.id, phase, touch.position.x, touch.position.y));
        }
    });
    game.on_ui(|sim, ui, _| {
        let place = egui::Rect::from_min_size(egui::pos2(8.0, 8.0), egui::vec2(40.0, 20.0));
        if sim.world.shop && ui.put(place, egui::Button::new("Shop")).clicked() {
            sim.world.shop_clicks += 1;
        }
    });
    game.gpu_pass("broken", PassStage::Post, Broken);
    game.camera(|_| Camera::look_at(vec3(0.0, 0.0, 10.0), Vec3::ZERO));
    game.named_camera("top", |_| Camera::look_at(vec3(0.0, 12.0, 0.1), Vec3::ZERO));
    game.eye("eye:spawn", |sim| Camera::look_at(vec3(sim.world.x as f32, 1.0, 6.0), Vec3::ZERO));
    game.on_draw(|_, frame, _| {
        frame.tag("marker").cube(Transform::from_xyz(0.0, 2.6, 0.0).with_scale(Vec3::splat(2.0)), Color::RED);
    });
    game.probe("x", |sim| json!(sim.world.x));
    game.probe("saves", |sim| json!({ "written": sim.world.saves, "loaded": sim.world.loaded }));
    game.probe("touch", |sim| match &sim.world.touch {
        Some((id, phase, x, y)) => json!({ "id": id, "phase": phase, "x": x, "y": y }),
        None => Value::Null,
    });
    game.probe("taps", |sim| json!(sim.world.taps));
    game.probe("shopClicks", |sim| json!(sim.world.shop_clicks));
    game.probe_volatile("ticksSeen", |sim| json!(sim.world.x));
    game.demo("walk", |d| {
        d.inject(Input::key_down(Key::KeyD));
        d.advance_ms(100);
        d.inject(Input::key_up(Key::KeyD));
        json!({ "x": d.sim().world.x })
    });
    game.demo("crash", |_| panic!("the crash demo"));
    genex::install(game);
}
