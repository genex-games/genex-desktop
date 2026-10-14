//! HDR environment maps from a game's assets (RQ2): Radiance `.hdr` files (RGBE, flat or
//! run-length encoded) decoded into `rgba16float` texels within fixed caps, refused with a typed
//! [`HdriRefusal`] before anything beyond the cap is allocated. The decoded map is prepared for
//! the device ([`prepare_map`]: box-filtered down to its class's width, the sun found first) and
//! is what [`crate::ibl::EnvironmentMaps::set_prepared_map`] bakes from and the backdrop draws;
//! with [`crate::settings::HdriSun::Analytic`] [`analytic_sun`] finds the map's brightest region
//! deterministically, which the bake clamps out and the scene's sun takes over
//! ([`crate::ibl::world_sun`]).
//!
//! The renderer never reads files (a web build has none): the facade reads the asset and hands
//! the bytes to [`decode`]. The importer's header check (`src/substrate/asset-import/hdr.ts`)
//! holds the same caps and layout rules, so a map the importer keeps is a map [`decode`] reads.
//!
//! The format: `#?RADIANCE` (or `#?RGBE`), header lines (`FORMAT=32-bit_rle_rgbe` or none;
//! `EXPOSURE=` and comments are ignored), a blank line, a resolution line (`-Y h +X w`, the usual
//! top-down order, or `+Y` for bottom-up rows and `-X` for mirrored columns), then the pixels:
//! four bytes a texel (red, green and blue mantissas and a shared exponent), flat or, for widths
//! 8 to 32767, one new-style run-length row per scanline. A texel is `mantissa * 2^(exponent -
//! 136)`, black for exponent zero, and every channel is clamped to the largest finite half float.
//!
//! The map's frame (the equirectangular convention [`direction_to_uv`] and [`uv_to_direction`]
//! hold, and the bake's `equirect.wgsl` follows): `u` runs left to right with `u = 0.5` at the
//! `-z` horizon and `u = 0.75` at `+x`; `v` runs from `0` at straight up (`+y`) to `1` at
//! straight down. A map's rotation turns it about `+y` ([`rotate_about_up`]): the bake looks the
//! map up in the world direction turned by the opposite angle, so a sun at `d` in the map
//! appears at `rotate_about_up(d, rotation)` in the world.

use std::fmt;

use crate::post::tonemap::{f16_to_f32, f32_to_f16};

/// The widest map (an equirectangular map is twice as wide as tall).
pub const HDRI_MAX_WIDTH: u32 = 4096;
/// The tallest map.
pub const HDRI_MAX_HEIGHT: u32 = 2048;
/// The most bytes a decoded map holds (`rgba16float`: 8 bytes a texel).
pub const HDRI_MAX_DECODED_BYTES: u64 = 64 * 1024 * 1024;
/// Bytes of one decoded texel.
pub const HDRI_TEXEL_BYTES: u64 = 8;
/// The `.hdr` file's first line (`#?RADIANCE`; `#?RGBE` is accepted too).
pub const RADIANCE_MAGIC: &[u8] = b"#?RADIANCE";
/// The other first line a Radiance file may start with.
const RGBE_MAGIC: &[u8] = b"#?RGBE";
/// The only colour format read: `rgbe`, run-length encoded or flat.
const SUPPORTED_FORMAT: &[u8] = b"32-bit_rle_rgbe";
/// The header (magic line, lines, blank line, resolution line) may not be longer than this.
const HEADER_MAX_BYTES: usize = 4096;
/// Run-length rows exist only for widths in this range; narrower or wider maps are flat.
const RLE_MIN_WIDTH: u32 = 8;
const RLE_MAX_WIDTH: u32 = 32767;
/// The most texels a two-byte run encodes.
const RLE_RUN_MAX: u32 = 127;
/// The largest finite half float (a brighter texel clamps to it).
const HALF_MAX: f32 = 65504.0;
/// The exponent bias of RGBE with the mantissa's eight bits folded in (`2^(e - 136)`).
const RGBE_EXPONENT_BIAS: i32 = 136;

