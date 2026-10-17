/**
 * Live for a game linked to an Unreal project (`shared/game-engine.ts`). The game plays in the
 * Unreal editor, not in a web page, so instead of the black page the stage names the project and
 * says where it stands, with the one step it needs, as the Unreal button's panel offers it: get
 * Unreal, set up and open, open, a timer while it opens, Ready, or switch, restart or quit Unreal
 * (`unreal-stage-view.ts`). It asks the bundled Unreal plugin's `stage-status` every few seconds.
 * The latest play shot shows above the name once a run keeps one (`live-views.ts` `latestShot`). A
 * folder holding an Unreal project Genex has no link to yet shows the game's name and the way to
 * choose its project.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../../shared/duration.ts";
import { isUserCancelled } from "../../../shared/errors.ts";
import { projectName } from "../../../shared/game-engine.ts";
import type { PluginInfo } from "../../../shared/plugins.ts";
import { runPluginAction } from "../../plugin-actions.ts";
import { type Notify, ToastTone } from "../../state/toasts.ts";
import { Button } from "../../ui/Button.tsx";
import { OPEN_PLUGINS_EVENT } from "../../ui/ComposerAddMenu.tsx";
import type { GameProject } from "../../types.ts";
import {
  parseStageStatus,
  UNREAL_PLUGIN_ID,
  UnrealPluginAction,
  type UnrealStageStatus,
  unrealOpener,
  unrealProjectOf,
} from "../../unreal-game.ts";
import { problemWords, UNREAL_WORDS } from "../../words.ts";
import { openPluginSetup } from "../../plugin-setup.ts";
import { type StatusPoll, startStatusPoll } from "../../status-poll.ts";
import {
  keepStageStatus,
  keptStageStatus,
  type ReceivedStatus,
  type ReopenMark,
  ReopenStep,
  reopenStep,
  StageAct,
  type StageView,
  stageView,
} from "./unreal-stage-view.ts";

/** How often the card asks where the project stands; the panel asks as often. */
const STATUS_POLL_MS = 3 * SECOND_MS;
/** How long a restart waits for Unreal to close (it may ask to save) before it gives up opening. */
const QUIT_WAIT_MS = 60 * SECOND_MS;

/** The plugin's own note about an Open, such as the Genex editor helper files it kept as .mine; null without one. */
function openNote(result: unknown): string | null {
  if (!result || typeof result !== "object" || !("note" in result)) return null;
  return typeof result.note === "string" && result.note ? result.note : null;
}

/** Time since an opening began, as the panel's timer shows it: minutes and two-digit seconds. */
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / SECOND_MS));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Opens the Unreal button's panel (where Get Unreal and the project list are), else the Plugins page at Unreal. */
const openUnrealPanel = () => openPluginSetup(UNREAL_PLUGIN_ID);

/** Before the plugin's first answer for a game. */
const NOT_ASKED: ReceivedStatus = { status: null, at: 0 };

/**
 * The plugin's `stage-status` for this game, asked every few seconds while the card shows, one ask
 * at a time. A card that comes back starts from the game's last answer, so switching tabs never
 * replays a guess; a new game restarts the asking and drops the last game's answers, and a new
 * plugin list restarts it only when the plugin itself changed.
 */
function useStageStatus(plugin: PluginInfo | null, game: string) {
  const [latest, setLatest] = useState(() => ({ game, received: keptStageStatus(game) ?? NOT_ASKED }));
  const received = latest.game === game ? latest.received : (keptStageStatus(game) ?? NOT_ASKED);
  const poll = useRef<StatusPoll | null>(null);
  const pluginId = plugin?.manifest.id;
  useEffect(() => {
    if (!pluginId) return;
    const ask = () => window.studio.pluginAction(pluginId, UnrealPluginAction.StageStatus, {}, game).catch(() => null);
    const read = startStatusPoll(
      ask,
      (answer) => {
        const next = { status: parseStageStatus(answer), at: Date.now() };
        keepStageStatus(game, next);
        setLatest({ game, received: next });
      },
      STATUS_POLL_MS,
    );
    poll.current = read;
    return () => {
      read.stop();
      if (poll.current === read) poll.current = null;
    };
  }, [pluginId, game]);
  const refresh = useCallback(() => poll.current?.refresh() ?? Promise.resolve(), []);
  return { received, refresh };
}

/** The timer while the project opens: the plugin's elapsed time when it answered, counted on since. */
function useOpeningTimer({ status, at }: ReceivedStatus): string {
  const [now, setNow] = useState(() => Date.now());
  const elapsed = status?.opening?.elapsedMs;
  useEffect(() => {
    if (elapsed === undefined) return;
    const tick = setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => clearInterval(tick);
  }, [elapsed]);
  return elapsed === undefined ? "" : elapsedText(elapsed + Math.max(0, now - at));
}

/** What a press needs: the plugin, the game and its project, the status refresh, and the toast channel. */
type PressDeps = {
  plugin: PluginInfo | null;
  game: string;
  project: string | null;
  refresh: () => Promise<void>;
  onNotice: Notify;
};

/** Runs one of the plugin's actions for this game's project; actions here ask no in-app review (setup's is native). */
async function act(deps: PressDeps, plugin: PluginInfo, name: string): Promise<unknown> {
  const review = ({ resolve }: { resolve: (yes: boolean) => void }) => resolve(false);
  return runPluginAction({ plugin, name, args: { project: deps.project }, project: deps.game, review });
}

