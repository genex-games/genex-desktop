/**
 * Renderer bridge. Sandboxed preloads must be CommonJS, and the surface is deliberately a fixed
 * list of named calls: the renderer can ask the substrate to do specific things, never to
 * evaluate arbitrary code or touch the filesystem. The calls are built in `studio-bridge.ts`, typed
 * by the channel map in `shared/ipc-channels.ts`.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";
import { systemLanguagesFromArgs } from "../shared/locale.ts";
import { createStudioBridge } from "./studio-bridge.ts";

contextBridge.exposeInMainWorld(
  "studio",
  createStudioBridge(ipcRenderer, webUtils, systemLanguagesFromArgs(process.argv)),
);

export type { StudioApi } from "../shared/studio-api.ts";
