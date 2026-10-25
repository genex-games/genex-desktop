/** Settings → Storage's data folder: where Genex keeps its files, picking another folder, and the move. */
import { dialog, type BrowserWindow } from "electron";
import type { DataFolderChoices } from "../data-folder-choice.ts";
import { t } from "../../shared/i18n.ts";
import type { IpcHandle } from "./registrar.ts";

/** The picker's words, read when it opens: main's language is set after start. */
const picker = () => ({
  title: t("Folder for Genex’s files"),
  buttonLabel: t("Use this folder"),
  message: t("Pick an empty folder or a drive. Genex makes a Genex folder in one that has files."),
});

const MESSAGE = {
  noWindow: () => t("The studio window is not open."),
} as const;

/** What the data folder's channels need: its choices, and how a folder is picked (the native picker by default). */
export interface DataFolderIpcDeps {
  choices: DataFolderChoices;
  window: () => BrowserWindow | null;
  /** The folder the person picks, or null when they cancel; the data-folder fixture names a stand-in. */
  pick?: (window: BrowserWindow, defaultPath: string) => Promise<string | null>;
}

/** The native folder picker. */
async function pickFolder(window: BrowserWindow, defaultPath: string): Promise<string | null> {
  const result = await dialog.showOpenDialog(window, {
    ...picker(),
    defaultPath,
    properties: ["openDirectory", "createDirectory"],
  });
  const dir = result.filePaths[0];
  return result.canceled || !dir ? null : dir;
}

export function registerDataFolderIpc(handle: IpcHandle, deps: DataFolderIpcDeps): void {
  handle("studio:data-folder", async () => deps.choices.state());

  // The folder picker, then the checks; nothing is written until the move. A launch that cannot
  // move its data (another system, a developer or test launch) says so without opening a picker.
  handle("studio:data-folder.choose", async () => {
    const state = deps.choices.state();
    if (!state.movable) return deps.choices.choose(state.dir);
    const window = deps.window();
    if (!window) throw new Error(MESSAGE.noWindow());
    const dir = await (deps.pick ?? pickFolder)(window, state.dir);
    return dir ? deps.choices.choose(dir) : null;
  });

  handle("studio:data-folder.move", async () => deps.choices.move());
}
