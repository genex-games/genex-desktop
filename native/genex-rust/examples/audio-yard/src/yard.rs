//! The yard: the walker's loop, the emitters, the scripted events and the drawing. Everything is a
//! function of the tick, the seed's rng and the input, so the simulation (and its checksum) is
//! the same with audio on or off; only the `ctx.audio` calls depend on `audible`.

use genex::physics::ColliderBuilder;
use genex::prelude::*;

/// Ticks one loop of the walk takes (20 s).
pub const TOUR_TICKS: u64 = 1200;
/// The walk's corners, clockwise from the north-west, on the ground.
const CORNERS: [Vec3; 4] = [Vec3::new(-12.0, 0.0, 8.0), Vec3::new(12.0, 0.0, 8.0), Vec3::new(12.0, 0.0, -8.0), Vec3::new(-12.0, 0.0, -8.0)];
/// The walk's length, metres.
const TOUR_METRES: f32 = 80.0;
/// The HUD's distance from the screen's edges, in points.
const HUD_INSET: f32 = 16.0;
/// The ears' height above the walker's feet.
const EAR_HEIGHT: f32 = 1.7;

/// Ticks between footsteps.
const STEP_TICKS: u64 = 15;
/// Footsteps playing at once, at most.
pub const FOOTSTEP_INSTANCES: u8 = 2;

/// Where the gun stands.
pub const TURRET: Vec3 = Vec3::new(10.0, 1.2, 15.0);
/// The loop ticks a burst starts on.
pub const GUN_STARTS: [u64; 2] = [200, 800];
/// A burst's length in ticks.
pub const GUN_BURST_TICKS: u64 = 90;
/// Ticks between shots.
const SHOT_TICKS: u64 = 3;
/// Shots playing at once, at most: a newer one steals the oldest.
pub const GUN_INSTANCES: u8 = 5;

/// The loop ticks the radio speaks on.
pub const TALK_TICKS: [u64; 2] = [60, 660];
/// How far dialogue ducks the music, dB.
pub const DUCK_DB: f32 = -12.0;

/// The cave's low corner (its reverb zone).
pub const CAVE_MIN: Vec3 = Vec3::new(4.0, -1.0, -14.0);
/// The cave's high corner.
pub const CAVE_MAX: Vec3 = Vec3::new(20.0, 6.0, -2.0);
/// The beacon at the back of the cave.
const BEACON: Vec3 = Vec3::new(12.0, 1.5, -11.0);
/// Drips in the cave: where, and every how many ticks.
const DRIPS: [(Vec3, u64); 4] = [
    (Vec3::new(6.0, 3.0, -12.0), 47),
    (Vec3::new(9.0, 3.0, -4.0), 53),
    (Vec3::new(16.0, 3.0, -12.0), 61),
    (Vec3::new(18.0, 3.0, -6.0), 71),
];
/// The music crossfade at the cave mouth, seconds.
const CROSSFADE_S: f32 = 2.0;

/// The generator behind the wall.
pub const GENERATOR: Vec3 = Vec3::new(-18.0, 0.8, -12.0);
/// The occluding wall's centre.
pub const WALL_CENTER: Vec3 = Vec3::new(-15.0, 2.0, -11.0);
/// The occluding wall's half extents.
pub const WALL_HALF: Vec3 = Vec3::new(0.4, 2.0, 5.0);

/// The loop tick the drone's first pass starts on; it passes every half loop.
pub const DRONE_START_TICK: u64 = 300;
/// Ticks one pass takes (96 m at 36 m/s).
pub const DRONE_TICKS: u64 = 160;
const DRONE_FROM: Vec3 = Vec3::new(-48.0, 8.0, 2.0);
const DRONE_TO: Vec3 = Vec3::new(48.0, 8.0, 2.0);

/// Crickets ringing the yard.
pub const CRICKETS: usize = 30;
const CRICKET_RING_M: f32 = 26.0;

/// Ticks between HUD chimes, and the chime's offset in that period.
const CHIME_TICKS: u64 = 240;
const CHIME_OFFSET: u64 = 120;

