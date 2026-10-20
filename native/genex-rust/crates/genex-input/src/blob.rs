//! The bindings file, `genex-input.json` (format `genex-input/1`): the player's rebinds and
//! accessibility settings, saved through the game's saves (this crate does no file I/O).
//!
//! ```json
//! {"format":"genex-input/1","bindings":{"jump":["key:KeyJ","pad:south"]},
//!  "access":{"holdMode":{"sprint":"toggle"},"stickDeadZone":[0.15,0.15],"triggerPress":0.75,
//!   "triggerRelease":0.65,"invertY":[false,false],"swapSticks":false,"slowPressPercent":100}}
//! ```
//!
//! `to_blob` is canonical (only actions whose bindings differ from the game's, in declaration
//! order; every setting), so the map's digest is the FNV-1a 64 of these bytes. `apply_blob` reads
//! the whole file against the map and replaces the player's state all or nothing: a hostile file
//! (too large, too deep, a repeated key, a lone surrogate, an unknown binding, a setting out of
//! range) leaves the map exactly as it was. Rows for actions the map no longer declares are
//! skipped and reported as `input-bindings-stale`.

use std::collections::BTreeSet;
use std::fmt;

use genex_core::digest::fnv1a64;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Value};

use crate::access::{access_from, access_json};
use crate::binding::Binding;
use crate::error::{InputError, InputErrorCode};
use crate::id::{ActionId, ControlId, name_ok};
use crate::map::{ACTIONS_MAX, ActionMap, BINDINGS_PER_ACTION_MAX};

/// The bindings file's format tag.
pub const BLOB_FORMAT: &str = "genex-input/1";
/// The largest bindings file read, in bytes.
pub const BINDINGS_BLOB_BYTES_MAX: usize = 64 * 1024;
/// The deepest nesting of objects and arrays read (the file itself needs three).
pub const BLOB_DEPTH_MAX: usize = 8;

/// What applying a bindings file skipped.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct BlobReport {
    /// Names of actions the file has rows for that the map does not declare, in file order.
    pub stale: Vec<String>,
}

impl BlobReport {
    /// `input-bindings-stale` when rows were skipped.
    pub fn problem(&self) -> Option<InputError> {
        if self.stale.is_empty() {
            return None;
        }
        let detail = format!("rows for actions this game no longer has: {}", self.stale.join(", "));
        Some(InputError::new(InputErrorCode::BindingsStale, detail))
    }
}

/// A parsed JSON value whose objects kept every member in order (no duplicates passed).
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Node {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Node>),
    Object(Vec<(String, Node)>),
}

impl ActionMap {
    /// The canonical `genex-input.json` bytes of the player's bindings and settings.
    pub fn to_blob(&self) -> Vec<u8> {
        let mut bindings = Map::new();
        for def in self.slots().filter(|def| def.bindings != def.defaults) {
            let wires = def.bindings.iter().map(|binding| Value::String(binding.wire())).collect();
            bindings.insert(def.id.name().to_owned(), Value::Array(wires));
        }
        let mut file = Map::new();
        file.insert("format".to_owned(), Value::String(BLOB_FORMAT.to_owned()));
        file.insert("bindings".to_owned(), Value::Object(bindings));
        file.insert("access".to_owned(), access_json(&self.access));
        // Serializing a Value with string keys cannot fail.
        serde_json::to_vec(&Value::Object(file)).unwrap_or_default()
    }

    /// The FNV-1a 64 of [`ActionMap::to_blob`]: equal digests, equal player state.
    pub fn digest(&self) -> u64 {
        fnv1a64(&self.to_blob())
    }

