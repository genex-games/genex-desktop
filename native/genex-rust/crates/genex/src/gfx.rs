//! Services a reset hook may use: asset handles under the game's `assets/` folder, its saves and
//! its Level-2 extensions (`gfx.material`, `gfx.post_pass`: see `extend.rs`).
//!
//! A Level-2 source at `[[wgsl]] api = 2` may sample the game's own textures: `gfx.texture(path)`
//! is a handle to an image under `assets/` (a format in [`GAME_TEXTURE_FORMATS`]) and
//! `gfx.material_textured(path, uniforms, &[&texture])` binds them, in order, from
//! `@group(2) @binding(1)` (genex-render's `GAME_TEXTURE_FIRST_BINDING`), with the renderer's
//! samplers at `@binding(5)` (linear, repeating) and `@binding(6)` (nearest, clamped).
//!
//! A missing or unsafe path never crashes: it gives a missing model, which renders as the
//! magenta checker. The path rule is genex-core's port of `paths.h` (`isSafeAssetPath`).
//! The files behind the handles are the ones the host-side importer (`src/main/rust-assets.ts`)
//! normalized; a desktop run reads them from `assets/` beside the executable (`install_with_assets`).
//!
//! The sim may also read its assets while a reset builds it: `gfx.assets().bytes(path)` (a level's
//! JSON), `.triangles(&model)` (a navmesh's or a collider's input, parsed by the renderer's own
//! glTF reader) and `.info(path)` (size and group, nothing read). Every shell attaches its
//! [`AssetSource`] before the first seed, and one rule holds on all six destinations: reads happen
//! in `on_reset` only (`not-at-reset`), and only for assets of the boot and sim groups
//! (`not-preloaded` for a streamed or named one). The bytes are part of the build, so the same seed
//! gives the same checksum everywhere; a re-seed reuses what the first one read.
//!
//! `gfx.character(path)` reads a rigged GLB the same way and hands it to genex-anim's importer
//! (behind genex-core's GLB guard); the rig is kept in an `Arc` cache across seeds, so a re-seed
//! neither reads nor parses again. Its clips are imported with it (AN-15: `asset.graph()`,
//! `asset.animator(&graph)`, see `animation.rs`). Every refusal, the read's included, is
//! `animation-asset-invalid`.

use std::cell::{Cell, RefCell};
use std::sync::Arc;

use genex_anim::animator::AnimSet;
use genex_anim::clip::import_clips;
use genex_anim::import::{Rig, import_rig};
use genex_anim::skeleton::Skeleton;
use genex_anim::AnimationError;
use genex_core::paths::is_safe_asset_path;
use genex_core::saves::Saves;
use serde_json::Value;

use crate::extend::{CustomMaterial, ExtensionRefusal, Extensions, PostPass, WgslSetup};
use crate::lod::{Impostor, LOD_BIAS_DEFAULT, LOD_BIAS_MAX, LOD_BIAS_MIN, LodRefusalCode, ModelLod};
#[cfg(doc)]
use crate::lod::LOD_LEVELS_MAX;
use crate::map::Map;
use crate::math::Vec3;

/// A game's assets compiled into its binary: `(path under assets/, bytes)`. A dev build that
/// passes none reads `assets/` beside the executable (`../Resources/assets/` in a Mac bundle), or
/// with none there, under `cargo run`, its crate's `assets/`.
pub type AssetTable = &'static [(&'static str, &'static [u8])];

/// The image formats a game texture is read from (the asset table's Rust texture formats).
pub const GAME_TEXTURE_FORMATS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];

/// A game texture handle (`gfx.texture(path)`). `GameTexture::default()` is a missing texture,
/// which the renderer binds as its neutral white texel, never the checker.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct GameTexture {
    path: Option<Arc<str>>,
}

impl GameTexture {
    /// The path under `assets/`, or `None` for a missing texture.
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Whether this handle is missing (an unsafe path or not an image format).
    pub fn is_missing(&self) -> bool {
        self.path.is_none()
    }
}

/// Whether `path` names an image format a game texture is read from (by its extension, any case).
fn is_texture_path(path: &str) -> bool {
    let extension = path.rsplit_once('.').map(|(_, extension)| extension.to_ascii_lowercase());
    extension.is_some_and(|extension| GAME_TEXTURE_FORMATS.contains(&extension.as_str()))
}

/// A model handle. `Model::default()` is a missing model.
#[derive(Clone, Debug, Default, PartialEq, Eq, Hash)]
pub struct Model {
    path: Option<Arc<str>>,
    /// Its level-of-detail options (game systems LOD-07); `None` for a plain model.
    lod: Option<Arc<ModelLod>>,
}

impl Model {
    /// The path under `assets/`, or `None` for a missing model. A compound's is its first
    /// member's.
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Whether this handle draws the magenta checker.
    pub fn is_missing(&self) -> bool {
        self.path.is_none()
    }

