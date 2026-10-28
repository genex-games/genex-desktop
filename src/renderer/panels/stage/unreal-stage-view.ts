/**
 * What the Live tab's Unreal card says and offers for the step the plugin's `stage-status` names:
 * one line of where the game's own project stands and at most one button, the same step the Unreal
 * button's panel offers. Pure, so each step is tested without a DOM.
 */
import { UnrealStageStep, type UnrealStageStatus } from "../../unreal-game.ts";
import { t } from "../../../shared/i18n.ts";
import { UNREAL_WORDS } from "../../words.ts";

/**
 * What the card's button does: open the Unreal panel at Get Unreal (or to choose a project), set
 * up then open, set up only (Unreal has another project open), open, quit, or restart (quit, then
 * open this project: switching to it from another set-up project Unreal has open, or reopening
 * this one when Unreal has it open but it doesn't answer). Nothing quits a project Genex didn't
 * set up: the card says to open this one once Unreal is free.
 */
export const StageAct = {
  GetUnreal: "get-unreal",
  Panel: "panel",
  SetUpAndOpen: "set-up-and-open",
  SetUp: "set-up",
  Open: "open",
  Quit: "quit",
  Restart: "restart",
} as const;
export type StageAct = (typeof StageAct)[keyof typeof StageAct];

/**
 * The card's line, its button (none while nothing is to be pressed), whether the line runs a timer,
 * and a quieter second line when one helps (a first start's wait).
 */
export type StageView = {
  line: string;
  button: { label: string; act: StageAct } | null;
  timer: boolean;
  hint: string | null;
};

const WORDS = UNREAL_WORDS.stage;

/** Two sentences one after the other, run on as the reader's language does (a space between them in English). */
const thenSay = (first: string, second: string): string => t("{first} {second}", { first, second });

/** A line with no button. */
const said = (line: string, timer = false): StageView => ({ line, button: null, timer, hint: null });
/** A line with one button. */
const offers = (line: string, label: string, act: StageAct): StageView => ({
  line,
  button: { label, act },
  timer: false,
  hint: null,
});

/**
 * The steps a Loop using Unreal changes: those whose button would quit Unreal, and opening this
 * project once Unreal is free.
 */
const BUSY_STEPS: ReadonlySet<UnrealStageStep> = new Set([
  UnrealStageStep.QuitFirst,
  UnrealStageStep.Switch,
  UnrealStageStep.NotAnswering,
  UnrealStageStep.PortBlocked,
  UnrealStageStep.OpenWhenFree,
]);

/** The Loop using Unreal, in the card's words: this game's own, or another game's by its title. */
const loopWords = (run: NonNullable<UnrealStageStatus["busyRun"]>) =>
  run.here ? WORDS.busyHere : WORDS.busyRun(run.title);

/**
 * What holds Unreal while this project waits for it: the Loop using it, else the project it has
 * open by name, else another project it can't name.
 */
function holderWords(status: UnrealStageStatus): string {
  if (status.busyRun) return loopWords(status.busyRun);
  return status.holder ? WORDS.otherOpen(status.holder) : WORDS.anotherOpen;
}

/**
 * While a Loop is using Unreal, a step that would quit it offers no button: the card names the
 * Loop and what to do once it ends. A Loop on this very project keeps the project's own line first.
 */
function busyView(status: UnrealStageStatus, name: string): StageView | null {
  const run = status.busyRun;
  if (!run || !BUSY_STEPS.has(status.next)) return null;
  const who = loopWords(run);
  if (status.next === UnrealStageStep.QuitFirst) return said(thenSay(who, WORDS.setUpAfter(name)));
  if (run.project !== status.project?.file) return said(thenSay(who, WORDS.openAfter(name)));
  const state = status.next === UnrealStageStep.PortBlocked ? WORDS.portBlocked(name) : WORDS.notAnswering(name);
  return said(thenSay(thenSay(state, who), WORDS.leaveOpen));
}

/**
 * Set up: then open, unless Unreal has another project open (Genex keeps one Unreal, so it only
 * sets up, naming what holds Unreal); a port another app holds is why it needs setup again.
 */
function setUpView(status: UnrealStageStatus, name: string): StageView {
  if (status.editors > 0) {
    const then = status.busyRun ? WORDS.openAfterLoop : WORDS.openWhenFree;
    const line = thenSay(thenSay(holderWords(status), WORDS.setUpBeside(name)), then);
    return offers(line, WORDS.setUpButton, StageAct.SetUp);
  }
  return offers(status.portTaken ? WORDS.portTaken(name) : WORDS.setUp, WORDS.setUpAndOpen, StageAct.SetUpAndOpen);
}

/** Opening, timed; a first start also says it takes minutes. */
function startingView(status: UnrealStageStatus): StageView {
  return { ...said(WORDS.starting, true), hint: status.firstStart ? WORDS.startingHint : null };
}

