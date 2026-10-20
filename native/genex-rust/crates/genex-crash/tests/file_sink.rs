//! The file sink's rows (CRASH-1a), a hostile-input table that asserts no side effect: a symlink
//! as the crash folder or the root refuses with nothing written; a refused root writes nothing; a
//! planted name is skipped for the next index and its target never touched; the 17th record
//! prunes the oldest and never a symlink; a record over 64 KiB writes nothing. And the SAVE
//! contract row: the crash folder is reserved, so `Saves::save` (and load, list, remove) refuse it.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use genex_core::paths::{Destination, GameIdentity, SaveRefusal};
use genex_core::saves::{SaveWriteError, Saves};
use genex_crash::caps::{CRASH_FILES_KEPT, CRASH_RECORD_MAX_BYTES};
use genex_crash::{CRASH_DIR, CrashKind, CrashRecord, CrashSink, CrashSource, FileSink, FileSinkError, FnSink};

const NO_GAME: GameIdentity<'static> = GameIdentity { name: "", bundle_id: "" };
static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

/// A fresh, empty folder for one test (removed when dropped).
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let n = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("genex-crash-sink-{}-{n}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("the scratch folder");
        Scratch(dir)
    }

    fn path(&self, rel: &str) -> PathBuf {
        self.0.join(rel)
    }

    /// The save root under this folder, made, as genex-core spells roots (ending in a separator).
    fn root(&self) -> String {
        let root = self.path("saves");
        fs::create_dir_all(&root).expect("the save root");
        format!("{}/", root.display())
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Every entry under `dir`: relative path to (kind, bytes or link target), symlinks not followed.
fn tree(dir: &Path) -> BTreeMap<String, String> {
    let mut seen = BTreeMap::new();
    let mut pending = vec![dir.to_path_buf()];
    while let Some(at) = pending.pop() {
        let Ok(entries) = fs::read_dir(&at) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let rel = path.strip_prefix(dir).expect("below").display().to_string();
            let meta = fs::symlink_metadata(&path).expect("metadata");
            let what = if meta.file_type().is_symlink() {
                format!("link -> {}", fs::read_link(&path).expect("target").display())
            } else if meta.is_dir() {
                pending.push(path);
                "dir".to_owned()
            } else {
                format!("file {:?}", fs::read(&path).expect("bytes"))
            };
            seen.insert(rel, what);
        }
    }
    seen
}

fn record_json(n: u64) -> Vec<u8> {
    let mut record = CrashRecord::new(CrashKind::Panic, CrashSource::Game, true, format!("crash {n}"));
    record.context.tick = Some(n);
    record.to_json()
}

fn names(sink: &FileSink) -> Vec<String> {
    sink.records().iter().map(|path| path.file_name().expect("a name").to_string_lossy().into_owned()).collect()
}

#[test]
fn records_go_to_the_crash_folder_under_the_save_root_with_rising_indices() {
    let scratch = Scratch::new("rising");
    let saves = Saves::at(Ok(scratch.root()));
    let sink = FileSink::new(&saves);
    let first = sink.write(&record_json(0)).expect("written");
    let second = sink.write(&record_json(1)).expect("written");
    assert_eq!(first, scratch.path("saves").join(CRASH_DIR).join("0.json"));
    assert_eq!(second, scratch.path("saves").join(CRASH_DIR).join("1.json"));
    let back = CrashRecord::from_json(&fs::read(&second).expect("readable")).expect("a record");
    assert_eq!(back.context.tick, Some(1));
    let written = (record_json(0).len() + record_json(1).len()) as u64;
    assert!(saves.bytes_used() >= written, "records count toward the quota (OX-4)");
}

#[test]
fn the_17th_record_prunes_the_oldest() {
    let scratch = Scratch::new("prune");
    let sink = FileSink::new(&Saves::at(Ok(scratch.root())));
    for n in 0..=CRASH_FILES_KEPT as u64 {
        sink.write(&record_json(n)).expect("written");
    }
    let kept = names(&sink);
    assert_eq!(kept.len(), CRASH_FILES_KEPT);
    assert_eq!(kept.first().map(String::as_str), Some("1.json"), "0.json, the oldest, went");
    assert_eq!(kept.last().map(String::as_str), Some("16.json"));
}

#[test]
fn a_refused_root_writes_nothing() {
    let scratch = Scratch::new("refused");
    let before = tree(&scratch.0);
    let sink = FileSink::new(&Saves::at(Err(SaveRefusal::NoHome)));
    assert_eq!(sink.write(&record_json(0)), Err(FileSinkError::NoRoot));
    assert_eq!(sink.dir(), None);
    assert_eq!(tree(&scratch.0), before);
}

#[test]
fn a_missing_root_is_not_made() {
    let scratch = Scratch::new("missing");
    let sink = FileSink::new(&Saves::at(Ok(format!("{}/", scratch.path("absent").display()))));
    assert_eq!(sink.write(&record_json(0)), Err(FileSinkError::NoRoot));
    assert!(tree(&scratch.0).is_empty());
}

#[test]
fn the_web_mirror_has_no_files_to_write() {
    let sink = FileSink::new(&Saves::for_destination(Destination::Web, &|_| None, NO_GAME));
    assert_eq!(sink.write(&record_json(0)), Err(FileSinkError::NoRoot));
}

#[test]
fn a_record_over_64_kib_writes_nothing() {
    let scratch = Scratch::new("large");
    let root = scratch.root();
    let before = tree(&scratch.0);
    let sink = FileSink::new(&Saves::at(Ok(root)));
    assert_eq!(sink.write(&vec![b' '; CRASH_RECORD_MAX_BYTES + 1]), Err(FileSinkError::TooLarge));
    assert_eq!(tree(&scratch.0), before, "not even the crash folder");
}

