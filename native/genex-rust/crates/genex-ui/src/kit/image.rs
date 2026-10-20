//! The kit's image cache (G6 gameplay UI, UIS-5): a game PNG decoded once per asset path into an
//! egui texture and kept in the HUD context's memory (a seed forgets it). Reading the asset's bytes
//! is the caller's (the facade reads its asset groups); a failure is cached too, so a missing
//! image costs one read, not one per tick.

use std::collections::BTreeMap;

/// The largest PNG file the cache decodes, in bytes.
pub const IMAGE_BYTES_MAX: usize = 16 * 1024 * 1024;
/// The longest side the cache decodes, in texels.
pub const IMAGE_SIDE_MAX: u32 = 4096;
/// The most images one context caches; later paths are refused.
pub const IMAGES_MAX: usize = 256;
/// Where the cache lives in egui memory.
const CACHE_ID: &str = "genex-ui.images";
/// The most the PNG decoder may allocate: a [`IMAGE_SIDE_MAX`]-square image at 16-bit RGBA, with
/// room for its rows.
const DECODE_BYTES_MAX: usize = 160 * 1024 * 1024;
/// The first bytes of every PNG file.
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];

/// Why an image did not load.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[non_exhaustive]
pub enum ImageErrorCode {
    /// The asset is not there.
    Missing,
    /// The bytes are not a PNG the decoder reads.
    Invalid,
    /// Over [`IMAGE_BYTES_MAX`] bytes, a side over [`IMAGE_SIDE_MAX`], or over [`IMAGES_MAX`] images.
    TooLarge,
}

impl ImageErrorCode {
    /// The code's wire spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            ImageErrorCode::Missing => "image-missing",
            ImageErrorCode::Invalid => "image-invalid",
            ImageErrorCode::TooLarge => "image-too-large",
        }
    }
}

type Cache = BTreeMap<String, Result<egui::TextureHandle, ImageErrorCode>>;

/// The texture of the PNG at `asset`, decoded on first use from the bytes `read` answers (`None`
/// when the asset is missing); later calls answer the cached texture or error without reading.
pub fn image(ctx: &egui::Context, asset: &str, read: impl FnOnce(&str) -> Option<Vec<u8>>) -> Result<egui::TextureHandle, ImageErrorCode> {
    let id = egui::Id::new(CACHE_ID);
    let cached = ctx.data(|data| data.get_temp::<Cache>(id).and_then(|cache| cache.get(asset).cloned()));
    if let Some(answer) = cached {
        return answer;
    }
    let full = ctx.data(|data| data.get_temp::<Cache>(id).is_some_and(|cache| cache.len() >= IMAGES_MAX));
    if full {
        return Err(ImageErrorCode::TooLarge);
    }
    let answer = read(asset)
        .ok_or(ImageErrorCode::Missing)
        .and_then(|bytes| decode_png(&bytes))
        .map(|pixels| ctx.load_texture(format!("genex-ui:{asset}"), pixels, egui::TextureOptions::LINEAR));
    ctx.data_mut(|data| data.get_temp_mut_or_default::<Cache>(id).insert(asset.to_owned(), answer.clone()));
    answer
}

/// Decode a PNG into straight-alpha RGBA texels, refusing anything else and anything too large.
///
/// The png crate decodes it directly (not the image crate, whose format dispatch links every
/// decoder it was built with into a web build): palettes, low bit depths and `tRNS` are expanded,
/// and 16-bit samples are rounded to 8 bits as the image crate rounds them.
pub fn decode_png(bytes: &[u8]) -> Result<egui::ColorImage, ImageErrorCode> {
    if bytes.len() > IMAGE_BYTES_MAX {
        return Err(ImageErrorCode::TooLarge);
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(ImageErrorCode::Invalid);
    }
    let limits = png::Limits { bytes: DECODE_BYTES_MAX };
    let mut decoder = png::Decoder::new_with_limits(std::io::Cursor::new(bytes), limits);
    decoder.set_transformations(png::Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(refusal)?;
    let (width, height) = (reader.info().width, reader.info().height);
    if width > IMAGE_SIDE_MAX || height > IMAGE_SIDE_MAX {
        return Err(ImageErrorCode::TooLarge);
    }
    let mut texels = vec![0; reader.output_buffer_size().ok_or(ImageErrorCode::TooLarge)?];
    let frame = reader.next_frame(&mut texels).map_err(refusal)?;
    texels.truncate(frame.buffer_size());
    let rgba = straight_rgba8(&texels, frame.color_type, frame.bit_depth).ok_or(ImageErrorCode::Invalid)?;
    let size = [frame.width as usize, frame.height as usize];
    Ok(egui::ColorImage::from_rgba_unmultiplied(size, &rgba))
}

/// A decoder error as the refusal it is: an allocation over the cap is too large, anything else invalid.
fn refusal(error: png::DecodingError) -> ImageErrorCode {
    match error {
        png::DecodingError::LimitsExceeded => ImageErrorCode::TooLarge,
        _ => ImageErrorCode::Invalid,
    }
}

/// Expanded PNG samples (gray, gray-alpha, RGB or RGBA at 8 or 16 bits) as RGBA8 texels.
fn straight_rgba8(samples: &[u8], color: png::ColorType, depth: png::BitDepth) -> Option<Vec<u8>> {
    let channels = match color {
        png::ColorType::Grayscale => 1,
        png::ColorType::GrayscaleAlpha => 2,
        png::ColorType::Rgb => 3,
        png::ColorType::Rgba => 4,
        png::ColorType::Indexed => return None,
    };
    let eight: Vec<u8> = match depth {
        png::BitDepth::Eight => samples.to_vec(),
        // Big-endian samples, rounded as round(v * 255 / 65535).
        png::BitDepth::Sixteen => samples.as_chunks::<2>().0.iter().map(|pair| ((u32::from(u16::from_be_bytes(*pair)) + 128) / 257) as u8).collect(),
        _ => return None,
    };
    let texel = |chunk: &[u8]| -> [u8; 4] {
        match chunk {
            [l] => [*l, *l, *l, u8::MAX],
            [l, a] => [*l, *l, *l, *a],
            [r, g, b] => [*r, *g, *b, u8::MAX],
            [r, g, b, a] => [*r, *g, *b, *a],
            _ => [0; 4],
        }
    };
    Some(eight.chunks_exact(channels).flat_map(texel).collect())
}
