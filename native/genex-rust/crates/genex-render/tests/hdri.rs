//! RQ2.3: HDR environment maps from assets. The Radiance `.hdr` parser (RGBE, flat and
//! run-length encoded) refuses every hostile file with a typed code before anything beyond the
//! caps is allocated, a synthetic map round-trips within half-float precision, and the analytic
//! sun is found deterministically. Every map but the showcase's is written by this test.
//!
//! All rows are CPU rows and run on every host; no GPU is touched.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::path::PathBuf;

use genex_render::hdri::{
    AnalyticSun, HDRI_MAX_DECODED_BYTES, HDRI_MAX_HEIGHT, HDRI_MAX_WIDTH, HdriImage, HdriRefusal, SUN_MAX_SOLID_ANGLE, analytic_sun,
    decode, direction_to_uv, rotate_about_up, uv_to_direction,
};
use genex_render::post::tonemap::{f16_to_f32, f32_to_f16};

// ---------------------------------------------------------------------------------------------
// A counting allocator: the hostile rows prove no allocation beyond a few kilobytes happens
// before a refusal. Counted per thread, so the parallel test threads do not see each other.

thread_local! {
    static LIVE: Cell<isize> = const { Cell::new(0) };
    static PEAK: Cell<isize> = const { Cell::new(0) };
}

struct Counting;

// SAFETY: forwards every call to the system allocator and only adds to thread-local counters.
#[allow(unsafe_code)]
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let live = LIVE.with(|live| {
            live.set(live.get() + layout.size() as isize);
            live.get()
        });
        PEAK.with(|peak| peak.set(peak.get().max(live)));
        unsafe { System.alloc(layout) }
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        LIVE.with(|live| live.set(live.get() - layout.size() as isize));
        unsafe { System.dealloc(ptr, layout) }
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        let live = LIVE.with(|live| {
            live.set(live.get() + new_size as isize - layout.size() as isize);
            live.get()
        });
        PEAK.with(|peak| peak.set(peak.get().max(live)));
        unsafe { System.realloc(ptr, layout, new_size) }
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// The most bytes `work` held live above its start, on this thread.
fn peak_bytes<T>(work: impl FnOnce() -> T) -> (T, usize) {
    let start = LIVE.with(Cell::get);
    PEAK.with(|peak| peak.set(start));
    let value = work();
    let peak = PEAK.with(Cell::get);
    (value, (peak - start).max(0) as usize)
}

/// Half floats hold 11 significant bits.
const HALF_RELATIVE_PRECISION: f32 = 1.0 / 2048.0;

/// What a refused file may allocate while it is being refused (headers, error values).
const REFUSAL_ALLOCATION_MAX: usize = 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Test-side Radiance encoder

/// Radiance's `float2rgbe`: the shared-exponent bytes of a linear rgb.
fn rgbe(rgb: [f32; 3]) -> [u8; 4] {
    let biggest = rgb[0].max(rgb[1]).max(rgb[2]);
    if biggest < 1.0e-32 {
        return [0, 0, 0, 0];
    }
    let mut exponent = 0i32;
    let mut scale = 1.0f64;
    // frexp by hand: biggest = mantissa * 2^exponent with mantissa in [0.5, 1).
    while f64::from(biggest) / scale >= 1.0 {
        scale *= 2.0;
        exponent += 1;
    }
    while f64::from(biggest) / scale < 0.5 {
        scale /= 2.0;
        exponent -= 1;
    }
    let factor = 256.0 / scale;
    let byte = |value: f32| (f64::from(value) * factor).floor().clamp(0.0, 255.0) as u8;
    [byte(rgb[0]), byte(rgb[1]), byte(rgb[2]), (exponent + 128) as u8]
}

/// How a row of pixels is laid out in the file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rows {
    Flat,
    Rle,
}

