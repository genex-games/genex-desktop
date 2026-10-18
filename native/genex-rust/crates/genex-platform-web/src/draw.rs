//! Where a web build's models come from, and the part-1 bridge the phone shells still draw with.
//!
//! The web shell draws through genex's shared presenter (`genex::present::Presenter`, the one a
//! native run draws with): [`WebModels`] is its model source, the table compiled into the module
//! first, then the staged files the shell fetched (`crate::assets`).
//!
//! The bridge from what a draw hook wrote (a facade [`Frame`] seen from a [`Camera`]) to a
//! part-1 [`Scene`] ([`to_scene`], [`MeshCache`]) stays for the iOS shell and the self-test
//! harness, which have not moved to the presenter yet. It is the presenter's own conversion
//! (`genex::present::to_scene`, lights and materials included) over the presenter's asset cache,
//! so the bridge draws the scene native and web draw. Models are GLB files from the game's assets
//! (an [`AssetSource`]), loaded into the renderer's mesh library once per path, one mesh per
//! material. A model whose file is missing or malformed draws the magenta checker cube, as the
//! C++ runtime's missing asset does, and is never retried. The bridge uploads no textures: a
//! material's textured slots draw untextured there.

use genex::present::{AssetCache, ModelSource, Uploads};
use genex::{Camera, Frame};
use genex_render::texture::{TextureData, TextureId, TextureKind};
use genex_render::{RenderCode, RenderError};

use crate::assets::{Layered, WebAssets};
use genex_render::mesh::MeshData;
use genex_render::scene::{MeshId, Scene};

/// A game's assets compiled into its binary: `(path under assets/, bytes)`. A web build has no
/// file system, so its staged `assets/` arrive through the shell instead (`crate::assets`).
pub type AssetTable = &'static [(&'static str, &'static [u8])];

/// Where a model's bytes come from, by its path under `assets/`.
pub trait AssetSource {
    /// The bytes of `path`, or None when the game has no such asset.
    fn asset(&self, path: &str) -> Option<&[u8]>;
}

impl AssetSource for [(&'static str, &'static [u8])] {
    fn asset(&self, path: &str) -> Option<&[u8]> {
        self.iter().find(|(known, _)| *known == path).map(|(_, bytes)| *bytes)
    }
}

/// A web build's models for the shared presenter: the compiled table first, then the staged files
/// the shell fetched before `studio_boot`.
pub struct WebModels {
    /// The game's compiled table (`install_with_assets`).
    pub compiled: AssetTable,
    /// The staged files the shell fetched and admitted.
    pub fetched: WebAssets,
}

impl ModelSource for WebModels {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        let layered = Layered { compiled: self.compiled, fetched: &self.fetched };
        layered.asset(path).map(<[u8]>::to_vec)
    }

    /// The compiled table's bytes (they come first, as [`Layered`] serves them): a fetched file
    /// is not the program's for its whole life, so its decoded upload is kept.
    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        self.compiled.iter().find(|(known, _)| *known == path).map(|(_, bytes)| *bytes)
    }
}

/// Which model paths have meshes in the renderer's library (refused ones included), as the
/// presenter's [`AssetCache`] holds them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MeshCache {
    cache: AssetCache,
}

/// A bridge's assets as the presenter's model source.
struct Bytes<'a, S: ?Sized>(&'a S);

impl<S: AssetSource + ?Sized> ModelSource for Bytes<'_, S> {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        self.0.asset(path).map(<[u8]>::to_vec)
    }
}

/// A bridge's uploads: meshes through its renderer's `add_mesh`, no textures.
struct MeshesOnly<F>(F);

impl<F: FnMut(MeshData) -> Result<MeshId, RenderError>> Uploads for MeshesOnly<F> {
    fn add_mesh(&mut self, mesh: MeshData) -> Result<MeshId, RenderError> {
        (self.0)(mesh)
    }

    fn add_texture(&mut self, _data: &TextureData, _kind: TextureKind) -> Result<TextureId, RenderError> {
        Err(RenderError::refused(RenderCode::TextureInvalid, "the part-1 bridge uploads no textures"))
    }
}