    /// Replace the player's bindings and settings with a bindings file's, all or nothing. Actions
    /// the file has no row for go back to the game's bindings.
    pub fn apply_blob(&mut self, bytes: &[u8]) -> Result<BlobReport, InputError> {
        let root = parse(bytes)?;
        let members = object(&root, "the file")?;
        let mut format = None;
        let mut bindings = None;
        let mut access = None;
        for (name, value) in members {
            match name.as_str() {
                "format" => format = Some(value),
                "bindings" => bindings = Some(value),
                "access" => access = Some(value),
                other => return Err(invalid(format!("unknown member {:?}", clip(other)))),
            }
        }
        if format != Some(&Node::String(BLOB_FORMAT.to_owned())) {
            return Err(invalid(format!("not a {BLOB_FORMAT} file")));
        }
        let mut candidate = self.clone();
        candidate.reset();
        let mut report = BlobReport::default();
        if let Some(rows) = bindings {
            candidate.apply_rows(rows, &mut report)?;
        }
        if let Some(settings) = access {
            candidate.access = access_from(settings, &candidate, &mut report.stale)?;
        }
        candidate.validate()?;
        *self = candidate;
        Ok(report)
    }

    fn apply_rows(&mut self, rows: &Node, report: &mut BlobReport) -> Result<(), InputError> {
        let rows = object(rows, "bindings")?;
        if rows.len() > ACTIONS_MAX {
            return Err(invalid(format!("{} binding rows (at most {ACTIONS_MAX})", rows.len())));
        }
        for (name, wires) in rows {
            let Some(action) = self.action_named(checked_name(name)?) else {
                report.stale.push(name.clone());
                continue;
            };
            let parsed = self.parse_row(wires)?;
            if let Some(def) = self.action_mut(action) {
                def.bindings = parsed;
            }
        }
        Ok(())
    }

    fn parse_row(&self, wires: &Node) -> Result<Vec<Binding>, InputError> {
        let Node::Array(items) = wires else { return Err(invalid("a binding row is not an array")) };
        if items.len() > BINDINGS_PER_ACTION_MAX {
            return Err(invalid(format!("a row of {} bindings (at most {BINDINGS_PER_ACTION_MAX})", items.len())));
        }
        let control = |name: &str| self.control_named(name);
        items
            .iter()
            .map(|item| match item {
                Node::String(text) => Binding::from_wire_with(text, control),
                _ => Err(invalid("a binding is not a string")),
            })
            .collect()
    }

    /// The declared action with this name.
    pub(crate) fn action_named(&self, name: &str) -> Option<ActionId> {
        self.slots().map(|def| def.id).find(|id| id.name() == name)
    }

    /// A touch control the game's bindings name.
    fn control_named(&self, name: &str) -> Option<ControlId> {
        let mut bindings = self.slots().flat_map(|def| def.defaults.iter().chain(&def.bindings));
        bindings.find_map(|binding| match binding {
            Binding::Touch(control) if control.name() == name => Some(*control),
            _ => None,
        })
    }
}

/// `input-bindings-invalid` with a detail.
pub(crate) fn invalid(detail: impl Into<String>) -> InputError {
    InputError::new(InputErrorCode::BindingsInvalid, detail)
}

/// The members of an object node.
pub(crate) fn object<'a>(node: &'a Node, what: &str) -> Result<&'a [(String, Node)], InputError> {
    match node {
        Node::Object(members) => Ok(members),
        _ => Err(invalid(format!("{what} is not an object"))),
    }
}

/// An id-shaped name from the file, or a refusal.
pub(crate) fn checked_name(name: &str) -> Result<&str, InputError> {
    if name_ok(name) { Ok(name) } else { Err(invalid(format!("{:?} is not an action name", clip(name)))) }
}

/// A name cut short and made printable for a detail line.
fn clip(text: &str) -> String {
    text.chars().take(40).flat_map(char::escape_default).collect()
}

/// The whole file as nodes: at most 64 KiB, at most eight levels deep, no repeated key, valid
/// UTF-8 without lone surrogates, nothing after the value.
fn parse(bytes: &[u8]) -> Result<Node, InputError> {
    if bytes.len() > BINDINGS_BLOB_BYTES_MAX {
        return Err(invalid(format!("{} bytes (at most {BINDINGS_BLOB_BYTES_MAX})", bytes.len())));
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
        if depth > BLOB_DEPTH_MAX {
            return Err(E::custom(format!("nested deeper than {BLOB_DEPTH_MAX}")));
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
