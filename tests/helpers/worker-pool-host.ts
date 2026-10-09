/**
 * A fake host for Genex's worker pool (`loop/workers/`): real git in a temporary game repository
 * and the copies made of it, worker sessions the test ends, the chat's log of questions, the
 * pool's persisted artifacts and every record the pool appends to the chat. Shared by
 * `worker-pool.test.ts` and `worker-events.test.ts`.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import type { FactRef } from "../../src/harness-seed/loop/folder-facts.ts";
import { openPool, type WorkerPool } from "../../src/harness-seed/loop/workers/pool.ts";
import type { PoolClock } from "../../src/harness-seed/loop/workers/records.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";
import { WorkerTool, type WorkerType } from "../../src/shared/workers.ts";
import { type CtxRecorder, ctxRecorder } from "./ctx-recorder.ts";
import { gitFile } from "./git.ts";
import { tmpDir } from "./tmp.ts";

const run = promisify(execFile);
export const PROJECT = "garden";
export const THREAD = "thread-1";
export const TURN = "msg-1";
export const CLAUDE = "claude-code";
/** How many turns of the event loop a test lets the pool take before it reads what happened. */
const SETTLE_TICKS = 50;
/** How much faster than real time the pool's clock runs in these tests. */
const CLOCK_SPEEDUP = 100;
/** A web game's facts, as a pool's identity carries them. */
const WEB_FACTS: readonly FactRef[] = [{ id: "web-game", path: "." }];

/** What a delegation answers once the test lets it end. */
export type Result = { ok: boolean; sessionId?: string; summary?: string; stopReason?: string; errorText?: string };
/** One worker session the fake host is running. */
type Session = { params: Record<string, unknown>; end: (result: Result) => void };
/** One custom record the pool appended to the chat: its type and payload. */
export type Appended = { type: string; payload: Record<string, unknown> };

/** Let the pool's background work run its next steps. */
export async function settle(): Promise<void> {
  for (let tick = 0; tick < SETTLE_TICKS; tick++) await new Promise((resolve) => setImmediate(resolve));
}

/** A clock a hundred times faster than real time: a minute's wait passes in well under a second. */
export function fastClock(): PoolClock {
  let now = 1_000_000;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
      await sleep(ms / CLOCK_SPEEDUP);
    },
  };
}

/** A repository with one commit, as a game folder is. */
export async function gameRepo(): Promise<string> {
  const dir = await realpath(await tmpDir("worker-pool-game-"));
  await gitFile(["init", "-q", "-b", "main"], { cwd: dir });
  await writeFile(path.join(dir, "a.txt"), "base\n");
  await writeFile(path.join(dir, "b.txt"), "base\n");
  await gitFile(["add", "-A"], { cwd: dir });
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "first"], { cwd: dir });
  return dir;
}

