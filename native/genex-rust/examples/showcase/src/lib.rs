//! The showcase scenes for the workspace: the lakeside's game folder modules (`game/src/`, compiled
//! here as they are in Studio), its assets read from `game/assets/`, and the procedural mesh
//! generator that wrote them (the scene is documented in `game/src/main.rs`); Harbour Street's game
//! folder modules ([`harbour`] and [`street`], from `harbour/src/`; renderer pass 2's urban and
//! interior scene, documented in `harbour/src/main.rs`). [`bench`] holds the renderer bench scenes
//! the follow-up measures beside them (drawn through genex-render directly).

pub mod bench;
#[path = "../game/src/draw.rs"]
pub mod draw;
pub mod fetched;
#[path = "../harbour/src/harbour.rs"]
pub mod harbour;
#[path = "../game/src/hud.rs"]
pub mod hud;
#[path = "../game/src/interior.rs"]
pub mod interior;
#[path = "../game/src/layout.rs"]
pub mod layout;
pub mod meshgen;
#[path = "../game/src/passes.rs"]
pub mod passes;
pub mod props;
#[path = "../game/src/showcase.rs"]
pub mod showcase;
pub mod stress;
#[path = "../harbour/src/street.rs"]
pub mod street;
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

/// Harbour Street's game folder (renderer pass 2, A.13): its `genex.toml` declares no WGSL.
pub const HARBOUR_GAME_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/harbour");

/// Harbour Street's assets (`harbour/assets/`: its own decal textures under `decals/`).
pub const HARBOUR_ASSETS_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/harbour/assets");

/// Harbour Street's fetched assets' processed folder (`scripts/showcase-assets.ts fetch --scene
/// harbour-street` writes it), read as `fetched/<name>` unless `GENEX_SHOWCASE_FETCHED=0`.
pub const HARBOUR_FETCHED_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../.studio-dev/assets-cache/harbour-street/assets/fetched");

/// Harbour Street with every hook registered.
pub fn harbour_game() -> Game<harbour::World> {
    let mut game = harbour::new_game();
    harbour::wire(&mut game);
    game
}

/// Harbour Street's fetched CC0 maps and sky map ([`HARBOUR_FETCHED_DIR`], or
/// `harbour/assets/fetched/` where `--install` put them) as `fetched/...`, read once and kept for
/// the process as [`assets`] is.
pub fn harbour_assets() -> AssetTable {
    static TABLE: OnceLock<AssetTable> = OnceLock::new();
    TABLE.get_or_init(|| {
        let mut files: Vec<(&'static str, &'static [u8])> = Vec::new();
        // Its own decal textures (renderer pass 2 A.10: posters, grime, puddles), always read.
        read_folder(&format!("{HARBOUR_ASSETS_DIR}/decals"), "decals/", &[".png"], &mut files);
        if reads_fetched() {
            let fetched = [".jpg", ".png", ".hdr"];
            read_folder(&format!("{HARBOUR_ASSETS_DIR}/fetched"), "fetched/", &fetched, &mut files);
            read_folder(HARBOUR_FETCHED_DIR, "fetched/", &fetched, &mut files);
        }
        Box::leak(files.into_boxed_slice())
    })
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
