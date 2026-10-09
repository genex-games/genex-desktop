/**
 * The Publish dialog's view of Genex's publish record: where the game is (not online, draft only,
 * public), the running attempt's steps, how the last one ended, and the one press the next step
 * needs. What Publish asks for first (Genex installed and on, then an account), whether Studio puts
 * Publish on the strip itself and which games get none (an Unreal game) are decided here too. Pure,
 * so the dialog only draws it.
 */
import {
  cleanGenexTitle,
  defaultGenexTitle,
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  GenexAction,
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  GenexPublishStatusOperation,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import { type PluginToolbarEntry, toolbarItems } from "../../../../shared/plugin-toolbar.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { type FactRef, type FolderHolds, servedAsWebGame } from "../../../../shared/project-facts.ts";
import { relativeTime } from "../../../chat-labels.ts";
import { GENEX_WORDS } from "../../../words.ts";

const WORDS = GENEX_WORDS.publish;

/** Where the game is on Genex. */
export const PublishStage = { None: "none", Draft: "draft", Public: "public" } as const;
export type PublishStage = (typeof PublishStage)[keyof typeof PublishStage];

/** A step of a publish attempt as the progress bar names it: the draft is tested before it goes live. */
export const GenexPublishStep = {
  Prepare: "prepare",
  Upload: "upload",
  Test: "test",
  Live: "live",
} as const;
export type GenexPublishStep = (typeof GenexPublishStep)[keyof typeof GenexPublishStep];

/** Which step each phase belongs to; the finished phases belong to none. */
const PHASE_STEP: Partial<Record<GenexPublishPhase, GenexPublishStep>> = {
  [GenexPublishPhase.Checking]: GenexPublishStep.Prepare,
  [GenexPublishPhase.Exporting]: GenexPublishStep.Prepare,
  [GenexPublishPhase.CreatingProject]: GenexPublishStep.Prepare,
  [GenexPublishPhase.Uploading]: GenexPublishStep.Upload,
  [GenexPublishPhase.VerifyingDeployment]: GenexPublishStep.Test,
  [GenexPublishPhase.Promoting]: GenexPublishStep.Live,
  [GenexPublishPhase.Listing]: GenexPublishStep.Live,
};

/** Where a step stands on the progress bar. */
export const StepState = { Done: "done", Current: "current", Next: "next" } as const;
export type StepState = (typeof StepState)[keyof typeof StepState];

/** One step on the progress bar. */
export interface StepView {
  step: GenexPublishStep;
  label: string;
  state: StepState;
}

/** How the last attempt ended, as the dialog tells it: nothing to tell, working, done, failed, or not known yet. */
export const PublishOutcome = {
  Idle: "idle",
  Running: "running",
  Failed: "failed",
  Unresolved: "unresolved",
} as const;
export type PublishOutcome = (typeof PublishOutcome)[keyof typeof PublishOutcome];

/** A button the dialog offers: its words, the action it runs, and its aria-label (kept for smoke checks). */
export interface PublishButton {
  label: string;
  action: string;
  args?: Record<string, unknown>;
  ariaLabel: string;
}

/** Everything the dialog draws. */
export interface PublishView {
  stage: PublishStage;
  intro: string;
  outcome: PublishOutcome;
  running: boolean;
  unresolved: boolean;
  phase: string;
  startedAt: string | null;
  steps: StepView[];
  /** The game's line under its name: not online, a test version, live since…, publishing. */
  status: string;
  primary: PublishButton;
  /** Check again and allow a new upload, while an upload's outcome is unknown. */
  extra: PublishButton[];
  /** Review Genex's terms in the browser: the one press while they are not accepted. */
  terms: PublishButton | null;
  canPublish: boolean;
  /** Something the person must do first (accept Genex's terms); never a failed attempt's raw error. */
  problems: string[];
  /** A failed or unknown attempt, said calmly, and the raw detail it keeps for support. */
  failure: { title: string; text: string; details: string } | null;
  /** The link anyone can play, once the game is public. */
  link: string | null;
}

export const isListed = (state: GenexPublishState): boolean => state.status === GenexHostedStatus.Published;

/** Whether an attempt is still going, including one whose upload outcome is not known yet. */
export const isLive = (job: GenexPublishJob | undefined): boolean =>
  job?.state === GenexPublishJobState.Running || job?.state === GenexPublishJobState.Unresolved;

/** The steps an attempt takes: a publish prepares, uploads, tests and goes live; a draft stops after its test. */
export function publishSteps(job: GenexPublishJob): GenexPublishStep[] {
  const steps = [GenexPublishStep.Prepare, GenexPublishStep.Upload, GenexPublishStep.Test];
  return job.kind === GenexPublishKind.Draft ? steps : [...steps, GenexPublishStep.Live];
}

/** The progress bar: the steps before the running one done, the running one current. */
function stepViews(job: GenexPublishJob | undefined, running: boolean): StepView[] {
  if (!job || !running) return [];
  const steps = publishSteps(job);
  const current = PHASE_STEP[job.phase];
  const at = current ? steps.indexOf(current) : -1;
  return steps.map((step, index) => ({
    step,
    label: WORDS.step[step],
    state: (index < at && StepState.Done) || (index === at && StepState.Current) || StepState.Next,
  }));
}

/** Where the game is: public once listed, a draft once it has a page, else not online. */
function stageOf(state: GenexPublishState): PublishStage {
  if (isListed(state)) return PublishStage.Public;
  return state.slug ? PublishStage.Draft : PublishStage.None;
}

const INTRO: Record<PublishStage, string> = {
  none: WORDS.intro,
  draft: WORDS.intro,
  public: WORDS.published,
};

/** How the record's last attempt ended, for the dialog. */
function outcomeOf(job: GenexPublishJob | undefined, running: boolean): PublishOutcome {
  if (running) return PublishOutcome.Running;
  if (job?.state === GenexPublishJobState.Unresolved) return PublishOutcome.Unresolved;
  if (job?.state === GenexPublishJobState.Failed) return PublishOutcome.Failed;
  return PublishOutcome.Idle;
}

/** The game's line under its name. */
function statusLine(state: GenexPublishState, stage: PublishStage, running: boolean, now: number): string {
  if (running) return WORDS.statusPublishing;
  if (stage === PublishStage.Public)
    return state.lastPublishAt ? WORDS.statusLive(relativeTime(state.lastPublishAt, now)) : WORDS.statusLiveUndated;
  return stage === PublishStage.Draft ? WORDS.statusDraft : WORDS.statusNone;
}

/** Check again and allow a new upload, while an upload's outcome is unknown. */
function unresolvedButtons(job: GenexPublishJob | undefined): PublishButton[] {
  if (job?.phase !== GenexPublishPhase.Unresolved) return [];
  return [
    {
      label: WORDS.checkAgain,
      action: GenexAction.PublishStatus,
      args: { operation: GenexPublishStatusOperation.Check },
      ariaLabel: "Check deployment availability without uploading",
    },
    {
      label: WORDS.allowUpload,
      action: GenexAction.PublishAllowUpload,
      args: { jobId: job.id },
      ariaLabel: "Allow a new upload after checking the deployment page",
    },
  ];
}

/** A failed or unknown attempt in plain words; the raw error and check stay as details for support. */
function failureOf(outcome: PublishOutcome, state: GenexPublishState, job: GenexPublishJob | undefined) {
  const details = [job?.error ?? state.lastError, job?.checkError].filter(Boolean).join("\n");
  if (outcome === PublishOutcome.Unresolved)
    return { title: WORDS.unresolvedTitle, text: WORDS.unresolvedText, details };
  if (outcome !== PublishOutcome.Failed) return null;
  return { title: WORDS.failedTitle, text: isListed(state) ? WORDS.failedKept : WORDS.failedText, details };
}

/** The dialog's view of a publish record, at `now`. */
export function publishView(state: GenexPublishState, now = Date.now()): PublishView {
  const job = state.job;
  const live = isLive(job);
  const unresolved = job?.phase === GenexPublishPhase.Unresolved;
  const running = live && !unresolved;
  const stage = stageOf(state);
  const listed = stage === PublishStage.Public;
  const outcome = outcomeOf(job, running);
  const failed = outcome === PublishOutcome.Failed;
  return {
    stage,
    intro: INTRO[stage],
    outcome,
    running,
    unresolved,
    phase: job && running ? WORDS.phase[job.phase] : "",
    startedAt: running && job ? job.startedAt : null,
    steps: stepViews(job, running),
    status: statusLine(state, stage, running, now),
    primary: {
      label: (failed && WORDS.tryAgain) || (listed && WORDS.updatePublic) || WORDS.publish,
      action: GenexAction.PublishGallery,
      ariaLabel: "Publish this game on Genex",
    },
    extra: unresolvedButtons(job),
    terms:
      state.terms?.accepted === false
        ? { label: WORDS.reviewTerms, action: GenexAction.Terms, ariaLabel: WORDS.reviewTerms }
        : null,
    canPublish: state.connected && !live,
    problems: state.terms?.accepted === false ? [WORDS.termsNote] : [],
    failure: failureOf(outcome, state, job),
    link: listed ? (state.galleryUrl ?? null) : null,
  };
}

/** The name the dialog offers: the one the game is listed under, else Studio's title for it, else its folder. */
export function offeredTitle(state: GenexPublishState | null, gameTitle: string | undefined, project: string): string {
  return state?.title ?? cleanGenexTitle(gameTitle) ?? defaultGenexTitle(project);
}

/** What Publish asks for before it can publish, in this order. */
export const PublishGate = { Install: "install", TurnOn: "turn-on", Connect: "connect", Ready: "ready" } as const;
export type PublishGate = (typeof PublishGate)[keyof typeof PublishGate];

/**
 * What stands between the person and Publish: Genex installed (`genex` missing or removed), turned
 * on, then a connected account. A record not read yet asks for nothing.
 */
export function publishGate(
  genex: Pick<PluginInfo, "enabled" | "removed"> | undefined,
  connected: boolean | undefined,
): PublishGate {
  if (!genex || genex.removed) return PublishGate.Install;
  if (!genex.enabled) return PublishGate.TurnOn;
  return connected === false ? PublishGate.Connect : PublishGate.Ready;
}

/** Whether a stage-strip button is Genex's Publish. */
export const isGenexPublish = (entry: PluginToolbarEntry): boolean =>
  entry.plugin.manifest.id === GENEX_PLUGIN_ID &&
  entry.item.target.kind === "panel" &&
  entry.item.target.id === GENEX_PUBLISH_PANEL;

/**
 * Whether Publish can put a game holding these facts (and, with none, `holds`) on Genex. Publish uploads the game folder as a
 * web game, so only a game served as one at its root has Publish; an Unreal game's folder holds an
 * Unreal project and no web build, and any other kind of project none either. The host refuses the
 * same games (`main/core/genex-publish.ts`).
 */
const publishable = (facts: readonly FactRef[], holds: FolderHolds | undefined): boolean =>
  servedAsWebGame({ facts, holds });

/**
 * The plugin buttons on the open game's stage strip: every enabled plugin's, less Genex's Publish
 * for a game Publish can't put online (`publishable`).
 */
export function stripEntries(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): PluginToolbarEntry[] {
  const entries = toolbarItems(plugins, project);
  return publishable(facts, holds) ? entries : entries.filter((entry) => !isGenexPublish(entry));
}

/**
 * Whether Studio puts Publish on the strip itself: a web game is open and Genex, off or gone, adds
 * none.
 */
export function studioPublishButton(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): boolean {
  return Boolean(project) && publishable(facts, holds) && !toolbarItems(plugins, project).some(isGenexPublish);
}
