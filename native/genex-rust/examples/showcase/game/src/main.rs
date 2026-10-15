//! Lakeside: a photoreal lake at golden hour, drawn with genex's built-in renderer (the facade's
//! models: PBR with photo-scanned CC0 textures where the asset cache holds them and procedural
//! stand-ins where it does not, branching trees with three levels of detail, emissive lanterns,
//! windows and fireflies with real point and spot lights, four PCSS shadow cascades, GPU culling),
//! its environment (the physical sky, or an HDR sky map: image-based light and the backdrop), the
//! look (AgX, auto exposure, height fog, bloom, AO, contact shadows), the built-in terrain (six PBR
//! layers blended per pixel by a control map and their heights, with continuous levels of detail)
//! and four custom GPU passes for what no built-in draws (clouds, grass, lake, light sprites). A slow tour flies through five named shots;
//! 1–5 hold a shot, F flies a free camera, B steps through the skies, O opens the graphics settings
//! (also the HUD's settings button), H hides the HUD.

mod draw;
mod hud;
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