    /// Authored levels, coarser and coarser: `(level, metres)` draws `level`'s parts in place of
    /// this model's from `metres` from the camera (to the nearest point of the model's bounding
    /// sphere) for a copy of scale 1 at the nominal view (1080 rows, 60° fov, the one-pixel
    /// threshold); a bigger copy, a sharper view or a stricter quality preset switches later, a
    /// coarser preset sooner. Level k's part i draws with part i's material; at most
    /// [`LOD_LEVELS_MAX`] levels, each a GLB with this model's part count.
    ///
    /// Refused `levels-invalid` (no levels, too many, a distance that is not finite, positive and
    /// increasing, a missing level, a level with levels of its own, or a model that already has
    /// levels or is a compound) and, at load, `levels-mismatch` (a level with another part
    /// count): the model draws whole and `state().__render.lodRefused` names it. Never a crash.
    pub fn with_levels(self, levels: &[(Model, f32)]) -> Model {
        let Some(path) = self.path.clone() else { return self };
        let mut lod = self.lod_options().cloned().unwrap_or_default();
        if let Some(code) = crate::lod::levels_refusal(&self, levels) {
            // Drawn whole: its own parts (a compound's members), no levels.
            lod.refused = Some(code);
            lod.levels.clear();
            if lod.members.is_empty() {
                lod.key = None;
            }
            return Model { path: self.path, lod: Some(Arc::new(lod)) };
        }
        lod.levels = levels.iter().map(|(level, metres)| (level.clone(), metres.to_bits())).collect();
        lod.key = Some(crate::lod::levels_key(&path, levels));
        Model { path: self.path, lod: Some(Arc::new(lod)) }
    }

    /// How long this model keeps its detail: 2.0 holds each level twice as far, 0.5 half
    /// (Godot's `lod_bias` sense), clamped to [`LOD_BIAS_MIN`]..=[`LOD_BIAS_MAX`]; a bias that
    /// is not a number keeps the default 1.0. It applies to the model's own levels, imported or
    /// authored, and to every part of a compound.
    pub fn with_lod_bias(self, bias: f32) -> Model {
        let bias = if bias.is_nan() { LOD_BIAS_DEFAULT } else { bias.clamp(LOD_BIAS_MIN, LOD_BIAS_MAX) };
        let mut lod = self.lod_options().cloned().unwrap_or_default();
        lod.bias = bias.to_bits();
        Model { path: self.path, lod: Some(Arc::new(lod)) }
    }

    /// Past its last mesh level, draw this model as an impostor baked from its own parts at load
    /// (on the GPU, sized by the device class: game systems LOD-16): lit, shadowed (its last mesh
    /// level casts) and fogged like the mesh. Until the bake lands, and on a quality with
    /// impostors off, the last mesh level draws to the horizon. Works on a model with levels and
    /// on a compound (one card for all its members).
    ///
    /// Refused `impostor-invalid` on an empty model (a missing model here, a GLB with no
    /// triangles at load): the model draws whole and `state().__render.lodRefused` names it.
    pub fn with_impostor(self, impostor: Impostor) -> Model {
        let mut lod = self.lod_options().cloned().unwrap_or_default();
        lod.impostor = Some(impostor);
        if self.path.is_none() {
            lod.refused = Some(LodRefusalCode::ImpostorInvalid);
        }
        Model { path: self.path, lod: Some(Arc::new(lod)) }
    }

    /// Its impostor, unless refused (game systems LOD-16).
    pub fn impostor(&self) -> Option<Impostor> {
        self.lod_options().and_then(ModelLod::drawn_impostor)
    }

    /// Why one of this model's level-of-detail options was refused (it then draws whole), or
    /// `None`. A `levels-mismatch` is found at load and only reported in `__render.lodRefused`.
    pub fn lod_refusal(&self) -> Option<LodRefusalCode> {
        self.lod.as_ref().and_then(|lod| lod.refused)
    }

    /// Its level-of-detail options, if it has any.
    pub(crate) fn lod_options(&self) -> Option<&ModelLod> {
        self.lod.as_deref()
    }

    /// The presenter's cache key: the path for a model drawn from its GLB alone, a derived key
    /// for one with authored levels or a compound; `None` for a missing model.
    pub(crate) fn key(&self) -> Option<&str> {
        self.lod.as_ref().and_then(|lod| lod.key.as_deref()).or(self.path.as_deref())
    }

    /// The models whose parts draw for this one: a compound's members, else itself.
    pub(crate) fn drawn_members(&self) -> &[Model] {
        match self.lod.as_deref() {
            Some(lod) if !lod.members.is_empty() => &lod.members,
            _ => std::slice::from_ref(self),
        }
    }

    /// A handle for `assets/<path>` that nothing has recorded yet: a streamed cell's builder makes
    /// it on a worker, and the commit slot records its path in cell order (STR-9). A missing model
    /// for a path that is not a plain relative path.
    pub(crate) fn unrecorded(path: &str) -> Model {
        if !is_safe_asset_path(path) {
            return Model::default();
        }
        Model { path: Some(Arc::from(path)), lod: None }
    }
}

/// The largest asset a reset reads into memory (genex-assets' `MAX_ASSET_BYTES`).
pub const ASSET_READ_MAX_BYTES: u64 = 256 * 1024 * 1024;

