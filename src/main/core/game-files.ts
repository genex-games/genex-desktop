/**
 * Files a chat names and the images a chat message carried. Which names are files, and how each
 * opens, is `main/chat-files.ts` (`resolveChatFiles`, `chatFileTarget`): the game's folder and
 * build, the Studio chat's workspace, or an absolute path anywhere but credentials. Game Markdown
 * and images are read beside the chat (`shared/game-file.ts`) from inside that chat's game only:
 * its folder, or the build its latest run made while that build is running or was not landed.
 * Composed by `StudioCore`.
 */
import path from "node:path";
import {
  CHAT_FILE_LIMIT,
  type ChatFileLink,
  type ChatFileOpenOutside,
  type ChatFileRef,
} from "../../shared/chat-files.ts";
import { rewindsOf, withoutRewound } from "../../shared/chat-rewind.ts";
import { latestRun } from "../../shared/coordinator.ts";
import { ThreadKind } from "../../shared/event-log.ts";
import type { GameFile } from "../../shared/game-file.ts";
import { t } from "../../shared/i18n.ts";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { RunState } from "../../shared/run-state.ts";
import { toolchain } from "../../substrate/toolchain.ts";
import { ChatFileResolver, credentialRoots, type ChatFileScope } from "../chat-files.ts";
import { folderFilePath, gameRelativePath, readCommitFile, readFolderFile } from "../game-file.ts";
import type { StudioCore } from "../studio-core.ts";

/**
 * What the user reads when a chat's file cannot be opened. `namesRequired` answers only a
 * malformed request from our own renderer, so it stays English.
 */
const MESSAGE = {
  chatGone: () => t("This chat is no longer here."),
  namesRequired: "File names are required.",
  noGameFolder: () => t("This chat has no game folder yet."),
  notInFolder: () => t("This file isn’t in the game folder yet."),
  outsideGame: (raw: string) => t("{path} is outside this game.", { path: raw.trim() }),
  notFound: (relative: string) => t("Couldn’t find {file} in this game.", { file: relative }),
} as const;

/** A message id the harness could have saved attachments under. */
const MESSAGE_ID = /^[\w-]{1,80}$/;
/**
 * Where a build-only file is copied to open in its app: under userData, outside every folder an
 * agent process may write, so nothing can be planted where a click opens.
 */
const OPENED_COPIES = "opened-files";

/** A ref as the renderer sent it, reduced to the two fields a lookup reads. */
function chatFileRef(raw: unknown): ChatFileRef {
  const value = (raw ?? {}) as { name?: unknown; base?: unknown };
  return { name: String(value.name ?? ""), ...(typeof value.base === "string" ? { base: value.base } : {}) };
}

/** The fields of a chat's latest run that say where its build lives. */
type LatestRun = { runId?: string; state?: string; landed?: boolean; integrationHead?: unknown };

/** Does the run's build still hold its documents: while it runs, or when it finished without landing? */
function buildIsOpen(run: LatestRun | null): boolean {
  return run?.state !== RunState.Finished || run?.landed === false;
}

export class GameFileService {
  readonly #core: StudioCore;
  /** Its caches (build trees, folder listings) are shared by every chat. */
  readonly #chatFiles = new ChatFileResolver(async () => (await toolchain()).path);

  constructor(core: StudioCore) {
    this.#core = core;
  }