/// The new-style run-length encoding of one channel of `row`.
fn rle_channel(out: &mut Vec<u8>, values: &[u8]) {
    let mut at = 0;
    while at < values.len() {
        let mut run = 1;
        while at + run < values.len() && values[at + run] == values[at] && run < 127 {
            run += 1;
        }
        if run >= 3 {
            out.push(128 + run as u8);
            out.push(values[at]);
            at += run;
            continue;
        }
        // A literal chunk up to the next run of three or 128 bytes.
        let mut end = at + 1;
        while end < values.len() && end - at < 128 {
            let ahead = values[end..].iter().take(3).take_while(|&&v| v == values[end]).count();
            if ahead >= 3 {
                break;
            }
            end += 1;
        }
        out.push((end - at) as u8);
        out.extend_from_slice(&values[at..end]);
        at = end;
    }
}

/// The pixel bytes of `width × height` texels (row 0 = top).
fn pixel_bytes(width: u32, height: u32, texels: &[[f32; 3]], layout: Rows) -> Vec<u8> {
    let mut out = Vec::new();
    for row in 0..height as usize {
        let pixels: Vec<[u8; 4]> = (0..width as usize).map(|x| rgbe(texels[row * width as usize + x])).collect();
        if layout == Rows::Flat {
            out.extend(pixels.iter().flatten());
            continue;
        }
        out.extend_from_slice(&[2, 2, (width >> 8) as u8, (width & 0xff) as u8]);
        for channel in 0..4 {
            let values: Vec<u8> = pixels.iter().map(|p| p[channel]).collect();
            rle_channel(&mut out, &values);
        }
    }
    out
}

/// A `.hdr` file of `width × height` linear rgb texels (row 0 = top), with the header lines in
/// `extra` (each line ending in a newline) between the format line and the blank line.
fn file(width: u32, height: u32, texels: &[[f32; 3]], layout: Rows, extra: &str, resolution: &str) -> Vec<u8> {
    let mut out = format!("#?RADIANCE\n# written by the test\nFORMAT=32-bit_rle_rgbe\n{extra}\n{resolution}\n").into_bytes();
    out.extend(pixel_bytes(width, height, texels, layout));
    out
}

fn standard(width: u32, height: u32, texels: &[[f32; 3]], layout: Rows) -> Vec<u8> {
    file(width, height, texels, layout, "", &format!("-Y {height} +X {width}"))
}

/// The header of a file with no pixel data.
fn header_only(resolution: &str) -> Vec<u8> {
    format!("#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n{resolution}\n").into_bytes()
}

/// A 64x32 map of exactly RGBE-representable values (8-bit mantissas, shared exponent), with
/// flat runs (RLE has something to repeat) and a gradient (and something to copy).
fn synthetic_map() -> Vec<[f32; 3]> {
    let mut texels = Vec::with_capacity(64 * 32);
    for y in 0..32u32 {
        for x in 0..64u32 {
            let scale = libm::exp2f((y / 4) as f32 - 3.0);
            let texel = match x {
                0..=15 => [0.5 * scale, 0.25 * scale, 0.125 * scale],
                16..=31 => [(x - 15) as f32 * scale / 16.0, 0.5 * scale, 0.5 * scale],
                32..=47 => [1.0 * scale; 3],
                _ => [((x * 3) % 256) as f32 / 256.0 * 2.0 * scale, (y * 8 % 256) as f32 / 256.0 * 2.0 * scale, 0.0],
            };
            texels.push(texel);
        }
    }
    texels
}

fn texel_f32(image: &HdriImage, x: u32, y: u32) -> [f32; 4] {
    image.texels[(y * image.width + x) as usize].map(f16_to_f32)
}

// ---------------------------------------------------------------------------------------------
// Refusals

