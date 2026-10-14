//! Frame pacing (RQ0.12): the graph runs only on display frames that carry a sim tick, a repeat
//! frame re-presents the last world target, and every temporal sequence (the frame index, exposure
//! adaptation, TAA and AO history) advances per rendered tick, never per display refresh.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex-render \
//!     --test pacing --offline --locked -- --ignored metal

use genex_render::immediate::ImmediateFrame;
use genex_render::pacing::{FrameAction, FrameGate, FramePacer, FrameTally, MOBILE_PREFERRED_HZ, tick_blend};
use genex_render::scene::{CameraDesc, translation};
use genex_render::{CullPath, FrameRenderer, Gpu, RenderOptions};

/// What a temporal consumer sees after `frames` display frames of `frame_ms`: the frame index, an
/// exposure-like value adapted towards 1.0 at 5% a tick, and the frames rendered and repeated.
fn drive(frames: u32, frame_ms: f64) -> (u64, f32, FrameTally) {
    let mut pacer = FramePacer::default();
    let mut gate = FrameGate::default();
    let mut exposure = 0.0_f32;
    for _ in 0..frames {
        let paced = pacer.display_frame(frame_ms);
        if gate.frame(paced.ticks) == FrameAction::Render {
            exposure += (1.0 - exposure) * tick_blend(0.05, paced.ticks);
        }
    }
    (gate.frame_index(), exposure, gate.tally())
}

#[test]
fn a_120_hz_display_advances_the_frame_index_and_adaptation_exactly_as_a_60_hz_one() {
    let (index_60, exposure_60, tally_60) = drive(60, 1000.0 / 60.0);
    let (index_120, exposure_120, tally_120) = drive(120, 1000.0 / 120.0);
    assert_eq!(index_60, 60, "one second at 60 Hz is 60 rendered ticks");
    assert_eq!(index_120, index_60, "the frame index counts ticks, not display refreshes");
    assert_eq!(exposure_120.to_bits(), exposure_60.to_bits(), "adaptation steps per tick: bit-identical");
    assert_eq!(tally_60, FrameTally { rendered: 60, repeated: 0 });
    // The first 120 Hz frame is worth no tick yet and draws anyway (the window never shows an empty
    // target); every later frame renders only when it carries a tick.
    assert_eq!(tally_120, FrameTally { rendered: 61, repeated: 59 }, "120 Hz renders the graph once per tick");
}

#[test]
fn a_144_hz_display_renders_at_most_once_per_tick() {
    let (index, _, tally) = drive(144, 1000.0 / 144.0);
    assert_eq!(index, 60);
    assert_eq!(tally.rendered, 61, "60 ticks and the first frame");
    assert_eq!(tally.repeated, 83);
}

#[test]
fn a_slow_display_adapts_over_both_ticks_of_a_two_tick_frame() {
    let (index_60, exposure_60, _) = drive(60, 1000.0 / 60.0);
    let (index_30, exposure_30, tally_30) = drive(30, 1000.0 / 30.0);
    assert_eq!(index_30, index_60, "a frame that runs two ticks advances the index by two");
    assert_eq!(tally_30, FrameTally { rendered: 30, repeated: 0 });
    assert!((exposure_30 - exposure_60).abs() < 1e-5, "30 Hz {exposure_30} vs 60 Hz {exposure_60}");
}

#[test]
fn tick_blend_is_zero_without_a_tick_and_compounds_per_tick() {
    assert_eq!(tick_blend(0.05, 0), 0.0, "a repeat frame moves nothing");
    assert_eq!(tick_blend(0.05, 1), 0.05);
    let two = tick_blend(0.05, 2);
    assert!((two - (1.0 - 0.95 * 0.95)).abs() < 1e-7);
    assert_eq!(tick_blend(1.0, 3), 1.0);
    assert_eq!(tick_blend(0.0, 3), 0.0);
    for hostile in [f32::NAN, f32::INFINITY, -0.5] {
        assert_eq!(tick_blend(hostile, 4), 0.0, "{hostile} moves nothing");
    }
    assert_eq!(tick_blend(2.0, 1), 1.0, "a rate above one lands on the target");
    assert!(tick_blend(0.01, u32::MAX) <= 1.0);
}

