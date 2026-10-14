//! The game's world and its rules. The starter is a floor and one block that turns, a probe the
//! checks can read and a camera that shows both; replace it with the game in the brief.

use genex::prelude::*;

/// How fast the starter block turns, in radians per second of simulated time.
const SPIN_PER_SECOND: f32 = 0.8;
const FLOOR: Color = Color::rgb(64, 72, 88);
const BLOCK: Color = Color::rgb(224, 168, 72);

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// How far the starter block has turned, in radians.
    pub spin: f32,
}

/// The starter's hooks: turn the block each tick, draw the floor and the block, report the turn.
pub fn wire(game: &mut Game<World>) {
    game.on_update(|sim, ctx| sim.world.spin += SPIN_PER_SECOND * ctx.dt);
    game.on_draw(|sim, frame, _camera| {
        let floor = Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(12.0, 1.0, 12.0));
        let block = Transform::from_xyz(0.0, 0.5, 0.0).with_rotation(Quat::from_rotation_y(sim.world.spin));
        frame.tag("floor").cube(floor, FLOOR);
        frame.tag("block").cube(block, BLOCK);
    });
    game.camera(|_sim| Camera::look_at(vec3(5.0, 4.0, 7.0), Vec3::ZERO));
    game.named_camera("overview", |_sim| Camera::look_at(vec3(0.0, 14.0, 0.1), Vec3::ZERO));
    game.probe("starter", |sim| json!({ "spin": sim.world.spin }));
}
