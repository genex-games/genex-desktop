// Draw hooks are read hooks: captures and Live frames cannot move the checksum.
use genex::prelude::*;

#[derive(Default)]
struct World {
    frames: u32,
}

fn main() {
    let mut game = Game::new(World::default());
    game.on_draw(|sim, _frame, _camera| {
        sim.world.frames += 1;
    });
    genex::install(game);
}
