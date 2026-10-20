/**
 * A game's request turned into the one call every lane carries (`AiCallRequest`), or refused
 * before anything leaves the page. A judge call becomes a JSON call with a schema built from its
 * questions; an act call one whose schema names every tool. What compiles is exactly what main's
 * reader accepts (`readAiCallRequest` runs on every compiled call), so a lane never sends a call
 * main would drop. Nothing here throws: game code is untrusted input too.
 */
import {
  AI_DEFAULT_OUTPUT_TOKENS,
  AI_MAX_OUTPUT_TOKENS,
  AI_MAX_PROMPT_BYTES,
  AI_MAX_SCHEMA_BYTES,
  AI_MAX_UNTRUSTED_BYTES,
  AI_MAX_UNTRUSTED_FIELDS,
  AI_SITE_RE,
  AiAuthority,
  type AiCallRequest,
  AiErrorCode,
  AiOp,
  AiTier,
  fitsBytes,
  GAME_AI_WIRE_VERSION,
  isBoundedJson,
  isPlainRecord,
  readAiCallRequest,
  readMember,
} from "../../shared/game-ai.ts";
import { type AiOutputSchema, AiSchemaType, canonicalJson, checkSchema } from "../../shared/game-ai-schema.ts";
import {
  actPrompt,
  CHOICE_ANSWER_WORDS,
  JUDGE_SYSTEM,
  type JudgePromptQuestion,
  judgePrompt,
  scoreAnswerWords,
  yesNoAnswerWords,
} from "./compile-prompts.ts";
import { AiJudgeKind } from "./types.ts";

/** The most questions one judge call asks (one property each in its schema). */
export const JUDGE_MAX_QUESTIONS = 32;
/** A question's or a tool's name (genex.games' judge question name). */
export const AI_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
/** The longest instructions, option or level text (genex.games' judge text). */
export const JUDGE_MAX_TEXT = 2000;
/** The longest option name. */
export const JUDGE_MAX_OPTION_CHARS = 80;
/** A choice's option count, and a score's level count (genex.games' judge bounds; a schema enum holds 32). */
export const JUDGE_CHOICE_OPTIONS = { min: 2, max: 32 } as const;
export const JUDGE_SCORE_LEVELS = { min: 2, max: 10 } as const;
/** The largest judge state, as JSON (genex.games `JUDGE_MAX_STATE_BYTES`). */
export const JUDGE_MAX_STATE_BYTES = 96 * 1024;
/** The most tools one act call offers: one property each beside `tool`. */
export const ACT_MAX_TOOLS = 31;
/** The longest tool description (a schema annotation's cap). */
export const ACT_MAX_DESCRIPTION = 500;
/** The property an act answer names its tool in. */
export const ACT_TOOL_KEY = "tool";

const FORBIDDEN_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
const JUDGE_STATE_BOUNDS = { nodes: 8192, depth: 16, chars: JUDGE_MAX_STATE_BYTES };

/** What every compiled call carries besides the game's request: its ticket and grant, and the sites it may name. */
export interface CompileContext {
  ticket: string;
  grantId: string;
  /** The sites `createAi({ sites })` declared; null when it declared none. */
  sites: ReadonlySet<string> | null;
}

/** genex.games' judge question types (its own wire words). Never rename one. */
export const PlatformJudgeType = { YesNo: "noul", Choice: "choice", Score: "score" } as const;
export type PlatformJudgeType = (typeof PlatformJudgeType)[keyof typeof PlatformJudgeType];

/** A judge question as genex.games' judge takes it (the platform lane calls `judge()` with these). */
export type PlatformJudgeQuestion =
  | { type: typeof PlatformJudgeType.YesNo; instructions: string; criteria?: { true: string; false: string } }
  | { type: typeof PlatformJudgeType.Choice; instructions: string; criteria: Record<string, string> }
  | { type: typeof PlatformJudgeType.Score; instructions: string; criteria: string[] };

/** A compiled call: the wire, and how its validated answer becomes what the game reads. */
export interface CompiledCall {
  wire: AiCallRequest;
  /** A judge call's own questions and state, for genex.games' judge. */
  judge: { questions: Record<string, PlatformJudgeQuestion>; state: unknown } | null;
  /** The answer as the game reads it, once it fitted the wire's schema. */
  decode(value: unknown): unknown;
  /** Credits ceiling a published game named for the call. */
  maxCredits: number | null;
}

