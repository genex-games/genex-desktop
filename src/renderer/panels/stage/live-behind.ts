/**
 * What Live shows and what waits for its Reload. Live never changes itself while the person
 * watches it (`stage.ts` holds the rules): a run's newest healthy build, a change main holds for
 * Live (`live.behind`) and a build found broken mark Reload, and Reload brings them in — or, for
 * what main holds, the person leaving Live does. The empty scaffold still takes the run's first
 * healthy build at once: it has no game to lose.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveBehindEvent } from "../../../shared/live-behind.ts";
import { UiEvent } from "../../../shared/ui-events.ts";
import { type RunGraph as RunGraphModel, runBuilding } from "../../run-graph.ts";
import {
  appliesUnseen,
  firstBuildShows,
  laterOf,
  type LiveBehind,
  liveBehindOf,
  newBuildOffer,
  type StageWatch,
  StageView,
} from "../../stage.ts";
import { type Notify, ToastTone } from "../../state/toasts.ts";
import { problemWords, TOAST_WORDS } from "../../words.ts";

/** The run's build Live shows, as main says it (`live.behind` `shows`). */
type ShownBuild = { head: string };

/** What the stage needs to know what waits for Live, and to bring it in. */
export interface LiveBehindInput extends StageWatch {
  project: string | null;
  threadId: string | null;
  /** The run Live answers to (`stageRunGraph`): never a chat turn's graph. */
  graph: RunGraphModel | null;
  selectedRun: string | null;
  /** The person stopped the game: nothing waiting goes in on its own, which would start it again. */
  stopped: boolean;
  loadLive: (target: string, load: () => Promise<unknown>) => Promise<unknown>;
  onView: (view: StageView) => void;
  onNotice: Notify;
}

/**
 * What main says of this game's Live (`live.behind`): what it holds for Reload, and the build Live
 * shows whichever path loaded it. Read once on mount, so a renderer that reloaded (or mounted after
 * the event) still knows; then kept by the events, and an event that lands before the read answers
 * wins over it (`laterOf`).
 */
function useLiveState(project: string | null): LiveBehindEvent | null {
  const [state, setState] = useState<LiveBehindEvent | null>(null);
  useEffect(() => {
    setState(null);
    if (!project) return;
    let heard = false;
    let mounted = true;
    const stop = window.studio.onEvent((event) => {
      if (event.type !== UiEvent.LiveBehind || event.payload?.project !== project) return;
      heard = true;
      setState(event.payload);
    });
    void window.studio.liveBehind(project).then(
      (read) => {
        if (mounted) setState((now) => laterOf(now, read, heard));
      },
      () => {},
    );
    return () => {
      mounted = false;
      stop();
    };
  }, [project]);
  return state;
}

/**
 * The build the stage swapped in, what waits for Live, and the swap itself. `showBuild` is the
 * person's Play (it brings Live forward); `reload` is Reload, which brings in whatever waits.
 */
