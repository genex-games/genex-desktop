/**
 * Play-time AI composed for one profile: the one place its parts meet, through the seams in
 * `types.ts`. One service runs every call — Play's page, Create Live's route, a native game's lines
 * and the harness's recordings all reach the same instance, its grants, queue, ledger and cards —
 * and the hosts the IPC registrars and the harness RPC call are built over it here.
 *
 * Its folder is `userData/game-ai` (`GAME_AI_DIR`), which no agent may write. `start` loads what it
 * keeps (grants, settings) and starts the plan watcher; `building` tells the queue and the watcher a
 * build holds this Mac; a payer that changes stops every grant naming it (a Genex sign-in is seen
 * here, by the account's token changing; a key or a plan account by `payerChanged`); `dispose`
 * stops the watcher and sends the fit counts that wait. Electron-free: genex.games, the engines, the
 * library and the windows come in as deps.
 */
import { createHash, randomBytes } from "node:crypto";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { MINUTE_MS } from "../../shared/duration.ts";
import { AiDoor, type AiGameKey, AiGameKind, type AiModelRef } from "../../shared/game-ai.ts";
import type { GameAiNotice } from "../../shared/game-ai-views.ts";
import type { GameProject } from "../../shared/game-project.ts";
import type { PlayAiBar } from "../../shared/play-bar.ts";
import { EngineId } from "../../shared/providers.ts";
import type { EngineModel } from "../../substrate/engines/types.ts";
import { reportCheckIpcHost } from "../ipc/game-ai-report-check.ts";
import type { GalleryRequest } from "../play/gallery.ts";
import { createGameAiConsents } from "./approvals.ts";
import { type NativeAiHost, nativeAiHost } from "./bridge-native.ts";
import { createGameAiPlayBridge } from "./bridge-play.ts";
import {
  createGameAiGrants,
  createGameAiSettings,
  type GameAiGrantsStore,
  type GameAiSettings,
  type GameCallBucket,
  GRANTS_FILE,
  SETTINGS_FILE,
} from "./budgets.ts";
import { createGameAiCache } from "./cache.ts";
import type { CreateRouteHost } from "./create-route.ts";
import { createByokDoor } from "./doors/byok.ts";
import { cachedRows, type EngineSource, usableModels } from "./doors/engine.ts";
import { createFixtureDoor } from "./doors/fixture.ts";
import { createGenexDevDoor, type GenexDevDoor } from "./doors/genex-dev.ts";
import { createLocalDoor } from "./doors/local.ts";
import { createOpenCodeDoor } from "./doors/opencode.ts";
import { createPlanDoor } from "./doors/plan.ts";
import { createTapeDoor } from "./doors/tape.ts";
import type { gameAiCallRecord } from "./events.ts";
import { createFitCounts, type GameAiFitCounts } from "./fit-counts.ts";
import { type AiDemoPlayer, createGameAiHarnessHost } from "./harness-host.ts";
import { createGameAiLedger } from "./ledger.ts";
import { type AiModelFacts, createGameAiMenu, type GameAiMenuDeps } from "./menu.ts";
import { createModelCheck, type ModelCheckDeps, type ModelCheckService } from "./model-check.ts";
import { createMomentStore, type GameAiMoments } from "./moments.ts";
import { createGenexAiCreatorReads, createGenexAiPlatform, type GenexAiCreatorReads } from "./platform.ts";
import { createGameAiQueue, type GameAiQueueOptions } from "./queue.ts";
import { createReportInbox } from "./report-inbox.ts";
import { createGameAiReports, type GameAiReportService, type ReportCapture } from "./report.ts";
import { createGameAiIpcHost, createGameAiService, type GameAiServiceImpl, menuOffers } from "./service.ts";
import { editorAiRelays, type EditorAiRelaysOptions } from "./editor-relays.ts";
import { createGameAiTapes } from "./tapes.ts";
import { createTraceSink } from "./trace-sink.ts";
import {
  GAME_AI_DIR,
  type GameAiClock,
  type GameAiConsents,
  type GameAiDeps,
  type GameAiDoorImpl,
  type GameAiHarnessHost,
  type GameAiInboxHost,
  type GameAiIpcHost,
  type GameAiLedger,
  type GameAiNativeStep,
  type GameAiPlanWatcher,
  type GameAiPlayBridge,
  type GameAiQueue,
  type GameAiTapes,
  type GenexAiPlatform,
} from "./types.ts";

