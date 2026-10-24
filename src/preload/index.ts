/**
 * Renderer bridge. Sandboxed preloads must be CommonJS, and the surface is deliberately a fixed
 * list of named calls: the renderer can ask the substrate to do specific things, never to
 * evaluate arbitrary code or touch the filesystem. The calls are built in `studio-bridge.ts`, typed
 * by the channel map in `shared/ipc-channels.ts`.
 */
import { contextBridge, ipcRenderer, sharedTexture, webUtils } from "electron";
import { systemLanguagesFromArgs } from "../shared/locale.ts";
import { type BridgeFrames, createStudioBridge } from "./studio-bridge.ts";

/** Whether this Electron has a `sharedTexture` the bridge can receive Live's embedded frames through. */
function hasFramesReceiver(candidate: unknown): candidate is BridgeFrames {
  return (
    typeof candidate === "object" &&
    candidate !== null &&
    "setSharedTextureReceiver" in candidate &&
    typeof candidate.setSharedTextureReceiver === "function"
  );
}

// The frames receiver is registered here, at load, before main can send a frame (studio-bridge.ts).
const frames = hasFramesReceiver(sharedTexture) ? sharedTexture : undefined;
contextBridge.exposeInMainWorld(
  "studio",
  createStudioBridge(ipcRenderer, webUtils, systemLanguagesFromArgs(process.argv), frames),
);

export type { StudioApi } from "../shared/studio-api.ts";
