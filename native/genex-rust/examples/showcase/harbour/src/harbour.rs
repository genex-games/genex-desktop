//! Harbour Street, every hook registered: the clock, the camera (a tour that holds each named shot
//! and cuts to the next, a held shot, or a free camera the player flies), the sky switch, the HUD,
//! the look and the probes. The street itself is `street.rs`.

use genex::egui;
use genex::math::{self, Vec3, vec3};
use genex::prelude::*;
use genex::render::{Bloom, Environment, Exposure, Fog, HdriEnvironment, HdriSun, QualityPreset, RenderConfig, ShadowConfig, ShadowFilter, SkyParams, Tonemap};

use crate::street::{self, Surfaces};

/// The world target's size: the size captures are taken at.
pub const WORLD_SIZE: [u32; 2] = [1280, 720];
/// Ticks per second of simulated time.
pub const TICKS_PER_SECOND: f32 = 60.0;
/// Ticks the tour holds each shot before it cuts to the next (eight seconds).
pub const SHOT_HOLD_TICKS: u64 = 480;

/// Cascades and reach of the sun's shadows at `high` and `ultra` (metres): the street is short, so
/// four cascades over 60 m keep the café's window shafts and the crossing's shadows crisp.
const SHADOW_CASCADES: u8 = 4;
const SHADOW_DISTANCE: u16 = 60;
/// The damp air after the rain: extinction per metre at the street and how fast it thins with
/// height (per metre).
const FOG_DENSITY: f32 = 0.006;
const FOG_HEIGHT_FALLOFF: f32 = 0.12;
/// Dusk's key: auto exposure draws the street this far under middle grey, so the neon, the bulbs
/// and the café's windows carry the picture (G0 look: at middle grey every shot read as daylight).
/// A look's key, not a patch of the curve (owner decision D2 removed those).
const DUSK_KEY_EV: f32 = -1.5;

/// Bloom: the neon, the bulbs and the lamps glow, held soft.
const BLOOM_INTENSITY: f32 = 0.06;
const BLOOM_RADIUS: f32 = 1.2;
/// The physical sky's light against the low sun: dusk, the shade stays deep and blue.
const SKY_INTENSITY: f32 = 0.7;
/// The physical sky's sun disk, in degrees of angular radius.
const SKY_SUN_DEGREES: f32 = 0.5;
/// The ground the physical sky sees below the horizon (linear rgb): wet asphalt.
const SKY_GROUND: [f32; 3] = [0.05, 0.05, 0.055];
/// The fetched overcast dusk map (CC0, Poly Haven `kloppenheim_01_puresky`; assets-manifest.json).
pub const DUSK_HDRI: &str = "fetched/dusk-sky.hdr";
/// The dusk map's light against the street's sun (the map is lit as it is, its own sun off, so the
/// street's low sun keeps shining down the side street and through the café's windows).
const DUSK_INTENSITY: f32 = 0.8;

/// Free-camera speeds: metres per second (running with Shift), radians per second, radians per
/// pixel of mouse movement; it never looks straight up or down.
const FREE_SPEED: f32 = 4.0;
const FREE_RUN: f32 = 3.0;
const FREE_TURN: f32 = 1.4;
const FREE_LOOK: f32 = 0.004;
const PITCH_LIMIT: f32 = 1.35;
/// The free camera's height above the street (metres) at least.
const FREE_FLOOR: f32 = 0.3;
const FREE_FOVY: f32 = 55.0;

/// A fixed camera shot: the same picture before and after a renderer change.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shot {
    /// Its camera name (`cameras` lists it; `capture` takes it).
    pub name: &'static str,
    /// Where the camera stands, in the world.
    pub eye: Vec3,
    /// What it looks at, in the world.
    pub target: Vec3,
    /// Its vertical field of view in degrees.
    pub fovy: f32,
}

