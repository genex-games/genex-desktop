// A generation that failed at its provider comes back to the agent typed (B8). In the body-cam run
// a Meshy character ("not a valid GLB v2") and a Tripo animate ("Invalid input parameter") were
// answered to `wait` as `retrieval_failed` with the generation's raw JSON in `error`, which reads
// as "try fetching again". The job now says the generation failed, of which kind, the provider's
// own words, and what to do next, by the generation's `status` and `kind` fields (never its text).
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { GENEX_FAILURE_NEXT, GenexFailureCode, GenexJobStatus, type GenexJob } from "../../src/shared/genex.ts";
import { CreditKind } from "../../src/shared/play-credits.ts";

/** A fixture credential store holding one token. */
function credentials() {
  return {
    token: "fixture-token" as string | null,
    async get() {
      return this.token;
    },
    async set(token: string) {
      this.token = token;
    },
    async clear() {
      this.token = null;
    },
  };
}

/** Genex's fixture API: every generation it is asked about is `generations[id]`. */
async function fixtureApi(generations: Record<string, Record<string, unknown>>) {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {
    }
    res.setHeader("content-type", "application/json");
    const id = /^\/api\/generations\/([\w-]+)$/.exec(req.url ?? "")?.[1];
    const generation = id === undefined ? undefined : generations[id];
    if (req.url === "/api/credits/me") return res.end(JSON.stringify({ balance: 100, spendable: 100, reserved: 0 }));
    if (generation) return res.end(JSON.stringify({ generation: { id, ...generation } }));
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not_found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return { api: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close };
}

/** `wait` on each generation of the fixture API, through the real pinned CLI. */
async function waitFor(generations: Record<string, Record<string, unknown>>, ids: string[]): Promise<GenexJob[]> {
  const temp = await mkdtemp(path.join(os.tmpdir(), "studio-genex-failure-"));
  const { api, close } = await fixtureApi(generations);
  try {
    const tools = new GenexTools(path.join(temp, "host"), api, { credentials: credentials() });
    await tools.init();
    const game = path.join(temp, "game");
    await mkdir(game);
    const jobs: GenexJob[] = [];
    for (const id of ids) jobs.push((await tools.execute("body-cam", game, { operation: "wait", id })) as GenexJob);
    return jobs;
  } finally {
    await close();
    await rm(temp, { recursive: true, force: true });
  }
}

describe("a generation its provider failed, as `wait` answers it", () => {
  it("is failed, not a retrieval failure, with its kind, the provider's words and what to do next", async () => {
    const [meshy, tripo] = await waitFor(
      {
        "meshy-character": {
          kind: CreditKind.Character,
          status: "failed",
          error: "Meshy output is not a valid GLB v2 file",
        },
        "tripo-animate": {
          kind: CreditKind.ModelAnimation,
          status: "failed",
          error: "tripo task 8e4a: Invalid input parameter",
        },
      },
      ["meshy-character", "tripo-animate"],
    );
    assert.equal(meshy?.status, GenexJobStatus.Failed, JSON.stringify(meshy));
    assert.equal(meshy?.failure?.code, GenexFailureCode.GenerationFailed);
    assert.equal(meshy?.failure?.kind, CreditKind.Character);
    assert.equal(meshy?.failure?.providerError, "Meshy output is not a valid GLB v2 file");
    assert.equal(meshy?.failure?.next, GENEX_FAILURE_NEXT[CreditKind.Character]);
    assert.equal(tripo?.status, GenexJobStatus.Failed, JSON.stringify(tripo));
    assert.equal(tripo?.failure?.kind, CreditKind.ModelAnimation);
    assert.equal(tripo?.failure?.next, GENEX_FAILURE_NEXT[CreditKind.ModelAnimation]);
  });

  it("a generation the fixture does not know is still a retrieval failure, with no provider failure", async () => {
    const [unknown] = await waitFor({}, ["no-such-generation"]);
    assert.equal(unknown?.status, GenexJobStatus.RetrievalFailed, JSON.stringify(unknown));
    assert.equal(unknown?.failure, undefined);
  });
});