/** A compiled call, or why the request is refused before it leaves the page. */
export type Compiled = { ok: true; call: CompiledCall } | { ok: false; code: AiErrorCode };

const refused = (code: AiErrorCode): Compiled => ({ ok: false, code });

/** What every op's request carries, read from untrusted game code. */
export interface BaseRequest {
  site?: unknown;
  system?: unknown;
  prompt?: unknown;
  untrusted?: unknown;
  memory?: unknown;
  tier?: unknown;
  authority?: unknown;
  maxOutputTokens?: unknown;
  maxCredits?: unknown;
}

/** The fields of a base request every op shares, read; or the code that refuses them. */
interface BaseRead {
  site: string;
  system: string | null;
  untrusted: Record<string, string>;
  memory: string | null;
  tier: AiTier;
  authority: AiAuthority;
  maxOutputTokens: number;
  maxCredits: number | null;
}

/** A field read from game code: its value, or the code that refuses it. */
type Read<T> = { ok: true; value: T } | { ok: false; code: AiErrorCode };

const value = <T>(read: T): Read<T> => ({ ok: true, value: read });
const refusal = <T>(code: AiErrorCode): Read<T> => ({ ok: false, code });

/** Player-typed fields: at most {@link AI_MAX_UNTRUSTED_FIELDS}, keyed like sites, each a bounded string. */
function readUntrusted(raw: unknown): Read<Record<string, string>> {
  if (raw === undefined) return value({});
  if (!isPlainRecord(raw)) return refusal(AiErrorCode.BadRequest);
  const entries = Object.entries(raw);
  if (entries.length > AI_MAX_UNTRUSTED_FIELDS) return refusal(AiErrorCode.BadRequest);
  const fields: Record<string, string> = {};
  for (const [key, text] of entries) {
    if (!AI_SITE_RE.test(key) || typeof text !== "string") return refusal(AiErrorCode.BadRequest);
    if (!fitsBytes([text], AI_MAX_UNTRUSTED_BYTES)) return refusal(AiErrorCode.TooLarge);
    fields[key] = text;
  }
  return value(fields);
}

/** A memory's text: what `ai.memory()` returns carries one; anything else is refused. */
function readMemory(raw: unknown): Read<string | null> {
  if (raw === undefined || raw === null) return value(null);
  const text = typeof raw === "object" ? Reflect.get(raw, "text") : undefined;
  if (typeof text !== "function") return refusal(AiErrorCode.BadRequest);
  const said: unknown = Reflect.apply(text, raw, []);
  return said === null || typeof said === "string" ? value(said) : refusal(AiErrorCode.BadRequest);
}

const isWhole = (raw: unknown, min: number, max: number): raw is number =>
  typeof raw === "number" && Number.isInteger(raw) && raw >= min && raw <= max;

/** The output budget: the default, or a whole number of tokens within the cap. */
function readOutputTokens(raw: unknown): number | null {
  if (raw === undefined) return AI_DEFAULT_OUTPUT_TOKENS;
  return isWhole(raw, 1, AI_MAX_OUTPUT_TOKENS) ? raw : null;
}

/** The most credits one call may name. */
const MAX_CALL_CREDITS = 1_000_000;

/** A credits ceiling: a whole number of credits from one, or none (null); undefined when it is not one. */
function readCredits(raw: unknown): number | null | undefined {
  if (raw === undefined) return null;
  return isWhole(raw, 1, MAX_CALL_CREDITS) ? raw : undefined;
}

/** The site: the name's shape, and one the game declared when it declared any. */
function siteOk(site: unknown, sites: ReadonlySet<string> | null): site is string {
  return typeof site === "string" && AI_SITE_RE.test(site) && (sites === null || sites.has(site));
}

