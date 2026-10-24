/**
 * A downloaded game's play, as Play reports it to genex.games once the game's window is on screen.
 * Most native builds never sign in to Genex, so without this a game people install and play keeps a
 * play count of 0. genex.games counts each person once per game, as it does a web play: the
 * signed-in account, or, signed out, this computer's own random id, kept beside the installed games
 * and sent only while no account is signed in. A token genex.games refuses (401) ends the sign-in,
 * as on Play's other calls, and the play goes again as this computer's. Best-effort: a report that
 * fails is logged and dropped, never retried, and never holds the game. Electron-free: the call, the
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

/** What reporting a play takes. */
export interface NativePlayDeps {
  /** The installed-games folder (`StudioLayout.installedGames`), where this computer's id is kept. */
  root: string;
  request: GalleryRequest;
  /** The unlocked Genex account's token, or undefined while there is none. */
  token(): Promise<string | undefined>;
  /** genex.games answered 401 to `token`: its sign-in has ended (`GenexAccount.refused`). */
  refused?(token: string): void;
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

/** The reporter over `deps`: one computer id per start of Genex, read or made once. */
export function nativePlays(deps: NativePlayDeps): NativePlays {
  let id: Promise<string> | null = null;
  /** The token genex.games last refused: while the account still holds it, reports go signed out. */
  let refusedToken: string | null = null;
  const playerId = (): Promise<string> => {
    id ??= computerId(deps.root).catch((error: unknown) => {
      id = null;
      throw error;
    });
    return id;
  };

  const sendSignedOut = async (slug: string): Promise<number> => {
    const body = { slug, playerId: await playerId() };
    return (await deps.request(PlayRoute.NativePlay, { method: "POST", body })).status;
  };

  const send = async (slug: string): Promise<number> => {
    const token = await deps.token();
    if (!token || token === refusedToken) return sendSignedOut(slug);
    const { status } = await deps.request(PlayRoute.NativePlay, { method: "POST", body: { slug }, token });
    if (status !== HTTP_UNAUTHORIZED) return status;
    refusedToken = token;
    deps.refused?.(token);
    return sendSignedOut(slug);
  };

  const report = async (slug: string): Promise<void> => {
    if (!isPlaySlug(slug)) return;
    try {
      const status = await send(slug);
      if (status < 200 || status >= 300) deps.log(`play of ${slug} not counted: genex.games answered ${status}`);
    } catch (error) {
      deps.log(`play of ${slug} not counted: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return { report };
}
