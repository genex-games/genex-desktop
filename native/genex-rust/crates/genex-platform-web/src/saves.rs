//! What a web page's `state()` says about its saves (M2.9). On the web a game's saves live in
//! genex-core's in-memory [`mirror`], which the shell fills from IndexedDB before the first reset
//! and drains into it when the page is idle or hidden. `state()` carries the mirror's account
//! under `volatile.saves` (never in the checksum) and a refused write's typed code (`save-quota`)
//! as `state().error`, which the host's run card, the prober and the page's notice read.
//!
//! [`mirror`]: genex_core::saves::mirror

use genex::{Value, json};
use genex_core::saves::mirror::MirrorStatus;

/// The storage the mirror is written to, as `volatile.saves.store` names it.
pub const SAVES_STORE: &str = "indexeddb";
/// The IndexedDB database a game's saves live in: this prefix and the game's name.
pub const SAVES_DATABASE_PREFIX: &str = "genex-saves:";

/// The mirror's account: `{store, files, pending, inFlight, error}`.
pub fn saves_state(status: &MirrorStatus) -> Value {
    json!({
        "store": SAVES_STORE,
        "files": status.files,
        "pending": status.pending,
        "inFlight": status.in_flight,
        "error": status.error.map(|error| error.wire()),
    })
}

/// `state` with the mirror's account under `volatile.saves` and, when the game reported no error
/// of its own, the mirror's typed code as `error`.
pub fn with_saves(mut state: Value, status: &MirrorStatus) -> Value {
    let Some(object) = state.as_object_mut() else { return state };
    if let Some(error) = status.error {
        let unset = object.get("error").is_none_or(Value::is_null);
        if unset {
            object.insert("error".to_owned(), json!(error.wire()));
        }
    }
    let volatile = object.entry("volatile").or_insert_with(|| json!({}));
    if let Some(volatile) = volatile.as_object_mut() {
        volatile.insert("saves".to_owned(), saves_state(status));
    }
    state
}
