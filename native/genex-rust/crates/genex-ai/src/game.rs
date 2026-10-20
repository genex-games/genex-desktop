//! [`GameAi`]: a game's play-time AI. A call answers its ticket at once and prints one `ai` line
//! for the studio; the studio's `ai.reply` (and, for `say`, `ai.delta`) come back in order with
//! every other op, and the result enters the game only through [`GameAi::drain`], once per fixed
//! step. A failure carries the fallback the call named. Nothing here reads a clock, a random
//! number or the network: tickets and rids are counters, so the same seed and inputs ask the same
//! calls in the same order, and a replayed run (the studio holds a saved playtest's answers to
//! its step boundaries) releases every answer on the same tick.

use std::any::Any;
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::marker::PhantomData;
use std::sync::Arc;

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::answers::{self, AiGrant, CallAnswer};
use crate::compile::{self, Compiled, Context};
use crate::json::{js_json, utf16_len};
use crate::requests::{
    Act, AiTicket, Ask, Judge, Judgement, Say, ToolSet, decode_judgement, decode_pick, decode_serde, decode_text,
};
use crate::schema::validate_value;
use crate::wire::{
    AI_MAX_OUTPUT_BYTES, AiBridgeOp, AiDoor, AiErrorCode, AiGrantStatus, AiOp, AiProvenance, AiRequirement, AiSource,
    AiTier, AiTransport, GAME_AI_WIRE_VERSION, PLAY_AI_MAX_IN_FLIGHT, PLAY_AI_MAX_LINE_CHARS, PLAY_EVENT_AI, PlayAiOp,
};

/// The grant id a call carries before the game holds a grant.
const NO_GRANT: &str = "no-grant";
/// How many rids of each kind the echo keeps, newest last.
const MAX_ECHO: usize = 256;
/// The HUD chip's words, which a game draws once it uses AI.
const DISCLOSURE_TEXT: &str = "AI-generated";
/// Where the chip sits.
const DISCLOSURE_ANCHOR: &str = "top-right";

/// How a game starts its AI.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AiOptions {
    /// `Ai` when the game means nothing without a model; `Optional` (the default) when it plays on.
    pub requires: AiRequirement,
    /// Every call site the game uses; a call naming another is refused `bad_request`. None: any.
    pub sites: Option<Vec<String>>,
}

impl Default for AiOptions {
    fn default() -> Self {
        AiOptions { requires: AiRequirement::Optional, sites: None }
    }
}

/// An answer and where it came from.
#[derive(Clone, Debug, PartialEq)]
pub struct AiAnswer {
    /// The answer: it fitted the call's schema (a `say` answer: text with words, cut to `max_chars`).
    pub value: Value,
    /// Where it came from.
    pub source: AiSource,
    /// How far it can be trusted: only `verified` may decide a leaderboard, a reward or shared state.
    pub provenance: AiProvenance,
    /// The studio answered it from its cache.
    pub cached: bool,
}

/// Why a call got no answer, with the fallback the call named.
#[derive(Clone)]
pub struct AiFailure {
    /// Why.
    pub code: AiErrorCode,
    /// The call site.
    pub site: String,
    /// When the code says to wait (a plan resting, a rate limit), how long, in milliseconds.
    pub retry_after_ms: Option<u64>,
    fallback: Option<Arc<dyn Any + Send + Sync>>,
}

impl AiFailure {
    /// The fallback the call named, when it named one of type `T`.
    pub fn fallback<T: Clone + 'static>(&self) -> Option<T> {
        self.fallback.as_ref()?.downcast_ref::<T>().cloned()
    }

    /// Whether the call named a fallback.
    pub fn has_fallback(&self) -> bool {
        self.fallback.is_some()
    }
}

impl std::fmt::Debug for AiFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AiFailure")
            .field("code", &self.code)
            .field("site", &self.site)
            .field("retry_after_ms", &self.retry_after_ms)
            .field("fallback", &self.fallback.is_some())
            .finish()
    }
}

impl PartialEq for AiFailure {
    fn eq(&self, other: &Self) -> bool {
        self.code == other.code
            && self.site == other.site
            && self.retry_after_ms == other.retry_after_ms
            && self.has_fallback() == other.has_fallback()
    }
}

