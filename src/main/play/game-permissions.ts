/**
 * What a game's page in Play may be granted: pointer lock, full screen and clipboard writes, from
 * its own top frame only; the microphone only as its view's gate lets it (`mic.ts`); nothing else
 * (camera, location, notifications, devices). Electron-free, so every request is a plain answer.
 */
import type { MicGate, MicRequest } from "./mic.ts";

/** The permissions a game in Play may have, besides the microphone. */
export const PLAY_GRANTED: ReadonlySet<string> = new Set(["pointerLock", "fullscreen", "clipboard-sanitized-write"]);
/** The permission Electron asks a microphone (or a camera) under. */
const MEDIA = "media";

/** Whether a game's page is granted `permission` now: `request` says what and from which frame. */
export function playPermitted(
  permission: string,
  request: MicRequest,
  gate: MicGate | undefined,
  now: number,
): boolean {
  if (permission !== MEDIA) return PLAY_GRANTED.has(permission) && request.isMainFrame;
  return gate?.take(request, now) === true;
}

/** Whether a game's page may check `permission`: the same few, and the microphone's names once its gate trusts it. */
export function playPermissionShown(
  permission: string,
  check: { mediaType: string | undefined; isMainFrame: boolean },
  gate: MicGate | undefined,
): boolean {
  if (permission !== MEDIA) return PLAY_GRANTED.has(permission) && check.isMainFrame;
  return gate?.names(check.mediaType, check.isMainFrame) === true;
}
