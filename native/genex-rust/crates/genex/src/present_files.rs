//! The native presenter's device and model files: a studio run and the desktop shell open the
//! shared [`Presenter`] headless on the host GPU, with the game's declared native-enhanced
//! features, and read models from the table a game compiled in, then `assets/` beside the
//! executable (`../Resources/assets/` inside a Mac app bundle, as the C++ runtime's `platform.cpp`
//! finds them). A dev-flavour build (feature `studio`) with no `assets/` beside it, such as a plain
//! `cargo run` from `target/debug`, reads `$CARGO_MANIFEST_DIR/assets` instead; an export never
//! does. Models are loaded once per path; a path outside the asset-path rule is never read.

#[cfg(feature = "studio")]
use std::ffi::OsString;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};

use crate::gfx::AssetTable;
use crate::present::{ModelSource, Presenter, declared_features};
use genex_core::paths::is_safe_asset_path;
use genex_render::{Gpu, RenderError};

/// Where a Mac app bundle keeps its executable, and its assets relative to it.
const BUNDLE_EXECUTABLE_DIR: &str = "Contents/MacOS";
const BUNDLE_ASSETS: &str = "../Resources/assets";
const ASSETS_DIR: &str = "assets";
/// What cargo sets to the game crate's folder for `cargo run` and `cargo test` (dev fallback).
#[cfg(feature = "studio")]
const MANIFEST_DIR_ENV: &str = "CARGO_MANIFEST_DIR";

/// Models from the compiled table first, then files under the asset folder.
struct FileSource {
    table: AssetTable,
    root: Option<PathBuf>,
}

impl ModelSource for FileSource {
    fn model_bytes(&self, path: &str) -> Option<Vec<u8>> {
        if let Some(bytes) = self.table.model_bytes(path) {
            return Some(bytes);
        }
        // `Assets::model` already held the path to the rule; held again before any file is read.
        let root = self.root.as_ref().filter(|_| is_safe_asset_path(path))?;
        std::fs::read(root.join(path)).ok()
    }

    /// The compiled table's bytes only: a file under the asset folder may change, so its decoded
    /// upload is kept.
    fn static_bytes(&self, path: &str) -> Option<&'static [u8]> {
        self.table.static_bytes(path)
    }
}

/// A native refusal goes to stderr, prefixed as the runtime's other lines are.
fn log_to_stderr(line: &str) {
    eprintln!("genex: {line}");
}

/// `assets/` beside the executable, or the bundle's Resources/assets for a Mac app.
fn beside_executable() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let bundled = dir.ends_with(BUNDLE_EXECUTABLE_DIR);
    Some(dir.join(if bundled { BUNDLE_ASSETS } else { ASSETS_DIR }))
}

/// The game crate's folder as cargo gives it to `cargo run` and `cargo test`, in the dev flavour
/// only: an export never reads a folder outside its own.
#[cfg(feature = "studio")]
fn dev_manifest_dir() -> Option<OsString> {
    std::env::var_os(MANIFEST_DIR_ENV)
}

#[cfg(not(feature = "studio"))]
fn dev_manifest_dir() -> Option<std::ffi::OsString> {
    None
}

/// Where models are read from disk: `beside` (the executable's `assets/`) when it is a folder;
/// else `<dev manifest>/assets` when the manifest folder is absolute and has one; else `beside`.
fn resolve_asset_root(
    beside: Option<PathBuf>,
    dev_manifest: Option<&OsStr>,
    is_dir: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    if beside.as_deref().is_some_and(&is_dir) {
        return beside;
    }
    let manifest = dev_manifest.map(Path::new).filter(|dir| dir.is_absolute());
    let fallback = manifest.map(|dir| dir.join(ASSETS_DIR)).filter(|dir| is_dir(dir));
    fallback.or(beside)
}

/// The folder a native run reads its models from ([`resolve_asset_root`] for this process).
fn asset_root() -> Option<PathBuf> {
    resolve_asset_root(beside_executable(), dev_manifest_dir().as_deref(), Path::is_dir)
}

