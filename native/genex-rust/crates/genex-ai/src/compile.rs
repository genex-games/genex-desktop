//! A game's request turned into the one call every lane carries (`AiCallRequest`), or refused
//! before anything leaves the game: the web SDK's `src/page/ai/compile.ts`, check for check and
//! code for code. A judge call becomes a JSON call whose schema its questions build; an act call
//! one whose schema names every tool. What compiles is exactly what main's reader
//! (`readAiCallRequest`) accepts, so the studio never drops a line a game is waiting on.

use serde_json::{Map, Value};

use crate::json::{AI_MESSAGE_BOUNDS, JsonBounds, canonical_json, has_words, is_bounded, js_json, utf16_len};
use crate::prompts::{
    CHOICE_ANSWER_WORDS, JUDGE_SYSTEM, PromptQuestion, act_prompt, judge_prompt, score_answer_words,
    yes_no_answer_words,
};
use crate::schema::{SchemaNode, check_schema};
use crate::wire::{
    ACT_MAX_DESCRIPTION, ACT_MAX_TOOLS, ACT_TOOL_KEY, AI_DEFAULT_OUTPUT_TOKENS, AI_MAX_OUTPUT_TOKENS,
    AI_MAX_PROMPT_BYTES, AI_MAX_SCHEMA_BYTES, AI_MAX_UNTRUSTED_BYTES, AI_MAX_UNTRUSTED_FIELDS, AI_MAX_WALK_DEPTH,
    AI_MAX_WALK_NODES, AiAuthority, AiErrorCode, AiOp, AiSchemaType, AiTier, GAME_AI_WIRE_VERSION,
    JUDGE_CHOICE_OPTIONS, JUDGE_MAX_OPTION_CHARS, JUDGE_MAX_QUESTIONS, JUDGE_MAX_STATE_BYTES, JUDGE_MAX_TEXT,
    JUDGE_SCORE_LEVELS, is_id, is_name, is_site,
};

/// Option names a JavaScript reader would copy onto a prototype.
const FORBIDDEN_NAMES: [&str; 3] = ["__proto__", "constructor", "prototype"];
/// The bounds a judge's state is held to before it is printed into the prompt.
const JUDGE_STATE_BOUNDS: JsonBounds =
    JsonBounds { nodes: AI_MAX_WALK_NODES, depth: AI_MAX_WALK_DEPTH, chars: JUDGE_MAX_STATE_BYTES };

/// What every call names besides its op's own parts.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Base {
    pub site: String,
    pub system: Option<String>,
    pub untrusted: Vec<(String, String)>,
    pub memory: Option<String>,
    pub tier: AiTier,
    pub authority: AiAuthority,
    pub max_output_tokens: u32,
}

impl Base {
    pub fn new(site: &str) -> Base {
        Base {
            site: site.to_owned(),
            system: None,
            untrusted: Vec::new(),
            memory: None,
            tier: AiTier::Fast,
            authority: AiAuthority::Local,
            max_output_tokens: AI_DEFAULT_OUTPUT_TOKENS,
        }
    }
}

/// The ticket and grant a compiled call carries, and the sites the game declared.
pub(crate) struct Context<'a> {
    pub ticket: &'a str,
    pub grant_id: &'a str,
    pub sites: Option<&'a [String]>,
}

/// One judge question, as the game wrote it.
#[derive(Clone, Debug, PartialEq)]
pub enum Question {
    /// A probability from 0 to 1 that the answer is yes; `sides` say what yes and no mean.
    YesNo {
        /// What the question asks.
        instructions: String,
        /// What yes and what no mean, when the game says.
        sides: Option<(String, String)>,
    },
    /// The name of one of 2-32 options, each described.
    Choice {
        /// What the question asks.
        instructions: String,
        /// The options by name, each with what it means.
        options: Vec<(String, String)>,
    },
    /// A level of 2-10, lowest first; the answer is its index.
    Score {
        /// What the question asks.
        instructions: String,
        /// The levels, lowest first.
        levels: Vec<String>,
    },
}

