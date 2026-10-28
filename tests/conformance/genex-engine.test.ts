/**
 * The Genex engine: Claude Code on the person's Genex credits. The lane (`substrate/engines/
 * genex.ts`) reads whether the account may build and which models genex.games offers, reuses a
 * read for a moment, and moves at once when genex.games refuses a call; the engine
 * (`ClaudeCodeEngine` with a `gateway`) runs each session through a relay lease of its own, in the
 * studio's home, with none of the Mac's own Claude variables, and turns a refusal into the engine
 * error the run policy acts on.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { EngineStatusCode, EngineStatusReason } from "../../src/shared/engine-descriptor.ts";
import { EngineFailureKind } from "../../src/shared/engine-requests.ts";
import { GENEX_HELPER_MODEL, GENEX_MODELS, GenexAccess, GenexBuildRoute } from "../../src/shared/genex-build.ts";
import { EngineId } from "../../src/shared/providers.ts";
import { ClaudeCodeEngine, type ClaudeGateway } from "../../src/substrate/engines/claude-code.ts";
import { creditsUsage, createGenexLane, genexStatus } from "../../src/substrate/engines/genex.ts";
import type { GenexLease } from "../../src/substrate/engines/genex-relay.ts";
import { EngineError } from "../../src/substrate/engines/types.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { tmpDir } from "../helpers/tmp.ts";

const API = "https://api.genex.test";
const TOKEN = "genex-token";

type Answer = { status: number; body?: unknown } | Error;

/** A fetch that answers from `answers` in turn (the last one repeats) and keeps what it was asked. */
function scriptedFetch(answers: Answer[]) {
  const asked: Array<{ url: string; auth: string | null }> = [];
  const fetch = (async (url: URL | string, init?: RequestInit) => {
    asked.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    const next = answers.length > 1 ? answers.shift() : answers[0];
    if (!next || next instanceof Error) throw next ?? new Error("no answer");
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
  }) as typeof globalThis.fetch;
  return { fetch, asked };
}

/** A lane over scripted answers, on a clock the test moves; `token` is null while signed out. */
function laneOver(answers: Answer[], token: string | null = TOKEN) {
  const { fetch, asked } = scriptedFetch(answers);
  let clock = 1_000;
  const changes: number[] = [];
  const refused: string[] = [];
  const lane = createGenexLane({
    api: API,
    token: async () => token ?? undefined,
    fetch,
    now: () => clock,
    onChange: () => changes.push(clock),
    refused: (value) => refused.push(value),
  });
  return { lane, asked, changes, refused, tick: (ms: number) => (clock += ms) };
}

describe("Genex lane", () => {
  it("maps each answer genex.games gives to the engine's status", async () => {
    const cases: Array<[Answer, string, string | undefined]> = [
      [{ status: 200, body: { access: "ready" } }, EngineStatusCode.Ready, undefined],
      [{ status: 200, body: { access: "sign_in" } }, EngineStatusCode.NeedsLogin, EngineStatusReason.NotSignedIn],
      [{ status: 200, body: { access: "verify_email" } }, EngineStatusCode.NeedsLogin, EngineStatusReason.VerifyEmail],
      [{ status: 200, body: { access: "needs_plan" } }, EngineStatusCode.NeedsLogin, EngineStatusReason.NeedsPlan],
      [
        { status: 200, body: { access: "out_of_credits" } },
        EngineStatusCode.NeedsLogin,
        EngineStatusReason.OutOfCredits,
      ],
      [{ status: 200, body: { access: "paused" } }, EngineStatusCode.NeedsLogin, EngineStatusReason.Paused],
      [{ status: 404, body: { error: "not_found" } }, EngineStatusCode.NotInstalled, EngineStatusReason.NotOffered],
      [{ status: 200, body: { access: "something-new" } }, EngineStatusCode.Error, EngineStatusReason.CheckFailed],
      [{ status: 500, body: { error: "x" } }, EngineStatusCode.Error, EngineStatusReason.CheckFailed],
      [new Error("offline"), EngineStatusCode.Error, EngineStatusReason.CheckFailed],
    ];
    for (const [answer, code, reason] of cases) {
      const { lane } = laneOver([answer]);
      const status = await lane.status();
      assert.equal(status.code, code, JSON.stringify(answer));
      assert.equal(status.reason, reason, JSON.stringify(answer));
    }
  });

  it("asks with the person's sign-in only while there is one", async () => {
    const signedIn = laneOver([{ status: 200, body: { access: "ready" } }]);
    await signedIn.lane.status();
    assert.deepEqual(signedIn.asked, [{ url: `${API}${GenexBuildRoute.Status}`, auth: `Bearer ${TOKEN}` }]);
    const signedOut = laneOver([{ status: 200, body: { access: "sign_in" } }], null);
    await signedOut.lane.status();
    assert.equal(signedOut.asked[0]?.auth, null);
  });

  it("offers genex.games's own models once it lists them, and its three until then", async () => {
    const answer = {
      access: "ready",
      models: [{ id: "opus-5.5-medium-or", name: "Opus 5.5" }, { id: 7 }, { id: "", name: "x" }, "bad"],
    };
    const { lane } = laneOver([{ status: 200, body: answer }]);
    assert.deepEqual(
      lane.models().map((model) => model.id),
      GENEX_MODELS.map((model) => model.id),
    );
    assert.equal(lane.defaultModel(), GENEX_HELPER_MODEL);
    await lane.status();
    assert.deepEqual(
      lane.models().map((model) => [model.id, model.label]),
      [["opus-5.5-medium-or", "Opus 5.5"]],
    );
    assert.equal(lane.defaultModel(), "opus-5.5-medium-or");
  });
});

