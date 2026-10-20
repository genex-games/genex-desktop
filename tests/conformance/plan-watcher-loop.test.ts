/**
 * The plan watcher's loop (`main/game-ai/player-loop.ts`): poll → claim → run → submit, or release
 * and say why. Ported from genex-demo's `apps/cli/test/player-loop.test.ts` and
 * `player-loop-throttle.test.ts`, driven in-process against a fake genex.games and a fake runner,
 * one pass at a time on a held clock.
 *
 * The properties a watcher on somebody's Mac keeps:
 *  1. It claims before it runs and submits under the same watcher id, so two machines on one
 *     account never answer the same prompt twice; a lease somebody else holds is theirs.
 *  2. A plan limit is released as a wait with a time, kept here too, never a paid fallback.
 *  3. A claim that keeps failing backs off; contention is not work but is no failure either.
 *  4. Stopping hands the row straight back.
 *  5. Builds come first: while one runs, nothing is claimed; above the keep-for-building line the
 *     row is released with the plan's real reset.
 *  6. Codex is advertised only when its read-deny check passed.
 *  7. The log carries ids and timings, never the prompt, never the answer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  type HeartbeatResult,
  PlayerApiError,
  PlayerAuthError,
  type PlayerClient,
  type PendingGeneration,
  type PlayerPolicy,
  PlayerRelease,
  PlayerUpdateRequiredError,
  type RunnerJob,
} from "../../src/main/game-ai/player-api.ts";
import type { RunnerInstall, RunnerOutcome } from "../../src/main/game-ai/player-runner.ts";
import {
  SHUTDOWN_RETRY_SECONDS,
  WatcherStop,
  backoffMs,
  createWatcherSession,
  planCeiling,
  workable,
  type WatcherSessionDeps,
} from "../../src/main/game-ai/player-loop.ts";
import { AiWatcherRunner } from "../../src/shared/game-ai-watcher.ts";
import type { ProviderUsage } from "../../src/shared/provider-usage.ts";

const PROMPT = "Name one creature for a fantasy game.";
const ANSWER = "Brightwing";
const START = Date.UTC(2026, 9, 20, 12, 0, 0);

const POLICY: PlayerPolicy = {
  version: "policy-loop",
  minVersion: "0.1.0",
  latestVersion: "0.1.0",
  pollIntervalSeconds: 1,
  backoff: { initialSeconds: 1, maxSeconds: 4, factor: 2, jitterRatio: 0 },
  claude: { args: ["-p"], modelFlag: "--model" },
  codex: { args: ["exec"], modelFlag: "--model" },
};

const JOB: RunnerJob = {
  system: "LONG. Reply with the finished text only.",
  user: PROMPT,
  outputFormat: "text",
  model: { id: "anthropic/claude-sonnet-4.5", family: "claude", cliModel: "sonnet" },
  maxOutputTokens: 256,
  mode: "long_usage",
  grantId: "grant_1",
  leaseSeconds: 120,
};

const CLAUDE: RunnerInstall = { runner: AiWatcherRunner.Claude, binary: "/opt/claude", readRoots: [], homes: [] };
const CODEX: RunnerInstall = { runner: AiWatcherRunner.Codex, binary: "/opt/codex", readRoots: [], homes: [] };

function row(over: Partial<PendingGeneration> = {}): PendingGeneration {
  return {
    id: "gen_1",
    gameName: "Creature game",
    expiresAt: new Date(START + 30 * 60_000).toISOString(),
    attempts: 0,
    claimedBy: null,
    leaseExpiresAt: null,
    runner: JOB,
    ...over,
  };
}

interface Calls {
  policy: number;
  heartbeat: Array<{ runners: string[]; watcherId?: string }>;
  pending: string[];
  claim: Array<{ id: string; watcherId: string }>;
  release: Array<{ id: string; reason: string; retryAfterSeconds?: number; watcherId: string }>;
  submit: Array<{ id: string; watcherId: string; output: unknown }>;
}

/** A fake genex.games: one pending row on the claude lane until it is answered or handed back. */
function fakeClient(over: Partial<PlayerClient> = {}, rows: () => PendingGeneration[] = () => [row()]) {
  const calls: Calls = { policy: 0, heartbeat: [], pending: [], claim: [], release: [], submit: [] };
  const client: PlayerClient = {
    version: "0.1.10",
    policy: async () => {
      calls.policy += 1;
      return POLICY;
    },
    heartbeat: async (input) => {
      calls.heartbeat.push({ runners: input.runners, ...(input.watcherId ? { watcherId: input.watcherId } : {}) });
      const beat: HeartbeatResult = {
        watcherId: "watcher_1",
        minVersion: "0.1.0",
        latestVersion: "0.1.0",
        policyVersion: POLICY.version,
        pollIntervalSeconds: 1,
      };
      return beat;
    },
    pending: async (provider) => {
      calls.pending.push(provider);
      return provider === "claude" ? rows() : [];
    },
    claim: async (id, _provider, watcherId) => {
      calls.claim.push({ id, watcherId });
      return row({ id, claimedBy: watcherId });
    },
    release: async (id, _provider, input) => {
      calls.release.push({ id, ...input });
      return { id, status: "awaiting_external", attempts: calls.release.length };
    },
    submit: async (id, _provider, watcherId, output) => {
      calls.submit.push({ id, watcherId, output });
      return { id, status: "succeeded" };
    },
    ...over,
  };
  return { client, calls };
}

