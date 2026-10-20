/**
 * Play-time AI as the app composes it for one launch's core (`game-ai/host.ts`): the core's engines,
 * budget, event log, library and windows; genex.games over the network (a fixture launch's own
 * answers in a fixture profile) with the Genex account Studio is signed in as; the browser for
 * checkout and sign-ins (never in a fixture launch); the plan watcher, whose every job is boxed by
 * the same deny list as the agents; and a Report's capture from Play's game or Create's Live page.
 */
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserWindow } from "electron";
import { shell } from "electron";
import { type AiGameKey, isPlainRecord } from "../shared/game-ai.ts";
import { AiWatcherRunner } from "../shared/game-ai-watcher.ts";
import { GameAiNoticeKind } from "../shared/game-ai-views.ts";
import { GENEX_PLUGIN_ID, GenexAction, GenexPublishStatusOperation } from "../shared/genex.ts";
import type { PlayOrigins } from "../shared/play.ts";
import { EngineId } from "../shared/providers.ts";
import { UiEvent } from "../shared/ui-events.ts";
import { memoryKeyStore } from "../substrate/provider-keys.ts";
import type { GenexAccount } from "./core/genex-account.ts";
import { assertNativeActionAllowed } from "./dev/native-policy.ts";
import { openGenexPage } from "./genex-browser.ts";
import { type EditorAiChannels, editorAiTargets } from "./game-ai/editor-targets.ts";
import { createGameAi, type GameAiHost, libraryName, publishedId } from "./game-ai/host.ts";
import { godotAiChannel } from "../plugins/godot/editor-bridge.ts";
import { unityAiChannel } from "../plugins/unity/ai-relay.ts";
import { STRIPE_CHECKOUT_ORIGIN } from "./game-ai/platform.ts";
import { createPlanWatcher, type PlanWatcher } from "./game-ai/player-watcher.ts";
import { planWatcherDeps } from "./game-ai/player-watcher-host.ts";
import type { ReportCapture } from "./game-ai/report.ts";
import type { GalleryRequest } from "./play/gallery.ts";
import { playAiCapture } from "./play/viewer-view.ts";
import type { PlayViewer } from "./play/viewer.ts";
import type { StudioCore } from "./studio-core.ts";
import type { GameAiNativeStep } from "./game-ai/types.ts";

/** The editors main reaches with play-time AI: Godot's bridge folder and Unity's Pipeline server. */
const EDITOR_CHANNELS: EditorAiChannels = {
  godot: (dir) => godotAiChannel(dir, { now: Date.now, sleep: (ms, signal) => sleep(ms, undefined, { signal }) }),
  unity: (dir) => unityAiChannel(dir),
};

/** A genex.games project id as the publish record keeps it. */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** The channel the browser's opening is classified under (`native-policy.ts`). */
const OPEN_URL_CHANNEL = "studio:open-url";

/** The engine whose plan usage each watcher runner reads. */
const USAGE_ENGINE = {
  [AiWatcherRunner.Claude]: EngineId.ClaudeCode,
  [AiWatcherRunner.Codex]: EngineId.Codex,
} as const satisfies Record<AiWatcherRunner, string>;

/** What the app hands play-time AI for one launch. */
export interface GameAiAppDeps {
  studio: StudioCore;
  /** This launch's core data folder. */
  userData: string;
  /** A fixture launch: no network, no browser, no secret store, and native steps refused. */
  fixture: boolean;
  origins: PlayOrigins;
  version: string;
  /** genex.games' API for this launch (a fixture launch's own answers in a fixture profile). */
  request: GalleryRequest;
  account(): GenexAccount;
  pushUiEvent(event: UiEvent): void;
  log(line: string): void;
  playView(): PlayViewer | null;
  window(): BrowserWindow | null;
}

