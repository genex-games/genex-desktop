//! genex-save: saves for genex games, below the facade. A save is a named slot holding a versioned
//! envelope of sections, encoded deterministically (deflated past a size), migrated forward on
//! load, written at the end of a tick and swapped in before the next one, inside a total quota the
//! runtime enforces on every destination.
//!
//! Every planned module is declared now so each work package fills one body (G6 saves, UIS-0); a
//! module that names its work package is still a stub.

pub mod error;
pub mod slot;
pub mod envelope;
pub mod codec;
pub mod index;
pub mod quota;
pub mod migrate;
pub mod autosave;
pub mod driver;
