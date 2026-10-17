/**
 * The Publish dialog's view of Genex's publish record: where the game is (not online, draft only,
 * public), the running attempt's steps, how the last one ended, and the one press the next step
 * needs. What Publish asks for first (a Genex account; the plugin may be off), what Multiplayer asks
 * for (the plugin on), whether to ask the game's chat for a Genex cover, whether Studio puts Publish
 * on the strip itself, which games get none (an Unreal game) and whether the chat's cover card
 * offers Publish are decided here too.
 * Pure, so the dialog only draws it.
 */
import {
  cleanGenexTitle,
  defaultGenexTitle,
  GENEX_PLUGIN_ID,
  GENEX_PUBLISH_PANEL,
  GenexAction,
  GenexCoverOutcome,
  ownerChoseCover,
  type GenexCoverRecord,
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../../../shared/genex.ts";
import { type PluginToolbarEntry, toolbarItems } from "../../../../shared/plugin-toolbar.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import type { FactRef, FolderHolds, GameKind } from "../../../../shared/project-facts.ts";
import { publishesAsWebGame } from "../../../../shared/project-workspace.ts";
import { MINUTE_MS } from "../../../../shared/duration.ts";
import { FEEDBACK_TEXT_MAX_CHARS, type FeedbackDraft, FeedbackScreen } from "../../../../shared/feedback.ts";
import { relativeTime } from "../../../chat-labels.ts";
import { type StepState, stepStateAt } from "../../../ui/step-bar.ts";
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

/**
 * Which step each phase belongs to; the finished phases belong to none. An upload whose outcome
 * is not known yet is still being checked: it stands on the test.
 */
const PHASE_STEP: Partial<Record<GenexPublishPhase, GenexPublishStep>> = {
  [GenexPublishPhase.Checking]: GenexPublishStep.Prepare,
  [GenexPublishPhase.Exporting]: GenexPublishStep.Prepare,
  [GenexPublishPhase.CreatingProject]: GenexPublishStep.Prepare,
  [GenexPublishPhase.Uploading]: GenexPublishStep.Upload,
  [GenexPublishPhase.VerifyingDeployment]: GenexPublishStep.Test,
  [GenexPublishPhase.Unresolved]: GenexPublishStep.Test,
  [GenexPublishPhase.Promoting]: GenexPublishStep.Live,
  [GenexPublishPhase.Listing]: GenexPublishStep.Live,
};

/** A test running longer than this is "Still testing": Genex usually serves a new build well within it. */
export const SLOW_TEST_MS = 2 * MINUTE_MS;

/** One step on the progress bar. */
export interface StepView {
  step: GenexPublishStep;
  label: string;
  state: StepState;
}

/** How the last attempt ended, as the dialog tells it: nothing to tell, working, or failed. */
export const PublishOutcome = {
  Idle: "idle",
  Running: "running",
  Failed: "failed",
} as const;
export type PublishOutcome = (typeof PublishOutcome)[keyof typeof PublishOutcome];

/** The banner's status chip: quiet while not published, green once live, red after a failed attempt. */
export const ChipTone = { Quiet: "quiet", Live: "live", Failed: "failed" } as const;
export type ChipTone = (typeof ChipTone)[keyof typeof ChipTone];

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
  /** The line under Publish: who can play it. */
  intro: string;
  outcome: PublishOutcome;
  /** An attempt is going, including one whose upload Studio is still checking. */
  running: boolean;
  /** Studio does not know yet whether the upload reached Genex. */
  unresolved: boolean;
  /** The test is taking longer than usual, or the outcome is not known yet: "Still testing". */
  slow: boolean;
  /** What the running attempt is doing, for the busy button. */
  phase: string;
  startedAt: string | null;
  steps: StepView[];
  /** Where the game is, on the banner; none while an attempt runs (the button says it). */
  chip: { tone: ChipTone; text: string } | null;
  primary: PublishButton;
  /** Publish again, while Studio cannot tell whether the last upload reached Genex. */
  again: PublishButton | null;
  /** Review Genex's terms in the browser: the one press while they are not accepted. */
  terms: PublishButton | null;
  canPublish: boolean;
  /** Something the person must do first (accept Genex's terms); never a failed attempt's raw error. */
  problems: string[];
  /** A failed attempt in one line, and the raw detail its report carries. */
  failure: { text: string; details: string } | null;
  /** The link anyone can play, once the game is public. */
  link: string | null;
  /** The tested draft's address while players do not have it yet ({@link testLinkOf}); null otherwise. */
  testLink: string | null;
  /** The game has no Genex cover yet and its owner chose none: Studio takes one as the dialog opens. */
  needsCover: boolean;
  /** Whether the banner offers Another cover: the plugin keeps covers, nothing runs, and the owner chose none. */
  canAskCover: boolean;
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
    state: stepStateAt(index, at),
  }));
}