/// Why a sim-side asset read was refused. Wire codes: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AssetErrorCode {
    /// The path breaks the asset-path rule (absolute, `..`, `.`, an empty segment, a backslash,
    /// NUL), or is a link or passes through one below the asset folder.
    UnsafePath,
    /// The build has no asset at the path.
    Missing,
    /// Larger than [`ASSET_READ_MAX_BYTES`].
    TooLarge,
    /// [`Assets::triangles`] on bytes that are not a readable GLB with triangles, or
    /// [`AssetBytes::json`] on bytes that are not JSON.
    Malformed,
    /// Read outside `on_reset`: the sim reads its assets while it is being built, never later.
    NotAtReset,
    /// The asset ships in a group that is not loaded before the first frame (a streamed or named
    /// group): the same refusal on every destination, the web's and the native ones alike.
    NotPreloaded,
}

impl AssetErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [AssetErrorCode; 6] = [
        AssetErrorCode::UnsafePath,
        AssetErrorCode::Missing,
        AssetErrorCode::TooLarge,
        AssetErrorCode::Malformed,
        AssetErrorCode::NotAtReset,
        AssetErrorCode::NotPreloaded,
    ];

    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            AssetErrorCode::UnsafePath => "unsafe-path",
            AssetErrorCode::Missing => "missing",
            AssetErrorCode::TooLarge => "too-large",
            AssetErrorCode::Malformed => "malformed",
            AssetErrorCode::NotAtReset => "not-at-reset",
            AssetErrorCode::NotPreloaded => "not-preloaded",
        }
    }
}

/// A refused asset read: its typed code and what it was about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetError {
    code: AssetErrorCode,
    detail: String,
}

impl AssetError {
    /// A refusal with `code` about `detail`.
    pub fn new(code: AssetErrorCode, detail: impl Into<String>) -> AssetError {
        AssetError { code, detail: detail.into() }
    }

    /// The typed code.
    pub fn code(&self) -> AssetErrorCode {
        self.code
    }

    /// What the refusal was about (for a log line; never matched on).
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl std::fmt::Display for AssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for AssetError {}

/// The bytes of one asset file, shared: a reset keeps them in the world (`Arc`), so update hooks
/// use them without reading anything. Derefs to `[u8]`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetBytes {
    bytes: Arc<[u8]>,
}

impl AssetBytes {
    /// FNV-1a 64 of the bytes (genex-core's, the web asset map's digest).
    pub fn digest(&self) -> u64 {
        genex_core::digest::fnv1a64(&self.bytes)
    }

    /// The bytes as UTF-8 text, or None when they are not.
    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.bytes).ok()
    }

    /// The bytes parsed as JSON (a level, a wave table), or `malformed`. Parsing is exact, so the
    /// same file gives the same values on every destination.
    pub fn json(&self) -> Result<Value, AssetError> {
        serde_json::from_slice(&self.bytes).map_err(|error| AssetError::new(AssetErrorCode::Malformed, format!("not JSON: {error}")))
    }

    /// The bytes, shared (streamed music keeps them without a copy).
    pub(crate) fn shared(&self) -> Arc<[u8]> {
        Arc::clone(&self.bytes)
    }
}

impl std::ops::Deref for AssetBytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        &self.bytes
    }
}

/// The CPU triangles of a model's default scene, node transforms applied (object space of its
/// scene root), read with the renderer's own glTF reader: a navmesh bake's input, a collider, a
/// gameplay query. Never a render level of detail.
#[derive(Clone, Debug, PartialEq)]
pub struct ModelTriangles {
    /// Vertex positions.
    pub positions: Vec<Vec3>,
    /// Three indices per triangle, each below `positions.len()`.
    pub indices: Vec<u32>,
    /// The smallest corner of the positions' bounds.
    pub min: Vec3,
    /// The largest corner of the positions' bounds.
    pub max: Vec3,
}

impl ModelTriangles {
    /// The triangles of a GLB's bytes, or `malformed`.
    fn from_glb(path: &str, bytes: &[u8]) -> Result<ModelTriangles, AssetError> {
        let mesh = genex_render::mesh::MeshData::from_glb(bytes).map_err(|error| AssetError::new(AssetErrorCode::Malformed, format!("{path}: {error}")))?;
        let positions: Vec<Vec3> = mesh.vertices.iter().map(|vertex| Vec3::from_array(vertex.position)).collect();
        let min = positions.iter().copied().fold(Vec3::splat(f32::INFINITY), Vec3::min);
        let max = positions.iter().copied().fold(Vec3::splat(f32::NEG_INFINITY), Vec3::max);
        Ok(ModelTriangles { positions, indices: mesh.indices, min, max })
    }

    /// Triangles in the list.
    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }
}

/// Which group of the build an asset ships in. Boot and sim assets are loaded before the first
/// frame on every destination, so a reset may read them; streamed and named groups arrive later.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum AssetGroup {
    /// Needed to draw the first frame.
    Boot,
    /// Read by the simulation (the default: a build that records no group ships every asset here).
    #[default]
    Sim,
    /// Fetched while playing, by streaming.
    Stream,
    /// One of the game's named groups (`genex.toml`), required by name while playing.
    Named,
}