impl Question {
    /// A yes-or-no question.
    pub fn yes_no(instructions: &str) -> Question {
        Question::YesNo { instructions: instructions.to_owned(), sides: None }
    }

    /// A yes-or-no question that says what yes and no mean.
    pub fn yes_no_meaning(instructions: &str, yes: &str, no: &str) -> Question {
        Question::YesNo { instructions: instructions.to_owned(), sides: Some((yes.to_owned(), no.to_owned())) }
    }

    /// A question answered by one option's name.
    pub fn choice<'a>(instructions: &str, options: impl IntoIterator<Item = (&'a str, &'a str)>) -> Question {
        let options = options.into_iter().map(|(name, text)| (name.to_owned(), text.to_owned())).collect();
        Question::Choice { instructions: instructions.to_owned(), options }
    }

    /// A question answered by a level's index, lowest first.
    pub fn score<'a>(instructions: &str, levels: impl IntoIterator<Item = &'a str>) -> Question {
        Question::Score {
            instructions: instructions.to_owned(),
            levels: levels.into_iter().map(str::to_owned).collect(),
        }
    }
}

/// One tool an act call offers.
#[derive(Clone, Debug, PartialEq)]
pub struct Tool {
    /// Its name (`[A-Za-z][A-Za-z0-9_]{0,63}`, never `tool`): the answer's `tool` names it.
    pub name: String,
    /// What it does, for the model (1-500 characters).
    pub description: String,
    /// The shape of its arguments.
    pub args: Value,
}

impl Tool {
    /// A tool by its name, description and argument schema.
    pub fn new(name: &str, description: &str, args: SchemaNode) -> Tool {
        Tool { name: name.to_owned(), description: description.to_owned(), args: args.into_value() }
    }
}

/// A compiled call: the wire main reads, and the schema its answer is held to.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Compiled {
    pub wire: Value,
    pub schema: Option<Value>,
}

/// JavaScript's `isText`: words, at most `max` UTF-16 units.
fn is_text(text: &str, max: usize) -> bool {
    has_words(text) && utf16_len(text) <= max
}

fn site_ok(site: &str, sites: Option<&[String]>) -> bool {
    is_site(site) && sites.is_none_or(|sites| sites.iter().any(|declared| declared == site))
}

/// The player-typed fields: at most 16, named like sites, once each, each at most 8 KiB.
fn untrusted_problem(fields: &[(String, String)]) -> Option<AiErrorCode> {
    if fields.len() > AI_MAX_UNTRUSTED_FIELDS {
        return Some(AiErrorCode::BadRequest);
    }
    for (index, (name, text)) in fields.iter().enumerate() {
        let repeated = fields[..index].iter().any(|(earlier, _)| earlier == name);
        if !is_site(name) || repeated {
            return Some(AiErrorCode::BadRequest);
        }
        if text.len() > AI_MAX_UNTRUSTED_BYTES {
            return Some(AiErrorCode::TooLarge);
        }
    }
    None
}

/// The fields every op shares, read (`readBase`).
fn base_problem(base: &Base, context: &Context<'_>) -> Option<AiErrorCode> {
    if !site_ok(&base.site, context.sites) {
        return Some(AiErrorCode::BadRequest);
    }
    if let Some(code) = untrusted_problem(&base.untrusted) {
        return Some(code);
    }
    let tokens_ok = (1..=AI_MAX_OUTPUT_TOKENS).contains(&base.max_output_tokens);
    (!tokens_ok).then_some(AiErrorCode::BadRequest)
}

/// The op's own parts of a call.
struct Parts {
    system: Option<String>,
    prompt: String,
    schema: Option<Value>,
}

fn text_or_null(text: Option<&str>) -> Value {
    text.map_or(Value::Null, Value::from)
}

