//! Saves: `studio::save` and `studio::load` (`studio.h:107-110`, over `platform.cpp:393-419`),
//! synchronous. A save is a file under the destination's save root ([`paths::save_root`]), named
//! by a path [`paths::is_safe_asset_path`] accepts; its folders are made on the way. A load reads
//! the whole file or nothing. A hostile name, a missing root, a file past [`MAX_SAVE_BYTES`] or a
//! symlink anywhere below the root refuses before anything is opened or written: a game never
//! saves outside its own folder.
//!
//! Under genex-save's slots the store also lists one folder ([`Saves::list`]), removes one file
//! ([`Saves::remove`]), counts what the game keeps ([`Saves::bytes_used`]) and holds every game to
//! [`MAX_TOTAL_SAVE_BYTES`]; [`Saves::save_checked`] names why a write was refused. Folders the
//! host keeps under the same root (a Genex run's `captures/` and the game process's `home/`, the
//! Android shell's records) are never listed, counted, written or removed by the game.
//!
//! The iOS and Android shells hand their own roots in through [`Saves::at`]. A browser has no
//! files: the web destination's saves go to [`mirror`], an in-memory copy the web shell fills from
//! IndexedDB before the first reset and drains, write-behind, into IndexedDB (M2.9).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::paths::{self, CAPTURES_DIR, Destination, GameIdentity, SaveRefusal};

/// The most bytes one save may hold (16 MiB): a save is a game's progress, never its assets.
pub const MAX_SAVE_BYTES: usize = 16 * 1024 * 1024;
/// The most bytes all of one game's saves may hold together (64 MiB, owner call U1), on every
/// destination.
pub const MAX_TOTAL_SAVE_BYTES: u64 = 64 * 1024 * 1024;
/// How deep [`Saves::bytes_used`] walks below the root; deeper files are not counted.
const WALK_DEPTH_MAX: usize = 32;
/// The suffix of the sibling a save is staged in before its rename.
const PARTIAL_SUFFIX: &str = ".partial";
/// The Android shell's records folder under the activity's data path, which is also the save
/// root (genex-platform-ios `records::RECORDS_DIR`).
const ANDROID_RECORDS_DIR: &str = "genex-self-test";
/// The game process's HOME inside a Genex run's state folder (the host's `RunDirLayout.Home`),
/// where the OS and its frameworks keep their own caches.
const RUN_HOME_DIR: &str = "home";

/// Why [`Saves::save_checked`] wrote nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum SaveWriteError {
    /// The name is not a safe relative path, names a host folder, or a symlink is on its way.
    #[error("the save name is unsafe, or a symlink is on its way")]
    Unsafe,
    /// The destination has no save root.
    #[error("there is no save root")]
    NoRoot,
    /// The bytes are past [`MAX_SAVE_BYTES`].
    #[error("one save holds at most 16 MiB")]
    TooLarge,
    /// The game's saves would pass [`MAX_TOTAL_SAVE_BYTES`].
    #[error("a game's saves hold at most 64 MiB together")]
    Quota,
    /// The file system refused the write.
    #[error("the save could not be written")]
    Io,
}

/// The top-level folders the host keeps under `destination`'s save root.
fn host_folders(destination: Destination) -> &'static [&'static str] {
    match destination {
        Destination::GenexRun => &[CAPTURES_DIR, RUN_HOME_DIR],
        Destination::Android => &[ANDROID_RECORDS_DIR],
        _ => &[],
    }
}

/// A game's save folder: where `save` and `load` go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saves {
    root: Result<String, SaveRefusal>,
    /// The web destination's saves, kept in [`mirror`] instead of files.
    mirrored: bool,
    /// Top-level folders under the root that are the host's, not the game's.
    host: &'static [&'static str],
}

impl Saves {
    /// The saves under `root` (a save root ending in its separator, as [`paths::save_root`]
    /// answers), or none for a refusal. Every file under it is the game's.
    pub fn at(root: Result<String, SaveRefusal>) -> Saves {
        Saves { root, mirrored: false, host: &[] }
    }

    /// The saves of `game` on `destination`, its root read from the injected environment.
    pub fn for_destination(
        destination: Destination,
        env: &dyn Fn(&str) -> Option<String>,
        game: GameIdentity<'_>,
    ) -> Saves {
        let mirrored = destination == Destination::Web;
        Saves { root: paths::save_root(destination, env, game), mirrored, host: host_folders(destination) }
    }

