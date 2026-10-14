// Probes are read hooks: `&Sim`, so reading state() can never change the simulation.
use genex::prelude::*;

#[derive(Default)]
struct World {
    score: u32,
}

fn main() {
    let mut game = Game::new(World::default());
    game.probe("score", |sim| {
        sim.world.score += 1;
        json!(sim.world.score)
    });
    genex::install(game);
}
