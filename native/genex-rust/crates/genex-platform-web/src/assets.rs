//! A game's staged assets on the web. A browser cannot list a folder, so the host's lane writes
//! `assets.json` (the asset map: each staged file's `/`-separated path under `assets/`, its length
//! and its FNV-1a 64) beside the page (`webAssetMap` in `src/main/rust-build-web.ts`). Before the
//! first frame the shell hands the map to [`WebAssets::plan`], fetches exactly the files it
//! answers in [`WebAssets::preload`] and hands each to [`WebAssets::admit`].
//!
//! The rules are the desktop's ([`genex_core::paths::is_safe_asset_path`], at most
//! [`MAX_ASSET_BYTES`] a file), plus the web's own caps on the whole set: an entry that breaks one
//! is never planned, so the shell never fetches it, and bytes for a path the map did not plan, or
//! that are not exactly the recorded length and digest, never reach the table. A model whose file
//! is not in the table draws the magenta checker, as on the desktop.
//!
//! **Map v2** (game systems SF-2) adds three optional members to an entry; a v1 map (none of them)
//! plans and admits exactly as before, every entry in the `sim` group:
//! - `group`: `boot`, `sim` (the default), `stream` or `named` (with `name`, the `genex.toml` group).
//!   Boot and sim files are preloaded before the first reset; stream and named files are fetched
//!   while playing, when the game wants them ([`WebAssets::want`], [`WebAssets::take_wanted`]),
//!   and can be released again ([`WebAssets::release`]). The groups reach the sim's reads
//!   ([`WebAssets::groups`]), so a reset refuses a streamed file `not-preloaded` as natively.
//! - `ranges`: `[{offset, bytes, fnv1a64}]`, a streamed file's pieces (KTX2 levels, cell pack
//!   sections), each fetched by a `Range` request and admitted by its own length and digest
//!   ([`WebAssets::arrived`]). Ranges lie inside the file, never overlap, and only a streamed or
//!   named entry has them: boot and sim files are fetched whole.
//! - `family` and `of`: one GPU family file (`bc`, `astc`, `etc2`, `rgba8`) or the `source` image of
//!   the texture `of` names. [`WebAssets::plan_for`] plans one file per texture: the first family
//!   the adapter samples, else `rgba8`, else the source.
//!
//! A refusal (`asset-range-invalid`, `asset-group-invalid` for the v2 members) changes nothing:
//! a refused entry is left out with its reason, refused bytes never load, a refused release keeps
//! the file.

use crate::draw::{AssetSource, AssetTable};
use genex::{AssetGroup, AssetGroups};
use genex_core::digest::fnv1a64;
use genex_render::texture::TextureFamily;
use serde_json::{Map, Value};

/// The newest asset map format this module reads; [`ASSET_MAP_V1`] still reads. The host's
/// `WEB_ASSET_MAP_VERSION` names the one its lane writes.
pub const ASSET_MAP_VERSION: u64 = 2;
/// The first asset map format: path, length and digest only.
pub const ASSET_MAP_V1: u64 = 1;
/// The largest file a game reads (genex-assets' `MAX_ASSET_BYTES`, the desktop's cap).
pub const MAX_ASSET_BYTES: u64 = 256 * 1024 * 1024;
/// The most the web keeps in the module's memory for all of a game's assets.
pub const MAX_ASSETS_TOTAL_BYTES: u64 = 512 * 1024 * 1024;
/// The most files a map may plan.
pub const MAX_ASSET_FILES: usize = 4096;
/// The largest asset map read.
pub const MAX_ASSET_MAP_BYTES: usize = 4 * 1024 * 1024;
/// The most ranges one file may have (a KTX2's levels and its header, a cell pack's sections).
pub const MAX_RANGES_PER_FILE: usize = 256;
/// The digest's spelling: FNV-1a 64 as 16 lowercase hex digits.
const DIGEST_HEX_DIGITS: usize = 16;
/// The `family` of a texture's source image (the file the game names).
const SOURCE_FAMILY: &str = "source";

