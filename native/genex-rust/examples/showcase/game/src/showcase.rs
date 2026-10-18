//! The lakeside, every hook registered: the clock and camera keys, the draw hook, the HUD, the
//! custom passes, the named shots and the probes.

use genex::prelude::*;
use genex::render::{Bloom, Exposure, Fog, QualityPreset, RenderConfig, ShadowConfig, ShadowFilter, Tonemap};

use crate::draw::{HORIZON, draw};
use crate::passes;
use crate::world::{Models, World, named_shots, scene_probe, update};

/// Auto exposure's compensation in EV, against the renderer's metering of the golden-hour frame:
/// none. AgX punchy holds middle grey where plain AgX draws it (pass 2, P2-0.10), so the +0.9 EV
/// that made up for pass 1's punchy darkening it by 1.15 EV is gone.
pub const LOOK_EV_COMPENSATION: f32 = 0.0;

/// Cascades the lakeside asks for at `high` and `ultra`: the tour's long shots reach the sun's
/// shadow distance, and four cascades keep the trees' leaf shadows crisp in the middle distance.
/// Phones and the low tier are held to their own caps whatever this says, and `low` and `medium`
/// keep their rows.
pub const HIGH_SHADOW_CASCADES: u8 = 4;
/// How far the sun's shadows reach at `high` and `ultra` (metres): the far woods in the wide shot.
const SHADOW_DISTANCE: u16 = 110;

/// The fog's extinction per metre at the water and how fast it thins with height (per metre).
const FOG_DENSITY: f32 = 0.0032;
const FOG_HEIGHT_FALLOFF: f32 = 0.16;
/// The golden hour, for the whole frame: the look's white balance (linear gains, normalised to keep
/// the brightness). The sun itself is white outside the atmosphere; the physical sky reddens it on
/// its way down, and this warms what the sky's blue fill would cool. A light touch: under AgX
/// punchy's saturation (P2-0.10) pass 1's [1.0, 0.9, 0.76] turned the grass and canopy acid
/// yellow-green and the dock orange (G0 look: mean chroma 24.6 -> 32.3 on the wide shot, at the same
/// luma). Green is held down with blue (G0 leftovers): at [1.0, 0.98, 0.94] the frame lost pass
/// 1's red with its blue, and the sunlit meadow and canopy turned acid yellow (mean hue 2.7-4.6
/// degrees yellower than pass 1 on every shot). Punchy now saturates display-encoded values, as
/// pass 1 did, which keeps a sunlit blade's blue (acid-yellow share at 720p high: wide 0.09%,
/// forest 0.09%): at these gains each shot's hue is within 0.6 degrees of pass 1's and the
/// closeup keeps 90% of the art's chroma at every preset (at [1.0, 0.955, 0.93] it fell to 88%;
/// at [1.0, 0.93, 0.92] the cabin was 3.5 degrees redder).
pub const WHITE_BALANCE: [f32; 3] = [1.0, 0.945, 0.9];
/// Bloom: the lanterns', windows' and fireflies' glow and the sun's sheen on the water, held soft.
const BLOOM_INTENSITY: f32 = 0.05;
const BLOOM_RADIUS: f32 = 1.4;
/// Ambient occlusion's strength and reach (the grass at the trunks, the cabin's footing, the logs'
/// seams) and the sun's contact shadows' reach (the bark's and the stones' small shadows). The
/// strength is light (owner decision 2026-10-12 (a)): `low` draws no AO by design, and at full
/// strength GTAO's final power took 43% of the shaded cabin walls' light (the logs' grooves hide
/// about a fifth of the sky, `ao.rs`'s log-wall row), so the hero object's exposure jumped between
/// `low` and the AO presets. At 0.1 the walls stay within 15% of `low` (the shots' cabin-wall row).
const AO_INTENSITY: f32 = 0.1;
const AO_RADIUS: f32 = 0.9;
const CONTACT_SHADOW_LENGTH: f32 = 0.35;

