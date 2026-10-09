/**
 * Chat with a contractor engine selected: pick (or scaffold) the game workspace, hand the user's
 * ask over as a brief, and log the whole thing exactly like a `delegate_to_contractor` tool call
 * so the transcript reads the same either way. With Loop on the same contractor may also ask a
 * question or launch a build, and what it records is executed here. After a run it led, the
 * same session also keeps the run's controls (after-loop-run.ts), and a resume it records — or, after a
 * finished build with Loop on, a reopen (reopen-run.ts) — is handed back for the chat to do once the
 * reply ends.
 */
import { GIT_TIMEOUT_MS, MIN_DELEGATE_TIMEOUT_MS } from "./config.ts";
import { GIT, gitAt } from "./git.ts";
import {
  buildContractorBrief,
  isContinueAsk,
  lastContractorSession,
  nameFromAsk,
  resolveChatProject,
} from "./chat-session.ts";
import type { LaunchGrant } from "./launch-prompts.ts";
// The launch tools double as a Loop chat's bridged tools (MCP for Claude, the bridge command for
// Codex) — one definition, two transports.
import { tools as launchToolset } from "../tools/game-tools.ts";
import { askUser, recordInterviewQuestion } from "./interview-question.ts";
import { afterLoopRunGrant, resumeAsked } from "./after-loop-run.ts";
import { afterLoopRunNote } from "./after-loop-run-prompts.ts";
import { commissionHours, reopenAsked, reopens } from "./reopen-run.ts";
import { type ReopenGrant, reopenRunTool } from "./reopen-run-prompts.ts";
import { steeredCall } from "./chat-steer.ts";
import { EngineFailure, StopReason } from "./outage.ts";
import { HostMethod } from "./host-methods.ts";
import { StudioContract } from "./page-contract.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { clip, CLIP_BRIEF, CLIP_GAME_TITLE } from "./text.ts";
import { SECOND_MS, sleep } from "./time.ts";
import { recordFirstPreview } from "./first-preview.ts";
import { canFallBack, runToolLoop } from "./tool-loop.ts";
import { briefSummary, goesOn } from "./chat-continuity.ts";
import { compactedSummary, endedByCompaction } from "./compaction-log.ts";
import { TurnStop, sayInTurn } from "./turn-record.ts";
import type { TurnOptions, TurnOutcome } from "./turn-loop.ts";
import type { AnyRecord, CallResult, HarnessCtx, HarnessTool, ToolCtx, ToolOutcome } from "../types/harness.d.ts";
import type {
  BuildObservation,
  ContentStamps,
  ReadyResult,
  DelegateImage,
  DelegateResult,
  Message,
  StudioToolSpec,
} from "../types/host-api.d.ts";

/** How long a loaded preview settles before it is read, when the studio cannot say whether it is up. */
const PREVIEW_SETTLE_MS = 1.5 * SECOND_MS;
/** A bare ask is shorter than this many characters… */
const BARE_ASK_CHARS = 24;
/** …and has fewer than this many words. */
const BARE_ASK_WORDS = 4;
/**
 * Whose engine call a `messages` record's `usage` reports when it is not the chat's own
 * (`usage_source`). `delegation`: a delegated turn's reply carrying its contractor's report, which
 * the turn's `build_observation` repeats; readers count that call once. Never rename a value; the
 * app's copy is `MessageUsageSource` in `shared/event-log.ts` (tests/conformance/seed-contracts.test.ts).
 * It lives here, not in run-events.ts, so a run-events.ts an agent edited and kept still loads.
 */
export const MessageUsageSource = {
  Delegation: "delegation",
} as const;
export type MessageUsageSource = (typeof MessageUsageSource)[keyof typeof MessageUsageSource];
/** The tool name the transcript records a delegation under (the app reads it as `DELEGATE_TOOL` in `shared/coordinator.ts`). */
export const DELEGATE_TOOL = "delegate_to_contractor";

/**
 * This turn serves the chat's own session after a lead's run (after-loop-run.ts): it hands the
 * session the run's controls and gives back the resume it records. chat-dispatch.ts asks before it
 * sends the chat here (`servesAfterLoopRun`); a kept copy from before would do neither.
 */
export const SERVES_AFTER_LOOP_RUN = true;

/**
 * This turn offers the chat's own session the reopen of its finished build when Loop came with the
 * message (reopen-run.ts), and gives back the reopen it records. chat-dispatch.ts asks before it
 * offers it (`servesReopen`): a kept copy from before would bridge the launch instead.
 */
export const SERVES_REOPEN = true;

/** "claude-code is throttled (usage limit reached)": an engine's outage, as a fallback names it. */
function outageWords(engine: string, kind: string, detail: string | undefined): string {
  return `${engine} is ${kind === EngineFailure.RateLimit ? "throttled" : "unreachable"} (${detail ?? kind})`;
}

/** What the chat is told. */
const MESSAGE = {
  bareAsk: "Hi! What should we make? Tell me about the game you have in mind — a sentence is enough to start.",
  delegationFailed: "delegation failed",
  alreadyBuilding: (detail: string) =>
    `${detail}. Your message was not sent to it — send it again once the current build finishes.`,
  signIn: (engineLabel: string) =>
    `${engineLabel} needs you to sign in again. Your project is still here — sign in, then Keep going.`,
  outOfUsage: (engine: string, detail: string | undefined) =>
    `${engine} is out of usage: ${detail ?? "usage limit reached"}. Nothing was built by another model — wait for the reset, sign into a different account (Review → Models → "Use a different account…"), or pick another engine and resend.`,
  continuingOn: (engine: string, kind: string, detail: string | undefined, next: string) =>
    `${outageWords(engine, kind, detail)} — continuing the run on ${next} so the build isn't lost.`,
  continuingChatOn: (engine: string, kind: string, detail: string | undefined, next: string) =>
    `${outageWords(engine, kind, detail)} — continuing on ${next}.`,
  notSwitched: (engine: string, kind: string, detail: string | undefined) =>
    `${engine} is ${kind === EngineFailure.RateLimit ? "throttled right now" : "unreachable"} (${detail ?? kind}). I didn't switch to another model — wait a bit and resend, or pick a different engine.`,
  stopped: "Stopped. Finished edits are preserved; send a message to continue.",
  /** Loop allowed the finished build to go on, and the session made the change itself. */
  madeDirectly: "Small change — made directly, no build.",
  stoppedBeforeWork: "stopped before it started",
  launchedAnyway: (ending: string) =>
    `The session ended early (${ending}) after recording the launch — starting the build anyway.`,
  resumedAnyway: (ending: string) =>
    `The session ended early (${ending}) after asking to resume the build — resuming it anyway.`,
  reopenedAnyway: (ending: string) =>
    `The session ended early (${ending}) after asking to reopen the build — reopening it anyway.`,
  loadFailed: (error: string) => `⚠ The game failed to load: ${error}`,
  blackScreen: (reasons: readonly string[]) =>
    `⚠ The game loads but ${reasons.join(" and ")} — say "fix the black screen" and I'll send the contractor back in.`,
  consoleErrors: (count: number) =>
    `⚠ The preview shows ${count} console error${count === 1 ? "" : "s"} — say "fix the console errors" and I'll send the contractor back in.`,
  loadsClean: "The game loads clean in the preview.",
  done: "Done.",
  pickUp: " — send a message to pick up where it left off",
} as const;

