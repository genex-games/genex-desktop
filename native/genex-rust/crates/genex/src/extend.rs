//! Extension ladder level 2 in the facade: a custom material (`gfx.material(path, uniforms)`,
//! drawn with `frame.custom(..)`) and a post pass (`gfx.post_pass(path)`, run with
//! `frame.post_pass(..)`) from the game's `[[wgsl]]` sources, on every destination.
//!
//! A reset hook asks for a source by its path under the game folder. The facade admits it on the
//! CPU, before any GPU object exists, in this order:
//!
//! 1. the path is a plain relative `.wgsl` path (no absolute path, `..`, `.`, empty segment,
//!    backslash or colon);
//! 2. it is declared under `[[wgsl]]` (the game folder's `genex.toml`, else the `[[wgsl]]` rows a
//!    build lane compiled in as `GENEX_WGSL_TOML`) with the kind of the call that asks for it, at an
//!    api the Level-2 calls admit (1 or 2: `LEVEL_TWO_ADMITTED_APIS`). The lane compiles the
//!    rows into every destination, an empty set for a game with none, so a lane build admits the
//!    same sources natively, on the web and on a phone; only a build outside the lane (no rows
//!    compiled in, no folder) admits a compiled-in source undeclared, at api 1;
//! 3. its text comes, natively with a game folder (`wgsl_root`, or `cargo run`/`cargo test`), from the folder through
//!    genex-render's `read_extension_source` (by realpath inside the folder, a regular file, never a
//!    link, at most `WGSL_MAX_BYTES`), so an edited shader takes effect at the next reset with no
//!    rebuild; else from the binary (`game.wgsl(path, include_str!(..))`, what a web, phone or
//!    exported build has);
//! 4. naga admits it against its api's prelude (v2: `GxMaterialInV2`/`GxPostInV2`, the renderer's
//!    shading and the game group), the uniforms fit its block and a v2 material is handed as many
//!    textures as it binds (`gfx.material_textured`; a missing one binds the neutral white texel).
//!
//! On the GPU a v1 material keeps the frames that hold it on the legacy LDR scene
//! (`material-v1-in-hdr` in `degraded`); a v2 material draws on the HDR scene. Post passes run on
//! the display-ready world target (stage `ldr`), whatever their api.
//!
//! A refused source is still a handle: it draws the missing-asset checker, is listed with its typed
//! code in `state().volatile.extensions`, and changes nothing else (nothing is written, the
//! simulation never sees it). An admitted one is created on the GPU by the presenter the first time
//! a frame uses it; a refusal there (a device without a declared feature, the renderer's caps) is
//! listed the same way. The same API runs on native and web: both draw with the one presenter.

use std::fmt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use genex_render::extension::{ExtensionContext, ExtensionFault, ExtensionKind, read_extension_source, validate_api};
use genex_render::{RenderCode, RenderError};
use serde_json::{Value, json};

use crate::game::Game;
use crate::manifest::{GenexToml, ManifestErrorCode, WgslKind, WgslSource, check_wgsl_api, valid_wgsl_path};

/// The `[[wgsl]]` rows a build lane may compile in (a `genex.toml` fragment), read when the game
/// folder has no `genex.toml` (a web, phone or exported build).
const BUILD_WGSL_TOML: Option<&str> = option_env!("GENEX_WGSL_TOML");
/// The title a `[[wgsl]]`-only fragment is parsed under (the manifest needs a `[game]` table).
const FRAGMENT_GAME: &str = "[game]\ntitle = \"wgsl\"\n";
/// The manifest file in the game folder.
const MANIFEST_FILE: &str = "genex.toml";
/// What cargo sets to the game crate's folder for `cargo run` and `cargo test` (dev flavour only).
#[cfg(all(feature = "studio", not(target_arch = "wasm32")))]
const MANIFEST_DIR_ENV: &str = "CARGO_MANIFEST_DIR";
/// The `volatile` key the admission rows are listed under.
pub const VOLATILE_EXTENSIONS_KEY: &str = "extensions";