const GROUND: Color = Color::rgb(70, 82, 60);
const ROCK: Color = Color::rgb(58, 54, 60);
const WALL: Color = Color::rgb(150, 140, 120);
const WALKER: Color = Color::rgb(230, 200, 80);
const MACHINE: Color = Color::rgb(90, 110, 140);
const CRICKET: Color = Color::rgb(90, 170, 70);
const WATER: Color = Color::rgb(80, 150, 230);
const BEACON_LIGHT: Color = Color::rgb(250, 120, 60);
/// Towards the sun (above the horizon, from the south-west).
const SUN_TOWARDS: Vec3 = Vec3::new(-0.45, 0.7, 0.55);

/// The handles `on_reset` loads.
#[derive(Clone, Debug, PartialEq)]
struct Sounds {
    footstep: Sound,
    gunshot: Sound,
    dialogue: Sound,
    click: Sound,
    drone: Sound,
    hum: Sound,
    cricket: Sound,
    drip: Sound,
    beacon: Sound,
    yard: Music,
    cave: Music,
}

/// The yard's state: the walker, what played and what is asked for. No audio state lives here
/// (the Director holds it), so a save or a checksum never sees audio.
#[derive(Debug, Default)]
pub struct World {
    /// The handles, or None for the quiet game (every audio call is skipped).
    sounds: Option<Sounds>,
    tick: u64,
    walker: Vec3,
    facing: Vec3,
    in_cave: bool,
    crossfades: u32,
    steps: u32,
    shots: u32,
    talks: u32,
    chimes: u32,
    clicks: u32,
    drone: Voice,
    drone_at: Option<Vec3>,
    /// The tick a Fire press started its burst on.
    manual_burst: Option<u64>,
    /// Talk was pressed: the radio speaks on the next tick.
    talk_asked: bool,
}

impl World {
    /// Whether the walker is inside the cave.
    pub fn in_cave(&self) -> bool {
        self.in_cave
    }

    /// The walker's feet.
    pub fn walker(&self) -> Vec3 {
        self.walker
    }

    /// Music crossfades so far.
    pub fn crossfades(&self) -> u32 {
        self.crossfades
    }
}

/// The walker's feet and facing at loop tick `phase`.
pub fn walker_at(phase: u64) -> (Vec3, Vec3) {
    let mut metres = (phase % TOUR_TICKS) as f32 * TOUR_METRES / TOUR_TICKS as f32;
    for index in 0..CORNERS.len() {
        let (from, to) = (CORNERS[index], CORNERS[(index + 1) % CORNERS.len()]);
        let length = from.distance(to);
        if metres <= length {
            let facing = (to - from) / length;
            return (from + facing * metres, facing);
        }
        metres -= length;
    }
    (CORNERS[0], Vec3::X)
}

fn inside(point: Vec3, min: Vec3, max: Vec3) -> bool {
    point.cmpge(min).all() && point.cmple(max).all()
}

fn cricket_at(index: usize) -> Vec3 {
    let angle = std::f32::consts::TAU * index as f32 / CRICKETS as f32;
    let (sin, cos) = genex::math::sin_cos(angle);
    Vec3::new(CRICKET_RING_M * cos, 0.3, CRICKET_RING_M * sin)
}

fn drone_at(since: u64) -> Vec3 {
    DRONE_FROM.lerp(DRONE_TO, since as f32 / DRONE_TICKS as f32)
}

/// The game's audio setup: dialogue ducks music, the cave reverbs, colliders occlude.
fn setup() -> AudioSetup {
    AudioSetup {
        ducks: vec![Duck { trigger: Bus::Voice, target: Bus::Music, depth_db: DUCK_DB, attack_s: 0.1, release_s: 0.8 }],
        zones: vec![ReverbZone {
            name: "cave",
            shape: ZoneShape::Box { min: CAVE_MIN, max: CAVE_MAX },
            preset: ReverbPreset::CAVE,
            send_db: -4.0,
            uniformity: 1.0,
        }],
        occlusion: true,
        ..AudioSetup::default()
    }
}