/** What a delegated turn works with once its chat is read and its folder chosen. */
interface Handoff {
  ask: string;
  messages: Message[];
  /** The Loop or Autopilot commission a build this chat launches runs under, if any. */
  commission: AnyRecord | null;
  /** Loop on: the tool that launches a build, bridged in with `ask_user`; null in Auto. */
  launchTool: HarnessTool | null;
  /** After a finished build the chat may reopen, with Loop on: the reopen is offered (reopen-run.ts). */
  reopening: boolean;
  /** The contractor session this chat resumes, if any. */
  resume: string | null;
  /** The handover the chat's last compaction wrote, for a fresh session's brief; null when none. */
  compacted: string | null;
  hasPriorAsk: boolean;
  project: string;
  descriptor: GameProject | null;
  projectDir: string | null;
  scaffolded: boolean;
  /** Nothing has been made in this game yet: a first message there is a blank page, not code to inspect. */
  fresh: boolean;
  /** "folder AI Games/rift", never an absolute path — the last two segments say it all. */
  folderLabel: string;
  extraReads: string[];
  /** When the build was handed over: the start its first ready preview is timed from. */
  startedAt: number;
}

type GameProject = CallResult<"game.list">[number];
type DelegatedOptions = TurnOptions & { engine: string; engineLabel: string };

/** The answer of a builder that never started: the user stopped the turn while it prepared. */
function stoppedBeforeWork(engine: string): DelegateResult {
  return {
    ok: false,
    engine,
    turns: 0,
    usage: {},
    summary: "",
    stopReason: StopReason.Stopped,
    errorText: MESSAGE.stoppedBeforeWork,
  };
}

/** Run one chat turn on a delegated engine: the ask handed to its contractor. */
export async function runDelegatedTurn(ctx: HarnessCtx, options: DelegatedOptions): Promise<TurnOutcome> {
  const { turnId, engine } = options;
  const chat = await readChat(ctx, options);
  if (isBareAskInFreshChat(chat)) {
    await sayInTurn(ctx, turnId, MESSAGE.bareAsk);
    return { stopped: TurnStop.Done, round: 0, engine };
  }
  const handoff = await placeHandoff(ctx, options, chat);
  const briefFor = await briefWriter(ctx, options, handoff);
  await recordHandoff(ctx, options, handoff);
  const callId = await recordDelegateRequest(ctx, options, handoff);
  // A read-only turn is told apart from a build by what it did to the folder's content.
  const before = options.runId ? UNKNOWN_STAMPS : await contentStamps(ctx, handoff.project);
  let result: DelegateResult;
  try {
    // A Stop while the turn prepared: no builder runs yet for it to abort, so none starts.
    result = ctx.cancelled ? stoppedBeforeWork(engine) : await delegateResuming(ctx, options, handoff, briefFor);
  } catch (err: any) {
    return handleDelegateFailure(ctx, options, handoff.project, callId, err);
  }
  await recordDelegateResult(ctx, turnId, callId, result);
  await bookmarkSession(ctx, options, handoff.project, result);
  // Stop must not launch a recorded build or start a new preview health pass.
  if (result.stopReason === StopReason.Stopped) {
    ctx.notify("game.changed", { project: handoff.project });
    await sayInTurn(ctx, turnId, MESSAGE.stopped);
    return { stopped: TurnStop.Aborted, round: 0, engine };
  }
  const change = await folderChange(ctx, handoff.project, before);
  // Anything at all refreshes the chat's view of the game; a read-only setup or status turn
  // changed nothing and keeps the current preview.
  if (change.any) ctx.notify("game.changed", { project: handoff.project });
  return finishTurn(ctx, options, handoff, `${callId}_intake`, result, change);
}

/**
 * A Loop chat's recorded question or launch is executed here, by the harness — the engine only
 * ferried it; a resume or a reopen after a run goes back to the chat. A turn that recorded none
 * was an ordinary contractor turn (an answer, research, a plan, an edit) and is reported like any
 * chat build.
 */
async function finishTurn(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  intakeId: string,
  result: DelegateResult,
  change: FolderChange,
): Promise<TurnOutcome> {
  const { launchTool } = handoff;
  const recorded = result.studioToolCalls ?? [];
  // After a paused run the session may ask to resume it: the chat does that once the reply ends.
  const resume = options.afterLoopRun ? resumeAsked(options.afterLoopRun, recorded) : null;
  if (resume) return handBack(ctx, options, result, MESSAGE.resumedAnyway, { resumeRun: resume });
  const calls = launchTool ? recorded : [];
  const question = calls.find((c) => c.name === askUser.name);
  const launch = calls.find((c) => c.name === launchTool?.name);
  // A question is not approval to start. Even if the model also recorded a launch, wait for
  // the actual answer. The same persisted session receives that answer on the next turn.
  if (result.ok && question) return askInChat(ctx, options, handoff, result, question.args, change);
  // After a finished build the session may ask to reopen it; that beats a launch recorded beside it.
  const reopen = reopenAsked(options.afterLoopRun, handoff.commission, recorded);
  if (reopen) return handBack(ctx, options, result, MESSAGE.reopenedAnyway, { reopenRun: reopen });
  if (launchTool && launch) return launchFromChat(ctx, options, handoff, launchTool, intakeId, result, launch.args);
  return reportBuild(ctx, options, handoff, result, change);
}

