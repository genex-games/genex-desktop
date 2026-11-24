/**
 * Play-time models in a game's preview (docs/product/builds-live.md). The Genex SDK's local test
 * mode, which every loopback preview runs in, answers each model call `local_test_unsupported`
 * unless the page's address carries a practice helper's key (`genex_llm_practice=<port>.<hex>`).
 * This service runs that helper, the pinned CLI's `genex llm practice --json`, in the process
 * sandbox for a game whose code calls Genex's models, one per game and kind, and hands the preview
 * its key.
 *
 * Made-up answers (`source: 'practice'`, free, no account, loopback only) go to every preview: Live
 * and each agent's own window. Real models go to Live alone, and only after the person pressed
 * Start for a cap in Live's bar (`startRealModels`): the helper is then started with `--live --max-credits
 * <cap> --user-approved`, billed to the game's hosted project from the person's own credits, and the
 * CLI holds the whole run to the cap. A game that has no hosted project yet gets one on that Start
 * (`host`): a draft nobody sees, with none of its files sent. An agent's window never gets that key. The choice is kept per
 * game for this app session, and so is the cap: a run started after a Stop or a visit to another
 * game may spend only what the runs before it left, and once nothing is left real models wait for a
 * new Start. A new app start begins in practice.
 *
 * A helper lives while a preview shows its game: it stops when Live is stopped or moves to another
 * game, when an agent's window closes, and when the app quits.
 */
