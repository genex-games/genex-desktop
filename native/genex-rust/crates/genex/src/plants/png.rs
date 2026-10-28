//! A small PNG writer for the plants' textures: RGBA8, each row filtered `Up` or `Sub` (whichever
//! sums smaller), deflated with fixed Huffman codes over a hash-chained LZ77 window. A pure
//! function of the pixels (no clock, no platform), so the same plant writes the same bytes on every
//! destination; no crate beyond std.

/// The LZ77 window (deflate's largest).
const WINDOW: usize = 32 * 1024;
/// The longest and shortest match deflate codes.
const MATCH_MAX: usize = 258;
const MATCH_MIN: usize = 3;
/// How many earlier positions a match search walks back through.
const CHAIN_DEPTH: usize = 24;
/// Bits of the three-byte hash.
const HASH_BITS: u32 = 15;

/// The PNG of `rgba` (`width` × `height` texels, four bytes each, rows top first).
pub(crate) fn encode_rgba(rgba: &[u8], width: u32, height: u32) -> Vec<u8> {
    let stride = width as usize * 4;
    let mut filtered = Vec::with_capacity((stride + 1) * height as usize);
    let mut row_up = vec![0u8; stride];
    let mut row_sub = vec![0u8; stride];
    for y in 0..height as usize {
        let row = &rgba[y * stride..(y + 1) * stride];
        let above = if y == 0 { None } else { Some(&rgba[(y - 1) * stride..y * stride]) };
        for x in 0..stride {
            row_up[x] = row[x].wrapping_sub(above.map_or(0, |above| above[x]));
            row_sub[x] = row[x].wrapping_sub(if x >= 4 { row[x - 4] } else { 0 });
        }
        let cost = |bytes: &[u8]| bytes.iter().map(|&b| u64::from((b as i8).unsigned_abs())).sum::<u64>();
        let (kind, bytes) = if cost(&row_up) <= cost(&row_sub) { (2u8, &row_up) } else { (1u8, &row_sub) };
        filtered.push(kind);
        filtered.extend_from_slice(bytes);
    }
    let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
    let mut header = Vec::with_capacity(13);
    header.extend(width.to_be_bytes());
    header.extend(height.to_be_bytes());
    header.extend([8, 6, 0, 0, 0]);
    chunk(&mut png, b"IHDR", &header);
    chunk(&mut png, b"IDAT", &zlib(&filtered));
    chunk(&mut png, b"IEND", &[]);
    png
}

/// One PNG chunk: length, type, data, CRC of type and data.
fn chunk(out: &mut Vec<u8>, kind: &[u8; 4], data: &[u8]) {
    out.extend((data.len() as u32).to_be_bytes());
    let start = out.len();
    out.extend(kind);
    out.extend(data);
    let crc = crc32(&out[start..]);
    out.extend(crc.to_be_bytes());
}

/// CRC-32 (ISO 3309), bitwise.
fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for &byte in bytes {
        crc ^= u32::from(byte);
        for _ in 0..8 {
            crc = if crc & 1 != 0 { (crc >> 1) ^ 0xedb8_8320 } else { crc >> 1 };
        }
    }
    !crc
}

/// Adler-32.
fn adler32(bytes: &[u8]) -> u32 {
    let (mut a, mut b) = (1u32, 0u32);
    for chunk in bytes.chunks(5552) {
        for &byte in chunk {
            a += u32::from(byte);
            b += a;
        }
        a %= 65521;
        b %= 65521;
    }
    (b << 16) | a
}

/// LSB-first bit writer.
struct Bits {
    out: Vec<u8>,
    word: u64,
    count: u32,
}

impl Bits {
    fn put(&mut self, value: u32, bits: u32) {
        self.word |= u64::from(value) << self.count;
        self.count += bits;
        while self.count >= 8 {
            self.out.push(self.word as u8);
            self.word >>= 8;
            self.count -= 8;
        }
    }

    /// A Huffman code, most significant bit first.
    fn code(&mut self, code: u32, bits: u32) {
        let reversed = code.reverse_bits() >> (32 - bits);
        self.put(reversed, bits);
    }

    fn finish(mut self) -> Vec<u8> {
        if self.count > 0 {
            self.out.push(self.word as u8);
        }
        self.out
    }
}

/// A literal or length symbol's fixed Huffman code.
fn literal(bits: &mut Bits, symbol: u32) {
    match symbol {
        0..=143 => bits.code(0x30 + symbol, 8),
        144..=255 => bits.code(0x190 + symbol - 144, 9),
        256..=279 => bits.code(symbol - 256, 7),
        _ => bits.code(0xc0 + symbol - 280, 8),
    }
}

