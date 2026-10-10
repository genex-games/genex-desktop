import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { GenexTools, validateGenexRequest, parseGenexJson } from "../../src/plugins/genex/adapter.ts";

const credentials = new Map<
  string,
  { token: string | null; get(): Promise<string | null>; set(token: string): Promise<void>; clear(): Promise<void> }
>();
function fixtureCredentials(root: string) {
  let store = credentials.get(root);
  if (!store) {
    store = {
      token: null,
      async get() {
        return this.token;
      },
      async set(token) {
        this.token = token;
      },
      async clear() {
        this.token = null;
      },
    };
    credentials.set(root, store);
  }
  return store;
}
function fixtureTools(root: string, api: string) {
  return new GenexTools(root, api, { credentials: fixtureCredentials(root) });
}

describe("host-owned Genex tools", () => {
  it("rejects hosted commands, account flags and agent approvals", () => {
    for (const operation of ["publish", "init", "auth", "budget"])
      assert.throws(() => validateGenexRequest({ operation }));
    assert.throws(() =>
      validateGenexRequest({ operation: "model.rig", id: "--api-url", prompt: "https://example.invalid" }),
    );
    for (const key of ["user-approved", "out-dir", "env", "api-url", "approve-remesh"])
      assert.throws(() => validateGenexRequest({ operation: "model", options: { [key]: "x" } }));
    validateGenexRequest({ operation: "creature.animate", id: "existing", options: { action: "walk", lean: true } });
    validateGenexRequest({ operation: "creature", prompt: "fixture", options: { animation: [466, "walk"] } });
    assert.throws(() => validateGenexRequest({ operation: "creature", options: { animation: ["--user-approved"] } }));
    assert.deepEqual(parseGenexJson('progress\n{\n"id":"123"\n}\n'), { id: "123" });
  });
  it("runs the real pinned CLI against a fixture API; ambiguous creation is recovered without a second debit", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-"));
    let creates = 0;
    let requestId = "";
    const calls: string[] = [];
    const server = http.createServer(async (req, res) => {
      let body = "";
      for await (const b of req) body += b;
      calls.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      const send = (v: unknown, status = 200) => {
        res.statusCode = status;
        res.end(JSON.stringify(v));
      };
      if (req.url === "/api/credits/me")
        return send({
          balance: 100,
          spendable: 100,
          reserved: 0,
          unlimited: false,
          prices: { model: 3 },
          budget: { cap: 100 },
        });
      if (req.url === "/api/generations/lanes")
        return send({ paused: false, lanes: [{ kind: "model", provider: "fixture", mock: false, credit: "ok" }] });
      if (req.url === "/api/generations/quote") return send({ creditsQuoted: 3 });
      if (req.url === "/api/generations" && req.method === "POST") {
        creates++;
        requestId = JSON.parse(body).requestId;
        return send({ error: "lost response" }, 500);
      }
      if (req.url === `/api/generations/requests/${requestId}` && requestId)
        return send({ id: "fixture-generation", creditsQuoted: 3, status: "pending" });
      if (req.url?.includes("terms") || req.url?.includes("legal"))
        return send({ accepted: true, required: "1", acceptedVersion: "1" });
      return send({ error: "not_found" }, 404);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const api = `http://127.0.0.1:${(server.address() as any).port}`;
    try {
      const tools = fixtureTools(path.join(root, "host"), api);
      await tools.init();
      await fixtureCredentials(tools.root).set("fixture-token");
      const game = path.join(root, "game");
      await mkdir(game);
      const request = { operation: "model", prompt: "fixture cottage" };
      const first = (await tools.execute("fixture", game, request)) as any;
      assert.equal(first.status, "unresolved", JSON.stringify({ first, calls }));
      const second = (await tools.execute("fixture", game, request)) as any;
      assert.equal(second.generationId, "fixture-generation", JSON.stringify({ second, calls }));
      assert.equal(creates, 1);
      assert.ok(
        !(await readFile(path.join(tools.root, "projects/fixture/jobs", first.id, "job.json"), "utf8")).includes(
          "fixture-token",
        ),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(root, { recursive: true, force: true });
    }
  });
});

it("does not submit signed-out or already stopped work, and keeps validation failures distinct from uncertain submissions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-stop-"));
  try {
    const tools = fixtureTools(path.join(root, "host"), "http://127.0.0.1:1");
    await tools.init();
    await assert.rejects(tools.execute("game", root, { operation: "model", prompt: "x" }), /Connect Genex/);

    await assert.rejects(
      tools.execute("game", root, { operation: "model", prompt: "x" }, AbortSignal.abort()),
      /Stopped before/,
    );
    await fixtureCredentials(tools.root).set("fixture-token");
    const failed = (await tools.execute("game", root, {
      operation: "image",
      options: { edit: "../outside-secret.png" },
    })) as any;
    assert.equal(failed.status, "failed");
    const approval = (await tools.execute("game", root, { operation: "character.finalize", id: "candidate" })) as any;
    assert.equal(approval.status, "failed", "missing approval views fail closed");
    await assert.rejects(tools.approve("game", approval.id), /no longer pending/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("uses server credit admission across parallel requests without a Studio allowance and retrieves after reopening without charging again", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-concurrent-"));
  let creates = 0;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=",
    "base64",
  );
  let api = "";
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/credits/me")
      return send({ balance: 100, spendable: 100, reserved: 0, unlimited: false, prices: { image: 3 } });
    if (req.url === "/api/generations/quote") return send({ creditsQuoted: 3 });
    if (req.url === "/api/generations" && req.method === "POST") {
      if (creates) return send({ message: "Insufficient credits" }, 402);
      creates++;
      return send({ id: "existing-image", status: "pending", creditsQuoted: 3 });
    }
    if (req.url === "/api/generations/existing-image")
      return send({
        generation: {
          id: "existing-image",
          kind: "image",
          prompt: "fixture image",
          status: "completed",
          progress: 100,
          mocked: false,
          files: [{ role: "image.png", ext: "png", contentType: "image/png", url: api + "/asset.png" }],
        },
      });
    if (req.url === "/asset.png") {
      res.setHeader("content-type", "image/png");
      return res.end(png);
    }
    return send({ error: "not_found" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  api = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const tools = fixtureTools(path.join(temp, "host"), api);
    await tools.init();
    await fixtureCredentials(tools.root).set("fixture-token");
    const game = path.join(temp, "game");
    await mkdir(game);
    const results = (await Promise.all(
      ["sun", "moon"].map((prompt) => tools.execute("same-project", game, { operation: "image", prompt })),
    )) as any[];
    assert.equal(creates, 1, JSON.stringify(results));
    assert.deepEqual(results.map((r) => r.status).sort(), ["accepted", "failed"]);
    const loaded = (await tools.execute("same-project", game, { operation: "wait", id: "existing-image" })) as any;
    assert.equal(loaded.status, "downloaded", JSON.stringify(loaded));
    assert.equal(loaded.files.length, 1);
    assert.deepEqual(await readFile(path.join(game, loaded.files[0])), png);
    const reopened = fixtureTools(tools.root, api);
    const again = (await reopened.execute("same-project", game, { operation: "wait", id: "existing-image" })) as any;
    assert.equal(again.status, "downloaded", JSON.stringify(again));
    assert.equal(creates, 1, "retrieval is not another generation");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(temp, { recursive: true, force: true });
  }
});

it("disconnect wins over an authorization response already in flight", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-auth-"));
  let reply: (() => void) | undefined, seen!: () => void;
  const polling = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/cli/device/start")
      return res.end(
        JSON.stringify({
          deviceCode: "private-code",
          userCode: "PUBLIC",
          verifyUrl: "https://genex.games/verify",
          expiresIn: 600,
          interval: 5,
        }),
      );
    if (req.url === "/api/cli/device/poll") {
      reply = () => res.end(JSON.stringify({ status: "approved", token: "fixture-token" }));
      seen();
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const tools = fixtureTools(temp, `http://127.0.0.1:${(server.address() as any).port}`);
    await tools.connect();
    const status = tools.status();
    await polling;
    await tools.disconnect();
    reply!();
    assert.equal((await status).connected, false);
    assert.equal(await readFile(path.join(temp, "credentials.env"), "utf8").catch(() => null), null);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(temp, { recursive: true, force: true });
  }
});

it("shows all character candidates before a real UI selection can authorize the chosen preview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-approval-"));
  let creates = 0;
  let chosen = 0;
  const originalFetch = globalThis.fetch;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    const send = (v: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.url === "/api/generations/concept")
      return send({
        generation: {
          id: "concept",
          kind: "character_concept",
          status: "completed",
          prompt: "a character",
          progress: 100,
          files: [1, 2, 3].map((n) => ({
            role: `concept-candidate-${n}`,
            ext: "png",
            contentType: "image/png",
            url: `https://assets.genex.technology/concept/${n}.png`,
          })),
        },
      });
    if (req.url === "/api/credits/me")
      return send({ balance: 100, spendable: 100, reserved: 0, unlimited: false, prices: { character_preview: 3 } });
    if (req.url === "/api/characters/concepts/concept/previews/quote")
      return send({ quote: { credits: 3, candidateIndex: JSON.parse(body).candidateIndex, providerModel: "fixture" } });
    if (req.url === "/api/characters/concepts/concept/previews") {
      creates++;
      const data = JSON.parse(body);
      chosen = data.candidateIndex;
      assert.equal(data.userApproved, true);
      return send({ id: "preview", status: "pending", creditsQuoted: 3 });
    }
    return send({ error: "not_found" }, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  globalThis.fetch = async (input, init) =>
    String(input).startsWith("https://assets.genex.technology/")
      ? new Response(Buffer.from("fixture image"), { headers: { "content-type": "image/png" } })
      : originalFetch(input, init);
  try {
    const tools = fixtureTools(path.join(root, "host"), `http://127.0.0.1:${(server.address() as any).port}`);
    await tools.init();
    await fixtureCredentials(tools.root).set("fixture-token");
    const game = path.join(root, "game");
    await mkdir(game);
    const request = (await tools.execute("game", game, {
      operation: "character.preview",
      id: "concept",
      options: { candidate: 1 },
    })) as any;
    assert.equal(request.status, "approval_required", JSON.stringify(request));
    assert.equal(creates, 0);
    assert.equal(JSON.stringify(request).includes("data:image"), false, "approval pixels do not enter model prompts");
    const saved = JSON.parse(
      await readFile(path.join(tools.root, "projects/game/jobs", request.id, "job.json"), "utf8"),
    );
    assert.deepEqual(
      saved.approval.images.map((image: any) => image.label),
      ["1", "2", "3"],
    );
    await assert.rejects(tools.approve("game", request.id), /Choose candidate/);
    assert.equal(creates, 0);
    const attempts = await Promise.allSettled([
      tools.approve("game", request.id, 3),
      tools.approve("game", request.id, 3),
    ]);
    assert.equal(
      attempts.filter((result) => result.status === "fulfilled").length,
      1,
      "one UI approval can authorize only one create",
    );
    const approved = (attempts.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    assert.equal(approved.status, "accepted", JSON.stringify(approved));
    assert.equal(creates, 1);
    assert.equal(chosen, 3, "the UI choice wins over the agent suggestion");
    await assert.rejects(tools.approve("game", request.id, 3), /no longer pending/);
  } finally {
    globalThis.fetch = originalFetch;
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

it("Stop after acceptance preserves the generation and reopening reconciles it without another create", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-accepted-stop-"));
  let creates = 0,
    hold = false,
    seen!: () => void;
  const polled = new Promise<void>((resolve) => {
    seen = resolve;
  });
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/credits/me")
      return send({ balance: 100, spendable: 100, reserved: 0, unlimited: false, prices: { image: 3 } });
    if (req.url === "/api/generations/quote") return send({ creditsQuoted: 3 });
    if (req.url === "/api/generations" && req.method === "POST") {
      creates++;
      return send({ id: "accepted-before-stop", status: "pending", creditsQuoted: 3 });
    }
    if (req.url === "/api/generations/accepted-before-stop") {
      if (hold) {
        seen();
        return;
      }
      return send({ generation: { id: "accepted-before-stop", kind: "image", status: "completed", files: [] } });
    }
    if (req.url === "/api/auth/get-session") return send({ user: { email: "fixture@example.test" } });
    if (req.url === "/api/generations/lanes") return send({ lanes: [] });
    if (req.url === "/api/legal/status") return send({ accepted: true });
    send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const tools = fixtureTools(path.join(temp, "host"), api);
    await fixtureCredentials(tools.root).set("fixture-token");
    const game = path.join(temp, "game");
    await mkdir(game);
    const accepted = (await tools.execute("game", game, { operation: "image", prompt: "fixture" })) as any;
    assert.equal(accepted.generationId, "accepted-before-stop");
    assert.equal(accepted.status, "accepted");
    hold = true;
    const waiting = tools.execute("game", game, { operation: "wait", id: accepted.generationId });
    await polled;
    tools.cancel("game");
    const stopped = (await waiting) as any;
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.generationId, accepted.generationId);
    hold = false;
    const reopened = fixtureTools(tools.root, api);
    const status = await reopened.status("game");
    assert.equal(status.jobs.find((job) => job.id === accepted.id)?.remoteStatus, "completed");
    assert.equal(creates, 1);
    assert.equal(status.jobs[0]?.creditsRefunded, undefined, "local Stop does not invent a refund");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(temp, { recursive: true, force: true });
  }
});

