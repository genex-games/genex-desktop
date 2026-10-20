//! The wire a game and the studio share for play-time AI: the vocabularies of `src/shared/game-ai.ts`,
//! `game-ai-schema.ts` and `play-protocol.ts` in their exact spellings, and the limits main's
//! readers hold every message to. `tests/fixtures/play-ai-wire-v1.json` (generated from the
//! TypeScript) holds both sides to the same values; `conformance.rs` replays it.

/// A vocabulary: its values in declaration order, each value's wire spelling, and the value a
/// spelling names.
macro_rules! vocabulary {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum $name {
            $($(#[$vmeta])* $variant,)+
        }

        impl $name {
            /// Every value, in the TypeScript vocabulary's order.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The wire spelling.
            pub const fn wire(self) -> &'static str {
                match self {
                    $($name::$variant => $wire,)+
                }
            }

            /// The value `wire` spells, or None for any other text.
            pub fn from_wire(wire: &str) -> Option<$name> {
                match wire {
                    $($wire => Some($name::$variant),)+
                    _ => None,
                }
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(self.wire())
            }
        }
    };
}

vocabulary! {
    /// What a game asks of a model.
    AiOp {
        /// Structured output: JSON that fits the call's schema.
        Ask => "ask",
        /// Free text, streamed.
        Say => "say",
        /// Classify a state against fixed questions (JSON).
        Judge => "judge",
        /// Pick one tool of a fixed set (JSON).
        Act => "act",
    }
}

vocabulary! {
    /// The messages a game's AI lines carry (`AiBridgeOp`).
    AiBridgeOp {
        /// Whether AI can run for this game here at all.
        Hello => "hello",
        /// The pill's state for the game: is AI on, and on which door.
        Doors => "doors",
        /// One call.
        Call => "call",
        /// Stop waiting for a call.
        Cancel => "cancel",
        /// The grant this game already holds.
        BudgetActive => "budget.active",
        /// Start AI for this game, from a player's action.
        BudgetRequest => "budget.request",
        /// The game turns its own AI off.
        BudgetStop => "budget.stop",
    }
}

vocabulary! {
    /// How capable a model a call needs.
    AiTier {
        /// A quick model.
        Fast => "fast",
        /// A more capable model.
        Smart => "smart",
    }
}

vocabulary! {
    /// Whether an answer stays with this player or reaches other players.
    AiAuthority {
        /// Only this player sees it.
        Local => "local",
        /// Other players see it, or a leaderboard counts it: only Genex credits answer it.
        Shared => "shared",
    }
}

vocabulary! {
    /// Whether the game can run without AI.
    AiRequirement {
        /// The game means nothing without a model.
        Ai => "ai",
        /// The game plays on with its fallbacks.
        Optional => "optional",
    }
}

vocabulary! {
    /// Where a call's tokens come from.
    AiDoor {
        /// A model on this machine.
        Local => "local",
        /// OpenCode.
        OpenCode => "opencode",
        /// The person's own OpenRouter key.
        Byok => "byok",
        /// The person's Claude plan, in Create on their own game only.
        Plan => "plan",
        /// The person's plan, answered by this machine's watcher.
        PlanWatcher => "plan-watcher",
        /// The player's Genex credits.
        GenexCredits => "genex-credits",
        /// The creator's Genex credits on the development lane.
        GenexDev => "genex-dev",
        /// A saved playtest replayed.
        Tape => "tape",
        /// A test fixture's answer.
        Fixture => "fixture",
    }
}

vocabulary! {
    /// Where an answer came from: a door, or a platform answer the server marks external.
    AiSource {
        /// A model on this machine.
        Local => "local",
        /// OpenCode.
        OpenCode => "opencode",
        /// The person's own OpenRouter key.
        Byok => "byok",
        /// The person's Claude plan.
        Plan => "plan",
        /// The person's plan, answered by this machine's watcher.
        PlanWatcher => "plan-watcher",
        /// The player's Genex credits.
        GenexCredits => "genex-credits",
        /// The creator's Genex credits on the development lane.
        GenexDev => "genex-dev",
        /// A saved playtest replayed.
        Tape => "tape",
        /// A test fixture's answer.
        Fixture => "fixture",
        /// A platform answer from outside Genex's own dispatch.
        External => "external",
    }
}

