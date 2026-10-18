//! Harbour Street: a short street at dusk after rain, a crossing, a neon alley and a café reached
//! through its door, drawn with genex's built-in renderer only (the facade's boxes and spheres with
//! PBR materials: photo-scanned CC0 textures where the asset cache holds them and untextured
//! stand-ins where it does not; the low sun down the side street and through the café's windows;
//! festoon bulbs, neon, street lamps and pendant lamps as 200+ binned local lights; blended glass;
//! the physical sky or a fetched dusk sky map; AgX, auto exposure, height fog, bloom, AO and PCSS).
//! This is the blockout of renderer pass 2's urban showcase: Tier A and B features (reflection
//! probes, the irradiance grid, froxel fog, decals, particles, SSR) dress it as they land. A tour
//! holds each of the five named shots and cuts to the next; 1–5 hold a shot, F flies a free camera,
//! B switches the sky, N steps through the time of day (the dusk, the night, a clear day), O opens
//! the graphics settings (also the HUD's settings button), H hides the HUD.

mod harbour;
mod nightfall;
mod street;

fn main() {
    let mut game = harbour::new_game();
    harbour::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
