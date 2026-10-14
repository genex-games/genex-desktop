//! The web shell's painter ([`Screen`]) over genex's shared presenter, run natively on the host GPU
//! (the browser row, `tests/conformance/rust-web-render.test.ts`, runs the same code in Chromium):
//! the game's custom passes are installed and counted one `custom` draw each, `state()` answers
//! `fps`, per-tag triangles, `volatile.customPasses` and `volatile.gpu`, a pass whose pipeline wgpu
//! refuses is listed `gpu-pass-invalid` once its (deferred, as on the web) scope resolves and stays
//! off, and the diagnostic switch draws the same frame without the passes.
//!
//! The rows need a GPU: without one they print why and pass, unless `GENEX_REQUIRE_METAL=1`.

#![cfg(not(target_arch = "wasm32"))]

use genex::gpu::{self, GpuError, GpuPass, GpuPassCtx, PassSetup, PassStage};
use genex::present::Presenter;
use genex::prelude::*;
use genex::{Runtime, View};
use genex_core::json::Value as CoreValue;
use genex_platform_web::GameHandle;
use genex_platform_web::studio::{HandleGame, Painter, Screen};
use genex_render::RenderCode;
use genex_render::custom_pass::ScopeMode;
use genex_studio::StudioGame;

const WORLD: [u32; 2] = [96, 64];
/// One animation frame at 60 Hz, in milliseconds.
const FRAME_MS: f64 = 1000.0 / 60.0;

#[derive(Default)]
struct World {
    ticks: u32,
}

/// A pass that registers and draws nothing: valid at every stage.
struct Quiet;

impl GpuPass<World> for Quiet {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        Ok(())
    }

    fn run(&mut self, _ctx: &mut GpuPassCtx<'_, '_, World>) {}
}

/// A post pass that clears the finished frame to red: what the switch's A/B sees.
struct Red;

impl GpuPass<World> for Red {
    fn rebuild(&mut self, _setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        Ok(())
    }

    fn run(&mut self, ctx: &mut GpuPassCtx<'_, '_, World>) {
        let Some(view) = ctx.world_view().cloned() else { return };
        let Some(encoder) = ctx.encoder() else { return };
        let red = gpu::ClearColor { r: 1.0, g: 0.0, b: 0.0, a: 1.0 };
        drop(encoder.begin_render_pass(&gpu::RenderPassDescriptor {
            label: Some("red"),
            color_attachments: &[Some(gpu::RenderPassColorAttachment {
                view: &view,
                depth_slice: None,
                resolve_target: None,
                ops: gpu::Operations { load: gpu::LoadOp::Clear(red), store: gpu::StoreOp::Store },
            })],
            ..Default::default()
        }));
    }
}

const FULL_SCREEN: &str = "
@vertex fn vs_main(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
    return vec4<f32>(f32(i & 1u), f32(i >> 1u), 0.0, 1.0);
}
@fragment fn fs_main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }
";

/// A post pass whose WGSL naga admits but whose pipeline wgpu refuses (its fragment entry point
/// does not exist): only an error scope can tell.
struct BadPipeline;

impl GpuPass<World> for BadPipeline {
    fn rebuild(&mut self, setup: &mut PassSetup<'_>) -> Result<(), GpuError> {
        let module = setup.create_shader("bad pipeline", FULL_SCREEN)?;
        let targets = [Some(gpu::ColorTargetState { format: setup.world_format(), blend: None, write_mask: gpu::ColorWrites::ALL })];
        drop(setup.create_render_pipeline(&gpu::RenderPipelineDescriptor {
            label: Some("bad pipeline"),
            layout: None,
            vertex: gpu::VertexState { module: &module, entry_point: Some("vs_main"), compilation_options: Default::default(), buffers: &[] },
            primitive: gpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: gpu::MultisampleState::default(),
            fragment: Some(gpu::FragmentState {
                module: &module,
                entry_point: Some("fs_missing"),
                compilation_options: Default::default(),
                targets: &targets,
            }),
            multiview_mask: None,
            cache: None,
        }));
        Ok(())
    }

    fn run(&mut self, _ctx: &mut GpuPassCtx<'_, '_, World>) {}
}

fn game(passes: impl FnOnce(&mut Game<World>)) -> Runtime<World> {
    let mut game = Game::new(World::default()).world_size(WORLD[0], WORLD[1]);
    game.on_update(|sim, _ctx| sim.world.ticks += 1);
    game.on_draw(|_sim, frame, _| {
        frame.tag("floor").cube(Transform::from_xyz(0.0, 0.0, 0.0), Color::rgb(90, 140, 90));
    });
    passes(&mut game);
    Runtime::new(game).expect("a valid game")
}

/// A presenter on the host GPU, or None (the row is skipped) without one.
fn presenter() -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open_with_root(WORLD, &[], None) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no GPU: {error}"),
        Err(error) => {
            eprintln!("skipped: no WebGPU-core adapter ({error})");
            None
        }
    }
}

