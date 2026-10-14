//! Meshlets through the facade (R2.6): a model's imported clusters (`genex_meshlets` GLB extras,
//! R2.3) reach the renderer with its parts, and the game's [`Meshlets`] setting
//! (`RenderConfig::meshlets`, the `genex.toml` `[render.meshlets]` table) is the one the
//! presenter's renderer clusters by.
//!
//! The CPU rows run everywhere. The GPU rows are `#[ignore]`d and every name contains `metal`:
//!
//!   GENEX_REQUIRE_METAL=1 node scripts/toolchains/rust-env.ts -- cargo test -p genex --offline \
//!     --locked --test meshlets -- --ignored metal

use std::cell::RefCell;

use genex::present::{AssetCache, ModelSource, Uploads};
use genex::{Assets, Frame, Transform};
use genex_render::RenderError;
use genex_render::mesh::MeshData;
use genex_render::meshlet::{self, MeshletSet};
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use serde_json::{Value, json};

/// Quads of the strip the GLB holds (two vertices per column).
const STRIP_QUADS: u32 = 40;

/// A strip of quads and the set the runtime clusterizer builds for it (the importer's stand-in).
fn strip() -> (Vec<[f32; 3]>, Vec<u32>, MeshletSet) {
    let positions: Vec<[f32; 3]> = (0..=STRIP_QUADS).flat_map(|i| [[i as f32, 0.0, 0.0], [i as f32, 1.0, 0.0]]).collect();
    let indices: Vec<u32> = (0..STRIP_QUADS).flat_map(|q| [2 * q, 2 * q + 1, 2 * q + 2, 2 * q + 1, 2 * q + 3, 2 * q + 2]).collect();
    let set = meshlet::build(&indices, &positions).expect("the strip clusters");
    (positions, indices, set)
}

fn le<T: Copy>(values: impl IntoIterator<Item = T>, bytes: impl Fn(T) -> [u8; 4]) -> Vec<u8> {
    values.into_iter().flat_map(bytes).collect()
}

/// The strip as a GLB, its set in `extras.genex_meshlets` when `carry`.
fn strip_glb(carry: bool) -> Vec<u8> {
    let extras = if carry {
        json!({ "genex_meshlets": { "version": 1, "max_vertices": 64, "max_triangles": 124, "meshlets": 2, "vertices": 3, "triangles": 4 } })
    } else {
        json!({})
    };
    strip_glb_with(extras)
}