/** Stamps nobody took: every check that compares them runs. */
const UNKNOWN_STAMPS: ContentStamps = Object.freeze({ all: null, source: null });

/**
 * The folder's two stamps from one walk: everything, and the game's sources without docs/ and
 * Markdown. A host that predates `split` answers the full stamp as a string, which keeps the old
 * behaviour: it stands for both.
 */
async function contentStamps(ctx: HarnessCtx, project: string): Promise<ContentStamps> {
  const stamps = await ctx.call(HostMethod.GameContentStamp, { project, split: true }).catch(() => null);
  if (stamps && typeof stamps === "object") return stamps;
  return { all: stamps ?? null, source: stamps ?? null };
}

/** What a turn changed in its folder: anything at all, and the game's sources. Unknown is a change. */
interface FolderChange {
  any: boolean;
  source: boolean;
}

/**
 * Only game sources are worth loading in the preview: a research-and-plan turn on a fresh
 * scaffold once earned a "black canvas" warning, and a failed build in the learning log, for an
 * empty scene it never touched.
 */
async function folderChange(ctx: HarnessCtx, project: string, before: ContentStamps): Promise<FolderChange> {
  const stamped = Boolean(before.all || before.source);
  const after = stamped ? await contentStamps(ctx, project) : UNKNOWN_STAMPS;
  const unchanged = Boolean(before.all) && before.all === after.all;
  const sourceUnchanged = Boolean(before.source) && before.source === after.source;
  return { any: !unchanged, source: !(unchanged || sourceUnchanged) };
}

/** The chat as the turn finds it, before any folder is chosen or made. */
type ChatReading = Omit<
  Handoff,
  "project" | "descriptor" | "projectDir" | "scaffolded" | "fresh" | "folderLabel" | "extraReads" | "startedAt"
> & {
  project: string | null;
  games: GameProject[];
};

async function readChat(ctx: HarnessCtx, options: DelegatedOptions): Promise<ChatReading> {
  const { threadId, engine } = options;
  const messages = await ctx.call(HostMethod.EventsMessages, { threadId });
  const ask =
    options.text ??
    [...messages]
      .reverse()
      .find((m) => m.role === "user")
      ?.content?.trim() ??
    "";
  // A commission adds the launch tool (and ask_user) to an ordinary contractor session: the same
  // engine that answers and edits here may also commission a build.
  const commission = options.autopilot ?? options.loop ?? null;
  // After a finished build the chat may reopen, a commission offers the reopen, with the launch
  // beside it only for an explicit start over.
  const reopening = reopens(options.afterLoopRun, commission);
  const launchTool = launchToolFor(options, reopening);
  // This chat's contractor session, if any — follow-ups resume it instead of starting a new
  // mind that only sees the last line ("keep going" with no idea what the game is). Only the
  // chat's latest goes on: one another model answered after missed those turns (chat-continuity.ts).
  const events = await ctx.call(HostMethod.EventsList, { threadId });
  const latest = lastContractorSession(events);
  const prior = goesOn(latest, engine);
  // A message sent while the chat was compacted carries the session the compaction ended.
  const asked = endedByCompaction(events, options.resume) ? null : options.resume;
  const resume = asked || prior?.sessionId || null;
  // Which workspace gets the brief: THIS chat's folder, never the preview and never "the
  // newest game". Those two fallbacks were how a follow-up quietly wandered into a sibling.
  const games = await ctx.call(HostMethod.GameList);
  const project = resolveChatProject(options, games) ?? priorProject(latest, games);
  // A prior real ask means this chat is mid-conversation, whatever happened to its session.
  const hasPriorAsk = messages.some((m) => m.role === "user" && m.content?.trim() && m.content.trim() !== ask);
  // A fresh session mid-conversation is briefed with a summary when its brief cannot carry it.
  const compacted =
    resume || !hasPriorAsk
      ? compactedSummary(events)
      : await briefSummary(ctx, { threadId, engine, model: options.model, events });
  return { ask, messages, commission, launchTool, reopening, resume, compacted, hasPriorAsk, project, games };
}

/**
 * The tool a Loop chat may launch its build with: Autopilot's, or the Loop's. After a run, only
 * beside the reopen of a finished build, for an explicit start over: a commission after any other
 * run (a paused one, one the chat may not reopen, an interview's restored onto the reply) is none.
 */
function launchToolFor(options: DelegatedOptions, reopening: boolean): HarnessTool | null {
  const name = launchToolName(options);
  if (!name) return null;
  if (options.afterLoopRun && !reopening) return null;
  return launchToolset.find((t) => t.name === name) ?? null;
}

function launchToolName(options: DelegatedOptions): string | null {
  if (options.autopilot) return "start_autopilot";
  if (options.loop) return "start_unattended_run";
  return null;
}

/** The folder the chat's last contractor session worked in, while it still exists. */
function priorProject(prior: { project?: string } | null, games: readonly GameProject[]): string | null {
  const project = prior?.project;
  if (!project || !games.some((g) => g.name === project)) return null;
  return project;
}

/**
 * A contractor session costs minutes and cannot ask anything back — the brief is one-way.
 * A tiny ask ("hi") in a genuinely fresh chat is never a brief: answer, don't build. But a
 * chat bound to a game, or one with an ask already behind it, is mid-iteration — "add fog"
 * there is an instruction, and deflecting it stalled every short follow-up.
 */
function isBareAskInFreshChat(chat: ChatReading): boolean {
  const freshChat = !chat.launchTool && !chat.resume && !chat.project && !chat.hasPriorAsk;
  if (!freshChat || isContinueAsk(chat.ask)) return false;
  const words = chat.ask.split(/\s+/).filter(Boolean);
  return chat.ask.length < BARE_ASK_CHARS && words.length < BARE_ASK_WORDS;
}