impl Shot {
    /// The shot as a facade camera.
    pub fn camera(&self) -> Camera {
        Camera { fovy: self.fovy, ..Camera::look_at(self.eye, self.target) }
    }
}

/// The named shots, in tour order (renderer pass 2 plan, section 6; the night street comes with the
/// day and night toggle): the street down to the crossing, a puddle at the crossing under the
/// café's front, the neon alley, the café inside, and the sun's shafts through its windows.
pub const SHOTS: [Shot; 5] = [
    Shot { name: "street-wide", eye: vec3(-26.0, 1.7, -2.0), target: vec3(6.0, 3.0, 2.5), fovy: 55.0 },
    Shot { name: "puddle", eye: vec3(-1.0, 0.42, -5.8), target: vec3(0.6, 1.0, 7.5), fovy: 46.0 },
    Shot { name: "neon-alley", eye: vec3(15.0, 1.7, 2.5), target: vec3(15.0, 3.0, 26.0), fovy: 50.0 },
    Shot { name: "cafe", eye: vec3(5.3, 1.65, 13.5), target: vec3(-4.5, 1.1, 11.0), fovy: 58.0 },
    Shot { name: "window-shafts", eye: vec3(-1.8, 2.9, 15.2), target: vec3(-3.0, 0.2, 9.5), fovy: 52.0 },
];

/// How the camera moves.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum CameraMode {
    /// Each shot in turn, held for [`SHOT_HOLD_TICKS`] and cut to the next (the default).
    #[default]
    Tour,
    /// One fixed shot ([`SHOTS`]).
    Shot(usize),
    /// The free camera.
    Free,
}

impl CameraMode {
    /// Its name for the HUD and the `view` probe.
    pub fn label(self) -> &'static str {
        match self {
            CameraMode::Tour => "tour",
            CameraMode::Shot(i) => SHOTS[i.min(SHOTS.len() - 1)].name,
            CameraMode::Free => "free",
        }
    }
}

/// What lights the street besides the sun and draws behind it: the renderer's physical sky lit by
/// the frame's sun (the default), or the fetched overcast dusk map (B switches).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Backdrop {
    /// The physical sky.
    #[default]
    Sky,
    /// The fetched dusk map ([`DUSK_HDRI`]; without the asset cache it is missing and the renderer
    /// lights with the flat colour).
    Dusk,
}

impl Backdrop {
    /// Its name for the HUD and the `view` probe.
    pub fn label(self) -> &'static str {
        match self {
            Backdrop::Sky => "sky",
            Backdrop::Dusk => "dusk-hdri",
        }
    }

    /// The environment a frame declares for it.
    pub fn environment(self) -> Environment {
        match self {
            Backdrop::Sky => Environment::Sky(SkyParams::default().with_intensity(SKY_INTENSITY).with_sun_angular_radius_degrees(SKY_SUN_DEGREES).with_ground_albedo(SKY_GROUND)),
            Backdrop::Dusk => Environment::Hdri(HdriEnvironment::new(DUSK_HDRI).with_intensity(DUSK_INTENSITY).with_sun(HdriSun::Off)),
        }
    }

    fn next(self) -> Backdrop {
        match self {
            Backdrop::Sky => Backdrop::Dusk,
            Backdrop::Dusk => Backdrop::Sky,
        }
    }
}

/// The free camera's pose.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FreeCam {
    /// Where it stands.
    pub eye: Vec3,
    /// Its turn about +y (0 looks along +x).
    pub yaw: f32,
    /// Its tilt (positive looks up).
    pub pitch: f32,
}

impl FreeCam {
    /// The pose looking from `eye` towards `target`.
    pub fn looking(eye: Vec3, target: Vec3) -> FreeCam {
        let d = (target - eye).normalize_or(Vec3::X);
        FreeCam { eye, yaw: math::atan2(d.z, d.x), pitch: math::asin(d.y.clamp(-1.0, 1.0)) }
    }

