//! The slot index: what a slot list shows, built from the sidecars (`<slot>.meta.json`, under
//! [`META_BYTES_MAX`]) so listing never reads a body. A sidecar records its body's stored length
//! and FNV-1a 64; a body that does not match (read when it is loaded) lists its slot
//! [`SlotState::Corrupt`], as does a sidecar that does not parse or a body without one.

use std::collections::BTreeMap;

use genex_core::digest::{fnv1a64, hex64};
use serde_json::{Map, Value};

use crate::envelope::Envelope;
use crate::error::SaveError;
use crate::slot::{AUTOSAVE_DIR, SLOTS_DIR, SlotName};

/// The most bytes a sidecar holds.
pub const META_BYTES_MAX: usize = 4 * 1024;
/// The `genex` member of a sidecar.
const META_MARK: &str = "save-meta";
/// The sidecar format this build writes and reads.
const META_FORMAT: u64 = 1;
/// A sidecar's members.
const META_MEMBERS: [&str; 11] =
    ["genex", "format", "slot", "label", "schema", "tick", "playMs", "savedAtMs", "bytes", "digest", "autosave"];

/// How a slot stands against the running game.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SlotState {
    /// Saved at the game's schema: loads as is.
    Ready,
    /// Saved at an older schema: loads through the game's migrations.
    NeedsMigration,
    /// Saved at a newer schema: refuses `save-newer`.
    Newer,
    /// Its sidecar or body is damaged: refuses `save-corrupt`.
    Corrupt,
}

impl SlotState {
    /// Every state, in declaration order.
    pub const ALL: [SlotState; 4] = [SlotState::Ready, SlotState::NeedsMigration, SlotState::Newer, SlotState::Corrupt];

    /// The state's wire spelling (`volatile.saves.slots[].state`).
    pub const fn wire(self) -> &'static str {
        match self {
            SlotState::Ready => "ready",
            SlotState::NeedsMigration => "needs-migration",
            SlotState::Newer => "newer",
            SlotState::Corrupt => "corrupt",
        }
    }
}

/// One slot as a list shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotInfo {
    /// The slot's name.
    pub name: SlotName,
    /// The label it was saved with.
    pub label: String,
    /// The schema it was saved at (0 when its sidecar is unreadable).
    pub schema: u32,
    /// The simulated tick it was saved at.
    pub tick: u64,
    /// Simulated play time in milliseconds.
    pub play_ms: u64,
    /// The body's stored bytes.
    pub bytes: u64,
    /// Whether the autosave ring wrote it.
    pub autosave: bool,
    /// How it stands against the running game.
    pub state: SlotState,
    /// Wall clock, display only; None in Genex runs so checks never read a date.
    pub saved_at_ms: Option<u64>,
}

/// A slot's sidecar: its list facts and its body's length and digest.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlotMeta {
    /// The slot it describes.
    pub slot: SlotName,
    /// The label it was saved with.
    pub label: String,
    /// The schema it was saved at.
    pub schema: u32,
    /// The simulated tick it was saved at.
    pub tick: u64,
    /// Simulated play time in milliseconds.
    pub play_ms: u64,
    /// Wall clock, display only.
    pub saved_at_ms: Option<u64>,
    /// The body's stored length.
    pub bytes: u64,
    /// FNV-1a 64 of the body's stored bytes.
    pub digest: u64,
}

impl SlotMeta {
    /// The sidecar of `slot` holding `envelope` stored as `body`.
    pub fn for_body(slot: &SlotName, envelope: &Envelope, body: &[u8]) -> SlotMeta {
        SlotMeta {
            slot: slot.clone(),
            label: envelope.meta.label.clone(),
            schema: envelope.schema,
            tick: envelope.tick,
            play_ms: envelope.meta.play_ms,
            saved_at_ms: envelope.meta.saved_at_ms,
            bytes: body.len() as u64,
            digest: fnv1a64(body),
        }
    }

