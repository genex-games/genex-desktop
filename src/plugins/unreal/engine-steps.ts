/**
 * The steps card for Unreal: what the user can still do to make the agent's Unreal work better,
 * read live so the card notices a step done without being told. Xcode is recommended, never
 * required: without it Genex builds in Blueprints only. The card is quiet, not a
 * permission card; it appears in a game's chat when new-game makes its Unreal project while a step
 * is open, and the agent can show it again when C++ would clearly help.
 */
import { t } from "../../shared/i18n.ts";
import { type XcodeRange, type XcodeStatus, XcodeState } from "./xcode.ts";

/** Each step's id on the card. Wire values: the renderer keys its rows by them. */
export const UnrealStepId = {
  SetUp: "set-up",
  InstallXcode: "install-xcode",
  OpenXcode: "open-xcode",
  SelectXcode: "select-xcode",
  UpdateXcode: "update-xcode",
  AddXcode: "add-xcode",
  /** A computer without the Unreal Genex makes games with: Epic's launcher, then the engine installed in it. */
  GetLauncher: "get-launcher",
  InstallEngine: "install-engine",
  /** Windows without the Visual C++ runtime Unreal's editor needs (Epic's launcher normally installs it). */
  InstallRuntime: "install-runtime",
} as const;
export type UnrealStepId = (typeof UnrealStepId)[keyof typeof UnrealStepId];

/**
 * What the `get-xcode` action does: open Xcode's App Store page, open Xcode itself, or open Apple's
 * developer downloads for an older Xcode beside one too new for the engine.
 */
export const XcodeStep = { Install: "install", Open: "open", Downloads: "downloads" } as const;
export type XcodeStep = (typeof XcodeStep)[keyof typeof XcodeStep];

/** The plugin action a step's button runs. */
export const GET_XCODE_ACTION = "get-xcode";

/** A step's button: the plugin action it runs with its arguments, and its label. */
export type StepAction = { name: string; args: Record<string, string>; label: string };
/** One row of the card; `command` is a line the user runs in Terminal themselves; `working` one under way. */
export type UnrealStep = {
  you?: true;
  working?: true;
  id: UnrealStepId;
  label: string;
  detail: string;
  done: boolean;
  action?: StepAction;
  command?: string;
};
/** The card: its heading, one line under it, its rows, whether any step is still open, and its buttons. */
export type UnrealSteps = {
  title: string;
  intro: string;
  steps: UnrealStep[];
  open: boolean;
  primary?: StepAction;
  secondary?: StepAction;
  doneSays?: string;
  /** What the agent is told once when a step Genex ran for the person stopped. */
  stuckSays?: string;
};

/** The card's words, in the person's language. */
const WORDS = {
  Title: () => t("Unreal setup"),
  /** The open steps counted in words, which is all the card ever holds (three at most). */
  Intro: (open: number) =>
    t(
      "{open, plural, =1 {One step left so the agent can add C++ to this game.} =2 {Two steps left so the agent can add C++ to this game.} =3 {Three steps left so the agent can add C++ to this game.} other {# steps left so the agent can add C++ to this game.}}",
      { open },
    ),
  AllDone: () => t("Everything Unreal needs from you is done."),
  SetUp: (engine: string, project: string) => t("Unreal {engine} is set up for {project}", { engine, project }),
  SetUpDetail: () => t("Agents can edit and play it from this chat."),
  InstallXcode: () => t("Install Xcode"),
  InstallDetail: () =>
    t(
      "Recommended. Lets the agent add C++ to this game; without it, it builds in Blueprints. Free from the App Store.",
    ),
  GetXcode: () => t("Get Xcode"),
  OpenXcode: () => t("Open Xcode once"),
  OpenDetail: () => t("It finishes its own setup the first time it opens."),
  OpenButton: () => t("Open Xcode"),
  SelectXcode: () => t("Use Xcode for builds"),
  SelectDetail: () => t("Xcode is installed but not in use. Run this in Terminal; it asks for your password:"),
  UpdateXcode: (version: string | null) =>
    version ? t("Update Xcode (this Mac has {version})", { version }) : t("Update Xcode"),
  UpdateDetail: (engine: string, min: string, max: string) =>
    t("Unreal {engine} builds with Xcode {min} to {max}.", { engine, min, max }),
  UpdateButton: () => t("Open App Store"),
  AddXcode: (major: string) => t("Add Xcode {major}", { major }),
  AddDetail: (engine: string, range: XcodeRange, version: string | null) =>
    t(
      "Unreal {engine} builds with Xcode {min} to {max}. Keep Xcode {version} and add Xcode {wanted} from Apple's downloads: put it in Applications beside Xcode {current}; this card then shows the one command to select it.",
      {
        engine,
        min: range.min,
        max: range.max,
        version: version ?? "",
        wanted: majorOf(range.max),
        current: majorOf(version ?? ""),
      },
    ),
  AddButton: () => t("Open Apple's downloads"),
  XcodeReady: (version: string | null) => (version ? t("Xcode {version} is ready", { version }) : t("Xcode is ready")),
  ReadyDetail: () => t("The agent can add C++ to this game."),
} as const;