    /// The unit direction it looks along.
    pub fn forward(&self) -> Vec3 {
        let (sp, cp) = math::sin_cos(self.pitch);
        let (sy, cy) = math::sin_cos(self.yaw);
        vec3(cy * cp, sp, sy * cp)
    }
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed: the tour and every animation read it.
    pub tick: u64,
    /// How the camera moves.
    pub mode: CameraMode,
    /// The free camera's pose (kept when switching away and back).
    pub free: FreeCam,
    /// Whether the HUD is hidden (H).
    pub hud_hidden: bool,
    /// Whether the person's graphics panel is open (O, or the HUD's settings button).
    pub settings_open: bool,
    /// What the HUD covered on the last frame, in world pixels (min x, min y, max x, max y).
    pub hud_area: Option<[f32; 4]>,
    /// What lights the street besides the sun (B).
    pub backdrop: Backdrop,
    /// The time of day: the dusk, the night or the clear day (N).
    pub time: crate::nightfall::TimeOfDay,
    /// The tick whose frame starts a new shot because a key moved the camera there.
    pub cut_at: Option<u64>,
    /// The surfaces the draw hook uses.
    pub surfaces: Surfaces,
    /// The steam and the drizzle (the same emitters every seed).
    pub weather: street::Weather,
    /// The same steam and drizzle at night, darker (renderer pass 2 B.12).
    pub night_weather: crate::nightfall::NightWeather,
    /// The surfaces at night, the street soaked (renderer pass 2 B.12).
    pub night_surfaces: crate::nightfall::NightSurfaces,
}

impl World {
    /// Simulated seconds since the seed.
    pub fn seconds(&self) -> f32 {
        self.tick as f32 / TICKS_PER_SECOND
    }

    /// The shot the tour holds at this tick.
    pub fn tour_shot(&self) -> usize {
        ((self.tick / SHOT_HOLD_TICKS) % SHOTS.len() as u64) as usize
    }

    /// The camera this tick.
    pub fn camera(&self) -> Camera {
        match self.mode {
            CameraMode::Tour => SHOTS[self.tour_shot()].camera(),
            CameraMode::Shot(i) => SHOTS[i.min(SHOTS.len() - 1)].camera(),
            CameraMode::Free => Camera { fovy: FREE_FOVY, ..Camera::look_at(self.free.eye, self.free.eye + self.free.forward()) },
        }
    }

    /// Whether this tick's frame starts a new shot: a key moved the camera, or the tour cut.
    pub fn is_cut(&self) -> bool {
        let tour_cut = self.mode == CameraMode::Tour && self.tick > 0 && self.tick.is_multiple_of(SHOT_HOLD_TICKS);
        tour_cut || self.cut_at == Some(self.tick)
    }
}

/// Move the free camera one tick from the keys and the mouse.
fn fly(free: &mut FreeCam, ctx: &Ctx<'_>) {
    let keys = ctx.keys;
    let axis = |plus: Key, minus: Key| f32::from(u8::from(keys.down(plus))) - f32::from(u8::from(keys.down(minus)));
    free.yaw += axis(Key::ArrowRight, Key::ArrowLeft) * FREE_TURN * ctx.dt;
    free.pitch += axis(Key::ArrowUp, Key::ArrowDown) * FREE_TURN * ctx.dt;
    if ctx.pointer_lock || keys.down(Key::Mouse1) {
        free.yaw += ctx.look.x * FREE_LOOK;
        free.pitch -= ctx.look.y * FREE_LOOK;
    }
    free.pitch = free.pitch.clamp(-PITCH_LIMIT, PITCH_LIMIT);
    let forward = free.forward();
    let right = forward.cross(Vec3::Y).normalize_or(Vec3::Z);
    let run = if keys.down(Key::ShiftLeft) || keys.down(Key::ShiftRight) { FREE_RUN } else { 1.0 };
    let step = forward * axis(Key::KeyW, Key::KeyS) + right * axis(Key::KeyD, Key::KeyA) + Vec3::Y * axis(Key::KeyE, Key::KeyQ);
    free.eye += step * FREE_SPEED * run * ctx.dt;
    free.eye.y = free.eye.y.max(FREE_FLOOR);
}

