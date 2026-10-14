//! The designed refusal screen for a GPU below WebGPU core (or one without a native-enhanced
//! feature the game declares), drawn without wgpu: the shell cannot
//! trust the GPU it just refused, so the screen is an RGBA image rendered on the CPU from a small
//! built-in bitmap font ([`render`]) and written into the platform's window buffer in its pixel
//! layout ([`encode_into`]). On Android the shell locks the `ANativeWindow` and blits it (no
//! swapchain was ever made on it); on iOS it is a CoreGraphics image on a layer over the window's
//! view (`refusal_layer`); the typed `gpu-unsupported` record is written beside it.
//!
//! The words are fixed and short (the code names the refusal for support), in capitals so the
//! font stays a few dozen glyphs.

use genex_render::RenderCode;

/// A screen's lines, top to bottom; the last is the typed code.
pub type RefusalLines = [&'static str; 3];
/// The screen for a GPU below WebGPU core (`gpu-unsupported`).
pub const REFUSAL_LINES: RefusalLines = ["THIS GAME CAN'T RUN ON THIS DEVICE", "ITS GPU IS BELOW WEBGPU CORE", "GPU-UNSUPPORTED"];
/// The screen for a GPU without a native-enhanced feature the game declares
/// (`native-feature-missing`).
pub const FEATURE_MISSING_LINES: RefusalLines =
    ["THIS GAME CAN'T RUN ON THIS DEVICE", "ITS GPU LACKS A FEATURE THE GAME NEEDS", "NATIVE-FEATURE-MISSING"];

/// The screen a refusal shows, when it is one the device will always give: below core, or a
/// declared feature it lacks. Anything else (a failed device request, a renderer refusal) is no
/// verdict on the device and shows none.
pub fn lines_for(code: RenderCode) -> Option<RefusalLines> {
    match code {
        RenderCode::GpuUnsupported => Some(REFUSAL_LINES),
        RenderCode::NativeFeatureMissing => Some(FEATURE_MISSING_LINES),
        _ => None,
    }
}

/// The background colour (RGBA).
pub const BACKGROUND: [u8; 4] = [16, 18, 24, 255];
/// The message colour.
pub const INK: [u8; 4] = [236, 238, 242, 255];
/// The code's colour, quieter than the message.
pub const CODE_INK: [u8; 4] = [150, 156, 168, 255];
/// The largest screen rendered, in pixels (an 8K panel); a larger window gets no screen.
pub const MAX_REFUSAL_PIXELS: u64 = 7680 * 4320;

/// Glyph cell: 5 columns by 7 rows, one column and two rows of spacing.
const GLYPH_WIDTH: u32 = 5;
const GLYPH_HEIGHT: u32 = 7;
const ADVANCE: u32 = GLYPH_WIDTH + 1;
const LINE_ADVANCE: u32 = GLYPH_HEIGHT + 4;
/// The text block's share of the screen width and height, at most.
const TEXT_WIDTH_SHARE: f32 = 0.85;
const TEXT_HEIGHT_SHARE: f32 = 0.5;

/// A glyph's seven rows, five bits each (bit 4 is the left column).
type Glyph = [u8; 7];

/// The font: every character the lines use, and the rest of A-Z and 0-9.
const FONT: [(char, Glyph); 41] = [
    ('A', [0b01110, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001]),
    ('B', [0b11110, 0b10001, 0b10001, 0b11110, 0b10001, 0b10001, 0b11110]),
    ('C', [0b01110, 0b10001, 0b10000, 0b10000, 0b10000, 0b10001, 0b01110]),
    ('D', [0b11110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b11110]),
    ('E', [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b11111]),
    ('F', [0b11111, 0b10000, 0b10000, 0b11110, 0b10000, 0b10000, 0b10000]),
    ('G', [0b01110, 0b10001, 0b10000, 0b10111, 0b10001, 0b10001, 0b01111]),
    ('H', [0b10001, 0b10001, 0b10001, 0b11111, 0b10001, 0b10001, 0b10001]),
    ('I', [0b01110, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110]),
    ('J', [0b00111, 0b00010, 0b00010, 0b00010, 0b00010, 0b10010, 0b01100]),
    ('K', [0b10001, 0b10010, 0b10100, 0b11000, 0b10100, 0b10010, 0b10001]),
    ('L', [0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b10000, 0b11111]),
    ('M', [0b10001, 0b11011, 0b10101, 0b10101, 0b10001, 0b10001, 0b10001]),
    ('N', [0b10001, 0b10001, 0b11001, 0b10101, 0b10011, 0b10001, 0b10001]),
    ('O', [0b01110, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110]),
    ('P', [0b11110, 0b10001, 0b10001, 0b11110, 0b10000, 0b10000, 0b10000]),
    ('Q', [0b01110, 0b10001, 0b10001, 0b10001, 0b10101, 0b10010, 0b01101]),
    ('R', [0b11110, 0b10001, 0b10001, 0b11110, 0b10100, 0b10010, 0b10001]),
    ('S', [0b01111, 0b10000, 0b10000, 0b01110, 0b00001, 0b00001, 0b11110]),
    ('T', [0b11111, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100, 0b00100]),
    ('U', [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01110]),
    ('V', [0b10001, 0b10001, 0b10001, 0b10001, 0b10001, 0b01010, 0b00100]),
    ('W', [0b10001, 0b10001, 0b10001, 0b10101, 0b10101, 0b10101, 0b01010]),
    ('X', [0b10001, 0b10001, 0b01010, 0b00100, 0b01010, 0b10001, 0b10001]),
    ('Y', [0b10001, 0b10001, 0b01010, 0b00100, 0b00100, 0b00100, 0b00100]),
    ('Z', [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b10000, 0b11111]),
    ('0', [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110]),
    ('1', [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110]),
    ('2', [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111]),
    ('3', [0b11111, 0b00010, 0b00100, 0b00010, 0b00001, 0b10001, 0b01110]),
    ('4', [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010]),
    ('5', [0b11111, 0b10000, 0b11110, 0b00001, 0b00001, 0b10001, 0b01110]),
    ('6', [0b00110, 0b01000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110]),
    ('7', [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000]),
    ('8', [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110]),
    ('9', [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00010, 0b01100]),
    (' ', [0; 7]),
    ('\'', [0b00100, 0b00100, 0b01000, 0, 0, 0, 0]),
    ('-', [0, 0, 0, 0b11111, 0, 0, 0]),
    ('.', [0, 0, 0, 0, 0, 0b01100, 0b01100]),
    (':', [0, 0b01100, 0b01100, 0, 0b01100, 0b01100, 0]),
];

fn glyph(c: char) -> Option<Glyph> {
    FONT.iter().find(|(known, _)| *known == c).map(|(_, rows)| *rows)
}

/// A rendered screen: `width` x `height` RGBA pixels, rows top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RefusalImage {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// RGBA bytes, `width * height * 4`.
    pub rgba: Vec<u8>,
}

