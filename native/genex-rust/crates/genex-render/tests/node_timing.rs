//! Per-node GPU timing (PROF-2), Metal rows: an armed frame gives one span per pass step in
//! schedule order plus the world pass, and the spans add up to no more than 1.05x the bracketed
//! span; a renderer that is never armed opens exactly the passes its twin does; a frame drawn on a
//! capture's history set while armed records no sample; and an armed frame's capture is byte for
//! byte the unarmed twin's.

use genex_profile::gpu_lane::WORLD_NODE;
use genex_render::graph::{FRAME_GRAPH, schedule};
use genex_render::renderer::node_timing::NodeFrame;
use genex_render::scene::{CameraDesc, Material, MeshId, Scene, scaled, translation};
use genex_render::settle::HistorySet;
use genex_render::{CullPath, Gpu, Renderer};

const WIDTH: u32 = 128;
const HEIGHT: u32 = 72;
/// The node spans may add up past the bracketed span by this much (the brackets themselves).
const SPAN_SUM_TOLERANCE: f64 = 1.05;
/// Frames drawn while waiting for armed frames' times to land.
const LANDING_FRAMES: u64 = 12;

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

fn scene() -> Scene {
    let mut scene = Scene::new(CameraDesc::look_at([0.0, 3.0, 8.0], [0.0, 0.5, 0.0]), [18, 20, 28, 255]);
    scene.draw(MeshId::CUBE, translation(0.0, 0.5, 0.0), Material::color([230, 41, 55, 255]));
    scene.draw(MeshId::CUBE, scaled([0.0, -0.75, 0.0], [12.0, 0.2, 8.0]), Material::color([90, 90, 100, 255]));
    scene
}

fn wait(gpu: &Gpu) {
    let _ = gpu.device.poll(wgpu::PollType::wait_indefinitely());
}

/// Arm and draw `frames` frames from `first`, then keep arming (and drawing) until their times
/// land; answers every landed frame.
fn armed_frames(gpu: &Gpu, renderer: &mut Renderer, first: u64, frames: u64) -> Option<Vec<NodeFrame>> {
    let mut landed = Vec::new();
    for frame in first..first + frames + LANDING_FRAMES {
        wait(gpu);
        landed.extend(renderer.arm_node_timer(&gpu.queue, frame)?);
        renderer.render(gpu, &scene(), CullPath::Gpu).expect("frame");
    }
    Some(landed)
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_armed_nodes_give_one_span_per_step_in_schedule_order_within_the_frame_span() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let Some(landed) = armed_frames(&gpu, &mut renderer, 0, 4) else {
        assert!(!gpu.device.features().contains(wgpu::Features::TIMESTAMP_QUERY), "a timer where timestamps are offered");
        return;
    };
    assert!(landed.len() >= 4, "armed frames land within a few frames: {}", landed.len());
    let mut rows = Vec::new();
    for frame in &landed {
        let names: Vec<&str> = frame.nodes.iter().map(|sample| sample.node).collect();
        let worlds = names.iter().filter(|name| **name == WORLD_NODE).count();
        assert_eq!(worlds, 1, "frame {}: one world span in {names:?}", frame.frame);
        let order: Vec<usize> = names
            .iter()
            .filter(|name| **name != WORLD_NODE)
            .map(|name| FRAME_GRAPH.iter().position(|row| row.wire == *name).expect("a frame-graph row"))
            .collect();
        assert!(order.windows(2).all(|pair| pair[0] < pair[1]), "frame {}: schedule order {names:?}", frame.frame);
        assert!(frame.nodes.iter().all(|sample| sample.frame == frame.frame && sample.ms.is_finite() && sample.ms >= 0.0));
        let span = frame.span_ms.expect("the bracketed span");
        let sum: f64 = frame.nodes.iter().map(|sample| sample.ms).sum();
        assert!(sum <= span * SPAN_SUM_TOLERANCE, "frame {}: node spans {sum} ms against the span {span} ms", frame.frame);
        rows.push(format!("{{\"frame\":{},\"span_ms\":{span},\"sum_ms\":{sum},\"nodes\":{names:?}}}", frame.frame));
    }
    // Every step the legacy frame schedules is timed (the world pass's rows as one span).
    let steps = schedule(|id| landed[0].nodes.iter().any(|sample| sample.node == genex_render::graph::spec(id).wire));
    assert!(!steps.is_empty());
    let receipt = gpu.receipt();
    eprintln!("{{\"row\":\"prof2-node-spans\",\"backend\":\"{}\",\"adapter\":\"{}\",\"frames\":[{}]}}", receipt.backend, receipt.adapter, rows.join(","));
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_renderer_never_armed_opens_the_passes_its_twin_does() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut twin = Renderer::new(&gpu, WIDTH, HEIGHT).expect("twin");
    for frame in 0..6 {
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("frame");
        twin.render(&gpu, &scene(), CullPath::Gpu).expect("twin frame");
        let (ours, theirs) = (renderer.last_stats(), twin.last_stats());
        assert_eq!((ours.compute_passes, ours.render_passes), (theirs.compute_passes, theirs.render_passes), "frame {frame}");
        assert_eq!(ours, theirs, "frame {frame}: off times nothing and adds nothing");
    }
    // Armed brackets are the profiler's passes, not the renderer's: its stats stay the twin's.
    if renderer.arm_node_timer(&gpu.queue, 6).is_some() {
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("armed frame");
        twin.render(&gpu, &scene(), CullPath::Gpu).expect("twin frame");
        assert_eq!(renderer.last_stats(), twin.last_stats(), "an armed frame's renderer stats");
    }
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_a_capture_drawn_while_armed_records_no_sample() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut landed = Vec::new();
    for frame in 0..4u64 {
        wait(&gpu);
        let Some(times) = renderer.arm_node_timer(&gpu.queue, frame) else { return };
        landed.extend(times);
        // Frames 0..4 are a settled capture's re-renders, armed by mistake.
        renderer.set_history_set(HistorySet::Capture);
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("capture frame");
    }
    renderer.set_history_set(HistorySet::Live);
    for frame in 100..100 + LANDING_FRAMES {
        wait(&gpu);
        landed.extend(renderer.arm_node_timer(&gpu.queue, frame).unwrap_or_default());
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("Live frame");
    }
    assert!(landed.iter().all(|frame| frame.frame >= 100), "no capture frame was timed: {:?}", landed.iter().map(|frame| frame.frame).collect::<Vec<_>>());
    assert!(!landed.is_empty(), "the Live frames after it are timed");
}

#[test]
#[ignore = "needs a GPU: run with --ignored metal"]
fn metal_an_armed_frame_captures_byte_identical_to_its_unarmed_twin() {
    let Some(gpu) = gpu() else { return };
    let mut renderer = Renderer::new(&gpu, WIDTH, HEIGHT).expect("renderer");
    let mut twin = Renderer::new(&gpu, WIDTH, HEIGHT).expect("twin");
    for frame in 0..4u64 {
        let armed = renderer.arm_node_timer(&gpu.queue, frame).is_some();
        renderer.render(&gpu, &scene(), CullPath::Gpu).expect("armed frame");
        twin.render(&gpu, &scene(), CullPath::Gpu).expect("twin frame");
        let ours = renderer.capture(&gpu).expect("capture");
        let theirs = twin.capture(&gpu).expect("twin capture");
        assert_eq!(ours.digest(), theirs.digest(), "frame {frame} (armed: {armed})");
    }
}
