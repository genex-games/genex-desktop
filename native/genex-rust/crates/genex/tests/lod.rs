//! A model's levels of detail through the facade (game systems LOD-07): authored levels
//! (`Model::with_levels`) become the renderer's chain at load and switch where the game's own
//! distance rule did; a level with another part count is refused `levels-mismatch` and the model
//! draws whole; every hostile option is refused with its typed code and no side effect; a
//! compound's parts measure from one sphere and switch together; the bias reaches the draws;
//! `state().__render.lodRefused` names refused models.
//!
//! Every row is CPU only: the cull's keep rule is genex-render's CPU twin (`lod_row_keep`), held
//! to the GPU cull by genex-render's own rows.

use std::cell::RefCell;

use genex::present::{AssetCache, LodRefused, ModelSource, Uploads, drawn_of, to_scene};
use genex::prelude::*;
use genex::{LOD_BIAS_MAX, LOD_BIAS_MIN, LodRefusalCode, Runtime, View};
use genex_render::RenderError;
use genex_render::device_loss::ModelParts;
use genex_render::lod_rows::DrawLod;
use genex_render::mesh::{MeshData, batch_lod, lod_row_keep};
use genex_render::scene::{MeshId, ModelPart};
use genex_render::texture::{TextureData, TextureId, TextureKind};
use serde_json::{Value, json};

/// The showcase's former hand-picked tree rule (24 and 58 m, LOD-08 replaced it with authored
/// levels): where its levels changed, in metres from the camera, scaled by the tree's size.
const TREE_LOD_DISTANCES: [f32; 2] = [24.0, 58.0];

/// The former rule's level at `distance` for a tree of `scale`.
fn tree_lod_at(distance: f32, scale: f32) -> usize {
    let [near, middle] = TREE_LOD_DISTANCES.map(|d| d * scale);
    if distance < near {
        0
    } else if distance < middle {
        1
    } else {
        2
    }
}

// ---------------------------------------------------------------------------------------------
// GLB fixtures: each part one primitive with a material of its own.

/// A column of `quads` stacked quads from y = 0 to `height`, `width` wide at x offset `x`: a
/// trunk or a crown stand-in, finer with more quads, the same extents at every level.
fn column(quads: u32, width: f32, height: f32, x: f32) -> Vec<[f32; 3]> {
    let step = height / quads as f32;
    (0..quads)
        .flat_map(|q| {
            let (y0, y1) = (q as f32 * step, (q + 1) as f32 * step);
            let (a, b) = (x - width * 0.5, x + width * 0.5);
            [[a, y0, 0.0], [b, y0, 0.0], [a, y1, 0.0], [b, y0, 0.0], [b, y1, 0.0], [a, y1, 0.0]]
        })
        .collect()
}

/// A GLB whose parts are `parts` (each a triangle soup, three positions a triangle).
fn glb_of(parts: &[Vec<[f32; 3]>]) -> Vec<u8> {
    let mut bin: Vec<u8> = Vec::new();
    let (mut views, mut accessors, mut primitives) = (Vec::new(), Vec::new(), Vec::new());
    for (at, positions) in parts.iter().enumerate() {
        let floats: Vec<u8> = positions.iter().flatten().flat_map(|f| f.to_le_bytes()).collect();
        let indices: Vec<u8> = (0..positions.len() as u32).flat_map(u32::to_le_bytes).collect();
        let min = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::INFINITY, f32::min)).collect::<Vec<f32>>();
        let max = (0..3).map(|i| positions.iter().map(|p| p[i]).fold(f32::NEG_INFINITY, f32::max)).collect::<Vec<f32>>();
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": floats.len() }));
        bin.extend(&floats);
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": indices.len() }));
        bin.extend(&indices);
        accessors.push(json!({ "bufferView": 2 * at, "componentType": 5126, "count": positions.len(), "type": "VEC3", "min": min, "max": max }));
        accessors.push(json!({ "bufferView": 2 * at + 1, "componentType": 5125, "count": positions.len(), "type": "SCALAR" }));
        primitives.push(json!({ "attributes": { "POSITION": 2 * at }, "indices": 2 * at + 1, "material": at }));
    }
    let materials: Vec<Value> = (0..parts.len()).map(|at| json!({ "name": format!("m{at}") })).collect();
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

