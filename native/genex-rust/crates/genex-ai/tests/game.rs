//! A game's AI at its boundary with the studio: the lines it prints, the hostile answers it
//! takes (each refused with no side effect on the game), the in-flight cap, cancel, streaming,
//! a reset that forgets a run, and replay determinism: the same calls answered on the same step
//! boundaries give the same results on the same drains.

use genex_ai::{
    AiErrorCode, AiOpRefusal, AiOptions, AiRequirement, AiResult, AiTicket, AiTransport, Ask, GameAi, Judge, Judgement,
    Question, Say, SchemaNode,
};
use serde_json::{Value, json};

fn connected(options: AiOptions) -> GameAi {
    let ai = GameAi::new(options);
    ai.connect();
    ai
}

fn move_schema() -> SchemaNode {
    SchemaNode::object().property("move", SchemaNode::string().one_of(["left", "right"]))
}

fn ask_move(ai: &GameAi) -> AiTicket<Value> {
    ai.ask(Ask::with_schema("dot.move", "Pick the way.", move_schema()).fallback(json!({"move": "left"})))
}

fn ticket_text(run: u64, id: u64) -> String {
    format!("rstk-{run:08}-{id:08}")
}

fn answer(ticket: &str, value: Value) -> Value {
    json!({"v": 1, "ok": true, "ticket": ticket, "value": value, "source": "tape", "provenance": "replay", "latencyMs": 0, "cached": false})
}

fn reply(ai: &GameAi, rid: &str, reply: Value) -> Result<bool, AiOpRefusal> {
    ai.take_studio_op("ai.reply", &json!({"rid": rid, "reply": reply}))
}

fn rid_of(line: &str) -> String {
    let line: Value = serde_json::from_str(line).expect("a JSON line");
    line["rid"].as_str().expect("a rid").to_owned()
}

#[test]
fn a_game_with_no_studio_plays_its_fallbacks_and_prints_nothing() {
    let ai = GameAi::new(AiOptions::default());
    let ticket = ask_move(&ai);
    let said = ai.say(Say::new("npc.greet", "Greet.").fallback("Hello.".to_owned()));
    assert!(ai.take_lines().is_empty());
    let results = ai.drain();
    assert_eq!(
        results.iter().map(AiResult::code).collect::<Vec<_>>(),
        [Some(AiErrorCode::Off), Some(AiErrorCode::Off)]
    );
    assert_eq!(ticket.value(&results[0]), Some(json!({"move": "left"})));
    assert_eq!(said.value(&results[1]), Some("Hello.".to_owned()));
    let status = ai.status();
    assert_eq!((status.transport, status.on, status.fallbacks, status.pending), (AiTransport::Off, false, 2, 0));
}

#[test]
fn every_studio_op_outside_its_shape_is_refused_or_ignored_with_no_side_effect() {
    let ai = connected(AiOptions::default());
    let ticket = ask_move(&ai);
    let rid = rid_of(&ai.take_lines()[0]);
    let before = ai.status();
    let rows: Vec<(&str, &str, Value, Result<bool, AiOpRefusal>)> = vec![
        ("an unknown op", "ai.replay", json!({"rid": rid, "reply": {}}), Err(AiOpRefusal::UnknownOp)),
        ("an op in another case", "AI.REPLY", json!({"rid": rid}), Err(AiOpRefusal::UnknownOp)),
        ("no rid", "ai.reply", json!({"reply": {}}), Err(AiOpRefusal::BadArgs)),
        ("a rid that is a number", "ai.reply", json!({"rid": 1, "reply": {}}), Err(AiOpRefusal::BadArgs)),
        ("arguments that are a list", "ai.reply", json!([rid]), Err(AiOpRefusal::BadArgs)),
        ("arguments that are null", "ai.delta", Value::Null, Err(AiOpRefusal::BadArgs)),
        (
            "a rid never printed",
            "ai.reply",
            json!({"rid": "rsai-99999999", "reply": answer(&ticket_text(1, 1), json!({"move": "right"}))}),
            Ok(false),
        ),
        ("a rid of another shape", "ai.reply", json!({"rid": "../../etc/passwd", "reply": {}}), Ok(false)),
        ("a delta that is not text", "ai.delta", json!({"rid": rid, "text": {"t": 1}}), Ok(false)),
        ("a delta for an ask", "ai.delta", json!({"rid": rid, "text": "left"}), Ok(false)),
        ("a delta for a rid never printed", "ai.delta", json!({"rid": "rsai-99999999", "text": "x"}), Ok(false)),
    ];
    for (why, op, args, read) in rows {
        assert_eq!(ai.take_studio_op(op, &args), read, "{why}");
        assert_eq!(ai.status(), before, "{why}: nothing changed");
    }
    assert!(ai.drain().is_empty(), "nothing arrived");
    assert_eq!(ai.partial(&ticket), None);
}

