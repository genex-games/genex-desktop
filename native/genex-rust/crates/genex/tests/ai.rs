//! Play-time AI through the facade: a game declares it with `game.ai(..)`, asks through `ctx.ai`
//! in its update hooks, and reads answers only from `ctx.ai.drain()` on the fixed step. A seed
//! forgets the run before it, `state().volatile.ai` echoes the rids (never the checksum), and the
//! same seed with the same answers on the same step boundaries replays the same checksum.

use genex::ai::{AiErrorCode, AiOptions, AiRequirement, AiTicket, Ask, SchemaNode};
use genex::prelude::*;
use genex::{InstallErrorCode, Runtime};

#[derive(Default)]
struct World {
    x: i64,
    asked: u32,
    waiting: Option<AiTicket<Value>>,
    codes: Vec<String>,
}

fn move_schema() -> SchemaNode {
    SchemaNode::object().property("move", SchemaNode::string().one_of(["left", "right"]))
}

/// Every 10th tick it asks which way to run (a fallback of left), and runs by what drained.
fn runner(ai: Option<AiOptions>) -> Game<World> {
    let mut game = Game::new(World::default()).title("Runner");
    if let Some(options) = ai {
        game.ai(options);
    }
    game.on_update(|sim, ctx| {
        for result in ctx.ai.drain() {
            let Some(ticket) = sim.world.waiting.as_ref().filter(|ticket| ticket.is(&result)) else { continue };
            let way = ticket.value(&result).and_then(|value| value["move"].as_str().map(str::to_owned));
            sim.world.x += if way.as_deref() == Some("right") { 1 } else { -1 };
            if let Some(code) = result.code() {
                sim.world.codes.push(code.wire().to_owned());
            }
            sim.world.waiting = None;
        }
        if ctx.tick % 10 == 0 && sim.world.waiting.is_none() {
            sim.world.asked += 1;
            let ask = Ask::with_schema("dot.move", "Pick the way.", move_schema()).fallback(json!({"move": "left"}));
            sim.world.waiting = Some(ctx.ai.ask(ask));
        }
    });
    game.probe("runner", |sim| json!({"x": sim.world.x, "asked": sim.world.asked, "codes": sim.world.codes}));
    game
}

/// The studio's stand-in: between steps it answers every line the last step printed, the n-th
/// call with the n-th way of `ways`.
fn answer_lines(runtime: &Runtime<World>, ways: &[&str], answered: &mut usize) {
    for line in runtime.ai().take_lines() {
        let line: Value = serde_json::from_str(&line).expect("a line");
        let ticket = line["body"]["ticket"].as_str().unwrap_or_default().to_owned();
        let way = ways[*answered % ways.len()];
        *answered += 1;
        let reply = json!({"v": 1, "ok": true, "ticket": ticket, "value": {"move": way}, "source": "tape", "provenance": "replay", "latencyMs": 0, "cached": false});
        let taken = runtime.ai().take_studio_op("ai.reply", &json!({"rid": line["rid"], "reply": reply}));
        assert_eq!(taken, Ok(true));
    }
}

fn played(runtime: &mut Runtime<World>, seed: u32, steps: u32, ways: &[&str]) -> (String, Value) {
    runtime.seed(seed);
    let mut answered = 0;
    for _ in 0..steps {
        runtime.step(64.0);
        answer_lines(runtime, ways, &mut answered);
    }
    (runtime.checksum(), runtime.state())
}

#[test]
fn the_same_seed_and_answers_on_the_same_boundaries_replay_the_same_checksum() {
    let mut runtime = Runtime::new(runner(Some(AiOptions::default()))).expect("installs");
    assert!(runtime.uses_ai());
    runtime.ai().connect();
    let ways = ["right", "right", "left"];
    let (first, state) = played(&mut runtime, 7, 30, &ways);
    let (second, again) = played(&mut runtime, 7, 30, &ways);
    assert_eq!(first, second);
    assert_eq!(state["runner"], again["runner"]);
    assert!(state["runner"]["asked"].as_u64().unwrap_or(0) > 10, "{}", state["runner"]);
    assert_eq!(state["runner"]["codes"], json!([]));
    let echo = &state["volatile"]["ai"];
    assert!(!echo["asked"].as_array().expect("rids").is_empty());
    assert_eq!(echo["asked"], echo["answered"], "every line it printed was answered by its rid");
    assert_ne!(echo["asked"], again["volatile"]["ai"]["asked"], "rids are not part of a replay");
    assert_eq!(state["volatile"]["ai"]["status"]["transport"], "protocol");
    let (other, _) = played(&mut runtime, 7, 30, &["left"]);
    assert_ne!(first, other, "the answers steer the game");
}

#[test]
fn a_seed_forgets_the_run_before_it() {
    let mut runtime = Runtime::new(runner(Some(AiOptions::default()))).expect("installs");
    runtime.ai().connect();
    runtime.seed(1);
    runtime.step(16.0);
    let lines = runtime.ai().take_lines();
    assert_eq!(lines.len(), 1);
    let line: Value = serde_json::from_str(&lines[0]).expect("a line");
    runtime.seed(1);
    let late = json!({"v": 1, "ok": true, "ticket": line["body"]["ticket"], "value": {"move": "right"}, "source": "tape", "provenance": "replay", "latencyMs": 0, "cached": false});
    assert_eq!(runtime.ai().take_studio_op("ai.reply", &json!({"rid": line["rid"], "reply": late})), Ok(false));
    assert_eq!(runtime.state()["volatile"]["ai"]["asked"], json!([]));
}

#[test]
fn a_game_with_no_studio_taking_its_ai_plays_its_fallbacks() {
    let mut runtime =
        Runtime::new(runner(Some(AiOptions { requires: AiRequirement::Optional, sites: None }))).expect("installs");
    runtime.seed(3);
    runtime.step(64.0);
    assert!(runtime.ai().take_lines().is_empty());
    let state = runtime.state();
    assert_eq!(state["runner"]["codes"], json!([AiErrorCode::Off.wire()]));
    assert_eq!(state["runner"]["x"], -1, "the fallback ran it left");
}

#[test]
fn a_game_that_declares_no_ai_has_no_ai_state_and_its_calls_fail_ai_off() {
    let mut runtime = Runtime::new(runner(None)).expect("installs");
    assert!(!runtime.uses_ai());
    runtime.seed(3);
    // Two ticks: the call on the first, its failure drained on the second.
    runtime.step(32.0);
    let state = runtime.state();
    assert!(state["volatile"].get("ai").is_none());
    assert_eq!(state["runner"]["codes"], json!([AiErrorCode::Off.wire()]));
}

#[test]
fn a_volatile_probe_cannot_take_the_ai_echos_place() {
    let mut game = runner(Some(AiOptions::default()));
    game.probe_volatile("ai", |_| json!(0));
    let refused = Runtime::new(game).err().map(|error| error.code());
    assert_eq!(refused, Some(InstallErrorCode::ReservedProbe));
    let mut plain = runner(None);
    plain.probe_volatile("ai", |_| json!(0));
    assert!(Runtime::new(plain).is_ok(), "a game without AI may name a probe ai");
}
