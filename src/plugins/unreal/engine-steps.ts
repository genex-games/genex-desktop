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
  /** A Mac without the Unreal Genex makes games with: Epic's launcher, then the engine installed in it. */
  GetLauncher: "get-launcher",
  InstallEngine: "install-engine",
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
/** One row of the card; `command` is a line the user runs in Terminal themselves. */
export type UnrealStep = {
  you?: true;
  id: UnrealStepId;
  label: string;
  detail: string;
  done: boolean;
  action?: StepAction;
  command?: string;
};
/** The card: its heading, one line under it, its rows, and whether any step is still open. */
export type UnrealSteps = {
  title: string;
  intro: string;
  steps: UnrealStep[];
  open: boolean;
  secondary?: StepAction;
  doneSays?: string;
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
export const InstallCardAction = { GetUnreal: "get-unreal", Skip: "skip" } as const;

/** Where Epic's launcher installs an engine version, as its own English menus name the steps. */
const launcherInstallPath = (version: string) => `Library, + beside Engine Versions, ${version}, Install`;

/** The install card's words: the person's, then what the agent is told once the card closes. */
const INSTALL_WORDS = {
  Intro: () => t("Two steps before the agent can build in Unreal."),
  GetLauncher: () => t("Get the Epic Games Launcher"),
  GetLauncherDetail: () => t("Epic's free app that installs Unreal. Genex opens Epic's download page."),
  LauncherReady: () => t("The Epic Games Launcher is installed"),
  Download: () => t("Download"),
  Install: (version: string) => t("Install Unreal {version}", { version }),
  InstallDetail: (version: string) =>
    t("In the launcher, sign in, then {clickPath}. About 45 GB. Only you can sign in to Epic.", {
      clickPath: launcherInstallPath(version),
    }),
  OpenLauncher: () => t("Open the Epic Games Launcher"),
  Installed: (version: string) => t("Unreal {version} is installed", { version }),
  Skip: () => t("Don't use Unreal"),
  // The card's `doneSays`, which the agent reads: English.
  Done: (version: string) =>
    `Unreal ${version} is installed on this Mac. Go on with the person's game in Unreal: call unreal__new-game if it has no Unreal project yet.`,
  Skipped:
    "The person chose not to use Unreal for now (Don't use Unreal on the setup card). Offer in one line to build the game as a web game that plays in Genex instead, and do it if they agree.",
} as const;

/**
 * The setup card on a Mac without the Unreal Genex makes games with: Epic's launcher (Genex opens
 * Epic's download page), then Unreal installed in it, which only the person can do (it asks for
 * their Epic account). Closed, with what the agent is told, once Unreal is there or the person chose
 * Don't use Unreal.
 */
export function unrealInstallCard(state: {
  launcher: boolean;
  version: string;
  installed: boolean;
  skipped: boolean;
}): UnrealSteps {
  const { version } = state;
  const launcher: UnrealStep = state.launcher
    ? { id: UnrealStepId.GetLauncher, label: INSTALL_WORDS.LauncherReady(), detail: "", done: true }
    : {
        id: UnrealStepId.GetLauncher,
        label: INSTALL_WORDS.GetLauncher(),
        detail: INSTALL_WORDS.GetLauncherDetail(),
        done: false,
        action: { name: InstallCardAction.GetUnreal, args: {}, label: INSTALL_WORDS.Download() },
      };
  const engine: UnrealStep = state.installed
    ? { id: UnrealStepId.InstallEngine, label: INSTALL_WORDS.Installed(version), detail: "", done: true }
    : {
        id: UnrealStepId.InstallEngine,
        label: INSTALL_WORDS.Install(version),
        detail: INSTALL_WORDS.InstallDetail(version),
        done: false,
        you: true,
        ...(state.launcher
          ? { action: { name: InstallCardAction.GetUnreal, args: {}, label: INSTALL_WORDS.OpenLauncher() } }
          : {}),
      };
  const card = { title: WORDS.Title(), intro: INSTALL_WORDS.Intro(), steps: [launcher, engine] };
  if (state.installed) return { ...card, open: false, doneSays: INSTALL_WORDS.Done(version) };
  if (state.skipped) return { ...card, open: false, doneSays: INSTALL_WORDS.Skipped };
  return { ...card, open: true, secondary: { name: InstallCardAction.Skip, args: {}, label: INSTALL_WORDS.Skip() } };
}