/** A card ticket's random part, in bytes. */
const TICKET_BYTES = 12;

const MESSAGE = {
  notInLibrary: (project: string) => `refused: "${project}" is not a game in the library`,
} as const;

/**
 * The doors whose answers genex.games screens before it returns them (D6): the call says who sees
 * its answer, and a shared answer that is withheld, unscreened or undeclared never comes back.
 */
const SCREENED_DOORS: ReadonlySet<AiDoor> = new Set([AiDoor.GenexDev, AiDoor.GenexCredits]);

/**
 * Whether text other players will see may be broadcast (D6): only when a door genex.games screens
 * answered it. Routing already sends a shared call nowhere else; this holds should that ever move.
 */
export const screenedByStand = async (_text: string, door: AiDoor): Promise<boolean> => SCREENED_DOORS.has(door);

/** The door whose grants a payer's change stops, by the engine that changed account or key. */
const PAYER_DOORS: Readonly<Record<string, AiDoor>> = {
  [EngineId.OpenRouter]: AiDoor.Byok,
  [EngineId.ClaudeCode]: AiDoor.Plan,
  [EngineId.OpenCode]: AiDoor.OpenCode,
};

/** The door whose grants stop when `engine`'s account or key changes; null for an engine no game is paid through. */
export const payerDoorOf = (engine: string): AiDoor | null =>
  Object.hasOwn(PAYER_DOORS, engine) ? (PAYER_DOORS[engine] ?? null) : null;

/** A library game as play-time AI needs it. */
export type AiLibraryGame = Pick<GameProject, "name" | "dir" | "title">;

/** What play-time AI is composed from. */
export interface GameAiHostDeps {
  /** The profile's own data folder: play-time AI keeps `game-ai` in it. */
  userData: string;
  clock?: GameAiClock;
  /** Studio's engines by id (null for one this profile does not have). */
  engines: EngineSource;
  /** The budget ledger's host-only game bucket (`StudioCore.budget`). */
  calls: GameCallBucket;
  /** Record a settled call's event in the event log (`CustomEvent.GameAiCall`). */
  record(event: ReturnType<typeof gameAiCallRecord>): Promise<void>;
  /** Push `UiEvent.GameAi`. */
  notify(notice: GameAiNotice): void;
  /** Redraw a Play game's pill (`PlayBarState.ai`). */
  drawPill(game: AiGameKey, bar: PlayAiBar): void;
  /** genex.games' API, and the Genex account's token while one is signed in. */
  genex: { request: GalleryRequest; token(): Promise<string | undefined> };
  /** Open a page in the person's browser. */
  openExternal(url: string): Promise<void>;
  /** Where checkout may open: genex.games and the payment page it hands the person to. */
  checkoutOrigins: readonly string[];
  /** Throws where a native step may not run (a fixture profile). */
  assertNative(step: GameAiNativeStep): void;
  /** The library: its games, and the genex.games project each was published as. */
  library: {
    list(): Promise<readonly AiLibraryGame[]>;
    playProject(project: string): Promise<string | null>;
  };
  /** What a game's page or process holds for a Report, or null when it is gone. */
  capture(game: AiGameKey): Promise<Partial<ReportCapture> | null>;
  /** The plan watcher (§3.7), started and stopped with play-time AI. */
  watcher: GameAiPlanWatcher;
  /** Where the harness's replays and recordings play a demo (`StudioCore.playAiDemo`). */
  demos: AiDemoPlayer;
  /** The queue's waits (tests hold them short). */
  queue?: GameAiQueueOptions;
  /**
   * The engine editors to relay play-time AI for (`editor-relays.ts`): the library's linked Godot
   * and Unity projects, and the games a run is going in. Absent: no editor is relayed.
   */
  editors?: Pick<EditorAiRelaysOptions, "targets" | "runningGames" | "log">;
}

