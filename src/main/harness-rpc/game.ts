/** Harness RPC: games and their assets — list, scaffold, read, write, validate, covers, export. */
import { workspaceContentStamp, workspaceContentStamps } from "../../substrate/workspace-content.ts";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { ensureDir, realpathNearest, writeFileNoFollow } from "../../substrate/fsx.ts";
import { isImageFile } from "../../substrate/game-workspace.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { starterOfKind } from "../../shared/project-facts.ts";
import type { AttachReport } from "../../shared/game-project.ts";
import {
  HostMethod,
  type HarnessHostHandlers,
  type HarnessParams,
  type HarnessResult,
} from "../../shared/harness-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import { git } from "../../substrate/snapshots.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { attachReport, noAttachment, str } from "../core/page-report.ts";
import { startHeldInPlan } from "../core/project-tools.ts";
import { withEditorPlay } from "../core/editor-play-session.ts";
import { isBelow, samePath, throughClaudeFolder, throughGitFolder } from "../../substrate/paths.ts";

/** The largest image `game.read` hands back. */
const MAX_IMAGE_READ_MB = 8;
const MAX_IMAGE_READ_BYTES = MAX_IMAGE_READ_MB * 1024 * 1024;

/** What the harness reads when a game call is refused. */
const MESSAGE = {
  invalidRunId: "Invalid run id",
  foreignWorkspace: "Integration workspace does not belong to this game",
  exportOutsideExports: (target: string) =>
    `refused: game.export writes only into the studio's exports folder: ${target}`,
  onlyBrowserGames: "Only browser-game scaffolding is supported in this build.",
  imageTooLarge: (file: string) => `${file} is larger than ${MAX_IMAGE_READ_MB} MB`,
  imageNotJudgeable: (file: string, what: string) =>
    `${file} is ${what}, which the preview cannot read — re-save it as JPEG or PNG`,
  claudeFolder: (file: string) =>
    `refused: ${file} is in the game's .claude folder, Claude Code's own settings, which only the person changes`,
  gitFolder: (file: string) => `refused: ${file} is in a .git folder, whose configuration and hooks the host controls`,
  noContract: "Genex asks nothing of a game's files: there is no contract to upgrade",
} as const;

/** A run id an integration workspace is filed under: a plain slug, dots allowed. */
const RUN_ID = /^[a-z0-9][a-z0-9-_.]*$/i;
/** The field of a worktree listing that names a registered worktree's folder. */
const WORKTREE_FIELD = "worktree ";

/** A run's integration workspace, refused unless git has it registered as a worktree of this game. */
async function integrationWorkspace(core: StudioCore, project: string, runId: string): Promise<string> {
  if (!RUN_ID.test(runId)) throw new Error(MESSAGE.invalidRunId);
  await core.assertProjectAllowed(core.games.dirFor(project));
  const workspace = await realpath(path.join(core.layout.scratch, "autopilot", runId, "integration"));
  // Git's registration ties this host-derived worktree to the authorized game.
  const listing = await git(core.games.dirFor(project), ["worktree", "list", "--porcelain", "-z"]);
  if (!(await registersWorktree(listing, workspace))) throw new Error(MESSAGE.foreignWorkspace);
  return workspace;
}

/**
 * Does a `git worktree list --porcelain -z` listing register `workspace` (a real path)? Fields
 * end in NUL, so a newline in a folder's name never reads as a line of its own; each registered
 * folder is realpathed, so Git for Windows' `C:/…` and a link's spelling match the native path.
 */
async function registersWorktree(listing: string, workspace: string): Promise<boolean> {
  for (const field of listing.split("\0")) {
    if (!field.startsWith(WORKTREE_FIELD)) continue;
    const registered = await realpath(field.slice(WORKTREE_FIELD.length)).catch(() => null);
    if (registered !== null && samePath(registered, workspace)) return true;
  }
  return false;
}

/**
 * Project settings and Git control files can execute hooks or filters in another host session.
 * The harness never writes either folder, by any spelling (case, `..`, links): check the named
 * path and its actual destination before creating directories or writing bytes.
 */