/// The call's wire (`finish`): the prompt and schema caps, then main's own reader.
fn finish(op: AiOp, base: &Base, parts: Parts, context: &Context<'_>) -> Result<Compiled, AiErrorCode> {
    let prompt_bytes =
        parts.system.as_ref().map_or(0, String::len) + parts.prompt.len() + base.memory.as_ref().map_or(0, String::len);
    if prompt_bytes > AI_MAX_PROMPT_BYTES {
        return Err(AiErrorCode::TooLarge);
    }
    if parts.schema.as_ref().is_some_and(|schema| js_json(schema).len() > AI_MAX_SCHEMA_BYTES) {
        return Err(AiErrorCode::TooLarge);
    }
    let untrusted: Map<String, Value> =
        base.untrusted.iter().map(|(name, text)| (name.clone(), Value::from(text.as_str()))).collect();
    let mut wire = Map::new();
    wire.insert("v".to_owned(), Value::from(GAME_AI_WIRE_VERSION));
    wire.insert("op".to_owned(), Value::from(op.wire()));
    wire.insert("site".to_owned(), Value::from(base.site.as_str()));
    wire.insert("ticket".to_owned(), Value::from(context.ticket));
    wire.insert("grantId".to_owned(), Value::from(context.grant_id));
    wire.insert("system".to_owned(), text_or_null(parts.system.as_deref()));
    wire.insert("prompt".to_owned(), Value::from(parts.prompt.as_str()));
    wire.insert("untrusted".to_owned(), Value::Object(untrusted));
    wire.insert("memory".to_owned(), text_or_null(base.memory.as_deref()));
    wire.insert("schema".to_owned(), parts.schema.clone().unwrap_or(Value::Null));
    wire.insert("tier".to_owned(), Value::from(base.tier.wire()));
    wire.insert("authority".to_owned(), Value::from(base.authority.wire()));
    wire.insert("maxOutputTokens".to_owned(), Value::from(base.max_output_tokens));
    wire.insert("stream".to_owned(), Value::Bool(op == AiOp::Say));
    let wire = Value::Object(wire);
    // What `readAiCallRequest` checks beyond what was read above.
    let readable = is_bounded(&wire, AI_MESSAGE_BOUNDS)
        && is_id(context.ticket)
        && is_id(context.grant_id)
        && has_words(&parts.prompt);
    if !readable {
        return Err(AiErrorCode::BadRequest);
    }
    Ok(Compiled { wire, schema: parts.schema })
}

/// `ask`: JSON that fits the game's schema.
pub(crate) fn ask(base: &Base, prompt: &str, schema: &Value, context: &Context<'_>) -> Result<Compiled, AiErrorCode> {
    if let Some(code) = base_problem(base, context) {
        return Err(code);
    }
    if !has_words(prompt) {
        return Err(AiErrorCode::BadRequest);
    }
    if check_schema(schema).is_some() {
        return Err(AiErrorCode::InvalidSchema);
    }
    let parts = Parts { system: base.system.clone(), prompt: prompt.to_owned(), schema: Some(schema.clone()) };
    finish(AiOp::Ask, base, parts, context)
}

/// `say`: free text, streamed; `max_chars` (at least 1) cuts the answer the game keeps.
pub(crate) fn say(
    base: &Base,
    prompt: &str,
    max_chars: Option<u64>,
    context: &Context<'_>,
) -> Result<Compiled, AiErrorCode> {
    if let Some(code) = base_problem(base, context) {
        return Err(code);
    }
    if !has_words(prompt) || max_chars == Some(0) {
        return Err(AiErrorCode::BadRequest);
    }
    let parts = Parts { system: base.system.clone(), prompt: prompt.to_owned(), schema: None };
    finish(AiOp::Say, base, parts, context)
}

/// One judge question read: its schema and its prompt lines.
struct ReadQuestion<'a> {
    schema: Value,
    prompt: PromptQuestion<'a>,
}

