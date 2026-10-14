//! Saves: `studio::save` and `studio::load` (`studio.h:107-110`, over `platform.cpp:393-419`),
//! synchronous. A save is a file under the destination's save root ([`paths::save_root`]), named
//! by a path [`paths::is_safe_asset_path`] accepts; its folders are made on the way. A load reads
//! the whole file or nothing. A hostile name, a missing root, a file past [`MAX_SAVE_BYTES`] or a
//! symlink anywhere below the root refuses before anything is opened or written: a game never
//! saves outside its own folder.
//!
//! The iOS and Android shells hand their own roots in through [`Saves::at`]. A browser has no
//! files: the web destination's saves go to [`mirror`], an in-memory copy the web shell fills from
//! IndexedDB before the first reset and drains, write-behind, into IndexedDB (M2.9).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::paths::{self, Destination, GameIdentity, SaveRefusal};

/// The most bytes one save may hold (16 MiB): a save is a game's progress, never its assets.
pub const MAX_SAVE_BYTES: usize = 16 * 1024 * 1024;

/// A game's save folder: where `save` and `load` go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Saves {
    root: Result<String, SaveRefusal>,
    /// The web destination's saves, kept in [`mirror`] instead of files.
    mirrored: bool,
}

impl Saves {
    /// The saves under `root` (a save root ending in its separator, as [`paths::save_root`]
    /// answers), or none for a refusal.
    pub fn at(root: Result<String, SaveRefusal>) -> Saves {
        Saves { root, mirrored: false }
    }

    /// The saves of `game` on `destination`, its root read from the injected environment.
    pub fn for_destination(
        destination: Destination,
        env: &dyn Fn(&str) -> Option<String>,
        game: GameIdentity<'_>,
    ) -> Saves {
        let mirrored = destination == Destination::Web;
        Saves { root: paths::save_root(destination, env, game), mirrored }
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
    /// nothing written, for an unsafe name, no root, too many bytes or a symlink on the way.
    pub fn save(&self, file: &str, bytes: &[u8]) -> bool {
        if bytes.len() > MAX_SAVE_BYTES {
            return false;
        }
        let Some((root, parts)) = self.split(file) else { return false };
        if self.mirrored {
            return mirror::put(file, bytes);
        }
        let Some((name, folders)) = parts.split_last() else { return false };
        let mut at = root;
        for folder in folders {
            at.push(folder);
            if !plain_folder(&at) {
                return false;
            }
        }
        at.push(name);
        if is_symlink(&at) {
            return false;
        }
        write_file(&at, bytes)
    }

    /// The bytes saved as `file`, or None (never saved, an unsafe name, no root, a file past
    /// [`MAX_SAVE_BYTES`], a folder, a symlink on the way).
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

    /// The root as a path and `file`'s segments, when both are usable.
    fn split<'a>(&self, file: &'a str) -> Option<(PathBuf, Vec<&'a str>)> {
        let root = self.root.as_deref().ok()?;
        if root.is_empty() || !paths::is_safe_asset_path(file) {
            return None;
        }
        Some((PathBuf::from(root), file.split('/').collect()))
    }
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

/// Write the whole file through a sibling and rename it into place, so a crash mid-save leaves
/// the older save, never half of one.
fn write_file(path: &Path, bytes: &[u8]) -> bool {
    let Some(name) = path.file_name() else { return false };
    let mut partial = name.to_os_string();
    partial.push(".partial");
    let staging = path.with_file_name(partial);
    let written = fs::File::create(&staging).and_then(|mut file| file.write_all(bytes).and_then(|()| file.sync_all()));
    if written.is_err() || fs::rename(&staging, path).is_err() {
        let _ = fs::remove_file(&staging);
        return false;
    }
    true
}

/// The web destination's saves (M2.9): an in-memory copy of the game's IndexedDB store, so a
/// game's `save` and `load` stay synchronous in a browser. The web shell fills it with
/// [`mirror::preload`] before the first reset, drains the files saved since with
/// [`mirror::take_dirty`] when the page is idle or hidden, writes them to IndexedDB and answers
/// [`mirror::flushed`]. A write the browser refused stays dirty for the next flush and leaves its
/// typed code in [`mirror::status`], which the shell reports as `state().error` (`save-quota`) and
/// on the page. One mirror per thread: a browser runs the game on one.
pub mod mirror {
    use std::cell::RefCell;
    use std::collections::{BTreeMap, BTreeSet};

    use super::MAX_SAVE_BYTES;
    use crate::paths;

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
        /// Saved files.
        pub files: usize,
        /// Files saved since they were last taken for a flush.
        pub pending: usize,
        /// Files taken by a flush that has not answered yet.
        pub in_flight: usize,
        /// Why the last flush failed; None once one succeeds.
        pub error: Option<MirrorError>,
    }

    #[derive(Default)]
    struct Store {
        files: BTreeMap<String, Vec<u8>>,
        dirty: BTreeSet<String>,
        in_flight: BTreeSet<String>,
        error: Option<MirrorError>,
    }

    thread_local! {
        static STORE: RefCell<Store> = RefCell::new(Store::default());
    }

    fn fits(name: &str, bytes: &[u8]) -> bool {
        bytes.len() <= MAX_SAVE_BYTES && paths::is_safe_asset_path(name)
    }

    /// Replace the mirror with what the store held (entries with an unsafe name or past
    /// [`MAX_SAVE_BYTES`] are skipped, since they come from the page); nothing is dirty and no
    /// error is left.
    pub fn preload(entries: Vec<(String, Vec<u8>)>) {
        let files = entries.into_iter().filter(|(name, bytes)| fits(name, bytes)).collect();
        STORE.with_borrow_mut(|store| *store = Store { files, ..Store::default() });
    }

    /// Keep `bytes` as `name` and mark it dirty; false, with nothing kept, for an unsafe name or
    /// too many bytes.
    pub(crate) fn put(name: &str, bytes: &[u8]) -> bool {
        if !fits(name, bytes) {
            return false;
        }
        STORE.with_borrow_mut(|store| {
            store.files.insert(name.to_owned(), bytes.to_vec());
            store.dirty.insert(name.to_owned());
        });
        true
    }

    /// The bytes kept as `name`.
    pub(crate) fn get(name: &str) -> Option<Vec<u8>> {
        STORE.with_borrow(|store| store.files.get(name).cloned())
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
            files: store.files.len(),
            pending: store.dirty.len(),
            in_flight: store.in_flight.len(),
            error: store.error,
        })
    }
}
