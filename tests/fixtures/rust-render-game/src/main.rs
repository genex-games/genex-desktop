//! Every Light: a small courtyard at dusk that reaches every renderer feature through the facade,
//! so an ejected fork of genex-render is built and judged with all of it in use. `scene.rs` draws
//! the courtyard (sky, sun, spot and point lights, PBR and emissive surfaces, meshlet orbs, a v2
//! material and a v2 post pass); `probe.rs` is a v2 Level-3 pass at `after-prepass` and `warm.rs`
//! one at `post-hdr`.

mod probe;
mod scene;
mod warm;

use genex::prelude::*;
use scene::World;

fn main() {
    let mut game = Game::new(World::default()).title("Every Light").world_size(640, 360);
    scene::wire(&mut game);
    probe::wire(&mut game);
    warm::wire(&mut game);
    // ── FACET WIRING ── two lines per facet, nothing else: #[path = "facets/<slug>.rs"] mod <slug>; and <slug>::wire(&mut game);
    // ── END FACET WIRING ──
    genex::install(game);
}
