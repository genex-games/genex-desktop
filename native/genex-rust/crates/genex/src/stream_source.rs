//! Where streamed cells and groups come from: cell packs on disk, the web's ranges, the phones'
//! bundles, all behind one async source (game systems STR-13: the native one).
//!
//! An [`AsyncSource`] takes a request for bytes of an asset (a byte range, or the whole file) and
//! answers it later: the frame thread never waits on a read. [`AsyncSource::poll`] hands back what
//! finished since the last poll, in the order the reads finished, each with the
//! [`StreamRequest`] its request returned, so a caller reassembles by id. What a read returns is
//! view-side data: the streamed view set (STR-16) uploads it and the commit slot (STR-9) merges
//! cell content in cell order, so the order reads finish in never reaches a checksum.
//!
//! [`StreamFiles`] is the native one (macOS, Windows, Linux; the phones' in STR-15, the web's in
//! STR-14): the compiled table first, as a slice of the program's own bytes with no copy, then
//! files under `assets/` read on the job pool ([`genex_render::jobs::Pool`]). A file's path is
//! checked by the same code as the sim's reads and the presenter's ([`AssetFiles`]: the asset-path
//! rule, no link at the name or on the way to it, a regular file within
//! [`ASSET_READ_MAX_BYTES`]), and its range against the file's size, all before anything is
//! opened: a FIFO, a device or a range past the end is refused without opening it.

use std::ops::Range;
use std::sync::Arc;

use genex_render::jobs::Priority;

use crate::gfx::AssetError;

#[cfg(not(target_arch = "wasm32"))]
pub use files::StreamFiles;

/// Names one request to an [`AsyncSource`]; its answer carries it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct StreamRequest(u64);

impl StreamRequest {
    /// The id numbered `raw`: what a source outside this crate (the web's fetches, a test's)
    /// hands back from [`AsyncSource::request`], counting its own requests.
    pub fn from_raw(raw: u64) -> StreamRequest {
        StreamRequest(raw)
    }

    /// The number behind the id (requests count up from 0 per source).
    pub fn raw(self) -> u64 {
        self.0
    }
}

/// The bytes a request delivered: a slice of the compiled table (no copy), or a read's own.
#[derive(Clone, Debug)]
pub enum StreamBytes {
    /// Part of the asset table the program holds for its whole life.
    Static(&'static [u8]),
    /// Bytes read from a file.
    Read(Arc<[u8]>),
}

impl std::ops::Deref for StreamBytes {
    type Target = [u8];

    fn deref(&self) -> &[u8] {
        match self {
            StreamBytes::Static(bytes) => bytes,
            StreamBytes::Read(bytes) => bytes,
        }
    }
}

/// One answered request: its id, and its bytes or why not.
pub type StreamAnswer = (StreamRequest, Result<StreamBytes, AssetError>);

/// A source the frame thread asks for asset bytes without waiting: requests go out, answers come
/// back at a later [`AsyncSource::poll`].
pub trait AsyncSource {
    /// Ask for bytes `range` of `path` (None: the whole file) at `priority`, the job pool lane the
    /// read waits on.
    fn request(&mut self, path: &str, range: Option<Range<u64>>, priority: Priority) -> StreamRequest;

    /// Withdraw `request`: its answer never comes. False when it was already answered by a poll or
    /// never made.
    fn cancel(&mut self, request: StreamRequest) -> bool;

    /// The answers that came in since the last poll, in the order the reads finished.
    fn poll(&mut self) -> Vec<StreamAnswer>;

    /// Requests made and not yet answered by a poll.
    fn in_flight(&self) -> usize;
}

#[cfg(not(target_arch = "wasm32"))]
mod files {
    use std::collections::{BTreeMap, BTreeSet};
    use std::fs::File;
    use std::io::{ErrorKind, Read, Seek, SeekFrom};
    use std::ops::Range;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, MutexGuard, PoisonError};

    use genex_render::jobs::{Job, JobError, Pool, Priority};

