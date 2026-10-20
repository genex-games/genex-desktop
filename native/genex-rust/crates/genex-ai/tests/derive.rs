//! `#[derive(Schema)]`: a Rust type as the closed dialect, in step with its serde names, and an
//! answer the dialect passed read back into the type; an enum with documented variants as an act
//! call's tools.

use genex_ai::{Act, AiOptions, Ask, GameAi, Schema, SchemaNode, ToolSet};
use serde::Deserialize;
use serde_json::{Value, json};

/// One nation's reaction.
#[derive(Clone, Debug, PartialEq, Deserialize, Schema)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct Reaction {
    /// Which nation reacts.
    nation: Nation,
    /// How its stance moves.
    #[genex_ai(min = -3, max = 3)]
    stance_shift: i32,
    /// Troops sent.
    #[genex_ai(min = -500, max = 500)]
    troops: i16,
    /// A line for the chronicle.
    #[genex_ai(max_length = 120)]
    note: Option<String>,
    #[serde(rename = "final")]
    last: bool,
    #[serde(default)]
    weight: f64,
    #[serde(skip)]
    #[allow(dead_code, reason = "a skipped field never reaches the schema")]
    cache: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Schema)]
#[serde(rename_all = "kebab-case")]
enum Nation {
    Avar,
    ByzantineEmpire,
    #[serde(rename = "rus")]
    KievanRus,
}

/// One turn's resolution.
#[derive(Clone, Debug, PartialEq, Deserialize, Schema)]
#[serde(deny_unknown_fields)]
struct Turn {
    #[genex_ai(max_items = 8, max_length = 40)]
    tags: Vec<String>,
    #[genex_ai(max_items = 8)]
    reactions: Vec<Reaction>,
    #[genex_ai(title = "Headline", description = "One line, past tense.")]
    headline: String,
    corner: [u8; 2],
}

/// The tools a robot picks from.
#[derive(Clone, Debug, PartialEq, Deserialize, Schema)]
#[serde(deny_unknown_fields, rename_all = "snake_case")]
enum Order {
    /// Hit a target.
    Attack {
        /// The target's slot.
        #[genex_ai(min = 0, max = 7)]
        target: u8,
    },
    /// Run away.
    Flee,
    /// Say something.
    Taunt(Line),
}

/// A taunt.
#[derive(Clone, Debug, PartialEq, Deserialize, Schema)]
#[serde(deny_unknown_fields)]
struct Line {
    #[genex_ai(max_length = 30)]
    words: String,
}

/// The ways a dot runs: unit variants with doc comments are a schema and a tool set.
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Schema)]
#[serde(rename_all = "lowercase")]
enum Way {
    /// Run left.
    Left,
    /// Run right.
    Right,
}

#[test]
fn a_struct_is_a_closed_object_with_its_serde_names_and_bounds() {
    let schema = Reaction::schema();
    assert_eq!(schema.problem(), None);
    assert_eq!(
        schema.to_value(),
        json!({
            "type": "object",
            "properties": {
                "nation": {"type": "string", "enum": ["avar", "byzantine-empire", "rus"], "description": "Which nation reacts."},
                "stanceShift": {"type": "integer", "minimum": -3, "maximum": 3, "description": "How its stance moves."},
                "troops": {"type": "integer", "minimum": -500, "maximum": 500, "description": "Troops sent."},
                "note": {"type": "string", "maxLength": 120, "description": "A line for the chronicle."},
                "final": {"type": "boolean"},
                "weight": {"type": "number"}
            },
            "required": ["nation", "stanceShift", "troops", "final"],
            "additionalProperties": false,
            "description": "One nation's reaction."
        })
    );
}

#[test]
fn nested_lists_arrays_and_annotations_reach_the_schema() {
    let schema = Turn::schema();
    assert_eq!(schema.problem(), None);
    let value = schema.to_value();
    assert_eq!(
        value["properties"]["tags"],
        json!({"type": "array", "items": {"type": "string", "maxLength": 40}, "maxItems": 8})
    );
    assert_eq!(value["properties"]["reactions"]["items"], Reaction::schema().to_value());
    assert_eq!(
        value["properties"]["headline"],
        json!({"type": "string", "title": "Headline", "description": "One line, past tense."})
    );
    assert_eq!(value["properties"]["corner"]["minItems"], 2);
    assert_eq!(value["description"], "One turn's resolution.");
}

