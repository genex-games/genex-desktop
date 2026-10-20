//! The shared wire fixture (`tests/fixtures/play-ai-wire-v1.json`, generated from the TypeScript
//! by `scripts/toolchains/play-ai-wire-fixture.ts`), replayed row by row: the vocabularies and
//! limits, every compiled call (refusal code, wire and the exact line text), the other lines a
//! game prints, schema and answer verdicts, canonical JSON and the studio's answers.

use serde_json::{Map, Value, json};

use crate::compile::{self, Base, Context, Question, Tool};
use crate::json::{canonical_json, js_json};
use crate::schema::{SchemaNode, check_schema, validate_value};
use crate::wire::*;
use crate::{AiOptions, AiResult, Ask, GameAi, Judge, Say};

const FIXTURE: &str = include_str!("../../../../../tests/fixtures/play-ai-wire-v1.json");

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("the shared fixture is JSON")
}

fn texts(value: &Value) -> Vec<&str> {
    value.as_array().expect("a list").iter().map(|item| item.as_str().expect("text")).collect()
}

fn wires<T: Copy>(all: &[T], wire: fn(T) -> &'static str) -> Vec<&'static str> {
    all.iter().map(|value| wire(*value)).collect()
}

#[test]
fn the_vocabularies_are_the_typescript_ones_in_order() {
    let fixture = fixture();
    let vocabularies = &fixture["vocabularies"];
    let rows: [(&str, Vec<&str>); 14] = [
        ("AiOp", wires(AiOp::ALL, AiOp::wire)),
        ("AiBridgeOp", wires(AiBridgeOp::ALL, AiBridgeOp::wire)),
        ("AiTier", wires(AiTier::ALL, AiTier::wire)),
        ("AiAuthority", wires(AiAuthority::ALL, AiAuthority::wire)),
        ("AiRequirement", wires(AiRequirement::ALL, AiRequirement::wire)),
        ("AiDoor", wires(AiDoor::ALL, AiDoor::wire)),
        ("AiSource", wires(AiSource::ALL, AiSource::wire)),
        ("AiProvenance", wires(AiProvenance::ALL, AiProvenance::wire)),
        ("AiErrorCode", wires(AiErrorCode::ALL, AiErrorCode::wire)),
        ("AiGrantStatus", wires(AiGrantStatus::ALL, AiGrantStatus::wire)),
        ("AiSchemaType", wires(AiSchemaType::ALL, AiSchemaType::wire)),
        ("AiSchemaProblem", wires(AiSchemaProblem::ALL, AiSchemaProblem::wire)),
        ("AiJudgeKind", wires(AiJudgeKind::ALL, AiJudgeKind::wire)),
        ("PlayAiOp", wires(PlayAiOp::ALL, PlayAiOp::wire)),
    ];
    for (name, rust) in rows {
        assert_eq!(rust, texts(&vocabularies[name]), "{name}");
    }
    assert_eq!(vocabularies["PlayEventAi"], PLAY_EVENT_AI);
    for code in AiErrorCode::ALL {
        assert_eq!(AiErrorCode::from_wire(code.wire()), Some(*code));
    }
}

#[test]
fn the_limits_are_the_typescript_ones() {
    let fixture = fixture();
    let limits = &fixture["limits"];
    let rows: [(&str, u64); 30] = [
        ("GAME_AI_WIRE_VERSION", u64::from(GAME_AI_WIRE_VERSION)),
        ("AI_MAX_PROMPT_BYTES", AI_MAX_PROMPT_BYTES as u64),
        ("AI_MAX_SCHEMA_BYTES", AI_MAX_SCHEMA_BYTES as u64),
        ("AI_MAX_UNTRUSTED_BYTES", AI_MAX_UNTRUSTED_BYTES as u64),
        ("AI_MAX_UNTRUSTED_FIELDS", AI_MAX_UNTRUSTED_FIELDS as u64),
        ("AI_DEFAULT_OUTPUT_TOKENS", u64::from(AI_DEFAULT_OUTPUT_TOKENS)),
        ("AI_MAX_OUTPUT_TOKENS", u64::from(AI_MAX_OUTPUT_TOKENS)),
        ("AI_MAX_OUTPUT_BYTES", AI_MAX_OUTPUT_BYTES as u64),
        ("AI_MAX_BODY_CHARS", AI_MAX_BODY_CHARS as u64),
        ("AI_MAX_WALK_NODES", AI_MAX_WALK_NODES as u64),
        ("AI_MAX_WALK_DEPTH", AI_MAX_WALK_DEPTH as u64),
        ("AI_SCHEMA_MAX_DEPTH", AI_SCHEMA_MAX_DEPTH as u64),
        ("AI_SCHEMA_MAX_PROPERTIES", AI_SCHEMA_MAX_PROPERTIES as u64),
        ("AI_SCHEMA_MAX_ENUM", AI_SCHEMA_MAX_ENUM as u64),
        ("AI_SCHEMA_MAX_KEY_CHARS", AI_SCHEMA_MAX_KEY_CHARS as u64),
        ("AI_SCHEMA_MAX_DESCRIPTION", AI_SCHEMA_MAX_DESCRIPTION as u64),
        ("AI_SCHEMA_MAX_TITLE", AI_SCHEMA_MAX_TITLE as u64),
        ("AI_SCHEMA_MAX_ITEMS_BOUND", AI_SCHEMA_MAX_ITEMS_BOUND),
        ("AI_MAX_JSON_NODES", AI_MAX_JSON_NODES as u64),
        ("AI_MAX_JSON_DEPTH", AI_MAX_JSON_DEPTH as u64),
        ("AI_MAX_JSON_ARRAY_ITEMS", AI_MAX_JSON_ARRAY_ITEMS),
        ("AI_SCHEMA_MAX_STRING", AI_SCHEMA_MAX_STRING),
        ("PLAY_AI_MAX_LINE_CHARS", PLAY_AI_MAX_LINE_CHARS as u64),
        ("PLAY_AI_MAX_IN_FLIGHT", PLAY_AI_MAX_IN_FLIGHT as u64),
        ("JUDGE_MAX_QUESTIONS", JUDGE_MAX_QUESTIONS as u64),
        ("JUDGE_MAX_TEXT", JUDGE_MAX_TEXT as u64),
        ("JUDGE_MAX_OPTION_CHARS", JUDGE_MAX_OPTION_CHARS as u64),
        ("JUDGE_MAX_STATE_BYTES", JUDGE_MAX_STATE_BYTES as u64),
        ("ACT_MAX_TOOLS", ACT_MAX_TOOLS as u64),
        ("ACT_MAX_DESCRIPTION", ACT_MAX_DESCRIPTION as u64),
    ];
    for (name, rust) in rows {
        assert_eq!(limits[name].as_u64(), Some(rust), "{name}");
    }
    let pair = |name: &str| {
        (limits[name]["min"].as_u64().unwrap_or(0) as usize, limits[name]["max"].as_u64().unwrap_or(0) as usize)
    };
    assert_eq!(pair("JUDGE_CHOICE_OPTIONS"), JUDGE_CHOICE_OPTIONS);
    assert_eq!(pair("JUDGE_SCORE_LEVELS"), JUDGE_SCORE_LEVELS);
    assert_eq!(limits["ACT_TOOL_KEY"], ACT_TOOL_KEY);
}

#[test]
fn the_name_patterns_are_the_ones_the_matchers_implement() {
    let fixture = fixture();
    // The matchers below are hand-written for these exact patterns: a change on the TypeScript
    // side fails here first.
    assert_eq!(fixture["patterns"]["site"], "^[A-Za-z][A-Za-z0-9_.-]{0,63}$");
    assert_eq!(fixture["patterns"]["id"], "^[A-Za-z0-9_-]{8,100}$");
    assert_eq!(fixture["patterns"]["name"], "^[A-Za-z][A-Za-z0-9_]{0,63}$");
    let sites: [(&str, bool); 9] = [
        ("a", true),
        ("turn.resolve", true),
        ("a-b_c.d", true),
        ("1a", false),
        ("", false),
        ("a b", false),
        ("é", false),
        (&"a".repeat(64), true),
        (&"a".repeat(65), false),
    ];
    for (text, is) in sites {
        assert_eq!(is_site(text), is, "site {text:?}");
    }
    let ids: [(&str, bool); 6] = [
        ("no-grant", true),
        ("abcdefg", false),
        ("rsai-00000001", true),
        ("a.b-cdefgh", false),
        (&"x".repeat(100), true),
        (&"x".repeat(101), false),
    ];
    for (text, is) in ids {
        assert_eq!(is_id(text), is, "id {text:?}");
    }
    let names: [(&str, bool); 5] = [("attack", true), ("a.b", false), ("_a", false), ("A_1", true), ("tool", true)];
    for (text, is) in names {
        assert_eq!(is_name(text), is, "name {text:?}");
    }
}

/// A request field as the fixture keeps it: `{"$repeat": [unit, count]}` is `unit` repeated.
fn text_of(value: &Value) -> Option<String> {
    if let Some(text) = value.as_str() {
        return Some(text.to_owned());
    }
    let repeat = value.get("$repeat")?;
    Some(repeat[0].as_str()?.repeat(usize::try_from(repeat[1].as_u64()?).ok()?))
}

fn expanded(value: &Value) -> Value {
    if let Some(text) = value.get("$repeat").and_then(|_| text_of(value)) {
        return Value::from(text);
    }
    match value {
        Value::Array(items) => Value::Array(items.iter().map(expanded).collect()),
        Value::Object(members) => {
            Value::Object(members.iter().map(|(key, child)| (key.clone(), expanded(child))).collect())
        }
        _ => value.clone(),
    }
}

fn base_of(request: &Value) -> Base {
    let mut base = Base::new(request["site"].as_str().expect("a site"));
    base.system = request.get("system").and_then(Value::as_str).map(str::to_owned);
    base.memory = request.get("memory").and_then(Value::as_str).map(str::to_owned);
    if let Some(Value::Object(fields)) = request.get("untrusted") {
        base.untrusted =
            fields.iter().map(|(name, text)| (name.clone(), text.as_str().expect("text").to_owned())).collect();
    }
    if let Some(tier) = request.get("tier").and_then(Value::as_str) {
        base.tier = AiTier::from_wire(tier).expect("a tier");
    }
    if let Some(authority) = request.get("authority").and_then(Value::as_str) {
        base.authority = AiAuthority::from_wire(authority).expect("an authority");
    }
    if let Some(tokens) = request.get("maxOutputTokens").and_then(Value::as_u64) {
        base.max_output_tokens = u32::try_from(tokens).expect("tokens");
    }
    base
}

fn question_of(raw: &Value) -> Question {
    let instructions = raw["instructions"].as_str().expect("instructions").to_owned();
    match raw["kind"].as_str() {
        Some("yes-no") => {
            let sides = raw
                .get("yes")
                .map(|yes| (yes.as_str().expect("yes").to_owned(), raw["no"].as_str().expect("no").to_owned()));
            Question::YesNo { instructions, sides }
        }
        Some("choice") => {
            let options = raw["options"].as_object().expect("options");
            Question::Choice {
                instructions,
                options: options
                    .iter()
                    .map(|(name, text)| (name.clone(), text.as_str().expect("text").to_owned()))
                    .collect(),
            }
        }
        _ => Question::Score { instructions, levels: texts(&raw["levels"]).into_iter().map(str::to_owned).collect() },
    }
}

fn questions_of(request: &Value) -> Vec<(String, Question)> {
    request["questions"]
        .as_object()
        .expect("questions")
        .iter()
        .map(|(name, raw)| (name.clone(), question_of(raw)))
        .collect()
}

fn tools_of(request: &Value) -> Vec<Tool> {
    let tools = request["tools"].as_object().expect("tools");
    tools
        .iter()
        .map(|(name, spec)| Tool {
            name: name.clone(),
            description: spec["description"].as_str().expect("description").to_owned(),
            args: spec["args"].clone(),
        })
        .collect()
}

/// One row compiled the crate's way, from the fixture's request.
fn compile_row(row: &Value) -> Result<compile::Compiled, AiErrorCode> {
    let request = expanded(&row["request"]);
    let sites: Option<Vec<String>> =
        row["sites"].as_array().map(|sites| sites.iter().map(|site| site.as_str().expect("site").to_owned()).collect());
    let context = Context {
        ticket: row["ticket"].as_str().expect("ticket"),
        grant_id: row["grantId"].as_str().expect("grant"),
        sites: sites.as_deref(),
    };
    let base = base_of(&request);
    let prompt = request.get("prompt").and_then(Value::as_str);
    match row["op"].as_str() {
        Some("ask") => compile::ask(&base, prompt.expect("prompt"), &request["schema"], &context),
        Some("say") => {
            compile::say(&base, prompt.expect("prompt"), request.get("maxChars").and_then(Value::as_u64), &context)
        }
        Some("judge") => compile::judge(&base, &questions_of(&request), &request["state"], prompt, &context),
        _ => compile::act(&base, prompt.expect("prompt"), &tools_of(&request), &context),
    }
}

fn line_text(rid: &str, op: AiBridgeOp, body: &Value) -> String {
    let mut line = Map::new();
    line.insert("event".to_owned(), Value::from(PLAY_EVENT_AI));
    line.insert("rid".to_owned(), Value::from(rid));
    line.insert("op".to_owned(), Value::from(op.wire()));
    line.insert("body".to_owned(), body.clone());
    js_json(&Value::Object(line))
}

#[test]
fn every_call_compiles_to_the_same_wire_and_line_or_the_same_refusal() {
    let fixture = fixture();
    let rows = fixture["compile"].as_array().expect("rows");
    assert!(rows.len() >= 30, "the fixture lost its rows");
    for row in rows {
        let name = row["name"].as_str().expect("a name");
        let expect = &row["expect"];
        match compile_row(row) {
            Err(code) => assert_eq!(Some(code.wire()), expect["code"].as_str(), "{name}"),
            Ok(compiled) => {
                assert_eq!(compiled.wire, expect["wire"], "{name}: the wire");
                assert_eq!(
                    line_text("rsai-00000001", AiBridgeOp::Call, &compiled.wire),
                    expect["line"].as_str().expect("a line"),
                    "{name}: the line, byte for byte"
                );
                assert_eq!(expect["hostReads"], true, "{name}: main reads it");
            }
        }
    }
}

/// The public way to ask a row: a game's AI with the row's sites, connected, asked once.
fn ask_publicly(row: &Value) -> Option<(GameAi, Vec<String>)> {
    let request = expanded(&row["request"]);
    let sites =
        row["sites"].as_array().map(|sites| sites.iter().map(|site| site.as_str().expect("site").to_owned()).collect());
    let ai = GameAi::new(AiOptions { sites, ..AiOptions::default() });
    ai.connect();
    let base = base_of(&request);
    let prompt = request.get("prompt").and_then(Value::as_str).unwrap_or_default();
    match row["op"].as_str() {
        Some("ask") => {
            let schema = SchemaNode::from_value(request["schema"].clone()).ok()?;
            let mut ask = Ask::with_schema(&base.site, prompt, schema);
            ask.base = base;
            ai.ask(ask);
        }
        Some("say") => {
            let mut say = Say::new(&base.site, prompt);
            say.base = base;
            say.max_chars = request.get("maxChars").and_then(Value::as_u64);
            ai.say(say);
        }
        Some("judge") => {
            let mut judge = Judge::new(&base.site, request["state"].clone());
            judge.base = base;
            judge.questions = questions_of(&request);
            judge.prompt = request.get("prompt").and_then(Value::as_str).map(str::to_owned);
            ai.judge(judge);
        }
        _ => return None,
    }
    let lines = ai.take_lines();
    Some((ai, lines))
}

#[test]
fn a_game_asking_through_its_ai_prints_the_fixtures_line_or_drains_its_refusal() {
    let fixture = fixture();
    for row in fixture["compile"].as_array().expect("rows") {
        let name = row["name"].as_str().expect("a name");
        let Some((ai, lines)) = ask_publicly(row) else { continue };
        match row["expect"]["line"].as_str() {
            Some(line) => assert_eq!(lines, [line], "{name}"),
            None => {
                assert!(lines.is_empty(), "{name}: a refused call prints nothing");
                let drained: Vec<AiResult> = ai.drain();
                assert_eq!(drained.len(), 1, "{name}");
                assert_eq!(drained[0].code().map(AiErrorCode::wire), row["expect"]["code"].as_str(), "{name}");
            }
        }
    }
}

#[test]
fn the_other_lines_a_game_prints_are_the_fixtures() {
    let fixture = fixture();
    let printed = |act: &dyn Fn(&GameAi)| -> Vec<String> {
        let ai = GameAi::default();
        ai.connect();
        act(&ai);
        ai.take_lines()
    };
    let hello = printed(&|ai| ai.hello());
    let doors = printed(&|ai| ai.doors());
    let active = printed(&|ai| ai.active_budget());
    let stop = printed(&|ai| ai.stop());
    let cancel = printed(&|ai| {
        let ticket = ai.ask(Ask::with_schema("dot.move", "Pick.", SchemaNode::null()));
        ai.cancel(&ticket);
    });
    let both = {
        let ai = GameAi::new(AiOptions { requires: AiRequirement::Ai, sites: None });
        ai.connect();
        ai.start(&[AiTier::Fast, AiTier::Smart, AiTier::Fast]);
        ai.take_lines()
    };
    let fast = printed(&|ai| ai.start(&[]));
    let ours = [
        &hello[0],
        &doors[0],
        &active[0],
        &stop[0],
        &cancel[1].replace("rsai-00000002", "rsai-00000001"),
        &both[0],
        &fast[0],
    ];
    let rows = fixture["lines"].as_array().expect("lines");
    assert_eq!(rows.len(), ours.len());
    for (row, line) in rows.iter().zip(ours) {
        assert_eq!(line.as_str(), row["line"].as_str().expect("a line"), "{}", row["op"]);
        assert_eq!(row["hostReads"], true);
    }
}

#[test]
fn schema_verdicts_are_the_typescript_ones() {
    let fixture = fixture();
    for row in fixture["schemas"].as_array().expect("schemas") {
        let problem = check_schema(&row["schema"]).map(AiSchemaProblem::wire);
        assert_eq!(problem, row["problem"].as_str(), "{}", row["name"]);
    }
}

#[test]
fn answer_verdicts_are_the_typescript_ones() {
    let fixture = fixture();
    for row in fixture["values"].as_array().expect("values") {
        assert_eq!(Some(validate_value(Some(&row["schema"]), &row["value"])), row["ok"].as_bool(), "{}", row["name"]);
    }
}

#[test]
fn canonical_json_is_the_typescript_text() {
    let fixture = fixture();
    for row in fixture["canonical"].as_array().expect("canonical") {
        assert_eq!(canonical_json(&row["value"]), row["text"].as_str().expect("text"));
    }
}

/// A game's AI that asked the fixture's move once: the line's rid, and the AI.
fn asked_move() -> (GameAi, crate::AiTicket<Value>) {
    let ai = GameAi::default();
    ai.connect();
    let schema = SchemaNode::object().property("move", SchemaNode::string().one_of(["left", "right"]));
    let ticket = ai.ask(Ask::with_schema("dot.move", "Pick the way.", schema).fallback(json!({"move": "right"})));
    assert_eq!(ai.take_lines().len(), 1);
    (ai, ticket)
}

#[test]
fn the_studios_answers_reach_the_game_as_the_fixture_says() {
    let fixture = fixture();
    let answers = &fixture["answers"];
    let reply = |ai: &GameAi, rid: &str, reply: &Value| {
        ai.take_studio_op(PlayAiOp::Reply.wire(), &json!({"rid": rid, "reply": reply}))
    };

    let (ai, ticket) = asked_move();
    assert_eq!(reply(&ai, "rsai-00000001", &answers["callOk"]), Ok(true));
    let results = ai.drain();
    assert_eq!(ticket.value(&results[0]), Some(json!({"move": "left"})));
    let answer = results[0].outcome.as_ref().expect("an answer");
    assert_eq!((answer.source, answer.provenance), (AiSource::Tape, AiProvenance::Replay));
    assert!(ai.status().on);

    let (ai, ticket) = asked_move();
    reply(&ai, "rsai-00000001", &answers["callRefused"]).expect("taken");
    let results = ai.drain();
    let failure = ticket.read(&results[0]).expect("its result").expect_err("a refusal");
    assert_eq!((failure.code, failure.retry_after_ms), (AiErrorCode::WaitingForPlan, Some(60_000)));
    assert_eq!(failure.fallback::<Value>(), Some(json!({"move": "right"})));

    let (ai, _) = asked_move();
    reply(&ai, "rsai-00000001", &answers["callOff"]).expect("taken");
    assert_eq!(ai.drain()[0].code(), Some(AiErrorCode::Off));
    assert!(!ai.status().on);

    let ai = GameAi::default();
    ai.connect();
    ai.hello();
    ai.doors();
    ai.active_budget();
    ai.take_lines();
    reply(&ai, "rsai-00000001", &answers["hello"]).expect("taken");
    reply(&ai, "rsai-00000002", &answers["doors"]).expect("taken");
    reply(&ai, "rsai-00000003", &answers["grant"]).expect("taken");
    let status = ai.status();
    assert_eq!((status.on, status.door, status.grant), (true, Some(AiDoor::Local), Some(AiGrantStatus::Active)));
    assert_eq!(ai.grant().map(|grant| grant.id), Some("grant-0001".to_owned()));
    let schema = SchemaNode::null();
    ai.ask(Ask::with_schema("dot.move", "Pick.", schema));
    let line: Value = serde_json::from_str(&ai.take_lines()[0]).expect("a line");
    assert_eq!(line["body"]["grantId"], "grant-0001", "a call carries the grant it holds");

    let ai = GameAi::default();
    ai.connect();
    ai.start(&[]);
    ai.take_lines();
    reply(&ai, "rsai-00000001", &answers["grantRefused"]).expect("taken");
    assert_eq!(ai.grant(), None);
    assert!(!ai.status().on);
}
