/**
 * The Play game view's preload. It puts the app's microphone into the game's page before the game's
 * own scripts run (`play-mic-page.ts`), and carries the page's word to main and main's word back on
 * Play's two mic channels: nothing else of the app reaches the page. Sandboxed preloads must be
 * CommonJS.
 */
import { contextBridge, ipcRenderer } from "electron";
import { type PlayMicCommand, PlayMicChannel, type PlayMicReport } from "../shared/play-mic.ts";
import { installPlayMic, type PlayMicControl } from "./play-mic-page.ts";

const mic = contextBridge.executeInMainWorld({
  func: installPlayMic,
  args: [(report: PlayMicReport) => ipcRenderer.send(PlayMicChannel.Report, report)],
}) as PlayMicControl | null;

ipcRenderer.on(PlayMicChannel.Command, (_event, command: PlayMicCommand) => mic?.command(command));
