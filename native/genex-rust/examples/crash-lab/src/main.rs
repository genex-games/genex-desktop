//! crash-lab's native build: the game handed to `genex::install` (started by the studio, the dev
//! flavour serves its verbs headless; otherwise the facade's desktop shell runs it).

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    genex::install(crash_lab_game::game());
}

/// On the web the library's `start` export is the entry; the binary does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {}
