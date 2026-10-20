//! The settings store (G6 gameplay UI, UIS-7): the person's settings over a schema, read from and
//! written to `genex-settings.json` through the game's saves (this crate does no file I/O).
//!
//! ```json
//! {"format":1,"presets":{"audio":"quiet"},"values":{"audio.music":0.6,"difficulty_hint":"all"}}
//! ```
//!
//! The file holds each tab's chosen preset and only the values that differ from it (or from the
//! default), in schema order; a choice is saved by its option key, so reordering options never
//! changes a person's pick. Loading is all or nothing: a hostile file (too large, too deep, a
//! repeated key, not format 1, an unknown member, a value of the wrong type or out of range)
//! refuses `settings-invalid`, keeps what the store held and writes nothing until the person
//! changes something. Rows for options or presets the schema no longer has are skipped with
//! `settings-key-unknown` and the rest applies.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

use crate::settings::schema::{SettingDef, SettingKind, SettingValue, SettingsErrorCode, SettingsIssue, SettingsSchema, SettingsTab};

/// The settings file's name in the game's saves.
pub const SETTINGS_FILE: &str = "genex-settings.json";
/// The settings file's format number.
pub const SETTINGS_FORMAT: u64 = 1;
/// The largest settings file read, in bytes.
pub const SETTINGS_BYTES_MAX: usize = 64 * 1024;
/// The most members one object of the file holds.
pub const SETTINGS_KEYS_MAX: usize = 256;
/// The deepest nesting read (the file itself needs two).
pub const SETTINGS_DEPTH_MAX: usize = 4;
/// The file's subject in an issue.
const FILE_SUBJECT: &str = "genex-settings.json";

/// The person's settings: a preset per tab and per-option deltas over the schema's defaults.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingsStore {
    schema: SettingsSchema,
    presets: BTreeMap<SettingsTab, String>,
    /// Option index in the schema → value, only where it differs from the preset or default.
    overrides: BTreeMap<usize, SettingValue>,
    dirty: bool,
    changed: BTreeSet<usize>,
}

impl SettingsStore {
    /// Every option at its default, over a schema that validates.
    pub fn new(schema: SettingsSchema) -> Result<SettingsStore, SettingsIssue> {
        schema.validate()?;
        Ok(SettingsStore { schema, presets: BTreeMap::new(), overrides: BTreeMap::new(), dirty: false, changed: BTreeSet::new() })
    }

    /// The schema.
    pub fn schema(&self) -> &SettingsSchema {
        &self.schema
    }

    /// The option `key`'s value: the person's change, else the tab's preset, else the default.
    pub fn value(&self, key: &str) -> Option<SettingValue> {
        let at = self.index(key)?;
        Some(self.value_at(at))
    }

    /// A slider's value (0 for anything else).
    pub fn number(&self, key: &str) -> f32 {
        match self.value(key) {
            Some(SettingValue::Number(number)) => number,
            _ => 0.0,
        }
    }

    /// A toggle's value (false for anything else).
    pub fn flag(&self, key: &str) -> bool {
        matches!(self.value(key), Some(SettingValue::Bool(true)))
    }

    /// The preset chosen on `tab`.
    pub fn preset(&self, tab: SettingsTab) -> Option<&str> {
        self.presets.get(&tab).map(String::as_str)
    }

    /// Set the option `key`; answers whether its value changed. Refuses `settings-key-unknown` or
    /// `settings-value-invalid` and changes nothing.
    pub fn set(&mut self, key: &str, value: SettingValue) -> Result<bool, SettingsIssue> {
        let at = self.index(key).ok_or_else(|| unknown(key))?;
        let checked = self.def_at(at).check(value)?;
        let before = self.value_at(at);
        if checked == self.base_at(at) {
            self.overrides.remove(&at);
        } else {
            self.overrides.insert(at, checked);
        }
        Ok(self.note(at, before))
    }