/// Deflate's length codes: (base, extra bits) for symbols 257..=285.
const LENGTHS: [(u32, u32); 29] = [
    (3, 0), (4, 0), (5, 0), (6, 0), (7, 0), (8, 0), (9, 0), (10, 0), (11, 1), (13, 1), (15, 1), (17, 1), (19, 2), (23, 2), (27, 2),
    (31, 2), (35, 3), (43, 3), (51, 3), (59, 3), (67, 4), (83, 4), (99, 4), (115, 4), (131, 5), (163, 5), (195, 5), (227, 5), (258, 0),
];
/// Deflate's distance codes: (base, extra bits) for symbols 0..=29.
const DISTANCES: [(u32, u32); 30] = [
    (1, 0), (2, 0), (3, 0), (4, 0), (5, 1), (7, 1), (9, 2), (13, 2), (17, 3), (25, 3), (33, 4), (49, 4), (65, 5), (97, 5), (129, 6),
    (193, 6), (257, 7), (385, 7), (513, 8), (769, 8), (1025, 9), (1537, 9), (2049, 10), (3073, 10), (4097, 11), (6145, 11), (8193, 12),
    (12289, 12), (16385, 13), (24577, 13),
];

fn length_code(bits: &mut Bits, length: u32) {
    let at = LENGTHS.iter().rposition(|(base, _)| *base <= length).unwrap_or(0);
    let (base, extra) = LENGTHS[at];
    literal(bits, 257 + at as u32);
    bits.put(length - base, extra);
}

fn distance_code(bits: &mut Bits, distance: u32) {
    let at = DISTANCES.iter().rposition(|(base, _)| *base <= distance).unwrap_or(0);
    let (base, extra) = DISTANCES[at];
    bits.code(at as u32, 5);
    bits.put(distance - base, extra);
}

fn hash3(data: &[u8], at: usize) -> usize {
    let value = u32::from(data[at]) | u32::from(data[at + 1]) << 8 | u32::from(data[at + 2]) << 16;
    (value.wrapping_mul(0x9e37_79b1) >> (32 - HASH_BITS)) as usize
}

/// The longest match for `at` among the chained earlier positions: (length, distance).
fn longest(data: &[u8], at: usize, head: &[u32], prev: &[u32]) -> (usize, usize) {
    let limit = (data.len() - at).min(MATCH_MAX);
    let mut best = (0, 0);
    let mut candidate = head[hash3(data, at)];
    for _ in 0..CHAIN_DEPTH {
        if candidate == u32::MAX {
            break;
        }
        let from = candidate as usize;
        if at - from > WINDOW {
            break;
        }
        let length = data[from..].iter().zip(&data[at..at + limit]).take_while(|(a, b)| a == b).count();
        if length > best.0 {
            best = (length, at - from);
            if length == limit {
                break;
            }
        }
        candidate = prev[from % WINDOW];
    }
    best
}

/// A zlib stream of `data`: one final block of fixed Huffman codes.
fn zlib(data: &[u8]) -> Vec<u8> {
    let mut bits = Bits { out: vec![0x78, 0x01], word: 0, count: 0 };
    bits.put(1, 1);
    bits.put(1, 2);
    let mut head = vec![u32::MAX; 1 << HASH_BITS];
    let mut prev = vec![u32::MAX; WINDOW];
    let mut insert = |head: &mut [u32], prev: &mut [u32], at: usize| {
        if at + MATCH_MIN <= data.len() {
            let h = hash3(data, at);
            prev[at % WINDOW] = head[h];
            head[h] = at as u32;
        }
    };
    let mut at = 0;
    while at < data.len() {
        let (length, distance) = if at + MATCH_MIN <= data.len() { longest(data, at, &head, &prev) } else { (0, 0) };
        if length >= MATCH_MIN {
            length_code(&mut bits, length as u32);
            distance_code(&mut bits, distance as u32);
            for step in at..at + length {
                insert(&mut head, &mut prev, step);
            }
            at += length;
        } else {
            literal(&mut bits, u32::from(data[at]));
            insert(&mut head, &mut prev, at);
            at += 1;
        }
    }
    literal(&mut bits, 256);
    let mut out = bits.finish();
    out.extend(adler32(data).to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_png_decodes_to_the_pixels_it_was_made_from() {
        let (width, height) = (67u32, 41u32);
        let mut rgba = Vec::new();
        for y in 0..height {
            for x in 0..width {
                // Runs (to match), gradients (to filter) and noise (literals).
                let noise = (x.wrapping_mul(2_654_435_761) ^ y.wrapping_mul(40_503)) as u8;
                rgba.extend([(x * 3) as u8, if x % 9 < 5 { 200 } else { 10 }, noise, (y * 6) as u8]);
            }
        }
        let png = encode_rgba(&rgba, width, height);
        let decoded = genex_render::mesh::decode_image(&png).expect("a PNG the renderer reads");
        assert_eq!((decoded.width(), decoded.height()), (width, height));
        assert_eq!(decoded.rgba(), &rgba[..], "lossless");
        assert_eq!(png, encode_rgba(&rgba, width, height), "the same pixels write the same bytes");
    }

    #[test]
    fn a_flat_image_compresses() {
        let rgba = vec![90u8; 256 * 256 * 4];
        let png = encode_rgba(&rgba, 256, 256);
        assert!(png.len() < rgba.len() / 50, "{} bytes for a flat 256² image", png.len());
        let decoded = genex_render::mesh::decode_image(&png).expect("decodes");
        assert_eq!(decoded.rgba(), &rgba[..]);
    }
}
