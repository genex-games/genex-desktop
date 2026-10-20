//! The play-time AI example of docs/GENEX_API.md ("Play-time AI"), compiled by `cargo test`.
use genex::ai::{AiOptions, AiTicket, Ask, SchemaNode};
use genex::prelude::*;

#[derive(Default)]
struct World {
    x: i32,
    waiting: Option<AiTicket<Value>>,
}

fn main() {
    let mut game = Game::new(World::default()).title("Runner");
    game.ai(AiOptions::default());
    game.on_update(|sim, ctx| {
        for result in ctx.ai.drain() {
            let Some(ticket) = &sim.world.waiting else { continue };
            if !ticket.is(&result) {
                continue;
            }
            let way = ticket.value(&result).and_then(|v| v["move"].as_str().map(str::to_owned));
            sim.world.x += if way.as_deref() == Some("right") { 1 } else { -1 };
            sim.world.waiting = None;
        }
        if ctx.keys.pressed(Key::Space) && sim.world.waiting.is_none() {
            let schema = SchemaNode::object().property("move", SchemaNode::string().one_of(["left", "right"]));
            let ask = Ask::with_schema("dot.move", "Pick the way the dot runs.", schema);
            sim.world.waiting = Some(ctx.ai.ask(ask.fallback(json!({"move": "left"}))));
        }
    });
    genex::install(game);
}
