/**
 * What a game's page in a preview may be granted, Electron-free so every request is a plain answer.
 * Pointer lock (and full screen in a window a person sees) for mouse-look; the microphone only in
 * Live, for a game that declares it, once the person allowed it (`core/preview-mic.ts`), and only as
 * Play's gate lets it (`play/mic.ts`): audio alone, from the game's own top frame. Never a camera,
 * never an agent's window, never a frame of another origin.
 */
import { type MicRequest, micGateFor } from "./play/mic.ts";

/** The permission Electron asks a microphone (or a camera) under. */
const MEDIA = "media";

/** The permissions a preview grants without asking: mouse-look, and full screen in a window a person sees. */
export function previewInputPermissions(offscreen: boolean): ReadonlySet<string> {
  return new Set(offscreen ? ["pointerLock"] : ["pointerLock", "fullscreen"]);
}

/** A media request as Electron's request handler describes it, with the address of the frame that asked. */
export interface PreviewMediaRequest extends MicRequest {
  requestingUrl: string;
}

/**
 * Whether a preview's media request may go to the person at all: only Live asks (`live`), only for
 * audio alone, only from the game's own top frame on the page's own origin (`page`, the address Live
 * loaded). Anything else is refused at once, with no prompt.
 */
export function previewMicMayAsk(request: PreviewMediaRequest, page: string, live: boolean, now: number): boolean {
  if (!live) return false;
  // Play's gate, opened for this one look: it answers the same shape and origin rules a grant needs.
  const gate = micGateFor(request.requestingUrl, page);
  gate.allow(now);
  return gate.take(request, now);
}

/** Whether a preview's permission request is granted without asking: never the microphone, which asks (`previewMicMayAsk`). */
export function previewPermitted(permission: string, inputs: ReadonlySet<string>): boolean {
  return permission !== MEDIA && inputs.has(permission);
}

/** Whether `permission` is Electron's media one, which the microphone and camera ask under. */
export const isMediaPermission = (permission: string): boolean => permission === MEDIA;

/**
 * Whether a preview's page may see that it holds the microphone (a permission check): in Live, for
 * audio from its own top frame, once the person allowed this game.
 */
export function previewMicShown(
  check: { mediaType: string | undefined; isMainFrame: boolean },
  live: boolean,
  allowed: boolean,
): boolean {
  return live && allowed && check.isMainFrame && check.mediaType === "audio";
}