fn read_yes_no(sides: Option<&(String, String)>) -> Option<(Value, String, Vec<String>)> {
    if let Some((yes, no)) = sides
        && !(is_text(yes, JUDGE_MAX_TEXT) && is_text(no, JUDGE_MAX_TEXT))
    {
        return None;
    }
    let schema = SchemaNode::number().minimum(0.0).maximum(1.0).into_value();
    let words = yes_no_answer_words(sides.map(|(yes, no)| (yes.as_str(), no.as_str())));
    Some((schema, words, Vec::new()))
}

fn read_choice(options: &[(String, String)]) -> Option<(Value, String, Vec<String>)> {
    let (fewest, most) = JUDGE_CHOICE_OPTIONS;
    if options.len() < fewest || options.len() > most {
        return None;
    }
    for (index, (name, text)) in options.iter().enumerate() {
        let named =
            (1..=JUDGE_MAX_OPTION_CHARS).contains(&utf16_len(name)) && !FORBIDDEN_NAMES.contains(&name.as_str());
        let repeated = options[..index].iter().any(|(earlier, _)| earlier == name);
        if !named || repeated || !is_text(text, JUDGE_MAX_TEXT) {
            return None;
        }
    }
    let schema = SchemaNode::string().one_of(options.iter().map(|(name, _)| name.as_str())).into_value();
    let lines = options.iter().map(|(name, text)| format!("{name}: {text}")).collect();
    Some((schema, CHOICE_ANSWER_WORDS.to_owned(), lines))
}

fn read_score(levels: &[String]) -> Option<(Value, String, Vec<String>)> {
    let (fewest, most) = JUDGE_SCORE_LEVELS;
    if levels.len() < fewest || levels.len() > most || !levels.iter().all(|level| is_text(level, JUDGE_MAX_TEXT)) {
        return None;
    }
    let schema = SchemaNode::integer().minimum(0.0).maximum((levels.len() - 1) as f64).into_value();
    let lines = levels.iter().enumerate().map(|(index, level)| format!("{index}: {level}")).collect();
    Some((schema, score_answer_words(levels.len()), lines))
}

fn read_question<'a>(name: &'a str, question: &'a Question) -> Option<ReadQuestion<'a>> {
    let instructions = match question {
        Question::YesNo { instructions, .. }
        | Question::Choice { instructions, .. }
        | Question::Score { instructions, .. } => instructions,
    };
    if !is_name(name) || !is_text(instructions, JUDGE_MAX_TEXT) {
        return None;
    }
    let (schema, answer, options) = match question {
        Question::YesNo { sides, .. } => read_yes_no(sides.as_ref())?,
        Question::Choice { options, .. } => read_choice(options)?,
        Question::Score { levels, .. } => read_score(levels)?,
    };
    Some(ReadQuestion { schema, prompt: PromptQuestion { name, instructions, answer, options } })
}

/// A judge's state as its prompt carries it: canonical JSON within the judge's bounds.
fn state_text(state: &Value) -> Result<String, AiErrorCode> {
    if !is_bounded(state, JUDGE_STATE_BOUNDS) {
        return Err(AiErrorCode::BadRequest);
    }
    let text = canonical_json(state);
    if text.len() > JUDGE_MAX_STATE_BYTES {
        return Err(AiErrorCode::TooLarge);
    }
    Ok(text)
}

/// A closed object schema over named properties, every one required.
fn closed_object(properties: Vec<(&str, Value)>) -> Value {
    let required: Vec<Value> = properties.iter().map(|(name, _)| Value::from(*name)).collect();
    let mut node = Map::new();
    node.insert("type".to_owned(), Value::from(AiSchemaType::Object.wire()));
    node.insert(
        "properties".to_owned(),
        Value::Object(properties.into_iter().map(|(name, schema)| (name.to_owned(), schema)).collect()),
    );
    node.insert("required".to_owned(), Value::Array(required));
    node.insert("additionalProperties".to_owned(), Value::Bool(false));
    Value::Object(node)
}

