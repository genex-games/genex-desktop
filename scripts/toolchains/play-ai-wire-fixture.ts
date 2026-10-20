/**
 * Writes or checks `tests/fixtures/play-ai-wire-v1.json`, the play-time AI wire both sides hold:
 * the vocabularies and limits of `src/shared/game-ai.ts`, `game-ai-schema.ts` and
 * `play-protocol.ts`, the calls `src/page/ai/compile.ts` compiles (each with the exact `ai` line a
 * native game prints for it), schema and answer verdicts, canonical JSON and the answers the
 * studio sends back. The Rust `genex-ai` crate replays every row (`src/conformance.rs`), so a Rust
 * game sends byte for byte the line a web game's call would carry.
 *
 *   node scripts/toolchains/play-ai-wire-fixture.ts write [--from <checkout>]
 *   node scripts/toolchains/play-ai-wire-fixture.ts check [--from <checkout>]
 *
 * `--from` names the checkout whose TypeScript is the source of truth (default: this one); the
 * modules are loaded by path, so the script runs on any checkout that has them. `check` writes
 * nothing and exits 1 when the committed fixture differs from what the modules give now.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const REPO = fileURLToPath(new URL("../..", import.meta.url));
const FIXTURE = path.join(REPO, "tests", "fixtures", "play-ai-wire-v1.json");
/** The rid every compiled call's line is printed under. */
const LINE_RID = "rsai-00000001";
/** The ticket and grant every compiled call carries. */
const CONTEXT = { ticket: "rstk-00000001-00000001", grantId: "no-grant" } as const;

/** A vocabulary module's table: wire values by key. */
type Vocabulary = Readonly<Record<string, string>>;

/** A compile result as `compile.ts` answers it. */
type Compiled = { ok: true; call: { wire: unknown } } | { ok: false; code: string };
type CompileFn = (request: Record<string, unknown>, context: CompileContext) => Compiled;
interface CompileContext {
  ticket: string;
  grantId: string;
  sites: ReadonlySet<string> | null;
}

/** The parts of the TypeScript modules this script reads. */
interface Modules {
  ai: {
    GAME_AI_WIRE_VERSION: number;
    AI_MAX_PROMPT_BYTES: number;
    AI_MAX_SCHEMA_BYTES: number;
    AI_MAX_UNTRUSTED_BYTES: number;
    AI_MAX_UNTRUSTED_FIELDS: number;
    AI_DEFAULT_OUTPUT_TOKENS: number;
    AI_MAX_OUTPUT_TOKENS: number;
    AI_MAX_OUTPUT_BYTES: number;
    AI_MAX_BODY_CHARS: number;
    AI_MAX_WALK_NODES: number;
    AI_MAX_WALK_DEPTH: number;
    AI_SITE_RE: RegExp;
    AI_ID_RE: RegExp;
    AiOp: Vocabulary;
    AiBridgeOp: Vocabulary;
    AiTier: Vocabulary;
    AiAuthority: Vocabulary;
    AiRequirement: Vocabulary;
    AiDoor: Vocabulary;
    AiSource: Vocabulary;
    AiProvenance: Vocabulary;
    AiErrorCode: Vocabulary;
    AiGrantStatus: Vocabulary;
    refusedAnswer: (ticket: string, code: string, retryAfterMs?: number | null) => unknown;
  };
  schema: {
    AI_SCHEMA_MAX_DEPTH: number;
    AI_SCHEMA_MAX_PROPERTIES: number;
    AI_SCHEMA_MAX_ENUM: number;
    AI_SCHEMA_MAX_KEY_CHARS: number;
    AI_SCHEMA_MAX_DESCRIPTION: number;
    AI_SCHEMA_MAX_TITLE: number;
    AI_SCHEMA_MAX_ITEMS_BOUND: number;
    AI_MAX_JSON_NODES: number;
    AI_MAX_JSON_DEPTH: number;
    AI_MAX_JSON_ARRAY_ITEMS: number;
    AI_SCHEMA_MAX_STRING: number;
    AiSchemaType: Vocabulary;
    AiSchemaProblem: Vocabulary;
    checkSchema: (schema: unknown) => string | null;
    validateValue: (schema: unknown, value: unknown) => boolean;
    canonicalJson: (value: unknown) => string;
  };
  play: {
    PLAY_AI_MAX_LINE_CHARS: number;
    PLAY_AI_MAX_IN_FLIGHT: number;
    PlayAiOp: Vocabulary;
    PlayEvent: Vocabulary;
    readPlayAiLine: (value: unknown) => unknown;
  };
  compile: {
    JUDGE_MAX_QUESTIONS: number;
    AI_NAME_RE: RegExp;
    JUDGE_MAX_TEXT: number;
    JUDGE_MAX_OPTION_CHARS: number;
    JUDGE_CHOICE_OPTIONS: { min: number; max: number };
    JUDGE_SCORE_LEVELS: { min: number; max: number };
    JUDGE_MAX_STATE_BYTES: number;
    ACT_MAX_TOOLS: number;
    ACT_MAX_DESCRIPTION: number;
    ACT_TOOL_KEY: string;
    compileAsk: CompileFn;
    compileSay: CompileFn;
    compileJudge: CompileFn;
    compileAct: CompileFn;
  };
  page: { AiJudgeKind: Vocabulary };
}

