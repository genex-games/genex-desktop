//! audio-yard's scene, read back through `state().volatile.audio` over one loop of the walk: each
//! part of `genex::audio` the yard shows does what the reference says. Every row is new behaviour
//! (section 0 of the game systems plan): the example did not exist.

use audio_yard_game::{
    ASSETS, CRICKETS, DRONE_START_TICK, DUCK_DB, FOOTSTEP_INSTANCES, GUN_BURST_TICKS, GUN_INSTANCES, GUN_STARTS, TALK_TICKS, TOUR_TICKS,
    World, game, game_quiet,
};
use genex::audio::PoolClass;
use genex::{FIXED_STEP_MS, Input, Key, Runtime, Value, json};

const SEED: u32 = 1;
/// Loop ticks with the walker inside the cave (its head enters at 510 and leaves at 720).
const IN_CAVE: [u64; 2] = [540, 700];
const IN_YARD: [u64; 2] = [100, 900];
/// Loop ticks where the wall stands between the walker's ears and the generator, and where it
/// does not.
const BEHIND_WALL: u64 = 960;
const IN_THE_OPEN: u64 = 20;
/// The radio is quiet again by here (the dialogue ends at 204, the duck releases over 0.8 s).
const AFTER_TALK: u64 = 330;
/// A HUD chime's loop tick.
const CHIME: u64 = 120;
/// Frames of logical clock per tick at pitch 1 (48 kHz / 60), as seconds.
const TICK_S: f64 = 1.0 / 60.0;

fn runtime(game: genex::Game<World>) -> Runtime<World> {
    let mut rt = Runtime::with_assets(game, Box::new(ASSETS)).expect("installs");
    rt.seed(SEED);
    rt
}

/// `volatile.audio` after every tick of one loop, from seed 1 on `class`.
fn one_loop(class: PoolClass) -> Vec<Value> {
    let mut rt = Runtime::with_assets(game(), Box::new(ASSETS)).expect("installs");
    rt.set_audio_pool(class);
    rt.seed(SEED);
    (0..TOUR_TICKS)
        .map(|_| {
            rt.step(FIXED_STEP_MS);
            rt.state()["volatile"]["audio"].clone()
        })
        .collect()
}

fn voices_of<'a>(audio: &'a Value, sound: &str) -> Vec<&'a Value> {
    audio["voices"].as_array().into_iter().flatten().filter(|voice| voice["sound"] == json!(sound)).collect()
}

fn events_of<'a>(audio: &'a Value, code: &str, sound: &str) -> Vec<&'a Value> {
    audio["events"].as_array().into_iter().flatten().filter(|event| event["code"] == json!(code) && event["sound"] == json!(sound)).collect()
}

fn number(value: &Value) -> f64 {
    value.as_f64().unwrap_or_else(|| panic!("a number: {value}"))
}

#[test]
fn every_sound_and_track_loads_and_nothing_is_refused_over_a_loop() {
    let ticks = one_loop(PoolClass::Desktop);
    let last = ticks.last().expect("a loop");
    assert_eq!(last["issues"], json!([]), "{last}");
    assert_eq!(last["counts"]["refused"], json!(0), "{}", last["counts"]);
    let crickets = voices_of(last, "sfx/cricket.wav").len();
    assert_eq!(crickets, CRICKETS, "every cricket keeps its voice (max_instances 0)");
}

#[test]
fn footsteps_never_pass_their_instance_cap_and_the_oldest_is_stolen() {
    let ticks = one_loop(PoolClass::Desktop);
    let most = ticks.iter().map(|audio| voices_of(audio, "sfx/footstep.wav").len()).max().unwrap_or(0);
    assert_eq!(most, usize::from(FOOTSTEP_INSTANCES), "two steps overlap, never three");
    let stolen: usize = ticks.iter().map(|audio| events_of(audio, "stolen", "sfx/footstep.wav").len()).sum();
    assert!(stolen > 0, "a step whose gravel is still settling is stolen");
}

#[test]
fn the_gun_burst_steals_its_oldest_shot_and_never_passes_five() {
    let ticks = one_loop(PoolClass::Desktop);
    let start = GUN_STARTS[0];
    let burst = &ticks[start as usize..(start + GUN_BURST_TICKS) as usize];
    let most = burst.iter().map(|audio| voices_of(audio, "sfx/gunshot.wav").len()).max().unwrap_or(0);
    assert_eq!(most, usize::from(GUN_INSTANCES));
    let steals: Vec<&Value> = burst.iter().flat_map(|audio| events_of(audio, "stolen", "sfx/gunshot.wav")).collect();
    assert!(steals.len() > 10, "most shots of the burst steal: {}", steals.len());
    assert!(steals.iter().all(|event| event["by"].as_u64().is_some_and(|by| by > event["voice"].as_u64().unwrap_or(u64::MAX))), "a newer shot takes the oldest's voice");
}

#[test]
fn dialogue_ducks_the_music_and_the_music_comes_back() {
    let ticks = one_loop(PoolClass::Desktop);
    let music_db = |tick: u64| number(&ticks[tick as usize]["buses"]["music"]["simDb"]);
    let talk = TALK_TICKS[0];
    assert_eq!(music_db(talk - 5), 0.0, "before the radio speaks");
    assert!(music_db(talk + 40) <= f64::from(DUCK_DB) + 0.5, "ducked while it speaks: {}", music_db(talk + 40));
    assert!(music_db(AFTER_TALK) > -0.5, "released after: {}", music_db(AFTER_TALK));
}