/// Register every hook.
pub(crate) fn wire(game: &mut Game<World>, audible: bool) {
    if audible {
        game.audio(setup());
    }
    game.on_reset(move |sim, _, _, gfx| reset(sim, gfx, audible));
    game.on_update(update);
    game.on_ui(ui);
    game.on_draw(draw);
    game.camera(|sim| {
        let walker = sim.world.walker;
        Camera::look_at(walker + Vec3::new(0.0, 22.0, 18.0), walker)
    });
    game.probe("yard", |sim| {
        let world = &sim.world;
        json!({
            "walker": [world.walker.x, world.walker.y, world.walker.z],
            "inCave": world.in_cave,
            "crossfades": world.crossfades,
            "steps": world.steps,
            "shots": world.shots,
            "talks": world.talks,
            "chimes": world.chimes,
            "clicks": world.clicks,
        })
    });
}

fn reset(sim: &mut Sim<World>, gfx: &Gfx, audible: bool) {
    let sounds = Sounds {
        footstep: gfx.sound("sfx/footstep.wav"),
        gunshot: gfx.sound("sfx/gunshot.wav"),
        dialogue: gfx.sound("sfx/dialogue.wav"),
        click: gfx.sound("sfx/click.wav"),
        drone: gfx.sound("sfx/drone.wav"),
        hum: gfx.sound("sfx/hum.wav"),
        cricket: gfx.sound("sfx/cricket.wav"),
        drip: gfx.sound("sfx/drip.wav"),
        beacon: gfx.sound("sfx/beacon.ogg"),
        yard: gfx.music("music/yard.ogg"),
        cave: gfx.music("music/cave.ogg"),
    };
    sim.world = World { sounds: audible.then_some(sounds), ..World::default() };
    (sim.world.walker, sim.world.facing) = walker_at(0);
    sim.physics.insert_collider(ColliderBuilder::cuboid(WALL_HALF.x, WALL_HALF.y, WALL_HALF.z).translation(WALL_CENTER), None);
}

/// The loops that play from the first tick: crickets, the generator, the beacon and the music.
fn start_loops(sounds: &Sounds, ctx: &Ctx<'_>) {
    for index in 0..CRICKETS {
        // `max_instances(0)`: every cricket keeps its voice (the default cap of 4 would steal).
        let ring = PlayOpts::default().on(Bus::Ambience).volume_db(-4.0).looped().at(cricket_at(index)).max_instances(0);
        let opts = PlayOpts { start_s: (index % 6) as f32 * 0.1, ..ring };
        ctx.audio.play_with(&sounds.cricket, opts);
    }
    let near = Spatial { ref_distance: 2.0, max_distance: 40.0, ..Spatial::default() };
    ctx.audio.play_with(&sounds.hum, PlayOpts::default().looped().at(GENERATOR).spatial(near));
    let beacon = Spatial { ref_distance: 1.5, max_distance: 25.0, ..Spatial::default() };
    ctx.audio.play_with(&sounds.beacon, PlayOpts::default().volume_db(-6.0).looped().at(BEACON).spatial(beacon));
    ctx.audio.music(&sounds.yard, MusicOpts { fade_s: 0.5, ..MusicOpts::default() });
}

fn update(sim: &mut Sim<World>, ctx: &Ctx<'_>) {
    let world = &mut sim.world;
    let tick = ctx.tick;
    let phase = tick % TOUR_TICKS;
    world.tick = tick;
    (world.walker, world.facing) = walker_at(phase);
    if ctx.keys.pressed(Key::KeyT) {
        world.talk_asked = true;
    }
    if ctx.keys.pressed(Key::KeyF) {
        world.manual_burst = Some(tick);
    }
    // The footstep's pitch comes from the tick rng whether or not audio plays, so the quiet game
    // draws the same numbers.
    let step_pitch = 0.92 + ctx.rng.below(17) as f32 * 0.01;
    let sounds = world.sounds.clone();
    let audio = |play: &dyn Fn(&Sounds)| {
        if let Some(sounds) = &sounds {
            play(sounds);
        }
    };
    if tick == 0 {
        audio(&|s| start_loops(s, ctx));
    }
    let ears = Listener { position: world.walker + Vec3::Y * EAR_HEIGHT, forward: world.facing, up: Vec3::Y };
    audio(&|_| ctx.audio.listener(Some(ears)));
    walk(world, ctx, phase, step_pitch, &audio);
    gun(world, ctx, phase, &audio);
    radio(world, ctx, phase, &audio);
    cave(world, ctx, phase, &audio);
    drone(world, ctx, phase, &audio);
    if phase % CHIME_TICKS == CHIME_OFFSET {
        world.chimes += 1;
        audio(&|s| {
            ctx.audio.play_with(&s.click, PlayOpts::ui());
        });
    }
}