const getXcode = (step: XcodeStep, label: string): StepAction => ({ name: GET_XCODE_ACTION, args: { step }, label });

/** A version's first number, as people name an Xcode: "27.9" is Xcode 27. */
const majorOf = (version: string): string => version.split(".")[0] ?? version;

/**
 * The row for an Xcode outside the engine's range: too old, update it from the App Store; too new,
 * keep it and add one the engine builds with from Apple's downloads (the App Store has only the newest).
 */
function unsupportedStep(xcode: XcodeStatus, engine: string): UnrealStep {
  const range = xcode.supported;
  if (xcode.tooNew && range)
    return {
      id: UnrealStepId.AddXcode,
      label: WORDS.AddXcode(majorOf(range.max)),
      detail: WORDS.AddDetail(engine, range, xcode.version),
      done: false,
      action: getXcode(XcodeStep.Downloads, WORDS.AddButton()),
    };
  return {
    id: UnrealStepId.UpdateXcode,
    label: WORDS.UpdateXcode(xcode.version),
    detail: range ? WORDS.UpdateDetail(engine, range.min, range.max) : "",
    done: false,
    action: getXcode(XcodeStep.Install, WORDS.UpdateButton()),
  };
}

/** The Xcode rows for where Xcode stands; none off a Mac. */
function xcodeSteps(xcode: XcodeStatus, engine: string): UnrealStep[] {
  const installed = xcode.state !== XcodeState.Missing;
  const install: UnrealStep = {
    id: UnrealStepId.InstallXcode,
    label: WORDS.InstallXcode(),
    detail: WORDS.InstallDetail(),
    done: installed,
    ...(installed ? {} : { action: getXcode(XcodeStep.Install, WORDS.GetXcode()) }),
  };
  const open: UnrealStep = {
    id: UnrealStepId.OpenXcode,
    label: WORDS.OpenXcode(),
    detail: WORDS.OpenDetail(),
    done: false,
    ...(installed ? { action: getXcode(XcodeStep.Open, WORDS.OpenButton()) } : {}),
  };
  switch (xcode.state) {
    case XcodeState.NotApplicable:
      return [];
    case XcodeState.Missing:
    case XcodeState.FirstLaunch:
      return [install, open];
    case XcodeState.NotSelected:
      return [
        {
          id: UnrealStepId.SelectXcode,
          label: WORDS.SelectXcode(),
          detail: WORDS.SelectDetail(),
          done: false,
          command: xcode.command ?? "",
        },
      ];
    case XcodeState.Unsupported:
      return [unsupportedStep(xcode, engine)];
    default:
      return [
        {
          id: UnrealStepId.InstallXcode,
          label: WORDS.XcodeReady(xcode.version),
          detail: WORDS.ReadyDetail(),
          done: true,
        },
      ];
  }
}

/**
 * The card for a game whose Unreal project is `project` (its name; null before one is set up), on
 * an engine of version `engine`, with Xcode where `xcode` says.
 */
export function unrealSteps(project: string | null, engine: string, xcode: XcodeStatus): UnrealSteps {
  const setUp: UnrealStep[] = project
    ? [{ id: UnrealStepId.SetUp, label: WORDS.SetUp(engine, project), detail: WORDS.SetUpDetail(), done: true }]
    : [];
  const steps = [...setUp, ...xcodeSteps(xcode, engine)];
  const open = steps.filter((step) => !step.done).length;
  return { title: WORDS.Title(), intro: open ? WORDS.Intro(open) : WORDS.AllDone(), steps, open: open > 0 };
}

