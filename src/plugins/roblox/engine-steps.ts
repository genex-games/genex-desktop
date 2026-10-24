/**
 * The Roblox Studio setup rows: what the person can still do so agents can build in Studio, read
 * live so a step they finish is ticked without being told. One builder serves both the Set up
 * panel and the chat's steps card, so the card shows the panel's rows with the same words, ticks
 * and buttons; the panel adds, on the step that is next, its further choices, Studio's own click
 * path, a note and what Genex is waiting for.
 *
 * The rows are Studio on this computer, signing in, the Genex helper, Studio's MCP server and the
 * game's place. Signing in is only ever the person's, so the card marks it theirs: Genex shows
 * where, never does it, and never sees their password. A Studio that answers Genex has a place
 * open, which it opens only signed in, so that ticks it. Every other step is Genex's: the card's
 * Set it up for me does whichever it can now, and the agent is told once all are done.
 */
import { RobloxAction } from "./actions.ts";
import { SETUP_PROMPTS } from "./setup-prompts.ts";
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
/** One row of the card: `you` marks the person's own step (signing in), `working` one Genex is doing now. */
export type RobloxStep = {
  id: RobloxStepId;
  label: string;
  detail: string;
  done: boolean;
  action?: RobloxStepAction;
  you?: true;
  working?: true;
};
/**
 * The card: its heading, one line under it, its rows, whether any step is still open, its own
 * button for every step Genex can do now, and what the agent is told once all are done or when Get
 * Roblox Studio stopped by itself.
 */
export type RobloxSteps = {
  title: string;
  intro: string;
  steps: RobloxStep[];
  open: boolean;
  primary?: RobloxStepAction;
  doneSays?: string;
  stuckSays?: string;
};

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
  /** Get Roblox Studio is under way, with what it is doing now, and whether that is waiting for the sign-in. */
  getting?: { detail: string; signingIn?: boolean };
  /** Get Roblox Studio stopped before it finished, and why; `stopped` when the person stopped it. */
  failed?: { detail: string; stopped?: boolean };
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
  if (facts.installed) return { id, label: W.StudioDone(facts.version), detail: W.StudioDoneDetail(), done: true };
  if (facts.getting)
    return {
      id,
      label: W.Getting(),
      detail: facts.getting.detail,
      done: false,
      busy: true,
      action: button(RobloxAction.CancelGetStudio, W.Stop()),
    };
  const detail = facts.failed?.detail ?? W.GetStudioDetail();
  return { id, label: W.GetStudio(), detail, done: false, action: button(RobloxAction.GetStudio, W.GetStudio()) };
}

function signInRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const done = facts.answering;
  const row: RobloxRow = {
    id: RobloxStepId.SignIn,
    label: done ? W.SignedIn() : W.SignIn(),
    detail: facts.getting?.signingIn ? facts.getting.detail : W.SignInDetail(),
    done,
    ...(done ? {} : { you: true as const }),
  };
  const canOpen = facts.installed && !facts.running && !facts.getting;
  return canOpen ? { ...row, action: button(RobloxAction.OpenStudio, W.OpenStudio()) } : row;
}

/** Get Roblox Studio sets Studio up only once its installer's Studio is here and the person has signed in there. */
const waitsForSignIn = (facts: RobloxStepFacts) =>
  Boolean(facts.getting) && (!facts.installed || facts.getting?.signingIn === true);

function helperRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Helper;
  if (facts.setUp) return { id, label: W.HelperDone(), detail: W.HelperDoneDetail(), done: true };
  const row: RobloxRow = { id, label: W.Helper(), detail: W.HelperDetail(), done: false };
  if (waitsForSignIn(facts)) return { ...row, detail: W.AfterSignIn() };
  // Get Roblox Studio sets it up now, after the sign-in.
  if (facts.getting) return { ...row, detail: facts.getting.detail, busy: true };
  if (!facts.installed) return row;
  // Set up writes Studio's settings only while it is closed, so an open Studio is restarted for it.
  if (facts.running)
    return {
      ...row,
      detail: W.HelperStudioOpen(),
      action: button(RobloxAction.RestartStudio, MESSAGE.Choice.RestartStudio()),
    };
  const withSetUp = { ...row, action: button(RobloxAction.Setup, W.SetUp()) };
  return facts.mac ? { ...withSetUp, note: MESSAGE.Setup.DocumentsNote() } : withSetUp;
}

/**
 * Why an open Studio doesn't answer yet, in words: its switch is off, or it is on and Studio waits
 * for a place; either way a Studio on its sign-in screen answers nothing, so signing in comes first.
 */
function mcpWaitingDetail(facts: RobloxStepFacts): string {
  const W = MESSAGE.Steps;
  if (!facts.mcpOn) return `${W.McpOff()} ${W.SignInFirst()}`;
  return `${facts.linked ? W.McpOnWaiting() : W.McpOnNoPlace()} ${W.SignInFirst()}`;
}

function mcpRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Mcp;
  if (facts.answering) return { id, label: W.McpDone(), detail: W.McpDoneDetail(), done: true };
  if (!facts.setUp)
    return { id, label: W.Mcp(), detail: waitsForSignIn(facts) ? W.AfterSignIn() : W.McpLater(), done: false };
  if (!facts.running) return { id, label: W.Mcp(), detail: W.McpWhenOpen(), done: false };
  const restart = button(RobloxAction.RestartStudio, MESSAGE.Choice.RestartStudio());
  const row: RobloxRow = { id, label: W.Mcp(), detail: mcpWaitingDetail(facts), done: false, waiting: W.Waiting() };
  // The switch is on: clicking it can't help, and Studio waits for a sign-in or a place.
  if (facts.mcpOn) return { ...row, action: restart };
  const switchOff = { ...row, clickPath: clicks(MCP_SWITCH_CLICK_PATH) };
  // Only where Genex can click in Studio for the person; elsewhere their own clicks are the way.
  if (!facts.canClick) return { ...switchOff, action: restart };
  return { ...switchOff, action: button(RobloxAction.DoItForMe, MESSAGE.Choice.DoItForMe()), more: [restart] };
}

function placeRow(facts: RobloxStepFacts): RobloxRow {
  const W = MESSAGE.Steps;
  const id = RobloxStepId.Place;
  if (!facts.linked) return { id, label: W.Place(), detail: W.PlaceDetail(), done: false };
  const row: RobloxRow = {
    id,
    label: facts.place ? W.PlaceDoneNamed(facts.place) : W.PlaceDone(),
    detail: facts.rojo ? W.PlaceRojo() : W.PlaceDoneDetail(),
    done: true,
  };
  return facts.liveData ? { ...row, warning: { text: W.LiveData(), clickPath: clicks(LIVE_DATA_CLICK_PATH) } } : row;
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
  if (facts.getting?.signingIn) return RobloxStepId.SignIn;
  if (!facts.setUp) return RobloxStepId.Helper;
  if (!facts.running) return RobloxStepId.SignIn;
  if (!facts.answering) return RobloxStepId.Mcp;
  return facts.linked ? undefined : RobloxStepId.Place;
}

/** The card's extra words for a row: Studio's clicks, or where to choose the place (the panel is where). */
function cardHint(row: RobloxRow): string | undefined {
  if (row.clickPath) return MESSAGE.Steps.OrInStudio(row.clickPath.join(CLICK_SEPARATOR));
  return row.id === RobloxStepId.Place && !row.done ? MESSAGE.Steps.PlaceCardHint() : undefined;
}

/** A row as the card shows it: the panel's words, with Studio's clicks or the place's button after them. */
function cardRow(row: RobloxRow): RobloxStep {
  const hint = cardHint(row);
  const detail = hint ? `${row.detail} ${hint}` : row.detail;
  const step: RobloxStep = {
    id: row.id,
    label: row.label,
    detail,
    done: row.done,
    ...(row.you ? { you: true as const } : {}),
    ...(row.busy ? { working: true as const } : {}),
  };
  return row.action ? { ...step, action: row.action } : step;
}

/**
 * Whether Genex has a step it can do now (Set it up for me): none while it gets Studio, and never
 * signing in. A closed Studio, set up for a game with its place, waits for the person to open it and
 * sign in, which the sign-in step's Open Studio offers.
 */
function genexCanDo(facts: RobloxStepFacts): boolean {
  if (facts.getting) return false;
  if (!facts.installed || !facts.setUp || !facts.linked) return true;
  return facts.running && !facts.answering && !facts.mcpOn;
}

/** The line under the heading: how many steps are left and, while signing in is one, that it alone is the person's. */
function introOf(steps: RobloxStep[], left: number): string {
  if (left === 0) return MESSAGE.Steps.AllDone();
  const signIn = steps.find((step) => step.id === RobloxStepId.SignIn);
  return signIn?.done === false
    ? `${MESSAGE.Steps.Intro(left)} ${MESSAGE.Steps.SignInYours()}`
    : MESSAGE.Steps.Intro(left);
}

/** The card for where Studio stands now. */
export function robloxSteps(facts: RobloxStepFacts): RobloxSteps {
  const steps = robloxRows(facts).map(cardRow);
  const left = steps.filter((step) => !step.done).length;
  const stuck = facts.failed && !facts.failed.stopped ? SETUP_PROMPTS.GetStudioStopped(facts.failed.detail) : undefined;
  return {
    title: MESSAGE.Steps.Title(),
    intro: introOf(steps, left),
    steps,
    open: left > 0,
    ...(genexCanDo(facts) ? { primary: button(RobloxAction.FinishSetup, MESSAGE.Steps.ForMe()) } : {}),
    doneSays: SETUP_PROMPTS.Ready,
    ...(stuck ? { stuckSays: stuck } : {}),
  };
}
