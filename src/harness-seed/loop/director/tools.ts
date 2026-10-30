/**
 * A web game's Loop lead's run tools as its session calls them: the handler the studio forwards
 * every call to. The worker tools are the run's pool (Genex's one worker model, `loop/workers/`);
 * `judge` is a second opinion the lead asks for; `finish` checks and lands (integrate.ts).
 */
import { shortSha } from "../git.ts";
import { checkHealth, healthLine } from "../health-check.ts";
import { fireHooks, HookEvent, runScope } from "../hooks.ts";
import { HOOK_PROMPTS } from "../hooks-prompts.ts";
import { HostMethod } from "../host-methods.ts";
import { RunEvent } from "../run-events.ts";
import { askSecondOpinion, pictureFile, picturesIn, SECOND_OPINION_WORDS } from "../second-opinion.ts";
import { minutes } from "../time.ts";
import { WorkerTool } from "../workers/contract.ts";
import { capRefusesWorker, runNow } from "./cap-lines.ts";
import { retainSpan, timedOperation } from "./timing.ts";
import { plainly } from "./rules.ts";
import { DirectorTool, headSynced } from "./tool-specs.ts";
import { finishAsked, wrapUp } from "./wrap-up.ts";
import { FINISH_ASKED_NO_WORKERS } from "./wrap-up-prompts.ts";
import { BuildTarget, type LoopRun } from "./loop-run.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { MessageImage } from "../../types/host-api.d.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** What a stopped run answers every tool call with but the studio's own. */
const STOPPED_BY_USER = "STOPPED BY THE USER: the run is over; end your session now without starting anything";
/** How much of a note the journal keeps, and of its plain sentence. */
const NOTE_CHARS = 2_000;
const NOTE_PLAIN_CHARS = 400;

/** The worker tools the run's pool answers. */
const POOL_TOOLS: ReadonlySet<string> = new Set(Object.values(WorkerTool));

/** Where a build the lead names lives: the integration worktree, the live folder, or a worker's copy. */
export function resolveRoot(
  loopRun: LoopRun,
  target: unknown,
): { root: string; label: string; error?: undefined } | { error: string; root?: undefined; label?: undefined } {
  const { integrationWorktree, pool, projectDir } = loopRun;
  const named = String(target ?? BuildTarget.Integration).trim() || BuildTarget.Integration;
  if (named === BuildTarget.Integration) return { root: integrationWorktree, label: BuildTarget.Integration };
  if (named === BuildTarget.Live) return { root: projectDir, label: BuildTarget.Live };
  const record = pool?.state.records.find((one) => one.id === named);
  if (record?.worktree) return { root: record.worktree, label: record.id };
  const ids = (pool?.state.records ?? []).map((one) => one.id).join(", ") || "none started";
  return { error: `no build called "${named}" — targets are integration, live, or a worker id with a copy (${ids})` };
}

/** Where the run stands, as `run_status` answers. */
export async function statusText(loopRun: LoopRun): Promise<AnyRecord> {
  const { finalDeadline, inbox, integrationRef, integrationWorktree, pool, softDeadline, started, state } = loopRun;
  const now = Date.now();
  return {
    time: {
      elapsedMin: minutes(now - started),
      workingMinutesLeft: minutes(softDeadline - now),
      hardMinutesLeft: minutes(finalDeadline - now),
    },
    integration: {
      worktree: integrationWorktree,
      head: state.integrationHead ? shortSha(state.integrationHead) : null,
      ref: integrationRef,
      lastHealthCheck: state.integrationHealthy,
    },
    workers: (pool?.state.records ?? []).map((record) => ({
      id: record.id,
      title: record.title,
      isolation: record.isolation,
      state: record.state,
      verdict: record.verdict ?? null,
    })),
    user: { finishRequested: await inbox.finishing().catch(() => false) },
  };
}

/** `show`: offer a build to Live's Reload. */
export async function show(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { ctx, projectDir, run } = loopRun;
  const target = loopRun.resolveRoot(args.target);
  if (target.error !== undefined) return target.error;
  try {
    await ctx.call(HostMethod.PreviewLoad, {
      project: run.project,
      ...(target.root !== projectDir ? { root: target.root } : {}),
    });
    await loopRun.appendRun(RunEvent.DirectorShow, { target: target.label, root: target.root });
    const what = target.root === projectDir ? "the game folder" : target.label;
    return `Live's Reload now offers ${what}: the user sees it when they press it`;
  } catch (err: any) {
    return `could not show ${target.label}: ${err?.message ?? err}`;
  }
}

/** `note`: a card in the run's feed. */
async function noteTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const { journal } = loopRun;
  const text = String(args.text ?? "").trim();
  if (!text) return "note needs text";
  const plain = String(args.plain ?? "").trim();
  journal.director.notes.push({
    at: new Date().toISOString(),
    text: text.slice(0, NOTE_CHARS),
    plain: plainly(plain || text).slice(0, NOTE_PLAIN_CHARS),
  });
  await loopRun.saveJournal();
  await loopRun.decision(`lead: ${text}`, plain || null);
  return "noted";
}

