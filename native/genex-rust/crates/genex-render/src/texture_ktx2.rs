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
//!
//! A file can also be read in byte ranges (STR-18, [`Ktx2Index`]): KTX2 stores level data smallest
//! first, so the first [`KTX2_PREFIX_BYTES`] (the header and the level index) give the exact range
//! of the smallest k levels, a tail-first read that grows only at its end, and the levels cut from
//! the fetched ranges are bit-equal to [`read_ktx2`] on the whole file.

use std::ops::Range;

use ktx2::Format;
use wgpu::{Features, TextureFormat};

use crate::caps::{TEXTURE_MAX_BYTES, check_texture};
use crate::error::{RenderCode, RenderError};
use crate::texture::{TextureKind, mip_level_count};

/// Texels on a side of one compressed block (all three families use 4 x 4 blocks).
const BLOCK_SIDE: u32 = 4;
/// Bytes of one compressed block: 128 bits for BC7, ASTC 4x4 and ETC2 RGBA8.
const BLOCK_BYTES: u32 = 16;
/// Bytes of one RGBA8 texel.
const RGBA8_BYTES: u32 = 4;
/// The widest square texture the cap takes ([`TEXTURE_MAX_BYTES`] of RGBA8).
const KTX2_SIDE_MAX: u64 = (TEXTURE_MAX_BYTES / RGBA8_BYTES as u64).isqrt();
/// Levels of that texture's whole chain: the most a material KTX2 lists.
const KTX2_LEVELS_MAX: usize = KTX2_SIDE_MAX.ilog2() as usize + 1;
/// Bytes of a KTX2 prefix that holds the header and the level index of any material texture the
/// cap takes: the first range a streamed texture fetches.
pub const KTX2_PREFIX_BYTES: usize = ktx2::Header::LENGTH + ktx2::LevelIndex::LENGTH * KTX2_LEVELS_MAX;

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

/// Where one level's bytes sit in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct LevelSpan {
    offset: u64,
    length: u64,
}

impl LevelSpan {
    fn end(self) -> u64 {
        self.offset + self.length
    }
}

/// A KTX2 file's header and level index read from a prefix (STR-18): the byte range of the
/// smallest k levels, and those levels cut from fetched ranges. Parsing checks what [`read_ktx2`]
/// checks of the header and the level sizes, and that the levels lie smallest first, in the file,
/// after the index and without overlap; anything else is `texture-invalid`. The data format
/// descriptor is not read: the header's `vkFormat` names the family.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ktx2Index {
    family: TextureFamily,
    srgb: bool,
    side: u32,
    /// Level 0 first.
    levels: Vec<LevelSpan>,
}

impl Ktx2Index {
    /// How many bytes of the file hold its header and level index, read from its first 80 bytes:
    /// refused when they are not a KTX2 header or list more levels than any material texture has.
    pub fn prefix_len(header: &[u8]) -> Result<usize, RenderError> {
        let header = parse_header(header)?;
        index_end(&header)
    }

    /// The index of a file `file_len` bytes long from its first bytes (at least
    /// [`Ktx2Index::prefix_len`] of them; [`KTX2_PREFIX_BYTES`] always suffices).
    pub fn parse(prefix: &[u8], file_len: u64) -> Result<Ktx2Index, RenderError> {
        let header = parse_header(prefix)?;
        let end = index_end(&header)?;
        let (family, srgb) = check_header(&header)?;
        check_sections(&header.index, file_len)?;
        let side = header.pixel_width;
        if header.level_count != mip_level_count(side) {
            return Err(invalid(format!("{} levels where a {side} texture has {}: every mip down to 1 x 1", header.level_count, mip_level_count(side))));
        }
        let entries = prefix.get(ktx2::Header::LENGTH..end).ok_or_else(|| invalid(format!("the prefix holds {} of the index's {end} bytes", prefix.len())))?;
        let (entries, _) = entries.as_chunks::<{ ktx2::LevelIndex::LENGTH }>();
        let levels = entries
            .iter()
            .enumerate()
            .map(|(level, entry)| level_span(family, side, level, entry, file_len))
            .collect::<Result<Vec<_>, _>>()?;
        check_order(&levels, end as u64)?;
        Ok(Ktx2Index { family, srgb, side, levels })
    }

    /// Its family.
    pub fn family(&self) -> TextureFamily {
        self.family
    }

    /// Level 0's side in texels.
    pub fn side(&self) -> u32 {
        self.side
    }

    /// Levels in the file, down to 1 x 1.
    pub fn level_count(&self) -> u32 {
        self.levels.len() as u32
    }

    /// The bytes holding the smallest `k` levels (1 to [`Ktx2Index::level_count`]): one range that
    /// starts where the 1 x 1 level does, so a larger `k` only extends its end.
    pub fn smallest(&self, k: u32) -> Result<Range<u64>, RenderError> {
        let first = self.first_level(k)?;
        let tail = self.levels[self.levels.len() - 1];
        Ok(tail.offset..self.levels[first].end())
    }

    /// The range of the levels from the one `side` texels wide down (a size class's chain), or
    /// `None` when no level is that wide.
    pub fn chain(&self, side: u32) -> Option<Range<u64>> {
        let level = (0..self.levels.len()).find(|&level| self.side >> level == side)?;
        self.smallest((self.levels.len() - level) as u32).ok()
    }

