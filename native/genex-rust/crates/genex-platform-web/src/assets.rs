//! A game's staged assets on the web. A browser cannot list a folder, so the host's lane writes
//! `assets.json` (the asset map: each staged file's `/`-separated path under `assets/`, its length
//! and its FNV-1a 64) beside the page (`webAssetMap` in `src/main/rust-build-web.ts`). Before the
//! first frame the shell hands the map to [`WebAssets::plan`], fetches exactly the files it planned
//! and hands each to [`WebAssets::admit`].
//!
//! The rules are the desktop's ([`genex_core::paths::is_safe_asset_path`], at most
//! [`MAX_ASSET_BYTES`] a file), plus the web's own caps on the whole set: an entry that breaks one
//! is never planned, so the shell never fetches it, and bytes for a path the map did not plan, or
//! that are not exactly the recorded length and digest, never reach the table. A model whose file
//! is not in the table draws the magenta checker, as on the desktop.

use crate::draw::{AssetSource, AssetTable};
use genex_core::digest::fnv1a64;
use serde_json::Value;

/// The asset map's format (`WEB_ASSET_MAP_VERSION` host-side).
pub const ASSET_MAP_VERSION: u64 = 1;
/// The largest file a game reads (genex-assets' `MAX_ASSET_BYTES`, the desktop's cap).
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
/// The most the web keeps in the module's memory for all of a game's assets.
pub const MAX_ASSETS_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// The most files a map may plan.
pub const MAX_ASSET_FILES: usize = 4096;
/// The largest asset map read.
pub const MAX_ASSET_MAP_BYTES: usize = 4 * 1024 * 1024;
/// The digest's spelling: FNV-1a 64 as 16 lowercase hex digits.
const DIGEST_HEX_DIGITS: usize = 16;

/// Why the map, an entry or a file's bytes were refused. Wire codes: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetRefusal {
    /// The map is not a version-1 object with a `files` array, or an entry is malformed.
    MapInvalid,
    /// The path breaks the asset-path rule.
    UnsafePath,
    /// The file is over [`MAX_ASSET_BYTES`].
    TooLarge,
    /// Planning it would pass [`MAX_ASSET_FILES`] or [`MAX_ASSETS_TOTAL_BYTES`].
    OverBudget,
    /// The map names the path twice.
    Duplicate,
    /// Bytes for a path the map did not plan (or that already arrived).
    NotPlanned,
    /// The bytes are not the recorded length.
    SizeMismatch,
    /// The bytes are the recorded length but not the recorded digest.
    DigestMismatch,
}

impl AssetRefusal {
    /// The wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            AssetRefusal::MapInvalid => "asset-map-invalid",
            AssetRefusal::UnsafePath => "asset-unsafe-path",
            AssetRefusal::TooLarge => "asset-too-large",
            AssetRefusal::OverBudget => "asset-over-budget",
            AssetRefusal::Duplicate => "asset-duplicate",
            AssetRefusal::NotPlanned => "asset-not-planned",
            AssetRefusal::SizeMismatch => "asset-size-mismatch",
            AssetRefusal::DigestMismatch => "asset-digest-mismatch",
        }
    }
}

/// A refusal with what it was about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AssetError {
    code: AssetRefusal,
    detail: String,
}

impl AssetError {
    fn new(code: AssetRefusal, detail: impl Into<String>) -> AssetError {
        AssetError { code, detail: detail.into() }
    }

    /// The typed code.
    pub fn code(&self) -> AssetRefusal {
        self.code
    }
}

impl std::fmt::Display for AssetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for AssetError {}

/// A file the shell fetches: its path under `assets/`, its length and its FNV-1a 64.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedAsset {
    /// The `/`-separated path under `assets/`.
    pub path: String,
    /// Its recorded length.
    pub bytes: u64,
    digest: u64,
}

/// The game's fetched assets: what the map planned, what it left out and why, and the files admitted.
#[derive(Debug, Default)]
pub struct WebAssets {
    planned: Vec<PlannedAsset>,
    skipped: Vec<(String, AssetRefusal)>,
    loaded: Vec<(String, Vec<u8>)>,
}

/// One entry's fields, or why it is malformed.
fn entry_fields(entry: &Value) -> Option<(&str, u64, u64)> {
    let path = entry.get("path")?.as_str()?;
    let bytes = entry.get("bytes")?.as_u64()?;
    let digest = entry.get("fnv1a64")?.as_str()?;
    let hex = digest.len() == DIGEST_HEX_DIGITS && digest.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !hex {
        return None;
    }
    Some((path, bytes, u64::from_str_radix(digest, 16).ok()?))
}

