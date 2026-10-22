//! The web saves mirror (M2.9): on the web a game's synchronous `save`/`load` go to an in-memory
//! mirror the shell fills from IndexedDB before the first reset and drains, write-behind, on idle
//! and when the page is hidden. A write the browser refuses (quota, eviction) leaves the save
//! pending and surfaces as the typed `save-quota` code in `state()`.

use genex_core::paths::{Destination, GameIdentity};
use genex_core::saves::{MAX_SAVE_BYTES, Saves, mirror};
use genex_platform_web::web_saves::{SAVES_STORE, saves_state, with_saves};

const GAME: GameIdentity<'static> = GameIdentity { name: "web-saves", bundle_id: "" };

fn web_saves() -> Saves {
    Saves::for_destination(Destination::Web, &|_| None, GAME)
}

#[test]
fn a_web_destination_saves_into_the_mirror_and_marks_the_file_dirty() {
    mirror::preload(Vec::new());
    let saves = web_saves();
    assert!(saves.is_mirrored());
    assert!(saves.save("slot/one.bin", b"abc"));
    assert_eq!(saves.load("slot/one.bin").as_deref(), Some(&b"abc"[..]));
    assert_eq!(mirror::status().pending, 1);
    assert_eq!(mirror::take_dirty(), vec![("slot/one.bin".to_owned(), b"abc".to_vec())]);
    assert_eq!(mirror::status().pending, 0, "taken writes are in flight, not pending");
    mirror::flushed(Ok(()));
    assert_eq!(mirror::status().error, None);
}

#[test]
fn a_preloaded_save_is_read_before_anything_is_written() {
    mirror::preload(vec![("best.bin".to_owned(), vec![7, 0, 0, 0])]);
    let saves = web_saves();
    assert_eq!(saves.load("best.bin"), Some(vec![7, 0, 0, 0]));
    assert_eq!(mirror::status().pending, 0, "preloaded files are already stored");
}

#[test]
fn hostile_names_and_oversize_saves_never_reach_the_mirror() {
    mirror::preload(vec![
        ("../escape.bin".to_owned(), vec![1]),
        ("/abs.bin".to_owned(), vec![1]),
        ("ok.bin".to_owned(), vec![2]),
        ("huge.bin".to_owned(), vec![0; MAX_SAVE_BYTES + 1]),
    ]);
    let saves = web_saves();
    for hostile in ["../escape.bin", "/abs.bin", "a/../../b", "", "huge.bin"] {
        assert_eq!(saves.load(hostile), None, "{hostile:?} is not loadable");
        assert!(!saves.save(hostile, b"x") || hostile == "huge.bin", "{hostile:?} is not saved");
    }
    assert!(!saves.save("big.bin", &vec![0; MAX_SAVE_BYTES + 1]));
    assert_eq!(saves.load("ok.bin"), Some(vec![2]));
    let dirty: Vec<String> = mirror::take_dirty().into_iter().map(|(name, _)| name).collect();
    assert!(dirty.iter().all(|name| name == "huge.bin"), "only safe names are dirty: {dirty:?}");
}

#[test]
fn a_refused_flush_keeps_the_writes_pending_and_reports_save_quota() {
    mirror::preload(Vec::new());
    let saves = web_saves();
    assert!(saves.save("progress.bin", b"1"));
    let taken = mirror::take_dirty();
    mirror::flushed(Err((mirror::MirrorError::Quota, taken.into_iter().map(|(name, _)| name).collect())));
    let status = mirror::status();
    assert_eq!(status.error, Some(mirror::MirrorError::Quota));
    assert_eq!(status.pending, 1, "the refused write is retried on the next flush");
    let state = saves_state(&status);
    assert_eq!(state["store"], SAVES_STORE);
    assert_eq!(state["error"], "save-quota");
    assert_eq!(state["pending"], 1);
    // A later flush that lands clears the code.
    assert_eq!(mirror::take_dirty().len(), 1);
    mirror::flushed(Ok(()));
    assert_eq!(saves_state(&mirror::status())["error"], serde_json::Value::Null);
}

#[test]
fn a_file_saved_again_while_its_flush_is_in_flight_stays_dirty() {
    mirror::preload(Vec::new());
    let saves = web_saves();
    assert!(saves.save("a.bin", b"1"));
    let taken = mirror::take_dirty();
    assert!(saves.save("a.bin", b"2"));
    mirror::flushed(Err((mirror::MirrorError::Quota, taken.into_iter().map(|(name, _)| name).collect())));
    assert_eq!(mirror::take_dirty(), vec![("a.bin".to_owned(), b"2".to_vec())], "the newest bytes win");
}

#[test]
fn every_other_destination_keeps_its_files() {
    let saves = Saves::at(Ok("/nowhere/".to_owned()));
    assert!(!saves.is_mirrored());
}

#[test]
fn state_carries_the_account_under_volatile_and_the_typed_code_as_error() {
    mirror::preload(Vec::new());
    let saves = web_saves();
    assert!(saves.save("a.bin", b"1"));
    let state = serde_json::json!({ "error": null, "volatile": { "fps": 60.0 }, "score": 3 });
    let clean = with_saves(state.clone(), &mirror::status());
    assert_eq!(clean["error"], serde_json::Value::Null);
    assert_eq!(clean["volatile"]["fps"], 60.0);
    assert_eq!(clean["volatile"]["saves"]["pending"], 1);
    assert_eq!(clean["score"], 3, "probes are untouched");
    let taken = mirror::take_dirty();
    mirror::flushed(Err((mirror::MirrorError::Quota, taken.into_iter().map(|(name, _)| name).collect())));
    let refused = with_saves(state, &mirror::status());
    assert_eq!(refused["error"], "save-quota");
    let own = with_saves(serde_json::json!({ "error": "boom", "volatile": {} }), &mirror::status());
    assert_eq!(own["error"], "boom", "the game's own error is kept");
    assert_eq!(own["volatile"]["saves"]["error"], "save-quota");
}

#[test]
fn a_wire_code_names_its_error_and_nothing_else() {
    assert_eq!(mirror::MirrorError::from_wire("save-quota"), Some(mirror::MirrorError::Quota));
    assert_eq!(mirror::MirrorError::from_wire("save-unavailable"), Some(mirror::MirrorError::Unavailable));
    assert_eq!(mirror::MirrorError::from_wire("gpu-unsupported"), None);
}
