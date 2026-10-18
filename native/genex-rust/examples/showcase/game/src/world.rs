//! The simulation: the tick every animation reads, the camera (a slow tour through the named shots,
//! a fixed shot, or a free camera the player flies) and the model handles the draw hook uses.

use genex::math::{self, Vec3, vec3};
use genex::prelude::*;
use genex::render::{Clouds, Environment, HdriEnvironment, SkyParams};
use genex::{Gfx, Model, Terrain, TerrainLayer};

use crate::layout::{TreeLod, layout, tree_asset};

/// Ticks per second of simulated time.
pub const TICKS_PER_SECOND: f32 = 60.0;
/// Seconds the tour spends flying from one shot to the next (holding at each for a moment).
const TOUR_LEG_SECONDS: f32 = 14.0;
/// How far the tour lifts the camera halfway between two shots, so it never flies through a tree.
const TOUR_LIFT: f32 = 5.0;
/// Free-camera speeds: metres per second (running with Shift), radians per second, radians per
/// pixel of mouse movement.
const FREE_SPEED: f32 = 6.0;
const FREE_RUN: f32 = 3.0;
const FREE_TURN: f32 = 1.4;
const FREE_LOOK: f32 = 0.004;
/// The free camera never looks straight up or down.
const PITCH_LIMIT: f32 = 1.35;

/// A fixed camera shot: the same picture before and after a renderer change.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shot {
    /// Its camera name (`cameras` lists it; `capture` takes it).
    pub name: &'static str,
    /// Where the camera stands: x and z, and y above the ground (or the water).
    pub eye: Vec3,
    /// What it looks at: x and z, and y above the ground (or the water).
    pub target: Vec3,
    /// Its vertical field of view in degrees.
    pub fovy: f32,
}

/// `p` with its y measured from the ground (or the water) instead of from zero.
fn above_ground(p: Vec3) -> Vec3 {
    vec3(p.x, crate::layout::height(p.x, p.z).max(crate::layout::WATER_LEVEL) + p.y, p.z)
}

impl Shot {
    /// Where the camera stands, in the world.
    pub fn eye(&self) -> Vec3 {
        above_ground(self.eye)
    }

    /// What it looks at, in the world.
    pub fn target(&self) -> Vec3 {
        above_ground(self.target)
    }

    /// The shot as a facade camera.
    pub fn camera(&self) -> Camera {
        Camera { fovy: self.fovy, ..Camera::look_at(self.eye(), self.target()) }
    }
}

/// The named shots, in tour order.
pub const SHOTS: [Shot; 5] = [
    Shot { name: "wide", eye: vec3(-30.0, 9.0, 12.0), target: vec3(4.4, 0.0, 1.5), fovy: 55.0 },
    Shot { name: "dock", eye: vec3(-8.5, 2.1, -6.5), target: vec3(10.0, 0.4, -1.0), fovy: 50.0 },
    Shot { name: "cabin", eye: vec3(-15.0, 2.2, -5.5), target: vec3(-8.0, 1.2, -21.0), fovy: 46.0 },
    Shot { name: "forest", eye: vec3(-25.0, 1.6, -37.0), target: vec3(-10.0, 2.2, -31.5), fovy: 50.0 },
    Shot { name: "closeup", eye: vec3(-30.0, 0.55, -2.0), target: vec3(-14.0, 1.1, -6.0), fovy: 42.0 },
];

/// Lakeside v2's shots (renderer pass 2, plan section 6), after pass 1's five (kept for continuity;
/// the tour flies through those only): a wide golden hour over the lake into the low sun, a shore
/// close-up crouched on the east beach's pebbles, looking along the waterline with the sun behind,
/// the forest floor looking into the sun through the trunks and the cabin's lamplit room from its
/// back corner (the table lamp, the hearth and the sun through the open door; a reflection probe
/// and an irradiance volume over the room). 6–9 hold them.
pub const V2_SHOTS: [Shot; 4] = [
    Shot { name: "golden-wide", eye: vec3(-44.0, 13.0, -14.0), target: vec3(8.0, 0.0, 6.0), fovy: 52.0 },
    Shot { name: "shore", eye: vec3(27.0, 0.9, -2.0), target: vec3(8.0, 0.3, -14.0), fovy: 46.0 },
    Shot { name: "forest-floor", eye: vec3(-24.0, 0.6, -44.0), target: vec3(-8.0, 2.4, -32.0), fovy: 56.0 },
    Shot { name: "cabin-interior", eye: vec3(-7.675, 1.8, -23.673), target: vec3(-9.688, 1.05, -19.598), fovy: 60.0 },
];

