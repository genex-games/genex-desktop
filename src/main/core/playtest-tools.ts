/**
 * The playtester's shorthands: press keys, look, click, wait, read the page's clock, save a
 * screenshot. They sit beside the computer tool on the same pooled window of the build under test;
 * each one acts, leaves a frame on the agent's screen and answers with Genex's own record of the
 * page (frames, rate, whether it runs). The game is never asked about itself.
 */
import { writeFile } from "node:fs/promises";
import { type ScreenAct, ScreenDeed } from "../../shared/agent-screen.ts";
import type { DelegateRequest, LiveToolResult } from "../../substrate/engines/types.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import { DEFAULT_SHOT_QUALITY } from "./capture.ts";

type LiveTool = NonNullable<DelegateRequest["liveTools"]>[number];

/** The playtester's tool names. The model calls them by these names: never rename one. */
export const PlaytestTool = {
  PressKeys: "press_keys",
  Look: "look",
  Click: "click",
  Screenshot: "screenshot",
  GameState: "game_state",
  Wait: "wait",
} as const;
export type PlaytestTool = (typeof PlaytestTool)[keyof typeof PlaytestTool];

/** The clamps on a playtester's input; the tool descriptions quote the same numbers. */
export const PLAYTEST_LIMITS = {
  defaultHoldMs: 400,
  minHoldMs: 16,
  maxHoldMs: 8_000,
  maxWaitMs: 5_000,
  maxKeys: 8,
  stateChars: 1_500,
} as const;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });

/** The shorthands as the model is given them. */
export const PLAYTEST_TOOLS: readonly LiveTool[] = [
  {
    name: PlaytestTool.PressKeys,
    description: `Press keys in the game the way a player would (w,a,s,d,space,shift,arrows…). Hold with holdMs (default ${PLAYTEST_LIMITS.defaultHoldMs}). Screenshot to see what happened.`,
    parameters: {
      type: "object",
      properties: {
        keys: str('comma-separated keys, e.g. "w" or "w,shift"'),
        holdMs: num(
          `how long to hold in ms, default ${PLAYTEST_LIMITS.defaultHoldMs}, max ${PLAYTEST_LIMITS.maxHoldMs}`,
        ),
      },
      required: ["keys"],
    },
  },
  {
    name: PlaytestTool.Look,
    description: "Mouse-look: dx pixels (positive = right), dy pixels (positive = down).",
    parameters: {
      type: "object",
      properties: { dx: num("horizontal pixels"), dy: num("vertical pixels") },
      required: ["dx"],
    },
  },
  {
    name: PlaytestTool.Click,
    description: "Click in the game view. x,y as 0–1 fractions of the view (omit for centre).",
    parameters: { type: "object", properties: { x: num("0–1 fraction"), y: num("0–1 fraction") } },
  },
  {
    name: PlaytestTool.Screenshot,
    description: "Save a screenshot of what you see right now to a file and return its path.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: PlaytestTool.GameState,
    description: "Genex's own record of the page: its frame count, frame rate and whether it is running.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: PlaytestTool.Wait,
    description: `Let the game run for a moment (ms, max ${PLAYTEST_LIMITS.maxWaitMs}), then report the state.`,
    parameters: {
      type: "object",
      properties: { ms: num(`milliseconds, max ${PLAYTEST_LIMITS.maxWaitMs}`) },
      required: ["ms"],
    },
  },
];

/** What a shorthand needs besides the window: a frame on the agent's screen, and a file for a screenshot. */
export interface PlaytestContext {
  frame(port: PreviewPort, jpeg: Buffer | null, caption: string, act: ScreenAct): Promise<void>;
  /** A fresh file for a screenshot of the current view (`camera` stays null). */
  shotFile(camera: string | null): Promise<string>;
  sleep(ms: number): Promise<void>;
}

type PlaytestHandler = (live: PreviewPort, args: Record<string, unknown>, ctx: PlaytestContext) => Promise<string>;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

async function stateText(port: PreviewPort): Promise<string> {
  const state = await port.studioState().catch(() => null);
  return `state: ${JSON.stringify(state ?? { __missing: true }).slice(0, PLAYTEST_LIMITS.stateChars)}`;
}

function keysOf(raw: unknown): string[] {
  return String(raw ?? "")
    .split(/[,\s]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, PLAYTEST_LIMITS.maxKeys);
}

const HANDLERS: Record<PlaytestTool, PlaytestHandler> = {
  [PlaytestTool.PressKeys]: async (live, args, ctx) => {
    const keys = keysOf(args.keys);
    if (!keys.length) return 'press_keys needs keys, e.g. "w"';
    const holdMs = Number(args.holdMs) || PLAYTEST_LIMITS.defaultHoldMs;
    await live.input([{ type: "hold", keys, ms: clamp(holdMs, PLAYTEST_LIMITS.minHoldMs, PLAYTEST_LIMITS.maxHoldMs) }]);
    await ctx.frame(live, null, `press ${keys.join("+")}`, { deed: ScreenDeed.Press, keys });
    return stateText(live);
  },
  [PlaytestTool.Look]: async (live, args, ctx) => {
    await live.input([{ type: "look", dx: Number(args.dx) || 0, dy: Number(args.dy) || 0 }]);
    await ctx.frame(live, null, "look", { deed: ScreenDeed.Look });
    return stateText(live);
  },
  [PlaytestTool.Click]: async (live, args, ctx) => {
    await live.input([
      {
        type: "click",
        ...(args.x !== undefined ? { x: Number(args.x) } : {}),
        ...(args.y !== undefined ? { y: Number(args.y) } : {}),
      },
    ]);
    await ctx.frame(live, null, "click", { deed: ScreenDeed.Click });
    return stateText(live);
  },
  [PlaytestTool.Wait]: async (live, args, ctx) => {
    await ctx.sleep(clamp(Number(args.ms) || 0, 0, PLAYTEST_LIMITS.maxWaitMs));
    return stateText(live);
  },
  [PlaytestTool.GameState]: async (live) => stateText(live),
  [PlaytestTool.Screenshot]: async (live, _args, ctx) => {
    const jpeg = live.screenshotWithStats
      ? (await live.screenshotWithStats(DEFAULT_SHOT_QUALITY)).jpeg
      : await live.screenshot(DEFAULT_SHOT_QUALITY);
    const file = await ctx.shotFile(null);
    await writeFile(file, jpeg);
    await ctx.frame(live, jpeg, "screenshot", { deed: ScreenDeed.Look });
    return `saved ${file}`;
  },
};

function isPlaytestTool(name: string): name is PlaytestTool {
  return Object.hasOwn(HANDLERS, name);
}

/** Run one shorthand on the loaded window; a name that is not one of them is answered as unknown. */
export async function runPlaytestTool(
  name: string,
  args: Record<string, unknown>,
  live: PreviewPort,
  ctx: PlaytestContext,
): Promise<LiveToolResult> {
  if (!isPlaytestTool(name)) return `unknown tool ${name}`;
  return HANDLERS[name](live, args, ctx);
}
