//! FNV-1a 64 (CONTRACT.md §2, §10), written by hand, and its 16-hex-digit form.

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// An FNV-1a 64 state fed byte by byte.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Fnv1a64(u64);

impl Fnv1a64 {
    /// The empty hash.
    pub(crate) fn new() -> Self {
        Self(FNV_OFFSET)
    }

    /// Feeds `bytes`.
    pub(crate) fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(FNV_PRIME);
        }
    }

    /// Feeds one f32's little-endian bits, −0.0 written as +0.0 (§10.1).
    pub(crate) fn write_f32(&mut self, x: f32) {
        let normalized = if x == 0.0 { 0.0f32 } else { x };
        self.write(&normalized.to_bits().to_le_bytes());
    }

    /// The hash so far.
    pub(crate) fn finish(self) -> u64 {
        self.0
    }
}

/// FNV-1a 64 of `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash = Fnv1a64::new();
    hash.write(bytes);
    hash.finish()
}

/// A u64 as 16 lowercase hex digits, the JSON form of a hash (§10).
pub fn hex16(value: u64) -> String {
    format!("{value:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fnv1a64_matches_the_published_vectors() {
        assert_eq!(fnv1a64(b""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a64(b"a"), 0xaf63_dc4c_8601_ec8c);
        assert_eq!(fnv1a64(b"foobar"), 0x8594_4171_f739_67e8);
    }

    #[test]
    fn hex16_pads_to_sixteen_lowercase_digits() {
        assert_eq!(hex16(0xab), "00000000000000ab");
        assert_eq!(hex16(u64::MAX), "ffffffffffffffff");
    }

    #[test]
    fn signed_zero_hashes_as_positive_zero() {
        let mut positive = Fnv1a64::new();
        positive.write_f32(0.0);
        let mut negative = Fnv1a64::new();
        negative.write_f32(-0.0);
        assert_eq!(positive.finish(), negative.finish());
    }
}