import type { ChildProcess } from "node:child_process";
import { rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { Writable } from "node:stream";
import { SECOND_MS } from "../../shared/duration.ts";
import { errorMessage } from "../../shared/errors.ts";
import { GenexHosting } from "../../shared/genex.ts";
import {
  isPreviewAiCap,
  noPreviewAi,
  PreviewAiMode,
  type PreviewAiState,
  PreviewAiUnavailable,
  type PreviewMicAsk,
} from "../../shared/preview-ai.ts";
import { LoopbackProtocol } from "../../substrate/linux-loopback-bridge.ts";
import { treeKiller } from "../../substrate/plugins/native-process.ts";
import type { LoopbackExpose } from "../../substrate/spawn.ts";
import type { PracticeLaunch } from "./genex-cli.ts";

/** The URL parameter the SDK reads the helper's key from (embed-sdk 0.37). */
export const PRACTICE_PARAM = "genex_llm_practice";
/** How long a starting helper may take to print its first line before it is ended. */
const PRACTICE_LISTEN_TIMEOUT_MS = 20 * SECOND_MS;
/** How long a stopping helper may take to print its totals and exit before it is killed. */
const PRACTICE_STOP_GRACE_MS = 3 * SECOND_MS;
/** The most of a helper's error kept for the bar. */
const ERROR_MAX_CHARS = 300;
/** A key as the CLI prints it: a port and the 32-hex token. */
const PRACTICE_KEY = /^genex_llm_practice=(\d{4,5})\.([0-9a-f]{32})$/;

/** The kinds of helper: made-up answers, or real models on the person's credits. */
export const PracticeKind = { Mock: "mock", Live: "live" } as const;
export type PracticeKind = (typeof PracticeKind)[keyof typeof PracticeKind];

/** The CLI's first line's `status` (`genex llm practice --json`). */
const PracticeStatus = { Listening: "listening", Failed: "failed", Off: "off" } as const;
/** The CLI's later lines' `event`. */
const PracticeEvent = { Live: "live", Call: "call", Stopped: "stopped" } as const;
/** The call refusals that mean the run's cap is spent. */
const CAP_SPENT: ReadonlySet<string> = new Set(["grant_limit_reached", "insufficient_credits"]);
/** Where a call was answered: by the real model. */
const VIA_LIVE = "live";

/** What the service needs: the CLI's launch, the sandbox, the person's account, Live and the bar. */
export interface PreviewAiDeps {
  /** The pinned CLI's helper command for a game (`GenexCliService.practiceLaunch`). */
  launch: (project: string, live: { maxCredits: number } | null) => Promise<PracticeLaunch>;
  /** ProcessSandbox's `spawnLongLived`. */
  spawn: (request: {
    command: string;
    cwd: string;
    env?: Record<string, string>;
    stdin?: string;
    label?: string;
    policy?: PracticeLaunch["policy"];
    loopbackServer?: boolean;
  }) => Promise<{ child: ChildProcess; input: Writable; expose?: LoopbackExpose }>;
  /** Whether the app is signed in to Genex now. */
  signedIn: () => Promise<boolean>;
  /** Whether the game has a hosted project on Genex to bill real calls to. */
  hasDraft: (project: string) => Promise<boolean>;
  /**
   * Put the game on the person's Genex account, with none of its files sent (`hostOnGenex`): asked
   * only after their Start, for a game that has no hosted project. Throws with Genex's words when it
   * could not.
   */
  host: (project: string) => Promise<GenexHosting>;
  /** Whether this profile may spend at all: false in a test (fixture) profile. */
  liveAllowed: () => boolean;
  /** A game's state changed: the bar hears it. */
  emit: (state: PreviewAiState) => void;
  /** Load Live again when it shows `project`, so its page takes the helper's new key. */
  reloadLive: (project: string) => Promise<void>;
  listenTimeoutMs?: number;
  stopGraceMs?: number;
}

/** One running helper. */
interface Helper {
  kind: PracticeKind;
  project: string;
  child: ChildProcess;
  root: string;
  /** Its key once it listens. */
  key: string | null;
  /** The most it may spend (real models only): what was left of the approved cap when it started. */
  cap: number | null;
  /** What it has charged and holds so far (real models only). */
  spent: number;
  /** Its spend was added to the game's (`#settle`). */
  settled: boolean;
  closed: Promise<void>;
  /** Asked to stop by the service: its exit is no failure. */
  stopping: boolean;
}

/** Why real models cannot start for a game, with Genex's own words when it gave any. */
interface Refusal {
  reason: PreviewAiUnavailable;
  error: string | null;
}

/** What a helper's first line said. */
type FirstLine =
  | { status: typeof PracticeStatus.Listening; key: string }
  | { status: typeof PracticeStatus.Off }
  | { status: typeof PracticeStatus.Failed; error: string };

/** A JSON object line, or null. */
function jsonLine(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A helper's key when `value` is one the SDK takes, else null. */
export function practiceKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = PRACTICE_KEY.exec(value);
  const port = Number(match?.[1]);
  return match && port >= 1024 && port <= 65535 ? value : null;
}

/** The first line's meaning, or null for a line that is not the helper's first. */
export function firstPracticeLine(text: string): FirstLine | null {
  const line = jsonLine(text);
  if (line?.command !== "llm practice") return null;
  if (line.status === PracticeStatus.Off) return { status: PracticeStatus.Off };
  const key = practiceKey(line.key);
  if (line.status === PracticeStatus.Listening && key) return { status: PracticeStatus.Listening, key };
  const code = typeof line.code === "string" ? `${line.code}: ` : "";
  const words = typeof line.error === "string" ? line.error : JSON.stringify(line).slice(0, ERROR_MAX_CHARS);
  return { status: PracticeStatus.Failed, error: `${code}${words}`.slice(0, ERROR_MAX_CHARS) };
}

/** A whole number of credits from a line, or null. */
const credits = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** The `<entry>` with a helper's key added to its query. */
export function withPracticeKey(entry: string, key: string | null): string {
  if (key === null) return entry;
  return `${entry}${entry.includes("?") ? "&" : "?"}${key}`;
}

/** The game's helpers, the previews that show each game, and the person's choice per game. */
export class PreviewAiService {
  readonly #deps: PreviewAiDeps;
  /** Running (or starting) helpers by `<kind>:<project>`. */
  readonly #helpers = new Map<string, Helper>();
  /** A start under way by `<kind>:<project>`: a second ask waits for it. */
  readonly #starting = new Map<string, Promise<Helper | null>>();
  /** Which game each preview shows (by its handle), while it asked for a helper. */
  readonly #holders = new Map<string, string>();
  /** The handle of Live: the only preview real models may answer. */
  readonly #liveHandle: string;
  /**
   * The cap the person approved for each game by pressing Start in Live's bar, for this app
   * session: the only way a helper on real models is started (`#startLive`).
   */
  readonly #approved = new Map<string, number>();
  /**
   * What the ended runs under a game's approval charged and held, so the next run gets the rest of
   * the cap and never the whole of it again. A held bill counts as spent.
   */
  readonly #spent = new Map<string, number>();
  readonly #states = new Map<string, PreviewAiState>();
  #closing = false;

  constructor(deps: PreviewAiDeps, liveHandle: string) {
    this.#deps = deps;
    this.#liveHandle = liveHandle;
  }

  /** A game's state for its bar. */
  state(project: string): PreviewAiState {
    return this.#states.get(project) ?? noPreviewAi(project);
  }

  /** Change a game's state and tell the bar. */
  #set(project: string, change: Partial<Omit<PreviewAiState, "project">>): void {
    const next = { ...this.state(project), ...change, project };
    this.#states.set(project, next);
    this.#deps.emit(next);
  }

  /** Whether the game is on Genex, for the bar's confirmation, said only when it changed. */
  #noteOnGenex(project: string, onGenex: boolean): void {
    if (this.state(project).onGenex !== onGenex) this.#set(project, { onGenex });
  }

  /** The microphone's ask for a game changed (`preview-mic.ts`). */
  setMic(project: string, mic: PreviewMicAsk): void {
    this.#set(project, { mic });
  }

  /**
   * The helper key preview `handle` loads `project` with, starting the helper it needs; null when
   * none could start. Live gets real models only while the person's approval for that game stands;
   * every other preview gets made-up answers. A preview that moved off another game lets go of it.
   */
  async keyFor(handle: string, project: string): Promise<string | null> {
    const before = this.#holders.get(handle);
    this.#holders.set(handle, project);
    if (before !== undefined && before !== project) await this.#letGo(before);
    if (handle === this.#liveHandle) this.#noteOnGenex(project, await this.#deps.hasDraft(project));
    if (handle === this.#liveHandle && this.#approved.has(project)) {
      const live = await this.#startLive(project);
      if (live?.key) return live.key;
    }
    if (handle === this.#liveHandle && this.state(project).mode === PreviewAiMode.None)
      this.#set(project, { mode: PreviewAiMode.Practice });
    const mock = await this.#ensure(PracticeKind.Mock, project, null);
    return mock?.key ?? null;
  }

  /** Preview `handle` shows no game that needs a helper now: helpers nobody shows stop. */
  async release(handle: string): Promise<void> {
    const project = this.#holders.get(handle);
    if (project === undefined) return;
    this.#holders.delete(handle);
    await this.#letGo(project);
  }

  /**
   * Preview `handle` shows `project`, whose code calls no play-time model (any more): it lets go of
   * the helper, and in Live the bar goes, unless real models were approved for the game.
   */
  async noModels(handle: string, project: string): Promise<void> {
    await this.release(handle);
    const idle = handle === this.#liveHandle && !this.#approved.has(project);
    if (idle && this.state(project).mode !== PreviewAiMode.None)
      this.#set(project, { mode: PreviewAiMode.None, reason: null, error: null });
  }

  /** Stop the helpers of `project` no preview shows any more: its real-model one goes with Live. */
  async #letGo(project: string): Promise<void> {
    const shown = [...this.#holders.values()].includes(project);
    const inLive = this.#holders.get(this.#liveHandle) === project;
    if (!inLive) await this.#stop(PracticeKind.Live, project);
    if (!shown) await this.#stop(PracticeKind.Mock, project);
  }

  /**
   * The person pressed Start in Live's bar for `capCredits`: recorded as their approval for this
   * game and cap, then Live is loaded again on real models. A game that is not on their Genex account
   * is put there first. Refused with the reason the bar shows when this profile never spends, the app
   * is signed out, Genex's terms wait or the game could not be put on Genex.
   */
  async startRealModels(project: string, capCredits: number): Promise<PreviewAiState> {
    if (!isPreviewAiCap(capCredits)) throw new Error(`${capCredits} is not a cap Live offers`);
    const refusal = (await this.#cannotSpend(project)) ?? (await this.#putOnGenex(project, capCredits));
    if (refusal !== null) {
      this.#set(project, { mode: PreviewAiMode.Unavailable, ...refusal, capCredits: null });
      return this.state(project);
    }
    // A new cap starts a new run, counted from nothing: the one on the old cap ends first.
    await this.#stop(PracticeKind.Live, project);
    this.#approved.set(project, capCredits);
    this.#spent.delete(project);
    this.#set(project, {
      mode: PreviewAiMode.Starting,
      reason: null,
      error: null,
      capCredits,
      chargedCredits: 0,
      heldCredits: 0,
    });
    await this.#deps.reloadLive(project);
    return this.state(project);
  }

  /** The person went back to practice answers: the approval ends and Live loads on made-up answers. */
  async backToPractice(project: string): Promise<PreviewAiState> {
    this.#approved.delete(project);
    await this.#stop(PracticeKind.Live, project);
    this.#spent.delete(project);
    this.#set(project, { mode: PreviewAiMode.Practice, reason: null, error: null, capCredits: null });
    await this.#deps.reloadLive(project);
    return this.state(project);
  }

  /** Why real models cannot answer in this profile or for this account, or null when they can. */
  async #cannotSpend(project: string): Promise<Refusal | null> {
    if (!this.#deps.liveAllowed()) return { reason: PreviewAiUnavailable.NotHere, error: null };
    if (!(await this.#deps.signedIn())) return { reason: PreviewAiUnavailable.SignedOut, error: null };
    return null;
  }

  /**
   * The game's hosted project, which real calls are billed to, made when it has none; the bar says
   * real AI is starting while Genex is asked. Null once the game is on Genex, else why it is not.
   */
  async #putOnGenex(project: string, capCredits: number): Promise<Refusal | null> {
    if (await this.#deps.hasDraft(project)) {
      this.#noteOnGenex(project, true);
      return null;
    }
    this.#set(project, { mode: PreviewAiMode.Starting, reason: null, error: null, capCredits, onGenex: false });
    try {
      const hosting = await this.#deps.host(project);
      if (hosting !== GenexHosting.Hosted) return { reason: PreviewAiUnavailable.Terms, error: null };
      this.#noteOnGenex(project, true);
      return null;
    } catch (error) {
      return { reason: PreviewAiUnavailable.NoDraft, error: errorMessage(error).slice(0, ERROR_MAX_CHARS) };
    }
  }

  /**
   * Live's helper on real models for the cap the person approved for this game, or null (then the
   * state says why and practice answers go on). Nothing but a recorded approval starts one.
   */
  async #startLive(project: string): Promise<Helper | null> {
    const cap = this.#approved.get(project);
    if (cap === undefined) return null;
    const running = this.#helpers.get(`${PracticeKind.Live}:${project}`);
    const left = Math.floor(cap - (this.#spent.get(project) ?? 0));
    if (!running && left < 1) {
      this.#set(project, { mode: PreviewAiMode.CapReached });
      return null;
    }
    const helper = await this.#ensure(PracticeKind.Live, project, left);
    if (helper?.key) {
      if (this.state(project).mode === PreviewAiMode.Starting) this.#set(project, { mode: PreviewAiMode.Live });
      return helper;
    }
    return null;
  }

  /** The running helper of this kind for the game, or a new one; null when it could not start. */
  async #ensure(kind: PracticeKind, project: string, cap: number | null): Promise<Helper | null> {
    const id = `${kind}:${project}`;
    const running = this.#helpers.get(id);
    if (running?.key) return running;
    const pending = this.#starting.get(id);
    if (pending) return pending;
    const start = this.#start(kind, project, cap).finally(() => this.#starting.delete(id));
    this.#starting.set(id, start);
    return start;
  }

  /** Start a helper and wait for its first line. */
  async #start(kind: PracticeKind, project: string, cap: number | null): Promise<Helper | null> {
    if (this.#closing) return null;
    let launch: PracticeLaunch;
    try {
      launch = await this.#deps.launch(
        project,
        kind === PracticeKind.Live && cap !== null ? { maxCredits: cap } : null,
      );
    } catch (error) {
      this.#failed(kind, project, error);
      return null;
    }
    const { root, ...request } = launch;
    const spawned = await this.#deps.spawn({ ...request, loopbackServer: true }).catch((error: unknown) => {
      this.#failed(kind, project, error);
      return null;
    });
    if (!spawned) {
      await rm(root, { recursive: true, force: true }).catch(() => {});
      return null;
    }
    const closed = new Promise<void>((resolve) => spawned.child.once("close", () => resolve()));
    const helper: Helper = {
      kind,
      project,
      child: spawned.child,
      root,
      key: null,
      cap,
      spent: 0,
      settled: false,
      closed,
      stopping: false,
    };
    const id = `${kind}:${project}`;
    this.#helpers.set(id, helper);
    void closed.then(() => this.#ended(id, helper));
    const first = await this.#firstLine(helper, spawned.expose);
    if (first.status === PracticeStatus.Listening) return helper;
    await this.#stopHelper(helper);
    if (first.status === PracticeStatus.Off) this.#laneOff(project);
    else this.#failed(kind, project, first.error);
    return null;
  }

  /** The helper's first line, then every later one kept as it comes. */
  async #firstLine(helper: Helper, expose: LoopbackExpose | undefined): Promise<FirstLine> {
    const timeoutMs = this.#deps.listenTimeoutMs ?? PRACTICE_LISTEN_TIMEOUT_MS;
    let errors = "";
    helper.child.stderr?.on("data", (chunk: Buffer) => {
      errors = `${errors}${chunk.toString("utf8")}`.slice(-ERROR_MAX_CHARS);
    });
    const heard = new Promise<FirstLine>((resolve) => {
      let first = true;
      eachLine(helper.child, (line) => {
        const parsed = first ? firstPracticeLine(line) : null;
        if (parsed) resolve(parsed);
        else if (!first) this.#note(helper, line);
        if (parsed) first = false;
      });
      void helper.closed.then(() =>
        resolve({ status: PracticeStatus.Failed, error: errors.trim() || `exited (${helper.child.exitCode})` }),
      );
    });
    // The wait is cancelled once the line is in, so it holds nothing open behind it.
    const waiting = new AbortController();
    const timer = sleep(timeoutMs, undefined, { signal: waiting.signal }).then(
      (): FirstLine => ({ status: PracticeStatus.Failed, error: `no answer within ${timeoutMs / SECOND_MS} s` }),
      (): FirstLine => ({ status: PracticeStatus.Failed, error: "cancelled" }),
    );
    const first = await Promise.race([heard, timer]);
    waiting.abort();
    if (first.status !== PracticeStatus.Listening) return first;
    const port = Number(PRACTICE_KEY.exec(first.key)?.[1]);
    // Where the sandbox gives the helper a loopback of its own (Linux), its port opens on this computer's.
    const opened = await (expose?.(port, LoopbackProtocol.Tcp) ?? Promise.resolve()).then(
      () => true,
      () => false,
    );
    if (!opened) return { status: PracticeStatus.Failed, error: "its port could not be opened on this computer" };
    helper.key = first.key;
    return first;
  }

  /** A later line of a helper on real models: what it spent, and whether the cap is used up. */
  #note(helper: Helper, text: string): void {
    if (helper.kind !== PracticeKind.Live) return;
    const line = jsonLine(text);
    if (!line) return;
    if (line.event === PracticeEvent.Live) {
      const charged = credits(line.chargedCredits);
      const held = credits(line.heldCredits);
      if (charged === null || held === null) return;
      helper.spent = charged + held;
      const before = this.#spent.get(helper.project) ?? 0;
      this.#set(helper.project, { chargedCredits: before + charged, heldCredits: held });
      return;
    }
    const capSpent = line.event === PracticeEvent.Call && line.via === VIA_LIVE && CAP_SPENT.has(String(line.error));
    if (capSpent) this.#set(helper.project, { mode: PreviewAiMode.CapReached });
  }

  /** A helper could not start or failed: real models fall back to practice with the reason shown. */
  #failed(kind: PracticeKind, project: string, error: unknown): void {
    const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
    const known = Object.values(PreviewAiUnavailable).find((reason) => reason === code);
    const words = typeof error === "string" ? error : errorMessage(error);
    if (kind === PracticeKind.Live) this.#forget(project);
    this.#set(project, {
      mode: kind === PracticeKind.Live ? PreviewAiMode.Unavailable : PreviewAiMode.Practice,
      reason: known ?? PreviewAiUnavailable.HelperFailed,
      error: known ? null : words.slice(0, ERROR_MAX_CHARS),
      capCredits: null,
    });
  }

  /** Genex's model lane is off: practice answers go on, and the bar says why. */
  #laneOff(project: string): void {
    this.#forget(project);
    this.#set(project, { mode: PreviewAiMode.Unavailable, reason: PreviewAiUnavailable.LaneOff, capCredits: null });
  }

  /** The person's approval for a game ends, and what its runs spent with it. */
  #forget(project: string): void {
    this.#approved.delete(project);
    this.#spent.delete(project);
  }

  /** Add an ended real-model run's spend to its game's, once. */
  #settle(helper: Helper): void {
    if (helper.kind !== PracticeKind.Live || helper.settled) return;
    helper.settled = true;
    if (!this.#approved.has(helper.project)) return;
    this.#spent.set(helper.project, (this.#spent.get(helper.project) ?? 0) + helper.spent);
  }

  /** A helper's process ended: forget it; a real-model run that ended on its own falls back to practice. */
  async #ended(id: string, helper: Helper): Promise<void> {
    this.#settle(helper);
    await rm(helper.root, { recursive: true, force: true }).catch(() => {});
    if (this.#helpers.get(id) !== helper) return;
    this.#helpers.delete(id);
    if (helper.stopping || this.#closing || helper.key === null) return;
    this.#failed(
      helper.kind,
      helper.project,
      `the helper stopped (${helper.child.exitCode ?? helper.child.signalCode})`,
    );
    if (helper.kind === PracticeKind.Live) await this.#deps.reloadLive(helper.project).catch(() => {});
  }

  /** Stop the game's helper of this kind, if it runs. */
  async #stop(kind: PracticeKind, project: string): Promise<void> {
    const id = `${kind}:${project}`;
    await this.#starting.get(id)?.catch(() => null);
    const helper = this.#helpers.get(id);
    if (helper) await this.#stopHelper(helper);
  }

  /** Ask a helper to stop (its totals print on the way out), then end its process tree. */
  async #stopHelper(helper: Helper): Promise<void> {
    helper.stopping = true;
    const id = `${helper.kind}:${helper.project}`;
    if (this.#helpers.get(id) === helper) this.#helpers.delete(id);
    signalTree(helper.child, "SIGTERM");
    const grace = this.#deps.stopGraceMs ?? PRACTICE_STOP_GRACE_MS;
    const waiting = new AbortController();
    const ended = await Promise.race([
      helper.closed.then(() => true),
      sleep(grace, undefined, { signal: waiting.signal }).then(
        () => false,
        () => true,
      ),
    ]);
    waiting.abort();
    if (!ended) await treeKiller(helper.child)();
    await helper.closed;
    this.#settle(helper);
    await rm(helper.root, { recursive: true, force: true }).catch(() => {});
  }

  /** The process ids of the helpers running now, for checks that none is left behind. */
  runningPids(): number[] {
    return [...this.#helpers.values()].flatMap((helper) => (helper.child.pid ? [helper.child.pid] : []));
  }

  /** Stop every helper (the app quits). */
  async stopAll(): Promise<void> {
    this.#closing = true;
    await Promise.all([...this.#starting.values()].map((start) => start.catch(() => null)));
    await Promise.all([...this.#helpers.values()].map((helper) => this.#stopHelper(helper)));
  }
}

/** Call `each` with every non-empty line the child prints, as it comes. */
function eachLine(child: ChildProcess, each: (line: string) => void): void {
  let pending = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const text of lines) if (text.trim()) each(text.trim());
  });
}

/** Send `signal` to a child's process group, or to the child alone when it leads none. */
function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}
