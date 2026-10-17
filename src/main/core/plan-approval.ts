/**
 * Plan mode in a chat's own session, approved with the plan card (`tool_permission`,
 * `ExitPlanMode`) as Claude Code's own plan is mid-turn.
 *
 * On an engine that shows its plan by ending its turn (`plansByTurn`: Codex, Bonsai), a session in
 * Plan only reads and replies with a plan; the host then asks the person. Approved, the same session
 * goes on in the mode the person chose, which the permission service has kept on the chat; sent back
 * with words, it plans again with them; any other ending (a Stop, a withdrawn card, a reply that
 * asked a question) leaves the turn as it ended.
 *
 * On every engine that plans, a build the session recorded to start (`BuildLaunch`) while the chat
 * is still in Plan waits behind the same card: the harness starts a recorded build once the reply
 * ends, and nothing else would hold it. Approved, it starts as recorded, in the mode chosen; sent
 * back with words, it is dropped and the session plans again; any other ending, a question beside
 * it or a failed turn drops it.
 */
import { randomUUID } from "node:crypto";
import { BuildLaunch, isBuildLaunch } from "../../shared/coordinator.ts";
import {
  engineMode,
  PermissionDecision,
  PermissionMode,
  permissionModesFor,
  PLAN_TOOL,
  plansByTurn,
} from "../../shared/permissions.ts";
import type { ModelTokenUsage, Usage } from "../../shared/event-log.ts";
import type {
  DelegatePermissions,
  DelegateRequest,
  DelegateResult,
  PermissionReply,
} from "../../substrate/engines/types.ts";
import { MODEL_ROW_COUNTS } from "../../substrate/engines/session-cost.ts";
import { planApprovedNote, planRevisionNote } from "./delegation-prompts.ts";

/** How many times one turn's plan may be sent back and planned again before the turn just ends. */
const MAX_PLAN_REVISIONS = 20;

/** What the plan card adds for a build held back: what it would build. */
const MESSAGE = {
  build: (ask: string) => `**Build to start:** ${ask}`,
} as const;

/** The argument in which each held build says what it would build. */
const LAUNCH_ASK: Record<BuildLaunch, string> = {
  [BuildLaunch.StartAutopilot]: "goal",
  [BuildLaunch.StartUnattendedRun]: "goal",
  [BuildLaunch.ReopenRun]: "text",
  [BuildLaunch.ResumeRun]: "text",
};

type StudioCall = NonNullable<DelegateResult["studioToolCalls"]>[number];

/** What the session does next after the person answered its plan, or null when the turn ends. */
interface PlanNext {
  mode: PermissionMode;
  prompt: string;
}

/** The person's answer to a plan, as the next pass of the session. */
function nextPass(engine: string, reply: PermissionReply): PlanNext | null {
  if (reply.decision === PermissionDecision.ApprovePlan)
    return { mode: engineMode(engine, reply.mode), prompt: planApprovedNote() };
  const words = reply.decision === PermissionDecision.Deny && !("withdrawn" in reply) ? reply.message?.trim() : "";
  return words ? { mode: PermissionMode.Plan, prompt: planRevisionNote(words) } : null;
}

/** A reply that is a plan to approve: a whole turn with words, a session to continue, and nothing launched or asked. */
function isPlanReply(result: DelegateResult): result is DelegateResult & { sessionId: string } {
  const plain = !result.studioToolCalls?.length;
  return result.ok && plain && Boolean(result.summary.trim()) && typeof result.sessionId === "string";
}

/** The counts of a pass's usage that are its own, and so add up across the passes of one turn. */
const PASS_COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "reasoning_tokens",
  "cost_usd",
  "compactions",
] as const satisfies ReadonlyArray<keyof Usage>;

/** The keys of `T` whose values are counts. */
type CountKey<T> = { [K in keyof T]-?: T[K] extends number | undefined ? K : never }[keyof T];

/** Each count in `keys`, the two passes' added up; absent when neither pass reported it. */
function added<T>(first: T, next: T, keys: ReadonlyArray<CountKey<T>>): Partial<Record<CountKey<T>, number>> {
  const out: Partial<Record<CountKey<T>, number>> = {};
  for (const key of keys) {
    const a = first[key];
    const b = next[key];
    if (typeof a !== "number" && typeof b !== "number") continue;
    out[key] = (typeof a === "number" ? a : 0) + (typeof b === "number" ? b : 0);
  }
  return out;
}

/** Both passes' models: each pass reports its own share of every model (`session-cost.ts`). */
function addedModels(first: Usage["by_model"], next: Usage["by_model"]): Usage["by_model"] {
  if (!first || !next) return next ?? first;
  const models = new Set([...Object.keys(first), ...Object.keys(next)]);
  const rows = [...models].flatMap((id): Array<[string, ModelTokenUsage]> => {
    const a = first[id];
    const b = next[id];
    if (a && b) return [[id, { ...b, ...added(a, b, MODEL_ROW_COUNTS) }]];
    const only = b ?? a;
    return only ? [[id, only]] : [];
  });
  return Object.fromEntries(rows);
}

/** Two passes' usage as one: every count each pass reported for itself, added up. */
function addedUsage(first: Usage, next: Usage): Usage {
  const byModel = addedModels(first.by_model, next.by_model);
  return { ...next, ...added(first, next, PASS_COUNTS), ...(byModel ? { by_model: byModel } : {}) };
}

