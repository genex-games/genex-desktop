//! The renderer's WGSL as a web build ships it (renderer pass 2, A.12): without comments,
//! indentation or blank lines, made at compile time, so the module carries less text.
//!
//! The renderer's shaders are written for people: every struct and step carries its reason, and
//! `common.wgsl` is concatenated into most of them. A web module embeds each concatenation whole
//! (`common.wgsl` 37 times), and gzip's 32 KiB window cannot fold copies that far apart. At the
//! A.12 head the Lakeside module embedded 1.41 MB of WGSL, about a third of it comments. Native
//! builds keep the sources as written, so naga's and the drivers' messages point at the files'
//! own lines; the extension preludes stay as written on every target, because a game's shader
//! diagnostics count their lines.
//!
//! WGSL has no string or character literals, so a comment is any `//` to the end of its line and
//! any `/* … */` (they nest). Whitespace only separates tokens: a run of it (a comment counts as
//! one) becomes one space, or one newline when it held a line break, and the start and end of
//! the source lose theirs. Nothing else changes, so the module naga reads is the same.

/// The minified form of `source`, written into `out` when `write` (which must then be at least
/// [`minified_len`] long), and its length in bytes either way. One scanner serves both the
/// length and the bytes, so the two can never disagree.
pub const fn scan(source: &[u8], out: &mut [u8], write: bool) -> usize {
    let mut i = 0;
    let mut n = 0;
    // A separator owed before the next token: a space, or a newline when the run held one.
    let mut space = false;
    let mut newline = false;
    while i < source.len() {
        let byte = source[i];
        let next = if i + 1 < source.len() { source[i + 1] } else { 0 };
        if byte == b'/' && next == b'/' {
            while i < source.len() && source[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if byte == b'/' && next == b'*' {
            i = block_comment_end(source, i);
            space = true;
            continue;
        }
        if byte == b'\n' {
            newline = true;
            i += 1;
            continue;
        }
        if byte == b' ' || byte == b'\t' || byte == b'\r' {
            space = true;
            i += 1;
            continue;
        }
        if n > 0 && (space || newline) {
            if write {
                out[n] = if newline { b'\n' } else { b' ' };
            }
            n += 1;
        }
        space = false;
        newline = false;
        if write {
            out[n] = byte;
        }
        n += 1;
        i += 1;
    }
    n
}

/// The index just past the (nested) block comment that opens at `start`, or the source's end
/// when it never closes (naga then refuses the module, as it would the source as written).
const fn block_comment_end(source: &[u8], start: usize) -> usize {
    let mut i = start + 2;
    let mut depth = 1;
    while i < source.len() && depth > 0 {
        let next = if i + 1 < source.len() { source[i + 1] } else { 0 };
        if source[i] == b'/' && next == b'*' {
            depth += 1;
            i += 2;
        } else if source[i] == b'*' && next == b'/' {
            depth -= 1;
            i += 2;
        } else {
            i += 1;
        }
    }
    i
}

/// How many bytes the minified form of `source` has.
pub const fn minified_len(source: &str) -> usize {
    scan(source.as_bytes(), &mut [], false)
}

/// The minified bytes of `source`, `N` long ([`minified_len`]).
pub const fn minified<const N: usize>(source: &str) -> [u8; N] {
    let mut out = [0u8; N];
    let written = scan(source.as_bytes(), &mut out, true);
    assert!(written == N, "the minified length is the scanned one");
    out
}

/// `bytes` (a minified WGSL source, UTF-8 because only whole comments and ASCII whitespace were
/// dropped) as text.
pub const fn as_str(bytes: &[u8]) -> &str {
    match core::str::from_utf8(bytes) {
        Ok(text) => text,
        Err(_) => panic!("a minified WGSL source is UTF-8"),
    }
}

/// The minified form of `source` as an owned string (tests and tools; the shipped constants are
/// made by [`shipped_wgsl!`] at compile time).
pub fn minify(source: &str) -> String {
    let mut out = vec![0u8; minified_len(source)];
    scan(source.as_bytes(), &mut out, true);
    as_str(&out).to_owned()
}

/// A renderer shader constant as its target ships it: `$source` (a `&'static str` constant
/// expression, usually a `concat!` of `include_str!`s) minified at compile time on the web
/// (`wasm32`), as written everywhere else.
macro_rules! shipped_wgsl {
    ($source:expr) => {{
        #[cfg(target_arch = "wasm32")]
        let shipped: &str = {
            const SOURCE: &str = $source;
            const LEN: usize = $crate::shaders::minify::minified_len(SOURCE);
            #[allow(long_running_const_eval)]
            const BYTES: [u8; LEN] = $crate::shaders::minify::minified::<LEN>(SOURCE);
            $crate::shaders::minify::as_str(&BYTES)
        };
        #[cfg(not(target_arch = "wasm32"))]
        let shipped: &str = $source;
        shipped
    }};
}
pub(crate) use shipped_wgsl;

#[cfg(test)]
mod tests {
    use super::minify;

    #[test]
    fn comments_indentation_and_blank_lines_go() {
        let source = "// A header.\n\nstruct S {\n    a: f32, // the a\n    /* gone */ b: f32,\n}\n\n  fn f() {}\n";
        assert_eq!(minify(source), "struct S {\na: f32,\nb: f32,\n}\nfn f() {}");
    }

    #[test]
    fn a_comment_between_tokens_still_separates_them() {
        assert_eq!(minify("let a/*x*/= b;"), "let a = b;");
        assert_eq!(minify("return a/**/b;"), "return a b;");
        assert_eq!(minify("x // tail"), "x");
    }

    #[test]
    fn block_comments_nest_and_span_lines() {
        assert_eq!(minify("a /* one /* two */ still\n one */ b"), "a b");
        assert_eq!(minify("a /* never closed"), "a");
    }

    #[test]
    fn division_and_runs_of_whitespace_are_kept_as_one_separator() {
        assert_eq!(minify("let q = a / b;\t\t let r = a  /  b;"), "let q = a / b; let r = a / b;");
        assert_eq!(minify("a\r\n\r\n   b"), "a\nb");
    }

    #[test]
    fn non_ascii_in_comments_goes_and_text_stays_utf8() {
        assert_eq!(minify("// Lagarde’s · estimate — ok\nfn g() {} /* ±1 */"), "fn g() {}");
    }

    #[test]
    fn minifying_twice_changes_nothing() {
        let once = minify(crate::shaders::FORWARD);
        assert_eq!(minify(&once), once);
    }

    /// `source` parsed, validated against WebGPU core (with cube arrays, as tests/layout.rs) and
    /// written as MSL, every override without a default set to 0.
    fn msl_of(name: &str, source: &str) -> String {
        use naga::back::msl;
        use naga::valid::{Capabilities, ValidationFlags, Validator};
        let module = naga::front::wgsl::parse_str(source).unwrap_or_else(|error| panic!("{name}: {}", error.emit_to_string(source)));
        let info = Validator::new(ValidationFlags::all(), Capabilities::CUBE_ARRAY_TEXTURES)
            .validate(&module)
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        let constants: naga::back::PipelineConstants = module
            .overrides
            .iter()
            .filter(|(_, o)| o.init.is_none())
            .filter_map(|(_, o)| o.name.clone().map(|name| (name, 0.0)))
            .collect();
        let (module, info) = naga::back::pipeline_constants::process_overrides(&module, &info, None, &constants)
            .unwrap_or_else(|error| panic!("{name}: overrides: {error:?}"));
        let options = msl::Options { lang_version: (2, 4), ..Default::default() };
        msl::write_string(&module, &info, &options, &msl::PipelineOptions::default())
            .unwrap_or_else(|error| panic!("{name}: MSL: {error:?}"))
            .0
    }

    /// The shipped renderer modules [`crate::shaders::SHADERS`] does not list.
    const UNLISTED: &[(&str, &str)] = &[
        ("spot-shadow", crate::spot_shadow::SPOT_SHADOW),
        ("light-bin", crate::cluster::LIGHT_BIN),
        ("sun-mask-denoise", crate::post::sun_mask::DENOISE),
    ];

    #[test]
    fn every_renderer_shader_minifies_to_the_same_module() {
        for (name, source) in crate::shaders::SHADERS.iter().chain(UNLISTED) {
            let small = minify(source);
            assert!(!small.contains("//") && !small.contains("/*"), "{name}: no comment is left");
            assert!(small.lines().all(|line| !line.starts_with([' ', '\t'])), "{name}: no indentation is left");
            assert!(small.len() < source.len(), "{name}: smaller");
            assert_eq!(msl_of(name, &small), msl_of(name, source), "{name}: the same module");
        }
    }
}
