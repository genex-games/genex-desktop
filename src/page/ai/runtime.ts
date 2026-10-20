/**
 * `genex-ai`'s engine: it compiles each call, keys it, sends it down the lane, holds the answer
 * in the inbox until the drain it is due, and hands the game a result with its fallback. Every
 * part is injected (the lanes, the gesture check, where the studio contract finds it), so tests
 * drive it with a fake fetch, a fake bridge and a fake embed SDK.
 *
 * Determinism: a call's frame is fixed when the game makes it, its key in the call itself
 * (`callKeyNow`), and a replayed answer is due that frame plus the frames it took live. A reset
 * (`__studio.seed()`) forgets every call, so a seed and the same steps replay the same frames.
 */
import {
  AI_ID_RE,
  AiAuthority,
  type AiBudgetView,
  type AiCallAnswer,
  AiErrorCode,
  type AiGrantRequest,
  AiGrantStatus,
  AiOp,
  AiProvenance,
  AiRequirement,
  AiTier,
  GAME_AI_WIRE_VERSION,
  isPlatformDoor,
  readMember,
} from "../../shared/game-ai.ts";
import type { AiGrantAnswer } from "../../shared/game-ai-bridge.ts";
import type { AiLane } from "../../shared/game-ai-lane.ts";
import { validateValue } from "../../shared/game-ai-schema.ts";
import { callKeyInput } from "../../shared/game-ai-tape.ts";
import { COMPACT_PROMPT, COMPACT_ROLE } from "./compile-prompts.ts";
import {
  type Compiled,
  type CompileContext,
  type CompiledCall,
  compileAct,
  compileAsk,
  compileJudge,
  compileSay,
} from "./compile.ts";
import { inbox } from "./inbox.ts";
import { type AiMemory, type AiMemoryLine, applyCompaction, createMemory, keepOf, MEMORY_NAME_RE } from "./memory.ts";
import { type Lane, type LaneOpened, type LaneReply, refusedReply } from "./lanes/lane.ts";
import { callKeyNow } from "./sha256.ts";
import type { AiDisclosure, AiFailure, AiResult, AiStatus, AiTicket, CreateAiOptions, GameAi } from "./types.ts";

/** What the game's HUD chip says, and where it sits. */
const MESSAGE = {
  disclosure: "AI-generated",
  badMemoryName: (name: string) => `genex-ai: "${name}" is not a memory name (a letter, then letters, digits, _ . -)`,
} as const;
const DISCLOSURE_ANCHOR = "top-right";
/** The grant id a host call names before the game holds one: main decides what a first call may do. */
export const UNGRANTED_ID = "ungranted";
/** Refusals an AI-only game cannot play past: Studio shows its "needs AI" state until the person acts. */
const NEEDS_AI: ReadonlySet<AiErrorCode> = new Set([
  AiErrorCode.Off,
  AiErrorCode.ConsentRequired,
  AiErrorCode.ConsentDeclined,
  AiErrorCode.ConsentPending,
  AiErrorCode.Paused,
  AiErrorCode.WaitingForPlan,
  AiErrorCode.DoorUnavailable,
  AiErrorCode.LocalLoading,
  AiErrorCode.NoFunding,
  AiErrorCode.OutOfCredits,
  AiErrorCode.MonthlyLimit,
]);

/** Where a page's lanes come from. */
export interface LaneSource {
  /** The lane the page starts on. */
  first(): Promise<Lane>;
  /** genex.games' lane, for a grant whose door genex.games answers; null where the page has none. */
  platform: (() => Promise<Lane>) | null;
}

/** What the runtime is given by the page (or a test). */
export interface RuntimeDeps {
  lanes: LaneSource;
  /** A person's click or key is being handled now (`navigator.userActivation.isActive`). */
  gesture(): boolean;
  /** Hand the studio contract (`__studio.state().ai`, `__studio.seed()`) its view of this AI. */
  register(handle: { status(): AiStatus; reset(seed: number): void }): void;
}