vocabulary! {
    /// How far an answer can be trusted.
    AiProvenance {
        /// Genex dispatched and billed it: it may decide a leaderboard, a reward or shared state.
        Verified => "verified",
        /// A model the person runs or pays for themselves: it decides only their own game.
        Unverified => "unverified",
        /// A saved playtest.
        Replay => "replay",
        /// A test fixture.
        Fixture => "fixture",
    }
}

vocabulary! {
    /// Why a call got no answer (`AiErrorCode`).
    AiErrorCode {
        /// AI is off for this game, everywhere, or in this context.
        Off => "ai_off",
        /// Replaying, and the saved playtest has no answer for this call.
        Unrecorded => "ai_unrecorded",
        /// The game called an AI vendor directly.
        DirectBlocked => "ai_direct_blocked",
        /// The request is not one a model can be asked.
        BadRequest => "bad_request",
        /// The prompt, a player's field, the schema or the line is over its cap.
        TooLarge => "prompt_too_large",
        /// The schema is outside the closed dialect.
        InvalidSchema => "invalid_schema",
        /// The answer did not fit the game's shape, after the one repair. Never charged.
        InvalidOutput => "invalid_output",
        /// The game has no grant yet.
        ConsentRequired => "consent_required",
        /// The person said no.
        ConsentDeclined => "consent_declined",
        /// The person has not answered yet.
        ConsentPending => "consent_pending",
        /// A grant was asked for outside a person's gesture.
        NoGesture => "no_gesture",
        /// The game waits for the person.
        Paused => "ai_paused",
        /// Too many calls at once.
        Concurrency => "grant_concurrency",
        /// Too many calls too quickly.
        RateLimited => "grant_rate_limited",
        /// The person's plan rests until its window resets.
        WaitingForPlan => "waiting_for_plan",
        /// The door is down.
        DoorUnavailable => "door_unavailable",
        /// The local model is still loading.
        LocalLoading => "local_model_loading",
        /// The grant's door may not be used in this context.
        NoFunding => "no_funding",
        /// The grant's door is answered by genex.games.
        PlatformDoor => "platform_door",
        /// A leaderboard or shared answer needs a verified door.
        NeedsVerified => "needs_verified",
        /// The plan door is not allowed here.
        PlanNotAllowed => "plan_door_not_allowed",
        /// The balance cannot pay.
        OutOfCredits => "insufficient_credits",
        /// The person's own key reached its monthly limit.
        MonthlyLimit => "monthly_limit",
        /// Text other players would see was refused by moderation.
        Moderated => "moderated",
        /// The model took too long.
        Timeout => "timeout",
        /// The provider failed.
        Provider => "provider",
        /// The call was canceled.
        Canceled => "canceled",
    }
}

vocabulary! {
    /// Where a game's grant stands.
    AiGrantStatus {
        /// It answers calls.
        Active => "active",
        /// Its plan rests until its window resets.
        WaitingForPlan => "waiting_for_plan",
        /// Held until the person says go on.
        Paused => "paused",
        /// The person turned AI off for the game.
        Off => "off",
        /// Another model took its place.
        Replaced => "replaced",
    }
}

vocabulary! {
    /// The value types of the closed schema dialect.
    AiSchemaType {
        /// A closed object.
        Object => "object",
        /// A list of one item schema.
        Array => "array",
        /// Text.
        String => "string",
        /// A finite number.
        Number => "number",
        /// A safe integer.
        Integer => "integer",
        /// `true` or `false`.
        Boolean => "boolean",
        /// `null`.
        Null => "null",
    }
}