    /// The saves of this process: its destination from the environment (a Genex run when the
    /// studio started it), the game's identity from its `saveName` and the running bundle's id
    /// over the build's (`paths.cpp` `identityOf`).
    pub fn for_process(save_name: &str, running_bundle_id: &str, build: GameIdentity<'_>) -> Saves {
        let env = |name: &str| paths::process_env(name);
        let game = paths::identity_of(save_name, running_bundle_id, build);
        Saves::for_destination(paths::destination_of(&env), &env, game)
    }

    /// The save root, ending in its separator; None when there is none.
    pub fn root(&self) -> Option<&str> {
        self.root.as_deref().ok()
    }

    /// Why there is no save root, or None when there is one.
    pub fn refusal(&self) -> Option<SaveRefusal> {
        self.root.as_ref().err().copied()
    }

    /// Whether saves go to the web's in-memory [`mirror`] rather than files.
    pub fn is_mirrored(&self) -> bool {
        self.mirrored
    }

    /// Save `bytes` as `file` (folders made as needed, an older save replaced); false, with
    /// nothing written, whenever [`Saves::save_checked`] refuses.
    pub fn save(&self, file: &str, bytes: &[u8]) -> bool {
        self.save_checked(file, bytes).is_ok()
    }

    /// Save `bytes` as `file`, or say why nothing was written: no root, an unsafe name (a host
    /// folder, a symlink on the way or as the staging file), too many bytes, the game's total past
    /// [`MAX_TOTAL_SAVE_BYTES`] (a replaced file counts only the difference), or the file system.
    pub fn save_checked(&self, file: &str, bytes: &[u8]) -> Result<(), SaveWriteError> {
        let root = self.usable_root().ok_or(SaveWriteError::NoRoot)?;
        if !self.is_game_path(file) {
            return Err(SaveWriteError::Unsafe);
        }
        if bytes.len() > MAX_SAVE_BYTES {
            return Err(SaveWriteError::TooLarge);
        }
        let len = bytes.len() as u64;
        if self.mirrored {
            within_quota(mirror::bytes(), mirror::size_of(file), len)?;
            return if mirror::put(file, bytes) { Ok(()) } else { Err(SaveWriteError::Unsafe) };
        }
        let parts: Vec<&str> = file.split('/').collect();
        let existing = existing_size(Path::new(root), &parts)?;
        within_quota(self.bytes_used(), existing, len)?;
        let Some((name, folders)) = parts.split_last() else { return Err(SaveWriteError::Unsafe) };
        let mut at = PathBuf::from(root);
        for folder in folders {
            at.push(folder);
            if !plain_folder(&at) {
                return Err(SaveWriteError::Io);
            }
        }
        at.push(name);
        write_file(&at, bytes)
    }

    /// The bytes saved as `file`, or None (never saved, an unsafe name, no root, a file past
    /// [`MAX_SAVE_BYTES`], a folder, a symlink on the way). On the web a `.sav` body that is not
    /// resident yet answers None and is requested ([`mirror::request`]).
    pub fn load(&self, file: &str) -> Option<Vec<u8>> {
        let (mut at, parts) = self.split(file)?;
        if self.mirrored {
            return mirror::get(file);
        }
        for part in &parts {
            at.push(part);
            if is_symlink(&at) {
                return None;
            }
        }
        let meta = fs::metadata(&at).ok()?;
        let fits = meta.is_file() && usize::try_from(meta.len()).is_ok_and(|len| len <= MAX_SAVE_BYTES);
        if !fits {
            return None;
        }
        fs::read(&at).ok()
    }