/// `state()` through the web's studio adapter, with `screen` as its painter.
fn state(game: &mut dyn GameHandle, screen: &mut Screen) -> CoreValue {
    let (mut view, mut draws) = (None, 0);
    let mut adapter = HandleGame { game, painter: screen, view: &mut view, draws: &mut draws };
    adapter.state("default")
}

/// `volatile.customPasses` as (name, stage, running, code).
fn listed(state: &CoreValue) -> Vec<(String, String, bool, Option<String>)> {
    let passes = &state["volatile"]["customPasses"];
    passes
        .items()
        .iter()
        .map(|pass| {
            let code = match &pass["code"] {
                CoreValue::Null => None,
                code => Some(code.as_str().to_owned()),
            };
            (pass["name"].as_str().to_owned(), pass["stage"].as_str().to_owned(), pass["running"] == CoreValue::Bool(true), code)
        })
        .collect()
}

#[test]
fn the_web_screen_counts_one_custom_draw_per_pass_and_state_answers_fps_triangles_and_the_passes() {
    let Some(presenter) = presenter() else { return };
    let mut runtime = game(|game| {
        game.gpu_pass("glow", PassStage::Post, Quiet);
        game.gpu_pass("ring", PassStage::AfterOpaque, Quiet);
    });
    let game: &mut dyn GameHandle = &mut runtime;
    let mut screen = Screen::new(presenter);
    screen.install(game);
    // The game's own draws (reading a frame resets the tally, so before the painted one).
    let own = game.frame().0.draw_calls();
    let draws = screen.paint(game, None);
    assert_eq!(draws, own + 2, "the cube and one custom draw per registered pass");
    for _ in 0..30 {
        screen.shown(FRAME_MS);
    }
    let state = state(game, &mut screen);
    assert_eq!(
        listed(&state),
        vec![("glow".to_owned(), "post".to_owned(), true, None), ("ring".to_owned(), "after-opaque".to_owned(), true, None)]
    );
    let fps = state["fps"].as_f64();
    assert!(fps > 0.0, "fps {fps}");
    assert_eq!(state["volatile"]["fps"].as_f64(), fps);
    let triangles = state["__render"]["triangles"].as_f64();
    assert!(triangles > 0.0, "the presenter's triangles reach state(): {triangles}");
    assert!(state["__render"]["tags"]["floor"]["triangles"].as_f64() > 0.0, "per tag");
    assert!(state["volatile"]["gpu"]["passes"].as_f64() > 0.0, "volatile.gpu is reported");
}

#[test]
fn a_pass_wgpu_refuses_on_the_web_is_listed_gpu_pass_invalid_after_its_scope_resolves_and_stays_off() {
    let Some(mut presenter) = presenter() else { return };
    // The web's mode: every scope is answered on a later frame.
    presenter.passes.set_scope_mode(ScopeMode::Deferred);
    let mut runtime = game(|game| {
        game.gpu_pass("fine", PassStage::Post, Quiet);
        game.gpu_pass("bad", PassStage::Post, BadPipeline);
    });
    let game: &mut dyn GameHandle = &mut runtime;
    let mut screen = Screen::new(presenter);
    screen.install(game);
    let before = listed(&state(game, &mut screen));
    assert!(before.iter().all(|(_, _, running, code)| *running && code.is_none()), "nothing is known before a frame: {before:?}");
    screen.paint(game, None);
    let after = listed(&state(game, &mut screen));
    assert_eq!(
        after,
        vec![
            ("fine".to_owned(), "post".to_owned(), true, None),
            ("bad".to_owned(), "post".to_owned(), false, Some(RenderCode::GpuPassInvalid.wire().to_owned())),
        ]
    );
    for _ in 0..3 {
        screen.paint(game, None);
    }
    assert_eq!(listed(&state(game, &mut screen)), after, "the refused pass stays off");
    assert!(screen.presenter.take_pass_refusals().is_empty(), "and is not retried");
}

#[test]
fn the_diagnostic_switch_draws_the_frame_without_the_passes_and_the_same_frame_once_back_on() {
    let Some(presenter) = presenter() else { return };
    let mut runtime = game(|game| {
        game.gpu_pass("red", PassStage::Post, Red);
    });
    let mut screen = Screen::new(presenter);
    screen.install(&mut runtime);
    let capture = |screen: &mut Screen, runtime: &mut Runtime<World>| {
        screen.presenter.draw_view(runtime, View::Game).expect("the game's view").expect("drawn");
        screen.presenter.resilient.capture().expect("capture").digest()
    };
    let with = capture(&mut screen, &mut runtime);
    screen.presenter.set_custom_passes_enabled(false);
    let without = capture(&mut screen, &mut runtime);
    screen.presenter.set_custom_passes_enabled(true);
    let again = capture(&mut screen, &mut runtime);
    assert_ne!(with, without, "the pass changed the frame");
    assert_eq!(again, with, "back on, the same frame");
}
