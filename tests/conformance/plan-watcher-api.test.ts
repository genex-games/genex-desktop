/**
 * The plan watcher's genex.games client (`main/game-ai/player-api.ts`): the seven player routes a
 * Genex player credential can reach, the headers every call carries, the refusals the loop branches
 * on, and the readers every answer goes through. genex.games composes each job; what arrives is
 * still read as hostile input, because part of it becomes a CLI's argv.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  EXTERNAL_PROVIDER_HEADER,
  PLAYER_VERSION_HEADER,
  PlayerApiError,
  PlayerAuthError,
  PlayerProvider,
  PlayerRelease,
  PlayerUpdateRequiredError,
  createPlayerClient,
  readHeartbeat,
  readPendingGenerations,
  readPlayerPolicy,
  readRunnerJob,
} from "../../src/main/game-ai/player-api.ts";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch that records each call and answers `answer(url)`. */
function fakeFetch(answer: (url: string, method: string) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]),
    );
    seen.push({ url, method, headers, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const { status, body } = answer(url, method);
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const API = "https://api.genex.games";

const JOB = {
  system: "LONG. Reply with the finished text only.",
  user: "Name one creature.",
  outputFormat: "text",
  model: { id: "anthropic/claude-sonnet-4.5", family: "claude", cliModel: "sonnet" },
  maxOutputTokens: 256,
  mode: "long_usage",
  grantId: "grant_1",
  leaseSeconds: 120,
};

describe("the player client", () => {
  it("every call carries the credential, the watcher's version and, on the queue, the funding lane", async () => {
    const { fetchImpl, seen } = fakeFetch((url) => {
      if (url.endsWith("/heartbeat"))
        return {
          status: 200,
          body: {
            watcherId: "w_1",
            minVersion: "0.1.0",
            latestVersion: "0.1.0",
            policyVersion: "p1",
            pollIntervalSeconds: 5,
          },
        };
      if (url.endsWith("/generations")) return { status: 200, body: { generations: [] } };
      return { status: 200, body: { id: "gen_1", status: "succeeded" } };
    });
    const client = createPlayerClient({ api: API, token: "tok_player", version: "0.1.10", fetch: fetchImpl });
    await client.heartbeat({ platform: "darwin", runners: ["claude"], label: "Mac" });
    await client.pending(PlayerProvider.Claude);
    await client.submit("gen_1", PlayerProvider.Claude, "w_1", "Brightwing");
    for (const call of seen) {
      assert.equal(call.headers.authorization, "Bearer tok_player", call.url);
      assert.equal(call.headers[PLAYER_VERSION_HEADER], "0.1.10", call.url);
    }
    assert.equal(seen[0]?.headers[EXTERNAL_PROVIDER_HEADER], undefined, "the heartbeat names no lane");
    assert.equal(seen[1]?.headers[EXTERNAL_PROVIDER_HEADER], "claude");
    assert.deepEqual(seen[0]?.body, { version: "0.1.10", platform: "darwin", runners: ["claude"], label: "Mac" });
    assert.deepEqual(seen[2]?.body, { output: "Brightwing", watcherId: "w_1" });
    assert.equal(seen[2]?.url, `${API}/api/runtime/external/generations/gen_1/result`);
  });

  it("a row id is encoded into its route, never spliced", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({
      status: 200,
      body: { id: "x", status: "awaiting_external", attempts: 1 },
    }));
    const client = createPlayerClient({ api: API, token: "t", version: "0.1.10", fetch: fetchImpl });
    await client.release("../../admin?x=1", PlayerProvider.Claude, { watcherId: "w_1", reason: PlayerRelease.Failed });
    assert.equal(seen[0]?.url, `${API}/api/runtime/external/generations/..%2F..%2Fadmin%3Fx%3D1/release`);
  });

  it("a release's wait is whole seconds the route takes: 1 to 86400", async () => {
    const { fetchImpl, seen } = fakeFetch(() => ({
      status: 200,
      body: { id: "g", status: "awaiting_external", attempts: 1 },
    }));
    const client = createPlayerClient({ api: API, token: "t", version: "0.1.10", fetch: fetchImpl });
    for (const retryAfterSeconds of [0.2, 200_000, 12.6])
      await client.release("g", PlayerProvider.Claude, {
        watcherId: "w",
        reason: PlayerRelease.RateLimited,
        retryAfterSeconds,
      });
    assert.deepEqual(
      seen.map((call) => (call.body as { retryAfterSeconds: number }).retryAfterSeconds),
      [1, 86400, 13],
    );
  });

  it("426 is the server's version floor, 401 and 403 end the credential, anything else keeps its code", async () => {
    const answers: Record<string, { status: number; body: unknown }> = {
      "/api/runtime/player/policy": { status: 426, body: { minVersion: "0.2.0", latestVersion: "0.3.0" } },
      "/api/runtime/player/watchers/heartbeat": { status: 403, body: { error: "credential_scope" } },
      "/api/runtime/external/generations": { status: 401, body: null },
      "/api/runtime/external/generations/g/claim": { status: 409, body: { error: "already_claimed" } },
    };
    const { fetchImpl } = fakeFetch((url) => answers[url.slice(API.length)] ?? { status: 500, body: null });
    const client = createPlayerClient({ api: API, token: "t", version: "0.1.10", fetch: fetchImpl });
    await assert.rejects(client.policy(), (error: unknown) => {
      assert.ok(error instanceof PlayerUpdateRequiredError);
      assert.equal(error.minVersion, "0.2.0");
      return true;
    });
    await assert.rejects(client.heartbeat({ platform: "darwin", runners: [] }), (error: unknown) => {
      assert.ok(error instanceof PlayerAuthError);
      assert.equal(error.status, 403);
      return true;
    });
    await assert.rejects(client.pending(PlayerProvider.Claude), PlayerAuthError);
    await assert.rejects(client.claim("g", PlayerProvider.Claude, "w"), (error: unknown) => {
      assert.ok(error instanceof PlayerApiError);
      assert.equal(error.code, "already_claimed");
      return true;
    });
  });

  it("an answer that is not the shape the loop reads is a refusal, never a cast", async () => {
    const { fetchImpl } = fakeFetch((url) =>
      url.endsWith("/heartbeat")
        ? { status: 200, body: { watcherId: 7 } }
        : { status: 200, body: { generations: "all" } },
    );
    const client = createPlayerClient({ api: API, token: "t", version: "0.1.10", fetch: fetchImpl });
    await assert.rejects(client.heartbeat({ platform: "darwin", runners: [] }), PlayerApiError);
    assert.deepEqual(await client.pending(PlayerProvider.Claude), []);
  });
});

