//! A second facet wired through the same block.

use super::World;
use genex::prelude::*;

#[derive(Default)]
pub struct Shop {
    pub coins: u32,
}

pub fn wire(game: &mut Game<World>) {
    game.facet_state::<Shop>();
    game.on_reset(|sim, _, _, _| sim.facets.get_mut::<Shop>().coins = 10);
    game.on_update(|sim, ctx| {
        if ctx.keys.pressed(Key::KeyB) {
            sim.facets.get_mut::<Shop>().coins -= 1;
            sim.world.purchases += 1;
        }
    });
    game.probe("shop", |sim| json!({ "coins": sim.facets.get::<Shop>().coins }));
}