#[test]
fn hostile_files_are_refused_typed_with_no_allocation_beyond_the_cap() {
    let flat_map = standard(64, 32, &synthetic_map(), Rows::Flat);
    let rle_map = standard(64, 32, &synthetic_map(), Rows::Rle);
    let truncated_rle = rle_map[..rle_map.len() - 9].to_vec();
    let truncated_flat = flat_map[..flat_map.len() - 1].to_vec();

    let mut bad_scanline = header_only("-Y 1 +X 64");
    bad_scanline.extend_from_slice(&[2, 2, 1, 0]); // the row says it is 256 texels wide
    bad_scanline.extend_from_slice(&[0; 64]);

    let mut run_past_row_end = header_only("-Y 1 +X 64");
    run_past_row_end.extend_from_slice(&[2, 2, 0, 64]);
    run_past_row_end.extend_from_slice(&[128 + 100, 7]); // a run of 100 in a row of 64
    run_past_row_end.extend_from_slice(&[0; 64]);

    let mut zero_literal = header_only("-Y 1 +X 64");
    zero_literal.extend_from_slice(&[2, 2, 0, 64]);
    zero_literal.extend_from_slice(&[0, 9, 9, 9]);
    zero_literal.extend_from_slice(&[0; 64]);

    let mut over_cap_rows = header_only("-Y 2049 +X 4096");
    over_cap_rows.extend_from_slice(&[0; 256]);

    let rows: Vec<(&str, Vec<u8>, HdriRefusal)> = vec![
        ("empty input", Vec::new(), HdriRefusal::BadMagic),
        ("not a radiance file", b"P6\n64 32\n255\n".to_vec(), HdriRefusal::BadMagic),
        ("magic only half", b"#?RADIA".to_vec(), HdriRefusal::BadMagic),
        ("a png", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR".to_vec(), HdriRefusal::BadMagic),
        ("0x0", header_only("-Y 0 +X 0"), HdriRefusal::Empty),
        ("zero width", header_only("-Y 32 +X 0"), HdriRefusal::Empty),
        ("zero height", header_only("-Y 0 +X 64"), HdriRefusal::Empty),
        ("8192x4096", header_only("-Y 4096 +X 8192"), HdriRefusal::TooLarge { width: 8192, height: 4096 }),
        ("one past the width cap", header_only("-Y 1 +X 4097"), HdriRefusal::TooLarge { width: 4097, height: 1 }),
        ("one past the height cap", over_cap_rows, HdriRefusal::TooLarge { width: 4096, height: 2049 }),
        ("a side past u32", header_only("-Y 99999999999999 +X 99999999999999"), HdriRefusal::TooLarge { width: u32::MAX, height: u32::MAX }),
        ("truncated RLE", truncated_rle, HdriRefusal::Truncated),
        ("truncated flat", truncated_flat, HdriRefusal::Truncated),
        ("the cap itself with no pixels", header_only("-Y 2048 +X 4096"), HdriRefusal::Truncated),
        ("a run past the row's end", run_past_row_end, HdriRefusal::BadRle),
        ("a literal of length zero", zero_literal, HdriRefusal::BadRle),
        ("a scanline header of another width", bad_scanline, HdriRefusal::BadRle),
        ("xyze colours", b"#?RADIANCE\nFORMAT=32-bit_rle_xyze\n\n-Y 1 +X 1\n\0\0\0\0".to_vec(), HdriRefusal::BadHeader),
        ("no resolution line", b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n".to_vec(), HdriRefusal::Truncated),
        ("a rotated resolution", header_only("+X 64 -Y 32"), HdriRefusal::BadHeader),
        ("a negative width", header_only("-Y 32 +X -64"), HdriRefusal::BadHeader),
        ("a words resolution", header_only("-Y high +X wide"), HdriRefusal::BadHeader),
        ("a header that never ends", [b"#?RADIANCE\n".as_slice(), &[b'x'; 8192]].concat(), HdriRefusal::BadHeader),
        ("a header line without a newline", b"#?RADIANCE\nFORMAT=32-bit_rle_rgbe".to_vec(), HdriRefusal::Truncated),
    ];
    for (name, bytes, expected) in rows {
        let (result, peak) = peak_bytes(|| decode(&bytes));
        assert_eq!(result, Err(expected), "{name}");
        assert!(peak <= REFUSAL_ALLOCATION_MAX, "{name}: refused after allocating {peak} bytes");
    }
}

#[test]
fn a_refusal_before_the_pixels_allocates_nothing_near_the_cap() {
    // The cap itself is 64 MB; a file that claims it and holds nothing is refused as truncated
    // before any of it is allocated.
    let claim = header_only(&format!("-Y {HDRI_MAX_HEIGHT} +X {HDRI_MAX_WIDTH}"));
    let (result, peak) = peak_bytes(|| decode(&claim));
    assert_eq!(result, Err(HdriRefusal::Truncated));
    assert!(peak < 1024 * 1024, "{peak} bytes for a {HDRI_MAX_DECODED_BYTES} byte claim");
}

#[test]
fn the_refusals_have_stable_wire_spellings() {
    let wires = [
        (HdriRefusal::BadMagic, "hdri-bad-magic"),
        (HdriRefusal::BadHeader, "hdri-bad-header"),
        (HdriRefusal::Empty, "hdri-empty"),
        (HdriRefusal::TooLarge { width: 1, height: 1 }, "hdri-too-large"),
        (HdriRefusal::Truncated, "hdri-truncated"),
        (HdriRefusal::BadRle, "hdri-bad-rle"),
    ];
    for (refusal, wire) in wires {
        assert_eq!(refusal.wire(), wire);
    }
}

// ---------------------------------------------------------------------------------------------
// Decoding

#[test]
fn a_synthetic_64x32_map_round_trips_within_half_float_precision() {
    let texels = synthetic_map();
    for layout in [Rows::Flat, Rows::Rle] {
        let image = decode(&standard(64, 32, &texels, layout)).expect("a valid map decodes");
        assert_eq!((image.width, image.height), (64, 32));
        assert_eq!(image.texels.len(), 64 * 32);
        assert_eq!(image.decoded_bytes(), 64 * 32 * 8);
        for (index, expected) in texels.iter().enumerate() {
            let got = image.texels[index].map(f16_to_f32);
            for channel in 0..3 {
                let want = expected[channel];
                // The values are RGBE-exact and half floats hold 11 significant bits.
                let tolerance = want.abs() * HALF_RELATIVE_PRECISION;
                assert!((got[channel] - want).abs() <= tolerance, "{layout:?} texel {index} channel {channel}: {} vs {want}", got[channel]);
            }
            assert_eq!(got[3], 1.0, "alpha is one");
        }
    }
}

#[test]
fn flat_and_run_length_files_decode_to_the_same_texels() {
    let texels = synthetic_map();
    let flat = decode(&standard(64, 32, &texels, Rows::Flat)).expect("flat");
    let rle = decode(&standard(64, 32, &texels, Rows::Rle)).expect("rle");
    assert_eq!(flat, rle);
    assert_eq!(rle, decode(&standard(64, 32, &texels, Rows::Rle)).expect("again"), "decoding is deterministic");
}

#[test]
fn narrow_maps_are_stored_flat() {
    // Under eight texels wide the format has no run-length rows.
    let texels: Vec<[f32; 3]> = (0..4 * 3).map(|i| [i as f32 * 0.25, 1.0, 0.5]).collect();
    let image = decode(&file(4, 3, &texels, Rows::Flat, "", "-Y 3 +X 4")).expect("narrow flat");
    assert_eq!((image.width, image.height), (4, 3));
    assert_eq!(texel_f32(&image, 3, 2)[0], 11.0 * 0.25);
}

#[test]
fn the_resolution_line_orients_the_rows_and_columns() {
    let texels: Vec<[f32; 3]> = (0..16u32 * 2).map(|i| [(i + 1) as f32, 0.0, 0.0]).collect();
    let top_down = decode(&file(16, 2, &texels, Rows::Rle, "", "-Y 2 +X 16")).expect("-Y +X");
    let bottom_up = decode(&file(16, 2, &texels, Rows::Rle, "", "+Y 2 +X 16")).expect("+Y +X");
    let mirrored = decode(&file(16, 2, &texels, Rows::Rle, "", "-Y 2 -X 16")).expect("-Y -X");
    assert_eq!(texel_f32(&top_down, 0, 0)[0], 1.0);
    assert_eq!(texel_f32(&bottom_up, 0, 0)[0], 17.0, "+Y puts the file's first row at the bottom");
    assert_eq!(texel_f32(&bottom_up, 0, 1)[0], 1.0);
    assert_eq!(texel_f32(&mirrored, 0, 0)[0], 16.0, "-X puts the file's first column on the right");
    assert_eq!(texel_f32(&mirrored, 15, 0)[0], 1.0);
}

#[test]
fn comments_exposure_and_crlf_in_the_header_are_accepted() {
    let texels = vec![[1.0f32, 2.0, 4.0]; 8 * 2];
    let with_extras = file(8, 2, &texels, Rows::Rle, "EXPOSURE=1.0\nSOFTWARE=genex test\n# a comment\n", "-Y 2 +X 8");
    let image = decode(&with_extras).expect("extra header lines");
    assert_eq!(texel_f32(&image, 7, 1)[..3], [1.0, 2.0, 4.0]);

    let mut crlf = b"#?RADIANCE\r\nFORMAT=32-bit_rle_rgbe\r\n\r\n-Y 2 +X 8\r\n".to_vec();
    crlf.extend(pixel_bytes(8, 2, &texels, Rows::Rle));
    assert_eq!(decode(&crlf).expect("CRLF header").width, 8);
    assert!(decode(&[b"#?RGBE\n\n-Y 1 +X 1\n".as_slice(), &rgbe([1.0, 1.0, 1.0])].concat()).is_ok(), "#?RGBE is accepted");
}

#[test]
fn a_missing_format_line_is_rgbe() {
    let mut bytes = b"#?RADIANCE\n\n-Y 1 +X 2\n".to_vec();
    bytes.extend(rgbe([0.5, 0.5, 0.5]));
    bytes.extend(rgbe([2.0, 2.0, 2.0]));
    let image = decode(&bytes).expect("no FORMAT line");
    assert_eq!(texel_f32(&image, 1, 0)[..3], [2.0, 2.0, 2.0]);
}

#[test]
fn texels_stay_finite_and_zero_exponents_are_black() {
    // The largest shared exponent overflows half floats: it clamps to the largest finite half.
    let mut bytes = header_only("-Y 1 +X 3");
    bytes.extend_from_slice(&[255, 255, 255, 255]);
    bytes.extend_from_slice(&[200, 100, 50, 0]);
    bytes.extend_from_slice(&[128, 0, 0, 1]);
    let image = decode(&bytes).expect("extreme exponents");
    assert_eq!(texel_f32(&image, 0, 0), [65504.0, 65504.0, 65504.0, 1.0]);
    assert_eq!(texel_f32(&image, 1, 0), [0.0, 0.0, 0.0, 1.0], "exponent zero is black whatever the mantissas");
    assert_eq!(texel_f32(&image, 2, 0), [0.0, 0.0, 0.0, 1.0], "a texel below half range flushes to zero, never NaN");
    assert!(image.texels.iter().flatten().all(|&bits| f16_to_f32(bits).is_finite()));
}

#[test]
fn the_largest_allowed_map_header_is_accepted() {
    let mut bytes = header_only(&format!("-Y {HDRI_MAX_HEIGHT} +X {HDRI_MAX_WIDTH}"));
    bytes.extend(std::iter::repeat_n(0u8, 4 * (HDRI_MAX_WIDTH as usize) * 2));
    // Two rows of a 2048-row map: truncated, but past every size check.
    assert_eq!(decode(&bytes), Err(HdriRefusal::Truncated));
}

// ---------------------------------------------------------------------------------------------
// Directions and the analytic sun

fn angle_between(a: [f32; 3], b: [f32; 3]) -> f32 {
    libm::acosf((a[0] * b[0] + a[1] * b[1] + a[2] * b[2]).clamp(-1.0, 1.0)).to_degrees()
}

#[test]
fn equirect_directions_round_trip_and_follow_the_documented_convention() {
    assert!(angle_between(uv_to_direction([0.5, 0.0]), [0.0, 1.0, 0.0]) < 0.01, "v = 0 is straight up");
    assert!(angle_between(uv_to_direction([0.5, 1.0]), [0.0, -1.0, 0.0]) < 0.01, "v = 1 is straight down");
    assert!(angle_between(uv_to_direction([0.5, 0.5]), [0.0, 0.0, -1.0]) < 0.01, "the map's centre is the -z horizon");
    assert!(angle_between(uv_to_direction([0.75, 0.5]), [1.0, 0.0, 0.0]) < 0.01, "a quarter turn right is +x");
    for (u, v) in [(0.1, 0.2), (0.37, 0.5), (0.9, 0.81), (0.5, 0.35)] {
        let back = direction_to_uv(uv_to_direction([u, v]));
        assert!((back[0] - u).abs() < 1.0e-4 && (back[1] - v).abs() < 1.0e-4, "({u}, {v}) -> {back:?}");
    }
}

#[test]
fn rotation_turns_a_direction_about_up() {
    let turned = rotate_about_up([1.0, 0.0, 0.0], std::f32::consts::FRAC_PI_2);
    assert!(angle_between(turned, [0.0, 0.0, -1.0]) < 0.01, "{turned:?}");
    assert!(angle_between(rotate_about_up([0.0, 1.0, 0.0], 1.234), [0.0, 1.0, 0.0]) < 0.01, "up stays up");
    let sun = AnalyticSun { direction: [1.0, 0.0, 0.0], radiance: [1.0; 3], irradiance: [2.0; 3], clamp: 5.0 };
    let rotated = sun.rotated(std::f32::consts::PI);
    assert!(angle_between(rotated.direction, [-1.0, 0.0, 0.0]) < 0.01);
    assert_eq!((rotated.radiance, rotated.irradiance, rotated.clamp), (sun.radiance, sun.irradiance, sun.clamp));
}

/// A `width × height` equirect map of a constant sky with a sun of `sun_radiance` on the texels
/// within `radius` texels of (`sun_x`, `sun_y`).
fn sky_with_sun(width: u32, height: u32, sky: f32, sun: Option<(u32, u32, u32, f32)>) -> HdriImage {
    let mut texels = Vec::new();
    for y in 0..height {
        for x in 0..width {
            let mut value = sky * (1.0 - y as f32 / height as f32 * 0.5);
            if let Some((sun_x, sun_y, radius, radiance)) = sun {
                let dx = (x as i32 - sun_x as i32).abs().min(width as i32 - (x as i32 - sun_x as i32).abs());
                let dy = y as i32 - sun_y as i32;
                if dx * dx + dy * dy <= (radius * radius) as i32 {
                    value = radiance;
                }
            }
            texels.push([value, value * 0.9, value * 0.7, 1.0].map(f32_to_f16));
        }
    }
    HdriImage { width, height, texels }
}

#[test]
fn the_analytic_sun_is_the_bright_region_found_deterministically() {
    let image = sky_with_sun(256, 128, 2.0, Some((60, 30, 2, 20000.0)));
    let sun = analytic_sun(&image).expect("a sun stands out of a sky");
    let expected = uv_to_direction([(60.0 + 0.5) / 256.0, (30.0 + 0.5) / 128.0]);
    assert!(angle_between(sun.direction, expected) < 1.0, "{:?} vs {expected:?}", sun.direction);
    assert!((sun.direction.iter().map(|c| c * c).sum::<f32>() - 1.0).abs() < 1.0e-4, "a unit direction");
    assert!(sun.clamp > 2.0 && sun.clamp < 20000.0, "the clamp sits between the sky and the sun: {}", sun.clamp);
    assert!(sun.irradiance[0] > sun.irradiance[2] && sun.irradiance[2] > 0.0, "a warm sun: {:?}", sun.irradiance);
    assert!(sun.radiance[0] > 0.0 && sun.radiance[0] <= 20000.0);

    // The irradiance is what the bake removes: the excess over the clamp times the texel solid angle.
    let mut removed = 0.0f64;
    for (index, texel) in image.texels.iter().enumerate() {
        let y = index as u32 / image.width;
        let theta = (y as f64 + 0.5) / 128.0 * std::f64::consts::PI;
        let solid_angle = (2.0 * std::f64::consts::PI / 256.0) * (std::f64::consts::PI / 128.0) * theta.sin();
        removed += (f64::from(f16_to_f32(texel[0])) - f64::from(sun.clamp)).max(0.0) * solid_angle;
    }
    assert!((f64::from(sun.irradiance[0]) - removed).abs() <= removed * 0.01, "{} vs {removed}", sun.irradiance[0]);

    assert_eq!(analytic_sun(&image), Some(sun), "the same map gives the same sun");
}

#[test]
fn an_overcast_map_has_no_sun() {
    assert_eq!(analytic_sun(&sky_with_sun(128, 64, 4.0, None)), None, "a smooth sky");
    assert_eq!(analytic_sun(&sky_with_sun(128, 64, 0.0, None)), None, "a black map");
    // Bright, but nowhere near contrast with the rest of the map.
    assert_eq!(analytic_sun(&sky_with_sun(128, 64, 3.0, Some((10, 10, 1, 12.0)))), None, "a faint highlight");
}

#[test]
fn a_huge_bright_patch_is_a_sky_not_a_sun() {
    let image = sky_with_sun(128, 64, 1.0, Some((64, 32, 20, 5000.0)));
    let patch_angle = 2.0 * std::f32::consts::PI / 128.0 * 20.0;
    assert!(patch_angle * patch_angle > SUN_MAX_SOLID_ANGLE, "the patch is wider than any sun");
    assert_eq!(analytic_sun(&image), None);
}

#[test]
fn equal_peaks_resolve_to_the_first_in_scan_order() {
    let mut image = sky_with_sun(256, 128, 1.0, Some((200, 40, 1, 8000.0)));
    let second = sky_with_sun(256, 128, 1.0, Some((30, 40, 1, 8000.0)));
    for (texel, other) in image.texels.iter_mut().zip(&second.texels) {
        if f16_to_f32(other[0]) > 1000.0 {
            *texel = *other;
        }
    }
    let sun = analytic_sun(&image).expect("two suns, one found");
    let first = uv_to_direction([(30.0 + 0.5) / 256.0, (40.0 + 0.5) / 128.0]);
    assert!(angle_between(sun.direction, first) < 2.0, "the first peak in scan order wins: {:?}", sun.direction);
}

#[test]
fn a_sun_across_the_seam_is_one_region() {
    // A disc centred on the wrap column: texels at both edges of the map belong to it.
    let image = sky_with_sun(256, 128, 2.0, Some((0, 40, 3, 15000.0)));
    let sun = analytic_sun(&image).expect("a sun on the seam");
    let seam = uv_to_direction([0.5 / 256.0, (40.0 + 0.5) / 128.0]);
    assert!(angle_between(sun.direction, seam) < 2.0, "{:?} vs {seam:?}", sun.direction);
}

// ---------------------------------------------------------------------------------------------
// The showcase's CC0 map

const SHOWCASE_HDRI: &str = "../../examples/showcase/game/assets/env/kloofendal_43d_clear_puresky_1k.hdr";
/// Poly Haven's published size for the 1k file (api.polyhaven.com/files/kloofendal_43d_clear_puresky).
const SHOWCASE_HDRI_BYTES: usize = 1_184_531;

#[test]
fn the_showcase_hdri_decodes_and_has_a_sun() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(SHOWCASE_HDRI);
    let bytes = std::fs::read(&path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    assert_eq!(bytes.len(), SHOWCASE_HDRI_BYTES, "the pinned file (its sha256 is in THIRD-PARTY-NOTICES.md)");
    let image = decode(&bytes).expect("the showcase map decodes");
    assert_eq!((image.width, image.height), (1024, 512));
    assert!(image.decoded_bytes() <= HDRI_MAX_DECODED_BYTES);
    assert!(image.texels.iter().flatten().all(|&bits| f16_to_f32(bits).is_finite()));

    let sun = analytic_sun(&image).expect("a clear midday sky has a sun");
    assert!(sun.direction[1] > 0.5, "a midday sun is high in the sky: {:?}", sun.direction);
    assert!(sun.irradiance.iter().all(|&e| e.is_finite() && e > 0.0), "{:?}", sun.irradiance);
    assert!(sun.clamp > 1.0 && sun.clamp.is_finite(), "{}", sun.clamp);
}
