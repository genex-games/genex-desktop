//! genex-save: saves for genex games, below the facade. A save is a named slot holding a versioned
//! envelope of sections, encoded deterministically (deflated past a size), migrated forward on
//! load, written at the end of a tick and swapped in before the next one, inside a total quota the
//! runtime enforces on every destination.
//!
//! Every planned module was declared by UIS-0 so each work package filled one body: the envelope,
//! slots and codec (UIS-2) and migrations, the index, autosave, quota and the slot driver (UIS-3).

pub mod error;
pub mod slot;
pub mod envelope;
pub mod codec;
pub mod index;
pub mod quota;
pub mod migrate;
pub mod autosave;
pub mod driver;

pub use codec::{DEFLATE_ABOVE_BYTES, DEFLATE_LEVEL};
pub use driver::{SAVE_LOAD_HOLD_MAX_MS, SLOTS_MAX};
pub use envelope::{LABEL_CHARS_MAX, SECTION_NAME_MAX, SECTIONS_MAX};
pub use index::META_BYTES_MAX;
pub use migrate::MIGRATION_STEPS_MAX;
pub use slot::{AUTOSAVE_RING_MAX, SLOT_NAME_MAX};
