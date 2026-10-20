//! Play-time AI for a genex game (docs/play-protocol.md, "Play-time AI"): the game asks a model
//! for text, or for JSON that fits a Rust type, and Genex answers on the model the person chose.
//!
//! - [`GameAi::ask`], [`GameAi::say`], [`GameAi::judge`] and [`GameAi::act`] answer their
//!   [`AiTicket`] at once. Each prints one `ai` line for the studio,
//!   `{"event":"ai","rid":…,"op":"call","body":<AiCallRequest>}`, byte for byte the call a web
//!   game's `genex-ai` would carry (`tests/fixtures/play-ai-wire-v1.json` holds both sides to it).
//! - The studio answers each line once with its op `ai.reply {rid, reply}` (a `say` streams
//!   `ai.delta {rid, text}` first). The answer enters the game only through [`GameAi::drain`],
//!   called once per fixed step: an [`AiResult`] holds the answer or an [`AiFailure`] with its
//!   typed [`AiErrorCode`] and the fallback the call named. Answers are data: clamp them before
//!   they change the world.
//! - Nothing here reaches a model vendor, opens a socket or reads a clock: the studio's broker
//!   picks the door, holds the money and replays saved playtests to the same step boundaries, so
//!   the same seed and inputs get the same answers on the same ticks.
//! - Player-typed text never goes in a prompt: pass it with `.untrusted(name, text)`, which every
//!   model sees fenced as the player's words.
//! - With no studio taking the game's lines (an export, a web build, a studio that did not take
//!   `capabilities.ai`), every call fails `ai_off` at once and the game plays its fallbacks.
//!
//! `#[derive(Schema)]` describes a type in the closed dialect an answer is held to; the type also
//! derives serde's `Deserialize` with `#[serde(deny_unknown_fields)]`, so a value the dialect
//! passed reads into it. An enum whose variants carry doc comments is a [`ToolSet`] for `act`.

// The derive's code names this crate `genex_ai`, as a game does.
extern crate self as genex_ai;

mod answers;
mod compile;
mod game;
pub mod json;
mod prompts;
mod requests;
pub mod schema;
pub mod wire;

#[cfg(test)]
mod conformance;

pub use answers::AiGrant;
pub use compile::{Question, Tool};
pub use game::{AiAnswer, AiDisclosure, AiEcho, AiFailure, AiOpRefusal, AiOptions, AiResult, AiStatus, GameAi};
pub use genex_ai_derive::Schema;
pub use prompts::{CHOICE_ANSWER_WORDS, JUDGE_SYSTEM};
pub use requests::{Act, AiTicket, Ask, Judge, Judgement, Say, ToolSet, decode_tool};
pub use schema::{Schema, SchemaNode};
/// What the derive's code names; not part of the API.
#[doc(hidden)]
pub mod __private {
    pub use serde_json::Value;
}

pub use wire::{
    AiAuthority, AiBridgeOp, AiDoor, AiErrorCode, AiGrantStatus, AiOp, AiProvenance, AiRequirement, AiSchemaProblem,
    AiSchemaType, AiSource, AiTier, AiTransport, PlayAiOp,
};
