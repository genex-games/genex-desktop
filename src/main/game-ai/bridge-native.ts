/**
 * Play-time AI for a native game Studio started (docs/play-protocol.md, "Play-time AI"): the
 * game's `ai` lines, heard by its Play Protocol client, become calls on the AI service under a
 * caller main derives from where the process runs (never from a line), and each answer goes back
 * once as the optional op `ai.reply {rid, reply}`, a streamed `say` as `ai.delta {rid, text}`.
 *
 * Answers arrive on step boundaries. While the studio holds the game's clock (paused, or stepped),
 * nothing is written to the game between steps: what settled waits for the next step, and a step
 * of a replay first waits (up to {@link NATIVE_AI_REPLAY_WAIT_MS}) for the answers its tape holds,
 * so the same seed and inputs get every answer on the same tick. While the clock runs, an answer
 * goes out as soon as it settles.
 *
 * A fifth unanswered line, a line repeating a rid still unanswered, and a line from a game AI is
 * off for are answered at once with a refusal and never reach the service: a refusal has no side
 * effect. A game whose `hello` did not declare `capabilities.ai` gets no bridge at all.
 */
import { AiBridgeOp, AiErrorCode, createGameKey, GAME_AI_WIRE_VERSION, refusedAnswer } from "../../shared/game-ai.ts";
import type { AiBridgeAnswers, AiBridgeMessage } from "../../shared/game-ai-bridge.ts";
import { AiContext } from "../../shared/game-ai-route.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  PLAY_AI_MAX_IN_FLIGHT,
  type PlayAiLine,
  PlayAiOp,
  type PlayAiOutgoing,
  type PlayHello,
  takesAiOp,
} from "../../shared/play-protocol.ts";
import type { PlayClient, PlayDeadlines } from "../../substrate/play-protocol-client.ts";
import type { GameAiCaller } from "./types.ts";

/** How long a step of a replay waits for the answers its tape holds before it runs without them. */
export const NATIVE_AI_REPLAY_WAIT_MS = 5 * SECOND_MS;

/** What any bridge answers one op with. */
export type AiBridgeAnswer = AiBridgeAnswers[AiBridgeMessage["op"]];

const MESSAGE = {
  repeated: (rid: string) => `[play-ai] dropped a line repeating the unanswered rid ${rid}`,
  failed: (why: string) => `[play-ai] the AI service failed a line: ${why}`,
  refused: (op: string, why: string) => `[play-ai] the game did not take ${op}: ${why}`,
  undeclared: "the game's hello did not declare ai",
} as const;

