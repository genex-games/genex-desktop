/**
 * The page Live is waiting for. Until it has loaded and settled the native view stays out of
 * sight and the stage shows a quiet loader — never the previous game, a blank navigation or a
 * first black frame. `pending` covers a load the stage started itself and is still awaiting.
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { WebBuildLoad } from "../../../shared/live-behind.ts";
import { isBuildLoadFailure, LiveLoadFailure } from "../../../shared/preview-contract.ts";
import type { GameKind } from "../../../shared/project-facts.ts";
import { webFolderOf } from "../../../shared/project-workspace.ts";
import { gameStartedSince, type StageGameKind, StageView } from "../../stage.ts";
import { blankSuspected, liveRefusedProperties, liveShownProperties } from "../../analytics/builds-stage.ts";
import { guarded, track } from "../../analytics/client.ts";
import { gameRef } from "../../analytics/game-ref.ts";
import { AnalyticsEvent } from "../../analytics/events.ts";
import { LiveOutcome, LiveTrigger } from "../../analytics/events/builds.ts";
import { oneOf } from "../../analytics/properties.ts";

/** While a page loads behind the loader the stage asks often; otherwise once a second is enough. */
const LIVE_LOADING_TICK_MS = 150;
const LIVE_TICK_MS = SECOND_MS;
/** A loaded page whose requests have been quiet this long is shown. */
const LIVE_QUIET_MS = 300;
/** A loaded page that keeps requesting is shown anyway after this long. */
const LIVE_SETTLE_MAX_MS = 3 * SECOND_MS;
/** Never keep the game hidden longer than this, whatever the page is doing. */
const LIVE_LOAD_MAX_MS = 45 * SECOND_MS;
/** How long the stage waits before asking again for a web build still being written, and how often it asks. */
const WEB_BUILD_RETRY_MS = 2 * SECOND_MS;
const WEB_BUILD_ASKS = 15;

/** A load Live is waiting on: for which game, whether the stage is still starting it, since when, and what started it. */
export type LiveLoad = { project: string; pending: boolean; since: number; trigger?: LiveTrigger };

type LivePage = Awaited<ReturnType<typeof window.studio.previewLive>>;

/**
 * Whether this game waits for the person's Play: Live holds another game's page, or none, and no load
 * of this one is under way. Opening a game never starts it, so a game Live does not hold shows Play.
 */
export function waitsForPlay(at: { project: string | null; holds: boolean; liveLoad: LiveLoad | null }): boolean {
  return Boolean(at.project) && !at.holds && at.liveLoad?.project !== at.project;
}

/** The load a game Live holds starts with: its page is waited for until it settles. A game it does not hold waits for Play. */
const loadOnOpen = (project: string | null, holds: boolean, trigger: LiveTrigger): LiveLoad | null =>
  project && holds ? { project, pending: false, since: Date.now(), trigger } : null;

/** The load waited on once Live takes this game (`holds`) or lets it go: then only one still under way. */
function loadOnHolds(current: LiveLoad | null, project: string | null, holds: boolean): LiveLoad | null {
  if (holds) return current ?? loadOnOpen(project, holds, LiveTrigger.MainLoad);
  return current?.pending ? current : null;
}

/**
 * What the game reports about itself, whether it is stopped or waits for Play (`idle`), the load
 * Live waits on, and a way to start one. `holds`: Live holds this game's page or is loading it.
 */