it("reconciling an accepted job names only completed, processing and pending remotely; other remote statuses stay as they came", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-reconcile-"));
  let remote = "pending";
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (req.url === "/api/credits/me")
      return send({ balance: 100, spendable: 100, reserved: 0, unlimited: false, prices: { image: 3 } });
    if (req.url === "/api/generations/quote") return send({ creditsQuoted: 3 });
    if (req.url === "/api/generations" && req.method === "POST")
      return send({ id: "reconciled", status: "pending", creditsQuoted: 3 });
    if (req.url === "/api/generations/reconciled")
      return send({ generation: { id: "reconciled", kind: "image", status: remote, files: [] } });
    if (req.url === "/api/auth/get-session") return send({ user: { email: "fixture@example.test" } });
    if (req.url === "/api/generations/lanes") return send({ lanes: [] });
    if (req.url === "/api/legal/status") return send({ accepted: true });
    send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const tools = fixtureTools(path.join(temp, "host"), api);
    await fixtureCredentials(tools.root).set("fixture-token");
    const game = path.join(temp, "game");
    await mkdir(game);
    const accepted = (await tools.execute("game", game, { operation: "image", prompt: "fixture" })) as any;
    assert.equal(accepted.status, "accepted");
    // `completed` is Genex's last word on a generation, so it comes last: later reads remember it.
    const expected: [string, string][] = [
      ["processing", "generating"],
      ["pending", "accepted"],
      ["queued", "queued"],
      ["running", "running"],
      ["completed", "generated"],
    ];
    for (const [remoteStatus, jobStatus] of expected) {
      remote = remoteStatus;
      const job = (await tools.status("game")).jobs.find((x) => x.id === accepted.id);
      assert.equal(job?.remoteStatus, remoteStatus);
      assert.equal(job?.status, jobStatus, `remote ${remoteStatus}`);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(temp, { recursive: true, force: true });
  }
});

