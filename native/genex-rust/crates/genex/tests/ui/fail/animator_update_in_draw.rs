// An animator moves only in the simulation: a draw hook reads `&Sim`, so it cannot advance one.
use genex::prelude::*;

#[derive(Default)]
struct World {
    hero: Option<Animator>,
}

fn main() {
    let mut game = Game::new(World::default());
    game.on_draw(|sim, _frame, _camera| {
        if let Some(hero) = &sim.world.hero {
            hero.update(1.0 / 60.0);
        }
    });
    genex::install(game);
}