/** The genex.games project a library game was published as, from the Genex plugin's record; null when never published. */
async function publishedProject(studio: StudioCore, project: string): Promise<string | null> {
  const binding = await studio.pluginBinding(project).catch(() => undefined);
  if (!binding) return null;
  const args = { operation: GenexPublishStatusOperation.Status };
  const record: unknown = await studio.plugins
    .action(GENEX_PLUGIN_ID, GenexAction.PublishStatus, args, binding)
    .catch(() => null);
  const id = isPlainRecord(record) ? record.projectId : null;
  return typeof id === "string" && PROJECT_ID_RE.test(id) ? id : null;
}

/** What a Report captures of a game: Play's game on screen, or Create's Live page of a library game. */
async function captureOf(deps: GameAiAppDeps, game: AiGameKey): Promise<Partial<ReportCapture> | null> {
  const own = libraryName(game);
  if (own !== null) return deps.studio.liveAiCapture(own);
  const projectId = publishedId(game);
  const shown = await deps.playView()?.aiGame();
  const win = deps.window();
  if (!shown || shown.projectId !== projectId || !win) return null;
  return playAiCapture(win);
}

/** Open a page in the browser: never in a fixture launch, where the step is refused. */
async function openOutside(fixture: boolean, url: string): Promise<void> {
  assertNativeActionAllowed(fixture, OPEN_URL_CHANNEL);
  await shell.openExternal(url);
}

/** Play-time AI as the app holds it: the host, and its plan watcher for Settings' channels. */
export type AppGameAi = GameAiHost & { watcher: PlanWatcher };

/** Play-time AI for `deps.studio`; the caller starts it once the core has started. */
export function composeGameAi(deps: GameAiAppDeps): AppGameAi {
  const { studio } = deps;
  let host: GameAiHost | null = null;
  const watcher = createPlanWatcher(
    planWatcherDeps({
      origins: deps.origins,
      version: deps.version,
      userData: deps.userData,
      secretsDir: studio.layout.secrets,
      protectedPaths: studio.deniedPaths(),
      ...(deps.fixture ? { credential: memoryKeyStore(null) } : {}),
      planUsage: async (runner) => {
        const id = USAGE_ENGINE[runner];
        const engine = studio.engines.has(id) ? studio.engines.get(id) : null;
        return (await engine?.readUsage?.().catch(() => null)) ?? null;
      },
      keepForBuildingPercent: async () => host?.keepForBuildingPercent() ?? 0,
      openSignIn: (url) => openGenexPage(deps.fixture, url, deps.origins.web),
      notify: () => deps.pushUiEvent({ type: UiEvent.GameAi, payload: { kind: GameAiNoticeKind.Changed, game: null } }),
      log: (line) => deps.log(line),
    }),
  );
  host = createGameAi({
    userData: deps.userData,
    engines: (id) => (studio.engines.has(id) ? studio.engines.get(id) : null),
    calls: {
      admitGame: (game, cap) => studio.budget.admitGame(game, cap),
      recordGame: (game, tokens) => studio.budget.recordGame(game, tokens),
    },
    record: async (event) => {
      await studio.append([event]);
    },
    notify: (notice) => deps.pushUiEvent({ type: UiEvent.GameAi, payload: notice }),
    drawPill: (_game, bar) => deps.playView()?.aiBar(bar),
    genex: { request: deps.request, token: () => deps.account().token() },
    openExternal: (url) => openOutside(deps.fixture, url),
    checkoutOrigins: [deps.origins.web, STRIPE_CHECKOUT_ORIGIN],
    assertNative: (step: GameAiNativeStep) => assertNativeActionAllowed(deps.fixture, step),
    library: {
      list: () => studio.games.list(),
      playProject: (project) => publishedProject(studio, project),
    },
    capture: (game) => captureOf(deps, game),
    watcher,
    demos: { play: (run) => studio.playAiDemo(run) },
    editors: {
      targets: async () => editorAiTargets(await studio.games.list(), EDITOR_CHANNELS),
      runningGames: async () =>
        new Set(((await studio.pluginServices.runningGames?.()) ?? []).map((game) => game.project)),
      log: (line) => deps.log(line),
    },
  });
  return { ...host, watcher };
}