    /// The sidecar's file bytes (JSON, members in a fixed order).
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut members = Map::new();
        members.insert("genex".to_owned(), Value::from(META_MARK));
        members.insert("format".to_owned(), Value::from(META_FORMAT));
        members.insert("slot".to_owned(), Value::from(self.slot.as_str()));
        members.insert("label".to_owned(), Value::from(self.label.as_str()));
        members.insert("schema".to_owned(), Value::from(self.schema));
        members.insert("tick".to_owned(), Value::from(self.tick));
        members.insert("playMs".to_owned(), Value::from(self.play_ms));
        members.insert("savedAtMs".to_owned(), self.saved_at_ms.map_or(Value::Null, Value::from));
        members.insert("bytes".to_owned(), Value::from(self.bytes));
        members.insert("digest".to_owned(), Value::from(hex64(self.digest)));
        members.insert("autosave".to_owned(), Value::from(self.slot.is_autosave()));
        serde_json::to_vec(&Value::Object(members)).unwrap_or_default()
    }

    /// The sidecar in `bytes`, or `save-corrupt` (past [`META_BYTES_MAX`], not JSON, a member
    /// missing, unknown or of the wrong kind).
    pub fn parse(bytes: &[u8]) -> Result<SlotMeta, SaveError> {
        if bytes.len() > META_BYTES_MAX {
            return Err(SaveError::corrupt(format!("a sidecar holds at most {META_BYTES_MAX} bytes")));
        }
        let Ok(Value::Object(members)) = serde_json::from_slice::<Value>(bytes) else {
            return Err(SaveError::corrupt("the sidecar is not a JSON object"));
        };
        read_meta(&members).map_err(SaveError::corrupt)
    }

    /// Whether `body` is the body this sidecar describes.
    pub fn matches(&self, body: &[u8]) -> bool {
        body.len() as u64 == self.bytes && fnv1a64(body) == self.digest
    }
}

fn read_meta(members: &Map<String, Value>) -> Result<SlotMeta, String> {
    if let Some(unknown) = members.keys().find(|key| !META_MEMBERS.contains(&key.as_str())) {
        return Err(format!("unknown sidecar member {unknown:?}"));
    }
    let marked = members.get("genex").and_then(Value::as_str) == Some(META_MARK);
    if !marked || members.get("format").and_then(Value::as_u64) != Some(META_FORMAT) {
        return Err("not a genex save sidecar".to_owned());
    }
    let text = |key: &str| members.get(key).and_then(Value::as_str).ok_or_else(|| format!("{key} is not a string"));
    let number = |key: &str| members.get(key).and_then(Value::as_u64).ok_or_else(|| format!("{key} is not a u64"));
    let slot = SlotName::lookup(text("slot")?).map_err(|e| e.detail)?;
    let digest = text("digest")?;
    let saved_at_ms = match members.get("savedAtMs") {
        Some(Value::Null) | None => None,
        Some(value) => Some(value.as_u64().ok_or("savedAtMs is not a u64")?),
    };
    Ok(SlotMeta {
        slot,
        label: text("label")?.to_owned(),
        schema: u32::try_from(number("schema")?).map_err(|e| e.to_string())?,
        tick: number("tick")?,
        play_ms: number("playMs")?,
        saved_at_ms,
        bytes: number("bytes")?,
        digest: u64::from_str_radix(digest, 16).map_err(|_| format!("digest {digest:?} is not hex"))?,
    })
}

/// One indexed slot: what the list shows, its sidecar when it parsed, and the sidecar's size.
#[derive(Clone, Debug)]
struct Entry {
    info: SlotInfo,
    meta: Option<SlotMeta>,
    meta_bytes: u64,
}

/// Every slot of a game, sorted by name.
#[derive(Clone, Debug, Default)]
pub struct SlotIndex {
    entries: BTreeMap<SlotName, Entry>,
    list: Vec<SlotInfo>,
}

impl SlotIndex {
    /// The index of the files listed in the slot folders (`files`, as genex-core `Saves::list`
    /// names them), reading only sidecars through `read_meta`; `schema` is the game's.
    pub fn build(files: &[String], mut read_meta: impl FnMut(&str) -> Option<Vec<u8>>, schema: u32) -> SlotIndex {
        let mut index = SlotIndex::default();
        let mut slots: BTreeMap<SlotName, (bool, bool)> = BTreeMap::new();
        for file in files {
            let Some(slot) = SlotName::from_file(file) else { continue };
            let seen = slots.entry(slot.clone()).or_default();
            if *file == slot.meta_file() {
                seen.1 = true;
            } else {
                seen.0 = true;
            }
        }
        for (slot, (has_body, has_meta)) in slots {
            let bytes = if has_meta { read_meta(&slot.meta_file()) } else { None };
            let meta = bytes.as_deref().and_then(|bytes| SlotMeta::parse(bytes).ok()).filter(|meta| meta.slot == slot);
            let meta_bytes = bytes.as_ref().map_or(0, |bytes| bytes.len() as u64);
            let entry = match meta {
                Some(meta) if has_body => entry_of(meta, meta_bytes, schema),
                meta => corrupt_entry(&slot, meta, meta_bytes),
            };
            index.entries.insert(slot, entry);
        }
        index.relist();
        index
    }