/// A tree stand-in at three levels (one part each): 40, 12 and 3 quads, 10 m tall.
fn tree_files() -> Files {
    Files::new(vec![
        ("tree.glb", glb_of(&[column(40, 2.0, 10.0, 0.0)])),
        ("tree-lod1.glb", glb_of(&[column(12, 2.0, 10.0, 0.0)])),
        ("tree-lod2.glb", glb_of(&[column(3, 2.0, 10.0, 0.0)])),
        ("two-parts.glb", glb_of(&[column(6, 2.0, 10.0, 0.0), column(6, 1.0, 4.0, 3.0)])),
        ("wood.glb", glb_of(&[column(20, 0.5, 6.0, 0.0)])),
        ("wood-lod1.glb", glb_of(&[column(4, 0.5, 6.0, 0.0)])),
        ("foliage.glb", glb_of(&[column(30, 4.0, 4.0, 0.0).into_iter().map(|[x, y, z]| [x, y + 6.0, z]).collect()])),
        ("foliage-lod1.glb", glb_of(&[column(5, 4.0, 4.0, 0.0).into_iter().map(|[x, y, z]| [x, y + 6.0, z]).collect()])),
    ])
}

/// A game's files, recording every path read.
struct Files {
    files: Vec<(&'static str, Vec<u8>)>,
    read: RefCell<Vec<String>>,
}

impl Files {
    fn new(files: Vec<(&'static str, Vec<u8>)>) -> Files {
        Files { files, read: RefCell::new(Vec::new()) }
    }
}

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.read.borrow_mut().push(path.to_owned());
        self.files.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// A renderer stand-in that keeps every model's parts as uploaded.
#[derive(Default)]
struct Recording {
    models: Vec<ModelParts>,
    meshes: u32,
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.meshes += 1;
        Ok(MeshId::from_raw(1 + self.meshes))
    }

