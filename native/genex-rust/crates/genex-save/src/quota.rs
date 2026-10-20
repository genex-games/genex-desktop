//! The quota planner: whether a slot write fits the game's total before anything is written, so a
//! body never lands without room for its sidecar. "Used" is everything the game keeps under its
//! save root (genex-core `Saves::bytes_used`): slots, legacy saves, settings, the crash records in
//! `genex-crash/`, and the Vulkan pipeline cache, which is written through `Saves` too.

use genex_core::saves::MAX_TOTAL_SAVE_BYTES;

use crate::error::{SaveError, SaveErrorCode};

/// The bytes all of one game's saves may hold together.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quota {
    /// The cap in bytes (genex-core's `MAX_TOTAL_SAVE_BYTES` by default).
    pub total: u64,
}

impl Default for Quota {
    fn default() -> Quota {
        Quota { total: MAX_TOTAL_SAVE_BYTES }
    }
}

impl Quota {
    /// The bytes used after replacing `replaced` bytes with `written` when `used` are held now, or
    /// `save-quota` past the cap.
    pub fn check(&self, used: u64, replaced: u64, written: u64) -> Result<u64, SaveError> {
        let after = used.saturating_sub(replaced).saturating_add(written);
        if after > self.total {
            return Err(SaveError::new(
                SaveErrorCode::Quota,
                format!("the game's saves would hold {after} bytes; at most {} together", self.total),
            ));
        }
        Ok(after)
    }

    /// The bytes still free when `used` are held.
    pub fn headroom(&self, used: u64) -> u64 {
        self.total.saturating_sub(used)
    }
}