    /// The folders slots are kept in, to list for [`SlotIndex::build`].
    pub const FOLDERS: [&'static str; 2] = [SLOTS_DIR, AUTOSAVE_DIR];

    /// Every slot, sorted by name.
    pub fn list(&self) -> &[SlotInfo] {
        &self.list
    }

    /// The slot named `name`.
    pub fn get(&self, name: &str) -> Option<&SlotInfo> {
        self.list.iter().find(|info| info.name.as_str() == name)
    }

    /// The sidecar of `slot`, when it parsed.
    pub fn meta(&self, slot: &SlotName) -> Option<&SlotMeta> {
        self.entries.get(slot).and_then(|entry| entry.meta.as_ref())
    }

    /// How many named (not autosave) slots there are.
    pub fn named_count(&self) -> usize {
        self.entries.keys().filter(|slot| !slot.is_autosave()).count()
    }

    /// The bytes `slot` keeps now (body and sidecar), which a new save of it replaces.
    pub fn stored_bytes(&self, slot: &SlotName) -> u64 {
        self.entries.get(slot).map_or(0, |entry| entry.info.bytes + entry.meta_bytes)
    }

    /// Whether `body` is what `slot`'s sidecar describes; when it is not, the slot lists
    /// [`SlotState::Corrupt`] from now on.
    pub fn verify(&mut self, slot: &SlotName, body: &[u8]) -> bool {
        let Some(entry) = self.entries.get_mut(slot) else { return false };
        let matches = entry.meta.as_ref().is_some_and(|meta| meta.matches(body));
        if !matches {
            entry.info.state = SlotState::Corrupt;
            self.relist();
        }
        matches
    }

    /// List `slot` [`SlotState::Corrupt`] (its body did not decode).
    pub fn mark_corrupt(&mut self, slot: &SlotName) {
        if let Some(entry) = self.entries.get_mut(slot) {
            entry.info.state = SlotState::Corrupt;
            self.relist();
        }
    }

    /// Index the sidecar just written for a slot (`meta_bytes` its size); `schema` is the game's.
    pub fn put(&mut self, meta: SlotMeta, meta_bytes: u64, schema: u32) {
        let slot = meta.slot.clone();
        self.entries.insert(slot, entry_of(meta, meta_bytes, schema));
        self.relist();
    }

    /// Forget `slot` (its files were removed).
    pub fn remove(&mut self, slot: &SlotName) {
        self.entries.remove(slot);
        self.relist();
    }

    fn relist(&mut self) {
        self.list = self.entries.values().map(|entry| entry.info.clone()).collect();
    }
}

fn entry_of(meta: SlotMeta, meta_bytes: u64, schema: u32) -> Entry {
    let state = if meta.schema == 0 { SlotState::Corrupt } else { state_against(meta.schema, schema) };
    let info = SlotInfo {
        name: meta.slot.clone(),
        label: meta.label.clone(),
        schema: meta.schema,
        tick: meta.tick,
        play_ms: meta.play_ms,
        bytes: meta.bytes,
        autosave: meta.slot.is_autosave(),
        state,
        saved_at_ms: meta.saved_at_ms,
    };
    Entry { info, meta: Some(meta), meta_bytes }
}

/// How a slot saved at `slot_schema` stands against the game's `schema`.
pub fn state_against(slot_schema: u32, schema: u32) -> SlotState {
    match slot_schema.cmp(&schema) {
        std::cmp::Ordering::Equal => SlotState::Ready,
        std::cmp::Ordering::Less => SlotState::NeedsMigration,
        std::cmp::Ordering::Greater => SlotState::Newer,
    }
}

/// A slot whose sidecar is missing or unreadable, or whose body is missing.
fn corrupt_entry(slot: &SlotName, meta: Option<SlotMeta>, meta_bytes: u64) -> Entry {
    let mut entry = match meta {
        Some(meta) => entry_of(meta, meta_bytes, 0),
        None => Entry {
            info: SlotInfo {
                name: slot.clone(),
                label: String::new(),
                schema: 0,
                tick: 0,
                play_ms: 0,
                bytes: 0,
                autosave: slot.is_autosave(),
                state: SlotState::Corrupt,
                saved_at_ms: None,
            },
            meta: None,
            meta_bytes,
        },
    };
    entry.info.state = SlotState::Corrupt;
    entry
}