#[test]
fn a_hostile_answer_to_a_waiting_call_is_a_typed_failure_with_its_fallback() {
    let rows: Vec<(&str, Value, AiErrorCode)> = vec![
        ("not an object", json!("left"), AiErrorCode::Provider),
        ("no reply at all", Value::Null, AiErrorCode::Provider),
        ("another ticket", answer(&ticket_text(1, 9), json!({"move": "left"})), AiErrorCode::Provider),
        ("a value outside the schema", answer(&ticket_text(1, 1), json!({"move": "up"})), AiErrorCode::InvalidOutput),
        (
            "a value with an extra key",
            answer(&ticket_text(1, 1), json!({"move": "left", "x": 1})),
            AiErrorCode::InvalidOutput,
        ),
        ("a value too deep", answer(&ticket_text(1, 1), deep(40)), AiErrorCode::InvalidOutput),
        (
            "an unknown code",
            json!({"v": 1, "ok": false, "ticket": ticket_text(1, 1), "code": "rm -rf", "retryAfterMs": null}),
            AiErrorCode::Provider,
        ),
    ];
    for (why, hostile, code) in rows {
        let ai = connected(AiOptions::default());
        let ticket = ask_move(&ai);
        ai.take_lines();
        assert_eq!(reply(&ai, "rsai-00000001", hostile), Ok(true), "{why}: it answered the line");
        let results = ai.drain();
        assert_eq!(results.len(), 1, "{why}");
        assert_eq!(results[0].code(), Some(code), "{why}");
        assert_eq!(ticket.value(&results[0]), Some(json!({"move": "left"})), "{why}: the fallback plays");
        assert_eq!(
            reply(&ai, "rsai-00000001", answer(&ticket_text(1, 1), json!({"move": "right"}))),
            Ok(false),
            "{why}: a second answer is ignored"
        );
        assert!(ai.drain().is_empty(), "{why}");
    }
}

fn deep(levels: usize) -> Value {
    (0..levels).fold(json!("left"), |inner, _| json!({"move": inner}))
}

#[test]
fn past_four_unanswered_lines_a_call_fails_here_and_prints_nothing() {
    let ai = connected(AiOptions::default());
    let tickets: Vec<AiTicket<Value>> = (0..5).map(|_| ask_move(&ai)).collect();
    assert_eq!(ai.take_lines().len(), 4);
    let results = ai.drain();
    assert_eq!(results.len(), 1);
    assert!(tickets[4].is(&results[0]));
    assert_eq!(results[0].code(), Some(AiErrorCode::Concurrency));
    assert_eq!(ai.status().in_flight, 4);
    reply(&ai, "rsai-00000001", answer(&ticket_text(1, 1), json!({"move": "right"}))).expect("taken");
    ask_move(&ai);
    assert_eq!(ai.take_lines().len(), 1, "an answered line frees its place");
}

#[test]
fn a_call_refused_before_it_leaves_prints_nothing_and_drains_its_code() {
    let ai = connected(AiOptions { requires: AiRequirement::Ai, sites: Some(vec!["dot.move".to_owned()]) });
    let rows: Vec<(&str, AiTicket<Value>, AiErrorCode)> = vec![
        ("an undeclared site", ai.ask(Ask::with_schema("dot.other", "x", move_schema())), AiErrorCode::BadRequest),
        ("a blank prompt", ai.ask(Ask::with_schema("dot.move", " \u{feff}", move_schema())), AiErrorCode::BadRequest),
        (
            "a field over its cap",
            ai.ask(Ask::with_schema("dot.move", "x", move_schema()).untrusted("name", &"é".repeat(4097))),
            AiErrorCode::TooLarge,
        ),
        (
            "a field named twice",
            ai.ask(Ask::with_schema("dot.move", "x", move_schema()).untrusted("a", "1").untrusted("a", "2")),
            AiErrorCode::BadRequest,
        ),
        (
            "a field named like a prototype",
            ai.ask(Ask::with_schema("dot.move", "x", move_schema()).untrusted("constructor", "1")),
            AiErrorCode::BadRequest,
        ),
        (
            "no output tokens",
            ai.ask(Ask::with_schema("dot.move", "x", move_schema()).max_output_tokens(0)),
            AiErrorCode::BadRequest,
        ),
        ("a schema too deep", ai.ask(Ask::with_schema("dot.move", "x", nested(6))), AiErrorCode::InvalidSchema),
    ];
    assert!(ai.take_lines().is_empty());
    let results = ai.drain();
    for ((why, ticket, code), result) in rows.iter().zip(&results) {
        assert!(ticket.is(result), "{why}");
        assert_eq!(result.code(), Some(*code), "{why}");
    }
    assert_eq!(ai.status().needs_ai, Some(AiErrorCode::InvalidSchema), "an AI-only game with no fallback needs AI");
}

