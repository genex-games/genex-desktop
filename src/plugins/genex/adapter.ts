import { markDeployment, verifyDeployment } from "./deployment.ts";
import path from "node:path";
import { recordGenexUse, type GenexObserver } from "../../substrate/genex-outcomes.ts";
import { fileURLToPath } from "node:url";
import { SessionCredentials } from "../../substrate/session-credentials.ts";
import { SecretStore } from "../../substrate/secrets.ts";
import { deliverGenexFiles } from "../../substrate/genex-delivery.ts";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, lstat, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import { writeFile } from "node:fs/promises";
import {
  cleanGenexTitle,
  defaultGenexTitle,
  GENEX_COVERS_DIR,
  GenexCoverOutcome,
  type GenexCoverSent,
  GenexHostedStatus,
  GenexJobStatus,
  GenexOperation,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexGameManifest,
  type GenexJob,
  type GenexPublishJob,
  type GenexPublishState,
  type GenexRequest,
  type GenexStatus,
} from "../../shared/genex.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { PluginStillProblemCode } from "../../shared/plugins.ts";
import { GenexCliStopped, runGenexCli, genexCliPath } from "./cli.ts";
import {
  adviceLines,
  type CoverAnswer,
  type CoverCamera,
  coverAdvice,
  coverDelivery,
  CoverOperation,
  coverRides,
  type CoverView,
  COVER_SEND_TIMEOUT_MS,
  COVER_VIEW_TIMEOUT_MS,
  decideSend,
  DELIVERY_GUIDANCE,
  freezeShot,
  INVOCATION_BUDGET_MS,
  keptOwnerRecord,
  MESSAGE as COVER_MESSAGE,
  MIN_REMAINING_FOR_SHOT_MS,
  noneRecord,
  OUTCOME_GUIDANCE,
  ownerPick,
  parseCoverAnswer,
  parseCoverView,
  PROBLEM_GUIDANCE,
  PUBLISH_SHOT_TIMEOUT_MS,
  readSent,
  readShot,
  readStillAnswer,
  reshootLine,
  saveShot,
  sentRecord,
  statusGuidance,
  unchangedRecord,
  writeSent,
} from "./cover.ts";
import { windowsBaseEnv } from "../../substrate/child-env.ts";
import { envPath } from "../../substrate/toolchain.ts";
import {
  ACCEPT_URL,
  GenexRoute,
  genexFetch,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
  isGenexAuthorizationUrl,
  isGenexLink,
  statusOf,
  withSignal,
} from "./http.ts";
import {
  APPROVAL_OPERATIONS,
  cliArgsFor,
  READ_OPERATIONS,
  REMESH_FACES,
  TOOL_OPERATIONS,
  USE_OPERATIONS,
  validateGenexRequest,
} from "./request.ts";
import {
  approvalImageUrl,
  approvalLabels,
  deliveredElsewhereMessage,
  failedJobStatus,
  fetchApprovalImage,
  fetchDesktopVariant,
  filesPresent,
  hasDownloadableResult,
  isRemoteFailure,
  isUncertainSubmit,
  JOB_ID,
  jobStatusFromRemote,
  reconciledJobStatus,
  manifestFromView,
  readLedger,
  RECONCILE_BATCH,
  settledFailureStatus,
  siblingWithFiles,
  type LedgerRow,
  type ReviewAnswer,
} from "./jobs.ts";
import {
  canForceSettle,
  checksDraftPage,
  deploymentCheckDue,
  DRAFT_TEST_MS,
  draftRetryDelay,
  finishJob,
  interruptedInTest,
  markReady,
  linkFor,
  linkTarget,
  listingLanded,
  markUnknownAfterRestart,
  MAX_UPLOADS,
  mergeMeta,
  MESSAGE as PUBLISH_MESSAGE,
  needsRelisting,
  nextDeploymentCheck,
  publicSteps,
  publishArgs,
  publishPhaseFor,
  recordPages,
  PUBLISH_ERROR_TAIL_CHARS,
  PublishLinkTarget,
  shareLink,
  signInRecorded,
  stagingLink,
  stoppedBeforePromotion,
  uploadMissing,
  wasInterrupted,
  workspaceManifest,
  type HostedMeta,
  type HostedStaging,
  type InterruptedJob,
} from "./publish.ts";

export { validateGenexRequest } from "./request.ts";
export { genexCliEnv, parseGenexJson } from "./cli.ts";

const ASSET_TIMEOUT_MS = 3 * MINUTE_MS;
/** An upload of a whole game, not a request: the CLI builds, pushes source and deploys in one run. */
const PUBLISH_TIMEOUT_MS = 20 * MINUTE_MS;
/** Bounded so a waiting agent answers well inside the host's 190 s invocation ceiling. */
const PUBLISH_WAIT_MS = 150_000;
const MIN_PUBLISH_WAIT_MS = SECOND_MS;
/** How long a verified sign-in is trusted before status asks Genex again. */
const SESSION_CACHE_MS = 2 * MINUTE_MS;
/** Genex's device flow never asks Studio to poll faster than this. */
const MIN_POLL_INTERVAL_S = 5;
/** The workspace folder name: letters, digits, `_` and `-` only, so it can never be a path. */
const PROJECT_NAME = /^[a-zA-Z0-9_-]+$/;
const DEVICE_LABEL = "AI Game Studio";

/** Where Genex's device sign-in stands, as its poll answers. */
const DeviceStatus = { Approved: "approved", Denied: "denied", Expired: "expired" } as const;
const DEVICE_ENDED = new Set<string>([DeviceStatus.Denied, DeviceStatus.Expired]);

const MESSAGE = {
  SignInCanceled: "Sign-in was canceled",
  UnexpectedAuthorization: "Unexpected authorization URL",
  ConnectBadge: "Connect Genex to use assets",
  SignInExpired: "Genex sign-in expired. Reconnect your account.",
  StoppedBeforeSubmission: "Stopped before Genex submission",
  ConnectToGenerate: "Connect Genex to generate assets.",
  InspectWithStudioId: "Use the delivered Studio job id for an asset inspection",
  NotThisProject: "Asset job does not belong to this project",
  ApprovalNeedsSource: "Approval requires an existing concept or preview generation",
  ApprovalViewsMissing: "Approval cannot proceed: required candidate/preview views are unavailable",
  InvalidApproval: "Invalid approval",
  ApprovalNotPending: "Approval is no longer pending",
  ChooseCandidate: "Choose candidate 1, 2, or 3",
  CredentialsUninitialized: "Genex credentials are not initialized",
} as const;

/** `genex cover` exits 0 for a frame set or outranked and 1 for any other answer: both are answers. */
const COVER_ANSWER_EXIT_CODES = [0, 1] as const;
/** How a cover answer names the shot it sent, in place of its path in Studio's storage. */
const COVER_SHOT_NAME = "the genex-cover shot";

/** The preview candidates a user may pick from. */
const PREVIEW_CANDIDATES = [1, 2, 3];

async function readJsonOr<T>(file: string): Promise<T | null>;
async function readJsonOr<T>(file: string, fallback: T): Promise<T>;
async function readJsonOr<T>(file: string, fallback: T | null = null): Promise<T | null> {
  return JSON.parse(await readFile(file, "utf8").catch(() => JSON.stringify(fallback)));
}

/** The CLI's record of a publish workspace's hosted project. */
const metaFile = (dir: string) => path.join(dir, ".genex/project.json");

/** An approval as the agent sees it: the images stay in Studio for the user to review. */
const approvalSummary = (approval: NonNullable<GenexJob["approval"]>) => ({
  sourceId: approval.sourceId,
  reviewInStudio: true,
});

/** A status whose sign-in Genex no longer accepts. */
function markSignedOut(result: GenexStatus): void {
  result.connected = false;
  result.enabled = false;
  result.accountVerified = false;
  result.error = MESSAGE.SignInExpired;
}

/** Whether a controller registered for `scope` belongs to the project and thread being cancelled. */
const coversScope = (scope: { project: string; threadId?: string }, project?: string, threadId?: string) =>
  (!project || scope.project === project) && (!threadId || scope.threadId === threadId);

/** Where one publish attempt got to before it failed. */
interface PublishAttempt {
  submitted: boolean;
  slug?: unknown;
  before?: HostedStaging;
}

/** A draft Genex was seen serving: the upload's revision, its page and its files' digest. */
type ReadyDraft = NonNullable<GenexPublishState["readyDraft"]>;

/** One cover send running for a game: the publish it trails (none for genex__cover-set) and how to stop it. */
interface CoverStep {
  jobId?: string;
  controller: AbortController;
  done: Promise<GenexCoverSent | null>;
}

/** How long the cover's own steps may take; tests shorten them. */
interface CoverTimeouts {
  shotMs: number;
  sendMs: number;
  viewMs: number;
}

/** The value a race against a timer gives when the timer wins. */
const TIMED_OUT = Symbol("timed out");

