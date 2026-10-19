/**
 * The main-side seams of play-time AI: one interface per part, so each part is built and tested
 * on its own and composed in one place. `GameAiService` runs every call — read → route → reserve →
 * queue → door → validate → settle — over the parts named in {@link GameAiDeps}; the bridges turn
 * each lane's input into a {@link GameAiCaller} derived by main; the IPC registrar
 * (`main/ipc/game-ai.ts`) and the harness RPC (`main/harness-rpc/ai.ts`) call the hosts at the end.
 *
 * Rules every implementation keeps (plan §3, design laws):
 *  - The caller is derived by main per message from where it came (the frame, the partition, the
 *    process), never read from a payload.
 *  - A refusal has no side effect. A call reserves its worst case and persists the hold before
 *    dispatch; a crash never refunds, and a reply the game could not use is never charged (D7).
 *  - Plan or money is used only after a person's yes on a trusted surface; that yes asserts its
 *    native step (`GameAiNativeStep`) first. A free model may start with no tap (`AiConsent.Silent`).
 *  - Harness runs, judges and checks never reach the network: tape, fixture or local, on a run
 *    budget the host created.
 *  - The ledger and the logs never hold prompt or answer text.
 *  - Every door's process goes through ProcessSandbox; times come from {@link GameAiClock}.
 */
import type { AiContext, DoorReadiness } from "../../shared/game-ai-route.ts";
import type {
  AiBudgetView,
  AiCallAnswer,
  AiCallRequest,
  AiConsent,
  AiDoor,
  AiErrorCode,
  AiGameKey,
  AiGrantRequest,
  AiGrantStatus,
  AiModelRef,
  AiProvenance,
  AiRequirement,
  AiUsage,
} from "../../shared/game-ai.ts";
import type { AiBridgeAnswers, AiBridgeMessage, AiGrantAnswer } from "../../shared/game-ai-bridge.ts";
import type { AiBenchResult, AiCheckResult, AiFitCountRow, AiPublishFacts } from "../../shared/game-ai-check.ts";
import type { AiReportBundle, AiReportOutcome, AiReportRequest } from "../../shared/game-ai-report.ts";
import type { AiRecordResult, AiReplayResult, TapeLine } from "../../shared/game-ai-tape.ts";
import type {
  AiActivity,
  AiAutoTopUp,
  AiConsentAnswer,
  AiConsentResult,
  AiConsentTicket,
  AiCreditPack,
  AiCreditProduct,
  AiModelMenu,
  AiPickResult,
  AiStopCard,
  AiTapeSummary,
  GameAiNotice,
  GameAiSettingsPatch,
  GameAiSettingsView,
} from "../../shared/game-ai-views.ts";
import type { GenexDesktopConfirmAnswer, GenexDesktopConfirmRequest } from "../../shared/genex-desktop-bridge.ts";
import type { PlayAiBar } from "../../shared/play-bar.ts";
import type { CompletePurpose } from "../../substrate/engines/types.ts";

/**
 * Play-time AI's own folder under userData: grants, settings and the ledger. It sits outside every
 * root an agent process may write (`StudioCore.#createSandbox`), so no agent can grant itself AI.
 */
export const GAME_AI_DIR = "game-ai";

/** The native steps a card's yes asserts before it spends anything (`main/dev/native-policy.ts`). */
export const GameAiNativeStep = {
  /** A door that bills: the person's key, OpenCode's paid models, Genex credits, development credits. */
  ApprovePaid: "studio:game-ai.approve-paid",
  /** The person's Claude or ChatGPT plan. */
  ApprovePlan: "studio:game-ai.approve-plan",
} as const;
export type GameAiNativeStep = (typeof GameAiNativeStep)[keyof typeof GameAiNativeStep];

/** Main's clock: every TTL, window and day is read from it, so tests hold time. */
export interface GameAiClock {
  /** Wall-clock ms since the epoch; a clock that goes backwards never extends anything. */
  now(): number;
}