describe("Genex lane reads", () => {
  it("reuses a read for a moment, joins one in flight, and asks again when told to", async () => {
    const { lane, asked, tick } = laneOver([{ status: 200, body: { access: "ready" } }]);
    await Promise.all([lane.status(), lane.status()]);
    assert.equal(asked.length, 1, "two reads at once are one request");
    await lane.status();
    assert.equal(asked.length, 1, "a fresh read is reused");
    await lane.status(true);
    assert.equal(asked.length, 2);
    tick(60_000);
    await lane.status();
    assert.equal(asked.length, 3, "an old read is not");
  });

  it("says when the status moves, as a purchase moves it", async () => {
    const { lane, changes, tick } = laneOver([
      { status: 200, body: { access: "needs_plan" } },
      { status: 200, body: { access: "ready" } },
    ]);
    await lane.status();
    assert.deepEqual(changes, [], "the first read is no change");
    tick(60_000);
    assert.equal((await lane.status()).code, EngineStatusCode.Ready);
    assert.equal(changes.length, 1);
  });

  it("moves at once when genex.games refuses a call, and ends a sign-in it refused", async () => {
    const refusal = { type: "error", error: { type: "authentication_error", message: "x" }, reason: "sign_in" };
    const { lane, changes, refused } = laneOver([
      { status: 200, body: { access: "ready" } },
      { status: 401, body: refusal },
    ]);
    await lane.status();
    const lease = await lane.open("chat_1");
    const res = await fetch(`${lease.env.ANTHROPIC_BASE_URL}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": lease.env.ANTHROPIC_AUTH_TOKEN ?? "" },
      body: JSON.stringify({ model: GENEX_HELPER_MODEL }),
    });
    assert.equal(res.status, 401);
    await res.body?.cancel();
    assert.equal((await lane.status()).reason, EngineStatusReason.NotSignedIn, "no new read needed");
    assert.deepEqual(refused, [TOKEN]);
    assert.equal(changes.length, 1);
    lease.close();
    await lane.close();
  });

  it("reads the monthly credits as one usage window, and none without a monthly refill", () => {
    const at = "2026-10-28T12:00:00.000Z";
    assert.deepEqual(creditsUsage({ spendable: 250, refillTo: 1000, refillAt: "2026-11-01T00:00:00.000Z" }, at), {
      measuredAt: at,
      windows: [{ id: "credits", label: "Monthly credits", percent: 75, resetsAt: "2026-11-01T00:00:00.000Z" }],
    });
    assert.equal(
      creditsUsage({ spendable: 5000, refillTo: 1000 }, at)?.windows[0]?.percent,
      0,
      "bought credits on top",
    );
    assert.equal(creditsUsage({ spendable: 250, refillTo: null }, at), null);
    assert.equal(creditsUsage(null, at), null);
  });
});

/** A gateway the test drives: one status, its leases, and what each was asked. */
function fakeGateway(status = genexStatus(GenexAccess.Ready)) {
  const opened: Array<{ chat: string; closed: boolean; refuse?: GenexAccess }> = [];
  let refuseNext: GenexAccess | undefined;
  const lane = createGenexLane({ api: API, token: async () => TOKEN, fetch: scriptedFetch([new Error("x")]).fetch });
  const gateway: ClaudeGateway = {
    id: EngineId.Genex,
    label: "Genex",
    status: async () => status,
    models: () => lane.models(),
    defaultModel: () => GENEX_HELPER_MODEL,
    readUsage: async () => null,
    forget: () => {},
    close: async () => {},
    open: async (chat: string): Promise<GenexLease> => {
      const lease = { chat, closed: false, refuse: refuseNext };
      opened.push(lease);
      return {
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: `lease-${opened.length}` },
        refusal: () => lease.refuse,
        close: () => {
          lease.closed = true;
        },
      };
    },
  };
  return { gateway, opened, refuse: (reason: GenexAccess) => (refuseNext = reason) };
}

const ok = { type: "result", subtype: "success", is_error: false, result: "Done.", num_turns: 1, usage: {} };
const failed = { ...ok, is_error: true, result: 'API Error: 402 {"type":"error"}' };

/** A Genex engine over `gateway` whose CLI answers `result`, and the options each session started with. */
async function genexEngine(gateway: ClaudeGateway, result: Record<string, unknown> = ok) {
  const root = await tmpDir("studio-genex-engine-");
  const seen: Array<Record<string, unknown>> = [];
  const engine = new ClaudeCodeEngine({
    gateway,
    resolveCli: fixtureCodingCli,
    engineHome: path.join(root, "genex-build"),
    systemHome: path.join(root, "no-system-login"),
    judgeCwd: path.join(root, "judge"),
    queryFn: ((params: { options?: Record<string, unknown> }) => {
      seen.push({ ...params.options });
      return {
        async *[Symbol.asyncIterator]() {
          yield result;
        },
      };
    }) as never,
  });
  const cwd = await tmpDir("studio-genex-game-");
  return { engine, seen, root, cwd };
}

describe("Genex engine", () => {
  it("is Genex, with the lane's status, models and default", async () => {
    const { gateway } = fakeGateway(genexStatus(GenexAccess.OutOfCredits));
    const { engine } = await genexEngine(gateway);
    assert.equal(engine.id, EngineId.Genex);
    assert.equal(engine.label, "Genex");
    assert.equal((await engine.status()).reason, EngineStatusReason.OutOfCredits);
    assert.deepEqual(
      (await engine.models()).map((model) => model.id),
      GENEX_MODELS.map((model) => model.id),
    );
    assert.equal(await engine.defaultModel(), GENEX_HELPER_MODEL);
    assert.equal((await engine.account()).source, "none");
  });

  it("runs each session through its own lease, in the studio's home, with none of this Mac's Claude variables", async (t) => {
    const saved = { ...process.env };
    t.after(() => {
      for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN"]) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
    });
    process.env.ANTHROPIC_API_KEY = "sk-person";
    process.env.ANTHROPIC_BASE_URL = "https://person.example";
    process.env.ANTHROPIC_MODEL = "claude-person";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth-person";
    const { gateway, opened } = fakeGateway();
    const { engine, seen, root, cwd } = await genexEngine(gateway);
    const result = await engine.delegate({ cwd, prompt: "Build it", model: "opus-5.5-medium-or" } as never);
    assert.equal(result.ok, true);
    assert.equal(result.engine, EngineId.Genex);
    assert.equal(result.billing, "api", "credits are billed per call");
    const env = seen[0]?.env as Record<string, string>;
    assert.equal(env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "lease-1");
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(root, "genex-build"));
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN"])
      assert.equal(env[name], undefined, name);
    assert.equal(seen[0]?.model, "opus-5.5-medium-or");
    assert.equal(opened.length, 1);
    assert.equal(opened[0]?.closed, true, "the lease ends with the session");
    assert.match(opened[0]?.chat ?? "", /^[0-9a-f]{32}$/, "the chat is a hash, never the folder's path");
    assert.ok(!(opened[0]?.chat ?? "").includes(path.basename(cwd)));
  });

  it("gives a judge its own lease too, ended with the verdict", async () => {
    const { gateway, opened } = fakeGateway();
    const { engine, seen } = await genexEngine(gateway, { ...ok, type: "assistant", message: { content: [] } });
    await engine.complete({ messages: [{ role: "user", content: "Is it red?" }] }).catch(() => {});
    assert.equal(opened[0]?.chat, "judge");
    assert.equal(opened[0]?.closed, true);
    const env = seen[0]?.env as Record<string, string> | undefined;
    assert.equal(env?.ANTHROPIC_AUTH_TOKEN, "lease-1");
  });

  it("turns genex.games's refusal into the engine error the run policy acts on", async () => {
    const cases: Array<[GenexAccess, string]> = [
      [GenexAccess.OutOfCredits, EngineFailureKind.UsageLimit],
      [GenexAccess.NeedsPlan, EngineFailureKind.UsageLimit],
      [GenexAccess.Paused, EngineFailureKind.UsageLimit],
      [GenexAccess.SignIn, EngineFailureKind.Auth],
      [GenexAccess.VerifyEmail, EngineFailureKind.Auth],
    ];
    for (const [reason, kind] of cases) {
      const { gateway, refuse, opened } = fakeGateway();
      refuse(reason);
      const { engine, cwd } = await genexEngine(gateway, failed);
      await assert.rejects(
        engine.delegate({ cwd, prompt: "Build it" } as never),
        (error: unknown) => error instanceof EngineError && error.kind === kind && error.engine === EngineId.Genex,
        reason,
      );
      assert.equal(opened[0]?.closed, true, reason);
    }
  });
});