/** A Genex API that answers a status read and counts every request it is sent, by route. */
async function countingGenex(
  generation: (id: string) => string | undefined,
  request: (id: string) => string | undefined,
) {
  const hits = new Map<string, number>();
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const url = req.url ?? "";
    hits.set(url, (hits.get(url) ?? 0) + 1);
    const send = (value: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(value));
    };
    if (url === "/api/auth/get-session") return send({ user: { email: "fixture@example.test" } });
    if (url === "/api/legal/status") return send({ accepted: true });
    if (url === "/api/credits/me")
      return send({
        balance: 100,
        spendable: 100,
        reserved: 0,
        unlimited: false,
        prices: { image: 3 },
        budget: { cap: 100 },
      });
    if (url === "/api/generations/lanes") return send({ lanes: [] });
    const found = /^\/api\/generations\/requests\/([\w-]+)$/.exec(url);
    const foundId = found?.[1] ? request(found[1]) : undefined;
    if (foundId) return send({ id: foundId, status: generation(foundId), creditsQuoted: 3 });
    const id = /^\/api\/generations\/([\w-]+)$/.exec(url)?.[1];
    const remote = id ? generation(id) : undefined;
    if (id && remote) return send({ generation: { id, kind: "image", status: remote, files: [] } });
    send({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = `http://127.0.0.1:${(server.address() as any).port}`;
  /** The requests made while `read` ran, by route. */
  const during = async (read: () => Promise<unknown>) => {
    hits.clear();
    await read();
    return new Map(hits);
  };
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  };
  return { api, during, close };
}