/** Opens the project in Unreal, and shows the plugin's note about it (helper files it kept), if any. */
async function openProject(deps: PressDeps, plugin: PluginInfo): Promise<void> {
  const note = openNote(await act(deps, plugin, UnrealPluginAction.OpenEditor));
  if (note) deps.onNotice(note, ToastTone.Ok);
}

/**
 * Each button's sequence of the plugin's own actions, the same ones its panel runs; true when a
 * restart is waiting for Unreal to close before it opens the project.
 */
async function press(deps: PressDeps, which: StageAct): Promise<boolean> {
  const plugin = deps.plugin;
  if (which === StageAct.GetUnreal || which === StageAct.Panel) {
    openUnrealPanel();
    return false;
  }
  if (!plugin) {
    window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: UNREAL_PLUGIN_ID } }));
    return false;
  }
  if (which === StageAct.SetUpAndOpen || which === StageAct.SetUp) await act(deps, plugin, UnrealPluginAction.Setup);
  // Beside another project Unreal has open, setup opens nothing: Genex keeps one Unreal at a time.
  if (which === StageAct.SetUp) return false;
  const quits = which === StageAct.Quit || which === StageAct.Restart;
  if (quits) await act(deps, plugin, UnrealPluginAction.QuitEditor);
  if (quits) return which === StageAct.Restart;
  await openProject(deps, plugin);
  return false;
}

/** Shows a press's failure, unless the person cancelled it in a confirmation. */
const failed = (deps: PressDeps) => (err: unknown) => {
  if (!isUserCancelled(err)) deps.onNotice(problemWords(err), ToastTone.Error);
};

/**
 * The card's button, busy from a press until its sequence ends. A restart opens the project once
 * the status says no editor runs any more (Unreal may first ask to save) and opening is the step,
 * or gives up after {@link QUIT_WAIT_MS}: a quit the person cancelled opens nothing, and a project
 * whose port another app now holds shows Set up again instead (`reopenStep`). Another game on the
 * stage starts with no restart waiting and the button free, so a restart never opens the wrong game.
 */
function usePress(deps: PressDeps, status: UnrealStageStatus | null) {
  const [busy, setBusy] = useState(false);
  const reopen = useRef<ReopenMark | null>(null);
  // Each press, and each game the stage shows, takes the next number; only the latest press frees the button.
  const presses = useRef(0);
  const { plugin, game } = deps;
  useEffect(() => {
    presses.current += 1;
    reopen.current = null;
    setBusy(false);
  }, [game]);
  const run = async (which: StageAct) => {
    const mine = ++presses.current;
    setBusy(true);
    try {
      if (await press(deps, which)) reopen.current = { game, until: Date.now() + QUIT_WAIT_MS };
    } catch (err) {
      failed(deps)(err);
    } finally {
      if (presses.current === mine) setBusy(false);
      await deps.refresh();
    }
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new status is the trigger; deps are read as they are now
  useEffect(() => {
    if (!plugin) return;
    const step = reopenStep(reopen.current, game, status, Date.now());
    if (step === ReopenStep.Wait) return;
    reopen.current = null;
    if (step !== ReopenStep.Open) return;
    void openProject(deps, plugin)
      .catch(failed(deps))
      .finally(() => void deps.refresh());
  }, [status]);
  return { busy, run };
}

/** The card's line, with its timer while the project opens, and its quieter second line when it has one. */
function StageLine({ view, timer }: { view: StageView; timer: string }): JSX.Element {
  return (
    <>
      {/* One line tall even before the first answer, so the line arriving moves nothing. */}
      <p className="empty-state-subtitle min-h-lh max-w-full" role="status">
        {view.line}
        {view.timer && timer ? <span className="tabular-nums"> {timer}</span> : null}
      </p>
      {view.hint ? <p className="empty-state-subtitle max-w-full">{view.hint}</p> : null}
    </>
  );
}

/** Live's Unreal card: the latest play shot when there is one, the project's name, where it stands, and its one step. */
export function UnrealStage({
  game,
  plugins,
  shot = null,
  onNotice,
}: {
  /** The game on the stage, which Live shows as an Unreal project (`live-views.ts`). */
  game: Pick<GameProject, "name" | "engine" | "title">;
  plugins: PluginInfo[];
  /** The latest play shot's URL; none until a run keeps one. */
  shot?: string | null;
  onNotice: Notify;
}): JSX.Element | null {
  const project = unrealProjectOf(game);
  const plugin = unrealOpener(plugins);
  const { received, refresh } = useStageStatus(plugin, game.name);
  const status = received.status;
  const timer = useOpeningTimer(received);
  const { busy, run } = usePress({ plugin, game: game.name, project, refresh, onNotice }, status);
  const name = project ? projectName(project) : game.title;
  const view = stageView(status, name, { linked: project !== null, answered: received.at > 0 });
  const button = view.button;
  return (
    <div
      data-stage-unreal=""
      data-unreal-step={status?.next ?? ""}
      className="hatch absolute inset-0 grid place-items-center overflow-y-auto p-8"
    >
      <div className="flex w-full max-w-[560px] flex-col items-center text-center">
        {shot ? (
          <img
            data-unreal-shot=""
            src={shot}
            alt={UNREAL_WORDS.playShot(name)}
            className="aspect-video w-full rounded-lg border border-line object-cover"
          />
        ) : null}
        <h2 className="empty-state-title max-w-full" title={name}>
          {name}
        </h2>
        <StageLine view={view} timer={timer} />
        {button ? (
          <div className="empty-state-slot">
            <Button data-unreal-open="" variant="default" disabled={busy} onClick={() => void run(button.act)}>
              {button.label}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
