/**
 * The relay building with Genex runs Claude Code through (`substrate/engines/genex-relay.ts`),
 * against a fake genex.games on this machine: a session's call reaches genex.games with the
 * person's sign-in in place of the session's key, naming its model and chat, and streams back;
 * a refusal is passed on with its reason; and anything else (no key, another key, an ended lease,
 * another route or method, an oversized or unreadable body, nobody signed in) is refused with
 * nothing sent on.
 */
import assert from "node:assert/strict";
import http, { type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { GenexAccess, GENEX_HELPER_MODEL, GENEX_MODELS } from "../../src/shared/genex-build.ts";
import { createGenexRelay, RELAY_MAX_REQUEST_BYTES } from "../../src/substrate/engines/genex-relay.ts";

const TOKEN = "genex-person-token";
const MODELS = GENEX_MODELS.map((model) => model.id);
const OPUS = MODELS[1] ?? "";

type Seen = { url: string; headers: IncomingMessage["headers"]; body: string };
type Reply = { status: number; type: string; body: string };

/** A fake genex.games: what it was asked, and the answer it gives (an SSE stream by default). */
async function fakeGenex() {
  const seen: Seen[] = [];
  let reply: Reply = { status: 200, type: "text/event-stream", body: "event: message_stop\ndata: {}\n\n" };
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
    res.writeHead(reply.status, { "content-type": reply.type, "request-id": "req_1" }).end(reply.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    api,
    seen,
    answer: (next: Reply) => {
      reply = next;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const closers: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of closers) await close();
});

/** A relay over a fake genex.games, with a lease open; `token` is the person's, null while signed out. */
async function relayOver(token: string | null = TOKEN) {
  const genex = await fakeGenex();
  const refusals: Array<{ reason: string; token: string | undefined }> = [];
  const relay = createGenexRelay({
    api: genex.api,
    token: async () => token ?? undefined,
    models: () => MODELS,
    onRefusal: (reason, refused) => refusals.push({ reason, token: refused }),
  });
  closers.push(genex.close, relay.close);
  const lease = await relay.open({ chat: "chat_1" });
  const base = lease.env.ANTHROPIC_BASE_URL ?? "";
  const key = lease.env.ANTHROPIC_AUTH_TOKEN ?? "";
  return { genex, relay, lease, base, key, refusals };
}

/** A raw request to the relay, so a hostile path reaches it as written. */
function send(
  base: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; type: string; body: string }> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: Number(port),
        method: options.method ?? "POST",
        path: options.path,
        headers: options.headers,
      },
      async (res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of res) chunks.push(chunk as Buffer);
        resolve({
          status: res.statusCode ?? 0,
          type: String(res.headers["content-type"] ?? ""),
          body: Buffer.concat(chunks).toString("utf8"),
        });
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

const call = (model: string) => JSON.stringify({ model, max_tokens: 64, messages: [{ role: "user", content: "hi" }] });