/// Every named shot: pass 1's five, then Lakeside v2's.
pub fn named_shots() -> impl Iterator<Item = &'static Shot> {
    SHOTS.iter().chain(V2_SHOTS.iter())
}

/// Named shot `i` ([`named_shots`] order; past the last, the last).
pub fn shot_at(i: usize) -> &'static Shot {
    named_shots().nth(i).unwrap_or(&V2_SHOTS[V2_SHOTS.len() - 1])
}

/// How the camera moves.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum CameraMode {
    /// The slow fly-through of every shot (the default).
    #[default]
    Tour,
    /// One fixed shot ([`named_shots`]).
    Shot(usize),
    /// The free camera.
    Free,
}

impl CameraMode {
    /// Its name for the HUD and the `view` probe.
    pub fn label(self) -> &'static str {
        match self {
            CameraMode::Tour => "tour",
            CameraMode::Shot(i) => shot_at(i).name,
            CameraMode::Free => "free",
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

/// What lights the lakeside besides the sun and draws behind it: the renderer's physical sky,
/// lit by the frame's sun (the default), the fetched golden-hour sky map, or the committed clear
/// CC0 map in `assets/env/` (B steps through them).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub enum Backdrop {
    /// The physical sky.
    #[default]
    Sky,
    /// The fetched golden-hour map ([`GOLDEN_HDRI`]; without the asset cache it is missing and the
    /// renderer lights with the flat colour).
    Golden,
    /// The committed clear map ([`HDRI`]).
    Map,
}

/// The HDR map the [`Backdrop::Map`] lights with (CC0, Poly Haven; THIRD-PARTY-NOTICES.md).
pub const HDRI: &str = "env/kloofendal_43d_clear_puresky_1k.hdr";
/// The fetched golden-hour map (CC0, Poly Haven `kloppenheim_06_puresky`; assets-manifest.json).
pub const GOLDEN_HDRI: &str = "fetched/golden-sky.hdr";
/// The physical sky's light against the lakeside's sun: a little under the sky's own, so the shade
/// stays deep beside the low sun's light.
pub const SKY_INTENSITY: f32 = 0.8;
/// The physical sky's sun disk, in degrees of angular radius: a little larger than the real sun so
/// the low sun reads through the haze.
pub const SKY_SUN_DEGREES: f32 = 0.6;
/// The ground the physical sky sees below the horizon (linear rgb): the meadow's olive.
pub const SKY_GROUND: [f32; 3] = [0.16, 0.15, 0.08];
/// The physical sky's clouds (renderer pass 2 B.5, drawn from desktop medium up; phones and low
/// draw none, D16): a few fair-weather cumulus over the lake, thinner than the renderer's default.
/// The clouds light the scene's ambient through the environment cube: at 0.4 they warmed the
/// golden meadow on the wide shot's left by 13 levels (owner decision D20 keeps that warmth); at
/// 0.3 hardly a cloud shows.
pub const SKY_CLOUD_COVERAGE: f32 = 0.4;
/// The cirrus sheet above them: the streaky deck the low sun lights gold, which the game's flat
/// clouds drew before the renderer's took over (look fix lane SKY).
pub const SKY_CIRRUS: f32 = 0.6;

/// The physical sky's layer of clouds ([`SKY_CLOUD_COVERAGE`], [`SKY_CIRRUS`]).
pub fn sky_clouds() -> Clouds {
    Clouds::default().with_coverage(SKY_CLOUD_COVERAGE).with_cirrus(SKY_CIRRUS)
}
/// The clear map's light against the lakeside's sun: its midday sky is far brighter than the
/// golden-hour scene was lit for.
pub const HDRI_INTENSITY: f32 = 0.25;
/// The golden map's light against the lakeside's sun.
pub const GOLDEN_INTENSITY: f32 = 0.6;
/// The golden map's turn about the up axis that puts its sun where the lakeside's sun is
/// (`layout::SUN_DIR`'s azimuth; the map's own sun becomes the scene's).
pub const GOLDEN_ROTATION_DEGREES: f32 = -86.1;

impl Backdrop {
    /// Its name for the HUD and the `view` probe.
    pub fn label(self) -> &'static str {
        match self {
            Backdrop::Sky => "sky",
            Backdrop::Golden => "golden-hdri",
            Backdrop::Map => "hdri",
        }
    }