/// The lakeside's height fog, the look's own (the same on every preset and device): thick over the
/// lake and the low meadow, thinning up the hills, its light the sky's (so the haze meets the sky
/// at the horizon), with the sky's own aerial perspective on top where the quality draws it. The
/// built-in surfaces and the terrain (a Level-2 material shaded by `gx_shade_pbr`) take it as they
/// are shaded; the grass and the lake, drawn by passes, apply the same fog row from the v2 tables
/// themselves (`common.wgsl`'s `look_fog`).
pub fn look_fog() -> Fog {
    Fog::default().with_density(FOG_DENSITY).with_height(FOG_HEIGHT_FALLOFF, 0.0)
}

/// The world target's size: the size captures are taken at.
pub const WORLD_SIZE: [u32; 2] = [1280, 720];

/// The lakeside's render choices: AgX with its punchy look (the filmic roll-off keeps the low sun,
/// the lanterns and the fireflies from clipping while the golden colours stay rich), auto
/// exposure (a moonlit night kept a night, [`crate::daylight::EXPOSURE_CURVE`]), the height fog
/// under a warm white balance, soft bloom, light ambient occlusion and
/// contact shadows, and the sun's shadows at their best where the device allows: four cascades
/// reaching the far woods, PCSS-lite at `high` and full PCSS at `ultra` (phones and weak
/// desktops are held to their caps).
pub fn render_config() -> RenderConfig {
    let shadows = ShadowConfig::new().cascades(HIGH_SHADOW_CASCADES).distance(SHADOW_DISTANCE);
    let mut config = RenderConfig::new()
        .tonemap(Tonemap::AgxPunchy)
        .exposure(Exposure::auto().compensation(LOOK_EV_COMPENSATION))
        .exposure_curve(&crate::daylight::EXPOSURE_CURVE)
        .fog(look_fog())
        .white_balance(WHITE_BALANCE)
        .bloom(Bloom::new(BLOOM_INTENSITY).radius(BLOOM_RADIUS))
        .shadows_at(QualityPreset::High, shadows.filter(ShadowFilter::PcssLite))
        .shadows_at(QualityPreset::Ultra, shadows.filter(ShadowFilter::Pcss));
    config.look.ao_intensity = AO_INTENSITY;
    config.look.ao_radius = AO_RADIUS;
    config.look.contact_shadow_length = CONTACT_SHADOW_LENGTH;
    config
}

/// The game before its hooks: its title, size, background and render choices ([`render_config`]).
pub fn new_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Lakeside").world_size(WORLD_SIZE[0], WORLD_SIZE[1]).background(HORIZON);
    game.render_settings(render_config());
    game
}

/// Register every hook and pass.
pub fn wire(game: &mut Game<World>) {
    game.on_reset(|sim, _seed, _rng, gfx| sim.world.models = Models::load(gfx));
    game.on_update(|sim, ctx| update(&mut sim.world, ctx));
    game.on_ui(|sim, ui, _ctx| crate::hud::ui(&mut sim.world, ui));
    game.on_draw(|sim, frame, camera| draw(&sim.world, frame, camera));
    game.camera(|sim| sim.world.camera());
    for shot in named_shots() {
        game.named_camera(shot.name, move |_| shot.camera());
    }
    game.probe("view", |sim| json!({ "mode": sim.world.mode.label(), "tick": sim.world.tick, "backdrop": sim.world.backdrop.label(), "time": sim.world.time.label() }));
    game.probe("scene", |_| scene_probe());
    passes::wire(game);
}

#[cfg(test)]
mod tests {
    use genex::Runtime;
    use genex::render::{DeviceClass, PresetChoice, RenderChange};

    use crate::world::World;

    use super::*;