/** Play-time AI for one profile. */
export interface GameAiHost {
  service: GameAiServiceImpl;
  /** What `ipc/game-ai.ts` delegates to. */
  ipc: GameAiIpcHost;
  /** What `ipc/game-ai-inbox.ts` delegates to. */
  inbox: GameAiInboxHost;
  /** Play's page bridge (`play/viewer-view.ts`). */
  play: GameAiPlayBridge;
  /** The Create Live route's host (`preview.ts`). */
  createRoute: CreateRouteHost;
  /** The harness RPC's host (`harness-rpc/ai.ts`). */
  harness: GameAiHarnessHost;
  /** A native player's AI host for a game of the library (`core/game-bridge-target.ts`). */
  native(game: { name: string; title: string }, replaying: boolean): NativeAiHost;
  /** Load what play-time AI keeps and start the plan watcher. */
  start(): Promise<void>;
  /** A build started or ended on this Mac: the local doors and the watcher wait for it. */
  building(on: boolean): void;
  /** A payer changed (a key, a plan account): every grant naming the door stops. */
  payerChanged(door: AiDoor): Promise<void>;
  /** Settings' share of each plan kept for building (the plan watcher rests before it). */
  keepForBuildingPercent(): number;
  /** Stop the watcher and send what waits; nothing runs after it. */
  dispose(): Promise<void>;
}

/** Whether a library entry's folder is a real folder: not a link, not a file, not gone. */
async function realFolder(dir: string): Promise<string | null> {
  const link = await lstat(dir).catch(() => null);
  if (!link || link.isSymbolicLink() || !link.isDirectory()) return null;
  const real = await realpath(dir).catch(() => null);
  return real !== null && (await stat(real).catch(() => null))?.isDirectory() === true ? real : null;
}

/** The library name a game key names, for a game of the library; null for a published game's. */
export const libraryName = (game: AiGameKey): string | null =>
  game.startsWith(`${AiGameKind.Create}:`) ? game.slice(AiGameKind.Create.length + 1) : null;

/** The genex.games project id a game key names, for a published game; null for a library game's. */
export const publishedId = (game: AiGameKey): string | null =>
  game.startsWith(`${AiGameKind.Play}:`) ? game.slice(AiGameKind.Play.length + 1) : null;

/** How long a library game's link to its published self is kept before it is read again. */
const PUBLISHED_LINK_TTL_MS = MINUTE_MS;

/** A library game's published project id, read at most every {@link PUBLISHED_LINK_TTL_MS} per game. */
function publishedLinks(read: (project: string) => Promise<string | null>, now: () => number) {
  const kept = new Map<string, { at: number; id: string | null }>();
  return async (project: string): Promise<string | null> => {
    const known = kept.get(project);
    if (known && now() - known.at < PUBLISHED_LINK_TTL_MS && now() >= known.at) return known.id;
    const id = await read(project).catch(() => null);
    kept.set(project, { at: now(), id });
    return id;
  };
}

