//! What a game asks: [`Ask`] (JSON that fits a type), [`Say`] (free text, streamed), [`Judge`]
//! (questions about a state) and [`Act`] (one tool of a set), each with the options every call
//! shares, and the typed values a judge and an act answer become.

use std::marker::PhantomData;

use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::compile::{Base, Question, Tool};
use crate::schema::{Schema, SchemaNode};
use crate::wire::{AiAuthority, AiTier};

/// The options every call takes: static words the model reads first, player-typed fields, a
/// memory, the tier and authority, the output budget, and the fallback played without an answer.
macro_rules! call_options {
    ($request:ident $(<$param:ident>)?, $fallback:ty) => {
        impl$(<$param>)? $request$(<$param>)? {
            /// Player-typed text by name (a site-like name, at most 16 fields of 8 KiB): every model
            /// sees it fenced as the player's words, never as instructions. Never put it in the prompt.
            pub fn untrusted(mut self, name: &str, text: &str) -> Self {
                self.base.untrusted.push((name.to_owned(), text.to_owned()));
                self
            }

            /// How capable a model the call needs (`fast` unless named).
            pub fn tier(mut self, tier: AiTier) -> Self {
                self.base.tier = tier;
                self
            }

            /// `shared` when other players see the answer or a leaderboard counts it: only Genex
            /// credits answer such a call (`needs_verified` otherwise).
            pub fn authority(mut self, authority: AiAuthority) -> Self {
                self.base.authority = authority;
                self
            }

            /// The most output tokens the answer may take (1-32 768; 512 unless named).
            pub fn max_output_tokens(mut self, tokens: u32) -> Self {
                self.base.max_output_tokens = tokens;
                self
            }

            /// What the game plays when no answer comes: the failure carries it.
            pub fn fallback(mut self, fallback: $fallback) -> Self {
                self.fallback = Some(fallback);
                self
            }
        }
    };
}

/// The options a call with free prompts takes besides the shared ones.
macro_rules! prompt_options {
    ($request:ident $(<$param:ident>)?) => {
        impl$(<$param>)? $request$(<$param>)? {
            /// Static words the model reads first (the world's rules, a persona): the same on every call.
            pub fn system(mut self, system: &str) -> Self {
                self.base.system = Some(system.to_owned());
                self
            }

            /// What the game remembers for this call, as text.
            pub fn memory(mut self, memory: &str) -> Self {
                self.base.memory = Some(memory.to_owned());
                self
            }
        }
    };
}

/// Structured output: JSON that fits `T`'s schema, read into a `T`.
///
/// ```
/// use genex_ai::{Ask, Schema};
/// use serde::Deserialize;
///
/// #[derive(Clone, Deserialize, Schema)]
/// #[serde(deny_unknown_fields)]
/// struct Move {
///     /// Where the dot runs.
///     #[genex_ai(max_length = 8)]
///     way: String,
/// }
///
/// let request = Ask::<Move>::new("dot.move", "Pick the way the dot runs.").fallback(Move { way: "left".into() });
/// # let _ = request;
/// ```
#[derive(Clone, Debug)]
pub struct Ask<T> {
    pub(crate) base: Base,
    pub(crate) prompt: String,
    pub(crate) schema: Value,
    pub(crate) fallback: Option<T>,
}

impl<T: Schema + DeserializeOwned> Ask<T> {
    /// Ask at `site` (the call site's stable name) with `prompt` (never player-typed text).
    pub fn new(site: &str, prompt: &str) -> Ask<T> {
        Ask { base: Base::new(site), prompt: prompt.to_owned(), schema: T::schema().into_value(), fallback: None }
    }
}

impl Ask<Value> {
    /// Ask for JSON that fits a schema built by hand, read as JSON.
    pub fn with_schema(site: &str, prompt: &str, schema: SchemaNode) -> Ask<Value> {
        Ask { base: Base::new(site), prompt: prompt.to_owned(), schema: schema.into_value(), fallback: None }
    }
}

call_options!(Ask<T>, T);
prompt_options!(Ask<T>);

/// Free text, streamed: `GameAi::partial` holds what has arrived so far.
#[derive(Clone, Debug)]
pub struct Say {
    pub(crate) base: Base,
    pub(crate) prompt: String,
    pub(crate) max_chars: Option<u64>,
    pub(crate) fallback: Option<String>,
}

impl Say {
    /// Say at `site` with `prompt` (never player-typed text).
    pub fn new(site: &str, prompt: &str) -> Say {
        Say { base: Base::new(site), prompt: prompt.to_owned(), max_chars: None, fallback: None }
    }

    /// The longest answer the game keeps, in characters (at least 1); the rest is cut.
    pub fn max_chars(mut self, max: u64) -> Say {
        self.max_chars = Some(max);
        self
    }
}

call_options!(Say, String);
prompt_options!(Say);

/// Classify a state against fixed questions; the answer is a [`Judgement`].
#[derive(Clone, Debug)]
pub struct Judge {
    pub(crate) base: Base,
    pub(crate) questions: Vec<(String, Question)>,
    pub(crate) state: Value,
    pub(crate) prompt: Option<String>,
    pub(crate) fallback: Option<Judgement>,
}

impl Judge {
    /// Judge `state` (plain JSON, at most 96 KiB) at `site`.
    pub fn new(site: &str, state: Value) -> Judge {
        Judge { base: Base::new(site), questions: Vec::new(), state, prompt: None, fallback: None }
    }

    /// One question by name (`[A-Za-z][A-Za-z0-9_]{0,63}`); 1-32 of them.
    pub fn question(mut self, name: &str, question: Question) -> Judge {
        self.questions.push((name.to_owned(), question));
        self
    }