/// What [`GameAi::drain`] hands the game: one call's answer, or why there is none.
#[derive(Clone, Debug, PartialEq)]
pub struct AiResult {
    /// The call's [`AiTicket::id`].
    pub ticket: u64,
    /// The call site.
    pub site: String,
    /// What the call asked.
    pub op: AiOp,
    /// The drain it was released on (from 1, counted again after every reset).
    pub frame: u64,
    /// The answer, or why there is none.
    pub outcome: Result<AiAnswer, AiFailure>,
}

impl AiResult {
    /// Whether this is `ticket`'s result.
    pub fn is<T>(&self, ticket: &AiTicket<T>) -> bool {
        self.ticket == ticket.id
    }

    /// Whether the call got an answer.
    pub fn ok(&self) -> bool {
        self.outcome.is_ok()
    }

    /// Why the call got no answer; None when it got one.
    pub fn code(&self) -> Option<AiErrorCode> {
        self.outcome.as_ref().err().map(|failure| failure.code)
    }

    /// The answer as JSON; None on a failure.
    pub fn value(&self) -> Option<&Value> {
        self.outcome.as_ref().ok().map(|answer| &answer.value)
    }

    fn fallback(&self) -> Option<Arc<dyn Any + Send + Sync>> {
        match &self.outcome {
            Err(failure) => failure.fallback.clone(),
            Ok(_) => None,
        }
    }
}

impl<T: Clone + 'static> AiTicket<T> {
    /// Whether `result` is this ticket's.
    pub fn is(&self, result: &AiResult) -> bool {
        result.ticket == self.id
    }

    /// This ticket's result read as `T`: None for another ticket's result, the typed answer, or
    /// the failure (an answer that does not read as `T` is `invalid_output`, with the fallback).
    pub fn read(&self, result: &AiResult) -> Option<Result<T, AiFailure>> {
        if !self.is(result) {
            return None;
        }
        Some(match &result.outcome {
            Err(failure) => Err(failure.clone()),
            Ok(answer) => (self.decode)(&answer.value).ok_or_else(|| AiFailure {
                code: AiErrorCode::InvalidOutput,
                site: result.site.clone(),
                retry_after_ms: None,
                fallback: result.fallback(),
            }),
        })
    }

    /// This ticket's answer as `T`, or the fallback when there is none; None for another ticket's
    /// result, or a failure with no fallback.
    pub fn value(&self, result: &AiResult) -> Option<T> {
        match self.read(result)? {
            Ok(value) => Some(value),
            Err(failure) => failure.fallback::<T>(),
        }
    }
}

/// The game's AI as `state().volatile.ai.status` reports it and a HUD shows it: the same for the
/// same seed and steps.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiStatus {
    /// Where lines go.
    pub transport: AiTransport,
    /// Whether the game can run without AI.
    pub requires: AiRequirement,
    /// The studio said AI answers here (`hello`, `doors`, a grant or an answer).
    pub on: bool,
    /// The door AI answers through, when the studio named one.
    pub door: Option<AiDoor>,
    /// Where the game's grant stands, when it holds one.
    pub grant: Option<AiGrantStatus>,
    /// Drains so far.
    pub frame: u64,
    /// Calls made and not yet released by `drain()`.
    pub pending: u64,
    /// Lines the studio has not answered yet.
    pub in_flight: usize,
    /// Calls made.
    pub calls: u64,
    /// Calls answered.
    pub answered: u64,
    /// Failures that played the call's fallback.
    pub fallbacks: u64,
    /// Failures by code.
    pub refused: BTreeMap<String, u64>,
    /// An AI-only game got a failure it has no fallback for: Studio shows its "needs AI" state.
    pub needs_ai: Option<AiErrorCode>,
    /// The game drew [`GameAi::disclosure`].
    pub disclosed: bool,
}

impl AiStatus {
    /// Whether a call is on its way: a HUD's "thinking" mark.
    pub fn thinking(&self) -> bool {
        self.pending > 0
    }
}

/// The HUD chip a game draws once it uses AI.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AiDisclosure {
    /// The chip's words.
    pub text: &'static str,
    /// Where it sits on the screen.
    pub anchor: &'static str,
}