/** A model's names as the chat's catalog gives them: the engines' own rows, genex.games' for credits. */
function modelCatalog(engines: EngineSource, devLabel: (model: string) => string | null, now: () => number) {
  const rowsOf = new Map<string, () => Promise<EngineModel[]>>();
  const known = new Map<string, AiModelFacts>();
  const keyOf = (model: AiModelRef): string => `${model.door} ${model.engine} ${model.model}`;
  const engineRows = (id: string): Promise<EngineModel[]> => {
    let read = rowsOf.get(id);
    if (!read) {
      read = cachedRows(now, async () => {
        const engine = engines(id);
        return engine ? usableModels(engine) : [];
      });
      rowsOf.set(id, read);
    }
    return read();
  };
  const facts = async (model: AiModelRef): Promise<AiModelFacts | null> => {
    const fromGenex = model.door === AiDoor.GenexDev || model.door === AiDoor.GenexCredits;
    const row = fromGenex ? null : (await engineRows(model.engine)).find((entry) => entry.id === model.model);
    const label = fromGenex ? devLabel(model.model) : row?.label || null;
    if (!label) return null;
    const read = { label, shortLabel: label, free: row?.free === true };
    known.set(keyOf(model), read);
    return read;
  };
  return {
    facts,
    /** A model's name now, as last read; its id when it was never read. */
    labelNow: (model: AiModelRef): string => known.get(keyOf(model))?.label ?? devLabel(model.model) ?? model.model,
    /** Read the names of every model these doors offer now. */
    async warm(doors: Iterable<GameAiDoorImpl>): Promise<void> {
      const lists = await Promise.all([...doors].map((door) => door.models().catch(() => [] as AiModelRef[])));
      await Promise.all(lists.flat().map((model) => facts(model).catch(() => null)));
    },
  };
}

/**
 * The Genex account's token as play-time AI reads it. A sign-in that changes (out, or in as anyone)
 * is a payer change for the credits doors: the read that sees it waits for the stop, so nothing it
 * goes on to do spends a grant agreed under the other account.
 */
function accountWatch(read: () => Promise<string | undefined>) {
  let print: string | null | undefined;
  let stop: (() => Promise<void>) | null = null;
  return {
    async token(): Promise<string | undefined> {
      const current = await read().catch(() => undefined);
      const next = current ? createHash("sha256").update(current).digest("hex") : null;
      const changed = print !== undefined && print !== null && print !== next;
      print = next;
      if (changed) await stop?.().catch(() => undefined);
      return current;
    },
    /** What a change stops. */
    onChange(run: () => Promise<void>): void {
      stop = run;
    },
  };
}

/** The library as play-time AI reads it: a game's real folder, its title, and any game's title. */
function libraryReads(deps: GameAiHostDeps, publishedTitle: (projectId: string) => Promise<string | null>) {
  const titleIn = async (project: string): Promise<string | null> =>
    (await deps.library.list()).find((listed) => listed.name === project)?.title || null;
  return {
    /** A library game's folder, resolved through the library by real path; throws for any other name. */
    async folder(project: string): Promise<string> {
      const game = (await deps.library.list()).find((listed) => listed.name === project);
      const real = game ? await realFolder(game.dir) : null;
      if (!real) throw new Error(MESSAGE.notInLibrary(project));
      return real;
    },
    title: titleIn,
    /** A game's name: the library's for the creator's own, genex.games' listing for a published one. */
    async titleOf(game: AiGameKey): Promise<string> {
      const own = libraryName(game);
      const title = own !== null ? await titleIn(own) : await publishedTitle(publishedId(game) ?? "");
      return title ?? own ?? game;
    },
  };
}