type Audio<'a> = dyn Fn(&dyn Fn(&Sounds)) + 'a;

fn walk(world: &mut World, ctx: &Ctx<'_>, phase: u64, pitch: f32, audio: &Audio<'_>) {
    if !phase.is_multiple_of(STEP_TICKS) {
        return;
    }
    world.steps += 1;
    let feet = world.walker;
    audio(&|s| {
        ctx.audio.play_with(&s.footstep, PlayOpts::default().at(feet).pitch(pitch).max_instances(FOOTSTEP_INSTANCES));
    });
}

fn gun(world: &mut World, ctx: &Ctx<'_>, phase: u64, audio: &Audio<'_>) {
    let scripted = GUN_STARTS.iter().any(|start| (*start..*start + GUN_BURST_TICKS).contains(&phase) && (phase - start).is_multiple_of(SHOT_TICKS));
    let manual = world.manual_burst.is_some_and(|from| {
        let since = world.tick - from;
        since < GUN_BURST_TICKS && since.is_multiple_of(SHOT_TICKS)
    });
    if !(scripted || manual) {
        return;
    }
    world.shots += 1;
    let far = Spatial { ref_distance: 3.0, max_distance: 60.0, ..Spatial::default() };
    audio(&|s| {
        ctx.audio.play_with(&s.gunshot, PlayOpts::default().at(TURRET).spatial(far).priority(140).max_instances(GUN_INSTANCES));
    });
}

fn radio(world: &mut World, ctx: &Ctx<'_>, phase: u64, audio: &Audio<'_>) {
    if !(TALK_TICKS.contains(&phase) || world.talk_asked) {
        return;
    }
    world.talk_asked = false;
    world.talks += 1;
    audio(&|s| {
        ctx.audio.play_with(&s.dialogue, PlayOpts::default().on(Bus::Voice).priority(200));
    });
}

fn cave(world: &mut World, ctx: &Ctx<'_>, phase: u64, audio: &Audio<'_>) {
    let in_cave = inside(world.walker + Vec3::Y * EAR_HEIGHT, CAVE_MIN, CAVE_MAX);
    if in_cave != world.in_cave {
        world.in_cave = in_cave;
        world.crossfades += 1;
        audio(&|s| {
            let track = if in_cave { &s.cave } else { &s.yard };
            ctx.audio.music(track, MusicOpts { fade_s: CROSSFADE_S, ..MusicOpts::default() });
        });
    }
    for (at, period) in DRIPS {
        if phase.is_multiple_of(period) {
            audio(&|s| {
                ctx.audio.play_with(&s.drip, PlayOpts::default().volume_db(-3.0).at(at).max_instances(2));
            });
        }
    }
}

fn drone(world: &mut World, ctx: &Ctx<'_>, phase: u64, audio: &Audio<'_>) {
    let half = TOUR_TICKS / 2;
    let since = (phase + half - DRONE_START_TICK) % half;
    if since >= DRONE_TICKS {
        if world.drone_at.take().is_some() {
            let voice = world.drone;
            audio(&|_| ctx.audio.stop(voice, 0.2));
        }
        return;
    }
    let at = drone_at(since);
    world.drone_at = Some(at);
    if since == 0 {
        let flyby = Spatial { ref_distance: 4.0, max_distance: 80.0, doppler: 1.0, ..Spatial::default() };
        let voice = std::cell::Cell::new(Voice::NONE);
        audio(&|s| voice.set(ctx.audio.play_with(&s.drone, PlayOpts::default().looped().at(at).spatial(flyby).priority(160))));
        world.drone = voice.get();
        return;
    }
    let voice = world.drone;
    audio(&|_| ctx.audio.set_position(voice, at));
}

