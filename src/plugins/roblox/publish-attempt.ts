/**
 * The game's latest publish, as the publishing card follows it (`publish-attempts/<game>.json` in the
 * plugin's storage): written when the game's chat takes a publish, ended by the agent's
 * `publish-result` once Studio has published or the turn stopped for the person, and for a first
 * publish also by Genex seeing the game's place on Roblox. One the agent never ends stops on its
 * own once the turn that clicks it can no longer hold computer control.
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type RobloxPublishAttempt, RobloxPublishKind, RobloxPublishPhase } from "../../shared/roblox-publish.ts";
import { atomicWriteJson, isJsonObject, readRegularFile } from "../../substrate/fsx.ts";
import { isGameId } from "./studio-binding.ts";

/** How long a publish stays under way unended: the longest the clicking turn holds computer control. */
export const PUBLISH_ATTEMPT_MS = 20 * MINUTE_MS;
/** The longest note the agent leaves on an ended publish. */
export const MAX_DETAIL_CHARS = 300;
const ATTEMPTS_FOLDER = "publish-attempts";
const MAX_ATTEMPT_BYTES = 4 * 1024;

const attemptFile = (storage: string, game: string) => path.join(storage, ATTEMPTS_FOLDER, `${game}.json`);

const PHASES = new Set<string>(Object.values(RobloxPublishPhase));
const KINDS = new Set<string>(Object.values(RobloxPublishKind));
const isPhase = (value: unknown): value is RobloxPublishPhase => typeof value === "string" && PHASES.has(value);
const isKind = (value: unknown): value is RobloxPublishKind => typeof value === "string" && KINDS.has(value);

/** Text as one plain line of at most {@link MAX_DETAIL_CHARS}; undefined when nothing is left. */
export function plainDetail(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
  const plain = text
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!plain) return undefined;
  return plain.length > MAX_DETAIL_CHARS ? `${plain.slice(0, MAX_DETAIL_CHARS - 1)}…` : plain;
}

/** Records the game's publish as it stands now, replacing the one before. */
export async function writeAttempt(storage: string, game: string, attempt: RobloxPublishAttempt): Promise<void> {
  if (!isGameId(game)) return;
  await mkdir(path.join(storage, ATTEMPTS_FOLDER), { recursive: true, mode: 0o700 });
  await atomicWriteJson(attemptFile(storage, game), attempt);
}

/** The game's latest publish as recorded; undefined when there is none or the record isn't one. */
export async function readAttempt(storage: string, game: string): Promise<RobloxPublishAttempt | undefined> {
  if (!isGameId(game)) return undefined;
  const value = await readRegularFile(attemptFile(storage, game), MAX_ATTEMPT_BYTES)
    .then((bytes) => JSON.parse(bytes.toString("utf8")) as unknown)
    .catch(() => undefined);
  if (!isJsonObject(value) || !isPhase(value.phase) || !isKind(value.kind) || !Number.isSafeInteger(value.at))
    return undefined;
  const attempt: RobloxPublishAttempt = { phase: value.phase, kind: value.kind, at: value.at as number };
  const name = plainDetail(value.name);
  const detail = plainDetail(value.detail);
  if (name) attempt.name = name;
  if (detail) attempt.detail = detail;
  return attempt;
}

/**
 * A publish as it stands at `now`: a first publish still under way is published once Roblox has the
 * game's place; one under way past {@link PUBLISH_ATTEMPT_MS} has stopped.
 */
export function attemptNow(attempt: RobloxPublishAttempt, onRoblox: boolean, now: number): RobloxPublishAttempt {
  if (attempt.phase !== RobloxPublishPhase.Publishing) return attempt;
  if (attempt.kind === RobloxPublishKind.First && onRoblox) return { ...attempt, phase: RobloxPublishPhase.Published };
  if (now - attempt.at > PUBLISH_ATTEMPT_MS) return { ...attempt, phase: RobloxPublishPhase.Stopped };
  return attempt;
}

/**
 * The game's publish ended as the agent says: published, or stopped with what Roblox asked. Only a
 * publish under way ends; anything else answers false and changes nothing.
 */
export async function endAttempt(
  storage: string,
  game: string,
  end: { published: boolean; detail?: unknown },
  now: number,
): Promise<boolean> {
  const recorded = await readAttempt(storage, game);
  if (!recorded) return false;
  const attempt = attemptNow(recorded, false, now);
  if (attempt.phase !== RobloxPublishPhase.Publishing) return false;
  const phase = end.published ? RobloxPublishPhase.Published : RobloxPublishPhase.Stopped;
  const detail = plainDetail(end.detail);
  const { detail: _before, ...rest } = attempt;
  await writeAttempt(storage, game, { ...rest, phase, ...(detail ? { detail } : {}) });
  return true;
}