/** The doors over this Mac's engines and genex.games' development lane. */
function doorsOf(
  deps: GameAiHostDeps,
  now: () => number,
  settings: GameAiSettings,
  genex: { token(): Promise<string | undefined>; playProject(project: string): Promise<string | null> },
) {
  const local = createLocalDoor({ engines: deps.engines, now });
  const dev = createGenexDevDoor({
    request: deps.genex.request,
    token: () => genex.token(),
    now,
    // Only the creator's own game reaches the development lane: its project from the library's link.
    projectOf: async (game) => {
      const own = libraryName(game);
      return own === null ? null : genex.playProject(own);
    },
  });
  const plan = createPlanDoor({
    engines: deps.engines,
    now,
    allowed: () => settings.local().allowPlan,
    keepForBuildingPercent: () => settings.local().keepForBuildingPercent,
  });
  const doors = new Map<AiDoor, GameAiDoorImpl>([
    [AiDoor.Local, local],
    [AiDoor.OpenCode, createOpenCodeDoor({ engines: deps.engines, now })],
    [AiDoor.Byok, createByokDoor({ engines: deps.engines, now })],
    [AiDoor.Plan, plan],
    [AiDoor.GenexDev, dev],
    [AiDoor.Tape, createTapeDoor()],
    [AiDoor.Fixture, createFixtureDoor()],
  ]);
  return { doors, local, dev };
}

/** What play-time AI keeps: Settings, the grants, the ledger, the tapes, and the queue in front of the doors. */
function storesOf(deps: GameAiHostDeps, clock: GameAiClock, dir: string, platform: GenexAiPlatform) {
  const settings = createGameAiSettings({ file: path.join(dir, SETTINGS_FILE), platform });
  const grants = createGameAiGrants({
    file: path.join(dir, GRANTS_FILE),
    clock,
    calls: deps.calls,
    limits: () => settings.limits(),
  });
  const ledger = createGameAiLedger({ dir, clock, record: (event) => deps.record(event) });
  return { settings, grants, ledger, tapes: createGameAiTapes(), queue: createGameAiQueue(deps.queue) };
}

/** What goes to genex.games of a session: a Report (D9) and, with consent, fit-from-play counts (D12). */
function sharingOf(
  deps: GameAiHostDeps,
  parts: {
    clock: GameAiClock;
    dir: string;
    settings: GameAiSettings;
    platform: GenexAiPlatform;
    check: Pick<ModelCheckService, "rowFor">;
  },
) {
  const { clock, dir, settings, platform, check } = parts;
  const reports = createGameAiReports({
    clock,
    capture: (game) => deps.capture(game),
    checkRow: (game, model) => check.rowFor(game, model),
    send: (bundle) => platform.sendReport(bundle),
  });
  const fitCounts = createFitCounts({
    clock,
    dir,
    consent: async () => settings.local().shareFitCounts,
    send: (rows) => platform.sendFitCounts(rows),
  });
  return { reports, fitCounts };
}

/** What the model check reads of the models' names and of genex.games' price for players. */
function catalogReads(
  catalog: ReturnType<typeof modelCatalog>,
  dev: Pick<GenexDevDoor, "priceMicros">,
): Pick<ModelCheckDeps, "label" | "playerCostMicros"> {
  return {
    label: (model) => catalog.labelNow(model),
    playerCostMicros: (model, usage) => dev.priceMicros(model.model, usage),
  };
}

/** What the model check reads of a published library game as its creator: their share and its audience. */
function publishedReads(
  playProject: (project: string) => Promise<string | null>,
  creator: GenexAiCreatorReads,
): Pick<ModelCheckDeps, "creatorShareBps" | "audience"> {
  return {
    creatorShareBps: async (project) => creatorShare(project, playProject, creator),
    audience: async (project) => {
      const published = await playProject(project);
      return published ? creator.audience(published) : null;
    },
  };
}

/** The genex.games project a game is: a Play game's own, a library game's published one. */
const gameProjectOf =
  (playProject: (project: string) => Promise<string | null>) =>
  async (game: AiGameKey): Promise<string | null> => {
    const own = libraryName(game);
    return own === null ? publishedId(game) : playProject(own);
  };

/** A game played in Godot's or Unity's own editor is answered through that editor's channel (D1 holds). */
function editorRelaysOf(deps: GameAiHostDeps, service: GameAiServiceImpl, settings: GameAiSettings) {
  if (!deps.editors) return null;
  return editorAiRelays({
    service,
    ...deps.editors,
    createRouteEnabled: () => settings.local().createRouteEnabled,
  });
}

