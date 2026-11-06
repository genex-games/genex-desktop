/**
 * The Genex plugin's read of a game's review and its requests for a person. The read goes through
 * `genex review --json --no-brief` on a CLI that has it, else straight to the API's answer for the
 * game's apps and the owner read (the pinned CLI's `native list --json` keeps only live builds). It is
 * kept in `publish/<game>/review.json` with what the host last told, never read while a publish of the
 * game runs, and a publish never rewrites it. A request for a person goes over HTTP whatever the CLI,
 * and an app Genex keeps no copy of is sent again at once.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import {
  GenexGameReview,
  GenexReviewReadProblem,
  GenexReviewRefusal,
  type GenexReviewStatus,
} from "../../src/shared/genex-review.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const SHA = "3f9a21c0".padEnd(64, "0");
const HELD = {
  platform: "mac",
  arch: "arm64",
  version: "1.3.0",
  sha256: SHA,
  publishedAt: "2026-10-27T14:02:00.000Z",
  review: "rejected",
  reviewReason: "Mines cryptocurrency.",
  reviewDetail: {
    stage: "decided",
    decidedBy: "check",
    decidedAt: "2026-10-27T14:06:00.000Z",
    things: [{ text: "Mines cryptocurrency on the player's computer", where: "vendor/worker.min.js" }],
    humanReview: { state: "none", canRequest: true },
    nextReviewBy: "check",
  },
};
const LINUX = { ...HELD, platform: "linux", arch: "x64", review: "approved", reviewDetail: { stage: "decided" } };

/** How the fixture API answers, which a test changes as Genex would. */
interface Genex {
  native: unknown;
  project: Record<string, unknown>;
  nativeStatus: number;
  request: { status: number; body: unknown };
  appeal: { status: number; body: unknown };
  seen: GenexRequest[];
}

const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((server) => server.close()));
});