/** The folder the brief goes to: the chat's own, or a new one named from the ask. */
async function placeHandoff(ctx: HarnessCtx, options: DelegatedOptions, chat: ChatReading): Promise<Handoff> {
  const { games, ...reading } = chat;
  const extraReads = Array.isArray(options.extraReads) ? options.extraReads : [];
  if (chat.project) {
    // The folder's own descriptor, not just its path: a chat build is briefed about the shape it
    // is working in, the way every run brief already is (autopilot.ts, director.ts).
    const descriptor = games.find((g) => g.name === chat.project) ?? null;
    const projectDir = descriptor?.dir ?? null;
    return {
      ...reading,
      project: chat.project,
      descriptor,
      projectDir,
      scaffolded: false,
      fresh: await isFreshGame(ctx, chat, descriptor),
      folderLabel: folderLabel(projectDir, chat.project),
      extraReads,
      startedAt: Date.now(),
    };
  }
  const base = nameFromAsk(chat.ask);
  let name = base;
  for (let n = 2; games.some((g) => g.name === name); n++) name = `${base}-${n}`;
  // threadId rides along so an unbound "new game" chat becomes this project's chat.
  const created = await ctx.call(HostMethod.GameScaffold, {
    name,
    title: chat.ask.slice(0, CLIP_GAME_TITLE) || name,
    threadId: options.threadId,
  });
  const project = created.name as string;
  return {
    ...reading,
    project,
    descriptor: created,
    projectDir: created.dir,
    scaffolded: true,
    fresh: true,
    folderLabel: folderLabel(created.dir, project),
    extraReads,
    startedAt: Date.now(),
  };
}

/**
 * Has nothing been made in this game yet? Asked only of a chat's first message, and only of the
 * studio's own template: a game the studio just made is its one commit with nothing changed since.
 * A look that fails says no, and the brief continues from the code as it always did.
 */
async function isFreshGame(ctx: HarnessCtx, chat: ChatReading, descriptor: GameProject | null): Promise<boolean> {
  const firstMessage = !chat.hasPriorAsk && !chat.resume && !chat.compacted;
  if (!firstMessage || !descriptor || descriptor.shape?.own) return false;
  const where = { project: descriptor.name };
  const options = { timeoutMs: GIT_TIMEOUT_MS.quick };
  try {
    const commits = await gitAt(ctx, where, GIT.commitCount, options);
    const changes = await gitAt(ctx, where, GIT.status, options);
    return commits.trim() === "1" && changes.trim() === "";
  } catch {
    return false;
  }
}

/** "folder AI Games/rift", never an absolute path — the last two segments say it all. */
function folderLabel(projectDir: string | null | undefined, project: string): string {
  return projectDir ? projectDir.split("/").slice(-2).join("/") : project;
}

/**
 * The contractor's brief, for the session this chat resumes or for a new one (a session that
 * cannot be resumed is started afresh): a build's, with a Loop chat's launch rules.
 */
async function briefWriter(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
): Promise<(resumed: boolean) => string> {
  const { ask, messages, folderLabel, descriptor } = handoff;
  const missing = await contractMissing(ctx, handoff);
  // A reopen's rules live in the after-run note: a change goes to the build, not to a launch.
  const launch = handoff.reopening ? null : launchGrant(handoff);
  return (resumed) =>
    buildContractorBrief({
      ask,
      messages,
      resume: resumed,
      extraReads: handoff.extraReads,
      folderLabel,
      scaffolded: handoff.scaffolded,
      fresh: handoff.fresh,
      shape: descriptor?.shape ?? null,
      ownShape: descriptor?.built === true,
      contractMissing: missing,
      // The one thing in the brief that is spelled per engine (M4.8b): a Codex session cannot
      // call an mcp__ name and a Claude session cannot run the bridge command.
      engine: options.engine,
      launch,
      afterLoopRun: options.afterLoopRun
        ? afterLoopRunNote(options.afterLoopRun, options.engine, reopenGrant(handoff))
        : null,
      compacted: handoff.compacted,
    });
}

/** The finished build's reopen as the after-run note words it, when this turn offers it; else null. */
function reopenGrant(handoff: Handoff): ReopenGrant | null {
  if (!handoff.reopening) return null;
  const { commission, launchTool } = handoff;
  return {
    hours: commissionHours(commission),
    frameCount: (commission?.frames ?? []).length,
    project: handoff.project,
    launchTool: launchTool?.name ?? null,
  };
}

/**
 * Loop on: the chat is still a contractor — it answers, researches or edits itself — and may
 * also launch a build when the ask is one. The composer's hours are that build's budget.
 */
function launchGrant(handoff: Handoff): LaunchGrant | null {
  const { launchTool, commission } = handoff;
  if (!launchTool) return null;
  return {
    toolName: launchTool.name,
    hours: typeof commission?.hours === "number" ? commission.hours : null,
    frameCount: (commission?.frames ?? []).length,
    project: handoff.project,
  };
}

/**
 * A game the user brought that never loads the studio contract cannot be judged by anyone
 * (M2.6): the run's first step wires it in, and a chat build is the faster way to the same
 * place, so its brief says so before the ask. Only for a folder that is somebody's own game
 * — the studio's template already has it — and only when a brief is actually written: a
 * resumed session keeps the context it already has.
 */
async function contractMissing(ctx: HarnessCtx, handoff: Handoff): Promise<boolean> {
  const briefForBuiltGame = !handoff.resume && handoff.descriptor?.built === true;
  if (!briefForBuiltGame) return false;
  const readiness = await ctx.call(HostMethod.GameValidate, { project: handoff.project }).catch(() => null);
  return readiness?.contract === StudioContract.Missing;
}

/** "Claude Code (opus) · high effort": who the contractor is, as the handoff names it. */
function effortLabel(options: DelegatedOptions): string {
  const { engineLabel, model, effort } = options;
  const modelBit = model && model !== "default" ? ` (${model})` : "";
  const effortBit = effort ? ` · ${effort} effort` : "";
  return `${engineLabel}${modelBit}${effortBit}`;
}

