//! The stored form of an envelope. A body up to [`DEFLATE_ABOVE_BYTES`] is its canonical JSON as
//! is; a larger one is framed as [`DEFLATE_MAGIC`], its JSON length as a little-endian u32, and a
//! raw deflate stream (miniz_oxide at [`DEFLATE_LEVEL`]: pure Rust, the same bytes on every
//! target). Inflating never writes past the declared length (at most genex-core's
//! `MAX_SAVE_BYTES`), so a deflate bomb costs no more memory than an honest save.

use std::borrow::Cow;

use genex_core::saves::MAX_SAVE_BYTES;
use miniz_oxide::inflate::TINFLStatus;
use miniz_oxide::inflate::core::{DecompressorOxide, decompress, inflate_flags};

use crate::error::SaveError;

/// Bodies past this many bytes (256 KiB) are deflated.
pub const DEFLATE_ABOVE_BYTES: usize = 256 * 1024;
/// miniz_oxide's compression level for bodies (zlib's default).
pub const DEFLATE_LEVEL: u8 = 6;
/// The four bytes a deflated body starts with (a plain body starts with `{`).
pub const DEFLATE_MAGIC: &[u8; 4] = b"GXSZ";
/// The frame's header: the magic and the u32 length.
const FRAME_HEADER_BYTES: usize = 8;

/// The stored bytes of an envelope's canonical `json`: as is up to [`DEFLATE_ABOVE_BYTES`],
/// framed and deflated past it. Refuses `save-too-large` past `MAX_SAVE_BYTES`.
pub fn pack(json: Vec<u8>) -> Result<Vec<u8>, SaveError> {
    if json.len() > MAX_SAVE_BYTES {
        return Err(SaveError::too_large(format!("the envelope is {} bytes; a save holds at most 16 MiB", json.len())));
    }
    if json.len() <= DEFLATE_ABOVE_BYTES {
        return Ok(json);
    }
    let length = u32::try_from(json.len()).map_err(|_| SaveError::too_large("the envelope's length is past u32"))?;
    let stream = miniz_oxide::deflate::compress_to_vec(&json, DEFLATE_LEVEL);
    let mut framed = Vec::with_capacity(FRAME_HEADER_BYTES + stream.len());
    framed.extend_from_slice(DEFLATE_MAGIC);
    framed.extend_from_slice(&length.to_le_bytes());
    framed.extend_from_slice(&stream);
    if framed.len() > MAX_SAVE_BYTES {
        return Err(SaveError::too_large("the deflated envelope is past 16 MiB"));
    }
    Ok(framed)
}

/// The canonical JSON of stored bytes. Refuses `save-too-large` for bytes, a declared length or an
/// inflated stream past `MAX_SAVE_BYTES`, and `save-corrupt` for a truncated frame, a stream that
/// is not deflate, bytes after its end, or a length that does not match what it inflates to.
pub fn unpack(stored: &[u8]) -> Result<Cow<'_, [u8]>, SaveError> {
    if stored.len() > MAX_SAVE_BYTES {
        return Err(SaveError::too_large(format!(
            "the stored save is {} bytes; a save holds at most 16 MiB",
            stored.len()
        )));
    }
    if !stored.starts_with(DEFLATE_MAGIC) {
        return Ok(Cow::Borrowed(stored));
    }
    let Some(header) = stored.get(..FRAME_HEADER_BYTES) else {
        return Err(SaveError::corrupt("the deflate frame is truncated"));
    };
    let declared = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let declared = usize::try_from(declared).unwrap_or(usize::MAX);
    if declared > MAX_SAVE_BYTES {
        return Err(SaveError::too_large(format!("the frame declares {declared} bytes; a save holds at most 16 MiB")));
    }
    inflate_exact(&stored[FRAME_HEADER_BYTES..], declared).map(Cow::Owned)
}

/// Inflate `stream` into exactly `declared` bytes, writing at most one byte more.
fn inflate_exact(stream: &[u8], declared: usize) -> Result<Vec<u8>, SaveError> {
    let mut out = vec![0u8; declared + 1];
    let mut state = Box::<DecompressorOxide>::default();
    let flags = inflate_flags::TINFL_FLAG_USING_NON_WRAPPING_OUTPUT_BUF;
    let (status, consumed, written) = decompress(&mut state, stream, &mut out, 0, flags);
    match status {
        TINFLStatus::Done if consumed == stream.len() && written == declared => {
            out.truncate(declared);
            Ok(out)
        }
        TINFLStatus::Done if consumed != stream.len() => Err(SaveError::corrupt("bytes follow the deflate stream")),
        TINFLStatus::Done => {
            Err(SaveError::corrupt(format!("the frame declares {declared} bytes; it inflates to {written}")))
        }
        TINFLStatus::HasMoreOutput if declared == MAX_SAVE_BYTES => {
            Err(SaveError::too_large("the stream inflates past 16 MiB"))
        }
        TINFLStatus::HasMoreOutput => {
            Err(SaveError::corrupt(format!("the stream inflates past the declared {declared} bytes")))
        }
        _ => Err(SaveError::corrupt(format!("the deflate stream is truncated or malformed ({status:?})"))),
    }
}
