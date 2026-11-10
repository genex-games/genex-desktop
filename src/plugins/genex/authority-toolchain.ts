/**
 * The room-module toolchain in Studio's publish copy. The CLI bundles and validates a
 * server-authoritative game's room module with the `@genex-ai/authority-dev` it resolves from the
 * folder it runs in, as Node resolves a dependency of the game. Studio's copy of a game has no
 * dependencies of its own, so it gets a link to the pinned copy in this plugin's payload: nothing
 * is downloaded, and a game whose maker installed nothing still has its room checked and shipped.
 */
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUTHORITY_DEV_PACKAGE, type GenexGameManifest, type GenexPublishRoom } from "../../shared/genex.ts";
import { roomModulePath } from "../../substrate/genex-room-stage.ts";

/** The publish copy's dependency folder, which holds nothing but the link. */
const MODULES_DIR = "node_modules";
/** Where the CLI keeps its gate's last report in the folder it publishes from (`.genex/` is never uploaded). */
const ROOM_REPORT = path.join(".genex", "authority", "report.json");
/** The gate's report as the CLI keeps it: the fields a publish's record reads. */
interface KeptReport {
  passed?: unknown;
  moduleSha256?: unknown;
  failures?: unknown;
}

/** Its ignore file: git keeps none of it, so a source push never carries the link. */
const MODULES_IGNORE = "# Studio's link to its room-module toolchain, never pushed\n*\n";

/** Whether the game declares a room block at all (a malformed one too: the CLI names what is wrong). */
export function declaresRoom(manifest: GenexGameManifest | undefined): boolean {
  return manifest?.genex !== undefined && Object.hasOwn(manifest.genex, "authority");
}

/**
 * Give the publish copy `workspace` the toolchain when the game declares a room and `toolDir` (the
 * pinned package's folder) is there; otherwise leave it no dependency folder at all, so a game
 * with no room publishes from exactly the copy it always did. The folder is Studio's alone: what
 * was in it, a link included, is removed and never followed.
 */
export async function linkAuthorityToolchain(
  workspace: string,
  toolDir: string | null,
  manifest: GenexGameManifest | undefined,
): Promise<void> {
  const modules = path.join(workspace, MODULES_DIR);
  await rm(modules, { recursive: true, force: true });
  if (!toolDir || !declaresRoom(manifest)) return;
  const link = path.join(modules, ...AUTHORITY_DEV_PACKAGE.split("/"));
  await mkdir(path.dirname(link), { recursive: true });
  await writeFile(path.join(modules, ".gitignore"), MODULES_IGNORE);
  // A junction on Windows: it needs no symlink privilege (ignored elsewhere).
  await symlink(toolDir, link, "junction");
}

/**
 * A publish's first record of the game's room: the module its block names, not yet checked or
 * sent; undefined for a game with no room block. The last attempt's report goes, so what a later
 * read finds is this attempt's own.
 */
export async function roomBeforeUpload(
  workspace: string,
  manifest: GenexGameManifest | undefined,
): Promise<GenexPublishRoom | undefined> {
  await rm(path.join(workspace, ROOM_REPORT), { force: true });
  if (!declaresRoom(manifest)) return undefined;
  return { module: roomModulePath(manifest?.genex?.authority), validated: false, uploaded: false };
}

/** The gate's typed reasons in a kept report: each failure's `reason` that is a string. */
const failureReasons = (failures: unknown): string[] =>
  Array.isArray(failures) ? failures.flatMap((f) => (typeof f?.reason === "string" ? [f.reason as string] : [])) : [];

/**
 * The room after one upload of the build: validated by the CLI's kept report of this attempt, and
 * uploaded when the upload finished (`landed`), which the CLI refuses unless Genex stored the
 * module and named its sha. A report that is missing or unreadable validated nothing.
 */
export async function roomAfterUpload(
  workspace: string,
  room: GenexPublishRoom,
  landed: boolean,
): Promise<GenexPublishRoom> {
  const report = await readFile(path.join(workspace, ROOM_REPORT), "utf8")
    .then((text) => JSON.parse(text) as KeptReport)
    .catch(() => null);
  const sha = typeof report?.moduleSha256 === "string" ? report.moduleSha256 : undefined;
  const validated = report?.passed === true && sha !== undefined;
  const failures = failureReasons(report?.failures);
  return {
    module: room.module,
    validated,
    uploaded: validated && landed,
    ...(validated ? { moduleSha256: sha } : {}),
    ...(!validated && failures.length ? { failures } : {}),
  };
}