describe("Genex relay", () => {
  it("sends a session's call to genex.games on the person's sign-in, naming its model and chat", async () => {
    const { genex, base, key, lease } = await relayOver();
    const res = await send(base, {
      path: "/v1/messages?beta=true",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${key}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "context-1m",
      },
      body: call(OPUS),
    });
    assert.equal(res.status, 200);
    assert.equal(res.type, "text/event-stream");
    assert.match(res.body, /message_stop/);
    const [sent] = genex.seen;
    assert.ok(sent);
    assert.equal(sent.url, "/api/desktop/llm/v1/messages?beta=true");
    assert.equal(sent.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(sent.headers["x-api-key"], undefined);
    assert.equal(sent.headers["x-genex-model"], OPUS);
    assert.equal(sent.headers["x-genex-chat"], "chat_1");
    assert.equal(sent.headers["anthropic-version"], "2023-06-01");
    assert.equal(sent.headers["anthropic-beta"], "context-1m");
    assert.equal(JSON.parse(sent.body).model, OPUS, "the body goes on as Claude Code wrote it");
    assert.doesNotMatch(JSON.stringify(lease.env), new RegExp(TOKEN), "the session never holds the person's token");
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("runs every name genex.games does not offer, and count_tokens, on the default model", async () => {
    const { genex, base, key } = await relayOver();
    const headers = { "x-api-key": key, "content-type": "application/json" };
    assert.equal((await send(base, { path: "/v1/messages", headers, body: call("claude-haiku-4-5") })).status, 200);
    assert.equal((await send(base, { path: "/v1/messages/count_tokens", headers, body: call("sonnet") })).status, 200);
    assert.deepEqual(
      genex.seen.map((seen) => [seen.url, seen.headers["x-genex-model"]]),
      [
        ["/api/desktop/llm/v1/messages", GENEX_HELPER_MODEL],
        ["/api/desktop/llm/v1/messages/count_tokens", GENEX_HELPER_MODEL],
      ],
    );
  });
});

describe("Genex relay answers", () => {
  it("passes a refusal on with its reason, and says which token was refused", async () => {
    const { genex, base, key, lease, refusals } = await relayOver();
    assert.equal(lease.refusal(), undefined);
    const refusal = JSON.stringify({
      type: "error",
      error: { type: "invalid_request_error", message: "Out of Genex credits." },
      reason: GenexAccess.OutOfCredits,
    });
    genex.answer({ status: 402, type: "application/json", body: refusal });
    const res = await send(base, { path: "/v1/messages", headers: { "x-api-key": key }, body: call(OPUS) });
    assert.equal(res.status, 402);
    assert.equal(res.body, refusal);
    assert.deepEqual(refusals, [{ reason: GenexAccess.OutOfCredits, token: TOKEN }]);
    assert.equal(lease.refusal(), GenexAccess.OutOfCredits, "the session's lease remembers why");
  });

  it("refuses a call while nobody is signed in to Genex, sending nothing", async () => {
    const { genex, base, key, refusals } = await relayOver(null);
    const res = await send(base, { path: "/v1/messages", headers: { "x-api-key": key }, body: call(OPUS) });
    assert.equal(res.status, 401);
    assert.equal(JSON.parse(res.body).reason, GenexAccess.SignIn);
    assert.deepEqual(refusals, [{ reason: GenexAccess.SignIn, token: undefined }]);
    assert.equal(genex.seen.length, 0);
  });
});

describe("Genex relay refusals", () => {
  it("refuses every hostile request with nothing sent on", async () => {
    const { genex, relay, base, key } = await relayOver();
    const ended = await relay.open({ chat: "chat_2" });
    ended.close();
    const endedKey = ended.env.ANTHROPIC_AUTH_TOKEN ?? "";
    const auth = { "x-api-key": key };
    const cases: Array<[string, Parameters<typeof send>[1], number]> = [
      ["no key", { path: "/v1/messages", body: call(OPUS) }, 401],
      ["another key", { path: "/v1/messages", headers: { "x-api-key": "not-a-lease" }, body: call(OPUS) }, 401],
      [
        "the person's token",
        { path: "/v1/messages", headers: { authorization: `Bearer ${TOKEN}` }, body: call(OPUS) },
        401,
      ],
      ["an ended lease", { path: "/v1/messages", headers: { "x-api-key": endedKey }, body: call(OPUS) }, 401],
      ["GET", { method: "GET", path: "/v1/messages", headers: auth }, 404],
      ["models", { path: "/v1/models", headers: auth, body: "{}" }, 404],
      ["files", { path: "/v1/files", headers: auth, body: "{}" }, 404],
      ["batches", { path: "/v1/messages/batches", headers: auth, body: "{}" }, 404],
      ["dot segments", { path: "/v1/messages/../files", headers: auth, body: "{}" }, 404],
      ["another host", { path: "//evil.example/v1/messages", headers: auth, body: call(OPUS) }, 404],
      ["absolute URL", { path: "http://evil.example/v1/messages", headers: auth, body: call(OPUS) }, 404],
      ["not JSON", { path: "/v1/messages", headers: auth, body: "model=x" }, 400],
      ["a JSON array", { path: "/v1/messages", headers: auth, body: "[]" }, 400],
      ["too large", { path: "/v1/messages", headers: auth, body: Buffer.alloc(RELAY_MAX_REQUEST_BYTES + 1, 32) }, 413],
    ];
    for (const [name, request, status] of cases) {
      const res = await send(base, request);
      assert.equal(res.status, status, name);
      assert.equal(JSON.parse(res.body).type, "error", name);
    }
    assert.equal(genex.seen.length, 0, "nothing reached genex.games");
  });

  it("gives each lease its own key, and only a well-formed chat id", async () => {
    const { genex, relay, base, key } = await relayOver();
    const other = await relay.open({ chat: "../../etc" });
    const otherKey = other.env.ANTHROPIC_AUTH_TOKEN ?? "";
    assert.notEqual(otherKey, key);
    assert.equal(other.env.ANTHROPIC_DEFAULT_OPUS_MODEL, GENEX_HELPER_MODEL, "helpers run on the default");
    await send(base, { path: "/v1/messages", headers: { "x-api-key": otherKey }, body: call(OPUS) });
    assert.equal(genex.seen[0]?.headers["x-genex-chat"], "default");
    other.close();
  });
});
