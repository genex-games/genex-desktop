/**
 * The Unity setup card a game's chat shows while this computer can't make Unity games yet: Unity
 * Hub, a signed-in Unity account with its license, and a Unity 6 editor. Its rows are read live,
 * so a step done in Hub itself is ticked without being told, and while Genex installs Hub or Unity
 * for the person the row says how far it got. Signing in is the one step only the person can do.
 * Reading the card only looks: which apps and license files exist, and the install under way.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import { type EditorsEnv, findEditors, findHub, type UnityEditor } from "./editors.ts";
import type { PluginSetupButton, PluginSetupCard, PluginSetupStep } from "../../plugin-sdk/index.d.ts";
import { t } from "../../shared/i18n.ts";
import { newestUnity6 } from "./readiness.ts";

/** Each row's id on the card. Wire values: the chat keys its rows by them. */
export const SetupStepId = { GetHub: "get-hub", SignIn: "sign-in", InstallUnity: "install-unity" } as const;
export type SetupStepId = (typeof SetupStepId)[keyof typeof SetupStepId];

/** The plugin actions the card's buttons run. Wire values: the manifest declares them. */
export const SetupAction = {
  Steps: "steps",
  GetHub: "get-hub",
  OpenHub: "open-hub",
  InstallUnity: "install-unity",
  SetUp: "set-up",
  Stop: "stop",
  Skip: "skip",
} as const;
export type SetupAction = (typeof SetupAction)[keyof typeof SetupAction];

/**
 * What Genex is doing for the person: installing Unity Hub, waiting for their sign-in in Hub (Do it
 * for me), or installing a Unity editor through Hub. Wire values.
 */
export const JobKind = { Hub: "hub", SignIn: "sign-in", Editor: "editor" } as const;
export type JobKind = (typeof JobKind)[keyof typeof JobKind];

/** Where an install stands. Wire values: kept in the plugin's storage. */
export const JobState = { Running: "running", Failed: "failed" } as const;
export type JobState = (typeof JobState)[keyof typeof JobState];

/** An install Genex started for the person: what, how far (bytes or percent), or why it stopped. */
export interface InstallJob {
  kind: JobKind;
  state: JobState;
  /** The Unity version an editor install installs. */
  version?: string;
  done?: number;
  total?: number;
  percent?: number;
  /** What Hub says it is doing (downloading, installing…), in its own word. */
  phase?: string;
  /** Why it stopped, in the person's words. */
  why?: string;
  /** A stop that Unity Hub's own window may still get past (the agent can, with computer control). */
  inHub?: true;
  /** The person stopped it themselves: nothing to tell the agent. */
  stopped?: true;
}

/** What the card reads about this computer. */
export interface SetupFacts {
  hub: string | undefined;
  /** Unity's license is on this computer, which signing in to Hub adds. */
  signedIn: boolean;
  /** The newest Unity 6 installed, the one new games are made with. */
  editor: UnityEditor | undefined;
  /** The install under way, or the last one that stopped. */
  job: InstallJob | null;
}

/** A row's button: one of the setup actions, and its label. */
type Button = PluginSetupButton & { name: SetupAction };
/** One row as the chat's steps card reads it. */
export type SetupRow = PluginSetupStep & { id: SetupStepId; action?: Button };
/** The card as the chat reads it. */
export type SetupCard = PluginSetupCard & { steps: SetupRow[] };

/** About how much room a Unity 6 editor takes once installed. */
export const UNITY_SIZE_GB = 12;
const MEGABYTE = 1024 * 1024;