/** The call's tier, authority and budgets, read; null when one is not a value it may take. */
function readTerms(
  request: BaseRequest,
): Pick<BaseRead, "tier" | "authority" | "maxOutputTokens" | "maxCredits"> | null {
  const tier = request.tier === undefined ? AiTier.Fast : readMember(AiTier, request.tier);
  const authority = request.authority === undefined ? AiAuthority.Local : readMember(AiAuthority, request.authority);
  const maxOutputTokens = readOutputTokens(request.maxOutputTokens);
  const maxCredits = readCredits(request.maxCredits);
  if (!tier || !authority || maxOutputTokens === null || maxCredits === undefined) return null;
  return { tier, authority, maxOutputTokens, maxCredits };
}

/** The fields every op shares, read from untrusted game code. */
function readBase(request: BaseRequest, context: CompileContext): Read<BaseRead> {
  const { site, system } = request;
  if (!siteOk(site, context.sites)) return refusal(AiErrorCode.BadRequest);
  if (system !== undefined && typeof system !== "string") return refusal(AiErrorCode.BadRequest);
  const untrusted = readUntrusted(request.untrusted);
  if (!untrusted.ok) return untrusted;
  const memory = readMemory(request.memory);
  if (!memory.ok) return memory;
  const terms = readTerms(request);
  if (!terms) return refusal(AiErrorCode.BadRequest);
  return value({ site, system: system ?? null, untrusted: untrusted.value, memory: memory.value, ...terms });
}

/** A call's wire: the base, the op's prompt and schema, checked against main's own reader. */
function finish(
  op: AiOp,
  base: BaseRead,
  parts: { system: string | null; prompt: string; schema: AiOutputSchema | null },
  context: CompileContext,
): AiCallRequest | AiErrorCode {
  if (!fitsBytes([parts.system, parts.prompt, base.memory], AI_MAX_PROMPT_BYTES)) return AiErrorCode.TooLarge;
  if (parts.schema !== null && !fitsBytes([JSON.stringify(parts.schema)], AI_MAX_SCHEMA_BYTES))
    return AiErrorCode.TooLarge;
  const wire: AiCallRequest = {
    v: GAME_AI_WIRE_VERSION,
    op,
    site: base.site,
    ticket: context.ticket,
    grantId: context.grantId,
    system: parts.system,
    prompt: parts.prompt,
    untrusted: base.untrusted,
    memory: base.memory,
    schema: parts.schema,
    tier: base.tier,
    authority: base.authority,
    maxOutputTokens: base.maxOutputTokens,
    stream: op === AiOp.Say,
  };
  return readAiCallRequest(wire) ?? AiErrorCode.BadRequest;
}

/** A compiled call from its parts, or the refusal one of them raised. */
function compiled(
  op: AiOp,
  request: BaseRequest,
  context: CompileContext,
  build: (
    base: BaseRead,
  ) =>
    | { system: string | null; prompt: string; schema: AiOutputSchema | null; extra?: Partial<CompiledCall> }
    | AiErrorCode,
): Compiled {
  const read = readBase(request, context);
  if (!read.ok) return refused(read.code);
  const base = read.value;
  const parts = build(base);
  if (typeof parts === "string") return refused(parts);
  const wire = finish(op, base, parts, context);
  if (typeof wire === "string") return refused(wire);
  const call: CompiledCall = {
    wire,
    judge: null,
    decode: (answer) => answer,
    maxCredits: base.maxCredits,
    ...parts.extra,
  };
  return { ok: true, call };
}

const isPrompt = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

/** `ask`: JSON that fits the game's schema. */
export function compileAsk(request: BaseRequest & { schema?: unknown }, context: CompileContext): Compiled {
  return compiled(AiOp.Ask, request, context, (base) => {
    if (!isPrompt(request.prompt)) return AiErrorCode.BadRequest;
    if (checkSchema(request.schema) !== null) return AiErrorCode.InvalidSchema;
    if (!isOutputSchema(request.schema)) return AiErrorCode.InvalidSchema;
    return { system: base.system, prompt: request.prompt, schema: request.schema };
  });
}

/** A schema `checkSchema` passed: the dialect's own type. */
const isOutputSchema = (schema: unknown): schema is AiOutputSchema => checkSchema(schema) === null;

/** Text cut to `max` characters (code points), never inside one. */
const cutTo = (text: string, max: number): string => {
  const points = [...text];
  return points.length > max ? points.slice(0, max).join("") : text;
};

