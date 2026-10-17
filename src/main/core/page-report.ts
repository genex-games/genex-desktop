/**
 * What a served page reported back: the attach report every failure path shares, and the notes a
 * load adds when a page wanders off or boots slowly.
 */
import type { AttachReport } from "../../shared/game-project.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import type { ReadyResult } from "../../substrate/preview-ready.ts";

/** At most this many reported names are kept for a sheet. */
const REPORTED_NAMES_CAP = 24;
/** A page that boots this slowly is told so: every look at the build waits that long. */
const SLOW_BOOT_MS = 5 * SECOND_MS;

/**
 * Which page a port was actually given: the folder it is served from, the page in it, and the
 * origin it is served under (a template game that starts loading the Genex SDK moves to loopback).
 */
export function servedKey(served: { entry: string; root: string | undefined; loopback?: boolean }): string {
  return JSON.stringify([served.root ?? null, served.entry, served.loopback === true]);
}

/** A string the page reported, or nothing — never the word "undefined" on a sheet. */
export function str(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** A list of names the page reported: bare strings, or the `url` of each record it kept. */
export function names(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) =>
      typeof item === "string"
        ? item
        : (str((item as { url?: unknown })?.url) ?? str((item as { name?: unknown })?.name) ?? ""),
    )
    .filter(Boolean)
    .slice(0, REPORTED_NAMES_CAP);
}

/** Nothing was reached: the answer every failure path gives, so a caller reads one shape. */
export function noAttachment(
  reason: string | null,
  loadError: string | null,
  consoleErrors: number | null,
): AttachReport {
  return {
    ok: false,
    contract: "none",
    shim: false,
    reach: null,
    renderer: null,
    scene: null,
    camera: null,
    cameras: [],
    eyes: [],
    player: false,
    renders: 0,
    frames: 0,
    three: [],
    reason,
    loadError,
    consoleErrors,
  };
}

/**
 * The page's own account of itself, read field by field over `base` (what the load already
 * knows), so a page that answers a shape nobody expected cannot become the answer.
 */
export function attachReport(reported: Record<string, unknown>, base: AttachReport): AttachReport {
  const contract = reported.contract === "installed" || reported.contract === "attached" ? reported.contract : "none";
  const merged: AttachReport = {
    ...base,
    contract,
    shim: Boolean(reported.shim),
    reach: str(reported.reach) ?? base.reach,
    renderer: str(reported.renderer) ?? base.renderer,
    scene: str(reported.scene) ?? base.scene,
    camera: str(reported.camera) ?? base.camera,
    cameras: names(reported.cameras),
    eyes: names(reported.eyes),
    player: Boolean(reported.player),
    renders: Number(reported.renders) || 0,
    frames: Number(reported.frames) || 0,
    // The hook reports each three it wrapped as a record; the sheet wants the URLs.
    three: names(reported.three),
  };
  return { ...merged, ok: merged.contract !== "none" };
}

/** The address a URL belongs to: `game://<project>`, or scheme + host + port for the loopback. */
export function originOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "about:" || parsed.protocol === "blob:") return null;
    return `${parsed.protocol}//${parsed.host || parsed.hostname}`;
  } catch {
    return null;
  }
}

/**
 * A page that has left the address the studio put in the window. The studio serves every page
 * itself — that is how the shim, the clock and the cameras get there at all — so a game that
 * navigates to its own dev server has walked out of the studio's sight, and saying so by name
 * beats judging a page nothing can drive.
 */
export function strayPage(loaded: string, url: string | null): string | null {
  const served = originOf(loaded);
  const now = originOf(url);
  const leftTheStudio = served && now && served !== now;
  if (!leftTheStudio) return null;
  return `the page left ${served} for ${now}, which the studio does not serve — nothing the studio puts on a page (the clock, the cameras, the capture) reaches it there`;
}

/** How long a page takes to boot is the builder's business; the studio only ever says so. */
export function readyNote(ready: ReadyResult): string | null {
  if (ready.timedOut) {
    return `the page has not reported itself ready after ${Math.round(ready.budgetMs / SECOND_MS)}s — you are looking at whatever it drew`;
  }
  const pageMs = ready.ready && typeof ready.pageMs === "number" ? ready.pageMs : null;
  if (pageMs === null || pageMs < SLOW_BOOT_MS) return null;
  return `the page took ${(pageMs / SECOND_MS).toFixed(1)}s to boot — every look at this build costs that much waiting`;
}