/** The card's words for the person, said in the language of the moment the card is read. */
const WORDS = {
  Title: () => t("Unity setup"),
  /** The open steps, in words up to three, which is all the card ever holds. */
  Intro: (open: number) =>
    t(
      "{count, plural, =0 {} =1 {One step} =2 {Two steps} =3 {Three steps} other {# steps}} before the agent can build in Unity.",
      { count: open },
    ),
  Working: () => t("Genex is doing this. You'll only be asked to sign in."),
  GetHub: () => t("Get Unity Hub"),
  GetHubDetail: () => t("Unity's free app that installs Unity."),
  HubReady: () => t("Unity Hub is installed"),
  Download: () => t("Download"),
  DownloadingHub: () => t("Downloading Unity Hub"),
  InstallingHub: () => t("Installing Unity Hub"),
  Megabytes: (done: number, total: number) =>
    t("{done} of {total} MB", { done: Math.round(done / MEGABYTE), total: Math.round(total / MEGABYTE) }),
  SignIn: () => t("Sign in to Unity"),
  SignInDetail: () =>
    t(
      "In Unity Hub, sign in and add a Unity license (Personal is free if Unity's terms allow it for you). Unity's own terms cover its apps and your account. Only you type your password.",
    ),
  SignedIn: () => t("Signed in to Unity"),
  OpenHub: () => t("Open Unity Hub"),
  YourTurn: () => t("Sign in to Unity Hub"),
  YourTurnDetail: () =>
    t(
      "Type your email and password in the Unity Hub window and add a Unity license (Personal is free if Unity's terms allow it for you). Genex goes on by itself once you're in.",
    ),
  ShowHub: () => t("Show Unity Hub"),
  InstallUnity: () => t("Install Unity 6"),
  InstallDetail: () => t("About {size} GB. Genex installs it through Unity Hub.", { size: UNITY_SIZE_GB }),
  Install: () => t("Install"),
  Installing: (version: string) => t("Installing Unity {version}", { version }),
  Percent: (percent: number) => t("{percent}%", { percent: Math.round(percent) }),
  /** Unity Hub's own word for what it is doing, as it says it. */
  PhaseOnly: (phase: string) => `${phase.charAt(0).toLocaleUpperCase()}${phase.slice(1)}…`,
  Phase: (phase: string, percent: number) =>
    t("{phase} · {percent}%", {
      phase: `${phase.charAt(0).toLocaleUpperCase()}${phase.slice(1)}`,
      percent: Math.round(percent),
    }),
  Starting: () => t("Starting…"),
  Installed: (version: string) => t("Unity {version} is installed", { version }),
  TryAgain: () => t("Try again"),
  DoItForMe: () => t("Do it for me"),
  Stop: () => t("Stop"),
  Skip: () => t("Don't use Unity"),
} as const;

/** What the agent is told once the card closes or a step stops: the agent's words, never translated. */
const TOLD = {
  Skipped:
    "The person chose not to use Unity for now (Don't use Unity on the setup card). Offer in one line to build the game as a web game that plays in Genex instead, and do it if they agree.",
  Stuck: (why: string) => `Genex's install of Unity for the person stopped: ${why}`,
  InHub: (version: string) =>
    ` If you have the desktop tool (computer control), finish it in Unity Hub's own window: open Unity Hub, go to Installs, choose Install Editor and install Unity ${version}, then wait while Hub installs it; the setup card notices when it is done. Otherwise tell the person in one line what stopped and that Try again is on the card.`,
  PersonOnly: " Tell the person in one line what stopped and that Try again is on the card once it is fixed.",
  Done: (version: string) =>
    `Unity ${version} is installed on this Mac and the person is signed in. Go on with their game in Unity: call unity__new-game if it has no Unity project yet.`,
} as const;

const button = (name: SetupAction, label: string): Button => ({ name, args: {}, label });

/** How far a running install got, in one line. */
function progressOf(job: InstallJob): string {
  if (job.done !== undefined && job.total) return WORDS.Megabytes(job.done, job.total);
  if (job.percent !== undefined && job.phase) return WORDS.Phase(job.phase, job.percent);
  if (job.percent !== undefined) return WORDS.Percent(job.percent);
  if (job.phase) return WORDS.PhaseOnly(job.phase);
  return WORDS.Starting();
}

/** The job of one kind, when it is the current one. */
const jobOf = (facts: SetupFacts, kind: JobKind): InstallJob | undefined =>
  facts.job?.kind === kind ? facts.job : undefined;

/** Unity Hub's row: installed, being installed, stopped, or to get. */
function hubRow(facts: SetupFacts): SetupRow {
  const id = SetupStepId.GetHub;
  if (facts.hub) return { id, label: WORDS.HubReady(), detail: "", done: true };
  const job = jobOf(facts, JobKind.Hub);
  if (job?.state === JobState.Running) {
    const downloading = job.total !== undefined && (job.done ?? 0) < job.total;
    const label = downloading ? WORDS.DownloadingHub() : WORDS.InstallingHub();
    return { id, label, detail: downloading ? progressOf(job) : "", done: false, working: true };
  }
  if (job?.state === JobState.Failed)
    return {
      id,
      label: WORDS.GetHub(),
      detail: job.why ?? "",
      done: false,
      you: true,
      action: button(SetupAction.GetHub, WORDS.TryAgain()),
    };
  return {
    id,
    label: WORDS.GetHub(),
    detail: WORDS.GetHubDetail(),
    done: false,
    action: button(SetupAction.GetHub, WORDS.Download()),
  };
}