/** Play-time AI for one profile over `deps`; `start` before the first call. */
export function createGameAi(deps: GameAiHostDeps): GameAiHost {
  const clock: GameAiClock = deps.clock ?? { now: () => Date.now() };
  const dir = path.join(deps.userData, GAME_AI_DIR);
  const now = () => clock.now();
  const account = accountWatch(() => deps.genex.token());
  const token = () => account.token();
  const playProject = publishedLinks((project) => deps.library.playProject(project), now);
  const platform = createGenexAiPlatform({ request: deps.genex.request, token, openExternal: deps.openExternal });
  const creator = createGenexAiCreatorReads({ request: deps.genex.request, token });
  const library = libraryReads(deps, (id) => creator.publishedTitle(id));
  const { settings, grants, ledger, tapes, queue } = storesOf(deps, clock, dir, platform);
  const { doors, local, dev } = doorsOf(deps, now, settings, { token, playProject });
  const catalog = modelCatalog(deps.engines, (model) => dev.labelOf(model), now);
  const moments = createMomentStore({ dir, clock });
  const checkDeps: ModelCheckDeps = {
    clock,
    dir,
    doors,
    moments,
    queue,
    allowPlan: async () => settings.local().allowPlan,
    ...catalogReads(catalog, dev),
    ...publishedReads(playProject, creator),
  };
  const check = createModelCheck(checkDeps);
  const { reports, fitCounts } = sharingOf(deps, { clock, dir, settings, platform, check });
  const parts: ServiceParts = { clock, settings, grants, ledger, tapes, queue, doors, platform, moments, reports };
  const { service, consents } = serviceOf(deps, parts, {
    titleOf: library.titleOf,
    facts: (model) => catalog.facts(model),
    fitCounts,
    check: (game) => ownCheck(check, game),
    projectIdOf: gameProjectOf(playProject),
  });
  account.onChange(() => service.payerChanged(AiDoor.GenexDev));
  const editors = editorRelaysOf(deps, service, settings);

  const ipc = ipcOf(deps, { ...parts, service, check, library, warmNames: () => catalog.warm(doors.values()) });
  let built: boolean | null = null;
  return {
    service,
    ipc,
    inbox: createReportInbox({
      game: async (project) => ({ root: await library.folder(project), playProject: await playProject(project) }),
      source: creator.inbox,
    }),
    play: createGameAiPlayBridge({
      service,
      platform,
      consents,
      clock,
      assertNative: deps.assertNative,
      newTicket: () => `t_${randomBytes(TICKET_BYTES).toString("base64url")}`,
    }),
    createRoute: {
      clock,
      settings,
      service,
      game: async (project) => ({ title: (await library.title(project)) ?? project, ownGame: true }),
    },
    harness: createGameAiHarnessHost({
      clock,
      folderOf: async (project, root) => root ?? library.folder(project),
      tapes,
      player: deps.demos,
      local,
      queue,
      moments,
      checkOn: (checkDoors) => createModelCheck({ ...checkDeps, doors: checkDoors }),
      creatorCheck: check,
    }),
    native: (game, replaying) => nativeAiHost(service, game, { replaying }),
    async start() {
      await Promise.all([settings.load(), grants.load()]);
      // The account Studio starts signed in as is the payer every credits grant was agreed under.
      await token();
      await deps.watcher.start();
      editors?.start();
    },
    building(on) {
      if (built === on) return;
      built = on;
      queue.building(on);
      deps.watcher.building(on);
    },
    payerChanged: (door) => service.payerChanged(door),
    keepForBuildingPercent: () => settings.local().keepForBuildingPercent,
    async dispose() {
      await editors?.stop();
      await deps.watcher.stop();
      await fitCounts.flush(true).catch(() => undefined);
    },
  };
}

