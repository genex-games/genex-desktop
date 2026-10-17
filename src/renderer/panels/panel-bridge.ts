/**
 * The pure parts of the plugin panel bridge (PluginPanelHost): what a panel is told about where it
 * runs, and how a failed request is answered. Kept apart from the React host so they run in tests.
 */
import { errorMessage, isUserCancelled } from "../../shared/errors.ts";
import { PanelErrorCode, PLUGIN_API_VERSION } from "../../shared/plugins.ts";

/** Reads one CSS custom property, as `getComputedStyle` does. */
export type StyleReader = { getPropertyValue(name: string): string };

/** The answer to a failed panel request: its text, and `code` when the person cancelled. */
export type PanelErrorReply = { error: string; code?: PanelErrorCode };

/** What a panel's frame sits on: the page, or a dialog's card, whose colour its background must match. */
export const PanelSurface = { Page: "page", Card: "card" } as const;
export type PanelSurface = (typeof PanelSurface)[keyof typeof PanelSurface];

/** The theme property each surface is painted with. */
const SURFACE_BACKGROUND = {
  [PanelSurface.Page]: "--background",
  [PanelSurface.Card]: "--card",
} as const satisfies Record<PanelSurface, string>;

/**
 * What a panel is told about where it runs: the project, the theme's colours (its background is
 * the surface it sits on) and the plugin API version. `accent` is the raw accent; `accentFill`,
 * `accentForeground` and `accentHover` are the readable button colours Studio's own primary
 * buttons use. `surface` says what the frame sits on: in a dialog's card the panel's heading is
 * the dialog's title, so the panel leaves out its own.
 */
export function panelContext(
  project: string | null | undefined,
  style: StyleReader,
  surface: PanelSurface = PanelSurface.Page,
) {
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    project: project ?? null,
    theme: {
      background: read(SURFACE_BACKGROUND[surface]),
      foreground: read("--foreground"),
      accent: read("--accent-primary"),
      accentFill: read("--accent-fill"),
      accentForeground: read("--accent-foreground"),
      accentHover: read("--accent-hover"),
    },
    apiVersion: PLUGIN_API_VERSION,
    surface,
  };
}

/**
 * How a failed request is answered: a cancel the person chose carries `code: cancelled` with its
 * words, so a panel can stay quiet without matching text; any other failure keeps its text as it was.
 */
export function panelErrorReply(error: unknown): PanelErrorReply {
  if (isUserCancelled(error)) return { error: errorMessage(error), code: PanelErrorCode.Cancelled };
  return { error: String(error) };
}

/** The longest heading and description a panel may give its dialog, and the tallest it may ask to be. */
const PANEL_TITLE_MAX = 80;
const PANEL_DESCRIPTION_MAX = 240;
const PANEL_HEIGHT_MAX = 4000;

/** A panel's heading as its dialog shows it: the title, the line under it, and whether it offers Back. */
export type PanelHead = { title: string; description: string | null; back: boolean };

/** A short line of a panel's own text, trimmed and capped; null when it is not text or is empty. */
function panelLine(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const line = value.replace(/\s+/g, " ").trim();
  return line ? line.slice(0, max) : null;
}

/** A panel's heading message read as data: null when it names no title (the dialog keeps its own). */
export function panelHead(message: { title?: unknown; description?: unknown; back?: unknown }): PanelHead | null {
  const title = panelLine(message.title, PANEL_TITLE_MAX);
  if (!title) return null;
  return { title, description: panelLine(message.description, PANEL_DESCRIPTION_MAX), back: message.back === true };
}

/** The height a panel asks its frame to be, in whole pixels within the cap; null when it is no height. */
export function panelHeight(message: { height?: unknown }): number | null {
  const { height } = message;
  if (typeof height !== "number" || !Number.isFinite(height) || height < 0) return null;
  return Math.min(Math.ceil(height), PANEL_HEIGHT_MAX);
}
