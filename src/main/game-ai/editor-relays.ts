/**
 * The editor AI relays main keeps running: one per engine editor a library game is linked to
 * (`bridge-editor.ts`), so a game played in Godot's or Unity's own editor gets its `ai` lines
 * answered. The set follows the library: a game linked since is relayed on the next sync, one
 * unlinked or gone is stopped and its calls abandoned. A pull from an editor that is closed or plays
 * nothing answers no play, so a relay for an editor that is not open costs one cheap read a tick.
 *
 * Who plays decides the caller: while a run is going in the game the agent plays it (a harness run,
 * which never spends), otherwise a person does (Create Live, which answers `ai_off` while Settings'
 * "AI in your playtests" is off, D1).
 */
import { setTimeout as sleep } from "node:timers/promises";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import {
  type EditorAiChannel,
  type EditorAiGame,
  editorAiRelay,
  EDITOR_AI_POLL_MS,
  runEditorAiRelay,
} from "./bridge-editor.ts";
import type { NativeAiService } from "./bridge-native.ts";

/** How often the set of relayed editors is read again from the library. */
export const EDITOR_AI_SYNC_MS = 5 * SECOND_MS;

const MESSAGE = {
  syncFailed: (why: string) => `[play-ai] the editors to relay could not be read: ${why}`,
} as const;

/** One engine editor a library game is linked to, as a relay reaches it. */
export interface EditorAiTarget {
  /** Stable while the link holds: the engine and the project's real folder. */
  key: string;
  game: EditorAiGame;
  /** The engine project's folder. */
  cwd: string;
  channel: EditorAiChannel;
}

/** What the relays run on. */
export interface EditorAiRelaysOptions {
  service: NativeAiService;
  /** The editors to relay now: every library game linked to an engine whose channel main can reach. */
  targets(): Promise<readonly EditorAiTarget[]>;
  /** The library games a run is going in now: their editor plays are the agent's. */
  runningGames(): Promise<ReadonlySet<string>>;
  /** Settings' "AI in your playtests" (D1). */
  createRouteEnabled(): boolean;
  pollMs?: number;
  syncMs?: number;
  /** A pause that ends early when `signal` aborts (tests hold it short). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  log?: (line: string) => void;
}

/** The relays' set: synced on its own cadence once started, and stopped whole. */
export interface EditorAiRelays {
  start(): void;
  /** Read the targets and the running games now: start what is new, stop what is gone. */
  sync(): Promise<void>;
  /** The keys relayed now. */
  relayed(): string[];
  stop(): Promise<void>;
}

/** One relay running: how to stop it, and when it has. */
interface Running {
  controller: AbortController;
  done: Promise<void>;
}

const pauseFor = (ms: number, signal: AbortSignal): Promise<void> =>
  sleep(ms, undefined, { signal }).catch(() => undefined);

/** The editor AI relays over `options`. */
export function editorAiRelays(options: EditorAiRelaysOptions): EditorAiRelays {
  const log = options.log ?? (() => {});
  const wait = options.sleep ?? pauseFor;
  const running = new Map<string, Running>();
  let agents: ReadonlySet<string> = new Set();
  const loop = new AbortController();
  let looping: Promise<void> | null = null;

  const begin = (target: EditorAiTarget): Running => {
    const controller = new AbortController();
    const relay = editorAiRelay(target.channel, {
      service: options.service,
      game: target.game,
      place: { cwd: target.cwd, channel: `editor:${target.key}` },
      agentPlaying: () => agents.has(target.game.name),
      createRouteEnabled: options.createRouteEnabled,
      log,
    });
    const done = runEditorAiRelay(relay, {
      signal: controller.signal,
      pollMs: options.pollMs ?? EDITOR_AI_POLL_MS,
      sleep: wait,
    });
    return { controller, done };
  };
  const end = async (key: string): Promise<void> => {
    const relay = running.get(key);
    if (!relay) return;
    running.delete(key);
    relay.controller.abort();
    await relay.done;
  };

  const sync = async (): Promise<void> => {
    if (loop.signal.aborted) return;
    const [targets, games] = await Promise.all([options.targets(), options.runningGames()]);
    agents = games;
    if (loop.signal.aborted) return;
    const wanted = new Map(targets.map((target) => [target.key, target]));
    await Promise.all([...running.keys()].filter((key) => !wanted.has(key)).map(end));
    for (const [key, target] of wanted) if (!running.has(key)) running.set(key, begin(target));
  };

  return {
    start() {
      if (looping || loop.signal.aborted) return;
      looping = (async () => {
        while (!loop.signal.aborted) {
          await sync().catch((error: unknown) => log(MESSAGE.syncFailed(errorMessage(error))));
          await wait(options.syncMs ?? EDITOR_AI_SYNC_MS, loop.signal);
        }
      })();
    },
    sync,
    relayed: () => [...running.keys()],
    async stop() {
      loop.abort();
      await looping;
      await Promise.all([...running.keys()].map(end));
    },
  };
}
