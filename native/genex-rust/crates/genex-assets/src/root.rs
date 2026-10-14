//! The asset folder a game reads from, and the one way it reads: the asset-path rule first, then
//! no link at the name, then the real path inside the folder's own, then a regular file of a
//! bounded size. A FIFO or a device is never opened.

use crate::error::{AssetError, AssetErrorCode};
use genex_core::paths::is_safe_asset_path;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

/// The largest file a game reads into memory.
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;

/// A game's asset folder, by its real path.
#[derive(Clone, Debug)]
pub struct AssetRoot {
    root: PathBuf,
}

fn io_error(rel: &str, error: &std::io::Error) -> AssetError {
    let code = match error.kind() {
        ErrorKind::NotFound | ErrorKind::NotADirectory => AssetErrorCode::Missing,
        ErrorKind::IsADirectory => AssetErrorCode::NotAFile,
        _ => AssetErrorCode::Missing,
    };
    AssetError::new(code, format!("{rel}: {error}"))
}

impl AssetRoot {
    /// The asset folder at `root`, which must exist; links on the way to it are resolved once, here.
    pub fn open(root: impl AsRef<Path>) -> Result<AssetRoot, AssetError> {
        let root = fs::canonicalize(root.as_ref()).map_err(|e| io_error("assets", &e))?;
        if !root.is_dir() {
            return Err(AssetError::new(AssetErrorCode::NotAFile, "the asset folder is not a folder"));
        }
        Ok(AssetRoot { root })
    }

    /// The folder's real path.
    pub fn path(&self) -> &Path {
        &self.root
    }

    /// The bytes of `rel` (a `/`-separated name under the folder), or why not. Nothing is read
    /// unless the name passes the asset-path rule, is not itself a link, and stays inside the
    /// folder once every link on the way is followed.
    pub fn read(&self, rel: &str) -> Result<Vec<u8>, AssetError> {
        if !is_safe_asset_path(rel) {
            return Err(AssetError::new(AssetErrorCode::UnsafePath, format!("{rel:?}")));
        }
        let named = rel.split('/').fold(self.root.clone(), |path, segment| path.join(segment));
        let link = fs::symlink_metadata(&named).map_err(|e| io_error(rel, &e))?;
        if link.file_type().is_symlink() {
            return Err(AssetError::new(AssetErrorCode::EscapesAssets, format!("{rel} is a link")));
        }
        let real = fs::canonicalize(&named).map_err(|e| io_error(rel, &e))?;
        if !real.starts_with(&self.root) || real == self.root {
            return Err(AssetError::new(AssetErrorCode::EscapesAssets, format!("{rel} leaves the asset folder")));
        }
        let meta = fs::metadata(&real).map_err(|e| io_error(rel, &e))?;
        if !meta.is_file() {
            return Err(AssetError::new(AssetErrorCode::NotAFile, rel.to_owned()));
        }
        if meta.len() > MAX_ASSET_BYTES {
            return Err(AssetError::new(AssetErrorCode::TooLarge, format!("{rel}: {} bytes", meta.len())));
        }
        let bytes = fs::read(&real).map_err(|e| io_error(rel, &e))?;
        if bytes.len() as u64 > MAX_ASSET_BYTES {
            return Err(AssetError::new(AssetErrorCode::TooLarge, rel.to_owned()));
        }
        Ok(bytes)
    }
}
