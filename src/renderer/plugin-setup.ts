/**
 * Opening a plugin's setup from anywhere: its toolbar panel over the stage when it has one (for
 * Genex, Studio's own Publish dialog), else the Plugins page on it. The stage strip listens
 * (`panels/PluginToolbar.tsx`); the chat's Genex cover card asks it for Publish.
 *
 * A request for another game's setup (a review notice opens its game with Publish open) waits until
 * that game's strip is up: the strip of the game on screen leaves it, and the strip that comes up
 * for it takes it once, while it is fresh.
 */
import { SECOND_MS } from "../shared/duration.ts";
import { PluginsOpenedFrom } from "./analytics/plugins-page.ts";

/** The window event {@link openPluginSetup} dispatches, with the plugin's id. */
export const PLUGIN_SETUP_EVENT = "studio:plugin-setup";
/** A request for another game's setup is dropped when no strip took it this soon. */
export const PENDING_SETUP_MS = 10 * SECOND_MS;

/** What {@link PLUGIN_SETUP_EVENT} carries: the plugin, (for usage analytics) where it was asked from, and its game. */
export interface PluginSetupRequest {
  id: string;
  from: PluginsOpenedFrom;
  /** The game whose strip opens it; absent for the game on screen. */
  project?: string;
}

/** The request for a game's setup no strip has taken yet, and when it was made. */
let pending: { request: PluginSetupRequest & { project: string }; at: number } | null = null;

/** Open one plugin's setup: its toolbar panel, or the Plugins page on it. */
export function openPluginSetup(id: string, from: PluginsOpenedFrom = PluginsOpenedFrom.SetupRequest): void {
  window.dispatchEvent(new CustomEvent<PluginSetupRequest>(PLUGIN_SETUP_EVENT, { detail: { id, from } }));
}

/** Open one plugin's setup on `project`'s strip, now when it is up, else once it comes up. */
export function openPluginSetupFor(
  project: string,
  id: string,
  from: PluginsOpenedFrom = PluginsOpenedFrom.SetupRequest,
  now = Date.now(),
): void {
  const request = { id, from, project };
  pending = { request, at: now };
  window.dispatchEvent(new CustomEvent<PluginSetupRequest>(PLUGIN_SETUP_EVENT, { detail: request }));
}

/** Whether a strip on `project` answers this request: one for the game on screen, or for its own game. */
export const setupIsFor = (request: Pick<PluginSetupRequest, "project">, project: string | null): boolean =>
  request.project === undefined || request.project === project;

/**
 * The request waiting for `project`'s strip, taken once when `handles` says the strip can open it;
 * null when none waits for it, it is stale, or the strip cannot open it yet.
 */
export function takePendingSetup(
  project: string | null,
  handles: (request: PluginSetupRequest) => boolean,
  now = Date.now(),
): PluginSetupRequest | null {
  if (!pending) return null;
  if (now - pending.at > PENDING_SETUP_MS) {
    pending = null;
    return null;
  }
  if (pending.request.project !== project || !handles(pending.request)) return null;
  const { request } = pending;
  pending = null;
  return request;
}

/** A strip opened the request: it waits no longer. */
export function settlePendingSetup(request: PluginSetupRequest): void {
  if (pending && pending.request.project === request.project && pending.request.id === request.id) pending = null;
}