/** The handoff line the transcript records: who takes the ask, where, and how. */
function handoffText(options: DelegatedOptions, handoff: Handoff): string {
  const who = effortLabel(options);
  const { project, folderLabel, resume } = handoff;
  const where = `**${project}** (folder \`${folderLabel}\`)`;
  if (handoff.launchTool) {
    if (resume)
      return `${who} continues in **${project}** — same session, its context restored. Loop is on, so it may start a build.`;
    return `${where} — ${who} answers or changes the game itself; Loop is on, so it starts a build when the ask needs one.`;
  }
  if (resume) return `Resuming the contractor in ${where} — same chat, its context restored.`;
  return [
    buildOpening(handoff, where),
    `${who} works alone and can't ask questions mid-build, so it builds from this chat. It shows checkpoints in the preview as it goes and reports back here when done.`,
  ].join(" ");
}

function buildOpening(handoff: Handoff, where: string): string {
  if (handoff.scaffolded) return `Starting a new project ${where} for this brief.`;
  const followUp = Boolean(handoff.resume) || handoff.hasPriorAsk;
  if (followUp)
    return `Handing this back to the contractor in ${where} — same chat, continuing from the code already there.`;
  return `Handing this to the contractor in ${where} — it will continue from the code already there.`;
}

/**
 * Preserve handoff identity for diagnostics; live status and the project header already
 * explain the context. Host bookkeeping must not become an assistant chat bubble.
 */
async function recordHandoff(ctx: HarnessCtx, options: DelegatedOptions, handoff: Handoff): Promise<void> {
  const { engine, model, turnId } = options;
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.ContractorHandoff,
        payload: {
          project: handoff.project,
          engine,
          model,
          resumed: Boolean(handoff.resume),
          launch: handoff.launchTool?.name ?? null,
          text: handoffText(options, handoff),
        },
      },
    ],
  });
}

/** Log the delegation as a tool call, and say what the contractor is doing. Returns the call's id. */
async function recordDelegateRequest(ctx: HarnessCtx, options: DelegatedOptions, handoff: Handoff): Promise<string> {
  const { turnId, engine, engineLabel } = options;
  const { project, resume } = handoff;
  const callId = `dlg_${Date.now().toString(36)}`;
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.ToolRequested,
        tool_call_id: callId,
        request: {
          name: DELEGATE_TOOL,
          arguments: { project, engine, brief: handoff.ask, ...(resume ? { resume } : {}) },
        },
      },
    ],
  });
  ctx.notify("tool.started", { name: DELEGATE_TOOL, id: callId });
  ctx.setStatus?.(`${engineLabel} building ${project}`);
  return callId;
}

/**
 * Hands and eyes for every build: the capture tool and the computer
 * tool over a pooled window of this folder — a run's single builder and a chat build alike,
 * Loop or not.
 */
function senses(options: DelegatedOptions, handoff: Handoff): AnyRecord {
  const { project, projectDir } = handoff;
  if (!projectDir) return {};
  return {
    selfCapture: {
      project,
      root: projectDir,
      ...(options.runId ? { runId: options.runId, facetId: "build", iteration: options.iteration ?? 0 } : {}),
      ...(options.setup ? { setup: options.setup } : {}),
      label: options.runId ? "builder" : project,
    },
  };
}

/** A Loop chat's own tools, bridged in: its launch, and its question. */
function bridgedTools(launchTool: HarnessTool): StudioToolSpec[] {
  return [
    { name: launchTool.name, description: launchTool.description, parameters: launchTool.parameters },
    { name: askUser.name, description: askUser.description, parameters: askUser.parameters },
  ] as StudioToolSpec[];
}

/**
 * What the session is handed beside its own tools: a Loop chat's launch and question; after a run it
 * led, the run's controls, a paused run's resume, and — reopening a finished build — the reopen
 * first, beside the launch for a start over.
 */
function sessionTools(options: DelegatedOptions, handoff: Handoff): AnyRecord {
  const launch = handoff.launchTool ? bridgedTools(handoff.launchTool) : [];
  if (!options.afterLoopRun) return launch.length ? { interviewTools: launch } : {};
  const grant = afterLoopRunGrant(options.afterLoopRun);
  const reopen = handoff.reopening ? [reopenRunTool] : [];
  const interviewTools = [...reopen, ...launch, ...(grant.interviewTools ?? [])];
  return { runControls: grant.runControls, ...(interviewTools.length ? { interviewTools } : {}) };
}

/** The pictures the message itself carries. */
function messageStills(options: DelegatedOptions): DelegateImage[] {
  return options.stills ?? [];
}

/**
 * The Loop mood board reaches a new session once; a resumed one already has it, and a Loop chat
 * may run many turns before (or without) a build. The message's own stills replace it.
 */
function moodBoard(options: DelegatedOptions, handoff: Handoff, resumeId: string | null | undefined): DelegateImage[] {
  if (options.stills || resumeId) return [];
  return handoff.commission?.frames ?? [];
}

/** Hand `prompt` and its pictures to the contractor, resuming `resumeId` when there is one. */
function delegate(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  prompt: string,
  resumeId: string | null | undefined,
  images: DelegateImage[],
): Promise<DelegateResult> {
  const { engine, threadId, model, effort } = options;
  const { extraReads } = handoff;
  const pictures = [...images, ...moodBoard(options, handoff, resumeId)];
  return ctx.call(HostMethod.EngineDelegate, {
    engine,
    project: handoff.project,
    threadId,
    prompt,
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(options.preferences ? { preferences: options.preferences } : {}),
    ...(resumeId ? { resume: resumeId } : {}),
    ...(extraReads.length ? { extraReads } : {}),
    ...senses(options, handoff),
    ...(pictures.length ? { images: pictures } : {}),
    // A Loop chat's launch; after a run it led, the run's controls and what it may record.
    ...sessionTools(options, handoff),
    // A run's contractor gets what is left on the run's clock — never less than a minute,
    // so a build started at the wire still gets to report something. Chat builds carry no
    // deadline and fall to the studio's default ceiling.
    ...(options.deadlineMs ? { timeoutMs: Math.max(MIN_DELEGATE_TIMEOUT_MS, options.deadlineMs - Date.now()) } : {}),
    // This session is the chat's current turn: what the person sends meanwhile reaches it.
    ...(options.steer ? { chatTurn: { messageId: options.steer.messageId } } : {}),
  });
}

/**
 * Delegate the brief as the chat's current turn (chat-steer.ts), so a message sent meanwhile
 * reaches it; a session that cannot be resumed is started afresh with a full brief.
 */
