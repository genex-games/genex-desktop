//! The courtyard: its world, its look and quality choices, and what each frame draws.

use genex::render::{Environment, Meshlets, RenderConfig, SkyParams, SpotLight};
use genex::prelude::*;

/// How fast the orbs circle, in radians per second of simulated time.
const ORBIT_PER_SECOND: f32 = 0.6;
/// Meshes of at least this many triangles draw as meshlets where the class runs them: low enough
/// that the facade's sphere (1024 triangles) is clustered.
const MESHLET_MIN_TRIANGLES: u32 = 512;
const ORBS: u32 = 6;
const STONE: Color = Color::rgb(120, 116, 108);
const BRASS: Color = Color::rgb(200, 160, 90);
const LANTERN: Color = Color::rgb(255, 176, 96);
const MOON: Color = Color::rgb(150, 180, 255);
/// The v2 material's uniforms: its colour, then its glow (rgb and strength).
const GLOW_UNIFORMS: [f32; 8] = [0.3, 0.55, 0.9, 1.0, 0.2, 0.5, 1.0, 0.08];

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// How far the orbs have circled, in radians.
    pub orbit: f32,
    /// Whether the graphics settings panel is open (Tab).
    pub settings: bool,
    /// The v2 material and post pass, loaded on reset.
    pub glow: CustomMaterial,
    pub vignette: Option<PostPass>,
}

/// The game's look and quality: `genex.toml`'s `[render]` with meshlets for the facade's sphere.
fn render_config() -> RenderConfig {
    RenderConfig::from_build().meshlets(Meshlets::DEFAULT.with_min_triangles(MESHLET_MIN_TRIANGLES))
}

/// Every hook of the courtyard.
pub fn wire(game: &mut Game<World>) {
    game.render_settings(render_config());
    game.wgsl("shaders/glow.wgsl", include_str!("../shaders/glow.wgsl"));
    game.wgsl("shaders/vignette.wgsl", include_str!("../shaders/vignette.wgsl"));
    game.on_reset(|sim, _seed, _rng, gfx| {
        sim.world.glow = gfx.material("shaders/glow.wgsl", &GLOW_UNIFORMS);
        sim.world.vignette = Some(gfx.post_pass("shaders/vignette.wgsl"));
    });
    game.on_update(|sim, ctx| {
        sim.world.orbit += ORBIT_PER_SECOND * ctx.dt;
        if ctx.keys.pressed(Key::Tab) {
            sim.world.settings = !sim.world.settings;
        }
    });
    game.on_ui(|sim, ui, _ctx| {
        if sim.world.settings {
            genex::render::settings_panel(ui);
        }
    });
    game.on_draw(|sim, frame, _camera| draw(&sim.world, frame));
    game.camera(|_sim| Camera::look_at(vec3(7.0, 4.5, 9.0), vec3(0.0, 0.8, 0.0)));
    game.named_camera("overview", |_sim| Camera::look_at(vec3(0.0, 16.0, 0.1), Vec3::ZERO));
    game.probe("courtyard", |sim| json!({ "orbit": sim.world.orbit }));
}

fn draw(world: &World, frame: &mut Frame) {
    frame.environment(Environment::Sky(SkyParams::default().with_ground_albedo([0.12, 0.11, 0.1])));
    frame.sun(vec3(-0.6, 0.35, 0.4), Color::rgb(255, 255, 255), 2.5);
    frame.ambient(MOON, 0.1);

    frame.tag("ground");
    let floor = Transform::from_xyz(0.0, -0.5, 0.0).with_scale(vec3(16.0, 1.0, 16.0));
    frame.cube_with(floor, &Material::color(STONE).with_roughness(0.85));
    for (i, x) in [-3.0_f32, 3.0].into_iter().enumerate() {
        let pillar = Transform::from_xyz(x, 1.5, -2.0).with_scale(vec3(0.8, 4.0, 0.8));
        frame.cube_with(pillar, &Material::color(STONE).with_roughness(0.7));
        // A lantern on each pillar: glowing glass with a light of its own.
        let glass = vec3(x, 3.8, -1.4);
        frame.sphere_with(glass, 0.25, &Material::emissive(LANTERN, 6.0));
        frame.point_light(glass, 4.0, LANTERN, 3.0);
        let shadowed = i == 0;
        frame.spot_light_with(
            &SpotLight::new(vec3(x, 3.6, -1.2), vec3(0.0, -1.0, 0.6), 9.0, LANTERN, 14.0)
                .with_cone_degrees(25.0, 40.0)
                .with_shadow(shadowed),
        );
    }

    // Orbs that move: each named, so TAA's motion vectors follow it; clustered as meshlets.
    frame.tag("orbs");
    for orb in 0..ORBS {
        let angle = world.orbit + orb as f32 * std::f32::consts::TAU / ORBS as f32;
        let at = vec3(3.2 * genex::math::cos(angle), 0.7, 3.2 * genex::math::sin(angle));
        frame.id(orb);
        frame.sphere_with(at, 0.6, &Material::color(BRASS).with_metallic(1.0).with_roughness(0.3));
    }
    frame.end_id();

    // The v2 material, shaded by the renderer like a built-in surface.
    frame.tag("glow");
    frame.id("glow");
    let statue = Transform::from_xyz(0.0, 1.2, 0.0).with_scale(vec3(1.2, 1.2, 1.2));
    frame.custom(CustomMesh::Sphere, statue, &world.glow, Color::rgb(255, 255, 255));
    frame.end_id();

    if let Some(vignette) = &world.vignette {
        frame.post_pass(vignette);
    }
}