export function useLiveLoad(project: string | null, holds: boolean) {
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  /** The person stopped the game (Stop on the strip): main says so on every probe. */
  const [stopped, setStopped] = useState(false);
  const [liveLoad, setLiveLoad] = useState<LiveLoad | null>(() => loadOnOpen(project, holds, LiveTrigger.OpenGame));
  const [loadFor, setLoadFor] = useState({ project, holds });
  if (loadFor.project !== project) {
    setLoadFor({ project, holds });
    setState(null);
    setStopped(false);
    setLiveLoad(loadOnOpen(project, holds, LiveTrigger.OpenGame));
  } else if (loadFor.holds !== holds) {
    // Main started a load of this game itself (a chat's show, the morning card): wait for its page.
    // Live let go of it (a failed load): nothing is waited for but a load still under way.
    setLoadFor({ project, holds });
    setLiveLoad((current) => loadOnHolds(current, project, holds));
  }
  const idle = waitsForPlay({ project, holds, liveLoad });
  const liveLoadRef = useRef(liveLoad);
  liveLoadRef.current = liveLoad;
  /** Hide the game while `load` runs, then wait for the page it produced to settle; `trigger` says what asked for it. */
  const loadLive = useCallback((target: string, load: () => Promise<unknown>, trigger: LiveTrigger) => {
    const since = Date.now();
    setLiveLoad({ project: target, pending: true, since, trigger });
    return load().then(
      (value) => {
        setLiveLoad((current) =>
          current?.project === target ? { project: target, pending: false, since: Date.now(), trigger } : current,
        );
        return value;
      },
      (err: unknown) => {
        setLiveLoad((current) => (current?.project === target ? null : current));
        noteRefused({ project: target, since, trigger }, err);
        throw err;
      },
    );
  }, []);
  return { state, setState, stopped, setStopped, idle, liveLoad, setLiveLoad, liveLoadRef, loadLive };
}

/**
 * Load the stage's game into Live once it takes a kind (`gameStartedSince`): while it had none Live
 * loaded nothing. A game Live doesn't show as the web preview (`noPage`: the Unreal card, the
 * latest pictures) has no page, so it loads nothing either way. Answers whether the
 * game has no kind yet (`pending`), as given.
 */
export function useLoadOnceStarted(
  game: StageGameKind & { noPage: boolean },
  loadLive: ReturnType<typeof useLiveLoad>["loadLive"],
): boolean {
  const { project, pending, noPage } = game;
  const seen = useRef<StageGameKind>({ project, pending });
  useEffect(() => {
    const before = seen.current;
    seen.current = { project, pending };
    if (noPage || !project || !gameStartedSince(before, { project, pending })) return;
    void loadLive(project, () => window.studio.loadPreview(project), LiveTrigger.GameStarted).catch(() => {});
  }, [project, pending, noPage, loadLive]);
  return pending;
}

/** One answer about a web build: wait for the page it loaded, ask again while it is written, or give up and say so. */
function heardWebBuild(answer: WebBuildLoad, asksLeft: number, act: { show: () => void; again: () => void }): void {
  if (answer === WebBuildLoad.Loaded) act.show();
  if (answer !== WebBuildLoad.Unfinished) return;
  if (asksLeft > 1) act.again();
  else track(AnalyticsEvent.WebBuildWaitGaveUp, { asks: WEB_BUILD_ASKS });
}

/**
 * While the Web game tab is on screen, Live is asked to load the game's web build in a folder
 * (`webFolderOf`: a Godot or Unity export in `web/`) whenever the game, the folder or the tab
 * changes, and again while main answers that the build is still being written. Main decides
 * (`loadWebBuild`): only a finished build Live lacks, never into a stopped game or a build the
 * person chose to view. A load it made is awaited like the stage's own until the page settles; the
 * loader is not shown while main only decides, which would hide a running game every time. A game
 * waiting for Play is asked nothing: its build waits for the Play too.
 */
export function useWebGamePage(
  stage: { project: string | null; game: GameKind | null; onWebGame: boolean },
  live: Pick<ReturnType<typeof useLiveLoad>, "stopped" | "idle" | "setLiveLoad">,
): void {
  const { project, game, onWebGame } = stage;
  const { setLiveLoad } = live;
  const stopped = live.stopped || live.idle;
  const folder = game ? webFolderOf(game) : null;
  useEffect(() => {
    if (!onWebGame || stopped || !project || !folder) return;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = (asksLeft: number): void => {
      void window.studio
        .loadWebBuild(project)
        .then((answer) => {
          if (cancelled) return;
          heardWebBuild(answer, asksLeft, {
            show: () => setLiveLoad({ project, pending: false, since: Date.now(), trigger: LiveTrigger.WebBuild }),
            again: () => {
              retry = setTimeout(() => ask(asksLeft - 1), WEB_BUILD_RETRY_MS);
            },
          });
        })
        .catch(() => {});
    };
    ask(WEB_BUILD_ASKS);
    return () => {
      cancelled = true;
      if (retry) clearTimeout(retry);
    };
  }, [project, folder, onWebGame, stopped, setLiveLoad]);
}

