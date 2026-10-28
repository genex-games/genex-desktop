/**
 * The Play bar layer's preload (`renderer/play-bar.html`): the studio's own bridge, cut to the few
 * calls the bar and its Comments make (`shared/play-bar.ts`), since the page shows genex.games'
 * words and pictures. Sandboxed preloads must be CommonJS.
 */
import { contextBridge, ipcRenderer } from "electron";
import { systemLanguagesFromArgs } from "../shared/locale.ts";
import { PLAY_BAR_CALLS } from "../shared/play-bar.ts";
import { createStudioBridge } from "./studio-bridge.ts";

const bridge = createStudioBridge(ipcRenderer, undefined, systemLanguagesFromArgs(process.argv));
contextBridge.exposeInMainWorld("studio", Object.fromEntries(PLAY_BAR_CALLS.map((name) => [name, bridge[name]])));
