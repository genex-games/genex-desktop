//! Lakeside: a photoreal lake at golden hour, drawn with genex's built-in renderer (the facade's
//! models: PBR with photo-scanned CC0 textures where the asset cache holds them and procedural
//! stand-ins where it does not, branching trees with three levels of detail, emissive lanterns,
//! windows and fireflies with real point and spot lights, four PCSS shadow cascades, GPU culling),
//! its environment (the physical sky, or an HDR sky map: image-based light and the backdrop), the
//! look (AgX, auto exposure, height fog, bloom, AO, contact shadows), the built-in terrain (six PBR
//! layers blended per pixel by a control map and their heights, with continuous levels of detail,
//! the meadow's GPU grass grown on its grassy layers and stones scattered on its beach and path)
//! the lake (the renderer's water: refraction, absorption, shore foam and reflections) and three
//! custom GPU passes for what no built-in draws (clouds, the lake on MSAA presets, light sprites). The
//! cabin is a room: its door stands open on a lamplit interior with a hearth and chinked log
//! walls, lit inside by a reflection probe and an irradiance volume. A slow tour flies through pass 1's five named shots;
//! four more (a wide golden hour, the shore, the forest floor and the cabin's room) are held by
//! 6–9. 1–9 hold a shot, F flies a free camera, B steps through the skies, N through the time of
//! day (the golden hour, a moonlit night under the stars, a clear day), O opens the graphics
//! settings (also the HUD's settings button), H hides the HUD.

mod daylight;
mod draw;
mod hud;
mod interior;
mod layout;
mod passes;
mod showcase;
mod world;

fn main() {
    let mut game = showcase::new_game();
    showcase::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