const total = (hits: Map<string, number>) => [...hits.values()].reduce((a, b) => a + b, 0);
/** A job id for the n-th record: a UUID, as Studio's job folders are. */
const jobId = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

it("a status read asks Genex only about generations it has not seen settle, however many finished jobs the game has", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-settled-"));
  const FINISHED = 60;
  const GENERIC = 2;
  const remote = (id: string) => {
    const n = Number(/^done-(\d+)$/.exec(id)?.[1]);
    if (Number.isInteger(n)) return n % 4 ? "completed" : "failed";
    return /^found-\d+$/.test(id) ? "completed" : undefined;
  };
  const genex = await countingGenex(remote, (requestId) => requestId.replace("req-", "found-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    const tools = fixtureTools(path.join(temp, "host"), genex.api);
    await fixtureCredentials(tools.root).set("fixture-token");
    const cwd = path.join(tools.root, "projects", "game");
    const record = async (n: number, job: Record<string, unknown>) => {
      const id = jobId(n);
      await mkdir(path.join(cwd, "jobs", id), { recursive: true });
      const createdAt = new Date(Date.UTC(2026, 9, 9, 0, 0, n)).toISOString();
      await writeFile(
        path.join(cwd, "jobs", id, "job.json"),
        JSON.stringify({ id, project: "game", files: [], createdAt, ...job }),
      );
    };
    for (let n = 1; n <= FINISHED; n++)
      await record(n, { operation: "image", status: "accepted", generationId: `done-${n}` });
    // A create whose answer was lost: only the CLI's generic reservation names it.
    const ledger: string[] = [];
    for (let g = 1; g <= GENERIC; g++) {
      const n = FINISHED + g;
      await record(n, { operation: "model", status: "unresolved" });
      ledger.push(
        JSON.stringify({
          t: "reserve",
          id: `req-${g}`,
          out: path.join(cwd, "jobs", jobId(n), "output"),
          credits: 3,
          generic: true,
        }),
      );
    }
    await mkdir(path.join(cwd, ".genex"), { recursive: true });
    await writeFile(path.join(cwd, ".genex/generations.ndjson"), `${ledger.join("\n")}\n`);
    // The incident's shape: an approved character review stays `approved` once its run moved on.
    await record(FINISHED + GENERIC + 1, {
      operation: "character.finalize",
      status: "approved",
      approval: { sourceId: "preview-1", images: [{ label: "front", dataUrl: "data:image/png;base64,AA==" }] },
    });

    let first: Awaited<ReturnType<GenexTools["status"]>> | undefined;
    const firstHits = await genex.during(async () => {
      first = await tools.status("game");
    });
    for (let n = 1; n <= FINISHED; n++) assert.equal(firstHits.get(`/api/generations/done-${n}`), 1, `done-${n}`);
    assert.equal(firstHits.get("/api/generations/requests/req-1"), 1);
    assert.equal(firstHits.get("/api/generations/found-1"), 1);

    let second: Awaited<ReturnType<GenexTools["status"]>> | undefined;
    const secondHits = await genex.during(async () => {
      second = await tools.status("game");
    });
    const baseline = await genex.during(() => tools.status("empty"));
    assert.equal(second?.error, undefined, "the account read itself succeeded");
    const asked = [...secondHits.keys()].filter(
      (url) => url.startsWith("/api/generations/") && url !== "/api/generations/lanes",
    );
    assert.deepEqual(asked, [], "no settled generation or found reservation is asked about again");
    assert.equal(total(secondHits), total(baseline), "a read costs what a game with no jobs costs");
    assert.deepEqual(second?.jobs, first?.jobs, "a remembered answer shows the jobs exactly as a fresh one did");
    assert.equal(second?.jobs.find((job) => job.generationId === "done-4")?.status, "failed");
    assert.equal(second?.jobs.find((job) => job.generationId === "done-5")?.status, "generated");
    assert.equal(second?.jobs.find((job) => job.generationId === "found-1")?.status, "generated");

    // Signing out forgets them: the next account asks Genex afresh.
    await tools.disconnect();
    await fixtureCredentials(tools.root).set("fixture-token");
    const afterSignIn = await genex.during(() => tools.status("game"));
    assert.equal(afterSignIn.get("/api/generations/done-1"), 1);
  } finally {
    await genex.close();
    await rm(temp, { recursive: true, force: true });
  }
});

