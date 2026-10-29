/**
 * Genex's updated terms, from the account to the chat: a generation asks Genex first and, while the
 * terms wait for the person, says so and waits for them before it submits anything; the account the
 * sidebar reads says the terms are pending; a call that went no further than the terms is recorded
 * as blocked, so the chat offers Review under it while they are still pending.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { mkdir } from "node:fs/promises";
import { assetCliTimeoutMs, GenexTools } from "../../src/plugins/genex/adapter.ts";
import { INVOCATION_BUDGET_MS } from "../../src/plugins/genex/cover.ts";
import { createGenexAccount, type GenexAccountPort } from "../../src/main/core/genex-account.ts";
import { finishedPayload, startedPayload } from "../../src/main/plugin-activity.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import { GENEX_PLUGIN_ID, GenexBlocked } from "../../src/shared/genex.ts";
import { PluginAccountState } from "../../src/shared/plugins.ts";
import { asksForGenexTerms } from "../../src/renderer/panels/plugins/genex/genex-terms.ts";
import { ToolState } from "../../src/renderer/ui/tool-state.ts";
import { accountRead, initialPeople } from "../../src/renderer/state/people.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** How long a test's gate waits for the terms, and how often it asks: short, so a test never idles. */
const TERMS_WAIT = { waitMs: 200, pollMs: 10 };

/**
 * A Genex API whose terms answer `accepted` until `acceptAfter` status reads have passed (never,
 * when null). Every request is recorded; anything but the terms answers 404.
 */