async function delegateResuming(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  briefFor: (resumed: boolean) => string,
): Promise<DelegateResult> {
  return steeredCall(ctx, options.steer, {
    prompt: briefFor(Boolean(handoff.resume)),
    resume: handoff.resume,
    images: messageStills(options),
    call: (prompt, resume, images) => delegate(ctx, options, handoff, prompt, resume, images),
    // A Loop chat that starts afresh keeps its launch rules and the folder's shape.
    fresh: () => briefFor(false),
  });
}

/**
 * A delegation that threw. A busy workspace and an expired sign-in are answers; a usage cap and
 * a throttle are said plainly (a commissioned run survives a throttle on the fallback engine).
 * Anything a run's own engine-health policies must count is rethrown.
 */
async function handleDelegateFailure(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  project: string,
  callId: string,
  err: any,
): Promise<TurnOutcome> {
  const { turnId, engine, engineLabel } = options;
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.ToolResult,
        tool_call_id: callId,
        result: { ok: false, content: err?.message ?? MESSAGE.delegationFailed },
      },
    ],
  });
  ctx.notify("tool.finished", { name: DELEGATE_TOOL, id: callId, ok: false });
  // Only one contractor per project — a busy workspace is an answer, not a failure.
  if (/already building/.test(err?.message ?? "")) {
    await sayInTurn(ctx, turnId, MESSAGE.alreadyBuilding(err.message));
    return { stopped: TurnStop.Done, round: 0, engine };
  }
  const fallbacks: string[] = err?.fallbacks ?? [];
  const kind: string = err?.kind ?? EngineFailure.Other;
  // Auth is a sign-in problem, not a failover: swapping in the local model hides the
  // button the user needs. Rate limits still fall back so an unattended run survives a throttle.
  if (kind === EngineFailure.Auth) return askToSignIn(ctx, turnId, engine, engineLabel, err?.message ?? "");
  // A run's build turn answers to the gauntlet's own engine-health policies (strikes,
  // throttle waits, usage_limit preservation) — rethrow anything it must count, and let
  // only the fallback case through so a run survives a throttle.
  if (options.runId && !canFallBack(kind, fallbacks)) throw err;
  if (kind === EngineFailure.UsageLimit) {
    await sayInTurn(ctx, turnId, MESSAGE.outOfUsage(engine, err?.message));
    return { stopped: TurnStop.EngineLimited, round: 0, engine };
  }
  if (!canFallBack(kind, fallbacks)) throw err;
  return fallBackOrStop(ctx, options, project, fallbacks[0], kind, err?.message);
}

/** The sign-in the engine needs, where the user can act on it. */
async function askToSignIn(
  ctx: HarnessCtx,
  turnId: string,
  engine: string,
  engineLabel: string,
  detail: string,
): Promise<TurnOutcome> {
  const content = MESSAGE.signIn(engineLabel);
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      { type: EventKind.Custom, event_type: RunEvent.NeedsSignin, payload: { engine, message: detail } },
      { type: EventKind.Messages, messages: [{ role: "assistant", content }] },
    ],
  });
  ctx.notify("chat.message", { role: "assistant", content });
  ctx.notify("engine.auth", { engine, message: detail });
  return { stopped: TurnStop.NeedsSignin, round: 0, engine };
}

/**
 * A throttle with a fallback engine named. A commissioned run or a run's build turn survives
 * on the fallback — but out loud; a chat build says so and leaves the choice to the user.
 */
async function fallBackOrStop(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  project: string,
  next: string,
  kind: string,
  detail: string | undefined,
): Promise<TurnOutcome> {
  const { turnId, engine } = options;
  if (!fallsBack(options)) {
    await sayInTurn(ctx, turnId, MESSAGE.notSwitched(engine, kind, detail));
    return { stopped: TurnStop.EngineLimited, round: 0, engine };
  }
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.EngineFallback,
        payload: { from: engine, to: next, kind, message: detail ?? "" },
      },
    ],
  });
  const said = options.runId ? MESSAGE.continuingOn : MESSAGE.continuingChatOn;
  await sayInTurn(ctx, turnId, said(engine, kind, detail, next));
  ctx.notify("engine.fallback", { from: engine, to: next, kind });
  // The folder this turn resolved (or scaffolded) is the chat's: the fallback works in it, and a
  // launch it records is stamped with it, exactly like a delegated launch.
  const outcome = await runToolLoop(ctx, { ...options, project, newProject: false, engine: next, model: undefined });
  return withChatProject(outcome, project);
}

/**
 * A throttle falls back for a run's work or a chat that may launch one — never for the chat's own
 * session after its run, whose reply a fallback engine could not give (its tools, its session).
 */
function fallsBack(options: DelegatedOptions): boolean {
  if (options.runId) return true;
  return !options.afterLoopRun && Boolean(options.loop || options.autopilot);
}

/** The delegation's answer, as the tool call's result. */
async function recordDelegateResult(
  ctx: HarnessCtx,
  turnId: string,
  callId: string,
  result: DelegateResult,
): Promise<void> {
  const content = result.ok
    ? `Contractor finished in ${result.turns} turns: ${result.summary}`
    : `Contractor stopped after ${result.turns} turns (${result.stopReason ?? StopReason.Error})${result.errorText ? `: ${result.errorText}` : ""}`;
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.ToolResult, tool_call_id: callId, result: { ok: result.ok, content } }],
  });
  ctx.notify("tool.finished", { name: DELEGATE_TOOL, id: callId, ok: result.ok });
}

/**
 * The chat IS the contractor session. Bookmark the id on every result that has one — not
 * only on a stop — so the next message in this chat resumes instead of starting over. The model
 * it was opened on rides along: a run this chat launches leads from this session only on the
 * same engine and model (director/lead-session.ts).
 */
async function bookmarkSession(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  project: string,
  result: DelegateResult,
): Promise<void> {
  if (!result.sessionId) return;
  const { turnId, engine } = options;
  const { sessionId } = result;
  const model = options.model ?? null;
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.ContractorSession,
        payload: { project, engine, sessionId, model },
      },
      ...(result.ok
        ? []
        : [
            {
              type: EventKind.Custom,
              event_type: RunEvent.DelegationIncomplete,
              payload: {
                project,
                engine,
                sessionId,
                stopReason: result.stopReason ?? StopReason.Error,
                model: result.model ?? null,
                requestedModel: result.requestedModel ?? null,
                cliVersion: result.cliVersion ?? null,
                cliPath: result.cliPath ?? null,
                usage: result.usage ?? null,
                billing: result.billing ?? null,
              },
            },
          ]),
    ],
  });
}