impl AssetGroup {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            AssetGroup::Boot => "boot",
            AssetGroup::Sim => "sim",
            AssetGroup::Stream => "stream",
            AssetGroup::Named => "named",
        }
    }

    /// Whether every destination has the group loaded before the first reset.
    pub const fn preloaded(self) -> bool {
        matches!(self, AssetGroup::Boot | AssetGroup::Sim)
    }
}

/// The groups a build records for its assets, by path; a path it does not name is [`AssetGroup::Sim`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AssetGroups {
    rows: Vec<(String, AssetGroup)>,
}

impl AssetGroups {
    /// These groups with `path` in `group` (a later row for the same path wins).
    pub fn with(mut self, path: &str, group: AssetGroup) -> AssetGroups {
        self.rows.retain(|(known, _)| known != path);
        self.rows.push((path.to_owned(), group));
        self
    }

    /// The group `path` ships in.
    pub fn of(&self, path: &str) -> AssetGroup {
        self.rows.iter().find(|(known, _)| known == path).map(|(_, group)| *group).unwrap_or_default()
    }
}

/// What the build knows about one asset without the sim reading it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub struct AssetInfo {
    /// Its size in bytes, as shipped for this destination.
    pub bytes: u64,
    /// The group it ships in.
    pub group: AssetGroup,
}

/// Where a game's asset bytes come from, for the sim's reads and the presenter's: natively the
/// table a game compiled in, then `assets/` beside the executable by real path; on the web the
/// table, then the files the page fetched; on a phone the table. Each shell attaches one before
/// the first reset ([`crate::Runtime::with_assets`]).
pub trait AssetSource {
    /// The bytes of `path` (already held to the asset-path rule), or why not.
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError>;

    /// The size of `path` without keeping its bytes, or why not (by default: a read).
    fn size(&self, path: &str) -> Result<u64, AssetError> {
        self.read(path).map(|bytes| bytes.len() as u64)
    }

    /// The group `path` ships in (by default [`AssetGroup::Sim`]: the build records none).
    fn group(&self, _path: &str) -> AssetGroup {
        AssetGroup::Sim
    }
}

impl AssetSource for AssetTable {
    fn read(&self, path: &str) -> Result<Arc<[u8]>, AssetError> {
        let found = self.iter().find(|(known, _)| *known == path).map(|(_, bytes)| *bytes);
        found.map(Arc::from).ok_or_else(|| AssetError::new(AssetErrorCode::Missing, path.to_owned()))
    }

    fn size(&self, path: &str) -> Result<u64, AssetError> {
        let found = self.iter().find(|(known, _)| *known == path).map(|(_, bytes)| bytes.len() as u64);
        found.ok_or_else(|| AssetError::new(AssetErrorCode::Missing, path.to_owned()))
    }
}

/// A character GLB's rig, then its clips on that rig (no root motion until the game asks).
fn import_character(bytes: &[u8]) -> Result<Imported, AnimationError> {
    let rig = import_rig(bytes)?;
    let clips = import_clips(bytes, &rig)?;
    let set = AnimSet::new(rig.skeleton().clone(), clips);
    Ok((Arc::new(rig), Arc::new(set)))
}

/// A game with no assets compiled in and none on disk (a test's runtime).
pub(crate) const NO_ASSETS: AssetTable = &[];

/// A rigged GLB loaded at reset (`gfx.character(path)`): genex-anim's rig of its first skinned
/// mesh node and the file's clips on it, shared by `Arc` (cloning is cheap; every seed gets the
/// one parse).
#[derive(Clone, Debug)]
pub struct CharacterAsset {
    path: Arc<str>,
    rig: Arc<Rig>,
    set: Arc<AnimSet>,
}

impl PartialEq for CharacterAsset {
    /// The same file's rig: its clips come from the same bytes.
    fn eq(&self, other: &CharacterAsset) -> bool {
        self.path == other.path && self.rig == other.rig
    }
}

impl CharacterAsset {
    /// The path under `assets/` it was loaded from.
    pub fn path(&self) -> &str {
        &self.path
    }

    /// Joints in its skeleton.
    pub fn joint_count(&self) -> usize {
        self.rig.skeleton().joint_count()
    }

    /// Its skeleton: joint names, parents and rest pose.
    pub fn skeleton(&self) -> &Skeleton {
        self.rig.skeleton()
    }

    /// The skeleton and clips its animators share (`animation.rs` builds on it).
    pub(crate) fn set(&self) -> &Arc<AnimSet> {
        &self.set
    }

    /// The same file with another clip set (root motion extracted, `animation.rs`).
    pub(crate) fn with_set(&self, set: AnimSet) -> CharacterAsset {
        CharacterAsset { path: Arc::clone(&self.path), rig: Arc::clone(&self.rig), set: Arc::new(set) }
    }
}

/// A character file as imported: its rig and the clip set on it.
type Imported = (Arc<Rig>, Arc<AnimSet>);

/// What the asset folder remembers across seeds: each read's bytes, each model's triangles and
/// each character's rig (or why it was refused), so a re-seed never reads or parses again (they
/// are a pure function of the build's files).
#[derive(Default)]
struct Reads {
    bytes: Map<String, AssetBytes>,
    triangles: Map<String, Arc<ModelTriangles>>,
    rigs: Map<String, Result<Imported, AnimationError>>,
}

