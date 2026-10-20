//! A scope name with a capital and a space is refused when the game compiles.

const BAD: genex_profile::ScopeName = genex_profile::ScopeName::new("Bad Name");

fn main() {
    let _ = BAD;
}