/** The Loop chat asked: code it changed first is checked like any chat build's, then the question is recorded. */
async function askInChat(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  result: DelegateResult,
  args: AnyRecord,
  change: FolderChange,
): Promise<TurnOutcome> {
  const { turnId, engine } = options;
  const check = change.source ? await lookAtBuild(ctx, options, handoff, result) : NOTHING_SEEN;
  const said = [result.summary?.trim(), check.health].filter(Boolean).join("\n\n");
  if (said) await sayInTurn(ctx, turnId, said);
  await recordInterviewQuestion({ ...ctx, ...options, turnId } as ToolCtx, args);
  return { stopped: TurnStop.Done, round: 0, engine };
}

/**
 * After its run the session asked for the build again — a paused run resumed, a finished one
 * reopened: its reply is said, and what it asked goes back to the chat in `details`, which does it once
 * the turn has ended (after-loop-run.ts `resumeAfterReply`, reopen-run.ts `reopenAfterReply`) — the
 * run's lead is this same session. No preview pass: the reply edits nothing.
 */
async function handBack(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  result: DelegateResult,
  anyway: (ending: string) => string,
  details: AnyRecord,
): Promise<TurnOutcome> {
  const { turnId, engine } = options;
  const summary = result.summary?.trim();
  if (summary) await sayInTurn(ctx, turnId, summary);
  // The session was told the build goes on when its reply ends, and it does: the ending is said.
  if (!result.ok) await sayInTurn(ctx, turnId, anyway(endingOf(result)));
  return { stopped: TurnStop.Done, round: 0, engine, details };
}

/** How a session that did not end well ended, for the chat: its stop reason, and what it said. */
function endingOf(result: DelegateResult): string {
  return `${result.stopReason ?? StopReason.Error}${result.errorText ? `: ${result.errorText}` : ""}`;
}

/**
 * The Loop chat recorded a launch: its reply is said, then the launch runs. No preview pass here;
 * the build looks at its own starting point. A session that ended badly AFTER recording the
 * launch — a deadline, a late notice from the engine — still launches: the studio told it "the
 * build starts when your reply ends", and it keeps that word rather than asking the user to say
 * "start" to a session that believes it already did.
 */
async function launchFromChat(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  launchTool: HarnessTool,
  intakeId: string,
  result: DelegateResult,
  args: AnyRecord | undefined,
): Promise<TurnOutcome> {
  const { turnId } = options;
  const summary = result.summary?.trim();
  if (summary) await sayInTurn(ctx, turnId, summary);
  if (!result.ok) await sayInTurn(ctx, turnId, MESSAGE.launchedAnyway(endingOf(result)));
  return executeLaunch(ctx, options, handoff.project, launchTool, intakeId, args ?? {});
}

/** Execute the launch the chat recorded, logged as its own tool call. */
async function executeLaunch(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  project: string,
  launchTool: HarnessTool,
  intakeId: string,
  args: AnyRecord,
): Promise<TurnOutcome> {
  const { turnId, engine, model } = options;
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      { type: EventKind.ToolRequested, tool_call_id: intakeId, request: { name: launchTool.name, arguments: args } },
    ],
  });
  // The launch tool reads only the commission and the engine off its ctx; it answers a record.
  const toolResult = (await launchTool.execute(args, {
    engine,
    model,
    ...(options.loop ? { loop: options.loop } : {}),
    ...(options.autopilot ? { autopilot: options.autopilot } : {}),
  } as ToolCtx)) as ToolOutcome;
  const content = toolResult.content ?? "";
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.ToolResult,
        tool_call_id: intakeId,
        result: { ok: toolResult.ok === true, content },
      },
    ],
  });
  await sayInTurn(ctx, turnId, content);
  const run = toolResult.stopTurn === TurnStop.LaunchRun ? toolResult.details?.run : null;
  if (!run) return { stopped: TurnStop.Done, round: 0, engine };
  return withChatProject({ stopped: TurnStop.LaunchRun, round: 0, engine, details: toolResult.details }, project);
}

/**
 * The folder is the chat's, not the session's. This turn resolved (or scaffolded) it before the
 * session said a word, so a launch is stamped with it — the run the interviewer's own slug
 * won, a second empty folder appeared beside the chat and the run built in it while the user
 * typed into the first.
 */
function withChatProject(outcome: TurnOutcome, project: string): TurnOutcome {
  const run = outcome.stopped === TurnStop.LaunchRun ? outcome.details?.run : null;
  if (!run || !project) return outcome;
  return { ...outcome, details: { ...outcome.details, run: { ...run, project } } };
}

/** What the preview showed of a finished build. */
interface PreviewCheck {
  health: string | null;
  consoleErrors: number;
  observation: BuildObservation | null;
  /** What `preview.ready` answered, and when; null when the preview could not be asked. */
  ready: ReadyResult | null;
  readyAt: number | null;
}

/** A turn that changed no game source is not looked at. */
const NOTHING_SEEN: PreviewCheck = Object.freeze({
  health: null,
  consoleErrors: 0,
  observation: null,
  ready: null,
  readyAt: null,
});

/**
 * USE the studio's own senses: load the game and see whether it actually runs, instead of
 * taking the contractor's word for it (the first build shipped with zero verification), and
 * record what was seen.
 */
async function lookAtBuild(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  result: DelegateResult,
): Promise<PreviewCheck> {
  ctx.setStatus?.(`checking ${handoff.project} in the preview`);
  const check = await checkPreview(ctx, handoff.project);
  await recordBuildObservation(ctx, options.turnId, handoff, result, check);
  if (check.readyAt !== null) {
    const build = {
      threadId: options.threadId,
      project: handoff.project,
      runId: options.runId,
      startedAt: handoff.startedAt,
    };
    await recordFirstPreview(ctx, build, check.ready, check.readyAt);
  }
  return check;
}

