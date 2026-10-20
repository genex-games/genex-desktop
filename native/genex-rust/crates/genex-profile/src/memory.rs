//! Memory rows: what the summary and the report say about memory, one row per class. A class is a
//! GPU budget kind (genex-render's `BudgetKind` wire spellings), a CPU memory class (the stream
//! crate's memory-fact wire spellings) or a process measure. Those crates own their spellings;
//! this module only carries them, checked as names. At most [`PROFILE_MEMORY_ROWS_MAX`] rows; a
//! class set again replaces its row.

use crate::scope::is_scope_name;
use crate::summary::{MemoryRow, ProfileSummary};

/// The most memory rows a summary or report lists.
pub const PROFILE_MEMORY_ROWS_MAX: usize = 64;

/// One memory row's class.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum MemoryClass {
    /// A GPU budget kind, by its wire spelling (`target`, `streamed-meshes`, …).
    Gpu(&'static str),
    /// A CPU memory class, by its wire spelling (`asset-cache`, `anim-clips`, …).
    Cpu(&'static str),
    /// The process's resident memory.
    ProcessResident,
    /// What the OS still lets the process take (phones).
    ProcessAvailable,
    /// The WebAssembly heap (`memory.buffer.byteLength`).
    WasmHeap,
}

impl MemoryClass {
    /// The class's wire spelling: the owner's spelling for a GPU or CPU class.
    pub const fn wire(self) -> &'static str {
        match self {
            MemoryClass::Gpu(wire) | MemoryClass::Cpu(wire) => wire,
            MemoryClass::ProcessResident => "process-resident",
            MemoryClass::ProcessAvailable => "process-available",
            MemoryClass::WasmHeap => "wasm-heap",
        }
    }
}

/// A frame's memory rows, in the order first set.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct MemoryRows {
    rows: Vec<MemoryRow>,
    dropped: u64,
}

impl MemoryRows {
    /// No rows yet.
    pub fn new() -> MemoryRows {
        MemoryRows::default()
    }

    /// Set `class` to `bytes` (and its budget); false, counted as dropped, for a class whose
    /// spelling is not a name or a new class past [`PROFILE_MEMORY_ROWS_MAX`].
    pub fn push(&mut self, class: MemoryClass, bytes: u64, budget: Option<u64>) -> bool {
        let wire = class.wire();
        if let Some(row) = self.rows.iter_mut().find(|row| row.class == wire) {
            row.bytes = bytes;
            row.budget = budget;
            return true;
        }
        if !is_scope_name(wire) || self.rows.len() >= PROFILE_MEMORY_ROWS_MAX {
            self.dropped = self.dropped.saturating_add(1);
            return false;
        }
        self.rows.push(MemoryRow { class: wire.to_owned(), bytes, budget });
        true
    }

    /// The rows.
    pub fn rows(&self) -> &[MemoryRow] {
        &self.rows
    }

    /// Sets left out so far.
    pub fn dropped(&self) -> u64 {
        self.dropped
    }

    /// Put the rows into `summary`.
    pub fn fill(&self, summary: &mut ProfileSummary) {
        summary.memory = self.rows.clone();
    }
}
