/**
 * A publish whose outcome Studio does not know is never retried automatically, but it must be
 * possible to settle it: 'unresolved' used to block every later upload for the game, and
 * "Check again" could not clear it. Genex's own record decides: when the hosted staging revision
 * is still the last one Studio knew, the upload did not land and a new one is allowed; when it
 * moved, the upload is recorded and verified. The user can also settle it explicitly.
 *
 * GenexTools runs against the fixture Genex API. A preload that exits before the CLI starts
 * stands in for a CLI that fails after Studio considered the upload submitted.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { createGenexPlugin } from "../../src/plugins/genex/backend.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import type { GenexPublishState } from "../../src/shared/genex.ts";
import { startGenexFixtureApi, type GenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "fixture";
const SLUG = "fixture-game";
const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/**
 * Publishing checks for git and git-lfs before it starts the CLI, and nothing after that runs git
 * (the fixture CLI exits first). A `git` that answers yes to both keeps the catch-path tests
 * running on a machine or CI image without git-lfs, instead of skipping them there.
 */
async function withFixtureGit<T>(fn: () => Promise<T>): Promise<T> {
  const bin = await tmpDir("studio-genex-git-");
  await writeFile(path.join(bin, "git"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(bin, "git"), 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${previous ?? ""}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = previous;
  }
}

/** A hosted game whose staging revision the test moves; `answer` overrides the by-slug reply. */
async function hosted(
  options: { revision?: string | null; status?: "draft" | "published"; answer?: "missing" | "down" } = {},
) {
  const hostedGame = { revision: options.revision === undefined ? "r1" : options.revision };
  const server = await startGenexFixtureApi(({ url }, reply) => {
    if (url === `/api/projects/by-slug/${SLUG}`) {
      if (options.answer === "missing") return reply.json({ error: "not_found" }, 404);
      if (options.answer === "down") return reply.json({ error: "unavailable" }, 503);
      return reply.json({
        project: { slug: SLUG, status: options.status ?? "draft", stagingCommitSha: hostedGame.revision },
      });
    }
  });
  servers.push(server);
  return { server, hostedGame };
}

/** Studio's publish workspace as a previous session left it: a draft verified at `r1`, and `job`. */
async function tools(api: string, job?: GenexPublishState["job"], options: { cliDelayMs?: number } = {}) {
  const root = await tmpDir("studio-genex-settle-");
  const failingCli = path.join(root, "cli-fails.mjs");
  const fail = "process.stderr.write('fixture: network error after submit\\n');process.exit(3);";
  await writeFile(
    failingCli,
    options.cliDelayMs ? `setTimeout(() => { ${fail} }, ${options.cliDelayMs});\n` : `${fail}\n`,
  );
  let token: string | null = "fixture-token";
  const genex = new GenexTools(path.join(root, "host"), api, {
    credentials: {
      get: async () => token,
      set: async (t) => {
        token = t;
      },
      clear: async () => {
        token = null;
      },
    },
    preload: failingCli,
  });
  const dir = path.join(genex.root, "publish", PROJECT);
  await mkdir(path.join(dir, ".genex"), { recursive: true });
  await writeFile(path.join(dir, ".genex", "project.json"), JSON.stringify({ slug: SLUG, id: "p1", status: "draft" }));
  const state: GenexPublishState = {
    version: 1,
    project: PROJECT,
    connected: true,
    readyDraft: {
      revision: "r1",
      url: "https://genex.games/draft/fixture-game",
      digest: "d1",
      verifiedAt: "2026-09-22T10:00:00.000Z",
    },
    ...(job ? { job } : {}),
  };
  await writeFile(path.join(dir, "publish.json"), JSON.stringify(state));
  const saved = async () => JSON.parse(await readFile(path.join(dir, "publish.json"), "utf8")) as GenexPublishState;
  return { genex, saved };
}

const interruptedUpload = (): NonNullable<GenexPublishState["job"]> => ({
  id: "job-before-quit",
  kind: "draft",
  state: "running",
  phase: "uploading",
  startedAt: "2026-09-23T09:00:00.000Z",
});

describe("settling a Genex publish whose outcome is unknown", () => {
  it("after a quit mid-upload, Check again finds the hosted draft unchanged and allows a new upload", async () => {
    const { server } = await hosted({ revision: "r1" });
    const { genex } = await tools(server.url, interruptedUpload());
    const restarted = await genex.publishStatus(PROJECT);
    assert.equal(restarted.job?.state, "unresolved", "a restart alone never permits a retry");
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "failed", JSON.stringify(checked.job));
    assert.match(checked.job?.error ?? "", /did not reach Genex/);
  });

  it("after a quit mid-upload, Check again records an upload the hosted revision shows landed", async () => {
    const { server } = await hosted({ revision: "r2" });
    const { genex, saved } = await tools(server.url, interruptedUpload());
    await genex.publishStatus(PROJECT);
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.expectedStagingRevision, "r2");
    assert.ok(checked.job?.uploadedAt, "the upload is recorded");
    assert.notEqual(checked.job?.state, "failed", "a landed upload is never reported as failed");
    assert.equal((await saved()).job?.expectedStagingRevision, "r2");
  });

  it("Check again settles a lost draft whose hosted project does not exist, and waits when Genex cannot answer", async () => {
    const missing = await hosted({ answer: "missing" });
    const gone = await tools(missing.server.url, interruptedUpload());
    await gone.genex.publishStatus(PROJECT);
    assert.equal((await gone.genex.publishStatus(PROJECT, true)).job?.state, "failed");

    const down = await hosted({ answer: "down" });
    const waiting = await tools(down.server.url, interruptedUpload());
    await waiting.genex.publishStatus(PROJECT);
    const checked = await waiting.genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "unresolved", "no answer is not evidence either way");
    assert.ok(checked.job?.checkError);
  });

  it("a CLI failure after submission, with the hosted draft unchanged, fails instead of locking publishing", () =>
    withFixtureGit(async () => {
      const { server } = await hosted({ revision: "r1" });
      const { genex } = await tools(server.url);
      const started = await genex.publishDraft(PROJECT);
      const settled = await genex.publishWait(PROJECT, started.job!.id);
      assert.equal(settled.job?.state, "failed", JSON.stringify(settled.job));
      const again = await genex.publishDraft(PROJECT);
      assert.notEqual(again.job?.id, started.job!.id, "a new upload starts");
      await genex.publishWait(PROJECT, again.job!.id);
    }));

  it("a CLI failure after an upload that did land stays unresolved: no second upload", () =>
    withFixtureGit(async () => {
      let reads = 0;
      const server = await startGenexFixtureApi(({ url }, reply) => {
        if (url === `/api/projects/by-slug/${SLUG}`)
          return reply.json({
            project: { slug: SLUG, status: "draft", stagingCommitSha: reads++ === 0 ? "r1" : "r2" },
          });
      });
      servers.push(server);
      const { genex } = await tools(server.url);
      const started = await genex.publishDraft(PROJECT);
      const settled = await genex.publishWait(PROJECT, started.job!.id);
      assert.equal(settled.job?.state, "unresolved");
      const blocked = await genex.publishDraft(PROJECT);
      assert.equal(blocked.job?.id, started.job!.id, "no new upload while this one's outcome is open");
    }));

  // The gallery half: listing a game publicly is the upload that must never happen twice by accident.
  const interruptedListing = (phase: "uploading" | "listing" | "promoting"): NonNullable<GenexPublishState["job"]> => ({
    id: "listing-before-quit",
    kind: "gallery",
    state: "running",
    phase,
    startedAt: "2026-09-23T09:00:00.000Z",
  });

  it("Check again on a gallery listing: still a draft on Genex means it did not land, and a new one is allowed", async () => {
    const { server } = await hosted({ revision: "r1", status: "draft" });
    const { genex } = await tools(server.url, interruptedListing("listing"));
    assert.equal((await genex.publishStatus(PROJECT)).job?.state, "unresolved");
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "failed", JSON.stringify(checked.job));
  });

  it("Check again on a gallery listing: published on Genex means it landed, and nothing is uploaded again", async () => {
    const { server } = await hosted({ revision: "r1", status: "published" });
    const { genex, saved } = await tools(server.url, interruptedListing("listing"));
    await genex.publishStatus(PROJECT);
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "done", JSON.stringify(checked.job));
    assert.equal(checked.status, "published");
    assert.equal((await saved()).job?.state, "done");
  });

  it("Check again on a re-promotion Genex cannot tell apart stays unresolved, with the reason", async () => {
    const { server } = await hosted({ revision: "r1", status: "published" });
    const { genex } = await tools(server.url, interruptedListing("promoting"));
    await genex.publishStatus(PROJECT);
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "unresolved", JSON.stringify(checked.job));
    assert.ok(checked.job?.checkError);
  });

  it("Check again on a publish that quit while updating the draft: an unchanged draft did not land", async () => {
    const { server } = await hosted({ revision: "r1", status: "published" });
    const { genex } = await tools(server.url, interruptedListing("uploading"));
    await genex.publishStatus(PROJECT);
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "failed", JSON.stringify(checked.job));
    assert.match(checked.job?.error ?? "", /did not reach Genex/);
  });

  it("Check again on a publish that quit after updating the draft: the public version never changed, so publish again", async () => {
    const { server } = await hosted({ revision: "r2", status: "published" });
    const { genex } = await tools(server.url, interruptedListing("uploading"));
    await genex.publishStatus(PROJECT);
    const checked = await genex.publishStatus(PROJECT, true);
    assert.equal(checked.job?.state, "failed", JSON.stringify(checked.job));
    assert.notEqual(checked.job?.phase, "ready", "a draft alone is not a finished publish");
    assert.match(checked.job?.error ?? "", /public version is unchanged/);
  });

  it("Check again on a gallery listing whose hosted project is gone allows a new one", async () => {
    const { server } = await hosted({ answer: "missing" });
    const { genex } = await tools(server.url, interruptedListing("listing"));
    await genex.publishStatus(PROJECT);
    assert.equal((await genex.publishStatus(PROJECT, true)).job?.state, "failed");
  });

  it("allowing a new upload is refused while the upload is still running here", () =>
    withFixtureGit(async () => {
      const { server } = await hosted({ revision: "r1" });
      const { genex } = await tools(server.url, undefined, { cliDelayMs: 1_500 });
      const started = await genex.publishDraft(PROJECT);
      await assert.rejects(genex.publishAllowNewUpload(PROJECT, started.job!.id), /still running/);
      assert.equal((await genex.publishStatus(PROJECT)).job?.state, "running", "the running upload is left alone");
      await genex.publishWait(PROJECT, started.job!.id);
    }));

  it("the user can settle an unresolved upload explicitly, and only the one they looked at", async () => {
    const { server } = await hosted({ answer: "down" });
    const { genex, saved } = await tools(server.url, {
      ...interruptedUpload(),
      state: "unresolved",
      phase: "unresolved",
    });
    await assert.rejects(genex.publishAllowNewUpload(PROJECT, "some-other-job"), /no longer/);
    assert.equal((await saved()).job?.state, "unresolved");
    const allowed = await genex.publishAllowNewUpload(PROJECT, "job-before-quit");
    assert.equal(allowed.job?.state, "failed");
    assert.equal((await saved()).job?.state, "failed", "the settlement is durable");
  });

  it("a draft whose check keeps failing stays settled once the user allows a new upload", async () => {
    const { server } = await hosted({ revision: "r2" });
    const { genex, saved } = await tools(server.url, {
      ...interruptedUpload(),
      state: "unresolved",
      phase: "unresolved",
      uploadedAt: "2026-09-23T09:01:00.000Z",
      expectedStagingRevision: "r-this-upload",
      stagingUrl: "https://preview--fixture-game.genex.technology/",
      deployment: { id: "job-before-quit", digest: "d2", files: [] },
      nextCheckAt: "2026-09-23T09:02:00.000Z",
    });
    await genex.publishAllowNewUpload(PROJECT, "job-before-quit");
    // The next due check, as the panel's poll or Check again would run it.
    const later = await genex.publishStatus(PROJECT, true);
    assert.equal(later.job?.state, "failed", "the background check does not reopen a settled upload");
    assert.equal((await saved()).job?.state, "failed");
  });

  it("the Publish dialog's Publish again is a plugin action that settles it in one press", async () => {
    const manifest = validateManifest(
      JSON.parse(await readFile(path.join(process.cwd(), "src/plugins/genex/plugin.json"), "utf8")),
    );
    const declared = manifest.actions.find((a) => a.name === "publish-allow-upload");
    assert.ok(declared, "the dialog's Publish again runs it");
    assert.equal(declared.confirmation, undefined, "a newer build is all it puts online: nothing asks again");

    const { server } = await hosted({ answer: "down" });
    const { genex, saved } = await tools(server.url, {
      ...interruptedUpload(),
      state: "unresolved",
      phase: "unresolved",
    });
    const plugin = await createGenexPlugin(server.url);
    const services: Record<string, unknown> = {
      "storage.root": genex.root,
      "credentials.read": "fixture-token",
      "credentials.session": null,
    };
    const ctx = { project: PROJECT, host: async (method: string) => services[method] ?? true };
    const settled = (await plugin.action(
      "publish-allow-upload",
      { jobId: "job-before-quit" },
      ctx,
    )) as GenexPublishState;
    assert.equal(settled.job?.state, "failed");
    assert.equal((await saved()).job?.state, "failed");
  });
});