async function refuseProjectControlFolder(root: string, target: string, file: string): Promise<void> {
  const realRoot = await realpath(root).catch(() => path.resolve(root));
  const named = path.relative(path.resolve(root), path.resolve(target));
  const landing = path.relative(realRoot, await realpathNearest(target));
  if (throughClaudeFolder(named) || throughClaudeFolder(landing)) throw new Error(MESSAGE.claudeFolder(file));
  if (throughGitFolder(named) || throughGitFolder(landing)) throw new Error(MESSAGE.gitFolder(file));
}

/** TQ-1: the harness may name where inside the studio's exports folder, never elsewhere. */
async function assertExportTarget(core: StudioCore, target: string): Promise<void> {
  const real = await realpathNearest(target);
  const exportsRoot = await realpathNearest(core.layout.exports);
  if (!isBelow(exportsRoot, real)) throw new Error(MESSAGE.exportOutsideExports(target));
}

export function gameRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.AssetsInventory]: async (p) => {
      await core.assertProjectAllowed(core.games.dirFor(p.project));
      return core.projectAssets(p.project);
    },
    [HostMethod.AssetsCheckpoint]: async (p) => {
      const workspace = await integrationWorkspace(core, p.project, p.runId);
      return core.assetCheckpoints.checkpoint(p.project, workspace, p.assetIds);
    },
    // — games —
    // An engine game a plugin plays in its editor says so, with its judges: what the Loop and the chat offer.
    [HostMethod.GameList]: async () => withEditorPlay(core, await core.games.list()),
    [HostMethod.GameSetCover]: async (p) => x.setGameCover(p.project, p, p.threadId),
    // Harnesses installed before recipes still author custom GLSL covers through this.
    [HostMethod.GameSetCoverShader]: async (p) => x.setGameCoverShader(p.project, p.surface, p.threadId),
    // `split` answers both stamps from one walk; a caller that does not ask gets the old string.
    [HostMethod.GameContentStamp]: async (p) =>
      p.split
        ? workspaceContentStamps(core.games.dirFor(p.project))
        : workspaceContentStamp(core.games.dirFor(p.project)),
    [HostMethod.GameRecents]: async () => core.games.recents(),
    [HostMethod.GameScaffold]: async (p) => scaffold(core, x, p),
    // The starter a game with no kind yet takes on (a local model's `start_web_game`, a Loop's launch).
    // A local model's names its chat: while that chat is in Plan nothing is written, as for the chat's
    // own `start_web_game`. `readyProject` tells the app its game changed.
    [HostMethod.GameStart]: async (p) =>
      (await startHeldInPlan(core, x, p.project, p.threadId)) ??
      x.readyProject(await core.games.start(p.project, p.starter)),
    // No `game.adopt` here (ARCH-1): adopting a folder widens the sandbox, so it is the user's
    // Open Game sheet's to do (`adoptProject`), never the agent-editable harness's.
    [HostMethod.GameValidate]: async (p) =>
      p.candidateId
        ? core.games.validateAt((await core.candidates.get(p.candidateId, p.project)).root)
        : core.games.validate(p.project),
    // The live half of the same question. `game.validate` reads the folder; this serves the
    // page, waits for it to boot and asks what the hook got hold of — so a run stops asking
    // for the two lines from a game the studio already attached to on its own. A HOST call,
    // made by the run for the director: no MCP tool and no bridge entry, so both engines see
    // exactly the tools they saw before.
    [HostMethod.GameAttached]: async (p) => attached(core, x, p),
    // v2 contract upgrade: a game whose studio.js predates
    // `inspect()` gets the shipped template's copy; the old file is kept beside it.
    [HostMethod.GameUpgradeContract]: async () => upgradeContract(),
    [HostMethod.GameRead]: async (p) => {
      const target = p.candidateId
        ? await core.candidates.file(p.candidateId, p.project, p.file)
        : await x.delegation.gameFile(p.project, p.file, "read");
      if (isImageFile(target)) return readImage(target, p.file);
      return readFile(target, "utf8");
    },
    [HostMethod.GameWrite]: async (p) => {
      const target = p.candidateId
        ? await core.candidates.file(p.candidateId, p.project, p.file, true)
        : await x.delegation.gameFile(p.project, p.file, "write");
      const root = p.candidateId
        ? (await core.candidates.get(p.candidateId, p.project)).root
        : core.games.dirFor(p.project);
      await refuseProjectControlFolder(root, target, p.file);
      await ensureDir(path.dirname(target));
      await writeFileNoFollow(target, p.contents);
      if (!p.candidateId) core.emit(UiEvent.GameChanged, { project: p.project, file: p.file });
      return { bytes: p.contents.length };
    },
    [HostMethod.GameTree]: async (p) =>
      p.candidateId ? core.candidates.tree(p.candidateId, p.project) : x.delegation.gameTree(p.project),
    [HostMethod.GameExport]: async (p) => {
      await x.assertHarnessRoot(p.project, null);
      if (p.target !== undefined && p.target !== null) await assertExportTarget(core, String(p.target));
      return core.games.export(p.project, p.target ?? path.join(core.layout.exports, p.project), undefined, {
        secretValues: core.knownSecretValues(),
      });
    },
    // The stills in <project>/references/, sniffed and resized, for a run whose board is
    // empty (a resume, or a board attached in an earlier chat).
    [HostMethod.GameReferences]: async (p) => core.referenceStills(p.project, { max: p?.max, maxPx: p?.maxPx }),
  } satisfies Partial<HarnessHostHandlers>;
}

