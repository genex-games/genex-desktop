//! The matched performance scene on the genex facade (M2.12c): `tests/conformance/rust-performance.test.ts`
//! compiles this file with rustc against the pond's release build (the dependency rlibs Cargo
//! reported) and runs it.
//!
//!   bench <scene.json>
//!
//! The scene is a genex game: its draw hook draws the ground, the water, the dock's planks, the rod
//! with its line and bobber, and `fish` spheres on fixed orbits around the dock, all from the
//! numbers in `scene.json` and the tick (no physics, no randomness, no assets, no HUD), so
//! `raylib/bench.cpp` can draw the same frame. It opens the headless GPU (the WebGPU-core floor a
//! game opens), seeds and starts the game, then runs `frames` live frames of `frameMs`: advance
//! the game, draw it through the GPU-culled path, and wait for the GPU, so a frame's time is its
//! CPU work plus GPU completion with no vsync. It prints one JSON line: the scene it drew, the
//! adapter, GPU open, pipeline compile, first frame, p50/p95/max frame time and capture latency.

use genex::Runtime;
use genex::math::{self, TAU};
use genex::prelude::*;
use genex_platform_web::{GameHandle, MeshCache, to_scene};
use genex_render::{CullPath, Gpu, Renderer};
use serde_json::Value as Json;
use std::time::Instant;

const GROUND: Color = Color::rgb(64, 112, 52);
const WATER: Color = Color::rgb(38, 92, 128);
const PLANK: Color = Color::rgb(140, 100, 60);
const ROD: Color = Color::rgb(112, 74, 40);
const LINE: Color = Color::rgb(230, 230, 220);
const BOBBER: Color = Color::rgb(220, 40, 40);
const FISH: [Color; 3] = [Color::rgb(232, 196, 64), Color::rgb(240, 240, 232), Color::rgb(96, 168, 96)];
const ROD_TIP: [f32; 3] = [0.0, 2.6, 7.5];
const BOBBER_AT: [f32; 3] = [0.0, 0.05, 2.0];

/// The scene's numbers, as `scene.json` gives them.
#[derive(Clone, Copy)]
struct Scene {
    world: [u32; 2],
    frames: usize,
    frame_ms: f64,
    fish: u32,
    fish_radius: f32,
    rings: u32,
    planks: u32,
    eye: [f32; 3],
    target: [f32; 3],
    fovy: f32,
    captures: usize,
}

fn number(json: &Json, key: &str) -> f64 {
    json[key].as_f64().unwrap_or_else(|| panic!("scene.json: {key} is not a number"))
}

fn triple(json: &Json, key: &str) -> [f32; 3] {
    let list = json[key].as_array().unwrap_or_else(|| panic!("scene.json: camera.{key} is not a list"));
    [0, 1, 2].map(|i| list[i].as_f64().expect("a number") as f32)
}

fn scene_of(json: &Json) -> Scene {
    let world = json["worldSize"].as_array().expect("scene.json: worldSize");
    let camera = &json["camera"];
    Scene {
        world: [world[0].as_u64().expect("width") as u32, world[1].as_u64().expect("height") as u32],
        frames: number(json, "frames") as usize,
        frame_ms: number(json, "frameMs"),
        fish: number(json, "fish") as u32,
        fish_radius: number(json, "fishRadius") as f32,
        rings: number(json, "schoolRings") as u32,
        planks: number(json, "planks") as u32,
        eye: triple(camera, "eye"),
        target: triple(camera, "target"),
        fovy: number(camera, "fovy") as f32,
        captures: number(json, "captures") as usize,
    }
}

/// The world: the tick, which every orbit is drawn from.
#[derive(Default)]
struct World {
    tick: u64,
}

/// Fish `index` at `tick`: ring `index % rings`, evenly spaced on it, circling the dock.
fn fish_at(scene: &Scene, index: u32, tick: u64) -> Vec3 {
    let ring = index % scene.rings;
    let per_ring = scene.fish.div_ceil(scene.rings);
    let slot = index / scene.rings;
    let radius = 3.0 + 1.1 * ring as f32;
    let speed = 0.004 + 0.0015 * ring as f32;
    let angle = TAU * slot as f32 / per_ring as f32 + speed * tick as f32;
    let (sin, cos) = math::sin_cos(angle);
    vec3(radius * cos, -0.3 + 0.08 * math::sin(angle * 3.0), radius * sin)
}

