/**
 * What reaches a Loop's lead from outside its own session, through one channel: the chat's messages
 * on its line (lead-line.ts), as they were written, and Genex's own lines of the run's log — a worker
 * or a job that ended, the project's app that stopped or came back, what Genex did with the folder
 * (`NoteKind`), each one fact. A resting lead is woken with them (`askOf`, wake.ts); a working one
 * is handed them at its next step (`watchTurn`, `engine.steer`) — the person's words cut its turn
 * short when it may be cut, and the same session goes on with them, Genex's never cut it. What the
 * lead heard is kept in two places only: the line, for the chat's messages, and the
 * run's `waitSeq`, for Genex's lines (every one up to it is told: a line a turn's message carried or
 * the turn took counts while the turn works, and is untold again when the turn ends without reading it).
 */
import type { DelegateImage, DelegateResult, SteerMessage } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { attachStills, type QueueAction, steerMessageOf, textsOf, WORDS_APART } from "../message-queue.ts";
import { fromThePerson, MessageFrom, SteerDelivery } from "../steer-delivery.ts";
import { SECOND_MS } from "../time.ts";
import { closeUnderWay } from "./close-latch.ts";
import type { LeadLine } from "./lead-line.ts";
import type { LoopRun, LoopRunLogEntry } from "./loop-run.ts";
import { abortLead } from "./open/app-look.ts";
import { PAUSE_CALLS_MS, PAUSE_END_MS } from "./open/contract.ts";
import { LOOP_WORDS } from "./wake-prompts.ts";
import type { NoteKind } from "./wake-schedule.ts";

/** How often a turn under way is looked at for Genex's lines. */
const TURN_WATCH_MS = SECOND_MS;

/** What a message to the lead carries besides its words: who wrote them, their pictures, and Genex's lines beside them. */
export interface TurnSaid {
  from: MessageFrom;
  images?: DelegateImage[];
  notices?: string[];
}

/** One message to the lead's session, and what it tells it. */
export interface TurnAsk {
  prompt: string;
  said: TurnSaid;
  /** Genex's lines it carries that no line of the log holds (the Loop's start, the wrap-up): said again when no turn works on it. */
  lead: readonly string[];
  /** The last of the chat's messages it carries: every one up to it is heard once a turn works on it. */
  through: QueueAction | null;
  /** The last line of the run's log it carries: every one up to it is told once a turn works on it. */
  toldSeq: number;
}

/** A line of the run's log with the kind that makes it one of Genex's facts for the lead. */
type GenexLine = LoopRunLogEntry & { kind: NoteKind };

/**
 * The run is over for the lead: it finished, the user stopped it, or it failed on its own; or its
 * close has started; or, an open Loop, its lead paused it for the person.
 */
export const runOver = (loopRun: LoopRun): boolean =>
  loopRun.state.finished ||
  loopRun.ctx.cancelled === true ||
  Boolean(loopRun.report.failure) ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  Boolean(loopRun.open.halted);

/** Genex's lines of the run's log the lead has not been told, oldest first. */
export function untold(loopRun: Pick<LoopRun, "notesSince" | "waitSeq">): GenexLine[] {
  return loopRun.notesSince(loopRun.waitSeq).filter((entry): entry is GenexLine => entry.kind !== undefined);
}

/** The lead was told every line of the run's log up to `seq`. */
export function toldThrough(loopRun: Pick<LoopRun, "waitSeq">, seq: number): void {
  loopRun.waitSeq = Math.max(loopRun.waitSeq, seq);
}

/** The chat's unheard messages the next message to the lead is: the leading ones of one sender. */
function leadingWords(line: LeadLine | null): QueueAction[] {
  const unheard = line?.unheard() ?? [];
  const first = unheard[0];
  if (!first) return [];
  const other = unheard.findIndex((item) => fromThePerson(item) !== fromThePerson(first));
  return other < 0 ? [...unheard] : unheard.slice(0, other);
}

