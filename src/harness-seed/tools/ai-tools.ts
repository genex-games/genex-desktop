/**
 * Play-time AI for the builder: the host's `ai.*` methods as tools. A schema is checked against the
 * dialect; a demo's saved playtest is listed, replayed under seeds (on its tape, with AI off, or with
 * the worst answers its shapes allow), recorded on this Mac's models, and a call site benched; the
 * model check runs on local models only. Nothing here reaches the network, and nothing the agent
 * sends sizes the host's run budget: it caps the calls itself (`main/harness-rpc/ai.ts`).
 *
 * Every argument is read here first, and a bad one is answered in a sentence before any host call.
 * A new module: the registry imports every `tools/*.ts`, so a kept older workspace without it simply
 * has no AI tools, and a host without `ai.*` offers none.
 */
import { HostMethod } from "../loop/host-methods.ts";
import {
  AI_BENCH_MAX_SAMPLES,
  AI_REPLAY_MAX_SEEDS,
  AI_SITE_RE,
  AiReplayAnswers,
  TAPE_NAME_RE,
} from "../loop/ai-contract.ts";
import { AI_CHECK_SEEDS } from "../loop/ai-checks.ts";
import { AI_TOOL_WORDS } from "./ai-tools-prompts.ts";
import type { AnyRecord, HarnessTool, ToolCtx, ToolOutcome } from "../types/harness.d.ts";

/** The seed a recording plays when the call names none. */
const DEFAULT_RECORD_SEED = 1;
/** The largest seed a tool passes: the host's own bound (a safe integer). */
const MAX_SEED = Number.MAX_SAFE_INTEGER;

const str = (description: string) => ({ type: "string", description });

/** A refusal: the tool's answer, with no host call. */
const refused = (content: string): ToolOutcome => ({ ok: false, content });

/** The game a call may act on, or the sentence that says why not. */
function gameOf(ctx: ToolCtx): { project: string } | ToolOutcome {
  if (ctx.candidateId) return refused(AI_TOOL_WORDS.candidate);
  if (!ctx.project) return refused(AI_TOOL_WORDS.noProject);
  return { project: ctx.project };
}

/** A seed: a whole number from 0 to the largest safe integer. */
function seedOf(raw: unknown): number | null {
  const text = typeof raw === "number" ? String(raw) : String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const seed = Number(text);
  return Number.isSafeInteger(seed) && seed <= MAX_SEED ? seed : null;
}

/** The seeds a replay runs: a list or comma-separated text, each a seed, 1 to `AI_REPLAY_MAX_SEEDS`. */
function seedsOf(raw: unknown): number[] | null {
  if (raw === undefined || raw === null || raw === "") return [...AI_CHECK_SEEDS];
  const items = Array.isArray(raw) ? raw : String(raw).split(",");
  if (items.length < 1 || items.length > AI_REPLAY_MAX_SEEDS) return null;
  const seeds = items.map(seedOf);
  return seeds.every((seed) => seed !== null) ? seeds : null;
}

/** What a replay answers its calls with; the tape when the call names nothing. */
function answersOf(raw: unknown): AiReplayAnswers | null {
  if (raw === undefined || raw === null || raw === "") return AiReplayAnswers.Tape;
  return Object.values(AiReplayAnswers).find((word) => word === raw) ?? null;
}

/** A demo's name, or null. */
const demoOf = (raw: unknown): string | null => (typeof raw === "string" && TAPE_NAME_RE.test(raw) ? raw : null);

/** A call site's name, or null. */
const siteOf = (raw: unknown): string | null => (typeof raw === "string" && AI_SITE_RE.test(raw) ? raw : null);

/** A bench's samples: a whole number from 1 to the most a bench takes; the most when the call names none. */
function samplesOf(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return AI_BENCH_MAX_SAMPLES;
  const samples = Number(raw);
  return Number.isInteger(samples) && samples >= 1 && samples <= AI_BENCH_MAX_SAMPLES ? samples : null;
}

/** A schema: a JSON object, or JSON text of one. */
function schemaOf(raw: unknown): { schema: unknown } | null {
  if (typeof raw !== "string") return raw === undefined ? null : { schema: raw };
  try {
    return { schema: JSON.parse(raw) };
  } catch {
    return null;
  }
}

/** Run a host call, and say its failure in a sentence instead of throwing it at the turn. */
async function answered<R>(what: string, call: () => Promise<R>, words: (result: R) => string): Promise<ToolOutcome> {
  try {
    return { ok: true, content: words(await call()) };
  } catch (err: unknown) {
    return refused(AI_TOOL_WORDS.failed(what, err instanceof Error ? err.message : String(err)));
  }
}

