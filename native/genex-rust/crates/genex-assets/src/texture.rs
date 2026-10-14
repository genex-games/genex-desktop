//! Textures: images decoded to RGBA8, the missing-texture checker, and the per-destination
//! texture table.
//!
//! A texture that cannot load is never a crash: [`load_texture`] answers the raylib runtime's
//! 64 px magenta-and-black checker (`studio.cpp` `missingTexture`) with the reason beside it.
//! KTX2 (Basis Universal) textures are transcoded by the renderer to the family
//! [`compression_for`] picks from the device's WebGPU features; the studio's import step
//! transcodes every family a game's destinations may pick, from the same table
//! (`src/substrate/asset-import/texture-table.ts`; `tests/fixtures/asset-import/texture-table.json`
//! holds the two equal).

use crate::error::{AssetError, AssetErrorCode};
use crate::root::AssetRoot;
use std::io::Cursor;

/// The missing-texture checker's side, in pixels.
pub const MISSING_TEXTURE_PX: u32 = 64;
/// The side of one of its checks, in pixels.
pub const MISSING_TEXTURE_CHECK_PX: u32 = 8;
const MAGENTA: [u8; 4] = [255, 0, 255, 255];
const BLACK: [u8; 4] = [0, 0, 0, 255];
/// The largest side an image may declare, and the most memory its decoder may take.
const MAX_IMAGE_SIDE: u32 = 16_384;
const MAX_IMAGE_ALLOC_BYTES: u64 = 1024 * 1024 * 1024;

/// An image as RGBA8, top row first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Texture {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width * height * 4` bytes.
    pub rgba: Vec<u8>,
}

/// The checker a missing or unloadable texture shows: loud on purpose.
pub fn missing_texture() -> Texture {
    let side = MISSING_TEXTURE_PX;
    let mut rgba = Vec::with_capacity((side * side * 4) as usize);
    for y in 0..side {
        for x in 0..side {
            let even = (x / MISSING_TEXTURE_CHECK_PX + y / MISSING_TEXTURE_CHECK_PX).is_multiple_of(2);
            rgba.extend_from_slice(if even { &MAGENTA } else { &BLACK });
        }
    }
    Texture { width: side, height: side, rgba }
}

/// `bytes` decoded by their content (not their name) to RGBA8.
pub fn decode_image(bytes: &[u8]) -> Result<Texture, AssetError> {
    if crate::dds::is_dds(bytes) {
        return crate::dds::decode_dds(bytes);
    }
    let malformed = |error: image::ImageError| AssetError::new(AssetErrorCode::Malformed, error.to_string());
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_SIDE);
    limits.max_image_height = Some(MAX_IMAGE_SIDE);
    limits.max_alloc = Some(MAX_IMAGE_ALLOC_BYTES);
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| AssetError::new(AssetErrorCode::Malformed, e.to_string()))?;
    reader.limits(limits);
    let image = reader.decode().map_err(malformed)?.to_rgba8();
    Ok(Texture { width: image.width(), height: image.height(), rgba: image.into_raw() })
}

/// The texture at `rel`, or the checker and why.
pub fn load_texture(root: &AssetRoot, rel: &str) -> (Texture, Option<AssetError>) {
    match root.read(rel).and_then(|bytes| decode_image(&bytes)) {
        Ok(texture) => (texture, None),
        Err(error) => (missing_texture(), Some(error)),
    }
}

/// A GPU texture family. Wire spellings shared with the import receipt.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextureCompression {
    /// BC7.
    Bc,
    /// ASTC 4×4.
    Astc,
    /// ETC2 with EAC alpha.
    Etc2,
    /// Uncompressed RGBA, 8 bits a channel: every device takes it.
    Rgba8,
}

impl TextureCompression {
    /// Every family, in the table's order.
    pub const ALL: [TextureCompression; 4] =
        [TextureCompression::Bc, TextureCompression::Astc, TextureCompression::Etc2, TextureCompression::Rgba8];

    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            TextureCompression::Bc => "bc",
            TextureCompression::Astc => "astc",
            TextureCompression::Etc2 => "etc2",
            TextureCompression::Rgba8 => "rgba8",
        }
    }

    /// The WebGPU feature the family needs; uncompressed needs none.
    pub const fn feature(self) -> Option<&'static str> {
        match self {
            TextureCompression::Bc => Some("texture-compression-bc"),
            TextureCompression::Astc => Some("texture-compression-astc"),
            TextureCompression::Etc2 => Some("texture-compression-etc2"),
            TextureCompression::Rgba8 => None,
        }
    }

    /// Basis Universal's `transcoder_texture_format` for the family.
    pub const fn basis_format(self) -> u32 {
        match self {
            TextureCompression::Bc => 6,
            TextureCompression::Astc => 10,
            TextureCompression::Etc2 => 1,
            TextureCompression::Rgba8 => 13,
        }
    }
}

/// A destination, as the texture table keys it. Wire spellings are the studio's `BuildTarget`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextureTarget {
    /// macOS.
    Macos,
    /// Windows.
    Windows,
    /// Linux.
    Linux,
    /// iPhone and iPad.
    Ios,
    /// Android.
    Android,
    /// A browser: a desktop or a phone.
    Web,
}

impl TextureTarget {
    /// Every destination.
    pub const ALL: [TextureTarget; 6] = [
        TextureTarget::Macos,
        TextureTarget::Windows,
        TextureTarget::Linux,
        TextureTarget::Ios,
        TextureTarget::Android,
        TextureTarget::Web,
    ];

    /// The wire spelling.
    pub const fn as_str(self) -> &'static str {
        match self {
            TextureTarget::Macos => "macos",
            TextureTarget::Windows => "windows",
            TextureTarget::Linux => "linux",
            TextureTarget::Ios => "ios",
            TextureTarget::Android => "android",
            TextureTarget::Web => "web",
        }
    }
}

const DESKTOP: &[TextureCompression] = &[TextureCompression::Bc, TextureCompression::Rgba8];
const MOBILE: &[TextureCompression] = &[TextureCompression::Astc, TextureCompression::Etc2, TextureCompression::Rgba8];
const BROWSER: &[TextureCompression] = &TextureCompression::ALL;

/// The destination's families, best first; the last is always uncompressed.
pub const fn destination_textures(target: TextureTarget) -> &'static [TextureCompression] {
    match target {
        TextureTarget::Macos | TextureTarget::Windows | TextureTarget::Linux => DESKTOP,
        TextureTarget::Ios | TextureTarget::Android => MOBILE,
        TextureTarget::Web => BROWSER,
    }
}

/// The family a device of `target` with `features` (WebGPU feature names) loads a texture as.
pub fn compression_for(target: TextureTarget, features: &[&str]) -> TextureCompression {
    destination_textures(target)
        .iter()
        .copied()
        .find(|family| family.feature().is_none_or(|feature| features.contains(&feature)))
        .unwrap_or(TextureCompression::Rgba8)
}