it("a generation Genex is still working on is asked about on every read until it settles", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-moving-"));
  let remote = "pending";
  const genex = await countingGenex(
    (id) => (id === "moving" ? remote : undefined),
    () => undefined,
  );
  try {
    const { writeFile } = await import("node:fs/promises");
    const tools = fixtureTools(path.join(temp, "host"), genex.api);
    await fixtureCredentials(tools.root).set("fixture-token");
    const dir = path.join(tools.root, "projects", "game", "jobs", jobId(1));
    await mkdir(dir, { recursive: true });
    const createdAt = new Date().toISOString();
    const job = { id: jobId(1), project: "game", operation: "image", status: "accepted", generationId: "moving" };
    await writeFile(path.join(dir, "job.json"), JSON.stringify({ ...job, files: [], createdAt }));
    const reads: [string, string, number][] = [
      ["pending", "accepted", 1],
      ["processing", "generating", 1],
      ["processing", "generating", 1],
      ["completed", "generated", 1],
      ["completed", "generated", 0],
    ];
    for (const [answer, shown, asked] of reads) {
      remote = answer;
      let status: Awaited<ReturnType<GenexTools["status"]>> | undefined;
      const hits = await genex.during(async () => {
        status = await tools.status("game");
      });
      assert.equal(hits.get("/api/generations/moving") ?? 0, asked, `remote ${answer}`);
      assert.equal(status?.jobs[0]?.status, shown, `remote ${answer}`);
    }
  } finally {
    await genex.close();
    await rm(temp, { recursive: true, force: true });
  }
});

