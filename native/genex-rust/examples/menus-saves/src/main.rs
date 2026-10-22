//! menus-saves's native build: the game handed to `genex::install_with_assets` with its text files
//! compiled in (started by the studio, the dev flavour serves its verbs headless; otherwise the
//! facade's desktop shell runs it).

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    genex::install_with_assets(menus_saves_game::game(), menus_saves_game::ASSETS);
}

/// On the web the library's `start` export is the entry; the binary does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {}