/// Why the facade refused a Level-2 source. Wire spellings never change once shipped.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ExtensionRefusalCode {
    /// The path has no `[[wgsl]]` row (or no `genex.toml` declares any).
    WgslUndeclared,
    /// The `[[wgsl]]` row's kind is not the asking call's (a `pass` used as a material).
    WgslKindMismatch,
    /// The `genex.toml` rows could not be read: its code (`extension-api-unavailable` for an api
    /// this renderer does not serve yet).
    Manifest(ManifestErrorCode),
    /// genex-render refused it: `wgsl-too-large` with the [`ExtensionFault`], or
    /// `native-feature-missing`, or a device refusal.
    Render(RenderCode),
}

impl ExtensionRefusalCode {
    /// The code's wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            ExtensionRefusalCode::WgslUndeclared => "wgsl-undeclared",
            ExtensionRefusalCode::WgslKindMismatch => "wgsl-kind-mismatch",
            ExtensionRefusalCode::Manifest(code) => code.as_str(),
            ExtensionRefusalCode::Render(code) => code.wire(),
        }
    }
}

/// A typed Level-2 refusal: its code, the extension rule broken (for genex-render's refusals) and
/// what was refused, for the game's author.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExtensionRefusal {
    code: ExtensionRefusalCode,
    fault: Option<ExtensionFault>,
    detail: String,
}

impl ExtensionRefusal {
    fn new(code: ExtensionRefusalCode, detail: impl Into<String>) -> ExtensionRefusal {
        ExtensionRefusal { code, fault: None, detail: detail.into() }
    }

    fn path(detail: impl Into<String>) -> ExtensionRefusal {
        ExtensionRefusal::from(RenderError::extension(RenderCode::WgslTooLarge, ExtensionFault::PathRefused, detail))
    }

    /// The typed code.
    pub fn code(&self) -> ExtensionRefusalCode {
        self.code
    }

    /// The extension rule the source broke, for a genex-render refusal.
    pub fn fault(&self) -> Option<ExtensionFault> {
        self.fault
    }

    /// What was refused, in words.
    pub fn detail(&self) -> &str {
        &self.detail
    }
}

impl From<RenderError> for ExtensionRefusal {
    fn from(error: RenderError) -> ExtensionRefusal {
        ExtensionRefusal { code: ExtensionRefusalCode::Render(error.code()), fault: ExtensionFault::of(&error), detail: error.to_string() }
    }
}

impl fmt::Display for ExtensionRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.detail)
    }
}

impl std::error::Error for ExtensionRefusal {}

/// Where a game's Level-2 sources come from: the ones compiled into its binary and, natively, its
/// folder. Set on the [`Game`] before install.
#[derive(Clone, Debug, Default)]
pub(crate) struct WgslSetup {
    root: Option<PathBuf>,
    compiled: Vec<(String, &'static str)>,
}

impl WgslSetup {
    /// The game folder: the one the host set, else (dev flavour, natively) the crate folder cargo
    /// names for `cargo run` and `cargo test`.
    fn root(&self) -> Option<PathBuf> {
        self.root.clone().or_else(dev_root)
    }

    fn compiled(&self, path: &str) -> Option<&'static str> {
        self.compiled.iter().find(|(known, _)| known == path).map(|(_, source)| *source)
    }
}

#[cfg(all(feature = "studio", not(target_arch = "wasm32")))]
fn dev_root() -> Option<PathBuf> {
    std::env::var_os(MANIFEST_DIR_ENV).map(PathBuf::from).filter(|dir| dir.is_absolute())
}

#[cfg(not(all(feature = "studio", not(target_arch = "wasm32"))))]
fn dev_root() -> Option<PathBuf> {
    None
}

impl<W: Default + 'static> Game<W> {
    /// Compile a `[[wgsl]]` source into the game: `game.wgsl("shaders/water.wgsl",
    /// include_str!("../shaders/water.wgsl"))`. `gfx.material` and `gfx.post_pass` take it by its
    /// path on every destination (the web, phones and exports have no game folder to read).
    pub fn wgsl(&mut self, path: &str, source: &'static str) -> &mut Self {
        self.wgsl.compiled.retain(|(known, _)| known != path);
        self.wgsl.compiled.push((path.to_owned(), source));
        self
    }

    /// Read `[[wgsl]]` sources and `genex.toml` from `root` (host glue: a shell or a test names the
    /// game folder; a dev build otherwise uses its crate folder).
    #[doc(hidden)]
    pub fn wgsl_root(&mut self, root: &Path) -> &mut Self {
        self.wgsl.root = Some(root.to_path_buf());
        self
    }
}