/// `judge`: classify the game's state against fixed questions, as JSON its questions shape.
pub(crate) fn judge(
    base: &Base,
    questions: &[(String, Question)],
    state: &Value,
    extra: Option<&str>,
    context: &Context<'_>,
) -> Result<Compiled, AiErrorCode> {
    if let Some(code) = base_problem(base, context) {
        return Err(code);
    }
    if questions.is_empty() || questions.len() > JUDGE_MAX_QUESTIONS {
        return Err(AiErrorCode::BadRequest);
    }
    let mut read = Vec::with_capacity(questions.len());
    for (index, (name, question)) in questions.iter().enumerate() {
        let repeated = questions[..index].iter().any(|(earlier, _)| earlier == name);
        let one = read_question(name, question).filter(|_| !repeated).ok_or(AiErrorCode::BadRequest)?;
        read.push(one);
    }
    if extra.is_some_and(|extra| !has_words(extra)) {
        return Err(AiErrorCode::BadRequest);
    }
    let state = state_text(state)?;
    let schema = closed_object(read.iter().map(|question| (question.prompt.name, question.schema.clone())).collect());
    let prompts: Vec<PromptQuestion<'_>> = read.into_iter().map(|question| question.prompt).collect();
    let prompt = judge_prompt(&prompts, &state, extra);
    let parts = Parts { system: Some(JUDGE_SYSTEM.to_owned()), prompt, schema: Some(schema) };
    finish(AiOp::Judge, base, parts, context)
}

fn tools_ok(tools: &[Tool]) -> bool {
    if tools.is_empty() || tools.len() > ACT_MAX_TOOLS {
        return false;
    }
    tools.iter().enumerate().all(|(index, tool)| {
        let repeated = tools[..index].iter().any(|earlier| earlier.name == tool.name);
        let named = is_name(&tool.name) && tool.name != ACT_TOOL_KEY && !repeated;
        named && is_text(&tool.description, ACT_MAX_DESCRIPTION) && check_schema(&tool.args).is_none()
    })
}

/// `act`: pick exactly one tool and fill its arguments.
pub(crate) fn act(base: &Base, prompt: &str, tools: &[Tool], context: &Context<'_>) -> Result<Compiled, AiErrorCode> {
    if let Some(code) = base_problem(base, context) {
        return Err(code);
    }
    if !has_words(prompt) || !tools_ok(tools) {
        return Err(AiErrorCode::BadRequest);
    }
    let names = SchemaNode::string().one_of(tools.iter().map(|tool| tool.name.as_str())).into_value();
    let mut properties = vec![(ACT_TOOL_KEY, names)];
    properties.extend(tools.iter().map(|tool| (tool.name.as_str(), tool.args.clone())));
    let schema = closed_object(properties);
    if check_schema(&schema).is_some() {
        return Err(AiErrorCode::InvalidSchema);
    }
    let listed: Vec<(&str, &str)> = tools.iter().map(|tool| (tool.name.as_str(), tool.description.as_str())).collect();
    let parts = Parts { system: base.system.clone(), prompt: act_prompt(prompt, &listed), schema: Some(schema) };
    finish(AiOp::Act, base, parts, context)
}

/// The tool an act answer picked, and its arguments (`decodeAct`).
pub(crate) fn picked(answer: &Value) -> Option<(&str, &Value)> {
    let tool = answer.get(ACT_TOOL_KEY)?.as_str()?;
    Some((tool, answer.get(tool)?))
}

/// A `say` answer cut to `max` characters (code points), never inside one.
pub(crate) fn cut_to(text: &str, max: Option<u64>) -> String {
    match max.and_then(|max| usize::try_from(max).ok()) {
        Some(max) => text.chars().take(max).collect(),
        None => text.to_owned(),
    }
}
