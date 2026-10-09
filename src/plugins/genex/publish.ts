/**
 * The rules of a Genex publish, apart from the I/O that carries it out: which phase and CLI command
 * an attempt runs, when an unknown outcome may be settled or re-checked, and which links are ours.
 */
import {
  GenexHostedStatus,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexGameManifest,
  type GenexPublishJob,
  type GenexPublishState,
} from "../../shared/genex.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { stripAnsi } from "./cli.ts";
import { DEFAULT_DASHBOARD, isGenexLink } from "./http.ts";

/** A draft checked this soon after its upload is still expected to go live on its own. */
const FOREGROUND_CHECK_MS = 2 * 60 * SECOND_MS;
/** How long a gallery publish waits for its new draft to pass its test before it gives up on going public. */
export const DRAFT_TEST_MS = FOREGROUND_CHECK_MS;
/** A gallery publish uploads its build at most this many times: once, and once more when the draft fails its test. */
export const MAX_UPLOADS = 2;
const FIRST_RETRY_MS = 2 * SECOND_MS;
const MAX_FOREGROUND_RETRY_MS = 15 * SECOND_MS;
/** Retries double at most this many times before settling at the cap. */
const MAX_BACKOFF_STEPS = 3;
const BACKGROUND_RETRY_MS = 30 * SECOND_MS;
/** How much of a failed CLI run's message a job keeps. */
export const PUBLISH_ERROR_TAIL_CHARS = 3000;

export const MESSAGE = {
  UnknownAfterRestart: "Upload outcome is unknown after restart. Check the deployment page before retrying.",
  CannotReach: "Genex could not be reached to check this upload. Check again later.",
  DidNotLand: "The upload did not reach Genex: the hosted game is unchanged. You can upload again.",
  CannotTell: "Genex cannot tell whether this upload went live. Check the game page, then allow a new upload.",
  StillRunning: "This upload is still running",
  NotCurrent: "That upload is no longer the current one",
  OnlyDraftUpdated: "Only the draft page was updated: the public version is unchanged. Publish again to update it.",
  AllowedNewUpload: "You checked the deployment page and allowed a new upload.",
  ConnectFirst: "Connect Genex Tools first",
  AuthorizationExpired: "Genex authorization expired. Reconnect Genex Tools before uploading.",
  NoHostedProject: "Genex did not create a hosted project for this game",
  NoStagingIdentity: "Upload recorded; staging identity is not yet available",
  RevisionMismatch: "Hosted staging revision does not match this upload yet",
  NotInGallery: "This game is not in the gallery yet",
  NothingOnline: "Nothing is online for this game yet",
  UnrecognizedLink: "Unrecognized Genex page link",
  InvalidProject: "Invalid project",
  NeedsGit: "Publishing needs git on this Mac. Install git (Xcode command line tools or Homebrew) and try again.",
  NeedsGitLfs:
    "Publishing needs git and git-lfs on this Mac (brew install git-lfs). Studio will not let the Genex CLI install software.",
  DraftFailedTest:
    "The new build did not pass its test on the draft page, so it was not made public. Players still get the previous version.",
  SignInNotRecorded: (shipped: string, reported: string) =>
    `Genex does not record this build's sign-in support (shipped ${shipped}, Genex reports ${reported})`,
} as const;

/** Genex's own record of a hosted game, read by slug. `missing`: there is no hosted project. */
export interface HostedStaging {
  revision: string | null;
  status?: string;
  missing?: boolean;
}

/** The CLI's `.genex/project.json`, or Genex's answer about the same project. Fields are unchecked JSON. */
export interface HostedMeta {
  slug?: unknown;
  id?: unknown;
  status?: unknown;
  playUrl?: unknown;
  dashboardOrigins?: unknown;
  stagingCommit?: string;
}

/** A job's phase when its outcome became unknown: `phase` then reads 'unresolved' for the panel, and Check again still needs to know a gallery listing from a promotion. */
export type InterruptedJob = GenexPublishJob & { interruptedIn?: GenexPublishJob["phase"] };
export const phaseOf = (job: GenexPublishJob): GenexPublishJob["phase"] =>
  (job as InterruptedJob).interruptedIn ?? job.phase;

