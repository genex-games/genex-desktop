/**
 * macOS access for `app_look`: Screen Recording (a window's picture) and Accessibility (its tree).
 * The status is read each time; Genex asks macOS once, at the first look that finds access missing,
 * and remembers that it asked in `<engine homes>/app-look-access.json` (host-only: no agent's file
 * tools reach engine homes). The Automation prompt for System Events is macOS's own, shown at the
 * first tree read; it cannot be asked ahead. Electron-only; the decision itself is `accessStep`.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { desktopCapturer, systemPreferences } from "electron";
import { type AppLookAccessStatus, type ScreenAccess, ScreenAccessState } from "../substrate/app-look.ts";
import { atomicWriteJson } from "../substrate/fsx.ts";

/** The file that remembers Genex asked, under engine homes. */
const ACCESS_FILE = "app-look-access.json";
const KNOWN_STATES: ReadonlySet<string> = new Set(Object.values(ScreenAccessState));

/** Screen Recording's state as macOS reports it; anything unexpected reads as unknown. */
function screenState(): ScreenAccessState {
  const state = systemPreferences.getMediaAccessStatus("screen");
  return KNOWN_STATES.has(state) ? (state as ScreenAccessState) : ScreenAccessState.Unknown;
}

/** Whether the file says Genex asked before; a file that cannot be read says it did not. */
async function askedBefore(file: string): Promise<boolean> {
  const text = await readFile(file, "utf8").catch(() => "");
  try {
    const parsed: unknown = JSON.parse(text);
    return (
      typeof parsed === "object" && parsed !== null && typeof (parsed as { askedAt?: unknown }).askedAt === "string"
    );
  } catch {
    return false;
  }
}

/** The macOS access for `app_look`, remembered under `engineHomes`. */
export function appLookAccess(engineHomes: string): ScreenAccess {
  const file = path.join(engineHomes, ACCESS_FILE);
  const status = (): AppLookAccessStatus => ({
    screen: screenState(),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
  });
  return {
    status,
    asked: () => askedBefore(file),
    async askOnce() {
      if (await askedBefore(file)) return;
      // Written first: a prompt that throws or never answers is still asked only once.
      await atomicWriteJson(file, { askedAt: new Date().toISOString() });
      const now = status();
      if (!now.accessibility) systemPreferences.isTrustedAccessibilityClient(true);
      // Listing windows is what makes macOS show Screen Recording's prompt; no picture is kept.
      if (now.screen !== ScreenAccessState.Granted)
        await desktopCapturer.getSources({ types: ["window"], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
    },
  };
}
