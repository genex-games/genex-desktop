/**
 * A downloaded game's play, as Play reports it to genex.games once the game's window is on screen.
 * Most native builds never sign in to Genex, so without this a game people install and play keeps a
 * play count of 0. genex.games counts each person once per game, as it does a web play: the
 * signed-in account, or, signed out, this computer's own random id, kept beside the installed games
 * and sent only while no account is signed in. A token genex.games refuses (401) ends the sign-in,
 * as on Play's other calls, and the play goes again as this computer's. Best-effort: a report that
 * fails is logged and dropped, never retried, and never holds the game. An app build's install
 * moments (`install-reports.ts`) go the same way, with the same id. Electron-free: the call, the
 * account's token and the folder are deps.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isPlaySlug } from "../../shared/play.ts";
import { atomicWriteJson, readJsonIfExists } from "../../substrate/fsx.ts";
import { type GalleryRequest, HTTP_UNAUTHORIZED, PlayRoute } from "./gallery.ts";

/** The file beside the installed games that keeps this computer's id for play counts. */
const PLAYER_FILE = "player.json";
/** The only id this computer keeps: one `randomUUID()`, as it made it. */
const PLAYER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What a report from the app takes: the account's token, or this computer's id while there is none. */
export interface LauncherReportDeps {
  request: GalleryRequest;
  /** The unlocked Genex account's token, or undefined while there is none. */
  token(): Promise<string | undefined>;
  /** genex.games answered 401 to `token`: its sign-in has ended (`GenexAccount.refused`). */
  refused?(token: string): void;
  /** This computer's id, sent only while no account is signed in (`computerIdOf`). */
  playerId(): Promise<string>;
}

/** What reporting a play takes. */
export interface NativePlayDeps extends Omit<LauncherReportDeps, "playerId"> {
  /** The installed-games folder (`StudioLayout.installedGames`), where this computer's id is kept. */
  root: string;
  /** This computer's id, when other reports share it; read from `root` by default. */
  playerId?(): Promise<string>;
  log(line: string): void;
}

/** Reports a downloaded game's plays. */
export interface NativePlays {
  /** Tell genex.games `slug` was played; resolves once it answered or failed, never throws. */
  report(slug: string): Promise<void>;
}

/** The kept id in `value`, or null when it is not one this computer made. */
function keptId(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const { playerId } = value as Record<string, unknown>;
  return typeof playerId === "string" && PLAYER_ID.test(playerId) ? playerId : null;
}

/** The kept file's contents; one that is not JSON reads as none. Any other failure throws. */
async function readKept(file: string): Promise<unknown> {
  try {
    return await readJsonIfExists<unknown>(file);
  } catch (error) {
    // Only a file that is not JSON is replaced: one that can't be read now may hold the id still.
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/** This computer's id for play counts: the kept one, or a new one, kept from now on. */
async function computerId(root: string): Promise<string> {
  const file = path.join(root, PLAYER_FILE);
  const kept = keptId(await readKept(file));
  if (kept) return kept;
  const playerId = randomUUID();
  await atomicWriteJson(file, { playerId });
  return playerId;
}

/**
 * This computer's id for the app's reports, kept in `root`: read or made once per start of Genex, and
 * shared by every report given the same function, so two reports at once never make two ids.
 */
export function computerIdOf(root: string): () => Promise<string> {
  let id: Promise<string> | null = null;
  return () => {
    id ??= computerId(root).catch((error: unknown) => {
      id = null;
      throw error;
    });
    return id;
  };
}

/**
 * How the app sends a report (from main: genex.games refuses one from a page): `body` as the
 * signed-in account, or with this computer's id beside it while there is none. A token genex.games
 * refuses (401) ends the sign-in, and the report, and every later one while the account still holds
 * that token, goes as this computer's. Answers genex.games' status; a failed request throws.
 */
export function launcherSender(
  deps: LauncherReportDeps,
): (route: string, body: Readonly<Record<string, unknown>>) => Promise<number> {
  /** The token genex.games last refused: while the account still holds it, reports go signed out. */
  let refusedToken: string | null = null;
  const sendSignedOut = async (route: string, body: Readonly<Record<string, unknown>>): Promise<number> => {
    const signedOut = { ...body, playerId: await deps.playerId() };
    return (await deps.request(route, { method: "POST", body: signedOut })).status;
  };
  return async (route, body) => {
    const token = await deps.token();
    if (!token || token === refusedToken) return sendSignedOut(route, body);
    const { status } = await deps.request(route, { method: "POST", body, token });
    if (status !== HTTP_UNAUTHORIZED) return status;
    refusedToken = token;
    deps.refused?.(token);
    return sendSignedOut(route, body);
  };
}

/** The reporter over `deps`: one computer id per start of Genex, read or made once. */
export function nativePlays(deps: NativePlayDeps): NativePlays {
  const send = launcherSender({ ...deps, playerId: deps.playerId ?? computerIdOf(deps.root) });

  const report = async (slug: string): Promise<void> => {
    if (!isPlaySlug(slug)) return;
    try {
      const status = await send(PlayRoute.NativePlay, { slug });
      if (status < 200 || status >= 300) deps.log(`play of ${slug} not counted: genex.games answered ${status}`);
    } catch (error) {
      deps.log(`play of ${slug} not counted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return { report };
}