const hasSlug = (meta: HostedMeta | null | undefined): meta is HostedMeta & { slug: string } =>
  typeof meta?.slug === "string" && meta.slug !== "";
const isListed = (meta: HostedMeta | null | undefined) => meta?.status === GenexHostedStatus.Published;

/** Whether a listed game is listed again: only when the name it is listed under changes. */
export const needsRelisting = (meta: HostedMeta | null | undefined, listedTitle: string | undefined, title?: string) =>
  isListed(meta) && title !== undefined && title !== listedTitle;

/**
 * The CLI phases after the draft upload and its test, in order. A draft stops there. Publishing
 * makes that tested build the public version, then lists the game the first time, or again when
 * its name changed; nothing goes public before the draft passed.
 */
export function publicSteps(
  meta: HostedMeta | null | undefined,
  kind: GenexPublishKind,
  relist = false,
): GenexPublishPhase[] {
  if (kind === GenexPublishKind.Draft) return [];
  const listing = !isListed(meta) || relist;
  return listing ? [GenexPublishPhase.Promoting, GenexPublishPhase.Listing] : [GenexPublishPhase.Promoting];
}

/** The phase an attempt starts in: create the hosted project once, then upload the draft. */
export function publishPhaseFor(meta: HostedMeta | null | undefined): GenexPublishPhase {
  return meta?.slug ? GenexPublishPhase.Uploading : GenexPublishPhase.CreatingProject;
}

/**
 * Whether an upload is verified on the draft page after it finished: every draft, and a publish of a
 * marked export that an earlier Studio promoted before testing. A publish now tests its draft first.
 */
export const checksDraftPage = (job: GenexPublishJob): boolean =>
  job.kind === GenexPublishKind.Draft || job.deployment !== undefined;

/** The CLI command for each upload phase. Listing ships nothing: the promoted build is already live. */
const CLI_ARGS_FOR_PHASE: Partial<Record<GenexPublishPhase, string[]>> = {
  [GenexPublishPhase.Uploading]: ["preview", "--no-build"],
  [GenexPublishPhase.Promoting]: ["promote"],
  [GenexPublishPhase.Listing]: ["publish", "--no-push"],
};

/**
 * The CLI arguments that carry out an upload phase. Listing names the game. Its cover is a real
 * frame of the game with no name in it (`cover.ts`), so a new name never asks for a new picture.
 */
export function publishArgs(phase: GenexPublishPhase, listing: { title?: string } = {}): string[] {
  const args = [...(CLI_ARGS_FOR_PHASE[phase] ?? [])];
  if (phase !== GenexPublishPhase.Listing || !listing.title) return args;
  return [...args, "--title", listing.title];
}

/**
 * The package.json of Studio's publish copy: the game's Genex SDK versions and `genex` settings,
 * which the CLI reads from the folder it runs in and sends with every upload. Null when the game
 * names none, so no package.json is left behind.
 */
export function workspaceManifest(project: string, manifest: GenexGameManifest | undefined): object | null {
  if (!manifest) return null;
  return {
    name: project.toLowerCase(),
    private: true,
    dependencies: manifest.dependencies,
    ...(manifest.genex ? { genex: manifest.genex } : {}),
  };
}

/** The sign-in support Genex records for a build, when its answer names one: compared with what shipped. */
export function signInRecorded(shipped: string | undefined, project: { embedSdkVersion?: unknown } | undefined) {
  const reported = project?.embedSdkVersion;
  if (!shipped || reported === undefined) return { ok: true } as const;
  if (reported === shipped) return { ok: true } as const;
  return { ok: false, reported: typeof reported === "string" ? reported : "none" } as const;
}

/** A running upload with no recorded outcome that no process here owns: a restart interrupted it. */
export function wasInterrupted(job: GenexPublishJob | undefined, exporting: boolean): job is GenexPublishJob {
  return job?.state === GenexPublishJobState.Running && !job.uploadedAt && !exporting;
}

