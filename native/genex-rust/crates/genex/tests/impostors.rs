//! A model's impostor through the facade (game systems LOD-16): `Model::with_impostor` bakes the
//! model's parts on the GPU once they are loaded, a capture waits for the bakes and is repeatable,
//! Live bakes lazily (one a frame, the last mesh level standing in), a device loss bakes again and
//! the next capture matches, an empty model is refused `impostor-invalid`, and
//! `volatile.render.lod` lists the baked impostors.
//!
//! The GPU rows skip without a WebGPU-core adapter unless `GENEX_REQUIRE_METAL=1`; with
//! `GENEX_RENDER_EVIDENCE_DIR` set they write their captures there as PNGs.

use std::path::Path;

use genex::present::{AssetCache, BakeTally, LodRefused, ModelSource, Presenter, Uploads, drawn_of};
use genex::prelude::*;
use genex::{Impostor, ImpostorLayout, LodRefusalCode, Runtime, View};
use genex_render::RenderError;
use genex_render::device_loss::ModelParts;
use genex_render::mesh::MeshData;
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use serde_json::{Value, json};

/// The world the GPU rows draw at.
const WORLD: [u32; 2] = [320, 240];
/// How far the trees stand from the camera: well past the impostor switch (about 30 m for a 10 m
/// tree at this size), well inside the far plane.
const FAR_M: f32 = 90.0;

// ---------------------------------------------------------------------------------------------
// GLB fixtures.

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

/// A GLB whose parts are `parts` (each a triangle soup with a base colour of its own).
fn glb_of(parts: &[(Vec<[f32; 3]>, [f32; 4])]) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let (mut views, mut accessors, mut primitives, mut materials) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    for (at, (positions, color)) in parts.iter().enumerate() {
        let floats: Vec<u8> = positions.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
        let indices: Vec<u8> = (0..positions.len() as u32).flat_map(u32::to_le_bytes).collect();
        let min: Vec<f32> = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::INFINITY, f32::min)).collect();
        let max: Vec<f32> = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::NEG_INFINITY, f32::max)).collect();
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": floats.len() }));
        bin.extend(&floats);
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": indices.len() }));
        bin.extend(&indices);
        accessors.push(json!({ "bufferView": 2 * at, "componentType": 5126, "count": positions.len(), "type": "VEC3", "min": min, "max": max }));
        accessors.push(json!({ "bufferView": 2 * at + 1, "componentType": 5125, "count": positions.len(), "type": "SCALAR" }));
        primitives.push(json!({ "attributes": { "POSITION": 2 * at }, "indices": 2 * at + 1, "material": at }));
        materials.push(json!({ "pbrMetallicRoughness": { "baseColorFactor": color, "metallicFactor": 0.0, "roughnessFactor": 0.9 } }));
    }
    let gltf = json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": accessors,
        "materials": materials,
        "meshes": [{ "primitives": primitives }],
        "nodes": [{ "mesh": 0 }], "scenes": [{ "nodes": [0] }], "scene": 0,
    });
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

/// A tree stand-in: a brown trunk and a green crown, 10 m tall.
fn tree_glb() -> Vec<u8> {
    glb_of(&[(cuboid([-0.4, 0.0, -0.4], [0.4, 5.0, 0.4]), [0.35, 0.2, 0.1, 1.0]), (cuboid([-2.5, 4.0, -2.5], [2.5, 10.0, 2.5]), [0.1, 0.5, 0.15, 1.0])])
}

/// A GLB with a primitive and no triangles (two indices).
fn empty_glb() -> Vec<u8> {
    let mut parts = vec![(vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]], [1.0, 1.0, 1.0, 1.0])];
    parts[0].0.truncate(2);
    glb_of(&parts)
}

/// A folder of its own under the system's temporary folder holding `files`.
fn folder(label: &str, files: &[(&str, Vec<u8>)]) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("genex-impostors-{label}-{}", std::process::id()));
    for (name, bytes) in files {
        let path = dir.join(name);
        std::fs::create_dir_all(path.parent().expect("a folder")).expect("folder");
        std::fs::write(&path, bytes).expect("written");
    }
    dir
}