async function termsApi(acceptAfter: number | null, onRead: () => void = () => {}) {
  const calls: string[] = [];
  let reads = 0;
  const server = http.createServer((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/legal/status") {
      reads++;
      onRead();
      const accepted = acceptAfter !== null && reads > acceptAfter;
      res.end(JSON.stringify({ accepted, required: "2" }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const api = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  };
  return { api, calls, close };
}

/** Genex's tools on `api`, signed in, with the test's short terms wait (or the given one and clock). */
async function signedInTools(
  root: string,
  api: string,
  timing: { termsWait?: typeof TERMS_WAIT; now?: () => number } = {},
) {
  let token: string | null = "fixture-token";
  const credentials = {
    get: async () => token,
    set: async (next: string) => {
      token = next;
    },
    clear: async () => {
      token = null;
    },
  };
  const tools = new GenexTools(path.join(root, "host"), api, {
    credentials,
    termsWait: timing.termsWait ?? TERMS_WAIT,
    ...(timing.now ? { now: timing.now } : {}),
  });
  await tools.init();
  const game = path.join(root, "game");
  await mkdir(game, { recursive: true });
  return { tools, game };
}

test("a generation waits for terms the person never accepts, submits nothing and is recorded as blocked", async () => {
  const root = await tmpDir("genex-terms-");
  const api = await termsApi(null);
  try {
    const { tools, game } = await signedInTools(root, api.api);
    const announced: boolean[] = [];
    const job = (await tools.execute("game", game, { operation: "image", prompt: "a fox" }, undefined, false, "t1", {
      termsPending: async (pending) => {
        announced.push(pending);
      },
    })) as { status: string; blocked?: string; error?: string };
    assert.equal(job.blocked, GenexBlocked.Terms);
    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /terms/i);
    assert.deepEqual(announced, [true], "the app hears once, when the wait starts");
    assert.ok(
      api.calls.every((call) => call === "GET /api/legal/status"),
      `nothing but the terms was asked: ${api.calls.join(", ")}`,
    );
    assert.ok(api.calls.length > 1, "the gate asked again while it waited");
  } finally {
    await api.close();
  }
});

test("terms accepted during the wait: the app hears both ends and the generation goes on to Genex", async () => {
  const root = await tmpDir("genex-terms-ok-");
  const api = await termsApi(2);
  try {
    const { tools, game } = await signedInTools(root, api.api);
    const announced: boolean[] = [];
    const job = (await tools.execute("game", game, { operation: "image", prompt: "a fox" }, undefined, false, "t1", {
      termsPending: async (pending) => {
        announced.push(pending);
      },
    })) as { blocked?: string };
    assert.deepEqual(announced, [true, false]);
    assert.equal(job.blocked, undefined);
    assert.ok(
      api.calls.some((call) => !call.endsWith("/api/legal/status")),
      `the generation reached Genex after the terms: ${api.calls.join(", ")}`,
    );
  } finally {
    await api.close();
  }
});

test("a generation's CLI never runs past the host's ceiling for its call, terms wait included", () => {
  assert.equal(assetCliTimeoutMs(0), 180_000, "with no wait the CLI keeps its whole timeout");
  for (const elapsed of [0, 1_000, 60_000, 100_000, 120_000, 149_999]) {
    const timeout = assetCliTimeoutMs(elapsed);
    assert.ok(timeout > 0, `${elapsed} ms in, there is still time to submit`);
    assert.ok(elapsed + timeout < INVOCATION_BUDGET_MS, `${elapsed} ms in, the CLI stops before the host's ceiling`);
  }
  assert.equal(assetCliTimeoutMs(100_000), 80_000, "the terms wait comes out of the CLI's own time");
  for (const elapsed of [160_000, 190_000, 400_000])
    assert.equal(assetCliTimeoutMs(elapsed), 0, `${elapsed} ms in, too little is left to submit`);
});

test("terms accepted with too little of the call left: nothing is submitted and the job says why", async () => {
  const root = await tmpDir("genex-terms-late-");
  let clock = 0;
  // Each question about the terms takes most of a minute of the call.
  const api = await termsApi(2, () => {
    clock += 55_000;
  });
  try {
    const { tools, game } = await signedInTools(root, api.api, {
      termsWait: { waitMs: 10 * 60_000, pollMs: 10 },
      now: () => clock,
    });
    const job = (await tools.execute("game", game, { operation: "image", prompt: "a fox" })) as {
      status: string;
      blocked?: string;
      error?: string;
    };
    assert.equal(job.status, "failed");
    assert.equal(job.blocked, undefined, "the terms were accepted");
    assert.match(job.error ?? "", /nothing was submitted/);
    assert.ok(
      api.calls.every((call) => call === "GET /api/legal/status"),
      `nothing but the terms was asked: ${api.calls.join(", ")}`,
    );
  } finally {
    await api.close();
  }
});

test("accepted terms cost a generation one question and no announcement", async () => {
  const root = await tmpDir("genex-terms-accepted-");
  const api = await termsApi(0);
  try {
    const { tools, game } = await signedInTools(root, api.api);
    const announced: boolean[] = [];
    await tools.execute("game", game, { operation: "image", prompt: "a fox" }, undefined, false, "t1", {
      termsPending: async (pending) => {
        announced.push(pending);
      },
    });
    assert.deepEqual(announced, []);
    assert.equal(api.calls.filter((call) => call === "GET /api/legal/status").length, 1);
  } finally {
    await api.close();
  }
});

test("the terms status answers whether the account still has terms to accept", async () => {
  const root = await tmpDir("genex-terms-status-");
  const pending = await termsApi(null);
  const accepted = await termsApi(0);
  try {
    assert.deepEqual(await (await signedInTools(root, pending.api)).tools.termsStatus(), { pending: true });
    assert.deepEqual(await (await signedInTools(path.join(root, "b"), accepted.api)).tools.termsStatus(), {
      pending: false,
    });
  } finally {
    await pending.close();
    await accepted.close();
  }
});

/** A signed-in account port whose terms are `pending`. */
function signedInPort(pending: boolean | "throws"): GenexAccountPort {
  return {
    state: async () => PluginAccountState.Unlocked,
    token: async () => "token-1",
    connect: async () => ({}),
    cancel: async () => {},
    disconnect: async () => {},
    signedIn: async () => {},
    termsPending: async () => {
      if (pending === "throws") throw new Error("offline");
      return pending;
    },
  };
}

test("the app's account says the terms are pending only while signed in and Genex says so", async () => {
  const view = (port: GenexAccountPort) => createGenexAccount({ port, openSignIn: async () => {} }).view();
  assert.deepEqual(await view(signedInPort(true)), { status: GenexAccountStatus.SignedIn, termsPending: true });
  assert.deepEqual(await view(signedInPort(false)), { status: GenexAccountStatus.SignedIn });
  assert.deepEqual(
    await view(signedInPort("throws")),
    { status: GenexAccountStatus.SignedIn },
    "an unanswered question is no reason to stop anyone",
  );
  const signedOut: GenexAccountPort = { ...signedInPort(true), token: async () => undefined };
  assert.deepEqual(await view(signedOut), { status: GenexAccountStatus.SignedOut });
});

test("the people store keeps the account's pending terms, and drops them with the sign-in", () => {
  const signedIn = accountRead(initialPeople(), { status: GenexAccountStatus.SignedIn, termsPending: true }, null);
  assert.equal(signedIn.genexTermsPending, true);
  const accepted = accountRead(signedIn, { status: GenexAccountStatus.SignedIn }, null);
  assert.equal(accepted.genexTermsPending, false);
  const out = accountRead(signedIn, { status: GenexAccountStatus.SignedOut }, null);
  assert.equal(out.genexTermsPending, false);
});

test("a call Genex took no further than the terms is recorded as blocked", () => {
  const started = startedPayload({
    pluginId: GENEX_PLUGIN_ID,
    pluginName: "Genex",
    tool: "image",
    toolName: "genex__image",
    args: {},
    project: "game",
    engine: "claude",
    role: "chat",
  });
  const blocked = finishedPayload(
    started,
    { result: { id: "job-1", generationId: undefined, files: [], status: "failed", blocked: GenexBlocked.Terms } },
    0,
    10,
  );
  assert.equal(blocked.blocked, GenexBlocked.Terms);
  const plain = finishedPayload(started, { result: { id: "job-2", files: [], status: "failed" } }, 0, 10);
  assert.equal("blocked" in plain, false);
  const strange = finishedPayload(started, { result: { id: "job-3", files: [], blocked: "something-else" } }, 0, 10);
  assert.equal("blocked" in strange, false, "only a known reason is recorded");
});

test("the chat offers Review under Genex's running or terms-blocked calls only", () => {
  const genex = { id: GENEX_PLUGIN_ID, name: "Genex" };
  const row = (extra: object) => ({ key: "k", icon: "game" as const, label: "Genex", ...extra });
  assert.equal(asksForGenexTerms([row({ source: genex, state: ToolState.Running })]), true);
  assert.equal(asksForGenexTerms([row({ source: genex, state: ToolState.Failed, blocked: GenexBlocked.Terms })]), true);
  assert.equal(asksForGenexTerms([row({ source: genex, state: ToolState.Failed })]), false);
  assert.equal(asksForGenexTerms([row({ source: genex, state: ToolState.Succeeded })]), false);
  assert.equal(asksForGenexTerms([row({ source: { id: "unity", name: "Unity" }, state: ToolState.Running })]), false);
});