impl MeshCache {
    /// The first mesh for `path`: `Some(Some(id))` loaded, `Some(None)` refused, `None` never tried.
    pub fn get(&self, path: &str) -> Option<Option<MeshId>> {
        self.cache.tried(path).then(|| self.cache.model(path).and_then(|model| model.parts.first()).map(|part| part.mesh))
    }

    /// Record the outcome of loading `path` as one mesh.
    pub fn insert(&mut self, path: &str, id: Option<MeshId>) {
        self.cache.insert_model(path, id);
    }

    /// The presenter's cache these meshes are held in.
    pub fn cache(&self) -> &AssetCache {
        &self.cache
    }

    /// Load every model `frame` draws that was never tried: its GLB from `assets`, each part's
    /// mesh handed to `add` (the renderer's `add_mesh`). A missing file, a malformed GLB or a
    /// refused upload is recorded as refused and logged once.
    pub fn load<S: AssetSource + ?Sized>(
        &mut self,
        frame: &Frame,
        assets: &S,
        add: impl FnMut(MeshData) -> Result<MeshId, RenderError>,
    ) {
        let loaded = self.cache.load(frame, &Bytes(assets), &mut MeshesOnly(add), &mut |line| log::warn!("{line}"));
        if let Err(error) = loaded {
            log::warn!("models not loaded: {error}");
        }
    }
}

/// The scene for `frame` drawn from `camera`, in draw order: the presenter's conversion
/// (`genex::present::to_scene`). Models not in `meshes` (missing, refused or not loaded yet) draw
/// the missing-asset checker cube under their transform.
pub fn to_scene(frame: &Frame, camera: &Camera, meshes: &MeshCache) -> Scene {
    genex::present::to_scene(frame, camera, &meshes.cache)
}

#[cfg(test)]
mod tests {
    use super::*;
    use genex::glam::Vec3;
    use genex::{Assets, Color, Model, Transform};

    const TINY_TABLE: AssetTable = &[("broken.glb", b"not a glb")];

    fn frame_with(model: &Model) -> Frame {
        let mut frame = Frame::new(Color::rgb(1, 2, 3));
        frame.tag("pond").model_tinted(model, Transform::from_xyz(1.0, 2.0, 3.0), Color::rgb(10, 20, 30));
        frame.cube(Transform::IDENTITY, Color::RED);
        frame.sphere(Vec3::new(0.0, 1.0, 0.0), 2.0, Color::GREEN);
        frame.line(Vec3::ZERO, Vec3::X, Color::BLUE);
        frame
    }

    #[test]
    fn every_draw_reaches_the_scene_in_order() {
        let assets = Assets::default();
        let model = assets.model("pond.glb");
        let mut meshes = MeshCache::default();
        meshes.insert("pond.glb", Some(MeshId::from_raw(2)));
        let scene = to_scene(&frame_with(&model), &Camera::DEFAULT, &meshes);
        assert_eq!(scene.clear, [1, 2, 3, 255]);
        let ids: Vec<u32> = scene.draws.iter().map(|d| d.mesh.raw()).collect();
        assert_eq!(ids, [2, MeshId::CUBE.raw(), MeshId::SPHERE.raw()]);
        assert_eq!(scene.draws[0].material.base_color, [10, 20, 30, 255]);
        assert_eq!(&scene.draws[0].model[12..15], &[1.0, 2.0, 3.0]);
        assert_eq!(scene.draws[2].model[0], 2.0, "a sphere is the unit sphere scaled by its radius");
        assert_eq!(scene.lines.len(), 2);
        assert_eq!(scene.camera.eye, [0.0, 10.0, 20.0]);
    }

