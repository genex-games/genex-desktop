//! The template's turning block, turned by a speed read through a raw pointer: `unsafe` code in
//! the game's own crate, refused `unsafe-code` unless the person trusts the game.

use genex::prelude::*;

const FLOOR: Color = Color::rgb(64, 72, 88);
const BLOCK: Color = Color::rgb(224, 168, 72);

/// Set by the game's build script; only a trusted build runs it.
#[cfg(genex_trusted)]
const SPIN_PER_SECOND: f32 = 0.8;

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// How far the block has turned, in radians.
    pub spin: f32,
}

/// The turn speed, read through a raw pointer.
fn spin_per_second() -> f32 {
    let speed = SPIN_PER_SECOND;
    let at: *const f32 = &speed;
    // SAFETY: `at` points at `speed`, alive for this whole call.
    unsafe { *at }
}

/// Turn the block each tick, draw the floor and the block, report the turn.
pub fn wire(game: &mut Game<World>) {
    game.on_update(|sim, ctx| sim.world.spin += spin_per_second() * ctx.dt);
    game.on_draw(|sim, frame, _camera| {
        let floor = Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(12.0, 1.0, 12.0));
        let block = Transform::from_xyz(0.0, 0.5, 0.0).with_rotation(Quat::from_rotation_y(sim.world.spin));
        frame.tag("floor").cube(floor, FLOOR);
        frame.tag("block").cube(block, BLOCK);
    });
    game.camera(|_sim| Camera::look_at(vec3(5.0, 4.0, 7.0), Vec3::ZERO));
    game.probe("trusted", |sim| json!({ "spin": sim.world.spin }));
}