it("reports expired login honestly and quote refusals never become create submissions", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-errors-"));
  let quoteStatus = 402,
    expired = false,
    creates = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    const send = (v: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(v));
    };
    if (req.url === "/api/auth/get-session")
      return send(expired ? { error: "expired" } : { user: { email: "fixture@example.test" } }, expired ? 401 : 200);
    if (req.url === "/api/credits/me")
      return send({ balance: 100, spendable: 100, reserved: 0, unlimited: false, prices: { image: 3 } });
    if (req.url === "/api/generations/quote")
      return send(
        {
          error:
            quoteStatus === 402 ? "insufficient_credits" : quoteStatus === 503 ? "lane_unavailable" : "quote_failed",
        },
        quoteStatus,
      );
    if (req.url === "/api/generations" && req.method === "POST") {
      creates++;
      return send({}, 500);
    }
    send({}, 404);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const tools = fixtureTools(path.join(temp, "host"), `http://127.0.0.1:${(server.address() as any).port}`);
    await fixtureCredentials(tools.root).set("fixture-token");
    const game = path.join(temp, "game");
    await mkdir(game);
    for (const code of [402, 503, 500]) {
      quoteStatus = code;
      const job = (await tools.execute("game", game, { operation: "image", prompt: "fixture" })) as any;
      assert.equal(job.status, "failed", JSON.stringify(job));
      assert.equal(job.generationId, undefined);
      assert.equal(creates, 0);
    }
    expired = true;
    const status = await tools.status();
    assert.equal(status.connected, false);
    assert.match(status.error!, /expired.*Reconnect/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(temp, { recursive: true, force: true });
  }
});

it("disconnect blocks a new submission even while protected credential deletion is still pending", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-disconnect-"));
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deleting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const tools = fixtureTools(path.join(temp, "host"), "http://127.0.0.1:1");
  const store = fixtureCredentials(tools.root);
  const originalClear = store.clear;
  store.clear = async () => {
    entered();
    await gate;
    await originalClear.call(store);
  };
  let disconnect: Promise<void> | undefined;
  try {
    await store.set("fixture-token");
    disconnect = tools.disconnect();
    await deleting;
    const job = (await tools.execute("game", temp, { operation: "image", prompt: "fixture" })) as any;
    assert.equal(job.status, "failed");
    assert.match(job.error, /Connect Genex Tools first/);
    assert.equal(job.requestId, undefined);
  } finally {
    release();
    await disconnect;
    await rm(temp, { recursive: true, force: true });
  }
});