/** Who is calling, derived by main from the bridge on every message. Never read from a payload. */
export interface GameAiCaller {
  game: AiGameKey;
  /** The game's name as the catalog or the library shows it. */
  title: string;
  context: AiContext;
  /** The creator's own game (Create Live on a game in their library). */
  ownGame: boolean;
  /** A harness run is replaying a tape for this game. */
  replaying: boolean;
  /** The bridge's own id for the page or process (`webContents.id`, a native job id), for abandon. */
  channel: string;
}

// ── grants (keyed by profile, game and door; first-use consent, no TTL) ────────────────────

/**
 * A game's grant as main persists it in `userData/game-ai/grants.json` (a protected path): keyed by
 * profile (each profile has its own userData), game and door, agreed once by first-use consent, with
 * no TTL; it ends when the person turns it off or another model replaces it.
 */
export interface AiGrantRecord {
  id: string;
  game: AiGameKey;
  door: AiDoor;
  model: AiModelRef;
  status: AiGrantStatus;
  consent: AiConsent;
  /** ISO times: the person's yes (or the silent start), and the last call. */
  consentedAt: string;
  lastUsedAt: string | null;
  /** Settled spend, in USD micros: all time, today (by `day`) and this calendar month (by `month`). */
  spentMicros: number;
  todayMicros: number;
  day: string;
  monthMicros: number;
  month: string;
  /** The game's requirement, as it last said it. */
  requires: AiRequirement;
}

/** A reservation held for one call before dispatch. */
export interface AiHold {
  grantId: string;
  /** The worst case reserved, in USD micros. */
  reservedMicros: number;
  /** Count the one repair attempt against the grant's rate (never against its money: D7). */
  countRepair(): void;
  /** Settle what the call really cost; null: it gave the game nothing usable, so nothing is charged. */
  settle(cost: AiCallCost | null): Promise<void>;
  /** Give the reservation back: the call never left main. */
  release(): Promise<void>;
}

/** What one call cost. */
export interface AiCallCost {
  usage: AiUsage | null;
  costMicros: number;
}

/** A reservation, or why there is none. */
export type AiHoldResult = { ok: true; hold: AiHold } | { ok: false; code: AiErrorCode; retryAfterMs: number | null };

/** The grants store: one live grant per (game, door), newest replaces under a mutex, atomic writes. */
export interface GameAiGrants {
  /** The game's live grant, if it holds one. */
  live(game: AiGameKey): AiGrantRecord | null;
  /** Grant a game a model after a person's yes or a silent free start; the grant it holds after. */
  grant(game: AiGameKey, model: AiModelRef, consent: AiConsent, requires: AiRequirement): Promise<AiGrantRecord>;
  /** Reserve a call's worst case against the person's limits and persist it before dispatch. */
  reserve(grant: AiGrantRecord, worstMicros: number): Promise<AiHoldResult>;
  /** Turn a game's AI off (or on again); answers its grant after. */
  setOn(game: AiGameKey, on: boolean): Promise<AiGrantRecord | null>;
  /** Mark a grant's status (a plan resting, a pause at the daily alert). */
  setStatus(grantId: string, status: AiGrantStatus): Promise<void>;
  /** A payer changed (a key, a plan account, a sign-in): every grant naming the door stops; the games it stopped. */
  stopDoor(door: AiDoor): Promise<AiGameKey[]>;
  /** The person already agreed to this door for this game (first-use consent per game and door); a payer change forgets it. */
  consented(game: AiGameKey, door: AiDoor): boolean;
  list(): AiGrantRecord[];
  /** What the game may see of its grant. */
  view(grant: AiGrantRecord): AiBudgetView;
}

// ── the queue in front of the doors ────────────────────────────────────────────────────────

/** A slot on a door, or why there is none now. */
export type AiSlotResult =
  | { ok: true; release(): void }
  | { ok: false; code: AiErrorCode; retryAfterMs: number | null };

/** Build work first: the local doors and the plan yield to a running build; per-door concurrency (plan: 1). */
export interface GameAiQueue {
  acquire(door: AiDoor, game: AiGameKey, signal: AbortSignal): Promise<AiSlotResult>;
  /** A build started or ended on this Mac. */
  building(on: boolean): void;
}

// ── doors ──────────────────────────────────────────────────────────────────────────────────