/** Record that an upload's outcome is unknown after a restart. Never permission to retry it. */
export function markUnknownAfterRestart(job: GenexPublishJob): void {
  (job as InterruptedJob).interruptedIn = job.phase;
  job.state = GenexPublishJobState.Unresolved;
  job.phase = GenexPublishPhase.Unresolved;
  job.error = MESSAGE.UnknownAfterRestart;
}

/** "Check again" may ask Genex about an unresolved upload that recorded no outcome and no process here owns. */
export function canForceSettle(job: GenexPublishJob | undefined, live: boolean, force: boolean): boolean {
  return !live && force && job?.state === GenexPublishJobState.Unresolved && !job.uploadedAt;
}

/** An uploaded draft not yet verified live, whose next check is due (or forced). */
export function deploymentCheckDue(
  job: GenexPublishJob | undefined,
  live: boolean,
  force: boolean,
  now = Date.now(),
): boolean {
  if (live || !job?.uploadedAt || !checksDraftPage(job)) return false;
  if (job.phase === GenexPublishPhase.Ready) return false;
  return force || !job.nextCheckAt || Date.parse(job.nextCheckAt) <= now;
}

/** Whether Genex's record shows the upload did not happen: the draft revision, or the listing, is as before. */
export function uploadMissing(job: GenexPublishJob, before: HostedStaging, now: HostedStaging): boolean {
  if (now.missing) return true;
  const phase = phaseOf(job);
  const updatesDraft = job.kind === GenexPublishKind.Draft || phase === GenexPublishPhase.Uploading;
  if (updatesDraft) return now.revision === before.revision;
  return phase === GenexPublishPhase.Listing && now.status !== GenexHostedStatus.Published;
}

/** A publish that stopped in its draft upload or its test never reached its promotion: the public version is unchanged. */
export const stoppedBeforePromotion = (job: GenexPublishJob): boolean => {
  const phase = phaseOf(job);
  const beforePublic = phase === GenexPublishPhase.Uploading || phase === GenexPublishPhase.VerifyingDeployment;
  return job.kind === GenexPublishKind.Gallery && beforePublic;
};

/**
 * A publish a restart stopped while its draft was being tested: the CLI had finished uploading,
 * nothing was made public, so it is over rather than unknown.
 */
export function interruptedInTest(job: GenexPublishJob | undefined, exporting: boolean): job is GenexPublishJob {
  const testing = job?.phase === GenexPublishPhase.VerifyingDeployment && job.kind === GenexPublishKind.Gallery;
  return testing && job.state === GenexPublishJobState.Running && !job.uploadedAt && !exporting;
}

/** Whether an unknown gallery upload is shown listed by Genex. */
export function listingLanded(job: GenexPublishJob, hosted: HostedStaging): boolean {
  const listing = job.kind === GenexPublishKind.Gallery && phaseOf(job) === GenexPublishPhase.Listing;
  return listing && hosted.status === GenexHostedStatus.Published;
}

/** Close a job as finished: `state` and `phase` both read `outcome`. */
export function finishJob(
  job: GenexPublishJob,
  outcome: typeof GenexPublishJobState.Done | typeof GenexPublishJobState.Failed,
  at: string,
): void {
  job.state = outcome;
  job.phase = outcome;
  job.finishedAt = at;
}

/** How long a publish waits before testing its draft again after `check` failed tries: doubling, capped. */
export const draftRetryDelay = (check: number): number =>
  Math.min(MAX_FOREGROUND_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(check, MAX_BACKOFF_STEPS));

/** Close a job whose build Genex was seen serving: done, and ready to play. */
export function markReady(job: GenexPublishJob, at: string): void {
  job.state = GenexPublishJobState.Done;
  job.phase = GenexPublishPhase.Ready;
  job.finishedAt = at;
  delete job.checkError;
  delete job.nextCheckAt;
}

/**
 * What a finished upload records about the game's pages: when each was updated, the name a
 * publish listed it under, and the page link the CLI printed for this attempt.
 */
export function recordPages(state: GenexPublishState, job: GenexPublishJob, shared: string | undefined, at: string) {
  state.lastPreviewAt = at;
  if (job.kind === GenexPublishKind.Draft) {
    if (shared) state.draftUrl = shared;
    return;
  }
  state.lastPublishAt = at;
  if (job.title) state.title = job.title;
  if (shared) state.galleryUrl = shared;
}