vocabulary! {
    /// Why a schema is refused (`AiSchemaProblem`).
    AiSchemaProblem {
        /// The schema (or a child) is not an object.
        NotObject => "not-object",
        /// It nests deeper than [`AI_SCHEMA_MAX_DEPTH`].
        TooDeep => "too-deep",
        /// Its `type` is not one of [`AiSchemaType`].
        UnknownType => "unknown-type",
        /// A keyword outside the dialect.
        UnknownKeyword => "unknown-keyword",
        /// A `description` or `title` of the wrong type or length.
        BadAnnotation => "bad-annotation",
        /// An enum that is empty, too long or not all scalars.
        BadEnum => "bad-enum",
        /// An object without closed `properties`, or with too many.
        ObjectShape => "object-shape",
        /// A property name too long or reserved.
        BadPropertyName => "bad-property-name",
        /// `required` names a property the object lacks.
        BadRequired => "bad-required",
        /// A keyword on a type that does not take it.
        MisplacedKeyword => "misplaced-keyword",
        /// A bound that is not a finite (whole, where it counts) number, or a min over its max.
        BadBound => "bad-bound",
    }
}

vocabulary! {
    /// How a judge question is answered.
    AiJudgeKind {
        /// A probability from 0 to 1 that the answer is yes.
        YesNo => "yes-no",
        /// The name of one of the question's options.
        Choice => "choice",
        /// A level from 0 to the number of levels less one.
        Score => "score",
    }
}

vocabulary! {
    /// The studio's AI ops, sent only to a game whose `capabilities.ai` it took.
    PlayAiOp {
        /// The answer to one of the game's `ai` lines, by its rid.
        Reply => "ai.reply",
        /// A streamed `say` answer's text so far.
        Delta => "ai.delta",
    }
}

vocabulary! {
    /// Where a game's lines go: to the studio over its protocol, or nowhere (fallbacks play).
    AiTransport {
        /// The studio took the game's `capabilities.ai`: lines go out and answers come back.
        Protocol => "protocol",
        /// No studio takes the lines: every call answers `ai_off` at once.
        Off => "off",
    }
}

