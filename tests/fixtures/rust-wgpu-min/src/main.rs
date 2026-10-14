use genex::prelude::*;

mod game;

fn main() {
    let mut game = Game::new(game::World::default()).title("Min").world_size(960, 540);
    game::wire(&mut game);
    // FACET WIRING
    genex::install(game);
}
