/**
 * The AI mechanic judge (`judge/ai-mechanic.md`): is a game's play-time AI a mechanic or decoration?
 * It reads tape replays only — never the network, never a live model in the game: each demo's saved
 * answers (`ai/tapes/<demo>.jsonl`), the state at its checkpoints under the replay seeds and what it
 * did with no answer at all — and answers four yes/no questions (does an answer decide something the
 * player acts on within ten seconds, is it legible, does it vary with the player's input, does the
 * game handle a missing answer) with one fix. The director's judge asks it of a game that declares AI.
 *
 * A tape is agent-writable game content: a demo's name is checked before it names a file, a tape is
 * read as a regular file under the build only (never through a link), bounded, and every value it
 * quotes is fenced as game content.
 */
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { askJudgeFor, judgePrompt } from "./judge.ts";
import { aiRequirementOf, gameLine } from "./kinds.ts";
import { AI_SITE_RE, AI_TAPE_EXTENSION, AI_TAPES_DIR, AiReplayAnswers, TAPE_NAME_RE } from "./ai-contract.ts";
import { buildFolder, buildOf, demosOf, replaysOf, type AiCheckEvidence } from "./ai-checks.ts";
import {
  AI_MECHANIC_RUBRIC_FALLBACK,
  aiMechanicBrief,
  type MechanicCall,
  type MechanicDemo,
} from "./ai-mechanic-prompts.ts";
import { isPlainRecord, isRecord } from "./json.ts";
import { clip, CLIP_REASON } from "./text.ts";
import type { HarnessCtx, Run } from "../types/harness.d.ts";
import type { AiReplayResult } from "../types/host-api.d.ts";

/** The rubric's file in the workspace's `judge/`. */
export const AI_MECHANIC_RUBRIC = "ai-mechanic.md";
/** The four questions, by the key the judge answers under. Verdicts keep them: never rename one. */
export const AiMechanicQuestion = {
  Decides: "decides",
  Legible: "legible",
  Varies: "varies",
  HandlesMissing: "handles_missing",
} as const;
export type AiMechanicQuestion = (typeof AiMechanicQuestion)[keyof typeof AiMechanicQuestion];

/** The most bytes of one tape the judge's brief reads, and the most of its calls it quotes. */
const MAX_TAPE_BYTES = 512 * 1024;
const MAX_CALLS_SHOWN = 24;
/** The longest reason or fix kept from the judge. */
const VERDICT_TEXT_CHARS = 300;

/** One question's answer: yes, no, or null when the judge gave none it could use. */
export interface AiMechanicAnswer {
  yes: boolean | null;
  why: string;
}

/** The judge's verdict, read as hostile input: every question answered or null, and its one fix. */
export interface AiMechanicVerdict {
  answers: Record<AiMechanicQuestion, AiMechanicAnswer>;
  fix: string;
  /** False when the judge's reply could not be read at all: no answer in it counts. */
  usable: boolean;
}

/** Why there is no verdict: no build, no demo, or a studio that could not replay. */
export interface AiMechanicUnavailable {
  unavailable: string;
}

/** Text the judge wrote, bounded. */
const textOf = (value: unknown): string => (typeof value === "string" ? clip(value.trim(), VERDICT_TEXT_CHARS) : "");

/** One question's answer as the judge wrote it: a boolean `yes`, or nothing. */
function answerOf(raw: unknown): AiMechanicAnswer {
  if (!isPlainRecord(raw)) return { yes: null, why: "" };
  return { yes: typeof raw.yes === "boolean" ? raw.yes : null, why: textOf(raw.why) };
}

/** The judge's reply as a verdict. Never throws; a reply it cannot read is unusable, every answer null. */
export function readAiMechanicVerdict(raw: unknown): AiMechanicVerdict {
  const reply = isPlainRecord(raw) && raw.unusable !== true ? raw : null;
  const answers = {
    [AiMechanicQuestion.Decides]: answerOf(reply?.[AiMechanicQuestion.Decides]),
    [AiMechanicQuestion.Legible]: answerOf(reply?.[AiMechanicQuestion.Legible]),
    [AiMechanicQuestion.Varies]: answerOf(reply?.[AiMechanicQuestion.Varies]),
    [AiMechanicQuestion.HandlesMissing]: answerOf(reply?.[AiMechanicQuestion.HandlesMissing]),
  };
  return { answers, fix: textOf(reply?.fix), usable: reply !== null };
}

/** One tape line as the brief quotes it, or null. */
function callOf(row: string): MechanicCall | null {
  let line: unknown;
  try {
    line = JSON.parse(row);
  } catch {
    return null;
  }
  if (!isRecord(line) || typeof line.site !== "string" || !AI_SITE_RE.test(line.site)) return null;
  const n = Number.isSafeInteger(line.n) ? Number(line.n) : null;
  const latencyFrames = Number.isSafeInteger(line.latencyFrames) ? Number(line.latencyFrames) : null;
  if (n === null || latencyFrames === null) return null;
  return { site: line.site, n, latencyFrames, value: line.value };
}

