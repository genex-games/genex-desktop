/** Harness RPC: games — list, scaffold, read, write, validate, covers, export. */
import { workspaceContentStamp, workspaceContentStamps } from "../../substrate/workspace-content.ts";
import path from "node:path";
import { readFile, realpath } from "node:fs/promises";
import { ensureDir, realpathNearest, writeFileNoFollow } from "../../substrate/fsx.ts";
import { isImageFile } from "../../substrate/game-workspace.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import { starterOfKind } from "../../shared/project-facts.ts";
import {
  HostMethod,
  type HarnessHostHandlers,
  type HarnessParams,
  type HarnessResult,
} from "../../shared/harness-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { describeUnknownImage, sniffImage } from "../../substrate/image-sniff.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";
import { startHeldInPlan } from "../core/project-tools.ts";
import { withEditorPlay } from "../core/editor-play-session.ts";
import { isBelow, throughClaudeFolder, throughGitFolder } from "../../substrate/paths.ts";

/** The largest image `game.read` hands back. */
const MAX_IMAGE_READ_MB = 8;
const MAX_IMAGE_READ_BYTES = MAX_IMAGE_READ_MB * 1024 * 1024;

/** What the harness reads when a game call is refused. */
const MESSAGE = {
  exportOutsideExports: (target: string) =>
    `refused: game.export writes only into the studio's exports folder: ${target}`,
  onlyBrowserGames: "Only browser-game scaffolding is supported in this build.",
  imageTooLarge: (file: string) => `${file} is larger than ${MAX_IMAGE_READ_MB} MB`,
  imageNotJudgeable: (file: string, what: string) =>
    `${file} is ${what}, which the preview cannot read — re-save it as JPEG or PNG`,
  claudeFolder: (file: string) =>
    `refused: ${file} is in the game's .claude folder, Claude Code's own settings, which only the person changes`,
  gitFolder: (file: string) => `refused: ${file} is in a .git folder, whose configuration and hooks the host controls`,
} as const;

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
    [HostMethod.GameValidate]: async (p) => core.games.validate(p.project),
    [HostMethod.GameRead]: async (p) => {
      const target = await x.delegation.gameFile(p.project, p.file, "read");
      if (isImageFile(target)) return readImage(target, p.file);
      return readFile(target, "utf8");
    },
    [HostMethod.GameWrite]: async (p) => {
      const target = await x.delegation.gameFile(p.project, p.file, "write");
      await refuseProjectControlFolder(core.games.dirFor(p.project), target, p.file);
      await ensureDir(path.dirname(target));
      await writeFileNoFollow(target, p.contents);
      core.emit(UiEvent.GameChanged, { project: p.project, file: p.file });
      return { bytes: p.contents.length };
    },
    [HostMethod.GameTree]: async (p) => x.delegation.gameTree(p.project),
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