/// A decoded equirectangular map: `width × height` texels, rows top (up) to bottom, each texel
/// the bits of four `f16` (rgb radiance, a = 1).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HdriImage {
    /// Texels per row.
    pub width: u32,
    /// Rows.
    pub height: u32,
    /// `width × height` texels as `f16` bits.
    pub texels: Vec<[u16; 4]>,
}

impl HdriImage {
    /// The bytes the decoded texels hold.
    pub fn decoded_bytes(&self) -> u64 {
        u64::from(self.width) * u64::from(self.height) * HDRI_TEXEL_BYTES
    }
}

/// Why a `.hdr` file is refused. Nothing beyond the caps is allocated before a refusal.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HdriRefusal {
    /// The file does not start with the Radiance magic.
    BadMagic,
    /// The header or the resolution line is malformed, or the format is not `32-bit_rle_rgbe`.
    BadHeader,
    /// A side is zero.
    Empty,
    /// The map is over [`HDRI_MAX_WIDTH`] × [`HDRI_MAX_HEIGHT`] or [`HDRI_MAX_DECODED_BYTES`].
    TooLarge {
        /// Its width.
        width: u32,
        /// Its height.
        height: u32,
    },
    /// The file ends inside the header, or the pixel data ends before the last row.
    Truncated,
    /// A run-length encoded row is malformed (a run past the row's end, a bad scanline header).
    BadRle,
    /// No decoder for this file (no longer returned; the spelling stays reserved).
    Unsupported,
}

impl HdriRefusal {
    /// The refusal's stable spelling.
    pub const fn wire(self) -> &'static str {
        match self {
            HdriRefusal::BadMagic => "hdri-bad-magic",
            HdriRefusal::BadHeader => "hdri-bad-header",
            HdriRefusal::Empty => "hdri-empty",
            HdriRefusal::TooLarge { .. } => "hdri-too-large",
            HdriRefusal::Truncated => "hdri-truncated",
            HdriRefusal::BadRle => "hdri-bad-rle",
            HdriRefusal::Unsupported => "hdri-unsupported",
        }
    }
}

impl fmt::Display for HdriRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            HdriRefusal::TooLarge { width, height } => {
                write!(f, "{}: {width}x{height}, at most {HDRI_MAX_WIDTH}x{HDRI_MAX_HEIGHT}", self.wire())
            }
            other => f.write_str(other.wire()),
        }
    }
}

impl std::error::Error for HdriRefusal {}

