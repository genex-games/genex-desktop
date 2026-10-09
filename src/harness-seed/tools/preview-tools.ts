/**
 * The senses — PLAN.md §7.
 *
 * "It renders" is not "it's fun", and a screenshot alone is a weak signal in 3D. So the studio
 * always has two channels: pixels (screenshots at named camera angles) and structure
 * (`__studio.state()` probes, console errors, fps). Hands (keys, look, click) are how it
 * *plays* the game instead of watching the clock.
 */
import { applyPlayScript, CONTROL_EXERCISE, shotToImage } from "../loop/play-script.ts";
import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "../loop/host-methods.ts";
import { PageMethod } from "../loop/page-contract.ts";
import { SECOND_MS } from "../loop/time.ts";

const str = (description: string) => ({ type: "string", description });
/** The most pictures one play call hands back to the turn. */
const MAX_TURN_IMAGES = 4;
/** Bytes in the kilobyte a capture's size is said in. */
const KB = 1024;
/** How long press_keys holds its keys when the call names no time. */
const HOLD_DEFAULT_MS = 400;
/** One stepped frame of the paused clock. */
const STEP_MS = 16;
/** Frames play_script steps after its script when the call names none (about five seconds), and how many one step call takes. */
const DEFAULT_STEPS = 300;
const STEPS_PER_CALL = 60;
/** The most recent console lines console_log reads back. */
const CONSOLE_LINES = 80;

/** The racing-line assist on or off around a held press; a page without one answers so, never throws here. */
async function steerWhileHeld(ctx: ToolCtx, on: boolean): Promise<void> {
  await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Assist, arg: { steer: on } }).catch(() => null);
}

