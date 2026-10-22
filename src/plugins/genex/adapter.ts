import { markDeployment, verifyDeployment } from "./deployment.ts";
import { bringsOwnSdk, connectPublishedCopy } from "./entry-page.ts";
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
  GenexCoverOrigin,
  GenexBlocked,
  GenexCoverOutcome,
  type GenexCoverSent,
  ownerChoseCover,
  GenexHostedStatus,
  GenexJobStatus,
  GenexOperation,
  GenexPublishJobState,
  GenexPublishKind,
  GenexPublishPhase,
  type GenexGameManifest,
  type GenexJob,
  GenexListingState,
  type GenexNativeRecord,
  type GenexPublishJob,
  GenexRemixProblem,
  type GenexRemixRecord,
  type GenexPublishState,
  type GenexRequest,
  type GenexStatus,
} from "../../shared/genex.ts";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import { PluginStillProblemCode } from "../../shared/plugins.ts";
import { GenexCliStopped, runGenexCli, genexCliPath } from "./cli.ts";
import {
  appClipCommit,
  listingOf,
  type NativeUpload,
  nativePublishArgs,
  pinnedCliSendsApps,
  sendNativeBuild,
} from "./native-publish.ts";
import {
  dropStaged,
  keptBackRecord,
  pinnedCliSendsSource,
  REMIX_FILE,
  SOURCE_FOLDER,
  type RemixSaved,
  readRemixSaved,
  remixAllowed,
  saveRemix,
  sentProject,
  sourceArgs,
  type StagedProject,
  stageProject,
} from "./remix-publish.ts";
import {
  adviceLines,
  type CoverAnswer,
  type CoverCamera,
  coverAdvice,
  coverDelivery,
  CoverOperation,
  coverRides,
  type CoverView,
  COVER_AUTO_GAP_MS,
  COVER_FALLBACK_CAMERA,
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
  pickCandidate,
  PROBLEM_GUIDANCE,
  PUBLISH_SHOT_TIMEOUT_MS,
  noteAgentTook,
  readAgentTook,
  readCandidates,
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
import {
  CLIP_MESSAGE,
  clipGuidance,
  clipProblemGuidance,
  clipSentRecord,
  clipToSend,
  freezeClip,
  readClip,
  readClipAnswer,
  readClipSent,
  saveClip,
  writeClipSent,
} from "./clip.ts";
import { windowsBaseEnv } from "../../substrate/child-env.ts";
import { envPath } from "../../substrate/toolchain.ts";
import {
  ACCEPT_URL,
  DeviceStatus,
  GenexRoute,
  genexFetch,
  HTTP_FORBIDDEN,
  HTTP_NOT_FOUND,
  HTTP_UNAUTHORIZED,
  isGenexAuthorizationUrl,
  DEFAULT_DASHBOARD,
  isGenexLink,
  MIN_POLL_INTERVAL_S,
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
  applyFoundGeneration,
  applyGenerationView,
  approvalImageUrl,
  approvalLabels,
  deliveredElsewhereMessage,
  failedJobStatus,
  fetchApprovalImage,
  fetchDesktopVariant,
  filesPresent,
  type FoundGeneration,
  generationView,
  type GenerationView,
  hasDownloadableResult,
  isRemoteFailure,
  isSettledView,
  isUncertainSubmit,
  JOB_ID,
  jobStatusFromRemote,
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
  isOpen,
  markUnknownAfterRestart,
  MAX_UPLOADS,
  mergeMeta,
  MESSAGE as PUBLISH_MESSAGE,
  needsRelisting,
  nextDeploymentCheck,
  publicSteps,
  publishArgs,
  publishPhaseFor,
  publishedConnection,
  recordPages,
  PUBLISH_ERROR_TAIL_CHARS,
  PublishLinkTarget,
  shareLink,
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
/** How long one app's `genex native publish` may take: zipping, hashing and uploading a large build. */
const NATIVE_PUBLISH_TIMEOUT_MS = 60 * MINUTE_MS;
/** Where a publish's apps are recorded in its workspace, apart from `publish.json`. */
const NATIVE_FILE = "native.json";
/** Bounded so a waiting agent answers well inside the host's 190 s invocation ceiling. */
const PUBLISH_WAIT_MS = 150_000;
const MIN_PUBLISH_WAIT_MS = SECOND_MS;
/** How long a verified sign-in is trusted before status asks Genex again. */
const SESSION_CACHE_MS = 2 * MINUTE_MS;
/**
 * How long a status read reuses a game's allowance before starting the CLI's `budget` again. The
 * page reads status every 5 s while a generation runs, and each `budget` is a whole Node process;
 * every other CLI command in that game forgets the allowance, since it may have spent from it.
 */
const ALLOWANCE_REUSE_MS = 30 * SECOND_MS;
/** The CLI command that reads a game's allowance. */
const BUDGET_COMMAND = "budget";
/** Kept back from the host's ceiling for one call, to record a generation's answer once its CLI stops. */
const ASSET_SETTLE_MS = 10 * SECOND_MS;
/** A generation is not submitted with less than this left of its call: its CLI could not finish. */
const MIN_ASSET_SUBMIT_MS = 30 * SECOND_MS;
/** How long a generation waits for the person to accept Genex's updated terms: as long as the CLI waits. */
const TERMS_WAIT_MS = 100 * SECOND_MS;
/** How often a generation waiting on the terms asks Genex again. */
const TERMS_POLL_MS = 3 * SECOND_MS;
/** The workspace folder name: letters, digits, `_` and `-` only, so it can never be a path. */
const PROJECT_NAME = /^[a-zA-Z0-9_-]+$/;
const DEVICE_LABEL = "AI Game Studio";

/**
 * How a reconcile reads Genex: not at all, afresh, or afresh only about generations this process
 * has not yet seen settle. Status reads are the last kind: the page, the usage panel and the
 * agent read status often, and a game's finished generations would otherwise each be asked about
 * again on every read, against the one per-account request budget every client shares.
 */
const RemoteRead = { None: "none", Fresh: "fresh", Remembered: "remembered" } as const;
type RemoteRead = (typeof RemoteRead)[keyof typeof RemoteRead];

const DEVICE_ENDED = new Set<string>([DeviceStatus.Denied, DeviceStatus.Expired]);

/**
 * The adapter's words. The agent reads its tool answers and refusals in English; what a person
 * reads (the account card, the toolbar badge, an action's refusal) is a function, translated when said.
 */
const MESSAGE = {
  SignInCanceled: () => t("Sign-in was canceled"),
  UnexpectedAuthorization: () => t("Unexpected authorization URL"),
  ConnectBadgeWord: () => t("Connect"),
  ConnectBadge: () => t("Connect Genex to use assets"),
  SignInExpired: () => t("Genex sign-in expired. Reconnect your account."),
  StoppedBeforeSubmission: "Stopped before Genex submission",
  ConnectToGenerate: "Connect Genex to generate assets.",
  InspectWithStudioId: "Use the delivered Studio job id for an asset inspection",
  NotThisProject: "Asset job does not belong to this project",
  ApprovalNeedsSource: "Approval requires an existing concept or preview generation",
  ApprovalViewsMissing: "Approval cannot proceed: required candidate/preview views are unavailable",
  InvalidApproval: () => t("Invalid approval"),
  ApprovalNotPending: () => t("Approval is no longer pending"),
  ChooseCandidate: () => t("Choose candidate 1, 2, or 3"),
  CredentialsUninitialized: "Genex credentials are not initialized",
  NoTimeToSubmit:
    "Waiting for Genex's terms used up this call, so nothing was submitted or charged. Make this request again now that they are accepted.",
  TermsPending:
    "Genex's terms changed and the user has not accepted them yet, so nothing was submitted or charged. Studio shows them Review in the chat and in the sidebar: ask them to accept the terms, then make this request again.",
} as const;

/**
 * How long a generation's CLI may run once `elapsedMs` of its call has gone (the terms wait among
 * it): its own timeout, cut so it stops, and its answer is recorded, before the host's ceiling for
 * the call ends the backend's work midway. Zero when too little is left to submit at all.
 */
export function assetCliTimeoutMs(elapsedMs: number): number {
  const left = INVOCATION_BUDGET_MS - ASSET_SETTLE_MS - elapsedMs;
  if (left < MIN_ASSET_SUBMIT_MS) return 0;
  return Math.min(ASSET_TIMEOUT_MS, left);
}

/** What a generation tells the app while it runs: the account's terms began or stopped waiting for the person. */
export interface GenexExecuteHooks {
  termsPending?: (pending: boolean) => Promise<void>;
}

/** A generation waited for the terms and the person did not accept them in time. */
class GenexTermsPending extends Error {
  constructor() {
    super(MESSAGE.TermsPending);
  }
}

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
/** The installed SDK's browser files, where a run from source (no build beside the backend) finds them. */
const installedEmbedSdk = () => path.dirname(fileURLToPath(import.meta.resolve("@genex-ai/embed-sdk")));

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
  result.error = MESSAGE.SignInExpired();
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

/** A publish's apps being sent, behind its web build. */
interface NativeStep {
  jobId: string;
  controller: AbortController;
  done: Promise<void>;
}

/** A publish's apps as `native.json` keeps them. */
type NativeSaved = Pick<GenexNativeRecord, "jobId" | "sent" | "failed" | "listing">;

/** `native.json` as read: any shape that is not a record of sent and failed apps is none. */
function readNativeSaved(value: unknown): NativeSaved {
  const record = typeof value === "object" && value !== null ? (value as Partial<NativeSaved>) : {};
  const listing = listingOf(record);
  return {
    ...(typeof record.jobId === "string" ? { jobId: record.jobId } : {}),
    sent: Array.isArray(record.sent) ? record.sent : [],
    failed: Array.isArray(record.failed) ? record.failed : [],
    ...(listing ? { listing } : {}),
  };
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
  /** The game's project staged for remixers, which the upload pushes as its source; null when it does not go. */
  staged: StagedProject | null;
}

/** A publish's remixing: the person's choice in the dialog (absent when no one chose) and the game's folder. */
export interface RemixChoice {
  allowed?: boolean;
  gameDir?: string;
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
  /** Each game workspace's last `budget` answer, for the sign-in that read it. */
  #allowances = new Map<string, { epoch: number; token: string; at: number; allowance: unknown }>();
  #exporting = new Set<string>();
  #readinessChecks = new Map<string, Promise<void>>();
  #publishJobs = new Map<string, { job: GenexPublishJob; done: Promise<void> }>();
  /** The cover send running per game: the one a publish leaves behind it, or genex__cover-set's. */
  #coverSteps = new Map<string, CoverStep>();
  /** The apps a publish is sending, per game. */
  #nativeSteps = new Map<string, NativeStep>();
  /** Whether this CLI has `genex native`; tests say so of their stand-in. */
  readonly #sendsApps: boolean;
  /** Whether this CLI pushes a game's source from another folder (`--source`); tests say so of their stand-in. */
  readonly #sendsSource: boolean;
  /** The games whose project Allow remixing is sending now. */
  #remixSends = new Set<string>();
  /** When Studio last took each game's cover on its own (`coverAuto`). */
  #coverAutoAt = new Map<string, number>();
  /** The last write to a game's kept shot, or a send's read of it: each waits for the one before. */
  #coverWrites = new Map<string, Promise<unknown>>();
  /** Genex's last word on each generation seen settled, by generation id: status reads apply it without asking again. */
  #settledGenerations = new Map<string, GenerationView>();
  /** Which generation each generic reservation became, by reservation id, as Genex named it. */
  #foundGenerations = new Map<string, FoundGeneration>();
  /** How long a publish's new draft has to pass its test before the publish gives up on going public. */
  readonly #draftTestMs: number;
  readonly #coverTimeouts: CoverTimeouts;
  /** The tools' clock: a publish's shot is measured against the invocation it runs in. */
  readonly #now: () => number;
  /** The folder of the browser SDK a published game that brings none of its own is connected with. */
  readonly #embedSdk: string | undefined;
  readonly #termsWait: { waitMs: number; pollMs: number };
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
      /** Where the build put the SDK's browser files beside the backend; else the installed package's. */
      embedSdk?: string;
      /** How long a generation waits for the person to accept Genex's terms, and how often it asks. */
      termsWait?: { waitMs: number; pollMs: number };
      /** Whether the CLI sends apps (`genex native`); else read from the pinned CLI's version. */
      sendsApps?: boolean;
      /** Whether the CLI sends a game's project (`--source`); else read from the pinned CLI's version. */
      sendsSource?: boolean;
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
    this.#termsWait = options.termsWait ?? { waitMs: TERMS_WAIT_MS, pollMs: TERMS_POLL_MS };
    this.#embedSdk = options.embedSdk;
    this.#credentials = options.credentials;
    this.#observe = options.observe;
    this.#deliver = options.deliver ?? deliverGenexFiles;
    this.#preload = options.preload ?? fileURLToPath(new URL("../../genex-host/preload.mjs", import.meta.url));
    this.#sendsApps = options.sendsApps ?? pinnedCliSendsApps();
    this.#sendsSource = options.sendsSource ?? pinnedCliSendsSource();
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
    if (epoch !== this.#authEpoch) throw new Error(MESSAGE.SignInCanceled());
    if (!isGenexAuthorizationUrl(new URL(d.verifyUrl))) throw new Error(MESSAGE.UnexpectedAuthorization());
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
    // What Genex said under this sign-in is not carried over to the next one.
    this.#settledGenerations.clear();
    this.#foundGenerations.clear();
    this.#allowances.clear();
    for (const c of this.#controllers.keys()) c.abort();
    await this.#account(async () => {
      await (await this.#store()).clear();
    });
  }
  async setupBadge() {
    if (!(await this.#token()))
      return { badge: MESSAGE.ConnectBadgeWord(), tone: "warn", title: MESSAGE.ConnectBadge() };
    return {};
  }
  /**
   * A project's tools workspace, where the asset commands run. `home/` is the CLI's HOME: the CLI
   * removes `genex-*` skills from the agent folders under its HOME before every command, so the
   * user's own must never be that HOME.
   */
  async #workspace(project: string) {
    if (!PROJECT_NAME.test(project)) throw new Error(PUBLISH_MESSAGE.InvalidProject);
    const cwd = path.join(this.root, "projects", project);
    await mkdir(path.join(cwd, ".genex"), { recursive: true });
    await mkdir(path.join(cwd, "home"), { recursive: true, mode: 0o700 });
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
    // The CLI pushes this folder as the game's source when no project goes with a publish: Studio's
    // private HOME, a project staged for remixers and the record of it are never part of it.
    await writeFile(path.join(dir, ".gitignore"), `home/\n${SOURCE_FOLDER}/\n${REMIX_FILE}\n`);
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
    if (!(await this.#run("git", ["--version"], dir, home))) throw new Error(PUBLISH_MESSAGE.NeedsGit());
    if (!(await this.#run("git", ["lfs", "version"], dir, home))) throw new Error(PUBLISH_MESSAGE.NeedsGitLfs());
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
      if (this.#publishJobs.has(project)) throw new Error(PUBLISH_MESSAGE.StillRunning());
      const state = await this.publishStatus(project);
      if (!state.job || state.job.id !== jobId) throw new Error(PUBLISH_MESSAGE.NotCurrent());
      if (state.job.state !== GenexPublishJobState.Unresolved) return state;
      finishJob(state.job, GenexPublishJobState.Failed, new Date().toISOString());
      state.job.error = PUBLISH_MESSAGE.AllowedNewUpload;
      delete state.job.checkError;
      delete state.job.nextCheckAt;
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
   * `apps` are the game's Mac, Windows and Linux builds, sent once its web build is public.
   */
  async publishGallery(
    project: string,
    exportStage: () => Promise<unknown>,
    title?: unknown,
    camera?: CoverCamera,
    apps: readonly NativeUpload[] = [],
    remix: RemixChoice = {},
  ): Promise<GenexPublishState> {
    return this.#account(() =>
      this.#startPublish(project, GenexPublishKind.Gallery, {
        exportStage,
        title,
        apps,
        remix,
        ...(camera ? { camera } : {}),
      }),
    );
  }
  /**
   * Publish a game that has only apps, no web build: send each with `genex native publish` and list
   * the game in the gallery under `title` with the first that goes, creating its hosted project the
   * first time. Runs as a publish job, so the dialog shows it like one. `camera` takes the cover
   * again first (an engine game's is the one its agent rendered); once the apps are recorded, that
   * cover is sent as a gallery publish's is.
   */
  async publishAppsOnly(
    project: string,
    apps: readonly NativeUpload[],
    title?: unknown,
    camera?: CoverCamera,
    remix: RemixChoice = {},
  ): Promise<GenexPublishState> {
    return this.#account(async () => {
      if (!this.#sendsApps || apps.length === 0) throw new Error(PUBLISH_MESSAGE.NoAppsRefusal());
      const state = await this.publishStatus(project);
      if (!state.connected) throw new Error(PUBLISH_MESSAGE.ConnectFirstRefusal());
      if (!(await this.#termsAccepted(project, state))) return state;
      const busy =
        state.job?.state === GenexPublishJobState.Running || state.job?.state === GenexPublishJobState.Unresolved;
      if (busy) return state;
      await this.#stopCoverStep(project);
      await this.#stopNativeStep(project);
      const dir = await this.#publishWorkspace(project);
      const meta = await readJsonOr<HostedMeta>(metaFile(dir));
      const job: GenexPublishJob = {
        id: randomUUID(),
        kind: GenexPublishKind.Gallery,
        state: GenexPublishJobState.Running,
        phase: publishPhaseFor(meta),
        startedAt: new Date().toISOString(),
        title: cleanGenexTitle(title) ?? state.title ?? defaultGenexTitle(project),
      };
      // The shot is taken here, inside the invocation: a detached send gets no answer from host services.
      const shotLines = camera ? await this.#reshoot(project, camera) : [];
      state.job = job;
      delete state.warnings;
      if (shotLines.length) state.warnings = shotLines;
      delete state.lastError;
      await this.#savePublishState(project, state);
      const done = this.#runAppsJob(project, job, apps, remix);
      this.#publishJobs.set(project, { job, done });
      void done.finally(() => {
        if (this.#publishJobs.get(project)?.job === job) this.#publishJobs.delete(project);
      });
      return this.#withCover(project, { ...state, job });
    });
  }
  /** The apps-only publish itself, detached from the press: hosted project, apps, listing, record. */
  async #runAppsJob(
    project: string,
    job: GenexPublishJob,
    apps: readonly NativeUpload[],
    remix: RemixChoice,
  ): Promise<void> {
    const dir = this.#publishDir(project);
    const controller = new AbortController();
    this.#controllers.set(controller, { project });
    const step: NativeStep = { jobId: job.id, controller, done: Promise.resolve() };
    try {
      const meta = await this.#ensureHostedProject(project, dir, path.join(dir, "home"), job, controller.signal);
      job.phase = GenexPublishPhase.Uploading;
      await this.#persistJob(project, job);
      const sending = this.#sendApps(project, job.id, apps, controller.signal, { title: job.title ?? project });
      step.done = sending.then(() => {});
      this.#nativeSteps.set(project, step);
      await this.#recordApps(project, job, meta, await sending);
      // The cover goes once the game is on Genex, as a gallery publish's does: never instead of an app.
      if (job.state === GenexPublishJobState.Done) {
        // Apps carry no source: the project goes on its own once the game is on Genex.
        await this.#sendProjectAfterApps(project, meta, remix, controller.signal);
        this.#startCoverStep(project, job.id);
      }
    } catch (error) {
      finishJob(job, GenexPublishJobState.Failed, new Date().toISOString());
      job.error = errorMessage(error).slice(-PUBLISH_ERROR_TAIL_CHARS);
      await this.#persistJob(project, job).catch(() => {});
    } finally {
      this.#controllers.delete(controller);
      if (this.#nativeSteps.get(project) === step) this.#nativeSteps.delete(project);
    }
  }
  /** What an apps-only publish did, on the record: listed (or held, or refused), or nothing sent. */
  async #recordApps(project: string, job: GenexPublishJob, meta: HostedMeta, sent: NativeSaved): Promise<void> {
    const now = new Date().toISOString();
    const state = await this.#publishState(project);
    mergeMeta(state, meta);
    state.job = job;
    const listing = sent.listing;
    if (sent.sent.length === 0) {
      finishJob(job, GenexPublishJobState.Failed, now);
      job.error = sent.failed[0]?.error ?? PUBLISH_MESSAGE.NoApps;
    } else if (listing?.state === GenexListingState.Refused) {
      finishJob(job, GenexPublishJobState.Failed, now);
      job.error = listing.detail ?? PUBLISH_MESSAGE.ListingRefused;
    } else {
      finishJob(job, GenexPublishJobState.Done, now);
      state.lastPublishAt = now;
      if (job.title) state.title = job.title;
      // Held for review or not listed at all: the apps are live, and the dialog says which (`native.listing`).
      if (listing?.state === GenexListingState.Published && state.slug) {
        // Genex's word that it is listed: kept in the hosted record every status read merges.
        const listed = { ...meta, status: GenexHostedStatus.Published };
        await atomicWriteJson(metaFile(this.#publishDir(project)), listed);
        mergeMeta(state, listed);
        state.galleryUrl = `${DEFAULT_DASHBOARD}/${state.slug}`;
      }
    }
    if (job.error) state.lastError = job.error;
    await this.#savePublishState(project, state);
  }
  /** Record Genex's terms answer; false when the user still has to accept them. */
  async #termsAccepted(project: string, state: GenexPublishState): Promise<boolean> {
    const legal = await this.#fetch(GenexRoute.LegalStatus).catch((error) => {
      const status = statusOf(error);
      if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN)
        throw new Error(PUBLISH_MESSAGE.AuthorizationExpired());
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
    {
      exportStage,
      title,
      camera,
      apps = [],
      remix = {},
    }: {
      exportStage?: () => Promise<unknown>;
      title?: unknown;
      camera?: CoverCamera;
      apps?: readonly NativeUpload[];
      remix?: RemixChoice;
    },
  ): Promise<GenexPublishState> {
    const state = await this.publishStatus(project);
    if (!state.connected) throw new Error(PUBLISH_MESSAGE.ConnectFirstRefusal());
    if (!(await this.#termsAccepted(project, state))) return state;
    const busy =
      state.job?.state === GenexPublishJobState.Running || state.job?.state === GenexPublishJobState.Unresolved;
    if (busy) return state;
    // A newer publish replaces the last one's cover send and its apps: it sends its own.
    await this.#stopCoverStep(project);
    await this.#stopNativeStep(project);
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
    const connect = exportStage ? await this.#exportGame(project, state, job, dir, exportStage) : false;
    const cover = coverRides(kind, state);
    // The shot is taken here, inside the invocation: a detached upload gets no answer from host services.
    const shotLines = cover && camera ? await this.#reshoot(project, camera) : [];
    state.job = job;
    delete state.warnings;
    if (shotLines.length) state.warnings = shotLines;
    delete state.lastError;
    await this.#savePublishState(project, state);
    const done = this.#runPublishJob(project, kind, job, { cover, connect, apps, remix });
    this.#publishJobs.set(project, { job, done });
    this.#exporting.delete(project);
    void done.finally(() => {
      if (this.#publishJobs.get(project)?.job === job) this.#publishJobs.delete(project);
    });
    return this.#withCover(project, { ...state, job });
  }
  /**
   * Export the game into the publish workspace and mark it, inside the invocation that asked. True
   * when the game brings no SDK of its own, so Studio connects the copy once Genex names its project.
   */
  async #exportGame(
    project: string,
    state: GenexPublishState,
    job: GenexPublishJob,
    dir: string,
    exportStage: () => Promise<unknown>,
  ): Promise<boolean> {
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
      const connect = !bringsOwnSdk(exported?.genex);
      await this.#writeWorkspaceManifest(dir, project, job, exported?.genex, connect);
      job.deployment = await markDeployment(path.join(dir, "dist"), job.id);
      job.phase = startPhase;
      return connect;
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
   * the folder it runs in: Studio's copy gets the game's Genex part of it, plus the SDK Studio ships
   * with a game that brings none (`studioSdk`), or none at all.
   */
  async #writeWorkspaceManifest(
    dir: string,
    project: string,
    job: GenexPublishJob,
    manifest: GenexGameManifest | undefined,
    studioSdk: boolean,
  ): Promise<void> {
    const pkg = workspaceManifest(project, manifest, studioSdk);
    const file = path.join(dir, "package.json");
    if (!pkg) {
      await rm(file, { force: true });
      return;
    }
    await atomicWriteJson(file, pkg);
    const embed = pkg.dependencies["@genex-ai/embed-sdk"];
    if (embed) job.embedSdkVersion = embed;
  }
  /**
   * Connect Studio's copy to the project Genex keeps for the game, which a first publish has only
   * just created, then mark it again: the draft test checks the files that really go up.
   */
  async #connectCopy(run: PublishRun, meta: HostedMeta): Promise<void> {
    const dist = path.join(run.dir, "dist");
    await connectPublishedCopy(dist, this.#embedSdk ?? installedEmbedSdk(), publishedConnection(meta, this.api));
    run.job.deployment = await markDeployment(dist, run.job.id);
    await this.#persistJob(run.project, run.job);
  }
  /**
   * The upload itself, detached from the invocation that asked for it. Every phase is persisted. A
   * publish tests the uploaded draft before anything goes public, and only then promotes and lists it.
   * Only once the upload is recorded does `cover` send the game's frame, as a step of its own: a
   * cover can never hold up or fail a publish, and a quit mid-send loses only the cover. A draft
   * asks again then, from what Genex just said: a game its owner listed on genex.games since
   * Studio last looked is public, and its draft sends nothing.
   */
  async #runPublishJob(
    project: string,
    kind: GenexPublishKind,
    job: GenexPublishJob,
    {
      cover,
      connect,
      apps,
      remix,
    }: { cover: boolean; connect: boolean; apps: readonly NativeUpload[]; remix: RemixChoice },
  ): Promise<void> {
    const dir = this.#publishDir(project);
    const home = path.join(dir, "home");
    const controller = new AbortController();
    this.#controllers.set(controller, { project });
    const run: PublishRun = {
      project,
      dir,
      home,
      job,
      signal: controller.signal,
      attempt: { submitted: false },
      staged: null,
    };
    try {
      const meta = await this.#ensureHostedProject(project, dir, home, job, controller.signal);
      run.attempt.slug = meta.slug;
      if (connect) await this.#connectCopy(run, meta);
      const allowed = remixAllowed(remix.allowed, await this.#remixSaved(project));
      // Only a publish opens the game to remixers: a draft carries no project.
      const staging = allowed && kind === GenexPublishKind.Gallery;
      const problem = staging ? await this.#stageForUpload(run, remix.gameDir) : undefined;
      const outs = kind === GenexPublishKind.Draft ? [await this.#uploadDraft(run)] : await this.#uploadTested(run);
      if (!outs) return;
      const relist = needsRelisting(meta, (await this.#publishState(project)).title, job.title);
      const listing = { title: job.title };
      for (const phase of publicSteps(meta, kind, relist)) outs.push(await this.#runStep(run, phase, listing));
      // Remixing is settled before the publish is recorded done, so its record never lags the dialog.
      if (kind === GenexPublishKind.Gallery) await this.#settleRemixing(project, meta, allowed, run.staged, problem);
      await this.#recordUpload(project, dir, kind, job, meta, outs);
      if (cover && coverRides(kind, await this.#pages(project))) this.#startCoverStep(project, job.id);
      // The apps go once the web build is public: a draft is not for players, and apps are live at once.
      if (kind === GenexPublishKind.Gallery && apps.length > 0) void this.publishApps(project, job.id, apps);
    } catch (error) {
      await this.#failPublishJob(project, job, run.attempt, error);
    } finally {
      this.#controllers.delete(controller);
      await dropStaged(dir);
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
    // Only an upload pushes the game's source; the other steps ship nothing new.
    const source = phase === GenexPublishPhase.Uploading ? sourceArgs(run.staged) : [];
    return (await this.#cliText(run.dir, [...publishArgs(phase, listing), ...source], run.signal, run.home)).out;
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
   * Test the draft an upload just put online: Genex serves this upload's revision and every exported
   * file. Tried again with backoff until the test time is up; a pass is recorded as the ready draft.
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
    // The user may have settled this upload while Genex was being asked: their choice stands.
    const latest = await this.#publishState(project);
    if (latest.job?.id !== job.id || !isOpen(latest.job)) {
      Object.assign(state, latest);
      return;
    }
    await this.#savePublishState(project, state);
  }
  /**
   * Genex serves this upload's revision and every exported file: the draft passes. Returns it as the
   * ready draft, unstamped. Its sign-in support is not read back: Genex keeps a draft's with the draft
   * and records it on the project only when that build goes public, so the project's is the public build's.
   */
  async #confirmDraft(slug: unknown, job: GenexPublishJob): Promise<Omit<ReadyDraft, "verifiedAt">> {
    const { stagingUrl, deployment, expectedStagingRevision } = job;
    if (!stagingUrl || !deployment || !expectedStagingRevision) throw new Error(PUBLISH_MESSAGE.NoStagingIdentity);
    const remote = await this.#fetch(GenexRoute.projectBySlug(typeof slug === "string" ? slug : ""));
    const revision = remote?.project?.stagingCommitSha ?? remote?.project?.stagingCommit;
    if (revision !== expectedStagingRevision) throw new Error(PUBLISH_MESSAGE.RevisionMismatch);
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
      throw new Error(PUBLISH_MESSAGE.NotInGallery());
    const url = linkFor(state, wanted);
    if (!url) throw new Error(PUBLISH_MESSAGE.NothingOnline());
    if (!isGenexLink(url)) throw new Error(PUBLISH_MESSAGE.UnrecognizedLink());
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
  /** What `remix.json` keeps for `project`. */
  async #remixSaved(project: string): Promise<RemixSaved> {
    return readRemixSaved(await readJsonOr(path.join(this.#publishDir(project), REMIX_FILE)));
  }
  /** The game's project as remixers get it, answered beside the publish record. */
  async #remixRecord(project: string): Promise<GenexRemixRecord> {
    return { supported: this.#sendsSource, sending: false, ...(await this.#remixSaved(project)) };
  }
  /**
   * Stage the game's project for an upload to push. Answers why it could not go, when it could not;
   * nothing is staged while this CLI cannot send a project.
   */
  async #stageForUpload(run: PublishRun, gameDir: string | undefined): Promise<GenexRemixProblem | undefined> {
    if (!this.#sendsSource) return undefined;
    if (!gameDir) return GenexRemixProblem.Failed;
    const staged = await stageProject(run.dir, gameDir);
    if ("problem" in staged) return staged.problem;
    run.staged = staged;
    return undefined;
  }
  /**
   * Once a publish is public: remixing stays open on Genex only when the game's project went with it,
   * and is turned off otherwise, so no one remixes a game without its project. Nothing changes while
   * this CLI cannot send a project. A refused change is kept as the record's problem: the publish
   * itself is already live.
   */
  async #settleRemixing(
    project: string,
    meta: HostedMeta,
    allowed: boolean,
    staged: StagedProject | null,
    problem: GenexRemixProblem | undefined,
  ): Promise<void> {
    if (!this.#sendsSource) return;
    const saved = staged ? sentProject(staged, new Date(this.#now())) : keptBackRecord(allowed, problem);
    const changed = await this.#setRemixing(meta, staged !== null);
    await saveRemix(this.#publishDir(project), changed ? saved : { ...saved, problem: GenexRemixProblem.Failed });
  }
  /** Open the game to remixers on Genex, or close it; false when Genex refused or could not be asked. */
  async #setRemixing(meta: HostedMeta, open: boolean): Promise<boolean> {
    if (typeof meta.id !== "string" || !meta.id) return false;
    const body = JSON.stringify({ private: !open });
    return this.#fetch(GenexRoute.visibility(meta.id), { method: "PATCH", body }).then(
      () => true,
      () => false,
    );
  }
  /**
   * After a game with only apps went live: send its project with `genex make-remixable --source`,
   * which also opens it to remixers, when remixing is allowed; else turn remixing off. Nothing changes
   * while this CLI cannot send a project.
   */
  async #sendProjectAfterApps(project: string, meta: HostedMeta, remix: RemixChoice, signal: AbortSignal) {
    if (!this.#sendsSource) return;
    const dir = this.#publishDir(project);
    const allowed = remixAllowed(remix.allowed, await this.#remixSaved(project));
    if (!allowed) return this.#settleRemixing(project, meta, false, null, undefined);
    if (!remix.gameDir) return this.#settleRemixing(project, meta, true, null, GenexRemixProblem.Failed);
    const staged = await stageProject(dir, remix.gameDir);
    if ("problem" in staged) return this.#settleRemixing(project, meta, true, null, staged.problem);
    this.#remixSends.add(project);
    try {
      await this.#spawnCli(dir, ["make-remixable", ...sourceArgs(staged)], signal, {
        timeoutMs: NATIVE_PUBLISH_TIMEOUT_MS,
        parse: false,
        home: path.join(dir, "home"),
      });
      await saveRemix(dir, sentProject(staged, new Date(this.#now())));
    } catch {
      await this.#settleRemixing(project, meta, true, null, GenexRemixProblem.Failed);
    } finally {
      this.#remixSends.delete(project);
      await dropStaged(dir);
    }
  }
  /** A publish state with the game's cover, and the cover lines of its own job among its warnings. */
  async #withCover(project: string, state: GenexPublishState): Promise<GenexPublishState> {
    const dir = this.#coverDir(project);
    const [shot, last, candidates, clip, clipLast, agentTook] = await Promise.all([
      readShot(dir),
      readSent(dir),
      readCandidates(dir),
      readClip(dir),
      readClipSent(dir),
      readAgentTook(dir),
    ]);
    const own = last?.jobId !== undefined && last.jobId === state.job?.id;
    const warnings = [...(state.warnings ?? []), ...(own ? (last.lines ?? []) : [])];
    const cover = { shot, last, sending: this.#coverSteps.has(project), candidates, clip, clipLast, agentTook };
    const native = await this.#nativeRecord(project);
    const remix = { ...(await this.#remixRecord(project)), sending: this.#remixSends.has(project) };
    return { ...state, ...(warnings.length ? { warnings } : {}), cover, native, remix };
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
    const shot = await this.#coverWrite(project, async () => {
      const kept = await saveShot(dir, reading.still, takenAt);
      await noteAgentTook(dir, { shot: takenAt });
      return kept;
    });
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
   * Studio's own cover step, as the Publish dialog opens and after a turn on the game: a fresh
   * frame of the genex-cover demo, or, for a game with no demo and no frame from one, a plain
   * frame of the game as it loads, so Publish always shows a cover. Nothing over the person's own
   * pick or the owner's cover on Genex, nothing beside a publish or a send, and at most once per
   * {@link COVER_AUTO_GAP_MS} a game. Answers the game's publish state with its cover.
   */
  async coverAuto(project: string, camera?: CoverCamera): Promise<GenexPublishState> {
    if (camera && (await this.#coverAutoDue(project))) {
      this.#coverAutoAt.set(project, this.#now());
      await this.#autoShoot(project, camera).catch(() => {});
      // A clip needs the game's own genex-clip demo to play itself: without one nothing is recorded.
      await this.#recordClip(project, camera).catch(() => null);
    }
    return this.#withCover(project, await this.publishStatus(project));
  }
  /** Whether Studio may take this game's cover now on its own. */
  async #coverAutoDue(project: string): Promise<boolean> {
    const busy = this.#publishJobs.has(project) || this.#coverSteps.has(project);
    const recent = this.#now() - (this.#coverAutoAt.get(project) ?? Number.NEGATIVE_INFINITY) < COVER_AUTO_GAP_MS;
    if (busy || recent) return false;
    const dir = this.#coverDir(project);
    const [shot, last] = await Promise.all([readShot(dir), readSent(dir)]);
    return !shot?.pinned && !ownerChoseCover(last);
  }
  /** One shot of the genex-cover demo, else Studio's plain frame unless a demo's frame is already kept. */
  async #autoShoot(project: string, camera: CoverCamera): Promise<void> {
    const dir = this.#coverDir(project);
    const demo = readStillAnswer(await within(camera.shoot(), this.#coverTimeouts.shotMs));
    if ("still" in demo) {
      const takenAt = new Date(this.#now()).toISOString();
      await this.#coverWrite(project, () => saveShot(dir, demo.still, takenAt));
      return;
    }
    const kept = await readShot(dir);
    const noDemo = demo.problem.code === PluginStillProblemCode.ViewUnknown;
    if (!noDemo || (kept && kept.origin !== GenexCoverOrigin.Studio)) return;
    const plain = readStillAnswer(
      await within(camera.shoot({ camera: COVER_FALLBACK_CAMERA }), this.#coverTimeouts.shotMs),
    );
    if (!("still" in plain)) return;
    const takenAt = new Date(this.#now()).toISOString();
    await this.#coverWrite(project, () => saveShot(dir, plain.still, takenAt, GenexCoverOrigin.Studio));
  }
  /**
   * genex__cover clip: record the game's genex-clip demo now and keep it as its clip. A problem
   * keeps the last clip and says what to fix; a recording comes back as its first frame.
   */
  async coverClip(project: string, camera: CoverCamera): Promise<Record<string, unknown>> {
    const taken = await this.#recordClip(project, camera);
    if (!taken)
      return {
        operation: CoverOperation.Clip,
        problem: { code: PluginStillProblemCode.Unavailable },
        guidance: CLIP_MESSAGE.Unavailable,
      };
    if ("problem" in taken)
      return {
        operation: CoverOperation.Clip,
        problem: taken.problem,
        kept: await readClip(this.#coverDir(project)),
        guidance: clipProblemGuidance(taken.problem),
      };
    const dir = this.#coverDir(project);
    await this.#coverWrite(project, () => noteAgentTook(dir, { clip: taken.clip.takenAt }));
    return {
      operation: CoverOperation.Clip,
      clip: taken.clip,
      guidance: clipGuidance(taken.clip),
      images: [{ mimeType: "image/jpeg", data: taken.poster.toString("base64"), label: CLIP_MESSAGE.PosterLabel }],
    };
  }
  /** Record the genex-clip demo and keep it; null when this camera records no clips. */
  async #recordClip(project: string, camera: CoverCamera) {
    if (!camera.record) return null;
    const answer = await camera.record().catch(() => null);
    const reading = readClipAnswer(answer);
    if ("problem" in reading) return reading;
    const takenAt = new Date(this.#now()).toISOString();
    const dir = this.#coverDir(project);
    const clip = await this.#coverWrite(project, () => saveClip(dir, reading.clip, takenAt));
    return { clip, poster: reading.clip.poster };
  }
  /** The person picked a candidate in Publish: it becomes the kept shot, pinned. Answers the publish state. */
  async coverPick(project: string, sha: unknown): Promise<GenexPublishState> {
    const dir = this.#coverDir(project);
    const picked = await this.#coverWrite(project, () => pickCandidate(dir, sha));
    if (!picked) throw new Error(COVER_MESSAGE.NoSuchCandidate());
    return this.#withCover(project, await this.publishStatus(project));
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
    // The person picked this frame among the candidates: it goes as it is.
    if ((await readShot(this.#coverDir(project)))?.pinned) return [];
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
  /**
   * Start a cover send for a game: after publish `jobId`, or (none) for genex__cover-set. Only a
   * publish's step sends the kept clip; genex__cover-set's approval covers the picture alone.
   */
  #startCoverStep(project: string, jobId?: string): CoverStep {
    const controller = new AbortController();
    this.#controllers.set(controller, { project });
    const step: CoverStep = { ...(jobId ? { jobId } : {}), controller, done: Promise.resolve(null) };
    const withClip = jobId !== undefined;
    step.done = this.#sendCover(project, controller.signal, jobId)
      .catch(() => null)
      .then(async (record) => {
        // The clip rides behind the cover, never instead of it: a clip that fails changes nothing else.
        if (withClip) await this.#sendClip(project, controller.signal, jobId).catch(() => {});
        return record;
      })
      .finally(() => {
        this.#controllers.delete(controller);
        if (this.#coverSteps.get(project) === step) this.#coverSteps.delete(project);
      });
    this.#coverSteps.set(project, step);
    return step;
  }
  // ── the game's apps ──────────────────────────────────────────────────────────────────────
  /** A game's apps as its last publish sent them, and whether they are going now. */
  async #nativeRecord(project: string): Promise<GenexNativeRecord> {
    const saved = readNativeSaved(await readJsonOr(path.join(this.#publishDir(project), NATIVE_FILE)));
    return { supported: this.#sendsApps, sending: this.#nativeSteps.has(project), ...saved };
  }
  /**
   * Send publish `jobId`'s apps (`genex native publish`), one at a time, each recorded as it goes; a
   * newer publish stops them. Nothing goes while the CLI has no `genex native`. Settles when the last
   * app went or failed.
   */
  async publishApps(project: string, jobId: string, apps: readonly NativeUpload[]): Promise<void> {
    if (!this.#sendsApps || apps.length === 0) return;
    await this.#stopNativeStep(project);
    await this.#startNativeStep(project, jobId, apps).done;
  }
  #startNativeStep(project: string, jobId: string, apps: readonly NativeUpload[]): NativeStep {
    const controller = new AbortController();
    this.#controllers.set(controller, { project });
    const step: NativeStep = { jobId, controller, done: Promise.resolve() };
    step.done = this.#sendApps(project, jobId, apps, controller.signal)
      .then(() => {})
      .catch(() => {})
      .finally(() => {
        this.#controllers.delete(controller);
        if (this.#nativeSteps.get(project) === step) this.#nativeSteps.delete(project);
      });
    this.#nativeSteps.set(project, step);
    return step;
  }
  /**
   * Each app through `genex native publish`, recorded as it goes: what went live and what did not.
   * With `gallery`, the game is listed under its title with the first app that goes (a game with only
   * apps); the record then keeps Genex's answer.
   */
  async #sendApps(
    project: string,
    jobId: string,
    apps: readonly NativeUpload[],
    signal: AbortSignal,
    gallery?: { title: string },
  ): Promise<NativeSaved> {
    const dir = this.#publishDir(project);
    const file = path.join(dir, NATIVE_FILE);
    const record: NativeSaved = { jobId, sent: [], failed: [] };
    await mkdir(path.join(dir, "home"), { recursive: true, mode: 0o700 });
    await atomicWriteJson(file, record);
    for (const app of apps) {
      const listing = gallery && !record.listing ? ["--gallery", "--title", gallery.title] : [];
      const outcome = await sendNativeBuild(app, () =>
        this.#spawnCli(dir, [...nativePublishArgs(app), ...listing], signal, {
          timeoutMs: NATIVE_PUBLISH_TIMEOUT_MS,
          parse: true,
          home: path.join(dir, "home"),
          // A refused listing exits 1 with its answer: the build itself is live.
          answerExitCodes: [0, 1],
        }),
      );
      // Stopped: a newer publish writes its own record.
      if (signal.aborted) return record;
      if ("sent" in outcome) record.sent.push(outcome.sent);
      else record.failed.push(outcome.failed);
      if (outcome.listing) record.listing = outcome.listing;
      await atomicWriteJson(file, record);
    }
    return record;
  }
  /** Stop a game's apps being sent and wait for the step to end. */
  async #stopNativeStep(project: string): Promise<void> {
    const step = this.#nativeSteps.get(project);
    if (!step) return;
    step.controller.abort();
    await step.done;
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
  /**
   * Send the kept clip unless Genex settled these bytes, with the build it was recorded from (the
   * revision the last upload shipped, else for a game with only apps its app's archive hash): Genex
   * keeps a clip only of a build the game ships. What goes out is a copy taken when the send began;
   * a stopped send writes nothing.
   */
  async #sendClip(project: string, signal: AbortSignal, jobId?: string): Promise<void> {
    const dir = this.#coverDir(project);
    const planned = await this.#coverWrite(project, async () => {
      const [clip, last] = await Promise.all([readClip(dir), readClipSent(dir)]);
      if (!clipToSend(clip, last) || !clip) return null;
      const copy = await freezeClip(dir, clip);
      return copy ? { clip, copy } : null;
    });
    if (!planned) return;
    try {
      const revision = await this.#clipBuild(project);
      if (!revision || signal.aborted) return;
      const { out } = (await this.#spawnCli(
        this.#publishDir(project),
        ["cover", "--clip", planned.copy, "--commit", revision, "--json"],
        signal,
        {
          timeoutMs: this.#coverTimeouts.sendMs,
          parse: false,
          home: path.join(this.#publishDir(project), "home"),
          answerExitCodes: COVER_ANSWER_EXIT_CODES,
        },
      ).catch(() => ({ out: "" }))) as { out: string };
      if (signal.aborted) return;
      await writeClipSent(dir, clipSentRecord(out, planned.clip, new Date(this.#now()).toISOString(), jobId));
    } finally {
      await rm(planned.copy, { force: true });
    }
  }
  /** The build a clip names: the staging revision the last upload shipped, else a sent app's archive hash. */
  async #clipBuild(project: string): Promise<string | undefined> {
    const dir = this.#publishDir(project);
    const revision = (await readJsonOr<HostedMeta>(metaFile(dir)))?.stagingCommit;
    if (revision) return revision;
    return appClipCommit(readNativeSaved(await readJsonOr(path.join(dir, NATIVE_FILE))).sent);
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
  /** Asset commands: structured output, the asset timeout (or less), the workspace's contained HOME. */
  async #cli(cwd: string, args: string[], signal?: AbortSignal, timeoutMs = ASSET_TIMEOUT_MS): Promise<any> {
    try {
      return await this.#spawnCli(cwd, args, signal, {
        timeoutMs,
        parse: true,
        home: path.join(cwd, "home"),
      });
    } finally {
      // Whatever ran may have spent from the allowance; a `budget` read records its own answer.
      if (args[0] !== BUDGET_COMMAND) this.#allowances.delete(cwd);
    }
  }
  /** The game's allowance: a recent answer for this sign-in, or the CLI's `budget` asked again. */
  async #allowance(cwd: string, signal?: AbortSignal): Promise<unknown> {
    const token = (await this.#token()) ?? "";
    const epoch = this.#authEpoch;
    const known = this.#allowances.get(cwd);
    const fresh =
      known && known.epoch === epoch && known.token === token && this.#now() - known.at < ALLOWANCE_REUSE_MS;
    if (fresh) return known.allowance;
    const allowance = await this.#cli(cwd, [BUDGET_COMMAND], signal);
    if (epoch === this.#authEpoch) this.#allowances.set(cwd, { epoch, token, at: this.#now(), allowance });
    return allowance;
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
    options: { timeoutMs: number; parse: boolean; home: string; answerExitCodes?: readonly number[] },
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
  async #reconcileJob(cwd: string, job: GenexJob, read: RemoteRead = RemoteRead.None, signal?: AbortSignal) {
    const reservation = await readLedger(cwd, job);
    const remote = read !== RemoteRead.None;
    if (remote && !job.generationId) await this.#findGeneration(job, reservation, read, signal);
    if (remote && job.generationId) await this.#refreshGeneration(job, job.generationId, read, signal);
    if (job.generationId && isUncertainSubmit(job)) job.status = GenexJobStatus.Accepted;
  }
  /** Ask Genex which generation a generic reservation became, unless it named one that has since settled. */
  async #findGeneration(job: GenexJob, reservation: LedgerRow | undefined, read: RemoteRead, signal?: AbortSignal) {
    if (reservation?.generic !== true || typeof reservation.id !== "string") return;
    const known = read === RemoteRead.Remembered ? this.#foundGenerations.get(reservation.id) : undefined;
    if (known && this.#settledGenerations.has(known.id)) {
      applyFoundGeneration(job, known);
      return;
    }
    try {
      const found = await this.#fetch(GenexRoute.generationRequest(reservation.id), withSignal(signal));
      if (typeof found.id !== "string") return;
      const answer: FoundGeneration = { id: found.id, status: found.status, creditsQuoted: found.creditsQuoted };
      applyFoundGeneration(job, answer);
      this.#foundGenerations.set(reservation.id, answer);
    } catch {} // A failed lookup cannot authorize a replacement or release a reservation.
  }
  /**
   * Copy Genex's view of a generation onto the job: status, files and credits. A remembered read
   * applies Genex's last word on a settled generation without asking again; any read that asks
   * remembers the answer once it is settled.
   */
  async #refreshGeneration(job: GenexJob, generationId: string, read: RemoteRead, signal?: AbortSignal) {
    const known = read === RemoteRead.Remembered ? this.#settledGenerations.get(generationId) : undefined;
    if (known) {
      applyGenerationView(job, known);
      return;
    }
    try {
      const view = generationView(await this.#fetch(GenexRoute.generation(generationId), withSignal(signal)));
      applyGenerationView(job, view);
      if (isSettledView(view)) this.#settledGenerations.set(generationId, view);
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
    const read = connected ? RemoteRead.Remembered : RemoteRead.None;
    for (let offset = 0; offset < jobs.length; offset += RECONCILE_BATCH) {
      signal?.throwIfAborted();
      const batch = jobs.slice(offset, offset + RECONCILE_BATCH);
      await Promise.all(batch.map((job) => this.#reconcileJob(cwd, job, read, signal)));
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
      result.allowance = await this.#allowance(cwd, signal);
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
    timeoutMs: number,
  ): Promise<NonNullable<GenexJob["approval"]>> {
    if (!request.id) throw new Error(MESSAGE.ApprovalNeedsSource);
    const response = (await this.#cli(cwd, ["wait", request.id, "--no-download"], signal, timeoutMs)) as ReviewAnswer;
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
    hooks: GenexExecuteHooks = {},
  ): Promise<GenexJob | unknown> {
    const controller = new AbortController();
    this.#controllers.set(controller, { project, threadId });
    const stop = () => controller.abort();
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
      return await this.#execute(project, root, request, controller.signal, approved, hooks);
    } finally {
      signal?.removeEventListener("abort", stop);
      this.#controllers.delete(controller);
    }
  }
  /** Whether the signed-in account still has Genex's updated terms to accept. */
  async termsStatus(signal?: AbortSignal): Promise<{ pending: boolean }> {
    const legal = await this.#fetch(GenexRoute.LegalStatus, withSignal(signal));
    return { pending: legal?.accepted === false };
  }
  /**
   * Before a generation reaches Genex: while the account's terms wait for the person, say so and ask
   * again until they accept or the wait runs out. Accepted terms cost one question and say nothing;
   * a question Genex does not answer stops nothing (the CLI meets any refusal itself).
   */
  async #waitForTerms(signal: AbortSignal, hooks: GenexExecuteHooks): Promise<void> {
    const pending = async () => (await this.termsStatus(signal).catch(() => ({ pending: false }))).pending;
    if (!(await pending())) return;
    await hooks.termsPending?.(true);
    const deadline = this.#now() + this.#termsWait.waitMs;
    while (this.#now() < deadline) {
      await sleep(this.#termsWait.pollMs, undefined, { signal });
      if (await pending()) continue;
      await hooks.termsPending?.(false);
      return;
    }
    throw new GenexTermsPending();
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
    hooks: GenexExecuteHooks,
  ): Promise<unknown> {
    if (signal?.aborted) throw new Error(MESSAGE.StoppedBeforeSubmission);
    const startedAt = this.#now();
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
      if (!READ_OPERATIONS.has(request.operation)) await this.#waitForTerms(signal, hooks);
      const cliMs = assetCliTimeoutMs(this.#now() - startedAt);
      if (cliMs === 0) throw new Error(MESSAGE.NoTimeToSubmit);
      if (APPROVAL_OPERATIONS.has(request.operation) && !approved) {
        job.approval = await this.#approvalReview(cwd, request, signal, cliMs);
        job.status = GenexJobStatus.ApprovalRequired;
        await save();
        return { ...job, approval: approvalSummary(job.approval) };
      }
      const { args, output } = await cliArgsFor(request, root, dir, approved);
      job.status = GenexJobStatus.Submitting;
      await save();
      const response = await this.#cli(cwd, args, signal, cliMs);
      await this.#recordAnswer(cwd, dir, root, job, response, output, signal);
      await save();
      return { ...job, result: response };
    } catch (e) {
      job.status = failedJobStatus(job, signal.aborted);
      job.error = (e as Error).message;
      if (e instanceof GenexTermsPending) job.blocked = GenexBlocked.Terms;
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
    await this.#reconcileJob(cwd, job, RemoteRead.Fresh, signal);
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
    if (!JOB_ID.test(id)) throw new Error(MESSAGE.InvalidApproval());
    const data = await this.#account(async () => {
      const dir = path.join(await this.#workspace(project), "jobs", id);
      const job = await readJsonOr<GenexJob>(path.join(dir, "job.json"));
      if (job?.status !== GenexJobStatus.ApprovalRequired || !job.approval?.images?.length)
        throw new Error(MESSAGE.ApprovalNotPending());
      const pending = await readJsonOr<{ root: string; request: GenexRequest }>(path.join(dir, "request.json"));
      if (!pending) throw new Error(MESSAGE.ApprovalNotPending());
      if (pending.request.operation === GenexOperation.CharacterPreview) {
        if (candidate === undefined || !PREVIEW_CANDIDATES.includes(candidate))
          throw new Error(MESSAGE.ChooseCandidate());
        pending.request.options = { ...pending.request.options, candidate };
      }
      job.status = GenexJobStatus.Approved;
      await atomicWriteJson(path.join(dir, "job.json"), job);
      return pending;
    });
    return this.execute(project, data.root, data.request, undefined, true);
  }
}