/// The game's `assets/` folder.
pub struct Assets {
    requested: RefCell<Vec<String>>,
    source: Box<dyn AssetSource>,
    /// Whether a reset hook is running: the only time the sim reads.
    at_reset: Cell<bool>,
    reads: RefCell<Reads>,
}

impl Default for Assets {
    fn default() -> Assets {
        Assets::with_source(Box::new(NO_ASSETS))
    }
}

impl std::fmt::Debug for Assets {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Assets").field("requested", &self.requested).field("at_reset", &self.at_reset).finish_non_exhaustive()
    }
}

impl Assets {
    /// The asset folder reading from `source`.
    pub(crate) fn with_source(source: Box<dyn AssetSource>) -> Assets {
        Assets { requested: RefCell::new(Vec::new()), source, at_reset: Cell::new(false), reads: RefCell::new(Reads::default()) }
    }

    /// A model at `assets/<path>` (glTF or GLB); a missing model when the path is not a plain
    /// relative path (no absolute path, `..`, `.`, empty segment or backslash).
    pub fn model(&self, path: &str) -> Model {
        if !is_safe_asset_path(path) {
            return Model::default();
        }
        self.note(path);
        Model { path: Some(Arc::from(path)), lod: None }
    }

    /// Several models drawn as one (a tree's wood and foliage GLBs): one transform, one level
    /// choice for all of their parts (each part measured from the compound's bounding sphere, so
    /// they switch together) and one bias. Members keep their own levels and materials; a
    /// material given to the draw applies to every part.
    ///
    /// Refused `compound-invalid` (no members, a missing member or a member that is a compound):
    /// it then draws its first member whole (the checker with none) and
    /// `state().__render.lodRefused` names it.
    pub fn compound(&self, members: &[&Model]) -> Model {
        let first = members.first().map(|member| (*member).clone()).unwrap_or_default();
        if let Some(code) = crate::lod::compound_refusal(members) {
            let lod = ModelLod { refused: Some(code), ..ModelLod::default() };
            let path = first.path.clone();
            return Model { path, lod: Some(Arc::new(lod)) };
        }
        let lod = ModelLod { members: members.iter().map(|member| (*member).clone()).collect(), key: Some(crate::lod::compound_key(members)), ..ModelLod::default() };
        Model { path: first.path, lod: Some(Arc::new(lod)) }
    }

    /// A texture at `assets/<path>` ([`GAME_TEXTURE_FORMATS`]); a missing texture when the path is
    /// not a plain relative path or not an image format. The presenter reads it by realpath inside
    /// the game's assets, like a model.
    pub fn texture(&self, path: &str) -> GameTexture {
        if !is_safe_asset_path(path) || !is_texture_path(path) {
            return GameTexture::default();
        }
        self.note(path);
        GameTexture { path: Some(Arc::from(path)) }
    }

    /// The bytes of `assets/<path>`, read in `on_reset` only and only for an asset of the boot or
    /// sim group (`not-preloaded` for a streamed or named one, on every destination). They are part
    /// of the build, so the same seed gives the same checksum everywhere; a re-seed reuses them.
    pub fn bytes(&self, path: &str) -> Result<AssetBytes, AssetError> {
        self.admit(path)?;
        let cached = self.reads.borrow().bytes.get(path).cloned();
        let bytes = match cached {
            Some(bytes) => bytes,
            None => self.read(path)?,
        };
        self.note(path);
        Ok(bytes)
    }

    /// Read `path` from the source once and keep it for later seeds.
    fn read(&self, path: &str) -> Result<AssetBytes, AssetError> {
        let bytes = self.source.read(path)?;
        if bytes.len() as u64 > ASSET_READ_MAX_BYTES {
            return Err(AssetError::new(AssetErrorCode::TooLarge, format!("{path}: {} bytes", bytes.len())));
        }
        let bytes = AssetBytes { bytes };
        self.reads.borrow_mut().bytes.insert(path.to_owned(), bytes.clone());
        Ok(bytes)
    }

    /// The triangles of `model`'s default scene, node transforms applied, read as [`Assets::bytes`]
    /// reads (in `on_reset`, boot and sim groups only) and parsed once per build file: a missing
    /// model handle is `unsafe-path`, bytes that are not a GLB with triangles `malformed`.
    pub fn triangles(&self, model: &Model) -> Result<Arc<ModelTriangles>, AssetError> {
        let Some(path) = model.path() else {
            return Err(AssetError::new(AssetErrorCode::UnsafePath, "a missing model has no file"));
        };
        let bytes = self.bytes(path)?;
        if let Some(triangles) = self.reads.borrow().triangles.get(path) {
            return Ok(Arc::clone(triangles));
        }
        let triangles = Arc::new(ModelTriangles::from_glb(path, &bytes)?);
        self.reads.borrow_mut().triangles.insert(path.to_owned(), Arc::clone(&triangles));
        Ok(triangles)
    }

