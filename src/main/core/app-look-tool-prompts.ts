/** What `app_look` says to a model: its description and its answers (`app-look-tool.ts`). Model-facing text. */
import type { LiveToolSpec } from "../../shared/engine-requests.ts";
import { APP_LOOK_TOOL_NAME, AppLookAccessKind } from "../../shared/jobs.ts";

/** `app_look`: a window's picture and accessibility tree, look-only. */
export const APP_LOOK_TOOL: LiveToolSpec = {
  name: APP_LOOK_TOOL_NAME,
  description:
    "Look at an app window on this Mac: the running game, an editor, a tool. Without arguments it lists the windows on screen (app, title, id). With app or window it answers that window's screenshot and its accessibility tree (roles, titles, values). It only looks: you cannot click or type with it. With save it also keeps the screenshot as a .jpg in your folder.",
  parameters: {
    type: "object",
    properties: {
      app: { type: "string", description: "The app, by its name or bundle id, e.g. Godot." },
      window: { type: "string", description: "A window id from the list, or words of its title." },
      save: {
        type: "string",
        description: "A .jpg path inside your project folder to keep the picture, for example as proof.",
      },
    },
  },
};

/** The most windows a list names. */
const LISTED_MAX = 60;

/** System Settings' names for what is missing. */
const ACCESS_WORDS = {
  [AppLookAccessKind.Screen]: "Screen Recording",
  [AppLookAccessKind.Accessibility]: "Accessibility",
} as const satisfies Record<AppLookAccessKind, string>;

/** One window, as a list or a look names it. */
export interface LookedWindow {
  id: number;
  app: string;
  title: string;
}

/** A window's name: its app and title. */
const nameOf = (window: LookedWindow) => `${window.app} — ${window.title || "(no title)"}`;

/** What `app_look` answers. */
export const APP_LOOK_ANSWER = {
  windows: (windows: readonly LookedWindow[]) =>
    windows.length
      ? [
          "Windows on screen (call app_look with app or window to look at one):",
          ...windows.slice(0, LISTED_MAX).map((window) => `${window.id} · ${nameOf(window)}`),
        ].join("\n")
      : "No app windows are on screen.",
  looked: (window: LookedWindow, tree: string, notes: readonly string[]) =>
    [`${nameOf(window)} (window ${window.id})`, tree || "(no accessibility tree)", ...notes].join("\n"),
  truncated: "(the tree was cut at its size limit)",
  noPicture: (why: string) => `(no screenshot: ${why})`,
  noMatch: "No window on screen matches that. Call app_look with no arguments to list them.",
  notOnScreen: "That window is not on screen any more. Call app_look with no arguments to list them.",
  refused:
    "Genex does not look at password managers, System Settings, the system's password prompts or its own windows.",
  unsupported: "app_look works on macOS only for now.",
  failed: (detail: string) => `Genex could not look at app windows: ${detail || "the command failed"}.`,
  saved: (file: string) => `Saved the picture as ${file}.`,
  notSaved: (why: string) => `The picture was not saved: ${why}.`,
  saveNoPicture: "there was no picture to save",
  saveNoWrite: "this session may not write files",
  saveInPlan: "the chat is in Plan mode, where nothing is written",
  saveBadPath: "save takes a relative path ending in .jpg, inside your folder, with no .. in it",
  saveOutside: "that folder is not a plain folder inside your folder (a link, a file, or outside it)",
  missing: (missing: readonly AppLookAccessKind[]) =>
    `Genex cannot see app windows yet: the person must allow ${missing.map((kind) => ACCESS_WORDS[kind]).join(" and ")} for Genex in System Settings → Privacy & Security${missing.includes(AppLookAccessKind.Accessibility) ? " (and, if macOS asks, let Genex control System Events)" : ""}. Tell them; do not retry until they say it is on.`,
} as const;
