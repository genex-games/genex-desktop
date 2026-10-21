//! AN-21: the characters example headless (no GPU). Two runs of a seed give the same probes,
//! checksum and every character's pose digest each second; the hero is a simple animator and the
//! duelist a two-layer graph whose slash fires its `hit` event; the climber crosses the ladder
//! link both ways and plays `Climb` on every tick between `take_link` and `finish_link` and on no
//! other; every character is one logical draw under its tag; and the mannequin GLB is the same
//! bytes on every call.

use genex::{FIXED_STEP_MS, Runtime, View, json};
use characters_game::{HERO_LOOP_TICKS, WALKERS, World, assets, game, mannequin};

/// A minute and a half: the climber goes up and down the ladder more than once.
const TICKS: u64 = 5400;
/// The probes and digests are compared this often, in ticks: just under a second, so the samples
/// do not alias the 1 s walk and 2 s idle cycles.
const EVERY: u64 = 59;

fn runtime() -> Runtime<World> {
    let mut runtime = Runtime::with_assets(game(), Box::new(assets())).expect("the game installs");
    runtime.seed(1);
    assert!(runtime.start());
    runtime
}

/// One run: (tick, probes, checksum, each character's pose digest) every [`EVERY`] ticks.
fn run() -> Vec<(u64, String, String, Vec<u64>)> {
    let mut runtime = runtime();
    let mut out = Vec::new();
    for tick in 1..=TICKS {
        runtime.step(FIXED_STEP_MS);
        if tick % EVERY == 0 {
            let poses = runtime.sim().world.characters().map(|placed| placed.animator.pose_digest()).collect();
            out.push((tick, genex::Value::Object(runtime.probes()).to_string(), runtime.checksum(), poses));
        }
    }
    out
}

#[test]
fn two_runs_give_the_same_probes_checksum_and_poses_every_second() {
    let first = run();
    let second = run();
    assert_eq!(first.len(), (TICKS / EVERY) as usize);
    for (a, b) in first.iter().zip(&second) {
        assert_eq!(a, b, "tick {}: the runs differ", a.0);
    }
    let poses: std::collections::BTreeSet<u64> = first.iter().map(|(_, _, _, poses)| poses[0]).collect();
    assert!(poses.len() > first.len() / 2, "the hero animates ({} distinct poses in {} samples)", poses.len(), first.len());
    assert_eq!(first[0].3.len(), 3 + WALKERS, "the hero, the duelist, the climber and the walkers");
}

#[test]
fn the_hero_is_a_simple_animator_and_the_duelist_a_two_layer_graph() {
    let mut runtime = runtime();
    let clips = {
        runtime.step(FIXED_STEP_MS);
        runtime.sim().world.clips().expect("the mannequin loaded with its five clips")
    };
    let mut hero_clips = Vec::new();
    for _ in 0..HERO_LOOP_TICKS {
        runtime.step(FIXED_STEP_MS);
        let world = &runtime.sim().world;
        let hero = world.hero.as_ref().expect("the hero");
        hero_clips.push(hero.animator.playing_clip().expect("the hero is a simple animator playing a clip"));
    }
    for clip in [clips.idle, clips.walk, clips.run, clips.slash] {
        assert!(hero_clips.contains(&clip), "the hero's loop plays {clip:?}");
    }
    let world = &runtime.sim().world;
    let duelist = world.duelist.as_ref().expect("the duelist");
    assert_eq!(duelist.animator.playing_clip(), None, "the duelist's graph is not a simple one");
    assert_eq!(duelist.animator.graph().layers().len(), 2, "base and upper body");
    let probes = runtime.probes();
    assert!(probes["characters"]["hits"].as_u64().is_some_and(|hits| hits >= 3), "the duelist's slash fired its hit: {}", probes["characters"]);
}

#[test]
fn the_climber_plays_climb_between_take_link_and_finish_link_only() {
    let mut runtime = runtime();
    runtime.step(TICKS as f64 * FIXED_STEP_MS);
    let totals = runtime.sim().world.climb_totals();
    println!("climb: {totals:?}; probes {}", genex::Value::Object(runtime.probes()));
    assert!(totals.taken >= 2, "the climber crossed the ladder up and down: {totals:?}");
    assert!(totals.finished + 1 >= totals.taken, "every crossing but the last finished: {totals:?}");
    assert!(totals.crossing_ticks > 0, "{totals:?}");
    assert_eq!(totals.climbing_ticks, totals.crossing_ticks, "Climb plays on every crossing tick: {totals:?}");
    assert_eq!(totals.climbing_outside, 0, "and on no tick outside a crossing: {totals:?}");
    assert_eq!(runtime.probes()["climb"]["taken"], json!(totals.taken));
}

#[test]
fn every_character_is_one_logical_draw_under_its_tag() {
    let mut runtime = runtime();
    runtime.step(120.0 * FIXED_STEP_MS);
    let frame = runtime.frame(View::Game).expect("the game view");
    let tags = frame.tags();
    for tag in ["hero", "duelist", "climber"] {
        assert_eq!(tags[tag], 1, "{tag}: {tags:?}");
    }
    assert_eq!(tags["walkers"] as usize, WALKERS, "{tags:?}");
}

#[test]
fn the_mannequin_is_the_same_bytes_every_time_and_imports() {
    let (a, b) = (mannequin::glb(), mannequin::glb());
    assert_eq!(a, b);
    assert!(a.len() < 64 * 1024, "the mannequin stays small ({} bytes)", a.len());
    let digest = a.iter().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(*byte)).wrapping_mul(0x0000_0100_0000_01b3));
    println!("mannequin.glb: {} bytes, fnv1a64 {digest:016x}", a.len());
}
