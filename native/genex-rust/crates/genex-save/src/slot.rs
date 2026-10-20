//! `SlotName`: a checked slot name and the two files it keeps under the save root, the body
//! (`slots/<name>.sav`, the envelope) and its sidecar (`slots/<name>.meta.json`, read for listing
//! so a list never reads a body). Autosave slots are `autosave-<n>`, kept as `autosave/<n>.sav`;
//! only the runtime's ring writes them, a game may load them.

use crate::error::SaveError;

/// The most bytes a slot name holds.
pub const SLOT_NAME_MAX: usize = 32;
/// The most slots an autosave ring holds.
pub const AUTOSAVE_RING_MAX: u8 = 8;
/// The prefix of the ring's slot names, reserved: a game never saves under it.
pub const AUTOSAVE_PREFIX: &str = "autosave-";
/// The folder named slots are kept in.
pub const SLOTS_DIR: &str = "slots";
/// The folder the autosave ring is kept in.
pub const AUTOSAVE_DIR: &str = "autosave";
/// The suffix of a slot's body (genex-core's mirror keeps these lazily on the web).
pub const BODY_SUFFIX: &str = ".sav";
/// The suffix of a slot's sidecar.
pub const META_SUFFIX: &str = ".meta.json";
/// Names a game never takes: the crash records folder kept in the save root (M8), and the device
/// names Windows refuses as a file stem whatever the extension.
const RESERVED_NAMES: [&str; 23] = [
    "genex-crash",
    "con",
    "prn",
    "aux",
    "nul",
    "com1",
    "com2",
    "com3",
    "com4",
    "com5",
    "com6",
    "com7",
    "com8",
    "com9",
    "lpt1",
    "lpt2",
    "lpt3",
    "lpt4",
    "lpt5",
    "lpt6",
    "lpt7",
    "lpt8",
    "lpt9",
];

/// A slot's checked name.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SlotName(String);

impl SlotName {
    /// A name a game saves under: 1 to [`SLOT_NAME_MAX`] of `[a-z0-9-]`, not starting with a dash,
    /// not reserved and not an autosave slot. Refuses `save-slot-invalid`.
    pub fn new(name: &str) -> Result<SlotName, SaveError> {
        check_plain(name)?;
        if name.starts_with(AUTOSAVE_PREFIX) {
            return Err(SaveError::slot_invalid(format!(
                "{AUTOSAVE_PREFIX}* names belong to the autosave ring: {name:?}"
            )));
        }
        Ok(SlotName(name.to_owned()))
    }

    /// The ring's slot `index` (below [`AUTOSAVE_RING_MAX`]).
    pub fn autosave(index: u8) -> Result<SlotName, SaveError> {
        if index >= AUTOSAVE_RING_MAX {
            return Err(SaveError::slot_invalid(format!("an autosave ring holds at most {AUTOSAVE_RING_MAX} slots")));
        }
        Ok(SlotName(format!("{AUTOSAVE_PREFIX}{index}")))
    }

    /// A name a game loads or deletes: a plain slot, or an autosave slot `autosave-<n>` spelled as
    /// [`SlotName::autosave`] spells it.
    pub fn lookup(name: &str) -> Result<SlotName, SaveError> {
        let Some(index) = name.strip_prefix(AUTOSAVE_PREFIX) else {
            return SlotName::new(name);
        };
        let parsed = index.parse::<u8>().ok().filter(|n| n.to_string() == index);
        match parsed {
            Some(n) => SlotName::autosave(n),
            None => Err(SaveError::slot_invalid(format!("not an autosave slot: {name:?}"))),
        }
    }

    /// The slot a stored file belongs to (`slots/<name>.sav`, `autosave/<n>.meta.json`), or None
    /// for any other file.
    pub fn from_file(file: &str) -> Option<SlotName> {
        let (folder, leaf) = file.split_once('/')?;
        let stem = leaf.strip_suffix(META_SUFFIX).or_else(|| leaf.strip_suffix(BODY_SUFFIX))?;
        match folder {
            SLOTS_DIR => SlotName::new(stem).ok(),
            AUTOSAVE_DIR => SlotName::lookup(&format!("{AUTOSAVE_PREFIX}{stem}")).ok(),
            _ => None,
        }
    }

    /// The name as written.
    pub fn as_str(&self) -> &str {
        &self.0
    }

    /// Whether this is one of the autosave ring's slots.
    pub fn is_autosave(&self) -> bool {
        self.autosave_index().is_some()
    }

    /// The ring index of an autosave slot.
    pub fn autosave_index(&self) -> Option<u8> {
        self.0.strip_prefix(AUTOSAVE_PREFIX).and_then(|index| index.parse().ok())
    }

    /// The body's file under the save root.
    pub fn body_file(&self) -> String {
        self.file(BODY_SUFFIX)
    }

    /// The sidecar's file under the save root.
    pub fn meta_file(&self) -> String {
        self.file(META_SUFFIX)
    }

    fn file(&self, suffix: &str) -> String {
        match self.autosave_index() {
            Some(index) => format!("{AUTOSAVE_DIR}/{index}{suffix}"),
            None => format!("{SLOTS_DIR}/{}{suffix}", self.0),
        }
    }
}

impl std::fmt::Display for SlotName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// The shape every slot name keeps: length, alphabet, no leading dash, not reserved.
fn check_plain(name: &str) -> Result<(), SaveError> {
    let alphabet = |c: u8| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-';
    let shaped = !name.is_empty() && name.len() <= SLOT_NAME_MAX && name.bytes().all(alphabet);
    if !shaped || name.starts_with('-') {
        return Err(SaveError::slot_invalid(format!(
            "a slot name is 1 to {SLOT_NAME_MAX} of a-z, 0-9 and '-', not starting with '-': {name:?}"
        )));
    }
    if RESERVED_NAMES.contains(&name) {
        return Err(SaveError::slot_invalid(format!("{name:?} is reserved")));
    }
    Ok(())
}
