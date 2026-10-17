//! Compressed material textures (renderer pass 2, A6.4): the GPU texture families a size-class
//! array can be stored in ([`TextureFamily`]: BC7, ASTC 4x4 and ETC2 RGBA8 at one byte a texel,
//! RGBA8 at four), and a KTX2 file in one of their fixed formats read and checked with the `ktx2`
//! crate ([`read_ktx2`]). Its levels are kept exactly as stored: a compressed chain is never
//! resampled, so a larger texture fits a smaller class by dropping its top levels.
//!
//! The Studio writes these files: a Basis Universal KTX2 is transcoded per family at export and
//! its levels written plain (no supercompression), so the runtime carries no transcoder and no
//! zstd decoder. Which family a device loads is the destination table's
//! (`genex-assets` `compression_for`); the features each family needs are renderer-owned
//! (`floor::RENDERER_FEATURES`).

use ktx2::Format;
use wgpu::{Features, TextureFormat};

use crate::caps::check_texture;
use crate::error::{RenderCode, RenderError};
use crate::texture::{TextureKind, mip_level_count};

/// Texels on a side of one compressed block (all three families use 4 x 4 blocks).
const BLOCK_SIDE: u32 = 4;
/// Bytes of one compressed block: 128 bits for BC7, ASTC 4x4 and ETC2 RGBA8.
const BLOCK_BYTES: u32 = 16;
/// Bytes of one RGBA8 texel.
const RGBA8_BYTES: u32 = 4;

/// A GPU texture family a material array is stored in.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum TextureFamily {
    /// BC7 (desktops, desktop browsers, Apple9 phones).
    Bc7,
    /// ASTC 4x4, LDR (phones, Apple silicon, mobile browsers).
    Astc4x4,
    /// ETC2 RGBA8 with EAC alpha (phones without ASTC).
    Etc2Rgba8,
    /// Uncompressed RGBA8: every device takes it.
    Rgba8,
}

impl TextureFamily {
    /// Every family, compressed first.
    pub const ALL: [TextureFamily; 4] = [TextureFamily::Bc7, TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8, TextureFamily::Rgba8];

    /// The WebGPU feature the family needs (none for RGBA8).
    pub const fn feature(self) -> Features {
        match self {
            TextureFamily::Bc7 => Features::TEXTURE_COMPRESSION_BC,
            TextureFamily::Astc4x4 => Features::TEXTURE_COMPRESSION_ASTC,
            TextureFamily::Etc2Rgba8 => Features::TEXTURE_COMPRESSION_ETC2,
            TextureFamily::Rgba8 => Features::empty(),
        }
    }

    /// Whether a device opened with `features` samples the family.
    pub fn usable(self, features: Features) -> bool {
        features.contains(self.feature())
    }

    /// The format an array of `kind` is stored in: sRGB for colour, linear for data and normals.
    pub fn format(self, kind: TextureKind) -> TextureFormat {
        let srgb = kind.array() == TextureKind::Color;
        match (self, srgb) {
            (TextureFamily::Bc7, true) => TextureFormat::Bc7RgbaUnormSrgb,
            (TextureFamily::Bc7, false) => TextureFormat::Bc7RgbaUnorm,
            (TextureFamily::Astc4x4, true) => TextureFormat::Astc { block: wgpu::AstcBlock::B4x4, channel: wgpu::AstcChannel::UnormSrgb },
            (TextureFamily::Astc4x4, false) => TextureFormat::Astc { block: wgpu::AstcBlock::B4x4, channel: wgpu::AstcChannel::Unorm },
            (TextureFamily::Etc2Rgba8, true) => TextureFormat::Etc2Rgba8UnormSrgb,
            (TextureFamily::Etc2Rgba8, false) => TextureFormat::Etc2Rgba8Unorm,
            (TextureFamily::Rgba8, true) => TextureFormat::Rgba8UnormSrgb,
            (TextureFamily::Rgba8, false) => TextureFormat::Rgba8Unorm,
        }
    }

    /// Texels on a side of one block (1 for RGBA8).
    pub const fn block_side(self) -> u32 {
        match self {
            TextureFamily::Rgba8 => 1,
            _ => BLOCK_SIDE,
        }
    }

    /// Bytes of one block (one texel for RGBA8).
    pub const fn block_bytes(self) -> u32 {
        match self {
            TextureFamily::Rgba8 => RGBA8_BYTES,
            _ => BLOCK_BYTES,
        }
    }

    /// Bytes of one `width` x `height` level: whole blocks, so a mip under a block takes one.
    pub fn level_bytes(self, width: u32, height: u32) -> u64 {
        let side = self.block_side();
        u64::from(width.div_ceil(side)) * u64::from(height.div_ceil(side)) * u64::from(self.block_bytes())
    }

    /// Bytes of a square layer of `side` texels with its whole chain down to 1 x 1.
    pub fn chain_bytes(self, side: u32) -> u64 {
        (0..mip_level_count(side)).map(|level| (side >> level).max(1)).map(|px| self.level_bytes(px, px)).sum()
    }

    /// The wire spelling the Studio names a family file with (`<stem>.<wire>.ktx2`), shared with
    /// the import receipt and `genex-assets`' `TextureCompression`.
    pub const fn wire(self) -> &'static str {
        match self {
            TextureFamily::Bc7 => "bc",
            TextureFamily::Astc4x4 => "astc",
            TextureFamily::Etc2Rgba8 => "etc2",
            TextureFamily::Rgba8 => "rgba8",
        }
    }

    /// The compressed families a device opened with `features` samples, best first for its form
    /// (a phone `mobile`): BC first on a desktop (Mesa only emulates ASTC and ETC2), ASTC first on
    /// a phone, as the destination table orders them.
    pub fn usable_compressed(features: Features, mobile: bool) -> Vec<TextureFamily> {
        let order = if mobile { MOBILE_ORDER } else { DESKTOP_ORDER };
        order.into_iter().filter(|family| family.usable(features)).collect()
    }
}