/// The rids this run printed and those the studio answered, newest last: not part of a replay
/// (`state().volatile.ai`), which the studio's conformance suite reads.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct AiEcho {
    /// Rids printed.
    pub asked: Vec<String>,
    /// Rids answered.
    pub answered: Vec<String>,
}

/// Why the studio's AI op was refused (its argument outside the op's shape).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AiOpRefusal {
    /// Not one of [`PlayAiOp`].
    UnknownOp,
    /// No `rid` of the line it answers.
    BadArgs,
}

/// A call waiting for its answer.
struct WaitingCall {
    id: u64,
    site: String,
    op: AiOp,
    wire_ticket: String,
    schema: Option<Value>,
    max_chars: Option<u64>,
    fallback: Option<Arc<dyn Any + Send + Sync>>,
    canceled: bool,
}

/// What one unanswered line was.
enum Line {
    Call(Box<WaitingCall>),
    Hello,
    Doors,
    Grant,
    Other,
}

/// What a game asked, before it is compiled.
struct Asked<'a> {
    op: AiOp,
    site: &'a str,
    max_chars: Option<u64>,
    fallback: Option<Arc<dyn Any + Send + Sync>>,
}

#[derive(Default)]
struct Counters {
    frame: u64,
    calls: u64,
    released: u64,
    answered: u64,
    fallbacks: u64,
    refused: BTreeMap<String, u64>,
}

struct Inner {
    options: AiOptions,
    transport: AiTransport,
    /// Lines this process printed: rids never repeat, so an answer to a line of an earlier run is ignored.
    rids: u64,
    /// Runs this process played: a wire ticket never repeats either.
    run: u64,
    /// Calls this run made.
    tickets: u64,
    waiting: BTreeMap<String, Line>,
    partials: BTreeMap<u64, String>,
    arrived: Vec<AiResult>,
    outbox: Vec<String>,
    echo: AiEcho,
    counters: Counters,
    on: bool,
    door: Option<AiDoor>,
    grant: Option<AiGrant>,
    needs_ai: Option<AiErrorCode>,
    disclosed: bool,
}

/// A game's play-time AI: one per game, held by the runtime (`ctx.ai` in a genex game).
///
/// ```
/// use genex_ai::{Ask, GameAi, AiOptions, AiErrorCode, Schema};
/// use serde::Deserialize;
///
/// #[derive(Clone, Debug, PartialEq, Deserialize, Schema)]
/// #[serde(deny_unknown_fields)]
/// struct Move {
///     /// Where the dot runs.
///     way: Way,
/// }
///
/// #[derive(Clone, Debug, PartialEq, Deserialize, Schema)]
/// #[serde(rename_all = "lowercase")]
/// enum Way { Left, Right }
///
/// let ai = GameAi::new(AiOptions::default());
/// let ticket = ai.ask(Ask::<Move>::new("dot.move", "Pick the way.").fallback(Move { way: Way::Left }));
/// // No studio took the game's AI here: the call fails at once and its fallback plays.
/// for result in ai.drain() {
///     assert_eq!(result.code(), Some(AiErrorCode::Off));
///     assert_eq!(ticket.value(&result), Some(Move { way: Way::Left }));
/// }
/// ```
pub struct GameAi {
    inner: RefCell<Inner>,
}

impl std::fmt::Debug for GameAi {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GameAi").field("status", &self.status()).finish()
    }
}

impl Default for GameAi {
    fn default() -> Self {
        GameAi::new(AiOptions::default())
    }
}

fn shared<T: Send + Sync + 'static>(value: Option<T>) -> Option<Arc<dyn Any + Send + Sync>> {
    value.map(|value| Arc::new(value) as Arc<dyn Any + Send + Sync>)
}

fn remember(list: &mut Vec<String>, rid: &str) {
    list.push(rid.to_owned());
    if list.len() > MAX_ECHO {
        list.remove(0);
    }
}

impl GameAi {
    /// A game's AI, with no studio taking its lines yet: every call fails `ai_off` until the
    /// runtime connects it ([`GameAi::connect`]).
    pub fn new(options: AiOptions) -> GameAi {
        GameAi {
            inner: RefCell::new(Inner {
                options,
                transport: AiTransport::Off,
                rids: 0,
                run: 1,
                tickets: 0,
                waiting: BTreeMap::new(),
                partials: BTreeMap::new(),
                arrived: Vec::new(),
                outbox: Vec::new(),
                echo: AiEcho::default(),
                counters: Counters::default(),
                on: false,
                door: None,
                grant: None,
                needs_ai: None,
                disclosed: false,
            }),
        }
    }