/** One call as a door runs it: the request plus the model and the host's framing. */
export interface AiDoorRequest {
  /** The game the call is for, as main derived it: a tape's loaded playtest, the development lane's project. */
  game: AiGameKey;
  request: AiCallRequest;
  model: AiModelRef;
  /** Always `CompletePurpose.Game`: the judge framing never reaches a game's call. */
  purpose: typeof CompletePurpose.Game;
  /** The repair turn, when this is the one retry: the answer that failed and what was wrong. */
  repair: { previous: string; problem: string } | null;
}

/** A door's answer: the model's text, before the game's shape is checked. */
export interface AiDoorAnswer {
  text: string;
  /** The model id the provider says ran it. */
  model: string | null;
  usage: AiUsage | null;
  costMicros: number;
}

/** One door: Local, OpenCode, Byok, Plan, GenexDev, Tape or Fixture (`doors/*.ts`). */
export interface GameAiDoorImpl {
  door: AiDoor;
  readiness(): Promise<DoorReadiness>;
  /** The models it offers now, for the pill's menu and the check set. */
  models(): Promise<AiModelRef[]>;
  /** Worst-case cost of a call, in USD micros, from its prompt and output budget. */
  worstCaseMicros(request: AiCallRequest, model: AiModelRef): number;
  run(call: AiDoorRequest, signal: AbortSignal, onDelta?: (text: string) => void): Promise<AiDoorAnswer>;
}

// ── the ledger, the cache and the tapes ────────────────────────────────────────────────────

/** One settled call in `userData/game-ai/ledger.jsonl`: ids, counts and money, never text. */
export interface AiLedgerEntry {
  at: string;
  game: AiGameKey;
  grantId: string | null;
  site: string;
  door: AiDoor;
  model: string | null;
  provenance: AiProvenance;
  /** The call's outcome: null when it answered, else why not. */
  code: AiErrorCode | null;
  repaired: boolean;
  usage: AiUsage | null;
  costMicros: number;
  latencyMs: number;
}

/** The append-only, rotated ledger; each entry is also a `CustomEvent.GameAiCall` record. */
export interface GameAiLedger {
  append(entry: AiLedgerEntry): Promise<void>;
  /** Newest first, at most `limit`, of one game or all. */
  recent(limit: number, game?: AiGameKey): Promise<AiLedgerEntry[]>;
  /** Spent per game this calendar month, in USD micros. */
  monthByGame(): Promise<Map<AiGameKey, number>>;
}

/** Answers kept by request content (`callKey`), per game; a cached answer costs nothing. */
export interface GameAiCache {
  get(game: AiGameKey, request: AiCallRequest): Promise<AiCallAnswer | null>;
  put(game: AiGameKey, request: AiCallRequest, answer: AiCallAnswer): Promise<void>;
}

/** A game's tapes in `<project>/ai/tapes/`, every path realpath-contained in the game's folder. */
export interface GameAiTapes {
  list(project: string): Promise<AiTapeSummary[]>;
  read(project: string, demo: string): Promise<TapeLine[]>;
  /** Start a recording; lines append as answers settle; `close` writes it whole. */
  record(project: string, demo: string): Promise<{ append(line: TapeLine): Promise<void>; close(): Promise<void> }>;
}

// ── the platform: genex.games for credits, confirms, reports and the watcher ───────────────

/** genex.games as play-time AI needs it, with the account Play is signed in as. */
export interface GenexAiPlatform {
  balanceCredits(): Promise<number | null>;
  packs(): Promise<AiCreditPack[]>;
  /** The checkout page for a product; main opens it in the browser. */
  checkoutUrl(product: AiCreditProduct): Promise<string>;
  autoTopUp(): Promise<AiAutoTopUp | null>;
  setAutoTopUp(next: AiAutoTopUp): Promise<AiAutoTopUp>;
  /** A grant's or a generation's terms, read by id, for the confirm card. */
  confirmTerms(request: GenexDesktopConfirmRequest): Promise<{ maxCredits: number; game: string } | null>;
  /** Approve or decline on genex.games itself. */
  answerConfirm(request: GenexDesktopConfirmRequest, approved: boolean): Promise<GenexDesktopConfirmAnswer>;
  /** Whether the creator allowed device funding for a published game (read from the server, never the page). */
  deviceFundingAllowed(projectId: string): Promise<boolean>;
  sendReport(bundle: AiReportBundle): Promise<AiReportOutcome>;
  /** Counts-only fit rows, sent only with the person's consent. */
  sendFitCounts(rows: readonly AiFitCountRow[]): Promise<void>;
}