    /// One conversion: the bridge's scene for a frame with lights and materials is the presenter's
    /// (`genex::present::to_scene`), so native and web draw the same scene.
    #[test]
    fn native_and_web_scenes_for_one_frame_are_equal() {
        let assets = Assets::default();
        let model = assets.model("pond.glb");
        let mut frame = frame_with(&model);
        let gold = genex::Material::color(Color::rgb(255, 200, 80)).with_metallic(1.0).with_roughness(0.25);
        frame.sun(Vec3::new(0.0, 1.0, 1.0), Color::rgb(255, 240, 220), 3.0);
        frame.ambient(Color::BLUE, 0.2);
        frame.point_light(Vec3::new(0.0, 2.0, 0.0), 4.0, Color::RED, 1.5);
        frame.cube_with(Transform::from_xyz(0.0, 0.0, 2.0), &gold);
        frame.model_with(&model, Transform::IDENTITY, &gold);
        let mut meshes = MeshCache::default();
        meshes.insert("pond.glb", Some(MeshId::from_raw(2)));
        let web = to_scene(&frame, &Camera::DEFAULT, &meshes);
        assert_eq!(web, genex::present::to_scene(&frame, &Camera::DEFAULT, meshes.cache()));
        assert_eq!(web.lighting.sun_intensity, 3.0, "the frame's sun reaches the web scene");
        assert_eq!(web.lighting.points.len(), 1);
        let last = web.draws.last().expect("draws");
        assert_eq!((last.material.metallic, last.material.roughness), (1.0, 0.25), "the model's material reaches the web scene");
    }

    #[test]
    fn a_model_without_a_mesh_draws_the_missing_checker() {
        let assets = Assets::default();
        for model in [assets.model("pond.glb"), assets.model("../escape.glb")] {
            let scene = to_scene(&frame_with(&model), &Camera::DEFAULT, &MeshCache::default());
            assert_eq!(scene.draws[0].mesh, MeshId::CUBE);
            assert!(scene.draws[0].material.checker);
        }
    }

    /// The presenter's web model source: the compiled table answers first, then the fetched files
    /// that were admitted; anything else, or a file the map never named, is no model.
    #[test]
    fn web_models_answer_the_compiled_table_then_the_admitted_fetched_files() {
        use genex_core::digest::{fnv1a64, hex64};
        let fetched_bytes = b"fetched glb";
        let map = format!(
            r#"{{"version":1,"files":[{{"path":"fetched.glb","bytes":{},"fnv1a64":"{}"}},{{"path":"both.glb","bytes":3,"fnv1a64":"{}"}}]}}"#,
            fetched_bytes.len(),
            hex64(fnv1a64(fetched_bytes)),
            hex64(fnv1a64(b"web")),
        );
        let mut fetched = WebAssets::plan(map.as_bytes()).expect("a well-formed map");
        fetched.admit("fetched.glb", fetched_bytes.to_vec()).expect("admitted");
        fetched.admit("both.glb", b"web".to_vec()).expect("admitted");
        let models = WebModels { compiled: &[("both.glb", b"compiled")], fetched };
        assert_eq!(models.model_bytes("fetched.glb").as_deref(), Some(&fetched_bytes[..]));
        assert_eq!(models.model_bytes("both.glb").as_deref(), Some(&b"compiled"[..]), "the compiled table wins");
        for absent in ["missing.glb", "../fetched.glb", ""] {
            assert_eq!(models.model_bytes(absent), None, "{absent:?}");
        }
    }

    #[test]
    fn load_tries_each_path_once_and_records_refusals() {
        let assets = Assets::default();
        let frame = frame_with(&assets.model("broken.glb"));
        let mut calls = 0;
        let mut meshes = MeshCache::default();
        meshes.load(&frame, TINY_TABLE, |_| {
            calls += 1;
            Err(RenderError::refused(RenderCode::MeshInvalid, "unreachable"))
        });
        meshes.load(&frame, TINY_TABLE, |_| {
            calls += 1;
            Ok(MeshId::from_raw(9))
        });
        assert_eq!(calls, 0, "a malformed GLB never reaches the renderer");
        assert_eq!(meshes.get("broken.glb"), Some(None));
        let missing = frame_with(&assets.model("absent.glb"));
        meshes.load(&missing, TINY_TABLE, |_| Ok(MeshId::from_raw(9)));
        assert_eq!(meshes.get("absent.glb"), Some(None));
    }
}
