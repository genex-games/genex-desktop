//! The game's own build script: runs at build time only while the person trusts the game. It
//! tells rustc a cfg the game reads, so a build that skipped it would not compile.

fn main() {
    println!("cargo::rustc-check-cfg=cfg(genex_trusted)");
    println!("cargo::rustc-cfg=genex_trusted");
    println!("cargo::rerun-if-changed=build.rs");
}