#[test]
fn the_first_frame_and_a_stale_frame_render_without_a_tick_and_keep_the_index() {
    let mut gate = FrameGate::default();
    assert_eq!(gate.frame(0), FrameAction::Render, "the window never shows an empty target");
    assert_eq!(gate.frame(0), FrameAction::Repeat);
    gate.mark_stale();
    assert_eq!(gate.frame(0), FrameAction::Render, "a verb or a resize changed what the frame shows");
    assert_eq!(gate.frame_index(), 0, "re-rendering the same tick does not advance temporal history");
    assert_eq!(gate.frame(1), FrameAction::Render);
    assert_eq!(gate.frame_index(), 1);
    assert_eq!(gate.tally(), FrameTally { rendered: 3, repeated: 1 });
}

#[test]
fn a_history_reset_restarts_the_index_and_renders_the_next_frame() {
    let mut gate = FrameGate::default();
    for _ in 0..5 {
        gate.frame(1);
    }
    assert_eq!(gate.frame_index(), 5);
    gate.reset_history();
    assert_eq!(gate.frame_index(), 0);
    assert_eq!(gate.frame(0), FrameAction::Render, "a new device or surface draws before it repeats");
    assert_eq!(gate.frame(2), FrameAction::Render);
    assert_eq!(gate.frame_index(), 2);
}

#[test]
fn phones_ask_for_the_sim_rate() {
    assert_eq!(MOBILE_PREFERRED_HZ, 60.0);
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

fn frame() -> ImmediateFrame {
    let mut frame = ImmediateFrame::new(CameraDesc::look_at([0.0, 2.0, 6.0], [0.0, 0.0, 0.0]), [20, 24, 32, 255]);
    frame.cube(translation(0.0, 0.0, 0.0), [230, 41, 55, 255]);
    frame.sphere([1.5, 0.5, 0.0], 0.5, [0, 121, 241, 255]);
    frame.rect(genex_render::immediate::Rect2d::new(4.0, 4.0, 20.0, 10.0), [253, 249, 0, 255]);
    frame
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_repeat_frame_encodes_no_graph_node_and_re_presents_the_same_picture() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, 128, 72, RenderOptions::default()).expect("renderer");
    let drawn = renderer.render_paced(&gpu, 1, &frame(), CullPath::Gpu, None).expect("frame");
    assert!(drawn.is_some(), "a frame with a tick runs the graph");
    let nodes = renderer.nodes_encoded();
    assert!(nodes > 0, "the rendered frame encoded graph nodes");
    let rendered = renderer.renderer_mut().present_to_texture(&gpu, (128, 72)).expect("present");
    let repeat = renderer.render_paced(&gpu, 0, &frame(), CullPath::Gpu, None).expect("repeat");
    assert!(repeat.is_none(), "a repeat frame reports no rendered frame");
    assert_eq!(renderer.nodes_encoded(), nodes, "a repeat frame encodes no graph node");
    assert_eq!(renderer.tally(), FrameTally { rendered: 1, repeated: 1 });
    assert_eq!(renderer.frame_index(), 1);
    let repeated = renderer.renderer_mut().present_to_texture(&gpu, (128, 72)).expect("re-present");
    assert_eq!(repeated.digest(), rendered.digest(), "a repeat frame shows the last world target");
    renderer.render_paced(&gpu, 2, &frame(), CullPath::Gpu, None).expect("two ticks");
    // RQ5 review flipped 3 -> 2 (named in the log): the history index counts drawn frames (the
    // jitter walks every position at any cadence); adaptation moves by the ticks the frame ran.
    assert_eq!(renderer.frame_index(), 2, "the index advances by one per drawn frame");
    assert!(renderer.nodes_encoded() > nodes);
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_120_display_frames_at_120_hz_run_the_graph_60_times() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = FrameRenderer::new(&gpu, 64, 36, RenderOptions::default()).expect("renderer");
    let mut pacer = FramePacer::default();
    let mut per_frame = None;
    for _ in 0..120 {
        let (before, first) = (renderer.nodes_encoded(), renderer.tally().rendered == 0);
        let paced = pacer.display_frame(1000.0 / 120.0);
        renderer.render_paced(&gpu, paced.ticks, &frame(), CullPath::Gpu, None).expect("frame");
        let encoded = renderer.nodes_encoded() - before;
        if paced.repeat && !first {
            assert_eq!(encoded, 0, "a repeat frame encodes nothing");
        } else if encoded > 0 {
            per_frame.get_or_insert(encoded);
        }
    }
    assert_eq!(renderer.tally(), FrameTally { rendered: 61, repeated: 59 }, "the first frame draws before its tick");
    // RQ5 review flipped 60 -> 61 (named in the log): the history index counts the 61 drawn frames.
    assert_eq!(renderer.frame_index(), 61);
    let per_frame = per_frame.expect("frames rendered");
    assert_eq!(renderer.nodes_encoded(), per_frame * 61, "the graph ran once per rendered frame");
}
