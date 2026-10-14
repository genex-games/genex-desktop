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

use std::cell::RefCell;
use std::sync::Arc;

use genex_core::paths::is_safe_asset_path;
use genex_core::saves::Saves;
use serde_json::Value;

use crate::extend::{CustomMaterial, ExtensionRefusal, Extensions, PostPass, WgslSetup};

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
}

impl Model {
    /// The path under `assets/`, or `None` for a missing model.
    pub fn path(&self) -> Option<&str> {
        self.path.as_deref()
    }

    /// Whether this handle draws the magenta checker.
    pub fn is_missing(&self) -> bool {
        self.path.is_none()
    }
}

/// The game's `assets/` folder.
#[derive(Debug, Default)]
pub struct Assets {
    requested: RefCell<Vec<String>>,
}

impl Assets {
    /// A model at `assets/<path>` (glTF or GLB); a missing model when the path is not a plain
    /// relative path (no absolute path, `..`, `.`, empty segment or backslash).
    pub fn model(&self, path: &str) -> Model {
        if !is_safe_asset_path(path) {
            return Model::default();
        }
        self.note(path);
        Model { path: Some(Arc::from(path)) }
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

    pub(crate) fn clear(&self) {
        self.requested.borrow_mut().clear();
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
}

impl Gfx {
    pub(crate) fn new(world_size: [u32; 2], saves: Saves, wgsl: WgslSetup) -> Gfx {
        Gfx { assets: Assets::default(), world_size, saves, extensions: Extensions::new(wgsl), textured: RefCell::new(Vec::new()) }
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
        Gfx::new([320, 180], Saves::at(Err(genex_core::paths::SaveRefusal::NoStateDir)), WgslSetup::default())
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