fn open_presenter(root: &Path) -> Option<Presenter> {
    let require = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|v| v == "1");
    match Presenter::open_with_root(WORLD, &[], Some(root.to_owned())) {
        Ok(presenter) => Some(presenter),
        Err(error) if require => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
        Err(_) => None,
    }
}

#[derive(Default)]
struct World {
    trees: Vec<Model>,
}

/// A game drawing `count` trees with impostors (or without), side by side `FAR_M` away.
fn runtime(count: usize, impostors: bool) -> Runtime<World> {
    let mut game = Game::new(World::default()).title("Impostors").world_size(WORLD[0], WORLD[1]);
    game.camera(|_| Camera::look_at(vec3(0.0, 5.0, FAR_M), vec3(0.0, 5.0, 0.0)));
    game.on_reset(move |sim, _, _, gfx| {
        sim.world.trees = (0..count)
            .map(|at| {
                let tree = gfx.assets().model(&format!("tree{at}.glb"));
                if impostors { tree.with_impostor(Impostor::hemi()) } else { tree }
            })
            .collect();
    });
    game.on_draw(move |sim, frame, _| {
        frame.sun(vec3(0.6, 0.8, 0.5), Color::WHITE, 3.0);
        frame.ambient(Color::WHITE, 0.4);
        let spread = sim.world.trees.len() as f32 - 1.0;
        for (at, tree) in sim.world.trees.iter().enumerate() {
            frame.model(tree, Transform::from_translation(vec3((at as f32 - spread * 0.5) * 12.0, 0.0, 0.0)));
        }
    });
    let mut runtime = Runtime::new(game).expect("valid registrations");
    runtime.seed(1);
    runtime.start();
    runtime.step(genex::FIXED_STEP_MS);
    runtime
}

/// One settled capture of `runtime` as BGRA (written as `<name>.png` to the evidence folder when
/// one is set).
fn capture(presenter: &mut Presenter, runtime: &mut Runtime<World>, name: &str) -> Vec<u8> {
    presenter.set_capturing(true);
    presenter.draw_view(runtime, View::Game).expect("game view").expect("drawn");
    assert_eq!(presenter.failure(), None);
    let capture = presenter.resilient.capture().expect("capture");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let root = Path::new(&dir).join("lod-16").join(name);
        let mut files = genex_render::capture::CaptureFiles::new(&root).expect("evidence folder");
        files.write(&capture).expect("evidence");
    }
    capture.bgra().to_vec()
}

/// Copies drawn as impostors by the last frame.
fn impostors_drawn(presenter: &Presenter) -> usize {
    presenter.resilient.renderer().renderer().impostor_draw().map_or(0, |draw| draw.rows().len())
}

/// The share of pixels of two BGRA captures differing by more than `step` in a channel.
fn share_past(a: &[u8], b: &[u8], step: u8) -> f64 {
    let past = a.as_chunks::<4>().0.iter().zip(b.as_chunks::<4>().0).filter(|(p, q)| (0..3).any(|c| p[c].abs_diff(q[c]) > step)).count();
    past as f64 / (a.len() / 4) as f64
}

fn tree_files(count: usize) -> Vec<(String, Vec<u8>)> {
    (0..count).map(|at| (format!("tree{at}.glb"), tree_glb())).collect()
}

fn files_ref(files: &[(String, Vec<u8>)]) -> Vec<(&str, Vec<u8>)> {
    files.iter().map(|(name, bytes)| (name.as_str(), bytes.clone())).collect()
}

// ---------------------------------------------------------------------------------------------
// GPU rows.