    /// The environment a frame declares for it.
    pub fn environment(self) -> Environment {
        match self {
            Backdrop::Sky => Environment::Sky(
                SkyParams::default()
                    .with_intensity(SKY_INTENSITY)
                    .with_sun_angular_radius_degrees(SKY_SUN_DEGREES)
                    .with_ground_albedo(SKY_GROUND)
                    .with_clouds(Some(sky_clouds())),
            ),
            Backdrop::Golden => Environment::Hdri(HdriEnvironment::new(GOLDEN_HDRI).with_intensity(GOLDEN_INTENSITY).with_rotation_degrees(GOLDEN_ROTATION_DEGREES)),
            Backdrop::Map => Environment::Hdri(HdriEnvironment::new(HDRI).with_intensity(HDRI_INTENSITY)),
        }
    }

    /// The next one.
    fn next(self) -> Backdrop {
        match self {
            Backdrop::Sky => Backdrop::Golden,
            Backdrop::Golden => Backdrop::Map,
            Backdrop::Map => Backdrop::Sky,
        }
    }
}

/// One tree mesh pair: its wood and its foliage.
#[derive(Clone, Debug, Default)]
pub struct TreeMeshes {
    /// The trunk and branches.
    pub wood: Model,
    /// The leaves or needles.
    pub foliage: Model,
}

/// The model handles and materials the draw hook uses, one per asset, made once per seed.
#[derive(Clone, Debug, Default)]
pub struct Models {
    /// The ground: the renderer's built-in terrain over the layout's heights ([`terrain`]).
    pub terrain: Option<Terrain>,
    /// Broadleaf meshes: per variant, per level of detail ([`TreeLod::ALL`]).
    pub broadleaf: Vec<Vec<TreeMeshes>>,
    /// Pine meshes: per variant, per level of detail.
    pub pine: Vec<Vec<TreeMeshes>>,
    /// Rock variants.
    pub rock: Vec<Model>,
    /// The beach's pebbles and the path's stones, scattered on the terrain's layers
    /// ([`crate::draw::stone_groups`]): one retained instance group per rock variant and kind.
    pub stones: Vec<genex::InstanceGroup>,
    /// A unit cylinder (radius 0.5, height 1 from y 0).
    pub cylinder: Model,
    /// A unit sphere (radius 1) with smooth normals.
    pub sphere: Model,
    /// The cabin's and the dock's parts ([`crate::draw::Parts`]).
    pub parts: crate::draw::Parts,
    /// The surfaces ([`crate::draw::Surfaces`]).
    pub surfaces: crate::draw::Surfaces,
}

/// The fetched CC0 layers (`assets/fetched/`, `scripts/showcase-assets.ts fetch`): each a base
/// colour with its height in alpha and a data map (normal, roughness, occlusion), named by the
/// manifest's terrain outputs. Without the asset cache every layer draws flat in its fallback.
fn layer(name: &str, tile: f32) -> TerrainLayer {
    TerrainLayer::textured(&format!("fetched/{name}-layer.png"), &format!("fetched/{name}-data.png"), tile)
}

/// The lush meadow's grass (renderer pass 2 A.8): knee-high blades from a dark foot to a fresh
/// green, a fifth of the tips dry, a few yellow flowers, the low sun shining through them.
pub fn lush_grass() -> genex::Grass {
    genex::Grass::meadow(30.0, 0.5)
        .with_height(0.14, 0.5)
        .with_width(0.022, 0.042)
        .with_colors(Color::rgb(39, 58, 25), Color::rgb(84, 112, 47))
        .with_dry(Color::rgb(149, 129, 75), 0.18)
        .with_flowers(Color::rgb(237, 206, 79), 0.025)
        .with_transmission(0.7)
}

/// The dry meadow's grass: taller and sparser, most of its tips gone gold.
pub fn dry_grass() -> genex::Grass {
    genex::Grass::meadow(22.0, 0.7)
        .with_height(0.3, 0.7)
        .with_width(0.022, 0.042)
        .with_colors(Color::rgb(48, 60, 27), Color::rgb(112, 118, 52))
        .with_dry(Color::rgb(160, 136, 76), 0.6)
        .with_flowers(Color::rgb(232, 225, 210), 0.015)
        .with_transmission(0.75)
}

