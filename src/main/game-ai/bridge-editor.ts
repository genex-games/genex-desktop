/**
 * Play-time AI for a game played in its engine's editor (docs/play-protocol.md, "Play-time AI in an
 * engine's editor"). The game's SDK (`genex_ai.gd`, `com.genex.ai`, `GenexAI`) queues the same `ai`
 * lines a native player prints, and Studio pulls them through the editor channel the engine plugin
 * already has — Godot's `.godot/genex/` folder, Unity's Pipeline server, Unreal's editor port — so
 * no new port or token is made. Each pull is read as Play Protocol `ai` lines; anything else is
 * dropped before it reaches the service. Answers go back on the next push, by their rid.
 *
 * The caller is main's: the creator's own game (`create:<library name>`), in Create Live while a
 * person plays and in a harness run while the agent plays (the plugin's agent-play marker). A play
 * that ends — the editor stops playing, or a pull fails — abandons its calls, and the next play
 * starts afresh. The editor runs its own clock, so an answer goes out as soon as it settles.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { createGameKey } from "../../shared/game-ai.ts";
import { AiContext } from "../../shared/game-ai-route.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  PLAY_AI_MAX_IN_FLIGHT,
  PLAY_AI_MAX_LINE_CHARS,
  type PlayAiLine,
  readPlayAiLine,
} from "../../shared/play-protocol.ts";
import {
  type AiLinePlace,
  type AiOutgoing,
  aiLineBridge,
  type NativeAiBridge,
  type NativeAiService,
} from "./bridge-native.ts";
import type { GameAiCaller } from "./types.ts";

/** How often Studio pulls an editor's queued lines while it relays for it. */
export const EDITOR_AI_POLL_MS = 250;
/** The most lines one pull reads: twice what may be in flight, so a burst is refused, not lost silently. */
export const EDITOR_AI_MAX_PULL = 2 * PLAY_AI_MAX_IN_FLIGHT;

const MESSAGE = {
  dropped: (why: string) => `[play-ai] dropped an editor line: ${why}`,
  unread: "it is not an ai line the studio can read",
  oversize: `it is longer than ${PLAY_AI_MAX_LINE_CHARS} characters`,
  tooMany: (count: number) => `[play-ai] dropped ${count} editor lines: more than ${EDITOR_AI_MAX_PULL} in one pull`,
  pullFailed: (why: string) => `[play-ai] the editor's lines could not be read: ${why}`,
  pushRefused: "[play-ai] the editor did not take its answers",
  pushFailed: (why: string) => `[play-ai] the editor's answers could not be handed over: ${why}`,
} as const;

/** One engine editor's AI channel. Neither call is ever retried by the relay. */
export interface EditorAiChannel {
  /**
   * The `ai` lines the game queued since the last pull, each as the parsed object it wrote, taken
   * out of the editor's queue; null while no game plays in the editor.
   */
  pull(signal: AbortSignal): Promise<unknown[] | null>;
  /** Hand the playing game its answers, in order; false when the editor did not take them. */
  push(items: readonly AiOutgoing[], signal: AbortSignal): Promise<boolean>;
}

/** The game an editor plays, as main knows it: its library name and the name people see. */
export interface EditorAiGame {
  name: string;
  title: string;
}

/**
 * The caller of a game played in its editor: the creator's own game, in Create Live while a person
 * plays it and in a harness run while the agent does. An editor play is never a replay.
 */
export function editorCaller(game: EditorAiGame, place: AiLinePlace, agentPlaying: boolean): GameAiCaller {
  return {
    game: createGameKey(game.name),
    title: game.title,
    context: agentPlaying ? AiContext.HarnessRun : AiContext.CreateLive,
    ownGame: true,
    replaying: false,
    channel: place.channel,
  };
}

/** What a relay runs on. */
export interface EditorAiRelayOptions {
  service: NativeAiService;
  game: EditorAiGame;
  place: AiLinePlace;
  /** Whether the agent plays the game in the editor right now (the plugin's agent-play marker). */
  agentPlaying: () => boolean;
  log?: (line: string) => void;
}

/** One editor's relay: a tick pulls, asks and pushes; close abandons what is in flight. */
export interface EditorAiRelay {
  tick(signal: AbortSignal): Promise<void>;
  close(): void;
}

/** The lines of one pull Studio reads: each an `ai` line within its cap, at most {@link EDITOR_AI_MAX_PULL}. */
function readPulled(raw: readonly unknown[], log: (line: string) => void): PlayAiLine[] {
  if (raw.length > EDITOR_AI_MAX_PULL) log(MESSAGE.tooMany(raw.length - EDITOR_AI_MAX_PULL));
  const lines: PlayAiLine[] = [];
  for (const item of raw.slice(0, EDITOR_AI_MAX_PULL)) {
    // The cap is the Play Protocol line's, counted on the line as the game would print it.
    const oversize = JSON.stringify(item ?? null).length > PLAY_AI_MAX_LINE_CHARS;
    const line = oversize ? null : readPlayAiLine(item);
    if (line) lines.push(line);
    else log(MESSAGE.dropped(oversize ? MESSAGE.oversize : MESSAGE.unread));
  }
  return lines;
}

/** The relay of one editor's AI channel to the service, for the game it plays. */
export function editorAiRelay(channel: EditorAiChannel, options: EditorAiRelayOptions): EditorAiRelay {
  const log = options.log ?? (() => {});
  const outbox: AiOutgoing[] = [];
  const host = {
    service: options.service,
    callerFor: (place: AiLinePlace) => editorCaller(options.game, place, options.agentPlaying()),
    log,
  };
  let bridge: NativeAiBridge | null = null;
  let closed = false;

  const endPlay = () => {
    bridge?.close();
    bridge = null;
    outbox.length = 0;
  };
  const playing = (): NativeAiBridge => {
    bridge ??= aiLineBridge(
      async (item) => {
        outbox.push(item);
      },
      options.place,
      host,
      () => false,
    );
    return bridge;
  };
  const pull = async (signal: AbortSignal): Promise<unknown[] | null> => {
    try {
      return await channel.pull(signal);
    } catch (error) {
      log(MESSAGE.pullFailed(errorMessage(error)));
      return null;
    }
  };
  const push = async (signal: AbortSignal): Promise<void> => {
    const items = outbox.splice(0);
    if (!items.length) return;
    const taken = await channel.push(items, signal).catch((error: unknown) => {
      log(MESSAGE.pushFailed(errorMessage(error)));
      return true;
    });
    if (!taken) log(MESSAGE.pushRefused);
  };

  return {
    async tick(signal) {
      if (closed) return;
      const raw = await pull(signal);
      if (closed) return;
      if (raw === null) {
        endPlay();
        return;
      }
      const current = playing();
      for (const line of readPulled(raw, log)) current.hear(line);
      await current.flush();
      await push(signal);
    },
    close() {
      if (closed) return;
      closed = true;
      endPlay();
    },
  };
}

/** Runs a relay on its cadence until `signal` aborts, then closes it. A tick's failure never ends the loop. */
export async function runEditorAiRelay(
  relay: EditorAiRelay,
  options: { signal: AbortSignal; pollMs?: number; sleep?: (ms: number, signal: AbortSignal) => Promise<void> },
): Promise<void> {
  const pollMs = options.pollMs ?? EDITOR_AI_POLL_MS;
  const wait =
    options.sleep ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }).catch(() => undefined));
  try {
    while (!options.signal.aborted) {
      await relay.tick(options.signal).catch(() => undefined);
      if (options.signal.aborted) break;
      await wait(pollMs, options.signal);
    }
  } finally {
    relay.close();
  }
}
