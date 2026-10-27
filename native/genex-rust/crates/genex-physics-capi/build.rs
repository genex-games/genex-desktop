//! The Apple dylib's install name is `@rpath/libgenex_physics_capi.dylib`: the linker's default is
//! the absolute path cargo wrote it to, which would name this machine's folders in every copy and
//! make a host's loader look there. A host (Unity, Godot, Unreal) finds it through its own rpath.

fn main() {
    let os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    if os == "macos" || os == "ios" {
        println!("cargo:rustc-cdylib-link-arg=-Wl,-install_name,@rpath/libgenex_physics_capi.dylib");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
