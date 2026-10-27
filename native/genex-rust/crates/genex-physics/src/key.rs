//! Keys (CONTRACT.md §3) and kind tags (§6.1).
//!
//! A key is 1 to 64 bytes of `[A-Za-z0-9_.:-]`, never `__proto__`, `constructor` or `prototype`; a
//! body, collider or joint key never starts with the reserved `static:` prefix (§6.5). A kind is 1
//! to 32 bytes of the same charset, and the empty kind `''` means no kind (§6.1).

use crate::error::{PhysicsError, PhysicsFailure, fail};

/// The longest key, in bytes.
pub const KEY_MAX_BYTES: usize = 64;
/// The longest kind tag, in bytes.
pub const KIND_MAX_BYTES: usize = 32;
/// The prefix reserved for static pieces (§6.5).
pub const STATIC_PREFIX: &str = "static:";
/// The names that fit the charset but are refused by name (§3).
pub const REFUSED_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// Whether `byte` is in the key charset.
fn is_key_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'-')
}

/// Whether `text` is 1..=`max` bytes, all from the key charset.
fn fits_charset(text: &str, max: usize) -> bool {
    let length_ok = !text.is_empty() && text.len() <= max;
    length_ok && text.bytes().all(is_key_byte)
}

/// Checks a key's syntax (§3), whatever it names; static keys pass.
pub fn check_key(key: &str) -> Result<(), PhysicsFailure> {
    if !fits_charset(key, KEY_MAX_BYTES) {
        return fail(PhysicsError::InvalidKey, "a key is 1-64 bytes of [A-Za-z0-9_.:-]");
    }
    if REFUSED_NAMES.contains(&key) {
        return fail(PhysicsError::InvalidKey, "that name is refused by name");
    }
    Ok(())
}

/// Checks a key a caller names a new body, collider or joint with: §3's syntax and no `static:`.
pub fn check_object_key(key: &str) -> Result<(), PhysicsFailure> {
    check_key(key)?;
    if key.starts_with(STATIC_PREFIX) {
        return fail(PhysicsError::InvalidKey, "the static: prefix is reserved for static pieces");
    }
    Ok(())
}

/// Checks a body's kind tag (§6.1): 1-32 bytes of the key charset, or `''`, which means no kind.
///
/// The contract names no code for a bad kind; `InvalidKey` is the closest, as a kind is a key-like tag.
pub fn check_kind(kind: &str) -> Result<(), PhysicsFailure> {
    if !kind.is_empty() && !fits_charset(kind, KIND_MAX_BYTES) {
        return fail(PhysicsError::InvalidKey, "a kind is 1-32 bytes of [A-Za-z0-9_.:-]");
    }
    Ok(())
}
