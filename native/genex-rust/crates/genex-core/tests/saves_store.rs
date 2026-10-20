//! The save store under genex-save's slots: `list`, `remove`, `bytes_used`, the total quota
//! ([`MAX_TOTAL_SAVE_BYTES`]), typed write errors from `save_checked`, and the web mirror's lazy
//! `.sav` bodies (index first, a body only when asked for). Every hostile row asserts that nothing
//! changed on disk, inside the save root or outside it.

use std::fs;
use std::path::{Path, PathBuf};

use genex_core::paths::{ANDROID_DATA_KEY, Destination, GameIdentity};
use genex_core::saves::mirror;
use genex_core::saves::{MAX_SAVE_BYTES, MAX_TOTAL_SAVE_BYTES, SaveWriteError, Saves};

/// A fresh folder under the system temp dir, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let mut path = std::env::temp_dir();
        path.push(format!("genex-core-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("a scratch folder");
        Scratch(path.canonicalize().expect("canonical scratch"))
    }

    fn root(&self) -> String {
        format!("{}/", self.0.display())
    }

    fn saves(&self) -> Saves {
        Saves::at(Ok(self.root()))
    }

    /// Every entry under the scratch folder (files, folders and symlinks, not followed) with its
    /// size, relative and sorted: what a hostile row compares before and after.
    fn snapshot(&self) -> Vec<(String, u64)> {
        let mut out = Vec::new();
        walk(&self.0, &self.0, &mut out);
        out.sort();
        out
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<(String, u64)>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = fs::symlink_metadata(&path) else { continue };
        let rel = path.strip_prefix(base).map(|rel| rel.display().to_string()).unwrap_or_default();
        if meta.is_dir() {
            out.push((format!("{rel}/"), 0));
            walk(base, &path, out);
        } else {
            out.push((rel, meta.len()));
        }
    }
}

const NO_GAME: GameIdentity<'static> = GameIdentity { name: "", bundle_id: "" };
const MIB: usize = 1024 * 1024;

#[test]
fn list_answers_the_files_of_one_folder_sorted() {
    let scratch = Scratch::new("list");
    let saves = scratch.saves();
    for name in ["slots/b.sav", "slots/a.sav", "slots/a.meta.json", "slots/deep/x.sav", "best.txt"] {
        saves.save_checked(name, b"x").expect("saved");
    }
    fs::write(scratch.0.join("slots/c.sav.partial"), b"half").expect("a staging file");
    assert_eq!(saves.list("slots"), ["slots/a.meta.json", "slots/a.sav", "slots/b.sav"]);
    assert_eq!(saves.list(""), ["best.txt"], "the root's own files; folders are not listed");
    assert!(saves.list("absent").is_empty());
    assert!(saves.list("best.txt").is_empty(), "a file is not a folder");
}

#[test]
fn remove_deletes_one_file_and_answers_whether_it_did() {
    let scratch = Scratch::new("remove");
    let saves = scratch.saves();
    saves.save_checked("slots/a.sav", b"abc").expect("saved");
    assert!(saves.remove("slots/a.sav"));
    assert_eq!(saves.load("slots/a.sav"), None);
    assert!(!saves.remove("slots/a.sav"), "a file already gone");
    assert_eq!(scratch.snapshot(), [("slots/".to_owned(), 0)], "the folder stays");
}

#[test]
fn save_checked_names_why_a_write_was_refused_and_save_keeps_its_bool() {
    let scratch = Scratch::new("typed");
    let saves = scratch.saves();
    assert_eq!(saves.save_checked("ok.bin", b"1"), Ok(()));
    assert_eq!(saves.save_checked("../x", b"1"), Err(SaveWriteError::Unsafe));
    assert_eq!(saves.save_checked("big.bin", &vec![0; MAX_SAVE_BYTES + 1]), Err(SaveWriteError::TooLarge));
    let rootless = Saves::at(Err(genex_core::paths::SaveRefusal::NoStateDir));
    assert_eq!(rootless.save_checked("ok.bin", b"1"), Err(SaveWriteError::NoRoot));
    assert!(!rootless.save("ok.bin", b"1"));
    assert!(saves.save("ok.bin", b"22"));
    assert!(!saves.save("../x", b"1"));
    let codes = [
        SaveWriteError::Unsafe,
        SaveWriteError::NoRoot,
        SaveWriteError::TooLarge,
        SaveWriteError::Quota,
        SaveWriteError::Io,
    ];
    for code in codes {
        assert!(!code.to_string().is_empty());
    }
}