async function load(from: string): Promise<Modules> {
  const module = (relative: string): Promise<unknown> => import(pathToFileURL(path.join(from, relative)).href);
  const [ai, schema, play, compile, page] = await Promise.all([
    module("src/shared/game-ai.ts"),
    module("src/shared/game-ai-schema.ts"),
    module("src/shared/play-protocol.ts"),
    module("src/page/ai/compile.ts"),
    module("src/page/ai/types.ts"),
  ]);
  // Loaded by path from another checkout: the interface names what this script reads of them.
  return { ai, schema, play, compile, page } as Modules;
}

const values = (vocabulary: Vocabulary): string[] => Object.values(vocabulary);

/** A schema the dialect takes: one move of two. */
const MOVE_SCHEMA = {
  type: "object",
  properties: { move: { type: "string", enum: ["left", "right"] } },
  required: ["move"],
  additionalProperties: false,
};

/** A schema with every keyword the dialect has, nested. */
const TURN_SCHEMA = {
  type: "object",
  title: "Turn",
  description: "One turn's reactions.",
  properties: {
    reactions: {
      type: "array",
      maxItems: 8,
      minItems: 0,
      items: {
        type: "object",
        properties: {
          nation: { type: "string", enum: ["avar", "byz"] },
          stance: { type: "integer", minimum: -3, maximum: 3 },
          weight: { type: "number", minimum: 0, maximum: 1.5 },
          note: { type: "string", maxLength: 120, minLength: 1 },
          final: { type: "boolean" },
          nothing: { type: "null" },
        },
        required: ["nation", "stance"],
        additionalProperties: false,
      },
    },
    headline: { type: "string", maxLength: 160 },
  },
  required: ["reactions", "headline"],
  additionalProperties: false,
};

/** An object schema of 32 properties, each described at the annotation's cap: valid, but over the schema's byte cap. */
function largeSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (let index = 0; index < 32; index += 1)
    properties[`field${index}`] = { type: "string", description: "d".repeat(500) };
  return { type: "object", properties, required: [], additionalProperties: false };
}

/** Text of `units` UTF-16 units. */
const text = (units: number, unit = "a"): string => unit.repeat(units);

/** One compile row: the game's request, and what the page answers it with. */
interface CompileRow {
  name: string;
  op: "ask" | "say" | "judge" | "act";
  request: Record<string, unknown>;
  sites?: string[];
}