fn draw(scene: &Scene, world: &World, frame: &mut Frame) {
    frame.tag("ground").cube(Transform::from_xyz(0.0, -0.6, 0.0).with_scale(vec3(40.0, 1.0, 40.0)), GROUND);
    frame.tag("water").cube(Transform::from_xyz(0.0, -0.05, 0.0).with_scale(vec3(24.0, 0.1, 24.0)), WATER);
    frame.tag("dock");
    for plank in 0..scene.planks {
        let z = 8.0 - 0.3 * plank as f32;
        frame.cube(Transform::from_xyz(0.0, 0.1, z).with_scale(vec3(2.4, 0.08, 0.26)), PLANK);
    }
    let tip = Vec3::from_array(ROD_TIP);
    let bobber = Vec3::from_array(BOBBER_AT);
    frame.tag("rod").cube(Transform::from_xyz(0.0, 1.3, 8.4).with_scale(vec3(0.12, 2.6, 0.12)), ROD);
    frame.tag("bobber").sphere(bobber, 0.2, BOBBER).line(tip, bobber, LINE);
    frame.tag("fish");
    for index in 0..scene.fish {
        frame.sphere(fish_at(scene, index, world.tick), scene.fish_radius, FISH[(index % 3) as usize]);
    }
}

fn game(scene: Scene) -> Game<World> {
    let mut game = Game::new(World::default()).title("Bench").world_size(scene.world[0], scene.world[1]);
    game.on_update(|sim, _ctx| sim.world.tick += 1);
    game.on_draw(move |sim, frame, _camera| draw(&scene, &sim.world, frame));
    game.camera(move |_| {
        let mut camera = Camera::look_at(Vec3::from_array(scene.eye), Vec3::from_array(scene.target));
        camera.fovy = scene.fovy;
        camera
    });
    game
}

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let rank = ((p / 100.0) * (sorted.len() - 1) as f64).round() as usize;
    sorted[rank.min(sorted.len() - 1)]
}

fn render(game: &mut dyn GameHandle, gpu: &Gpu, renderer: &mut Renderer, meshes: &MeshCache) {
    let (frame, camera) = game.frame();
    renderer.render(gpu, &to_scene(&frame, &camera, meshes), CullPath::Gpu).expect("render");
    gpu.device.poll(wgpu::PollType::wait_indefinitely()).expect("poll");
}

fn main() {
    let process_start = Instant::now();
    let path = std::env::args().nth(1).expect("usage: bench <scene.json>");
    let text = std::fs::read_to_string(&path).expect("scene.json");
    let json: Json = serde_json::from_str(&text).expect("scene.json is JSON");
    let scene = scene_of(&json);
    let started = Instant::now();
    let gpu = Gpu::headless().expect("a WebGPU-core adapter");
    let gpu_open_ms = ms(started);
    let mut runtime = Runtime::new(game(scene)).expect("the bench installs");
    let game: &mut dyn GameHandle = &mut runtime;
    game.seed(genex::DEFAULT_SEED);
    let started = Instant::now();
    let mut renderer = Renderer::new(&gpu, scene.world[0], scene.world[1]).expect("renderer");
    let pipeline_ms = ms(started);
    let meshes = MeshCache::default();
    render(game, &gpu, &mut renderer, &meshes);
    let first_frame_ms = ms(process_start);
    game.start();
    let mut times = Vec::with_capacity(scene.frames);
    for _ in 0..scene.frames {
        let started = Instant::now();
        game.advance_live(scene.frame_ms);
        render(game, &gpu, &mut renderer, &meshes);
        times.push(ms(started));
    }
    let mut captures = Vec::with_capacity(scene.captures);
    for _ in 0..scene.captures {
        let started = Instant::now();
        let capture = renderer.capture(&gpu).expect("capture");
        captures.push(ms(started));
        std::hint::black_box(capture.digest());
    }
    times.sort_by(f64::total_cmp);
    captures.sort_by(f64::total_cmp);
    let line = serde_json::json!({
        "format": "genex-bench/1",
        "stack": "rust-wgpu",
        "scene": json,
        "adapter": gpu.receipt().adapter,
        "frames": scene.frames,
        "gpuOpenMs": gpu_open_ms,
        "pipelineCompileMs": pipeline_ms,
        "firstFrameMs": first_frame_ms,
        "frameMs": { "p50": percentile(&times, 50.0), "p95": percentile(&times, 95.0), "max": times.last().copied().unwrap_or(0.0) },
        "captureMs": { "p50": percentile(&captures, 50.0), "p95": percentile(&captures, 95.0) },
    });
    println!("{line}");
}