/**
 * The pictures a second opinion looks at: the ones the lead names in the integration worktree, or —
 * none named — a screenshot of the integration build, taken with its health check.
 */
async function judgePictures(
  loopRun: LoopRun,
  args: AnyRecord,
): Promise<{ images: MessageImage[]; said: string } | { refused: string }> {
  const named = await picturesIn(loopRun.integrationWorktree, args.pictures);
  if ("refused" in named) return named;
  if (named.images.length) return { images: named.images, said: "" };
  const { ctx, integrationWorktree, run, state } = loopRun;
  state.judges += 1;
  const check = await checkHealth(ctx, {
    project: run.project,
    root: integrationWorktree,
    runId: run.runId,
    label: `director/judge_${state.judges}`,
  });
  const shot = check.picture ? await pictureFile(check.picture) : null;
  return shot ? { images: [shot], said: healthLine(check) } : { refused: healthLine(check) };
}

/** `judge`: a second opinion on pictures of the build, with the lead's question; it decides nothing. */
async function judgeTool(loopRun: LoopRun, args: AnyRecord): Promise<string> {
  const question = String(args.question ?? "").trim();
  if (!question) return SECOND_OPINION_WORDS.noQuestion;
  const pictures = await judgePictures(loopRun, args);
  if ("refused" in pictures) return pictures.refused;
  const answer = await askSecondOpinion(loopRun.ctx, { run: loopRun.run, question, images: pictures.images });
  return [pictures.said, answer].filter(Boolean).join(" ");
}

/** A worker tool, answered by the run's pool; a new worker is refused once the user asked to finish, or past the Loop's cap. */
async function poolTool(loopRun: LoopRun, name: string, args: AnyRecord): Promise<string> {
  const { pool } = loopRun;
  if (!pool) return "this run has no workers";
  if (name === WorkerTool.Start) {
    const capped = capRefusesWorker(loopRun, runNow(loopRun));
    if (capped) return capped;
    if (await finishAsked(loopRun)) return FINISH_ASKED_NO_WORKERS;
  }
  return pool.call(name, args);
}

/** The lead's `finish`, unless a plugin of the game holds it back: the lead hears why and the run goes on. */
async function finishUnlessHeld(loopRun: LoopRun, args: AnyRecord): Promise<unknown> {
  const held = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.Finish, runScope(loopRun));
  if (held.blocked) return HOOK_PROMPTS.finishHeld(held.blocked.reason);
  return loopRun.finish(args);
}

/** One tool call's answer, by its name. */
async function answer(loopRun: LoopRun, name: string, args: AnyRecord): Promise<unknown> {
  if (POOL_TOOLS.has(name)) return poolTool(loopRun, name, args);
  switch (name) {
    case DirectorTool.ResolveRoot: {
      const target = loopRun.resolveRoot(args.target);
      return target.error ?? target.root;
    }
    case DirectorTool.RunStatus:
      return JSON.stringify(await loopRun.statusText());
    case DirectorTool.Judge:
      return judgeTool(loopRun, args);
    case DirectorTool.Show:
      return loopRun.show(args);
    case DirectorTool.Note:
      return noteTool(loopRun, args);
    case DirectorTool.WrapUp:
      return wrapUp(loopRun, args);
    case DirectorTool.Finish:
      return finishUnlessHeld(loopRun, args);
    default:
      return `unknown tool: ${name}`;
  }
}

/** The handler the studio forwards every one of the lead's run tool calls to (`directors`, tool-specs.ts). */
export async function handler(loopRun: LoopRun, name: string, args: AnyRecord): Promise<unknown> {
  if (loopRun.ctx.cancelled && name !== DirectorTool.ResolveRoot) return STOPPED_BY_USER;
  loopRun.toolCalls++;
  // Counted until its answer settles: the chat never cuts a turn short inside a call (wake.ts).
  loopRun.toolsInFlight = (loopRun.toolsInFlight ?? 0) + 1;
  try {
    return await timedOperation(
      name,
      null,
      async () => {
        try {
          if (headSynced(name)) await loopRun.syncHead();
          return await answer(loopRun, name, args);
        } catch (err: any) {
          return `${name} failed: ${err?.message ?? err}`;
        }
      },
      (span) => {
        const director = loopRun.journal?.director;
        if (director) retainSpan(director, { ...span, runId: loopRun.run.runId, head: loopRun.state.integrationHead });
      },
    );
  } finally {
    loopRun.toolsInFlight = (loopRun.toolsInFlight ?? 1) - 1;
    if (loopRun.state.finished) await loopRun.saveJournal().catch(() => {});
  }
}