/// One Level-2 request as the facade admitted or refused it.
#[derive(Debug)]
struct Admission {
    /// Its place among the reset's requests of its kind (the presenter's GPU cache key with the source).
    index: u32,
    path: String,
    kind: WgslKind,
    /// The `[[wgsl]]` api it was declared at (None before its row was found).
    api: Option<i64>,
    /// The game's source, when admitted.
    source: Option<Arc<str>>,
    /// Bytes of its uniform block (0 for none).
    uniform_size: u64,
    uniforms: Mutex<Vec<u8>>,
    /// The game textures a v2 material binds, in binding order (None: a missing texture).
    textures: Vec<Option<Arc<str>>>,
    refusal: Option<ExtensionRefusal>,
    /// Why the GPU refused it, once a frame used it.
    gpu_refusal: Mutex<Option<ExtensionRefusal>>,
}

/// A lock that a panicking holder cannot poison for the next reader (the data is plain bytes).
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Admission {
    fn row(&self) -> Value {
        let gpu = lock(&self.gpu_refusal).clone();
        let refusal = self.refusal.clone().or(gpu);
        json!({
            "path": self.path,
            "kind": self.kind.as_str(),
            "api": self.api,
            "code": refusal.as_ref().map(|r| r.code().as_str()),
            "fault": refusal.as_ref().and_then(ExtensionRefusal::fault).map(ExtensionFault::wire),
            "detail": refusal.as_ref().map(ExtensionRefusal::detail),
        })
    }
}

/// A custom material (`gfx.material`): draw meshes with it through `frame.custom(..)`.
/// `CustomMaterial::default()` is a missing material, drawn as the checker.
#[derive(Clone, Default)]
pub struct CustomMaterial {
    admission: Option<Arc<Admission>>,
}

/// A post pass (`gfx.post_pass`): run it over the frame through `frame.post_pass(..)`.
#[derive(Clone)]
pub struct PostPass {
    admission: Arc<Admission>,
}

impl CustomMaterial {
    /// Why it was refused, or None (admitted, or a missing material).
    pub fn refusal(&self) -> Option<&ExtensionRefusal> {
        self.admission.as_ref()?.refusal.as_ref()
    }

    /// Whether it draws the missing-asset checker (refused or missing).
    pub fn is_missing(&self) -> bool {
        self.admission.as_ref().is_none_or(|a| a.source.is_none())
    }

    /// The `[[wgsl]]` api it was admitted under (0 for a missing material).
    pub fn api(&self) -> i64 {
        self.admission.as_ref().and_then(|a| a.api).unwrap_or(0)
    }

    /// Its source's path under the game folder (empty for a missing material).
    pub fn path(&self) -> &str {
        self.admission.as_ref().map_or("", |a| a.path.as_str())
    }

    /// The uniform bytes it draws with now.
    pub fn uniform_bytes(&self) -> Vec<u8> {
        self.admission.as_ref().map(|a| lock(&a.uniforms).clone()).unwrap_or_default()
    }

    pub(crate) fn gpu_parts(&self) -> Option<GpuParts> {
        GpuParts::of(self.admission.as_ref()?)
    }
}

impl PostPass {
    /// Why it was refused, or None.
    pub fn refusal(&self) -> Option<&ExtensionRefusal> {
        self.admission.refusal.as_ref()
    }

    /// The `[[wgsl]]` api it was admitted under (0 before its row was found).
    pub fn api(&self) -> i64 {
        self.admission.api.unwrap_or(0)
    }

    /// Its source's path under the game folder.
    pub fn path(&self) -> &str {
        &self.admission.path
    }

    pub(crate) fn gpu_parts(&self) -> Option<GpuParts> {
        GpuParts::of(&self.admission)
    }
}

impl fmt::Debug for CustomMaterial {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CustomMaterial").field("path", &self.path()).field("refusal", &self.refusal()).finish()
    }
}

impl fmt::Debug for PostPass {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PostPass").field("path", &self.path()).field("refusal", &self.refusal()).finish()
    }
}

