use genex::prelude::*;

#[derive(Default)]
pub struct World {
    pub ticks: u32,
}

pub fn wire(game: &mut Game<World>) {
    game.on_update(|sim, _ctx| sim.world.ticks += 1);
    game.probe("min", |sim| json!({ "ticks": sim.world.ticks }));
}