/** A shell command in a folder, answered the way `run.exec` answers. */
export async function shell(command: string, cwd: string) {
  try {
    const { stdout, stderr } = await run("/bin/sh", ["-c", command], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const failed = err as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

/** The custom records of one `events.append` batch. */
function appendedOf(params: Record<string, unknown>): Appended[] {
  const batch = Array.isArray(params.batch) ? (params.batch as Array<Record<string, unknown>>) : [];
  return batch.map((item) => ({
    type: String(item.event_type ?? ""),
    payload: (item.payload ?? {}) as Record<string, unknown>,
  }));
}

/**
 * The host's one writer in place per game, shared by every pool of it (`locks.hold`/`locks.release`):
 * a writer is known by the run or chat that started it and its id, and is answered the labels of
 * the plugin locks the game's plugins need (`labels`).
 */
export function fakeLocks(labels: readonly string[] = []) {
  const held = new Map<string, { key: string; title: string }>();
  const keyOf = (p: Record<string, unknown>) =>
    `${String(p.runId ?? p.threadId)}:${String((p.holder as { id?: unknown })?.id)}`;
  const releases: string[] = [];
  return {
    held,
    releases,
    handlers: {
      [HostMethod.LocksHold]: (p: Record<string, unknown>) => {
        const project = String(p.project);
        const writer = held.get(project);
        if (writer && writer.key !== keyOf(p)) return { busy: `"${writer.title}" is working in the game folder now.` };
        held.set(project, { key: keyOf(p), title: String((p.holder as { title?: unknown })?.title) });
        return { held: true, labels: [...labels] };
      },
      [HostMethod.LocksRelease]: (p: Record<string, unknown>) => {
        releases.push(keyOf(p));
        const project = String(p.project);
        if (held.get(project)?.key === keyOf(p)) held.delete(project);
        return true;
      },
    },
  };
}

/** A host's in-place table, as `fakeLocks` makes one. */
export type FakeLocks = ReturnType<typeof fakeLocks>;

/** The fake host: real git in the repository and its copies, sessions the test ends, and the chat's log. */
export function poolHost(
  repo: string,
  options: {
    types?: WorkerType[];
    log?: unknown[];
    copyRefused?: Error;
    /** The host refuses every worker's session with this (as a full chat's Settings ceiling does). */
    delegateRefused?: Error;
    /** How the host answers a Stop: ending the worker's sessions (the default), or as the test says. */
    abort?: (params: Record<string, unknown>, end: () => void) => { aborted: number };
    /** How the host answers a record the pool appends: kept (the default), or as the test says. */
    append?: (params: Record<string, unknown>) => unknown;
    /** The host's writer in place (shared between hosts of one game), or `false` for a host without one. */
    locks?: FakeLocks | false;
  } = {},
) {
  const locks = options.locks === false ? null : (options.locks ?? fakeLocks());
  const sessions: Session[] = [];
  const artifacts = new Map<string, unknown>();
  const appended: Appended[] = [];
  const log = options.log ?? [];
  const recorder: CtxRecorder = ctxRecorder({
    threadId: THREAD,
    handlers: {
      [HostMethod.ArtifactRead]: (p) => artifacts.get(String(p.artifactId)) ?? null,
      [HostMethod.ArtifactWrite]: (p) => {
        artifacts.set(String(p.artifactId), structuredClone(p.value));
        return 1;
      },
      [HostMethod.EventsAppend]: (p) => {
        if (options.append) return options.append(p);
        appended.push(...appendedOf(p));
        return `e${appended.length}`;
      },
      [HostMethod.PluginsWorkerTypes]: () => options.types ?? [],
      [HostMethod.EventsHead]: () => null,
      [HostMethod.EventsList]: (p) => {
        const index = log.findIndex((event) => (event as { id: string }).id === p.after);
        return log.slice(index + 1);
      },
      [HostMethod.RunExec]: (p) => shell(String(p.command), typeof p.cwd === "string" ? p.cwd : repo),
      [HostMethod.SnapshotCreate]: async () => ({
        snapshot_id: "snap-1",
        git: { game: (await shell("git rev-parse HEAD", repo)).stdout.trim() },
      }),
      [HostMethod.SnapshotWorktree]: async (p) => {
        if (options.copyRefused) throw options.copyRefused;
        const dir = path.join(path.dirname(repo), `${path.basename(repo)}-${String(p.name)}`);
        const commit = String(p.commit ?? "HEAD");
        await gitFile(["worktree", "add", "-q", "--detach", dir, commit], { cwd: repo });
        return { path: dir, commit: (await shell("git rev-parse HEAD", dir)).stdout.trim() };
      },
      [HostMethod.SnapshotRemoveWorktree]: async (p) => {
        await gitFile(["worktree", "remove", "--force", String(p.path)], { cwd: repo });
        return true;
      },
      [HostMethod.EngineDelegate]: (p) =>
        new Promise((resolve, reject) => {
          if (options.delegateRefused) return reject(options.delegateRefused);
          sessions.push({ params: p, end: (result) => resolve({ engine: CLAUDE, turns: 1, usage: {}, ...result }) });
        }),
      [HostMethod.EngineInterrupt]: (p) => {
        const live = sessions.findLast((s) => (s.params.worker as { id: string }).id === p.worker);
        live?.end({ ok: false, stopReason: "stopped", sessionId: `s-${String(p.worker)}` });
        return { interrupted: Boolean(live) };
      },
      [HostMethod.EngineAbort]: (p) => {
        const end = () => {
          for (const s of sessions.filter((s) => (s.params.worker as { id: string }).id === p.worker))
            s.end({ ok: false, stopReason: "stopped" });
        };
        if (options.abort) return options.abort(p, end);
        end();
        return { aborted: 1 };
      },
      ...(locks ? locks.handlers : {}),
    },
  });
  /** The latest session of a worker. */
  const sessionOf = (id: string): Session => {
    const found = sessions.findLast((s) => (s.params.worker as { id: string }).id === id);
    assert.ok(found, `${id} has a session`);
    return found;
  };
  return { recorder, sessions, artifacts, appended, log, sessionOf, locks };
}

/** The fake host of one test. */
export type Host = ReturnType<typeof poolHost>;

/** What a test's pool belongs to and works on, beyond the fake host's game. */
export type PoolOptions = {
  turn?: string;
  runId?: string;
  ask?: string;
  facts?: readonly FactRef[];
  /** The moments the game's plugins hook, as its descriptor lists them (absent: none, as a web game's). */
  hookEvents?: readonly string[];
};

/** A pool for the chat turn (or, with `runId`, a run), on the fake host. */
export function chatPool(host: Host, repo: string, turnOrOptions: string | PoolOptions = TURN): Promise<WorkerPool> {
  const options = typeof turnOrOptions === "string" ? { turn: turnOrOptions } : turnOrOptions;
  const belongs = options.runId ? { runId: options.runId } : { turn: options.turn ?? TURN };
  return openPool({
    ctx: host.recorder.ctx as never,
    project: PROJECT,
    threadId: THREAD,
    ...belongs,
    ...(options.ask === undefined ? {} : { ask: options.ask }),
    engine: CLAUDE,
    gameDir: repo,
    ...(options.hookEvents ? { game: { hookEvents: options.hookEvents } } : {}),
    leadFolder: { project: PROJECT },
    identity: { folderLabel: "AI Games/garden", facts: options.facts ?? WEB_FACTS },
    clock: fastClock(),
  });
}

/** Start a worker and answer its id. */
export async function start(pool: WorkerPool, args: Record<string, unknown>): Promise<string> {
  const answer = await pool.call(WorkerTool.Start, args);
  const id = /Started (w\d+)/.exec(answer)?.[1];
  assert.ok(id, answer);
  await settle();
  return id;
}

/** End a worker's session and wait until the pool has settled it (a copy's work committed). */
export async function finish(host: Host, pool: WorkerPool, id: string, result: Result = { ok: true }): Promise<void> {
  host.sessionOf(id).end(result);
  await pool.state.runs.get(id);
}

/** A worker's delegation: what the pool asked the host for. */
export const delegation = (host: Host, id: string) => host.sessionOf(id).params;
/** The worker grant a worker's delegation carried. */
export const grantOf = (host: Host, id: string) => delegation(host, id).worker as Record<string, unknown>;

/** Commit the lead's own change in the game folder. */
export async function leadCommits(repo: string, file: string, text: string): Promise<void> {
  await writeFile(path.join(repo, file), text);
  await gitFile(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", "lead"], { cwd: repo });
}