    // ── what a game calls ─────────────────────────────────────────────────────────────────

    /// JSON that fits `T`'s schema. Answers the call's ticket at once; the result arrives
    /// through [`GameAi::drain`].
    pub fn ask<T: DeserializeOwned + Clone + Send + Sync + 'static>(&self, request: Ask<T>) -> AiTicket<T> {
        let asked = Asked {
            op: AiOp::Ask,
            site: &request.base.site,
            max_chars: None,
            fallback: shared(request.fallback.clone()),
        };
        self.call(asked, decode_serde::<T>, |context| {
            compile::ask(&request.base, &request.prompt, &request.schema, context)
        })
    }

    /// Free text, streamed: [`GameAi::partial`] holds what has arrived so far.
    pub fn say(&self, request: Say) -> AiTicket<String> {
        let asked = Asked {
            op: AiOp::Say,
            site: &request.base.site,
            max_chars: request.max_chars,
            fallback: shared(request.fallback.clone()),
        };
        self.call(asked, decode_text, |context| {
            compile::say(&request.base, &request.prompt, request.max_chars, context)
        })
    }

    /// A classification of a state against fixed questions.
    pub fn judge(&self, request: Judge) -> AiTicket<Judgement> {
        let asked = Asked {
            op: AiOp::Judge,
            site: &request.base.site,
            max_chars: None,
            fallback: shared(request.fallback.clone()),
        };
        self.call(asked, decode_judgement, |context| {
            compile::judge(&request.base, &request.questions, &request.state, request.prompt.as_deref(), context)
        })
    }

    /// One tool of `T`'s set, picked and filled.
    pub fn act<T: ToolSet + Clone + Send + Sync + 'static>(&self, request: Act<T>) -> AiTicket<T> {
        let asked = Asked {
            op: AiOp::Act,
            site: &request.base.site,
            max_chars: None,
            fallback: shared(request.fallback.clone()),
        };
        self.call(asked, decode_pick::<T>, |context| {
            compile::act(&request.base, &request.prompt, &request.tools, context)
        })
    }

    /// Stop waiting for a call: its result arrives once, as `canceled`, with no fallback. False
    /// once its result has arrived.
    pub fn cancel<T>(&self, ticket: &AiTicket<T>) -> bool {
        let mut inner = self.inner.borrow_mut();
        let Some(call) = inner.waiting.values_mut().find_map(|line| match line {
            Line::Call(call) if call.id == ticket.id && !call.canceled => Some(call),
            _ => None,
        }) else {
            return false;
        };
        call.canceled = true;
        let (id, site, op, wire_ticket) = (call.id, call.site.clone(), call.op, call.wire_ticket.clone());
        inner.partials.remove(&id);
        inner.settle(id, &site, op, None, AiErrorCode::Canceled, None);
        let mut body = Map::new();
        body.insert("ticket".to_owned(), Value::from(wire_ticket));
        inner.send(AiBridgeOp::Cancel, Value::Object(body), Line::Other);
        true
    }

    /// The results that arrived since the last drain, oldest first. Call it once per fixed step,
    /// before anything reads them: it is the only way answers enter the game.
    pub fn drain(&self) -> Vec<AiResult> {
        let mut inner = self.inner.borrow_mut();
        inner.counters.frame += 1;
        let frame = inner.counters.frame;
        let mut results = std::mem::take(&mut inner.arrived);
        for result in &mut results {
            result.frame = frame;
        }
        inner.counters.released += results.len() as u64;
        results
    }

    /// A streamed `say`'s text so far; None before any arrives and once its result did.
    pub fn partial<T>(&self, ticket: &AiTicket<T>) -> Option<String> {
        self.inner.borrow().partials.get(&ticket.id).cloned()
    }

    /// Ask whether AI runs for this game here ([`AiStatus::on`] follows the answer).
    pub fn hello(&self) {
        self.inner.borrow_mut().send(AiBridgeOp::Hello, Value::Null, Line::Hello);
    }

    /// Ask which door AI answers through ([`AiStatus::door`] follows the answer).
    pub fn doors(&self) {
        self.inner.borrow_mut().send(AiBridgeOp::Doors, Value::Null, Line::Doors);
    }

    /// Ask for the grant the person already gave this game, so a reload never asks again.
    pub fn active_budget(&self) {
        self.inner.borrow_mut().send(AiBridgeOp::BudgetActive, Value::Null, Line::Grant);
    }

    /// Start AI for this game, from a player's action: Genex picks the model and asks the person
    /// only before their plan or their credits are used. `tiers` are the tiers its calls use
    /// (`fast` when none is named); [`GameAi::grant`] follows the answer.
    pub fn start(&self, tiers: &[AiTier]) {
        let mut asked: Vec<AiTier> = Vec::new();
        for tier in tiers {
            if !asked.contains(tier) {
                asked.push(*tier);
            }
        }
        if asked.is_empty() {
            asked.push(AiTier::Fast);
        }
        let mut inner = self.inner.borrow_mut();
        let mut body = Map::new();
        body.insert("v".to_owned(), Value::from(GAME_AI_WIRE_VERSION));
        body.insert("requires".to_owned(), Value::from(inner.options.requires.wire()));
        body.insert("tiers".to_owned(), Value::Array(asked.iter().map(|tier| Value::from(tier.wire())).collect()));
        inner.send(AiBridgeOp::BudgetRequest, Value::Object(body), Line::Grant);
    }

    /// The game turns its own AI off.
    pub fn stop(&self) {
        let mut inner = self.inner.borrow_mut();
        inner.grant = None;
        inner.send(AiBridgeOp::BudgetStop, Value::Null, Line::Other);
    }

    /// The grant the game holds, as a game may see it.
    pub fn grant(&self) -> Option<AiGrant> {
        self.inner.borrow().grant.clone()
    }

    /// Where the game's AI stands, for a HUD or the game's state.
    pub fn status(&self) -> AiStatus {
        let inner = self.inner.borrow();
        let counters = &inner.counters;
        AiStatus {
            transport: inner.transport,
            requires: inner.options.requires,
            on: inner.on,
            door: inner.door,
            grant: inner.grant.as_ref().map(|grant| grant.status),
            frame: counters.frame,
            pending: counters.calls.saturating_sub(counters.released),
            in_flight: inner.waiting.len(),
            calls: counters.calls,
            answered: counters.answered,
            fallbacks: counters.fallbacks,
            refused: counters.refused.clone(),
            needs_ai: inner.needs_ai,
            disclosed: inner.disclosed,
        }
    }

    /// The "AI-generated" chip a game draws once it uses AI; asking for it marks it shown.
    pub fn disclosure(&self) -> AiDisclosure {
        self.inner.borrow_mut().disclosed = true;
        AiDisclosure { text: DISCLOSURE_TEXT, anchor: DISCLOSURE_ANCHOR }
    }

    // ── what the runtime calls (host glue) ────────────────────────────────────────────────

    /// The studio took the game's `capabilities.ai`: lines go out from now on.
    pub fn connect(&self) {
        self.inner.borrow_mut().transport = AiTransport::Protocol;
    }

    /// The studio is gone: every line still waiting is answered `ai_off`, and later calls fail at once.
    pub fn disconnect(&self) {
        let mut inner = self.inner.borrow_mut();
        inner.transport = AiTransport::Off;
        let waiting = std::mem::take(&mut inner.waiting);
        for line in waiting.into_values() {
            if let Line::Call(call) = line
                && !call.canceled
            {
                inner.partials.remove(&call.id);
                inner.settle(call.id, &call.site, call.op, call.fallback, AiErrorCode::Off, None);
            }
        }
        inner.on = false;
        inner.outbox.clear();
    }

    /// The studio reset the game: every line of the run before is forgotten (a late answer to one
    /// is ignored), nothing waits, and the run's counters, tickets and status start again.
    pub fn forget_run(&self) {
        let mut inner = self.inner.borrow_mut();
        inner.waiting.clear();
        inner.partials.clear();
        inner.arrived.clear();
        inner.outbox.clear();
        inner.echo = AiEcho::default();
        inner.counters = Counters::default();
        inner.run += 1;
        inner.tickets = 0;
        inner.on = false;
        inner.door = None;
        inner.grant = None;
        inner.needs_ai = None;
        inner.disclosed = false;
    }

    /// The `ai` lines printed since the last call, oldest first, each one JSON line without its
    /// newline: the runtime writes them to the studio before its next reply.
    pub fn take_lines(&self) -> Vec<String> {
        std::mem::take(&mut self.inner.borrow_mut().outbox)
    }

    /// One of the studio's AI ops (`ai.reply {rid, reply}`, `ai.delta {rid, text}`): true when it
    /// answered a line still waiting; a late, unknown or malformed answer is taken and ignored.
    pub fn take_studio_op(&self, op: &str, args: &Value) -> Result<bool, AiOpRefusal> {
        let op = PlayAiOp::from_wire(op).ok_or(AiOpRefusal::UnknownOp)?;
        let rid = args.get("rid").and_then(Value::as_str).ok_or(AiOpRefusal::BadArgs)?;
        let mut inner = self.inner.borrow_mut();
        Ok(match op {
            PlayAiOp::Reply => inner.take_reply(rid, args.get("reply").unwrap_or(&Value::Null)),
            PlayAiOp::Delta => inner.take_delta(rid, args.get("text")),
        })
    }

    /// The rids printed and answered this run.
    pub fn echo(&self) -> AiEcho {
        self.inner.borrow().echo.clone()
    }

    /// `state().volatile.ai`: the echo and the status.
    pub fn state_value(&self) -> Value {
        let echo = self.echo();
        let mut state = Map::new();
        state.insert("asked".to_owned(), Value::from(echo.asked));
        state.insert("answered".to_owned(), Value::from(echo.answered));
        state.insert("status".to_owned(), serde_json::to_value(self.status()).unwrap_or(Value::Null));
        Value::Object(state)
    }

    fn call<T>(
        &self,
        asked: Asked<'_>,
        decode: fn(&Value) -> Option<T>,
        compile: impl FnOnce(&Context<'_>) -> Result<Compiled, AiErrorCode>,
    ) -> AiTicket<T> {
        let mut inner = self.inner.borrow_mut();
        inner.tickets += 1;
        inner.counters.calls += 1;
        let id = inner.tickets;
        let wire_ticket = format!("rstk-{:08}-{:08}", inner.run, id);
        let grant_id = inner.grant.as_ref().map_or(NO_GRANT.to_owned(), |grant| grant.id.clone());
        let sites = inner.options.sites.clone();
        let context = Context { ticket: &wire_ticket, grant_id: &grant_id, sites: sites.as_deref() };
        let ticket = AiTicket { id, site: asked.site.to_owned(), decode, kind: PhantomData };
        match compile(&context) {
            Err(code) => inner.settle(id, asked.site, asked.op, asked.fallback, code, None),
            Ok(compiled) => {
                let call = WaitingCall {
                    id,
                    site: asked.site.to_owned(),
                    op: asked.op,
                    wire_ticket: wire_ticket.clone(),
                    schema: compiled.schema,
                    max_chars: asked.max_chars,
                    fallback: asked.fallback,
                    canceled: false,
                };
                inner.send(AiBridgeOp::Call, compiled.wire, Line::Call(Box::new(call)));
            }
        }
        ticket
    }
}