    use super::{AsyncSource, StreamAnswer, StreamBytes, StreamRequest};
    use crate::gfx::{ASSET_READ_MAX_BYTES, AssetError, AssetErrorCode};
    use crate::present::ModelSource;
    use crate::present_files::AssetFiles;

    /// What a source shares with its reads: the answers they hand in and the files they opened.
    #[derive(Default)]
    struct Shared {
        answers: Mutex<Vec<StreamAnswer>>,
        opened: AtomicU64,
    }

    impl Shared {
        fn answers(&self) -> MutexGuard<'_, Vec<StreamAnswer>> {
            self.answers.lock().unwrap_or_else(PoisonError::into_inner)
        }
    }

    /// The native async source: the compiled table, then `assets/` read by range on the job pool
    /// (module doc). Every path goes through [`AssetFiles`]' check before anything is opened.
    pub struct StreamFiles {
        files: Arc<AssetFiles>,
        pool: &'static Pool,
        next: u64,
        /// Requests made and not yet answered by a poll or withdrawn.
        outstanding: usize,
        /// Reads not yet answered by a poll.
        pending: BTreeMap<StreamRequest, Job<()>>,
        /// Requests withdrawn while their read was running: their answers are dropped on arrival.
        withdrawn: BTreeSet<StreamRequest>,
        shared: Arc<Shared>,
    }

    impl std::fmt::Debug for StreamFiles {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.debug_struct("StreamFiles").field("in_flight", &self.in_flight()).field("opened", &self.opened()).finish()
        }
    }

    impl StreamFiles {
        /// Reads of `files` on the process job pool.
        pub fn new(files: AssetFiles) -> StreamFiles {
            StreamFiles::with_pool(files, Pool::global())
        }

        /// Reads of `files` on `pool`.
        pub fn with_pool(files: AssetFiles, pool: &'static Pool) -> StreamFiles {
            let shared = Arc::new(Shared::default());
            StreamFiles { files: Arc::new(files), pool, next: 0, outstanding: 0, pending: BTreeMap::new(), withdrawn: BTreeSet::new(), shared }
        }

        /// Files this source has opened so far (a refused request opens none).
        pub fn opened(&self) -> u64 {
            self.shared.opened.load(Ordering::Relaxed)
        }

        fn next_request(&mut self) -> StreamRequest {
            let request = StreamRequest(self.next);
            self.next += 1;
            self.outstanding += 1;
            request
        }
    }

    impl AsyncSource for StreamFiles {
        fn request(&mut self, path: &str, range: Option<Range<u64>>, priority: Priority) -> StreamRequest {
            let request = self.next_request();
            if let Some(bytes) = self.files.static_bytes(path) {
                let answer = checked_range(path, range, bytes.len() as u64).map(|range| StreamBytes::Static(slice_of(bytes, &range)));
                self.shared.answers().push((request, answer));
                return request;
            }
            let (files, shared, path) = (Arc::clone(&self.files), Arc::clone(&self.shared), path.to_owned());
            let job = self.pool.spawn(priority, move || {
                let answer = read_range(&files, &path, range, &shared.opened).map(StreamBytes::Read);
                shared.answers().push((request, answer));
            });
            self.pending.insert(request, job);
            request
        }

        fn cancel(&mut self, request: StreamRequest) -> bool {
            let mut answers = self.shared.answers();
            if let Some(at) = answers.iter().position(|(id, _)| *id == request) {
                drop(answers.remove(at));
                self.pending.remove(&request);
                self.outstanding -= 1;
                return true;
            }
            let Some(job) = self.pending.remove(&request) else { return false };
            // Still queued: it never runs. Running: its answer is dropped when it comes (the
            // answers lock is held, so it cannot have come in between).
            if !job.cancel() {
                self.withdrawn.insert(request);
            }
            self.outstanding -= 1;
            true
        }

        fn poll(&mut self) -> Vec<StreamAnswer> {
            let arrived = std::mem::take(&mut *self.shared.answers());
            let mut answers: Vec<StreamAnswer> = Vec::with_capacity(arrived.len());
            for (request, answer) in arrived {
                if self.withdrawn.remove(&request) {
                    continue;
                }
                self.pending.remove(&request);
                answers.push((request, answer));
            }
            // A read that panicked handed nothing in; it is answered here.
            let failed: Vec<(StreamRequest, String)> = self
                .pending
                .iter()
                .filter_map(|(request, job)| match job.try_get() {
                    Some(Err(JobError::Panicked(message))) => Some((*request, message)),
                    _ => None,
                })
                .collect();
            for (request, message) in failed {
                self.pending.remove(&request);
                answers.push((request, Err(AssetError::new(AssetErrorCode::Missing, format!("the read failed: {message}")))));
            }
            self.outstanding -= answers.len();
            answers
        }

        fn in_flight(&self) -> usize {
            self.outstanding
        }
    }

    /// `range` (None: all of it) of an asset of `size` bytes, or `malformed` when it is reversed or
    /// runs past the end (the requester's index does not match the file: a truncated pack), or
    /// `too-large` past [`ASSET_READ_MAX_BYTES`].
    fn checked_range(path: &str, range: Option<Range<u64>>, size: u64) -> Result<Range<u64>, AssetError> {
        let range = range.unwrap_or(0..size);
        if range.start > range.end || range.end > size {
            let detail = format!("{path}: bytes {}..{} of a {size}-byte asset", range.start, range.end);
            return Err(AssetError::new(AssetErrorCode::Malformed, detail));
        }
        if range.end - range.start > ASSET_READ_MAX_BYTES {
            let detail = format!("{path}: {} bytes in one read, at most {ASSET_READ_MAX_BYTES}", range.end - range.start);
            return Err(AssetError::new(AssetErrorCode::TooLarge, detail));
        }
        Ok(range)
    }

    /// `range` of `bytes` as a usize range (it was checked against their length).
    fn slice_of(bytes: &'static [u8], range: &Range<u64>) -> &'static [u8] {
        let start = usize::try_from(range.start).unwrap_or(bytes.len());
        let end = usize::try_from(range.end).unwrap_or(bytes.len());
        bytes.get(start..end).unwrap_or_default()
    }

    /// A refusal of `code` about `path`.
    fn refused(code: AssetErrorCode, path: &str, detail: impl std::fmt::Display) -> AssetError {
        AssetError::new(code, format!("{path}: {detail}"))
    }

    /// Bytes `range` of `path` under the asset folder. The path and the range are checked first
    /// ([`AssetFiles`]' rule, then the size); only then is the file opened (and counted), and the
    /// opened handle is checked again, since the name could have changed in between.
    fn read_range(files: &AssetFiles, path: &str, range: Option<Range<u64>>, opened: &AtomicU64) -> Result<Arc<[u8]>, AssetError> {
        let (real, size) = files.file(path)?;
        let range = checked_range(path, range, size)?;
        opened.fetch_add(1, Ordering::Relaxed);
        let mut file = File::open(&real).map_err(|error| refused(AssetErrorCode::Missing, path, error))?;
        let meta = file.metadata().map_err(|error| refused(AssetErrorCode::Missing, path, error))?;
        if !meta.is_file() || meta.len() < range.end {
            return Err(refused(AssetErrorCode::Missing, path, "changed while it was opened"));
        }
        let length = usize::try_from(range.end - range.start).map_err(|error| refused(AssetErrorCode::TooLarge, path, error))?;
        file.seek(SeekFrom::Start(range.start)).map_err(|error| refused(AssetErrorCode::Missing, path, error))?;
        let mut bytes = vec![0; length];
        file.read_exact(&mut bytes).map_err(|error| {
            let code = if error.kind() == ErrorKind::UnexpectedEof { AssetErrorCode::Malformed } else { AssetErrorCode::Missing };
            refused(code, path, error)
        })?;
        Ok(Arc::from(bytes))
    }
}