impl RefusalImage {
    /// The pixel at (`x`, `y`).
    pub fn pixel(&self, x: u32, y: u32) -> [u8; 4] {
        let at = ((y as usize * self.width as usize) + x as usize) * 4;
        [self.rgba[at], self.rgba[at + 1], self.rgba[at + 2], self.rgba[at + 3]]
    }

    fn put(&mut self, x: u32, y: u32, colour: [u8; 4]) {
        if x < self.width && y < self.height {
            let at = ((y as usize * self.width as usize) + x as usize) * 4;
            self.rgba[at..at + 4].copy_from_slice(&colour);
        }
    }
}

/// The scale `lines` are drawn at in a `width` x `height` screen: the largest whole number that
/// keeps the text block inside its share of the screen, at least 1.
pub fn text_scale(width: u32, height: u32, lines: &RefusalLines) -> u32 {
    let longest = lines.iter().map(|line| line.chars().count() as u32).max().unwrap_or(1);
    let block_width = (longest * ADVANCE).saturating_sub(1).max(1);
    let block_height = lines.len() as u32 * LINE_ADVANCE;
    let by_width = (width as f32 * TEXT_WIDTH_SHARE) as u32 / block_width;
    let by_height = (height as f32 * TEXT_HEIGHT_SHARE) as u32 / block_height;
    by_width.min(by_height).max(1)
}