    /// The game's files directly in `folder` ("" for the root), as save names (`slots/a.sav`),
    /// sorted. Sub-folders, staging files, symlinks, host folders and unsafe names are left out;
    /// a symlink on the way to `folder` lists nothing.
    pub fn list(&self, folder: &str) -> Vec<String> {
        let Some(root) = self.usable_root() else { return Vec::new() };
        if !folder.is_empty() && !self.is_game_path(folder) {
            return Vec::new();
        }
        if self.mirrored {
            return mirror::list(folder);
        }
        let parts: Vec<&str> = if folder.is_empty() { Vec::new() } else { folder.split('/').collect() };
        let Some(dir) = plain_path(Path::new(root), &parts) else { return Vec::new() };
        let Ok(entries) = fs::read_dir(&dir) else { return Vec::new() };
        let mut names: Vec<String> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| entry.file_name().into_string().ok())
            .filter(|name| !name.ends_with(PARTIAL_SUFFIX))
            .map(|name| if folder.is_empty() { name } else { format!("{folder}/{name}") })
            .filter(|name| paths::is_safe_asset_path(name))
            .collect();
        names.sort();
        names
    }

    /// Remove the saved file `file`; false, with nothing removed, for an unsafe or host name, no
    /// root, a symlink on the way or as the file, a folder, or a file that is not there.
    pub fn remove(&self, file: &str) -> bool {
        let Some(root) = self.usable_root() else { return false };
        if !self.is_game_path(file) {
            return false;
        }
        if self.mirrored {
            return mirror::remove(file);
        }
        let parts: Vec<&str> = file.split('/').collect();
        let Some(at) = plain_path(Path::new(root), &parts) else { return false };
        let is_file = fs::symlink_metadata(&at).is_ok_and(|meta| meta.file_type().is_file());
        is_file && fs::remove_file(&at).is_ok()
    }

    /// The bytes the game's saves hold now: every regular file under the root, host folders and
    /// symlinks left out (on the web, the mirror's index). 0 without a root.
    pub fn bytes_used(&self) -> u64 {
        let Some(root) = self.usable_root() else { return 0 };
        if self.mirrored {
            return mirror::bytes();
        }
        let root = Path::new(root);
        let Ok(entries) = fs::read_dir(root) else { return 0 };
        entries
            .flatten()
            .filter(|entry| entry.file_name().to_str().is_none_or(|name| !self.host.contains(&name)))
            .map(|entry| entry_bytes(&entry.path(), 1))
            .sum()
    }

    /// The root when it is usable (set and not empty).
    fn usable_root(&self) -> Option<&str> {
        self.root.as_deref().ok().filter(|root| !root.is_empty())
    }

    /// `file` is a safe relative path outside the host's folders.
    fn is_game_path(&self, file: &str) -> bool {
        let first = file.split('/').next().unwrap_or_default();
        paths::is_safe_asset_path(file) && !self.host.contains(&first)
    }

    /// The root as a path and `file`'s segments, when both are usable.
    fn split<'a>(&self, file: &'a str) -> Option<(PathBuf, Vec<&'a str>)> {
        let root = self.usable_root()?;
        if !paths::is_safe_asset_path(file) {
            return None;
        }
        Some((PathBuf::from(root), file.split('/').collect()))
    }
}

/// Ok when replacing `existing` bytes with `len` keeps a game at `used` within the quota.
fn within_quota(used: u64, existing: u64, len: u64) -> Result<(), SaveWriteError> {
    let total = used.saturating_sub(existing).saturating_add(len);
    if total > MAX_TOTAL_SAVE_BYTES { Err(SaveWriteError::Quota) } else { Ok(()) }
}

/// The size of the file at `root/parts` (0 when it is not there yet), refusing a symlink as any
/// segment or as the file's staging sibling, without making anything.
fn existing_size(root: &Path, parts: &[&str]) -> Result<u64, SaveWriteError> {
    let mut at = root.to_path_buf();
    for part in parts {
        at.push(part);
        match fs::symlink_metadata(&at) {
            Ok(meta) if meta.file_type().is_symlink() => return Err(SaveWriteError::Unsafe),
            Ok(_) => {}
            Err(_) => return Ok(0),
        }
    }
    if is_symlink(&staging_of(&at)) {
        return Err(SaveWriteError::Unsafe);
    }
    Ok(fs::symlink_metadata(&at).ok().filter(fs::Metadata::is_file).map_or(0, |meta| meta.len()))
}

/// `root/parts` when no segment on the way is a symlink and every folder exists.
fn plain_path(root: &Path, parts: &[&str]) -> Option<PathBuf> {
    let mut at = root.to_path_buf();
    if is_symlink(&at) {
        return None;
    }
    for part in parts {
        at.push(part);
        if is_symlink(&at) {
            return None;
        }
    }
    Some(at)
}

/// The bytes of a regular file, or of every regular file in a folder (symlinks and anything past
/// [`WALK_DEPTH_MAX`] count 0).
fn entry_bytes(path: &Path, depth: usize) -> u64 {
    let Ok(meta) = fs::symlink_metadata(path) else { return 0 };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() || depth >= WALK_DEPTH_MAX {
        return 0;
    }
    let Ok(entries) = fs::read_dir(path) else { return 0 };
    entries.flatten().map(|entry| entry_bytes(&entry.path(), depth + 1)).sum()
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// `path` is a real folder (made now when absent), never a symlink.
fn plain_folder(path: &Path) -> bool {
    match fs::symlink_metadata(path) {
        Ok(meta) => meta.is_dir(),
        Err(_) => fs::create_dir(path).is_ok() || fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir()),
    }
}