/** One call from the moment the game made it to the drain that released it. */
interface Pending {
  ticket: string;
  epoch: number;
  op: AiOp;
  site: string;
  call: CompiledCall | null;
  /** The drain count when the game made the call. */
  askedAt: number;
  key: string;
  n: number;
  abort: AbortController;
  fallback: unknown;
  partial: string | null;
  answer: AiCallAnswer | null;
  result: AiResult | null;
  canceled: boolean;
  /** A memory compaction's memory and the lines it summarizes. */
  compaction: { memory: AiMemory; lines: readonly AiMemoryLine[] } | null;
  /** It already went to genex.games' lane after main said its grant is answered there. */
  moved: boolean;
}

/** The runtime's state. */
interface Runtime {
  options: { sites: ReadonlySet<string> | null; requires: AiRequirement };
  deps: RuntimeDeps;
  lane: Lane | null;
  laneName: AiLane | null;
  opening: Promise<void>;
  /** The first lane is open (or failed to open): calls go at once. */
  opened: boolean;
  on: boolean;
  grant: AiBudgetView | null;
  /** A grant read in flight, so many calls before one ask once. */
  grantRead: Promise<void> | null;
  box: ReturnType<typeof inbox<Pending>>;
  epoch: number;
  seed: number;
  tickets: number;
  occurrences: Map<string, number>;
  running: Map<string, Pending>;
  counts: Omit<AiStatus, "lane" | "requires" | "on" | "door" | "frame" | "pending" | "needsAi" | "disclosed" | "tape">;
  needsAi: AiErrorCode | null;
  /** The last call an AI-only game could not play past: retried once when a grant becomes active. */
  parked: Pending | null;
  disclosed: boolean;
  tape: string | null;
}

const freshCounts = (): Runtime["counts"] => ({ calls: 0, answered: 0, fallbacks: 0, misses: 0, refused: {} });

/** A ticket id: the reset it belongs to and its number, within `AI_ID_RE`. */
const ticketId = (epoch: number, n: number): string => `tk${epoch}-${String(n).padStart(6, "0")}`;

function count(rt: Runtime, code: AiErrorCode): void {
  rt.counts.refused[code] = (rt.counts.refused[code] ?? 0) + 1;
}

/** Whether a grant view names a door genex.games answers. */
const onPlatform = (view: AiBudgetView | null): boolean => view !== null && isPlatformDoor(view.door);

/** Open genex.games' lane, or null when the page has none or it cannot open. */
async function openPlatform(rt: Runtime): Promise<{ lane: Lane; opened: LaneOpened } | null> {
  const platform = rt.deps.lanes.platform;
  if (!platform) return null;
  try {
    const lane = await platform();
    return { lane, opened: await lane.open() };
  } catch {
    return null;
  }
}

/** Move to genex.games' lane, once, when the game's grant is answered there. */
async function movePlatform(rt: Runtime): Promise<boolean> {
  if (rt.laneName === null || rt.lane?.needsGrant) return false;
  const moved = await openPlatform(rt);
  if (!moved) return false;
  rt.lane = moved.lane;
  rt.laneName = moved.lane.lane;
  rt.on = moved.opened.on;
  rt.tape = moved.opened.tape;
  rt.grant = moved.opened.grant.view;
  return true;
}

/** Take what a lane says of the game's grant, moving to genex.games' lane when it is answered there. */
async function takeGrant(rt: Runtime, answer: AiGrantAnswer): Promise<AiBudgetView | null> {
  rt.grant = answer.view;
  if (answer.code) count(rt, answer.code);
  if (onPlatform(answer.view) && (await movePlatform(rt))) return rt.grant;
  if (answer.view?.status === AiGrantStatus.Active) retryParked(rt);
  return answer.view;
}