/// The compressed families a desktop takes, best first.
const DESKTOP_ORDER: [TextureFamily; 3] = [TextureFamily::Bc7, TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8];
/// The compressed families a phone takes, best first.
const MOBILE_ORDER: [TextureFamily; 3] = [TextureFamily::Astc4x4, TextureFamily::Etc2Rgba8, TextureFamily::Bc7];

/// Where the Studio writes `path`'s file in `family` (renderer pass 2 A6.4/A6.5): beside it, its
/// extension replaced by `.<family>.ktx2` (`textures/rock.png` -> `textures/rock.bc.ktx2`).
pub fn family_file(path: &str, family: TextureFamily) -> String {
    let name_at = path.rfind('/').map_or(0, |at| at + 1);
    let stem = path[name_at..].rfind('.').map_or(path, |dot| &path[..name_at + dot]);
    format!("{stem}.{}.ktx2", family.wire())
}

/// The family and colour space of a KTX2 `vkFormat` a material array takes.
fn family_of(format: Format) -> Option<(TextureFamily, bool)> {
    let found = match format {
        Format::BC7_SRGB_BLOCK => (TextureFamily::Bc7, true),
        Format::BC7_UNORM_BLOCK => (TextureFamily::Bc7, false),
        Format::ASTC_4x4_SRGB_BLOCK => (TextureFamily::Astc4x4, true),
        Format::ASTC_4x4_UNORM_BLOCK => (TextureFamily::Astc4x4, false),
        Format::ETC2_R8G8B8A8_SRGB_BLOCK => (TextureFamily::Etc2Rgba8, true),
        Format::ETC2_R8G8B8A8_UNORM_BLOCK => (TextureFamily::Etc2Rgba8, false),
        Format::R8G8B8A8_SRGB => (TextureFamily::Rgba8, true),
        Format::R8G8B8A8_UNORM => (TextureFamily::Rgba8, false),
        _ => return None,
    };
    Some(found)
}

/// A square texture in one family with its whole mip chain as stored, level 0 first.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompressedTexture {
    family: TextureFamily,
    srgb: bool,
    side: u32,
    levels: Vec<Vec<u8>>,
}

impl CompressedTexture {
    /// Its family.
    pub fn family(&self) -> TextureFamily {
        self.family
    }

    /// Whether its texels are sRGB-encoded (a colour texture).
    pub fn is_srgb(&self) -> bool {
        self.srgb
    }

    /// Level 0's side in texels.
    pub fn side(&self) -> u32 {
        self.side
    }

    /// Every level, level 0 first, down to 1 x 1.
    pub fn levels(&self) -> &[Vec<u8>] {
        &self.levels
    }

    /// The levels from the one `side` texels wide down, or `None` when no level is that wide.
    pub fn chain_from(&self, side: u32) -> Option<&[Vec<u8>]> {
        let level = (0..self.levels.len()).find(|&level| self.side >> level == side)?;
        Some(&self.levels[level..])
    }
}

fn invalid(detail: impl Into<String>) -> RenderError {
    RenderError::refused(RenderCode::TextureInvalid, detail)
}

/// The header fields a material texture must have: one square 2D image, levels stored plain.
fn check_header(header: &ktx2::Header) -> Result<(TextureFamily, bool), RenderError> {
    let format = header.format.ok_or_else(|| invalid("a Basis Universal KTX2 is transcoded at export, not at runtime"))?;
    let (family, srgb) = family_of(format).ok_or_else(|| invalid(format!("{format:?} is not a material texture format")))?;
    if header.supercompression_scheme.is_some() {
        return Err(invalid("supercompressed levels are written plain at export"));
    }
    let two_d = header.pixel_height > 0 && header.pixel_depth == 0 && header.layer_count <= 1 && header.face_count == 1;
    if !two_d {
        return Err(invalid("not one 2D image (an array, a cube, a 1D or a 3D texture)"));
    }
    check_texture(header.pixel_width, header.pixel_height, RGBA8_BYTES)?;
    let square = header.pixel_width == header.pixel_height && header.pixel_width.is_power_of_two();
    if !square {
        return Err(invalid(format!("{}x{} is not square and a power of two", header.pixel_width, header.pixel_height)));
    }
    Ok((family, srgb))
}

/// A KTX2 file in one of the families' fixed formats, checked: one square power-of-two 2D image,
/// within the texture cap (else `texture-too-large`), levels not supercompressed, every level
/// down to 1 x 1 present at its exact size. Anything else is `texture-invalid`, never a panic.
pub fn read_ktx2(bytes: &[u8]) -> Result<CompressedTexture, RenderError> {
    let reader = ktx2::Reader::new(bytes).map_err(|error| invalid(format!("not a KTX2 file: {error}")))?;
    let header = reader.header();
    let (family, srgb) = check_header(&header)?;
    let side = header.pixel_width;
    if header.level_count != mip_level_count(side) {
        return Err(invalid(format!("{} levels where a {side} texture has {}: every mip down to 1 x 1", header.level_count, mip_level_count(side))));
    }
    let levels = reader
        .levels()
        .enumerate()
        .map(|(level, data)| {
            let px = (side >> level).max(1);
            let expected = family.level_bytes(px, px);
            if data.data.len() as u64 != expected {
                return Err(invalid(format!("level {level} holds {} bytes, not {expected}", data.data.len())));
            }
            Ok(data.data.to_vec())
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CompressedTexture { family, srgb, side, levels })
}
