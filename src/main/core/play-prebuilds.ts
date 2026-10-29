/**
 * Play's builds, made before the person presses Play (lane PW). When a run's build integrates
 * healthy, the commit's Play copy (`PreviewService.playCopy`, the folder Play latest plays) is made
 * and built for the browser and for this computer's own desktop, at background priority: the lane
 * runs it only in a slot nobody else waits for, under `nice` (`BuildPriority.Background`). Play then
 * finds the copy and its admitted builds ready. A newer commit of the same game cancels the older
 * one's prebuild; one prebuild runs at a time across games; none starts while the disk holding the
 * builds has less than {@link PREBUILD_FREE_MIN_BYTES} free (the lane's own sweep still runs before
 * each new build folder). When the toolchain lock changes (an install, a dev seed), the last
 * prebuilt commit of each game is built again on it. Never throws: a prebuild that fails is a log
 * line, and Play builds as it always did.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import type { BuildTarget } from "../../shared/game-project.ts";

/** A gibibyte. */
const GIB = 1024 ** 3;

/** The least free space on the builds' disk a prebuild starts with. */
export const PREBUILD_FREE_MIN_BYTES = 10 * GIB;

/** What a prebuild reaches: the copy, the build, the targets a game plays in and the disk. */
export interface PlayPrebuildDeps {
  /** The commit's Play copy (made or found), or null when the game cannot have one now. */
  copy(project: string, commit: string): Promise<string | null>;
  /** The background build of `dir` for `target`; resolves when it ends, whatever came of it. */
  build(project: string, dir: string, target: BuildTarget, signal: AbortSignal): Promise<void>;
  /** The destinations Play builds for this game here: the browser's and this computer's own, in that order; none for a game Play builds nothing for. */
  targets(project: string): Promise<BuildTarget[]>;
  /** Free bytes on the disk holding the builds; null when it cannot be read (no prebuild then). */
  freeBytes(): Promise<number | null>;
  /** The prebuild of `commit` started building (`since`, epoch ms) or ended (null): what Live's line says. */
  announce?(project: string, commit: string, since: number | null): void;
  log?(line: string): void;
}

/** One game's prebuild: the commit, and the abort that cancels it. */
interface Prebuild {
  commit: string;
  controller: AbortController;
}

/** Play's background builds, one game's newest commit each, one at a time. */
export class PlayPrebuilds {
  readonly #deps: PlayPrebuildDeps;
  readonly #current = new Map<string, Prebuild>();
  /** The last commit asked for per game, for a lock change to build again. */
  readonly #last = new Map<string, string>();
  #chain: Promise<void> = Promise.resolve();

  constructor(deps: PlayPrebuildDeps) {
    this.#deps = deps;
  }

  /** Prebuilds `commit` of `project`, cancelling an older commit's prebuild of the same game. Answers when it ended. */
  queue(project: string, commit: string): Promise<void> {
    const running = this.#current.get(project);
    if (running?.commit === commit && !running.controller.signal.aborted) return this.#chain;
    running?.controller.abort();
    const prebuild = { commit, controller: new AbortController() };
    this.#current.set(project, prebuild);
    this.#last.set(project, commit);
    const done = this.#chain.then(() => this.#run(project, prebuild));
    this.#chain = done;
    return done;
  }

  /** The toolchain lock changed: each game's last prebuilt commit is built again (its lock may have moved). */
  lockChanged(): Promise<void> {
    for (const [project, commit] of this.#last) {
      this.#current.get(project)?.controller.abort();
      this.#current.delete(project);
      void this.queue(project, commit);
    }
    return this.#chain;
  }

  /** Cancels every prebuild (the app's stop). */
  cancelAll(): void {
    for (const prebuild of this.#current.values()) prebuild.controller.abort();
    this.#current.clear();
  }

  /** Each target's build of the copy, in order, said to Live's line while it runs. */
  async #build(project: string, prebuild: Prebuild, dir: string, targets: readonly BuildTarget[]): Promise<void> {
    const { signal } = prebuild.controller;
    this.#deps.announce?.(project, prebuild.commit, Date.now());
    try {
      for (const target of targets) {
        if (signal.aborted) return;
        await this.#deps.build(project, dir, target, signal);
      }
    } finally {
      this.#deps.announce?.(project, prebuild.commit, null);
    }
  }

  async #run(project: string, prebuild: Prebuild): Promise<void> {
    const { signal } = prebuild.controller;
    try {
      if (signal.aborted) return;
      const free = await this.#deps.freeBytes().catch(() => null);
      if (free === null || free < PREBUILD_FREE_MIN_BYTES) return this.#deps.log?.(MESSAGE.noRoom(project, free));
      const targets = await this.#deps.targets(project);
      if (!targets.length || signal.aborted) return;
      const dir = await this.#deps.copy(project, prebuild.commit);
      if (!dir) return;
      await this.#build(project, prebuild, dir, targets);
    } catch (error) {
      this.#deps.log?.(MESSAGE.failed(project, error));
    } finally {
      if (this.#current.get(project) === prebuild) this.#current.delete(project);
    }
  }
}

const MESSAGE = {
  noRoom: (project: string, free: number | null) =>
    `[play] no prebuild of ${project}: ${free === null ? "the builds' disk cannot be read" : `${Math.round(free / GIB)} GB free`}`,
  failed: (project: string, error: unknown) => `[play] prebuild of ${project} failed: ${String(error)}`,
} as const;

/** A commit a run's integration names: hex, as git abbreviates or spells it whole. */
const COMMIT_NAME = /^[0-9a-f]{7,64}$/;

/**
 * The builds `events` say integrated healthy (`integration_health` with `ok`), newest last: what
 * Play latest will play, so what a prebuild makes ready. The project is the event's own, else null
 * (the thread's game, which the caller knows).
 */
export function healthyBuilds(events: readonly EventEnvelope[]): Array<{ head: string; project: string | null }> {
  const builds: Array<{ head: string; project: string | null }> = [];
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.event_type !== CustomEvent.IntegrationHealth || custom.payload.ok !== true) continue;
    const { head, project } = custom.payload;
    if (typeof head !== "string" || !COMMIT_NAME.test(head)) continue;
    builds.push({ head, project: typeof project === "string" ? project : null });
  }
  return builds;
}
