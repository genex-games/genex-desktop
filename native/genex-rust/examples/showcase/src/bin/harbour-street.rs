//! `cargo run -p showcase --bin harbour-street`: Harbour Street in a window (or headless with
//! `--headless`), its fetched maps read from the asset cache.

fn main() {
    genex::install_with_assets(showcase_game::harbour_game(), showcase_game::harbour_assets());
}
