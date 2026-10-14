//! Captures: the world target read back as BGRA rows top-down (the target is `Bgra8Unorm` on every
//! backend and wgpu's texture origin is the top-left, so no CPU swizzle or flip), its FNV-1a-64
//! digest, and the v1 file contract `<state>/captures/<seq>.bgra` with the newest eight kept.
//! The digest is genex-core's golden-checked port of `digest.h` ([`fnv1a64`], [`hex64`]).

use std::fs;
use std::path::{Path, PathBuf};

use crate::caps::CAPTURE_MAX_BYTES;
use crate::error::{RenderCode, RenderError};

/// The pixel layout of a capture file (`NATIVE_CAPTURE_FORMAT`). Wire value.
pub const CAPTURE_FORMAT: &str = "bgra8";
/// Capture files a run keeps; the host reads each one when its answer arrives and never deletes
/// in `state/` while the game runs, so the game drops the oldest. Eight, not one: a capture still
/// being read is never the one removed.
pub const CAPTURES_KEPT: u32 = 8;
/// The folder under the state root that captures go in.
pub const CAPTURES_DIR: &str = "captures";
/// A capture file's extension.
pub const CAPTURE_EXTENSION: &str = "bgra";

const BYTES_PER_PIXEL: u32 = 4;

/// FNV-1a 64 of a capture's pixels and its 16-digit hex form, as the host recomputes them.
pub use genex_core::digest::{fnv1a64, hex64};

/// The bytes of a `width` × `height` capture, or `capture-too-large` above [`CAPTURE_MAX_BYTES`].
pub fn check_capture_size(width: u32, height: u32) -> Result<u64, RenderError> {
    let bytes = u64::from(width).saturating_mul(u64::from(height)).saturating_mul(u64::from(BYTES_PER_PIXEL));
    if bytes > CAPTURE_MAX_BYTES {
        return Err(RenderError::refused(
            RenderCode::CaptureTooLarge,
            format!("{width}×{height} is {bytes} bytes, at most {CAPTURE_MAX_BYTES}"),
        ));
    }
    Ok(bytes)
}

/// One captured frame: opaque BGRA, top row first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Capture {
    width: u32,
    height: u32,
    bgra: Vec<u8>,
}

impl Capture {
    /// A capture of exactly `width * height * 4` bytes.
    pub fn new(width: u32, height: u32, bgra: Vec<u8>) -> Result<Capture, RenderError> {
        let bytes = check_capture_size(width, height)?;
        if bgra.len() as u64 != bytes {
            return Err(RenderError::refused(
                RenderCode::CaptureFailed,
                format!("{} bytes for {width}×{height}", bgra.len()),
            ));
        }
        Ok(Capture { width, height, bgra })
    }

    /// A capture from a GPU readback whose rows are `padded_bytes_per_row` apart: the padding is
    /// dropped, the bytes are kept in order.
    pub fn from_padded_rows(width: u32, height: u32, padded_bytes_per_row: u32, data: &[u8]) -> Result<Capture, RenderError> {
        check_capture_size(width, height)?;
        let row = (width * BYTES_PER_PIXEL) as usize;
        let stride = padded_bytes_per_row as usize;
        let needed = stride * height.saturating_sub(1) as usize + row;
        if stride < row || data.len() < needed {
            return Err(RenderError::refused(
                RenderCode::CaptureFailed,
                format!("readback of {} bytes with {stride}-byte rows cannot hold {width}×{height}", data.len()),
            ));
        }
        let mut bgra = Vec::with_capacity(row * height as usize);
        for y in 0..height as usize {
            bgra.extend_from_slice(&data[y * stride..y * stride + row]);
        }
        Capture::new(width, height, bgra)
    }

    /// Width in pixels.
    pub fn width(&self) -> u32 {
        self.width
    }

    /// Height in pixels.
    pub fn height(&self) -> u32 {
        self.height
    }

    /// The pixels.
    pub fn bgra(&self) -> &[u8] {
        &self.bgra
    }

    /// FNV-1a 64 of the pixels.
    pub fn digest(&self) -> u64 {
        fnv1a64(&self.bgra)
    }
}

/// What the `capture` verb answers about a written file.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureRecord {
    /// The file's sequence number, from 1.
    pub seq: u32,
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// [`CAPTURE_FORMAT`].
    pub format: &'static str,
    /// [`hex64`] of [`fnv1a64`] of the file's bytes.
    pub digest: String,
}

/// The capture files of one run.
#[derive(Debug)]
pub struct CaptureFiles {
    folder: PathBuf,
    seq: u32,
}

impl CaptureFiles {
    /// Captures under `<state_root>/captures/`. A relative or empty root is refused `no-state-dir`:
    /// it would land in the working folder, never a run's state.
    pub fn new(state_root: &Path) -> Result<CaptureFiles, RenderError> {
        if !state_root.is_absolute() {
            return Err(RenderError::refused(
                RenderCode::NoStateDir,
                format!("state root {state_root:?} is not absolute"),
            ));
        }
        Ok(CaptureFiles { folder: state_root.join(CAPTURES_DIR), seq: 0 })
    }

    /// The path of capture `seq`.
    pub fn path(&self, seq: u32) -> PathBuf {
        self.folder.join(format!("{seq}.{CAPTURE_EXTENSION}"))
    }

    /// Write the next capture file and drop the one [`CAPTURES_KEPT`] older. A failed write takes
    /// no sequence number.
    pub fn write(&mut self, capture: &Capture) -> Result<CaptureRecord, RenderError> {
        let failed = |error: std::io::Error| RenderError::refused(RenderCode::CaptureFailed, error.to_string());
        fs::create_dir_all(&self.folder).map_err(failed)?;
        let seq = self.seq + 1;
        fs::write(self.path(seq), capture.bgra()).map_err(failed)?;
        self.seq = seq;
        if seq > CAPTURES_KEPT {
            // Best effort, as the C++ runtime: a file the host already removed is not an error.
            let _ = fs::remove_file(self.path(seq - CAPTURES_KEPT));
        }
        Ok(CaptureRecord {
            seq,
            width: capture.width(),
            height: capture.height(),
            format: CAPTURE_FORMAT,
            digest: hex64(capture.digest()),
        })
    }
}
