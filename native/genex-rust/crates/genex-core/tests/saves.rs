//! Saves: `studio::save`/`studio::load` (`studio.cpp:982-990` over `platform.cpp:393-419`) as
//! genex-core's synchronous [`Saves`]: a file under the destination's save root, named by a safe
//! relative path, created with its folders; read back whole or not at all. A hostile name or a
//! missing root writes nothing. The mobile roots join the save-root table here: iOS keeps saves
//! in the app container's `Library/Application Support/`, Android in the activity's internal data
//! path (which its shell answers through the injected environment).

use std::fs;
use std::path::{Path, PathBuf};

use genex_core::paths::{ANDROID_DATA_KEY, Destination, GameIdentity, SaveRefusal, destination_of, save_root};
use genex_core::saves::{MAX_SAVE_BYTES, Saves};

/// A fresh folder under the system temp dir, removed when dropped.
struct Scratch(PathBuf);

impl Scratch {
    fn new(name: &str) -> Scratch {
        let mut path = std::env::temp_dir();
        path.push(format!("genex-core-saves-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&path);
        fs::create_dir_all(&path).expect("a scratch folder");
        Scratch(path.canonicalize().expect("canonical scratch"))
    }

    fn root(&self) -> String {
        format!("{}/", self.0.display())
    }

    /// Every file under the scratch folder, relative, sorted.
    fn files(&self) -> Vec<String> {
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

fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            walk(base, &path, out);
        } else if let Ok(rel) = path.strip_prefix(base) {
            out.push(rel.display().to_string());
        }
    }
}

const NO_GAME: GameIdentity<'static> = GameIdentity { name: "", bundle_id: "" };

#[test]
fn a_save_is_read_back_whole_and_nested_names_get_their_folders() {
    let scratch = Scratch::new("roundtrip");
    let saves = Saves::at(Ok(scratch.root()));
    assert!(saves.save("best.txt", b"42"));
    assert!(saves.save("slots/1.sav", &[0, 1, 2, 255]));
    assert_eq!(saves.load("best.txt").as_deref(), Some(&b"42"[..]));
    assert_eq!(saves.load("slots/1.sav").as_deref(), Some(&[0u8, 1, 2, 255][..]));
    assert!(saves.save("best.txt", b""), "an empty save is a save");
    assert_eq!(saves.load("best.txt").as_deref(), Some(&b""[..]));
    assert_eq!(saves.load("absent.txt"), None, "a file never saved loads as nothing");
    assert_eq!(saves.load("slots"), None, "a folder is not a save");
    assert_eq!(scratch.files(), ["best.txt", "slots/1.sav"]);
}

#[test]
fn hostile_names_are_refused_and_write_nothing() {
    let scratch = Scratch::new("hostile");
    let saves = Saves::at(Ok(scratch.root()));
    let hostile = [
        "",
        "../escape.txt",
        "a/../../escape.txt",
        "/etc/passwd",
        "C:\\saves\\x",
        "a\\b",
        "con.txt",
        "slot.",
        "slot ",
        "./x",
        "a//b",
        "nul\0byte",
        "semi;colon",
    ];
    for name in hostile {
        assert!(!saves.save(name, b"x"), "{name:?} is refused");
        assert_eq!(saves.load(name), None, "{name:?} loads nothing");
    }
    assert!(scratch.files().is_empty(), "nothing was written: {:?}", scratch.files());
}

#[cfg(unix)]
#[test]
fn a_symlink_inside_the_save_root_is_never_followed_out_of_it() {
    let scratch = Scratch::new("symlink");
    let outside = Scratch::new("symlink-outside");
    std::os::unix::fs::symlink(&outside.0, scratch.0.join("link")).expect("a symlink");
    fs::write(outside.0.join("secret.txt"), b"secret").expect("a file outside");
    let saves = Saves::at(Ok(scratch.root()));
    assert!(!saves.save("link/planted.txt", b"x"), "a save through a symlinked folder is refused");
    assert_eq!(saves.load("link/secret.txt"), None, "a load through a symlinked folder reads nothing");
    assert_eq!(outside.files(), ["secret.txt"], "nothing was written outside the save root");
}

#[test]
fn without_a_save_root_nothing_is_saved_or_loaded() {
    let saves = Saves::at(Err(SaveRefusal::NoStateDir));
    assert!(!saves.save("best.txt", b"42"));
    assert_eq!(saves.load("best.txt"), None);
    assert_eq!(saves.refusal(), Some(SaveRefusal::NoStateDir));
}

#[test]
fn a_save_past_the_cap_is_refused_before_anything_is_written() {
    let scratch = Scratch::new("cap");
    let saves = Saves::at(Ok(scratch.root()));
    let big = vec![7u8; MAX_SAVE_BYTES + 1];
    assert!(!saves.save("big.bin", &big));
    assert!(scratch.files().is_empty());
}

#[test]
fn a_genex_run_saves_in_its_own_state_folder() {
    let scratch = Scratch::new("run");
    let state = scratch.0.display().to_string();
    let env = |name: &str| (name == "GENEX_STATE_DIR").then(|| state.clone());
    let saves = Saves::for_destination(Destination::GenexRun, &env, NO_GAME);
    assert!(saves.save("progress.json", b"{}"));
    assert_eq!(scratch.files(), ["progress.json"]);
}

#[test]
fn the_mobile_roots_join_the_table() {
    let home = |name: &str| (name == "HOME").then(|| "/var/mobile/Containers/Data/Application/ABC".to_owned());
    assert_eq!(
        save_root(Destination::Ios, &home, NO_GAME).as_deref(),
        Ok("/var/mobile/Containers/Data/Application/ABC/Library/Application Support/"),
        "iOS saves in the app container, which is the app's own: no name is needed"
    );
    let relative = |name: &str| (name == "HOME").then(|| "Containers/x".to_owned());
    assert_eq!(save_root(Destination::Ios, &relative, NO_GAME), Err(SaveRefusal::NoHome));
    let data = |name: &str| (name == ANDROID_DATA_KEY).then(|| "/data/user/0/games.genex.pond/files".to_owned());
    assert_eq!(save_root(Destination::Android, &data, NO_GAME).as_deref(), Ok("/data/user/0/games.genex.pond/files/"));
    for hostile in ["", "files", "/data/../etc", "/data/x\0y"] {
        let env = |name: &str| (name == ANDROID_DATA_KEY).then(|| hostile.to_owned());
        assert_eq!(save_root(Destination::Android, &env, NO_GAME), Err(SaveRefusal::NoDataDir), "{hostile:?}");
    }
}

#[test]
fn a_studio_descriptor_makes_any_build_a_genex_run() {
    let studio = |name: &str| (name == "GENEX_STUDIO_FD").then(|| "3".to_owned());
    assert_eq!(destination_of(&studio), Destination::GenexRun);
    let none = |_: &str| None;
    let expected = if cfg!(target_os = "ios") {
        Destination::Ios
    } else if cfg!(target_os = "android") {
        Destination::Android
    } else if cfg!(target_os = "macos") {
        Destination::Mac
    } else if cfg!(windows) {
        Destination::Windows
    } else if cfg!(target_family = "wasm") {
        Destination::Web
    } else {
        Destination::Linux
    };
    assert_eq!(destination_of(&none), expected);
}
