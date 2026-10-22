/**
 * Native games being played: each in its own window, in the game sandbox (`spawnNativeGame`), at
 * most one per game. Genex owns the process: the game page brings its window forward or quits it,
 * quitting Genex ends every game, and a record per game on disk lets the next start end one an
 * earlier Genex left running (only while its process is still that one). A game that quits before
 * its window appears failed to start; its last output goes to the log, never on screen. A game opens
 * full screen with its engine's own argument, unless its app asks for a window.
 * Electron-free: the spawn, the window checks, the signals and the clock are deps.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { isPlaySlug } from "../../shared/play.ts";
import { LaunchFailure, NativeEngine, type NativeSession, NativeSessionPhase } from "../../shared/play-native.ts";
import type { JobClock, JobProbe } from "../../substrate/job-process.ts";
import { removeOwnedFolder } from "../../substrate/storage-folders.ts";
import type { GameGenexEnv, NativeGameRequest } from "../../substrate/plugins/native-process.ts";
import type { InstallRecord } from "./native-installs.ts";
import { SAVES } from "./native-installs.ts";

/** How long a quit waits for a game to end before its whole tree is killed. */
export const GAME_QUIT_GRACE_MS = 3 * SECOND_MS;
/** How often a starting game is looked for on screen, and how long before it counts as running anyway. */
const WINDOW_POLL_MS = SECOND_MS / 4;
const WINDOW_WAIT_MS = MINUTE_MS;
/** The most of a game's output kept, for the log when it fails. */
const OUTPUT_TAIL_BYTES = 16 * 1024;
/** Where the session records and each game's temporary folder are, beside the installed games. */
const SESSIONS = ".sessions";
const SCRATCH = ".scratch-";

const MESSAGE = { BadSlug: "not a game address" } as const;

/** Each engine's own command-line argument for opening its game full screen. */
const FULLSCREEN_ARGS: ReadonlyMap<string, readonly string[]> = new Map(
  Object.entries({
    [NativeEngine.Unity]: ["-screen-fullscreen", "1"],
    [NativeEngine.Godot]: ["--fullscreen"],
    [NativeEngine.Unreal]: ["-fullscreen"],
  } satisfies Record<NativeEngine, readonly string[]>),
);

/** What a game is started with: full screen in its engine's own way, or nothing for a window or an unknown engine. */
export const launchArgs = (record: Pick<InstallRecord, "engine" | "windowed">): string[] =>
  record.windowed || !record.engine ? [] : [...(FULLSCREEN_ARGS.get(record.engine) ?? [])];

