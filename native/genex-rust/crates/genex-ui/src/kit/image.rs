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
pub fn decode_png(bytes: &[u8]) -> Result<egui::ColorImage, ImageErrorCode> {
    if bytes.len() > IMAGE_BYTES_MAX {
        return Err(ImageErrorCode::TooLarge);
    }
    if !bytes.starts_with(&PNG_SIGNATURE) {
        return Err(ImageErrorCode::Invalid);
    }
    let mut reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), image::ImageFormat::Png);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(IMAGE_SIDE_MAX);
    limits.max_image_height = Some(IMAGE_SIDE_MAX);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|error| match error {
        image::ImageError::Limits(_) => ImageErrorCode::TooLarge,
        _ => ImageErrorCode::Invalid,
    })?;
    let rgba = decoded.to_rgba8();
    let size = [rgba.width() as usize, rgba.height() as usize];
    Ok(egui::ColorImage::from_rgba_unmultiplied(size, rgba.as_raw()))
}