    /// The shadow cascades a capture of the lakeside draws on `class` at `preset`.
    fn cascades(class: &str, preset: QualityPreset) -> u8 {
        let runtime = Runtime::new(new_game()).expect("installs");
        let handle = runtime.render();
        let class = DeviceClass::from_wire(class).expect("a known class");
        handle.borrow_mut().apply(&RenderChange { device_class: Some(Some(class)), preset: Some(Some(PresetChoice::Preset(preset))), ..RenderChange::default() });
        let (frame, _) = handle.borrow().capture_frame();
        frame.quality.shadows.cascades
    }

    /// Whether the game view's frame after `ticks` more ticks (with `key` tapped first) asks for a
    /// camera cut.
    fn cut_after(runtime: &mut Runtime<World>, key: Option<genex::Key>, ticks: u32) -> bool {
        if let Some(key) = key {
            runtime.inject(genex::Input::key_tap(key));
        }
        runtime.step(f64::from(ticks) * genex::FIXED_STEP_MS);
        runtime.frame(genex::View::Game).expect("a frame").is_camera_cut()
    }

    #[test]
    fn a_key_that_moves_the_camera_to_another_shot_cuts_once_and_free_flight_from_where_it_was_does_not() {
        let mut game = new_game();
        wire(&mut game);
        let mut runtime = Runtime::new(game).expect("installs");
        runtime.seed(1);
        runtime.start();
        assert!(!cut_after(&mut runtime, None, 10), "the tour flies: no cut");
        assert!(cut_after(&mut runtime, Some(genex::Key::Digit4), 1), "a shot key jumps the camera: a cut");
        assert!(!cut_after(&mut runtime, None, 1), "the shot holds: one cut, then none");
        assert!(cut_after(&mut runtime, Some(genex::Key::Space), 1), "back to the tour: a cut");
        assert!(!cut_after(&mut runtime, Some(genex::Key::KeyF), 1), "the free camera starts where the camera was");
    }

    #[test]
    fn every_animal_draw_carries_its_own_id_for_taa_and_the_still_scenery_none() {
        use genex::render::DrawId;
        let mut game = new_game();
        wire(&mut game);
        let mut runtime = Runtime::new(game).expect("installs");
        runtime.seed(1);
        runtime.start();
        runtime.step(30.0 * genex::FIXED_STEP_MS);
        let frame = runtime.frame(genex::View::Game).expect("a frame");
        let ids_under = |tag: &str| frame.draws().iter().filter(|draw| draw.tag == tag).map(|draw| draw.id).collect::<Vec<_>>();
        let animals = ids_under("animals");
        assert!(!animals.is_empty() && animals.iter().all(Option::is_some), "every animal part is named");
        for key in ["duck-0", "duck-1", "duck-2", "deer-0", "deer-1"] {
            assert!(animals.contains(&Some(DrawId::from(key))), "{key} is drawn under its id");
        }
        let dock = ids_under("dock");
        assert!(dock.contains(&Some(DrawId::from("boat"))) && dock.contains(&Some(DrawId::from("fisher"))), "the boat and the fisher move: named");
        assert!(dock.contains(&None), "the planks stay unnamed");
        for still in ["terrain", "lanterns"] {
            assert!(ids_under(still).iter().all(Option::is_none), "{still}: nothing named");
        }
    }

    #[test]
    fn the_lakeside_draws_four_cascades_at_high_on_a_desktop_and_the_devices_rows_elsewhere() {
        assert_eq!(cascades("desktop-high", QualityPreset::High), HIGH_SHADOW_CASCADES, "the game's own choice at high");
        assert_eq!(cascades("desktop-high", QualityPreset::Medium), 2, "medium keeps its row");
        // Low's row and the weakest phone's cap draw two cascades since the pass-1 shadows fix
        // (gate findings 01 and 02: 2 x 1024 on a desktop's low, 2 x 512 on mobile-low).
        assert_eq!(cascades("desktop-high", QualityPreset::Low), 2, "low keeps its row");
        assert_eq!(cascades("mobile-high", QualityPreset::High), 2, "a phone is held to its cap");
        assert_eq!(cascades("mobile-low", QualityPreset::High), 2, "the weakest phone draws its cap's two");
    }
}