/** Where the game is: public once listed, a draft once it has a page, else not online. */
function stageOf(state: GenexPublishState): PublishStage {
  if (isListed(state)) return PublishStage.Public;
  return state.slug ? PublishStage.Draft : PublishStage.None;
}

/** How the record's last attempt ended, for the dialog. */
function outcomeOf(job: GenexPublishJob | undefined, running: boolean): PublishOutcome {
  if (running) return PublishOutcome.Running;
  return job?.state === GenexPublishJobState.Failed ? PublishOutcome.Failed : PublishOutcome.Idle;
}

/** The banner's chip: where the game is, or that the last attempt failed; none while one runs. */
function chipOf(state: GenexPublishState, outcome: PublishOutcome, now: number): PublishView["chip"] {
  if (outcome === PublishOutcome.Running) return null;
  if (outcome === PublishOutcome.Failed) return { tone: ChipTone.Failed, text: WORDS.chipFailed };
  if (!isListed(state)) return { tone: ChipTone.Quiet, text: WORDS.chipNone };
  const text = state.lastPublishAt ? WORDS.chipLive(relativeTime(state.lastPublishAt, now)) : WORDS.chipLiveUndated;
  return { tone: ChipTone.Live, text };
}

/** Whether the attempt is taking longer than usual: its outcome is unknown, or its test outran {@link SLOW_TEST_MS}. */
function isSlow(job: GenexPublishJob | undefined, unresolved: boolean, now: number): boolean {
  if (unresolved) return true;
  const testing = job?.state === GenexPublishJobState.Running && PHASE_STEP[job.phase] === GenexPublishStep.Test;
  return testing && now - Date.parse(job.startedAt) > SLOW_TEST_MS;
}

/** Publish again, while Studio cannot tell whether the last upload reached Genex. */
function againButton(job: GenexPublishJob | undefined, unresolved: boolean): PublishButton | null {
  if (!job || !unresolved) return null;
  return {
    label: WORDS.publishAgain,
    action: GenexAction.PublishAllowUpload,
    args: { jobId: job.id },
    ariaLabel: "Publish again without waiting for the last upload",
  };
}

/** A failed attempt in one line; the raw error and check stay as details for its report. */
function failureOf(outcome: PublishOutcome, state: GenexPublishState, job: GenexPublishJob | undefined) {
  if (outcome !== PublishOutcome.Failed) return null;
  const details = [job?.error ?? state.lastError, job?.checkError].filter(Boolean).join("\n");
  return { text: isListed(state) ? WORDS.failedKept : WORDS.failedText, details };
}

/**
 * Whether Studio should take the game's Genex cover as the dialog opens: the plugin reports its
 * cover (an older one does not), no shot is kept, none is being sent, no publish is running (it
 * shoots the cover itself), and the owner chose none on genex.games.
 */
export function needsCover(state: GenexPublishState): boolean {
  const cover = state.cover;
  if (!cover || cover.shot) return false;
  return canAskCover(state);
}

