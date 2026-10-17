/**
 * The Roblox Studio setup rows: what the person can still do so agents can build in Studio, read
 * live so a step they finish is ticked without being told. One builder serves both the Set up
 * panel and the chat's steps card, so the card shows the panel's rows with the same words, ticks
 * and buttons; the panel adds, on the step that is next, its further choices, Studio's own click
 * path, a note and what Genex is waiting for.
 *
 * The rows are Studio on this computer, signing in, the Genex helper, Studio's MCP server and the
 * game's place. Signing in is only ever the person's: Genex shows where, never does it, and never
 * sees their password. A Studio that answers Genex has a place open, which it opens only signed in,
 * so that ticks it.
 */
import { RobloxAction } from "./actions.ts";
import { LIVE_DATA_CLICK_PATH, MCP_SWITCH_CLICK_PATH, MESSAGE } from "./words.ts";

/** Each step's id on the card and the panel. Wire values: the renderer and the panel key their rows by them. */
export const RobloxStepId = {
  Studio: "studio",
  SignIn: "sign-in",
  Helper: "helper",
  Mcp: "mcp",
  Place: "place",
} as const;
export type RobloxStepId = (typeof RobloxStepId)[keyof typeof RobloxStepId];

/** How a click path is written in words, and split into the clicks the panel draws. */
const CLICK_SEPARATOR = " › ";

/** A step's button: the plugin action it runs with its arguments, and its label. */
export type RobloxStepAction = { name: RobloxAction; args: Record<string, string>; label: string };
/** One row of the card. */
export type RobloxStep = { id: RobloxStepId; label: string; detail: string; done: boolean; action?: RobloxStepAction };
/** The card: its heading, one line under it, its rows, and whether any step is still open. */
export type RobloxSteps = { title: string; intro: string; steps: RobloxStep[]; open: boolean };

/** A warning a done step still carries, with Studio's own clicks to act on it. */
export type RobloxWarning = { text: string; clickPath: string[] };

/** One row as the panel draws it: the card's row, and what the panel adds on the step that is next. */
export interface RobloxRow extends RobloxStep {
  /** Further choices beside the row's button. */
  more?: RobloxStepAction[];
  /** Studio's own clicks for this step, one by one, for anyone who'd rather click them. */
  clickPath?: string[];
  /** A note under the buttons. */
  note?: string;
  /** What Genex is waiting for on this step. */
  waiting?: string;
  /** Genex is doing this step now; the detail says what. */
  busy?: boolean;
  warning?: RobloxWarning;
}

/** What the rows are read from. */
export interface RobloxStepFacts {
  installed: boolean;
  version?: string;
  /** Get Roblox Studio is under way, with what it is doing now. */
  getting?: { detail: string };
  /** Get Roblox Studio stopped before it finished, and why. */
  failed?: { detail: string };
  setUp: boolean;
  running: boolean;
  answering: boolean;
  /** The game the rows are for builds in a Roblox place. */
  linked: boolean;
  /** That place's name. */
  place?: string;
  /** This computer is a Mac, where macOS asks before Genex first uses the Documents folder. */
  mac?: boolean;
  /** Studio's MCP switch is on in an account's settings (unknown when absent). */
  mcpOn?: boolean;
  /** Genex can click in Studio for the person here (a Mac with computer control): Do it for me. */
  canClick?: boolean;
  /** The game's own Rojo project keeps its scripts in step. */
  rojo?: boolean;
  /** Studio can reach the game's live saved data, as the last play found. */
  liveData?: boolean;
}

const button = (name: RobloxAction, label: string): RobloxStepAction => ({ name, args: {}, label });
const clicks = (path: string) => path.split(CLICK_SEPARATOR);

function studioRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Studio;
  if (facts.installed) return { id, label: W.StudioDone(facts.version), detail: W.StudioDoneDetail, done: true };
  if (facts.getting)
    return {
      id,
      label: W.Getting,
      detail: facts.getting.detail,
      done: false,
      busy: true,
      action: button(RobloxAction.CancelGetStudio, W.Stop),
    };
  const detail = facts.failed?.detail ?? W.GetStudioDetail;
  return { id, label: W.GetStudio, detail, done: false, action: button(RobloxAction.GetStudio, W.GetStudio) };
}

function signInRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const row: RobloxRow = {
    id: RobloxStepId.SignIn,
    label: facts.answering ? W.SignedIn : W.SignIn,
    detail: W.SignInDetail,
    done: facts.answering,
  };
  const canOpen = facts.installed && !facts.running && !facts.getting;
  return canOpen ? { ...row, action: button(RobloxAction.OpenStudio, W.OpenStudio) } : row;
}

function helperRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Helper;
  if (facts.setUp) return { id, label: W.HelperDone, detail: W.HelperDoneDetail, done: true };
  const row: RobloxRow = { id, label: W.Helper, detail: W.HelperDetail, done: false };
  if (!facts.installed || facts.getting) return row;
  // Set up writes Studio's settings only while it is closed, so an open Studio is restarted for it.
  if (facts.running)
    return {
      ...row,
      detail: W.HelperStudioOpen,
      action: button(RobloxAction.RestartStudio, MESSAGE.Choice.RestartStudio),
    };
  const withSetUp = { ...row, action: button(RobloxAction.Setup, W.SetUp) };
  return facts.mac ? { ...withSetUp, note: MESSAGE.Setup.DocumentsNote } : withSetUp;
}

/**
 * Why an open Studio doesn't answer yet, in words: its switch is off, or it is on and Studio waits
 * for a place; either way a Studio on its sign-in screen answers nothing, so signing in comes first.
 */
function mcpWaitingDetail(facts: RobloxStepFacts): string {
  const W = MESSAGE.Steps;
  if (!facts.mcpOn) return `${W.McpOff} ${W.SignInFirst}`;
  return `${facts.linked ? W.McpOnWaiting : W.McpOnNoPlace} ${W.SignInFirst}`;
}

function mcpRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Mcp;
  if (facts.answering) return { id, label: W.McpDone, detail: W.McpDoneDetail, done: true };
  if (!facts.setUp) return { id, label: W.Mcp, detail: W.McpLater, done: false };
  if (!facts.running) return { id, label: W.Mcp, detail: W.McpWhenOpen, done: false };
  const restart = button(RobloxAction.RestartStudio, MESSAGE.Choice.RestartStudio);
  const row: RobloxRow = { id, label: W.Mcp, detail: mcpWaitingDetail(facts), done: false, waiting: W.Waiting };
  // The switch is on: clicking it can't help, and Studio waits for a sign-in or a place.
  if (facts.mcpOn) return { ...row, action: restart };
  const switchOff = { ...row, clickPath: clicks(MCP_SWITCH_CLICK_PATH) };
  // Only where Genex can click in Studio for the person; elsewhere their own clicks are the way.
  if (!facts.canClick) return { ...switchOff, action: restart };
  return { ...switchOff, action: button(RobloxAction.DoItForMe, MESSAGE.Choice.DoItForMe), more: [restart] };
}

function placeRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Place;
  if (!facts.linked) return { id, label: W.Place, detail: W.PlaceDetail, done: false };
  const row: RobloxRow = {
    id,
    label: facts.place ? W.PlaceDoneNamed(facts.place) : W.PlaceDone,
    detail: facts.rojo ? W.PlaceRojo : W.PlaceDoneDetail,
    done: true,
  };
  return facts.liveData ? { ...row, warning: { text: W.LiveData, clickPath: clicks(LIVE_DATA_CLICK_PATH) } } : row;
}

/** The rows for where Studio stands now, in the order the person meets them. */
export function robloxRows(facts: RobloxStepFacts): RobloxRow[] {
  return [studioRow(facts), signInRow(facts), helperRow(facts), mcpRow(facts), placeRow(facts)];
}

/**
 * The step to do next, the one the panel opens: Studio first, then Set up (which needs Studio
 * closed, so it comes before opening it), then opening Studio, its MCP server, and the place.
 * Undefined once every step is done.
 */
export function nowStep(facts: RobloxStepFacts): RobloxStepId | undefined {
  if (!facts.installed) return RobloxStepId.Studio;
  if (!facts.setUp) return RobloxStepId.Helper;
  if (!facts.running) return RobloxStepId.SignIn;
  if (!facts.answering) return RobloxStepId.Mcp;
  return facts.linked ? undefined : RobloxStepId.Place;
}

/** The card's extra words for a row: Studio's clicks, or where to choose the place (the panel is where). */
function cardHint(row: RobloxRow): string | undefined {
  if (row.clickPath) return MESSAGE.Steps.OrInStudio(row.clickPath.join(CLICK_SEPARATOR));
  return row.id === RobloxStepId.Place && !row.done ? MESSAGE.Steps.PlaceCardHint : undefined;
}

/** A row as the card shows it: the panel's words, with Studio's clicks or the place's button after them. */
function cardRow(row: RobloxRow): RobloxStep {
  const hint = cardHint(row);
  const detail = hint ? `${row.detail} ${hint}` : row.detail;
  const step: RobloxStep = { id: row.id, label: row.label, detail, done: row.done };
  return row.action ? { ...step, action: row.action } : step;
}

/** The card for where Studio stands now. */
export function robloxSteps(facts: RobloxStepFacts): RobloxSteps {
  const steps = robloxRows(facts).map(cardRow);
  const left = steps.filter((step) => !step.done).length;
  const intro = left === 0 ? MESSAGE.Steps.AllDone : MESSAGE.Steps.Intro(left);
  return { title: MESSAGE.Steps.Title, intro, steps, open: left > 0 };
}