/** Signing in: the person's own step, which Hub can't be opened for until it is installed. */
function signInRow(facts: SetupFacts): SetupRow {
  const id = SetupStepId.SignIn;
  if (facts.signedIn) return { id, label: WORDS.SignedIn(), detail: "", done: true };
  if (jobOf(facts, JobKind.SignIn)?.state === JobState.Running)
    return {
      id,
      label: WORDS.YourTurn(),
      detail: WORDS.YourTurnDetail(),
      done: false,
      you: true,
      action: button(SetupAction.OpenHub, WORDS.ShowHub()),
    };
  const open = facts.hub ? { action: button(SetupAction.OpenHub, WORDS.OpenHub()) } : {};
  return { id, label: WORDS.SignIn(), detail: WORDS.SignInDetail(), done: false, you: true, ...open };
}

/** The editor's row: installed, being installed, stopped, or to install once Hub is there. */
function editorRow(facts: SetupFacts): SetupRow {
  const id = SetupStepId.InstallUnity;
  if (facts.editor) return { id, label: WORDS.Installed(facts.editor.version), detail: "", done: true };
  const job = jobOf(facts, JobKind.Editor);
  const version = job?.version ?? "6";
  if (job?.state === JobState.Running)
    return { id, label: WORDS.Installing(version), detail: progressOf(job), done: false, working: true };
  const action = facts.hub
    ? { action: button(SetupAction.InstallUnity, job ? WORDS.TryAgain() : WORDS.Install()) }
    : {};
  if (job?.state === JobState.Failed)
    return { id, label: WORDS.InstallUnity(), detail: job.why ?? "", done: false, you: true, ...action };
  return { id, label: WORDS.InstallUnity(), detail: WORDS.InstallDetail(), done: false, ...action };
}

/** What the agent is told about an install that stopped: finish it in Hub with computer control, or tell the person. */
function stuckOf(job: InstallJob | null): { stuckSays?: string } {
  if (job?.state !== JobState.Failed || job.stopped) return {};
  const version = job.version && job.version !== "6" ? job.version : "6 (the newest final 6000.3 release)";
  const next = job.inHub ? TOLD.InHub(version) : TOLD.PersonOnly;
  return { stuckSays: `${TOLD.Stuck(job.why ?? "")}${next}` };
}

/**
 * The card for where this computer stands: three rows, the intro counting what is left (or saying
 * Genex is at it), Do it for me while nothing runs, and what the agent hears once all is done.
 */
export function setupCard(facts: SetupFacts): SetupCard {
  const steps = [hubRow(facts), signInRow(facts), editorRow(facts)];
  const left = steps.filter((row) => !row.done).length;
  const running = facts.job?.state === JobState.Running;
  const doneSays = facts.editor ? { doneSays: TOLD.Done(facts.editor.version) } : {};
  return {
    title: WORDS.Title(),
    intro: running ? WORDS.Working() : WORDS.Intro(left),
    open: left > 0,
    steps,
    ...(left > 0 && !running ? { primary: button(SetupAction.SetUp, WORDS.DoItForMe()) } : {}),
    ...(left > 0
      ? { secondary: running ? button(SetupAction.Stop, WORDS.Stop()) : button(SetupAction.Skip, WORDS.Skip()) }
      : {}),
    ...doneSays,
    ...stuckOf(facts.job),
  };
}

/** The license files signing in to Hub leaves on a Mac (or Windows): the account's, and an older machine-wide one. */
export function licenseFiles(env: EditorsEnv): string[] {
  if (env.platform === "win32")
    return [
      path.win32.join(env.home, "AppData", "Local", "Unity", "licenses", "UnityEntitlementLicense.xml"),
      path.win32.join(path.win32.parse(env.applications).root, "ProgramData", "Unity", "Unity_lic.ulf"),
    ];
  // Applications and Library sit side by side: /Applications beside /Library.
  const machine = path.posix.join(path.posix.dirname(env.applications), "Library", "Application Support", "Unity");
  return [
    path.posix.join(env.home, "Library", "Unity", "licenses", "UnityEntitlementLicense.xml"),
    path.posix.join(machine, "Unity_lic.ulf"),
  ];
}

/** Whether Unity's license is on this computer: one of its files exists. Its contents are never read. */
export async function hasLicense(env: EditorsEnv): Promise<boolean> {
  for (const file of licenseFiles(env)) if ((await stat(file).catch(() => null))?.isFile()) return true;
  return false;
}

/** What the card reads now, with the install the backend has under way. */
export async function readFacts(env: EditorsEnv, job: InstallJob | null): Promise<SetupFacts> {
  const [hub, signedIn, editors] = await Promise.all([findHub(env), hasLicense(env), findEditors(env)]);
  return { hub, signedIn, editor: newestUnity6(editors), job };
}

/** The card once the person chose Don't use Unity: closed, with what the agent is told. */
export function skippedCard(card: SetupCard): SetupCard {
  const { primary: _primary, secondary: _secondary, stuckSays: _stuck, ...rest } = card;
  return { ...rest, open: false, doneSays: TOLD.Skipped };
}
