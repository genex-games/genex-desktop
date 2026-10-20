//! Where crash records go. A [`CrashSink`] takes a finished record and its JSON; it must not block
//! and must not panic. [`FnSink`] wraps a closure (the studio's fd 3, the web shell, a phone's
//! records). [`FileSink`] writes `<save root>/genex-crash/<n>.json` for exports, where no host is
//! listening.
//!
//! The file sink keeps genex-core's save rules: it writes only under the game's own save root, a
//! symlink at the root or as the crash folder refuses with nothing written, a file is created new
//! (`O_EXCL`, which never follows a symlink) so a planted name is skipped for the next index, and
//! at most [`CRASH_FILES_KEPT`] records stay, the oldest removed first (regular files only). The
//! folder is reserved in genex-core (`saves::CRASH_RECORDS_DIR`): a game cannot save, load, list
//! or remove in it, and its records count toward the game's save quota.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use genex_core::saves::{CRASH_RECORDS_DIR, Saves};

use crate::caps::{CRASH_FILES_KEPT, CRASH_RECORD_MAX_BYTES};
use crate::record::CrashRecord;

/// The crash folder under the save root (genex-core reserves it).
pub const CRASH_DIR: &str = CRASH_RECORDS_DIR;
/// A record file's extension.
const RECORD_SUFFIX: &str = ".json";
/// The longest index a record file name carries (a u32 in decimal).
const INDEX_DIGITS_MAX: usize = 10;
/// How many names one write tries when planted entries already hold the next ones.
const NAME_ATTEMPTS_MAX: u32 = 64;

/// Somewhere a record goes. A sink must not block and must not panic.
pub trait CrashSink: Send + Sync {
    /// Take `record`, already written as `json` (at most 64 KiB).
    fn deliver(&self, record: &CrashRecord, json: &[u8]);
}

/// A closure sink: the studio's fd 3, the web shell, a phone's records.
pub struct FnSink<F: Fn(&CrashRecord, &[u8]) + Send + Sync>(pub F);

impl<F: Fn(&CrashRecord, &[u8]) + Send + Sync> CrashSink for FnSink<F> {
    fn deliver(&self, record: &CrashRecord, json: &[u8]) {
        (self.0)(record, json);
    }
}

/// Why the file sink wrote nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum FileSinkError {
    /// The game has no save root (or saves to the web's in-memory mirror, which has no files).
    #[error("there is no save root to write crash records under")]
    NoRoot,
    /// The root or the crash folder is a symlink, or the folder is not a folder.
    #[error("the crash folder is unsafe")]
    Unsafe,
    /// The record is over 64 KiB.
    #[error("a crash record takes at most 64 KiB")]
    TooLarge,
    /// The file system refused the write.
    #[error("the crash record could not be written")]
    Io,
}

/// `<save root>/genex-crash/<n>.json`, at most [`CRASH_FILES_KEPT`] of them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileSink {
    root: Option<PathBuf>,
}

impl FileSink {
    /// The sink for `saves`' root; one that refuses every write when there is no root or the saves
    /// live in the web's mirror.
    pub fn new(saves: &Saves) -> FileSink {
        // Rebuilt from its components: a root ending in its separator (as save roots do) would make
        // `lstat` follow a symlinked root, so the symlink refusal below could not see it.
        let root = saves
            .root()
            .filter(|root| !root.is_empty() && !saves.is_mirrored())
            .map(|root| Path::new(root).components().collect::<PathBuf>());
        FileSink { root }
    }

    /// The crash folder, when there is a root.
    pub fn dir(&self) -> Option<PathBuf> {
        self.root.as_ref().map(|root| root.join(CRASH_DIR))
    }