#[test]
fn the_music_crossfades_to_the_cave_track_inside_the_cave_and_back() {
    let ticks = one_loop(PoolClass::Desktop);
    for tick in IN_YARD {
        assert_eq!(ticks[tick as usize]["music"]["path"], json!("music/yard.ogg"), "tick {tick}");
    }
    let mouth = &ticks[IN_CAVE[0] as usize]["music"];
    assert_eq!(mouth["path"], json!("music/cave.ogg"), "{mouth}");
    assert_eq!(mouth["fadingFrom"], json!("music/yard.ogg"), "still fading out 30 ticks into a 2 s crossfade: {mouth}");
    assert_eq!(ticks[IN_CAVE[1] as usize]["music"]["path"], json!("music/cave.ogg"));
}

#[test]
fn the_cave_reverb_zone_is_active_only_while_the_ears_are_inside() {
    let ticks = one_loop(PoolClass::Desktop);
    for tick in IN_CAVE {
        assert_eq!(ticks[tick as usize]["zone"], json!("cave"), "tick {tick}");
    }
    for tick in IN_YARD {
        assert_eq!(ticks[tick as usize]["zone"], Value::Null, "tick {tick}");
    }
}

#[test]
fn the_wall_occludes_the_generator_only_from_behind_it() {
    let ticks = one_loop(PoolClass::Desktop);
    let hum = |tick: u64| voices_of(&ticks[tick as usize], "sfx/hum.wav").first().map(|voice| (*voice).clone()).expect("the hum loops");
    let (behind, open) = (hum(BEHIND_WALL), hum(IN_THE_OPEN));
    assert_eq!(behind["occluded"], json!(true), "{behind}");
    assert_eq!(open["occluded"], json!(false), "{open}");
    assert!(number(&behind["cutoffHz"]) < number(&open["cutoffHz"]), "occlusion darkens: {behind} vs {open}");
}

#[test]
fn the_drone_rises_in_pitch_approaching_and_falls_flying_away() {
    let ticks = one_loop(PoolClass::Desktop);
    let position = |since: u64| {
        let audio = &ticks[(DRONE_START_TICK + since) as usize];
        number(&voices_of(audio, "sfx/drone.wav").first().expect("the drone plays")["positionS"])
    };
    // The drone's 1 s loop advances by its pitch each tick: more than a tick's worth while it
    // approaches, less as it flies away (the walker stands level with it near tick 93).
    let rate = |from: u64, to: u64| (position(to) - position(from)).rem_euclid(1.0) / ((to - from) as f64 * TICK_S);
    let (approach, away) = (rate(10, 40), rate(120, 150));
    assert!(approach > 1.03, "pitch above 1 approaching: {approach}");
    assert!(away < 0.97, "pitch below 1 flying away: {away}");
}

#[test]
fn hud_chimes_play_on_the_ui_bus_and_are_never_virtual_on_a_phone() {
    let ticks = one_loop(PoolClass::Phone);
    let chime = voices_of(&ticks[CHIME as usize], "sfx/click.wav");
    assert_eq!(chime.len(), 1, "{}", ticks[CHIME as usize]);
    assert_eq!(chime[0]["bus"], json!("ui"));
    assert_eq!(chime[0]["virtual"], json!(false), "a UI sound keeps a physical voice");
    assert!(number(&ticks[CHIME as usize]["pool"]["virtual"]) > 0.0, "while other voices are virtual");
}

#[test]
fn pressing_t_makes_the_radio_speak_off_its_schedule() {
    let mut rt = runtime(game());
    for _ in 0..30 {
        rt.step(FIXED_STEP_MS);
    }
    assert!(voices_of(&rt.state()["volatile"]["audio"], "sfx/dialogue.wav").is_empty());
    rt.inject(Input::key_down(Key::KeyT));
    rt.step(FIXED_STEP_MS);
    rt.inject(Input::key_up(Key::KeyT));
    rt.step(FIXED_STEP_MS);
    let audio = rt.state()["volatile"]["audio"].clone();
    assert_eq!(voices_of(&audio, "sfx/dialogue.wav").len(), 1, "{audio}");
}

#[test]
fn audio_never_enters_the_checksum() {
    let checksums = |game: genex::Game<World>| {
        let mut rt = runtime(game);
        (0..TOUR_TICKS / 60)
            .map(|_| {
                for _ in 0..60 {
                    rt.step(FIXED_STEP_MS);
                }
                rt.checksum()
            })
            .collect::<Vec<_>>()
    };
    assert_eq!(checksums(game()), checksums(game_quiet()));
}

#[test]
fn seed_2_then_seed_1_replays_a_fresh_seed_1() {
    let run = |seeds: &[u32]| {
        let mut rt = Runtime::with_assets(game(), Box::new(ASSETS)).expect("installs");
        for seed in seeds {
            rt.seed(*seed);
            for _ in 0..240 {
                rt.step(FIXED_STEP_MS);
            }
        }
        (rt.state()["volatile"]["audio"].clone(), rt.audio_logical_hash(), rt.checksum())
    };
    let fresh = run(&[1]);
    assert_eq!(run(&[2, 1]), fresh);
}