/**
 * The lead's next message: the chat's unheard messages as they were written, Genex's lines beside
 * them (`lead`, then the log's untold ones) as a notice, and when the person's words open it, Genex's
 * line that they wait for an answer (`LOOP_WORDS.personWaits`) last — or, with no message waiting,
 * Genex's lines alone, as Genex's.
 */
export async function askOf(loopRun: LoopRun, line: LeadLine | null, lead: readonly string[]): Promise<TurnAsk> {
  const words = leadingWords(line);
  const lines = untold(loopRun);
  const genex = [...lead, ...lines.map((entry) => entry.text)].join("\n");
  const carried = { lead: [...lead], through: words.at(-1) ?? null, toldSeq: lines.at(-1)?.seq ?? 0 };
  const first = words[0];
  if (!first) return { prompt: genex, said: { from: MessageFrom.Genex }, ...carried };
  const said = words.map(steerMessageOf);
  const images = said.flatMap((one) => one.images ?? []);
  const from = fromThePerson(first) ? MessageFrom.Person : MessageFrom.Genex;
  // The person's words that open the turn come last, right after Genex's line that they wait for an answer.
  const waits = from === MessageFrom.Person ? [LOOP_WORDS.personWaits] : [];
  const notices = [...(genex ? [genex] : []), ...waits];
  const beside = { ...(images.length ? { images } : {}), ...(notices.length ? { notices } : {}) };
  return { prompt: textsOf(said).join(WORDS_APART), said: { from, ...beside }, ...carried };
}

/** Whether a message to the lead says anything: words, a picture, or Genex's lines. */
export const saysSomething = (ask: TurnAsk): boolean => Boolean(ask.prompt || ask.said.images?.length);

/**
 * Hands the lead's line what the run's inbox holds for it, with the pictures the chat keeps for it:
 * no queue holds it, so a Stop leaves it with the run.
 */
async function handFromInbox(loopRun: LoopRun, line: LeadLine, items: readonly QueueAction[]): Promise<void> {
  for (const item of items) {
    if (item.attachmentsArtifact) await attachStills(loopRun.ctx, loopRun.threadId, item).catch(() => {});
    line.hear(item);
  }
}

/**
 * A resumed run's line is handed again the chat's messages its lead took before the pause and never
 * heard (the app quit under it).
 */
export async function handAgain(loopRun: LoopRun, line: LeadLine | null): Promise<void> {
  if (line) await handFromInbox(loopRun, line, await loopRun.inbox.unheard().catch(() => []));
}

/**
 * The person's notes about the run's builds (a reply to a build, a note on a picture), which reach
 * the run's inbox and no chat queue: handed to the lead's line as they come (the inbox reads each once).
 */
export async function handNotes(loopRun: LoopRun, line: LeadLine | null): Promise<void> {
  if (line) await handFromInbox(loopRun, line, await loopRun.inbox.notes().catch(() => []));
}

/** One session call's watch: it ends with the call. */
interface TurnWatch {
  /**
   * The chat's words cut the turn short (`wordsAsk`: the person's on any engine, Genex's on one that
   * takes no input as it works): it is resumed with them.
   */
  cut(): boolean;
  /** The call ended: the watch stops, and what its session read (`steered`) is heard or told. */
  end(result: Partial<DelegateResult> | undefined): Promise<void>;
}

/** What a watch needs besides the run. */
interface WatchKit {
  line: LeadLine | null;
  clock: { sleep(ms: number): Promise<void> };
  /** The call's number: what is said into it goes in under ids of its own. */
  turn: number;
  /** The message the call opened with: what it carries is never said into it again. */
  ask: TurnAsk;
  /** Whether the chat's words may cut the turn short now. */
  mayCut: () => boolean;
  /** What each look reads first: the run's job ends, the project's app. */
  poll: () => Promise<void>;
}