/** A started game process: what the launcher reads of it. */
export interface GameProcess {
  pid?: number | undefined;
  stdout: Readable;
  stderr: Readable;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * A game's way to Genex while it plays: its gateway's ports (its sandbox's only network), what the
 * game is told (Genex's address, a sign-in ticket), and the gateway's end once the game ends.
 */
export interface GameGenex {
  ports: readonly number[];
  env: GameGenexEnv;
  close(): Promise<void>;
}

/** What the launcher works with. */
export interface NativeSessionsDeps {
  /** The installed-games folder (`StudioLayout.installedGames`). */
  root: string;
  /** An installed game's record, or null. */
  record(slug: string): Promise<InstallRecord | null>;
  /** Start a game in its sandbox (`spawnNativeGame`). */
  spawn(request: NativeGameRequest): Promise<GameProcess>;
  /** Whether the process has a window on screen, and bring it forward (`native-windows.ts`). */
  hasWindow(pid: number): Promise<boolean>;
  show(pid: number): Promise<void>;
  /** Signal a process, or with a negative id its group (`process.kill`). */
  kill(pid: number, signal: NodeJS.Signals): void;
  /** Kill a process and everything it started, listed first while each still has its parent. */
  killTree(pid: number): Promise<void>;
  /** When a process started, to tell a reused id apart. */
  probe: JobProbe;
  clock: JobClock;
  /** Every change, for the window. */
  publish(sessions: NativeSession[]): void;
  /** A game's window appeared: it counts as played now. */
  played(slug: string): Promise<void>;
  /** A game ended: its older versions may go now. */
  ended(slug: string): Promise<void>;
  log(line: string): void;
  /** Opens a game's way to Genex (`main/play/genex-gateway.ts`); without it a game has no network. */
  genex?(slug: string): Promise<GameGenex | null>;
  /**
   * Where a game's presence and plays go: started once it counts as running (its window on screen,
   * or a minute up without one), which reports the play to genex.games (`native-plays.ts`), and
   * ended once a running game ends (nothing yet: genex.games takes no presence from the app).
   */
  presence?: { started(slug: string): void; ended(slug: string): void };
}

/** One game being played. */
interface Live {
  session: NativeSession;
  pid: number;
  scratch: string;
  genex: GameGenex | null;
  exited: Promise<void>;
  quitting: Promise<void> | null;
}

/** A session record on disk. */
interface SessionRecord {
  slug: string;
  pid: number;
  procStart: string | null;
}

/** A session record as written, or null when it names no process and start time. */
function readRecord(text: string): { pid: number; procStart: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { pid, procStart } = value as Record<string, unknown>;
    const named = typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
    return named && typeof procStart === "string" && procStart ? { pid, procStart } : null;
  } catch {
    return null;
  }
}

/** The last `max` bytes a stream sent. */
function tail(stream: Readable, max: number): () => string {
  let kept = Buffer.alloc(0);
  stream.on("data", (chunk: Buffer) => {
    kept = Buffer.concat([kept, chunk]).subarray(-max);
  });
  return () => kept.toString("utf8");
}

/** The launcher over `deps`: one live session per game, each watched until it ends. */
export class NativeSessions {
  readonly #deps: NativeSessionsDeps;
  readonly #live = new Map<string, Live>();
  readonly #failed = new Map<string, NativeSession>();
  readonly #records: string;

  constructor(deps: NativeSessionsDeps) {
    this.#deps = deps;
    this.#records = path.join(deps.root, SESSIONS);
  }

  /** Every game being played, and every one that failed to start since. */
  sessions(): NativeSession[] {
    return [...[...this.#live.values()].map((one) => one.session), ...this.#failed.values()];
  }

  #push(): void {
    this.#deps.publish(this.sessions());
  }

  async #writeRecord(record: SessionRecord): Promise<void> {
    await mkdir(this.#records, { recursive: true });
    await writeFile(path.join(this.#records, `${record.slug}.json`), JSON.stringify(record));
  }

  #dropRecord(slug: string): Promise<void> {
    return rm(path.join(this.#records, `${slug}.json`), { force: true });
  }

  /** Whether `one` is still the live session of `slug`, not ended. */
  #current(slug: string, one: Live): boolean {
    return this.#live.get(slug) === one;
  }

  /**
   * Look for the game's window until it appears, it exits, it is being quit, or long enough has
   * passed. A game quit while it starts is never brought forward, played or counted.
   */
  async #awaitWindow(slug: string, one: Live): Promise<void> {
    const started = this.#deps.clock.now();
    const waiting = (): boolean => this.#current(slug, one) && !one.quitting;
    while (waiting()) {
      const seen = await this.#deps.hasWindow(one.pid);
      if (seen || this.#deps.clock.now() - started >= WINDOW_WAIT_MS) break;
      await new Promise<void>((resolve) => this.#deps.clock.setTimeout(resolve, WINDOW_POLL_MS));
    }
    if (!waiting()) return;
    one.session = { ...one.session, phase: NativeSessionPhase.Running };
    this.#push();
    // Before the awaits: a game that ends while it is brought forward reports its end after its start.
    this.#deps.presence?.started(slug);
    await this.#deps.show(one.pid);
    await this.#deps.played(slug).catch(() => undefined);
  }

  /** What happens once a game's process ends: running, it was played; starting, it failed. */
  async #onExit(slug: string, one: Live, output: () => string, code: number | null): Promise<void> {
    this.#live.delete(slug);
    await one.genex?.close().catch(() => undefined);
    await this.#dropRecord(slug);
    await rm(one.scratch, { recursive: true, force: true });
    if (one.session.phase === NativeSessionPhase.Running) this.#deps.presence?.ended(slug);
    if (one.session.phase === NativeSessionPhase.Starting && !one.quitting) {
      this.#failed.set(slug, { ...one.session, phase: NativeSessionPhase.Failed, failure: LaunchFailure.QuitEarly });
      const last = output().trim().split("\n").at(-1) ?? "";
      this.#deps.log(`native game ${slug} quit before its window (code ${code}): ${last}`);
    }
    this.#push();
    await this.#deps.ended(slug).catch(() => undefined);
  }

  /** The game's way to Genex, or none: one that can't open leaves the game offline, never unplayable. */
  async #openGenex(slug: string): Promise<GameGenex | null> {
    try {
      return (await this.#deps.genex?.(slug)) ?? null;
    } catch (error) {
      this.#deps.log(`native game ${slug} plays offline: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /**
   * Start the game in its sandbox with a fresh temporary folder and its way to Genex, both given
   * back if it does not start.
   */
  async #spawn(
    slug: string,
    record: InstallRecord,
  ): Promise<{ child: GameProcess; scratch: string; genex: GameGenex | null }> {
    const app = path.join(this.#deps.root, slug, record.version, record.entry);
    const saves = path.join(this.#deps.root, slug, SAVES);
    await mkdir(saves, { recursive: true });
    const scratch = await mkdtemp(path.join(this.#deps.root, `${SCRATCH}${slug}-`));
    const { bundleId, bundleName } = record;
    const binary = path.join(app, record.executable);
    const genex = await this.#openGenex(slug);
    const request: NativeGameRequest = {
      binary,
      app,
      saves,
      scratch,
      bundleId,
      bundleName,
      args: launchArgs(record),
      ...(genex ? { genex: { ports: genex.ports, env: genex.env } } : {}),
    };
    try {
      const child = await this.#deps.spawn(request);
      if (!child.pid) throw new Error("the game did not start");
      return { child, scratch, genex };
    } catch (error) {
      await genex?.close().catch(() => undefined);
      await rm(scratch, { recursive: true, force: true });
      throw error;
    }
  }

  /** Start `record`'s game and watch it until it ends. */
  async #start(slug: string, record: InstallRecord): Promise<void> {
    const { child, scratch, genex } = await this.#spawn(slug, record);
    const pid = child.pid ?? 0;
    const output = tail(child.stderr, OUTPUT_TAIL_BYTES);
    child.stdout.resume();
    const ended = new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.once("error", () => resolve(null));
    });
    const startedAt = new Date(this.#deps.clock.now()).toISOString();
    const session: NativeSession = { slug, phase: NativeSessionPhase.Starting, startedAt, failure: null };
    const one: Live = { session, pid, scratch, genex, quitting: null, exited: Promise.resolve() };
    one.exited = ended.then((code) => this.#onExit(slug, one, output, code));
    this.#live.set(slug, one);
    this.#failed.delete(slug);
    this.#push();
    await this.#writeRecord({ slug, pid, procStart: await this.#deps.probe.startTime(pid).catch(() => null) });
    void this.#awaitWindow(slug, one);
  }

  #fail(slug: string, failure: LaunchFailure): void {
    const startedAt = new Date(this.#deps.clock.now()).toISOString();
    this.#failed.set(slug, { slug, phase: NativeSessionPhase.Failed, startedAt, failure });
    this.#push();
  }

  /**
   * Play `slug` in its own window. A game already running is brought forward instead: one copy of
   * a game at a time. Answers once it has started.
   */
  async launch(slug: string): Promise<void> {
    if (!isPlaySlug(slug)) throw new Error(MESSAGE.BadSlug);
    const running = this.#live.get(slug);
    if (running) return this.#deps.show(running.pid);
    const record = await this.#deps.record(slug);
    if (!record) return this.#fail(slug, LaunchFailure.NotInstalled);
    try {
      await this.#start(slug, record);
    } catch (error) {
      this.#deps.log(`native game ${slug} did not start: ${error instanceof Error ? error.message : String(error)}`);
      this.#fail(slug, LaunchFailure.StartFailed);
    }
  }

  /** Bring `slug`'s window forward. */
  async show(slug: string): Promise<void> {
    const running = this.#live.get(slug);
    if (running) await this.#deps.show(running.pid);
  }

  /** Ask `one` to quit, then, after a grace period, kill it with everything it started. */
  async #end(one: Live): Promise<void> {
    try {
      this.#deps.kill(-one.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    let grace: unknown;
    const over = new Promise<boolean>((resolve) => {
      grace = this.#deps.clock.setTimeout(() => resolve(true), GAME_QUIT_GRACE_MS);
    });
    const late = await Promise.race([one.exited.then(() => false), over]);
    this.#deps.clock.clearTimeout(grace);
    if (late) await this.#deps.killTree(one.pid);
    await one.exited;
  }

  /** End `slug` (or forget how it failed to start). */
  quit(slug: string): Promise<void> {
    const running = this.#live.get(slug);
    if (running) {
      running.quitting ??= this.#end(running);
      return running.quitting;
    }
    if (this.#failed.delete(slug)) this.#push();
    return Promise.resolve();
  }

  /** End every game: what quitting Genex does. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#live.keys()].map((slug) => this.quit(slug)));
  }

  /**
   * At start: end a game an earlier Genex left running (only while its process is still the one it
   * started), and drop its record and its temporary folder.
   */
  async reconcile(): Promise<void> {
    for (const name of await readdir(this.#records).catch(() => [] as string[])) {
      const slug = name.replace(/\.json$/, "");
      if (!isPlaySlug(slug) || this.#live.has(slug)) continue;
      const record = readRecord(await readFile(path.join(this.#records, name), "utf8").catch(() => ""));
      const now = record ? await this.#deps.probe.startTime(record.pid).catch(() => null) : null;
      if (record && now === record.procStart) await this.#deps.killTree(record.pid);
      await this.#dropRecord(slug);
    }
    for (const name of await readdir(this.#deps.root).catch(() => [] as string[]))
      if (name.startsWith(SCRATCH)) await removeOwnedFolder(this.#deps.root, [], name);
  }

  /** Whether `slug` is being played: its installed version stays until it ends. */
  playing(slug: string): boolean {
    return this.#live.has(slug);
  }
}

/** The launcher over `deps`. */
export const nativeSessions = (deps: NativeSessionsDeps): NativeSessions => new NativeSessions(deps);