/**
 * A demo's saved calls, from `ai/tapes/<demo>.jsonl` under the build: none for a name that is not a
 * demo's, for a tape that is a link or no regular file, or one that cannot be read. Bounded.
 */
export async function tapeCalls(folder: string, demo: string): Promise<MechanicCall[]> {
  if (!TAPE_NAME_RE.test(demo)) return [];
  const file = path.join(folder, ...AI_TAPES_DIR.split("/"), `${demo}${AI_TAPE_EXTENSION}`);
  const info = await lstat(file).catch(() => null);
  if (!info?.isFile()) return [];
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .slice(0, MAX_TAPE_BYTES)
    .split("\n")
    .filter((row) => row.trim())
    .map(callOf)
    .filter((call): call is MechanicCall => call !== null)
    .slice(0, MAX_CALLS_SHOWN);
}

/** A demo's replays and tape, as the judge reads them. */
function mechanicDemo(
  demo: string,
  calls: MechanicCall[],
  tape: AiReplayResult | undefined,
  none: AiReplayResult | undefined,
): MechanicDemo {
  return {
    demo,
    calls,
    checkpoints: tape?.stateDigests ?? [],
    misses: tape?.misses ?? 0,
    fallbacks: tape?.fallbacks ?? 0,
    noAnswer: { settled: none?.settled ?? null, stuck: none?.stuck ?? null },
  };
}

/** What the judge reads of an evidence pass: each demo's tape and replays, or why there is nothing. */
export async function aiMechanicDemos(
  ctx: HarnessCtx,
  evidence: AiCheckEvidence & object,
): Promise<MechanicDemo[] | AiMechanicUnavailable> {
  const build = buildOf(evidence);
  if (!build) return { unavailable: "the evidence names no build" };
  const demos = demosOf(evidence).filter((demo) => TAPE_NAME_RE.test(demo));
  if (demos.length === 0) return { unavailable: "the game registers no demo with a saved playtest" };
  const folder = await buildFolder(ctx, build);
  if (!folder) return { unavailable: `the folder of ${build.project} could not be found` };
  const tape = await replaysOf(ctx, evidence, build, demos, AiReplayAnswers.Tape);
  const none = await replaysOf(ctx, evidence, build, demos, AiReplayAnswers.None);
  const failed = tape.error ?? none.error;
  if (failed !== null) return { unavailable: `the studio could not replay: ${failed}` };
  const byDemo = (results: typeof tape.results, demo: string) => results.find((entry) => entry.demo === demo)?.result;
  const read = demos.map(async (demo) =>
    mechanicDemo(demo, await tapeCalls(folder, demo), byDemo(tape.results, demo), byDemo(none.results, demo)),
  );
  return Promise.all(read);
}

/**
 * Ask the AI mechanic judge about the build an evidence pass looked at: its rubric is the workspace's
 * `judge/ai-mechanic.md` (or the built-in one), its brief the replays. A verdict, or why there is none.
 */
export async function judgeAiMechanic(
  ctx: HarnessCtx,
  run: Run,
  evidence: AiCheckEvidence & object,
): Promise<AiMechanicVerdict | AiMechanicUnavailable> {
  const demos = await aiMechanicDemos(ctx, evidence);
  if (!Array.isArray(demos)) return demos;
  const systemPrompt = await judgePrompt(ctx, AI_MECHANIC_RUBRIC, AI_MECHANIC_RUBRIC_FALLBACK);
  const userContent = aiMechanicBrief(gameLine(run.game), demos);
  try {
    const { raw } = await askJudgeFor(ctx, { run, systemPrompt, userContent });
    return readAiMechanicVerdict(raw);
  } catch (err: unknown) {
    return {
      unavailable: clip(`the judge could not answer: ${err instanceof Error ? err.message : String(err)}`, CLIP_REASON),
    };
  }
}

/**
 * The AI mechanic judge's word on a build the director's judge looked at: only for a game that
 * declares AI (its typed word) and evidence that came back; null otherwise, and nothing is asked.
 */
export async function aiMechanicOfJudgedBuild(
  ctx: HarnessCtx,
  run: Run,
  evidence: (AiCheckEvidence & { ok?: boolean }) | null | undefined,
): Promise<AiMechanicVerdict | AiMechanicUnavailable | null> {
  if (!aiRequirementOf(run.game?.ai) || !evidence || evidence.ok !== true) return null;
  return judgeAiMechanic(ctx, run, evidence);
}
