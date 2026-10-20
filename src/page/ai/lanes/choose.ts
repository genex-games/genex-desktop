/**
 * Which lane a page starts on, from where it runs:
 *  - In Genex Desktop's Play (`window.__genexDesktop` with its `ai` bridge): main's lane, which
 *    moves to genex.games' lane when the game's grant is answered there.
 *  - Published on genex.games (`window.__GENEX__`, which the games host injects): genex.games' lane.
 *  - In Studio's preview: the lane Studio hinted on the shim tag (`data-genex-ai`); with no hint,
 *    main's Create route when it answers that AI is on, else off.
 * Main enforces its own context whatever lane a page picks, so a page that lies gains nothing.
 */
import { AiLane, readAiLaneHint } from "../../../shared/game-ai-lane.ts";
import type { LaneSource } from "../runtime.ts";
import type { PlatformOptions } from "../types.ts";
import { desktopAiOf, desktopTransport, hostLane, routeIsOn, routeTransport } from "./host.ts";
import type { Lane } from "./lane.ts";
import { embedSdkOf, platformLane } from "./platform.ts";
import { edgeLane, type FetchLike, offLane, replayLane } from "./replay.ts";

/** What the page offers the chooser; a test hands it fakes. */
export interface PageEnv {
  /** The page's `window`. */
  scope: unknown;
  fetch: FetchLike;
  /** The shim tag's `data-genex-ai`, or null. */
  hint(): string | null;
  /** The embed SDK the page's connect module connected (`GENEX_EMBED_SDK_GLOBAL`), if any. */
  embedSdk(): unknown;
  /** A per-page prefix for idempotency keys. */
  session(): string;
}

/** The global the games host injects into a game it serves. */
const GENEX_SERVED_GLOBAL = "__GENEX__";

const MESSAGE = { noSdk: "genex-ai: no connected @genex-ai/embed-sdk on this page" } as const;

/** Whether genex.games serves this page. */
function published(scope: unknown): boolean {
  if (typeof scope !== "object" || scope === null) return false;
  const served: unknown = Reflect.get(scope, GENEX_SERVED_GLOBAL);
  return typeof served === "object" && served !== null;
}

/** The lane Studio's hint names. */
function hintedLane(env: PageEnv, lane: AiLane, tape: string | null): Lane {
  if (lane === AiLane.Host) return hostLane(routeTransport(env.fetch));
  if (lane === AiLane.Tape || lane === AiLane.Mock) return replayLane({ lane, demo: tape, fetch: env.fetch, seed: 1 });
  if (lane === AiLane.Edge) return edgeLane();
  return offLane();
}

/** Where a page's lanes come from. */
export function laneSource(env: PageEnv, terms: PlatformOptions = {}): LaneSource {
  const desktop = desktopAiOf(env.scope);
  const onPlatform = desktop !== null || published(env.scope);
  const platform = async (): Promise<Lane> => {
    const sdk = embedSdkOf(terms.sdk ?? env.embedSdk());
    if (!sdk) throw new Error(MESSAGE.noSdk);
    return platformLane({ sdk, terms, session: env.session() });
  };
  return {
    platform: onPlatform ? platform : null,
    async first() {
      if (desktop) return hostLane(desktopTransport(desktop));
      if (onPlatform) return platform();
      const hint = readAiLaneHint(env.hint());
      if (hint) return hintedLane(env, hint.lane, hint.tape);
      const route = routeTransport(env.fetch);
      return (await routeIsOn(route)) ? hostLane(route) : offLane();
    },
  };
}
