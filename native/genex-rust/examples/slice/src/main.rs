//! The slice's native build: the game handed to `genex::install_with_assets` (started by the
//! studio, the dev flavour serves its verbs headless; otherwise the facade's desktop shell runs it).

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    genex::install_with_assets(slice_game::game(), slice_game::ASSETS);
}

/// On the web the library's `start` export is the entry; the binary does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {}
