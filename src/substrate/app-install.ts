/**
 * Installing a Mac app for the person from an engine plugin's setup card (Unity Hub, Godot): its
 * download with the bytes counted for the card, the check that its maker signed it before anything
 * is copied (codesign accepts it against Apple's Developer ID chain with the maker's team in the
 * leaf, and Gatekeeper accepts it), and its copy into Applications under another name first,
 * renamed only once whole, so a half-copied app never reads as installed. An older copy of the
 * same app already there is moved to the person's Trash just before the rename (put back if the
 * rename fails), never deleted. A Stop is honoured between the steps. Programs run through the
 * caller's runner, so tests stand in for each one.
 */
import { createWriteStream } from "node:fs";
import { lstat, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { MINUTE_MS } from "../shared/duration.ts";

/** How long checking a signature or copying an app may take. */
export const APP_COPY_MS = 5 * MINUTE_MS;
/** The most names tried for an older app in the Trash (`Godot.app`, `Godot 2.app`, …). */
const TRASH_NAMES_MAX = 100;
const CODESIGN = "/usr/bin/codesign";
const SPCTL = "/usr/sbin/spctl";
/** An Apple team id: ten capitals and digits, nothing that could change the requirement it goes into. */
const TEAM_ID = /^[A-Z0-9]{10}$/;

/**
 * What Genex requires of a maker's signature: Apple's root, Apple's Developer ID authority, and the
 * maker's team in the leaf certificate. Without it `--verify` checks the signature only against the
 * requirement its signer wrote, which a self-signed certificate meets.
 */
const developerIdOf = (team: string) =>
  `anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[subject.OU] = "${team}"`;

/**
 * Runs a program and answers what it printed and on its error stream; rejects when it fails, and
 * ends it when `signal` is aborted.
 */
export type AppRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
  signal?: AbortSignal,
) => Promise<{ out: string; err: string }>;

/** Why an app download or copy failed. Wire values: never rename one. */
export const AppInstallProblem = { Download: "download", NotSigned: "not-signed", Copy: "copy" } as const;
export type AppInstallProblem = (typeof AppInstallProblem)[keyof typeof AppInstallProblem];

/** A failed download or copy, with what the person reads. */
export class AppInstallError extends Error {
  readonly problem: AppInstallProblem;
  constructor(problem: AppInstallProblem, detail: string) {
    super(detail);
    this.problem = problem;
  }
}

/** Downloads `url` into `file`, telling `onBytes` how far it got; a stop through `signal` ends it. */
export async function downloadFile(
  fetcher: typeof fetch,
  url: string,
  file: string,
  options: { signal: AbortSignal; onBytes: (done: number, total: number | undefined) => void },
): Promise<void> {
  const fail = (error: unknown) => {
    throw new AppInstallError(AppInstallProblem.Download, error instanceof Error ? error.message : String(error));
  };
  const response = await fetcher(url, { signal: options.signal }).catch(fail);
  if (!response.ok || !response.body) throw new AppInstallError(AppInstallProblem.Download, `HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || undefined;
  let done = 0;
  options.onBytes(done, total);
  const body = Readable.fromWeb(response.body as WebReadableStream);
  body.on("data", (chunk: Buffer) => {
    done += chunk.length;
    options.onBytes(done, total);
  });
  await pipeline(body, createWriteStream(file), { signal: options.signal }).catch(fail);
  options.onBytes(total ?? done, total);
}

/**
 * Whether an app is signed by `team`: codesign accepts it against Apple's Developer ID chain with
 * that team in the leaf, its signature names that team, and Gatekeeper accepts it.
 */
export async function signedByTeam(run: AppRunner, app: string, team: string, signal?: AbortSignal): Promise<boolean> {
  if (!TEAM_ID.test(team)) return false;
  try {
    await run(CODESIGN, ["--verify", "--deep", "--strict", `-R=${developerIdOf(team)}`, app], APP_COPY_MS, signal);
    // codesign describes a signature on its error stream.
    const described = await run(CODESIGN, ["-dv", app], APP_COPY_MS, signal);
    if (!described.err.split(/\r?\n/).includes(`TeamIdentifier=${team}`)) return false;
    await run(SPCTL, ["--assess", "--type", "execute", app], APP_COPY_MS, signal);
    return true;
  } catch {
    return false;
  }
}

/** Where an app goes, whose team must have signed it, and the Trash an older copy of it moves to. */
export interface AppPlace {
  applications: string;
  name: string;
  team: string;
  /** The person's Trash (`~/.Trash`), on the same disk as Applications. */
  trash: string;
}

const exists = async (file: string): Promise<boolean> => (await lstat(file).catch(() => undefined)) !== undefined;

/** A name for `name` in the Trash that nothing there has yet, as Finder numbers them. */
async function trashSpot(trash: string, name: string): Promise<string> {
  const extension = path.extname(name);
  const stem = path.basename(name, extension);
  for (let count = 1; count <= TRASH_NAMES_MAX; count++) {
    const spot = path.join(trash, count === 1 ? name : `${stem} ${count}${extension}`);
    if (!(await exists(spot))) return spot;
  }
  throw new Error(`the Trash already holds ${TRASH_NAMES_MAX} copies of ${name}`);
}

/** Renames the whole copy into place, moving an older app of that name to the Trash first and back if the rename fails. */
async function swapIn(partial: string, place: AppPlace): Promise<void> {
  const target = path.join(place.applications, place.name);
  if (!(await exists(target))) return rename(partial, target);
  const aside = await trashSpot(place.trash, place.name);
  await rename(target, aside);
  try {
    await rename(partial, target);
  } catch (error) {
    await rename(aside, target).catch(() => undefined);
    throw error;
  }
}

/**
 * Copies a checked app into `applications` as `name`: beside under another name first, renamed only
 * once whole, an older copy moved to the Trash. Refused, with nothing copied, unless `team` signed
 * it; a Stop through `signal` ends it between steps with Applications as it was.
 */
export async function placeApp(run: AppRunner, app: string, place: AppPlace, signal?: AbortSignal): Promise<void> {
  if (!(await signedByTeam(run, app, place.team, signal)))
    throw new AppInstallError(AppInstallProblem.NotSigned, place.name);
  const partial = path.join(place.applications, `.${place.name}.genex-copy`);
  await rm(partial, { recursive: true, force: true });
  try {
    signal?.throwIfAborted();
    await run("/usr/bin/ditto", [app, partial], APP_COPY_MS, signal);
    signal?.throwIfAborted();
    await swapIn(partial, place);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw new AppInstallError(AppInstallProblem.Copy, error instanceof Error ? error.message : String(error));
  }
}

/**
 * A made-up Mac a development test points an engine plugin at (its `Applications` and `home`), so an
 * engine's setup card can be tried in the real app on a computer that has the engine; the host
 * passes it to plugin backends (`substrate/plugins/process.ts`). Never set for a person.
 */
export const ENGINE_TEST_ROOT = "STUDIO_ENGINE_TEST_ROOT";

/** The made-up Mac's folders under {@link ENGINE_TEST_ROOT}, when a development test names an absolute one on a Mac. */
export function engineTestMac(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): { applications: string; home: string } | undefined {
  const root = env[ENGINE_TEST_ROOT];
  if (!root || !path.posix.isAbsolute(root) || platform !== "darwin") return undefined;
  return { applications: path.posix.join(root, "Applications"), home: path.posix.join(root, "home") };
}
