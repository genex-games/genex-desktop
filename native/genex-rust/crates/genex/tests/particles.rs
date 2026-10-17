//! Facade particles (renderer pass 2 A.11): an emitter is its description. Making the same emitter
//! again (a reset rebuilding the world, a draw hook making it every frame) answers the same
//! emitter, so the renderer holds one, not one per reset up to its 16; a changed one is another.
//! A frame draws an emitter once, in call order.

use genex::math::vec3;
use genex::{Color, Frame, Particles, ParticlesErrorCode};

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