async function scaffold(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameScaffold>,
): Promise<HarnessResult<typeof HostMethod.GameScaffold>> {
  // No kind makes a game with no kind yet; the web starter only when the caller names it.
  const starter = starterOfKind(p.kind);
  if (starter === undefined) throw new Error(MESSAGE.onlyBrowserGames);
  const options = p.title ? { title: p.title } : {};
  const made = starter ? await core.games.scaffold(p.name, options) : await core.games.makeEmpty(p.name, options);
  const project = await x.readyProject(made);
  // A brief sent from an unbound "new game" thread names that thread the moment the
  // folder exists — the chat and the project become one thing.
  if (p.threadId && p.threadId !== core.mainThread) {
    const record = await core.store.getRecord(p.threadId).catch(() => null);
    const meta = record?.metadata as { kind?: string; project?: string | null } | undefined;
    if (meta?.kind === ThreadKind.Game && !meta.project) await core.bindThreadToProject(p.threadId, project.name);
  }
  return project;
}

/** `game.attached`: serve the page in a window of its own and ask what the hook got hold of. */
async function attached(
  core: StudioCore,
  x: CoreInternals,
  p: HarnessParams<typeof HostMethod.GameAttached>,
): Promise<AttachReport> {
  const checked = await x.assertHarnessRoot(p.project, p.candidateId ? null : p.root);
  const root = p.candidateId ? (await core.candidates.get(p.candidateId, p.project)).root : checked;
  const session = x.previews.sessionPortFor({ label: `attach:${p.project}` });
  try {
    const port = await session.get();
    const loaded = await x.previews.loadServed(port, p.project, root, p.entry);
    const status = port.status();
    if (loaded.problem) return noAttachment(loaded.problem, status.loadError, status.consoleErrors);
    const answered = await (port.attachReport?.().catch(() => null) ?? Promise.resolve(null));
    const reported = answered && typeof answered === "object" ? (answered as unknown as Record<string, unknown>) : null;
    if (!reported) {
      return noAttachment(
        loaded.note ?? "this page reports nothing about the studio contract",
        status.loadError,
        status.consoleErrors,
      );
    }
    // The port's report is the page's own account of itself: read field by field, so a
    // page that answers a shape nobody expected cannot become this call's answer.
    const base = noAttachment(str(reported.reason) ?? loaded.note ?? null, status.loadError, status.consoleErrors);
    return attachReport(reported, base);
  } finally {
    await session.release();
  }
}

/** An image in the game, as the judges read it: the bytes decide the type. */
async function readImage(target: string, file: string) {
  const data = await readFile(target);
  if (data.length > MAX_IMAGE_READ_BYTES) throw new Error(MESSAGE.imageTooLarge(file));
  // The bytes decide the type, never the extension: an AVIF named .jpg is refused.
  const sniffed = sniffImage(data);
  if (!sniffed) throw new Error(MESSAGE.imageNotJudgeable(file, describeUnknownImage(data)));
  return {
    kind: "image" as const,
    mimeType: sniffed.mimeType,
    data: data.toString("base64"),
    bytes: data.length,
    file,
  };
}

/**
 * Kept for the harness's older callers: a game owes the studio no files, so nothing is written
 * and the answer says so.
 */
async function upgradeContract(): Promise<HarnessResult<"game.upgradeContract">> {
  return { upgraded: false, reason: MESSAGE.noContract };
}