/** A session on a held clock: `advance(ms)` moves it. */
function session(over: Partial<WatcherSessionDeps> & { client: PlayerClient }) {
  let now = START;
  const lines: string[] = [];
  const jobs: Array<{ job: RunnerJob; policy: PlayerPolicy; install: RunnerInstall }> = [];
  const renewals: Array<() => void> = [];
  const deps: WatcherSessionDeps = {
    clock: { now: () => now },
    platform: "darwin",
    label: "Studio Mac",
    watcherId: null,
    runners: async () => ({ installs: [CLAUDE], codexHeld: false }),
    runJob: async (job, run) => {
      jobs.push({ job, policy: run.policy, install: run.install });
      return { ok: true, output: ANSWER, durationMs: 12 };
    },
    planUsage: async () => null,
    keepForBuildingPercent: async () => 50,
    log: (line) => lines.push(line),
    repeat: (_ms, fn) => {
      renewals.push(fn);
      return () => {};
    },
    random: () => 0.5,
    ...over,
  };
  const s = createWatcherSession(deps);
  const signal = new AbortController().signal;
  return {
    s,
    lines,
    jobs,
    renewals,
    pass: (claim = true, abort = signal) => s.pass({ claim, signal: abort }),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("one pass of the loop", () => {
  it("claims before it runs, and submits under the same watcher id", async () => {
    const { client, calls } = fakeClient();
    const { pass, jobs, lines, s } = session({ client });
    const result = await pass();
    assert.equal(result.worked, true);
    assert.deepEqual(calls.claim, [{ id: "gen_1", watcherId: "watcher_1" }]);
    assert.deepEqual(calls.submit, [{ id: "gen_1", watcherId: "watcher_1", output: ANSWER }]);
    assert.equal(jobs[0]?.policy, POLICY, "the served policy drives the run");
    assert.equal(jobs[0]?.install, CLAUDE);
    assert.equal(s.snapshot().lastAnsweredAt, new Date(START).toISOString());
    const log = lines.join("\n");
    assert.equal(log.includes(PROMPT), false, "the log never carries a game's prompt");
    assert.equal(log.includes(ANSWER), false, "the log never carries the model's answer");
    assert.match(log, /gen_1 long_usage sonnet running/);
    assert.match(log, /gen_1 delivered in 12ms \(succeeded\)/);
  });

  it("work is serial: one job a pass, whatever the queue holds", async () => {
    const { client, calls } = fakeClient({}, () => [row({ id: "gen_1" }), row({ id: "gen_2" })]);
    const { pass } = session({ client });
    await pass();
    assert.deepEqual(
      calls.claim.map((c) => c.id),
      ["gen_1"],
    );
  });

  it("renews the lease while a long call runs", async () => {
    const { client, calls } = fakeClient();
    const { pass, renewals } = session({ client });
    await pass();
    assert.equal(renewals.length, 1);
    renewals[0]?.();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.claim.length, 2, "a renewal is a claim by the holder");
  });

  it("a plan limit is handed back as a wait with the time the CLI named, and waited out here", async () => {
    const { client, calls } = fakeClient();
    const outcome: RunnerOutcome = {
      ok: false,
      release: PlayerRelease.RateLimited,
      retryAfterSeconds: 900,
      durationMs: 1,
    };
    const { pass, advance, lines } = session({ client, runJob: async () => outcome });
    await pass();
    assert.deepEqual(calls.release, [
      { id: "gen_1", watcherId: "watcher_1", reason: PlayerRelease.RateLimited, retryAfterSeconds: 900 },
    ]);
    assert.equal(calls.submit.length, 0, "a wait is never submitted as an answer");
    for (let i = 0; i < 5; i += 1) {
      advance(60_000);
      await pass();
    }
    assert.equal(calls.claim.length, 1, "the same row is not re-claimed inside the wait it asked for");
    assert.deepEqual(calls.pending, ["claude"], "the provider is skipped before the poll");
    assert.ok(
      lines.some((l) => /claude waits 900s/.test(l)),
      lines.join(" | "),
    );
    advance(900_000);
    await pass();
    assert.equal(calls.claim.length, 2, "after the wait the lane is worked again");
  });

  it("a runner that could not start is runner_unavailable, not a failed request", async () => {
    const { client, calls } = fakeClient();
    const { pass } = session({
      client,
      runJob: async () => ({
        ok: false,
        release: PlayerRelease.RunnerUnavailable,
        detail: "missing:claude",
        durationMs: 1,
      }),
    });
    await pass();
    assert.equal(calls.release[0]?.reason, PlayerRelease.RunnerUnavailable);
  });

  it("a row another machine holds is skipped, never stolen; an expired lease is taken", async () => {
    const live = new Date(START + 90_000).toISOString();
    const dead = new Date(START - 1000).toISOString();
    const held = fakeClient({}, () => [row({ claimedBy: "watcher_elsewhere", leaseExpiresAt: live })]);
    await session({ client: held.client }).pass();
    assert.deepEqual(held.calls.claim, []);
    const abandoned = fakeClient({}, () => [row({ claimedBy: "watcher_asleep", leaseExpiresAt: dead })]);
    await session({ client: abandoned.client }).pass();
    assert.equal(abandoned.calls.claim.length, 1, "a lease nobody holds is not a lease");
  });

  it("a workflow parent carries no runner job and is left to its executor", async () => {
    const { client, calls } = fakeClient({}, () => [row({ runner: null })]);
    await session({ client }).pass();
    assert.deepEqual(calls.claim, []);
  });

  it("a claim that keeps failing backs off instead of spinning", async () => {
    const { client } = fakeClient({
      claim: async () => {
        throw new PlayerApiError(404, "watcher_not_found");
      },
    });
    const { pass } = session({
      client,
      runJob: async () => assert.fail("no job may run: the claim failed"),
    });
    const first = await pass();
    const second = await pass();
    assert.equal(first.worked, false);
    assert.ok(first.sleepMs >= 1000);
    assert.ok(second.sleepMs > first.sleepMs, "the backoff grows");
  });

  it("a claim another machine already holds is not work, and no failure: the poll interval applies", async () => {
    const { client } = fakeClient({
      claim: async () => {
        throw new PlayerApiError(409, "already_claimed");
      },
    });
    const result = await session({ client, runJob: async () => assert.fail("no job may run") }).pass();
    assert.deepEqual({ worked: result.worked, sleepMs: result.sleepMs }, { worked: false, sleepMs: 1000 });
  });

  it("an answer genex.games would not take is handed back as failed", async () => {
    const { client, calls } = fakeClient({
      submit: async () => {
        throw new PlayerApiError(422, "invalid_output");
      },
    });
    await session({ client }).pass();
    assert.equal(calls.release[0]?.reason, PlayerRelease.Failed);
  });

  it("stopping mid-call hands the row straight back with a short retry, and submits nothing", async () => {
    const { client, calls } = fakeClient();
    const stop = new AbortController();
    const { pass } = session({
      client,
      runJob: async (_job, run) => {
        stop.abort();
        assert.equal(run.signal.aborted, true);
        return { ok: false, release: PlayerRelease.RunnerUnavailable, detail: "shutdown", durationMs: 1 };
      },
    });
    await pass(true, stop.signal);
    assert.deepEqual(calls.release, [
      {
        id: "gen_1",
        watcherId: "watcher_1",
        reason: PlayerRelease.RunnerUnavailable,
        retryAfterSeconds: SHUTDOWN_RETRY_SECONDS,
      },
    ]);
    assert.ok(SHUTDOWN_RETRY_SECONDS <= 30);
    assert.equal(calls.submit.length, 0);
  });

  it("a credential genex.games refuses stops the loop; so does its version floor", async () => {
    const refused = fakeClient({
      heartbeat: async () => {
        throw new PlayerAuthError(403, "credential_scope");
      },
    });
    const auth = await session({ client: refused.client }).pass();
    assert.equal(auth.stop?.kind, WatcherStop.AuthRefused);
    const old = fakeClient({
      policy: async () => {
        throw new PlayerUpdateRequiredError("0.2.0", "0.3.0");
      },
    });
    const floor = await session({ client: old.client }).pass();
    assert.equal(floor.stop?.kind, WatcherStop.UpdateRequired);
    assert.deepEqual(old.calls.pending, []);
  });

  it("a heartbeat that fails keeps the watcher up and says genex.games is unreachable", async () => {
    let fail = true;
    const { client } = fakeClient({
      heartbeat: async () => {
        if (fail) throw new TypeError("fetch failed");
        return {
          watcherId: "watcher_1",
          minVersion: "0.1.0",
          latestVersion: "0.1.0",
          policyVersion: "p",
          pollIntervalSeconds: 1,
        };
      },
    });
    const { pass, s, advance } = session({ client });
    const result = await pass();
    assert.equal(result.stop, null);
    assert.equal(s.snapshot().unreachable, true);
    fail = false;
    advance(result.sleepMs);
    await pass();
    assert.equal(s.snapshot().unreachable, false);
  });
});

describe("what the loop does with answers it cannot read", () => {
  it("an unreadable policy keeps the shipped one and still answers", async () => {
    const { client, calls } = fakeClient({
      policy: async () => {
        throw new PlayerApiError(200, "unreadable_answer");
      },
    });
    const { pass, jobs } = session({ client });
    const result = await pass();
    assert.equal(result.stop, null);
    assert.equal(calls.submit.length, 1);
    assert.equal(jobs[0]?.policy.version, "fallback");
  });

  it("a claim whose answer does not read runs the job the listing carried", async () => {
    const { client, calls } = fakeClient({ claim: async () => null });
    const { pass, jobs } = session({ client });
    await pass();
    assert.equal(jobs[0]?.job, JOB);
    assert.equal(calls.submit.length, 1);
  });

  it("a resting plan reads as resting only until its reset", async () => {
    const resetsAt = new Date(START + 5 * 60_000).toISOString();
    const usage: ProviderUsage = { measuredAt: "", windows: [{ id: "five_hour", label: "", percent: 90, resetsAt }] };
    const { client } = fakeClient();
    const { pass, s, advance } = session({
      client,
      planUsage: async () => usage,
      runJob: async () => assert.fail("kept"),
    });
    await pass();
    assert.deepEqual(s.snapshot().resting, { resetsAt });
    advance(5 * 60_000 + 1);
    assert.equal(s.snapshot().resting, null);
  });
});

describe("what the watcher answers with", () => {
  it("advertises Claude alone while Codex has not passed its read-deny check", async () => {
    const { client, calls } = fakeClient();
    const { pass, s } = session({ client, runners: async () => ({ installs: [CLAUDE], codexHeld: true }) });
    await pass();
    assert.deepEqual(calls.heartbeat[0]?.runners, ["claude"]);
    assert.deepEqual(calls.pending, ["claude"], "the ChatGPT lane is never read");
    assert.deepEqual(s.snapshot().runners, ["claude"]);
    assert.equal(s.snapshot().codexHeld, true);
  });

  it("advertises Codex once its check passed, and reads its lane as chatgpt", async () => {
    const { client, calls } = fakeClient();
    await session({ client, runners: async () => ({ installs: [CLAUDE, CODEX], codexHeld: false }) }).pass();
    assert.deepEqual(calls.heartbeat[0]?.runners, ["claude", "codex"]);
    assert.deepEqual(calls.pending, ["claude", "chatgpt"]);
  });

  it("with neither CLI it still beats, with no runners, and claims nothing", async () => {
    const { client, calls } = fakeClient();
    const { pass, lines } = session({ client, runners: async () => ({ installs: [], codexHeld: false }) });
    await pass();
    await pass();
    assert.deepEqual(calls.heartbeat[0]?.runners, []);
    assert.deepEqual(calls.pending, []);
    assert.equal(lines.filter((l) => /nothing can be answered/.test(l)).length, 1, "said once, not every poll");
  });
});

describe("builds come first", () => {
  it("while a build runs it keeps its presence and claims nothing", async () => {
    const { client, calls } = fakeClient();
    await session({ client }).pass(false);
    assert.equal(calls.heartbeat.length, 1);
    assert.deepEqual(calls.pending, []);
    assert.deepEqual(calls.claim, []);
  });

  it("above the keep-for-building line it releases with the plan's real reset, once per row", async () => {
    const resetsAt = new Date(START + 3 * 3_600_000).toISOString();
    const usage: ProviderUsage = {
      measuredAt: new Date(START).toISOString(),
      windows: [
        { id: "five_hour", label: "5-hour limit", percent: 62, resetsAt },
        { id: "seven_day", label: "Weekly · all models", percent: 20 },
      ],
    };
    const { client, calls } = fakeClient();
    const { pass, s, advance } = session({
      client,
      planUsage: async () => usage,
      keepForBuildingPercent: async () => 50,
      runJob: async () => assert.fail("the plan is kept for building"),
    });
    await pass();
    assert.deepEqual(calls.release, [
      { id: "gen_1", watcherId: "watcher_1", reason: PlayerRelease.RateLimited, retryAfterSeconds: 3 * 3600 },
    ]);
    assert.deepEqual(s.snapshot().resting, { resetsAt });
    advance(10 * 60_000);
    await pass();
    assert.equal(calls.claim.length, 1, "a row already told is not claimed again while the plan rests");
  });

  it("a share Settings cannot read is the default share, and the claimed row is still answered", async () => {
    const usage: ProviderUsage = { measuredAt: "", windows: [{ id: "five_hour", label: "", percent: 30 }] };
    const { client, calls } = fakeClient();
    const { pass } = session({
      client,
      planUsage: async () => usage,
      keepForBuildingPercent: async () => {
        throw new Error("settings unreadable");
      },
    });
    await pass();
    assert.equal(calls.submit.length, 1);
  });

  it("under the line it answers", async () => {
    const usage: ProviderUsage = { measuredAt: "", windows: [{ id: "five_hour", label: "5-hour limit", percent: 30 }] };
    const { client, calls } = fakeClient();
    const { pass, s } = session({ client, planUsage: async () => usage, keepForBuildingPercent: async () => 50 });
    await pass();
    assert.equal(calls.submit.length, 1);
    assert.equal(s.snapshot().resting, null);
  });
});

describe("the loop's small rules", () => {
  it("a row is workable when it has a job and nobody else holds a live lease", () => {
    assert.equal(workable(row(), "w_1", START), true);
    assert.equal(workable(row({ runner: null }), "w_1", START), false);
    assert.equal(
      workable(row({ claimedBy: "w_1", leaseExpiresAt: new Date(START + 1).toISOString() }), "w_1", START),
      true,
    );
    assert.equal(
      workable(row({ claimedBy: "w_2", leaseExpiresAt: new Date(START + 1).toISOString() }), "w_1", START),
      false,
    );
    assert.equal(workable(row({ claimedBy: "w_2", leaseExpiresAt: "not a date" }), "w_1", START), false);
  });

  it("backs off exponentially, with jitter, from the server's numbers", () => {
    assert.equal(
      backoffMs(POLICY, 1, () => 0.5),
      1000,
    );
    assert.equal(
      backoffMs(POLICY, 2, () => 0.5),
      2000,
    );
    assert.equal(
      backoffMs(POLICY, 9, () => 0.5),
      4000,
      "never past the server's maximum",
    );
  });

  it("the keep-for-building line is the share each plan keeps: games use the rest", () => {
    const at = (percent: number | null, resetsAt?: string): ProviderUsage => ({
      measuredAt: "",
      windows: [{ id: "five_hour", label: "", percent, ...(resetsAt ? { resetsAt } : {}) }],
    });
    const reset = new Date(START + 60_000).toISOString();
    assert.deepEqual(planCeiling(at(50, reset), 50), { resting: true, resetsAt: reset });
    assert.deepEqual(planCeiling(at(49), 50), { resting: false, resetsAt: null });
    assert.deepEqual(planCeiling(at(65), 40), { resting: true, resetsAt: null });
    assert.deepEqual(planCeiling(at(99), 0), { resting: false, resetsAt: null }, "keep nothing: games may use it all");
    assert.deepEqual(
      planCeiling(at(null), 50),
      { resting: false, resetsAt: null },
      "an unknown share is not a full one",
    );
    assert.deepEqual(planCeiling(null, 50), { resting: false, resetsAt: null });
  });
});
