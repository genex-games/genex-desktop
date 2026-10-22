/**
 * The host's side of a plugin panel's bridge (PluginPanelHost), apart from React so it runs in
 * tests: which messages it takes from the frame, how each request is answered, and what the panel
 * is told. A request is answered in the game it was asked in, even when the person moves to another
 * game meanwhile (the panel is told its context changed, then gets its answer); only a panel that
 * is gone gets nothing more.
 */
import { pluginFileRequest } from "../../shared/plugin-file-request.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import { runPluginAction, type PluginReviewRequest } from "../plugin-actions.ts";
import {
  type PanelErrorReply,
  type PanelHead,
  PanelSurface,
  type StyleReader,
  panelContext,
  panelErrorReply,
  panelHead,
  panelHeight,
} from "./panel-bridge.ts";

/** The longest request id a panel may use, and how many requests it may have in flight. */
const REQUEST_ID_MAX = 80;
const MAX_PENDING_REQUESTS = 16;

/** The bridge's message types, as the plugin SDK (src/plugin-sdk/panel.js) spells them. Wire values: never rename. */
export const PanelMessage = {
  Request: "studio-plugin-request",
  Result: "studio-plugin-result",
  ContextChanged: "studio-plugin-context-changed",
  /** A panel on a dialog's card: its heading for the dialog's title, its height, and the dialog's Back. */
  Head: "studio-plugin-head",
  Size: "studio-plugin-size",
  Back: "studio-plugin-back",
} as const;

/** What a panel may ask for over the bridge. Wire values: never rename. */
export const PanelMethod = {
  Context: "context",
  Settings: "settings",
  Action: "action",
  ChooseFile: "chooseFile",
} as const;

/** A panel's request over the bridge, as it arrives: unchecked. */
type PanelRequest = { type?: unknown; id?: unknown; method?: unknown; name?: unknown; args?: unknown } | null;

/** What a panel tells without asking, as it arrives: unchecked. */
type PanelTold = { type?: unknown; title?: unknown; description?: unknown; back?: unknown; height?: unknown } | null;

/** The panel's frame as the host posts to it. */
export type PanelFrame = { postMessage(message: unknown, targetOrigin: string): void };

/** What the bridge reads as it is now, each time it needs it, and where it tells what the panel tells. */
export type PanelBridgeHost = {
  /** The panel's frame; null once it is gone. */
  frame(): PanelFrame | null;
  plugin(): PluginInfo;
  project(): string | null | undefined;
  surface(): PanelSurface;
  /** The theme's properties, for the panel's context. */
  style(): StyleReader;
  review(request: PluginReviewRequest): void;
  onHead(head: PanelHead | null): void;
  onHeight(height: number | null): void;
};

/** A message as the window hears it; its data is unchecked. */
export type PanelEvent = { source: unknown; origin: string; data: PanelRequest & PanelTold };

/** An open bridge: hear a message, tell the panel its context changed, close it for good. */
export type PanelBridge = {
  receive(event: PanelEvent): Promise<void>;
  contextChanged(): void;
  close(): void;
};

/** Whether a message is a bridge request this host takes: well formed, not a repeat, and within the in-flight cap. */
function takesRequest(
  m: PanelRequest,
  active: Set<string>,
): m is { id: string; method?: unknown; name?: unknown; args?: unknown } {
  if (m?.type !== PanelMessage.Request || typeof m.id !== "string") return false;
  return m.id.length <= REQUEST_ID_MAX && !active.has(m.id) && active.size < MAX_PENDING_REQUESTS;
}

/** What one request is answered in: the game and surface it was asked in. */
type Asked = { id: string; plugin: PluginInfo; project: string | null | undefined; surface: PanelSurface };

/** Answer one bridge request: the panel's context, its plugin's settings, one of its declared actions, or a chosen file. */
async function answerRequest(
  m: { method?: unknown; name?: unknown; args?: unknown },
  asked: Asked,
  host: PanelBridgeHost,
  review: (request: PluginReviewRequest) => void,
): Promise<unknown> {
  if (m.method === PanelMethod.Context) return panelContext(asked.project, host.style(), asked.surface);
  if (m.method === PanelMethod.Settings) return await window.studio.pluginSettings(asked.id);
  // Checked here before it leaves the renderer, and again in main before the picker opens.
  if (m.method === PanelMethod.ChooseFile)
    return await window.studio.pluginChooseFile(asked.id, pluginFileRequest(m.args));
  if (m.method !== PanelMethod.Action) throw new Error("Unsupported panel operation");
  // Only a declared action runs, and every declared action has a name.
  if (typeof m.name !== "string") throw new Error("Undeclared action");
  return await runPluginAction({ plugin: asked.plugin, name: m.name, args: m.args, project: asked.project, review });
}

/** The bridge for one panel's frame, reading the host as it is at each request. */
export function openPanelBridge(host: PanelBridgeHost): PanelBridge {
  let closed = false;
  const active = new Set<string>();
  const post = (message: unknown) => {
    if (!closed) host.frame()?.postMessage(message, "*");
  };
  // What a panel tells without asking: its heading and its height, read as data.
  const told = (m: PanelTold): boolean => {
    if (m?.type === PanelMessage.Head) host.onHead(panelHead(m));
    else if (m?.type === PanelMessage.Size) host.onHeight(panelHeight(m));
    else return false;
    return true;
  };
  // A review answered after this bridge closed is a cancel: the action must not run.
  const review = (r: PluginReviewRequest) => host.review({ ...r, resolve: (yes) => r.resolve(yes && !closed) });
  const receive = async (event: PanelEvent): Promise<void> => {
    if (closed || event.source !== host.frame() || event.origin !== "null") return;
    const m = event.data;
    if (told(m) || !takesRequest(m, active)) return;
    active.add(m.id);
    const plugin = host.plugin();
    const asked = { id: plugin.manifest.id, plugin, project: host.project(), surface: host.surface() };
    let body: { result: unknown } | PanelErrorReply;
    try {
      body = { result: await answerRequest(m, asked, host, review) };
    } catch (e) {
      body = panelErrorReply(e);
    } finally {
      active.delete(m.id);
    }
    post({ type: PanelMessage.Result, id: m.id, ...body });
  };
  return {
    receive,
    contextChanged: () => post({ type: PanelMessage.ContextChanged }),
    close: () => {
      closed = true;
    },
  };
}