    /// Choose the preset `name` on `tab`: its values apply and the tab's own changes are dropped.
    /// Refuses `settings-key-unknown` for a preset the tab does not offer.
    pub fn choose_preset(&mut self, tab: SettingsTab, name: &str) -> Result<(), SettingsIssue> {
        if self.schema.find_preset(tab, name).is_none() {
            return Err(unknown(&format!("{}:{name}", tab.wire())));
        }
        let before = self.values();
        self.presets.insert(tab, name.to_owned());
        self.clear_tab_overrides(tab);
        self.note_all(&before);
        self.dirty = true;
        Ok(())
    }

    /// Every option back to its default and no preset chosen.
    pub fn reset(&mut self) {
        let before = self.values();
        self.presets.clear();
        self.overrides.clear();
        self.note_all(&before);
        self.dirty = true;
    }

    /// One tab's options back to their defaults and its preset cleared.
    pub fn reset_tab(&mut self, tab: SettingsTab) {
        let before = self.values();
        self.presets.remove(&tab);
        self.clear_tab_overrides(tab);
        self.note_all(&before);
        self.dirty = true;
    }

    /// Read a `genex-settings.json`. On success the store holds the file's settings (nothing to
    /// write) and answers the skipped stale rows; on `settings-invalid` it is unchanged.
    pub fn load(&mut self, bytes: &[u8]) -> Result<Vec<SettingsIssue>, SettingsIssue> {
        let node = parse(bytes)?;
        let FileRows { presets, values, stale } = self.read_file(&node)?;
        let before = self.values();
        self.presets = presets;
        self.overrides.clear();
        for (at, value) in values {
            if value != self.base_at(at) {
                self.overrides.insert(at, value);
            }
        }
        self.note_all(&before);
        Ok(stale)
    }