fn nested(levels: usize) -> SchemaNode {
    (0..levels).fold(SchemaNode::string(), |inner, _| SchemaNode::array(inner))
}

#[test]
fn a_line_longer_than_the_studio_reads_is_refused_here() {
    let ai = connected(AiOptions::default());
    let mut ask = Ask::with_schema("dot.move", &"p".repeat(100 * 1024), move_schema());
    for index in 0..13 {
        ask = ask.untrusted(&format!("f{index}"), &"\u{1}".repeat(2000));
    }
    let ticket = ai.ask(ask);
    assert!(ai.take_lines().is_empty(), "escaped control characters take it past the line cap");
    assert_eq!(
        ai.drain().iter().find(|result| ticket.is(result)).and_then(AiResult::code),
        Some(AiErrorCode::TooLarge)
    );
}

#[test]
fn a_say_streams_its_text_and_is_cut_to_its_cap() {
    let ai = connected(AiOptions::default());
    let ticket = ai.say(Say::new("npc.greet", "Greet the player.").max_chars(5));
    let rid = rid_of(&ai.take_lines()[0]);
    assert_eq!(ai.partial(&ticket), None);
    assert_eq!(ai.take_studio_op("ai.delta", &json!({"rid": rid, "text": "Hel"})), Ok(true));
    assert_eq!(ai.partial(&ticket).as_deref(), Some("Hel"));
    assert_eq!(ai.take_studio_op("ai.delta", &json!({"rid": rid, "text": "Hello, trav"})), Ok(true));
    assert_eq!(ai.partial(&ticket).as_deref(), Some("Hello"));
    reply(&ai, &rid, answer(&ticket_text(1, 1), json!("Hello, traveller."))).expect("taken");
    assert_eq!(ai.partial(&ticket), None);
    let results = ai.drain();
    assert_eq!(ticket.value(&results[0]).as_deref(), Some("Hello"));
}

#[test]
fn a_canceled_call_arrives_once_as_canceled_without_its_fallback() {
    let ai = connected(AiOptions { requires: AiRequirement::Ai, sites: None });
    let ticket = ask_move(&ai);
    assert!(ai.cancel(&ticket));
    assert!(!ai.cancel(&ticket), "once is enough");
    let lines = ai.take_lines();
    let cancel: Value = serde_json::from_str(&lines[1]).expect("a line");
    assert_eq!((cancel["op"].as_str(), &cancel["body"]), (Some("cancel"), &json!({"ticket": ticket_text(1, 1)})));
    let results = ai.drain();
    let failure = ticket.read(&results[0]).expect("its result").expect_err("canceled");
    assert_eq!(failure.code, AiErrorCode::Canceled);
    assert!(!failure.has_fallback());
    reply(&ai, "rsai-00000001", answer(&ticket_text(1, 1), json!({"move": "right"})))
        .expect("its line is still answered");
    assert!(ai.drain().is_empty(), "a late answer to a canceled call adds nothing");
    assert_eq!(ai.status().needs_ai, None, "a cancel is the game's own choice");
    assert_eq!(ai.status().in_flight, 1, "the cancel line waits for its answer");
}

#[test]
fn a_reset_forgets_the_run_and_numbers_calls_again() {
    let ai = connected(AiOptions::default());
    let first = ask_move(&ai);
    let printed = ai.take_lines();
    ai.forget_run();
    let second = ask_move(&ai);
    let again = ai.take_lines();
    assert_eq!(first.id(), second.id(), "tickets count again from 1 after a reset");
    assert_ne!(rid_of(&printed[0]), rid_of(&again[0]), "rids never repeat in a process");
    let line: Value = serde_json::from_str(&again[0]).expect("a line");
    assert_eq!(line["body"]["ticket"], ticket_text(2, 1), "a wire ticket never repeats either");
    assert_eq!(
        reply(&ai, &rid_of(&printed[0]), answer(&ticket_text(1, 1), json!({"move": "right"}))),
        Ok(false),
        "the run before is forgotten"
    );
    assert!(ai.drain().is_empty());
    assert_eq!(ai.echo().asked, [rid_of(&again[0])]);
}