/// Whether a `width × height` map fits the caps (checked before any texel is allocated).
pub fn fits_caps(width: u32, height: u32) -> Result<(), HdriRefusal> {
    if width == 0 || height == 0 {
        return Err(HdriRefusal::Empty);
    }
    // The sides first: their product below cannot overflow once each is within its cap.
    let too_large = HdriRefusal::TooLarge { width, height };
    if width > HDRI_MAX_WIDTH || height > HDRI_MAX_HEIGHT {
        return Err(too_large);
    }
    if u64::from(width) * u64::from(height) * HDRI_TEXEL_BYTES > HDRI_MAX_DECODED_BYTES {
        return Err(too_large);
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------
// The header

/// What the resolution line says, and where the pixels start.
struct Header {
    width: u32,
    height: u32,
    /// `+Y`: the file's first row is the bottom one.
    bottom_up: bool,
    /// `-X`: the file's first column is the right one.
    mirrored: bool,
    /// Offset of the first pixel byte.
    pixels: usize,
}

/// The next header line from `at` (without its `\r\n`) and where the one after it starts. A line
/// that never ends is truncated when the file ends first and a bad header when the header
/// outgrows [`HEADER_MAX_BYTES`].
fn next_line(bytes: &[u8], at: usize) -> Result<(&[u8], usize), HdriRefusal> {
    let limit = bytes.len().min(HEADER_MAX_BYTES);
    let found = bytes.get(at..limit).and_then(|window| window.iter().position(|&b| b == b'\n'));
    let Some(offset) = found else {
        return Err(if bytes.len() >= HEADER_MAX_BYTES { HdriRefusal::BadHeader } else { HdriRefusal::Truncated });
    };
    let end = at + offset;
    let line = &bytes[at..end];
    Ok((line.strip_suffix(b"\r").unwrap_or(line), end + 1))
}

/// A side of the resolution line: digits only, saturating past `u32` so the caps refuse it.
fn side(token: &str) -> Result<u32, HdriRefusal> {
    if token.is_empty() || !token.bytes().all(|b| b.is_ascii_digit()) {
        return Err(HdriRefusal::BadHeader);
    }
    Ok(token.parse::<u32>().unwrap_or(u32::MAX))
}

/// The resolution line: `±Y height ±X width`.
fn parse_resolution(line: &[u8]) -> Result<(u32, u32, bool, bool), HdriRefusal> {
    let text = std::str::from_utf8(line).map_err(|_| HdriRefusal::BadHeader)?;
    let tokens: Vec<&str> = text.split_ascii_whitespace().collect();
    let [y_axis, height, x_axis, width] = tokens[..] else {
        return Err(HdriRefusal::BadHeader);
    };
    let bottom_up = match y_axis {
        "-Y" => false,
        "+Y" => true,
        _ => return Err(HdriRefusal::BadHeader),
    };
    let mirrored = match x_axis {
        "+X" => false,
        "-X" => true,
        _ => return Err(HdriRefusal::BadHeader),
    };
    Ok((side(width)?, side(height)?, bottom_up, mirrored))
}

/// The header of `bytes`, checked against the caps.
fn parse_header(bytes: &[u8]) -> Result<Header, HdriRefusal> {
    if !bytes.starts_with(RADIANCE_MAGIC) && !bytes.starts_with(RGBE_MAGIC) {
        return Err(HdriRefusal::BadMagic);
    }
    let (magic, mut at) = next_line(bytes, 0)?;
    if magic != RADIANCE_MAGIC && magic != RGBE_MAGIC {
        return Err(HdriRefusal::BadMagic);
    }
    loop {
        let (line, next) = next_line(bytes, at)?;
        at = next;
        if line.is_empty() {
            break;
        }
        let format = line.strip_prefix(b"FORMAT=");
        if format.is_some_and(|format| format != SUPPORTED_FORMAT) {
            return Err(HdriRefusal::BadHeader);
        }
    }
    let (resolution, pixels) = next_line(bytes, at)?;
    let (width, height, bottom_up, mirrored) = parse_resolution(resolution)?;
    fits_caps(width, height)?;
    Ok(Header { width, height, bottom_up, mirrored, pixels })
}

// ---------------------------------------------------------------------------------------------
// The pixels

/// Whether the pixels are new-style run-length rows: the width allows them and the first
/// scanline starts with the `2, 2, high, low` header (high bit clear).
fn is_run_length(width: u32, pixels: &[u8]) -> bool {
    let allowed = (RLE_MIN_WIDTH..=RLE_MAX_WIDTH).contains(&width);
    allowed && matches!(pixels, [2, 2, high, ..] if high & 0x80 == 0)
}

/// The fewest pixel bytes any encoding of a `width × height` map takes: a flat texel is four
/// bytes; a run-length row is its scanline header and, for each of four channels, at least one
/// two-byte run per 127 texels. A shorter file is truncated before anything is allocated.
fn minimum_pixel_bytes(width: u32, height: u32, run_length: bool) -> u64 {
    let (width, height) = (u64::from(width), u64::from(height));
    if !run_length {
        return width * height * 4;
    }
    height * (4 + 4 * 2 * width.div_ceil(u64::from(RLE_RUN_MAX)))
}

/// `2^(e - 136)` for every shared exponent byte (exact: a power of two), zero for exponent zero.
fn exponent_scales() -> [f32; 256] {
    let mut scales = [0.0f32; 256];
    for (exponent, scale) in scales.iter_mut().enumerate().skip(1) {
        *scale = libm::scalbnf(1.0, exponent as i32 - RGBE_EXPONENT_BIAS);
    }
    scales
}

/// One texel's half-float bits from its four RGBE bytes.
fn texel_from_rgbe(rgbe: [u8; 4], scales: &[f32; 256]) -> [u16; 4] {
    let scale = scales[usize::from(rgbe[3])];
    let channel = |mantissa: u8| f32_to_f16((f32::from(mantissa) * scale).min(HALF_MAX));
    [channel(rgbe[0]), channel(rgbe[1]), channel(rgbe[2]), f32_to_f16(1.0)]
}

/// One channel of a run-length row into `out` (`out.len()` = the row's width); the position in
/// `pixels` after it.
fn read_channel(pixels: &[u8], mut at: usize, out: &mut [u8]) -> Result<usize, HdriRefusal> {
    let mut x = 0;
    while x < out.len() {
        let code = *pixels.get(at).ok_or(HdriRefusal::Truncated)?;
        at += 1;
        if code > 128 {
            let count = usize::from(code - 128);
            let value = *pixels.get(at).ok_or(HdriRefusal::Truncated)?;
            at += 1;
            out.get_mut(x..x + count).ok_or(HdriRefusal::BadRle)?.fill(value);
            x += count;
            continue;
        }
        let count = usize::from(code);
        if count == 0 {
            return Err(HdriRefusal::BadRle);
        }
        let run = out.get_mut(x..x + count).ok_or(HdriRefusal::BadRle)?;
        run.copy_from_slice(pixels.get(at..at + count).ok_or(HdriRefusal::Truncated)?);
        at += count;
        x += count;
    }
    Ok(at)
}

/// One run-length row (scanline header, four channels) as RGBE texels into `row`; the position
/// in `pixels` after it.
fn read_run_length_row(pixels: &[u8], at: usize, width: u32, row: &mut [[u8; 4]]) -> Result<usize, HdriRefusal> {
    let header = pixels.get(at..at + 4).ok_or(HdriRefusal::Truncated)?;
    let encoded_width = u32::from(header[2]) << 8 | u32::from(header[3]);
    if header[0] != 2 || header[1] != 2 || header[2] & 0x80 != 0 || encoded_width != width {
        return Err(HdriRefusal::BadRle);
    }
    let mut at = at + 4;
    let mut channel = vec![0u8; row.len()];
    for index in 0..4 {
        at = read_channel(pixels, at, &mut channel)?;
        for (texel, &value) in row.iter_mut().zip(&channel) {
            texel[index] = value;
        }
    }
    Ok(at)
}

/// One flat row of RGBE texels into `row`; the position in `pixels` after it.
fn read_flat_row(pixels: &[u8], at: usize, row: &mut [[u8; 4]]) -> Result<usize, HdriRefusal> {
    let bytes = pixels.get(at..at + row.len() * 4).ok_or(HdriRefusal::Truncated)?;
    let (texels, _) = bytes.as_chunks::<4>();
    row.copy_from_slice(texels);
    Ok(at + row.len() * 4)
}

/// Decode a Radiance `.hdr` file into half-float texels, rows top to bottom. Refuses with a typed
/// [`HdriRefusal`]; the caps and the file's own size are checked before the texels are allocated,
/// and the output never holds a non-finite value.
pub fn decode(bytes: &[u8]) -> Result<HdriImage, HdriRefusal> {
    let header = parse_header(bytes)?;
    let pixels = &bytes[header.pixels..];
    let (width, height) = (header.width, header.height);
    let run_length = is_run_length(width, pixels);
    if (pixels.len() as u64) < minimum_pixel_bytes(width, height, run_length) {
        return Err(HdriRefusal::Truncated);
    }

    let scales = exponent_scales();
    let columns = width as usize;
    let mut texels = vec![[0u16; 4]; columns * height as usize];
    let mut row = vec![[0u8; 4]; columns];
    let mut at = 0;
    for file_row in 0..height as usize {
        at = if run_length { read_run_length_row(pixels, at, width, &mut row)? } else { read_flat_row(pixels, at, &mut row)? };
        let y = if header.bottom_up { height as usize - 1 - file_row } else { file_row };
        let out = &mut texels[y * columns..(y + 1) * columns];
        for (x, &rgbe) in row.iter().enumerate() {
            let column = if header.mirrored { columns - 1 - x } else { x };
            out[column] = texel_from_rgbe(rgbe, &scales);
        }
    }
    Ok(HdriImage { width, height, texels })
}

// ---------------------------------------------------------------------------------------------
// Directions

/// The equirectangular `(u, v)` of a unit direction in the map's frame (see the module docs).
pub fn direction_to_uv(direction: [f32; 3]) -> [f32; 2] {
    let u = libm::atan2f(direction[0], -direction[2]) / std::f32::consts::TAU + 0.5;
    let v = libm::acosf(direction[1].clamp(-1.0, 1.0)) / std::f32::consts::PI;
    [u, v]
}

/// The unit direction of an equirectangular `(u, v)` in the map's frame (see the module docs).
pub fn uv_to_direction(uv: [f32; 2]) -> [f32; 3] {
    let phi = (uv[0] - 0.5) * std::f32::consts::TAU;
    let theta = uv[1] * std::f32::consts::PI;
    let ring = libm::sinf(theta);
    [ring * libm::sinf(phi), libm::cosf(theta), -ring * libm::cosf(phi)]
}

/// `direction` turned `radians` about `+y`, right-handed: `+x` turned a quarter becomes `-z`.
pub fn rotate_about_up(direction: [f32; 3], radians: f32) -> [f32; 3] {
    let (sin, cos) = (libm::sinf(radians), libm::cosf(radians));
    [direction[0] * cos + direction[2] * sin, direction[1], -direction[0] * sin + direction[2] * cos]
}

// ---------------------------------------------------------------------------------------------
// The analytic sun

/// A map's brightest texel must be at least this luminance to be a sun.
pub const SUN_MIN_PEAK: f32 = 32.0;
/// ... and this many times the map's mean luminance (an overcast sky has no sun).
pub const SUN_CONTRAST: f64 = 16.0;
/// The sun's region is the texels connected to the peak within this factor of it.
pub const SUN_REGION_FALLOFF: f32 = 16.0;
/// A region wider than this (steradians, about a 10 degree radius) is a bright sky, not a sun.
pub const SUN_MAX_SOLID_ANGLE: f32 = 0.1;

/// The sun an HDR map holds, for [`crate::settings::HdriSun::Analytic`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnalyticSun {
    /// Unit direction towards the sun, in the map's frame (before its rotation).
    pub direction: [f32; 3],
    /// The sun region's mean radiance above [`AnalyticSun::clamp`] (linear rgb).
    pub radiance: [f32; 3],
    /// What the bake removes from the map and the analytic sun adds: the radiance above the
    /// clamp times each texel's solid angle, summed over the region (linear rgb, the irradiance
    /// on a surface facing the sun).
    pub irradiance: [f32; 3],
    /// The radiance above which a texel is the sun's: the bake clamps every channel of the map
    /// to it.
    pub clamp: f32,
}

impl AnalyticSun {
    /// The sun of a map turned `radians` about the up axis (see [`rotate_about_up`]).
    pub fn rotated(self, radians: f32) -> AnalyticSun {
        AnalyticSun { direction: rotate_about_up(self.direction, radians), ..self }
    }
}

/// Rec. 709 luminance of half-float texel bits (a non-finite texel counts as black).
fn luminance(texel: [u16; 4]) -> f32 {
    let [r, g, b, _] = texel.map(f16_to_f32);
    let value = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if value.is_finite() { value } else { 0.0 }
}

/// The solid angle of each row's texels (equirectangular: the cosine of latitude).
fn row_solid_angles(width: usize, height: usize) -> Vec<f64> {
    let (columns, rows) = (width as f64, height as f64);
    (0..height)
        .map(|y| {
            let theta = (y as f64 + 0.5) / rows * std::f64::consts::PI;
            std::f64::consts::TAU / columns * (std::f64::consts::PI / rows) * libm::sin(theta)
        })
        .collect()
}

/// The texels connected (eight ways, wrapping across the seam) to `start` whose luminance is at
/// least `threshold`, in ascending index order.
fn connected_region(luminances: &[f32], width: usize, height: usize, start: usize, threshold: f32) -> Vec<usize> {
    let mut inside = vec![false; luminances.len()];
    let mut stack = vec![start];
    inside[start] = true;
    while let Some(index) = stack.pop() {
        let (x, y) = (index % width, index / width);
        for dy in [-1i64, 0, 1] {
            let ny = y as i64 + dy;
            if ny < 0 || ny >= height as i64 {
                continue;
            }
            for dx in [-1i64, 0, 1] {
                let nx = (x as i64 + dx).rem_euclid(width as i64) as usize;
                let next = ny as usize * width + nx;
                if !inside[next] && luminances[next] >= threshold {
                    inside[next] = true;
                    stack.push(next);
                }
            }
        }
    }
    inside.iter().enumerate().filter_map(|(index, &member)| member.then_some(index)).collect()
}

/// The brightest region of `image`, found deterministically, or None when nothing stands out (an
/// overcast map, a bright sky, a faint highlight).
///
/// The peak is the brightest texel (the first in row-major order on a tie). It is a sun when its
/// luminance reaches [`SUN_MIN_PEAK`] and [`SUN_CONTRAST`] times the map's solid-angle-weighted
/// mean. The region is the texels connected to the peak within [`SUN_REGION_FALLOFF`] of it; a
/// region over [`SUN_MAX_SOLID_ANGLE`] is a bright sky and no sun. The clamp is the region's
/// threshold: the bake clamps every channel of every texel to it, and the sun takes back the
/// excess of the region, in the direction of its power-weighted centroid. Other bright texels
/// are clamped without being given back (a firefly is not a light).
pub fn analytic_sun(image: &HdriImage) -> Option<AnalyticSun> {
    let (width, height) = (image.width as usize, image.height as usize);
    if width == 0 || height == 0 || image.texels.len() != width * height {
        return None;
    }
    let solid_angles = row_solid_angles(width, height);
    let luminances: Vec<f32> = image.texels.iter().map(|&texel| luminance(texel)).collect();

    let (mut peak, mut peak_at) = (0.0f32, 0usize);
    let (mut power, mut sphere) = (0.0f64, 0.0f64);
    for (index, &value) in luminances.iter().enumerate() {
        let solid_angle = solid_angles[index / width];
        power += f64::from(value) * solid_angle;
        sphere += solid_angle;
        if value > peak {
            (peak, peak_at) = (value, index);
        }
    }
    let mean = power / sphere;
    if peak < SUN_MIN_PEAK || f64::from(peak) < SUN_CONTRAST * mean {
        return None;
    }

    let clamp = peak / SUN_REGION_FALLOFF;
    let region = connected_region(&luminances, width, height, peak_at, clamp);
    let region_angle: f64 = region.iter().map(|&index| solid_angles[index / width]).sum();
    if region_angle > f64::from(SUN_MAX_SOLID_ANGLE) {
        return None;
    }

    let mut irradiance = [0.0f64; 3];
    let mut centroid = [0.0f64; 3];
    for &index in &region {
        let solid_angle = solid_angles[index / width];
        let excess = image.texels[index].map(|bits| (f64::from(f16_to_f32(bits)) - f64::from(clamp)).max(0.0));
        let weight = (0.2126 * excess[0] + 0.7152 * excess[1] + 0.0722 * excess[2]) * solid_angle;
        let uv = [((index % width) as f32 + 0.5) / width as f32, ((index / width) as f32 + 0.5) / height as f32];
        let direction = uv_to_direction(uv);
        for channel in 0..3 {
            irradiance[channel] += excess[channel] * solid_angle;
            centroid[channel] += f64::from(direction[channel]) * weight;
        }
    }
    let length = libm::sqrt(centroid.iter().map(|c| c * c).sum());
    let direction = if length > 0.0 {
        centroid.map(|c| (c / length) as f32)
    } else {
        let at = peak_at;
        uv_to_direction([((at % width) as f32 + 0.5) / width as f32, ((at / width) as f32 + 0.5) / height as f32])
    };
    Some(AnalyticSun {
        direction,
        radiance: irradiance.map(|e| (e / region_angle) as f32),
        irradiance: irradiance.map(|e| e as f32),
        clamp,
    })
}

// ---------------------------------------------------------------------------------------------
// Preparing a map for a device

/// A decoded map ready to upload on one device: at most that device's width
/// (`presets::hdri_map_width`), box-filtered down from the decoded map, with the analytic sun
/// found on the full map (a sun a few texels wide would blur away in a smaller one).
#[derive(Clone, Debug, PartialEq)]
pub struct PreparedMap {
    /// The map to upload.
    pub image: HdriImage,
    /// The full map's sun, if it has one ([`analytic_sun`]).
    pub sun: Option<AnalyticSun>,
}

/// `image` prepared for a device that keeps maps at most `max_width` texels wide (0: no cap):
/// its sun found first, then halved with a 2 × 2 box filter until it fits.
pub fn prepare_map(image: &HdriImage, max_width: u32) -> PreparedMap {
    let sun = analytic_sun(image);
    let mut prepared = image.clone();
    while max_width > 0 && prepared.width > max_width && prepared.width > 1 && prepared.height > 1 {
        prepared = halved(&prepared);
    }
    PreparedMap { image: prepared, sun }
}

/// `image` at half its size, each texel the mean of the 2 × 2 above it (an odd last row or column
/// is dropped).
fn halved(image: &HdriImage) -> HdriImage {
    let (width, height) = ((image.width / 2).max(1), (image.height / 2).max(1));
    let source = image.width as usize;
    let texel = |x: u32, y: u32| image.texels[y as usize * source + x as usize].map(f16_to_f32);
    let texels = (0..height)
        .flat_map(|y| (0..width).map(move |x| (x, y)))
        .map(|(x, y)| {
            let [a, b, c, d] = [texel(2 * x, 2 * y), texel(2 * x + 1, 2 * y), texel(2 * x, 2 * y + 1), texel(2 * x + 1, 2 * y + 1)];
            let mean = |channel: usize| (a[channel] + b[channel] + c[channel] + d[channel]) * 0.25;
            [f32_to_f16(mean(0)), f32_to_f16(mean(1)), f32_to_f16(mean(2)), f32_to_f16(1.0)]
        })
        .collect();
    HdriImage { width, height, texels }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_caps_refuse_empty_and_oversize_maps_before_decoding() {
        assert_eq!(fits_caps(0, 16), Err(HdriRefusal::Empty));
        assert_eq!(fits_caps(64, 0), Err(HdriRefusal::Empty));
        assert_eq!(fits_caps(8192, 4096), Err(HdriRefusal::TooLarge { width: 8192, height: 4096 }));
        assert_eq!(fits_caps(HDRI_MAX_WIDTH, HDRI_MAX_HEIGHT), Ok(()), "the cap itself fits (exactly 64 MB)");
        assert_eq!(fits_caps(64, 32), Ok(()));
        assert_eq!(decode(b"#?RADIANCE\n"), Err(HdriRefusal::Truncated), "a header with nothing after it");
        assert_eq!(HdriRefusal::TooLarge { width: 1, height: 1 }.wire(), "hdri-too-large");
    }

    #[test]
    fn the_exponent_table_is_exact_powers_of_two() {
        let scales = exponent_scales();
        assert_eq!(scales[0], 0.0);
        assert_eq!(scales[136], 1.0);
        assert_eq!(scales[137], 2.0);
        assert_eq!(scales[128], 0.003_906_25, "2^-8");
    }
}
