//! The lakeside showcase for the workspace: the game folder's modules (`game/src/`, compiled here as
//! they are in Studio), its assets read from `game/assets/`, and the procedural mesh generator that
//! wrote them. The scene itself is documented in `game/src/main.rs`. [`bench`] holds the renderer
//! bench scenes the follow-up measures beside it (drawn through genex-render directly).

pub mod bench;
#[path = "../game/src/draw.rs"]
pub mod draw;
pub mod fetched;
#[path = "../game/src/hud.rs"]
pub mod hud;
#[path = "../game/src/layout.rs"]
pub mod layout;
pub mod meshgen;
#[path = "../game/src/passes.rs"]
pub mod passes;
pub mod props;
#[path = "../game/src/showcase.rs"]
pub mod showcase;
pub mod stress;
pub mod trees;
#[path = "../game/src/world.rs"]
pub mod world;

use std::sync::OnceLock;

use genex::{AssetTable, Game};

/// The game folder's assets.
pub const ASSETS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/game/assets");

/// The game folder: its `genex.toml` declares the `[[wgsl]]` sources (a lane build compiles the
/// rows in; the workspace's builds read them from here).
pub const GAME_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/game");

/// The game with every hook and pass registered, its `[[wgsl]]` rows read from [`GAME_DIR`].
pub fn game() -> Game<world::World> {
    let mut game = showcase::new_game();
    game.wgsl_root(std::path::Path::new(GAME_DIR));
    showcase::wire(&mut game);
    game
}

/// The fetched assets' processed folder (`scripts/showcase-assets.ts fetch` writes it): read as
/// `fetched/<name>` beside the game's own assets, unless `GENEX_SHOWCASE_FETCHED=0` asks for the
/// procedural fallback the scene draws without them.
pub const FETCHED_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../.studio-dev/assets-cache/lakeside/assets/fetched");

/// Whether this process reads the fetched assets (`GENEX_SHOWCASE_FETCHED=0` turns them off).
pub fn reads_fetched() -> bool {
    std::env::var("GENEX_SHOWCASE_FETCHED").map_or(true, |value| value != "0")
}

/// Every GLB and PNG in `game/assets/`, every HDR map in `game/assets/env/`, and the fetched CC0
/// maps ([`FETCHED_DIR`], or `game/assets/fetched/` where `--install` put them) as `fetched/...`,
/// read once and kept for the process (a dev run and the tests; a Studio build finds them beside
/// its binary). Every call after the first returns the same table: the lakeside's frames ask for
/// it each time they draw, and each read used to be leaked, which made a long perf run grow by
/// 3.6 MB a frame (and its CPU time carry the read).
pub fn assets() -> AssetTable {
    static TABLE: OnceLock<AssetTable> = OnceLock::new();
    TABLE.get_or_init(read_assets)
}

/// The files of `dir` ending in one of `extensions`, sorted, as (`prefix` + name, bytes).
fn read_folder(dir: &str, prefix: &str, extensions: &[&str], files: &mut Vec<(&'static str, &'static [u8])>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut names: Vec<String> = entries.filter_map(|entry| entry.ok()?.file_name().into_string().ok()).filter(|name| extensions.iter().any(|e| name.ends_with(e))).collect();
    names.sort();
    for name in names {
        let path = format!("{prefix}{name}");
        if files.iter().any(|(known, _)| *known == path) {
            continue;
        }
        let Ok(bytes) = std::fs::read(format!("{dir}/{name}")) else { continue };
        files.push((Box::leak(path.into_boxed_str()), Box::leak(bytes.into_boxed_slice())));
    }
}

fn read_assets() -> AssetTable {
    let mut files: Vec<(&'static str, &'static [u8])> = Vec::new();
    read_folder(ASSETS_DIR, "", &[".glb", ".png"], &mut files);
    read_folder(&format!("{ASSETS_DIR}/env"), "env/", &[".hdr"], &mut files);
    if reads_fetched() {
        let fetched = [".jpg", ".png", ".hdr"];
        read_folder(&format!("{ASSETS_DIR}/fetched"), "fetched/", &fetched, &mut files);
        read_folder(FETCHED_DIR, "fetched/", &fetched, &mut files);
    }
    Box::leak(files.into_boxed_slice())
}