/// Why the map, an entry or a file's bytes were refused. Wire codes: never rename one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AssetRefusal {
    /// The map is not a version-1 or version-2 object with a `files` array, or an entry is malformed.
    MapInvalid,
    /// The path breaks the asset-path rule.
    UnsafePath,
    /// The file is over [`MAX_ASSET_BYTES`].
    TooLarge,
    /// Planning it would pass [`MAX_ASSET_FILES`] or [`MAX_ASSETS_TOTAL_BYTES`].
    OverBudget,
    /// The map names the path twice.
    Duplicate,
    /// Bytes for a path or range the map did not plan (or that already arrived).
    NotPlanned,
    /// The bytes are not the recorded length.
    SizeMismatch,
    /// The bytes are the recorded length but not the recorded digest.
    DigestMismatch,
    /// An entry's ranges run past the file, overlap, are empty, malformed or too many.
    RangeInvalid,
    /// An entry's group is not one the map format has, a named group has no name, a ranged entry
    /// claims a preloaded group, or a preloaded file was asked to be released.
    GroupInvalid,
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
            AssetRefusal::RangeInvalid => "asset-range-invalid",
            AssetRefusal::GroupInvalid => "asset-group-invalid",
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

/// One piece of a streamed file: where it starts, its length and its FNV-1a 64.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AssetRange {
    /// Its first byte in the file.
    pub offset: u64,
    /// Its length.
    pub bytes: u64,
    digest: u64,
}

/// A file the map planned: its path under `assets/`, its length and FNV-1a 64, and the v2 members.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PlannedAsset {
    /// The `/`-separated path under `assets/`.
    pub path: String,
    /// Its recorded length.
    pub bytes: u64,
    digest: u64,
    /// Its group (`sim` when the map names none).
    pub group: AssetGroup,
    /// The named group's name (`genex.toml`), for a `named` entry.
    pub name: Option<String>,
    /// Its pieces, for a streamed file fetched by ranges; empty for a file fetched whole.
    pub ranges: Vec<AssetRange>,
}

/// One fetch the shell makes while playing: `bytes` bytes of `path` from `offset` (the whole file
/// when it has no ranges).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fetch {
    /// The `/`-separated path under `assets/`.
    pub path: String,
    /// The first byte.
    pub offset: u64,
    /// How many bytes.
    pub bytes: u64,
}

/// The game's fetched assets: what the map planned, what it left out and why, the files and
/// ranges admitted, and the fetches the game wants.
#[derive(Debug, Default)]
pub struct WebAssets {
    planned: Vec<PlannedAsset>,
    skipped: Vec<(String, AssetRefusal)>,
    loaded: Vec<(String, Vec<u8>)>,
    pieces: Vec<(String, u64, Vec<u8>)>,
    wanted: Vec<Fetch>,
}

/// An entry as read, before the family pick and the caps: the planned file, and its texture
/// (`of`) and family for a per-family file.
struct Candidate {
    asset: PlannedAsset,
    texture: Option<(String, String)>,
}

fn hex_digest(text: &str) -> Option<u64> {
    let hex = text.len() == DIGEST_HEX_DIGITS && text.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !hex {
        return None;
    }
    u64::from_str_radix(text, 16).ok()
}

/// One entry's path, length and digest, or why it is malformed.
fn entry_fields(entry: &Value) -> Option<(&str, u64, u64)> {
    let path = entry.get("path")?.as_str()?;
    let bytes = entry.get("bytes")?.as_u64()?;
    Some((path, bytes, hex_digest(entry.get("fnv1a64")?.as_str()?)?))
}

/// The entry's group and the named group's name.
fn entry_group(entry: &Map<String, Value>) -> Result<(AssetGroup, Option<String>), AssetRefusal> {
    let Some(group) = entry.get("group") else { return Ok((AssetGroup::Sim, None)) };
    let name = entry.get("name").and_then(Value::as_str).filter(|name| !name.is_empty());
    match (group.as_str(), name) {
        (Some("boot"), _) => Ok((AssetGroup::Boot, None)),
        (Some("sim"), _) => Ok((AssetGroup::Sim, None)),
        (Some("stream"), _) => Ok((AssetGroup::Stream, None)),
        (Some("named"), Some(name)) => Ok((AssetGroup::Named, Some(name.to_owned()))),
        _ => Err(AssetRefusal::GroupInvalid),
    }
}

