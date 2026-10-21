//! Rigid node clips through the facade (game systems AN-27): `gfx.node_clips` reads a GLB's node
//! animations, a `NodeAnimator` is the clip time (deterministic, probe-visible) and
//! `frame.model_posed` draws every node at its pose as one logical draw.
//!
//! The GPU rows skip without a WebGPU-core adapter unless `GENEX_REQUIRE_METAL=1`; with
//! `GENEX_RENDER_EVIDENCE_DIR` set they write their captures there (`an-27/<name>/captures`).

use std::path::Path;
use std::sync::LazyLock;

use genex::present::Presenter;
use genex::prelude::*;
use genex::{AnimationErrorCode, AssetTable, NodeAnimator, Runtime, Shape, View};
use serde_json::{Value, json};

/// The world the GPU rows draw at.
const WORLD: [u32; 2] = [256, 256];
/// The door's opening clip, in seconds.
const OPEN_S: f32 = 1.0;

// ---------------------------------------------------------------------------------------------
// GLB fixtures: a door (a slab hinged at the origin, 1 m wide along +x, 2 m tall) beside a fixed
// post, the door's node turning 90° about y over `OPEN_S`.

/// A closed box from `min` to `max`, as triangles.
fn cuboid(min: [f32; 3], max: [f32; 3]) -> Vec<[f32; 3]> {
    let [x0, y0, z0] = min;
    let [x1, y1, z1] = max;
    let quad = |a: [f32; 3], b: [f32; 3], c: [f32; 3], d: [f32; 3]| [a, b, c, a, c, d];
    [
        quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]),
        quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]),
        quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]),
        quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]),
        quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]),
        quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]),
    ]
    .concat()
}

/// The door slab in its node's space.
fn slab() -> Vec<[f32; 3]> {
    cuboid([0.0, 0.0, -0.05], [1.0, 2.0, 0.05])
}

/// The post, fixed, left of the hinge.
fn post() -> Vec<[f32; 3]> {
    cuboid([-0.3, 0.0, -0.1], [-0.1, 2.2, 0.1])
}

/// `points` turned 90° about y (x → -z).
fn turned(points: &[[f32; 3]]) -> Vec<[f32; 3]> {
    points.iter().map(|[x, y, z]| [*z, *y, -*x]).collect()
}

/// A GLB of `meshes` (one primitive each, with its colour), one node per mesh at the scene root,
/// and `animation` (a JSON animation over node 0 whose input and output floats follow) if any.
fn glb_of(meshes: &[(Vec<[f32; 3]>, [f32; 4])], animation: Option<(&[f32], &[[f32; 4]])>) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let (mut views, mut accessors, mut gltf_meshes, mut materials, mut nodes) = (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let mut view = |bin: &mut Vec<u8>, bytes: Vec<u8>| {
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": bytes.len() }));
        bin.extend(bytes);
        views.len() - 1
    };
    for (at, (positions, color)) in meshes.iter().enumerate() {
        let floats: Vec<u8> = positions.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
        let indices: Vec<u8> = (0..positions.len() as u32).flat_map(u32::to_le_bytes).collect();
        let min: Vec<f32> = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::INFINITY, f32::min)).collect();
        let max: Vec<f32> = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::NEG_INFINITY, f32::max)).collect();
        let positions_view = view(&mut bin, floats);
        let indices_view = view(&mut bin, indices);
        accessors.push(json!({ "bufferView": positions_view, "componentType": 5126, "count": positions.len(), "type": "VEC3", "min": min, "max": max }));
        accessors.push(json!({ "bufferView": indices_view, "componentType": 5125, "count": positions.len(), "type": "SCALAR" }));
        gltf_meshes.push(json!({ "primitives": [{ "attributes": { "POSITION": accessors.len() - 2 }, "indices": accessors.len() - 1, "material": at }] }));
        materials.push(json!({ "pbrMetallicRoughness": { "baseColorFactor": color, "metallicFactor": 0.0, "roughnessFactor": 0.8 } }));
        nodes.push(json!({ "mesh": at, "name": format!("node{at}") }));
    }
    let mut gltf = json!({
        "asset": { "version": "2.0" },
        "materials": materials,
        "meshes": gltf_meshes,
        "nodes": nodes,
        "scenes": [{ "nodes": (0..meshes.len()).collect::<Vec<_>>() }],
        "scene": 0,
    });
    if let Some((times, rotations)) = animation {
        let input = view(&mut bin, times.iter().flat_map(|t| t.to_le_bytes()).collect());
        let output = view(&mut bin, rotations.iter().flatten().flat_map(|f| f.to_le_bytes()).collect());
        accessors.push(json!({ "bufferView": input, "componentType": 5126, "count": times.len(), "type": "SCALAR", "min": [times[0]], "max": [times[times.len() - 1]] }));
        accessors.push(json!({ "bufferView": output, "componentType": 5126, "count": rotations.len(), "type": "VEC4" }));
        let (input, output) = (accessors.len() - 2, accessors.len() - 1);
        gltf["animations"] = json!([{ "name": "open", "samplers": [{ "input": input, "output": output, "interpolation": "LINEAR" }], "channels": [{ "sampler": 0, "target": { "node": 0, "path": "rotation" } }] }]);
    }
    gltf["accessors"] = json!(accessors);
    gltf["bufferViews"] = json!(views);
    gltf["buffers"] = json!([{ "byteLength": bin.len() }]);
    glb(&gltf, bin)
}

