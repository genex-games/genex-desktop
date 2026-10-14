//! FNV-1a 64, ported from the C++ template's `digest.h`: the digest a capture reports for its
//! pixels (the host recomputes it before it trusts the file) and the checksum `state()` reports
//! for the simulation.

/// FNV-1a 64's offset basis: the digest of no bytes.
pub const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
/// FNV-1a 64's prime.
pub const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a 64 of `bytes`.
pub const fn fnv1a64(bytes: &[u8]) -> u64 {
    fnv1a64_from(bytes, FNV_OFFSET_BASIS)
}

/// FNV-1a 64 of `bytes`, continuing from `hash` (so a digest can be taken in pieces).
pub const fn fnv1a64_from(bytes: &[u8], hash: u64) -> u64 {
    let mut hash = hash;
    let mut i = 0;
    while i < bytes.len() {
        hash ^= bytes[i] as u64;
        hash = hash.wrapping_mul(FNV_PRIME);
        i += 1;
    }
    hash
}

/// `value` as 16 lowercase hex digits, the way the host writes a digest.
pub fn hex64(value: u64) -> String {
    format!("{value:016x}")
}