/// The entry's ranges, each inside the file, none empty, none overlapping, at most
/// [`MAX_RANGES_PER_FILE`]; in the map's order (the writer lists a KTX2's smallest levels first).
fn entry_ranges(entry: &Map<String, Value>, file_bytes: u64) -> Result<Vec<AssetRange>, AssetRefusal> {
    let Some(ranges) = entry.get("ranges") else { return Ok(Vec::new()) };
    let ranges = ranges.as_array().filter(|ranges| !ranges.is_empty() && ranges.len() <= MAX_RANGES_PER_FILE).ok_or(AssetRefusal::RangeInvalid)?;
    let mut read = Vec::with_capacity(ranges.len());
    for range in ranges {
        let offset = range.get("offset").and_then(Value::as_u64);
        let bytes = range.get("bytes").and_then(Value::as_u64).filter(|&bytes| bytes > 0);
        let digest = range.get("fnv1a64").and_then(Value::as_str).and_then(hex_digest);
        let (Some(offset), Some(bytes), Some(digest)) = (offset, bytes, digest) else { return Err(AssetRefusal::RangeInvalid) };
        if offset.checked_add(bytes).is_none_or(|end| end > file_bytes) {
            return Err(AssetRefusal::RangeInvalid);
        }
        read.push(AssetRange { offset, bytes, digest });
    }
    let mut sorted: Vec<&AssetRange> = read.iter().collect();
    sorted.sort_by_key(|range| range.offset);
    if sorted.windows(2).any(|pair| pair[0].offset + pair[0].bytes > pair[1].offset) {
        return Err(AssetRefusal::RangeInvalid);
    }
    Ok(read)
}

/// The entry's texture and family (`of`, `family`) when it is a per-family file.
fn entry_texture(entry: &Map<String, Value>) -> Result<Option<(String, String)>, AssetRefusal> {
    let Some(family) = entry.get("family") else { return Ok(None) };
    let family = family.as_str().ok_or(AssetRefusal::MapInvalid)?;
    let known = family == SOURCE_FAMILY || TextureFamily::ALL.iter().any(|known| known.wire() == family);
    let texture = entry.get("of").and_then(Value::as_str).filter(|of| !of.is_empty());
    match (known, texture) {
        (true, Some(texture)) => Ok(Some((texture.to_owned(), family.to_owned()))),
        _ => Err(AssetRefusal::MapInvalid),
    }
}

/// The `files` array of a well-formed map.
fn map_files(map: &[u8]) -> Result<Vec<Value>, AssetError> {
    let invalid = |detail: &str| AssetError::new(AssetRefusal::MapInvalid, detail);
    if map.len() > MAX_ASSET_MAP_BYTES {
        return Err(invalid("the asset map is too large"));
    }
    let mut value: Value = serde_json::from_slice(map).map_err(|error| invalid(&error.to_string()))?;
    let version = value.get("version").and_then(Value::as_u64);
    if !version.is_some_and(|version| (ASSET_MAP_V1..=ASSET_MAP_VERSION).contains(&version)) {
        return Err(invalid("the asset map is not version 1 or 2"));
    }
    match value.get_mut("files").map(Value::take) {
        Some(Value::Array(files)) => Ok(files),
        _ => Err(invalid("the asset map has no files array")),
    }
}

/// For each texture with per-family files, the one family to plan: the first of `usable` the map
/// has, else `rgba8`, else the source.
fn picked_families(candidates: &[Candidate], usable: &[TextureFamily]) -> Vec<(String, String)> {
    let mut textures: Vec<&str> = candidates.iter().filter_map(|c| c.texture.as_ref().map(|(texture, _)| texture.as_str())).collect();
    textures.dedup();
    let preference: Vec<&str> = usable.iter().map(|family| family.wire()).chain([TextureFamily::Rgba8.wire(), SOURCE_FAMILY]).collect();
    let mut picks: Vec<(String, String)> = Vec::new();
    for texture in textures {
        if picks.iter().any(|(known, _)| known == texture) {
            continue;
        }
        let has = |family: &str| candidates.iter().any(|c| c.texture.as_ref().is_some_and(|(of, f)| of == texture && f == family));
        if let Some(family) = preference.iter().find(|family| has(family)) {
            picks.push((texture.to_owned(), (*family).to_owned()));
        }
    }
    picks
}