fn ui(sim: &mut Sim<World>, ui: &mut egui::Ui, ctx: &Ctx<'_>) {
    let world = &mut sim.world;
    let mut talk = false;
    let mut fire = false;
    egui::Frame::new().fill(egui::Color32::from_black_alpha(160)).inner_margin(8.0).outer_margin(HUD_INSET).show(ui, |ui| {
        ui.horizontal(|ui| {
            talk = ui.button("Talk (T)").clicked();
            fire = ui.button("Fire (F)").clicked();
            let place = if world.in_cave { "In the cave" } else { "In the yard" };
            ui.label(egui::RichText::new(place).color(egui::Color32::WHITE));
        });
    });
    if !(talk || fire) {
        return;
    }
    world.clicks += 1;
    world.talk_asked |= talk;
    if fire {
        world.manual_burst = Some(world.tick);
    }
    if let Some(sounds) = &world.sounds {
        ctx.audio.play_with(&sounds.click, PlayOpts::ui());
    }
}

fn draw(sim: &Sim<World>, frame: &mut Frame, _camera: &Camera) {
    let world = &sim.world;
    let block = |center: Vec3, half: Vec3| Transform::from_translation(center).with_scale(half * 2.0);
    frame.clear(Color::rgb(20, 24, 30)).ambient(Color::rgb(170, 190, 220), 0.3).sun(SUN_TOWARDS, Color::WHITE, 3.0);
    frame.environment(genex::render::Environment::sky());
    frame.tag("ground").cube_with(block(Vec3::new(0.0, -0.1, 0.0), Vec3::new(60.0, 0.1, 60.0)), &Material::color(GROUND).with_roughness(0.95));
    frame.tag("wall").cube_with(block(WALL_CENTER, WALL_HALF), &Material::color(WALL).with_roughness(0.9));
    frame.tag("cave");
    let rock = Material::color(ROCK).with_roughness(1.0);
    for (center, half) in cave_walls() {
        frame.cube_with(block(center, half), &rock);
    }
    frame.tag("machines");
    let machine = Material::color(MACHINE).with_roughness(0.5);
    frame.cube_with(block(GENERATOR, Vec3::new(1.0, 0.8, 0.8)), &machine);
    frame.cube_with(block(TURRET, Vec3::new(0.6, 1.2, 0.6)), &machine);
    frame.tag("beacon").cube_with(block(BEACON, Vec3::splat(0.3)), &Material::color(BEACON_LIGHT).with_emissive(BEACON_LIGHT, 2.0));
    frame.tag("crickets");
    for index in 0..CRICKETS {
        frame.cube_with(block(cricket_at(index), Vec3::splat(0.25)), &Material::color(CRICKET));
    }
    frame.tag("drips");
    for (at, _) in DRIPS {
        frame.cube_with(block(at, Vec3::splat(0.15)), &Material::color(WATER));
    }
    if let Some(at) = world.drone_at {
        frame.tag("drone").cube_with(block(at, Vec3::new(1.2, 0.25, 1.2)), &machine);
    }
    let walker = Transform::from_translation(world.walker + Vec3::Y * 0.9).with_scale(Vec3::new(0.6, 1.8, 0.6));
    frame.tag("walker").cube_with(walker, &Material::color(WALKER).with_roughness(0.5));
}

/// The cave's rock walls (no roof, so the camera sees in), with a mouth where the walk enters
/// from the south and another where it leaves to the west.
fn cave_walls() -> [(Vec3, Vec3); 6] {
    let height = 2.5;
    [
        (Vec3::new(20.0, height, -8.0), Vec3::new(0.4, height, 6.0)),
        (Vec3::new(12.0, height, -14.0), Vec3::new(8.0, height, 0.4)),
        (Vec3::new(7.0, height, -2.0), Vec3::new(3.0, height, 0.4)),
        (Vec3::new(17.0, height, -2.0), Vec3::new(3.0, height, 0.4)),
        (Vec3::new(4.0, height, -12.0), Vec3::new(0.4, height, 2.0)),
        (Vec3::new(4.0, height, -4.0), Vec3::new(0.4, height, 2.0)),
    ]
}