impl Presenter {
    /// Open the GPU headless with the game's declared features for a logical world of `size`;
    /// models come from `assets`, then this process's asset folder ([`asset_root`]).
    pub fn open(size: [u32; 2], assets: AssetTable) -> Result<Presenter, RenderError> {
        Presenter::open_with_root(size, assets, asset_root())
    }

    /// [`Presenter::open`] reading models from `assets` and `asset_root` only (None: the table only).
    pub fn open_with_root(size: [u32; 2], assets: AssetTable, asset_root: Option<PathBuf>) -> Result<Presenter, RenderError> {
        let declared = declared_features()?;
        let gpu = Gpu::headless_with(declared)?;
        let open = move || Gpu::headless_with(declared);
        let source = Box::new(FileSource { table: assets, root: asset_root });
        Presenter::with_gpu(gpu, size, declared, Box::new(open), source, log_to_stderr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Folders that exist, for [`resolve_asset_root`].
    fn folders(list: &'static [&'static str]) -> impl Fn(&Path) -> bool {
        move |path| list.iter().any(|dir| path == Path::new(dir))
    }

    /// A dev build run away from its run folder (a plain `cargo run`, the binary in
    /// `target/debug`) reads its crate's `assets/`; `assets/` beside the executable always wins,
    /// and a relative, empty or asset-less manifest folder is never used.
    #[test]
    fn the_dev_asset_fallback_is_the_manifest_assets_only_when_nothing_is_beside_the_executable() {
        let beside = || Some(PathBuf::from("/run/bin/assets"));
        let os = |dir: &'static str| Some(OsStr::new(dir));
        // (the dev manifest folder, the folders that exist, the root)
        let rows: [(Option<&OsStr>, &'static [&'static str], &str); 6] = [
            (os("/src/game"), &["/run/bin/assets", "/src/game/assets"], "/run/bin/assets"),
            (os("/src/game"), &["/src/game/assets"], "/src/game/assets"),
            (os("src/game"), &["/src/game/assets", "src/game/assets"], "/run/bin/assets"),
            (os(""), &["assets"], "/run/bin/assets"),
            (os("/src/empty"), &["/src/empty"], "/run/bin/assets"),
            (None, &["/src/game/assets"], "/run/bin/assets"),
        ];
        for (dev, existing, root) in rows {
            let resolved = resolve_asset_root(beside(), dev, folders(existing));
            assert_eq!(resolved, Some(PathBuf::from(root)), "{dev:?} {existing:?}");
        }
        let no_exe = resolve_asset_root(None, os("/src/game"), folders(&["/src/game/assets"]));
        assert_eq!(no_exe, Some(PathBuf::from("/src/game/assets")));
    }

    /// An export (built without the dev flavour's `studio` feature) never reads a manifest folder.
    #[cfg(not(feature = "studio"))]
    #[test]
    fn an_export_has_no_dev_asset_fallback() {
        assert_eq!(dev_manifest_dir(), None);
    }

    /// The table answers first; a file is read only from under the root and only under the
    /// asset-path rule, so a hostile path reads nothing.
    #[test]
    fn models_come_from_the_table_then_the_root_and_never_from_outside_it() {
        let dir = std::env::temp_dir().join(format!("genex-present-files-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("assets")).expect("assets folder");
        std::fs::write(dir.join("assets/disk.glb"), b"disk").expect("asset");
        std::fs::write(dir.join("secret.glb"), b"secret").expect("outside file");
        let source = FileSource { table: &[("table.glb", b"table")], root: Some(dir.join("assets")) };
        assert_eq!(source.model_bytes("table.glb").as_deref(), Some(&b"table"[..]));
        assert_eq!(source.model_bytes("disk.glb").as_deref(), Some(&b"disk"[..]));
        for hostile in ["../secret.glb", "/etc/hosts", "a/../../secret.glb", "", "missing.glb"] {
            assert_eq!(source.model_bytes(hostile), None, "{hostile:?}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