    /// The rig and clips of the GLB at `assets/<path>`, read as [`Assets::bytes`] reads (in
    /// `on_reset`, boot and sim groups only) and imported once per build file, its refusal
    /// included.
    fn rig(&self, path: &str) -> Result<Imported, AnimationError> {
        let bytes = self.bytes(path).map_err(|error| AnimationError::asset_invalid(format!("{path}: {error}")))?;
        if let Some(known) = self.reads.borrow().rigs.get(path) {
            return known.clone();
        }
        let imported = import_character(&bytes).map_err(|error| AnimationError { code: error.code, detail: format!("{path}: {}", error.detail) });
        self.reads.borrow_mut().rigs.insert(path.to_owned(), imported.clone());
        imported
    }

    /// What the build records for `assets/<path>` (its size and group), without reading it into
    /// the sim; None for an unsafe path or an asset the build does not have.
    pub fn info(&self, path: &str) -> Option<AssetInfo> {
        if !is_safe_asset_path(path) {
            return None;
        }
        let bytes = self.source.size(path).ok()?;
        Some(AssetInfo { bytes, group: self.source.group(path) })
    }

    /// The rule every read passes first: a plain path, a reset running, a preloaded group. Only a
    /// path that then reads is listed in `state().assets`, so a refused one leaves no trace.
    fn admit(&self, path: &str) -> Result<(), AssetError> {
        if !is_safe_asset_path(path) {
            return Err(AssetError::new(AssetErrorCode::UnsafePath, format!("{path:?}")));
        }
        if !self.at_reset.get() {
            return Err(AssetError::new(AssetErrorCode::NotAtReset, path.to_owned()));
        }
        let group = self.source.group(path);
        if !group.preloaded() {
            return Err(AssetError::new(AssetErrorCode::NotPreloaded, format!("{path} ships in the {} group", group.wire())));
        }
        Ok(())
    }

    fn note(&self, path: &str) {
        let mut requested = self.requested.borrow_mut();
        if !requested.iter().any(|known| known == path) {
            requested.push(path.to_owned());
        }
    }

    /// Every asset path requested so far, in first-request order (`state().assets`).
    pub fn requested(&self) -> Vec<String> {
        self.requested.borrow().clone()
    }

    /// The characters the game made (`gfx.character`) whose rigs imported, in path order: a
    /// presenter skins them before a frame draws one (game systems R-20).
    pub(crate) fn character_paths(&self) -> Vec<String> {
        self.reads.borrow().rigs.iter().filter(|(_, rig)| rig.is_ok()).map(|(path, _)| path.clone()).collect()
    }

    pub(crate) fn clear(&self) {
        self.requested.borrow_mut().clear();
    }

    /// Mark the reset hooks running (`true`) or done: reads are admitted only in between.
    pub(crate) fn set_at_reset(&self, at_reset: bool) {
        self.at_reset.set(at_reset);
    }
}

/// What `on_reset` gets besides the simulation: the asset folder, the world size, the saves and
/// the game's Level-2 extensions.
#[derive(Debug)]
pub struct Gfx {
    assets: Assets,
    world_size: [u32; 2],
    saves: Saves,
    extensions: Extensions,
    /// The textures each textured material binds, by its source path, in binding order.
    textured: RefCell<Vec<(String, Vec<GameTexture>)>>,
    /// The sounds and music the resets decoded (AU-7), kept across seeds.
    audio: crate::audio::Bank,
}

impl Gfx {
    pub(crate) fn new(world_size: [u32; 2], saves: Saves, wgsl: WgslSetup, source: Box<dyn AssetSource>) -> Gfx {
        let assets = Assets::with_source(source);
        Gfx { assets, world_size, saves, extensions: Extensions::new(wgsl), textured: RefCell::new(Vec::new()), audio: crate::audio::Bank::default() }
    }

    /// The sound at `assets/<path>` (WAV, Ogg Vorbis, MP3, FLAC), in `on_reset` (an asset of the
    /// boot or sim group, as [`Assets::bytes`] reads), decoded once and cached across seeds. A
    /// refusal never crashes: it is a missing sound ([`crate::audio::Sound::refusal`] says why:
    /// `not-at-reset`, `not-preloaded`, an unsafe path, `missing`, `needs-import` for Opus or AAC,
    /// `malformed`, `memory-limit` past [`crate::audio::SOUNDS_DECODED_MAX_BYTES`] decoded), and a
    /// play of it is refused `sound-missing`.
    pub fn sound(&self, path: &str) -> crate::audio::Sound {
        self.audio.sound(&self.assets, path)
    }

    /// Music at `assets/<path>`, read as [`Gfx::sound`] reads: Ogg Vorbis stays compressed and
    /// decodes while it plays (about 1 MB a minute resident); another format is held decoded.
    pub fn music(&self, path: &str) -> crate::audio::Music {
        self.audio.music(&self.assets, path)
    }

    /// What the resets decoded for audio (the runtime hands it to the mixer after each reset).
    pub(crate) fn audio_bank(&self) -> &crate::audio::Bank {
        &self.audio
    }