/// The lakeside's ground on the built-in terrain (renderer pass 2 A.7): the layout's heights every
/// [`crate::layout::TERRAIN_SPACING`] metres and its control map, six layers (tiles in metres: the
/// fetched textures' real sizes, assets-manifest.json `worldSizeMetres`): the scanned forest floor
/// greened for the lush meadow and gilded where it dries, the soil, the sand, the rock and the
/// lake bed (the sand darkened under the water). Made once per process.
pub fn terrain() -> Terrain {
    static TERRAIN: std::sync::OnceLock<Terrain> = std::sync::OnceLock::new();
    TERRAIN
        .get_or_init(|| {
            use crate::layout::{TERRAIN_HALF, TERRAIN_SAMPLES, TERRAIN_SPACING, terrain_ground};
            let (heights, control) = terrain_ground();
            let origin = math::vec2(-TERRAIN_HALF, -TERRAIN_HALF);
            let ground = Terrain::from_heights([TERRAIN_SAMPLES; 2], origin, TERRAIN_SPACING, heights).expect("the layout's heights");
            let layers = vec![
                layer("terrain-grass", 2.0).with_tint(vec3(0.68, 1.0, 0.5)).with_fallback(Color::rgb(54, 79, 34)).with_grass(lush_grass()),
                layer("terrain-grass", 2.0).with_tint(vec3(1.3, 1.08, 0.58)).with_fallback(Color::rgb(126, 108, 66)).with_grass(dry_grass()),
                layer("terrain-soil", 2.0).with_fallback(Color::rgb(108, 84, 62)),
                layer("terrain-sand", 3.0).with_fallback(Color::rgb(170, 152, 125)),
                layer("terrain-rock", 2.4).with_fallback(Color::rgb(138, 134, 126)),
                layer("terrain-sand", 3.0).with_tint(vec3(0.42, 0.4, 0.36)).with_fallback(Color::rgb(104, 92, 76)),
            ];
            let look = genex::TerrainLook { macro_variation: 0.2, macro_scale: 9.0, wet_darkening: 0.45, wet_roughness: 0.32, blend_depth: 0.18 };
            ground.with_layers(layers).and_then(|ground| ground.with_control(control)).expect("the layout's control map").with_look(look)
        })
        .clone()
}

impl Models {
    /// Every handle, from the game's `assets/`.
    pub fn load(gfx: &Gfx) -> Models {
        let assets = gfx.assets();
        let tree = |pine: bool, variant: u32| -> Vec<TreeMeshes> {
            TreeLod::ALL
                .iter()
                .map(|lod| TreeMeshes { wood: assets.model(&tree_asset(pine, variant, *lod, false)), foliage: assets.model(&tree_asset(pine, variant, *lod, true)) })
                .collect()
        };
        let rock: Vec<Model> = (0..3).map(|i| assets.model(&format!("rock-{i}.glb"))).collect();
        let surfaces = crate::draw::Surfaces::new();
        Models {
            terrain: Some(terrain()),
            broadleaf: (0..3).map(|v| tree(false, v)).collect(),
            pine: (0..2).map(|v| tree(true, v)).collect(),
            stones: crate::draw::stone_groups(&terrain(), &rock, &surfaces),
            rock,
            cylinder: assets.model("cylinder.glb"),
            sphere: assets.model("sphere.glb"),
            parts: crate::draw::Parts::load(assets),
            surfaces,
        }
    }
}

/// Everything the simulation owns. Every seed rebuilds it from `World::default()`.
#[derive(Default)]
pub struct World {
    /// Ticks since the seed: every animation (wind, water, fireflies, animals) reads it.
    pub tick: u64,
    /// How the camera moves.
    pub mode: CameraMode,
    /// The free camera's pose (kept when switching away and back).
    pub free: FreeCam,
    /// Whether the HUD is hidden (H).
    pub hud_hidden: bool,
    /// Whether the person's graphics panel is open (O, or the HUD's settings button).
    pub settings_open: bool,
    /// What the HUD covered on the last frame, in world pixels (min x, min y, max x, max y): a tap
    /// there is a click on the HUD, never a step to the next shot.
    pub hud_area: Option<[f32; 4]>,
    /// What lights the scene besides the sun and draws behind it (B).
    pub backdrop: Backdrop,
    /// The time of day: the golden hour, the moonlit night or the clear day (N).
    pub time: crate::daylight::TimeOfDay,
    /// The model handles.
    pub models: Models,
    /// The tick whose frame starts a new shot: a key or a tap moved the camera somewhere else at
    /// once, so the draw calls `frame.camera_cut()` there (the free camera starts where the camera
    /// was, so switching to it is no cut).
    pub cut_at: Option<u64>,
}