/// The sibling `path` is staged in.
fn staging_of(path: &Path) -> PathBuf {
    let mut partial = path.file_name().unwrap_or_default().to_os_string();
    partial.push(PARTIAL_SUFFIX);
    path.with_file_name(partial)
}

/// Write the whole file through a sibling and rename it into place, so a crash mid-save leaves
/// the older save, never half of one. The sibling is created new (`O_EXCL`, which never follows a
/// symlink): a symlink planted as the sibling refuses, and a leftover regular one is replaced.
fn write_file(path: &Path, bytes: &[u8]) -> Result<(), SaveWriteError> {
    if path.file_name().is_none() || is_symlink(path) {
        return Err(SaveWriteError::Unsafe);
    }
    let staging = staging_of(path);
    match fs::symlink_metadata(&staging) {
        Ok(meta) if meta.file_type().is_symlink() => return Err(SaveWriteError::Unsafe),
        Ok(meta) if meta.is_file() => fs::remove_file(&staging).map_err(|_| SaveWriteError::Io)?,
        Ok(_) => return Err(SaveWriteError::Io),
        Err(_) => {}
    }
    let written = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()));
    if written.is_err() || fs::rename(&staging, path).is_err() {
        if written.as_ref().is_err_and(|error| error.kind() == std::io::ErrorKind::AlreadyExists) {
            return Err(SaveWriteError::Unsafe);
        }
        let _ = fs::remove_file(&staging);
        return Err(SaveWriteError::Io);
    }
    Ok(())
}