/** Whether a new cover may be asked for now: the plugin keeps covers, nothing runs, and the owner chose none. */
export function canAskCover(state: GenexPublishState): boolean {
  const cover = state.cover;
  if (!cover || cover.sending || isLive(state.job)) return false;
  return !ownerChoseCover(cover.last);
}

/** The frames the banner flips between, newest first, and which of them is the kept shot (-1: none of them). */
export function coverChoices(record: GenexCoverRecord | undefined): { shas: string[]; index: number } {
  const shas = (record?.candidates ?? []).map((shot) => shot.sha256);
  return { shas, index: record?.shot ? shas.indexOf(record.shot.sha256) : -1 };
}

/** The frame an arrow lands on, `step` places along (older is +1), wrapping round; null with nothing to flip to. */
export function flipCover(choices: { shas: string[]; index: number }, step: 1 | -1): string | null {
  const { shas, index } = choices;
  if (shas.length < 2) return null;
  const from = index < 0 ? 0 : index;
  return shas[(from + step + shas.length) % shas.length] ?? null;
}

/** How long the banner says a cover is being made after Another cover, unless a new frame arrives first. */
export const COVER_MAKING_MS = 15 * MINUTE_MS;

/** An ask for another cover: the frame it was asked over, and when. */
export interface CoverAskRecord {
  from: string | null;
  at: number;
}

/** Whether the banner still says a cover is being made: no new frame since the ask, and not for too long. */
export const coverMaking = (ask: CoverAskRecord | null, shot: string | null, now: number): boolean =>
  ask !== null && ask.from === shot && now - ask.at < COVER_MAKING_MS;

/** The dialog's view of a publish record, at `now`. */
export function publishView(state: GenexPublishState, now = Date.now()): PublishView {
  const job = state.job;
  const running = isLive(job);
  const unresolved = job?.phase === GenexPublishPhase.Unresolved;
  const slow = running && isSlow(job, unresolved, now);
  const stage = stageOf(state);
  const listed = stage === PublishStage.Public;
  const outcome = outcomeOf(job, running);
  const failed = outcome === PublishOutcome.Failed;
  return {
    stage,
    intro: WORDS.intro,
    outcome,
    running,
    unresolved,
    slow,
    phase: job && running ? (slow && WORDS.stillTesting) || WORDS.phase[job.phase] : "",
    startedAt: running && job ? job.startedAt : null,
    steps: stepViews(job, running),
    chip: chipOf(state, outcome, now),
    primary: {
      label: (failed && WORDS.tryAgain) || (listed && WORDS.updatePublic) || WORDS.publishToWeb,
      action: GenexAction.PublishGallery,
      ariaLabel: "Publish this game on Genex",
    },
    again: againButton(job, unresolved),
    terms:
      state.terms?.accepted === false
        ? { label: WORDS.reviewTerms, action: GenexAction.Terms, ariaLabel: WORDS.reviewTerms }
        : null,
    canPublish: state.connected && !running,
    problems: state.terms?.accepted === false ? [WORDS.termsNote] : [],
    failure: failureOf(outcome, state, job),
    link: listed ? (state.galleryUrl ?? null) : null,
    testLink: testLinkOf(state, listed),
    needsCover: needsCover(state),
    canAskCover: canAskCover(state),
  };
}

/**
 * The tested draft's address, while it holds something players do not have: any tested draft
 * before the game is public; once it is, only a draft tested after the last publish that was not
 * that publish's own build. A publish tests its draft before promoting it and stamps
 * `lastPublishAt` when it finishes, so a fresh publish hides the link; the revision check covers a
 * publish settled later by Genex's record. Display only: nothing here changes what Publish does.
 */