    /// The rigged GLB at `assets/<path>` as a [`CharacterAsset`], in `on_reset` (an asset of the
    /// boot or sim group, as [`Assets::bytes`] reads). The rig is parsed once per build file and
    /// shared across seeds. Refused `animation-asset-invalid`: an unsafe path, a file the build
    /// does not have or cannot read now, or one that is not a GLB with a usable skin (no skinned
    /// mesh node, more than 256 joints, a broken node tree, a non-finite transform). A refusal
    /// never crashes; the model handle of the same path draws the checker. Refused
    /// `animation-disabled` in a game built with `[animation] enabled = false`.
    pub fn character(&self, path: &str) -> Result<CharacterAsset, AnimationError> {
        crate::animation::built()?;
        let (rig, set) = self.assets.rig(path)?;
        Ok(CharacterAsset { path: Arc::from(path), rig, set })
    }

    /// The rigid node clips of the GLB at `assets/<path>` (game systems AN-27): its node tree and
    /// animations, in `on_reset` (an asset of the boot or sim group, as [`Assets::bytes`] reads).
    /// Refused `animation-asset-invalid`: an unsafe path, a file the build does not have or cannot
    /// read now, or one that is not a usable GLB; `animation-clip-missing`: a GLB with no
    /// animations; `animation-disabled` in a game built with `[animation] enabled = false`. Draw
    /// it with `frame.model_posed`.
    pub fn node_clips(&self, path: &str) -> Result<crate::node_anim::NodeClips, AnimationError> {
        crate::animation::built()?;
        let bytes = self.assets.bytes(path).map_err(|error| AnimationError::asset_invalid(format!("{path:?}: {error}")))?;
        crate::node_anim::NodeClips::from_glb(path, &bytes)
    }

    /// A texture handle for a v2 material or post pass (`gfx.texture(path)`, [`Assets::texture`]).
    pub fn texture(&self, path: &str) -> GameTexture {
        self.assets.texture(path)
    }

    /// [`Gfx::material`] for a `[[wgsl]] api = 2` source that samples game textures: `textures`
    /// bind in order from `@group(2) @binding(1)`, as many as its highest texture binding asks for.
    pub fn material_textured(&self, path: &str, uniforms: &[f32], textures: &[&GameTexture]) -> CustomMaterial {
        let paths = textures.iter().map(|texture| texture.path.clone()).collect();
        let material = self.extensions.material_textured(path, uniforms, paths);
        let bound: Vec<GameTexture> = textures.iter().map(|texture| (*texture).clone()).collect();
        let mut textured = self.textured.borrow_mut();
        match textured.iter_mut().find(|(known, _)| known == path) {
            Some((_, held)) => *held = bound,
            None => textured.push((path.to_owned(), bound)),
        }
        material
    }

    /// The textures `material` binds (empty for one made without textures), in binding order: what
    /// the presenter uploads for its game group.
    pub fn material_textures(&self, material: &CustomMaterial) -> Vec<GameTexture> {
        let textured = self.textured.borrow();
        textured.iter().find(|(path, _)| path == material.path()).map(|(_, held)| held.clone()).unwrap_or_default()
    }

    /// A custom material from the `[[wgsl]] kind = "material"` source at `path` (relative to the
    /// game folder) with its uniform block's values (`[]` when it declares none; vec3 padded to
    /// vec4, as WGSL lays it out). Draw meshes with it through `frame.custom(..)`. A refused source
    /// gives a handle that draws the missing-asset checker; its typed refusal is
    /// [`CustomMaterial::refusal`] and is listed in `state().volatile.extensions`.
    pub fn material(&self, path: &str, uniforms: &[f32]) -> CustomMaterial {
        self.extensions.material(path, uniforms)
    }

    /// Replace a material's uniforms (the same size as its block); the next frame draws with them.
    pub fn set_material_uniforms(&self, material: &CustomMaterial, uniforms: &[f32]) -> Result<(), ExtensionRefusal> {
        Extensions::set_material_uniforms(material, uniforms)
    }

    /// A post pass from the `[[wgsl]] kind = "post"` source at `path`: run it over the frame through
    /// `frame.post_pass(..)`. Refusals as for [`Gfx::material`].
    pub fn post_pass(&self, path: &str) -> PostPass {
        self.extensions.post_pass(path, &[])
    }

    /// [`Gfx::post_pass`] for a source that declares a uniform block: its values.
    pub fn post_pass_with(&self, path: &str, uniforms: &[f32]) -> PostPass {
        self.extensions.post_pass(path, uniforms)
    }

    /// Forget the last reset's Level-2 requests (a new seed asks again).
    pub(crate) fn clear_extensions(&self) {
        self.extensions.clear();
        self.textured.borrow_mut().clear();
    }

    /// `state().volatile.extensions`: each Level-2 request with its api and typed code; None for none.
    pub(crate) fn extension_rows(&self) -> Option<Value> {
        self.extensions.rows()
    }

    /// The game's save folder (`load` a high score on reset; `ctx.save` it on update).
    pub fn saves(&self) -> &Saves {
        &self.saves
    }

    /// Replace the save folder (a phone shell's own root, before the first tick).
    pub(crate) fn set_saves(&mut self, saves: Saves) {
        self.saves = saves;
    }

    /// The bytes saved as `file`, or None (never saved, an unsafe name, no save folder).
    pub fn load(&self, file: &str) -> Option<Vec<u8>> {
        self.saves.load(file)
    }

