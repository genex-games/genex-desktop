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
//!
//! [`CellPacks`] reads a compiled cell pack whole (release R-8): `world.json` and every listed cell
//! body, from a game's compiled asset table or any [`AssetSource`] (natively [`AssetFiles`], whose
//! checks every read passes first). [`pack`] is the facade's view of the pack format, so a game
//! crate that depends only on `genex` reads a pack (`genex::pack`) and digests what it read
//! (`genex::digest`).

use std::collections::BTreeMap;
use std::ops::Range;
use std::sync::Arc;

use genex_core::cell::CellId;
use genex_core::digest::{FNV_OFFSET_BASIS, fnv1a64_from};
use genex_core::paths::is_safe_asset_path;
use genex_render::jobs::Priority;
use genex_stream::pack::{CellPack, PACK_WORLD_FILE, PackError, PackWorld, cell_file};
use genex_stream::StreamViewCode;

use crate::gfx::{AssetError, AssetErrorCode, AssetSource, AssetTable};

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

/// The cell pack format as a game reads it (release R-8): the reader [`CellPacks`], what a cell
/// body holds, and the refusals.
pub mod pack {
    pub use super::{CellPacks, PackReadError, PackRefusal};
    pub use genex_stream::StreamViewCode;
    pub use genex_stream::pack::{
        CELL_COLLIDERS_MAX, CELL_GROUPS_MAX, CELL_INSTANCES_MAX, CELL_MODELS_MAX, CELL_THINGS_MAX, CellPack, ColliderShapeKind, NavSource, PACK_CELL_BYTES_MAX,
        PACK_CELLS_MAX, PACK_FORMAT, PACK_VERSION, PACK_WORLD_BYTES_MAX, PACK_WORLD_FILE, PackCollider, PackEntry, PackError, PackGroup, PackModel,
        PackShape, PackTerrain, PackThing, PackTransform, PackWorld, cell_file, pack_file,
    };
}

/// Why a pack read was refused: the asset folder refused a file, or the pack format did.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum PackRefusal {
    /// A file was not read: an unsafe path, a link, missing, too large ([`AssetErrorCode`]).
    Asset(AssetErrorCode),
    /// A file was read and is not a v1 pack, or not the bytes `world.json` lists ([`StreamViewCode`]).
    Pack(StreamViewCode),
}

impl PackRefusal {
    /// The wire spelling: the asset code's, or the pack code's.
    pub const fn wire(self) -> &'static str {
        match self {
            PackRefusal::Asset(code) => code.wire(),
            PackRefusal::Pack(code) => code.wire(),
        }
    }
}

/// A refused pack read: the refusal, the file it is about (under `assets/`) and what was wrong,
/// for a person to read (never matched on). Nothing past the refused file was read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackReadError {
    /// The typed refusal.
    pub refusal: PackRefusal,
    /// The file under `assets/` it is about (the folder itself when that was refused).
    pub path: String,
    /// What was wrong.
    pub detail: String,
}

impl PackReadError {
    fn asset(path: &str, error: &AssetError) -> PackReadError {
        PackReadError { refusal: PackRefusal::Asset(error.code()), path: path.to_owned(), detail: error.detail().to_owned() }
    }

    fn pack(path: &str, error: &PackError) -> PackReadError {
        PackReadError { refusal: PackRefusal::Pack(error.code), path: path.to_owned(), detail: format!("{} (at byte {})", error.detail, error.at) }
    }
}

impl std::fmt::Display for PackReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}: {}", self.refusal.wire(), self.path, self.detail)
    }
}

impl std::error::Error for PackReadError {}

/// A compiled cell pack read whole: the host compiles a world's placement (`world/*.cells.json`)
/// into `assets/<folder>/` (`world.json` and `cells/<x>_<z>.cell`). Every listed cell is read and
/// checked against its listed size and FNV-1a 64; an unlisted cell is empty. The same pack gives
/// the same [`CellPacks::digest`] on every destination.
#[derive(Clone, Debug, PartialEq)]
pub struct CellPacks {
    folder: String,
    world: PackWorld,
    cells: BTreeMap<CellId, CellPack>,
}

impl CellPacks {
    /// The pack at `assets/<folder>/` in a game's compiled asset table (`include_bytes!` rows,
    /// the table [`crate::install_with_assets`] takes): the same on every destination, so cell
    /// builders registered at install can use it.
    pub fn from_table(table: AssetTable, folder: &str) -> Result<CellPacks, PackReadError> {
        CellPacks::read(&table, folder)
    }

    /// The pack at `assets/<folder>/` from `source`. A folder that is not a plain path under
    /// `assets/` is refused before anything is read; then `world.json`, then each listed body in
    /// ascending cell order, each read through the source's own checks (natively no link at a name
    /// below the asset folder). The first refusal ends the read.
    pub fn read(source: &dyn AssetSource, folder: &str) -> Result<CellPacks, PackReadError> {
        if !is_safe_asset_path(folder) {
            let error = AssetError::new(AssetErrorCode::UnsafePath, "the pack folder is not a plain path under assets/");
            return Err(PackReadError::asset(folder, &error));
        }
        let world_path = format!("{folder}/{PACK_WORLD_FILE}");
        let text = source.read(&world_path).map_err(|error| PackReadError::asset(&world_path, &error))?;
        let world = PackWorld::read(&text).map_err(|error| PackReadError::pack(&world_path, &error))?;
        let mut cells = BTreeMap::new();
        for entry in world.cells() {
            let path = format!("{folder}/{}", cell_file(entry.cell));
            let body = source.read(&path).map_err(|error| PackReadError::asset(&path, &error))?;
            let pack = CellPack::read(entry, &body).map_err(|error| PackReadError::pack(&path, &error))?;
            cells.insert(entry.cell, pack);
        }
        Ok(CellPacks { folder: folder.to_owned(), world, cells })
    }

    /// The folder under `assets/` it was read from.
    pub fn folder(&self) -> &str {
        &self.folder
    }

    /// The pack's `world.json`: the cell size, the bounds and the listed cells.
    pub fn world(&self) -> &PackWorld {
        &self.world
    }

    /// The content of `cell`; None for a cell the pack does not list (an empty cell).
    pub fn cell(&self, cell: CellId) -> Option<&CellPack> {
        self.cells.get(&cell)
    }

    /// Every listed cell's content, in ascending cell order (by `x`, then `z`).
    pub fn cells(&self) -> impl Iterator<Item = &CellPack> {
        self.cells.values()
    }

    /// The FNV-1a 64 of the pack: the cell size, then each listed cell's `x`, `z`, body size and
    /// body digest (little-endian), ascending. Equal packs give equal digests on every destination.
    pub fn digest(&self) -> u64 {
        let start = fnv1a64_from(&self.world.cell_size().to_le_bytes(), FNV_OFFSET_BASIS);
        self.world.cells().iter().fold(start, |hash, entry| {
            let hash = fnv1a64_from(&entry.cell.x.to_le_bytes(), hash);
            let hash = fnv1a64_from(&entry.cell.z.to_le_bytes(), hash);
            let hash = fnv1a64_from(&entry.bytes.to_le_bytes(), hash);
            fnv1a64_from(&entry.fnv.to_le_bytes(), hash)
        })
    }
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
