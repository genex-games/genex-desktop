//! `SaveErrorCode`: why a save, load or delete refused, as a typed code with a wire spelling. The
//! codes are pinned in the facade vocabulary (`tests/fixtures/rust-facade-vocabulary.json`) and
//! documented in the same change; `save-quota` and `save-unavailable` are genex-core's
//! [`MirrorError`] spellings, never re-spelled here.

use genex_core::saves::SaveWriteError;
use genex_core::saves::mirror::MirrorError;

/// Why a slot operation refused. Nothing changed: the slot, its sidecar and the running game are
/// as they were.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum SaveErrorCode {
    /// A slot name that is not 1 to 32 of `[a-z0-9-]`, starts with a dash, is a reserved name, or
    /// names an autosave slot in a save call; or a label past `LABEL_CHARS_MAX`.
    SlotInvalid,
    /// No slot of that name exists.
    SlotMissing,
    /// A new named slot past the game's `slots_max`.
    SlotsFull,
    /// An envelope past genex-core's `MAX_SAVE_BYTES` (16 MiB), encoded or inflated.
    TooLarge,
    /// The game's saves would pass genex-core's `MAX_TOTAL_SAVE_BYTES` (64 MiB), or the browser's
    /// quota is spent.
    Quota,
    /// There is no save root, the store could not be written, or the browser's storage is closed.
    Unavailable,
    /// A body or sidecar that is not a well-formed, canonical envelope, or whose digest does not
    /// match.
    Corrupt,
    /// Bytes that are not a genex save, or a save of a format this build does not read.
    FormatUnknown,
    /// A slot saved at a schema above the game's.
    Newer,
    /// No migration step from a schema on the slot's way to the game's.
    MigrationMissing,
    /// A migration step answered an error or a value that is not an object.
    MigrationFailed,
    /// A section name, count or nesting the envelope cannot hold.
    SectionInvalid,
    /// A section the game registered is missing from the slot.
    SectionMissing,
    /// A load is already pending.
    Busy,
    /// A lazy body did not arrive within `SAVE_LOAD_HOLD_MAX_MS`.
    LoadTimeout,
    /// The game registered no saves.
    NotConfigured,
}

impl SaveErrorCode {
    /// Every code, in declaration order.
    pub const ALL: [SaveErrorCode; 16] = [
        SaveErrorCode::SlotInvalid,
        SaveErrorCode::SlotMissing,
        SaveErrorCode::SlotsFull,
        SaveErrorCode::TooLarge,
        SaveErrorCode::Quota,
        SaveErrorCode::Unavailable,
        SaveErrorCode::Corrupt,
        SaveErrorCode::FormatUnknown,
        SaveErrorCode::Newer,
        SaveErrorCode::MigrationMissing,
        SaveErrorCode::MigrationFailed,
        SaveErrorCode::SectionInvalid,
        SaveErrorCode::SectionMissing,
        SaveErrorCode::Busy,
        SaveErrorCode::LoadTimeout,
        SaveErrorCode::NotConfigured,
    ];

    /// The code's wire spelling.
    pub fn wire(self) -> &'static str {
        match self {
            SaveErrorCode::SlotInvalid => "save-slot-invalid",
            SaveErrorCode::SlotMissing => "save-slot-missing",
            SaveErrorCode::SlotsFull => "save-slots-full",
            SaveErrorCode::TooLarge => "save-too-large",
            SaveErrorCode::Quota => MirrorError::Quota.wire(),
            SaveErrorCode::Unavailable => MirrorError::Unavailable.wire(),
            SaveErrorCode::Corrupt => "save-corrupt",
            SaveErrorCode::FormatUnknown => "save-format-unknown",
            SaveErrorCode::Newer => "save-newer",
            SaveErrorCode::MigrationMissing => "save-migration-missing",
            SaveErrorCode::MigrationFailed => "save-migration-failed",
            SaveErrorCode::SectionInvalid => "save-section-invalid",
            SaveErrorCode::SectionMissing => "save-section-missing",
            SaveErrorCode::Busy => "save-busy",
            SaveErrorCode::LoadTimeout => "save-load-timeout",
            SaveErrorCode::NotConfigured => "save-not-configured",
        }
    }

    /// The code for a wire spelling; None for any other.
    pub fn from_wire(code: &str) -> Option<SaveErrorCode> {
        SaveErrorCode::ALL.into_iter().find(|candidate| candidate.wire() == code)
    }
}

/// The volatile issue a load reports when it applied but the recomputed state checksum differs
/// from the one the slot saved. Not a refusal: the restored game runs.
pub const SAVE_RESTORE_DIVERGED: &str = "save-restore-diverged";

/// A refused slot operation: the code and what was wrong, for a person to read. Nothing changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SaveError {
    /// What was refused.
    pub code: SaveErrorCode,
    /// The detail (names, sizes, the failing step), never matched on.
    pub detail: String,
}

impl SaveError {
    /// A refusal with `code`.
    pub fn new(code: SaveErrorCode, detail: impl Into<String>) -> SaveError {
        SaveError { code, detail: detail.into() }
    }

    /// A `save-corrupt` refusal.
    pub fn corrupt(detail: impl Into<String>) -> SaveError {
        SaveError::new(SaveErrorCode::Corrupt, detail)
    }

    /// A `save-too-large` refusal.
    pub fn too_large(detail: impl Into<String>) -> SaveError {
        SaveError::new(SaveErrorCode::TooLarge, detail)
    }

    /// A `save-slot-invalid` refusal.
    pub fn slot_invalid(detail: impl Into<String>) -> SaveError {
        SaveError::new(SaveErrorCode::SlotInvalid, detail)
    }

    /// A `save-section-invalid` refusal.
    pub fn section_invalid(detail: impl Into<String>) -> SaveError {
        SaveError::new(SaveErrorCode::SectionInvalid, detail)
    }
}

impl From<SaveWriteError> for SaveError {
    /// The store's refusal as a slot refusal: an unsafe name is an invalid slot; a missing root or
    /// a failed write leaves saves unavailable.
    fn from(error: SaveWriteError) -> SaveError {
        let code = match error {
            SaveWriteError::Unsafe => SaveErrorCode::SlotInvalid,
            SaveWriteError::TooLarge => SaveErrorCode::TooLarge,
            SaveWriteError::Quota => SaveErrorCode::Quota,
            SaveWriteError::NoRoot | SaveWriteError::Io => SaveErrorCode::Unavailable,
        };
        SaveError::new(code, error.to_string())
    }
}

impl From<MirrorError> for SaveError {
    /// The browser storage's refusal, under the same wire spelling.
    fn from(error: MirrorError) -> SaveError {
        let code = match error {
            MirrorError::Quota => SaveErrorCode::Quota,
            MirrorError::Unavailable => SaveErrorCode::Unavailable,
        };
        SaveError::new(code, "the browser's storage refused the write")
    }
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code.wire(), self.detail)
    }
}

impl std::error::Error for SaveError {}