/// The refusal screen saying `lines` in a `width` x `height` window, or `None` for an empty or
/// oversized one.
pub fn render(width: u32, height: u32, lines: &RefusalLines) -> Option<RefusalImage> {
    let pixels = u64::from(width) * u64::from(height);
    if pixels == 0 || pixels > MAX_REFUSAL_PIXELS {
        return None;
    }
    let mut image = RefusalImage { width, height, rgba: BACKGROUND.repeat(pixels as usize) };
    let scale = text_scale(width, height, lines);
    let block_height = lines.len() as u32 * LINE_ADVANCE * scale;
    let top = height.saturating_sub(block_height) / 2;
    for (row, line) in lines.iter().enumerate() {
        let ink = if row + 1 == lines.len() { CODE_INK } else { INK };
        let line_width = (line.chars().count() as u32 * ADVANCE).saturating_sub(1) * scale;
        let left = width.saturating_sub(line_width) / 2;
        let y = top + row as u32 * LINE_ADVANCE * scale;
        draw_line(&mut image, line, (left, y), scale, ink);
    }
    Some(image)
}

fn draw_line(image: &mut RefusalImage, line: &str, (left, top): (u32, u32), scale: u32, ink: [u8; 4]) {
    for (column, c) in line.chars().enumerate() {
        let Some(rows) = glyph(c) else { continue };
        let x0 = left + column as u32 * ADVANCE * scale;
        for (gy, bits) in rows.iter().enumerate() {
            for gx in 0..GLYPH_WIDTH {
                if bits & (1 << (GLYPH_WIDTH - 1 - gx)) == 0 {
                    continue;
                }
                fill(image, (x0 + gx * scale, top + gy as u32 * scale), scale, ink);
            }
        }
    }
}

fn fill(image: &mut RefusalImage, (x, y): (u32, u32), scale: u32, ink: [u8; 4]) {
    for dy in 0..scale {
        for dx in 0..scale {
            image.put(x + dx, y + dy, ink);
        }
    }
}

/// A window buffer's pixel layout (Android's `ANativeWindow` formats a CPU can lock).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PixelLayout {
    /// 4 bytes, R G B A.
    Rgba8888,
    /// 4 bytes, R G B and an ignored byte.
    Rgbx8888,
    /// 2 bytes, little-endian RGB 5-6-5.
    Rgb565,
}

impl PixelLayout {
    /// Bytes per pixel.
    pub const fn bytes(self) -> usize {
        match self {
            PixelLayout::Rgba8888 | PixelLayout::Rgbx8888 => 4,
            PixelLayout::Rgb565 => 2,
        }
    }
}

/// One RGBA pixel in `layout`'s bytes.
fn encode_pixel(rgba: [u8; 4], layout: PixelLayout, out: &mut [u8]) {
    match layout {
        PixelLayout::Rgba8888 | PixelLayout::Rgbx8888 => out.copy_from_slice(&rgba),
        PixelLayout::Rgb565 => {
            let packed = (u16::from(rgba[0] >> 3) << 11) | (u16::from(rgba[1] >> 2) << 5) | u16::from(rgba[2] >> 3);
            out.copy_from_slice(&packed.to_le_bytes());
        }
    }
}