    fn add_model_parts(&mut self, parts: ModelParts) -> Result<Vec<MeshId>, RenderError> {
        let ids = parts
            .iter()
            .map(|_| {
                self.meshes += 1;
                MeshId::from_raw(1 + self.meshes)
            })
            .collect();
        self.models.push(parts);
        Ok(ids)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}

/// Load what `frame` draws from `files`.
fn load(frame: &Frame, files: &Files) -> (AssetCache, Recording, Vec<String>) {
    let (mut cache, mut uploads, mut lines) = (AssetCache::default(), Recording::default(), Vec::new());
    cache.load(frame, files, &mut uploads, &mut |line| lines.push(line.to_owned())).expect("no device loss");
    (cache, uploads, lines)
}

fn camera() -> Camera {
    Camera::look_at(Vec3::new(0.0, 5.0, 50.0), Vec3::new(0.0, 5.0, 0.0))
}

// ---------------------------------------------------------------------------------------------
// The cull's choice, on the CPU.

/// The pixels a world unit at distance 1 of the nominal view (1080 rows, 60° fov), over the
/// one-pixel threshold: the cull's `view.w`.
fn nominal_pixels_per_unit() -> f32 {
    genex_render::mesh::LOD_NOMINAL_HEIGHT as f32 * 0.5 / libm::tanf(30f32.to_radians()) / genex_render::mesh::LOD_THRESHOLD_PX
}

/// The level the cull keeps for a copy of `part` at `scale`, placed at the origin, seen from
/// `distance` metres to the nearest point of the sphere its levels measure from (`origin`, model
/// space; its own bounds when `None`).
fn picked_level(part: &ModelPart, scale: f32, distance: f32, origin: Option<[f32; 4]>) -> usize {
    let (center, radius) = part.mesh.bounds();
    let bounds = [center[0] * scale, center[1] * scale, center[2] * scale, radius * scale];
    let origin = origin.map_or(bounds, |[x, y, z, r]| [x * scale, y * scale, z * scale, r * scale]);
    let eye = [origin[0], origin[1], origin[2] + distance + origin[3]];
    picked_at(part, scale, eye, origin)
}

/// The level the cull keeps for a copy of `part` (scale 1, at the origin) seen from `eye`,
/// measured from the model-space sphere `origin` (its own bounds when `None`).
fn picked_from(part: &ModelPart, eye: [f32; 3], origin: Option<[f32; 4]>) -> usize {
    let (center, radius) = part.mesh.bounds();
    picked_at(part, 1.0, eye, origin.unwrap_or([center[0], center[1], center[2], radius]))
}

/// The level the cull keeps for a copy of `part` at `scale` seen from `eye`, measured from the
/// world sphere `origin`.
fn picked_at(part: &ModelPart, scale: f32, eye: [f32; 3], origin: [f32; 4]) -> usize {
    let errors = part.lods.as_ref().map(|chain| chain.errors()).unwrap_or_default();
    let (center, radius) = part.mesh.bounds();
    let bounds = [center[0] * scale, center[1] * scale, center[2] * scale, radius * scale];
    let view = [eye[0], eye[1], eye[2], nominal_pixels_per_unit()];
    let kept: Vec<usize> = (0..=errors.len()).filter(|level| lod_row_keep(batch_lod(*level as u32, &errors, radius), bounds, origin, view, 1.0, 0.0) == Some(1.0)).collect();
    assert_eq!(kept.len(), 1, "exactly one level keeps the copy seen from {eye:?}: {kept:?}");
    kept[0]
}

// ---------------------------------------------------------------------------------------------
// Rows.

/// New behaviour (LOD-07): authored levels pick the level the showcase's former hand-picked rule
/// (24 and 58 m) picked, at the nominal view, for copies of scale 1 and 1.4, on both sides of each
/// switch.
#[test]
fn authored_levels_pick_the_same_level_as_treelod_at_the_nominal_view() {
    let files = tree_files();
    let assets = Assets::default();
    let tree = assets.model("tree.glb").with_levels(&[(assets.model("tree-lod1.glb"), 24.0), (assets.model("tree-lod2.glb"), 58.0)]);
    assert_eq!(tree.lod_refusal(), None);
    let mut frame = Frame::default();
    frame.model(&tree, Transform::IDENTITY);
    let (cache, uploads, lines) = load(&frame, &files);
    assert!(lines.is_empty(), "nothing refused: {lines:?}");
    let [parts] = uploads.models.as_slice() else { panic!("one model uploaded: {}", uploads.models.len()) };
    let part = &parts[0];
    assert_eq!(part.lods.as_ref().map(|chain| chain.levels.len()), Some(2), "the two authored levels are its chain");
    for scale in [1.0, 1.4] {
        for metres in [1.0, 10.0, 23.8, 24.2, 40.0, 57.7, 58.3, 100.0, 300.0] {
            let distance = metres * scale;
            assert_eq!(picked_level(part, scale, distance, None), tree_lod_at(distance, scale), "scale {scale}, {distance} m");
        }
    }
    assert_eq!(drawn_of(&frame, &camera(), &cache).lod_refused, Vec::<LodRefused>::new());
}

/// New behaviour: a level whose GLB has another part count is refused `levels-mismatch` at load;
/// the model draws whole (its own parts, no chain) and `lodRefused` names it.
#[test]
fn a_level_with_another_part_count_is_refused_levels_mismatch_and_draws_whole() {
    let files = tree_files();
    let assets = Assets::default();
    let tree = assets.model("tree.glb").with_levels(&[(assets.model("two-parts.glb"), 24.0)]);
    assert_eq!(tree.lod_refusal(), None, "the part count is only known at load");
    let mut frame = Frame::default();
    frame.model(&tree, Transform::IDENTITY);
    let (cache, uploads, _) = load(&frame, &files);
    let plain = {
        let mut plain = Frame::default();
        plain.model(&assets.model("tree.glb"), Transform::IDENTITY);
        load(&plain, &tree_files()).1
    };
    assert_eq!(uploads.models, plain.models, "drawn whole: the parts a plain load uploads");
    let drawn = drawn_of(&frame, &camera(), &cache);
    assert_eq!(drawn.lod_refused, [LodRefused { model: "tree.glb".to_owned(), code: LodRefusalCode::LevelsMismatch }]);
    assert!(drawn.missing_models.is_empty(), "drawn, not the checker");
}

/// New behaviour: every hostile level table is refused `levels-invalid` with no side effect: the
/// model is the plain one apart from the refusal, nothing but its own GLB is read, it uploads what
/// a plain load uploads, and `lodRefused` names it.
#[test]
fn hostile_level_tables_refuse_levels_invalid_with_no_side_effect() {
    let assets = Assets::default();
    let lod1 = assets.model("tree-lod1.glb");
    let lod2 = assets.model("tree-lod2.glb");
    let nested = lod1.clone().with_levels(&[(lod2.clone(), 80.0)]);
    let compound = assets.compound(&[&lod1]);
    let cases: Vec<(&str, Vec<(Model, f32)>)> = vec![
        ("no levels", vec![]),
        ("a NaN distance", vec![(lod1.clone(), f32::NAN)]),
        ("an infinite distance", vec![(lod1.clone(), f32::INFINITY)]),
        ("a zero distance", vec![(lod1.clone(), 0.0)]),
        ("a negative distance", vec![(lod1.clone(), -5.0)]),
        ("descending distances", vec![(lod1.clone(), 58.0), (lod2.clone(), 24.0)]),
        ("equal distances", vec![(lod1.clone(), 24.0), (lod2.clone(), 24.0)]),
        ("too many levels", (1..=4).map(|k| (lod1.clone(), 10.0 * k as f32)).collect()),
        ("nested levels", vec![(nested, 24.0)]),
        ("a compound level", vec![(compound, 24.0)]),
        ("a missing level", vec![(Model::default(), 24.0)]),
        ("a `..` path", vec![(assets.model("../tree-lod1.glb"), 24.0)]),
        ("an absolute path", vec![(assets.model("/tree-lod1.glb"), 24.0)]),
    ];
    let plain_files = tree_files();
    let plain = {
        let mut frame = Frame::default();
        frame.model(&assets.model("tree.glb"), Transform::IDENTITY);
        load(&frame, &plain_files).1.models
    };
    let plain_reads = plain_files.read.borrow().clone();
    assert!(plain_reads.iter().all(|path| path == "tree.glb"), "{plain_reads:?}");
    for (name, levels) in cases {
        let tree = assets.model("tree.glb").with_levels(&levels);
        assert_eq!(tree.lod_refusal(), Some(LodRefusalCode::LevelsInvalid), "{name}");
        assert_eq!(tree.path(), Some("tree.glb"), "{name}");
        let files = tree_files();
        let mut frame = Frame::default();
        frame.model(&tree, Transform::IDENTITY);
        let (cache, uploads, _) = load(&frame, &files);
        assert_eq!(*files.read.borrow(), plain_reads, "{name}: what a plain load reads, no level");
        assert_eq!(uploads.models, plain, "{name}: drawn whole");
        let drawn = drawn_of(&frame, &camera(), &cache);
        assert_eq!(drawn.lod_refused, [LodRefused { model: "tree.glb".to_owned(), code: LodRefusalCode::LevelsInvalid }], "{name}");
        assert!(drawn.missing_models.is_empty(), "{name}");
    }
    // A level the game does not ship is only known at load: the same refusal, drawn whole.
    let tree = assets.model("tree.glb").with_levels(&[(assets.model("absent.glb"), 24.0)]);
    let mut frame = Frame::default();
    frame.model(&tree, Transform::IDENTITY);
    let (cache, uploads, _) = load(&frame, &tree_files());
    assert_eq!(uploads.models, plain, "an absent level: drawn whole");
    assert_eq!(drawn_of(&frame, &camera(), &cache).lod_refused, [LodRefused { model: "tree.glb".to_owned(), code: LodRefusalCode::LevelsInvalid }]);
}

/// New behaviour: a model that already has levels, or is a compound, takes no more.
#[test]
fn a_model_with_levels_or_a_compound_takes_no_levels() {
    let assets = Assets::default();
    let lod1 = assets.model("tree-lod1.glb");
    let leveled = assets.model("tree.glb").with_levels(&[(lod1.clone(), 24.0)]);
    assert_eq!(leveled.clone().with_levels(&[(assets.model("tree-lod2.glb"), 58.0)]).lod_refusal(), Some(LodRefusalCode::LevelsInvalid));
    let compound = assets.compound(&[&assets.model("wood.glb"), &assets.model("foliage.glb")]);
    assert_eq!(compound.with_levels(&[(lod1, 24.0)]).lod_refusal(), Some(LodRefusalCode::LevelsInvalid));
}

/// New behaviour: a compound's parts measure their levels from one sphere (around every member),
/// so a tree's wood and foliage switch at the same distance, while each part on its own would
/// switch at another; draws after it measure from their own bounds again.
#[test]
fn a_compounds_parts_measure_from_one_sphere_and_switch_together() {
    let files = tree_files();
    let assets = Assets::default();
    let wood = assets.model("wood.glb").with_levels(&[(assets.model("wood-lod1.glb"), 30.0)]);
    let foliage = assets.model("foliage.glb").with_levels(&[(assets.model("foliage-lod1.glb"), 30.0)]);
    let tree = assets.compound(&[&wood, &foliage]);
    assert_eq!((tree.lod_refusal(), tree.path()), (None, Some("wood.glb")));
    let mut frame = Frame::default();
    frame.model(&tree, Transform::IDENTITY);
    frame.model(&assets.model("tree.glb"), Transform::IDENTITY);
    let (cache, uploads, lines) = load(&frame, &files);
    assert!(lines.is_empty(), "{lines:?}");
    let scene = to_scene(&frame, &camera(), &cache);
    assert_eq!(scene.draws.len(), 3, "two parts of the compound, then the plain tree");
    let origin = scene.draws[0].lod.origin.expect("the compound names its sphere");
    assert_eq!(scene.draws[1].lod, scene.draws[0].lod, "both parts share it");
    assert_eq!(scene.draws[2].lod, DrawLod::OWN, "the next draw measures from its own bounds");
    // The sphere holds both members: the trunk from 0 m and the crown up to 10 m.
    assert!(origin[1] - origin[3] <= 0.0 && origin[1] + origin[3] >= 10.0, "{origin:?}");
    let [wood_parts, foliage_parts, _] = uploads.models.as_slice() else { panic!("three models: {}", uploads.models.len()) };
    let (wood_part, foliage_part) = (&wood_parts[0], &foliage_parts[0]);
    for metres in [5.0, 29.0, 29.9, 30.1, 31.0, 60.0] {
        let together = (picked_level(wood_part, 1.0, metres, Some(origin)), picked_level(foliage_part, 1.0, metres, Some(origin)));
        assert_eq!(together.0, together.1, "{metres} m from the compound's sphere");
        assert_eq!(together.0, usize::from(metres >= 30.0), "{metres} m");
    }
    // Measured from its own bounds the wood is farther away, so it would have switched sooner.
    let eye = [origin[0], origin[1], origin[2] + 29.0 + origin[3]];
    assert_eq!(picked_from(wood_part, eye, None), 1, "on its own the wood is past its switch");
    assert_eq!(picked_level(wood_part, 1.0, 29.0, Some(origin)), 0, "in the compound it is not");
}

/// New behaviour: a compound with no members, a missing member or a member that is a compound is
/// refused `compound-invalid`: it draws its first member whole (the checker with none) and
/// `lodRefused` names it.
#[test]
fn hostile_compounds_refuse_compound_invalid() {
    let assets = Assets::default();
    let wood = assets.model("wood.glb");
    let missing = Model::default();
    let inner = assets.compound(&[&wood]);
    let cases: Vec<(&str, Vec<&Model>, Option<&str>)> = vec![
        ("no members", vec![], None),
        ("a missing member", vec![&wood, &missing], Some("wood.glb")),
        ("an unsafe member", vec![&wood], Some("wood.glb")),
        ("a nested compound", vec![&wood, &inner], Some("wood.glb")),
    ];
    let unsafe_member = assets.model("../wood.glb");
    for (name, members, path) in cases {
        let members = if name == "an unsafe member" { vec![&wood, &unsafe_member] } else { members };
        let compound = assets.compound(&members);
        assert_eq!(compound.lod_refusal(), Some(LodRefusalCode::CompoundInvalid), "{name}");
        assert_eq!(compound.path(), path, "{name}: its first member draws");
        let mut frame = Frame::default();
        frame.model(&compound, Transform::IDENTITY);
        let (cache, uploads, _) = load(&frame, &tree_files());
        assert_eq!(uploads.models.len(), usize::from(path.is_some()), "{name}: only the first member loads");
        let drawn = drawn_of(&frame, &camera(), &cache);
        let model = path.unwrap_or_default().to_owned();
        assert_eq!(drawn.lod_refused, [LodRefused { model, code: LodRefusalCode::CompoundInvalid }], "{name}");
    }
}

/// New behaviour: the bias is clamped to its range and reaches the model's draws; a bias that is
/// not a number keeps the default, and a plain model's draws are unchanged.
#[test]
fn the_lod_bias_is_clamped_and_reaches_the_draws() {
    let files = tree_files();
    let assets = Assets::default();
    let bias_of = |model: &Model| {
        let mut frame = Frame::default();
        frame.model(model, Transform::IDENTITY);
        let (cache, _, _) = load(&frame, &files);
        to_scene(&frame, &camera(), &cache).draws[0].lod
    };
    let tree = assets.model("tree.glb");
    assert_eq!(bias_of(&tree), DrawLod::OWN);
    assert_eq!(bias_of(&tree.clone().with_lod_bias(2.0)).bias, 2.0);
    assert_eq!(bias_of(&tree.clone().with_lod_bias(100.0)).bias, LOD_BIAS_MAX);
    assert_eq!(bias_of(&tree.clone().with_lod_bias(0.0)).bias, LOD_BIAS_MIN);
    assert_eq!(bias_of(&tree.clone().with_lod_bias(f32::NAN)), DrawLod::OWN, "NaN keeps the default");
    assert_eq!(bias_of(&tree.clone().with_lod_bias(2.0)).origin, None, "a plain model measures from its own bounds");
    let leveled = tree.with_levels(&[(assets.model("tree-lod1.glb"), 24.0)]).with_lod_bias(2.0);
    assert_eq!((leveled.lod_refusal(), bias_of(&leveled).bias), (None, 2.0), "the bias after levels keeps them");
}

/// New behaviour: `state().__render.lodRefused` lists `[{model, code}]` while some are refused and
/// is absent otherwise; each drawn frame starts the list again.
#[test]
fn lod_refused_is_listed_only_while_some_are() {
    let mut game = Game::new(()).title("Levels");
    game.on_draw(|_, frame, _| {
        frame.cube(Transform::IDENTITY, Color::RED);
    });
    let mut rt = Runtime::new(game).expect("installs");
    rt.frame(View::Game).expect("the game's view");
    assert_eq!(rt.state()["__render"].get("lodRefused"), None, "absent when nothing is refused");
    rt.note_lod_refused(&[LodRefused { model: "tree.glb".to_owned(), code: LodRefusalCode::LevelsMismatch }]);
    assert_eq!(rt.state()["__render"]["lodRefused"], json!([{ "model": "tree.glb", "code": "levels-mismatch" }]));
    rt.frame(View::Game).expect("the next frame");
    assert_eq!(rt.state()["__render"].get("lodRefused"), None, "a new frame's tally starts empty");
}

/// Every refusal code's wire spelling, pinned.
#[test]
fn lod_refusal_codes_keep_their_wire_spellings() {
    let wire: Vec<&str> = LodRefusalCode::ALL.iter().map(|code| code.wire()).collect();
    assert_eq!(wire, ["levels-invalid", "levels-mismatch", "compound-invalid", "impostor-invalid"]);
}
