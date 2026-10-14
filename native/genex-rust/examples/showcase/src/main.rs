//! `cargo run -p showcase`: the lakeside in a window (or headless with `--headless`), its assets
//! read from `game/assets/`.

fn main() {
    genex::install_with_assets(showcase_game::game(), showcase_game::assets());
}
