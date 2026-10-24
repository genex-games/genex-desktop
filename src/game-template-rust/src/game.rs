//! The game's world and its rules. The starter is a floor and one metal block that turns under the
//! physical sky and an afternoon sun, a gear button that opens the graphics settings, a probe the
//! checks can read and a camera that shows it all; replace the scene with the game in the brief and
//! keep a way to reach the settings panel (a pause or options menu).

use genex::prelude::*;
use genex::render::Environment;

/// How fast the starter block turns, in radians per second of simulated time.
const SPIN_PER_SECOND: f32 = 0.8;
/// Towards the sun: about 25 degrees up, behind the block, so its shadow falls towards the camera.
const SUN_TOWARDS: Vec3 = vec3(-0.62, 0.45, -0.64);
/// The sun outside the atmosphere: white, and the sky colours it by its elevation.
const SUN_COLOR: Color = Color::WHITE;
const SUN_INTENSITY: f32 = 3.0;
/// The flat light and background a device without the sky or image-based lighting draws instead.
const AMBIENT_COLOR: Color = Color::rgb(170, 190, 220);
const AMBIENT_INTENSITY: f32 = 0.2;
const CLEAR: Color = Color::rgb(150, 180, 215);
/// A rough stone floor and a polished brass block (it mirrors the sky).
const FLOOR_COLOR: Color = Color::rgb(140, 136, 128);
const FLOOR_ROUGHNESS: f32 = 0.9;
/// The floor runs out to just inside the camera's far plane (1 km), and the look's light haze
/// (`[render.look]` in genex.toml) fades its far edge, and the sky's ground below it, into the
/// horizon's colour, so the sky meets the floor with no dark band between them.
const FLOOR_SIDE: f32 = 1800.0;
const BLOCK_COLOR: Color = Color::rgb(224, 168, 72);
const BLOCK_ROUGHNESS: f32 = 0.3;
/// The gear button's label (checks find it in `state().hud.items`; `settings_button` draws the gear).
pub const SETTINGS_BUTTON: &str = "Settings";
/// The settings panel's width, in world pixels.
const PANEL_WIDTH: f32 = 300.0;

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// How far the starter block has turned, in radians.
    pub spin: f32,
    /// Whether the graphics settings panel is open (the gear button toggles it).
    pub settings_open: bool,
}

/// The starter's hooks: turn the block each tick, draw the scene, show the gear button, report the turn.
pub fn wire(game: &mut Game<World>) {
    game.on_update(|sim, ctx| sim.world.spin += SPIN_PER_SECOND * ctx.dt);
    game.on_ui(|sim, ui, _ctx| settings(&mut sim.world, ui));
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_sim| Camera::look_at(vec3(4.0, 2.2, 5.5), vec3(0.0, 0.5, 0.0)));
    game.named_camera("overview", |_sim| Camera::look_at(vec3(0.0, 14.0, 0.1), Vec3::ZERO));
    game.probe("starter", |sim| json!({ "spin": sim.world.spin, "settingsOpen": sim.world.settings_open }));
}

/// The physical sky and its sun, a PBR floor and the turning block.
fn draw(world: &World, frame: &mut Frame) {
    frame.clear(CLEAR).ambient(AMBIENT_COLOR, AMBIENT_INTENSITY).sun(SUN_TOWARDS, SUN_COLOR, SUN_INTENSITY);
    frame.environment(Environment::sky());
    let floor = Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(FLOOR_SIDE, 1.0, FLOOR_SIDE));
    let block = Transform::from_xyz(0.0, 0.5, 0.0).with_rotation(Quat::from_rotation_y(world.spin));
    frame.tag("floor").cube_with(floor, &Material::color(FLOOR_COLOR).with_roughness(FLOOR_ROUGHNESS));
    frame.tag("block").cube_with(block, &Material::color(BLOCK_COLOR).with_metallic(1.0).with_roughness(BLOCK_ROUGHNESS));
}

/// The gear button in the top-right corner and, while it is open, the graphics settings panel
/// under it: the person's quality choice, saved on this device and never part of the simulation.
/// The hook's ui already sits inside the safe area and a 16 pt margin.
fn settings(world: &mut World, ui: &mut egui::Ui) {
    ui.with_layout(egui::Layout::top_down(egui::Align::Max), |ui| {
        if genex::render::settings_button(ui, SETTINGS_BUTTON).clicked() {
            world.settings_open = !world.settings_open;
        }
        if world.settings_open {
            // An opaque card of its own width, so the panel reads over a bright sky.
            egui::Frame::popup(ui.style()).show(ui, |ui| {
                ui.set_max_width(PANEL_WIDTH);
                ui.with_layout(egui::Layout::top_down(egui::Align::Min), genex::render::settings_panel);
            });
        }
    });
}