fn glb(gltf: &Value, mut bin: Vec<u8>) -> Vec<u8> {
    let mut json = serde_json::to_vec(gltf).expect("json");
    while !json.len().is_multiple_of(4) {
        json.push(b' ');
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + json.len() + 8 + bin.len()) as u32).to_le_bytes());
    out.extend((json.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&json);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(b"BIN\0");
    out.extend(&bin);
    out
}

const DOOR_COLOR: [f32; 4] = [0.6, 0.35, 0.15, 1.0];
const POST_COLOR: [f32; 4] = [0.2, 0.3, 0.7, 1.0];

/// The door: node 0 the slab (animated), node 1 the post.
static DOOR: LazyLock<&'static [u8]> = LazyLock::new(|| {
    let half = std::f32::consts::FRAC_1_SQRT_2;
    let rotations = [[0.0, 0.0, 0.0, 1.0], [0.0, half, 0.0, half]];
    Box::leak(glb_of(&[(slab(), DOOR_COLOR), (post(), POST_COLOR)], Some((&[0.0, OPEN_S], &rotations))).into_boxed_slice())
});
/// The same door already open, baked into its vertices, with no animation.
static OPEN_DOOR: LazyLock<&'static [u8]> = LazyLock::new(|| Box::leak(glb_of(&[(turned(&slab()), DOOR_COLOR), (post(), POST_COLOR)], None).into_boxed_slice()));

fn table() -> AssetTable {
    static TABLE: LazyLock<AssetTable> = LazyLock::new(|| Box::leak(vec![("door.glb", *DOOR), ("open-door.glb", *OPEN_DOOR)].into_boxed_slice()));
    *TABLE
}

// ---------------------------------------------------------------------------------------------
// The game.

#[derive(Default)]
struct World {
    door: Option<NodeAnimator>,
    model: Model,
    open: Model,
    refusal: Option<String>,
    missing_clip: Option<String>,
    ticks: u32,
}

/// The door game: the door opens once at tick 1, then from tick 120 swings in a loop; `posed`
/// draws it posed, else as a plain model (frozen). `reference` draws the baked open door instead.
fn door_game(posed: bool, reference: bool) -> Game<World> {
    let mut game = Game::new(World::default()).title("Doors").world_size(WORLD[0], WORLD[1]);
    game.camera(|_| Camera::look_at(vec3(0.5, 3.5, 3.0), vec3(0.2, 1.0, 0.0)));
    game.on_reset(|sim, _, _, gfx| {
        let clips = gfx.node_clips("door.glb").expect("the door's clips load");
        sim.world.door = Some(clips.animator());
        sim.world.model = gfx.assets().model("door.glb");
        sim.world.open = gfx.assets().model("open-door.glb");
        sim.world.refusal = gfx.node_clips("open-door.glb").err().map(|error| error.code.wire().to_owned());
        sim.world.missing_clip = sim.world.door.as_mut().and_then(|door| door.play("close").err()).map(|error| error.code.wire().to_owned());
    });
    game.on_update(|sim, ctx| {
        let world = &mut sim.world;
        world.ticks += 1;
        let Some(door) = world.door.as_mut() else { return };
        match world.ticks {
            1 => door.play_once("open").expect("the open clip"),
            120 => door.play("open").expect("the open clip"),
            _ => {}
        }
        door.update(ctx.dt);
    });
    game.on_draw(move |sim, frame, _| {
        frame.sun(vec3(0.4, 0.9, 0.6), Color::WHITE, 3.0);
        frame.ambient(Color::WHITE, 0.5);
        let Some(door) = &sim.world.door else { return };
        match (reference, posed) {
            (true, _) => frame.model(&sim.world.open, Transform::IDENTITY),
            (false, true) => frame.model_posed(&sim.world.model, door, Transform::IDENTITY),
            (false, false) => frame.model(&sim.world.model, Transform::IDENTITY),
        };
    });
    game.probe("door", |sim| sim.world.door.as_ref().map_or(Value::Null, NodeAnimator::probe));
    game.probe("ticks", |sim| json!(sim.world.ticks));
    game
}

fn runtime(posed: bool, reference: bool) -> Runtime<World> {
    let mut runtime = Runtime::with_assets(door_game(posed, reference), Box::new(table())).expect("valid game");
    runtime.seed(1);
    runtime.start();
    runtime
}

/// Ticks to `seconds` of simulated time at the fixed step.
fn ticks_for(seconds: f32) -> u32 {
    (f64::from(seconds) * 1000.0 / genex::FIXED_STEP_MS).round() as u32
}

// ---------------------------------------------------------------------------------------------
// CPU rows.

