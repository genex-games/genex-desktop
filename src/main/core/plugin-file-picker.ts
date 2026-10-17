/**
 * Choose file for plugin panels (`studio:plugins.choose-file`): Studio's own native file picker,
 * over its window, for a panel of an enabled plugin. The panel names a title and the file types;
 * Studio names the plugin, never lets the panel pick the starting folder or several files, opens
 * one picker at a time, and answers only a real file of a listed type, by its real path, or null
 * when the person cancels. Picking reads and writes nothing; the plugin acts on the path itself.
 * The dialog is a dependency, so this runs in Node without Electron.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { pluginFileRequest, type PluginFileRequest } from "../../shared/plugin-file-request.ts";
import type { PluginInfo, PluginManifest } from "../../shared/plugins.ts";

/** The picker's options: the part of Electron's `OpenDialogOptions` it uses, one existing file of the listed types. */
export interface PluginFileDialogOptions {
  title: string;
  message: string;
  buttonLabel: string;
  properties: ["openFile"];
  filters: Array<{ name: string; extensions: string[] }>;
}

/** What the picker needs to know about an installed plugin. */
export type PickerPlugin = Pick<PluginInfo, "enabled" | "removed"> & {
  manifest: Pick<PluginManifest, "id" | "name" | "panels">;
};

/** The dialog and the plugins, as main has them; tests pass recorders. */
export interface PluginFilePickerDeps<W> {
  /** Studio's window; null while it is closed. */
  window(): W | null;
  /** Electron's `dialog.showOpenDialog`. */
  showOpenDialog(window: W, options: PluginFileDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  /** The installed plugins, as the registry lists them now. */
  plugins(): readonly PickerPlugin[];
}

/** Why Choose file is refused, and the picker's own words. */
const MESSAGE = {
  unavailable: "Choose file is only for a panel of an enabled plugin",
  noWindow: "the window is not open",
  busy: "A file picker is already open",
  wrongFile: (extensions: readonly string[]) =>
    `Choose a file that ends in ${extensions.map((extension) => `.${extension}`).join(" or ")}`,
  choose: "Choose",
} as const;

/** The name of the enabled plugin with a panel that `id` names, or null. */
function panelPluginName(plugins: readonly PickerPlugin[], id: unknown): string | null {
  if (typeof id !== "string") return null;
  const plugin = plugins.find((candidate) => candidate.manifest.id === id);
  const hasPanel = plugin?.enabled === true && !plugin.removed && plugin.manifest.panels.length > 0;
  return hasPanel ? plugin.manifest.name : null;
}

/** One existing file of the listed types; the plugin's name leads, so the panel cannot speak as Studio. */
export function pluginFileDialogOptions(pluginName: string, request: PluginFileRequest): PluginFileDialogOptions {
  const heading = `${pluginName}: ${request.title}`;
  return {
    title: heading,
    message: heading,
    buttonLabel: MESSAGE.choose,
    properties: ["openFile"],
    filters: [
      { name: request.extensions.map((extension) => `.${extension}`).join(", "), extensions: [...request.extensions] },
    ],
  };
}

/**
 * The chosen file by its real path, when that is a regular file whose real name ends in a listed
 * extension. A name typed past the filter (Windows) or a link to something else is refused.
 */
async function chosenFile(chosen: string, extensions: readonly string[]): Promise<string> {
  const real = path.isAbsolute(chosen) ? await fs.realpath(chosen).catch(() => null) : null;
  const stat = real ? await fs.stat(real).catch(() => null) : null;
  const extension = real ? path.extname(real).slice(1).toLowerCase() : "";
  const listedFile = real !== null && stat?.isFile() === true && extensions.includes(extension);
  if (!listedFile) throw new Error(MESSAGE.wrongFile(extensions));
  return real;
}

/** Choose file for a panel: `(pluginId, request)` → the chosen file's real path, or null when cancelled. */
export function createPluginFilePicker<W>(
  deps: PluginFilePickerDeps<W>,
): (id: unknown, request: unknown) => Promise<string | null> {
  let open = false;
  return async (id, value) => {
    const pluginName = panelPluginName(deps.plugins(), id);
    if (!pluginName) throw new Error(MESSAGE.unavailable);
    const request = pluginFileRequest(value);
    const window = deps.window();
    if (!window) throw new Error(MESSAGE.noWindow);
    if (open) throw new Error(MESSAGE.busy);
    open = true;
    try {
      const result = await deps.showOpenDialog(window, pluginFileDialogOptions(pluginName, request));
      const [chosen] = result.filePaths;
      if (result.canceled || !chosen) return null;
      return await chosenFile(chosen, request.extensions);
    } finally {
      open = false;
    }
  };
}
