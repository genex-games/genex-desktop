//! Named asset groups loaded during play (game systems STR-29, release R-9): `sim.stream.require`
//! asks for a group `genex.toml` declares (`[[asset_group]]`, C-30), and `sim.stream.ready` hands
//! out its handles on a tick the simulation decides.
//!
//! - The groups and their members come from the build's asset index (`genex-asset-index.json`,
//!   written by the package step), so every destination of one build knows the same groups.
//! - A group required while tick `t` runs is ready at the start of tick
//!   `t + `[`STREAM_GROUP_PREFETCH_TICKS`], before the update hooks: never sooner, whatever the
//!   loading did. A member that is not resident then holds the frame, as a late cell build does:
//!   the tick waits and runs once the member arrives, so the group is ready on the same tick on
//!   every native destination and at any thread count. The web runtime does not fetch a named
//!   group yet: nothing asks `WebAssets::want_group` for `required_groups()` and the sim's assets
//!   never see what the shell fetches while playing, so a web build loads what it needs up front.
//! - The handles ([`GroupHandles`]) carry each member's bytes and a model handle for each model
//!   member; they work in `on_update` with no reset. Releasing a group and requiring it again gives
//!   equal handles.
//! - It works without `game.streaming` (a level game loading interiors). Required groups are not
//!   part of a save: a loaded game requires its groups again.
//! - The index is read at the first commit after a group is required (a game that requires none
//!   reads nothing more). Until then `require` cannot tell an undeclared name: that ticket is
//!   refused at the commit (`group_refusal` is `stream-unknown-group`, `ready` stays None); once
//!   the groups are known, `require` refuses an undeclared name itself. Both are deterministic.

use std::collections::BTreeMap;
use std::sync::Arc;

use genex_stream::{StreamError, StreamErrorCode, StreamTicket};
use serde_json::Value;

use crate::gfx::{AssetBytes, Assets, Model};

/// Ticks between a group's `require` and the tick it is ready on.
pub const STREAM_GROUP_PREFETCH_TICKS: u64 = 2;
/// The most groups required at once (more refuse `stream-invalid`).
pub const STREAM_GROUPS_REQUIRED_MAX: usize = 64;
/// The asset index the package step writes (C-15), where the groups are listed.
const ASSET_INDEX_FILE: &str = "genex-asset-index.json";
/// The asset index version this build reads.
const ASSET_INDEX_VERSION: u64 = 1;
/// The most groups and members one index may list (past either, no group is known).
const INDEX_GROUPS_MAX: usize = 256;
const GROUP_MEMBERS_MAX: usize = 4096;
/// File endings of the members a group hands out as models.
const MODEL_ENDINGS: [&str; 2] = [".glb", ".gltf"];

/// The build's named groups: each name and its members (paths under `assets/`), as the index lists
/// them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct GroupCatalog {
    groups: BTreeMap<String, Vec<String>>,
}

impl GroupCatalog {
    /// The groups of the asset index `assets` holds; none when there is no index or it is not one
    /// this build reads. Read only once a game requires a group, so a game without named groups
    /// reads nothing it did not ask for.
    pub(crate) fn read(assets: &Assets) -> GroupCatalog {
        assets.read_cached(ASSET_INDEX_FILE).map(|bytes| GroupCatalog::parse(&bytes)).unwrap_or_default()
    }

    /// The groups of an asset index's bytes (module doc).
    pub(crate) fn parse(index: &[u8]) -> GroupCatalog {
        let Ok(index) = serde_json::from_slice::<Value>(index) else { return GroupCatalog::default() };
        if index.get("version").and_then(Value::as_u64) != Some(ASSET_INDEX_VERSION) {
            return GroupCatalog::default();
        }
        let Some(rows) = index.get("groups").and_then(Value::as_array) else { return GroupCatalog::default() };
        if rows.len() > INDEX_GROUPS_MAX {
            return GroupCatalog::default();
        }
        let groups = rows.iter().filter_map(group_row).collect();
        GroupCatalog { groups }
    }

    fn members(&self, name: &str) -> Option<&[String]> {
        self.groups.get(name).map(Vec::as_slice)
    }
}

/// One index group: its name and its members, each a plain path under `assets/`.
fn group_row(row: &Value) -> Option<(String, Vec<String>)> {
    let name = row.get("name")?.as_str().filter(|name| !name.is_empty())?;
    let assets = row.get("assets")?.as_array()?;
    if assets.len() > GROUP_MEMBERS_MAX {
        return None;
    }
    let members: Option<Vec<String>> = assets.iter().map(|path| path.as_str().filter(|path| genex_core::paths::is_safe_asset_path(path)).map(str::to_owned)).collect();
    Some((name.to_owned(), members?))
}

/// A ready group's handles: each member's bytes, and a model handle for each model member.
#[derive(Clone, Debug, PartialEq)]
pub struct GroupHandles {
    name: Arc<str>,
    bytes: Arc<BTreeMap<String, AssetBytes>>,
    models: Arc<BTreeMap<String, Model>>,
}

impl GroupHandles {
    /// The group's name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The bytes of member `path` (any member: a level file, a model, a sound).
    pub fn bytes(&self, path: &str) -> Option<&AssetBytes> {
        self.bytes.get(path)
    }

    /// The model handle of member `path` (a `.glb` or `.gltf` member), to draw with `frame.model`.
    pub fn model(&self, path: &str) -> Option<&Model> {
        self.models.get(path)
    }

