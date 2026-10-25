/**
 * Whether a Live view shows the newest version of the game, and what the status line above it
 * says when it does not (docs/product/builds-live.md). Live never swaps the picture while someone
 * watches (`stage.ts`): a newer version waits for Update, which is Reload. After the game folder
 * changed under a compiled game (a landing, a checkpoint, the person's edits), the build Reload
 * would play is made in the background for the view the person has (`prepareLiveBuild`: Web for
 * the web view, Mac for Native), so the line can say it is being built, then that it is ready or
 * failed, and Update is quick. The same rule and words hold for Web and Native.
 */
import { useEffect, useMemo, useState } from "react";
import { BuildTarget } from "../../../shared/game-project.ts";
import {
  LiveBehindReason,
  LivePrepare,
  type LivePrepareTarget,
  LiveUpdateKind,
  type LiveUpdating,
} from "../../../shared/live-behind.ts";
import { CLOCK_TICK_MS, elapsedWords } from "../../asset-making.ts";
import type { LiveBehind } from "../../stage.ts";
import { LIVE_FRESH_WORDS } from "../../words.ts";

/** Where the status line stands. Wire values of `data-stage-live-fresh`: never rename one. */
export const LiveFreshState = {
  /** The newer version is being built; the earlier one stays. */
  Building: "building",
  /** A newer version waits for Update. */
  Ready: "ready",
  /** The newer version did not build; the earlier one stays, and Try again shows why. */
  Failed: "failed",
} as const;
export type LiveFreshState = (typeof LiveFreshState)[keyof typeof LiveFreshState];

/** One background build: of which destination, since when, and how it came out (null while under way). */
export interface LivePrepareRun {
  target: LivePrepareTarget;
  since: number;
  outcome: LivePrepare | null;
}

/** What the status line says: its state, its words, the quiet note beside them, and its button's label (null: none). */
export interface LiveFresh {
  state: LiveFreshState;
  title: string;
  note: string | null;
  action: string | null;
}

/**
 * The destination a waiting change is built for in the background: a compiled game's changed
 * game folder (main holds it, and Reload loads the folder, not a run's build by its commit), for
 * the view the person has. Null for anything else: Reload alone brings that in.
 */
export function prepareTargetFor(
  behind: LiveBehind | null,
  game: { compiled: boolean; native: boolean },
): LivePrepareTarget | null {
  const folderChanged = behind?.held === true && behind.reason === LiveBehindReason.Changed && behind.head === null;
  if (!folderChanged || !game.compiled) return null;
  return game.native ? BuildTarget.Mac : BuildTarget.Web;
}

/** One background build per change, view and game: a new note (a new checkpoint) is a new change. */
export const prepareKey = (project: string, behind: LiveBehind, target: LivePrepareTarget): string =>
  JSON.stringify([project, target, behind.reason, behind.head, behind.note]);

/** What waits says when nothing is built for it in the background (or the build was skipped). */
function readyFresh(behind: LiveBehind): LiveFresh {
  const broken = behind.reason === LiveBehindReason.Broken;
  return {
    state: LiveFreshState.Ready,
    title: LIVE_FRESH_WORDS.ready[behind.reason],
    note: broken ? null : LIVE_FRESH_WORDS.earlier,
    action: broken ? LIVE_FRESH_WORDS.backToGame : LIVE_FRESH_WORDS.update,
  };
}

/** How long a Play's build may take before the line says it is on its way: one ready at once never flashes it. */
export const UPDATING_SHOWN_AFTER_MS = 500;

/**
 * What the line says while a newer build is made ready for Live (PW): the person's Play, as soon as
 * it is more than a moment; Play's background build, only of the build Reload would play. Live keeps
 * the earlier version meanwhile, and says so when it shows this game. Null for nothing to say.
 */
function updatingFresh(
  updating: LiveUpdating | null | undefined,
  input: { behind: LiveBehind | null; now: number; showsGame: boolean },
): LiveFresh | null {
  if (!updating) return null;
  const waited = input.now - updating.since;
  const play = updating.kind === LiveUpdateKind.Play;
  const offered = input.behind?.head ? updating.commit.startsWith(input.behind.head) : false;
  if (play ? waited < UPDATING_SHOWN_AFTER_MS : !offered) return null;
  const clock = elapsedWords(updating.since, input.now) ?? "";
  const words = play ? LIVE_FRESH_WORDS.opening : LIVE_FRESH_WORDS.prebuilding;
  return {
    state: LiveFreshState.Building,
    title: words(clock),
    note: input.showsGame ? LIVE_FRESH_WORDS.earlier : null,
    action: null,
  };
}

/** The status line for a view: null while it shows the newest version. */
export function liveFreshness(input: {
  behind: LiveBehind | null;
  prepare: LivePrepareRun | null;
  now: number;
  /** A newer build being made ready for Live (`live.behind`'s `updating`). */
  updating?: LiveUpdating | null;
  /** Live shows a page of this game now. */
  showsGame?: boolean;
}): LiveFresh | null {
  const { behind, prepare, now } = input;
  const updating = updatingFresh(input.updating, { behind, now, showsGame: input.showsGame === true });
  if (updating) return updating;
  if (!behind) return null;
  const earlier = LIVE_FRESH_WORDS.earlier;
  if (prepare?.outcome === null) {
    const clock = elapsedWords(prepare.since, now) ?? "";
    return {
      state: LiveFreshState.Building,
      title: LIVE_FRESH_WORDS.building[prepare.target](clock),
      note: earlier,
      action: null,
    };
  }
  if (prepare?.outcome === LivePrepare.Failed)
    return {
      state: LiveFreshState.Failed,
      title: LIVE_FRESH_WORDS.failed,
      note: earlier,
      action: LIVE_FRESH_WORDS.tryAgain,
    };
  if (prepare?.outcome === LivePrepare.Built)
    return {
      state: LiveFreshState.Ready,
      title: LIVE_FRESH_WORDS.built,
      note: earlier,
      action: LIVE_FRESH_WORDS.update,
    };
  return readyFresh(behind);
}

/** Now, moving on once a second while `running`. */
function useTicking(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The status line for the game on the stage, starting the background build a change asks for
 * (`prepareTargetFor`) once per change and view. A build that answers after the change was brought
 * in (or another took its place) is forgotten with its key.
 */
export function useLiveFresh(input: {
  project: string | null;
  behind: LiveBehind | null;
  compiled: boolean;
  native: boolean;
  updating?: LiveUpdating | null;
  showsGame?: boolean;
}): LiveFresh | null {
  const { project, behind, compiled, native, updating, showsGame } = input;
  const target = prepareTargetFor(behind, { compiled, native });
  const key = project && behind && target ? prepareKey(project, behind, target) : null;
  const [run, setRun] = useState<(LivePrepareRun & { key: string }) | null>(null);
  useEffect(() => {
    if (!key || !project || !target) return;
    let current = true;
    setRun({ key, target, since: Date.now(), outcome: null });
    const settle = (outcome: LivePrepare): void => {
      if (current) setRun((now) => (now?.key === key ? { ...now, outcome } : now));
    };
    void window.studio.prepareLiveBuild(project, target).then(settle, () => settle(LivePrepare.Failed));
    return () => {
      current = false;
    };
  }, [key, project, target]);
  const prepare = run && run.key === key ? run : null;
  const now = useTicking(prepare?.outcome === null || Boolean(updating));
  return useMemo(
    () => liveFreshness({ behind, prepare, now, updating: updating ?? null, showsGame: showsGame === true }),
    [behind, prepare, now, updating, showsGame],
  );
}
