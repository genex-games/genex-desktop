/**
 * Play-time models for a game played in its engine's editor (docs/plugins.md, Unreal). A web game's
 * preview takes the practice helper's key in its page's address (`preview-ai.ts`); an Unreal game
 * has no page, so the key is named in `<game>/.studio/llm-practice.json`, `{"key":"<port>.<token>"}`.
 * Genex's Unreal plugin (GenexMultiplayerEditor's GenexLocalPractice) reads it each time Play in the
 * editor begins, checks the port answers and hands the key to the play, whose model calls then go
 * to the helper on this computer; with no file, or one whose port no longer answers, the play asks
 * Genex as a published game does. A play keeps the key it began with, so a change of helper reaches
 * the next Play. Only an editor build of the plugin takes a key: a packaged game never does.
 *
 * The helper is Live's own (`LIVE_HANDLE`), so what the person chose in Live's bar for the game
 * (practice answers, real models for a cap) answers the editor's play as it does a web preview. The
 * file exists only while Live shows the game's Unreal card and a helper runs: it is rewritten when
 * the helper changes and removed when Live leaves the game, Live stops, no helper runs, or the app
 * quits. It is written and removed as every handoff is (`editor-handoff.ts`).
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../../shared/errors.ts";
import { type PreviewAiState, PreviewAiUnavailable } from "../../shared/preview-ai.ts";
import { removeHandoff, writeHandoff } from "./editor-handoff.ts";
import { PRACTICE_PARAM, practiceKey } from "./preview-ai.ts";

/** The handoff's name in the game's `.studio`. */
const HANDOFF_FILE = "llm-practice.json";
/** The file that makes a folder a game of Genex's: the Unreal plugin looks for `.studio` beside it. */
const GAME_RECORD = "studio.json";

const MESSAGE = {
  notAKey: "not a practice helper's key",
  notAGame: (game: string) => `${game} holds no ${GAME_RECORD}`,
  notNamed: (project: string, error: unknown) =>
    `[practice] ${project}: the helper was not named to the editor: ${errorMessage(error)}`,
  notUnnamed: (project: string, error: unknown) =>
    `[practice] ${project}: ${HANDOFF_FILE} was not removed: ${errorMessage(error)}`,
  failed: (project: string, error: unknown) => `[practice] ${project}: ${errorMessage(error)}`,
} as const;

/** The handoff's text for `key`: compact, the whole file, as the Unreal plugin's parser takes it. */
const handoffText = (key: string) => JSON.stringify({ key });

/**
 * A helper's key as the handoff carries it, `<port>.<32 hex>`, from the service's
 * `genex_llm_practice=<port>.<32 hex>`; null for anything else, a port written with a leading zero
 * included (the Unreal plugin refuses one).
 */
export function handoffKey(key: unknown): string | null {
  const whole = practiceKey(key);
  if (whole === null) return null;
  const bare = whole.slice(PRACTICE_PARAM.length + 1);
  return bare.startsWith("0") ? null : bare;
}

/** Whether `value` is a key in the handoff's own spelling. */
const isHandoffKey = (value: string): boolean => handoffKey(`${PRACTICE_PARAM}=${value}`) === value;

/**
 * Name the helper with `key` (`<port>.<32 hex>`) in `game`'s `.studio/llm-practice.json`. Throws,
 * writing nothing, for anything that is not a key, a folder that holds no `studio.json` of its own,
 * and through a link.
 */
export async function namePractice(game: string, key: string): Promise<void> {
  if (!isHandoffKey(key)) throw new Error(MESSAGE.notAKey);
  const record = await lstat(path.join(game, GAME_RECORD)).catch(() => null);
  if (!record?.isFile()) throw new Error(MESSAGE.notAGame(game));
  await writeHandoff(game, HANDOFF_FILE, handoffText(key));
}

/** Remove the handoff while it is a plain file in a plain `.studio` and still names `key`. */
export function unnamePractice(game: string, key: string): Promise<void> {
  return removeHandoff(game, HANDOFF_FILE, handoffText(key));
}

/** What the editor's practice needs: Live's helper, the game's folder and code, Live's own page. */
export interface EditorPracticeDeps {
  /** Live's hold on the practice helpers (`PreviewAiService` with `LIVE_HANDLE`). */
  ai: {
    /** The key of the helper Live gets for the game, started when it must be; null when none could start. */
    keyFor(project: string): Promise<string | null>;
    /** Live shows a game that calls no model: it lets go of its helper, and the bar goes. */
    noModels(project: string): Promise<void>;
    /** Live shows no game that needs a helper. */
    release(): Promise<void>;
  };
  /** The game's folder. */
  gameDir: (project: string) => string;
  /** Whether the game's engine project calls Genex's models (`unrealGameCallsPlayTimeModels`). */
  callsModels: (dir: string) => Promise<boolean>;
  /** Live's own page, which holds the same helper while it runs a game with a key. */
  page: {
    /** The game Live's page runs with a helper's key now, or null. */
    keyed(): string | null;
    /** Stop Live's page as the person's Stop does: the helper its key names is about to go. */
    stop(): Promise<void>;
  };
  /** Run `op` in Live's queue, so a load of Live's page and a change here never cross. */
  serial: <T>(op: () => Promise<T>) => Promise<T>;
  log: (line: string) => void;
}

