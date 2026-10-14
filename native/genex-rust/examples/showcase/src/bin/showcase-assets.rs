//! Writes the lakeside's procedural assets into `game/assets/` (run after a layout or mesh change;
//! `tests/assets.rs` fails until the files match the generator).
//! `showcase-assets fetched <raw> <out> <manifest>` processes the fetched CC0 maps instead
//! (`scripts/showcase-assets.ts` runs it).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("fetched") {
        fetched(&args[1..]);
        return;
    }
    for (name, bytes) in showcase_game::meshgen::all_assets() {
        let path = format!("{}/{name}", showcase_game::ASSETS_DIR);
        std::fs::write(&path, &bytes).unwrap_or_else(|error| panic!("{path}: {error}"));
        println!("{name}: {} bytes", bytes.len());
    }
}

fn fetched(args: &[String]) {
    let [raw, out, manifest] = args else { panic!("usage: showcase-assets fetched <raw> <out> <manifest>") };
    let paths = [raw, out, manifest].map(std::path::Path::new);
    if let Err(failure) = showcase_game::fetched::process(paths[0], paths[1], paths[2]) {
        eprintln!("showcase-assets fetched: {failure}");
        std::process::exit(1);
    }
}
