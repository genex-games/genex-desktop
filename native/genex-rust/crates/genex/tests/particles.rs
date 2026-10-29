//! Facade particles (renderer pass 2 A.11): an emitter is its description. Making the same emitter
//! again (a reset rebuilding the world, a draw hook making it every frame) answers the same
//! emitter, so the renderer holds one, not one per reset up to its 16; a changed one is another.
//! A frame draws an emitter once, in call order.

use genex::math::vec3;
use genex::{Color, Frame, PARTICLES_MAX, Particles, ParticlesErrorCode};

#[test]
fn the_same_emitter_made_again_is_the_same_emitter() {
    let steam = Particles::steam(vec3(1.0, 0.0, 2.0));
    let again = Particles::steam(vec3(1.0, 0.0, 2.0));
    assert_eq!(steam.version(), again.version(), "a reset's steam is the steam the renderer holds");
    assert_eq!(steam, again);
    // A change that lands where the emitter already was is the same emitter too.
    assert_eq!(steam.with_soft(0.6).version(), steam.version(), "steam is already soft over 0.6 m");
    let rain = Particles::rain(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0)).with_rate(120, 70).expect("rain");
    let rain_again = Particles::rain(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0)).with_rate(120, 70).expect("rain");
    assert_eq!(rain.version(), rain_again.version());
}

#[test]
fn a_changed_emitter_is_another_and_the_old_one_draws_as_it_did() {
    let steam = Particles::steam(vec3(1.0, 0.0, 2.0));
    let moved = steam.with_origin(vec3(4.0, 0.0, 2.0), vec3(0.15, 0.0, 0.15));
    let hard = steam.with_soft(0.0);
    let grey = steam.with_look(0.35, 3.0, Color::rgba(120, 124, 132, 90), Color::rgba(110, 114, 122, 0));
    let book = steam.with_flipbook("fx/smoke.png", 4, 4, 16, 1.0, true).expect("flipbook");
    let versions = [steam.version(), moved.version(), hard.version(), grey.version(), book.version()];
    for (i, a) in versions.iter().enumerate() {
        assert!(versions[i + 1..].iter().all(|b| b != a), "every change is its own emitter: {versions:?}");
    }
    assert_eq!(steam.desc().origin, [1.0, 0.0, 2.0], "the old handle keeps its origin");
    assert_eq!(book.flipbook().map(|book| book.grid()), Some((4, 4)));
    assert!(steam.flipbook().is_none());
}

#[test]
fn refusals_name_their_code_and_change_nothing() {
    let rain = Particles::rain(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0));
    let none = rain.with_rate(0, 60).expect_err("none alive");
    assert_eq!(none.code, ParticlesErrorCode::CountInvalid);
    let many = rain.with_rate(1000, 1000).expect_err("too many alive");
    assert_eq!(many.code, ParticlesErrorCode::CountInvalid);
    let grid = rain.with_flipbook("fx/rain.png", 17, 1, 4, 1.0, false).expect_err("17 columns");
    assert_eq!(grid.code, ParticlesErrorCode::FlipbookInvalid);
    assert_eq!(rain.alive(), 160 * 60, "the rain is as it was");
}

#[test]
fn a_frame_draws_each_emitter_once_in_call_order() {
    let steam = Particles::steam(vec3(1.0, 0.0, 2.0));
    let rain = Particles::rain(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0));
    let mut frame = Frame::default();
    frame.particles(&rain).particles(&steam).particles(&Particles::rain(vec3(0.0, 9.0, 0.0), vec3(6.0, 0.0, 6.0)));
    let drawn: Vec<u64> = frame.drawn_particles().iter().map(Particles::version).collect();
    assert_eq!(drawn, vec![rain.version(), steam.version()], "the rain made again is the rain drawn already");
}

/// Ticks a second: velocities are world units a tick.
const TICKS_PER_SECOND: f32 = 60.0;

#[test]
fn snow_and_dust_are_soft_round_dots_well_within_an_emitter_s_cap() {
    let snow = Particles::snow(vec3(0.0, 10.0, 0.0), vec3(12.0, 0.0, 12.0));
    let dust = Particles::dust(vec3(0.0, 1.5, 0.0), vec3(3.0, 1.5, 3.0));
    for (name, preset) in [("snow", &snow), ("dust", &dust)] {
        let desc = preset.desc();
        assert!(desc.check().is_ok(), "{name} passes the renderer's limits");
        assert!(preset.alive() <= PARTICLES_MAX, "{name}: {} alive", preset.alive());
        assert!(desc.stretch == 0.0 && preset.flipbook().is_none(), "{name} draws the round dot, not a streak or a sprite");
        assert!(desc.soft_distance > 0.0 && desc.near_fade > 0.0, "{name} is soft and fades in front of the lens");
        assert!(!desc.sorted, "{name} draws in spawn order");
    }
    assert!((8_000..=12_000).contains(&snow.alive()), "snow holds {} flakes", snow.alive());
    assert!((200..=2_000).contains(&dust.alive()), "dust holds {} motes", dust.alive());

    let fall = -snow.desc().velocity[1] * TICKS_PER_SECOND;
    assert!((0.9..=1.1).contains(&fall), "snow falls about 1 m/s ({fall})");
    assert_eq!(snow.desc().origin, [0.0, 10.0, 0.0], "flakes fall from the box's top");
    assert!(snow.desc().collides(), "flakes settle where they land");

    let desc = dust.desc();
    let [vx, vy, vz] = desc.velocity;
    let drift = ((vx * vx + vy * vy + vz * vz).sqrt() + desc.spread * 3f32.sqrt()) * TICKS_PER_SECOND;
    assert!(drift < 0.05, "a mote drifts under 5 cm/s ({drift})");
    assert_eq!(desc.gravity, [0.0; 3]);
    assert_eq!(desc.extent, [3.0, 1.5, 3.0], "motes are born throughout the box");
    assert_ne!(snow.version(), dust.version());
}