/** Open the first lane; a lane that fails to open leaves the page off. */
async function open(rt: Runtime): Promise<void> {
  try {
    const lane = await rt.deps.lanes.first();
    const opened = await lane.open();
    rt.lane = lane;
    rt.laneName = lane.lane;
    rt.on = opened.on;
    rt.tape = opened.tape;
    lane.reseed(rt.seed);
    await takeGrant(rt, opened.grant);
  } catch {
    rt.lane = null;
    rt.on = false;
  }
  rt.opened = true;
}

/** A result from a call's answer, its fallback played on a failure. */
function resultOf(rt: Runtime, pending: Pending, answer: AiCallAnswer, frame: number): AiResult {
  const head = { ticket: pending.ticket, site: pending.site, op: pending.op, frame };
  if (answer.ok) {
    const value = pending.call ? pending.call.decode(answer.value) : answer.value;
    return {
      ...head,
      ok: true,
      value,
      code: null,
      fallback: false,
      source: answer.source,
      provenance: answer.provenance,
    };
  }
  const failure: AiFailure = { code: answer.code, site: pending.site, retryAfterMs: answer.retryAfterMs };
  const played = answer.code === AiErrorCode.Canceled ? undefined : playFallback(pending.fallback, failure);
  if (played !== undefined) rt.counts.fallbacks += 1;
  return {
    ...head,
    ok: false,
    value: played ?? null,
    code: answer.code,
    fallback: played !== undefined,
    source: null,
    provenance: null,
  };
}

/** The fallback's value: itself, or what its function makes of the failure; a throwing function plays none. */
function playFallback(fallback: unknown, failure: AiFailure): unknown {
  if (typeof fallback !== "function") return fallback;
  try {
    return fallback(failure);
  } catch {
    return undefined;
  }
}

/** What an answer means for this call: one that does not fit its shape or its authority is refused. */
function checked(pending: Pending, answer: AiCallAnswer): AiCallAnswer {
  if (!answer.ok || answer.ticket !== pending.ticket) {
    return answer.ok ? refusal(pending, AiErrorCode.Provider) : answer;
  }
  const wire = pending.call?.wire;
  if (wire && !validateValue(wire.schema, answer.value)) return refusal(pending, AiErrorCode.InvalidOutput);
  const shared = wire?.authority === AiAuthority.Shared;
  if (shared && answer.provenance === AiProvenance.Unverified) return refusal(pending, AiErrorCode.NeedsVerified);
  return answer;
}

const refusal = (pending: Pending, code: AiErrorCode): AiCallAnswer => refusedReply(pending.ticket, code).answer;

/** Hold a lane's reply until the drain it is due; a reply for a reset world or a canceled call is dropped. */
function settle(rt: Runtime, pending: Pending, reply: LaneReply): void {
  if (pending.epoch !== rt.epoch || pending.canceled || pending.answer) return;
  const answer = checked(pending, reply.answer);
  if (!answer.ok && answer.code === AiErrorCode.PlatformDoor && !pending.moved) {
    pending.moved = true;
    void movePlatform(rt).then((moved) => (moved ? send(rt, pending) : hold(rt, pending, answer, null)));
    return;
  }
  if (reply.missed) rt.counts.misses += 1;
  hold(rt, pending, answer, reply.frames);
}

function hold(rt: Runtime, pending: Pending, answer: AiCallAnswer, frames: number | null): void {
  if (pending.epoch !== rt.epoch || pending.answer) return;
  pending.answer = answer;
  rt.running.delete(pending.ticket);
  const due = frames === null ? rt.box.frame() + 1 : pending.askedAt + frames;
  rt.box.holdUntil(pending, due);
}

/** A lane that names its grant on every call gets one first, or the call is refused for want of one. */
async function grantFor(rt: Runtime): Promise<boolean> {
  if (!rt.grantRead && rt.lane) {
    const lane = rt.lane;
    rt.grantRead = lane
      .activeGrant()
      .then((answer) => takeGrant(rt, answer))
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        rt.grantRead = null;
      });
  }
  await rt.grantRead;
  return rt.grant !== null;
}

