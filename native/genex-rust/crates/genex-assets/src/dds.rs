//! DDS textures. `image` 0.25 no longer routes DDS through its reader: its `DdsDecoder` reads the
//! block-compressed forms (DXT1/3/5) only when called directly, and nothing reads the
//! uncompressed ones raylib also loads (32 or 24 bits a pixel). This reads both, the uncompressed
//! ones by their channel masks.

use crate::error::{AssetError, AssetErrorCode};
use crate::texture::Texture;
use image::DynamicImage;
use image::codecs::dds::DdsDecoder;
use std::io::Cursor;

const MAGIC: &[u8; 4] = b"DDS ";
const HEADER_BYTES: usize = 128;
/// `DDPF_ALPHAPIXELS`, `DDPF_FOURCC`, `DDPF_RGB`.
const ALPHA_PIXELS: u32 = 0x1;
const FOURCC: u32 = 0x4;
const RGB: u32 = 0x40;
const MAX_SIDE: u32 = 16_384;

/// Whether `bytes` start like a DDS file.
pub(crate) fn is_dds(bytes: &[u8]) -> bool {
    bytes.starts_with(MAGIC)
}

fn malformed(detail: impl Into<String>) -> AssetError {
    AssetError::new(AssetErrorCode::Malformed, detail)
}

fn word(bytes: &[u8], at: usize) -> u32 {
    bytes.get(at..at + 4).map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
}

/// One channel of a packed pixel, scaled to 8 bits; a zero mask reads as `fallback`.
fn channel(pixel: u32, mask: u32, fallback: u8) -> u8 {
    if mask == 0 {
        return fallback;
    }
    let shift = mask.trailing_zeros();
    let max = mask >> shift;
    let value = (pixel & mask) >> shift;
    u8::try_from(value * 255 / max).unwrap_or(u8::MAX)
}

/// A DDS file decoded to RGBA8.
pub(crate) fn decode_dds(bytes: &[u8]) -> Result<Texture, AssetError> {
    if bytes.len() < HEADER_BYTES || word(bytes, 4) != 124 {
        return Err(malformed("not a DDS file"));
    }
    let (height, width, flags) = (word(bytes, 12), word(bytes, 16), word(bytes, 80));
    if width == 0 || height == 0 || width > MAX_SIDE || height > MAX_SIDE {
        return Err(malformed("bad DDS size"));
    }
    if flags & FOURCC != 0 {
        let decoder = DdsDecoder::new(Cursor::new(bytes)).map_err(|e| malformed(e.to_string()))?;
        let image = DynamicImage::from_decoder(decoder).map_err(|e| malformed(e.to_string()))?.to_rgba8();
        return Ok(Texture { width: image.width(), height: image.height(), rgba: image.into_raw() });
    }
    let bits = word(bytes, 88);
    if flags & RGB == 0 || !(bits == 24 || bits == 32) {
        return Err(malformed("a DDS pixel format the runtime does not read"));
    }
    let size = (bits / 8) as usize;
    let pixels = width as usize * height as usize;
    let data = bytes.get(HEADER_BYTES..HEADER_BYTES + pixels * size).ok_or_else(|| malformed("truncated DDS"))?;
    let masks = [word(bytes, 92), word(bytes, 96), word(bytes, 100)];
    let alpha = if flags & ALPHA_PIXELS != 0 { word(bytes, 104) } else { 0 };
    let mut rgba = Vec::with_capacity(pixels * 4);
    for chunk in data.chunks_exact(size) {
        let mut packed = [0u8; 4];
        packed[..size].copy_from_slice(chunk);
        let pixel = u32::from_le_bytes(packed);
        rgba.extend(masks.iter().map(|&mask| channel(pixel, mask, 0)));
        rgba.push(channel(pixel, alpha, u8::MAX));
    }
    Ok(Texture { width, height, rgba })
}