    /// The smallest `k` levels cut from `chunks` (each its file offset and the bytes fetched
    /// there), bit-equal to the same levels of [`read_ktx2`] on the whole file. Refused when a
    /// level's bytes are not all inside the chunks.
    pub fn assemble(&self, k: u32, chunks: &[(u64, &[u8])]) -> Result<CompressedTexture, RenderError> {
        let first = self.first_level(k)?;
        let levels = self.levels[first..]
            .iter()
            .enumerate()
            .map(|(at, span)| cut(*span, chunks).ok_or_else(|| invalid(format!("level {} is not inside the fetched ranges", first + at))))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(CompressedTexture { family: self.family, srgb: self.srgb, side: self.side >> first, levels })
    }

    /// The level the smallest `k` start at, or why `k` is outside 1 to the level count.
    fn first_level(&self, k: u32) -> Result<usize, RenderError> {
        let count = self.levels.len();
        let k = k as usize;
        if k == 0 || k > count {
            return Err(invalid(format!("{k} levels of a texture with {count}")));
        }
        Ok(count - k)
    }
}

/// The header in the first 80 bytes of `prefix`.
fn parse_header(prefix: &[u8]) -> Result<ktx2::Header, RenderError> {
    let bytes: &[u8; ktx2::Header::LENGTH] = prefix
        .get(..ktx2::Header::LENGTH)
        .and_then(|head| head.try_into().ok())
        .ok_or_else(|| invalid(format!("{} bytes hold no KTX2 header", prefix.len())))?;
    ktx2::Header::from_bytes(bytes).map_err(|error| invalid(format!("not a KTX2 file: {error}")))
}

/// Where the level index ends, for a header that lists at most [`KTX2_LEVELS_MAX`] levels.
fn index_end(header: &ktx2::Header) -> Result<usize, RenderError> {
    let count = header.level_count.max(1) as usize;
    if count > KTX2_LEVELS_MAX {
        return Err(invalid(format!("{count} levels: a material texture has at most {KTX2_LEVELS_MAX}")));
    }
    Ok(ktx2::Header::LENGTH + ktx2::LevelIndex::LENGTH * count)
}

/// The header's data format, key/value and supercompression sections lie inside the file, as the
/// whole-file reader requires.
fn check_sections(index: &ktx2::Index, file_len: u64) -> Result<(), RenderError> {
    let dfd_start = u64::from(index.dfd_byte_offset) + 4;
    let dfd_end = u64::from(index.dfd_byte_offset) + u64::from(index.dfd_byte_length);
    let kvd_end = u64::from(index.kvd_byte_offset) + u64::from(index.kvd_byte_length);
    let sgd_end = index.sgd_byte_offset.checked_add(index.sgd_byte_length);
    let inside = dfd_end >= dfd_start && dfd_end < file_len && kvd_end < file_len && sgd_end.is_some_and(|end| end < file_len);
    if inside { Ok(()) } else { Err(invalid("a header section lies outside the file")) }
}

/// Level `level`'s entry, checked: its exact size for a `side` texture, stored plain, inside a file
/// `file_len` bytes long.
fn level_span(family: TextureFamily, side: u32, level: usize, entry: &[u8; ktx2::LevelIndex::LENGTH], file_len: u64) -> Result<LevelSpan, RenderError> {
    let entry = ktx2::LevelIndex::from_bytes(entry);
    let px = (side >> level).max(1);
    let expected = family.level_bytes(px, px);
    if entry.byte_length != expected || entry.uncompressed_byte_length != expected {
        return Err(invalid(format!("level {level} lists {} bytes ({} uncompressed), not {expected}", entry.byte_length, entry.uncompressed_byte_length)));
    }
    let end = entry.byte_offset.checked_add(entry.byte_length).filter(|&end| end <= file_len);
    if end.is_none() {
        return Err(invalid(format!("level {level} at {} runs past the file's {file_len} bytes", entry.byte_offset)));
    }
    Ok(LevelSpan { offset: entry.byte_offset, length: entry.byte_length })
}

/// The levels lie smallest first after the index (`index_end`), none overlapping the next.
fn check_order(levels: &[LevelSpan], index_end: u64) -> Result<(), RenderError> {
    let mut floor = index_end;
    for (level, span) in levels.iter().enumerate().rev() {
        if span.offset < floor {
            return Err(invalid(format!("level {level} at {} overlaps the index or a smaller level (ends at {floor})", span.offset)));
        }
        floor = span.end();
    }
    Ok(())
}

/// The bytes of `span` from `chunks`, which may split it across adjacent fetches; `None` when a
/// byte of it was not fetched.
fn cut(span: LevelSpan, chunks: &[(u64, &[u8])]) -> Option<Vec<u8>> {
    let mut bytes = Vec::with_capacity(usize::try_from(span.length).ok()?);
    let mut at = span.offset;
    while at < span.end() {
        let (start, data) = chunks.iter().find(|(start, data)| *start <= at && at < start.saturating_add(data.len() as u64))?;
        let from = usize::try_from(at - start).ok()?;
        let take = usize::try_from((span.end() - at).min((data.len() - from) as u64)).ok()?;
        bytes.extend_from_slice(&data[from..from + take]);
        at += take as u64;
    }
    Some(bytes)
}
