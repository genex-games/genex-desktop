/**
 * The chat's current turn as one engine session the person's messages reach while it works
 * (steer). The queue decides what joins the turn (message-queue.ts `SteerHandle`), the host how
 * the running session takes it (`engine.steer`), and this runner the legs: a session that cannot
 * read a message mid-turn is interrupted and resumed with it in front.
 *
 * Generic on purpose: whichever session is the chat's current turn — the contractor (a Loop
 * chat's too, and the chat's own session after a run it led), or a run's coordinator — runs
 * through here unchanged.
 */
import { isResumeFailure } from "./chat-session.ts";
import { steeredTurnPrompt, withSteers } from "./chat-steer-prompts.ts";
import type { QueueAction, SteerHandle } from "./message-queue.ts";
import { SteerDelivery } from "./steer-delivery.ts";
import { EngineFailure, StopReason } from "./outage.ts";
import type { DelegateImage, DelegateResult } from "../types/host-api.d.ts";

/** One engine call of the turn: the prompt it sends, the session it resumes, and its pictures. */
interface Leg {
  prompt: string;
  resume: string | null;
  images: DelegateImage[];
}

/** Runs the session once — an `engine.delegate` carrying `chatTurn`, so the host knows which session answers the chat. */
export type SessionCall = (prompt: string, resume: string | null, images: DelegateImage[]) => Promise<DelegateResult>;

/** What the turn's session is started with. */
export interface SteeredCallOptions {
  prompt: string;
  resume?: string | null;
  images?: DelegateImage[];
  call: SessionCall;
  /** The first prompt for a new session when the saved one cannot be resumed. */
  fresh?: () => string;
}

/** Everything the turn has been told so far, and how to run one leg of it. */
interface TurnLegs {
  ctx: { readonly cancelled: boolean };
  steer: SteerHandle;
  options: SteeredCallOptions;
  run: (leg: Leg) => Promise<DelegateResult>;
  /** Every message put in front of a session this turn, in the order it was told. */
  told: QueueAction[];
  /** Each leg's result, in order. */
  legs: DelegateResult[];
  /**
   * Handed in a prompt no session has read yet: this leg's, and an earlier leg's cut off before
   * it read its own (its prompt is sent again). A Stop or a failure before they are read puts
   * them back in the queue rather than leaving them recorded as read.
   */
  unread: QueueAction[];
  /** The leg last run, and what it returned. */
  leg: Leg | null;
  last: DelegateResult | undefined;
  /** What the last leg took by being interrupted: the next leg's to deliver. */
  interrupted: QueueAction[];
}

const textsOf = (items: readonly QueueAction[]): string[] => items.map((item) => String(item.text ?? ""));
const stillsOf = (items: readonly QueueAction[]): DelegateImage[] => items.flatMap((item) => item.stills ?? []);

/** The session was cut off before or as it started (the host's interrupt). */
const isAborted = (err: unknown): boolean => (err as { kind?: unknown } | null)?.kind === EngineFailure.Aborted;

/**
 * Run the chat's current turn. While it runs, the queue hands this turn what is sent
 * (`steer.open`) and the host puts it in: read mid-turn by an engine that can (recorded where it
 * was read), or by interrupting the session, which this resumes with those messages in front.
 * Messages sent before the session starts join its first prompt. Without a steer handle the
 * session runs once, as it always did.
 */
export async function steeredCall(
  ctx: { readonly cancelled: boolean },
  steer: SteerHandle | null | undefined,
  options: SteeredCallOptions,
): Promise<DelegateResult> {
  const told: QueueAction[] = [];
  const run = (leg: Leg) => callOrStartFresh(options, told, leg);
  if (!steer) return run({ prompt: options.prompt, resume: options.resume ?? null, images: options.images ?? [] });
  const turn: TurnLegs = {
    ctx,
    steer,
    options,
    run,
    told,
    legs: [],
    unread: [],
    leg: null,
    last: undefined,
    interrupted: [],
  };
  try {
    return await steered(turn);
  } finally {
    await steer.done();
  }
}

/** One leg; a saved session that cannot be resumed is started afresh with everything the turn was told. */
async function callOrStartFresh(options: SteeredCallOptions, told: QueueAction[], leg: Leg): Promise<DelegateResult> {
  try {
    return await options.call(leg.prompt, leg.resume, leg.images);
  } catch (err) {
    if (!leg.resume || !isResumeFailure(err)) throw err;
    const fresh = options.fresh?.() ?? options.prompt;
    return options.call(withSteers(fresh, textsOf(told)), null, [...(options.images ?? []), ...stillsOf(told)]);
  }
}

/** The turn's legs, until one ends it: its own ending, a Stop, a failure, or a question already asked. */
async function steered(turn: TurnLegs): Promise<DelegateResult> {
  for (;;) {
    const leg = await nextLeg(turn);
    if (!leg) return stopped(turn);
    const outcome: LegOutcome = await turn.run(leg).then(
      (result) => ({ result }),
      (failure: unknown) => ({ failure }),
    );
    const ending = await afterLeg(turn, outcome);
    if (ending) return ending;
  }
}

