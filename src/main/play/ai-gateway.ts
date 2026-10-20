/**
 * Play's gateway to AI vendors (owner decision D5): `genex-ai` is the only way a published game
 * reaches a model in Genex, so Play's session refuses every request a game's page makes to an AI
 * vendor's API host (`shared/ai-vendors.ts`) and tells the page why, once per host, as a typed
 * console line (`ai_direct_blocked`). A near miss (`api.openai.com.evil.io`, a vendor's name in a
 * path or a query) loads as before. Electron-free: `viewer-view.ts` runs it in the session's
 * request filter.
 */
import { aiVendorOfHost } from "../../shared/ai-vendors.ts";
import { AiErrorCode } from "../../shared/game-ai.ts";
import type { PlayAiBlocked } from "../../shared/play-ai.ts";

/** The most vendor hosts one page is told about; past them refusals go on silently. */
export const BLOCKED_NOTES_MAX = 32;

/** The schemes a request reaches a vendor's API on; nothing else is parsed (a `data:` address may be megabytes). */
const NETWORK_SCHEME = /^(?:https?|wss?):\/\//i;

/** The host a network address names, lowercase and without a trailing root dot, or null. */
function networkHost(url: string): string | null {
  if (!NETWORK_SCHEME.test(url)) return null;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return host || null;
  } catch {
    return null;
  }
}

/** Why Play refuses a request of a game's page, or null when it may load. Never throws. */
export function aiGatewayVerdict(url: string): PlayAiBlocked | null {
  const host = networkHost(url);
  const vendor = host ? aiVendorOfHost(host) : null;
  if (!host || !vendor) return null;
  return { code: AiErrorCode.DirectBlocked, vendor, host };
}

/**
 * Which refusals a page has been told about: each host once per page, and at most
 * {@link BLOCKED_NOTES_MAX} of them, so a game retrying in a loop cannot flood its console or main.
 */
export function blockedNotes() {
  const told = new Set<string>();
  return {
    /** Whether this refusal is news to the page (and is now told). */
    first(blocked: PlayAiBlocked): boolean {
      if (told.has(blocked.host) || told.size >= BLOCKED_NOTES_MAX) return false;
      told.add(blocked.host);
      return true;
    },
    /** A new page: it has been told nothing yet. */
    reset(): void {
      told.clear();
    },
  };
}

/** A page's refusals told, as `blockedNotes` makes them. */
export type BlockedNotes = ReturnType<typeof blockedNotes>;