#[test]
fn bytes_used_skips_the_hosts_folders_of_a_genex_run_and_an_android_root() {
    let scratch = Scratch::new("host");
    let state = scratch.0.display().to_string();
    let env = |name: &str| (name == "GENEX_STATE_DIR").then(|| state.clone());
    let saves = Saves::for_destination(Destination::GenexRun, &env, NO_GAME);
    fs::create_dir_all(scratch.0.join("captures")).expect("captures");
    fs::write(scratch.0.join("captures/0.bgra"), vec![0; 4096]).expect("a capture");
    fs::create_dir_all(scratch.0.join("home/Library/Caches")).expect("the process home");
    fs::write(scratch.0.join("home/Library/Caches/shaders.bin"), vec![0; 1000]).expect("an OS cache");
    saves.save_checked("progress.json", b"{}").expect("saved");
    assert_eq!(saves.bytes_used(), 2, "the run's captures and its process home are the host's, not the game's");
    assert_eq!(saves.save_checked("home/x.json", b"x"), Err(SaveWriteError::Unsafe));
    assert!(saves.list("captures").is_empty());
    assert!(!saves.remove("captures/0.bgra"), "a game never removes the host's files");
    assert_eq!(saves.save_checked("captures/1.bgra", b"x"), Err(SaveWriteError::Unsafe));

    let data = Scratch::new("android");
    let root = data.0.display().to_string();
    let env = |name: &str| (name == ANDROID_DATA_KEY).then(|| root.clone());
    let android = Saves::for_destination(Destination::Android, &env, NO_GAME);
    fs::create_dir_all(data.0.join("genex-self-test")).expect("records");
    fs::write(data.0.join("genex-self-test/lifecycle.ndjson"), vec![b'x'; 900]).expect("a record");
    android.save_checked("slots/a.sav", b"abc").expect("saved");
    assert_eq!(android.bytes_used(), 3, "the shell's records are not the game's");

    let plain = scratch.saves();
    assert_eq!(plain.bytes_used(), 5098, "a root handed in whole counts every file under it");
}

#[test]
fn a_write_past_the_total_quota_is_refused_and_writes_nothing() {
    let scratch = Scratch::new("quota");
    let saves = scratch.saves();
    let full = vec![1u8; MAX_SAVE_BYTES];
    let slots = usize::try_from(MAX_TOTAL_SAVE_BYTES).expect("fits") / MAX_SAVE_BYTES;
    for slot in 0..slots {
        saves.save_checked(&format!("slots/{slot}.sav"), &full).expect("under the quota");
    }
    assert_eq!(saves.bytes_used(), MAX_TOTAL_SAVE_BYTES);
    let before = scratch.snapshot();
    assert_eq!(saves.save_checked("one-more.bin", b"x"), Err(SaveWriteError::Quota), "64 MiB + 1");
    assert!(!saves.save("one-more.bin", b"x"));
    assert_eq!(scratch.snapshot(), before, "nothing written");
    assert_eq!(saves.save_checked("slots/0.sav", &full), Ok(()), "replacing a file counts only the difference");
    assert_eq!(saves.save_checked("slots/0.sav", &vec![1u8; MAX_SAVE_BYTES - 1]), Ok(()));
    assert_eq!(saves.save_checked("one-more.bin", b"x"), Ok(()), "the freed byte is usable");
}

#[test]
fn hostile_names_refuse_list_remove_and_save_checked_with_no_side_effect() {
    let scratch = Scratch::new("hostile");
    let saves = scratch.saves();
    saves.save_checked("slots/a.sav", b"abc").expect("saved");
    let before = scratch.snapshot();
    let hostile = ["", "..", "../slots/a.sav", "slots/../slots/a.sav", "/etc/passwd", "slots\\a.sav", "con.txt", "nul", "aux.sav", "slots/com1", "lpt1.meta.json", "a\0b", "slots/a.sav "];
    for name in hostile {
        assert_eq!(saves.save_checked(name, b"x"), Err(SaveWriteError::Unsafe), "{name:?}");
        assert!(!saves.remove(name), "{name:?}");
    }
    for folder in ["..", "../", "/", "/etc", "slots/..", "a\0b", "con", "slots/"] {
        assert!(saves.list(folder).is_empty(), "{folder:?}");
    }
    assert!(!saves.remove("slots"), "removing a folder");
    assert_eq!(scratch.snapshot(), before, "nothing changed");
}

#[cfg(unix)]
#[test]
fn symlinks_are_never_followed_by_list_remove_or_save_checked() {
    let scratch = Scratch::new("links");
    let outside = Scratch::new("links-outside");
    fs::write(outside.0.join("a.sav"), b"theirs").expect("a file outside");
    std::os::unix::fs::symlink(&outside.0, scratch.0.join("slots")).expect("a symlinked slots folder");
    std::os::unix::fs::symlink(outside.0.join("a.sav"), scratch.0.join("best.txt.partial")).expect("a symlinked .partial");
    std::os::unix::fs::symlink(outside.0.join("a.sav"), scratch.0.join("linked.sav")).expect("a symlinked file");
    let saves = scratch.saves();
    let (inside, theirs) = (scratch.snapshot(), outside.snapshot());
    assert_eq!(saves.save_checked("slots/b.sav", b"x"), Err(SaveWriteError::Unsafe), "through a symlinked folder");
    assert!(saves.list("slots").is_empty(), "a symlinked folder lists nothing");
    assert!(!saves.remove("slots/a.sav"), "a remove through a symlinked folder");
    assert_eq!(saves.save_checked("best.txt", b"mine"), Err(SaveWriteError::Unsafe), "a symlinked staging file");
    assert!(!saves.remove("linked.sav"), "a symlinked file is not removed");
    assert_eq!(saves.save_checked("linked.sav", b"x"), Err(SaveWriteError::Unsafe));
    assert!(!saves.list("").contains(&"linked.sav".to_owned()), "a symlinked file is not listed");
    assert_eq!(saves.bytes_used(), 0, "links are not counted");
    assert_eq!(scratch.snapshot(), inside, "nothing changed inside");
    assert_eq!(outside.snapshot(), theirs, "nothing changed outside");
    assert_eq!(fs::read(outside.0.join("a.sav")).expect("still there"), b"theirs");
}