impl PartialEq for Admission {
    /// Two requests are equal when they asked for the same thing and got the same answer, so the
    /// worlds of two runtimes on one seed compare equal.
    fn eq(&self, other: &Self) -> bool {
        let asked = (self.index, &self.path, self.kind, self.api, &self.textures) == (other.index, &other.path, other.kind, other.api, &other.textures);
        let answered = (&self.source, self.uniform_size, &self.refusal) == (&other.source, other.uniform_size, &other.refusal);
        asked && answered && *lock(&self.uniforms) == *lock(&other.uniforms)
    }
}

impl PartialEq for CustomMaterial {
    fn eq(&self, other: &Self) -> bool {
        match (&self.admission, &other.admission) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b) || **a == **b,
            (None, None) => true,
            _ => false,
        }
    }
}

impl PartialEq for PostPass {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.admission, &other.admission) || *self.admission == *other.admission
    }
}

/// Which device extension an admitted request is: its place among the reset's requests of its kind
/// and its source.
pub(crate) struct GpuKey {
    pub index: u32,
    pub source: Arc<str>,
}

impl CustomMaterial {
    /// The device key of an admitted material (None for a refused or missing one).
    pub(crate) fn gpu_key(&self) -> Option<GpuKey> {
        let admission = self.admission.as_ref()?;
        Some(GpuKey { index: admission.index, source: Arc::clone(admission.source.as_ref()?) })
    }
}

impl PostPass {
    /// The device key of an admitted post pass (None for a refused one).
    pub(crate) fn gpu_key(&self) -> Option<GpuKey> {
        Some(GpuKey { index: self.admission.index, source: Arc::clone(self.admission.source.as_ref()?) })
    }
}

/// What the presenter needs to create an admitted extension on the GPU and keep its uniforms.
pub(crate) struct GpuParts {
    /// Which device extension it is.
    pub key: GpuKey,
    pub uniforms: Vec<u8>,
    /// The extension API it was admitted at.
    pub api: u32,
    /// The game textures it binds, in order (asset paths; None: missing, the neutral texel).
    pub textures: Vec<Option<Arc<str>>>,
    admission: Arc<Admission>,
}

impl GpuParts {
    fn of(admission: &Arc<Admission>) -> Option<GpuParts> {
        let key = GpuKey { index: admission.index, source: Arc::clone(admission.source.as_ref()?) };
        let uniforms = lock(&admission.uniforms).clone();
        let api = admission.api.and_then(|api| u32::try_from(api).ok()).unwrap_or(genex_render::abi::ABI_V1);
        Some(GpuParts { key, uniforms, api, textures: admission.textures.clone(), admission: Arc::clone(admission) })
    }

    /// Note the GPU's refusal (listed in `volatile.extensions`); answers whether it is new.
    pub fn refuse(&self, refusal: ExtensionRefusal) -> bool {
        let mut held = lock(&self.admission.gpu_refusal);
        let fresh = held.is_none();
        *held = Some(refusal);
        fresh
    }

    /// The path, for a log line.
    pub fn path(&self) -> &str {
        &self.admission.path
    }
}

/// The Level-2 requests of the current reset, in request order.
#[derive(Debug, Default)]
pub(crate) struct Extensions {
    setup: WgslSetup,
    admitted: Mutex<Vec<Arc<Admission>>>,
}

/// Little-endian bytes of `values`: what the GPU reads.
fn uniform_bytes(values: &[f32]) -> Vec<u8> {
    values.iter().flat_map(|value| value.to_le_bytes()).collect()
}

/// The extension point a Level-2 kind is admitted at (`gfx.material` and `gfx.post_pass` only ask
/// for these two; a Level-3 `pass` row never reaches here, its kind is refused first).
const fn extension_kind(kind: WgslKind) -> ExtensionKind {
    match kind {
        WgslKind::Post => ExtensionKind::PostPass,
        WgslKind::Material | WgslKind::Pass => ExtensionKind::Material,
    }
}

impl Extensions {
    pub(crate) fn new(setup: WgslSetup) -> Extensions {
        Extensions { setup, admitted: Mutex::new(Vec::new()) }
    }

    /// Forget the last reset's requests (a new seed asks again).
    pub(crate) fn clear(&self) {
        lock(&self.admitted).clear();
    }

    /// `volatile.extensions`: every request since the reset with its api and code; None for none.
    pub(crate) fn rows(&self) -> Option<Value> {
        let admitted = lock(&self.admitted);
        if admitted.is_empty() {
            return None;
        }
        Some(Value::Array(admitted.iter().map(|a| a.row()).collect()))
    }