/** The keys a press_keys call names: its `keys` list, or its single `key`. */
function keysToPress(args: AnyRecord): string[] {
  if (Array.isArray(args.keys)) return args.keys;
  if (args.key !== undefined && args.key !== null) return [args.key];
  return [];
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
      // A reload answers the moment the navigation starts, not when the game is on screen: a
      // screenshot taken straight after it photographs a page that has drawn nothing. Wait for
      // the page to say it is ready, and say how long it took — or that it never did.
      const ready = await ctx.call(HostMethod.PreviewReady, {}).catch(() => null);
      const status = await ctx.call(HostMethod.PreviewStatus, {});
      if (status.loadError) return `Reloaded, but the page failed: ${status.loadError}`;
      if (ready?.ready === true)
        return `Reloaded (ready after ${(Math.max(0, Number(ready.ms) || 0) / SECOND_MS).toFixed(1)}s).`;
      if (ready?.timedOut === true) {
        const budget = (Math.max(0, Number(ready.budgetMs) || 0) / SECOND_MS).toFixed(1);
        return `Reloaded, but the page was not ready after ${budget}s${ready.reason ? `: ${ready.reason}` : ""}.`;
      }
      return "Reloaded.";
    },
  },

  {
    name: "screenshot",
    description:
      "Capture what the game looks like right now. You will see the picture on the next round — a path is not a picture. Pass a camera name to compare like with like across builds.",
    parameters: {
      type: "object",
      properties: {
        camera: str("named debug camera, e.g. default/top/close/wide"),
        label: str("file label when saving into a run"),
        runId: str("run id, when this shot belongs to a gauntlet iteration"),
      },
    },
    async execute(args, ctx) {
      if (args.camera) await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: args.camera });
      const shot = await ctx.call(HostMethod.PreviewScreenshot, {
        ...(args.runId ? { runId: args.runId } : {}),
        ...(args.label ? { label: args.label } : {}),
      });
      const image = shotToImage(shot, args.camera || args.label || "screenshot");
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
    description:
      "Press keys in the game preview the way a player would (WASD, Space, arrows). Hold with holdMs. Then look at a screenshot — 'I added WASD' is not a fact until the player moved.",
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
        autosteer: {
          type: "boolean",
          description:
            "racing games with a racing line (config.steer): the game's line steers while you hold the keys — hold the throttle with it to drive the course; steer yourself to judge the handling",
        },
      },
    },
    async execute(args, ctx) {
      const keys = keysToPress(args);
      if (!keys.length) return { ok: false, content: 'press_keys needs keys: ["w"] (or key: "w").' };
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start });
      // The game's own racing line steers the hold when asked (a game without one answers so).
      const autosteer = args.autosteer === true;
      if (autosteer) await steerWhileHeld(ctx, true);
      try {
        await ctx.call(HostMethod.PreviewInput, {
          actions: [{ type: "hold", keys, ms: args.holdMs ?? HOLD_DEFAULT_MS }],
        });
      } finally {
        if (autosteer) await steerWhileHeld(ctx, false);
      }
      const state = await ctx.call(HostMethod.PreviewState, {});
      return JSON.stringify(state, null, 2);
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
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start });
      await ctx.call(HostMethod.PreviewInput, {
        actions: [{ type: "click", x: args.x, y: args.y, button: args.button }],
      });
      const state = await ctx.call(HostMethod.PreviewState, {});
      return JSON.stringify(state, null, 2);
    },
  },

  {
    name: "look",
    description: "Mouse-look in the game preview (dx/dy in pixels). Positive dx looks right, negative dy looks up.",
    parameters: {
      type: "object",
      properties: {
        dx: { type: "number", description: "horizontal pixels, positive = right" },
        dy: { type: "number", description: "vertical pixels, positive = down" },
      },
      required: ["dx"],
    },
    async execute(args, ctx) {
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Start });
      await ctx.call(HostMethod.PreviewInput, {
        actions: [{ type: "look", dx: args.dx ?? 0, dy: args.dy ?? 0 }],
      });
      const state = await ctx.call(HostMethod.PreviewState, {});
      return JSON.stringify(state, null, 2);
    },
  },

  {
    name: "game_state",
    description:
      "Read window.__studio.state() — score, phase, entity counts, fps, and any probes the game exposes. The structural half of judging.",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const state = await ctx.call(HostMethod.PreviewState, {});
      return JSON.stringify(state, null, 2);
    },
  },

  {
    name: "play_deterministic",
    description:
      "Run a scripted, reproducible playthrough: seed, pause, drive controls, then advance by fixed steps. Two builds with the same seed and script are directly comparable. Omit script to use a short WASD/look/jump exercise.",
    parameters: {
      type: "object",
      properties: {
        seed: { type: "number", description: "RNG seed" },
        steps: { type: "number", description: "extra 16ms-based steps after the script (default 300 ≈ 5 seconds)" },
        camera: str("camera to end on"),
        script: {
          type: "array",
          description:
            "optional controls after seed. e.g. [{type:'hold', keys:['w'], ms:2000}, {type:'look', dx:40}, {type:'tap', keys:['space']}, {type:'screenshot', camera:'close'}]",
        },
      },
      required: ["seed"],
    },
    async execute(args, ctx) {
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Seed, arg: args.seed });
      await ctx.call(HostMethod.PreviewCall, { method: PageMethod.Pause });
      const script = Array.isArray(args.script) && args.script.length ? args.script : CONTROL_EXERCISE;
      const played = await applyPlayScript(ctx, script, { clock: "step", runId: args.runId });
      const steps = args.steps ?? DEFAULT_STEPS;
      for (let done = 0; done < steps; done += STEPS_PER_CALL) {
        await ctx.call(HostMethod.PreviewCall, {
          method: PageMethod.Step,
          arg: Math.min(STEPS_PER_CALL, steps - done) * STEP_MS,
        });
      }
      if (args.camera) await ctx.call(HostMethod.PreviewCall, { method: PageMethod.DebugCamera, arg: args.camera });
      const state = await ctx.call(HostMethod.PreviewState, {});
      const images = (played.images ?? []).slice(-MAX_TURN_IMAGES);
      return {
        ok: true,
        content: JSON.stringify(state, null, 2),
        ...(images.length ? { images } : {}),
      };
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