/** `say`: free text, streamed, cut to `maxChars` when the game names one. */
export function compileSay(request: BaseRequest & { maxChars?: unknown }, context: CompileContext): Compiled {
  return compiled(AiOp.Say, request, context, (base) => {
    if (!isPrompt(request.prompt)) return AiErrorCode.BadRequest;
    const max = request.maxChars;
    if (max !== undefined && !isWhole(max, 1, Number.MAX_SAFE_INTEGER)) return AiErrorCode.BadRequest;
    const decode = (answer: unknown): unknown =>
      typeof answer === "string" && max !== undefined ? cutTo(answer, max) : answer;
    return { system: base.system, prompt: request.prompt, schema: null, extra: { decode } };
  });
}

const isText = (raw: unknown, max: number): raw is string =>
  typeof raw === "string" && raw.trim().length > 0 && raw.length <= max;

/** A choice's options: 2–32 named options, each described. */
function readOptions(raw: unknown): Record<string, string> | null {
  if (!isPlainRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length < JUDGE_CHOICE_OPTIONS.min || entries.length > JUDGE_CHOICE_OPTIONS.max) return null;
  const options: Record<string, string> = {};
  for (const [name, text] of entries) {
    const named = name.length >= 1 && name.length <= JUDGE_MAX_OPTION_CHARS && !FORBIDDEN_NAMES.has(name);
    if (!named || !isText(text, JUDGE_MAX_TEXT)) return null;
    options[name] = text;
  }
  return options;
}

/** A score's levels, lowest first: 2–10 of them. */
function readLevels(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length < JUDGE_SCORE_LEVELS.min || raw.length > JUDGE_SCORE_LEVELS.max) return null;
  return raw.every((level) => isText(level, JUDGE_MAX_TEXT)) ? [...raw] : null;
}

/** One judge question read: its schema, its prompt line and genex.games' shape of it. */
interface ReadQuestion {
  schema: AiOutputSchema;
  prompt: JudgePromptQuestion;
  platform: PlatformJudgeQuestion;
}

function readYesNo(name: string, raw: Record<string, unknown>, instructions: string): ReadQuestion | null {
  const { yes, no } = raw;
  const unnamed = yes === undefined && no === undefined;
  if (!unnamed && !(isText(yes, JUDGE_MAX_TEXT) && isText(no, JUDGE_MAX_TEXT))) return null;
  const sides = unnamed ? null : { true: String(yes), false: String(no) };
  return {
    schema: { type: AiSchemaType.Number, minimum: 0, maximum: 1 },
    prompt: { name, instructions, answer: yesNoAnswerWords(sides?.true ?? null, sides?.false ?? null), options: [] },
    platform: { type: PlatformJudgeType.YesNo, instructions, ...(sides ? { criteria: sides } : {}) },
  };
}

function readChoice(name: string, raw: Record<string, unknown>, instructions: string): ReadQuestion | null {
  const options = readOptions(raw.options);
  if (!options) return null;
  const lines = Object.entries(options).map(([option, text]) => `${option}: ${text}`);
  return {
    schema: { type: AiSchemaType.String, enum: Object.keys(options) },
    prompt: { name, instructions, answer: CHOICE_ANSWER_WORDS, options: lines },
    platform: { type: PlatformJudgeType.Choice, instructions, criteria: options },
  };
}

function readScore(name: string, raw: Record<string, unknown>, instructions: string): ReadQuestion | null {
  const levels = readLevels(raw.levels);
  if (!levels) return null;
  return {
    schema: { type: AiSchemaType.Integer, minimum: 0, maximum: levels.length - 1 },
    prompt: {
      name,
      instructions,
      answer: scoreAnswerWords(levels.length),
      options: levels.map((l, i) => `${i}: ${l}`),
    },
    platform: { type: PlatformJudgeType.Score, instructions, criteria: levels },
  };
}

/** One question of a judge call, or null when it is not one the judge can answer. */
function readQuestion(name: string, raw: unknown): ReadQuestion | null {
  if (!AI_NAME_RE.test(name) || !isPlainRecord(raw) || !isText(raw.instructions, JUDGE_MAX_TEXT)) return null;
  const kind = readMember(AiJudgeKind, raw.kind);
  if (kind === AiJudgeKind.YesNo) return readYesNo(name, raw, raw.instructions);
  if (kind === AiJudgeKind.Choice) return readChoice(name, raw, raw.instructions);
  if (kind === AiJudgeKind.Score) return readScore(name, raw, raw.instructions);
  return null;
}