    /// The canonical `genex-settings.json` bytes.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut presets = Map::new();
        for (tab, name) in &self.presets {
            presets.insert(tab.wire().to_owned(), Value::String(name.clone()));
        }
        let mut values = Map::new();
        for (at, value) in &self.overrides {
            let def = self.def_at(*at);
            values.insert(def.key().to_owned(), value_json(def, *value));
        }
        let mut file = Map::new();
        file.insert("format".to_owned(), Value::from(SETTINGS_FORMAT));
        file.insert("presets".to_owned(), Value::Object(presets));
        file.insert("values".to_owned(), Value::Object(values));
        // Serializing a Value with string keys cannot fail.
        serde_json::to_vec(&Value::Object(file)).unwrap_or_default()
    }

    /// The bytes to save when the person changed something since the last call; `None` otherwise
    /// (after a load, and after a refused file).
    pub fn take_write(&mut self) -> Option<Vec<u8>> {
        if !self.dirty {
            return None;
        }
        self.dirty = false;
        Some(self.to_bytes())
    }

    /// The keys whose value changed since the last call, in schema order (for routing `audio.*`,
    /// `ui.*` and `input.*` outside the simulation).
    pub fn take_changed(&mut self) -> Vec<String> {
        let changed = std::mem::take(&mut self.changed);
        changed.into_iter().map(|at| self.def_at(at).key().to_owned()).collect()
    }

    fn index(&self, key: &str) -> Option<usize> {
        self.schema.options().position(|(_, def)| def.key() == key)
    }

    fn def_at(&self, at: usize) -> &SettingDef {
        // Indices come from positions in the schema the store owns.
        &self.schema.option_list()[at].1
    }

    fn tab_at(&self, at: usize) -> SettingsTab {
        self.schema.option_list()[at].0
    }

    /// The value without the person's change: the tab's preset, else the default.
    fn base_at(&self, at: usize) -> SettingValue {
        let def = self.def_at(at);
        let tab = self.tab_at(at);
        let preset = self.presets.get(&tab).and_then(|name| self.schema.find_preset(tab, name)?.value(def.key()));
        preset.unwrap_or_else(|| def.default_value())
    }

    fn value_at(&self, at: usize) -> SettingValue {
        self.overrides.get(&at).copied().unwrap_or_else(|| self.base_at(at))
    }

    fn values(&self) -> Vec<SettingValue> {
        (0..self.schema.option_list().len()).map(|at| self.value_at(at)).collect()
    }

    fn clear_tab_overrides(&mut self, tab: SettingsTab) {
        let list = self.schema.option_list();
        self.overrides.retain(|at, _| list[*at].0 != tab);
    }

    /// Record a change of one option; answers whether it changed.
    fn note(&mut self, at: usize, before: SettingValue) -> bool {
        let changed = self.value_at(at) != before;
        if changed {
            self.changed.insert(at);
            self.dirty = true;
        }
        changed
    }

    fn note_all(&mut self, before: &[SettingValue]) {
        for (at, value) in before.iter().enumerate() {
            if self.value_at(at) != *value {
                self.changed.insert(at);
            }
        }
    }

    /// The file's presets, values and stale rows, checked against the schema.
    fn read_file(&self, node: &Node) -> Result<FileRows, SettingsIssue> {
        let Node::Object(members) = node else { return Err(invalid("the file is not a JSON object")) };
        let member = |name: &str| members.iter().find(|(key, _)| key == name).map(|(_, value)| value);
        if let Some((name, _)) = members.iter().find(|(key, _)| !matches!(key.as_str(), "format" | "presets" | "values")) {
            return Err(invalid(format!("unknown member {}", clip(name))));
        }
        let format_ok = matches!(member("format"), Some(Node::Number(number)) if *number == SETTINGS_FORMAT as f64);
        if !format_ok {
            return Err(invalid("not a format 1 settings file"));
        }
        let mut stale = Vec::new();
        let presets = self.read_presets(member("presets"), &mut stale)?;
        let values = self.read_values(member("values"), &mut stale)?;
        Ok(FileRows { presets, values, stale })
    }

    fn read_presets(&self, node: Option<&Node>, stale: &mut Vec<SettingsIssue>) -> Result<BTreeMap<SettingsTab, String>, SettingsIssue> {
        let Some(Node::Object(rows)) = node else { return Err(invalid("presets is not an object")) };
        check_count(rows.len(), "presets")?;
        let mut presets = BTreeMap::new();
        for (tab_name, name) in rows {
            let tab = SettingsTab::from_wire(tab_name).ok_or_else(|| invalid(format!("a preset for an unknown tab {}", clip(tab_name))))?;
            let Node::String(name) = name else { return Err(invalid(format!("the {tab_name} preset is not a string"))) };
            if self.schema.find_preset(tab, name).is_some() {
                presets.insert(tab, name.clone());
            } else {
                let subject = format!("{}:{}", tab.wire(), clip(name));
                stale.push(SettingsIssue::new(SettingsErrorCode::KeyUnknown, &subject, format!("the {} tab has no preset {subject}", tab.wire())));
            }
        }
        Ok(presets)
    }

    fn read_values(&self, node: Option<&Node>, stale: &mut Vec<SettingsIssue>) -> Result<Vec<(usize, SettingValue)>, SettingsIssue> {
        let Some(Node::Object(rows)) = node else { return Err(invalid("values is not an object")) };
        check_count(rows.len(), "values")?;
        let mut values = Vec::new();
        for (key, node) in rows {
            let Some(at) = self.index(key) else {
                stale.push(SettingsIssue::new(SettingsErrorCode::KeyUnknown, key, format!("no option {}", clip(key))));
                continue;
            };
            let def = self.def_at(at);
            let value = value_from(def, node).ok_or_else(|| invalid(format!("{key} holds a value that does not fit it")))?;
            values.push((at, value));
        }
        Ok(values)
    }
}

/// What a settings file holds once checked.
struct FileRows {
    presets: BTreeMap<SettingsTab, String>,
    values: Vec<(usize, SettingValue)>,
    stale: Vec<SettingsIssue>,
}

fn unknown(subject: &str) -> SettingsIssue {
    SettingsIssue::new(SettingsErrorCode::KeyUnknown, subject, format!("no option or preset {subject}"))
}

fn invalid(detail: impl Into<String>) -> SettingsIssue {
    SettingsIssue::new(SettingsErrorCode::Invalid, FILE_SUBJECT, detail)
}

fn check_count(count: usize, what: &str) -> Result<(), SettingsIssue> {
    if count > SETTINGS_KEYS_MAX {
        return Err(invalid(format!("{what} holds {count} members, at most {SETTINGS_KEYS_MAX}")));
    }
    Ok(())
}

/// A name cut short and made printable for a detail line.
fn clip(text: &str) -> String {
    text.chars().take(40).flat_map(char::escape_default).collect()
}