/** How one page load is settling, tracked across probes. */
interface Settle {
  since: number;
  currentAt: number;
  lastResources: number;
  quietAt: number;
}
const freshSettle = (): Settle => ({ since: -1, currentAt: 0, lastResources: -1, quietAt: 0 });

/**
 * Why waiting for the page any longer is pointless, if it is: no time left, a broken build, a failed
 * or crashed page. A page whose load error is the game's own build (`isBuildLoadFailure`: nothing to
 * serve, or the last build that worked served instead) gave up on a broken build, not a failed load.
 */
export function givenUp(
  load: LiveLoad,
  probe: { live: LivePage | null; current: boolean; broken: boolean; now: number },
): LiveOutcome | null {
  const { live, current } = probe;
  if (current && live?.crashed) return LiveOutcome.Crashed;
  const buildFailed = current && isBuildLoadFailure(oneOf(LiveLoadFailure, live?.loadFailure));
  if (buildFailed) return LiveOutcome.BuildBroken;
  if (current && live?.loadError) return LiveOutcome.LoadFailed;
  if (probe.broken) return LiveOutcome.BuildBroken;
  return probe.now - load.since > LIVE_LOAD_MAX_MS ? LiveOutcome.TimedOut : null;
}

/**
 * Whether the page a load asked for has loaded and gone quiet (`shown`) — or waiting for it any
 * longer is pointless, and why; null while it is still worth waiting.
 */
function settled(
  settle: Settle,
  load: LiveLoad,
  probe: { live: LivePage | null; current: boolean; broken: boolean; now: number },
): LiveOutcome | null {
  const { live, current, now } = probe;
  if (load.since !== settle.since) Object.assign(settle, freshSettle(), { since: load.since });
  const gaveUp = givenUp(load, probe);
  if (!current) return gaveUp;
  settle.currentAt ||= now;
  let ready = now - settle.currentAt > LIVE_SETTLE_MAX_MS;
  const page = live?.page;
  if (page?.complete && page.resources !== settle.lastResources) {
    settle.lastResources = page.resources;
    settle.quietAt = now;
  } else if (page?.complete && now - settle.quietAt >= LIVE_QUIET_MS) ready = true;
  return gaveUp ?? (ready ? LiveOutcome.Shown : null);
}

/** What this game's own page says on a probe: whether it is stopped, and the state it reports. */
function noteGame(live: LivePage, set: Pick<ReturnType<typeof useLiveLoad>, "setState" | "setStopped">): void {
  set.setStopped(live.stopped);
  if (!live.page) return;
  const next = live.page.state;
  set.setState((previous) =>
    previous?.phase === next?.phase && previous?.drawCalls === next?.drawCalls ? previous : next,
  );
}

/** The load this game's probe settled, and how; null while there is none to wait on or the wait goes on. */
function settledLoad(
  load: LiveLoad | null,
  project: string,
  settle: Settle,
  probe: { live: LivePage | null; current: boolean; broken: boolean; now: number },
): { load: LiveLoad; outcome: LiveOutcome } | null {
  if (!load || load.pending || load.project !== project) return null;
  const outcome = settled(settle, load, probe);
  return outcome ? { load, outcome } : null;
}

/** What the stage knows of the game it waits on, for the event its wait sends. */
export interface LiveAbout {
  /** When the game was made (`GameProject.createdAt`). */
  createdAt: string | null;
  /** When the chat's first message was sent, once its log is read. */
  firstMessageAt: number | null;
}

/** Games Live has shown this launch. */
const shownThisLaunch = new Set<string>();

/** A game Live uncovered, watched until it draws or looks blank. */
type Shown = { project: string; at: number; told: boolean };

/**
 * A load main refused before any page came: said once, unless another load took its place. Guarded:
 * the refusal the caller catches is never one of analytics.
 */