it("reuses session identity during status polling but refreshes credits and rejects expired credentials", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-status-"));
  let sessions = 0,
    creditReads = 0,
    expired = false;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/get-session") {
      sessions++;
      res.end(JSON.stringify({ user: { email: "fixture@example.invalid" } }));
    } else if (req.url === "/api/credits/me") {
      creditReads++;
      res.statusCode = expired ? 401 : 200;
      res.end(JSON.stringify(expired ? { error: "expired" } : { balance: 100 - creditReads }));
    } else res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tools = fixtureTools(root, `http://127.0.0.1:${(server.address() as any).port}`);
    await fixtureCredentials(root).set("first");
    assert.equal((await tools.status()).balance, 99);
    assert.equal((await tools.status()).balance, 98);
    assert.equal(sessions, 1, "idle/job polling does not repeatedly hit the sign-in endpoint");
    await fixtureCredentials(root).set("second");
    await tools.status();
    assert.equal(sessions, 2, "a changed account cannot reuse another identity");
    expired = true;
    assert.equal((await tools.status()).connected, false, "cached identity never hides a rejected credential");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves authoritative unlimited entitlement and distinguishes credit errors from account failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-entitlement-"));
  let response: Record<string, unknown> = { balance: 460, unlimited: true };
  let status = 200;
  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/auth/get-session")
      return res.end(JSON.stringify({ user: { email: "fixture@example.invalid" } }));
    if (req.url === "/api/credits/me") {
      res.statusCode = status;
      return res.end(JSON.stringify(response));
    }
    res.end(JSON.stringify({ accepted: true }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const tools = fixtureTools(root, `http://127.0.0.1:${(server.address() as any).port}`);
    await fixtureCredentials(root).set("fixture");
    for (const balance of [460, 0]) {
      response = { balance, unlimited: true };
      const s = await tools.status();
      assert.equal(s.unlimited, true);
      assert.equal(s.balance, balance);
      assert.equal(s.accountVerified, true);
    }
    response = { balance: 0, unlimited: false };
    assert.equal((await tools.status()).unlimited, false);
    response = {};
    assert.equal((await tools.status()).unlimited, undefined);
    status = 503;
    const unavailable = await tools.status();
    assert.equal(unavailable.connected, true);
    assert.equal(unavailable.accountVerified, true);
    assert.equal(unavailable.balance, null);
    assert.ok(unavailable.error);
    status = 401;
    const expired = await tools.status();
    assert.equal(expired.connected, false);
    assert.equal(expired.accountVerified, false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await rm(root, { recursive: true, force: true });
  }
});

it("names the local copy when a worker-delivered job is inspected from another workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-genex-elsewhere-"));
  try {
    const { writeFile } = await import("node:fs/promises");
    let observed = 0;
    const tools = new GenexTools(path.join(root, "home"), "http://127.0.0.1:9", {
      credentials: fixtureCredentials(root),
      observe: async (_project, _root, files) => {
        observed++;
        return { image: Buffer.from("frame"), loadedFiles: files, consoleAvailable: true };
      },
    });
    const jobs = path.join(root, "home", "projects", "tanks", "jobs"),
      build = path.join(root, "integration");
    const lead = "11111111-1111-4111-8111-111111111111",
      worker = "22222222-2222-4222-8222-222222222222";
    const job = (id: string) => ({
      id,
      project: "tanks",
      operation: "wait",
      status: "downloaded",
      generationId: "gen-1",
      files: [`assets/genex/${id}/boom.mp3`],
      createdAt: new Date().toISOString(),
    });
    for (const id of [lead, worker]) {
      await mkdir(path.join(jobs, id), { recursive: true });
      await writeFile(path.join(jobs, id, "job.json"), JSON.stringify(job(id)));
    }
    await mkdir(path.join(build, "assets/genex", lead), { recursive: true });
    await writeFile(path.join(build, "assets/genex", lead, "boom.mp3"), "mp3");
    await assert.rejects(
      tools.execute("tanks", build, { operation: "inspect_use", id: worker }),
      new RegExp(`another workspace.*Job ${lead} has the same generation here`),
    );
    assert.equal(observed, 0);
    await rm(path.join(build, "assets/genex", lead), { recursive: true });
    await assert.rejects(
      tools.execute("tanks", build, { operation: "inspect_use", id: worker }),
      /after that work lands, or use wait with generationId gen-1/,
    );
    await mkdir(path.join(build, "assets/genex", worker), { recursive: true });
    await writeFile(path.join(build, "assets/genex", worker, "boom.mp3"), "mp3");
    await tools.execute("tanks", build, { operation: "inspect_use", id: worker });
    assert.equal(observed, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