/** How a leg ended: with the session's result, or with what its call threw. */
type LegOutcome = { result: DelegateResult; failure?: undefined } | { result?: undefined; failure: unknown };

/**
 * The next leg, as its session starts: what joined while it was set up, and what the last leg
 * was cut for, delivered into its prompt. Null after a Stop: nothing runs after it.
 */
async function nextLeg(turn: TurnLegs): Promise<Leg | null> {
  const { steer, told } = turn;
  const arrived = steer.inOrder([...turn.interrupted, ...(await steer.open())]);
  // A leg cut off before its session read anything: its prompt is sent again, with these after it.
  const forwarded = turn.leg !== null && !startedWorking(turn.last);
  turn.unread = forwarded ? [...turn.unread, ...arrived] : arrived;
  // A Stop between legs: nothing runs after it, and what no session read waits for its own turn.
  if (turn.ctx.cancelled) return null;
  await steer.deliver(arrived, turn.leg ? SteerDelivery.Interrupt : SteerDelivery.Prompt);
  told.push(...arrived);
  turn.leg = legAfter(turn, arrived, forwarded);
  return turn.leg;
}

/** Did this leg's session start working (it read its prompt): it keeps it and reads the messages next. */
function startedWorking(result: DelegateResult | undefined): boolean {
  return Boolean(result?.sessionId && result.turns > 0);
}

/** The prompt, session and pictures of the leg after `turn.leg`, carrying the messages that arrived. */
function legAfter(turn: TurnLegs, arrived: QueueAction[], forwarded: boolean): Leg {
  const { steer, options, told, leg, last } = turn;
  if (!leg) {
    // Delivered before a restart cut this turn short: its answer starts with them too.
    const lead = [...steer.carried, ...arrived];
    told.unshift(...steer.carried);
    return {
      prompt: withSteers(options.prompt, textsOf(lead)),
      resume: options.resume ?? null,
      images: [...(options.images ?? []), ...stillsOf(lead)],
    };
  }
  // A session that had started working keeps it and reads the messages next; one cut off before
  // it read its prompt gets that prompt again, with the messages after it.
  if (!forwarded)
    return { prompt: steeredTurnPrompt(textsOf(arrived)), resume: last?.sessionId ?? null, images: stillsOf(arrived) };
  return {
    prompt: withSteers(leg.prompt, textsOf(arrived)),
    resume: leg.resume,
    images: [...leg.images, ...stillsOf(arrived)],
  };
}

/**
 * Settle a leg that ended: what it read natively is recorded (the queue knows), what it took by
 * being interrupted goes to the next leg. Returns the turn's result when this leg ends the turn,
 * null when the turn goes on.
 */
async function afterLeg(turn: TurnLegs, outcome: LegOutcome): Promise<DelegateResult | null> {
  const { steer, ctx } = turn;
  const { result } = outcome;
  // Read natively → recorded where; taken by interrupting this leg → ours to deliver next.
  turn.interrupted = await steer.close(result);
  if (result) turn.legs.push(result);
  turn.last = result;
  const ours = turn.interrupted.length > 0 && !ctx.cancelled && cutForSteer(outcome);
  if (ours && !result?.studioToolCalls?.length) return null;
  const neverRead = !result || (ctx.cancelled && !(result.turns > 0));
  if (neverRead) await steer.requeue(steer.inOrder(turn.unread));
  // A Stop, a leg that ended on its own before the interrupt landed, or a failure: these wait.
  await steer.requeue(turn.interrupted);
  if (!result) throw outcome.failure;
  const ended = merged(turn, result);
  // A Loop chat that had already asked its question or launched has ended its turn: the
  // message waits for the next one (the answer, or the build it launched) instead.
  if (ours) return { ...ended, ok: true, stopReason: StopReason.Completed };
  return ended;
}

/** The leg ended because the host interrupted it to hand it messages, not on its own. */
function cutForSteer(outcome: LegOutcome): boolean {
  if (!outcome.result) return isAborted(outcome.failure);
  return !outcome.result.ok && outcome.result.stopReason === StopReason.Stopped;
}

/** The turn's answer: the last leg's, with every leg's turns, recorded launch and question calls and reads. */
function merged(turn: TurnLegs, result: DelegateResult): DelegateResult {
  return {
    ...result,
    turns: turn.legs.reduce((n, leg) => n + (leg.turns ?? 0), 0),
    studioToolCalls: turn.legs.flatMap((leg) => leg.studioToolCalls ?? []),
    steered: turn.legs.flatMap((leg) => leg.steered ?? []),
  };
}

/** Stopped between legs: what no session read goes back to the queue, and the turn reads as a Stop. */
async function stopped(turn: TurnLegs): Promise<DelegateResult> {
  const { steer, options } = turn;
  await steer.requeue(steer.inOrder(turn.unread));
  await steer.close();
  const resume = options.resume ?? null;
  const last: DelegateResult = turn.legs.at(-1) ?? {
    ok: false,
    summary: "",
    usage: {},
    turns: 0,
    engine: "",
    ...(resume ? { sessionId: resume } : {}),
  };
  return { ...merged(turn, last), ok: false, stopReason: StopReason.Stopped };
}