/** A quit or restart, unless two editors run and a quit could reach the wrong project's. */
function quitting(status: UnrealStageStatus, line: string, label: string, act: StageAct): StageView {
  if (status.editors > 1) return said(thenSay(line, WORDS.severalEditors));
  return offers(line, label, act);
}

/** The card for a step that runs an editor without this project answering in it. */
function runningView(status: UnrealStageStatus, name: string): StageView {
  if (status.next === UnrealStageStep.Switch) {
    const other = status.openProject?.name ?? "";
    return quitting(status, WORDS.otherOpen(other), WORDS.switchTo(name), StageAct.Restart);
  }
  if (status.next === UnrealStageStep.PortBlocked)
    return quitting(status, WORDS.portBlocked(name), WORDS.restart, StageAct.Restart);
  if (status.next === UnrealStageStep.QuitFirst)
    return quitting(status, WORDS.quitFirst(name), WORDS.quit, StageAct.Quit);
  return quitting(status, WORDS.notAnswering(name), WORDS.restart, StageAct.Restart);
}

/**
 * The card for the game's project `name` at `status`. Before the plugin first answers it says and
 * offers nothing, so no guess shows and then vanishes; when it answered nothing readable, Open in
 * Unreal as before, which the plugin refuses with its own reason when that is wrong. A game with no
 * link to its Unreal project yet (`linked: false`) is told to choose it, not that it moved.
 */
export function stageView(
  status: UnrealStageStatus | null,
  name: string,
  { linked, answered = true }: { linked: boolean; answered?: boolean } = { linked: true },
): StageView {
  if (!status) return answered ? offers(UNREAL_WORDS.stageStatus, UNREAL_WORDS.open, StageAct.Open) : said("");
  const busy = busyView(status, name);
  if (busy) return busy;
  switch (status.next) {
    case UnrealStageStep.GetUnreal:
      return offers(WORDS.getUnreal, WORDS.getUnrealButton, StageAct.GetUnreal);
    case UnrealStageStep.Choose:
      return offers(linked ? WORDS.choose(name) : WORDS.chooseFirst, WORDS.panel, StageAct.Panel);
    case UnrealStageStep.SetUp:
      return setUpView(status, name);
    case UnrealStageStep.Open:
      return offers(UNREAL_WORDS.stageStatus, UNREAL_WORDS.open, StageAct.Open);
    case UnrealStageStep.Starting:
      return startingView(status);
    case UnrealStageStep.Connected:
      return said(WORDS.ready);
    case UnrealStageStep.OpenWhenFree:
      return said(thenSay(holderWords(status), WORDS.openProjectWhenFree(name)));
    case UnrealStageStep.Crashed:
      return said(WORDS.crashed(name));
    default:
      return runningView(status, name);
  }
}

/** A status as it arrived: the plugin's answer and when (0 before the first), so the opening timer runs on between asks. */
export type ReceivedStatus = { status: UnrealStageStatus | null; at: number };

/** How many games' last answers outlive their card; the oldest is forgotten past this. */
const KEPT_STATUSES_MAX = 32;
const keptStatuses = new Map<string, ReceivedStatus>();

/** Keep a game's last answer, so its card coming back to the stage starts from it instead of from nothing. */
export function keepStageStatus(game: string, received: ReceivedStatus): void {
  keptStatuses.delete(game);
  keptStatuses.set(game, received);
  while (keptStatuses.size > KEPT_STATUSES_MAX) {
    const oldest = keptStatuses.keys().next().value;
    if (oldest !== undefined) keptStatuses.delete(oldest);
  }
}

/** The game's last answer while its card was on the stage, or null before it ever answered. */
export function keptStageStatus(game: string): ReceivedStatus | null {
  return keptStatuses.get(game) ?? null;
}

/** A restart waiting for Unreal to close before it opens a game's project: which game, and until when. */
export type ReopenMark = { game: string; until: number };

/** What a restart's mark does on a new status: keep waiting, open the project now, or give up. */
export const ReopenStep = { Wait: "wait", Open: "open", Drop: "drop" } as const;
export type ReopenStep = (typeof ReopenStep)[keyof typeof ReopenStep];

/**
 * A restart opens the project once the status says no editor runs any more and opening is the step.
 * It gives up when its wait runs out, when Unreal closed but opening isn't the step (the person
 * cancelled the quit, or another app holds the port), and when the stage now shows another game, so
 * a restart never opens a game the person moved away from.
 */
export function reopenStep(
  mark: ReopenMark | null,
  game: string,
  status: UnrealStageStatus | null,
  now: number,
): ReopenStep {
  if (!mark) return ReopenStep.Wait;
  if (mark.game !== game || now > mark.until) return ReopenStep.Drop;
  if (!status || status.editors !== 0) return ReopenStep.Wait;
  return status.next === UnrealStageStep.Open ? ReopenStep.Open : ReopenStep.Drop;
}