/// The `files` array of a well-formed map.
fn map_files(map: &[u8]) -> Result<Vec<Value>, AssetError> {
    let invalid = |detail: &str| AssetError::new(AssetRefusal::MapInvalid, detail);
    if map.len() > MAX_ASSET_MAP_BYTES {
        return Err(invalid("the asset map is too large"));
    }
    let mut value: Value = serde_json::from_slice(map).map_err(|error| invalid(&error.to_string()))?;
    if value.get("version").and_then(Value::as_u64) != Some(ASSET_MAP_VERSION) {
        return Err(invalid("the asset map is not version 1"));
    }
    match value.get_mut("files").map(Value::take) {
        Some(Value::Array(files)) => Ok(files),
        _ => Err(invalid("the asset map has no files array")),
    }
}

impl WebAssets {
    /// Plan the fetches from the asset map's bytes: every entry under the asset-path rule and the
    /// caps, in the map's order. A map that is not a version-1 object with a `files` array is
    /// refused `asset-map-invalid`; a single bad entry is left out with its reason.
    pub fn plan(map: &[u8]) -> Result<WebAssets, AssetError> {
        let mut assets = WebAssets::default();
        let mut total: u64 = 0;
        for entry in map_files(map)? {
            let label = entry.get("path").and_then(Value::as_str).unwrap_or_default().to_owned();
            match assets.check(&entry, total) {
                Ok(planned) => {
                    total += planned.bytes;
                    assets.planned.push(planned);
                }
                Err(refusal) => assets.skipped.push((label, refusal)),
            }
        }
        Ok(assets)
    }

    /// The entry as a planned fetch, given `total` bytes planned so far; or why it is left out.
    fn check(&self, entry: &Value, total: u64) -> Result<PlannedAsset, AssetRefusal> {
        let (path, bytes, digest) = entry_fields(entry).ok_or(AssetRefusal::MapInvalid)?;
        if !genex_core::paths::is_safe_asset_path(path) {
            return Err(AssetRefusal::UnsafePath);
        }
        if bytes > MAX_ASSET_BYTES {
            return Err(AssetRefusal::TooLarge);
        }
        if self.planned.iter().any(|known| known.path == path) {
            return Err(AssetRefusal::Duplicate);
        }
        let over_count = self.planned.len() >= MAX_ASSET_FILES;
        if over_count || total.saturating_add(bytes) > MAX_ASSETS_TOTAL_BYTES {
            return Err(AssetRefusal::OverBudget);
        }
        Ok(PlannedAsset { path: path.to_owned(), bytes, digest })
    }

    /// The files the shell fetches, in the map's order.
    pub fn planned(&self) -> &[PlannedAsset] {
        &self.planned
    }

    /// The entries left out, with why (by the path the map wrote, as written).
    pub fn skipped(&self) -> &[(String, AssetRefusal)] {
        &self.skipped
    }

    /// Admit a fetched file: only for a path the map planned and not yet admitted, with exactly the
    /// recorded length and FNV-1a 64. A refused file never reaches the table.
    pub fn admit(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), AssetError> {
        let refused = |code: AssetRefusal| AssetError::new(code, format!("{path:?}"));
        let Some(planned) = self.planned.iter().find(|known| known.path == path) else {
            return Err(refused(AssetRefusal::NotPlanned));
        };
        if self.get(path).is_some() {
            return Err(refused(AssetRefusal::NotPlanned));
        }
        if bytes.len() as u64 != planned.bytes {
            return Err(refused(AssetRefusal::SizeMismatch));
        }
        if fnv1a64(&bytes) != planned.digest {
            return Err(refused(AssetRefusal::DigestMismatch));
        }
        self.loaded.push((path.to_owned(), bytes));
        Ok(())
    }

    /// The admitted bytes of `path`.
    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.loaded.iter().find(|(known, _)| known == path).map(|(_, bytes)| bytes.as_slice())
    }
}

impl AssetSource for WebAssets {
    fn asset(&self, path: &str) -> Option<&[u8]> {
        self.get(path)
    }
}

/// The assets a web build draws from: those compiled into the module first, then the fetched ones.
pub struct Layered<'a> {
    /// The game's compiled table (`install_with_assets`).
    pub compiled: AssetTable,
    /// The staged files the shell fetched.
    pub fetched: &'a WebAssets,
}

impl AssetSource for Layered<'_> {
    fn asset(&self, path: &str) -> Option<&[u8]> {
        self.compiled.asset(path).or_else(|| self.fetched.get(path))
    }
}