  /**
   * Where a file this chat names can be read: the game folder, and the run's build while that
   * build is running or was not landed — the documents a run writes live there until it lands.
   */
  async #fileSources(
    threadId: string,
  ): Promise<{ projectDir: string; head: string | null; preferBuild: boolean; runId: string | null }> {
    const record = await this.#core.store.getRecord(threadId);
    const project = (record?.metadata as { project?: string } | undefined)?.project;
    if (!project) throw new Error(MESSAGE.noGameFolder());
    const projectDir = this.#core.games.dirFor(project);
    await this.#core.assertProjectAllowed(projectDir);
    // A build a rewind withdrew is not this chat's: its files are not the ones the chat names.
    const conversation = withoutRewound(await this.#core.store.listEvents(threadId), rewindsOf([], record?.metadata));
    const run = latestRun(conversation) as LatestRun | null;
    const head = await this.#runHead(threadId, run);
    return { projectDir, head, preferBuild: Boolean(head && buildIsOpen(run)), runId: run?.runId ?? null };
  }

  /** The commit the run's build is at: its close's integration head, else its journal's. */
  async #runHead(threadId: string, run: LatestRun | null): Promise<string | null> {
    if (!run?.runId) return null;
    if (typeof run.integrationHead === "string") return run.integrationHead;
    const journal = (await this.#core.store.readArtifact(threadId, `autopilot_${run.runId}`).catch(() => null)) as {
      director?: { integrationHead?: string };
    } | null;
    return journal?.director?.integrationHead ?? null;
  }

  /**
   * Where the files a chat names can be: its game (folder and build), the Studio chat's
   * workspace, or anywhere on this computer by absolute path, never credentials or the studio's
   * secrets.
   */
  async #chatFileScope(threadId: string): Promise<ChatFileScope> {
    const record = await this.#core.store.getRecord(threadId).catch(() => null);
    if (!record) throw new Error(MESSAGE.chatGone());
    const meta = (record.metadata ?? {}) as { project?: string; kind?: string };
    const { layout, games, options } = this.#core;
    const home = games.homeDir;
    let game: ChatFileScope["game"] = null;
    if (meta.project) {
      const { projectDir, head, preferBuild, runId } = await this.#fileSources(threadId);
      game = { dir: projectDir, head, preferBuild, runId };
    }
    return {
      home,
      game,
      workspace: meta.kind === ThreadKind.Studio ? layout.harnessWs : null,
      deny: [layout.secrets, layout.engineHomes, ...credentialRoots(home)],
      worktrees: path.join(layout.scratch, "autopilot"),
      copies: path.join(options.paths.userData, OPENED_COPIES),
    };
  }

  /** Which of these names are files on this computer, and how each opens. */
  async resolveChatFiles(threadId: string, refs: unknown): Promise<Array<ChatFileLink | null>> {
    if (!Array.isArray(refs)) throw new Error(MESSAGE.namesRequired);
    const list = refs.slice(0, CHAT_FILE_LIMIT).map(chatFileRef);
    return this.#chatFiles.resolve(await this.#chatFileScope(threadId), list);
  }

  /** The path a click on a chat's file opens, resolved again here, and how to open it. */
  async chatFileTarget(threadId: string, ref: unknown): Promise<{ open: ChatFileOpenOutside; target: string }> {
    return this.#chatFiles.target(await this.#chatFileScope(threadId), chatFileRef(ref));
  }

  async readGameFile(threadId: string, raw: string): Promise<GameFile> {
    const { projectDir, head, preferBuild } = await this.#fileSources(threadId);
    const relative = gameRelativePath(raw, projectDir);
    if (!relative) throw new Error(MESSAGE.outsideGame(String(raw)));
    const fromBuild = () => (head ? readCommitFile(projectDir, head, relative) : Promise.resolve(null));
    const file = preferBuild
      ? ((await fromBuild()) ?? (await readFolderFile(projectDir, relative)))
      : ((await readFolderFile(projectDir, relative)) ?? (await fromBuild()));
    if (!file) throw new Error(MESSAGE.notFound(relative));
    return file;
  }

  /** Show in Finder, for a file the game folder has: its real path inside the folder. */
  async revealGameFile(threadId: string, raw: string): Promise<string> {
    const { projectDir } = await this.#fileSources(threadId);
    const relative = gameRelativePath(raw, projectDir);
    const target = relative ? await folderFilePath(projectDir, relative) : null;
    if (!target) throw new Error(MESSAGE.notInFolder());
    return target;
  }

  /** The images sent with one chat message, as the harness saved them for the agent. */
  async messageImages(threadId: string, messageId: string): Promise<ReferenceFrame[]> {
    if (!MESSAGE_ID.test(String(messageId))) return [];
    const saved = (await this.#core.store
      .readArtifact(threadId, `message_attachments_${messageId}`)
      .catch(() => null)) as { stills?: ReferenceFrame[]; frames?: ReferenceFrame[] } | null;
    const images = saved?.stills?.length ? saved.stills : (saved?.frames ?? []);
    return images.filter((image) => typeof image?.data === "string" && /^image\//.test(String(image.mimeType)));
  }
}