/** What one watch handed the session and what it took, by the id each went in under. */
interface Handed {
  /** Genex's lines offered, by sequence number: one not taken is offered again with the next one. */
  offered: Set<number>;
  /** The chat's messages offered: they are offered again with the next one sent. */
  tried: Set<QueueAction>;
  /** What the session took to read at its next step: a chat message, or a line's sequence number. */
  taken: Map<string, QueueAction | number>;
  /** The run's `waitSeq` as the call began: what the session took counts as told only while it works. */
  toldBefore: number;
  cut: boolean;
}

/**
 * How a steer asks the host to deliver it: `interrupt` lets it cut the turn short at its next step,
 * and `native: false` never lets the session read it mid-turn, so the host cuts the turn instead.
 */
interface SteerAsk {
  interrupt: boolean;
  native?: boolean;
}

/** Says `messages` into the lead's turn under way, as `ask` asks; how the host delivered them and which it took. */
async function steer(loopRun: LoopRun, messages: SteerMessage[], ask: SteerAsk) {
  const params = { threadId: loopRun.threadId, into: loopRun.run.runId, messages, ...ask };
  const answer = await loopRun.ctx.call(HostMethod.EngineSteer, params).catch(() => null);
  return { how: answer?.how ?? null, accepted: new Set<string>(answer?.accepted ?? []) };
}

/**
 * How the chat's words go into the turn. The person's cut it whenever it may be cut, on an engine that
 * reads input mid-turn too, and the same session goes on with them as their own message: read beside
 * a tool's result, "How is it going?" went unanswered while a lead built on for half an hour
 * (castle-artillery). Inside a tool call or the wrap-up they are only read mid-turn; Genex's cut
 * only an engine that takes no input as it works.
 */
function wordsAsk(kit: WatchKit, waiting: readonly QueueAction[]): SteerAsk {
  const interrupt = kit.mayCut();
  if (interrupt && waiting.some(fromThePerson)) return { interrupt, native: false };
  return { interrupt };
}

/**
 * The chat's messages sent since the turn's own message, each as written, when one of them was not
 * offered to the turn yet: the person's cutting the turn short when it may be cut now (`wordsAsk`),
 * anything else taken to read at its next step — or cutting it, on an engine that takes no input as
 * it works.
 */
async function sayWords(loopRun: LoopRun, kit: WatchKit, handed: Handed): Promise<void> {
  const unheard = kit.line?.unheard() ?? [];
  const after = kit.ask.through ? unheard.indexOf(kit.ask.through) + 1 : 0;
  const taken = new Set(handed.taken.values());
  const waiting = unheard.slice(after).filter((item) => !taken.has(item));
  if (!waiting.some((item) => !handed.tried.has(item))) return;
  for (const item of waiting) handed.tried.add(item);
  const ids = new Map(waiting.map((item) => [`${loopRun.run.runId}:${kit.turn}:said-${item.messageId}`, item]));
  const messages = [...ids].map(([id, item]) => ({ ...steerMessageOf(item), id }));
  const answer = await steer(loopRun, messages, wordsAsk(kit, waiting));
  if (answer.how === SteerDelivery.Interrupt && answer.accepted.size) handed.cut = true;
  else for (const [id, item] of ids) if (answer.accepted.has(id)) handed.taken.set(id, item);
}

/**
 * Genex's untold lines, when one of them was not offered to the turn yet — in order, never cutting
 * the turn short: one the session took is told while the turn works (a close reads it so), and one
 * it did not take goes in again with the next, before it.
 */
async function sayLines(loopRun: LoopRun, kit: WatchKit, handed: Handed): Promise<void> {
  const waiting = untold(loopRun);
  if (!waiting.some((entry) => !handed.offered.has(entry.seq))) return;
  for (const entry of waiting) handed.offered.add(entry.seq);
  const seqs = new Map(waiting.map((entry) => [`${loopRun.run.runId}:${kit.turn}:news-${entry.seq}`, entry]));
  const messages = [...seqs].map(([id, entry]) => ({ id, text: entry.text, from: MessageFrom.Genex }));
  const answer = await steer(loopRun, messages, { interrupt: false });
  for (const [id, entry] of seqs) {
    if (!answer.accepted.has(id)) continue;
    handed.taken.set(id, entry.seq);
    toldThrough(loopRun, entry.seq);
  }
}