/** Send a call down the open lane. A replay lane answers at once, inside the frame the call was made in. */
function send(rt: Runtime, pending: Pending): void {
  if (pending.epoch !== rt.epoch || pending.canceled) return;
  const lane = rt.lane;
  const call = pending.call;
  if (!lane || !call) {
    hold(rt, pending, refusal(pending, AiErrorCode.Off), 1);
    return;
  }
  if (lane.needsGrant && !rt.grant) {
    void grantFor(rt).then((held) =>
      held ? send(rt, pending) : hold(rt, pending, refusal(pending, AiErrorCode.ConsentRequired), null),
    );
    return;
  }
  const failed = () => settle(rt, pending, refusedReply(pending.ticket, AiErrorCode.Provider, null));
  try {
    const grantId = rt.grant?.id ?? null;
    const reply = lane.call({
      call: { ...call, wire: { ...call.wire, grantId: wireGrantId(grantId) } },
      grantId,
      key: pending.key,
      n: pending.n,
      onDelta: (text) => {
        if (pending.epoch === rt.epoch && !pending.answer) pending.partial = text;
      },
      signal: pending.abort.signal,
    });
    if (reply instanceof Promise) reply.then((late) => settle(rt, pending, late), failed);
    else settle(rt, pending, reply);
  } catch {
    failed();
  }
}

/** Send a call now when the lane is open, else as soon as it is. */
function dispatch(rt: Runtime, pending: Pending): void {
  if (rt.opened) send(rt, pending);
  else void rt.opening.then(() => send(rt, pending));
}

/** Start a call the game made: refused at once when it did not compile, else keyed and sent. */
function issue(
  rt: Runtime,
  op: AiOp,
  compiled: Compiled,
  site: unknown,
  fallback: unknown,
  compaction: Pending["compaction"] = null,
): Pending {
  rt.tickets += 1;
  rt.counts.calls += 1;
  const ticket = ticketId(rt.epoch, rt.tickets);
  const call = compiled.ok ? compiled.call : null;
  const key = call ? callKeyNow(callKeyInput(call.wire)) : "";
  const n = rt.occurrences.get(key) ?? 0;
  if (call) rt.occurrences.set(key, n + 1);
  const pending: Pending = {
    ticket,
    epoch: rt.epoch,
    op,
    site: typeof site === "string" ? site : "",
    call: call ? { ...call, wire: { ...call.wire, ticket } } : null,
    askedAt: rt.box.frame(),
    key,
    n,
    abort: new AbortController(),
    fallback,
    partial: null,
    answer: null,
    result: null,
    canceled: false,
    compaction,
    moved: false,
  };
  rt.running.set(ticket, pending);
  if (!compiled.ok) hold(rt, pending, refusal(pending, compiled.code), 1);
  else dispatch(rt, pending);
  return pending;
}

/** The ticket a game holds for a call. */
function ticketOf<T>(rt: Runtime, pending: Pending): AiTicket<T> {
  return {
    id: pending.ticket,
    site: pending.site,
    partial: () => pending.partial,
    // The value is the call's own answer, decoded and checked against the schema the request typed `T` by.
    result: () => pending.result as AiResult<T> | null,
    cancel: () => cancel(rt, pending),
  };
}

/** Stop waiting for a call not yet released: it arrives as `canceled` on the next drain, whatever answer was held. */
function cancel(rt: Runtime, pending: Pending): boolean {
  if (pending.result || pending.canceled || pending.epoch !== rt.epoch) return false;
  pending.canceled = true;
  if (rt.running.delete(pending.ticket)) {
    rt.lane?.cancel(pending.ticket);
    pending.abort.abort();
  }
  pending.answer = refusal(pending, AiErrorCode.Canceled);
  rt.box.remove(pending);
  rt.box.holdUntil(pending, rt.box.frame() + 1);
  return true;
}