/**
 * A finished chat turn: if it changed the game's sources, look at it in the preview and record
 * what was seen, then report back in the chat. A turn that wrote only docs/ or Markdown (a plan,
 * research notes) and a read-only setup or status turn are not fed into the build accounting:
 * the preview would show the unrelated blank starter or error state.
 */
async function reportBuild(
  ctx: HarnessCtx,
  options: DelegatedOptions,
  handoff: Handoff,
  result: DelegateResult,
  change: FolderChange,
): Promise<TurnOutcome> {
  const { turnId, engine } = options;
  const check = change.source ? await lookAtBuild(ctx, options, handoff, result) : NOTHING_SEEN;
  // A finished build Loop could have reopened, changed by the session's own hands: say so, since
  // the person picked a Loop and no build started (golden-boot-glory).
  const direct = handoff.reopening && change.source && result.ok ? MESSAGE.madeDirectly : null;
  // Model, turns, time and cost stay in the recorded report above; chat replies carry no
  // per-message model labels, and there is no Continue button: a message continues the work.
  const content = [buildSummary(result), check.health, direct].filter(Boolean).join("\n\n");
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.Messages,
        messages: [{ role: "assistant", content }],
        usage: { ...(result.usage ?? {}), ...(result.model ? { model: String(result.model) } : {}), engine },
        // The contractor's report, which the build record above repeats: readers count it once.
        usage_source: MessageUsageSource.Delegation,
      },
    ],
  });
  ctx.notify("chat.message", { role: "assistant", content });
  return { stopped: TurnStop.Done, round: 0, engine };
}

/**
 * Load the game in the preview, wait for it to say it is up, and read its status, console and
 * pixels. Headless: nothing seen.
 */
async function checkPreview(ctx: HarnessCtx, project: string): Promise<PreviewCheck> {
  const check: PreviewCheck = { ...NOTHING_SEEN };
  try {
    const loadedAt = Date.now();
    await ctx.call(HostMethod.PreviewLoad, { project });
    check.ready = await awaitPreview(ctx);
    check.readyAt = Date.now();
    const status = await ctx.call(HostMethod.PreviewStatus);
    const entries = await ctx.call(HostMethod.PreviewConsole, { sinceMs: loadedAt });
    check.consoleErrors = entries.filter((entry) => entry.level === "error").length;
    // A clean console can sit over a black screen — the pixel probe is the second witness.
    check.observation = await ctx.call(HostMethod.PreviewObserve, {}).catch(() => null);
    check.health = healthLine(status.loadError, check.observation, check.consoleErrors);
  } catch {
    /* headless */
  }
  return check;
}

/**
 * Readiness is a fact the page reports, not a sleep: `preview.ready` answers as soon as the page
 * is up (a page that reports nothing gets the same short grace the sleep gave). The person's own
 * window is never clicked for a gesture. A studio that cannot answer gets the old settle.
 */
async function awaitPreview(ctx: HarnessCtx): Promise<ReadyResult | null> {
  const ready = await ctx.call(HostMethod.PreviewReady, { gesture: false }).catch(() => null);
  if (ready && typeof ready.ready === "boolean") return ready;
  await sleep(PREVIEW_SETTLE_MS);
  return null;
}

/** What a build's record keeps of the readiness answer. */
function readyRecord(ready: ReadyResult | null) {
  if (!ready) return null;
  const { ms, pageMs, timedOut, via, phase, reason } = ready;
  return { ready: ready.ready, ms, pageMs, timedOut, via, phase, reason };
}

function healthLine(
  loadError: string | null | undefined,
  observation: BuildObservation | null,
  consoleErrors: number,
): string {
  if (loadError) return MESSAGE.loadFailed(loadError);
  if (observation && !observation.ok) return MESSAGE.blackScreen(observation.reasons);
  if (consoleErrors > 0) return MESSAGE.consoleErrors(consoleErrors);
  return MESSAGE.loadsClean;
}

/**
 * The build becomes food for self-improvement: SkillOpt mines these observations the same
 * way it mines run iterations, so chat builds teach the studio too. `ok` is the whole truth —
 * the contractor's word AND what the screen showed — so a black build is a lesson, not a win.
 */
async function recordBuildObservation(
  ctx: HarnessCtx,
  turnId: string,
  handoff: Handoff,
  result: DelegateResult,
  { consoleErrors, observation, ready }: PreviewCheck,
): Promise<void> {
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.BuildObservation,
        payload: {
          project: handoff.project,
          brief: clip(handoff.ask, CLIP_BRIEF),
          ok: result.ok && observation?.ok !== false,
          consoleErrors,
          reason: observation?.reasons?.length ? observation.reasons.join("; ") : null,
          observation: observation ? observationRecord(observation) : null,
          summary: clip(result.summary, CLIP_BRIEF),
          model: result.model ?? null,
          requestedModel: result.requestedModel ?? null,
          cliVersion: result.cliVersion ?? null,
          cliPath: result.cliPath ?? null,
          sessionId: result.sessionId ?? null,
          cost_usd: result.usage?.cost_usd ?? null,
          billing: result.billing ?? null,
          stopReason: result.stopReason ?? (result.ok ? StopReason.Completed : StopReason.Error),
          durationMs: result.durationMs ?? null,
          turns: result.turns ?? null,
          usage: result.usage ?? null,
          ready: readyRecord(ready),
        },
      },
    ],
  });
}

function observationRecord(observation: BuildObservation) {
  return {
    ok: observation.ok,
    reasons: observation.reasons,
    pixels: observation.pixels,
    frameBefore: observation.frameBefore,
    frameAfter: observation.frameAfter,
    frameAdvanced: observation.frameAdvanced,
    running: observation.running,
    fps: observation.fps,
    studioMissing: observation.studioMissing,
  };
}

/** What the chat is told of a finished build, before the preview's word on it. */
function buildSummary(result: DelegateResult): string {
  if (result.ok) return result.summary?.trim() || MESSAGE.done;
  const pickUp = result.sessionId ? MESSAGE.pickUp : "";
  if (result.stopReason === StopReason.Stopped) return `Stopped. Finished edits are kept in your game${pickUp}.`;
  const said = result.summary?.trim() ? `\n\n${result.summary.trim()}` : "";
  return `The build stopped early (${result.errorText ?? result.stopReason ?? StopReason.Error}). Its work so far is kept in your game${pickUp}.${said}`;
}
