// `advance` belongs to a demo's driver: an update hook only has `&Ctx`, which cannot advance time.
use genex::prelude::*;

#[derive(Default)]
struct World;

fn main() {
    let mut game = Game::new(World);
    game.on_update(|_sim, ctx| {
        ctx.advance_ms(16);
    });
    genex::install(game);
}