impl WebAssets {
    /// Plan the fetches from the asset map's bytes for an adapter that samples no compressed
    /// family ([`WebAssets::plan_for`] with none): every entry under the asset-path rule and the
    /// caps, in the map's order. A map that is not a version-1 or version-2 object with a `files`
    /// array is refused `asset-map-invalid`; a single bad entry is left out with its reason.
    pub fn plan(map: &[u8]) -> Result<WebAssets, AssetError> {
        WebAssets::plan_for(map, &[])
    }

    /// [`WebAssets::plan`] for an adapter that samples the compressed families `usable`, best
    /// first: of a texture's per-family files only the one it picks is planned.
    pub fn plan_for(map: &[u8], usable: &[TextureFamily]) -> Result<WebAssets, AssetError> {
        let mut assets = WebAssets::default();
        let mut candidates: Vec<Candidate> = Vec::new();
        for entry in map_files(map)? {
            let label = entry.get("path").and_then(Value::as_str).unwrap_or_default().to_owned();
            match WebAssets::read_entry(&entry, &candidates) {
                Ok(candidate) => candidates.push(candidate),
                Err(refusal) => assets.skipped.push((label, refusal)),
            }
        }
        let picks = picked_families(&candidates, usable);
        let mut total: u64 = 0;
        for candidate in candidates {
            let picked = candidate.texture.as_ref().is_none_or(|texture| picks.contains(texture));
            if !picked {
                continue;
            }
            let over_count = assets.planned.len() >= MAX_ASSET_FILES;
            if over_count || total.saturating_add(candidate.asset.bytes) > MAX_ASSETS_TOTAL_BYTES {
                assets.skipped.push((candidate.asset.path, AssetRefusal::OverBudget));
                continue;
            }
            total += candidate.asset.bytes;
            assets.planned.push(candidate.asset);
        }
        Ok(assets)
    }

    /// The entry as a candidate fetch, given the candidates read before it; or why it is left out.
    fn read_entry(entry: &Value, before: &[Candidate]) -> Result<Candidate, AssetRefusal> {
        let (path, bytes, digest) = entry_fields(entry).ok_or(AssetRefusal::MapInvalid)?;
        if !genex_core::paths::is_safe_asset_path(path) {
            return Err(AssetRefusal::UnsafePath);
        }
        if bytes > MAX_ASSET_BYTES {
            return Err(AssetRefusal::TooLarge);
        }
        if before.iter().any(|known| known.asset.path == path) {
            return Err(AssetRefusal::Duplicate);
        }
        let members = entry.as_object().ok_or(AssetRefusal::MapInvalid)?;
        let (group, name) = entry_group(members)?;
        let texture = entry_texture(members)?;
        let ranges = entry_ranges(members, bytes)?;
        if group.preloaded() && !ranges.is_empty() {
            return Err(AssetRefusal::GroupInvalid);
        }
        Ok(Candidate { asset: PlannedAsset { path: path.to_owned(), bytes, digest, group, name, ranges }, texture })
    }

    /// The files the map planned, in its order.
    pub fn planned(&self) -> &[PlannedAsset] {
        &self.planned
    }

    /// The files the shell fetches before the first reset: the boot and sim groups (every file of
    /// a v1 map), in the map's order.
    pub fn preload(&self) -> impl Iterator<Item = &PlannedAsset> {
        self.planned.iter().filter(|asset| asset.group.preloaded())
    }

    /// The entries left out, with why (by the path the map wrote, as written).
    pub fn skipped(&self) -> &[(String, AssetRefusal)] {
        &self.skipped
    }

    /// Each planned file's group, for the sim's reads (unlisted paths are `sim`).
    pub fn groups(&self) -> AssetGroups {
        self.planned.iter().filter(|asset| asset.group != AssetGroup::Sim).fold(AssetGroups::default(), |groups, asset| groups.with(&asset.path, asset.group))
    }

    fn find(&self, path: &str) -> Result<&PlannedAsset, AssetError> {
        self.planned.iter().find(|known| known.path == path).ok_or_else(|| AssetError::new(AssetRefusal::NotPlanned, format!("{path:?}")))
    }