/** When to check an unverified draft again: back off while it is fresh, then poll slowly. */
export function nextDeploymentCheck(job: GenexPublishJob, now = Date.now()): { foreground: boolean; at: string } {
  const foreground = now - Date.parse(job.uploadedAt ?? "") < FOREGROUND_CHECK_MS;
  const backoff = FIRST_RETRY_MS * 2 ** Math.min(job.checkCount ?? 0, MAX_BACKOFF_STEPS);
  const delay = foreground ? Math.min(MAX_FOREGROUND_RETRY_MS, backoff) : BACKGROUND_RETRY_MS;
  return { foreground, at: new Date(now + delay).toISOString() };
}

/** The dashboard a hosted project names for itself, when it is one of ours. */
export function dashboardFor(meta: HostedMeta | null | undefined): string {
  const origin = Array.isArray(meta?.dashboardOrigins) ? meta.dashboardOrigins[0] : undefined;
  return isGenexLink(origin) ? String(origin).replace(/\/+$/, "") : DEFAULT_DASHBOARD;
}

/** Both pages of a hosted game. The CLI prints the same forms; a printed link wins when it is one of ours. */
export function publishUrls(meta: HostedMeta | null | undefined): { draftUrl?: string; galleryUrl?: string } {
  if (!hasSlug(meta)) return {};
  const dashboard = dashboardFor(meta);
  return { draftUrl: `${dashboard}/draft/${meta.slug}`, galleryUrl: `${dashboard}/world/${meta.slug}` };
}

/** Copy what the hosted project says about itself into Studio's publish record. */
export function mergeMeta(state: GenexPublishState, meta: HostedMeta | null | undefined): void {
  if (typeof meta?.slug === "string") state.slug = meta.slug;
  if (typeof meta?.id === "string") state.projectId = meta.id;
  if (meta?.status === GenexHostedStatus.Published || meta?.status === GenexHostedStatus.Draft)
    state.status = meta.status;
  if (isGenexLink(meta?.playUrl)) state.playUrl = meta.playUrl;
  Object.assign(state, publishUrls(meta));
}

/** The page link the CLI printed for sharing, when it is one of ours. */
export function shareLink(out: string): string | undefined {
  for (const line of stripAnsi(out).split("\n")) {
    if (!/page|share this link/i.test(line)) continue;
    const match = line.match(/https:\/\/[^\s)]+/);
    if (match && isGenexLink(match[0])) return match[0];
  }
  return undefined;
}

/** The staging URL the CLI printed after "Live." or "Published.": ours, or the fixture API's own origin. */
export function stagingLink(out: string, api: string): string | undefined {
  const apiUrl = new URL(api);
  const isFixtureOrigin = (value: string) => apiUrl.hostname === "127.0.0.1" && new URL(value).origin === apiUrl.origin;
  return stripAnsi(out)
    .split("\n")
    .filter((line) => /Live\.|Published\./.test(line))
    .flatMap((line) => line.match(/https?:\/\/[^\s)]+/g) ?? [])
    .find((value) => isGenexLink(value) || isFixtureOrigin(value));
}

/** Which page a "publish-open" action may open. */
export const PublishLinkTarget = { Draft: "draft", Gallery: "gallery", Play: "play" } as const;
export type PublishLinkTarget = (typeof PublishLinkTarget)[keyof typeof PublishLinkTarget];
const LINK_TARGETS = new Set<string>(Object.values(PublishLinkTarget));

/** The requested link target, defaulting to the draft page. */
export const linkTarget = (target: string | undefined): PublishLinkTarget =>
  target !== undefined && LINK_TARGETS.has(target) ? (target as PublishLinkTarget) : PublishLinkTarget.Draft;

/** The page link for a target: the play link is the verified draft, or the listed game's own. */
export function linkFor(state: GenexPublishState, target: PublishLinkTarget): string | undefined {
  if (target === PublishLinkTarget.Gallery) return state.galleryUrl;
  if (target === PublishLinkTarget.Draft) return state.draftUrl;
  return state.readyDraft?.url ?? (state.status === GenexHostedStatus.Published ? state.playUrl : undefined);
}
