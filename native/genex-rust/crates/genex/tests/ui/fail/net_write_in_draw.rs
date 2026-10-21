// Draw hooks are read hooks: `sim.net` writes take `&mut self`, so a frame can draw remote players
// and can never send, connect or publish (a capture or a Live frame never reaches the room).
use genex::prelude::*;

#[derive(Default)]
struct World;

fn main() {
    let mut game = Game::new(World);
    game.on_draw(|sim, _frame, _camera| {
        sim.net.connect();
        let _ = sim.net.set_me(json!({ "x": 1 }));
    });
    genex::install(game);
}
