/**
 * The page Live is waiting for. Until it has loaded and settled the native view stays out of
 * sight and the stage shows a quiet loader — never the previous game, a blank navigation or a
 * first black frame. `pending` covers a load the stage started itself and is still awaiting.
 */
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { WebBuildLoad } from "../../../shared/live-behind.ts";
import type { GameKind } from "../../../shared/project-facts.ts";
import { webFolderOf } from "../../../shared/project-workspace.ts";
import { gameStartedSince, type StageGameKind, StageView } from "../../stage.ts";

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

/** A load Live is waiting on: for which game, whether the stage is still starting it, and since when. */
export type LiveLoad = { project: string; pending: boolean; since: number };

type LivePage = Awaited<ReturnType<typeof window.studio.previewLive>>;

/** What the game reports about itself, whether it is stopped, the load Live waits on, and a way to start one. */
export function useLiveLoad(project: string | null) {
  const [state, setState] = useState<Record<string, unknown> | null>(null);
  /** The person stopped the game (Stop on the strip): main says so on every probe. */
  const [stopped, setStopped] = useState(false);
  const [liveLoad, setLiveLoad] = useState<LiveLoad | null>(() =>
    project ? { project, pending: false, since: Date.now() } : null,
  );
  const [loadFor, setLoadFor] = useState(project);
  if (loadFor !== project) {
    setLoadFor(project);
    setState(null);
    setStopped(false);
    setLiveLoad(project ? { project, pending: false, since: Date.now() } : null);
  }
  const liveLoadRef = useRef(liveLoad);
  liveLoadRef.current = liveLoad;
  /** Hide the game while `load` runs, then wait for the page it produced to settle. */
  const loadLive = useCallback((target: string, load: () => Promise<unknown>) => {
    setLiveLoad({ project: target, pending: true, since: Date.now() });
    return load().then(
      (value) => {
        setLiveLoad((current) =>
          current?.project === target ? { project: target, pending: false, since: Date.now() } : current,
        );
        return value;
      },
      (err: unknown) => {
        setLiveLoad((current) => (current?.project === target ? null : current));
        throw err;
      },
    );
  }, []);
  return { state, setState, stopped, setStopped, liveLoad, setLiveLoad, liveLoadRef, loadLive };
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
    void loadLive(project, () => window.studio.loadPreview(project)).catch(() => {});
  }, [project, pending, noPage, loadLive]);
  return pending;
}

/**
 * While the Web game tab is on screen, Live is asked to load the game's web build in a folder
 * (`webFolderOf`: a Godot or Unity export in `web/`) whenever the game, the folder or the tab
 * changes, and again while main answers that the build is still being written. Main decides
 * (`loadWebBuild`): only a finished build Live lacks, never into a stopped game or a build the
 * person chose to view. A load it made is awaited like the stage's own until the page settles; the
 * loader is not shown while main only decides, which would hide a running game every time.
 */
export function useWebGamePage(
  stage: { project: string | null; game: GameKind | null; onWebGame: boolean },
  live: Pick<ReturnType<typeof useLiveLoad>, "stopped" | "setLiveLoad">,
): void {
  const { project, game, onWebGame } = stage;
  const { stopped, setLiveLoad } = live;
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
          if (answer === WebBuildLoad.Loaded) setLiveLoad({ project, pending: false, since: Date.now() });
          if (answer === WebBuildLoad.Unfinished && asksLeft > 1)
            retry = setTimeout(() => ask(asksLeft - 1), WEB_BUILD_RETRY_MS);
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

/** Whether the page a load asked for has loaded and gone quiet — or waiting for it any longer is pointless. */
function settled(
  settle: Settle,
  load: LiveLoad,
  probe: { live: LivePage | null; current: boolean; broken: boolean; now: number },
): boolean {
  const { live, current, now } = probe;
  if (load.since !== settle.since) Object.assign(settle, freshSettle(), { since: load.since });
  const failed = Boolean(current && (live?.loadError || live?.crashed));
  let ready = now - load.since > LIVE_LOAD_MAX_MS || probe.broken || failed;
  if (!current) return ready;
  settle.currentAt ||= now;
  if (now - settle.currentAt > LIVE_SETTLE_MAX_MS) ready = true;
  const page = live?.page;
  if (!page?.complete) return ready;
  if (page.resources !== settle.lastResources) {
    settle.lastResources = page.resources;
    settle.quietAt = now;
  } else if (now - settle.quietAt >= LIVE_QUIET_MS) ready = true;
  return ready;
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

// One probe answers both questions the stage asks of the page: what state the game reports,
// and — while a load is under way — whether the page it asked for has loaded and gone quiet.
/** Probe the live page while Live shows or a load is waiting; reveal the game once its page has settled. */
export function useLiveProbe({
  project,
  stageView,
  live: { liveLoad, liveLoadRef, setLiveLoad, setState, setStopped },
  buildProblemRef,
}: {
  project: string | null;
  stageView: StageView;
  live: ReturnType<typeof useLiveLoad>;
  buildProblemRef: RefObject<boolean>;
}): void {
  const waiting = liveLoad !== null;
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
      const load = liveLoadRef.current;
      if (!load || load.pending) return;
      if (load.project !== project) return;
      const probe = { live, current, broken: buildProblemRef.current, now: Date.now() };
      if (settled(settle, load, probe)) setLiveLoad((value) => (value === load ? null : value));
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