const COMPILE_ROWS: CompileRow[] = [
  { name: "ask-minimal", op: "ask", request: { site: "dot.move", prompt: "Pick the way.", schema: MOVE_SCHEMA } },
  {
    name: "ask-every-field",
    op: "ask",
    request: {
      site: "turn.resolve",
      system: "You are the world's chronicler.",
      prompt: "Resolve the turn.",
      untrusted: { order: "Invade the north", motto: 'say "hi"\nthen <<<leave>>>' },
      memory: "Turn 1: peace.",
      tier: "smart",
      authority: "shared",
      maxOutputTokens: 700,
      schema: TURN_SCHEMA,
    },
  },
  {
    name: "ask-unicode-and-escapes",
    op: "ask",
    request: {
      site: "npc.line",
      prompt: "Привет, 🌍! Tab\there, bell\u0007, nul\u0000, del\u007f, line sep, slash / and \\ back",
      untrusted: { name: "Ünïcødé \u001f" },
      schema: { type: "string", maxLength: 40 },
    },
  },
  { name: "ask-bad-site", op: "ask", request: { site: "1bad", prompt: "x", schema: MOVE_SCHEMA } },
  { name: "ask-blank-prompt", op: "ask", request: { site: "dot.move", prompt: "   ", schema: MOVE_SCHEMA } },
  {
    name: "ask-open-object",
    op: "ask",
    request: { site: "dot.move", prompt: "x", schema: { type: "object", properties: {} } },
  },
  {
    name: "ask-too-deep",
    op: "ask",
    request: {
      site: "dot.move",
      prompt: "x",
      schema: {
        type: "array",
        items: {
          type: "array",
          items: {
            type: "array",
            items: { type: "array", items: { type: "array", items: { type: "array", items: { type: "string" } } } },
          },
        },
      },
    },
  },
  {
    name: "ask-untrusted-over-cap",
    op: "ask",
    request: { site: "dot.move", prompt: "x", untrusted: { name: text(8 * 1024 + 1) }, schema: MOVE_SCHEMA },
  },
  {
    name: "ask-untrusted-multibyte-at-cap",
    op: "ask",
    request: { site: "dot.move", prompt: "x", untrusted: { name: text(4096, "é") }, schema: MOVE_SCHEMA },
  },
  {
    name: "ask-untrusted-multibyte-over-cap",
    op: "ask",
    request: { site: "dot.move", prompt: "x", untrusted: { name: text(4097, "é") }, schema: MOVE_SCHEMA },
  },
  {
    name: "ask-too-many-untrusted",
    op: "ask",
    request: {
      site: "dot.move",
      prompt: "x",
      untrusted: Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}`, "v"])),
      schema: MOVE_SCHEMA,
    },
  },
  {
    name: "ask-untrusted-bad-key",
    op: "ask",
    request: { site: "dot.move", prompt: "x", untrusted: { "bad key": "v" }, schema: MOVE_SCHEMA },
  },
  {
    name: "ask-prompt-over-cap",
    op: "ask",
    request: { site: "dot.move", prompt: text(128 * 1024 + 1), schema: MOVE_SCHEMA },
  },
  {
    name: "ask-prompt-system-memory-over-cap-together",
    op: "ask",
    request: {
      site: "dot.move",
      system: text(64 * 1024),
      prompt: text(32 * 1024),
      memory: text(32 * 1024 + 1),
      schema: MOVE_SCHEMA,
    },
  },
  {
    name: "ask-no-output-tokens",
    op: "ask",
    request: { site: "dot.move", prompt: "x", maxOutputTokens: 0, schema: MOVE_SCHEMA },
  },
  {
    name: "ask-output-tokens-over-cap",
    op: "ask",
    request: { site: "dot.move", prompt: "x", maxOutputTokens: 32_769, schema: MOVE_SCHEMA },
  },
  {
    name: "ask-output-tokens-at-cap",
    op: "ask",
    request: { site: "dot.move", prompt: "x", maxOutputTokens: 32_768, schema: MOVE_SCHEMA },
  },
  { name: "ask-schema-over-bytes", op: "ask", request: { site: "dot.move", prompt: "x", schema: largeSchema() } },
  {
    name: "ask-undeclared-site",
    op: "ask",
    request: { site: "dot.other", prompt: "x", schema: MOVE_SCHEMA },
    sites: ["dot.move"],
  },
  {
    name: "ask-declared-site",
    op: "ask",
    request: { site: "dot.move", prompt: "x", schema: MOVE_SCHEMA },
    sites: ["dot.move"],
  },
  { name: "say-minimal", op: "say", request: { site: "npc.greet", prompt: "Greet the player." } },
  { name: "say-max-chars", op: "say", request: { site: "npc.greet", prompt: "Greet.", maxChars: 12 } },
  { name: "say-zero-max-chars", op: "say", request: { site: "npc.greet", prompt: "Greet.", maxChars: 0 } },
  {
    name: "judge-every-kind",
    op: "judge",
    request: {
      site: "turn.judge",
      prompt: "The player gave an order.",
      untrusted: { order: "march" },
      questions: {
        plausible: { kind: "yes-no", instructions: "Could this nation attempt it?" },
        brave: { kind: "yes-no", instructions: "Is it brave?", yes: "a hero would", no: "a coward would" },
        mood: { kind: "choice", instructions: "The court's mood.", options: { calm: "nobody minds", angry: "riots" } },
        risk: { kind: "score", instructions: "How risky?", levels: ["none", "some", "grave"] },
      },
      state: { turn: 3, nations: [{ id: "byz", troops: 1200, ratio: 0.25 }], era: "early", b: null, a: true },
    },
  },
  {
    name: "judge-canonical-numbers",
    op: "judge",
    request: {
      site: "turn.judge",
      questions: { odd: { kind: "yes-no", instructions: "Is it odd?" } },
      state: { z: 1e21, y: 1e-7, x: 0.1, w: -0, v: 123456789012345680000, u: 1.5e-6, t: 2 ** 53, s: [3, 1, 2] },
    },
  },
  {
    name: "judge-no-questions",
    op: "judge",
    request: { site: "turn.judge", questions: {}, state: {} },
  },
  {
    name: "judge-one-option",
    op: "judge",
    request: {
      site: "turn.judge",
      questions: { mood: { kind: "choice", instructions: "Mood.", options: { calm: "calm" } } },
      state: {},
    },
  },
  {
    name: "judge-eleven-levels",
    op: "judge",
    request: {
      site: "turn.judge",
      questions: {
        risk: { kind: "score", instructions: "Risk.", levels: Array.from({ length: 11 }, (_, i) => `l${i}`) },
      },
      state: {},
    },
  },
  {
    name: "judge-bad-question-name",
    op: "judge",
    request: { site: "turn.judge", questions: { "1x": { kind: "yes-no", instructions: "x" } }, state: {} },
  },
  {
    name: "judge-blank-extra-prompt",
    op: "judge",
    request: { site: "turn.judge", prompt: "  ", questions: { a: { kind: "yes-no", instructions: "x" } }, state: {} },
  },
  {
    name: "judge-state-over-cap",
    op: "judge",
    request: {
      site: "turn.judge",
      questions: { a: { kind: "yes-no", instructions: "x" } },
      state: { blob: text(96 * 1024) },
    },
  },
  {
    name: "act-two-tools",
    op: "act",
    request: {
      site: "robot.act",
      system: "You steer a robot.",
      prompt: "The enemy is near.",
      tools: {
        attack: {
          description: "Hit a target.",
          args: {
            type: "object",
            properties: { target: { type: "integer", minimum: 0, maximum: 7 } },
            required: ["target"],
            additionalProperties: false,
          },
        },
        flee: {
          description: "Run away.",
          args: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
      },
    },
  },
  {
    name: "act-tool-named-tool",
    op: "act",
    request: {
      site: "robot.act",
      prompt: "x",
      tools: { tool: { description: "x", args: { type: "string" } } },
    },
  },
  {
    name: "act-too-many-tools",
    op: "act",
    request: {
      site: "robot.act",
      prompt: "x",
      tools: Object.fromEntries(
        Array.from({ length: 32 }, (_, index) => [`t${index}`, { description: "x", args: { type: "null" } }]),
      ),
    },
  },
  {
    name: "act-blank-description",
    op: "act",
    request: { site: "robot.act", prompt: "x", tools: { flee: { description: " ", args: { type: "null" } } } },
  },
  {
    name: "act-description-over-cap",
    op: "act",
    request: { site: "robot.act", prompt: "x", tools: { flee: { description: text(501), args: { type: "null" } } } },
  },
  {
    name: "act-bad-args-schema",
    op: "act",
    request: { site: "robot.act", prompt: "x", tools: { flee: { description: "x", args: { type: "object" } } } },
  },
];

/** The longest string a request row keeps as it is; a longer run of one unit is written `{"$repeat": [unit, count]}`. */
const COMPACT_OVER_UNITS = 1024;

/** A request as the fixture keeps it: every long run of one repeated unit folded into a `$repeat`. */
function compact(value: unknown): unknown {
  if (typeof value === "string") {
    const first = value.codePointAt(0);
    if (first === undefined || value.length <= COMPACT_OVER_UNITS) return value;
    const unit = String.fromCodePoint(first);
    const folds = Number.isInteger(value.length / unit.length) && unit.repeat(value.length / unit.length) === value;
    return folds ? { $repeat: [unit, value.length / unit.length] } : value;
  }
  if (Array.isArray(value)) return value.map(compact);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, compact(child)]));
  return value;
}

/** A memory as `ai.memory()` hands one to a call: the page reads its text. */
const memoryOf = (said: unknown) => ({ text: () => said });

function compileRows(modules: Modules) {
  const compilers = {
    ask: modules.compile.compileAsk,
    say: modules.compile.compileSay,
    judge: modules.compile.compileJudge,
    act: modules.compile.compileAct,
  };
  return COMPILE_ROWS.map((row) => {
    const request = { ...row.request };
    if (typeof request.memory === "string") request.memory = memoryOf(request.memory);
    const context = { ...CONTEXT, sites: row.sites ? new Set(row.sites) : null };
    const compiled = compilers[row.op](request, context);
    const expect = compiled.ok
      ? {
          wire: compiled.call.wire,
          line: JSON.stringify({
            event: modules.play.PlayEvent.Ai,
            rid: LINE_RID,
            op: "call",
            body: compiled.call.wire,
          }),
          hostReads:
            modules.play.readPlayAiLine({ event: "ai", rid: LINE_RID, op: "call", body: compiled.call.wire }) !== null,
        }
      : { code: compiled.code };
    return { name: row.name, op: row.op, request: compact(row.request), sites: row.sites ?? null, ...CONTEXT, expect };
  });
}

/** The other lines a game prints: each op with its body, and the exact text. */
function otherLines(modules: Modules) {
  const bodies: Array<[string, unknown]> = [
    ["hello", null],
    ["doors", null],
    ["budget.active", null],
    ["budget.stop", null],
    ["cancel", { ticket: CONTEXT.ticket }],
    ["budget.request", { v: 1, requires: "ai", tiers: ["fast", "smart"] }],
    ["budget.request", { v: 1, requires: "optional", tiers: ["fast"] }],
  ];
  return bodies.map(([op, body]) => {
    const line = { event: modules.play.PlayEvent.Ai, rid: LINE_RID, op, body };
    return { op, body, line: JSON.stringify(line), hostReads: modules.play.readPlayAiLine(line) !== null };
  });
}

const SCHEMA_ROWS: Array<[string, unknown]> = [
  ["move", MOVE_SCHEMA],
  ["turn", TURN_SCHEMA],
  ["not-object", ["string"]],
  ["unknown-type", { type: "tuple" }],
  ["unknown-keyword", { type: "string", pattern: "a+" }],
  ["bad-annotation", { type: "string", title: text(101) }],
  ["bad-enum-empty", { type: "string", enum: [] }],
  ["bad-enum-object", { type: "string", enum: [{}] }],
  ["object-without-closed", { type: "object", properties: {} }],
  [
    "bad-property-name",
    {
      type: "object",
      properties: { __proto__x: { type: "null" }, constructor: { type: "null" } },
      additionalProperties: false,
    },
  ],
  ["bad-required", { type: "object", properties: {}, required: ["ghost"], additionalProperties: false }],
  ["misplaced-items", { type: "string", items: { type: "string" } }],
  ["misplaced-max-length", { type: "integer", maxLength: 3 }],
  ["bad-bound-order", { type: "integer", minimum: 3, maximum: 1 }],
  ["bad-bound-fraction", { type: "string", maxLength: 1.5 }],
  ["array-without-items", { type: "array" }],
];

const VALUE_ROWS: Array<[string, unknown, unknown]> = [
  ["move-left", MOVE_SCHEMA, { move: "left" }],
  ["move-up", MOVE_SCHEMA, { move: "up" }],
  ["move-extra-key", MOVE_SCHEMA, { move: "left", speed: 1 }],
  ["move-missing", MOVE_SCHEMA, {}],
  ["integer-fraction", { type: "integer" }, 1.5],
  ["integer-unsafe", { type: "integer" }, 2 ** 53],
  ["number-bounds", { type: "number", minimum: 0, maximum: 1 }, 1.0000001],
  ["string-code-points", { type: "string", maxLength: 2 }, "🌍🌍"],
  ["string-code-points-over", { type: "string", maxLength: 2 }, "🌍🌍🌍"],
  ["array-default-cap", { type: "array", items: { type: "integer" } }, Array.from({ length: 257 }, () => 1)],
  ["array-min-items", { type: "array", items: { type: "integer" }, minItems: 2 }, [1]],
  ["null", { type: "null" }, null],
  ["enum-null", { type: "string", enum: ["a", null] }, null],
];

const CANONICAL_ROWS: unknown[] = [
  { b: 1, a: { d: [3, { y: 2, x: 1 }], c: "é" } },
  [1.5, -0, 1e21, 1e-7, 0.000001, 123456789012345680000, 2 ** 53, -1e-300, 5e-324, 1.7976931348623157e308],
  "line\nbreak \u0001  ",
];

function answers(modules: Modules) {
  return {
    callOk: {
      v: 1,
      ok: true,
      ticket: CONTEXT.ticket,
      value: { move: "left" },
      source: "tape",
      provenance: "replay",
      latencyMs: 0,
      cached: false,
    },
    callRefused: modules.ai.refusedAnswer(CONTEXT.ticket, modules.ai.AiErrorCode.WaitingForPlan, 60_000),
    callOff: modules.ai.refusedAnswer(CONTEXT.ticket, modules.ai.AiErrorCode.Off),
    hello: { v: 1, on: true },
    doors: { on: true, door: "local" },
    grant: {
      view: {
        id: "grant-0001",
        status: "active",
        door: "local",
        spentMicros: 0,
        planUsedPercent: null,
        planResetsAt: null,
      },
      code: null,
    },
    grantRefused: { view: null, code: modules.ai.AiErrorCode.ConsentRequired },
    cancel: { canceled: true },
    stop: { stopped: true },
  };
}

function vocabularies(modules: Modules) {
  const { ai, schema, play, page } = modules;
  return {
    AiOp: values(ai.AiOp),
    AiBridgeOp: values(ai.AiBridgeOp),
    AiTier: values(ai.AiTier),
    AiAuthority: values(ai.AiAuthority),
    AiRequirement: values(ai.AiRequirement),
    AiDoor: values(ai.AiDoor),
    AiSource: values(ai.AiSource),
    AiProvenance: values(ai.AiProvenance),
    AiErrorCode: values(ai.AiErrorCode),
    AiGrantStatus: values(ai.AiGrantStatus),
    AiSchemaType: values(schema.AiSchemaType),
    AiSchemaProblem: values(schema.AiSchemaProblem),
    AiJudgeKind: values(page.AiJudgeKind),
    PlayAiOp: values(play.PlayAiOp),
    PlayEventAi: play.PlayEvent.Ai,
  };
}

function limits(modules: Modules) {
  const { ai, schema, play, compile } = modules;
  return {
    GAME_AI_WIRE_VERSION: ai.GAME_AI_WIRE_VERSION,
    AI_MAX_PROMPT_BYTES: ai.AI_MAX_PROMPT_BYTES,
    AI_MAX_SCHEMA_BYTES: ai.AI_MAX_SCHEMA_BYTES,
    AI_MAX_UNTRUSTED_BYTES: ai.AI_MAX_UNTRUSTED_BYTES,
    AI_MAX_UNTRUSTED_FIELDS: ai.AI_MAX_UNTRUSTED_FIELDS,
    AI_DEFAULT_OUTPUT_TOKENS: ai.AI_DEFAULT_OUTPUT_TOKENS,
    AI_MAX_OUTPUT_TOKENS: ai.AI_MAX_OUTPUT_TOKENS,
    AI_MAX_OUTPUT_BYTES: ai.AI_MAX_OUTPUT_BYTES,
    AI_MAX_BODY_CHARS: ai.AI_MAX_BODY_CHARS,
    AI_MAX_WALK_NODES: ai.AI_MAX_WALK_NODES,
    AI_MAX_WALK_DEPTH: ai.AI_MAX_WALK_DEPTH,
    AI_SCHEMA_MAX_DEPTH: schema.AI_SCHEMA_MAX_DEPTH,
    AI_SCHEMA_MAX_PROPERTIES: schema.AI_SCHEMA_MAX_PROPERTIES,
    AI_SCHEMA_MAX_ENUM: schema.AI_SCHEMA_MAX_ENUM,
    AI_SCHEMA_MAX_KEY_CHARS: schema.AI_SCHEMA_MAX_KEY_CHARS,
    AI_SCHEMA_MAX_DESCRIPTION: schema.AI_SCHEMA_MAX_DESCRIPTION,
    AI_SCHEMA_MAX_TITLE: schema.AI_SCHEMA_MAX_TITLE,
    AI_SCHEMA_MAX_ITEMS_BOUND: schema.AI_SCHEMA_MAX_ITEMS_BOUND,
    AI_MAX_JSON_NODES: schema.AI_MAX_JSON_NODES,
    AI_MAX_JSON_DEPTH: schema.AI_MAX_JSON_DEPTH,
    AI_MAX_JSON_ARRAY_ITEMS: schema.AI_MAX_JSON_ARRAY_ITEMS,
    AI_SCHEMA_MAX_STRING: schema.AI_SCHEMA_MAX_STRING,
    PLAY_AI_MAX_LINE_CHARS: play.PLAY_AI_MAX_LINE_CHARS,
    PLAY_AI_MAX_IN_FLIGHT: play.PLAY_AI_MAX_IN_FLIGHT,
    JUDGE_MAX_QUESTIONS: compile.JUDGE_MAX_QUESTIONS,
    JUDGE_MAX_TEXT: compile.JUDGE_MAX_TEXT,
    JUDGE_MAX_OPTION_CHARS: compile.JUDGE_MAX_OPTION_CHARS,
    JUDGE_CHOICE_OPTIONS: compile.JUDGE_CHOICE_OPTIONS,
    JUDGE_SCORE_LEVELS: compile.JUDGE_SCORE_LEVELS,
    JUDGE_MAX_STATE_BYTES: compile.JUDGE_MAX_STATE_BYTES,
    ACT_MAX_TOOLS: compile.ACT_MAX_TOOLS,
    ACT_MAX_DESCRIPTION: compile.ACT_MAX_DESCRIPTION,
    ACT_TOOL_KEY: compile.ACT_TOOL_KEY,
  };
}

async function fixture(from: string): Promise<string> {
  const modules = await load(from);
  const { ai, schema, compile } = modules;
  const body = {
    about:
      "The play-time AI wire both sides hold (generated by scripts/toolchains/play-ai-wire-fixture.ts from src/shared/game-ai.ts, game-ai-schema.ts, play-protocol.ts and src/page/ai/compile.ts): the Rust genex-ai crate replays every row (native/genex-rust/crates/genex-ai/src/conformance.rs). Regenerate with `write`, never by hand.",
    vocabularies: vocabularies(modules),
    limits: limits(modules),
    patterns: { site: ai.AI_SITE_RE.source, id: ai.AI_ID_RE.source, name: compile.AI_NAME_RE.source },
    compile: compileRows(modules),
    lines: otherLines(modules),
    schemas: SCHEMA_ROWS.map(([name, row]) => ({ name, schema: row, problem: schema.checkSchema(row) })),
    values: VALUE_ROWS.map(([name, row, value]) => ({
      name,
      schema: row,
      value,
      ok: schema.validateValue(row, value),
    })),
    canonical: CANONICAL_ROWS.map((value) => ({ value, text: schema.canonicalJson(value) })),
    answers: answers(modules),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

async function main(): Promise<void> {
  const { positionals, values: flags } = parseArgs({
    allowPositionals: true,
    options: { from: { type: "string", default: REPO } },
  });
  const mode = positionals[0];
  const from = path.resolve(flags.from ?? REPO);
  const made = await fixture(from);
  if (mode === "write") {
    await writeFile(`${FIXTURE}.partial`, made);
    await rename(`${FIXTURE}.partial`, FIXTURE);
    return;
  }
  if (mode === "check") {
    const committed = await readFile(FIXTURE, "utf8");
    if (committed !== made) {
      process.stderr.write(`${path.relative(REPO, FIXTURE)} differs from ${from}'s modules: run write\n`);
      process.exitCode = 1;
    }
    return;
  }
  process.stderr.write("usage: play-ai-wire-fixture.ts write|check [--from <checkout>]\n");
  process.exitCode = 2;
}

await main();