/**
 * What the session read of what it took: the chat's messages up to the last one it read are heard,
 * Genex's lines up to the last one it read are told — and those it took and never read are untold
 * again (the turn's own message is settled after this, by whether the turn worked on it).
 */
async function settle(loopRun: LoopRun, kit: WatchKit, handed: Handed, result: Partial<DelegateResult> | undefined) {
  const read = new Set(result?.steered ?? []);
  loopRun.waitSeq = handed.toldBefore;
  let lastItem: QueueAction | null = null;
  for (const [id, what] of handed.taken) {
    if (!read.has(id)) continue;
    if (typeof what === "number") toldThrough(loopRun, what);
    else lastItem = what;
  }
  if (lastItem) await kit.line?.heardThrough(lastItem);
}

/** Whether one session call of the lead's opened a session that read its message: it has a session and took a turn. */
export const startedASession = (result: Partial<DelegateResult> | undefined): boolean =>
  Boolean(result?.sessionId) && (result?.turns ?? 0) > 0;

/**
 * Whether Genex ends the lead's session now: the person stopped the Loop, or its lead paused it and
 * had its time to end its turn with its words (`PAUSE_END_MS` from its pause's answer; `PAUSE_CALLS_MS`
 * from the pause while a call of Genex's tools, the pause's own included, is still answering). Ended under a call, the engine answers that call
 * as if the person had declined it.
 */
function endsTheSession(loopRun: LoopRun): boolean {
  const open = loopRun.open;
  if (loopRun.ctx.cancelled === true) return true;
  const askedAt = open?.halted ? open.haltedAt : undefined;
  if (askedAt === undefined) return false;
  const now = open.clock.now();
  // A call still answering gets longer, never forever: one that never answers would leave a paused lead at work.
  if ((loopRun.toolsInFlight ?? 0) > 0) return now - askedAt >= PAUSE_CALLS_MS;
  return now - (open.haltAnsweredAt ?? askedAt) >= PAUSE_END_MS;
}

/**
 * Watches one session call of the lead's until it ends (the module's header): each look reads the
 * run's job ends and the project's app first (`poll`), then hands the turn what came since its own
 * message. A Loop the person stopped ends an open Loop's session again instead (one its first abort
 * missed: the host had not seated it yet), and so does one its lead paused, once the lead had its time
 * to end its turn (`endsTheSession`); a run that is over hears nothing more.
 */
export function watchTurn(loopRun: LoopRun, kit: WatchKit): TurnWatch {
  const open = loopRun.open;
  const handed: Handed = {
    offered: new Set(),
    tried: new Set(),
    taken: new Map(),
    toldBefore: loopRun.waitSeq,
    cut: false,
  };
  // What the call's own message carries is told while it works, as what it takes later is.
  toldThrough(loopRun, kit.ask.toldSeq);
  let over = false;
  let stop = () => {};
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  const look = async (): Promise<void> => {
    if (open && endsTheSession(loopRun)) return abortLead(loopRun);
    await kit.poll();
    if (over || runOver(loopRun)) return;
    await sayWords(loopRun, kit, handed);
    await sayLines(loopRun, kit, handed);
  };
  if (open) open.inTurn = true;
  const watching = (async () => {
    while (!over && !handed.cut) {
      const spoke = kit.line?.heard();
      await look().catch(() => {});
      await Promise.race([kit.clock.sleep(TURN_WATCH_MS), stopped, ...(spoke ? [spoke] : [])]);
    }
  })();
  return {
    cut: () => handed.cut,
    end: async (result) => {
      over = true;
      if (open) open.inTurn = false;
      stop();
      await watching;
      await settle(loopRun, kit, handed, result);
      if (open && startedASession(result)) open.sessionWorked = true;
    },
  };
}