    /// Admit a fetched file: only for a path the map planned whole and not yet admitted, with
    /// exactly the recorded length and FNV-1a 64. A refused file never reaches the table.
    pub fn admit(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), AssetError> {
        self.arrived(path, 0, bytes)
    }

    /// Admit bytes from `offset` of `path`: the whole file (offset 0) of an entry with no ranges,
    /// or exactly one planned range of a streamed entry, not yet admitted, with exactly its length
    /// and FNV-1a 64. A refusal changes nothing.
    pub fn arrived(&mut self, path: &str, offset: u64, bytes: Vec<u8>) -> Result<(), AssetError> {
        let refused = |code: AssetRefusal| Err(AssetError::new(code, format!("{path:?} at {offset}")));
        let planned = self.find(path)?;
        let (length, digest) = if planned.ranges.is_empty() {
            if offset != 0 || self.get(path).is_some() {
                return refused(AssetRefusal::NotPlanned);
            }
            (planned.bytes, planned.digest)
        } else {
            let Some(range) = planned.ranges.iter().find(|range| range.offset == offset) else { return refused(AssetRefusal::NotPlanned) };
            if self.range(path, offset).is_some() {
                return refused(AssetRefusal::NotPlanned);
            }
            (range.bytes, range.digest)
        };
        if bytes.len() as u64 != length {
            return refused(AssetRefusal::SizeMismatch);
        }
        if fnv1a64(&bytes) != digest {
            return refused(AssetRefusal::DigestMismatch);
        }
        let whole = planned.ranges.is_empty();
        self.wanted.retain(|fetch| !(fetch.path == path && fetch.offset == offset));
        if whole {
            self.loaded.push((path.to_owned(), bytes));
        } else {
            self.pieces.push((path.to_owned(), offset, bytes));
        }
        Ok(())
    }

    /// Queue the fetches a planned file still needs: its ranges not yet admitted, or the whole
    /// file. A file already loaded, or already queued, adds nothing.
    pub fn want(&mut self, path: &str) -> Result<(), AssetError> {
        let planned = self.find(path)?;
        let whole = planned.ranges.is_empty();
        let pieces: Vec<Fetch> = if whole {
            vec![Fetch { path: path.to_owned(), offset: 0, bytes: planned.bytes }]
        } else {
            planned.ranges.iter().map(|range| Fetch { path: path.to_owned(), offset: range.offset, bytes: range.bytes }).collect()
        };
        for fetch in pieces {
            let here = if whole { self.get(path).is_some() } else { self.range(path, fetch.offset).is_some() };
            if !here && !self.wanted.contains(&fetch) {
                self.wanted.push(fetch);
            }
        }
        Ok(())
    }

    /// The fetches wanted since the last take, in the order they were wanted.
    pub fn take_wanted(&mut self) -> Vec<Fetch> {
        std::mem::take(&mut self.wanted)
    }

    /// Drop a streamed or named file's admitted bytes (and its queued fetches), so it can be
    /// wanted again. Boot and sim files stay resident (`asset-group-invalid`).
    pub fn release(&mut self, path: &str) -> Result<(), AssetError> {
        if self.find(path)?.group.preloaded() {
            return Err(AssetError::new(AssetRefusal::GroupInvalid, format!("{path:?} is preloaded and stays resident")));
        }
        self.loaded.retain(|(known, _)| known != path);
        self.pieces.retain(|(known, _, _)| known != path);
        self.wanted.retain(|fetch| fetch.path != path);
        Ok(())
    }

    /// What stays with the shell once the preloaded files moved to the game at boot: the plan of
    /// the streamed and named files, with nothing admitted or queued.
    pub fn streaming_part(&self) -> WebAssets {
        let planned = self.planned.iter().filter(|asset| !asset.group.preloaded()).cloned().collect();
        WebAssets { planned, ..WebAssets::default() }
    }

    /// The admitted bytes of `path`.
    pub fn get(&self, path: &str) -> Option<&[u8]> {
        self.loaded.iter().find(|(known, _)| known == path).map(|(_, bytes)| bytes.as_slice())
    }

    /// The admitted bytes of the range of `path` from `offset`.
    pub fn range(&self, path: &str, offset: u64) -> Option<&[u8]> {
        self.pieces.iter().find(|(known, at, _)| known == path && *at == offset).map(|(_, _, bytes)| bytes.as_slice())
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
