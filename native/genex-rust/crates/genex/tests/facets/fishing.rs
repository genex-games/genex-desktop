//! A facet: its private state lives in `sim.facets`, so it never edits the entry file's world.

use super::World;
use genex::prelude::*;

#[derive(Default)]
pub struct Fishing {
    pub casts: u32,
}

pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Fishing>();
    game.on_update(|sim, ctx| {
        if ctx.keys.pressed(Key::Space) {
            sim.facets.get_mut::<Fishing>().casts += 1;
        }
    });
    game.probe("fishing", |sim| json!({ "casts": sim.facets.get::<Fishing>().casts }));
}