    /// Write `json` as the next record and prune the oldest past [`CRASH_FILES_KEPT`]; the
    /// written file's path, or why nothing was written.
    pub fn write(&self, json: &[u8]) -> Result<PathBuf, FileSinkError> {
        let root = self.root.as_deref().ok_or(FileSinkError::NoRoot)?;
        if json.len() > CRASH_RECORD_MAX_BYTES {
            return Err(FileSinkError::TooLarge);
        }
        let dir = crash_folder(root)?;
        let mut index = next_index(&dir);
        for _ in 0..NAME_ATTEMPTS_MAX {
            let path = dir.join(record_name(index));
            match create_new(&path, json) {
                Ok(()) => {
                    prune(&dir);
                    return Ok(path);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => index = index.saturating_add(1),
                Err(_) => return Err(FileSinkError::Io),
            }
        }
        Err(FileSinkError::Io)
    }

    /// The records kept, oldest first.
    pub fn records(&self) -> Vec<PathBuf> {
        let Some(dir) = self.dir().filter(|dir| is_plain_dir(dir)) else { return Vec::new() };
        record_files(&dir).into_iter().map(|(_, path)| path).collect()
    }
}

impl CrashSink for FileSink {
    fn deliver(&self, _record: &CrashRecord, json: &[u8]) {
        let _ = self.write(json);
    }
}

fn is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

fn is_plain_dir(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|meta| meta.is_dir())
}

/// `root/genex-crash`, made when absent; refused when the root or the folder is a symlink, the
/// root is missing, or the folder is something else.
fn crash_folder(root: &Path) -> Result<PathBuf, FileSinkError> {
    if is_symlink(root) {
        return Err(FileSinkError::Unsafe);
    }
    if !is_plain_dir(root) {
        return Err(FileSinkError::NoRoot);
    }
    let dir = root.join(CRASH_DIR);
    match fs::symlink_metadata(&dir) {
        Ok(meta) if meta.is_dir() => Ok(dir),
        Ok(_) => Err(FileSinkError::Unsafe),
        Err(_) => match fs::create_dir(&dir) {
            Ok(()) => Ok(dir),
            Err(_) if is_plain_dir(&dir) => Ok(dir),
            Err(_) => Err(FileSinkError::Io),
        },
    }
}

fn record_name(index: u32) -> String {
    format!("{index}{RECORD_SUFFIX}")
}

/// The index in a record file name (`<digits>.json`), or None.
fn index_of(name: &str) -> Option<u32> {
    let digits = name.strip_suffix(RECORD_SUFFIX)?;
    let plain = !digits.is_empty() && digits.len() <= INDEX_DIGITS_MAX && digits.bytes().all(|b| b.is_ascii_digit());
    if plain { digits.parse().ok() } else { None }
}

/// The regular record files in `dir`, oldest (lowest index) first; symlinks and other entries
/// are left out.
fn record_files(dir: &Path) -> Vec<(u32, PathBuf)> {
    let Ok(entries) = fs::read_dir(dir) else { return Vec::new() };
    let mut files: Vec<(u32, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter_map(|entry| Some((index_of(entry.file_name().to_str()?)?, entry.path())))
        .collect();
    files.sort();
    files
}

/// One past the highest index of a regular record file (0 for an empty folder).
fn next_index(dir: &Path) -> u32 {
    record_files(dir).last().map_or(0, |(index, _)| index.saturating_add(1))
}

/// Write `bytes` into a file that must not exist yet (never following a symlink).
fn create_new(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    let written = file.write_all(bytes).and_then(|()| file.sync_all());
    if written.is_err() {
        let _ = fs::remove_file(path);
    }
    written
}

/// Remove the oldest regular record files past [`CRASH_FILES_KEPT`].
fn prune(dir: &Path) {
    let files = record_files(dir);
    let excess = files.len().saturating_sub(CRASH_FILES_KEPT);
    for (_, path) in files.into_iter().take(excess) {
        let regular = fs::symlink_metadata(&path).is_ok_and(|meta| meta.file_type().is_file());
        if regular {
            let _ = fs::remove_file(&path);
        }
    }
}
