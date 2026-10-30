/**
 * The assets a running Loop delivered into its build workspaces. Its workers deliver into their own
 * copies of the game and the lead into the run's integration worktree; the game folder holds none of
 * it until the run lands. While the run goes on, each such delivery the game folder does not hold is
 * listed from the workspace that has it, marked `building` and read through a host-issued reference
 * (`shared/build-ref.ts`). A run that closed lends nothing: landed, its files are the game's own;
 * not landed, they never reach the game.
 *
 * A workspace is only ever one the host lists for this game (`git worktree list` under the scratch
 * folder, `asset-workspaces.ts`); the file is in the game's asset folders and read contained (no
 * link, no escape) by the readers that take a root.
 */
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { type BuildRef, buildRef, parseBuildRef } from "../shared/build-ref.ts";
import { CustomEvent } from "../shared/custom-events.ts";
import { EventKind } from "../shared/event-log.ts";
import { type AssetKind, deliveredToBuild, type ProjectAsset } from "../shared/game-assets.ts";
import { type AssetFolder, isAssetPath } from "../shared/project-workspace.ts";
import type { EventEnvelope } from "../substrate/types.ts";
import type { AssetWorkspace } from "./game-assets.ts";

/** The folder under the scratch folder a Loop's workspaces live in: `autopilot/<runId>/<name>`. */
const RUNS_FOLDER = "autopilot";

/** One delivered file of a run, as its record names it. */
interface DeliveredFile {
  runId: string;
  file: string;
  kind: AssetKind;
  payload: Record<string, unknown>;
}

const KINDS: ReadonlySet<string> = new Set(["image", "model", "audio", "video", "other"]);
const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The custom records of this project's log, by type. */
function* customRecords(ledger: readonly EventEnvelope[]) {
  for (const event of ledger) {
    if (event.data.type !== EventKind.Custom) continue;
    const payload = event.data.payload as Record<string, unknown> | undefined;
    if (payload) yield { type: event.data.event_type, payload };
  }
}

/** The runs whose close is on the log: they lend the Assets stage nothing of their builds. */
function closedRuns(ledger: readonly EventEnvelope[]): Set<string> {
  const closed = new Set<string>();
  for (const { type, payload } of customRecords(ledger)) {
    const runId = str(payload.runId);
    if (type === CustomEvent.RunFinished && runId) closed.add(runId);
  }
  return closed;
}

/** The files one delivery record lists, each with its kind (`other` for one the host does not name). */
function filesOf(runId: string, payload: Record<string, unknown>): DeliveredFile[] {
  const rows = Array.isArray(payload.files) ? (payload.files as Array<Record<string, unknown> | null>) : [];
  return rows.flatMap((row) => {
    const file = str(row?.file);
    const kind = str(row?.kind) ?? "other";
    return file ? [{ runId, file, kind: KINDS.has(kind) ? (kind as AssetKind) : "other", payload }] : [];
  });
}

/** Every file a run still going delivered into a build workspace of this game, the newest record of each last. */
function openBuildDeliveries(ledger: readonly EventEnvelope[], project: string): DeliveredFile[] {
  const closed = closedRuns(ledger);
  const files = new Map<string, DeliveredFile>();
  for (const { type, payload } of customRecords(ledger)) {
    const runId = str(payload.runId);
    const ours = type === CustomEvent.AssetDelivered && payload.project === project;
    if (!ours || runId === null || closed.has(runId) || !deliveredToBuild(payload)) continue;
    for (const delivered of filesOf(runId, payload)) files.set(delivered.file, delivered);
  }
  return [...files.values()];
}

/** A run's workspaces, its integration worktree first: the merged build before a worker's copy. */
function workspacesOf(workspaces: readonly AssetWorkspace[], runId: string): AssetWorkspace[] {
  const prefix = `${RUNS_FOLDER}/${runId}/`;
  return workspaces
    .filter((workspace) => workspace.id.startsWith(prefix))
    .sort((a, b) => Number(b.scope === "integration") - Number(a.scope === "integration"));
}

/** The file's size and time when it is a plain file inside `root`, reached through no link; else null. */
async function containedFile(root: string, file: string): Promise<{ size: number; mtime: Date } | null> {
  const realRoot = await realpath(root).catch(() => null);
  const target = path.join(root, ...file.split("/"));
  const real = await realpath(target).catch(() => null);
  if (!realRoot || real !== path.join(realRoot, ...file.split("/"))) return null;
  const stat = await lstat(real).catch(() => null);
  return stat?.isFile() ? { size: stat.size, mtime: stat.mtime } : null;
}

/** A delivered file as the Assets stage lists it, from the workspace that holds it. */
function buildAsset(delivered: DeliveredFile, workspace: string, found: { size: number; mtime: Date }): ProjectAsset {
  const { payload, runId, file } = delivered;
  const facetId = str(payload.facetId);
  const at = str(payload.at);
  const jobId = str(payload.jobId);
  return {
    file,
    kind: delivered.kind,
    bytes: found.size,
    mtime: found.mtime.toISOString(),
    source: str(payload.source) ?? "imported",
    assetRef: buildRef(runId, workspace, file),
    building: { runId, workspace },
    runId,
    ...(jobId ? { jobId } : {}),
    ...(at ? { at } : {}),
    ...(facetId ? { facetId } : {}),
  };
}

/**
 * The deliveries of this game's runs still going that are only in a build workspace: each file the
 * game folder does not list (`listed`), in its asset folders, from the run's integration worktree
 * else a worker's copy that holds it.
 */
export async function buildDeliveries(input: {
  project: string;
  ledger: readonly EventEnvelope[];
  listed: ReadonlySet<string>;
  workspaces: readonly AssetWorkspace[];
  folders: readonly AssetFolder[];
}): Promise<ProjectAsset[]> {
  const assets: ProjectAsset[] = [];
  for (const delivered of openBuildDeliveries(input.ledger, input.project)) {
    if (input.listed.has(delivered.file) || !isAssetPath(delivered.file, input.folders)) continue;
    for (const workspace of workspacesOf(input.workspaces, delivered.runId)) {
      const found = await containedFile(workspace.root, delivered.file);
      if (!found) continue;
      assets.push(buildAsset(delivered, path.basename(workspace.root), found));
      break;
    }
  }
  return assets;
}

/**
 * Where a build reference's file is: the workspace the host lists for this game under that run and
 * name, and the file in the game's asset folders; null for any other reference.
 */
export function resolveBuildRef(
  ref: unknown,
  workspaces: readonly AssetWorkspace[],
  folders: readonly AssetFolder[],
): (BuildRef & { root: string }) | null {
  const parsed = parseBuildRef(ref);
  if (!parsed || !isAssetPath(parsed.file, folders)) return null;
  const id = `${RUNS_FOLDER}/${parsed.runId}/${parsed.workspace}`;
  const workspace = workspaces.find((each) => each.id === id && path.basename(each.root) === parsed.workspace);
  return workspace ? { ...parsed, root: workspace.root } : null;
}