/** An AI-only game's last refusal it cannot play past: Studio's "needs AI" state, and one retry later. */
function noteNeed(rt: Runtime, pending: Pending, result: AiResult): void {
  if (result.ok) {
    rt.needsAi = null;
    return;
  }
  const blocking = rt.options.requires === AiRequirement.Ai && !result.fallback && NEEDS_AI.has(result.code);
  if (!blocking) return;
  rt.needsAi = result.code;
  if (pending.call && !pending.compaction) rt.parked = pending;
}

/** Retry the parked call once, now that the game holds an active grant. */
function retryParked(rt: Runtime): void {
  const parked = rt.parked;
  rt.parked = null;
  if (!parked?.call) return;
  issue(rt, parked.op, { ok: true, call: parked.call }, parked.site, parked.fallback);
}

/** Release every answer due this drain, as the game's results. */
function drain(rt: Runtime): AiResult[] {
  const released = rt.box.drain();
  const frame = rt.box.frame();
  const results: AiResult[] = [];
  for (const pending of released) {
    const answer = pending.answer ?? refusal(pending, AiErrorCode.Provider);
    const result = resultOf(rt, pending, answer, frame);
    pending.result = result;
    if (result.ok) rt.counts.answered += 1;
    else count(rt, result.code);
    noteNeed(rt, pending, result);
    if (result.ok && pending.compaction && typeof result.value === "string") {
      applyCompaction(pending.compaction.memory, pending.compaction.lines, result.value, COMPACT_ROLE);
    }
    results.push(result);
  }
  return results;
}

/** Forget every call and start again from `seed` (the studio reset the world). */
function reset(rt: Runtime, seed: number): void {
  for (const pending of rt.running.values()) {
    rt.lane?.cancel(pending.ticket);
    pending.abort.abort();
  }
  rt.running.clear();
  rt.epoch += 1;
  rt.seed = seed >>> 0;
  rt.tickets = 0;
  rt.occurrences.clear();
  rt.box.clear();
  rt.counts = freshCounts();
  rt.needsAi = null;
  rt.parked = null;
  rt.disclosed = false;
  rt.lane?.reseed(rt.seed);
}

function status(rt: Runtime): AiStatus {
  return {
    lane: rt.laneName,
    requires: rt.options.requires,
    on: rt.on,
    door: rt.grant?.door ?? null,
    frame: rt.box.frame(),
    pending: rt.running.size + rt.box.pending(),
    ...rt.counts,
    refused: { ...rt.counts.refused },
    needsAi: rt.needsAi,
    disclosed: rt.disclosed,
    tape: rt.tape,
  };
}

/** The tiers a grant asks for: the game's, each once, or both. */
function grantTiers(raw: unknown): AiTier[] {
  if (!Array.isArray(raw)) return [AiTier.Fast, AiTier.Smart];
  const tiers = [...new Set(raw.map((tier) => readMember(AiTier, tier)).filter((tier) => tier !== null))];
  return tiers.length ? tiers : [AiTier.Fast, AiTier.Smart];
}

/** Ask for a grant inside a person's gesture; outside one, nothing leaves the page. */
async function requestGrant(rt: Runtime, tiers: unknown): Promise<AiBudgetView | null> {
  if (!rt.deps.gesture()) {
    count(rt, AiErrorCode.NoGesture);
    return null;
  }
  await rt.opening;
  if (!rt.lane) return null;
  const request: AiGrantRequest = { v: GAME_AI_WIRE_VERSION, requires: rt.options.requires, tiers: grantTiers(tiers) };
  try {
    return await takeGrant(rt, await rt.lane.requestGrant(request));
  } catch {
    count(rt, AiErrorCode.DoorUnavailable);
    return null;
  }
}

