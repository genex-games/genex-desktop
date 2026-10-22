//! audio-yard (G6 AU-10): a walker tours a yard on a 20 s loop and the yard plays every part of
//! `genex::audio` as it passes.
//!
//! - **Footsteps** four times a second, at most [`FOOTSTEP_INSTANCES`] at once: a step whose
//!   gravel is still settling is stolen by the next but one.
//! - **A rapid-fire gun** in two bursts a loop, a shot every 3 ticks, at most [`GUN_INSTANCES`]
//!   at once: each new shot steals the oldest.
//! - **Radio dialogue** on the voice bus, which ducks the music by [`DUCK_DB`].
//! - **A music crossfade** between the yard and cave tracks at the cave mouth.
//! - **A cave reverb zone**, with drips and a beacon inside it.
//! - **An occluding wall** (a Rapier collider) between part of the walk and a humming generator.
//! - **A drone fly-by** with Doppler, moved every tick.
//! - **UI clicks**: the Talk and Fire buttons, and a HUD chime every four seconds.
//!
//! Thirty crickets ring the yard, so with the bursts and the dialogue more voices play than the
//! web's or a phone's physical pool renders: the rest go virtual and keep time, and the logical state stays
//! the same on every pool class. The ears are the walker's head, never the camera.
//!
//! The same [`game`] runs natively (`src/main.rs`) and on the web (this library as a wasm-bindgen
//! `cdylib`). [`game_quiet`] is the same game with every audio call left out (the checksum row).

mod yard;

#[cfg(test)]
mod parity;

pub use yard::{
    CAVE_MAX, CAVE_MIN, CRICKETS, DRONE_START_TICK, DRONE_TICKS, DUCK_DB, FOOTSTEP_INSTANCES, GENERATOR, GUN_BURST_TICKS,
    GUN_INSTANCES, GUN_STARTS, TALK_TICKS, TOUR_TICKS, TURRET, WALL_CENTER, WALL_HALF, World, walker_at,
};

use genex::prelude::*;

/// The game's name in the shell.
pub const NAME: &str = "audio-yard";
/// The world target size.
pub const WORLD_SIZE: [u32; 2] = [1280, 720];

/// The sounds and music, compiled in. The short sounds are `build.rs`'s synthesized WAVs; the
/// music and the beacon are the repo's own FFmpeg-generated Ogg Vorbis tones.
pub const ASSETS: genex::AssetTable = &[
    ("sfx/footstep.wav", include_bytes!(concat!(env!("OUT_DIR"), "/footstep.wav"))),
    ("sfx/gunshot.wav", include_bytes!(concat!(env!("OUT_DIR"), "/gunshot.wav"))),
    ("sfx/dialogue.wav", include_bytes!(concat!(env!("OUT_DIR"), "/dialogue.wav"))),
    ("sfx/click.wav", include_bytes!(concat!(env!("OUT_DIR"), "/click.wav"))),
    ("sfx/drone.wav", include_bytes!(concat!(env!("OUT_DIR"), "/drone.wav"))),
    ("sfx/hum.wav", include_bytes!(concat!(env!("OUT_DIR"), "/hum.wav"))),
    ("sfx/cricket.wav", include_bytes!(concat!(env!("OUT_DIR"), "/cricket.wav"))),
    ("sfx/drip.wav", include_bytes!(concat!(env!("OUT_DIR"), "/drip.wav"))),
    ("sfx/beacon.ogg", include_bytes!("../assets/sfx/beacon.ogg")),
    ("music/yard.ogg", include_bytes!("../assets/music/yard.ogg")),
    ("music/cave.ogg", include_bytes!("../assets/music/cave.ogg")),
];

/// audio-yard, with every hook registered.
pub fn game() -> Game<World> {
    build(true)
}

/// audio-yard with every `ctx.audio` call left out: the same simulation, so the same checksums.
pub fn game_quiet() -> Game<World> {
    build(false)
}

fn build(audible: bool) -> Game<World> {
    let mut game = Game::new(World::default()).title("Audio yard").world_size(WORLD_SIZE[0], WORLD_SIZE[1]).background(Color::rgb(20, 24, 30));
    yard::wire(&mut game, audible);
    game
}

/// The web entry: hand the game to the web shell when the module is instantiated (never in this
/// crate's own unit tests, which run as a plain wasm32 libtest binary).
#[cfg(all(target_arch = "wasm32", not(test)))]
#[wasm_bindgen::prelude::wasm_bindgen(start)]
pub fn start() {
    genex_platform_web::install_named(NAME, game(), ASSETS);
}