/** One turn's passes as the one result the caller reads: the last pass's ending, everything counted. */
export function joinedResult(first: DelegateResult, next: DelegateResult): DelegateResult {
  const calls = [...(first.studioToolCalls ?? []), ...(next.studioToolCalls ?? [])];
  const steered = [...(first.steered ?? []), ...(next.steered ?? [])];
  return {
    ...next,
    usage: addedUsage(first.usage, next.usage),
    turns: first.turns + next.turns,
    durationMs: (first.durationMs ?? 0) + (next.durationMs ?? 0),
    ...(calls.length ? { studioToolCalls: calls } : {}),
    ...(steered.length ? { steered } : {}),
  };
}

/** The builds a turn recorded to start. */
function launchesIn(result: DelegateResult): StudioCall[] {
  return (result.studioToolCalls ?? []).filter((call) => isBuildLaunch(call.name));
}

/** The turn without the builds it recorded to start: what is left still goes to the harness. */
function withoutLaunches(result: DelegateResult): DelegateResult {
  const { studioToolCalls, ...rest } = result;
  const kept = (studioToolCalls ?? []).filter((call) => !isBuildLaunch(call.name));
  return kept.length ? { ...rest, studioToolCalls: kept } : rest;
}

/** A turn whose held build can be put to the person: it ended well and recorded nothing else (no question). */
function launchToApprove(result: DelegateResult): boolean {
  return result.ok && (result.studioToolCalls ?? []).every((call) => isBuildLaunch(call.name));
}

/** The plan card for a held build: the reply, then what each build would build. */
function heldPlan(result: DelegateResult): string {
  const asks = launchesIn(result).map((call) => {
    const ask = isBuildLaunch(call.name) ? call.args[LAUNCH_ASK[call.name]] : undefined;
    return typeof ask === "string" && ask.trim() ? MESSAGE.build(ask.trim()) : "";
  });
  return [result.summary.trim(), ...asks].filter(Boolean).join("\n\n");
}

/** The plan a turn leaves to approve, and whether it is a held build; null when it leaves none. */
interface PlanToApprove {
  plan: string;
  held: boolean;
}

/**
 * What a pass leaves for the person: a held build (the chat still in Plan, as the host keeps it,
 * so an approval mid-turn lets it go), else on an engine that plans by turn a plain plan reply.
 */
async function planOf(input: {
  engine: string;
  mode: PermissionMode;
  result: DelegateResult;
  planning: () => Promise<boolean>;
}): Promise<PlanToApprove | null> {
  const { engine, mode, result } = input;
  if (launchesIn(result).length && (await input.planning())) return { plan: heldPlan(result), held: true };
  const plainPlan = mode === PermissionMode.Plan && plansByTurn(engine) && isPlanReply(result);
  return plainPlan ? { plan: result.summary, held: false } : null;
}

/** The next pass of the same session: its stills were already shown, and a steer door opens once per turn. */
function nextRequest(
  request: DelegateRequest,
  permissions: DelegatePermissions,
  next: PlanNext,
  sessionId: string,
): DelegateRequest {
  const { images: _images, steer: _steer, ...rest } = request;
  return { ...rest, prompt: next.prompt, resume: sessionId, permissions: { ...permissions, mode: next.mode } };
}

/** A held build that cannot go to the person (beside a question, a failed turn) or was not approved is dropped. */
function settled(result: DelegateResult, plan: PlanToApprove): DelegateResult {
  return plan.held ? withoutLaunches(result) : result;
}

/** One plan put to the person: the turn as it ends, or the next pass of the same session. */
type Round = { done: DelegateResult } | { kept: DelegateResult; next: PlanNext; sessionId: string };

/** Ask about one plan, unless the turn was stopped or its held build cannot be put to the person. */
async function askRound(input: {
  engine: string;
  result: DelegateResult;
  plan: PlanToApprove;
  permissions: DelegatePermissions;
  signal: AbortSignal;
}): Promise<Round> {
  const { engine, result, plan, permissions, signal } = input;
  if (signal.aborted || (plan.held && !launchToApprove(result))) return { done: settled(result, plan) };
  const ask = { tool: PLAN_TOOL, input: { plan: plan.plan }, toolUseId: randomUUID(), always: [] };
  const reply = await permissions.ask(ask, signal);
  // An approved build is the plan carried out: it starts as recorded, in the mode chosen.
  if (plan.held && reply.decision === PermissionDecision.ApprovePlan) return { done: result };
  const kept = settled(result, plan);
  const next = nextPass(engine, reply);
  if (!next || signal.aborted || !result.sessionId) return { done: kept };
  return { kept, next, sessionId: result.sessionId };
}

/**
 * Run a delegation; a chat session in Plan then has its plan, or a build it recorded to start,
 * approved, sent back, or left as it is (see the module's notes). Every other delegation runs once.
 * `planning` is the host's word on whether the chat is still in Plan.
 */
export async function withPlanApproval(input: {
  engine: string;
  request: DelegateRequest;
  run: (request: DelegateRequest) => Promise<DelegateResult>;
  signal: AbortSignal;
  planning: () => Promise<boolean>;
}): Promise<DelegateResult> {
  const { engine, request, run, signal, planning } = input;
  let result = await run(request);
  const { permissions } = request;
  if (!permissions || !permissionModesFor(engine).includes(PermissionMode.Plan)) return result;
  let mode = permissions.mode;
  for (let revision = 0; revision <= MAX_PLAN_REVISIONS; revision++) {
    const plan = await planOf({ engine, mode, result, planning });
    if (!plan) return result;
    const round = await askRound({ engine, result, plan, permissions, signal });
    if ("done" in round) return round.done;
    mode = round.next.mode;
    result = joinedResult(round.kept, await run(nextRequest(request, permissions, round.next, round.sessionId)));
  }
  // Out of revisions: a build still recorded in Plan does not start.
  return launchesIn(result).length && (await planning()) ? withoutLaunches(result) : result;
}