/** The stores and parts the service runs over. */
interface ServiceParts {
  clock: GameAiClock;
  settings: GameAiSettings;
  grants: GameAiGrantsStore;
  ledger: GameAiLedger;
  tapes: GameAiTapes;
  queue: GameAiQueue;
  doors: ReadonlyMap<AiDoor, GameAiDoorImpl>;
  platform: GenexAiPlatform;
  moments: GameAiMoments;
  reports: GameAiReportService;
}

/** The service, its cards and its menu over `parts`. */
function serviceOf(
  deps: GameAiHostDeps,
  parts: ServiceParts,
  reads: Pick<GameAiMenuDeps, "titleOf" | "facts" | "check"> &
    Pick<GameAiDeps, "projectIdOf"> & { fitCounts: GameAiFitCounts },
): { service: GameAiServiceImpl; consents: GameAiConsents } {
  const { clock, grants, platform } = parts;
  let service: GameAiServiceImpl | null = null;
  const consents = createGameAiConsents({
    clock,
    notify: deps.notify,
    assertNative: deps.assertNative,
    usable: async (game, model) => {
      const menu = await service?.menuOf(game).catch(() => null);
      return menu ? menuOffers(menu, model) !== null : false;
    },
  });
  const menu = createGameAiMenu({
    clock,
    doors: parts.doors,
    grants,
    ledger: parts.ledger,
    titleOf: reads.titleOf,
    facts: reads.facts,
    balanceCredits: () => platform.balanceCredits(),
    check: reads.check,
    sessionStartedAt: clock.now(),
  });
  service = createGameAiService({
    clock,
    grants,
    queue: parts.queue,
    doors: parts.doors,
    ledger: parts.ledger,
    cache: createGameAiCache({ clock }),
    tapes: parts.tapes,
    platform,
    watcher: deps.watcher,
    consents,
    settings: parts.settings,
    assertNative: deps.assertNative,
    notify: deps.notify,
    drawPill: deps.drawPill,
    menu,
    moderate: screenedByStand,
    traces: createTraceSink({ reports: parts.reports, moments: parts.moments, fitCounts: reads.fitCounts }),
    projectIdOf: reads.projectIdOf,
  });
  return { service, consents };
}

/** The model check of the creator's own game, as the menu reads it; null for a published game's. */
async function ownCheck(check: Pick<ModelCheckService, "state">, game: AiGameKey) {
  const own = libraryName(game);
  if (own === null) return null;
  const result = await check.state(own);
  return { rows: result.rows, recommended: result.recommended };
}

/** The creator's share of a library game's AI spend, once it is published; null before. */
async function creatorShare(
  project: string,
  playProject: (project: string) => Promise<string | null>,
  creator: Pick<GenexAiCreatorReads, "creatorShareBps">,
): Promise<number | null> {
  const published = await playProject(project);
  return published ? creator.creatorShareBps(published) : null;
}

/**
 * The IPC host: the service's own, with Reports and the check behind the library's word on a game,
 * and the check's model names read before it runs, as the chat's menu names them.
 */
function ipcOf(
  deps: GameAiHostDeps,
  parts: ServiceParts & {
    service: GameAiServiceImpl;
    check: ModelCheckService;
    library: ReturnType<typeof libraryReads>;
    warmNames(): Promise<void>;
  },
): GameAiIpcHost {
  const { service, check, reports, library } = parts;
  const base = createGameAiIpcHost({
    service,
    grants: parts.grants,
    settings: parts.settings,
    tapes: parts.tapes,
    ledger: parts.ledger,
    platform: parts.platform,
    reports,
    check,
    projectFolder: library.folder,
    titleOf: library.titleOf,
    openExternal: deps.openExternal,
    checkoutOrigins: deps.checkoutOrigins,
  });
  const checked = reportCheckIpcHost({ games: () => deps.library.list(), check, reports });
  return {
    ...base,
    ...checked,
    check: async (project) => {
      await parts.warmNames();
      return checked.check(project);
    },
  };
}