/** A judge call's questions, every one read, or null. */
function readQuestions(raw: unknown): Map<string, ReadQuestion> | null {
  if (!isPlainRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > JUDGE_MAX_QUESTIONS) return null;
  const read = new Map<string, ReadQuestion>();
  for (const [name, question] of entries) {
    const one = readQuestion(name, question);
    if (!one) return null;
    read.set(name, one);
  }
  return read;
}

/** A judge's state as the prompt carries it: plain JSON within the judge's bounds. */
function stateText(state: unknown): Read<string> {
  if (state === undefined || !isBoundedJson(state, JUDGE_STATE_BOUNDS)) return refusal(AiErrorCode.BadRequest);
  const text = canonicalJson(state);
  return fitsBytes([text], JUDGE_MAX_STATE_BYTES) ? value(text) : refusal(AiErrorCode.TooLarge);
}

/** A closed object schema over named properties, every one required. */
const closedObject = (properties: Record<string, AiOutputSchema>): AiOutputSchema => ({
  type: AiSchemaType.Object,
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** `judge`: classify the game's state against fixed questions, as JSON its questions shape. */
export function compileJudge(
  request: BaseRequest & { questions?: unknown; state?: unknown },
  context: CompileContext,
): Compiled {
  return compiled(AiOp.Judge, request, context, () => {
    const questions = readQuestions(request.questions);
    if (!questions) return AiErrorCode.BadRequest;
    const extra = request.prompt;
    if (extra !== undefined && !isPrompt(extra)) return AiErrorCode.BadRequest;
    const state = stateText(request.state);
    if (!state.ok) return state.code;
    const read = [...questions.entries()];
    const schema = closedObject(Object.fromEntries(read.map(([name, q]) => [name, q.schema])));
    const prompt = judgePrompt(
      read.map(([, q]) => q.prompt),
      state.value,
      extra ?? null,
    );
    const judge = { questions: Object.fromEntries(read.map(([name, q]) => [name, q.platform])), state: request.state };
    return { system: JUDGE_SYSTEM, prompt, schema, extra: { judge } };
  });
}

/** An act call's tools: their names, descriptions and argument schemas. */
function readTools(raw: unknown): Array<{ name: string; description: string; args: AiOutputSchema }> | null {
  if (!isPlainRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > ACT_MAX_TOOLS) return null;
  const tools: Array<{ name: string; description: string; args: AiOutputSchema }> = [];
  for (const [name, spec] of entries) {
    if (!AI_NAME_RE.test(name) || name === ACT_TOOL_KEY || !isPlainRecord(spec)) return null;
    if (!isText(spec.description, ACT_MAX_DESCRIPTION) || !isOutputSchema(spec.args)) return null;
    tools.push({ name, description: spec.description, args: spec.args });
  }
  return tools;
}

/** The tool an act answer picked, with its arguments. */
function decodeAct(answer: unknown): unknown {
  if (!isPlainRecord(answer) || typeof answer[ACT_TOOL_KEY] !== "string") return null;
  const tool = answer[ACT_TOOL_KEY];
  return { tool, args: answer[tool] };
}

/** `act`: pick exactly one tool and fill its arguments. */
export function compileAct(request: BaseRequest & { tools?: unknown }, context: CompileContext): Compiled {
  return compiled(AiOp.Act, request, context, (base) => {
    if (!isPrompt(request.prompt)) return AiErrorCode.BadRequest;
    const tools = readTools(request.tools);
    if (!tools) return AiErrorCode.BadRequest;
    const names = tools.map((tool) => tool.name);
    const schema = closedObject({
      [ACT_TOOL_KEY]: { type: AiSchemaType.String, enum: names },
      ...Object.fromEntries(tools.map((tool) => [tool.name, tool.args])),
    });
    if (checkSchema(schema) !== null) return AiErrorCode.InvalidSchema;
    const prompt = actPrompt(request.prompt, tools);
    return { system: base.system, prompt, schema, extra: { decode: decodeAct } };
  });
}