    pub(crate) fn material(&self, path: &str, uniforms: &[f32]) -> CustomMaterial {
        self.material_textured(path, uniforms, Vec::new())
    }

    /// A material binding `textures` (asset paths in binding order; None: a missing texture).
    pub(crate) fn material_textured(&self, path: &str, uniforms: &[f32], textures: Vec<Option<Arc<str>>>) -> CustomMaterial {
        CustomMaterial { admission: Some(self.admit(path, WgslKind::Material, &uniform_bytes(uniforms), textures)) }
    }

    pub(crate) fn post_pass(&self, path: &str, uniforms: &[f32]) -> PostPass {
        PostPass { admission: self.admit(path, WgslKind::Post, &uniform_bytes(uniforms), Vec::new()) }
    }

    pub(crate) fn set_material_uniforms(material: &CustomMaterial, uniforms: &[f32]) -> Result<(), ExtensionRefusal> {
        let Some(admission) = material.admission.as_ref().filter(|a| a.source.is_some()) else {
            return Err(material.refusal().cloned().unwrap_or_else(|| ExtensionRefusal::new(ExtensionRefusalCode::WgslUndeclared, "a missing material")));
        };
        let bytes = uniform_bytes(uniforms);
        if bytes.len() as u64 != admission.uniform_size {
            return Err(layout_mismatch(bytes.len(), admission.uniform_size));
        }
        *lock(&admission.uniforms) = bytes;
        Ok(())
    }

    fn admit(&self, path: &str, kind: WgslKind, uniforms: &[u8], textures: Vec<Option<Arc<str>>>) -> Arc<Admission> {
        let mut admitted = lock(&self.admitted);
        let index = admitted.iter().filter(|a| a.kind == kind).count() as u32;
        let given = textures.len();
        let mut admission = Admission {
            index,
            path: path.to_owned(),
            kind,
            api: None,
            source: None,
            uniform_size: 0,
            uniforms: Mutex::new(uniforms.to_vec()),
            textures,
            refusal: None,
            gpu_refusal: Mutex::new(None),
        };
        let found = self.find(path, kind, &mut admission.api);
        let api = admission.api.and_then(|api| u32::try_from(api).ok()).unwrap_or(genex_render::abi::ABI_V1);
        match found.and_then(|source| check(kind, api, &source, uniforms, given).map(|size| (source, size))) {
            Ok((source, size)) => {
                admission.source = Some(Arc::from(source));
                admission.uniform_size = size;
            }
            Err(refusal) => admission.refusal = Some(refusal),
        }
        let admission = Arc::new(admission);
        admitted.push(Arc::clone(&admission));
        admission
    }

    /// Steps 1-3 of the module docs: the path, its declaration (its api noted in `api`) and its text.
    fn find(&self, path: &str, kind: WgslKind, api: &mut Option<i64>) -> Result<String, ExtensionRefusal> {
        if !valid_wgsl_path(path) {
            return Err(ExtensionRefusal::path(format!("`{path}` is not a plain relative .wgsl path inside the game")));
        }
        let root = self.setup.root();
        let compiled = self.setup.compiled(path);
        let declared = match declarations(root.as_deref())? {
            Some(rows) => Some(declared_row(&rows, path, kind)?),
            None if compiled.is_some() => None,
            None => return Err(undeclared(path)),
        };
        *api = Some(declared.as_ref().map_or(1, |row| row.api));
        if let Some(row) = &declared {
            check_wgsl_api(row).map_err(|error| ExtensionRefusal::new(ExtensionRefusalCode::Manifest(error.code()), error.to_string()))?;
        }
        match (compiled, root) {
            // With a game folder (a dev build, Live) its copy wins, so an edited shader takes
            // effect at the next reset with no rebuild (WP-9); the compiled copy stands in where
            // the folder has none or refuses it.
            (Some(source), Some(root)) => Ok(read_extension_source(&root, path).unwrap_or_else(|_| source.to_owned())),
            (Some(source), None) => Ok(source.to_owned()),
            (None, Some(root)) => Ok(read_extension_source(&root, path)?),
            (None, None) => Err(ExtensionRefusal::path(format!("`{path}` is neither compiled in (`game.wgsl`) nor in a game folder"))),
        }
    }
}