/** The plugin actions the install card's buttons run. Wire values: the manifest declares them. */
export const InstallCardAction = {
  GetUnreal: "get-unreal",
  Skip: "skip",
  /** Do it for me: the next open step Genex can do itself (`backend.ts`). */
  ForMe: "install-for-me",
  /** Stops what Do it for me is installing. */
  StopForMe: "stop-install",
} as const;

/** What Do it for me can do here for each step; a step it can't do is the person's alone. */
export type ForMeReach = {
  /** Genex downloads Epic's launcher from Epic and installs it (Windows). */
  launcher: boolean;
  /** The game's chat installs Unreal in the launcher with the person's computer control. */
  engine: boolean;
  /** Genex installs Microsoft's Visual C++ runtime from the engine's own copy (Windows). */
  runtime: boolean;
};

/** The step Do it for me is installing now, and where it stands in the person's words. */
export type ForMeWork = {
  step: typeof UnrealStepId.GetLauncher | typeof UnrealStepId.InstallRuntime;
  message: string;
};

/** What the install card is drawn from. */
export type InstallCardState = {
  launcher: boolean;
  version: string;
  installed: boolean;
  skipped: boolean;
  /** Whether Windows has the Visual C++ runtime Unreal's editor loads; false only where it is missing. */
  runtime?: boolean;
  forMe?: ForMeReach;
  working?: ForMeWork;
};

/** Where Epic's launcher installs an engine version, as its own English menus name the steps. */
export const launcherInstallPath = (version: string) => `Library, + beside Engine Versions, ${version}, Install`;

/** The install card's words: the person's, then what the agent is told once the card closes. */
const INSTALL_WORDS = {
  Intro: (steps: number) =>
    t(
      "{steps, plural, =2 {Two steps before the agent can build in Unreal.} =3 {Three steps before the agent can build in Unreal.} other {# steps before the agent can build in Unreal.}}",
      { steps },
    ),
  GetLauncher: () => t("Get the Epic Games Launcher"),
  GetLauncherDetail: () => t("Epic's free app that installs Unreal. Genex opens Epic's download page."),
  GetLauncherForMe: () =>
    t(
      "Epic's free app that installs Unreal. Do it for me downloads it from Epic and installs it: choose Yes when Windows asks.",
    ),
  LauncherReady: () => t("The Epic Games Launcher is installed"),
  Download: () => t("Download"),
  Install: (version: string) => t("Install Unreal {version}", { version }),
  InstallDetail: (version: string) =>
    t("In the launcher, sign in, then {clickPath}. About 45 GB. Only you can sign in to Epic.", {
      clickPath: launcherInstallPath(version),
    }),
  InstallForMe: () =>
    t(
      "Do it for me opens the launcher, and this chat installs it there with computer control. About 45 GB. Only you sign in to Epic, when it asks.",
    ),
  OpenLauncher: () => t("Open the Epic Games Launcher"),
  Installed: (version: string) => t("Unreal {version} is installed", { version }),
  Runtime: () => t("Install Microsoft's Visual C++ runtime"),
  RuntimeDetail: () =>
    t(
      "Unreal's editor needs it to start. Run vc_redist.x64.exe from Unreal's Engine › Extras › Redist › en-us folder.",
    ),
  RuntimeForMe: () =>
    t(
      "Unreal's editor needs it to start, and it isn't on this computer. Do it for me runs Unreal's own copy: choose Yes when Windows asks.",
    ),
  ForMe: () => t("Do it for me"),
  Stop: () => t("Stop"),
  Skip: () => t("Don't use Unreal"),
  // The card's `doneSays`, which the agent reads: English.
  Done: (version: string) =>
    `Unreal ${version} is installed on this computer. Go on with the person's game in Unreal: call unreal__new-game if it has no Unreal project yet.`,
  Skipped:
    "The person chose not to use Unreal for now (Don't use Unreal on the setup card). Offer in one line to build the game as a web game that plays in Genex instead, and do it if they agree.",
} as const;

const button = (name: string, label: string): StepAction => ({ name, args: {}, label });

