//! characters' native build.
//!
//! `characters --self-test <ticks> [--seed <n>] [--demo <name>] [--out <file>] [--state-dir <dir>]`
//! seeds, runs the demo (`watch` by default), runs `<ticks>` ticks, captures the world target on the
//! host GPU at the self-test checkpoints and writes the JSON record (probe fields, checksum and
//! capture digests) to `--out` or stdout: the native side of the web self-test plan. A refusal
//! prints `characters: {"code","detail"}` on stderr and exits 1 (2 for a usage error).
//!
//! Without arguments the game is handed to `genex::install_with_assets` with its mannequin: started
//! by the studio, the dev flavour serves its verbs headless; otherwise the facade's desktop shell
//! runs it.

#[cfg(not(target_arch = "wasm32"))]
mod self_test;

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        genex::install_with_assets(characters_game::game(), characters_game::assets());
        return;
    }
    std::process::exit(self_test::main(&args));
}

/// On the web the library's `start` export is the entry; the binary does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {}
