//! audio-yard's native build: the game handed to `genex::install_with_assets` with its sounds
//! compiled in (started by the studio, the dev flavour serves its verbs headless; otherwise the
//! facade's desktop shell runs it and opens the audio device).

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    genex::install_with_assets(audio_yard_game::game(), audio_yard_game::ASSETS);
}

/// On the web the library's `start` export is the entry; the binary does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {}
