//! The pond's native build.
//!
//! `pond --self-test <ticks> [--seed <n>] [--demo <name>] [--out <file>] [--state-dir <dir>]`
//! (spike only, M0a.7) seeds, runs the demo, runs `<ticks>` ticks, captures the world target on the
//! host GPU at the self-test checkpoints and writes the JSON record (probe fields and capture
//! digests) to `--out` or stdout; with `--state-dir` (absolute) the captures are also written as
//! `<dir>/captures/<seq>.bgra`. The device rows (M0a.11/M0a.12) pull this record from a device and
//! M0a.15 compares it with the Mac golden. A refusal prints `pond: {"code","detail"}` on stderr
//! and exits 1 (2 for a usage error).
//!
//! Without `--self-test`, the game is handed to `genex::install` (with its compiled-in assets):
//! started by the studio (descriptor 3 and `GENEX_STUDIO_NONCE`), the dev flavour (feature
//! `studio`, the facade's) serves the studio's verbs headless on the host GPU; otherwise the
//! facade's desktop shell runs it (a window, or headless with `--headless`).

#[cfg(not(target_arch = "wasm32"))]
mod self_test;

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        genex::install_with_assets(pond_game::game(), pond_game::ASSETS);
        return;
    }
    std::process::exit(self_test::main(&args));
}

/// On the web the library's `start` export is the entry; the binary does nothing there.
#[cfg(target_arch = "wasm32")]
fn main() {}