fn undeclared(path: &str) -> ExtensionRefusal {
    ExtensionRefusal::new(ExtensionRefusalCode::WgslUndeclared, format!("`{path}` has no [[wgsl]] row in genex.toml"))
}

fn layout_mismatch(given: usize, block: u64) -> ExtensionRefusal {
    let error = RenderError::extension(
        RenderCode::WgslTooLarge,
        ExtensionFault::LayoutMismatch,
        format!("{given} bytes of uniforms for a block of {block} bytes"),
    );
    ExtensionRefusal::from(error)
}

/// The `[[wgsl]]` row of `path`, when its kind is `kind`.
fn declared_row(rows: &[WgslSource], path: &str, kind: WgslKind) -> Result<WgslSource, ExtensionRefusal> {
    let row = rows.iter().find(|row| row.path == path).ok_or_else(|| undeclared(path))?;
    if row.kind != kind {
        let detail = format!("`{path}` is declared kind = \"{}\"; {} takes kind = \"{}\"", row.kind.as_str(), kind.facade_call(), kind.as_str());
        return Err(ExtensionRefusal::new(ExtensionRefusalCode::WgslKindMismatch, detail));
    }
    Ok(row.clone())
}

/// The game's `[[wgsl]]` rows: its folder's `genex.toml` (read like a source: inside the folder, a
/// regular file), else the build's fragment; None when neither exists.
fn declarations(root: Option<&Path>) -> Result<Option<Vec<WgslSource>>, ExtensionRefusal> {
    let on_disk = root.filter(|root| root.join(MANIFEST_FILE).exists());
    let text = match on_disk {
        Some(root) => read_extension_source(root, MANIFEST_FILE)?,
        None => match BUILD_WGSL_TOML {
            Some(fragment) => format!("{FRAGMENT_GAME}{fragment}"),
            None => return Ok(None),
        },
    };
    // Read as data: only the `[[wgsl]]` rows matter here (the lane refuses the rest of the file).
    let manifest: GenexToml = toml::from_str(&text)
        .map_err(|error| ExtensionRefusal::new(ExtensionRefusalCode::Manifest(ManifestErrorCode::Syntax), error.message().to_owned()))?;
    Ok(Some(manifest.wgsl))
}

/// Step 4: naga admits `source` for `kind` at `api` (against WebGPU core plus the build's declared
/// features), the uniforms fit its block and a material is handed the `textures` it binds;
/// answers the block's size.
fn check(kind: WgslKind, api: u32, source: &str, uniforms: &[u8], textures: usize) -> Result<u64, ExtensionRefusal> {
    let declared = declared_features();
    let validated = validate_api(extension_kind(kind), api, source, &ExtensionContext::new(declared, declared))?;
    validated.check_uniforms(uniforms)?;
    if kind == WgslKind::Material {
        validated.check_textures(textures)?;
    }
    Ok(validated.uniform_bytes().unwrap_or(0))
}

#[cfg(not(target_arch = "wasm32"))]
fn declared_features() -> wgpu::Features {
    crate::present::declared_features().unwrap_or(wgpu::Features::empty())
}

/// The web is WebGPU core.
#[cfg(target_arch = "wasm32")]
fn declared_features() -> wgpu::Features {
    wgpu::Features::empty()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_refusal_code_has_its_wire_spelling() {
        let rows = [
            (ExtensionRefusalCode::WgslUndeclared, "wgsl-undeclared"),
            (ExtensionRefusalCode::WgslKindMismatch, "wgsl-kind-mismatch"),
            (ExtensionRefusalCode::Manifest(ManifestErrorCode::ExtensionApiUnavailable), "extension-api-unavailable"),
            (ExtensionRefusalCode::Render(RenderCode::WgslTooLarge), "wgsl-too-large"),
        ];
        for (code, wire) in rows {
            assert_eq!(code.as_str(), wire);
        }
    }

    #[test]
    fn a_missing_material_draws_the_checker_and_takes_no_uniforms() {
        let missing = CustomMaterial::default();
        assert!(missing.is_missing() && missing.refusal().is_none() && missing.api() == 0);
        assert!(Extensions::set_material_uniforms(&missing, &[1.0]).is_err());
        assert_eq!(missing, CustomMaterial::default());
    }
}