/// The strip as a GLB with `extras` on its primitive (the set's buffer views are always there).
fn strip_glb_with(extras: Value) -> Vec<u8> {
    let (positions, indices, set) = strip();
    let records: Vec<u8> = set
        .meshlets
        .iter()
        .flat_map(|m| {
            let floats = m.bounds.iter().chain(&m.cone).flat_map(|f| f.to_le_bytes());
            let words = [m.vertex_offset, m.triangle_offset, m.vertex_count, m.triangle_count].into_iter().flat_map(u32::to_le_bytes);
            floats.chain(words).collect::<Vec<u8>>()
        })
        .collect();
    let parts = [
        le(positions.iter().flatten().copied(), f32::to_le_bytes),
        le(indices.iter().copied(), u32::to_le_bytes),
        records,
        le(set.vertices.iter().copied(), u32::to_le_bytes),
        le(set.triangles.iter().copied(), u32::to_le_bytes),
    ];
    let mut bin = Vec::new();
    let mut views = Vec::new();
    for part in &parts {
        views.push(json!({ "buffer": 0, "byteOffset": bin.len(), "byteLength": part.len() }));
        bin.extend(part);
    }
    let max = [STRIP_QUADS as f32, 1.0, 0.0];
    let gltf = json!({
        "asset": { "version": "2.0" },
        "buffers": [{ "byteLength": bin.len() }],
        "bufferViews": views,
        "accessors": [
            { "bufferView": 0, "componentType": 5126, "count": positions.len(), "type": "VEC3", "min": [0, 0, 0], "max": max },
            { "bufferView": 1, "componentType": 5125, "count": indices.len(), "type": "SCALAR" }],
        "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "indices": 1, "extras": extras }] }],
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

struct Files(Vec<(&'static str, Vec<u8>)>);

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.0.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.clone())
    }
}

/// A renderer stand-in that records the imported set each mesh came with.
#[derive(Default)]
struct Recording {
    sets: RefCell<Vec<Option<MeshletSet>>>,
}

impl Uploads for Recording {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.sets.borrow_mut().push(None);
        Ok(MeshId::from_raw(1 + self.sets.borrow().len() as u32))
    }

    fn add_meshes_with_meshlets(&mut self, parts: Vec<(MeshData, Option<MeshletSet>)>) -> Result<Vec<MeshId>, RenderError> {
        let first = self.sets.borrow().len() as u32;
        self.sets.borrow_mut().extend(parts.into_iter().map(|(_, set)| set));
        Ok((first..self.sets.borrow().len() as u32).map(|n| MeshId::from_raw(2 + n)).collect())
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}

/// A stand-in written before meshlets: only the required methods.
#[derive(Default)]
struct Plain {
    meshes: u32,
}

impl Uploads for Plain {
    fn add_mesh(&mut self, _mesh: MeshData) -> Result<MeshId, RenderError> {
        self.meshes += 1;
        Ok(MeshId::from_raw(1 + self.meshes))
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}

fn load(files: &Files, uploads: &mut dyn Uploads) -> AssetCache {
    let assets = Assets::default();
    let mut frame = Frame::default();
    for (path, _) in &files.0 {
        frame.model(&assets.model(path), Transform::IDENTITY);
    }
    let mut cache = AssetCache::default();
    cache.load(&frame, files, uploads, &mut |line| panic!("nothing is refused: {line}")).expect("no device loss");
    cache
}

#[test]
fn a_models_imported_meshlets_reach_the_renderer_with_its_parts() {
    let files = Files(vec![("carrying.glb", strip_glb(true)), ("plain.glb", strip_glb(false))]);
    let mut uploads = Recording::default();
    let cache = load(&files, &mut uploads);
    assert!(cache.model("carrying.glb").is_some() && cache.model("plain.glb").is_some());
    let (_, _, set) = strip();
    assert_eq!(*uploads.sets.borrow(), [Some(set), None], "the importer's set with its part; none without extras");
}

/// R2 review: an importer and runtime disagreement is never silent. A GLB whose `genex_meshlets`
/// the renderer refuses still loads (the mesh clusters at runtime), and the load reports the typed
/// fault.
#[test]
fn a_refused_genex_meshlets_loads_the_model_and_reports_the_typed_warning() {
    let hostile = json!({ "genex_meshlets": { "version": 99, "max_vertices": 64, "max_triangles": 124, "meshlets": 2, "vertices": 3, "triangles": 4 } });
    let files = Files(vec![("hostile.glb", strip_glb_with(hostile))]);
    let mut uploads = Recording::default();
    let assets = Assets::default();
    let mut frame = Frame::default();
    frame.model(&assets.model("hostile.glb"), Transform::IDENTITY);
    let mut cache = AssetCache::default();
    let mut lines = Vec::new();
    cache.load(&frame, &files, &mut uploads, &mut |line| lines.push(line.to_owned())).expect("no device loss");
    assert!(cache.model("hostile.glb").is_some(), "the model still loads and draws");
    assert_eq!(*uploads.sets.borrow(), [None], "no set reaches the renderer: it clusters at runtime");
    let fault = genex_render::meshlet::MeshletFault::UnknownVersion.wire();
    assert!(lines.iter().any(|line| line.contains(fault)), "the load reports {fault}: {lines:?}");
}

#[test]
fn an_uploads_stand_in_without_the_meshlet_method_still_loads_every_model() {
    let files = Files(vec![("carrying.glb", strip_glb(true))]);
    let mut uploads = Plain::default();
    let cache = load(&files, &mut uploads);
    assert!(cache.model("carrying.glb").is_some());
    assert_eq!(uploads.meshes, 1, "the default drops the set and adds the mesh");
}

// ---------------------------------------------------------------------------------------------
// GPU rows (Metal): the presenter's renderer clusters by the game's setting

mod metal {
    use genex::prelude::*;
    use genex::present::Presenter;
    use genex::render::{Meshlets, RenderConfig};
    use genex::{Runtime, View};

    fn presenter() -> Option<Presenter> {
        let required = std::env::var("GENEX_REQUIRE_METAL").is_ok_and(|value| value == "1");
        match Presenter::open([160, 90], &[]) {
            Ok(presenter) => Some(presenter),
            Err(error) if required => panic!("GENEX_REQUIRE_METAL=1 and no WebGPU-core adapter: {error}"),
            Err(error) => {
                eprintln!("skipped: no WebGPU-core adapter ({error})");
                None
            }
        }
    }

    #[derive(Default)]
    struct Scene;

    fn game(config: Option<RenderConfig>) -> Game<Scene> {
        let mut game = Game::new(Scene).world_size(160, 90);
        game.camera(|_| Camera::look_at(vec3(3.0, 3.0, 6.0), Vec3::ZERO));
        game.on_draw(|_, frame, _| {
            frame.cube(Transform::IDENTITY, Color::RED);
        });
        if let Some(config) = config {
            game.render_settings(config);
        }
        game
    }

    fn drawn_setting(config: Option<RenderConfig>) -> Option<Meshlets> {
        let mut presenter = presenter()?;
        let mut runtime = Runtime::new(game(config)).expect("installs");
        presenter.draw_view(&mut runtime, View::Game)?.expect("Live");
        let live = presenter.resilient.renderer().renderer().meshlet_setting();
        presenter.set_capturing(true);
        presenter.draw_view(&mut runtime, View::Game)?.expect("capture");
        let captured = presenter.resilient.renderer().renderer().meshlet_setting();
        assert_eq!(live, captured, "Live and the capture cluster alike");
        Some(live)
    }

    #[test]
    #[ignore = "needs the host GPU: run with --ignored metal"]
    fn metal_the_presenters_renderer_clusters_by_the_games_meshlet_setting() {
        let Some(default) = drawn_setting(None) else { return };
        assert_eq!(default, Meshlets::DEFAULT, "a game that says nothing keeps the default");
        let narrowed = Meshlets::DEFAULT.with_occlusion(false).with_min_triangles(4096);
        assert_eq!(drawn_setting(Some(RenderConfig::new().meshlets(narrowed))), Some(narrowed), "the game's narrowed setting");
        let off = Meshlets::DEFAULT.with_enabled(false);
        assert_eq!(drawn_setting(Some(RenderConfig::new().meshlets(off))), Some(off), "the game's opt-out");
    }
}