/** A memory the game's calls can carry; compacting it is a `say` on its own site. */
function memoryOf(rt: Runtime, name: unknown, keep: unknown): AiMemory {
  const named = String(name);
  if (!MEMORY_NAME_RE.test(named)) throw new TypeError(MESSAGE.badMemoryName(named));
  return createMemory(named, keepOf(keep), (memory, site) => {
    const lines = [...memory.lines()];
    if (!lines.length) return;
    const compiled = compileSay({ site, prompt: COMPACT_PROMPT, memory }, compileContext(rt));
    issue(rt, AiOp.Say, compiled, site, undefined, { memory, lines });
  });
}

const compileContext = (rt: Runtime) => ({
  ticket: ticketId(rt.epoch, rt.tickets + 1),
  grantId: UNGRANTED_ID,
  sites: rt.options.sites,
});

/** The grant id a call carries to main: the game's when main's wire can name it (a host grant's always can). */
const wireGrantId = (grantId: string | null): string =>
  grantId !== null && AI_ID_RE.test(grantId) ? grantId : UNGRANTED_ID;

/**
 * A game's request read once into plain fields: every getter runs once, and a request that throws
 * while it is read (a proxy, a throwing getter) reads as empty, which compiles to `bad_request`.
 */
function fieldsOf(request: unknown): Record<string, unknown> {
  if (typeof request !== "object" || request === null) return {};
  try {
    return { ...request };
  } catch {
    return {};
  }
}

/** The compilers, by op. */
const COMPILE = {
  [AiOp.Ask]: compileAsk,
  [AiOp.Say]: compileSay,
  [AiOp.Judge]: compileJudge,
  [AiOp.Act]: compileAct,
} as const satisfies Record<AiOp, (fields: Record<string, unknown>, context: CompileContext) => Compiled>;

/** The game's AI over `deps`: lanes, gesture and registration. */
export function createRuntime(options: CreateAiOptions | undefined, deps: RuntimeDeps): GameAi {
  const sites = Array.isArray(options?.sites)
    ? new Set(options.sites.filter((site) => typeof site === "string"))
    : null;
  const rt: Runtime = {
    options: { sites, requires: readMember(AiRequirement, options?.requires) ?? AiRequirement.Optional },
    deps,
    lane: null,
    laneName: null,
    opening: Promise.resolve(),
    opened: false,
    on: false,
    grant: null,
    grantRead: null,
    box: inbox<Pending>(),
    epoch: 0,
    seed: 1,
    tickets: 0,
    occurrences: new Map(),
    running: new Map(),
    counts: freshCounts(),
    needsAi: null,
    parked: null,
    disclosed: false,
    tape: null,
  };
  rt.opening = open(rt);
  deps.register({ status: () => status(rt), reset: (seed) => reset(rt, seed) });
  const start = <T>(op: AiOp, request: unknown): AiTicket<T> => {
    const fields = fieldsOf(request);
    const compiled = COMPILE[op](fields, compileContext(rt));
    return ticketOf<T>(rt, issue(rt, op, compiled, fields.site, fields.fallback));
  };
  return {
    ready: () => rt.opening,
    ask: (request) => start(AiOp.Ask, request),
    say: (request) => start(AiOp.Say, request),
    judge: (request) => start(AiOp.Judge, request),
    act: (request) => start(AiOp.Act, request),
    memory: (name, memoryOptions) => memoryOf(rt, name, memoryOptions?.keep),
    drain: () => drain(rt),
    async activeBudget() {
      await rt.opening;
      if (!rt.lane) return null;
      return takeGrant(
        rt,
        await rt.lane.activeGrant().catch(() => ({ view: null, code: AiErrorCode.DoorUnavailable })),
      );
    },
    requestBudget: (grantOptions) => requestGrant(rt, grantOptions?.tiers),
    async stopBudget() {
      await rt.opening;
      await rt.lane?.stopGrant(rt.grant?.id ?? null).catch(() => false);
      rt.grant = null;
    },
    status: () => status(rt),
    disclosure(): AiDisclosure {
      rt.disclosed = true;
      return { text: MESSAGE.disclosure, anchor: DISCLOSURE_ANCHOR };
    },
  };
}