impl Inner {
    /// A call's failure, released by the next drain.
    fn settle(
        &mut self,
        id: u64,
        site: &str,
        op: AiOp,
        fallback: Option<Arc<dyn Any + Send + Sync>>,
        code: AiErrorCode,
        retry_after_ms: Option<u64>,
    ) {
        if code == AiErrorCode::Off {
            self.on = false;
        }
        *self.counters.refused.entry(code.wire().to_owned()).or_default() += 1;
        if fallback.is_some() {
            self.counters.fallbacks += 1;
        } else if self.options.requires == AiRequirement::Ai && code != AiErrorCode::Canceled {
            self.needs_ai = Some(code);
        }
        let failure = AiFailure { code, site: site.to_owned(), retry_after_ms, fallback };
        self.arrived.push(AiResult { ticket: id, site: site.to_owned(), op, frame: 0, outcome: Err(failure) });
    }

    /// A line the studio never gets: a call's result arrives in the next drain, as any other.
    fn unsent(&mut self, line: Line, code: AiErrorCode) {
        match line {
            Line::Call(call) => self.settle(call.id, &call.site, call.op, call.fallback, code, None),
            Line::Hello | Line::Doors | Line::Grant if code == AiErrorCode::Off => self.on = false,
            Line::Hello | Line::Doors | Line::Grant | Line::Other => {}
        }
    }

