// Camera hooks are read hooks: an observer camera cannot step or edit physics.
use genex::prelude::*;

#[derive(Default)]
struct World;

fn main() {
    let mut game = Game::new(World);
    game.camera(|sim| {
        sim.physics.step();
        Camera::default()
    });
    genex::install(game);
}
