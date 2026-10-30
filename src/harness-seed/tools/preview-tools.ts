/**
 * The preview, from outside: load and reload the page, take a screenshot of the whole page (its HTML
 * included), read its console, and drive it with real input (keys, clicks, mouse movement). Genex
 * asks nothing of the game's own code.
 */
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import type { MessageImage } from "../types/host-api.d.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { SECOND_MS } from "../loop/time.ts";

const str = (description: string) => ({ type: "string", description });
/** Bytes in the kilobyte a capture's size is said in. */
const KB = 1024;
/** How long press_keys holds its keys when the call names no time. */
const HOLD_DEFAULT_MS = 400;
/** The most recent console lines console_log reads back. */
const CONSOLE_LINES = 80;

/** A screenshot as a picture the next round sees, or null when the capture held no pixels. */
function shotToImage(shot: { base64?: string } | null | undefined, label: unknown): MessageImage | null {
  if (!shot?.base64) return null;
  return { mimeType: "image/jpeg", data: shot.base64, label: String(label || "screenshot") };
}

/** The keys a press_keys call names: its `keys` list, or its single `key`. */
function keysToPress(args: AnyRecord): string[] {
  if (Array.isArray(args.keys)) return args.keys;
  if (args.key !== undefined && args.key !== null) return [args.key];
  return [];
}

/** A screenshot of the page right after an input, so the model sees what the input did. */
async function shotAfter(ctx: ToolCtx, label: string, done: string) {
  const shot = await ctx.call(HostMethod.PreviewScreenshot, { surface: "page" }).catch(() => null);
  const image = shotToImage(shot, label);
  return { ok: true, content: `${done} Look at the attached picture.`, ...(image ? { images: [image] } : {}) };
}

export const tools: HarnessTool[] = [
  {
    name: "load_preview",
    description: "Load a game project into the built-in browser.",
    parameters: { type: "object", properties: { project: str("project id") }, required: ["project"] },
    async execute(args, ctx) {
      const url = await ctx.call(HostMethod.PreviewLoad, { project: args.project });
      return `Loaded ${url}`;
    },
  },

  {
    name: "reload_preview",
    description: "Reload the preview after editing files.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      await ctx.call(HostMethod.PreviewReload, {});
      // A reload answers the moment the navigation starts, not when the page is on screen.
      const ready = await ctx.call(HostMethod.PreviewReady, {}).catch(() => null);
      const status = await ctx.call(HostMethod.PreviewStatus, {});
      if (status.loadError) return `Reloaded, but the page failed: ${status.loadError}`;
      if (ready?.ready === true)
        return `Reloaded (ready after ${(Math.max(0, Number(ready.ms) || 0) / SECOND_MS).toFixed(1)}s).`;
      return "Reloaded.";
    },
  },

  {
    name: "screenshot",
    description:
      "Capture the whole page as it looks right now (its HTML included). You will see the picture on the next round — a path is not a picture.",
    parameters: {
      type: "object",
      properties: {
        label: str("file label when saving into a run"),
        runId: str("run id, when this shot belongs to a run"),
      },
    },
    async execute(args, ctx) {
      const shot = await ctx.call(HostMethod.PreviewScreenshot, {
        surface: "page",
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.label ? { label: args.label } : {}),
      });
      const image = shotToImage(shot, args.label || "screenshot");
      return {
        ok: true,
        content: `Captured ${Math.round(shot.bytes / KB)} KB${shot.path ? ` → ${shot.path}` : ""}. Look at the attached picture.`,
        details: { path: shot.path, bytes: shot.bytes },
        ...(image ? { images: [image] } : {}),
      };
    },
  },

  {
    name: "press_keys",
    description: "Press keys in the game preview the way a player does. Hold with holdMs.",
    parameters: {
      type: "object",
      properties: {
        keys: {
          type: "array",
          items: { type: "string" },
          description: 'keys to press, e.g. ["w"] or ["shift","space"]',
        },
        key: str("single key, if not using keys[]"),
        holdMs: { type: "number", description: "how long to hold, default 400" },
      },
    },
    async execute(args, ctx) {
      const keys = keysToPress(args);
      if (!keys.length) return { ok: false, content: 'press_keys needs keys: ["w"] (or key: "w").' };
      await ctx.call(HostMethod.PreviewInput, {
        actions: [{ type: "hold", keys, ms: args.holdMs ?? HOLD_DEFAULT_MS }],
      });
      return shotAfter(ctx, "after keys", `Pressed ${keys.join("+")}.`);
    },
  },

  {
    name: "click",
    description:
      "Click in the game preview. Omit x,y to click the centre. Values between 0 and 1 are a fraction of the view.",
    parameters: {
      type: "object",
      properties: {
        x: { type: "number", description: "pixels, or 0–1 fraction" },
        y: { type: "number", description: "pixels, or 0–1 fraction" },
        button: str("left (default), right, or middle"),
      },
    },
    async execute(args, ctx) {
      await ctx.call(HostMethod.PreviewInput, {
        actions: [{ type: "click", x: args.x, y: args.y, button: args.button }],
      });
      return shotAfter(ctx, "after click", "Clicked.");
    },
  },

  {
    name: "look",
    description: "Move the mouse in the game preview (dx/dy in pixels). Positive dx is right, positive dy is down.",
    parameters: {
      type: "object",
      properties: {
        dx: { type: "number", description: "horizontal pixels, positive = right" },
        dy: { type: "number", description: "vertical pixels, positive = down" },
      },
      required: ["dx"],
    },
    async execute(args, ctx) {
      await ctx.call(HostMethod.PreviewInput, { actions: [{ type: "look", dx: args.dx ?? 0, dy: args.dy ?? 0 }] });
      return shotAfter(ctx, "after mouse", "Moved the mouse.");
    },
  },

  {
    name: "console_log",
    description: "Read the game's console output and errors.",
    parameters: { type: "object", properties: { sinceMs: { type: "number", description: "epoch ms" } } },
    async execute(args, ctx) {
      const entries = await ctx.call(HostMethod.PreviewConsole, { sinceMs: args.sinceMs ?? 0 });
      if (!entries.length) return "(console is empty)";
      return entries
        .slice(-CONSOLE_LINES)
        .map((e) => `[${e.level}] ${e.message}${e.source ? ` (${e.source}:${e.line ?? 0})` : ""}`)
        .join("\n");
    },
  },

  {
    name: "gpu_errors",
    description: "WebGL errors from the GPU process — the page console never sees these.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const errors = await ctx.call(HostMethod.PreviewGpuErrors, {});
      if (!errors?.length) return "(no WebGL errors)";
      return errors.map((entry) => `- ${entry}`).join("\n");
    },
  },
];