/** `ai_schema_check`: a schema against the dialect; needs no game. */
async function schemaCheck(args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome> {
  const read = schemaOf(args.schema);
  if (!read) return refused(AI_TOOL_WORDS.badSchema);
  return answered(
    "The schema check",
    () => ctx.call(HostMethod.AiSchemaCheck, { schema: read.schema }),
    (result) => (result.ok ? AI_TOOL_WORDS.schemaFits : AI_TOOL_WORDS.schemaRefused(result.problem)),
  );
}

/** `ai_tapes`: the game's saved playtests. */
async function tapes(_args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome> {
  const game = gameOf(ctx);
  if (!("project" in game)) return game;
  return answered("Listing the playtests", () => ctx.call(HostMethod.AiTapes, game), AI_TOOL_WORDS.tapes);
}

/** `ai_replay`: a demo's replay under its seeds. */
async function replay(args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome> {
  const game = gameOf(ctx);
  if (!("project" in game)) return game;
  const demo = demoOf(args.demo);
  if (!demo) return refused(AI_TOOL_WORDS.badDemo(String(args.demo ?? "")));
  const seeds = seedsOf(args.seeds);
  if (!seeds) return refused(AI_TOOL_WORDS.badSeeds);
  const answers = answersOf(args.answers);
  if (!answers) return refused(AI_TOOL_WORDS.badAnswers);
  return answered(
    "The replay",
    () => ctx.call(HostMethod.AiReplay, { ...game, demo, seeds, answers }),
    AI_TOOL_WORDS.replay,
  );
}

/** `ai_record`: a demo played on this Mac's models, saved as its tape. */
async function record(args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome> {
  const game = gameOf(ctx);
  if (!("project" in game)) return game;
  const demo = demoOf(args.demo);
  if (!demo) return refused(AI_TOOL_WORDS.badDemo(String(args.demo ?? "")));
  const seed = args.seed === undefined || args.seed === "" ? DEFAULT_RECORD_SEED : seedOf(args.seed);
  if (seed === null) return refused(AI_TOOL_WORDS.badSeed);
  return answered("The recording", () => ctx.call(HostMethod.AiRecord, { ...game, demo, seed }), AI_TOOL_WORDS.record);
}

/** `ai_bench`: one call site sampled on this Mac's models. */
async function bench(args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome> {
  const game = gameOf(ctx);
  if (!("project" in game)) return game;
  const site = siteOf(args.site);
  if (!site) return refused(AI_TOOL_WORDS.badSite);
  const samples = samplesOf(args.samples);
  if (samples === null) return refused(AI_TOOL_WORDS.badSamples);
  return answered("The bench", () => ctx.call(HostMethod.AiBench, { ...game, site, samples }), AI_TOOL_WORDS.bench);
}

/** `ai_model_check`: the model check on this Mac's models. */
async function modelCheck(_args: AnyRecord, ctx: ToolCtx): Promise<ToolOutcome> {
  const game = gameOf(ctx);
  if (!("project" in game)) return game;
  return answered("The model check", () => ctx.call(HostMethod.AiModelCheck, game), AI_TOOL_WORDS.modelCheck);
}

/** Does this studio's host run play-time AI for the harness (a kept older host-methods.ts may not know it)? */
function hostHasAi(): boolean {
  return Object.hasOwn(HostMethod, "AiReplay");
}

export const tools: HarnessTool[] = hostHasAi()
  ? [
      {
        name: "ai_schema_check",
        description: AI_TOOL_WORDS.schemaCheckDescription,
        parameters: { type: "object", properties: { schema: str(AI_TOOL_WORDS.schema) }, required: ["schema"] },
        execute: schemaCheck,
      },
      {
        name: "ai_tapes",
        description: AI_TOOL_WORDS.tapesDescription,
        parameters: { type: "object", properties: {} },
        execute: tapes,
      },
      {
        name: "ai_replay",
        description: AI_TOOL_WORDS.replayDescription,
        parameters: {
          type: "object",
          properties: {
            demo: str(AI_TOOL_WORDS.demo),
            seeds: str(AI_TOOL_WORDS.seeds),
            answers: { type: "string", enum: Object.values(AiReplayAnswers), description: AI_TOOL_WORDS.answers },
          },
          required: ["demo"],
        },
        execute: replay,
      },
      {
        name: "ai_record",
        description: AI_TOOL_WORDS.recordDescription,
        parameters: {
          type: "object",
          properties: { demo: str(AI_TOOL_WORDS.demo), seed: str(AI_TOOL_WORDS.seed) },
          required: ["demo"],
        },
        execute: record,
      },
      {
        name: "ai_bench",
        description: AI_TOOL_WORDS.benchDescription,
        parameters: {
          type: "object",
          properties: { site: str(AI_TOOL_WORDS.site), samples: str(AI_TOOL_WORDS.samples) },
          required: ["site"],
        },
        execute: bench,
      },
      {
        name: "ai_model_check",
        description: AI_TOOL_WORDS.modelCheckDescription,
        parameters: { type: "object", properties: {} },
        execute: modelCheck,
      },
    ]
  : [];