    /// Print one line, or answer it here when no studio takes it, the studio holds as many as it
    /// takes, or the line is longer than it reads.
    fn send(&mut self, op: AiBridgeOp, body: Value, line: Line) {
        if self.transport == AiTransport::Off {
            return self.unsent(line, AiErrorCode::Off);
        }
        if self.waiting.len() >= PLAY_AI_MAX_IN_FLIGHT {
            return self.unsent(line, AiErrorCode::Concurrency);
        }
        let rid = format!("rsai-{:08}", self.rids + 1);
        let mut printed = Map::new();
        printed.insert("event".to_owned(), Value::from(PLAY_EVENT_AI));
        printed.insert("rid".to_owned(), Value::from(rid.as_str()));
        printed.insert("op".to_owned(), Value::from(op.wire()));
        printed.insert("body".to_owned(), body);
        let text = js_json(&Value::Object(printed));
        if utf16_len(&text) > PLAY_AI_MAX_LINE_CHARS {
            return self.unsent(line, AiErrorCode::TooLarge);
        }
        self.rids += 1;
        remember(&mut self.echo.asked, &rid);
        self.waiting.insert(rid, line);
        self.outbox.push(text);
    }

    fn take_reply(&mut self, rid: &str, reply: &Value) -> bool {
        let Some(line) = self.waiting.remove(rid) else { return false };
        remember(&mut self.echo.answered, rid);
        match line {
            Line::Call(call) => self.answer_call(*call, reply),
            Line::Hello => self.on = answers::hello_answer(reply),
            Line::Doors => (self.on, self.door) = answers::doors_answer(reply),
            Line::Grant => {
                let answer = answers::grant_answer(reply);
                self.on = answer.view.is_some();
                self.grant = answer.view;
            }
            Line::Other => {}
        }
        true
    }

