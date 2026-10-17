/**
 * OpenRouter's browser sign-in (OAuth with PKCE): the authorization page it opens, the one-time
 * loopback callback that redeems the code exactly once for a key, and every way it ends. The
 * browser is played by plain requests to the callback; OpenRouter's code exchange is a fake.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { createOpenRouterLogin, type OpenRouterLoginDeps } from "../../src/main/openrouter-login.ts";
import { type EngineStatus, EngineStatusCode } from "../../src/shared/engine-descriptor.ts";
import { OpenRouterSignInOutcome } from "../../src/shared/openrouter-login.ts";

const EXCHANGE_URL = "https://openrouter.example/api/v1/auth/keys";
const AUTH_URL = "https://openrouter.example/auth";
const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";
const READY: EngineStatus = { code: EngineStatusCode.Ready, detail: "OpenRouter API key saved" };

type Exchange = { code: string; code_verifier: string; code_challenge_method: string };

/** A sign-in with a fake OpenRouter: what the browser was sent to, and what was exchanged and saved. */
function rig(options: { answer?: () => Response | Promise<Response>; save?: EngineStatus; timeoutMs?: number } = {}) {
  const opened: string[] = [];
  const exchanges: Exchange[] = [];
  const saved: string[] = [];
  let returns = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    assert.equal(String(input), EXCHANGE_URL);
    assert.equal(init?.method, "POST");
    exchanges.push(JSON.parse(String(init?.body)) as Exchange);
    return options.answer ? options.answer() : Response.json({ key: KEY });
  };
  const deps: OpenRouterLoginDeps = {
    openExternal: async (url) => {
      opened.push(url);
    },
    onReturn: () => {
      returns++;
    },
    fetch: fetchImpl,
    authUrl: AUTH_URL,
    exchangeUrl: EXCHANGE_URL,
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
  };
  const login = createOpenRouterLogin(deps);
  const saveKey = async (key: string) => {
    saved.push(key);
    return options.save ?? READY;
  };
  return { login, saveKey, opened, exchanges, saved, returns: () => returns };
}

/** The authorization page's address, once the sign-in has opened it. */
async function authorization(opened: string[]): Promise<URL> {
  for (let tries = 0; tries < 200 && opened.length === 0; tries++) await tick();
  assert.equal(opened.length, 1, "the browser was sent to OpenRouter once");
  return new URL(opened[0] ?? "");
}

/** The browser coming back to the callback OpenRouter was given, on IPv4 loopback. */
function callback(
  auth: URL,
  query: Record<string, string> | Array<[string, string]>,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(auth.searchParams.get("callback_url") ?? "");
  target.hostname = "127.0.0.1";
  for (const [name, value] of Array.isArray(query) ? query : Object.entries(query))
    target.searchParams.append(name, value);
  return fetch(target, init);
}

const challengeOf = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