/** The game whose editor play holds Live's helper, and the key its handoff names (null: none is written). */
interface Held {
  project: string;
  key: string | null;
}

/** Live's helper for the game whose Unreal card Live shows, named to the editor in the game's folder. */
export class EditorPractice {
  readonly #deps: EditorPracticeDeps;
  #held: Held | null = null;
  /** A key is being asked for here: a failure the service reports meanwhile is this ask's own. */
  #asking = false;

  constructor(deps: EditorPracticeDeps) {
    this.#deps = deps;
  }

  /**
   * Live shows `project`'s Unreal card. A game whose Unreal project calls Genex's models gets Live's
   * helper, named in its handoff; a page of another game that ran in Live with a key stops first, as
   * its helper goes. A game that calls none gets no file, and its bar goes.
   */
  show(project: string): Promise<void> {
    return this.#queued(project, () => this.#show(project));
  }

  /** Live shows `project`'s Unreal card no longer: its handoff goes, and the helper unless Live's page runs the game. */
  leave(project: string): Promise<void> {
    return this.#queued(project, async () => {
      if (this.#held?.project !== project) return;
      await this.#forget();
      if (this.#deps.page.keyed() !== project) await this.#deps.ai.release();
    });
  }

  /** The game's helper changed (real models, practice again, a run that ended): its handoff names the one that answers now. */
  rekey(project: string): Promise<void> {
    return this.#queued(project, async () => {
      if (this.#held?.project === project) await this.#name(this.#held);
    });
  }

  /**
   * Live's page asked the service for `project`'s helper, or said it needs none, and Live's hold
   * moved with it. A page that now runs another game with a key took the helper, and the held
   * game's handoff goes; any other page left it free, and the held game is named a helper again.
   */
  pageAsked(project: string): Promise<void> {
    return this.#queued(project, async () => {
      const held = this.#held;
      if (held === null) return;
      const onPage = this.#deps.page.keyed();
      if (onPage !== null && onPage !== held.project) await this.#forget();
      else await this.#name(held);
    });
  }

  /** A state the service told the bar: a helper of the held game that failed outside an ask here is asked for again. */
  heard(state: PreviewAiState): void {
    const ended = state.reason === PreviewAiUnavailable.HelperFailed && !this.#asking;
    if (ended && this.#held?.project === state.project) void this.rekey(state.project);
  }

  /** Live stopped and let go of its helper, in Live's queue already: the handoff goes. */
  async liveStopped(): Promise<void> {
    await this.#forget();
  }

  /** The app quits: no handoff is left behind. */
  async stopAll(): Promise<void> {
    await this.#forget();
  }

  /** Every change asked for so far has been made. */
  idle(): Promise<void> {
    return this.#deps.serial(async () => {});
  }

  /** One change at a time, in Live's queue; a failure is logged, never thrown. */
  #queued(project: string, op: () => Promise<void>): Promise<void> {
    return this.#deps.serial(op).catch((error: unknown) => this.#deps.log(MESSAGE.failed(project, error)));
  }

  async #show(project: string): Promise<void> {
    if (this.#held && this.#held.project !== project) await this.#forget();
    const onPage = this.#deps.page.keyed();
    if (!(await this.#deps.callsModels(this.#deps.gameDir(project)))) {
      await this.#forget();
      // Live's page keeps the helper it runs with; only a Live that holds none is told.
      if (onPage === null) await this.#deps.ai.noModels(project);
      return;
    }
    if (onPage !== null && onPage !== project) await this.#deps.page.stop();
    this.#held ??= { project, key: null };
    await this.#name(this.#held);
  }

  /** Ask for the held game's helper and name it; with none, or a key that is not one, no file stays. */
  async #name(held: Held): Promise<void> {
    this.#asking = true;
    const asked = await this.#deps.ai.keyFor(held.project).finally(() => {
      this.#asking = false;
    });
    const key = handoffKey(asked);
    const game = this.#deps.gameDir(held.project);
    if (held.key !== null && held.key !== key) await this.#unname(held);
    if (key === null) return;
    try {
      await namePractice(game, key);
      held.key = key;
    } catch (error) {
      this.#deps.log(MESSAGE.notNamed(held.project, error));
    }
  }

  /** Remove the held game's handoff, if one was written. */
  async #unname(held: Held): Promise<void> {
    const { key } = held;
    held.key = null;
    if (key === null) return;
    await unnamePractice(this.#deps.gameDir(held.project), key).catch((error: unknown) =>
      this.#deps.log(MESSAGE.notUnnamed(held.project, error)),
    );
  }

  /** The editor's play holds Live's helper no longer: its handoff goes. */
  async #forget(): Promise<void> {
    const held = this.#held;
    this.#held = null;
    if (held) await this.#unname(held);
  }
}