    fn answer_call(&mut self, call: WaitingCall, reply: &Value) {
        self.partials.remove(&call.id);
        if call.canceled {
            return;
        }
        let answered = match answers::call_answer(reply, &call.wire_ticket) {
            CallAnswer::Refused { code, retry_after_ms } => Err((code, retry_after_ms)),
            CallAnswer::Answered { value, source, provenance, cached } => checked(&call, value)
                .map(|value| AiAnswer { value, source, provenance, cached })
                .ok_or((AiErrorCode::InvalidOutput, None)),
        };
        match answered {
            Err((code, retry_after_ms)) => {
                self.settle(call.id, &call.site, call.op, call.fallback, code, retry_after_ms)
            }
            Ok(answer) => {
                self.on = true;
                self.needs_ai = None;
                self.counters.answered += 1;
                self.arrived.push(AiResult {
                    ticket: call.id,
                    site: call.site,
                    op: call.op,
                    frame: 0,
                    outcome: Ok(answer),
                });
            }
        }
    }

    fn take_delta(&mut self, rid: &str, text: Option<&Value>) -> bool {
        let Some(Line::Call(call)) = self.waiting.get(rid) else { return false };
        let Some(text) = text.and_then(Value::as_str) else { return false };
        if call.op != AiOp::Say || call.canceled || text.len() > AI_MAX_OUTPUT_BYTES {
            return false;
        }
        let id = call.id;
        let kept = compile::cut_to(text, call.max_chars);
        self.partials.insert(id, kept);
        true
    }
}

/// An answer held to its call's schema again (the studio checked it; the game does not rely on
/// that): a `say` answer is text with words, cut to the call's `max_chars`.
fn checked(call: &WaitingCall, value: Value) -> Option<Value> {
    if !validate_value(call.schema.as_ref(), &value) {
        return None;
    }
    match (&value, call.op) {
        (Value::String(text), AiOp::Say) => Some(Value::from(compile::cut_to(text, call.max_chars))),
        _ => Some(value),
    }
}