describe("OpenRouter browser sign-in", () => {
  it("sends the browser to OpenRouter with a PKCE challenge and redeems the code once for a saved key", async () => {
    const { login, saveKey, opened, exchanges, saved, returns } = rig();
    const ended = login.start(saveKey);
    const auth = await authorization(opened);
    assert.equal(`${auth.origin}${auth.pathname}`, AUTH_URL);
    assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
    assert.equal(auth.searchParams.get("key_label"), "Genex");
    assert.match(auth.searchParams.get("state") ?? "", /^[0-9a-f]{64}$/);
    const back = new URL(auth.searchParams.get("callback_url") ?? "");
    assert.equal(back.protocol, "http:");
    assert.equal(back.hostname, "localhost", "OpenRouter accepts a localhost callback on any port");
    assert.equal(back.pathname, "/openrouter/callback");

    const page = await callback(auth, { code: "the-code", state: auth.searchParams.get("state") ?? "" });
    assert.equal(page.status, 200);
    const words = await page.text();
    assert.match(words, /Genex is connected to OpenRouter/);
    assert.ok(!words.includes(KEY), "the key never reaches the browser");
    assert.deepEqual(await ended, { outcome: OpenRouterSignInOutcome.Connected });

    assert.equal(exchanges.length, 1);
    const exchange = exchanges[0];
    assert.equal(exchange?.code, "the-code");
    assert.equal(exchange?.code_challenge_method, "S256");
    assert.equal(challengeOf(exchange?.code_verifier ?? ""), auth.searchParams.get("code_challenge"));
    assert.deepEqual(saved, [KEY]);
    assert.equal(returns(), 1, "the app comes forward when the browser returns");
    await assert.rejects(callback(auth, { code: "again", state: auth.searchParams.get("state") ?? "" }));
    assert.equal(exchanges.length, 1, "the callback is gone once the sign-in ended");
  });

  it("refuses a callback that is not this sign-in's, and keeps waiting for the real one", async () => {
    const { login, saveKey, opened, exchanges, saved } = rig();
    const ended = login.start(saveKey);
    const auth = await authorization(opened);
    const state = auth.searchParams.get("state") ?? "";
    const hostile: Array<[string, Record<string, string> | Array<[string, string]>, RequestInit?]> = [
      ["no state", { code: "c" }],
      ["another state", { code: "c", state: "f".repeat(64) }],
      ["a shorter state", { code: "c", state: state.slice(1) }],
      ["a longer state", { code: "c", state: `${state}0` }],
      [
        "the state twice, a wrong one first",
        [
          ["code", "c"],
          ["state", "0".repeat(64)],
          ["state", state],
        ],
      ],
      ["a POST", { code: "c", state }, { method: "POST" }],
    ];
    for (const [name, query, init] of hostile) {
      const page = await callback(auth, query, init);
      assert.ok(page.status >= 400, `${name}: ${page.status}`);
      await page.body?.cancel();
    }
    const elsewhere = new URL(auth.searchParams.get("callback_url") ?? "");
    elsewhere.hostname = "127.0.0.1";
    for (const path of ["/", "/openrouter", "/openrouter/callback/x", "/openrouter/callbackx"]) {
      elsewhere.pathname = path;
      const page = await fetch(`${elsewhere.href}?code=c&state=${state}`);
      assert.equal(page.status, 404, path);
      await page.body?.cancel();
    }
    assert.equal(exchanges.length, 0, "no hostile callback reaches OpenRouter");
    assert.deepEqual(saved, []);

    const page = await callback(auth, { code: "real", state });
    await page.body?.cancel();
    assert.deepEqual(await ended, { outcome: OpenRouterSignInOutcome.Connected });
    assert.deepEqual(
      exchanges.map((exchange) => exchange.code),
      ["real"],
    );
  });

  it("redeems a code once when the browser comes back twice at the same time", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { login, saveKey, opened, exchanges } = rig({
      answer: async () => {
        await held;
        return Response.json({ key: KEY });
      },
    });
    const ended = login.start(saveKey);
    const auth = await authorization(opened);
    const state = auth.searchParams.get("state") ?? "";
    const first = callback(auth, { code: "c", state });
    for (let tries = 0; tries < 200 && exchanges.length === 0; tries++) await tick();
    const second = await callback(auth, { code: "c", state });
    assert.equal(second.status, 409);
    await second.body?.cancel();
    release();
    await (await first).body?.cancel();
    assert.deepEqual(await ended, { outcome: OpenRouterSignInOutcome.Connected });
    assert.equal(exchanges.length, 1);
  });

  it("ends with the reason when OpenRouter says no, the code is refused or the key is not accepted", async () => {
    const cases: Array<[string, Parameters<typeof rig>[0], Record<string, string> | null, RegExp, number]> = [
      ["denied on OpenRouter", {}, { error: "access_denied" }, /didn't connect/, 0],
      ["code refused", { answer: () => new Response("", { status: 403 }) }, null, /didn't give Genex a key/, 1],
      ["no key in the answer", { answer: () => Response.json({}) }, null, /didn't give Genex a key/, 1],
      [
        "OpenRouter unreachable",
        {
          answer: () => {
            throw new TypeError("fetch failed");
          },
        },
        null,
        /couldn't be reached/,
        1,
      ],
      [
        "key not accepted",
        { save: { code: EngineStatusCode.NeedsLogin, detail: "OpenRouter did not accept the saved API key." } },
        null,
        /did not accept/,
        1,
      ],
    ];
    for (const [name, options, query, reason, exchanged] of cases) {
      const { login, saveKey, opened, exchanges, saved } = rig(options);
      const ended = login.start(saveKey);
      const auth = await authorization(opened);
      const page = await callback(auth, query ?? { code: "c", state: auth.searchParams.get("state") ?? "" });
      assert.equal(page.status, 200, name);
      assert.match(await page.text(), /Go back to Genex/, name);
      const result = await ended;
      assert.equal(result.outcome, OpenRouterSignInOutcome.Failed, name);
      assert.match(result.outcome === OpenRouterSignInOutcome.Failed ? result.error : "", reason, name);
      assert.equal(exchanges.length, exchanged, name);
      if (exchanged === 0 || name !== "key not accepted") assert.deepEqual(saved, [], name);
    }
  });

  it("cancels, reopens only a sign-in under way, and a new Connect replaces the old one", async () => {
    const { login, saveKey, opened } = rig();
    const first = login.start(saveKey);
    const auth = await authorization(opened);
    assert.equal(await login.reopen(), true);
    assert.deepEqual(opened, [auth.href, auth.href], "the same page opens again");

    const second = login.start(saveKey);
    assert.deepEqual(await first, { outcome: OpenRouterSignInOutcome.Cancelled });
    await assert.rejects(callback(auth, { code: "c", state: auth.searchParams.get("state") ?? "" }));

    assert.equal(login.cancel(), true);
    assert.deepEqual(await second, { outcome: OpenRouterSignInOutcome.Cancelled });
    assert.equal(login.cancel(), false, "nothing left to cancel");
    assert.equal(await login.reopen(), false, "nothing left to reopen");
  });

  it("gives up when the browser never comes back, and when it cannot be opened", async () => {
    const slow = rig({ timeoutMs: 30 });
    const late = await slow.login.start(slow.saveKey);
    assert.equal(late.outcome, OpenRouterSignInOutcome.Failed);
    assert.match(late.outcome === OpenRouterSignInOutcome.Failed ? late.error : "", /took too long/);
    const auth = new URL(slow.opened[0] ?? "");
    await assert.rejects(callback(auth, { code: "c", state: auth.searchParams.get("state") ?? "" }));

    const blind = createOpenRouterLogin({
      openExternal: async () => {
        throw new Error("no browser");
      },
      fetch: async () => {
        throw new Error("unreachable");
      },
    });
    const result = await blind.start(async () => READY);
    assert.equal(result.outcome, OpenRouterSignInOutcome.Failed);
    assert.match(result.outcome === OpenRouterSignInOutcome.Failed ? result.error : "", /browser/);
  });
});