/** Where the plan watcher stands. Wire values: never rename one. */
export const AiWatcherState = {
  Off: "off",
  Online: "online",
  /** A build is running: the plan is the builder's first. */
  Yielding: "yielding",
  /** The plan reached its keep-for-building line; it resumes at `resetsAt`. */
  Resting: "resting",
  SignedOut: "signed-out",
} as const;
export type AiWatcherState = (typeof AiWatcherState)[keyof typeof AiWatcherState];

/** The watcher (§3.7): answers genex.games' plan-funded jobs with the person's own CLI, serially, tool-free. */
export interface GameAiPlanWatcher {
  state(): { state: AiWatcherState; runners: string[]; resetsAt: string | null };
  start(): Promise<void>;
  stop(): Promise<void>;
  /** A personal-funded call was just made in desktop Play: poll now instead of on the timer. */
  nudge(): void;
  /** A build started or ended: the watcher yields while one runs. */
  building(on: boolean): void;
}

// ── consent, the pill and the model check ──────────────────────────────────────────────────

/** Cards on trusted surfaces: a ticket per card, one pending per game, a cooldown after a decline. */
export interface GameAiConsents {
  /** Open a card and wait for its answer (or its lapse, as a decline). */
  ask(caller: GameAiCaller, ticket: AiConsentTicket): Promise<AiConsentAnswer>;
  /** The person's answer from the bar or Studio; asserts the native step for plan or money first. */
  answer(answer: AiConsentAnswer): Promise<AiConsentResult>;
  /** Close a game's cards (it left, or its AI turned off). */
  close(game: AiGameKey): void;
}

/** The pill and its menu, computed for one game. */
export interface GameAiPill {
  bar(game: AiGameKey): Promise<PlayAiBar>;
  menu(game: AiGameKey): Promise<AiModelMenu>;
}

/** The optional model check (D10/D12) on the creator's own models; the harness gets local models only. */
export interface GameAiModelCheck {
  start(project: string, options: { localOnly: boolean }): Promise<AiCheckResult>;
  state(project: string): Promise<AiCheckResult>;
  stop(project: string): Promise<AiCheckResult>;
  recommend(project: string, model: AiModelRef | null): Promise<AiCheckResult>;
  publishFacts(project: string): Promise<AiPublishFacts>;
}

/** Report bundles (D9): built from the session's ledger, tapes and capture, redacted, then sent. */
export interface GameAiReports {
  preview(game: AiGameKey): Promise<AiReportBundle>;
  send(request: AiReportRequest): Promise<AiReportOutcome>;
  /** An automatic bundle for a reply still invalid after its repair; no player text without opt-in. */
  automatic(caller: GameAiCaller, ticket: string): Promise<void>;
}

/** The settings store: `userData/game-ai/settings.json`, auto top-up read through on genex.games. */
export interface GameAiSettingsStore {
  view(): Promise<GameAiSettingsView>;
  save(patch: GameAiSettingsPatch): Promise<GameAiSettingsView>;
}

// ── the service and its deps ───────────────────────────────────────────────────────────────