/** Deadlines on the real clock; an armed one never keeps the studio alive. */
const REAL_DEADLINES: PlayDeadlines = {
  after(ms, fire) {
    const timer = setTimeout(fire, ms);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
};

/**
 * What a bridge answers a message it will not run, by its op: AI off for `hello` and `doors`, the
 * code for a call or a grant, and nothing canceled or stopped.
 */
export function refusedBridgeAnswer(message: AiBridgeMessage, code: AiErrorCode): AiBridgeAnswer {
  switch (message.op) {
    case AiBridgeOp.Hello:
      return { v: GAME_AI_WIRE_VERSION, on: false };
    case AiBridgeOp.Doors:
      return { on: false, door: null };
    case AiBridgeOp.Call:
      return refusedAnswer(message.body.ticket, code);
    case AiBridgeOp.Cancel:
      return { canceled: false };
    case AiBridgeOp.BudgetActive:
    case AiBridgeOp.BudgetRequest:
      return { view: null, code };
    case AiBridgeOp.BudgetStop:
      return { stopped: false };
  }
}

/** A line's bridge message without its rid: what the service is handed. */
export function bridgeMessageOf(line: PlayAiLine): AiBridgeMessage {
  switch (line.op) {
    case AiBridgeOp.Hello:
    case AiBridgeOp.Doors:
    case AiBridgeOp.BudgetActive:
    case AiBridgeOp.BudgetStop:
      return { op: line.op, body: null };
    case AiBridgeOp.Call:
      return { op: line.op, body: line.body };
    case AiBridgeOp.Cancel:
      return { op: line.op, body: line.body };
    case AiBridgeOp.BudgetRequest:
      return { op: line.op, body: line.body };
  }
}

/** Where a game's AI lines come from, as main knows it: its folder and the bridge's own id for it. */
export interface AiLinePlace {
  cwd: string;
  /** The process's (or the editor play's) channel id, which `abandon` names when it goes away. */
  channel: string;
}

/** Where a native game runs, as main knows it: its folder, the bridge's own id for it and its hello. */
export interface NativeAiPlace extends AiLinePlace {
  hello: PlayHello;
}

/**
 * The caller of a native player Studio started for a game of the person's library: their own
 * game, with no person attached to the process (an agent's playtest, a judge, a check), so only
 * tapes, fixtures and this Mac's models answer it (`LEGAL_DOORS[AiContext.Native]`).
 */
export function nativeCaller(
  game: { name: string; title: string },
  place: AiLinePlace,
  replaying: boolean,
): GameAiCaller {
  return {
    game: createGameKey(game.name),
    title: game.title,
    context: AiContext.Native,
    ownGame: true,
    replaying,
    channel: place.channel,
  };
}

/**
 * The part of the AI service a bridge calls: one message under main's caller, and a process gone.
 * `GameAiService` is one; its `handle` answers each op with that op's own answer.
 */
export interface NativeAiService {
  handle(caller: GameAiCaller, message: AiBridgeMessage, onDelta?: (text: string) => void): Promise<AiBridgeAnswer>;
  abandon(channel: string): void;
}

/** What a native game's AI runs on. */
export interface NativeAiHost {
  service: NativeAiService;
  /** The caller for this process, derived by main from where it runs; null: AI is off for it. */
  callerFor(place: AiLinePlace): GameAiCaller | null;
  deadlines?: PlayDeadlines;
  log?: (line: string) => void;
}

/**
 * The host of a game that declared `capabilities.ai` where Studio wired no AI: every line is
 * answered `ai_off` at once, so the game plays its fallbacks instead of waiting.
 */
export const NATIVE_AI_OFF: NativeAiHost = {
  service: {
    handle: async (_caller, message) => refusedBridgeAnswer(message, AiErrorCode.Off),
    abandon: () => {},
  },
  callerFor: () => null,
};

/**
 * The host of a native player Studio started for `game` of the person's library: every line is
 * asked as that game ({@link nativeCaller}), replaying when the run replays a saved playtest.
 */
export function nativeAiHost(
  service: NativeAiService,
  game: { name: string; title: string },
  options: { replaying: boolean; log?: (line: string) => void },
): NativeAiHost {
  return {
    service,
    callerFor: (place) => nativeCaller(game, place, options.replaying),
    ...(options.log ? { log: options.log } : {}),
  };
}

/** A game's AI bridge: its `ai` lines in, each answer out once by its rid. */
export interface NativeAiBridge {
  /** One `ai` line the game printed, read. */
  hear(line: PlayAiLine): void;
  /** Before a step of a held clock: wait for a replay's answers, then deliver everything settled. */
  boundary(): Promise<void>;
  /** Deliver everything settled now (the clock started running). */
  flush(): Promise<void>;
  /** Lines heard and not yet answered. */
  inFlight(): number;
  /** The process went away: its calls are abandoned and nothing more is written. */
  close(): void;
}

/** One line the service is answering: what is known of it, and what of that the game already has. */
interface Pending {
  replaying: boolean;
  settled: Promise<void>;
  reply: AiBridgeAnswer | null;
  /** A streamed answer's latest text, and the text the game was last sent. */
  delta: string | null;
  sentDelta: string | null;
}

/** One AI op to write to a game: an answer by its rid, or a streamed answer's text so far. */
export type AiOutgoing = PlayAiOutgoing;
type Outgoing = AiOutgoing;

/** The bridge's state: unanswered lines in arrival order, and refusals not yet written. */
interface BridgeState {
  pending: Map<string, Pending>;
  refusals: Outgoing[];
  closed: boolean;
}

/** What is ready to write, in order: refusals, then each pending line's reply or its newest text. */
function takeOutgoing(state: BridgeState): Outgoing[] {
  const out = state.refusals.splice(0);
  for (const [rid, entry] of state.pending) {
    if (entry.reply) {
      state.pending.delete(rid);
      out.push({ op: PlayAiOp.Reply, args: { rid, reply: entry.reply } });
    } else if (entry.delta !== null && entry.delta !== entry.sentDelta) {
      entry.sentDelta = entry.delta;
      out.push({ op: PlayAiOp.Delta, args: { rid, text: entry.delta } });
    }
  }
  return out;
}

/** Wait for every pending replay's answer, or the deadline, whichever comes first. */
function replaySettled(state: BridgeState, deadlines: PlayDeadlines): Promise<void> {
  const waits = [...state.pending.values()].filter((entry) => entry.replaying && !entry.reply);
  if (!waits.length) return Promise.resolve();
  return new Promise((resolve) => {
    const cancel = deadlines.after(NATIVE_AI_REPLAY_WAIT_MS, resolve);
    void Promise.all(waits.map((entry) => entry.settled)).then(() => {
      cancel();
      resolve();
    });
  });
}

/** Writes one AI op to the game; a refusal is the game's own (it is logged, never retried). */
export type AiOpWriter = (item: AiOutgoing) => Promise<unknown>;

/**
 * The AI bridge of a native game Studio started, or null for a game whose `hello` did not declare
 * `capabilities.ai`. `held` says whether the studio holds the game's clock right now.
 */
export function nativeAiBridge(
  client: Pick<PlayClient, "send">,
  place: NativeAiPlace,
  host: NativeAiHost,
  held: () => boolean,
): NativeAiBridge | null {
  const { hello } = place;
  if (!hello.capabilities.ai) return null;
  const write: AiOpWriter = (item) =>
    takesAiOp(hello, item.op) ? client.send(item.op, { ...item.args }) : Promise.reject(new Error(MESSAGE.undeclared));
  return aiLineBridge(write, { cwd: place.cwd, channel: place.channel }, host, held);
}

/**
 * The bridge between a game's `ai` lines and the AI service, whatever carries them: a native
 * player's Play Protocol, or an engine editor's relay (`bridge-editor.ts`). Each line is asked
 * under the caller main derives for `place`, and its answer is written once with `write`.
 */
export function aiLineBridge(
  write: AiOpWriter,
  place: AiLinePlace,
  host: NativeAiHost,
  held: () => boolean,
): NativeAiBridge {
  const deadlines = host.deadlines ?? REAL_DEADLINES;
  const log = host.log ?? (() => {});
  const state: BridgeState = { pending: new Map(), refusals: [], closed: false };

  const deliver = (item: Outgoing): Promise<void> =>
    write(item).then(
      () => {},
      (error: unknown) => log(MESSAGE.refused(item.op, errorMessage(error))),
    );
  const flush = async (): Promise<void> => {
    if (state.closed) return;
    await Promise.all(takeOutgoing(state).map(deliver));
  };
  const deliverSoon = () => {
    if (!held()) void flush();
  };
  const refuse = (line: PlayAiLine, code: AiErrorCode) => {
    state.refusals.push({ op: PlayAiOp.Reply, args: { rid: line.rid, reply: refusedBridgeAnswer(line, code) } });
    deliverSoon();
  };
  const run = (line: PlayAiLine, caller: GameAiCaller): Pending => {
    const message = bridgeMessageOf(line);
    const entry: Pending = {
      replaying: caller.replaying,
      settled: Promise.resolve(),
      reply: null,
      delta: null,
      sentDelta: null,
    };
    const onDelta = (text: string) => {
      if (state.closed || entry.reply) return;
      entry.delta = text;
      deliverSoon();
    };
    entry.settled = host.service.handle(caller, message, onDelta).then(
      (reply) => {
        entry.reply = reply;
      },
      (error: unknown) => {
        log(MESSAGE.failed(errorMessage(error)));
        entry.reply = refusedBridgeAnswer(message, AiErrorCode.Provider);
      },
    );
    void entry.settled.then(deliverSoon);
    return entry;
  };

  return {
    hear(line) {
      if (state.closed) return;
      if (state.pending.has(line.rid)) return log(MESSAGE.repeated(line.rid));
      if (state.pending.size >= PLAY_AI_MAX_IN_FLIGHT) return refuse(line, AiErrorCode.Concurrency);
      const caller = host.callerFor(place);
      if (!caller) return refuse(line, AiErrorCode.Off);
      state.pending.set(line.rid, run(line, caller));
    },
    boundary: async () => {
      await replaySettled(state, deadlines);
      await flush();
    },
    flush,
    inFlight: () => state.pending.size,
    close() {
      if (state.closed) return;
      state.closed = true;
      state.pending.clear();
      state.refusals = [];
      host.service.abandon(place.channel);
    },
  };
}