/// One tick: the clock, the camera keys (1–5 a shot, Space the tour, F the free camera, H the HUD,
/// O the graphics panel), the sky (B), the time of day (N) and the free camera's flight.
pub fn update(world: &mut World, ctx: &Ctx<'_>) {
    world.tick = ctx.tick + 1;
    let before = world.mode;
    let digits = [Key::Digit1, Key::Digit2, Key::Digit3, Key::Digit4, Key::Digit5];
    if let Some(shot) = digits.iter().position(|key| ctx.keys.pressed(*key)) {
        world.mode = CameraMode::Shot(shot);
    }
    if ctx.keys.pressed(Key::Space) {
        world.mode = CameraMode::Tour;
    }
    if ctx.keys.pressed(Key::KeyF) && world.mode != CameraMode::Free {
        let camera = world.camera();
        world.free = FreeCam::looking(camera.position, camera.target);
        world.mode = CameraMode::Free;
    }
    if ctx.keys.pressed(Key::KeyH) {
        world.hud_hidden = !world.hud_hidden;
    }
    if ctx.keys.pressed(Key::KeyO) {
        world.settings_open = !world.settings_open;
    }
    if ctx.keys.pressed(Key::KeyB) {
        world.backdrop = world.backdrop.next();
    }
    if ctx.keys.pressed(Key::KeyN) {
        world.time = world.time.next();
    }
    if world.mode != before && world.mode != CameraMode::Free {
        world.cut_at = Some(world.tick);
    }
    if world.mode == CameraMode::Free {
        fly(&mut world.free, ctx);
    }
}

/// The settings button's label (checks find it in `state().hud.items`).
pub const SETTINGS_BUTTON: &str = "Settings";
/// The HUD card's background (the dusk's blue, mostly see-through) and its text colours.
const CARD: egui::Color32 = egui::Color32::from_rgba_premultiplied(14, 18, 30, 150);
const TITLE: egui::Color32 = egui::Color32::from_rgb(255, 196, 150);
const BODY: egui::Color32 = egui::Color32::from_rgb(226, 230, 238);
const HINT: egui::Color32 = egui::Color32::from_rgb(176, 186, 204);
/// The graphics panel's width and the HUD's clearance from the screen edges, in world pixels.
const PANEL_WIDTH: f32 = 300.0;
const EDGE_MARGIN: i8 = 16;

/// Draw the HUD card in the top-left corner and, while it is open, the graphics panel under it.
pub fn ui(world: &mut World, ui: &mut egui::Ui) {
    let mut area: Option<egui::Rect> = None;
    if !world.hud_hidden {
        let card = egui::Frame::new().fill(CARD).corner_radius(10.0).inner_margin(egui::Margin::same(12)).outer_margin(egui::Margin::same(EDGE_MARGIN));
        area = Some(card.show(ui, |ui| card_contents(world, ui)).response.rect);
    }
    if world.settings_open {
        let margin = egui::Margin { left: EDGE_MARGIN, ..egui::Margin::ZERO };
        let panel = egui::Frame::popup(ui.style()).outer_margin(margin).show(ui, |ui| {
            ui.set_max_width(PANEL_WIDTH);
            ui.with_layout(egui::Layout::top_down(egui::Align::Min), genex::render::settings_panel);
        });
        let rect = panel.response.rect;
        area = Some(area.map_or(rect, |card| card.union(rect)));
    }
    world.hud_area = area.map(|rect| [rect.min.x, rect.min.y, rect.max.x, rect.max.y]);
}