/// Characterization flip (named in the PR): `mirror::preload` used to keep every entry it was
/// given resident, so ten 16 MiB slots held 160 MiB in a phone tab's heap. It now keeps only the
/// index of `.sav` bodies, and every other file resident as before.
#[test]
fn the_web_mirror_keeps_sav_bodies_lazy_and_other_files_resident() {
    let mut entries: Vec<(String, Vec<u8>)> = (0..10).map(|slot| (format!("slots/{slot}.sav"), vec![0; 16 * MIB])).collect();
    entries.push(("best.txt".to_owned(), b"42".to_vec()));
    mirror::preload(entries);
    let status = mirror::status();
    assert_eq!(status.files, 11);
    assert_eq!(status.lazy, 10, "no slot body is resident");
    assert_eq!(status.bytes, 160 * MIB as u64 + 2, "the index still knows every size");
    assert!(mirror::is_resident("best.txt"));
    assert!(!mirror::is_resident("slots/3.sav"));

    let web = Saves::for_destination(Destination::Web, &|_| None, NO_GAME);
    assert_eq!(web.load("best.txt").as_deref(), Some(&b"42"[..]), "small files load synchronously");
    assert_eq!(web.load("slots/3.sav"), None, "a lazy body is not there yet");
    assert!(mirror::request("slots/4.sav"));
    assert!(!mirror::request("best.txt"), "a resident file needs no request");
    assert!(!mirror::request("slots/absent.sav"), "an unknown file is never requested");
    assert_eq!(mirror::take_requests(), ["slots/3.sav", "slots/4.sav"]);
    assert!(mirror::take_requests().is_empty(), "a request is taken once");

    assert!(mirror::provide("slots/3.sav", vec![9; 8]));
    assert!(!mirror::provide("slots/absent.sav", vec![1]), "the page cannot plant a file");
    assert!(!mirror::provide("best.txt", vec![1]), "nor replace a resident one");
    assert!(!mirror::provide("slots/5.sav", vec![0; MAX_SAVE_BYTES + 1]), "nor a body past the cap");
    assert_eq!(web.load("slots/3.sav"), Some(vec![9; 8]));
    let status = mirror::status();
    assert_eq!((status.lazy, status.pending), (9, 0), "a provided body is stored already");
    assert_eq!(status.bytes, 144 * MIB as u64 + 8 + 2);
}

#[test]
fn the_web_mirror_takes_an_index_and_lists_removes_and_counts_like_files() {
    mirror::preload(vec![("best.txt".to_owned(), b"7".to_vec())]);
    mirror::preload_index(vec![("slots/a.sav".to_owned(), 300), ("best.txt".to_owned(), 99), ("../x.sav".to_owned(), 1)]);
    let web = Saves::for_destination(Destination::Web, &|_| None, NO_GAME);
    assert!(mirror::is_resident("best.txt"), "an index entry never hides a resident file");
    assert_eq!(web.list("slots"), ["slots/a.sav"]);
    assert_eq!(web.list(""), ["best.txt"]);
    assert_eq!(web.bytes_used(), 301);
    assert_eq!(mirror::status().lazy, 1);

    web.save_checked("slots/b.sav", b"xy").expect("saved");
    assert!(mirror::is_resident("slots/b.sav"), "a body saved here is resident");
    assert!(web.remove("slots/a.sav"));
    assert!(!web.remove("slots/a.sav"));
    assert_eq!(web.list("slots"), ["slots/b.sav"]);
    assert_eq!(mirror::take_removed(), ["slots/a.sav"], "the shell deletes it from IndexedDB");
    assert!(mirror::take_removed().is_empty());
    let full = MAX_SAVE_BYTES as u64;
    let index = (0..4).map(|slot| (format!("slots/full-{slot}.sav"), if slot == 0 { full - 3 } else { full })).collect();
    mirror::preload_index(index);
    assert_eq!(web.bytes_used(), MAX_TOTAL_SAVE_BYTES);
    assert_eq!(web.save_checked("c.bin", b"x"), Err(SaveWriteError::Quota));
    assert_eq!(web.load("c.bin"), None);
}
