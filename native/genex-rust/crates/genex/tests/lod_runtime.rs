//! Runtime LOD chains through the facade (game systems LOD-21): a model whose GLB the import step
//! did not simplify uploads with genex-render's runtime chain, and a device-loss replay rebuilds
//! the same chain from the program's bytes; an imported chain and authored levels are left as
//! they were. CPU only: the chain's own rows are genex-render's `mesh_lod_runtime`.

use genex::present::{AssetCache, ModelSource, Uploads};
use genex::prelude::*;
use genex_render::RenderError;
use genex_render::device_loss::{ModelParts, PartsSource};
use genex_render::mesh::{GlbModel, MeshData};
use genex_render::scene::MeshId;
use genex_render::texture::{TextureData, TextureId, TextureKind};
use serde_json::Value;

/// The repository's asset-import fixtures.
fn import_fixture(name: &str) -> Vec<u8> {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../../tests/fixtures/asset-import").join(name);
    std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// The golden sphere without its `genex_lods`: a GLB the import step never simplified.
fn unimported_sphere() -> Vec<u8> {
    let glb = import_fixture("lods-sphere.glb");
    let json_len = u32::from_le_bytes(glb[12..16].try_into().expect("length")) as usize;
    let mut json: Value = serde_json::from_slice(&glb[20..20 + json_len]).expect("json");
    for primitive in json["meshes"][0]["primitives"].as_array_mut().expect("primitives") {
        if let Some(extras) = primitive["extras"].as_object_mut() {
            extras.remove("genex_lods");
        }
    }
    let mut text = serde_json::to_vec(&json).expect("json");
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let bin = &glb[20 + json_len..];
    let mut out = Vec::new();
    out.extend(b"glTF");
    out.extend(2u32.to_le_bytes());
    out.extend(((12 + 8 + text.len() + bin.len()) as u32).to_le_bytes());
    out.extend((text.len() as u32).to_le_bytes());
    out.extend(b"JSON");
    out.extend(&text);
    out.extend(bin);
    out
}

/// A game's compiled-in files: bytes the program holds for its whole life, so uploads replay.
struct Files(Vec<(&'static str, &'static [u8])>);

impl ModelSource for Files {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.static_bytes(path).map(<[u8]>::to_vec)
    }

    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        self.0.iter().find(|(known, _)| *known == path).map(|(_, bytes)| *bytes)
    }
}

/// A renderer stand-in keeping each model's uploaded parts and what its replay source rebuilds.
#[derive(Default)]
struct Recording {
    models: Vec<ModelParts>,
    replays: Vec<ModelParts>,
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

    fn add_meshes_from(&mut self, parts: ModelParts, source: PartsSource) -> Result<Vec<MeshId>, RenderError> {
        self.replays.push(source()?);
        self.add_model_parts(parts)
    }

    fn add_texture(&mut self, _data: &TextureData, kind: TextureKind) -> Result<TextureId, RenderError> {
        Ok(TextureId::new(kind, 0))
    }
}

/// Load one model at `path` from `files`.
fn load(path: &str, files: &Files) -> (Recording, Vec<String>) {
    let assets = Assets::default();
    let mut frame = Frame::default();
    frame.model(&assets.model(path), Transform::IDENTITY);
    let (mut cache, mut uploads, mut lines) = (AssetCache::default(), Recording::default(), Vec::new());
    cache.load(&frame, files, &mut uploads, &mut |line| lines.push(line.to_owned())).expect("no device loss");
    (uploads, lines)
}

fn leak(bytes: Vec<u8>) -> &'static [u8] {
    Box::leak(bytes.into_boxed_slice())
}

/// New behaviour (LOD-21): an unimported GLB uploads with a runtime chain, says nothing in the
/// log, and its replay source rebuilds the same chain bit for bit.
#[test]
fn an_unimported_model_uploads_with_a_runtime_chain_its_replay_rebuilds() {
    let files = Files(vec![("sphere.glb", leak(unimported_sphere()))]);
    let (uploads, lines) = load("sphere.glb", &files);
    assert!(lines.is_empty(), "a built chain is the ordinary case: {lines:?}");
    let [parts] = uploads.models.as_slice() else { panic!("one model: {}", uploads.models.len()) };
    let levels = parts[0].lods.as_ref().map(|chain| chain.levels.len());
    assert!(matches!(levels, Some(1..=4)), "a runtime chain: {levels:?}");
    assert_eq!(uploads.replays.as_slice(), std::slice::from_ref(parts), "the replay rebuilds the same chain");
}

/// An imported chain uploads as the importer wrote it, and its replay keeps it.
#[test]
fn an_imported_chain_uploads_as_the_importer_wrote_it() {
    let golden = import_fixture("lods-sphere.glb");
    let imported = GlbModel::parts_from_glb(&golden).expect("loads");
    let files = Files(vec![("sphere.glb", leak(golden))]);
    let (uploads, _) = load("sphere.glb", &files);
    assert_eq!(uploads.models, vec![imported.clone()]);
    assert_eq!(uploads.replays, vec![imported]);
}

/// A model whose authored levels are refused still draws whole, with no runtime chain.
#[test]
fn a_model_whose_authored_levels_are_refused_draws_whole() {
    let files = Files(vec![("sphere.glb", leak(unimported_sphere()))]);
    let assets = Assets::default();
    let sphere = assets.model("sphere.glb").with_levels(&[(assets.model("missing.glb"), 20.0)]);
    let mut frame = Frame::default();
    frame.model(&sphere, Transform::IDENTITY);
    let (mut cache, mut uploads, mut lines) = (AssetCache::default(), Recording::default(), Vec::new());
    cache.load(&frame, &files, &mut uploads, &mut |line| lines.push(line.to_owned())).expect("no device loss");
    let [parts] = uploads.models.as_slice() else { panic!("one model") };
    assert!(parts.iter().all(|part| part.lods.is_none()), "drawn whole");
    assert!(uploads.replays.iter().flatten().all(|part| part.lods.is_none()), "its replay too");
}
