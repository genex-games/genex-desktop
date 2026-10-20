/**
 * The model check's moments (D10): the AI moments of the creator's own playtests, saved with their
 * requests so the check can replay each one on another model and compare. A tape keeps only a
 * call's key, so the request itself is kept here.
 *
 * A moment is a fitting answer a model gave in Create Live, in the creator's own game, while a
 * person played: never a published game, a harness run, a replay, a tape or a fixture. The newest
 * answer to a call replaces an older one, and a game keeps its newest {@link MOMENTS_MAX_PER_GAME}.
 * They live in `userData/game-ai/moments/<sha-256 of the game's name>.json`, outside every root an
 * agent may write, and are read back as hostile input all the same.
 */
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { AiContext } from "../../shared/game-ai-route.ts";
import {
  type AiCallRequest,
  AiDoor,
  AiGameKind,
  type AiModelRef,
  isPlainRecord,
  readAiCallRequest,
} from "../../shared/game-ai.ts";
import { AiValidation } from "../../shared/game-ai-report.ts";
import { validateValue } from "../../shared/game-ai-schema.ts";
import { callKey, callKeyInput } from "../../shared/game-ai-tape.ts";
import { readAiModelRef } from "../../shared/game-ai-views.ts";
import { AsyncLock, atomicWriteJson, ensureDir, readRegularFile } from "../../substrate/fsx.ts";
import type { AiCallTrace, GameAiCaller, GameAiClock } from "./types.ts";

/** The folder the moments live in, inside play-time AI's own folder. */
export const MOMENTS_DIR = "moments";
/** The most moments one game keeps. */
export const MOMENTS_MAX_PER_GAME = 60;
/** The largest moments file read back: sixty full-size calls with their answers fit. */
const MOMENTS_MAX_FILE_BYTES = 32 * 1024 * 1024;
const FILE_VERSION = 1;
/** Doors whose answers are not a model's: replays and fixtures. */
const NOT_A_MODEL: readonly AiDoor[] = [AiDoor.Tape, AiDoor.Fixture];

/** One saved moment: a call of the creator's playtest and the answer the playtest got. */
export interface AiMoment {
  /** `callKey` of the request: one moment per call. */
  key: string;
  request: AiCallRequest;
  value: unknown;
  /** The model that answered in the playtest. */
  model: AiModelRef | null;
  /** When it was played (ISO). */
  at: string;
}

/** What the store needs. */
export interface MomentStoreDeps {
  /** Play-time AI's own folder (`userData/game-ai`). */
  dir: string;
  clock: GameAiClock;
}

/** The creator's playtest moments, per game in their library. */
export interface GameAiMoments {
  /** Keep a settled call of the creator's own playtest, when it is a model's fitting answer. */
  remember(caller: GameAiCaller, trace: AiCallTrace): Promise<void>;
  /** A game's moments, oldest first. */
  list(project: string): Promise<AiMoment[]>;
  count(project: string): Promise<number>;
}

/** A game's moments file, by a hash of its name: a name never becomes a path. */
export const momentsFile = (dir: string, project: string): string =>
  path.join(dir, MOMENTS_DIR, `${createHash("sha256").update(project).digest("hex")}.json`);

const KEY_RE = /^[0-9a-f]{64}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** The library name of a `create:` game, or null for any other game. */
function projectOf(caller: GameAiCaller): string | null {
  const prefix = `${AiGameKind.Create}:`;
  return caller.game.startsWith(prefix) ? caller.game.slice(prefix.length) : null;
}

/** Whether a trace is a moment of a person's playtest of their own game. */
function isMoment(caller: GameAiCaller, trace: AiCallTrace): boolean {
  const live = caller.context === AiContext.CreateLive && caller.ownGame && !caller.replaying;
  const fitted = trace.validation === AiValidation.Valid || trace.validation === AiValidation.Repaired;
  return live && fitted && !NOT_A_MODEL.includes(trace.door) && validateValue(trace.request.schema, trace.value);
}

/** One saved moment as hostile input, or null. */
function readMoment(raw: unknown): AiMoment | null {
  if (!isPlainRecord(raw)) return null;
  const request = readAiCallRequest(raw.request);
  const model = raw.model === null ? null : readAiModelRef(raw.model);
  const { key, at, value } = raw;
  if (!request || (raw.model !== null && !model)) return null;
  if (typeof key !== "string" || !KEY_RE.test(key) || typeof at !== "string" || !ISO_RE.test(at)) return null;
  return validateValue(request.schema, value) ? { key, request, value, model, at } : null;
}

/** The moments store over `deps`. */
export function createMomentStore(deps: MomentStoreDeps): GameAiMoments {
  const lock = new AsyncLock();

  const read = async (project: string): Promise<AiMoment[]> => {
    const file = momentsFile(deps.dir, project);
    const exists = await stat(file).catch(() => null);
    if (!exists) return [];
    const text = await readRegularFile(file, MOMENTS_MAX_FILE_BYTES)
      .then((bytes) => bytes.toString("utf8"))
      .catch(() => "");
    let saved: unknown = null;
    try {
      saved = JSON.parse(text);
    } catch {
      return [];
    }
    if (!isPlainRecord(saved) || saved.v !== FILE_VERSION || !Array.isArray(saved.moments)) return [];
    return saved.moments.map(readMoment).filter((moment) => moment !== null);
  };

  const remember = async (caller: GameAiCaller, trace: AiCallTrace): Promise<void> => {
    const project = projectOf(caller);
    if (project === null || !isMoment(caller, trace)) return;
    const key = await callKey(callKeyInput(trace.request));
    const moment: AiMoment = {
      key,
      request: trace.request,
      value: trace.value,
      model: trace.model,
      at: new Date(deps.clock.now()).toISOString(),
    };
    await lock.run(async () => {
      const kept = (await read(project)).filter((known) => known.key !== key);
      const moments = [...kept, moment].slice(-MOMENTS_MAX_PER_GAME);
      await ensureDir(path.join(deps.dir, MOMENTS_DIR));
      await atomicWriteJson(momentsFile(deps.dir, project), { v: FILE_VERSION, moments });
    });
  };

  const list = (project: string) => lock.run(() => read(project));
  const count = async (project: string) => (await list(project)).length;

  return { remember, list, count };
}