const noteRefused = guarded((load: { project: string; since: number; trigger: LiveTrigger }, refusal: unknown) => {
  const properties = liveRefusedProperties(load, refusal, { now: Date.now(), gameRef: gameRef(load.project) });
  if (properties) track(AnalyticsEvent.LiveGameShown, properties);
});

/** Live's wait ended: say how, and start watching a shown game for a blank page. */
function noteSettled(
  load: LiveLoad,
  outcome: LiveOutcome,
  at: {
    now: number;
    about: RefObject<LiveAbout | null>;
    state: Record<string, unknown> | null;
    failure: { load: unknown; gone: unknown } | null;
  },
): Shown | null {
  const firstInLaunch = !shownThisLaunch.has(load.project);
  const about = at.about.current;
  track(
    AnalyticsEvent.LiveGameShown,
    liveShownProperties({
      outcome,
      load,
      now: at.now,
      firstInLaunch: firstInLaunch && outcome === LiveOutcome.Shown,
      gameCreatedAt: about?.createdAt ?? null,
      firstMessageAt: about?.firstMessageAt ?? null,
      state: at.state,
      gameRef: gameRef(load.project),
      failure: at.failure,
    }),
  );
  if (outcome !== LiveOutcome.Shown) return null;
  shownThisLaunch.add(load.project);
  return { project: load.project, at: at.now, told: false };
}

/** Why this game's own page failed or went away, as its probe says (unchecked); null for another page. */
const pageFailure = (live: LivePage | null, current: boolean): { load: unknown; gone: unknown } | null =>
  current && live ? { load: live.loadFailure, gone: live.gone } : null;

/** A shown game that has drawn nothing since it showed is told once. */
function noteBlank(
  shown: Shown | null,
  project: string,
  at: { now: number; state: Record<string, unknown> | null; unresponsive: unknown },
): void {
  if (!shown || shown.told || shown.project !== project) return;
  const blank = blankSuspected(shown.at, at.now, at.state, at.unresponsive);
  if (!blank) return;
  shown.told = true;
  track(AnalyticsEvent.LiveBlankSuspected, blank);
}

// One probe answers both questions the stage asks of the page: what state the game reports,
// and — while a load is under way — whether the page it asked for has loaded and gone quiet.
/** Probe the live page while Live shows or a load is waiting; reveal the game once its page has settled. */
export function useLiveProbe({
  project,
  stageView,
  live: { liveLoad, liveLoadRef, setLiveLoad, setState, setStopped },
  buildProblemRef,
  about,
}: {
  project: string | null;
  stageView: StageView;
  live: ReturnType<typeof useLiveLoad>;
  buildProblemRef: RefObject<boolean>;
  about: RefObject<LiveAbout | null>;
}): void {
  const waiting = liveLoad !== null;
  const shown = useRef<Shown | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the probe restarts only for a new game, view or wait; the rest is read through refs
  useEffect(() => {
    const probing = stageView === StageView.Live || waiting;
    if (!project || !probing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = freshSettle();
    const observe = (live: LivePage | null): void => {
      // The previous game's page, or this one mid-navigation, says nothing about the page asked for.
      const current = Boolean(live && live.project === project && !live.navigating);
      if (current && live) noteGame(live, { setState, setStopped });
      const now = Date.now();
      const state = live?.page?.state ?? null;
      if (current) noteBlank(shown.current, project, { now, state, unresponsive: live?.unresponsive });
      const done = settledLoad(liveLoadRef.current, project, settle, {
        live,
        current,
        broken: buildProblemRef.current,
        now,
      });
      if (!done) return;
      shown.current = noteSettled(done.load, done.outcome, { now, about, state, failure: pageFailure(live, current) });
      setLiveLoad((value) => (value === done.load ? null : value));
    };
    const tick = async (): Promise<void> => {
      const live = await window.studio.previewLive().catch(() => null);
      if (cancelled) return;
      observe(live);
      timer = setTimeout(() => void tick(), liveLoadRef.current ? LIVE_LOADING_TICK_MS : LIVE_TICK_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [project, stageView, waiting]);
}