/// The web destination's saves (M2.9): an in-memory copy of the game's IndexedDB store, so a
/// game's `save` and `load` stay synchronous in a browser. The web shell fills it with
/// [`mirror::preload`] before the first reset, drains the files saved since with
/// [`mirror::take_dirty`] (and the files removed with [`mirror::take_removed`]) when the page is
/// idle or hidden, writes them to IndexedDB and answers [`mirror::flushed`]. A write the browser
/// refused stays dirty for the next flush and leaves its typed code in [`mirror::status`], which
/// the shell reports as `state().error` (`save-quota`) and on the page. One mirror per thread: a
/// browser runs the game on one.
///
/// Slot bodies (`.sav` files) are lazy, so ten 16 MiB slots never sit in a phone tab's heap: the
/// mirror keeps their names and sizes ([`mirror::preload_index`]) and holds a body only once the
/// shell [`mirror::provide`]s it, after a load asked for it ([`mirror::take_requests`]). Every
/// other file is preloaded whole, so its load stays synchronous.
pub mod mirror {
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};

    use super::MAX_SAVE_BYTES;
    use crate::paths;

    /// The suffix of a file whose body the mirror keeps lazily: a genex-save slot body.
    pub const LAZY_SUFFIX: &str = ".sav";

    /// Why the browser's storage refused the mirror's writes.
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub enum MirrorError {
        /// The origin's quota is spent, or the browser evicted the store (`QuotaExceededError`).
        Quota,
        /// IndexedDB could not be opened or written for another reason (a private window, a
        /// blocked origin): saves last only as long as the page.
        Unavailable,
    }

    impl MirrorError {
        /// The wire code `state().error` carries.
        pub fn wire(self) -> &'static str {
            match self {
                MirrorError::Quota => "save-quota",
                MirrorError::Unavailable => "save-unavailable",
            }
        }

        /// The error for a wire code; None for any other.
        pub fn from_wire(code: &str) -> Option<MirrorError> {
            [MirrorError::Quota, MirrorError::Unavailable].into_iter().find(|error| error.wire() == code)
        }
    }

    /// What the mirror holds and owes.
    #[derive(Clone, Debug, Default, PartialEq, Eq)]
    pub struct MirrorStatus {
        /// Saved files, resident or lazy.
        pub files: usize,
        /// Files saved since they were last taken for a flush.
        pub pending: usize,
        /// Files taken by a flush that has not answered yet.
        pub in_flight: usize,
        /// Why the last flush failed; None once one succeeds.
        pub error: Option<MirrorError>,
        /// The bytes every saved file holds, lazy bodies by their indexed size.
        pub bytes: u64,
        /// Files known by name and size only: their body is not resident.
        pub lazy: usize,
    }

    #[derive(Default)]
    struct Store {
        files: BTreeMap<String, Vec<u8>>,
        /// Lazy bodies not resident yet, by name, with their size.
        lazy: BTreeMap<String, u64>,
        /// Lazy bodies a load asked for, not taken by the shell yet.
        requests: BTreeSet<String>,
        /// Lazy bodies the shell took a request for and has not provided yet.
        asked: BTreeSet<String>,
        dirty: BTreeSet<String>,
        in_flight: BTreeSet<String>,
        removed: BTreeSet<String>,
        error: Option<MirrorError>,
    }

    impl Store {
        /// Ask for the lazy body `name` unless the shell is already fetching it.
        fn ask(&mut self, name: &str) -> bool {
            if !self.lazy.contains_key(name) {
                return false;
            }
            if !self.asked.contains(name) {
                self.requests.insert(name.to_owned());
            }
            true
        }

        /// Forget any request for `name` (its body arrived, was saved anew or was removed).
        fn settle(&mut self, name: &str) {
            self.requests.remove(name);
            self.asked.remove(name);
        }
    }

    thread_local! {
        static STORE: RefCell<Store> = RefCell::new(Store::default());
    }

    fn fits(name: &str, bytes: &[u8]) -> bool {
        bytes.len() <= MAX_SAVE_BYTES && paths::is_safe_asset_path(name)
    }

    /// Whether the mirror keeps `name`'s body lazily.
    pub fn is_lazy_name(name: &str) -> bool {
        name.ends_with(LAZY_SUFFIX)
    }

    /// Replace the mirror with what the store held (entries with an unsafe name or past
    /// [`MAX_SAVE_BYTES`] are skipped, since they come from the page). A `.sav` entry keeps only
    /// its name and size; every other entry is resident. Nothing is dirty and no error is left.
    pub fn preload(entries: Vec<(String, Vec<u8>)>) {
        let mut store = Store::default();
        for (name, bytes) in entries.into_iter().filter(|(name, bytes)| fits(name, bytes)) {
            if is_lazy_name(&name) {
                store.lazy.insert(name, bytes.len() as u64);
            } else {
                store.files.insert(name, bytes);
            }
        }
        STORE.with_borrow_mut(|stored| *stored = store);
    }

    /// Add the store's `.sav` entries by name and size, without their bodies (after
    /// [`preload`]). Unsafe names, other files, sizes past [`MAX_SAVE_BYTES`] and names already
    /// resident are skipped.
    pub fn preload_index(index: Vec<(String, u64)>) {
        STORE.with_borrow_mut(|store| {
            for (name, size) in index {
                let usable = is_lazy_name(&name) && paths::is_safe_asset_path(&name) && size <= MAX_SAVE_BYTES as u64;
                if usable && !store.files.contains_key(&name) {
                    store.lazy.insert(name, size);
                }
            }
        });
    }

    /// Keep `bytes` as `name` (resident) and mark it dirty; false, with nothing kept, for an
    /// unsafe name or too many bytes.
    pub(crate) fn put(name: &str, bytes: &[u8]) -> bool {
        if !fits(name, bytes) {
            return false;
        }
        STORE.with_borrow_mut(|store| {
            store.files.insert(name.to_owned(), bytes.to_vec());
            store.lazy.remove(name);
            store.settle(name);
            store.removed.remove(name);
            store.dirty.insert(name.to_owned());
        });
        true
    }

    /// The bytes kept as `name`; a lazy body that is not resident answers None and is requested.
    pub(crate) fn get(name: &str) -> Option<Vec<u8>> {
        STORE.with_borrow_mut(|store| {
            let found = store.files.get(name).cloned();
            if found.is_none() {
                store.ask(name);
            }
            found
        })
    }

    /// Ask the shell for the lazy body `name`; false when it is resident or unknown.
    pub fn request(name: &str) -> bool {
        STORE.with_borrow_mut(|store| store.ask(name))
    }

    /// The lazy bodies asked for since the last take, sorted; each is asked once until it is
    /// provided.
    pub fn take_requests() -> Vec<String> {
        STORE.with_borrow_mut(|store| {
            let taken = std::mem::take(&mut store.requests);
            store.asked.extend(taken.iter().cloned());
            taken.into_iter().collect()
        })
    }

    /// The shell's body for the lazy file `name`, now resident (stored already, so not dirty);
    /// false, with nothing kept, for a name that is not lazy (unknown or resident) or a body past
    /// [`MAX_SAVE_BYTES`]: the page can neither plant nor replace a file.
    pub fn provide(name: &str, bytes: Vec<u8>) -> bool {
        if bytes.len() > MAX_SAVE_BYTES {
            return false;
        }
        STORE.with_borrow_mut(|store| {
            if store.lazy.remove(name).is_none() {
                return false;
            }
            store.settle(name);
            store.files.insert(name.to_owned(), bytes);
            true
        })
    }

    /// Whether `name`'s body is in the mirror now.
    pub fn is_resident(name: &str) -> bool {
        STORE.with_borrow(|store| store.files.contains_key(name))
    }

    /// Forget `name`, resident or lazy, and owe its removal to IndexedDB; false when it was not
    /// saved.
    pub(crate) fn remove(name: &str) -> bool {
        STORE.with_borrow_mut(|store| {
            let existed = store.files.remove(name).is_some() || store.lazy.remove(name).is_some();
            if existed {
                store.dirty.remove(name);
                store.settle(name);
                store.removed.insert(name.to_owned());
            }
            existed
        })
    }

    /// The files removed since the last take, sorted, for the shell to delete from IndexedDB.
    pub fn take_removed() -> Vec<String> {
        STORE.with_borrow_mut(|store| std::mem::take(&mut store.removed).into_iter().collect())
    }

    /// The saved files directly in `folder` ("" for the root), resident or lazy, sorted.
    pub(crate) fn list(folder: &str) -> Vec<String> {
        let in_folder = |name: &&String| match name.rsplit_once('/') {
            Some((parent, _)) => parent == folder,
            None => folder.is_empty(),
        };
        STORE.with_borrow(|store| {
            let names: BTreeSet<&String> = store.files.keys().chain(store.lazy.keys()).filter(in_folder).collect();
            names.into_iter().cloned().collect()
        })
    }

    /// The bytes every saved file holds, lazy bodies by their indexed size.
    pub(crate) fn bytes() -> u64 {
        STORE.with_borrow(store_bytes)
    }

    /// The bytes saved as `name` now (0 when it is not saved).
    pub(crate) fn size_of(name: &str) -> u64 {
        STORE.with_borrow(|store| store.files.get(name).map(|bytes| bytes.len() as u64).or_else(|| store.lazy.get(name).copied()).unwrap_or(0))
    }

    fn store_bytes(store: &Store) -> u64 {
        store.files.values().map(|bytes| bytes.len() as u64).chain(store.lazy.values().copied()).sum()
    }

    /// The files saved since the last take, with their current bytes; they are in flight until
    /// [`flushed`] answers.
    pub fn take_dirty() -> Vec<(String, Vec<u8>)> {
        STORE.with_borrow_mut(|store| {
            let names = std::mem::take(&mut store.dirty);
            let taken = names.iter().filter_map(|name| Some((name.clone(), store.files.get(name)?.clone()))).collect();
            store.in_flight.extend(names);
            taken
        })
    }

    /// The answer of the flush that took the in-flight files: Ok clears the error; an error marks
    /// the named files dirty again (a file saved anew since is dirty already) and is kept until a
    /// later flush succeeds.
    pub fn flushed(result: Result<(), (MirrorError, Vec<String>)>) {
        STORE.with_borrow_mut(|store| {
            store.in_flight.clear();
            match result {
                Ok(()) => store.error = None,
                Err((error, names)) => {
                    let kept: Vec<String> = names.into_iter().filter(|name| store.files.contains_key(name)).collect();
                    store.dirty.extend(kept);
                    store.error = Some(error);
                }
            }
        });
    }

    /// Record a storage failure outside a flush (IndexedDB could not be opened).
    pub fn fail(error: MirrorError) {
        STORE.with_borrow_mut(|store| store.error = Some(error));
    }

    /// What the mirror holds and owes now.
    pub fn status() -> MirrorStatus {
        STORE.with_borrow(|store| MirrorStatus {
            files: store.files.len() + store.lazy.len(),
            pending: store.dirty.len(),
            in_flight: store.in_flight.len(),
            error: store.error,
            bytes: store_bytes(store),
            lazy: store.lazy.len(),
        })
    }
}