/// Red first (AN-27): a GLB with no animations is refused `animation-clip-missing`, and so is a
/// clip name the file does not have (the animator keeps its state).
#[test]
fn a_glb_with_no_animations_refuses_animation_clip_missing() {
    let rt = runtime(true, false);
    assert_eq!(rt.sim().world.refusal.as_deref(), Some("animation-clip-missing"));
    assert_eq!(rt.sim().world.missing_clip.as_deref(), Some("animation-clip-missing"));
    assert_eq!(AnimationErrorCode::ClipMissing.wire(), "animation-clip-missing");
}

/// Red first (AN-27): the door played once reaches its open pose at t = 1 s and holds it; the
/// probe shows the clip and its time.
#[test]
fn the_door_clip_turns_its_node_90_degrees_at_one_second() {
    let mut rt = runtime(true, false);
    rt.step(f64::from(ticks_for(OPEN_S) + 1) * genex::FIXED_STEP_MS);
    let probe = rt.probes()["door"].clone();
    assert_eq!(probe["clip"], "open");
    assert_eq!(probe["once"], true);
    assert_eq!(probe["finished"], true, "{probe}");
    assert!((probe["time"].as_f64().expect("a time") - f64::from(OPEN_S)).abs() < 1e-6, "{probe}");
    let frame = rt.frame(View::Game).expect("the game's view");
    let palette = frame.draws().iter().find_map(|draw| match &draw.shape {
        Shape::Posed { palette, .. } => Some(palette.clone()),
        _ => None,
    });
    let palette = palette.expect("one posed draw");
    let door = glam::Mat4::from_cols_array(&palette[0]);
    let x = door.transform_vector3(Vec3::X);
    assert!((x - Vec3::new(0.0, 0.0, -1.0)).length() < 1e-5, "the door's +x turned to -z: {x}");
    let post = glam::Mat4::from_cols_array(&palette[1]);
    assert!(post.abs_diff_eq(glam::Mat4::IDENTITY, 1e-6), "the post stays: {post}");
    assert_eq!(frame.draw_calls(), 1, "one logical draw per model");
}

/// Red first (AN-27): 600 ticks replay bit-exact: two runs give the same probes and checksum at
/// every 50th tick, and the same palettes.
#[test]
fn six_hundred_ticks_replay_bit_exact() {
    let run = || {
        let mut rt = runtime(true, false);
        let mut seen = Vec::new();
        for _ in 0..12 {
            rt.step(50.0 * genex::FIXED_STEP_MS);
            let frame = rt.frame(View::Game).expect("the game's view");
            let palette: Vec<u32> = frame
                .draws()
                .iter()
                .filter_map(|draw| match &draw.shape {
                    Shape::Posed { palette, .. } => Some(palette.iter().flatten().map(|f| f.to_bits()).collect::<Vec<u32>>()),
                    _ => None,
                })
                .flatten()
                .collect();
            seen.push((rt.probes(), rt.checksum(), palette));
        }
        seen
    };
    let (first, second) = (run(), run());
    assert_eq!(first.len(), 12);
    assert_eq!(first[11].0["ticks"], json!(600));
    assert_eq!(first, second, "600 ticks replay bit-exact");
    assert_ne!(first[2].0["door"], first[3].0["door"], "the looping door moves");
}

// ---------------------------------------------------------------------------------------------
// GPU rows.

fn open_presenter() -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open(WORLD, table()) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => None,
    }
}

/// One capture of `runtime` as BGRA (written to the evidence folder when one is set).
fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> Vec<u8> {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    assert_eq!(presenter.failure(), None);
    let capture = presenter.resilient.capture().expect("capture");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let root = Path::new(&dir).join("an-27").join(name);
        let mut files = genex_render::capture::CaptureFiles::new(&root).expect("evidence folder");
        files.write(&capture).expect("evidence");
    }
    capture.bgra().to_vec()
}

/// The share of pixels of two BGRA captures differing by more than `step` in a channel.
fn share_past(a: &[u8], b: &[u8], step: u8) -> f64 {
    let past = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..3).any(|c| p[c].abs_diff(q[c]) > step)).count();
    past as f64 / (a.len() / 4) as f64
}

/// Red first (AN-27): at t = 1 s the posed door draws like the same door baked open, while the
/// door drawn as a plain model stays shut (node animations frozen, as before AN-27).
#[test]
fn the_posed_door_draws_open_at_one_second_and_the_plain_model_stays_shut() {
    let Some(mut presenter) = open_presenter() else { return };
    let opened = |posed: bool, reference: bool| {
        let mut rt = runtime(posed, reference);
        rt.step(f64::from(ticks_for(OPEN_S) + 1) * genex::FIXED_STEP_MS);
        rt
    };
    let posed = capture(&mut presenter, &mut opened(true, false), "posed-open");
    let reference = capture(&mut presenter, &mut opened(false, true), "baked-open");
    let frozen = capture(&mut presenter, &mut opened(false, false), "plain-shut");
    let posed_vs_reference = share_past(&posed, &reference, 8);
    let frozen_vs_reference = share_past(&frozen, &reference, 8);
    assert!(posed_vs_reference < 0.002, "the posed door is the open door: {posed_vs_reference}");
    assert!(frozen_vs_reference > 0.02, "the plain model stays shut: {frozen_vs_reference}");
}
