//! What a web page's `state()` says about its saves (M2.9, G6 UIS-12). On the web a game's saves
//! live in genex-core's in-memory [`mirror`], which the shell fills from IndexedDB before the first
//! reset and drains into it when the page is idle or hidden. Slot bodies (`.sav`) stay lazy: the
//! shell hands over their names and sizes only, and a body once a load asks for it ([`provide`]).
//! `state()` carries the mirror's account under `volatile.saves` (never in the checksum) and a
//! refused write's typed code (`save-quota`) as `state().error`, which the host's run card, the
//! prober and the page's notice read.
//!
//! The shell also asks the browser for persistent storage (`navigator.storage.persist()`) and
//! reports the answer ([`set_persistent`]); until it does, the page's storage counts as
//! best-effort (`persistent: false`).
//!
//! [`mirror`]: genex_core::saves::mirror

use std::cell::Cell;

use genex::{Value, json};
use genex_core::paths::{Destination, GameIdentity};
use genex_core::saves::Saves;
use genex_core::saves::mirror::{self, MirrorStatus};

/// The storage the mirror is written to, as `volatile.saves.store` names it.
pub const SAVES_STORE: &str = "indexeddb";
/// The IndexedDB database a game's saves live in: this prefix and the game's name.
pub const SAVES_DATABASE_PREFIX: &str = "genex-saves:";
/// The `volatile.saves` member that says whether the browser keeps the page's storage.
const PERSISTENT_KEY: &str = "persistent";
/// Any game's identity: the web's save root is the same for every game (its database is the
/// game's), so a mirror operation needs none.
const ANY_GAME: GameIdentity<'static> = GameIdentity { name: "", bundle_id: "" };

thread_local! {
    /// Whether the browser granted persistent storage (the shell's answer; false until it gives one).
    static PERSISTENT: Cell<bool> = const { Cell::new(false) };
}

/// The shell's answer to `navigator.storage.persist()`: whether the browser keeps the page's
/// storage under pressure (refused, rejected or no IndexedDB is false).
pub fn set_persistent(persistent: bool) {
    PERSISTENT.set(persistent);
}

/// Whether the browser granted persistent storage, as the shell last reported.
pub fn persistent() -> bool {
    PERSISTENT.get()
}

/// The shell's answer to a lazy body request: `Some(bytes)` makes the body resident (a held load
/// then restores), `None` says the store does not keep it, so the mirror forgets it and the load
/// refuses `save-slot-missing` at once instead of holding until `save-load-timeout`. False, with
/// nothing changed, for a name that is not a lazy body the mirror is still waiting for: the page
/// can neither plant a file nor drop a resident one.
pub fn provide(name: &str, body: Option<Vec<u8>>) -> bool {
    match body {
        Some(bytes) => mirror::provide(name, bytes),
        None => {
            // `request` answers whether `name` is a lazy body not resident yet (the shell already
            // took its request, so nothing new is asked); the removal settles it either way.
            mirror::request(name) && Saves::for_destination(Destination::Web, &|_| None, ANY_GAME).remove(name)
        }
    }
}

/// The mirror's account: `{store, files, bytes, pending, inFlight, lazy, persistent, error}`.
pub fn saves_state(status: &MirrorStatus) -> Value {
    json!({
        "store": SAVES_STORE,
        "files": status.files,
        "bytes": status.bytes,
        "pending": status.pending,
        "inFlight": status.in_flight,
        "lazy": status.lazy,
        PERSISTENT_KEY: persistent(),
        "error": status.error.map(|error| error.wire()),
    })
}

/// `state` with the mirror's typed code as `error` when the game reported no error of its own,
/// and the saves account under `volatile.saves`: a game with slots (`game.saves`) already reports
/// the full account there (the same shape on every destination), so only its `persistent` member
/// takes the shell's answer; any other game gets the mirror's account.
pub fn with_saves(mut state: Value, status: &MirrorStatus) -> Value {
    let Some(object) = state.as_object_mut() else { return state };
    if let Some(error) = status.error {
        let unset = object.get("error").is_none_or(Value::is_null);
        if unset {
            object.insert("error".to_owned(), json!(error.wire()));
        }
    }
    let volatile = object.entry("volatile").or_insert_with(|| json!({}));
    let Some(volatile) = volatile.as_object_mut() else { return state };
    match volatile.get_mut("saves").and_then(Value::as_object_mut) {
        Some(slotted) => {
            slotted.insert(PERSISTENT_KEY.to_owned(), json!(persistent()));
        }
        None => {
            volatile.insert("saves".to_owned(), saves_state(status));
        }
    }
    state
}
