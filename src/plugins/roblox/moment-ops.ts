/**
 * The Studio operations Genex's moments use for one game (`MomentOps`), built from the backend's
 * computer and the helper link: whether Studio is set up, linked, running and connected, the
 * helper's requests, the script sync's flush and reconcile, the viewport's picture through Studio's
 * own MCP server, and the agent's marks in the game's connection folder.
 */
import type { PluginContext, PluginEngineLink } from "../../plugin-sdk/index.d.ts";
import { PluginService } from "../../shared/plugins.ts";
import { type AgentMarks, agentBusyMarker, agentFolder, readAgentMarks } from "./agent-marks.ts";
import { type HelperAsk, HelperLinkError, HelperLinkFailure } from "./helper-link.ts";
import { type OpenAnswer, openStudio, type PlaceActionDeps } from "./place-actions.ts";
import { linkedPlace } from "./places.ts";
import type { StudioClient } from "./studio-client.ts";
import { startingNow } from "./studio-launch.ts";
import { studioRunning } from "./studio-locate.ts";
import { createStudioWatch, type MomentOps, type StudioWatch } from "./studio-moments.ts";
import { StudioTool } from "./studio-tools.ts";
import type { ReconcileOptions } from "./script-sync.ts";

/** The picture names a moment's screen captures take in Studio. */
const CAPTURE_PREFIX = "GenexMoment_";

const MESSAGE = { NotConnected: "The Genex helper in Roblox Studio isn't connected for this game." } as const;

/** The helper link and the script sync, as the moments reach them. */
export interface MomentServices {
  /** The game's helper; a request rejects when it isn't connected. */
  ask(game: string): HelperAsk;
  /** The Studio the game's helper is connected from now. */
  bound(game: string): string | undefined;
  /** Sends the game's file changes still on their way to Studio, waiting at most `timeoutMs` when given. */
  flush(game: string, timeoutMs?: number): Promise<void>;
  /** Reconciles the game's scripts with its folder (after a restore the restored files win); whether it ran to its end. */
  reapply(game: string, options?: ReconcileOptions): Promise<boolean>;
  watch: StudioWatch;
}

/** A link that serves no game: no helper connected, nothing heard. */
export function noMomentServices(now: () => number): MomentServices {
  const ask = (async () => {
    throw new HelperLinkError(HelperLinkFailure.NotBound, MESSAGE.NotConnected);
  }) as HelperAsk;
  return {
    ask: () => ask,
    bound: () => undefined,
    flush: async () => {},
    reapply: async () => false,
    watch: createStudioWatch(now),
  };
}

/** What the moments need of the backend's computer. */
export interface MomentDeps extends PlaceActionDeps {
  studio?: Pick<StudioClient, "studios" | "callTool">;
}

/** The plugin's storage and whether Genex has set Studio up, as the backend reads them. */
export interface MomentPlace {
  storage: string;
  setUp(): Promise<boolean>;
}

let captures = 0;

/** The image part of Studio's screen capture, base64, or null. */
function pictureOf(content: ReadonlyArray<{ type: string; [key: string]: unknown }>): { data: string } | null {
  const part = content.find((one) => one.type === "image" && typeof one.data === "string");
  return part ? { data: part.data as string } : null;
}

/** Studio's viewport picture through Studio's own MCP server, from the game's connected Studio. */
async function shotFrom(
  studio: MomentDeps["studio"],
  studioId: string | undefined,
  timeoutMs: number,
): Promise<{ data: string } | null> {
  if (!studio || !studioId) return null;
  const args = { studio_id: studioId, capture_id: `${CAPTURE_PREFIX}${++captures}` };
  const result = await studio.callTool(StudioTool.ScreenCapture, args, { timeoutMs });
  return result.isError ? null : pictureOf(result.content);
}

/** The operations of the game a moment's call is bound to. */
export function momentOpsFor(
  deps: MomentDeps,
  services: MomentServices,
  context: PluginContext,
  place: MomentPlace,
): MomentOps {
  const game = context.project ?? "";
  const folder = agentFolder(place.storage, game);
  const link = (): Promise<PluginEngineLink | null> =>
    context.project ? context.host(PluginService.GameEngineRead).catch(() => null) : Promise.resolve(null);
  const noMarks = async (): Promise<AgentMarks> => ({});
  return {
    now: deps.now,
    sleep: deps.sleep,
    signal: context.signal,
    mac: deps.platform === "darwin",
    game,
    folder: context.directory,
    setUp: place.setUp,
    linked: async () => (await link()) !== null,
    bound: () => services.bound(game) !== undefined,
    running: () => studioRunning(deps),
    starting: () => startingNow(place.storage, deps.now()),
    ask: services.ask(game),
    async listed(timeoutMs) {
      const bound = services.bound(game);
      if (!bound || !deps.studio) return false;
      return (await deps.studio.studios({ timeoutMs })).some((studio) => studio.id === bound);
    },
    flush: (timeoutMs) => services.flush(game, timeoutMs),
    reapply: (options) => services.reapply(game, options),
    open: (): Promise<OpenAnswer> => openStudio(deps, context),
    async placeName() {
      const linked = await link();
      if (!linked) return game;
      const directory = context.directory ? { directory: context.directory } : {};
      return (await linkedPlace(place.storage, { project: game, ...directory }, linked)).name;
    },
    shot: (timeoutMs) => shotFrom(deps.studio, services.bound(game), timeoutMs),
    marks: folder ? () => readAgentMarks(folder, deps.now()) : noMarks,
    asAgent: (work) => (folder ? agentBusyMarker(folder, deps.now).around(work) : work()),
    watch: services.watch,
  };
}
