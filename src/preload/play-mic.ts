/**
 * The Play game view's one preload. Before the game's own scripts run it puts two things into the
 * game's page: the app's microphone (`play-mic-page.ts`), and `window.__genexDesktop`
 * (`play-ai-page.ts`), the embed-sdk's desktop confirm and the `genex-ai` host lane. It carries the
 * page's word to main and main's word back on Play's mic and AI channels: nothing else of the app
 * reaches the page. Each AI envelope leaves with this isolated world's own word on whether a person
 * just activated the page, which the page cannot forge; main refuses a grant or a confirm without
 * it. Sandboxed preloads must be CommonJS.
 */
import { contextBridge, ipcRenderer } from "electron";
import { AiBridgeOp } from "../shared/game-ai.ts";
import { GENEX_DESKTOP_BRIDGE_VERSION, GENEX_DESKTOP_GLOBAL } from "../shared/genex-desktop-bridge.ts";
import { type PlayMicCommand, PlayMicChannel, type PlayMicReport } from "../shared/play-mic.ts";
import {
  PLAY_AI_MAX_ENVELOPE_ID,
  type PlayAiBlocked,
  PlayAiChannel,
  type PlayAiDelta,
  type PlayAiReply,
  PlayBridgeOp,
} from "../shared/play-ai.ts";
import { installPlayAi, type PlayAiControl, type PlayAiPageWords } from "./play-ai-page.ts";
import { installPlayMic, type PlayMicControl } from "./play-mic-page.ts";

/** The page's console words for Play's AI. */
const MESSAGE = {
  blocked: "Genex refused this game's direct request to an AI service. Games reach AI models through genex-ai:",
  exhausted: "Genex: this page has sent all the AI requests it may.",
} as const;

const AI_WORDS: PlayAiPageWords = {
  global: GENEX_DESKTOP_GLOBAL,
  version: GENEX_DESKTOP_BRIDGE_VERSION,
  confirmOp: PlayBridgeOp.GenexConfirm,
  callOp: AiBridgeOp.Call,
  maxId: PLAY_AI_MAX_ENVELOPE_ID,
  blockedNote: MESSAGE.blocked,
  exhausted: MESSAGE.exhausted,
};

const mic = contextBridge.executeInMainWorld({
  func: installPlayMic,
  args: [(report: PlayMicReport) => ipcRenderer.send(PlayMicChannel.Report, report)],
}) as PlayMicControl | null;

ipcRenderer.on(PlayMicChannel.Command, (_event, command: PlayMicCommand) => mic?.command(command));

/** Whether a person activated the page just now: a click or a key the page itself received. */
const activated = (): boolean => navigator.userActivation?.isActive === true;

const ai = contextBridge.executeInMainWorld({
  func: installPlayAi,
  args: [(envelope: unknown) => ipcRenderer.send(PlayAiChannel.Request, envelope, activated()), AI_WORDS],
}) as PlayAiControl | null;

ipcRenderer.on(PlayAiChannel.Reply, (_event, reply: PlayAiReply) => ai?.reply(reply));
ipcRenderer.on(PlayAiChannel.Delta, (_event, delta: PlayAiDelta) => ai?.delta(delta));
ipcRenderer.on(PlayAiChannel.Blocked, (_event, blocked: PlayAiBlocked) => ai?.blocked(blocked));