#[test]
fn a_crash_folder_that_is_a_file_is_refused_untouched() {
    let scratch = Scratch::new("file");
    let root = scratch.root();
    fs::write(scratch.path("saves").join(CRASH_DIR), b"not a folder").expect("planted");
    let before = tree(&scratch.0);
    assert_eq!(FileSink::new(&Saves::at(Ok(root))).write(&record_json(0)), Err(FileSinkError::Unsafe));
    assert_eq!(tree(&scratch.0), before);
}

#[cfg(unix)]
mod symlinks {
    use std::os::unix::fs::symlink;

    use super::*;

    #[test]
    fn a_crash_folder_symlink_is_refused_and_its_target_untouched() {
        let scratch = Scratch::new("dirlink");
        let root = scratch.root();
        fs::create_dir(scratch.path("elsewhere")).expect("target");
        symlink(scratch.path("elsewhere"), scratch.path("saves").join(CRASH_DIR)).expect("planted");
        let before = tree(&scratch.0);
        assert_eq!(FileSink::new(&Saves::at(Ok(root))).write(&record_json(0)), Err(FileSinkError::Unsafe));
        assert_eq!(tree(&scratch.0), before);
        assert!(tree(&scratch.path("elsewhere")).is_empty());
    }

    #[test]
    fn a_root_symlink_is_refused_and_its_target_untouched() {
        let scratch = Scratch::new("rootlink");
        fs::create_dir(scratch.path("real")).expect("target");
        symlink(scratch.path("real"), scratch.path("linked")).expect("planted");
        let before = tree(&scratch.0);
        let sink = FileSink::new(&Saves::at(Ok(format!("{}/", scratch.path("linked").display()))));
        assert_eq!(sink.write(&record_json(0)), Err(FileSinkError::Unsafe));
        assert_eq!(tree(&scratch.0), before);
    }

    #[test]
    fn a_planted_name_is_skipped_for_the_next_index_and_its_target_untouched() {
        let scratch = Scratch::new("collision");
        let root = scratch.root();
        let dir = scratch.path("saves").join(CRASH_DIR);
        fs::create_dir(&dir).expect("the crash folder");
        fs::write(scratch.path("victim.txt"), b"keep me").expect("victim");
        symlink(scratch.path("victim.txt"), dir.join("0.json")).expect("planted");
        let written = FileSink::new(&Saves::at(Ok(root))).write(&record_json(0)).expect("written");
        assert_eq!(written, dir.join("1.json"), "the collision took the next index");
        assert_eq!(fs::read(scratch.path("victim.txt")).expect("victim"), b"keep me");
        assert!(fs::symlink_metadata(dir.join("0.json")).expect("still there").file_type().is_symlink());
    }

    #[test]
    fn pruning_never_removes_a_symlink() {
        let scratch = Scratch::new("prunelink");
        let root = scratch.root();
        let dir = scratch.path("saves").join(CRASH_DIR);
        fs::create_dir(&dir).expect("the crash folder");
        fs::write(scratch.path("victim.txt"), b"keep me").expect("victim");
        symlink(scratch.path("victim.txt"), dir.join("0.json")).expect("planted");
        let sink = FileSink::new(&Saves::at(Ok(root)));
        for n in 0..(CRASH_FILES_KEPT as u64 + 4) {
            sink.write(&record_json(n)).expect("written");
        }
        assert_eq!(names(&sink).len(), CRASH_FILES_KEPT, "only regular records are kept and counted");
        assert!(fs::symlink_metadata(dir.join("0.json")).expect("still there").file_type().is_symlink());
        assert_eq!(fs::read(scratch.path("victim.txt")).expect("victim"), b"keep me");
    }
}

#[test]
fn a_save_into_the_crash_folder_is_refused_in_any_case() {
    let scratch = Scratch::new("reserved");
    let saves = Saves::at(Ok(scratch.root()));
    let sink = FileSink::new(&saves);
    sink.write(&record_json(0)).expect("written");
    let reserved =
        ["genex-crash", "genex-crash/0.json", "genex-crash/mine.sav", "GENEX-CRASH/x.sav", "Genex-Crash/0.json"];
    for name in reserved {
        assert_eq!(saves.save_checked(name, b"overwrite"), Err(SaveWriteError::Unsafe), "save {name}");
        assert!(!saves.save(name, b"overwrite"), "save {name}");
        assert_eq!(saves.load(name), None, "load {name}");
        assert!(!saves.remove(name), "remove {name}");
    }
    assert!(saves.list(CRASH_DIR).is_empty(), "the folder is never listed");
    assert!(!saves.list("").iter().any(|name| name.starts_with(CRASH_DIR)));
    assert!(saves.save("genex-crashed.sav", b"a game's own name"), "only the folder itself is reserved");
    let record = fs::read(scratch.path("saves").join(CRASH_DIR).join("0.json")).expect("the record");
    assert_eq!(CrashRecord::from_json(&record).map(|record| record.message), Ok("crash 0".to_owned()));
}

#[test]
fn a_closure_sink_gets_the_record_and_its_json() {
    let delivered: Mutex<Vec<(CrashKind, usize)>> = Mutex::new(Vec::new());
    let sink = FnSink(|record: &CrashRecord, json: &[u8]| {
        delivered.lock().expect("unpoisoned").push((record.kind, json.len()));
    });
    let record = CrashRecord::new(CrashKind::DeviceLost, CrashSource::Game, false, "lost");
    let json = record.to_json();
    sink.deliver(&record, &json);
    assert_eq!(delivered.lock().expect("unpoisoned").as_slice(), &[(CrashKind::DeviceLost, json.len())]);
}