/** What `createGameAiService` runs on; every part is replaceable in a test. */
export interface GameAiDeps {
  clock: GameAiClock;
  grants: GameAiGrants;
  queue: GameAiQueue;
  doors: ReadonlyMap<AiDoor, GameAiDoorImpl>;
  ledger: GameAiLedger;
  cache: GameAiCache;
  tapes: GameAiTapes;
  platform: GenexAiPlatform;
  watcher: GameAiPlanWatcher;
  consents: GameAiConsents;
  settings: GameAiSettingsStore;
  /** Throws in a fixture profile for a native step (`assertNativeActionAllowed`). */
  assertNative(step: GameAiNativeStep): void;
  /** Push `UiEvent.GameAi`. */
  notify(notice: GameAiNotice): void;
  /** Redraw a Play game's pill (`PlayBarState.ai`). */
  drawPill(game: AiGameKey, bar: PlayAiBar): void;
  /** The game's model menu (`GameAiPill.menu`): what Genex picks from when a game holds no grant. */
  menu(game: AiGameKey): Promise<AiModelMenu>;
  /** Classify text other players will see before it is broadcast (D6); false refuses it as `moderated`. */
  moderate(text: string): Promise<boolean>;
}

/** Runs every in-game AI call on this Mac. */
export interface GameAiService {
  /** One bridge message from a caller main derived; a streamed `say` reports its text so far. */
  handle<M extends AiBridgeMessage>(
    caller: GameAiCaller,
    message: M,
    onDelta?: (text: string) => void,
  ): Promise<AiBridgeAnswers[M["op"]]>;
  /** A grant asked for inside a gesture: Genex picks, and asks only before plan or money. */
  requestGrant(caller: GameAiCaller, request: AiGrantRequest): Promise<AiGrantAnswer>;
  /** Turn a game's AI off: prospective and immediate; in-flight calls abort within a second. */
  stop(game: AiGameKey): Promise<void>;
  /** A payer changed: every grant naming the door stops. */
  payerChanged(door: AiDoor): Promise<void>;
  /** A page or process went away or navigated: its pending tickets cancel and its calls abort. */
  abandon(channel: string): void;
  /** Show a stop card for a game. */
  showStop(card: AiStopCard): void;
}

// ── the hosts the IPC registrar and the harness RPC call ───────────────────────────────────

/** What `main/ipc/game-ai.ts` delegates to, its payloads already read. */
export interface GameAiIpcHost {
  menu(game: AiGameKey): Promise<AiModelMenu>;
  pick(game: AiGameKey, model: AiModelRef): Promise<AiPickResult>;
  answer(answer: AiConsentAnswer): Promise<AiConsentResult>;
  enable(game: AiGameKey, enabled: boolean): Promise<void>;
  activity(): Promise<AiActivity>;
  settings(): Promise<GameAiSettingsView>;
  saveSettings(patch: GameAiSettingsPatch): Promise<GameAiSettingsView>;
  tapes(project: string): Promise<AiTapeSummary[]>;
  reportPreview(game: AiGameKey): Promise<AiReportBundle>;
  report(request: AiReportRequest): Promise<AiReportOutcome>;
  check(project: string): Promise<AiCheckResult>;
  checkState(project: string): Promise<AiCheckResult>;
  checkStop(project: string): Promise<AiCheckResult>;
  recommend(project: string, model: AiModelRef | null): Promise<AiCheckResult>;
  publishFacts(project: string): Promise<AiPublishFacts>;
  credits(): Promise<AiCreditPack[]>;
  checkout(product: AiCreditProduct): Promise<void>;
}

/** What `main/harness-rpc/ai.ts` delegates to: tapes, mocks and local models only, on a host-made run budget. */
export interface GameAiHarnessHost {
  tapes(project: string): Promise<AiTapeSummary[]>;
  replay(project: string, demo: string, seeds: readonly number[]): Promise<AiReplayResult>;
  record(project: string, demo: string, seed: number): Promise<AiRecordResult>;
  bench(project: string, site: string, samples: number): Promise<AiBenchResult>;
  modelCheck(project: string): Promise<AiCheckResult>;
}

/** The Play view's bridge (`play/viewer-view.ts` hears `PlayAiChannel.Request`). */
export interface GameAiPlayBridge {
  /** Answer one envelope's AI op for the game the sending top frame shows now. */
  handle: GameAiService["handle"];
  /** The embed-sdk desktop confirm (D3): Genex's card over the game, the answer given on genex.games. */
  confirm(caller: GameAiCaller, request: GenexDesktopConfirmRequest): Promise<GenexDesktopConfirmAnswer>;
  abandon(channel: string): void;
}