/** `promise`'s value, or {@link TIMED_OUT} once `ms` have passed; the timer never outlives the race. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  const timer = new AbortController();
  try {
    return await Promise.race([promise, sleep(ms, TIMED_OUT, { signal: timer.signal })]);
  } finally {
    timer.abort();
  }
}

/** One running publish: its game, Studio's copy and the CLI's HOME in it, its job and how to stop it. */
interface PublishRun {
  project: string;
  dir: string;
  home: string;
  job: GenexPublishJob;
  signal: AbortSignal;
  attempt: PublishAttempt;
}

interface PendingAuthorization {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  expiresAt: number;
  nextPoll: number;
  interval: number;
}

const authorizationView = (auth: PendingAuthorization) => ({
  userCode: auth.userCode,
  verifyUrl: auth.verifyUrl,
  expiresAt: auth.expiresAt,
});

export interface GenexCredentials {
  get(): Promise<string | null>;
  set(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Host-owned adapter. Genex CLI remains the sole owner of admission/credit bookkeeping. */
export class GenexTools {
  readonly root: string;
  readonly api: string;
  #credentials: GenexCredentials | undefined;
  readonly #preload: string;
  readonly #observe: GenexObserver | undefined;
  readonly #deliver: typeof deliverGenexFiles;
  #initialized: Promise<void> | undefined;
  #auth: PendingAuthorization | null = null;
  #authEpoch = 0;
  #disconnecting = false;
  #accountTail: Promise<void> = Promise.resolve();
  #account<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#accountTail.then(fn, fn);
    this.#accountTail = next.then(
      () => {},
      () => {},
    );
    return next;
  }
  #controllers = new Map<AbortController, { project: string; threadId?: string }>();
  /** The publish running in this process, per game. Absent after a restart: the record then reconciles. */
  #sessionIdentity: { token: string; expires: number; session: any } | undefined;
  #exporting = new Set<string>();
  #readinessChecks = new Map<string, Promise<void>>();
  #publishJobs = new Map<string, { job: GenexPublishJob; done: Promise<void> }>();
  /** The cover send running per game: the one a publish leaves behind it, or genex__cover-set's. */
  #coverSteps = new Map<string, CoverStep>();
  /** The last write to a game's kept shot, or a send's read of it: each waits for the one before. */
  #coverWrites = new Map<string, Promise<unknown>>();
  /** How long a publish's new draft has to pass its test before the publish gives up on going public. */
  readonly #draftTestMs: number;
  readonly #coverTimeouts: CoverTimeouts;
  /** The tools' clock: a publish's shot is measured against the invocation it runs in. */
  readonly #now: () => number;
  constructor(
    root: string,
    api = "https://api.genex.games",
    options: {
      credentials?: GenexCredentials;
      preload?: string;
      observe?: GenexObserver;
      deliver?: typeof deliverGenexFiles;
      draftTestMs?: number;
      coverTimeouts?: Partial<CoverTimeouts>;
      now?: () => number;
    } = {},
  ) {
    this.root = root;
    this.api = api;
    this.#draftTestMs = options.draftTestMs ?? DRAFT_TEST_MS;
    this.#coverTimeouts = {
      shotMs: options.coverTimeouts?.shotMs ?? PUBLISH_SHOT_TIMEOUT_MS,
      sendMs: options.coverTimeouts?.sendMs ?? COVER_SEND_TIMEOUT_MS,
      viewMs: options.coverTimeouts?.viewMs ?? COVER_VIEW_TIMEOUT_MS,
    };
    this.#now = options.now ?? Date.now;
    this.#credentials = options.credentials;
    this.#observe = options.observe;
    this.#deliver = options.deliver ?? deliverGenexFiles;
    this.#preload = options.preload ?? fileURLToPath(new URL("../../genex-host/preload.mjs", import.meta.url));
  }
  async init() {
    this.#initialized ??= (async () => {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      if (!this.#credentials) {
        const dir = path.join(this.root, "credentials");
        // Opening or polling the panel must not open Keychain. Only explicit UI unlock/sign-in
        // reaches this lazy backend. Never auto-import credentials during initialization.
        const store = () => SecretStore.open(dir);
        this.#credentials = new SessionCredentials({
          get: async () => {
            if (!(await lstat(path.join(dir, "genex.bin")).catch(() => null))) return null;
            return (await store()).get("genex");
          },
          set: async (token) => (await store()).set("genex", token),
          clear: async () => {
            await rm(path.join(dir, "genex.bin"), { force: true });
          },
        });
      }
    })();
    await this.#initialized;
  }
  /** The credential store, which {@link init} always provides. */
  async #store(): Promise<GenexCredentials> {
    await this.init();
    if (!this.#credentials) throw new Error(MESSAGE.CredentialsUninitialized);
    return this.#credentials;
  }
  async unlock() {
    await this.init();
    if (this.#credentials instanceof SessionCredentials) await this.#credentials.unlock();
  }
  async #token() {
    return (await this.#store()).get();
  }
  async #fetch(route: string, init: RequestInit = {}) {
    return genexFetch(this.api, route, await this.#token(), init);
  }
  async connect() {
    if (this.#auth && this.#auth.expiresAt > Date.now()) return authorizationView(this.#auth);
    this.#authEpoch += 1;
    const epoch = this.#authEpoch;
    await this.init();
    const d = await this.#fetch(GenexRoute.DeviceStart, {
      method: "POST",
      body: JSON.stringify({ label: DEVICE_LABEL }),
    });
    if (epoch !== this.#authEpoch) throw new Error(MESSAGE.SignInCanceled);
    if (!isGenexAuthorizationUrl(new URL(d.verifyUrl))) throw new Error(MESSAGE.UnexpectedAuthorization);
    this.#auth = {
      deviceCode: d.deviceCode,
      userCode: d.userCode,
      verifyUrl: d.verifyUrl,
      expiresAt: Date.now() + d.expiresIn * SECOND_MS,
      nextPoll: 0,
      interval: Math.max(MIN_POLL_INTERVAL_S, d.interval ?? MIN_POLL_INTERVAL_S) * SECOND_MS,
    };
    return { userCode: d.userCode, verifyUrl: d.verifyUrl, expiresAt: this.#auth.expiresAt };
  }
  cancel(project?: string, threadId?: string) {
    for (const [c, scope] of this.#controllers) if (coversScope(scope, project, threadId)) c.abort();
  }
  cancelConnect() {
    ++this.#authEpoch;
    this.#auth = null;
  }
  async disconnect() {
    ++this.#authEpoch;
    this.#disconnecting = true;
    this.#auth = null;
    this.#sessionIdentity = undefined;
    for (const c of this.#controllers.keys()) c.abort();
    await this.#account(async () => {
      await (await this.#store()).clear();
    });
  }
  async setupBadge() {
    if (!(await this.#token())) return { badge: "Connect", tone: "warn", title: MESSAGE.ConnectBadge };
    return {};
  }
  async #workspace(project: string) {
    if (!PROJECT_NAME.test(project)) throw new Error(PUBLISH_MESSAGE.InvalidProject);
    const cwd = path.join(this.root, "projects", project);
    await mkdir(path.join(cwd, ".genex"), { recursive: true });
    await atomicWriteJson(path.join(cwd, ".genex/workspace.json"), { mode: "tools", version: 1 });
    return cwd;
  }
  /**
   * The publish workspace: Studio's own copy of the game, never the user's folder.
   * `publish.json` is Studio's record, `.genex/project.json` is the CLI's hosted identity,
   * `dist/` is the exported game the CLI uploads, `.genex-agent/` takes `init --dir`'s templates
   * and `home/` is the CLI's HOME. No `.genex/workspace.json` here: a tools workspace with no
   * hosted project is refused the publishing commands.
   */
  #publishDir(project: string) {
    if (!PROJECT_NAME.test(project)) throw new Error(PUBLISH_MESSAGE.InvalidProject);
    return path.join(this.root, "publish", project);
  }
  async #publishWorkspace(project: string) {
    const dir = this.#publishDir(project);
    await mkdir(path.join(dir, "home"), { recursive: true, mode: 0o700 });
    await mkdir(path.join(dir, "dist"), { recursive: true, mode: 0o700 });
    // The CLI pushes this folder as the game's source; Studio's private HOME is not part of it.
    await writeFile(path.join(dir, ".gitignore"), "home/\n");
    return dir;
  }
  async #publishState(project: string): Promise<GenexPublishState> {
    const fallback: GenexPublishState = { version: 1, project, connected: false };
    const state = await readJsonOr(path.join(this.#publishDir(project), "publish.json"), fallback);
    return { ...state, version: 1, project };
  }
  async #savePublishState(project: string, state: GenexPublishState) {
    await atomicWriteJson(path.join(this.#publishDir(project), "publish.json"), state);
  }
  /** Save `job` into the latest publish record, carrying its error to `lastError`. */
  async #persistJob(project: string, job: GenexPublishJob) {
    const state = await this.#publishState(project);
    state.job = job;
    if (job.error) state.lastError = job.error;
    await this.#savePublishState(project, state);
  }
  async #run(command: string, args: string[], cwd: string, home: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd,
        // Windows also needs its basics to run git at all, the profile kept inside `home`.
        env: {
          ...windowsBaseEnv(process.env, process.platform, home),
          PATH: envPath(process.env),
          HOME: home,
          TMPDIR: process.env.TMPDIR,
        },
        stdio: "ignore",
      });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
    });
  }
  /**
   * The CLI always pushes the game's source, so git must already be here. Studio installs nothing:
   * the pinned CLI's `pushSource` runs `brew install git-lfs` / `sudo apt-get install git-lfs` when
   * git-lfs is missing, so a machine without it is refused here, before the CLI is ever spawned.
   */
  async #gitReady(dir: string, home: string): Promise<void> {
    if (!(await this.#run("git", ["--version"], dir, home))) throw new Error(PUBLISH_MESSAGE.NeedsGit);
    if (!(await this.#run("git", ["lfs", "version"], dir, home))) throw new Error(PUBLISH_MESSAGE.NeedsGitLfs);
  }
  /** What Studio knows about this game's pages. Read-only: it never starts or resumes an upload. */
  async publishStatus(project: string, force = false): Promise<GenexPublishState> {
    await this.init();
    const state = await this.#publishState(project);
    state.connected = !!(await this.#token());
    mergeMeta(state, await readJsonOr<HostedMeta>(metaFile(this.#publishDir(project))));
    const live = this.#publishJobs.get(project);
    if (live) state.job = live.job;
    else if (interruptedInTest(state.job, this.#exporting.has(project))) {
      // The CLI had finished uploading and nothing was made public: the attempt is over, not unknown.
      finishJob(state.job, GenexPublishJobState.Failed, new Date().toISOString());
      state.job.error = PUBLISH_MESSAGE.OnlyDraftUpdated;
      await this.#savePublishState(project, state);
    } else if (wasInterrupted(state.job, this.#exporting.has(project))) {
      // A restart is never permission to retry an upload whose outcome is unknown.
      markUnknownAfterRestart(state.job);
      await this.#savePublishState(project, state);
    }
    // "Check again" on an upload with no recorded outcome asks Genex what it holds.
    if (canForceSettle(state.job, Boolean(live), force)) await this.#settleUnknownUpload(project, state);
    if (deploymentCheckDue(state.job, Boolean(live), force)) await this.#checkDeployment(project, state);
    return state;
  }
  /**
   * What Genex holds for this slug: the staging revision (null when there is none, or no hosted
   * project at all) and the listing status. `undefined` when Genex could not be asked: no answer
   * is evidence of nothing.
   */
  async #hostedStaging(slug: unknown): Promise<HostedStaging | undefined> {
    if (typeof slug !== "string" || !slug) return { revision: null, missing: true };
    try {
      const project = (await this.#fetch(GenexRoute.projectBySlug(slug)))?.project;
      const revision = project?.stagingCommitSha ?? project?.stagingCommit;
      return {
        revision: typeof revision === "string" && revision ? revision : null,
        ...(typeof project?.status === "string" ? { status: project.status } : {}),
      };
    } catch (error) {
      return statusOf(error) === HTTP_NOT_FOUND ? { revision: null, missing: true } : undefined;
    }
  }
  /**
   * "Check again" for an upload that ended with no recorded outcome (a quit mid-upload). Never a
   * retry: the hosted revision still equal to the last one Studio verified means nothing landed,
   * so a new upload is allowed; a moved revision is recorded as this upload and verified.
   */
  async #settleUnknownUpload(project: string, state: GenexPublishState): Promise<void> {
    const job = state.job;
    if (!job) return;
    const checkedAt = new Date().toISOString();
    job.lastCheckedAt = checkedAt;
    job.checkCount = (job.checkCount ?? 0) + 1;
    const hosted = await this.#hostedStaging(state.slug);
    if (!hosted) {
      job.checkError = PUBLISH_MESSAGE.CannotReach;
      await this.#savePublishState(project, state);
      return;
    }
    delete job.checkError;
    const before = { revision: state.readyDraft?.revision ?? null, status: GenexHostedStatus.Draft };
    if (uploadMissing(job, before, hosted)) {
      finishJob(job, GenexPublishJobState.Failed, checkedAt);
      job.error = PUBLISH_MESSAGE.DidNotLand;
    } else if (stoppedBeforePromotion(job)) {
      finishJob(job, GenexPublishJobState.Failed, checkedAt);
      job.error = PUBLISH_MESSAGE.OnlyDraftUpdated;
    } else if (job.kind === GenexPublishKind.Draft && hosted.revision) {
      await this.#adoptHostedRevision(project, state, job, hosted.revision, checkedAt);
      return;
    } else if (listingLanded(job, hosted)) {
      finishJob(job, GenexPublishJobState.Done, checkedAt);
      delete job.error;
      state.status = GenexHostedStatus.Published;
    } else job.checkError = PUBLISH_MESSAGE.CannotTell;
    await this.#savePublishState(project, state);
  }
  /** A moved hosted revision is this upload: record it, then verify it like a fresh one. */
  async #adoptHostedRevision(
    project: string,
    state: GenexPublishState,
    job: GenexPublishJob,
    revision: string,
    at: string,
  ): Promise<void> {
    job.uploadedAt = at;
    job.expectedStagingRevision = revision;
    job.state = GenexPublishJobState.Running;
    job.phase = GenexPublishPhase.VerifyingDeployment;
    delete job.error;
    await this.#savePublishState(project, state);
    await this.#checkDeployment(project, state);
  }
  /**
   * The explicit, confirmed way out of an unresolved upload: the user checked the deployment page
   * and allows a new upload. Only the job they looked at, and never one still running here.
   */
  async publishAllowNewUpload(project: string, jobId: string): Promise<GenexPublishState> {
    return this.#account(async () => {
      if (this.#publishJobs.has(project)) throw new Error(PUBLISH_MESSAGE.StillRunning);
      const state = await this.publishStatus(project);
      if (!state.job || state.job.id !== jobId) throw new Error(PUBLISH_MESSAGE.NotCurrent);
      if (state.job.state !== GenexPublishJobState.Unresolved) return state;
      finishJob(state.job, GenexPublishJobState.Failed, new Date().toISOString());
      state.job.error = PUBLISH_MESSAGE.AllowedNewUpload;
      await this.#savePublishState(project, state);
      return state;
    });
  }
  /**
   * Export this game and put it on its unlisted draft page only, creating the hosted project once.
   * Until the game is public its draft also shoots and sends the cover (`camera`). Serialized on the
   * account tail like every other account-scoped operation, so two presses in one window can never
   * run two CLIs in one workspace.
   */
  async publishDraft(
    project: string,
    exportStage?: () => Promise<unknown>,
    camera?: CoverCamera,
  ): Promise<GenexPublishState> {
    return this.#account(() =>
      this.#startPublish(project, GenexPublishKind.Draft, { exportStage, ...(camera ? { camera } : {}) }),
    );
  }
  /**
   * Publish: export this game, put it on the draft page, test it there and make that same build
   * the public version, creating the hosted project and the gallery listing the first time. `title`
   * is the name it is listed under: the last one Studio listed, else its folder name, as words.
   * `camera` shoots the genex-cover demo again; that frame is sent once the publish is recorded.
   */
  async publishGallery(
    project: string,
    exportStage: () => Promise<unknown>,
    title?: unknown,
    camera?: CoverCamera,
  ): Promise<GenexPublishState> {
    return this.#account(() =>
      this.#startPublish(project, GenexPublishKind.Gallery, { exportStage, title, ...(camera ? { camera } : {}) }),
    );
  }
  /** Record Genex's terms answer; false when the user still has to accept them. */
  async #termsAccepted(project: string, state: GenexPublishState): Promise<boolean> {
    const legal = await this.#fetch(GenexRoute.LegalStatus).catch((error) => {
      const status = statusOf(error);
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN)
        throw new Error(PUBLISH_MESSAGE.AuthorizationExpired);
      throw error;
    });
    if (typeof legal?.accepted === "boolean") state.terms = { accepted: legal.accepted, acceptUrl: ACCEPT_URL };
    if (legal?.accepted !== false) return true;
    await this.#savePublishState(project, state);
    return false;
  }
  async #startPublish(
    project: string,
    kind: GenexPublishKind,
    { exportStage, title, camera }: { exportStage?: () => Promise<unknown>; title?: unknown; camera?: CoverCamera },
  ): Promise<GenexPublishState> {
    const state = await this.publishStatus(project);
    if (!state.connected) throw new Error(PUBLISH_MESSAGE.ConnectFirst);
    if (!(await this.#termsAccepted(project, state))) return state;
    const busy =
      state.job?.state === GenexPublishJobState.Running || state.job?.state === GenexPublishJobState.Unresolved;
    if (busy) return state;
    // A newer publish replaces the last one's cover send: it shoots and sends its own frame.
    await this.#stopCoverStep(project);
    const dir = await this.#publishWorkspace(project);
    await this.#gitReady(dir, path.join(dir, "home"));
    const meta = await readJsonOr<HostedMeta>(metaFile(dir));
    const job: GenexPublishJob = {
      id: randomUUID(),
      kind,
      state: GenexPublishJobState.Running,
      phase: publishPhaseFor(meta),
      startedAt: new Date().toISOString(),
    };
    if (kind === GenexPublishKind.Gallery)
      job.title = cleanGenexTitle(title) ?? state.title ?? defaultGenexTitle(project);
    if (exportStage) await this.#exportGame(project, state, job, dir, exportStage);
    const cover = coverRides(kind, state);
    // The shot is taken here, inside the invocation: a detached upload gets no answer from host services.
    const shotLines = cover && camera ? await this.#reshoot(project, camera) : [];
    state.job = job;
    delete state.warnings;
    if (shotLines.length) state.warnings = shotLines;
    delete state.lastError;
    await this.#savePublishState(project, state);
    const done = this.#runPublishJob(project, kind, job, cover);
    this.#publishJobs.set(project, { job, done });
    this.#exporting.delete(project);
    void done.finally(() => {
      if (this.#publishJobs.get(project)?.job === job) this.#publishJobs.delete(project);
    });
    return this.#withCover(project, { ...state, job });
  }
  /** Export the game into the publish workspace and mark it, inside the invocation that asked. */
  async #exportGame(
    project: string,
    state: GenexPublishState,
    job: GenexPublishJob,
    dir: string,
    exportStage: () => Promise<unknown>,
  ): Promise<void> {
    this.#exporting.add(project);
    try {
      const startPhase = job.phase;
      job.phase = GenexPublishPhase.Exporting;
      state.job = job;
      await this.#savePublishState(project, state);
      const exported = (await exportStage()) as { files?: unknown; genex?: GenexGameManifest } | null;
      state.lastExportAt = new Date().toISOString();
      const files = exported?.files;
      if (Number.isSafeInteger(files)) job.export = { files: files as number };
      await this.#writeWorkspaceManifest(dir, project, job, exported?.genex);
      job.deployment = await markDeployment(path.join(dir, "dist"), job.id);
      job.phase = startPhase;
    } catch (error) {
      job.state = GenexPublishJobState.Failed;
      job.phase = GenexPublishPhase.Failed;
      job.error = String(error);
      state.job = job;
      await this.#savePublishState(project, state);
      this.#exporting.delete(project);
      throw error;
    }
  }
  /**
   * The CLI tells Genex what the game ships (sign-in support above all) from the package.json of
   * the folder it runs in: Studio's copy gets the game's Genex part of it, or none.
   */
  async #writeWorkspaceManifest(
    dir: string,
    project: string,
    job: GenexPublishJob,
    manifest: GenexGameManifest | undefined,
  ): Promise<void> {
    const pkg = workspaceManifest(project, manifest);
    const file = path.join(dir, "package.json");
    if (!pkg) {
      await rm(file, { force: true });
      return;
    }
    await atomicWriteJson(file, pkg);
    const embed = manifest?.dependencies["@genex-ai/embed-sdk"];
    if (embed) job.embedSdkVersion = embed;
  }
  /**
   * The upload itself, detached from the invocation that asked for it. Every phase is persisted. A
   * publish tests the uploaded draft before anything goes public, and only then promotes and lists it.
   * Only once the upload is recorded does `cover` send the game's frame, as a step of its own: a
   * cover can never hold up or fail a publish, and a quit mid-send loses only the cover. A draft
   * asks again then, from what Genex just said: a game its owner listed on genex.games since
   * Studio last looked is public, and its draft sends nothing.
   */
  async #runPublishJob(project: string, kind: GenexPublishKind, job: GenexPublishJob, cover: boolean): Promise<void> {
    const dir = this.#publishDir(project);
    const home = path.join(dir, "home");
    const controller = new AbortController();
    this.#controllers.set(controller, { project });
    const run: PublishRun = { project, dir, home, job, signal: controller.signal, attempt: { submitted: false } };
    try {
      const meta = await this.#ensureHostedProject(project, dir, home, job, controller.signal);
      run.attempt.slug = meta.slug;
      const outs = kind === GenexPublishKind.Draft ? [await this.#uploadDraft(run)] : await this.#uploadTested(run);
      if (!outs) return;
      const relist = needsRelisting(meta, (await this.#publishState(project)).title, job.title);
      const listing = { title: job.title };
      for (const phase of publicSteps(meta, kind, relist)) outs.push(await this.#runStep(run, phase, listing));
      await this.#recordUpload(project, dir, kind, job, meta, outs);
      if (cover && coverRides(kind, await this.#pages(project))) this.#startCoverStep(project, job.id);
    } catch (error) {
      await this.#failPublishJob(project, job, run.attempt, error);
    } finally {
      this.#controllers.delete(controller);
    }
  }
  /** One CLI phase, persisted first, with Genex's record read just before anything is uploaded. */
  async #runStep(
    run: PublishRun,
    phase: GenexPublishPhase,
    listing: Parameters<typeof publishArgs>[1] = {},
  ): Promise<string> {
    run.job.phase = phase;
    await this.#persistJob(run.project, run.job);
    // Genex's record just before an upload: a failed CLI that left it as it was sent nothing.
    // A promotion changes no revision, so there is nothing to compare it against.
    run.attempt.before =
      phase === GenexPublishPhase.Promoting ? undefined : await this.#hostedStaging(run.attempt.slug);
    run.attempt.submitted = true;
    return (await this.#cliText(run.dir, publishArgs(phase, listing), run.signal, run.home)).out;
  }
  /**
   * Upload the build to the draft page. A CLI that failed while Genex's record shows nothing
   * landed is tried once more, quietly; any other failure, or a second one, ends the attempt.
   */
  async #uploadDraft(run: PublishRun): Promise<string> {
    for (;;) {
      run.job.uploads = (run.job.uploads ?? 0) + 1;
      try {
        return await this.#runStep(run, GenexPublishPhase.Uploading);
      } catch (error) {
        const again = (run.job.uploads ?? 0) < MAX_UPLOADS && (await this.#nothingLanded(run));
        if (!again) throw error;
      }
    }
  }
  /** Whether Genex's record is as it was before the failed upload: nothing reached it. */
  async #nothingLanded(run: PublishRun): Promise<boolean> {
    if (!run.attempt.before) return false;
    const afterward = await this.#hostedStaging(run.attempt.slug);
    return Boolean(afterward && uploadMissing(run.job, run.attempt.before, afterward));
  }
  /**
   * Upload the draft and test it until it passes, uploading once more when it does not. Null when
   * it never passed: the attempt is then closed as failed, and nothing was made public.
   */
  async #uploadTested(run: PublishRun): Promise<string[] | null> {
    const outs: string[] = [];
    while ((run.job.uploads ?? 0) < MAX_UPLOADS) {
      const out = await this.#uploadDraft(run);
      outs.push(out);
      if (await this.#draftPasses(run, out)) return outs;
    }
    finishJob(run.job, GenexPublishJobState.Failed, new Date().toISOString());
    run.job.error = PUBLISH_MESSAGE.DraftFailedTest;
    await this.#persistJob(run.project, run.job);
    return null;
  }
  /**
   * Test the draft an upload just put online: Genex serves this upload's revision, every exported
   * file, and records the sign-in support it shipped. Tried again with backoff until the test time
   * is up; a pass is recorded as the ready draft.
   */
  async #draftPasses(run: PublishRun, out: string): Promise<boolean> {
    const { job } = run;
    const meta = await readJsonOr<HostedMeta>(metaFile(run.dir));
    job.expectedStagingRevision = meta?.stagingCommit;
    job.stagingUrl = stagingLink(out, this.api);
    job.phase = GenexPublishPhase.VerifyingDeployment;
    delete job.checkError;
    await this.#persistJob(run.project, job);
    const deadline = Date.now() + this.#draftTestMs;
    for (let check = 0; ; check++) {
      try {
        const ready = await this.#confirmDraft(run.attempt.slug, job);
        const state = await this.#publishState(run.project);
        state.readyDraft = { ...ready, verifiedAt: new Date().toISOString() };
        state.job = job;
        delete job.checkError;
        await this.#savePublishState(run.project, state);
        return true;
      } catch (error) {
        job.checkError = (error as Error).message;
        job.checkCount = (job.checkCount ?? 0) + 1;
        await this.#persistJob(run.project, job);
      }
      const wait = Math.min(draftRetryDelay(check), deadline - Date.now());
      if (wait <= 0) return false;
      await sleep(wait, undefined, { signal: run.signal });
    }
  }
  /** The hosted project this workspace publishes to, created on the first upload. */
  async #ensureHostedProject(
    project: string,
    dir: string,
    home: string,
    job: GenexPublishJob,
    signal: AbortSignal,
  ): Promise<HostedMeta> {
    const existing = await readJsonOr<HostedMeta>(metaFile(dir));
    if (existing?.slug) return existing;
    job.phase = GenexPublishPhase.CreatingProject;
    await this.#persistJob(project, job);
    // Without `--no-auth` the fd-3 token satisfies the CLI, so the hosted project is created here
    // and nowhere near the user's game folder.
    await this.#cliText(dir, ["init", project, "--dir", path.join(dir, ".genex-agent")], signal, home);
    const created = await readJsonOr<HostedMeta>(metaFile(dir));
    if (!created?.slug) throw new Error(PUBLISH_MESSAGE.NoHostedProject);
    return created;
  }
  /**
   * Finished CLI runs, one output per step: record the pages they printed, then verify the draft
   * page an export was uploaded to, or close a listing that uploaded none.
   */
  async #recordUpload(
    project: string,
    dir: string,
    kind: GenexPublishKind,
    job: GenexPublishJob,
    meta: HostedMeta,
    outs: string[],
  ): Promise<void> {
    const state = await this.#publishState(project);
    const fresh = await this.#refreshHosted(dir, (await readJsonOr<HostedMeta>(metaFile(dir))) ?? meta);
    mergeMeta(state, fresh);
    // The last step prints the page this attempt was for: the draft's, or the public one.
    const shared = shareLink(outs.at(-1) ?? "");
    const now = new Date().toISOString();
    const draft = kind === GenexPublishKind.Draft;
    // A publish tested its draft before promoting it; a draft is verified from here on.
    const verify = draft && checksDraftPage(job);
    recordPages(state, job, shared, now);
    job.uploadedAt = now;
    delete job.error;
    if (verify) {
      job.expectedStagingRevision = fresh?.stagingCommit;
      const link = stagingLink(outs.join("\n"), this.api);
      if (link) job.stagingUrl = link;
      job.phase = GenexPublishPhase.VerifyingDeployment;
      job.state = GenexPublishJobState.Running;
    } else if (draft) finishJob(job, GenexPublishJobState.Done, now);
    else markReady(job, now);
    state.job = job;
    delete state.lastError;
    await this.#savePublishState(project, state);
    if (verify) await this.#checkDeployment(project, state);
  }
  async #failPublishJob(project: string, job: GenexPublishJob, attempt: PublishAttempt, error: unknown) {
    // A CLI failure after submission may follow a successful remote upload. Never
    // silently turn an unknown outcome into permission for another upload: only Genex's own
    // record, unchanged since just before the upload, shows that nothing landed. One stopped
    // while its draft was tested is known: the upload finished and nothing was made public.
    const inTest = job.phase === GenexPublishPhase.VerifyingDeployment;
    let outcome: typeof GenexPublishJobState.Failed | typeof GenexPublishJobState.Unresolved =
      attempt.submitted && !inTest ? GenexPublishJobState.Unresolved : GenexPublishJobState.Failed;
    if (outcome === GenexPublishJobState.Unresolved && attempt.before) {
      const afterward = await this.#hostedStaging(attempt.slug);
      if (afterward && uploadMissing(job, attempt.before, afterward)) outcome = GenexPublishJobState.Failed;
    }
    if (outcome === GenexPublishJobState.Unresolved) (job as InterruptedJob).interruptedIn = job.phase;
    job.phase = outcome;
    job.state = outcome;
    job.finishedAt = new Date().toISOString();
    job.error = (error as Error).message.slice(-PUBLISH_ERROR_TAIL_CHARS);
    await this.#persistJob(project, job).catch(() => {});
  }
  async #checkDeployment(project: string, state: GenexPublishState): Promise<void> {
    const pending = this.#readinessChecks.get(project);
    if (pending) {
      await pending;
      Object.assign(state, await this.#publishState(project));
      return;
    }
    const check = this.#verifyDeploymentState(project, state);
    this.#readinessChecks.set(project, check);
    try {
      await check;
    } finally {
      this.#readinessChecks.delete(project);
    }
  }
  async #verifyDeploymentState(project: string, state: GenexPublishState): Promise<void> {
    const job = state.job;
    if (!job?.uploadedAt) return;
    job.lastCheckedAt = new Date().toISOString();
    job.checkCount = (job.checkCount ?? 0) + 1;
    try {
      await this.#verifyStaging(state, job);
    } catch (error) {
      job.checkError = (error as Error).message;
      const next = nextDeploymentCheck(job);
      job.state = next.foreground ? GenexPublishJobState.Running : GenexPublishJobState.Unresolved;
      job.phase = next.foreground ? GenexPublishPhase.VerifyingDeployment : GenexPublishPhase.Unresolved;
      job.nextCheckAt = next.at;
    }
    await this.#savePublishState(project, state);
  }
  /**
   * Genex serves this upload's revision and every exported file, and does not report sign-in
   * support other than the build shipped: the draft passes. Returns it as the ready draft, unstamped.
   */
  async #confirmDraft(slug: unknown, job: GenexPublishJob): Promise<Omit<ReadyDraft, "verifiedAt">> {
    const { stagingUrl, deployment, expectedStagingRevision } = job;
    if (!stagingUrl || !deployment || !expectedStagingRevision) throw new Error(PUBLISH_MESSAGE.NoStagingIdentity);
    const remote = await this.#fetch(GenexRoute.projectBySlug(typeof slug === "string" ? slug : ""));
    const revision = remote?.project?.stagingCommitSha ?? remote?.project?.stagingCommit;
    if (revision !== expectedStagingRevision) throw new Error(PUBLISH_MESSAGE.RevisionMismatch);
    const signIn = signInRecorded(job.embedSdkVersion, remote?.project);
    if (!signIn.ok) throw new Error(PUBLISH_MESSAGE.SignInNotRecorded(job.embedSdkVersion ?? "none", signIn.reported));
    await verifyDeployment(stagingUrl, deployment);
    return { revision, url: stagingUrl, digest: deployment.digest };
  }
  /** Genex serves this upload's revision and every exported file: the draft is ready. */
  async #verifyStaging(state: GenexPublishState, job: GenexPublishJob): Promise<void> {
    const ready = await this.#confirmDraft(state.slug, job);
    const finishedAt = new Date().toISOString();
    markReady(job, finishedAt);
    state.readyDraft = { ...ready, verifiedAt: finishedAt };
  }
  /**
   * Whether the game is listed is Genex's answer, not the CLI's record: only `preview` writes the
   * status back, so after a gallery run the local `project.json` still says `draft`. One
   * authenticated read settles it, and the CLI's own file stays the single source of truth.
   */
  async #refreshHosted(dir: string, meta: HostedMeta): Promise<HostedMeta> {
    if (typeof meta?.slug !== "string" || !meta.slug) return meta;
    const answer = await this.#fetch(GenexRoute.projectBySlug(meta.slug)).catch(() => null);
    const status = answer?.project?.status;
    const known = status === GenexHostedStatus.Draft || status === GenexHostedStatus.Published;
    if (!known || status === meta.status) return meta;
    const next = { ...meta, status };
    await atomicWriteJson(metaFile(dir), next);
    return next;
  }
  /**
   * Wait for the running upload and then for the cover it sends, together bounded well under the
   * host's invocation ceiling; then report, cover and all.
   */
  async publishWait(project: string, jobId?: string, maxMs = PUBLISH_WAIT_MS): Promise<GenexPublishState> {
    const deadline = Date.now() + Math.max(MIN_PUBLISH_WAIT_MS, Math.min(maxMs, PUBLISH_WAIT_MS));
    const live = this.#publishJobs.get(project);
    if (live && (!jobId || live.job.id === jobId)) await within(live.done, deadline - Date.now());
    // The cover goes out after the upload is recorded: an agent waiting on the job hears how it went.
    const step = this.#coverSteps.get(project);
    const left = deadline - Date.now();
    if (step && (!jobId || step.jobId === jobId) && left > 0) await within(step.done, left);
    return this.publishView(project);
  }
  /** What a publish-status call answers: {@link publishStatus} with this game's cover. */
  async publishView(project: string, force = false): Promise<GenexPublishState> {
    return this.#withCover(project, await this.publishStatus(project, force));
  }
  /** The one link this action may hand to the browser, checked against Genex's own hosts. */
  async publishLinks(project: string, target?: string): Promise<{ target: string; verifyUrl: string }> {
    const state = await this.publishStatus(project);
    const wanted = linkTarget(target);
    if (wanted === PublishLinkTarget.Gallery && state.status !== GenexHostedStatus.Published)
      throw new Error(PUBLISH_MESSAGE.NotInGallery);
    const url = linkFor(state, wanted);
    if (!url) throw new Error(PUBLISH_MESSAGE.NothingOnline);
    if (!isGenexLink(url)) throw new Error(PUBLISH_MESSAGE.UnrecognizedLink);
    return { target: wanted, verifyUrl: url };
  }
  // ── the game's Genex cover ───────────────────────────────────────────────────────────────
  /** Where a game's cover lives in this plugin's storage; never the game folder. */
  #coverDir(project: string): string {
    if (!PROJECT_NAME.test(project)) throw new Error(PUBLISH_MESSAGE.InvalidProject);
    return path.join(this.root, GENEX_COVERS_DIR, project);
  }
  /** What Studio knows of a game's pages, read only: its own record and the CLI's hosted identity. */
  async #pages(project: string): Promise<GenexPublishState> {
    const state = await this.#publishState(project);
    mergeMeta(state, await readJsonOr<HostedMeta>(metaFile(this.#publishDir(project))));
    return state;
  }
  /** A publish state with the game's cover, and the cover lines of its own job among its warnings. */
  async #withCover(project: string, state: GenexPublishState): Promise<GenexPublishState> {
    const dir = this.#coverDir(project);
    const [shot, last] = await Promise.all([readShot(dir), readSent(dir)]);
    const own = last?.jobId !== undefined && last.jobId === state.job?.id;
    const warnings = [...(state.warnings ?? []), ...(own ? (last.lines ?? []) : [])];
    const cover = { shot, last, sending: this.#coverSteps.has(project) };
    return { ...state, ...(warnings.length ? { warnings } : {}), cover };
  }
  /**
   * genex__cover shoot: photograph the game's genex-cover demo now and keep it as its shot. A
   * problem keeps the last shot and says what to fix; a picture comes back as its preview.
   */
  async coverShoot(project: string, camera: CoverCamera): Promise<Record<string, unknown>> {
    const dir = this.#coverDir(project);
    const answer = await camera.shoot().catch((error: unknown) => ({
      stillProblem: { code: PluginStillProblemCode.Unavailable, reason: errorMessage(error) },
    }));
    const reading = readStillAnswer(answer);
    if ("problem" in reading) {
      const { problem } = reading;
      return {
        operation: CoverOperation.Shoot,
        problem,
        kept: await readShot(dir),
        guidance: PROBLEM_GUIDANCE[problem.code],
      };
    }
    const takenAt = new Date(this.#now()).toISOString();
    const shot = await this.#coverWrite(project, () => saveShot(dir, reading.still, takenAt));
    const delivery = coverDelivery(await this.#pages(project));
    return {
      operation: CoverOperation.Shoot,
      shot: { ...shot, advice: coverAdvice(shot) },
      sends: delivery,
      guidance: [...adviceLines(shot), DELIVERY_GUIDANCE[delivery]].join(" "),
      images: [
        { mimeType: "image/jpeg", data: reading.still.preview.toString("base64"), label: COVER_MESSAGE.PreviewLabel },
      ],
    };
  }
  /**
   * genex__cover status: the kept shot, the last send and, for a hosted game while signed in,
   * Genex's own answer about its cover and who chose it.
   */
  async coverStatus(project: string): Promise<Record<string, unknown>> {
    const dir = this.#coverDir(project);
    const [shot, last, pages] = await Promise.all([readShot(dir), readSent(dir), this.#pages(project)]);
    const asksGenex = Boolean(pages.slug) && Boolean(await this.#token());
    const hosted = asksGenex ? await this.#hostedCoverView(project) : null;
    const noted = await this.#keepOwnerPick(project, dir, hosted);
    const delivery = coverDelivery(pages);
    return {
      operation: CoverOperation.Status,
      shot: shot ? { ...shot, advice: coverAdvice(shot) } : null,
      last: noted ?? last,
      sending: this.#coverSteps.has(project),
      hosted,
      sends: delivery,
      guidance: statusGuidance(shot, hosted, delivery),
    };
  }
  /**
   * With no shot kept, the owner's own cover that Genex reports is kept as the game's last cover
   * answer, so nothing asks for a cover the owner chose. A running send or a kept shot records its
   * own answer instead; an owner's pick already kept is left as it is. Null when nothing was kept.
   */
  async #keepOwnerPick(project: string, dir: string, view: CoverView | null): Promise<GenexCoverSent | null> {
    const owner = ownerPick(view);
    if (!owner || this.#coverSteps.has(project)) return null;
    return this.#coverWrite(project, async () => {
      const [shot, last] = await Promise.all([readShot(dir), readSent(dir)]);
      if (shot || last?.kind === GenexCoverOutcome.KeptOwner) return null;
      const record = keptOwnerRecord(null, owner, new Date(this.#now()).toISOString());
      await writeSent(dir, record);
      return record;
    });
  }
  /**
   * genex__cover-set, after the user said yes: send the kept shot now through the same step a publish
   * uses. Without a hosted project it sends nothing, and it never runs beside a publish of this game.
   */
  async coverSet(project: string): Promise<Record<string, unknown> & { kind: GenexCoverOutcome }> {
    const started = await this.#account(async () => {
      const state = await this.publishStatus(project);
      if (!state.connected) throw new Error(PUBLISH_MESSAGE.ConnectFirst);
      if (this.#publishJobs.has(project)) return GenexCoverOutcome.Busy;
      if (!state.slug) return GenexCoverOutcome.NotHosted;
      if (!(await this.#termsAccepted(project, state))) throw new Error(COVER_MESSAGE.TermsFirst);
      await this.#stopCoverStep(project);
      return this.#startCoverStep(project);
    });
    // A publish that started meanwhile stopped this send: it shoots and sends its own frame.
    const record = typeof started === "string" ? null : await started.done;
    const kind = typeof started === "string" ? started : (record?.kind ?? GenexCoverOutcome.Busy);
    return { ...record, kind, guidance: OUTCOME_GUIDANCE[kind] };
  }
  /**
   * Shoot the genex-cover demo again for a publish, inside the invocation that asked and only with
   * enough of it left. Any problem keeps the last shot; the lines say why, for the publish's warnings.
   * Never throws: by now the job is exporting, and a cover may not hold it up or fail it.
   */
  async #reshoot(project: string, camera: CoverCamera): Promise<string[]> {
    const left = INVOCATION_BUDGET_MS - (this.#now() - camera.invokedAt);
    if (left < MIN_REMAINING_FOR_SHOT_MS) return [COVER_MESSAGE.NoTimeToShoot];
    const answer = await within(camera.shoot(), this.#coverTimeouts.shotMs).catch(() => null);
    if (answer === TIMED_OUT) return [COVER_MESSAGE.ShotTimedOut];
    const reading = readStillAnswer(answer);
    if ("problem" in reading) return [reshootLine(reading.problem.code)];
    const takenAt = new Date(this.#now()).toISOString();
    try {
      await this.#coverWrite(project, () => saveShot(this.#coverDir(project), reading.still, takenAt));
      return [];
    } catch {
      // The plugin's storage could not take it (a full disk, a permission): the last shot, if any, goes.
      return [COVER_MESSAGE.ShotNotKept];
    }
  }
  /** Start a cover send for a game: after publish `jobId`, or (none) for genex__cover-set. */
  #startCoverStep(project: string, jobId?: string): CoverStep {
    const controller = new AbortController();
    this.#controllers.set(controller, { project });
    const step: CoverStep = { ...(jobId ? { jobId } : {}), controller, done: Promise.resolve(null) };
    step.done = this.#sendCover(project, controller.signal, jobId)
      .catch(() => null)
      .finally(() => {
        this.#controllers.delete(controller);
        if (this.#coverSteps.get(project) === step) this.#coverSteps.delete(project);
      });
    this.#coverSteps.set(project, step);
    return step;
  }
  /** Stop a game's running cover send and wait for it to end; it records nothing once stopped. */
  async #stopCoverStep(project: string): Promise<void> {
    const step = this.#coverSteps.get(project);
    if (!step) return;
    step.controller.abort();
    await step.done;
  }
  /** Run one write to a game's kept shot (or a send's read of it) once the one before it has ended. */
  async #coverWrite<T>(project: string, write: () => Promise<T>): Promise<T> {
    const turn = (this.#coverWrites.get(project) ?? Promise.resolve()).catch(() => {}).then(write);
    this.#coverWrites.set(project, turn);
    try {
      return await turn;
    } finally {
      if (this.#coverWrites.get(project) === turn) this.#coverWrites.delete(project);
    }
  }
  /**
   * The send's own view of the kept shot: its record, the last answer, whether to send, and when
   * it does, a private copy of the image, all read with no shot being written meanwhile.
   */
  #planSend(project: string, dir: string) {
    return this.#coverWrite(project, async () => {
      const [shot, last] = await Promise.all([readShot(dir), readSent(dir)]);
      const decision = decideSend(shot, last);
      const copy = decision.send && shot ? await freezeShot(dir, shot) : null;
      return { shot: copy ? shot : null, last, decision, copy };
    });
  }
  /**
   * Send the kept shot unless Genex has settled these exact bytes, and upload nothing over the
   * owner's own pick. What goes out is a copy taken when the send began, and the hash written is
   * that copy's: a shot taken meanwhile waits for the next send. Genex's answer, whatever it is, is
   * the outcome written; a send stopped midway writes nothing, so the next one decides afresh. Null
   * when stopped.
   */
  async #sendCover(project: string, signal: AbortSignal, jobId?: string): Promise<GenexCoverSent | null> {
    const dir = this.#coverDir(project);
    const { shot, last, decision, copy } = await this.#planSend(project, dir);
    const at = () => new Date(this.#now()).toISOString();
    if (!shot || !copy) {
      const unchanged = decision.send === false && decision.kind === GenexCoverOutcome.Unchanged && last;
      if (unchanged) return this.#keepSent(dir, signal, unchangedRecord(last, at(), jobId));
      // Nothing to send: still ask who chose the cover, so the owner's pick is never taken for none.
      const owner = ownerPick(await this.#hostedCoverView(project, signal));
      return this.#keepSent(dir, signal, owner ? keptOwnerRecord(null, owner, at(), jobId) : noneRecord(at(), jobId));
    }
    try {
      const owner = ownerPick(await this.#hostedCoverView(project, signal));
      if (signal.aborted) return null;
      if (owner) return this.#keepSent(dir, signal, keptOwnerRecord(shot, owner, at(), jobId));
      const answer = await this.#uploadCover(project, copy, signal);
      return this.#keepSent(dir, signal, sentRecord(answer, shot, at(), jobId));
    } finally {
      await rm(copy, { force: true });
    }
  }
  /** Write a send's outcome, unless the send was stopped. */
  async #keepSent(dir: string, signal: AbortSignal, record: GenexCoverSent): Promise<GenexCoverSent | null> {
    if (signal.aborted) return null;
    await writeSent(dir, record);
    return record;
  }
  /** Genex's answer about a hosted game's cover and who chose it, or null when it could not say. */
  async #hostedCoverView(project: string, signal?: AbortSignal): Promise<CoverView | null> {
    const dir = this.#publishDir(project);
    if (!(await readJsonOr<HostedMeta>(metaFile(dir)))?.slug) return null;
    try {
      const { out } = (await this.#spawnCli(dir, ["cover", "--json"], signal, {
        timeoutMs: this.#coverTimeouts.viewMs,
        parse: false,
        home: path.join(dir, "home"),
        answerExitCodes: COVER_ANSWER_EXIT_CODES,
      })) as { out: string };
      return parseCoverView(out);
    } catch {
      return null;
    }
  }
  /**
   * Upload one shot with the pinned CLI, in the publish workspace with its contained HOME and the
   * token on fd 3. Exit 1 is an answer too (a refused frame); a stop, a timeout or a crash is `failed`.
   */
  async #uploadCover(project: string, file: string, signal: AbortSignal): Promise<CoverAnswer> {
    const dir = this.#publishDir(project);
    try {
      const { out } = (await this.#spawnCli(dir, ["cover", file, "--json"], signal, {
        timeoutMs: this.#coverTimeouts.sendMs,
        parse: false,
        home: path.join(dir, "home"),
        answerExitCodes: COVER_ANSWER_EXIT_CODES,
      })) as { out: string };
      const answer = parseCoverAnswer(out);
      // The CLI names the file it sent: the shot's place in Studio's storage is nobody's business.
      if ("message" in answer && answer.message)
        return { ...answer, message: answer.message.replaceAll(file, COVER_SHOT_NAME) };
      return answer;
    } catch (error) {
      const timedOut = error instanceof GenexCliStopped && error.timedOut;
      return { kind: GenexCoverOutcome.Failed, message: timedOut ? COVER_MESSAGE.SendTimedOut : errorMessage(error) };
    }
  }
  /** Asset commands: structured output, the asset timeout, the user's own HOME. */
  async #cli(cwd: string, args: string[], signal?: AbortSignal): Promise<any> {
    return this.#spawnCli(cwd, args, signal, { timeoutMs: ASSET_TIMEOUT_MS, parse: true });
  }
  /** Publish commands: plain logs (preview/publish/promote ignore `--json`), a long timeout, a contained HOME. */
  async #cliText(cwd: string, args: string[], signal: AbortSignal | undefined, home: string): Promise<{ out: string }> {
    return this.#spawnCli(cwd, args, signal, { timeoutMs: PUBLISH_TIMEOUT_MS, parse: false, home }) as Promise<{
      out: string;
    }>;
  }
  async #spawnCli(
    cwd: string,
    args: string[],
    signal: AbortSignal | undefined,
    options: { timeoutMs: number; parse: boolean; home?: string; answerExitCodes?: readonly number[] },
  ) {
    const cli = genexCliPath();
    const authEpoch = this.#authEpoch;
    const token = await this.#token();
    const signedOut = !token || this.#disconnecting || authEpoch !== this.#authEpoch;
    if (signedOut) throw new Error(PUBLISH_MESSAGE.ConnectFirst);
    if (signal?.aborted) throw new Error(MESSAGE.StoppedBeforeSubmission);
    return runGenexCli({ cli, preload: this.#preload, api: this.api, token, cwd, args, signal, ...options });
  }
  /** Read Genex's durable admission evidence; never change its credit ledger. */
  async #reconcileJob(cwd: string, job: GenexJob, remote = false, signal?: AbortSignal) {
    const reservation = await readLedger(cwd, job);
    if (remote && !job.generationId) await this.#findGeneration(job, reservation, signal);
    if (remote && job.generationId) await this.#refreshGeneration(job, job.generationId, signal);
    if (job.generationId && isUncertainSubmit(job)) job.status = GenexJobStatus.Accepted;
  }
  /** Ask Genex which generation a generic reservation became. */
  async #findGeneration(job: GenexJob, reservation: LedgerRow | undefined, signal?: AbortSignal) {
    if (reservation?.generic !== true || typeof reservation.id !== "string") return;
    try {
      const found = await this.#fetch(GenexRoute.generationRequest(reservation.id), withSignal(signal));
      if (typeof found.id === "string") {
        job.generationId = found.id;
        job.remoteStatus = found.status;
        if (Number.isSafeInteger(found.creditsQuoted)) job.creditsQuoted = found.creditsQuoted;
      }
    } catch {} // A failed lookup cannot authorize a replacement or release a reservation.
  }
  /** Copy Genex's view of a generation onto the job: status, files and credits. */
  async #refreshGeneration(job: GenexJob, generationId: string, signal?: AbortSignal) {
    try {
      const response = await this.#fetch(GenexRoute.generation(generationId), withSignal(signal));
      const view = response.generation ?? response;
      if (typeof view.status === "string") {
        job.remoteStatus = view.status;
        const awaitingFiles = !job.files.length && job.status !== GenexJobStatus.ApprovalRequired;
        if (awaitingFiles) job.status = reconciledJobStatus(view.status);
      }
      if (Array.isArray(view.files)) job.manifest = manifestFromView(view.files);
      if (typeof view.creditsCharged === "number") job.creditsCharged = view.creditsCharged;
      if (typeof view.creditsRefunded === "number") job.creditsRefunded = view.creditsRefunded;
    } catch {} // Preserve last known state; absence is not completion or refund evidence.
  }
  /** Poll a pending device sign-in when its interval is due, and save an approved token. */
  async #pollAuthorization(signal?: AbortSignal) {
    if (this.#auth && Date.now() > this.#auth.expiresAt) this.#auth = null;
    const pending = this.#auth;
    if (!pending || Date.now() < pending.nextPoll) return;
    pending.nextPoll = Date.now() + pending.interval;
    const d = await this.#fetch(GenexRoute.DevicePoll, {
      method: "POST",
      body: JSON.stringify({ deviceCode: pending.deviceCode }),
      ...withSignal(signal),
    });
    await this.#account(async () => {
      if (this.#auth !== pending) return;
      if (d.status === DeviceStatus.Approved && typeof d.token === "string") {
        this.#auth = null; // A failed/cancelled save must not retry on every status poll.
        await (await this.#store()).set(d.token);
        this.#disconnecting = false;
      } else if (DEVICE_ENDED.has(d.status)) this.#auth = null;
    });
  }
  async status(project?: string, signal?: AbortSignal): Promise<GenexStatus> {
    await this.init();
    await this.#pollAuthorization(signal);
    const connected = !!(await this.#token());
    const result: GenexStatus = {
      connected,
      enabled: connected,
      identity: null,
      operations: [...TOOL_OPERATIONS],
      balance: null,
      allowance: null,
      lanes: null,
      jobs: [],
    };
    if (this.#credentials instanceof SessionCredentials) result.credentialState = this.#credentials.state;
    if (this.#auth) result.authorization = authorizationView(this.#auth);
    if (project) result.jobs = await this.#projectJobs(project, connected, signal);
    if (connected) await this.#readAccount(result, project, signal);
    return result;
  }
  /** A project's jobs, oldest first, each reconciled with Genex while signed in. */
  async #projectJobs(project: string, connected: boolean, signal?: AbortSignal): Promise<GenexJob[]> {
    const cwd = await this.#workspace(project);
    const jobs: GenexJob[] = [];
    for (const name of await readdir(path.join(cwd, "jobs")).catch(() => [])) {
      const job = await readJsonOr<GenexJob>(path.join(cwd, "jobs", name, "job.json"));
      if (job) jobs.push(job);
    }
    jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (let offset = 0; offset < jobs.length; offset += RECONCILE_BATCH) {
      signal?.throwIfAborted();
      const batch = jobs.slice(offset, offset + RECONCILE_BATCH);
      await Promise.all(batch.map((job) => this.#reconcileJob(cwd, job, connected, signal)));
    }
    return jobs;
  }
  /** Genex's session for the stored token, reusing a recent verified answer. */
  async #session(signal?: AbortSignal) {
    const token = await this.#token();
    const cached = this.#sessionIdentity;
    const reusable = cached && cached.token === token && cached.expires > Date.now();
    const session = reusable ? cached.session : await this.#fetch(GenexRoute.Session, withSignal(signal));
    if (session?.user && token)
      this.#sessionIdentity = {
        token,
        expires: cached && cached.session === session ? cached.expires : Date.now() + SESSION_CACHE_MS,
        session,
      };
    return session;
  }
  /** Fill in the account: identity, terms, credits and, for a project, its allowance and lanes. */
  async #readAccount(result: GenexStatus, project: string | undefined, signal?: AbortSignal) {
    try {
      const session = await this.#session(signal);
      if (!session?.user) {
        markSignedOut(result);
        return;
      }
      result.identity = session.user.email ?? null;
      result.accountVerified = true;
      const legal = await this.#fetch(GenexRoute.LegalStatus, withSignal(signal)).catch(() => null);
      if (typeof legal?.accepted === "boolean")
        result.legal = {
          accepted: legal.accepted,
          requiredVersion: typeof legal.required === "string" ? legal.required : undefined,
          acceptUrl: ACCEPT_URL,
        };
      const credits = await this.#fetch(GenexRoute.Credits, withSignal(signal));
      result.balance = Number.isFinite(credits.balance) ? credits.balance : null;
      if (typeof credits.unlimited === "boolean") result.unlimited = credits.unlimited;
      if (!project) return;
      const cwd = await this.#workspace(project);
      result.allowance = await this.#cli(cwd, ["budget"], signal);
      result.lanes = await this.#fetch(GenexRoute.Lanes, withSignal(signal));
    } catch (e) {
      if (statusOf(e) === HTTP_UNAUTHORIZED) markSignedOut(result);
      else result.error = (e as Error).message;
    }
  }
  async #approvalReview(
    cwd: string,
    request: GenexRequest,
    signal: AbortSignal,
  ): Promise<NonNullable<GenexJob["approval"]>> {
    if (!request.id) throw new Error(MESSAGE.ApprovalNeedsSource);
    const response = (await this.#cli(cwd, ["wait", request.id, "--no-download"], signal)) as ReviewAnswer;
    const labels = approvalLabels(request.operation);
    const urls = labels.map((label) => approvalImageUrl(request.operation, response, label));
    if (urls.some((url) => typeof url !== "string")) throw new Error(MESSAGE.ApprovalViewsMissing);
    const images: Array<{ label: string; dataUrl: string }> = [];
    for (const [i, label] of labels.entries())
      images.push({ label, dataUrl: await fetchApprovalImage(urls[i] as string, signal) });
    const finalize = request.operation === GenexOperation.CharacterFinalize;
    return {
      sourceId: request.id,
      images,
      ...(finalize
        ? {
            remeshFaces: REMESH_FACES,
            ...(typeof response.sourceFaceCount === "number" ? { sourceFaceCount: response.sourceFaceCount } : {}),
          }
        : {}),
    };
  }
  async execute(
    project: string,
    root: string,
    request: GenexRequest,
    signal?: AbortSignal,
    approved = false,
    threadId?: string,
  ): Promise<GenexJob | unknown> {
    const controller = new AbortController();
    this.#controllers.set(controller, { project, threadId });
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
      return await this.#execute(project, root, request, controller.signal, approved);
    } finally {
      signal?.removeEventListener("abort", stop);
      this.#controllers.delete(controller);
    }
  }
  /** Status as the agent sees it: approval images stay in Studio. */
  async #statusForAgent(project: string, signal: AbortSignal) {
    const status = await this.status(project, signal);
    return {
      ...status,
      jobs: status.jobs.map((job) => ({
        ...job,
        ...(job.approval ? { approval: approvalSummary(job.approval) } : {}),
      })),
    };
  }
  /** Inspect or verify how the game uses a job's delivered files. */
  async #recordUse(project: string, root: string, request: GenexRequest, signal: AbortSignal) {
    if (typeof request.id !== "string" || !JOB_ID.test(request.id)) throw new Error(MESSAGE.InspectWithStudioId);
    const cwd = await this.#workspace(project);
    const dir = path.join(cwd, "jobs", request.id);
    const job = await readJsonOr<GenexJob>(path.join(dir, "job.json"));
    if (!job || job.project !== project) throw new Error(MESSAGE.NotThisProject);
    if (request.operation === GenexOperation.InspectUse) await this.#requireFilesIn(cwd, root, job);
    return recordGenexUse({ job, dir, root, request, signal, observe: this.#observe });
  }
  async #execute(
    project: string,
    root: string,
    request: GenexRequest,
    signal: AbortSignal,
    approved: boolean,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error(MESSAGE.StoppedBeforeSubmission);
    if (request.operation === GenexOperation.Status) return this.#statusForAgent(project, signal);
    if (USE_OPERATIONS.has(request.operation)) return this.#recordUse(project, root, request, signal);
    validateGenexRequest(request);
    if (!(await this.#token())) throw new Error(MESSAGE.ConnectToGenerate);
    const cwd = await this.#workspace(project);
    const id = randomUUID();
    const dir = path.join(cwd, "jobs", id);
    await mkdir(dir, { recursive: true });
    const job: GenexJob = {
      id,
      project,
      operation: request.operation,
      status: GenexJobStatus.Requested,
      files: [],
      createdAt: new Date().toISOString(),
      ...(READ_OPERATIONS.has(request.operation) && request.id ? { generationId: request.id } : {}),
    };
    const save = () => atomicWriteJson(path.join(dir, "job.json"), job);
    await atomicWriteJson(path.join(dir, "request.json"), { root, request });
    await save();
    try {
      if (APPROVAL_OPERATIONS.has(request.operation) && !approved) {
        job.approval = await this.#approvalReview(cwd, request, signal);
        job.status = GenexJobStatus.ApprovalRequired;
        await save();
        return { ...job, approval: approvalSummary(job.approval) };
      }
      const { args, output } = await cliArgsFor(request, root, dir, approved);
      job.status = GenexJobStatus.Submitting;
      await save();
      const response = await this.#cli(cwd, args, signal);
      await this.#recordAnswer(cwd, dir, root, job, response, output, signal);
      await save();
      return { ...job, result: response };
    } catch (e) {
      job.status = failedJobStatus(job, signal.aborted);
      job.error = (e as Error).message;
      await this.#reconcileJob(cwd, job);
      job.status = settledFailureStatus(job, READ_OPERATIONS.has(request.operation), () => signal.aborted);
      await save();
      return job;
    }
  }
  /** Record the CLI's answer on the job and, when it finished, deliver its files into the game. */
  async #recordAnswer(
    cwd: string,
    dir: string,
    root: string,
    job: GenexJob,
    response: any,
    output: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (response.candidates || response.views)
      await atomicWriteJson(path.join(dir, "review.json"), {
        candidates: response.candidates,
        views: response.views,
        sourceFaceCount: response.sourceFaceCount,
      });
    if (typeof response.id === "string") job.generationId = response.id;
    job.remoteStatus = response.status;
    job.status = jobStatusFromRemote(response.status);
    if (Number.isSafeInteger(response.creditsQuoted)) job.creditsQuoted = response.creditsQuoted;
    if (isRemoteFailure(job)) job.error = String(response.error ?? job.status);
    if (hasDownloadableResult(job)) await this.#deliverResult(cwd, job, root, output, signal);
    await this.#reconcileJob(cwd, job);
  }
  /** Reconcile with Genex, fetch the desktop variant, then deliver the output into the game. */
  async #deliverResult(cwd: string, job: GenexJob, root: string, output: string, signal: AbortSignal) {
    await this.#reconcileJob(cwd, job, true, signal);
    await fetchDesktopVariant(job, output, signal);
    job.files = await this.#deliver(output, root, job.id);
    if (job.preferredFile) job.preferredFile = job.files.find((file) => path.basename(file) === job.preferredFile);
    if (job.files.length) job.status = GenexJobStatus.Downloaded;
  }
  /**
   * A worker's delivery lives in its own workspace until that work lands, so the lead can hold a
   * job id whose files are not in the build it is inspecting. Name the copy that is here instead.
   */
  async #requireFilesIn(cwd: string, root: string, job: GenexJob): Promise<void> {
    if (await filesPresent(root, job.files)) return;
    const sibling = await siblingWithFiles(cwd, root, job, (file) => readJsonOr<GenexJob>(file));
    throw new Error(deliveredElsewhereMessage(job, sibling));
  }
  async approve(project: string, id: string, candidate?: number) {
    if (!JOB_ID.test(id)) throw new Error(MESSAGE.InvalidApproval);
    const data = await this.#account(async () => {
      const dir = path.join(await this.#workspace(project), "jobs", id);
      const job = await readJsonOr<GenexJob>(path.join(dir, "job.json"));
      if (job?.status !== GenexJobStatus.ApprovalRequired || !job.approval?.images?.length)
        throw new Error(MESSAGE.ApprovalNotPending);
      const pending = await readJsonOr<{ root: string; request: GenexRequest }>(path.join(dir, "request.json"));
      if (!pending) throw new Error(MESSAGE.ApprovalNotPending);
      if (pending.request.operation === GenexOperation.CharacterPreview) {
        if (candidate === undefined || !PREVIEW_CANDIDATES.includes(candidate))
          throw new Error(MESSAGE.ChooseCandidate);
        pending.request.options = { ...pending.request.options, candidate };
      }
      job.status = GenexJobStatus.Approved;
      await atomicWriteJson(path.join(dir, "job.json"), job);
      return pending;
    });
    return this.execute(project, data.root, data.request, undefined, true);
  }
}
