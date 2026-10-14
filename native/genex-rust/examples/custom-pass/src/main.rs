//! The custom GPU pass sample's native build: the game handed to `genex::install`. Started by the
//! studio, the dev flavour serves its verbs headless on the host GPU with both passes in every
//! frame; otherwise the facade's desktop shell runs it (a window, or headless with `--headless`).

fn main() {
    genex::install(custom_pass_game::game());
}