fn card_contents(world: &mut World, ui: &mut egui::Ui) {
    let shot = match world.mode {
        CameraMode::Tour => format!("Tour: {}", SHOTS[world.tour_shot()].name),
        CameraMode::Free => "Free camera".to_owned(),
        CameraMode::Shot(i) => format!("Shot {}: {}", i + 1, SHOTS[i.min(SHOTS.len() - 1)].name),
    };
    ui.label(egui::RichText::new("Harbour Street at dusk").color(TITLE).size(18.0).strong());
    // The dusk's card is the one the Studio's digests were recorded with; another time of day is
    // named after the backdrop.
    let time = match world.time {
        crate::nightfall::TimeOfDay::Dusk => String::new(),
        time => format!(" · {} (N)", time.label()),
    };
    ui.label(egui::RichText::new(format!("{shot} · {}{time}", world.backdrop.label())).color(BODY).size(14.0));
    ui.add_space(4.0);
    let hint = if world.mode == CameraMode::Free {
        "WASD move · Q/E down/up · arrows or drag to look · Space tour"
    } else {
        "1–5 shots · Space tour · F free camera · B sky/HDRI · O settings · H hide"
    };
    ui.label(egui::RichText::new(hint).color(HINT).size(12.0));
    ui.add_space(4.0);
    if genex::render::settings_button(ui, SETTINGS_BUTTON).clicked() {
        world.settings_open = !world.settings_open;
    }
}

/// The street's height fog: thin, the damp air after the rain, its light the sky's.
pub fn look_fog() -> Fog {
    Fog::default().with_density(FOG_DENSITY).with_height(FOG_HEIGHT_FALLOFF, 0.0)
}

/// Harbour Street's render choices: AgX punchy with auto exposure keyed low for dusk
/// ([`DUSK_KEY_EV`]; the night kept dark, [`crate::nightfall::EXPOSURE_CURVE`]), the damp air's fog, soft bloom for the neon, and the sun's shadows at their
/// best where the device allows (four cascades over the street, PCSS-lite at `high`, full PCSS at
/// `ultra`).
pub fn render_config() -> RenderConfig {
    let shadows = ShadowConfig::new().cascades(SHADOW_CASCADES).distance(SHADOW_DISTANCE);
    RenderConfig::new()
        .tonemap(Tonemap::AgxPunchy)
        .exposure(Exposure::auto().compensation(DUSK_KEY_EV))
        .exposure_curve(&crate::nightfall::EXPOSURE_CURVE)
        .fog(look_fog())
        .bloom(Bloom::new(BLOOM_INTENSITY).radius(BLOOM_RADIUS))
        .shadows_at(QualityPreset::High, shadows.filter(ShadowFilter::PcssLite))
        .shadows_at(QualityPreset::Ultra, shadows.filter(ShadowFilter::Pcss))
}

/// The game before its hooks: its title, size, background and render choices.
pub fn new_game() -> Game<World> {
    let mut game = Game::new(World::default()).title("Harbour Street").world_size(WORLD_SIZE[0], WORLD_SIZE[1]).background(street::DUSK);
    game.render_settings(render_config());
    game
}

/// Register every hook.
pub fn wire(game: &mut Game<World>) {
    game.on_update(|sim, ctx| update(&mut sim.world, ctx));
    game.on_ui(|sim, egui_ui, _ctx| ui(&mut sim.world, egui_ui));
    game.on_draw(|sim, frame, _camera| street::draw(&sim.world, frame));
    game.camera(|sim| sim.world.camera());
    for shot in SHOTS {
        game.named_camera(shot.name, move |_| shot.camera());
    }
    game.probe("view", |sim| json!({ "mode": sim.world.mode.label(), "tick": sim.world.tick, "backdrop": sim.world.backdrop.label(), "time": sim.world.time.label() }));
    game.probe("where", |sim| street::where_probe(sim.world.camera().position));
    game.probe("scene", |_| street::scene_probe());
}
