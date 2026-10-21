//! Crash records on phones (game systems CRASH-4). The game's panics go through genex-crash's hook
//! into a [`Records`] sink: one `genex-crash/1` record per crash under
//! `<root>/genex-self-test/crash-<n>.json`, beside the self-test records the person pulls. The
//! platform's own reports of the last run (iOS MetricKit's crash diagnostics, Android's exit
//! reasons and tombstones) are read at the next launch and written the same way, so a native
//! fault or a low-memory kill the hook never saw still leaves a record. Nothing is sent anywhere.
//!
//! A records root or folder that is a symlink refuses with nothing written; a record file is
//! created new (it never follows a planted name), and the oldest go past
//! [`genex_crash::CRASH_FILES_KEPT`].

use std::io::Write as _;
use std::path::{Path, PathBuf};

pub use genex_crash::{CrashFrame, CrashImage, CrashKind, CrashRecord, CrashSource, RecordContext};

use super::records::{CRASH_FILE_PREFIX, CRASH_FILE_SUFFIX, Records};

/// How many names one write tries when planted entries hold the next ones.
const NAME_ATTEMPTS_MAX: u32 = 64;

/// Why a crash record was not written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CrashRecordsError {
    /// The records root or `genex-self-test` is a symlink, or the folder is not a folder.
    Unsafe,
    /// The record is over genex-crash's 64 KiB.
    TooLarge,
    /// The file system refused the write.
    Io,
}

fn is_symlink(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|meta| meta.file_type().is_symlink())
}

/// The record index a file name carries (`crash-<n>.json`), if it is one.
fn crash_index(name: &str) -> Option<u32> {
    let digits = name.strip_prefix(CRASH_FILE_PREFIX)?.strip_suffix(CRASH_FILE_SUFFIX)?;
    let plain = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
    if plain { digits.parse().ok() } else { None }
}

impl Records {
    /// The records folder, made when absent; refused when its root or itself is a symlink or it
    /// is not a folder.
    fn crash_dir(&self) -> Result<&Path, CrashRecordsError> {
        let dir = self.dir();
        if dir.parent().is_some_and(is_symlink) || is_symlink(dir) {
            return Err(CrashRecordsError::Unsafe);
        }
        match std::fs::symlink_metadata(dir) {
            Ok(meta) if meta.is_dir() => Ok(dir),
            Ok(_) => Err(CrashRecordsError::Unsafe),
            Err(_) => std::fs::create_dir_all(dir).map(|()| dir).map_err(|_| CrashRecordsError::Io),
        }
    }

    /// The crash records, oldest (lowest index) first; symlinks and other entries are not records.
    pub fn crash_records(&self) -> Vec<PathBuf> {
        let Ok(entries) = std::fs::read_dir(self.dir()) else { return Vec::new() };
        let mut found: Vec<(u32, PathBuf)> = entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .filter_map(|entry| crash_index(&entry.file_name().to_string_lossy()).map(|index| (index, entry.path())))
            .collect();
        found.sort();
        found.into_iter().map(|(_, path)| path).collect()
    }

    /// Write one crash record (`json`, as genex-crash wrote it) as the next `crash-<n>.json`, and
    /// drop the oldest past [`genex_crash::CRASH_FILES_KEPT`]; answers its path.
    pub fn write_crash(&self, json: &[u8]) -> Result<PathBuf, CrashRecordsError> {
        if json.len() > genex_crash::CRASH_RECORD_MAX_BYTES {
            return Err(CrashRecordsError::TooLarge);
        }
        let dir = self.crash_dir()?;
        let existing = self.crash_records();
        let next = existing.last().and_then(|path| crash_index(&path.file_name()?.to_string_lossy())).map_or(0, |index| index.saturating_add(1));
        let path = (0..NAME_ATTEMPTS_MAX)
            .find_map(|step| {
                let path = dir.join(format!("{CRASH_FILE_PREFIX}{}{CRASH_FILE_SUFFIX}", next.saturating_add(step)));
                let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path).ok()?;
                file.write_all(json).ok().map(|()| path)
            })
            .ok_or(CrashRecordsError::Io)?;
        let records = self.crash_records();
        let over = records.len().saturating_sub(genex_crash::CRASH_FILES_KEPT);
        for old in &records[..over] {
            let _ = std::fs::remove_file(old);
        }
        Ok(path)
    }

    /// Write a record the platform's reader made (a next-launch native fault or low-memory kill).
    pub fn write_platform_crash(&self, record: &CrashRecord) -> Result<PathBuf, CrashRecordsError> {
        self.write_crash(&record.to_json())
    }

    /// The text of marker `name` under the records folder (what a platform reader already
    /// recorded), at most [`MARKER_MAX_BYTES`]; `None` when absent, larger, or a symlink.
    pub fn read_marker(&self, name: &str) -> Option<String> {
        let path = self.dir().join(name);
        let meta = std::fs::symlink_metadata(&path).ok()?;
        let plain = meta.is_file() && meta.len() <= MARKER_MAX_BYTES as u64;
        if plain { std::fs::read_to_string(path).ok() } else { None }
    }

    /// Replace marker `name` with `text` through a temporary file; refused as a crash record is
    /// when the folder is unsafe, and when the marker or its temporary name is a symlink (never
    /// followed).
    pub fn write_marker(&self, name: &str, text: &str) -> Result<(), CrashRecordsError> {
        if text.len() > MARKER_MAX_BYTES {
            return Err(CrashRecordsError::TooLarge);
        }
        let dir = self.crash_dir()?;
        let (path, partial) = (dir.join(name), dir.join(format!("{name}.partial")));
        if is_symlink(&path) || is_symlink(&partial) {
            return Err(CrashRecordsError::Unsafe);
        }
        std::fs::write(&partial, text).and_then(|()| std::fs::rename(&partial, &path)).map_err(|_| CrashRecordsError::Io)
    }
}

/// The largest marker file read or written (a few dozen digests).
pub const MARKER_MAX_BYTES: usize = 4 * 1024;

/// Install genex-crash's panic hook with a sink into `records`: every panic of the game leaves one
/// `crash-<n>.json` (best effort: a refused folder is logged, never a second panic).
pub fn install(records: Records) -> genex_crash::Installed {
    let sink = genex_crash::FnSink(move |_record: &CrashRecord, json: &[u8]| {
        if let Err(error) = records.write_crash(json) {
            log::warn!("crash record not written: {error:?}");
        }
    });
    genex_crash::install(vec![Box::new(sink)])
}

/// The image a frame of a platform record points into: its index in `images`, added when new
/// (keyed by its id, then its name).
pub fn image_index(images: &mut Vec<CrashImage>, name: &str, id: &str) -> u64 {
    let at = images.iter().position(|image| image.id == id && image.name == name).unwrap_or_else(|| {
        images.push(CrashImage { name: name.to_owned(), id: id.to_owned() });
        images.len() - 1
    });
    at as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_plain_crash_names_carry_an_index() {
        assert_eq!(crash_index("crash-0.json"), Some(0));
        assert_eq!(crash_index("crash-17.json"), Some(17));
        for name in ["crash-.json", "crash-1.json.partial", "crash--1.json", "crash-1a.json", "lifecycle.ndjson", "crash-99999999999.json"] {
            assert_eq!(crash_index(name), None, "{name}");
        }
    }
}