/** A failed attempt that uploaded after `verifiedAt`: the draft address now serves its untested build. */
function failedAfter(job: GenexPublishJob | undefined, verifiedAt: string): boolean {
  if (job?.state !== GenexPublishJobState.Failed || !job.uploadedAt) return false;
  return Date.parse(job.uploadedAt) > Date.parse(verifiedAt);
}

export function testLinkOf(state: GenexPublishState, listed: boolean): string | null {
  const ready = state.readyDraft;
  // While an attempt runs the dialog shows its progress, never a link that is about to change.
  if (!ready?.url || isLive(state.job)) return null;
  // The address is the draft's, not the tested revision's: a later upload that then failed its
  // test serves that untested build there, so it is no link to hand a friend.
  if (failedAfter(state.job, ready.verifiedAt)) return null;
  if (!listed) return ready.url;
  const tested = Date.parse(ready.verifiedAt);
  const published = Date.parse(state.lastPublishAt ?? "");
  if (!Number.isFinite(tested) || !Number.isFinite(published) || tested <= published) return null;
  const job = state.job;
  const promoted =
    job?.kind === GenexPublishKind.Gallery &&
    job.state === GenexPublishJobState.Done &&
    job.expectedStagingRevision === ready.revision;
  return promoted ? null : ready.url;
}

/** An attempt this dialog watched just went live: the one moment it says "Your game is live!". */
export const justPublished = (before: PublishView | null, after: PublishView): boolean =>
  Boolean(before?.running) &&
  !after.running &&
  after.outcome === PublishOutcome.Idle &&
  after.stage === PublishStage.Public;

/** Seconds as the busy button's clock: 0:24, 2:14. */
export function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** The report Send report posts for a failed attempt: what failed and its raw detail, with the app's logs. */
export function publishReport(project: string, title: string, view: PublishView): FeedbackDraft {
  const text = WORDS.reportText(title, project, view.failure?.details ?? "");
  return { text: text.slice(0, FEEDBACK_TEXT_MAX_CHARS), screen: FeedbackScreen.Chat, appLogs: true, chatId: null };
}

/** The name the dialog offers: the one the game is listed under, else Studio's title for it, else its folder. */
export function offeredTitle(state: GenexPublishState | null, gameTitle: string | undefined, project: string): string {
  return state?.title ?? cleanGenexTitle(gameTitle) ?? defaultGenexTitle(project);
}

/** What Publish asks for before it can publish: a Genex account, or nothing. */
export const PublishGate = { SignIn: "sign-in", Ready: "ready" } as const;
export type PublishGate = (typeof PublishGate)[keyof typeof PublishGate];

/**
 * What stands between the person and Publish: only a Genex account. Publish is the account's, so
 * the Genex plugin being off asks nothing; a Genex that is missing or removed is brought back by
 * signing in. A record not read yet asks for nothing.
 */
export function publishGate(
  genex: Pick<PluginInfo, "enabled" | "removed"> | undefined,
  connected: boolean | undefined,
): PublishGate {
  if (!genex || genex.removed) return PublishGate.SignIn;
  return connected === false ? PublishGate.SignIn : PublishGate.Ready;
}

/** What Multiplayer asks for while the Genex plugin is not on: installed, then turned on. */
export const GenexSetup = { Install: "install", TurnOn: "turn-on" } as const;
export type GenexSetup = (typeof GenexSetup)[keyof typeof GenexSetup];

/** Install a missing or removed Genex, else turn it on. */
export const genexSetup = (genex: Pick<PluginInfo, "enabled" | "removed"> | undefined): GenexSetup =>
  !genex || genex.removed ? GenexSetup.Install : GenexSetup.TurnOn;

/** Whether a stage-strip button is Genex's Publish. */
export const isGenexPublish = (entry: PluginToolbarEntry): boolean =>
  entry.plugin.manifest.id === GENEX_PLUGIN_ID &&
  entry.item.target.kind === "panel" &&
  entry.item.target.id === GENEX_PUBLISH_PANEL;