/// An option's value as the file writes it: a choice by its option key, a slider as the decimal a
/// person would write (the f32's shortest spelling).
fn value_json(def: &SettingDef, value: SettingValue) -> Value {
    match (def.kind(), value) {
        (SettingKind::Choice { options }, SettingValue::Choice(index)) => {
            options.get(usize::from(index)).map_or(Value::Null, |option| Value::String(option.clone()))
        }
        (_, SettingValue::Number(number)) => {
            let decimal = number.to_string().parse::<f64>().unwrap_or(f64::from(number));
            serde_json::Number::from_f64(decimal).map_or(Value::Null, Value::Number)
        }
        (_, SettingValue::Bool(on)) => Value::Bool(on),
        (_, SettingValue::Choice(index)) => Value::from(index),
    }
}

/// The value a file node holds for an option, checked; `None` when it does not fit.
fn value_from(def: &SettingDef, node: &Node) -> Option<SettingValue> {
    let raw = match (def.kind(), node) {
        (SettingKind::Toggle, Node::Bool(on)) => SettingValue::Bool(*on),
        (SettingKind::Slider { .. }, Node::Number(number)) => SettingValue::Number(*number as f32),
        (SettingKind::Choice { options }, Node::String(name)) => {
            let index = options.iter().position(|option| option == name)?;
            SettingValue::Choice(u16::try_from(index).ok()?)
        }
        _ => return None,
    };
    def.check(raw).ok()
}

/// A parsed JSON value whose objects kept every member in order (no duplicates passed).
#[derive(Clone, Debug, PartialEq)]
enum Node {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

/// The whole file as nodes: at most 64 KiB, at most four levels deep, no repeated key, valid UTF-8
/// without lone surrogates, nothing after the value. The visitor follows genex-input's bindings
/// file reader.
fn parse(bytes: &[u8]) -> Result<Node, SettingsIssue> {
    if bytes.len() > SETTINGS_BYTES_MAX {
        return Err(invalid(format!("{} bytes (at most {SETTINGS_BYTES_MAX})", bytes.len())));
    }
    let mut reader = serde_json::Deserializer::from_slice(bytes);
    let node = NodeSeed { depth: 0 }.deserialize(&mut reader).map_err(|error| invalid(error.to_string()))?;
    reader.end().map_err(|error| invalid(error.to_string()))?;
    Ok(node)
}

/// Reads one value at a nesting depth.
#[derive(Clone, Copy)]
struct NodeSeed {
    depth: usize,
}

impl NodeSeed {
    fn deeper<E: de::Error>(self) -> Result<NodeSeed, E> {
        let depth = self.depth + 1;
        if depth > SETTINGS_DEPTH_MAX {
            return Err(E::custom(format!("nested deeper than {SETTINGS_DEPTH_MAX}")));
        }
        Ok(NodeSeed { depth })
    }
}

impl<'de> DeserializeSeed<'de> for NodeSeed {
    type Value = Node;

    fn deserialize<D: de::Deserializer<'de>>(self, deserializer: D) -> Result<Node, D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for NodeSeed {
    type Value = Node;

    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a JSON value")
    }

    fn visit_unit<E: de::Error>(self) -> Result<Node, E> {
        Ok(Node::Null)
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Node, E> {
        Ok(Node::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Node, E> {
        Ok(Node::Number(value as f64))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Node, E> {
        Ok(Node::Number(value as f64))
    }

    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Node, E> {
        Ok(Node::Number(value))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Node, E> {
        Ok(Node::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Node, E> {
        Ok(Node::String(value))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Node, A::Error> {
        let inner = self.deeper()?;
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(inner)? {
            items.push(item);
        }
        Ok(Node::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Node, A::Error> {
        let inner = self.deeper()?;
        let mut members: Vec<(String, Node)> = Vec::new();
        let mut seen = BTreeSet::new();
        while let Some(key) = map.next_key::<String>()? {
            if !seen.insert(key.clone()) {
                return Err(de::Error::custom("a key is repeated"));
            }
            let value = map.next_value_seed(inner)?;
            members.push((key, value));
        }
        Ok(Node::Object(members))
    }
}