/// Write `image` into a locked buffer of `layout` whose rows are `stride` pixels apart; rows and
/// columns beyond the buffer are cut, padding between rows is left alone. Answers whether the
/// buffer could hold at least one pixel.
pub fn encode_into(image: &RefusalImage, layout: PixelLayout, size: (u32, u32), stride: u32, out: &mut [u8]) -> bool {
    let bytes = layout.bytes();
    let (width, height) = (size.0.min(image.width).min(stride), size.1.min(image.height));
    let mut wrote = false;
    for y in 0..height {
        let row = y as usize * stride as usize * bytes;
        for x in 0..width {
            let at = row + x as usize * bytes;
            let Some(slot) = out.get_mut(at..at + bytes) else { return wrote };
            encode_pixel(image.pixel(x, y), layout, slot);
            wrote = true;
        }
    }
    wrote
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_font_has_every_character_the_screen_says() {
        for lines in [REFUSAL_LINES, FEATURE_MISSING_LINES] {
            for c in lines.iter().flat_map(|line| line.chars()) {
                assert!(glyph(c).is_some(), "no glyph for {c:?}");
            }
        }
        assert_eq!(REFUSAL_LINES.last(), Some(&"GPU-UNSUPPORTED"), "the typed code, as support reads it");
        assert_eq!(FEATURE_MISSING_LINES.last(), Some(&"NATIVE-FEATURE-MISSING"));
    }

    #[test]
    fn only_a_verdict_on_the_device_shows_a_screen_and_each_names_its_own_code() {
        assert_eq!(lines_for(RenderCode::GpuUnsupported), Some(REFUSAL_LINES));
        assert_eq!(lines_for(RenderCode::NativeFeatureMissing), Some(FEATURE_MISSING_LINES));
        for transient in [RenderCode::DeviceFailed, RenderCode::DeviceLost, RenderCode::TextureTooLarge, RenderCode::MeshInvalid] {
            assert_eq!(lines_for(transient), None, "{transient:?} is no verdict on the device");
        }
        for code in [RenderCode::GpuUnsupported, RenderCode::NativeFeatureMissing] {
            let lines = lines_for(code).expect("a screen");
            assert_eq!(lines[2], code.wire().to_uppercase(), "the screen's code line is the record's code");
        }
    }

    #[test]
    fn a_phone_screen_shows_the_lines_centred_on_the_background() {
        let image = render(1080, 2400, &REFUSAL_LINES).expect("a phone screen");
        assert_eq!(image.rgba.len(), 1080 * 2400 * 4);
        for (x, y) in [(0, 0), (1079, 0), (0, 2399), (1079, 2399)] {
            assert_eq!(image.pixel(x, y), BACKGROUND, "corner {x},{y}");
        }
        let inked: Vec<(u32, u32)> =
            (0..2400).flat_map(|y| (0..1080).map(move |x| (x, y))).filter(|(x, y)| image.pixel(*x, *y) == INK).collect();
        assert!(!inked.is_empty());
        let (min_x, max_x) = (inked.iter().map(|p| p.0).min().unwrap_or(0), inked.iter().map(|p| p.0).max().unwrap_or(0));
        let scale = text_scale(1080, 2400, &REFUSAL_LINES);
        assert!(scale >= 4, "readable on a phone: scale {scale}");
        assert!((min_x as i64 - (1079 - max_x) as i64).abs() <= i64::from(scale) * 2, "centred: {min_x}..{max_x}");
        let code_rows = (0..2400).filter(|y| (0..1080).any(|x| image.pixel(x, *y) == CODE_INK)).count();
        assert_eq!(code_rows as u32, GLYPH_HEIGHT * scale, "the code is one line of glyphs, quieter than the message");
    }

    #[test]
    fn empty_tiny_and_oversized_windows_never_panic() {
        assert!(render(0, 100, &REFUSAL_LINES).is_none());
        assert!(render(100_000, 100_000, &REFUSAL_LINES).is_none());
        let tiny = render(1, 1, &REFUSAL_LINES).expect("one pixel");
        assert_eq!(tiny.rgba.len(), 4);
        assert_eq!(text_scale(1, 1, &REFUSAL_LINES), 1);
    }

    #[test]
    fn the_image_is_written_in_the_window_s_layout_and_stride() {
        let image = RefusalImage { width: 2, height: 2, rgba: [INK, BACKGROUND, BACKGROUND, [255, 255, 255, 255]].concat() };
        let mut rgba = vec![0xAA_u8; 3 * 2 * 4];
        assert!(encode_into(&image, PixelLayout::Rgba8888, (2, 2), 3, &mut rgba));
        assert_eq!(&rgba[0..4], &INK);
        assert_eq!(&rgba[8..12], &[0xAA; 4], "row padding untouched");
        assert_eq!(&rgba[16..20], &[255, 255, 255, 255]);
        let mut rgb565 = vec![0_u8; 2 * 2 * 2];
        assert!(encode_into(&image, PixelLayout::Rgb565, (2, 2), 2, &mut rgb565));
        assert_eq!(&rgb565[6..8], &[0xFF, 0xFF], "white in 5-6-5");
        let mut short = vec![0_u8; 4];
        assert!(encode_into(&image, PixelLayout::Rgbx8888, (2, 2), 2, &mut short), "a short buffer is cut, not overrun");
        assert!(!encode_into(&image, PixelLayout::Rgba8888, (2, 2), 2, &mut []));
    }
}