/// The `event` of a game's AI line.
pub const PLAY_EVENT_AI: &str = "ai";
/// The wire version of every call, answer and grant message.
pub const GAME_AI_WIRE_VERSION: u32 = 1;
/// A call's prompt, system and memory together, in UTF-8 bytes.
pub const AI_MAX_PROMPT_BYTES: usize = 128 * 1024;
/// A call's schema, serialized, in UTF-8 bytes.
pub const AI_MAX_SCHEMA_BYTES: usize = 16 * 1024;
/// One player-typed field, in UTF-8 bytes.
pub const AI_MAX_UNTRUSTED_BYTES: usize = 8 * 1024;
/// How many player-typed fields one call may carry.
pub const AI_MAX_UNTRUSTED_FIELDS: usize = 16;
/// The output budget of a call that names none.
pub const AI_DEFAULT_OUTPUT_TOKENS: u32 = 512;
/// The most output tokens one call may ask for.
pub const AI_MAX_OUTPUT_TOKENS: u32 = 32_768;
/// The answer, JSON-encoded, in UTF-8 bytes.
pub const AI_MAX_OUTPUT_BYTES: usize = 256 * 1024;
/// The most characters (UTF-16 units) one message from a game may carry in all.
pub const AI_MAX_BODY_CHARS: usize = 200 * 1024;
/// The most JSON nodes one message from a game may hold.
pub const AI_MAX_WALK_NODES: usize = 8192;
/// The deepest one message from a game may nest.
pub const AI_MAX_WALK_DEPTH: usize = 16;
/// The deepest a schema nests.
pub const AI_SCHEMA_MAX_DEPTH: usize = 5;
/// The most properties one object schema lists.
pub const AI_SCHEMA_MAX_PROPERTIES: usize = 32;
/// The most values one enum lists.
pub const AI_SCHEMA_MAX_ENUM: usize = 32;
/// The longest property name, in UTF-16 units.
pub const AI_SCHEMA_MAX_KEY_CHARS: usize = 80;
/// The longest `description` annotation, in UTF-16 units.
pub const AI_SCHEMA_MAX_DESCRIPTION: usize = 500;
/// The longest `title` annotation, in UTF-16 units.
pub const AI_SCHEMA_MAX_TITLE: usize = 100;
/// The most items an array bound may name.
pub const AI_SCHEMA_MAX_ITEMS_BOUND: u64 = 65_536;
/// The most nodes an answer may hold.
pub const AI_MAX_JSON_NODES: usize = 32_768;
/// The deepest an answer may nest.
pub const AI_MAX_JSON_DEPTH: usize = 32;
/// The most items an array answer holds when its schema names no `maxItems`.
pub const AI_MAX_JSON_ARRAY_ITEMS: u64 = 256;
/// The longest string a schema may bound, or an answer's string may reach when its schema names none.
pub const AI_SCHEMA_MAX_STRING: u64 = 262_144;
/// The longest `ai` line the studio reads from a game, in characters (UTF-16 units).
pub const PLAY_AI_MAX_LINE_CHARS: usize = AI_MAX_BODY_CHARS;
/// The most `ai` lines of one game the studio holds unanswered.
pub const PLAY_AI_MAX_IN_FLIGHT: usize = 4;
/// The most questions one judge call asks.
pub const JUDGE_MAX_QUESTIONS: usize = 32;
/// The longest instructions, option or level text, in UTF-16 units.
pub const JUDGE_MAX_TEXT: usize = 2000;
/// The longest option name, in UTF-16 units.
pub const JUDGE_MAX_OPTION_CHARS: usize = 80;
/// The fewest and most options a choice question names.
pub const JUDGE_CHOICE_OPTIONS: (usize, usize) = (2, 32);
/// The fewest and most levels a score question names.
pub const JUDGE_SCORE_LEVELS: (usize, usize) = (2, 10);
/// The largest judge state, as canonical JSON, in UTF-8 bytes (and in UTF-16 units of its strings).
pub const JUDGE_MAX_STATE_BYTES: usize = 96 * 1024;
/// The most tools one act call offers.
pub const ACT_MAX_TOOLS: usize = 31;
/// The longest tool description, in UTF-16 units.
pub const ACT_MAX_DESCRIPTION: usize = 500;
/// The property an act answer names its tool in.
pub const ACT_TOOL_KEY: &str = "tool";

/// Whether `text` is a call site's name (`AI_SITE_RE`, `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`): the
/// tape key, the bench row, and the shape of a player-typed field's name.
pub fn is_site(text: &str) -> bool {
    let bytes = text.as_bytes();
    let tail = |byte: &u8| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b'-');
    matches!(bytes.first(), Some(first) if first.is_ascii_alphabetic())
        && bytes.len() <= 64
        && bytes[1..].iter().all(tail)
}

/// Whether `text` is a ticket, a grant id or a rid (`AI_ID_RE`, `^[A-Za-z0-9_-]{8,100}$`).
pub fn is_id(text: &str) -> bool {
    let bytes = text.as_bytes();
    (8..=100).contains(&bytes.len())
        && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Whether `text` is a judge question's or a tool's name (`AI_NAME_RE`, `^[A-Za-z][A-Za-z0-9_]{0,63}$`).
pub fn is_name(text: &str) -> bool {
    let bytes = text.as_bytes();
    let tail = |byte: &u8| byte.is_ascii_alphanumeric() || *byte == b'_';
    matches!(bytes.first(), Some(first) if first.is_ascii_alphabetic())
        && bytes.len() <= 64
        && bytes[1..].iter().all(tail)
}