impl World {
    /// Simulated seconds since the seed.
    pub fn seconds(&self) -> f32 {
        self.tick as f32 / TICKS_PER_SECOND
    }

    /// The camera this tick.
    pub fn camera(&self) -> Camera {
        match self.mode {
            CameraMode::Tour => tour(self.seconds()),
            CameraMode::Shot(i) => shot_at(i).camera(),
            CameraMode::Free => {
                let free = &self.free;
                Camera { fovy: 50.0, ..Camera::look_at(free.eye, free.eye + free.forward()) }
            }
        }
    }
}

/// The tour's camera at `seconds`: from shot to shot in [`SHOTS`] order, easing out of each,
/// lifted between them, and back to the first.
pub fn tour(seconds: f32) -> Camera {
    let legs = seconds / TOUR_LEG_SECONDS;
    let leg = (legs.floor() as usize) % SHOTS.len();
    let along = legs - legs.floor();
    let (from, to) = (SHOTS[leg], SHOTS[(leg + 1) % SHOTS.len()]);
    let t = crate::layout::smoothstep(0.18, 0.92, along);
    let lift = math::sin(t * math::PI) * TOUR_LIFT;
    let eye = from.eye().lerp(to.eye(), t) + vec3(0.0, lift, 0.0);
    let target = from.target().lerp(to.target(), t);
    Camera { fovy: from.fovy + (to.fovy - from.fovy) * t, ..Camera::look_at(eye, target) }
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
    let ground = crate::layout::height(free.eye.x, free.eye.z).max(crate::layout::WATER_LEVEL) + 0.4;
    free.eye.y = free.eye.y.max(ground);
}

/// Whether a touch that ended or tapped this tick is on the scene, not on the HUD.
fn tapped_scene(world: &World, ctx: &Ctx<'_>) -> bool {
    let on_hud = |at: Vec2| world.hud_area.is_some_and(|[x0, y0, x1, y1]| at.x >= x0 && at.x <= x1 && at.y >= y0 && at.y <= y1);
    let ended = |touch: &&genex::Touch| matches!(touch.phase, genex::TouchPhase::Tapped | genex::TouchPhase::Ended);
    ctx.touches.all().iter().filter(ended).any(|touch| !on_hud(touch.position))
}

/// One tick: the clock, the camera keys (1–9 a shot, Space the tour, F the free camera, H the HUD,
/// O the graphics panel; a tap on the scene steps to the next shot), the backdrop (B), the time of
/// day (N) and the free camera's flight.
pub fn update(world: &mut World, ctx: &Ctx<'_>) {
    world.tick = ctx.tick + 1;
    let before = world.mode;
    let digits = [Key::Digit1, Key::Digit2, Key::Digit3, Key::Digit4, Key::Digit5, Key::Digit6, Key::Digit7, Key::Digit8, Key::Digit9];
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
    if tapped_scene(world, ctx) && world.mode != CameraMode::Free {
        world.mode = match world.mode {
            CameraMode::Shot(i) if i + 1 < SHOTS.len() + V2_SHOTS.len() => CameraMode::Shot(i + 1),
            CameraMode::Shot(_) => CameraMode::Tour,
            _ => CameraMode::Shot(0),
        };
    }
    if world.mode != before && world.mode != CameraMode::Free {
        world.cut_at = Some(world.tick);
    }
    if world.mode == CameraMode::Free {
        fly(&mut world.free, ctx);
    }
}

/// The `scene` probe: what the layout placed (the same for every seed).
pub fn scene_probe() -> Value {
    let layout = layout();
    json!({
        "trees": layout.trees.len(),
        "rocks": layout.rocks.len(),
        "lanterns": layout.lanterns.len(),
        "fireflies": layout.fireflies.len(),
    })
}