/// Red first (LOD-16): a capture bakes every impostor before it draws (a bake job per model,
/// counted by the `pipelines` stage's tally), the far tree draws as an impostor, and a second
/// capture of the same frame is the same picture. Before LOD-16 a model had no impostor to bake.
#[test]
fn a_capture_waits_for_bakes_and_is_repeatable() {
    let files = tree_files(1);
    let root = folder("capture", &files_ref(&files));
    let Some(mut presenter) = open_presenter(&root) else { return };
    let mut rt = runtime(1, true);
    let first = capture(&mut presenter, &mut rt, "capture-1");
    assert_eq!(presenter.impostor_tally(), BakeTally { submitted: 1, finished: 1 }, "the capture waited for its bake");
    assert_eq!(presenter.impostor_bakes(), 1);
    assert_eq!(impostors_drawn(&presenter), 1, "the far tree draws as its impostor");
    let second = capture(&mut presenter, &mut rt, "capture-2");
    assert_eq!(presenter.impostor_bakes(), 1, "baked once");
    assert_eq!(share_past(&first, &second, 0), 0.0, "repeatable to the bit");
    // The impostor stands in for the mesh: the picture is close to the mesh-only one.
    let mut mesh_presenter = open_presenter(&root).expect("a second presenter on the adapter");
    let mesh = capture(&mut mesh_presenter, &mut runtime(1, false), "mesh");
    assert_eq!(impostors_drawn(&mesh_presenter), 0);
    let differing = share_past(&first, &mesh, 24);
    assert!(differing < 0.02, "the impostor covers what the mesh covers: {differing}");
    let covered = first.as_chunks::<4>().0.iter().zip(mesh.as_chunks::<4>().0).filter(|(p, _)| p[1] > p[0] + 20).count();
    assert!(covered > 50, "the green crown is drawn: {covered} px");
    let lod = presenter.render_settings().expect("attached").borrow().status().lod;
    assert_eq!(lod.impostors.len(), 1, "{lod:?}");
    let stat = &lod.impostors[0];
    assert_eq!((stat.model.as_str(), stat.layout), ("tree0.glb", ImpostorLayout::Hemi));
    assert!(stat.bytes > 0 && stat.frames > 0 && stat.frame_px > 0, "{stat:?}");
    let wire = lod.to_json();
    assert_eq!(wire["impostors"][0]["model"], "tree0.glb");
    assert_eq!(wire["impostors"][0]["layout"], "hemi");
    assert!(wire["thresholdPx"].as_f64().is_some_and(|px| px > 0.0), "{wire}");
    assert_eq!(wire["species"], 1, "{wire}");
    assert!(wire["speciesCap"].as_u64().is_some_and(|cap| cap >= 1), "{wire}");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        std::fs::write(Path::new(&dir).join("lod-16").join("volatile-lod.json"), wire.to_string()).expect("evidence");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// Red first (LOD-16): Live bakes at most one impostor a frame; the models not baked yet draw their
/// last mesh level meanwhile, and every model is baked after as many frames as there are models.
#[test]
fn live_bakes_one_impostor_a_frame_and_the_rest_draw_their_mesh() {
    let files = tree_files(3);
    let root = folder("live", &files_ref(&files));
    let Some(mut presenter) = open_presenter(&root) else { return };
    let mut rt = runtime(3, true);
    let mut finished = Vec::new();
    for _ in 0..4 {
        presenter.draw_view(&mut rt, View::Game).expect("game view").expect("drawn");
        finished.push((presenter.impostor_tally().finished, impostors_drawn(&presenter)));
    }
    assert_eq!(finished, [(1, 1), (2, 2), (3, 3), (3, 3)], "(baked, drawn as impostors) per Live frame");
    if let Ok(dir) = std::env::var("GENEX_RENDER_EVIDENCE_DIR") {
        let lod = presenter.render_settings().expect("attached").borrow().status().lod;
        std::fs::write(Path::new(&dir).join("lod-16").join("volatile-lod-live.json"), lod.to_json().to_string()).expect("evidence");
    }
    let _ = std::fs::remove_dir_all(&root);
}

/// Red first (LOD-16): after a device loss the presenter bakes every impostor again on the new
/// device, and the next capture equals the one before the loss.
#[test]
fn device_loss_rebakes_and_the_next_frame_matches() {
    let files = tree_files(1);
    let root = folder("loss", &files_ref(&files));
    let Some(mut presenter) = open_presenter(&root) else { return };
    let mut rt = runtime(1, true);
    let before = capture(&mut presenter, &mut rt, "before-loss");
    presenter.resilient.force_device_loss();
    let lost = presenter.draw_view(&mut rt, View::Game).expect("game view");
    assert!(lost.is_err(), "the lost device refuses the frame");
    assert!(presenter.recover_for(&mut rt).expect("recovered"), "a new device");
    let after = capture(&mut presenter, &mut rt, "after-loss");
    assert_eq!(presenter.impostor_bakes(), 2, "baked again on the new device");
    assert_eq!(impostors_drawn(&presenter), 1);
    let differing = share_past(&before, &after, 1);
    assert_eq!(differing, 0.0, "the frame after the loss matches the one before (1 LSB)");
    let _ = std::fs::remove_dir_all(&root);
}

// ---------------------------------------------------------------------------------------------
// CPU rows.

/// A game's files, served from memory.
struct Files(Vec<(&'static str, Vec<u8>)>);

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.0.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// A renderer stand-in that hands out mesh ids.
#[derive(Default)]
struct Ids(u32);

impl Uploads for Ids {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.0 += 1;
        Ok(MeshId::from_raw(1 + self.0))
    }

    fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        Ok(parts.iter().map(|_| self.add_mesh(MeshData::default()).expect("an id")).collect())
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}

/// Red first (LOD-16): an impostor on an empty model is refused `impostor-invalid`: a missing
/// model at once, a GLB with no triangles at load; the model draws whole (the checker for the
/// missing one), nothing is baked, and `lodRefused` names it.
#[test]
fn impostor_invalid_on_an_empty_model() {
    let assets = Assets::default();
    let missing = Model::default().with_impostor(Impostor::hemi());
    assert_eq!(missing.lod_refusal(), Some(LodRefusalCode::ImpostorInvalid));
    assert_eq!(missing.impostor(), None, "refused: no impostor draws");
    let empty = assets.model("empty.glb").with_impostor(Impostor::sphere());
    assert_eq!(empty.lod_refusal(), None, "the triangles are only known at load");
    assert_eq!(empty.impostor().map(Impostor::layout), Some(ImpostorLayout::Sphere));
    let mut frame = Frame::default();
    frame.model(&empty, Transform::IDENTITY);
    let files = Files(vec![("empty.glb", empty_glb())]);
    let mut cache = AssetCache::default();
    cache.load(&frame, &files, &mut Ids::default(), &mut |_| {}).expect("no device loss");
    let camera = Camera::look_at(vec3(0.0, 0.0, 5.0), Vec3::ZERO);
    let drawn = drawn_of(&frame, &camera, &cache);
    assert_eq!(drawn.lod_refused, [LodRefused { model: "empty.glb".to_owned(), code: LodRefusalCode::ImpostorInvalid }]);
}

/// The impostor options keep their values and their wire spellings.
#[test]
fn impostor_options_and_wire_spellings() {
    assert_eq!(Impostor::hemi().layout(), ImpostorLayout::Hemi);
    assert_eq!(Impostor::hemi().not_before(40.0).not_before_m(), 40.0);
    for hostile in [f32::NAN, -1.0, 0.0, f32::INFINITY] {
        assert_eq!(Impostor::sphere().not_before(hostile), Impostor::sphere(), "{hostile} keeps no floor");
    }
    let wire: Vec<&str> = ImpostorLayout::ALL.iter().map(|layout| layout.wire()).collect();
    assert_eq!(wire, ["hemi", "sphere"]);
    assert_eq!(LodRefusalCode::ImpostorInvalid.wire(), "impostor-invalid");
}