describe("the readers of what genex.games sends", () => {
  it("reads a well-formed job", () => {
    assert.deepEqual(readRunnerJob(JOB), { ...JOB });
    assert.deepEqual(readRunnerJob({ ...JOB, grantId: undefined }), { ...JOB, grantId: null });
  });

  const hostileJobs: Array<[string, unknown]> = [
    [
      "a model flag smuggled as the CLI model",
      { ...JOB, model: { ...JOB.model, cliModel: "--dangerously-skip-permissions" } },
    ],
    ["a CLI model with a space", { ...JOB, model: { ...JOB.model, cliModel: "sonnet --add-dir /" } }],
    ["a CLI model with a control character", { ...JOB, model: { ...JOB.model, cliModel: "sonnet\n" } }],
    ["an unknown family", { ...JOB, model: { ...JOB.model, family: "gemini" } }],
    ["an unknown output format", { ...JOB, outputFormat: "yaml" }],
    ["an unknown mode", { ...JOB, mode: "forever" }],
    ["a user text past its bound", { ...JOB, user: "x".repeat(70_000) }],
    ["a system text past its bound", { ...JOB, system: "x".repeat(40_000) }],
    ["a non-integer output budget", { ...JOB, maxOutputTokens: 1.5 }],
    ["a negative lease", { ...JOB, leaseSeconds: -1 }],
    ["a schema that is no plain JSON", { ...JOB, outputFormat: "json", schema: { a: () => 1 } }],
    [
      "a schema nested past its bound",
      { ...JOB, outputFormat: "json", schema: JSON.parse(`${"[".repeat(80)}${"]".repeat(80)}`) },
    ],
    ["a prototype key in the schema", { ...JOB, outputFormat: "json", schema: JSON.parse('{"__proto__":{"x":1}}') }],
    ["no model", { ...JOB, model: null }],
    ["an array", [JOB]],
  ];
  for (const [what, raw] of hostileJobs) it(`refuses a job with ${what}`, () => assert.equal(readRunnerJob(raw), null));

  it("keeps a pending row only when its id, its times and its job read", () => {
    const now = new Date(Date.UTC(2026, 9, 20)).toISOString();
    const row = { id: "gen_1", gameName: "Creature game", expiresAt: now, attempts: 0, runner: JOB };
    const rows = readPendingGenerations({
      generations: [
        row,
        { ...row, id: "gen 2" },
        { ...row, id: "gen_3", runner: { ...JOB, user: 4 } },
        { ...row, id: "gen_4", kind: "workflow", runner: undefined },
        { ...row, id: "gen_5", claimedBy: "w_other", leaseExpiresAt: now },
        "junk",
      ],
    });
    assert.deepEqual(
      rows.map((r) => [r.id, r.runner === null ? null : "job", r.claimedBy]),
      [
        ["gen_1", "job", null],
        ["gen_4", null, null],
        ["gen_5", "job", "w_other"],
      ],
    );
  });

  it("caps how many rows one poll can hand the loop", () => {
    const row = { id: "g", gameName: "G", expiresAt: new Date().toISOString(), attempts: 0, runner: JOB };
    const many = Array.from({ length: 500 }, (_, i) => ({ ...row, id: `g_${i}` }));
    assert.equal(readPendingGenerations({ generations: many }).length, 50);
  });

  it("reads a policy, and refuses one whose numbers or args are out of shape", () => {
    const policy = {
      version: "player-policy-1",
      minVersion: "0.1.0",
      latestVersion: "0.1.0",
      pollIntervalSeconds: 5,
      backoff: { initialSeconds: 5, maxSeconds: 300, factor: 2, jitterRatio: 0.2 },
      preambles: { one_time: "ONE.", long_usage: "LONG." },
      claude: { args: ["-p"], modelFlag: "--model" },
      codex: { args: ["exec"], modelFlag: "--model" },
    };
    assert.equal(readPlayerPolicy(policy)?.version, "player-policy-1");
    assert.deepEqual(readPlayerPolicy(policy)?.claude, { args: ["-p"], modelFlag: "--model" });
    for (const bad of [
      { ...policy, pollIntervalSeconds: 0 },
      { ...policy, pollIntervalSeconds: 10_000 },
      { ...policy, backoff: { ...policy.backoff, jitterRatio: 3 } },
      { ...policy, claude: { args: ["-p", 3] } },
      { ...policy, claude: { args: ["-p", "x\u0000"] } },
      { ...policy, claude: { args: Array.from({ length: 100 }, () => "-p") } },
      { ...policy, codex: { args: ["exec"], modelFlag: "model" } },
      { ...policy, version: 1 },
      "policy",
    ])
      assert.equal(readPlayerPolicy(bad), null, JSON.stringify(bad).slice(0, 80));
  });

  it("reads a heartbeat answer, and refuses an id that could not be one", () => {
    const beat = {
      watcherId: "w_1",
      minVersion: "0.1.0",
      latestVersion: "0.1.0",
      policyVersion: "p",
      pollIntervalSeconds: 5,
    };
    assert.equal(readHeartbeat(beat)?.watcherId, "w_1");
    assert.equal(readHeartbeat({ ...beat, watcherId: "w/../x" }), null);
    assert.equal(readHeartbeat({ ...beat, watcherId: "" }), null);
    assert.equal(
      readHeartbeat({ ...beat, pollIntervalSeconds: "5" })?.pollIntervalSeconds,
      5,
      "a missing cadence takes the default",
    );
  });
});