    /// The members' paths, ascending.
    pub fn paths(&self) -> impl Iterator<Item = &str> + '_ {
        self.bytes.keys().map(String::as_str)
    }
}

/// One required group: its ticket, the tick it is due on and, once ready, its handles.
#[derive(Debug)]
struct Required {
    ticket: StreamTicket,
    due: u64,
    handles: Option<GroupHandles>,
}

/// The groups `sim.stream` has required (part of [`crate::StreamState`]).
#[derive(Debug, Default)]
pub(crate) struct GroupSet {
    catalog: Option<Arc<GroupCatalog>>,
    /// Ticks committed since the seed: the clock `require` and the commit agree on.
    ticks: u64,
    next_ticket: u32,
    required: BTreeMap<String, Required>,
    /// Tickets the commit refused (an undeclared group required before the groups were known).
    refused: BTreeMap<StreamTicket, StreamErrorCode>,
}

impl GroupSet {
    /// Know the build's groups from now on (the runtime attaches them before the reset hooks).
    pub(crate) fn attach(&mut self, catalog: Arc<GroupCatalog>) {
        self.catalog = Some(catalog);
    }

    /// Whether the build's groups are known.
    pub(crate) fn attached(&self) -> bool {
        self.catalog.is_some()
    }

    /// Whether a group is required while the build's groups are not known yet.
    pub(crate) fn wants_catalog(&self) -> bool {
        self.catalog.is_none() && !self.required.is_empty()
    }

    /// Why `ticket` was refused at a commit, if it was.
    pub(crate) fn refusal(&self, ticket: StreamTicket) -> Option<StreamErrorCode> {
        self.refused.get(&ticket).copied()
    }

    /// Require `group`: its ticket, the one it already has while it stays required.
    pub(crate) fn require(&mut self, group: &str) -> Result<StreamTicket, StreamError> {
        if let Some(required) = self.required.get(group) {
            return Ok(required.ticket);
        }
        let unknown = self.catalog.as_ref().is_some_and(|catalog| catalog.members(group).is_none());
        if unknown || group.is_empty() {
            return Err(StreamError::new(StreamErrorCode::UnknownGroup, format!("no asset group {group:?} in genex.toml")));
        }
        if self.required.len() >= STREAM_GROUPS_REQUIRED_MAX {
            return Err(StreamError::new(StreamErrorCode::Invalid, format!("{STREAM_GROUPS_REQUIRED_MAX} groups are required already")));
        }
        let ticket = StreamTicket::from_raw(self.next_ticket);
        self.next_ticket += 1;
        self.required.insert(group.to_owned(), Required { ticket, due: self.ticks + STREAM_GROUP_PREFETCH_TICKS, handles: None });
        Ok(ticket)
    }

    /// The handles of `ticket`'s group, from the tick it is ready on until it is released.
    pub(crate) fn ready(&self, ticket: StreamTicket) -> Option<GroupHandles> {
        self.required.values().find(|required| required.ticket == ticket).and_then(|required| required.handles.clone())
    }

    /// Let `group` go: its ticket answers nothing from now on.
    pub(crate) fn release(&mut self, group: &str) {
        self.required.remove(group);
    }

    /// The groups required and not released, ready or not, ascending: what a shell fetches.
    pub(crate) fn required(&self) -> impl Iterator<Item = &str> + '_ {
        self.required.keys().map(String::as_str)
    }

    /// The members of the groups due at the next tick that are not ready yet.
    fn due_members(&self) -> Vec<&str> {
        let tick = self.ticks + 1;
        let due = self.required.iter().filter(|(_, required)| required.handles.is_none() && required.due <= tick);
        let Some(catalog) = self.catalog.as_ref() else { return Vec::new() };
        due.filter_map(|(name, _)| catalog.members(name)).flatten().map(String::as_str).collect()
    }

    /// Whether every member of the groups due at the next tick is resident in `assets`.
    pub(crate) fn due_resident(&self, assets: &Assets) -> bool {
        self.due_members().into_iter().all(|path| assets.info(path).is_some())
    }

    /// The start of a tick that runs: the groups due now become ready (their members were checked
    /// resident), in name order.
    pub(crate) fn commit(&mut self, assets: &Assets) {
        self.ticks += 1;
        let Some(catalog) = self.catalog.clone() else { return };
        let undeclared: Vec<String> = self.required.keys().filter(|name| catalog.members(name).is_none()).cloned().collect();
        for name in undeclared {
            if let Some(required) = self.required.remove(&name) {
                self.refused.insert(required.ticket, StreamErrorCode::UnknownGroup);
            }
        }
        for (name, required) in &mut self.required {
            if required.handles.is_some() || required.due > self.ticks {
                continue;
            }
            let members = catalog.members(name).unwrap_or_default();
            required.handles = Some(handles(name, members, assets));
        }
    }
}

/// The handles of group `name` over `members`: every member's bytes (a member that cannot be read
/// has none) and a model handle per model member.
fn handles(name: &str, members: &[String], assets: &Assets) -> GroupHandles {
    let mut bytes = BTreeMap::new();
    let mut models = BTreeMap::new();
    for path in members {
        if let Ok(read) = assets.read_cached(path) {
            bytes.insert(path.clone(), read);
        }
        if MODEL_ENDINGS.iter().any(|ending| path.ends_with(ending)) {
            models.insert(path.clone(), assets.model(path));
        }
    }
    GroupHandles { name: Arc::from(name), bytes: Arc::new(bytes), models: Arc::new(models) }
}