    /// Words the judge reads before the questions.
    pub fn prompt(mut self, prompt: &str) -> Judge {
        self.prompt = Some(prompt.to_owned());
        self
    }
}

call_options!(Judge, Judgement);

/// Pick exactly one tool of `T`'s set and fill its arguments.
#[derive(Clone, Debug)]
pub struct Act<T> {
    pub(crate) base: Base,
    pub(crate) prompt: String,
    pub(crate) tools: Vec<Tool>,
    pub(crate) fallback: Option<T>,
}

impl<T: ToolSet> Act<T> {
    /// Act at `site` with `prompt` (never player-typed text).
    pub fn new(site: &str, prompt: &str) -> Act<T> {
        Act { base: Base::new(site), prompt: prompt.to_owned(), tools: T::tools(), fallback: None }
    }
}

call_options!(Act<T>, T);
prompt_options!(Act<T>);

/// A set of tools an act call picks one of. `#[derive(Schema)]` writes it for an enum whose
/// every variant has a doc comment (the tool's description): a unit variant takes no arguments,
/// a struct variant its fields, a one-field tuple variant its field's type.
pub trait ToolSet: Sized {
    /// The tools, in order.
    fn tools() -> Vec<Tool>;
    /// The value an answer that picked `tool` with `args` stands for, or None when it fits no tool.
    fn from_pick(tool: &str, args: &Value) -> Option<Self>;
}

/// A typed act answer for the derive: the variant `tool` names, read the way serde reads an
/// externally tagged enum (a unit variant by its name, any other as `{name: args}`).
#[doc(hidden)]
pub fn decode_tool<T: DeserializeOwned>(tool: &str, args: &Value, unit: bool) -> Option<T> {
    let tagged = if unit {
        Value::from(tool)
    } else {
        let mut map = Map::new();
        map.insert(tool.to_owned(), args.clone());
        Value::Object(map)
    };
    serde_json::from_value(tagged).ok()
}

/// A judge call's answers, by question: a probability for a yes-or-no question, an option's name
/// for a choice, a level's index for a score.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Judgement(Vec<(String, Value)>);

impl Judgement {
    /// No answers yet: build a fallback with [`Judgement::with_yes`] and its kin.
    pub fn new() -> Judgement {
        Judgement::default()
    }

    /// With `question` answered yes with probability `probability`.
    pub fn with_yes(mut self, question: &str, probability: f64) -> Judgement {
        self.0.push((question.to_owned(), Value::from(probability)));
        self
    }

    /// With `question` answered by the option `option`.
    pub fn with_choice(mut self, question: &str, option: &str) -> Judgement {
        self.0.push((question.to_owned(), Value::from(option)));
        self
    }

    /// With `question` answered by the level `level`.
    pub fn with_score(mut self, question: &str, level: u32) -> Judgement {
        self.0.push((question.to_owned(), Value::from(level)));
        self
    }

    fn answer(&self, question: &str) -> Option<&Value> {
        self.0.iter().find(|(name, _)| name == question).map(|(_, answer)| answer)
    }

    /// The probability, from 0 to 1, that the yes-or-no `question`'s answer is yes.
    pub fn yes(&self, question: &str) -> Option<f64> {
        self.answer(question)?.as_f64()
    }

    /// The option the choice `question` was answered with.
    pub fn choice(&self, question: &str) -> Option<&str> {
        self.answer(question)?.as_str()
    }

    /// The level (0 the lowest) the score `question` was answered with.
    pub fn score(&self, question: &str) -> Option<u32> {
        self.answer(question)?.as_u64().and_then(|level| u32::try_from(level).ok())
    }

    /// A judge answer (an object of answers by question) as a judgement.
    pub(crate) fn from_value(value: &Value) -> Option<Judgement> {
        let Value::Object(answers) = value else { return None };
        Some(Judgement(answers.iter().map(|(name, answer)| (name.clone(), answer.clone())).collect()))
    }
}

/// A call on its way: what [`crate::GameAi::drain`]'s results are matched to and read through.
pub struct AiTicket<T> {
    pub(crate) id: u64,
    pub(crate) site: String,
    pub(crate) decode: fn(&Value) -> Option<T>,
    pub(crate) kind: PhantomData<T>,
}

impl<T> Clone for AiTicket<T> {
    fn clone(&self) -> Self {
        AiTicket { id: self.id, site: self.site.clone(), decode: self.decode, kind: PhantomData }
    }
}

impl<T> std::fmt::Debug for AiTicket<T> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiTicket").field("id", &self.id).field("site", &self.site).finish()
    }
}

impl<T> PartialEq for AiTicket<T> {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl<T> AiTicket<T> {
    /// The call's number in this run (from 1, counted again after every reset, so a replay
    /// numbers its calls the same).
    pub fn id(&self) -> u64 {
        self.id
    }

    /// The call site.
    pub fn site(&self) -> &str {
        &self.site
    }
}

/// Serde's reading of an answer into `T`.
pub(crate) fn decode_serde<T: DeserializeOwned>(value: &Value) -> Option<T> {
    serde_json::from_value(value.clone()).ok()
}

/// A `say` answer: its text.
pub(crate) fn decode_text(value: &Value) -> Option<String> {
    value.as_str().map(str::to_owned)
}

/// An act answer: the tool it picked, as `T`.
pub(crate) fn decode_pick<T: ToolSet>(value: &Value) -> Option<T> {
    let (tool, args) = crate::compile::picked(value)?;
    T::from_pick(tool, args)
}

/// A judge answer, as a judgement.
pub(crate) fn decode_judgement(value: &Value) -> Option<Judgement> {
    Judgement::from_value(value)
}