#[test]
fn losing_the_studio_answers_every_waiting_call_ai_off() {
    let ai = connected(AiOptions::default());
    let ticket = ask_move(&ai);
    ai.take_lines();
    ai.disconnect();
    let results = ai.drain();
    assert_eq!(results[0].code(), Some(AiErrorCode::Off));
    assert_eq!(ticket.value(&results[0]), Some(json!({"move": "left"})));
    assert_eq!(ai.status().in_flight, 0);
}

#[test]
fn a_judge_answers_by_question() {
    let ai = connected(AiOptions::default());
    let ticket = ai.judge(
        Judge::new("turn.judge", json!({"turn": 3}))
            .question("plausible", Question::yes_no("Could it happen?"))
            .question("mood", Question::choice("The mood.", [("calm", "nobody minds"), ("angry", "riots")]))
            .question("risk", Question::score("How risky?", ["none", "some", "grave"]))
            .fallback(Judgement::new().with_yes("plausible", 0.5)),
    );
    let rid = rid_of(&ai.take_lines()[0]);
    reply(&ai, &rid, answer(&ticket_text(1, 1), json!({"plausible": 0.75, "mood": "angry", "risk": 2})))
        .expect("taken");
    let judgement = ticket.value(&ai.drain()[0]).expect("a judgement");
    assert_eq!(
        (judgement.yes("plausible"), judgement.choice("mood"), judgement.score("risk")),
        (Some(0.75), Some("angry"), Some(2))
    );
}

/// A studio stand-in that holds every answer to the next step boundary, as the studio does
/// while it holds the clock: the answer to the n-th line is the n-th of `script`.
struct Replay {
    script: Vec<Value>,
    answered: usize,
}

impl Replay {
    fn answer_waiting(&mut self, ai: &GameAi, lines: Vec<String>) {
        for line in lines {
            let line: Value = serde_json::from_str(&line).expect("a line");
            let ticket = line["body"]["ticket"].as_str().unwrap_or_default().to_owned();
            let value = self.script[self.answered % self.script.len()].clone();
            self.answered += 1;
            reply(ai, line["rid"].as_str().expect("a rid"), answer(&ticket, value)).expect("taken");
        }
    }
}

/// A tiny game: every 4th tick it asks where to move, and moves by what drained.
fn play(ai: &GameAi, ticks: u32, studio: &mut Replay) -> (i64, Vec<(u64, u64, Option<String>)>) {
    ai.forget_run();
    let mut x = 0i64;
    let mut log = Vec::new();
    for tick in 0..ticks {
        // The studio's answers land between steps, before the tick that drains them.
        studio.answer_waiting(ai, ai.take_lines());
        for result in ai.drain() {
            let way = result.value().and_then(|value| value["move"].as_str()).map(str::to_owned);
            x += if way.as_deref() == Some("right") { 1 } else { -1 };
            log.push((result.ticket, result.frame, way));
        }
        if tick % 4 == 0 {
            ask_move(ai);
        }
    }
    (x, log)
}

#[test]
fn the_same_calls_answered_on_the_same_boundaries_replay_the_same_results_on_the_same_drains() {
    let script = vec![json!({"move": "right"}), json!({"move": "left"}), json!({"move": "right"})];
    let ai = connected(AiOptions::default());
    let first = play(&ai, 40, &mut Replay { script: script.clone(), answered: 0 });
    let second = play(&ai, 40, &mut Replay { script, answered: 0 });
    assert_eq!(first, second);
    // Ten calls (ticks 0, 4, … 36), each answered on the boundary after it and drained on the
    // next tick: the first asked on tick 0, drained on tick 1 (the run's second drain).
    assert_eq!(first.1.len(), 10);
    assert_eq!(first.1[0], (1, 2, Some("right".to_owned())));
    assert_eq!(first.0, 4, "the script right, left, right over ten answers: seven rights, three lefts");
    let status = ai.status();
    assert_eq!((status.calls, status.answered, status.pending, status.in_flight), (10, 10, 0, 0));
}
