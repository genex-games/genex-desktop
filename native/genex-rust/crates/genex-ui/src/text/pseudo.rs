//! `xx-pseudo`: the pseudo-locale that makes overflow and untranslated text visible in captures.
//!
//! Letters take an accent (Latin-1 and Latin Extended-A only, glyphs the HUD's text font has), the
//! text grows by [`PSEUDO_GROWTH_PERCENT`] with `~` and is bracketed, so a clipped label shows a
//! missing bracket. Placeables are left alone: the catalog accents only a message's own text,
//! so numbers and names keep their spelling. The output is a pure function of the input.

use std::borrow::Cow;

/// The pseudo-locale's tag.
pub const PSEUDO_LOCALE: &str = "xx-pseudo";
/// How much longer pseudo text is than its source, in percent of its characters (rounded up).
pub const PSEUDO_GROWTH_PERCENT: usize = 40;

const OPEN: char = '[';
const CLOSE: char = ']';
const PAD: char = '~';

/// The accented form of an ASCII letter; letters without a Latin-1 or Extended-A accent stay.
fn accented(letter: char) -> char {
    match letter {
        'a' => 'à',
        'c' => 'ç',
        'd' => 'ď',
        'e' => 'é',
        'g' => 'ĝ',
        'h' => 'ĥ',
        'i' => 'î',
        'j' => 'ĵ',
        'k' => 'ķ',
        'l' => 'ĺ',
        'n' => 'ñ',
        'o' => 'ö',
        'r' => 'ŕ',
        's' => 'š',
        't' => 'ţ',
        'u' => 'ü',
        'w' => 'ŵ',
        'y' => 'ý',
        'z' => 'ž',
        'A' => 'Å',
        'C' => 'Ç',
        'D' => 'Ď',
        'E' => 'É',
        'G' => 'Ĝ',
        'H' => 'Ĥ',
        'I' => 'Î',
        'J' => 'Ĵ',
        'K' => 'Ķ',
        'L' => 'Ĺ',
        'N' => 'Ñ',
        'O' => 'Ö',
        'R' => 'Ŕ',
        'S' => 'Š',
        'T' => 'Ţ',
        'U' => 'Ü',
        'W' => 'Ŵ',
        'Y' => 'Ý',
        'Z' => 'Ž',
        other => other,
    }
}

/// `text` with every letter accented (the catalog's transform of a message's own text).
pub fn accent(text: &str) -> Cow<'_, str> {
    if !text.chars().any(|c| accented(c) != c) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(text.chars().map(accented).collect())
}

/// `text` grown by [`PSEUDO_GROWTH_PERCENT`] and bracketed (applied once to a whole message).
pub fn frame(text: &str) -> String {
    let chars = text.chars().count();
    let pad = (chars * PSEUDO_GROWTH_PERCENT).div_ceil(100);
    let mut out = String::with_capacity(text.len() + pad + 2);
    out.push(OPEN);
    out.push_str(text);
    out.extend(std::iter::repeat_n(PAD, pad));
    out.push(CLOSE);
    out
}

/// The pseudo-locale form of plain text: accented, grown and bracketed.
pub fn pseudo(text: &str) -> String {
    frame(&accent(text))
}