export function useLiveBehind(input: LiveBehindInput): {
  shownBuild: ShownBuild | null;
  behind: LiveBehind | null;
  showBuild: (head: string) => Promise<void>;
  reload: () => void;
} {
  const { project, threadId, graph, selectedRun, loadLive, onView, onNotice } = input;
  const currentProject = useRef(project);
  currentProject.current = project;
  const pending = useRef(false);
  const failedHead = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new game or conversation forgets a build that failed to load
  useEffect(() => {
    failedHead.current = null;
  }, [project, threadId]);
  const live = useLiveState(project);
  const held = live?.reason ? live : null;
  // Main says which build Live shows, whoever loaded it: Play here, in Builds, on the morning card
  // or in a review, so a build already on the stage is never offered again.
  const shownBuild = useMemo<ShownBuild | null>(() => (live?.shows ? { head: live.shows } : null), [live?.shows]);

  /** Load into Live for this game, once at a time; `after` runs when this game is still the one on the stage. */
  const intoLive = useCallback(
    async (load: () => Promise<unknown>, after: () => void, onError: (err: unknown) => void): Promise<void> => {
      if (!project || pending.current) return;
      pending.current = true;
      await loadLive(project, load)
        .then(() => {
          if (currentProject.current === project) after();
        })
        .catch((err: unknown) => {
          if (currentProject.current === project) onError(err);
        })
        .finally(() => {
          pending.current = false;
        });
    },
    [project, loadLive],
  );
  const failed = useCallback((err: unknown) => onNotice(problemWords(err), ToastTone.Error), [onNotice]);

  const showMergedBuild = useCallback(
    (head: string, asked: boolean): Promise<void> =>
      intoLive(
        () => window.studio.showBuild(project ?? "", head),
        () => {
          if (asked) onView(StageView.Live);
        },
        (err) => {
          failedHead.current = head;
          failed(err);
        },
      ),
    [project, intoLive, onView, failed],
  );

  // A build merged this run that runs, and is not already on the stage. The graph is the run's
  // own (`stageRunGraph`): a chat turn's workers change the game itself and offer no build.
  const ownBuild = runBuilding(graph) && !selectedRun;
  const offer = useMemo(
    () => (ownBuild ? newBuildOffer(graph?.mergedHead ?? null, shownBuild?.head ?? null) : null),
    [ownBuild, graph?.mergedHead, shownBuild?.head],
  );
  // A build the stage swapped in can still be found broken by a later health pass. It stays until
  // the person reloads — they may be playing it — and the change is explained.
  const shownBroken = Boolean(
    shownBuild && graph?.mergedHead?.head === shownBuild.head && graph.mergedHead.healthy === false,
  );
  useEffect(() => {
    if (shownBroken) onNotice(TOAST_WORDS.shownBuildBroken, ToastTone.Info);
  }, [shownBroken, onNotice]);
  const behind = useMemo(() => liveBehindOf({ waiting: held, offer, shownBroken }), [held, offer, shownBroken]);

  /** Bring in what waits (or reload what is there), exactly as Reload does. */
  const apply = useCallback(
    (what: LiveBehind | null): Promise<void> => {
      if (what?.held)
        return intoLive(
          () => window.studio.reloadPreview(),
          () => {},
          failed,
        );
      if (what?.head) return showMergedBuild(what.head, false);
      if (what)
        return intoLive(
          () => window.studio.loadPreview(project ?? ""),
          () => {},
          failed,
        );
      return intoLive(
        () => window.studio.reloadPreview(),
        () => {},
        () => {},
      );
    },
    [project, intoLive, showMergedBuild, failed],
  );
  const behindRef = useRef(behind);
  behindRef.current = behind;
  const reload = useCallback(() => void apply(behindRef.current), [apply]);

  const stage: StageWatch = { view: input.view, visible: input.visible, showEmpty: input.showEmpty };
  useUnseenChanges(appliesUnseen(behind, stage) && !input.stopped ? behind : null, apply);
  useFirstBuild(firstBuildShows(offer, stage) ? (offer?.head ?? null) : null, failedHead, showMergedBuild);

  const showBuild = useCallback((head: string): Promise<void> => showMergedBuild(head, true), [showMergedBuild]);
  return { shownBuild, behind, showBuild, reload };
}

/** Nobody is watching a game in Live: what waits goes in now, so Live is current when they come back. */
function useUnseenChanges(unseen: LiveBehind | null, apply: (what: LiveBehind) => Promise<void>): void {
  const key = unseen ? `${unseen.reason}:${unseen.head ?? ""}:${unseen.note ?? ""}` : null;
  const latest = useRef(unseen);
  latest.current = unseen;
  // biome-ignore lint/correctness/useExhaustiveDependencies: one application per waiting change, named by its key
  useEffect(() => {
    if (latest.current) void apply(latest.current);
  }, [key]);
}

/** The empty scaffold takes the run's first healthy build at once, unless that very build already failed to load. */
function useFirstBuild(
  head: string | null,
  failedHead: { current: string | null },
  showMergedBuild: (head: string, asked: boolean) => Promise<void>,
): void {
  useEffect(() => {
    if (head && failedHead.current !== head) void showMergedBuild(head, false);
  }, [head, failedHead, showMergedBuild]);
}