/** A step Do it for me is installing: under way, with where it stands as its detail. */
function withWork(step: UnrealStep, working: ForMeWork | undefined): UnrealStep {
  return working?.step === step.id ? { ...step, done: false, working: true, detail: working.message } : step;
}

/** Whether the launcher's step is done: the launcher is here, or Unreal is, which only the launcher installs. */
const launcherDone = (state: InstallCardState) => state.launcher || state.installed;

function launcherStep(state: InstallCardState): UnrealStep {
  if (launcherDone(state))
    return { id: UnrealStepId.GetLauncher, label: INSTALL_WORDS.LauncherReady(), detail: "", done: true };
  const forMe = state.forMe?.launcher === true;
  const step: UnrealStep = {
    id: UnrealStepId.GetLauncher,
    label: INSTALL_WORDS.GetLauncher(),
    detail: forMe ? INSTALL_WORDS.GetLauncherForMe() : INSTALL_WORDS.GetLauncherDetail(),
    done: false,
    action: button(InstallCardAction.GetUnreal, INSTALL_WORDS.Download()),
  };
  return withWork(step, state.working);
}

function engineStep(state: InstallCardState): UnrealStep {
  const { version } = state;
  if (state.installed)
    return { id: UnrealStepId.InstallEngine, label: INSTALL_WORDS.Installed(version), detail: "", done: true };
  const forMe = state.forMe?.engine === true;
  return {
    id: UnrealStepId.InstallEngine,
    label: INSTALL_WORDS.Install(version),
    detail: forMe ? INSTALL_WORDS.InstallForMe() : INSTALL_WORDS.InstallDetail(version),
    done: false,
    ...(forMe ? {} : { you: true as const }),
    ...(state.launcher ? { action: button(InstallCardAction.GetUnreal, INSTALL_WORDS.OpenLauncher()) } : {}),
  };
}

function runtimeStep(state: InstallCardState): UnrealStep {
  const forMe = state.forMe?.runtime === true;
  const step: UnrealStep = {
    id: UnrealStepId.InstallRuntime,
    label: INSTALL_WORDS.Runtime(),
    detail: forMe ? INSTALL_WORDS.RuntimeForMe() : INSTALL_WORDS.RuntimeDetail(),
    done: false,
  };
  return withWork(step, state.working);
}

/** Whether Do it for me can do the first step still open. */
function canDoNext(state: InstallCardState, runtimeMissing: boolean): boolean {
  const reach = state.forMe;
  if (!reach) return false;
  if (!launcherDone(state)) return reach.launcher;
  if (!state.installed) return reach.engine;
  return runtimeMissing && reach.runtime;
}

/**
 * The setup card on a computer without the Unreal Genex makes games with: Epic's launcher, then
 * Unreal installed in it, then (on Windows, only when it is missing) Microsoft's Visual C++ runtime
 * the editor needs. Do it for me does the next of those it can (`forMe`): Genex installs the launcher
 * and the runtime itself, and the game's chat installs Unreal in the launcher with computer control;
 * only signing in to Epic stays the person's. Without it, the launcher's step opens Epic's download
 * page and Unreal is the person's to install. While an install runs, its step says where it stands
 * and Stop replaces Don't use Unreal. Closed, with what the agent is told, once everything is there or
 * the person chose Don't use Unreal.
 */
export function unrealInstallCard(state: InstallCardState): UnrealSteps {
  const runtimeMissing = state.installed && state.runtime === false;
  const steps = [launcherStep(state), engineStep(state), ...(runtimeMissing ? [runtimeStep(state)] : [])];
  const card = { title: WORDS.Title(), intro: INSTALL_WORDS.Intro(steps.length), steps };
  if (state.installed && !runtimeMissing) return { ...card, open: false, doneSays: INSTALL_WORDS.Done(state.version) };
  if (state.skipped) return { ...card, open: false, doneSays: INSTALL_WORDS.Skipped };
  if (state.working)
    return { ...card, open: true, secondary: button(InstallCardAction.StopForMe, INSTALL_WORDS.Stop()) };
  const skip = button(InstallCardAction.Skip, INSTALL_WORDS.Skip());
  if (!canDoNext(state, runtimeMissing)) return { ...card, open: true, secondary: skip };
  return { ...card, open: true, primary: button(InstallCardAction.ForMe, INSTALL_WORDS.ForMe()), secondary: skip };
}
