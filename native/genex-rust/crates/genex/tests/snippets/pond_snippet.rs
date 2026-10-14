//! The plan's pond snippet ("The game API agents write"), verbatim from `use` to the end of
//! `main`; only the game's own Pond and Rod types are stubbed below it.
use genex::prelude::*;

#[derive(Default)]
struct World { pond: Pond, rod: Rod, score: u32 }

fn main() {
    let mut game = Game::new(World::default()).title("Pond").world_size(960, 540);
    game.on_reset(|sim, seed, rng, gfx| {
        sim.world.pond = Pond::spawn(seed, rng, &mut sim.physics, gfx.assets().model("pond.glb"));
    });
    game.on_update(|sim, ctx| {
        let (w, physics) = sim.split();
        if ctx.keys.pressed(Key::Space) || ctx.touches.tapped() { w.rod.cast(ctx.rng.unit()); }
        if w.pond.bite(&w.rod, physics) { w.score += 1; }
    });
    game.on_ui(|sim, ui, _ctx| { if ui.button("Buy bait").clicked() { sim.world.score -= 1; } });
    game.on_draw(|sim, frame, _cam| { frame.tag("pond").model(&sim.world.pond.model, Transform::IDENTITY); });
    game.probe("fishing", |sim| json!({ "phase": sim.world.rod.phase(), "score": sim.world.score }));
    game.demo("cast", |d| { d.inject(Input::key_tap(Key::Space)); d.advance_ms(2000); json!({ "casts": 1 }) });
    genex::install(game);
}

#[derive(Default)]
struct Pond {
    model: Model,
    fish: u32,
}

impl Pond {
    fn spawn(seed: u32, rng: &mut Pcg32, _physics: &mut PhysicsWorld, model: Model) -> Pond {
        Pond { model, fish: seed % 7 + rng.below(5) }
    }

    fn bite(&self, rod: &Rod, _physics: &mut PhysicsWorld) -> bool {
        rod.cast_at.is_some_and(|at| at < 0.5) && self.fish > 0
    }
}

#[derive(Default)]
struct Rod {
    cast_at: Option<f32>,
}

impl Rod {
    fn cast(&mut self, at: f32) {
        self.cast_at = Some(at);
    }

    fn phase(&self) -> &'static str {
        if self.cast_at.is_some() { "cast" } else { "idle" }
    }
}
