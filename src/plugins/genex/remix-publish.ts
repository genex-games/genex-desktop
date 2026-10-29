/**
 * Remixing a game published from Studio. The Genex CLI pushes a game's source from the folder it is
 * told to, and Studio runs it in its own publish workspace, so a game's project goes only when Studio
 * stages it (`remix-source.ts`) and names that folder with `--source`. With every publish the person
 * chooses whether remixing is allowed: allowed, the project goes with the upload and Genex opens it to
 * remixers; not allowed, or when the project could not go, remixing is turned off on Genex, so no one
 * remixes a game without its project. A game with only apps has no upload to carry its project:
 * `genex make-remixable --source` sends it once its apps are live, as Allow remixing does for a game
 * published before remixing came to Studio. The choice and how the project last went are kept in
 * `remix.json`, beside `publish.json`.
 */
import { rm } from "node:fs/promises";
import path from "node:path";
// Read at build time, as `native-publish.ts` does: the packaged app ships the CLI only in the plugin's payload.
import cliPackage from "@genex-ai/cli-demo/package.json" with { type: "json" };
import { GenexRemixProblem, type GenexRemixRecord } from "../../shared/genex.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { RemixSourceError, type StagedSource, stageRemixSource } from "./remix-source.ts";

/** The first Genex CLI that pushes a game's source from another folder (`--source`). */
const SOURCE_CLI = [1, 36, 13] as const;
/** Where the choice and how the project last went are kept in the publish workspace. */
export const REMIX_FILE = "remix.json";
/** Where the project is staged in the publish workspace for the CLI to push. */
export const SOURCE_FOLDER = "source";

/**
 * Whether CLI `version` pushes a game's source from the folder `--source` names. A prerelease comes
 * before its release, so only a later release's prerelease counts.
 */
export function hasSourceOption(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) return false;
  const parts = match.slice(1, 4).map(Number);
  for (const [at, wanted] of SOURCE_CLI.entries()) {
    const part = parts[at] ?? 0;
    if (part !== wanted) return part > wanted;
  }
  return match[4] === undefined;
}

/** Whether the CLI Studio ships, the version this build pins, can send a game's project. */
export const pinnedCliSendsSource = (): boolean => hasSourceOption(cliPackage.version);

/** What `remix.json` keeps: the record without what is answered live. */
export type RemixSaved = Omit<GenexRemixRecord, "supported" | "sending">;

const isProblem = (value: unknown): value is GenexRemixProblem =>
  Object.values(GenexRemixProblem).some((problem) => problem === value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** `remix.json` as read: anything that is not a record of the choice is no choice at all. */
export function readRemixSaved(value: unknown): RemixSaved {
  const saved = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  return {
    ...(typeof saved.allowed === "boolean" ? { allowed: saved.allowed } : {}),
    ...(typeof saved.sentAt === "string" && !Number.isNaN(Date.parse(saved.sentAt)) ? { sentAt: saved.sentAt } : {}),
    ...(isCount(saved.files) ? { files: saved.files } : {}),
    ...(isCount(saved.bytes) ? { bytes: saved.bytes } : {}),
    ...(isProblem(saved.problem) ? { problem: saved.problem } : {}),
  };
}

/** Keep `saved` as the workspace's record. */
export const saveRemix = (dir: string, saved: RemixSaved): Promise<void> =>
  atomicWriteJson(path.join(dir, REMIX_FILE), saved);

/**
 * Whether a publish allows remixing: the person's choice in the dialog when they made one, else the
 * one they made last; a publish no one chose for (an agent's) allows it only when they did before.
 */
export const remixAllowed = (asked: boolean | undefined, saved: RemixSaved): boolean => asked ?? saved.allowed ?? false;

/** A staging that went: the folder the CLI pushes, and what it holds. */
export interface StagedProject extends StagedSource {
  sourceDir: string;
}

/**
 * Stage `gameDir`'s project in the workspace `dir` for the CLI to push. Answers the staged folder, or
 * the problem that kept the project back: a refused project goes nowhere, and remixing is then off.
 */
export async function stageProject(
  dir: string,
  gameDir: string,
  stage: typeof stageRemixSource = stageRemixSource,
): Promise<StagedProject | { problem: GenexRemixProblem }> {
  const sourceDir = path.join(dir, SOURCE_FOLDER);
  try {
    return { sourceDir, ...(await stage(gameDir, sourceDir)) };
  } catch (error) {
    if (error instanceof RemixSourceError) return { problem: error.code };
    return { problem: GenexRemixProblem.Failed };
  }
}

/** Remove the workspace's staged project once its push is over: a later push of the workspace never carries it. */
export const dropStaged = (dir: string): Promise<void> =>
  rm(path.join(dir, SOURCE_FOLDER), { recursive: true, force: true }).catch(() => {});

/** The CLI's arguments that name the staged project as the source a run pushes, or none. */
export const sourceArgs = (staged: StagedProject | null): string[] => (staged ? ["--source", staged.sourceDir] : []);

/** The record once `staged` went to Genex with remixing allowed. */
export const sentProject = (staged: StagedProject, at: Date): RemixSaved => ({
  allowed: true,
  sentAt: at.toISOString(),
  files: staged.files,
  bytes: staged.bytes,
});

/**
 * The record after a publish that did not send the project: remixing not allowed, or allowed while
 * the project could not go (`problem`). What went before is forgotten: remixing is off on Genex, and
 * turning it on again sends the project afresh rather than reopening an old one.
 */
export const keptBackRecord = (allowed: boolean, problem?: GenexRemixProblem): RemixSaved => ({
  allowed,
  ...(problem ? { problem } : {}),
});
