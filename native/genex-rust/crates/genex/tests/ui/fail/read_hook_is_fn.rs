// Read hooks are `Fn`: hidden state captured by a probe cannot change between reads.
use genex::prelude::*;

#[derive(Default)]
struct World;

fn main() {
    let mut game = Game::new(World);
    let mut reads = 0_u32;
    game.probe("reads", move |_sim| {
        reads += 1;
        json!(reads)
    });
    genex::install(game);
}