#[test]
fn an_answer_the_dialect_passed_reads_into_the_type() {
    let ai = GameAi::new(AiOptions::default());
    ai.connect();
    let ticket = ai.ask(Ask::<Reaction>::new("turn.react", "React."));
    ai.take_lines();
    let value = json!({"nation": "rus", "stanceShift": -2, "troops": 120, "final": true});
    let reply = json!({"v": 1, "ok": true, "ticket": "rstk-00000001-00000001", "value": value, "source": "local", "provenance": "unverified", "latencyMs": 9, "cached": false});
    assert_eq!(ai.take_studio_op("ai.reply", &json!({"rid": "rsai-00000001", "reply": reply})), Ok(true));
    let results = ai.drain();
    let reaction = ticket.read(&results[0]).expect("its result").expect("an answer");
    assert_eq!(
        reaction,
        Reaction {
            nation: Nation::KievanRus,
            stance_shift: -2,
            troops: 120,
            note: None,
            last: true,
            weight: 0.0,
            cache: 0
        }
    );
}

#[test]
fn an_answer_outside_the_types_bounds_never_reaches_the_game() {
    let ai = GameAi::new(AiOptions::default());
    ai.connect();
    let ticket = ai.ask(Ask::<Reaction>::new("turn.react", "React."));
    ai.take_lines();
    let rows: [Value; 4] = [
        json!({"nation": "rus", "stanceShift": 4, "troops": 0, "final": true}),
        json!({"nation": "gaul", "stanceShift": 0, "troops": 0, "final": true}),
        json!({"nation": "rus", "stanceShift": 0, "troops": 0, "final": true, "extra": 1}),
        json!({"nation": "rus", "stanceShift": 0, "troops": 0}),
    ];
    for (index, value) in rows.into_iter().enumerate() {
        let rid = format!("rsai-{:08}", index + 1);
        if index > 0 {
            ai.ask(Ask::<Reaction>::new("turn.react", "React."));
            ai.take_lines();
        }
        let ticket_text = format!("rstk-00000001-{:08}", index + 1);
        let reply = json!({"v": 1, "ok": true, "ticket": ticket_text, "value": value, "source": "local", "provenance": "unverified", "latencyMs": 1, "cached": false});
        ai.take_studio_op("ai.reply", &json!({"rid": rid, "reply": reply})).expect("taken");
    }
    let results = ai.drain();
    assert_eq!(results.len(), 4);
    for result in &results {
        assert_eq!(result.code(), Some(genex_ai::AiErrorCode::InvalidOutput), "{result:?}");
    }
    assert!(ticket.read(&results[0]).expect("its result").is_err());
}

#[test]
fn an_enum_with_documented_variants_is_a_tool_set() {
    let tools = Order::tools();
    let names: Vec<&str> = tools.iter().map(|tool| tool.name.as_str()).collect();
    assert_eq!(names, ["attack", "flee", "taunt"]);
    assert_eq!(tools[0].description, "Hit a target.");
    assert_eq!(tools[0].args["properties"]["target"]["maximum"], 7);
    assert_eq!(tools[1].args, SchemaNode::object().to_value());
    assert_eq!(tools[2].args, Line::schema().to_value());
    assert_eq!(Order::from_pick("attack", &json!({"target": 3})), Some(Order::Attack { target: 3 }));
    assert_eq!(Order::from_pick("flee", &json!({})), Some(Order::Flee));
    assert_eq!(Order::from_pick("taunt", &json!({"words": "Ha"})), Some(Order::Taunt(Line { words: "Ha".to_owned() })));
    assert_eq!(Order::from_pick("dance", &json!({})), None);
    assert_eq!(Way::tools().len(), 2);
    assert_eq!(
        Way::schema().to_value(),
        json!({"type": "string", "enum": ["left", "right"], "description": "The ways a dot runs: unit variants with doc comments are a schema and a tool set."})
    );
}

#[test]
fn an_act_answer_reads_into_the_picked_tool() {
    let ai = GameAi::new(AiOptions::default());
    ai.connect();
    let ticket = ai.act(Act::<Order>::new("robot.act", "The enemy is near.").fallback(Order::Flee));
    let line: Value = serde_json::from_str(&ai.take_lines()[0]).expect("a line");
    let schema = &line["body"]["schema"];
    assert_eq!(schema["properties"]["tool"]["enum"], json!(["attack", "flee", "taunt"]));
    assert_eq!(schema["required"], json!(["tool", "attack", "flee", "taunt"]));
    let value = json!({"tool": "taunt", "attack": {"target": 0}, "flee": {}, "taunt": {"words": "Too slow"}});
    let reply = json!({"v": 1, "ok": true, "ticket": "rstk-00000001-00000001", "value": value, "source": "fixture", "provenance": "fixture", "latencyMs": 1, "cached": false});
    ai.take_studio_op("ai.reply", &json!({"rid": "rsai-00000001", "reply": reply})).expect("taken");
    let results = ai.drain();
    assert_eq!(ticket.value(&results[0]), Some(Order::Taunt(Line { words: "Too slow".to_owned() })));
}