/** A Genex plugin whose CLI is a stand-in and whose API is the fixture's, with the game on Genex as `dust-runners`. */
async function setup(options: { readsReviews?: boolean; slowPublish?: boolean } = {}) {
  const genex: Genex = {
    native: { builds: [LINUX], submissions: [HELD] },
    project: { id: "p1", slug: "dust-runners", commitSha: "abc", takedown: null },
    nativeStatus: 200,
    request: { status: 202, body: { build: HELD } },
    appeal: { status: 202, body: { caseId: "c1" } },
    seen: [],
  };
  const api = await startGenexFixtureApi((request, reply) => {
    genex.seen.push(request);
    if (request.url === "/api/games/p1/native-builds" && request.method === "GET")
      return reply.json(genex.native, genex.nativeStatus);
    if (request.url === "/api/projects/by-slug/dust-runners") return reply.json({ project: genex.project });
    if (request.url.endsWith("/review-request")) return reply.json(genex.request.body, genex.request.status);
    if (request.url === "/api/projects/p1/moderation/appeal") return reply.json(genex.appeal.body, genex.appeal.status);
  });
  servers.push(api);
  const root = await realpath(await tmpDir("genex-review-"));
  const log = path.join(root, "cli.log");
  const standIn = path.join(root, "stand-in.mjs");
  const review = {
    game: { id: "p1", slug: "dust-runners", title: "Dust Runners", url: "https://genex.games/dust-runners" },
    state: "checking",
    takedown: null,
    apps: [{ platform: "mac", arch: "arm64", state: "checking", version: "1.3.0", sentAt: HELD.publishedAt }],
  };
  await writeFile(
    standIn,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args[0] === "review") { process.stdout.write(JSON.stringify(${JSON.stringify(review)})); process.exit(0); }
if (args[0] === "native") {
  ${options.slowPublish ? "await new Promise((resolve) => setTimeout(resolve, 1500));" : ""}
  const build = { platform: "mac", arch: "arm64", version: "1.3.1", sizeBytes: 10, sha256: ${JSON.stringify(SHA)}, publishedAt: new Date().toISOString(), review: "pending", reviewDetail: { stage: "person" } };
  process.stdout.write(JSON.stringify({ build, engine: "unity" }));
  process.exit(0);
}
process.exit(2);
`,
  );
  const tools = new GenexTools(path.join(root, "host"), api.url, {
    credentials: { get: async () => "fixture-token", set: async () => {}, clear: async () => {} },
    preload: standIn,
    sendsApps: true,
    buildsApps: false,
    readsReviews: options.readsReviews ?? false,
  });
  const workspace = path.join(tools.root, "publish", "dust");
  await mkdir(path.join(workspace, ".genex"), { recursive: true });
  await writeFile(
    path.join(workspace, ".genex", "project.json"),
    JSON.stringify({ slug: "dust-runners", id: "p1", status: "published" }),
  );
  await writeFile(
    path.join(workspace, "native.json"),
    JSON.stringify({ jobId: "job-0", sent: [{ ...LINUX, sizeBytes: 10 }], failed: [] }),
  );
  const runs = async () =>
    (await readFile(log, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
  const saved = async () => JSON.parse(await readFile(path.join(workspace, "review.json"), "utf8"));
  return { tools, genex, runs, saved, workspace };
}

const reads = (genex: Genex) => genex.seen.filter((request) => request.method === "GET").map((request) => request.url);

describe("a game's review as the plugin reads it", () => {
  it("reads the API's answer over HTTP with the pinned CLI, keeps it, and runs no CLI", async () => {
    const { tools, genex, runs, saved } = await setup();
    const status: GenexReviewStatus = await tools.reviewStatus("dust", { refresh: true });
    assert.equal(status.record?.state, GenexGameReview.NotApproved);
    assert.equal(status.record?.apps.length, 2);
    assert.equal(status.connected, true);
    assert.equal(status.problem, undefined);
    assert.ok(status.fingerprint);
    assert.deepEqual(reads(genex), ["/api/games/p1/native-builds", "/api/projects/by-slug/dust-runners"]);
    assert.ok(genex.seen.every((request) => request.authorization === "Bearer fixture-token"));
    assert.deepEqual(await runs(), []);
    const kept = await saved();
    assert.equal(kept.source, "list");
    assert.equal(kept.fingerprint, status.fingerprint);
    assert.equal(kept.record.state, GenexGameReview.NotApproved);
  });

  it("reads `genex review --json --no-brief` in the publish workspace with a CLI that has it", async () => {
    const { tools, genex, runs, workspace, saved } = await setup({ readsReviews: true });
    const status = await tools.reviewStatus("dust", { refresh: true });
    assert.equal(status.record?.state, GenexGameReview.Checking);
    assert.equal(status.open, true);
    const [run] = await runs();
    assert.deepEqual(run?.args.slice(0, 2), ["review", "--no-brief"]);
    assert.ok(run?.args.includes("--json"));
    assert.equal(run?.cwd, workspace);
    assert.ok(!reads(genex).includes("/api/games/p1/native-builds"), "the CLI reads the apps itself");
    assert.equal((await saved()).source, "review");
  });

  it("answers what it kept without asking Genex when not told to read", async () => {
    const { tools, genex } = await setup();
    const first = await tools.reviewStatus("dust", {});
    assert.equal(first.record, null);
    assert.deepEqual(reads(genex), []);
    await tools.reviewStatus("dust", { refresh: true });
    const seen = genex.seen.length;
    const again = await tools.reviewStatus("dust", {});
    assert.equal(again.record?.state, GenexGameReview.NotApproved);
    assert.equal(genex.seen.length, seen);
  });

  it("keeps the last record through failed reads, and says offline after two in a row", async () => {
    const { tools, genex } = await setup();
    await tools.reviewStatus("dust", { refresh: true });
    genex.nativeStatus = 503;
    const once = await tools.reviewStatus("dust", { refresh: true });
    assert.equal(once.problem, undefined);
    assert.equal(once.record?.state, GenexGameReview.NotApproved);
    const twice = await tools.reviewStatus("dust", { refresh: true });
    assert.equal(twice.problem, GenexReviewReadProblem.Offline);
    assert.equal(twice.record?.state, GenexGameReview.NotApproved, "the last known state is kept");
    genex.nativeStatus = 200;
    assert.equal((await tools.reviewStatus("dust", { refresh: true })).problem, undefined);
    genex.nativeStatus = 401;
    assert.equal((await tools.reviewStatus("dust", { refresh: true })).problem, GenexReviewReadProblem.SignedOut);
  });

  it("keeps what the host told, and a later read keeps it too", async () => {
    const { tools, saved } = await setup();
    const status = await tools.reviewStatus("dust", { refresh: true });
    const told = { fingerprint: status.fingerprint ?? "", keys: { "app:mac/arm64": "x" } };
    const answered = await tools.reviewStatus("dust", { told });
    assert.deepEqual(answered.told, told);
    await tools.reviewStatus("dust", { refresh: true });
    assert.deepEqual((await saved()).told, told);
    const hostile = await tools.reviewStatus("dust", { told: { fingerprint: 7, keys: "all" } });
    assert.deepEqual(hostile.told, told, "a told that is not one is not written");
  });

  it("reads nothing while the game's apps are being sent, and the send never rewrites review.json", async () => {
    const { tools, genex, saved } = await setup({ slowPublish: true });
    await tools.reviewStatus("dust", { refresh: true });
    const before = JSON.stringify(await saved());
    const sending = tools.publishApps("dust", "job-1", [{ target: "/game/Dust.app", platform: "mac" }]);
    await sleep(100);
    const seen = genex.seen.length;
    const during = await tools.reviewStatus("dust", { refresh: true });
    assert.equal(during.publishing, true);
    assert.equal(genex.seen.length, seen, "Genex is not asked while the apps go");
    await sending;
    assert.equal(JSON.stringify(await saved()), before);
  });
});

describe("the dialog's rows after Genex decided", () => {
  it("say what Genex said of each sent app since, without rewriting what the publish sent", async () => {
    const { tools, workspace } = await setup();
    const held = { ...HELD, sizeBytes: 10, review: "pending" };
    const sent = JSON.stringify({ jobId: "job-0", sent: [{ ...LINUX, sizeBytes: 10 }, held], failed: [] });
    await writeFile(path.join(workspace, "native.json"), sent);
    await tools.reviewStatus("dust", { refresh: true });
    const { native } = await tools.publishView("dust");
    const mac = native?.sent.find((app) => app.platform === "mac");
    assert.equal(mac?.review, "rejected");
    assert.equal(mac?.reviewReason, "Mines cryptocurrency on the player's computer");
    assert.equal(await readFile(path.join(workspace, "native.json"), "utf8"), sent);
  });
});

describe("Request human review from the plugin", () => {
  it("asks for a person about each turned-down app that allows it, with the creator's note", async () => {
    const { tools, genex } = await setup();
    await tools.reviewStatus("dust", { refresh: true });
    const answer = await tools.requestReview("dust", { note: "The coin page is our own shop." }, []);
    const posted = genex.seen.filter((request) => request.method === "POST");
    assert.deepEqual(
      posted.map((request) => request.url),
      ["/api/games/p1/native-builds/mac/arm64/review-request"],
      "the live Linux app is not asked about",
    );
    assert.deepEqual(JSON.parse(posted[0]?.body ?? "{}"), { note: "The coin page is our own shop." });
    assert.deepEqual(answer.requested, [{ platform: "mac", arch: "arm64", resend: false }]);
    assert.equal(answer.refused, undefined);
  });

  it("sends the app again at once when Genex keeps no copy of it, keeping the other apps' record", async () => {
    const { tools, genex, runs, workspace } = await setup();
    await tools.reviewStatus("dust", { refresh: true });
    genex.request = { status: 202, body: { build: HELD, resend: true } };
    const upload = { target: "/game/Builds/Dust.app", platform: "mac" as const };
    const answer = await tools.requestReview("dust", {}, [upload]);
    assert.deepEqual(answer.requested, [{ platform: "mac", arch: "arm64", resend: true }]);
    await tools.appsSent("dust");
    assert.deepEqual(
      (await runs()).map((run) => run.args.slice(0, 3)),
      [["native", "publish", upload.target]],
    );
    const native = JSON.parse(await readFile(path.join(workspace, "native.json"), "utf8"));
    assert.deepEqual(
      native.sent.map((sent: { platform: string; version: string }) => [sent.platform, sent.version]),
      [
        ["linux", "1.3.0"],
        ["mac", "1.3.1"],
      ],
    );
    assert.deepEqual(JSON.parse(genex.seen.find((r) => r.method === "POST")?.body ?? "null"), {});
  });

  it("answers Genex's refusal by its code, and asks nothing for a note over 500 characters", async () => {
    const { tools, genex } = await setup();
    await tools.reviewStatus("dust", { refresh: true });
    genex.request = { status: 409, body: { error: "already_requested" } };
    assert.equal((await tools.requestReview("dust", {}, [])).refused, GenexReviewRefusal.AlreadyRequested);
    const before = genex.seen.length;
    await assert.rejects(tools.requestReview("dust", { note: "x".repeat(501) }, []));
    const elsewhere = await tools.requestReview("dust", { platform: "windows", arch: "x64" }, []);
    assert.equal(elsewhere.refused, GenexReviewRefusal.NothingToAsk);
    assert.equal(genex.seen.length, before, "a refusal Studio can tell itself asks Genex nothing");
  });

  it("asks for a person about a takedown through the appeal, and an old API's 20-character note first", async () => {
    const { tools, genex } = await setup();
    genex.project = { ...genex.project, takedown: undefined, takedownAt: "2026-10-27T14:06:00.000Z" };
    delete genex.project.takedown;
    await tools.reviewStatus("dust", { refresh: true });
    const short = await tools.requestReview("dust", { note: "It is fine." }, []);
    assert.equal(short.refused, GenexReviewRefusal.NoteTooShort);
    assert.ok(!genex.seen.some((request) => request.method === "POST"));
    const answer = await tools.requestReview("dust", { note: "The coin page is our own shop, not a third party." }, []);
    assert.equal(answer.takedown, true);
    const posted = genex.seen.filter((request) => request.method === "POST").map((request) => request.url);
    assert.deepEqual(posted, ["/api/projects/p1/moderation/appeal"]);
  });
});