    /// The game's asset folder.
    pub fn assets(&self) -> &Assets {
        &self.assets
    }

    /// The fixed world target size, in pixels.
    pub fn world_size(&self) -> [u32; 2] {
        self.world_size
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gfx() -> Gfx {
        Gfx::new([320, 180], Saves::at(Err(genex_core::paths::SaveRefusal::NoStateDir)), WgslSetup::default(), Box::new(NO_ASSETS))
    }

    #[test]
    fn a_game_texture_is_a_plain_relative_image_path_and_anything_else_is_missing() {
        let gfx = gfx();
        let rows: &[(&str, bool)] = &[
            ("textures/bark.png", true),
            ("Bark.JPG", true),
            ("ui/icon.webp", true),
            ("old/sky.bmp", true),
            ("photo.jpeg", true),
            ("../secret.png", false),
            ("/etc/passwd.png", false),
            ("textures/./bark.png", false),
            ("textures//bark.png", false),
            ("textures\\bark.png", false),
            ("c:bark.png", false),
            ("bark.exr", false),
            ("bark", false),
            ("model.glb", false),
            ("", false),
        ];
        for (path, admitted) in rows {
            let texture = gfx.texture(path);
            assert_eq!(!texture.is_missing(), *admitted, "{path:?}");
            assert_eq!(texture.path(), admitted.then_some(*path), "{path:?}");
        }
        assert_eq!(gfx.assets().requested(), vec!["textures/bark.png", "Bark.JPG", "ui/icon.webp", "old/sky.bmp", "photo.jpeg"]);
        assert!(GameTexture::default().is_missing());
    }

    /// Reads are the reset's: outside it every read refuses `not-at-reset` before the source is
    /// asked, and `info` (metadata, no bytes) still answers.
    #[test]
    fn a_read_outside_the_reset_refuses_not_at_reset() {
        let table: AssetTable = &[("levels/one.json", b"{}")];
        let gfx = Gfx::new([320, 180], Saves::at(Err(genex_core::paths::SaveRefusal::NoStateDir)), WgslSetup::default(), Box::new(table));
        let assets = gfx.assets();
        let refused = assets.bytes("levels/one.json").expect_err("outside the reset");
        assert_eq!(refused.code(), AssetErrorCode::NotAtReset);
        let model = assets.model("levels/one.json");
        assert_eq!(assets.triangles(&model).expect_err("outside the reset").code(), AssetErrorCode::NotAtReset);
        assert_eq!(assets.info("levels/one.json").map(|info| info.bytes), Some(2));
        assets.set_at_reset(true);
        assert_eq!(assets.bytes("levels/one.json").map(|bytes| bytes.to_vec()), Ok(b"{}".to_vec()));
        assets.set_at_reset(false);
        assert_eq!(assets.bytes("levels/one.json").expect_err("after the reset").code(), AssetErrorCode::NotAtReset);
    }

    /// AU-7: `gfx.sound` and `gfx.music` read as the sim reads, so outside the reset they answer
    /// a missing handle refused `not-at-reset` before the source is asked; inside it the same
    /// path decodes, and a later call outside it still refuses.
    #[test]
    #[cfg(feature = "audio")]
    fn a_sound_outside_the_reset_is_missing_not_at_reset() {
        use crate::audio::SoundRefusal;
        let table: AssetTable = Box::leak(Box::new([("sfx/tone.wav", crate::audio::test_tone_wav())]));
        let gfx = Gfx::new([320, 180], Saves::at(Err(genex_core::paths::SaveRefusal::NoStateDir)), WgslSetup::default(), Box::new(table));
        let outside = gfx.sound("sfx/tone.wav");
        assert_eq!(outside.refusal(), Some(SoundRefusal::Asset(AssetErrorCode::NotAtReset)));
        assert_eq!(gfx.music("sfx/tone.wav").refusal(), Some(SoundRefusal::Asset(AssetErrorCode::NotAtReset)));
        gfx.assets().set_at_reset(true);
        let inside = gfx.sound("sfx/tone.wav");
        assert!(!inside.is_missing() && inside.seconds() > 0.4, "{inside:?}");
        gfx.assets().set_at_reset(false);
        assert_eq!(gfx.sound("sfx/tone.wav").refusal(), Some(SoundRefusal::Asset(AssetErrorCode::NotAtReset)), "the cache never skips the rule");
    }

    #[test]
    fn a_textured_material_remembers_its_textures_in_binding_order_until_the_next_reset() {
        let gfx = gfx();
        let (bark, moss) = (gfx.texture("bark.png"), gfx.texture("moss.png"));
        let material = gfx.material_textured("shaders/tree.wgsl", &[], &[&bark, &moss]);
        assert_eq!(gfx.material_textures(&material), vec![bark.clone(), moss]);
        let plain = gfx.material("shaders/plain.wgsl", &[]);
        assert!(gfx.material_textures(&plain).is_empty());
        let again = gfx.material_textured("shaders/tree.wgsl", &[], &[&bark]);
        assert_eq!(gfx.material_textures(&again), vec![bark], "the latest request wins");
        gfx.clear_extensions();
        assert!(gfx.material_textures(&again).is_empty());
    }
}
