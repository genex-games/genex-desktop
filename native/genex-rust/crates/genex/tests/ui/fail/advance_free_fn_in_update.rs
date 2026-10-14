// The C++ runtime's free `advance(ms)` has no Rust counterpart: nothing outside a demo advances time.
use genex::prelude::*;

#[derive(Default)]
struct World;

fn main() {
    let mut game = Game::new(World);
    game.on_update(|_sim, _ctx| {
        genex::advance(16);
    });
    genex::install(game);
}