/**
 * Whether Publish can put a game holding these facts (and, with none, `holds`) on Genex. Publish uploads the game folder as a
 * web game, so only a game served as one at its root, or with its web game in a folder of it (an
 * engine's web export), has Publish; an Unreal game's folder holds an
 * Unreal project and no web build, and any other kind of project none either. The host refuses the
 * same games (`main/core/genex-publish.ts`).
 */
const publishable = (facts: readonly FactRef[], holds: FolderHolds | undefined): boolean =>
  publishesAsWebGame({ facts, holds });

/** Whether a plugin is the Genex plugin, installed but switched off. */
const isGenexOff = (plugin: PluginInfo): boolean =>
  plugin.manifest.id === GENEX_PLUGIN_ID && !plugin.enabled && !plugin.removed && !plugin.unlisted;

/**
 * Each plugin's buttons in list order: an enabled plugin's all (those scoped to facts `game` isn't
 * served by marked out of scope), and an off Genex's Publish alone, since Publish belongs to the
 * account and not to the agent's tools.
 */
function toolbarEntries(plugins: readonly PluginInfo[], project: string | null, game?: GameKind): PluginToolbarEntry[] {
  return plugins.flatMap((plugin) => {
    if (!isGenexOff(plugin)) return toolbarItems([plugin], project, game);
    if (!project) return [];
    return (plugin.manifest.toolbar ?? [])
      .map((item) => ({ key: `${plugin.manifest.id}:${item.id}`, plugin, item }))
      .filter(isGenexPublish);
  });
}

/**
 * The plugin buttons on the open game's stage strip: every enabled plugin's and Genex's Publish, on
 * or off, less that Publish for a game it can't put online (`publishable`).
 */
export function stripEntries(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): PluginToolbarEntry[] {
  const entries = toolbarEntries(plugins, project, { facts, holds });
  return publishable(facts, holds) ? entries : entries.filter((entry) => !isGenexPublish(entry));
}

/**
 * Whether Studio puts Publish on the strip itself: a web game is open and no Genex is installed to
 * add its own (signing in from it brings Genex back).
 */
export function studioPublishButton(
  plugins: readonly PluginInfo[],
  project: string | null,
  facts: readonly FactRef[],
  holds?: FolderHolds,
): boolean {
  return Boolean(project) && publishable(facts, holds) && !toolbarEntries(plugins, project).some(isGenexPublish);
}

/**
 * Answers that leave nothing for a publish to do about a frame: Genex took it, already had it, or
 * the owner's own pick stands over it. A failed send or no hosted project is retried by the next
 * publish, and a refused frame is replaced by the shot it takes.
 */
const FRAME_ANSWERED = new Set<GenexCoverOutcome>([
  GenexCoverOutcome.Applied,
  GenexCoverOutcome.Unchanged,
  GenexCoverOutcome.Outranked,
  GenexCoverOutcome.KeptOwner,
]);

/** Whether Genex has answered for the kept frame itself, then or when these bytes were first sent. */
function keptFrameAnswered(cover: GenexCoverRecord | undefined): boolean {
  const shot = cover?.shot;
  const last = cover?.last;
  if (!shot || last?.sha256 !== shot.sha256) return false;
  return FRAME_ANSWERED.has(last.settled ?? last.kind);
}

/**
 * Whether the chat's Genex cover card offers Publish: Genex's own Publish is on the strip (Genex
 * installed, on or off), no publish of this game runs, and Genex has not yet answered for the kept
 * frame (a publish re-shoots and sends it, so once one has, the cover's next step is done). A
 * record not read yet hides nothing.
 */
export function coverCardPublish(
  plugins: readonly PluginInfo[],
  project: string | null,
  state: GenexPublishState | null,
): boolean {
  if (!project || !toolbarEntries(plugins, project).some(isGenexPublish)) return false;
  return !isLive(state?.job) && !keptFrameAnswered(state?.cover);
}
