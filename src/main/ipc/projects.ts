/** Folders on this Mac: picking, inspecting, adopting and opening a game, and showing its files. */
import path from "node:path";
import { dialog, shell, type BrowserWindow } from "electron";
import { tagGenexLink } from "../../plugins/genex/http.ts";
import { containedReal } from "../../substrate/paths.ts";
import { ChatFileOpen } from "../../shared/chat-files.ts";
import { isGenexRef } from "../../shared/genex-ref.ts";
import { gameLocationPickerOptions, projectPickerOptions } from "../project-picker.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";

/** Why a project request from the renderer is refused. */
const MESSAGE = {
  httpsOnly: "only https urls",
  noWindow: "the window is not open",
  unknownProject: (name: string) => `unknown project ${name}`,
} as const;

export interface ProjectsIpcDeps {
  core: StudioCore;
  /** The studio window; null while it is closed. */
  window(): BrowserWindow | null;
  /** `~/AI Games`, as a human reads it — the renderer never sees absolute paths. */
  gamesRootLabel(root: string): string;
}

export function registerProjectsIpc(
  handle: IpcHandle,
  { core, window: currentWindow, gamesRootLabel }: ProjectsIpcDeps,
): void {
  handle("studio:open-url", async (payload) => {
    if (!/^https:\/\//i.test(payload.url ?? "")) throw new Error(MESSAGE.httpsOnly);
    // Every renderer link lands here; a genex.games page goes tagged `s=desktop`.
    await shell.openExternal(tagGenexLink(payload.url));
    return true;
  });
  handle("studio:export", async (payload) => {
    const result = await core.exportPublicCopy(payload.project, path.join(core.layout.exports, payload.project));
    await shell.openPath(result.dir);
    return result;
  });

  // The renderer names a project and, at most, a file inside it; main resolves the folder and
  // contains the relative path. The few calls that do take an absolute path from the renderer
  // (open-path, project.inspect, project.adopt: a folder the user picked) validate it in main.
  handle("studio:reveal-project", async (payload) => {
    shell.showItemInFolder(await revealTarget(core, payload.project, payload.file));
    return true;
  });

  // Markdown and images the chat names open beside it. Main resolves the name inside that chat's game.
  handle("studio:game-file.read", async (payload) => core.readGameFile(String(payload.threadId), String(payload.path)));
  handle("studio:game-file.reveal", async (payload) => {
    shell.showItemInFolder(await core.revealGameFile(String(payload.threadId), String(payload.path)));
    return true;
  });
  // Every other file the chat names opens in its app. The renderer sends the words the chat used;
  // main finds the file again and decides how it opens (main/chat-files.ts): documents in their
  // app, folders in the file manager, and programs, scripts and unknown types only shown there.
  handle("studio:chat-files.resolve", async (payload) =>
    core.resolveChatFiles(String(payload?.threadId), payload?.refs),
  );
  handle("studio:chat-file.open", async (payload) => {
    const { open, target } = await core.chatFileTarget(String(payload?.threadId), payload?.ref);
    if (open === ChatFileOpen.Finder) {
      shell.showItemInFolder(target);
      return { open };
    }
    const problem = await shell.openPath(target);
    if (!problem) return { open };
    // No app on this computer claims it: show where it is instead of failing silently.
    shell.showItemInFolder(target);
    return { open: ChatFileOpen.Finder, problem };
  });

  handle("studio:project.pick", async () => {
    const window = currentWindow();
    if (!window) throw new Error(MESSAGE.noWindow);
    const result = await dialog.showOpenDialog(window, projectPickerOptions(core.layout.gamesRoot));
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    // Picking is not opening: the dialog answers *which folder*, and nothing is written until
    // the Open Game sheet has shown what is in it and the user has pressed its button.
    return dir;
  });

  // Create game's location. Choosing is not creating: the answer is checked by its real path, as
  // creating there will be, so a refused folder is said at once; nothing is written until Create.
  handle("studio:game.location.pick", async () => {
    const window = currentWindow();
    if (!window) throw new Error(MESSAGE.noWindow);
    const result = await dialog.showOpenDialog(window, gameLocationPickerOptions(core.layout.gamesRoot));
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    return core.gameLocation(dir);
  });

  // Settings → Games. New games go to the chosen folder; the ones already made stay where they are.
  handle("studio:games-root.choose", async () => {
    const window = currentWindow();
    if (!window) throw new Error(MESSAGE.noWindow);
    const result = await dialog.showOpenDialog(window, {
      title: "Folder for new games",
      defaultPath: path.dirname(core.layout.gamesRoot),
      buttonLabel: "Use this folder",
      message: "Choose an empty folder, or create one. Games you already have stay where they are.",
      properties: ["openDirectory", "createDirectory"],
    });
    const dir = result.filePaths[0];
    if (result.canceled || !dir) return null;
    await core.setGamesRoot(dir);
    return gamesRootLabel(core.layout.gamesRoot);
  });

  // Looking is not adopting: this reads the folder and writes nothing, so the sheet can show
  // what is there — including a game one level down — before the user agrees to open it.
  handle("studio:project.inspect", async (payload) => core.inspectFolder(payload.dir));

  // The sheet's own button. `subdir` is a candidate the inspection listed (the nested game the
  // studio offers as *the* game); `template` is the answer to "may I write a starter game here";
  // `versionNested` is the consent a row that keeps a folder holding its own repository carries.
  handle("studio:project.adopt", async (payload) =>
    core.adoptProject(payload.dir, {
      ...(payload.subdir ? { subdir: payload.subdir } : {}),
      ...(payload.title ? { title: payload.title } : {}),
      ...(typeof payload.template === "boolean" ? { template: payload.template } : {}),
      ...(payload.versionNested === true ? { versionNested: true } : {}),
      trustProjectSettings: payload.trustProjectSettings === true,
    }),
  );

  handle("studio:project.open", async (payload) => {
    const games = await core.games.list();
    const project = games.find((g) => g.name === payload.name);
    if (!project) throw new Error(MESSAGE.unknownProject(payload.name));
    await core.assertProjectAllowed(project.dir);
    await core.games.touch(project.name);
    core.sandbox.allowWrite(project.dir);
    return project;
  });
}

/** What Reveal shows: a retained Genex asset, a file inside the game, or the game's folder. */
async function revealTarget(core: StudioCore, project: string, file: string | undefined): Promise<string> {
  if (isGenexRef(file)) return core.retainedAssetFile(project, file);
  const dir = core.games.dirFor(project);
  return file ? containedReal(dir, file) : dir;
}
