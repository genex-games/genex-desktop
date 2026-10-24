/**
 * The human review server (`scripts/evals/review/`, §8.6, §10.7): loopback only, a per-session
 * token on every request, answers only from its own origin, media only from inside the run's own
 * evidence folder by real path (hostile-path table), `default-src 'self'` on every response, one
 * human row per answer through the ledger writer, and nothing on the page or in its JSON that
 * names a lane, a run, an engine or a model. Hermetic: temp folders and a loopback socket.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { describe, it } from "node:test";
import { EngineId } from "../../src/shared/providers.ts";
import { evalsPaths } from "../../scripts/evals/ledger/paths.ts";
import { GRADE_RECORD_SCHEMA, gradeCampaign, gradeRecordPathIn } from "../../scripts/evals/grade/pipeline.ts";
import { currentRows, readHumanRows, readPairwiseRows, readRunRows } from "../../scripts/evals/ledger/read.ts";
import { HUMAN_ROW_SCHEMA, type PairwiseRow, type RunRow } from "../../scripts/evals/ledger/types.ts";
import { appendLedgerRow, withGradeId } from "../../scripts/evals/ledger/write.ts";
import { MediaKind, type ReviewMedia, reviewSide } from "../../scripts/evals/review/evidence.ts";
import { ReviewPath, TOKEN_PARAM } from "../../scripts/evals/review/page.ts";
import type { ReviewRow } from "../../scripts/evals/review/rows.ts";
import {
  MAX_ANSWER_BYTES,
  REVIEW_HOST,
  ReviewRefusal,
  type ReviewServerHandle,
  startReviewServer,
} from "../../scripts/evals/review/server.ts";
import {
  campaignPairs,
  evidenceReviewSource,
  firstOnLeft,
  type ItemTask,
  loadReviewTasks,
  type PairTask,
  placementSeedFor,
  ReviewMode,
  type ReviewSource,
  type ReviewTask,
  validationSampleSize,
} from "../../scripts/evals/review/tasks.ts";
import {
  localReviewerId,
  parseReviewArgs,
  REVIEWER_ID_FILE,
  ReviewLine,
  reviewCommand,
} from "../../scripts/evals/review/command.ts";
import { graderValidationRow, pairReviewRow } from "../../scripts/evals/review/rows.ts";
import { REVIEWER_ID_PATTERN, SEED_PATTERN } from "../../scripts/evals/ledger/schema.ts";
import { EXIT_USAGE } from "../../scripts/eval.ts";
import type { EvalCase } from "../../scripts/evals/case-types.ts";
import type { FrameRef } from "../../scripts/evals/grade/types.ts";
import type { SessionView } from "../../scripts/evals/review/view.ts";
import {
  CheckResult,
  DefectCode,
  GraderFamily,
  HarnessFailure,
  HumanPick,
  ItemVerdict,
  ProbePhase,
  RowKind,
} from "../../scripts/evals/vocabulary.ts";
import { defaultHomes } from "../../scripts/transcript-census.ts";
import { closeBeforeCleanup, tmpDir } from "../helpers/tmp.ts";
import {
  CAMPAIGN as GRADING_CAMPAIGN,
  gradingCase,
  harness,
  seedCampaign,
} from "../fixtures/evals/grading/campaign.ts";

const SECRET = "outside-the-evidence-sentinel";
const REVIEWER = "0f1e2d3c4b5a6978";
const CAMPAIGN = "20261002T100000-smoke";
const LANES = ["genex-claude", "raw-claude", "raw-codex", "genex-codex"];
/** The origin the prober served the game on; frames on any other origin are not evidence. */
const ORIGIN = "http://127.0.0.1:5173";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ledgerFixtures = path.resolve(import.meta.dirname, "../fixtures/evals/ledger");
const reviewFixtures = path.resolve(import.meta.dirname, "../fixtures/evals/review");

/** The synthetic run row for one lane and rep of the sample case, stamped with its gradeId. */
function runRow(lane: string, rep = 1, change: (row: RunRow) => void = () => {}): RunRow {
  const row: RunRow = JSON.parse(readFileSync(path.join(ledgerFixtures, "run-row.json"), "utf8"));
  row.runId = `20261002T101500-${lane}-${row.case.id}-r${rep}`;
  row.campaignId = CAMPAIGN;
  row.lane.id = lane;
  change(row);
  return withGradeId(row);
}

/** One pairwise judgement of two runs. */
function pairwiseRow(first: RunRow, second: RunRow, change: (row: PairwiseRow) => void = () => {}): PairwiseRow {
  const row: PairwiseRow = JSON.parse(readFileSync(path.join(ledgerFixtures, "pairwise-row.json"), "utf8"));
  row.campaignId = first.campaignId;
  row.lanes = { first: first.lane.id, second: second.lane.id };
  row.runIds = { first: first.runId, second: second.runId };
  change(row);
  return row;
}

/** A kept checklist result: two judged items and one that no family judged. */
function checklistResult(): unknown {
  return JSON.parse(readFileSync(path.join(reviewFixtures, "checklist.json"), "utf8"));
}

/** Where the grade command keeps a run's current grade record (the file the review reads). */
const gradeRecordOf = (evidenceRoot: string, run: RunRow) =>
  path.join(evidenceRoot, run.runId, gradeRecordPathIn(run.gradeSeq));

/** A run's evidence folder: a boot frame, `frames` witnessed frames, and its grade record naming them (and optionally a checklist). */
async function writeRunEvidence(evidenceRoot: string, run: RunRow, frames: number, checklist?: unknown) {
  const dir = path.join(evidenceRoot, run.runId);
  await mkdir(dir, { recursive: true });
  const boot = path.join(dir, "boot.png");
  await writeFile(boot, Buffer.concat([PNG_SIGNATURE, Buffer.from("boot")]));
  const refs: FrameRef[] = [{ path: boot, atMs: 10, phase: ProbePhase.Boot, origin: ORIGIN, width: 4, height: 3 }];
  for (let index = 1; index <= frames; index++) {
    const file = path.join(dir, `frame-${String(index).padStart(2, "0")}.png`);
    await writeFile(file, Buffer.concat([PNG_SIGNATURE, Buffer.from(`frame ${index}`)]));
    refs.push({ path: file, atMs: 100 * index, phase: ProbePhase.InputBurst, origin: ORIGIN, width: 4, height: 3 });
  }
  const evidence = {
    gameOrigin: ORIGIN,
    frames: refs,
    consoleSummaryPath: "",
    networkSummaryPath: "",
    videoPath: null,
    summaryBytes: 4096,
  };
  const record = {
    schema: GRADE_RECORD_SCHEMA,
    runId: run.runId,
    gradeSeq: run.gradeSeq,
    probe: { evidence },
    checklist: checklist ?? { items: [] },
  };
  const file = gradeRecordOf(evidenceRoot, run);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(record));
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface RawRequest {
  method?: string;
  path: string;
  /** The Host header to send; null sends none. */
  host?: string | null;
  headers?: Record<string, string>;
  body?: string;
}

/** One raw request, the path sent byte for byte. */
function request(handle: ReviewServerHandle, raw: RawRequest): Promise<Reply> {
  const { port } = new URL(handle.origin);
  const host = raw.host === undefined ? `${REVIEW_HOST}:${port}` : raw.host;
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: REVIEW_HOST,
        port: Number(port),
        path: raw.path,
        method: raw.method ?? "GET",
        setHost: host !== null,
        headers: { ...(host === null ? {} : { host }), ...raw.headers },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("latin1"),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(raw.body);
  });
}

const tokenOf = (handle: ReviewServerHandle) => new URL(handle.url).searchParams.get(TOKEN_PARAM) ?? "";
const withQuery = (pathname: string, token: string) => `${pathname}?${TOKEN_PARAM}=${token}`;

async function nextView(handle: ReviewServerHandle): Promise<SessionView> {
  const reply = await request(handle, { path: withQuery(ReviewPath.Task, tokenOf(handle)) });
  assert.equal(reply.status, 200);
  return JSON.parse(reply.body);
}

function postAnswer(handle: ReviewServerHandle, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return request(handle, {
    method: "POST",
    path: withQuery(ReviewPath.Answer, tokenOf(handle)),
    headers: { "content-type": "application/json", origin: handle.origin, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const pairAnswer = (taskId: string, pick: string = HumanPick.A) => ({
  taskId,
  pick,
  human: null,
  defect: DefectCode.None,
  satisfied: { a: CheckResult.Pass, b: CheckResult.Unknown },
});

async function sizeOf(file: string): Promise<number | null> {
  return stat(file).then(
    (info) => info.size,
    () => null,
  );
}

/** A fresh evals home with two runs of one case, their evidence, and a pairwise judgement. */
async function pairSession(options: { now?: () => number; write?: (row: ReviewRow) => Promise<void> } = {}) {
  const user = await tmpDir("eval-review-");
  const paths = evalsPaths(path.join(user, ".genex-evals"));
  const runs: RunRow[] = LANES.slice(0, 2).map((lane) => runRow(lane));
  for (const row of runs) await writeRunEvidence(paths.evidence, row, 3);
  const pairwise: PairwiseRow[] = [pairwiseRow(runs[0] as RunRow, runs[1] as RunRow)];
  const source = evidenceReviewSource(
    paths.evidence,
    { runs: async () => runs, pairwise: async () => pairwise, human: () => readHumanRows(paths) },
    [],
  );
  const tasks = await loadReviewTasks(
    { campaignId: CAMPAIGN, mode: ReviewMode.Pair, seed: "s1", reviewerId: REVIEWER, sample: null },
    source,
  );
  const write =
    options.write ?? ((row: ReviewRow) => appendLedgerRow(row, { paths, homes: defaultHomes(user) }).then(() => {}));
  const handle = await startReviewServer({
    tasks,
    evidenceRoot: paths.evidence,
    reviewerId: REVIEWER,
    write,
    now: options.now,
  });
  closeBeforeCleanup(() => handle.close());
  return { user, paths, runs, tasks, handle };
}

describe("eval review server: access", () => {
  it("binds 127.0.0.1 on a random port and hands out a URL with a long random token", async () => {
    const { handle } = await pairSession();
    const url = new URL(handle.url);
    assert.equal(url.hostname, REVIEW_HOST);
    assert.notEqual(url.port, "");
    assert.match(tokenOf(handle), /^[0-9a-f]{64}$/);
    const other = await pairSession();
    assert.notEqual(tokenOf(other.handle), tokenOf(handle));
  });

  it("refuses every route without the session token, and a foreign Host even with it, writing nothing", async () => {
    const { handle, paths } = await pairSession();
    const token = tokenOf(handle);
    const view = await nextView(handle);
    const mediaUrl = view.task?.mode === ReviewMode.Pair ? view.task.sides[0].frames[0]?.url : undefined;
    assert.ok(mediaUrl);
    const mediaPath = new URL(mediaUrl, handle.origin).pathname;
    const routes = [ReviewPath.Page, ReviewPath.Script, ReviewPath.Style, ReviewPath.Task, mediaPath];
    const badTokens = [
      "",
      `${TOKEN_PARAM}=`,
      `${TOKEN_PARAM}=${"0".repeat(64)}`,
      `${TOKEN_PARAM}=${token.slice(0, 63)}`,
      `${TOKEN_PARAM}=${token}x`,
    ];
    for (const route of routes)
      for (const bad of badTokens) {
        const reply = await request(handle, { path: bad ? `${route}?${bad}` : route });
        assert.equal(reply.status, 401, `${route} ${bad}`);
        assert.deepEqual(JSON.parse(reply.body), { error: ReviewRefusal.BadToken });
        assert.ok(!reply.body.includes(SECRET));
      }
    const port = new URL(handle.origin).port;
    for (const host of ["localhost", `localhost:${port}`, "evil.example", `evil.example:${port}`, REVIEW_HOST]) {
      const reply = await request(handle, { path: withQuery(ReviewPath.Task, token), host });
      assert.equal(reply.status, 403, host);
      assert.deepEqual(JSON.parse(reply.body), { error: ReviewRefusal.ForeignHost });
    }
    // Without a Host header Node's own HTTP/1.1 parser refuses the request before it is routed.
    assert.equal((await request(handle, { path: withQuery(ReviewPath.Task, token), host: null })).status, 400);
    const task = view.task;
    assert.ok(task);
    const wrongToken = await request(handle, {
      method: "POST",
      path: withQuery(ReviewPath.Answer, "0".repeat(64)),
      headers: { "content-type": "application/json", origin: handle.origin },
      body: JSON.stringify(pairAnswer(task.taskId)),
    });
    assert.equal(wrongToken.status, 401);
    const foreignOrigin = await postAnswer(handle, pairAnswer(task.taskId), { origin: "http://evil.example" });
    assert.equal(foreignOrigin.status, 403);
    assert.deepEqual(JSON.parse(foreignOrigin.body), { error: ReviewRefusal.ForeignOrigin });
    assert.equal(await sizeOf(paths.ledgerFiles.human), null);
  });

  it("refuses methods other than reading pages and posting answers", async () => {
    const { handle } = await pairSession();
    const token = tokenOf(handle);
    const cases: RawRequest[] = [
      { method: "PUT", path: withQuery(ReviewPath.Page, token) },
      { method: "DELETE", path: withQuery(ReviewPath.Task, token) },
      { method: "POST", path: withQuery(ReviewPath.Task, token) },
      { method: "GET", path: withQuery(ReviewPath.Answer, token) },
    ];
    for (const raw of cases) assert.equal((await request(handle, raw)).status, 405, `${raw.method} ${raw.path}`);
  });

  it("serves the page, script and style from itself with default-src 'self' and nothing inline", async () => {
    const { handle } = await pairSession();
    const token = tokenOf(handle);
    for (const [route, type] of [
      [ReviewPath.Page, "text/html"],
      [ReviewPath.Script, "text/javascript"],
      [ReviewPath.Style, "text/css"],
      [ReviewPath.Task, "application/json"],
    ] as const) {
      const reply = await request(handle, { path: withQuery(route, token) });
      assert.equal(reply.status, 200, route);
      assert.ok(reply.headers["content-type"]?.startsWith(type), route);
      assert.match(String(reply.headers["content-security-policy"]), /(^|; )default-src 'self'(;|$)/);
      assert.equal(reply.headers["x-content-type-options"], "nosniff");
      assert.equal(reply.headers["cache-control"], "no-store");
    }
    const html = (await request(handle, { path: withQuery(ReviewPath.Page, token) })).body;
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) assert.match(tag, /\ssrc="/);
    assert.doesNotMatch(html, /<style\b|\sstyle=|\son[a-z]+=|https?:\/\/(?!127\.0\.0\.1)/i);
    assert.doesNotMatch(html, /\/\/cdn|googleapis|jsdelivr|unpkg/i);
    const script = (await request(handle, { path: withQuery(ReviewPath.Script, token) })).body;
    assert.doesNotThrow(() => new Function(script));
  });
});

/** Media named by a task that must never be served: each one points somewhere it should not. */
async function hostileMedia(evidenceRoot: string, runId: string, otherRunId: string) {
  const base = path.dirname(evidenceRoot);
  const outside = path.join(base, "outside");
  await mkdir(outside, { recursive: true });
  const outsideFrame = path.join(outside, "frame.png");
  await writeFile(outsideFrame, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(SECRET)]));
  const runDir = path.join(evidenceRoot, runId);
  await symlink(outsideFrame, path.join(runDir, "link-out.png"));
  await symlink(outside, path.join(runDir, "dir-out"));
  await writeFile(path.join(runDir, "not-an-image.png"), `text ${SECRET}`);
  const otherFrame = path.join(evidenceRoot, otherRunId, "other.png");
  await writeFile(otherFrame, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(SECRET)]));
  await symlink(otherFrame, path.join(runDir, "link-other-run.png"));
  const table: Array<{ name: string; file: string; kind?: MediaKind }> = [
    { name: "absolute path outside the evidence root", file: outsideFrame },
    { name: "relative climb out of the run", file: `..${path.sep}..${path.sep}outside${path.sep}frame.png` },
    { name: "encoded-looking climb", file: "%2e%2e/%2e%2e/outside/frame.png" },
    { name: "symlink to a file outside", file: path.join(runDir, "link-out.png") },
    { name: "symlinked folder outside", file: path.join(runDir, "dir-out", "frame.png") },
    { name: "another run's evidence", file: otherFrame },
    { name: "symlink into another run", file: path.join(runDir, "link-other-run.png") },
    { name: "NUL byte", file: `${path.join(runDir, "frame-01.png")}\0.png` },
    { name: "the run folder itself", file: runDir },
    { name: "missing file", file: path.join(runDir, "missing.png") },
    { name: "bytes that are not an image", file: path.join(runDir, "not-an-image.png") },
    { name: "a frame served as video", file: path.join(runDir, "frame-01.png"), kind: MediaKind.Video },
  ];
  return table.map(({ name, file, kind }): { name: string; media: ReviewMedia } => ({
    name,
    media: { kind: kind ?? MediaKind.Frame, runId, file, width: 1, height: 1 },
  }));
}

describe("eval review server: evidence boundary", () => {
  it("serves a hostile media path from no task and never returns its bytes (hostile-path table)", async () => {
    const user = await tmpDir("eval-review-hostile-");
    const paths = evalsPaths(path.join(user, ".genex-evals"));
    const [run, other] = LANES.slice(0, 2).map((lane) => runRow(lane)) as [RunRow, RunRow];
    await writeRunEvidence(paths.evidence, run, 1);
    await writeRunEvidence(paths.evidence, other, 1);
    const table = await hostileMedia(paths.evidence, run.runId, other.runId);
    const good: ReviewMedia = {
      kind: MediaKind.Frame,
      runId: run.runId,
      file: path.join(paths.evidence, run.runId, "frame-01.png"),
      width: 1,
      height: 1,
    };
    const task: PairTask = {
      mode: ReviewMode.Pair,
      campaignId: CAMPAIGN,
      caseId: run.case.id,
      caseVersion: run.case.version,
      caseText: null,
      placementSeed: "s1",
      left: { runId: run.runId, frames: [good, ...table.map((row) => row.media)], video: null },
      right: { runId: other.runId, frames: [], video: null },
    };
    const handle = await startReviewServer({
      tasks: [task],
      evidenceRoot: paths.evidence,
      reviewerId: REVIEWER,
      write: async () => {},
    });
    closeBeforeCleanup(() => handle.close());
    const view = await nextView(handle);
    assert.ok(view.task?.mode === ReviewMode.Pair);
    const [goodUrl, ...hostileUrls] = view.task.sides[0].frames.map((frame) => frame.url);
    assert.ok(goodUrl);
    const served = await request(handle, { path: goodUrl });
    assert.equal(served.status, 200);
    assert.equal(served.headers["content-type"], "image/png");
    assert.equal(hostileUrls.length, table.length);
    for (const [index, url] of hostileUrls.entries()) {
      const reply = await request(handle, { path: url as string });
      assert.equal(reply.status, 404, table[index]?.name);
      assert.ok(!reply.body.includes(SECRET), table[index]?.name);
    }
    const mediaPath = new URL(goodUrl, handle.origin).pathname;
    const token = tokenOf(handle);
    const urlTable = [
      `${ReviewPath.MediaPrefix}..%2F..%2Foutside%2Fframe.png`,
      `${ReviewPath.MediaPrefix}%2e%2e/%2e%2e/outside/frame.png`,
      `${ReviewPath.MediaPrefix}${"a".repeat(32)}`,
      `${ReviewPath.MediaPrefix}${"A".repeat(32)}`,
      `${mediaPath}/../../outside/frame.png`,
      `${mediaPath}%00`,
      `${ReviewPath.MediaPrefix}%E0%A4%A`,
      `${ReviewPath.MediaPrefix}`,
      "/evidence/../outside/frame.png",
    ];
    for (const raw of urlTable) {
      const reply = await request(handle, { path: withQuery(raw, token) });
      assert.ok(reply.status === 404 || reply.status === 400, raw);
      assert.ok(!reply.body.includes(SECRET), raw);
    }
  });
});

describe("eval review server: evidence loading", () => {
  it("drops every hostile frame a scorecard names before a page ever sees it", async () => {
    const user = await tmpDir("eval-review-scorecard-");
    const paths = evalsPaths(path.join(user, ".genex-evals"));
    const [run, other] = LANES.slice(0, 2).map((lane) => runRow(lane)) as [RunRow, RunRow];
    await writeRunEvidence(paths.evidence, other, 1);
    await writeRunEvidence(paths.evidence, run, 1);
    const table = await hostileMedia(paths.evidence, run.runId, other.runId);
    const frames = table.map((row, index) => ({
      path: row.media.file,
      atMs: 1000 + index,
      phase: ProbePhase.InputBurst,
      origin: ORIGIN,
      width: 1,
      height: 1,
    }));
    const scorecard = gradeRecordOf(paths.evidence, run);
    const card = JSON.parse(await readFile(scorecard, "utf8"));
    card.probe.evidence.frames = [...card.probe.evidence.frames, ...frames.slice(0, 7)];
    await writeFile(scorecard, JSON.stringify(card));
    const side = await reviewSide(paths.evidence, run);
    assert.deepEqual(
      side.frames.map((frame) => path.basename(frame.file)),
      ["frame-01.png"],
    );
  });

  it("re-checks a frame when it is served, so a file swapped for a link after loading is refused", async () => {
    const { handle, paths, tasks } = await pairSession();
    const view = await nextView(handle);
    assert.ok(view.task?.mode === ReviewMode.Pair);
    const firstUrl = view.task.sides[0].frames[0]?.url;
    assert.ok(firstUrl);
    const left = (tasks[0] as PairTask).left;
    const file = left.frames[0]?.file as string;
    const outside = path.join(path.dirname(paths.home), "swapped.png");
    await writeFile(outside, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(SECRET)]));
    await rm(file);
    await symlink(outside, file);
    const reply = await request(handle, { path: firstUrl });
    assert.equal(reply.status, 404);
    assert.ok(!reply.body.includes(SECRET));
  });
});

describe("eval review server: human rows", () => {
  it("writes one genex-evals/human/1 row per pair answer, A being the run shown on the left", async () => {
    let clock = 1_000;
    const { handle, paths, tasks } = await pairSession({ now: () => clock });
    const view = await nextView(handle);
    assert.ok(view.task);
    clock += 95_400;
    const reply = await postAnswer(handle, pairAnswer(view.task.taskId, HumanPick.B));
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), { saved: true, progress: { done: 1, total: 1 } });
    const rows = await readHumanRows(paths);
    assert.equal(rows.length, 1);
    const [row] = rows;
    const task = tasks[0] as PairTask;
    assert.equal(row?.schema, HUMAN_ROW_SCHEMA);
    assert.equal(row?.campaignId, CAMPAIGN);
    assert.equal(row?.reviewerId, REVIEWER);
    assert.deepEqual(row?.runIds, { a: task.left.runId, b: task.right.runId });
    assert.equal(row?.placementSeed, task.placementSeed);
    assert.equal(row?.pick, HumanPick.B);
    assert.equal(row?.defect, DefectCode.None);
    assert.deepEqual(row?.requestSatisfied, { a: CheckResult.Pass, b: CheckResult.Unknown });
    assert.equal(row?.reviewSeconds, 95);
    assert.equal(row?.recordedAt, new Date(clock).toISOString());
    await handle.finished;
    assert.equal((await nextView(handle)).task, null);
  });

  it("refuses a repeated, malformed, oversized or non-JSON answer without growing the ledger", async () => {
    const { handle, paths } = await pairSession();
    const view = await nextView(handle);
    assert.ok(view.task);
    const taskId = view.task.taskId;
    const refusals: Array<{
      name: string;
      body: unknown;
      headers?: Record<string, string>;
      status: number;
      error: string;
    }> = [
      { name: "unknown task", body: pairAnswer("feedfeedfeedfeed"), status: 409, error: ReviewRefusal.UnknownTask },
      { name: "pick not a code", body: pairAnswer(taskId, "left"), status: 400, error: ReviewRefusal.InvalidAnswer },
      {
        name: "no pick on a pair",
        body: { ...pairAnswer(taskId), pick: null },
        status: 400,
        error: ReviewRefusal.InvalidAnswer,
      },
      {
        name: "defect not a code",
        body: { ...pairAnswer(taskId), defect: "ugly" },
        status: 400,
        error: ReviewRefusal.InvalidAnswer,
      },
      {
        name: "satisfied not a code",
        body: { ...pairAnswer(taskId), satisfied: { a: "yes", b: CheckResult.Pass } },
        status: 400,
        error: ReviewRefusal.InvalidAnswer,
      },
      { name: "not JSON", body: "{taskId:", status: 400, error: ReviewRefusal.InvalidAnswer },
      { name: "an array", body: "[]", status: 400, error: ReviewRefusal.InvalidAnswer },
      {
        name: "oversized",
        body: JSON.stringify({ ...pairAnswer(taskId), pad: "x".repeat(MAX_ANSWER_BYTES) }),
        status: 413,
        error: ReviewRefusal.TooLarge,
      },
      {
        name: "form-encoded",
        body: "taskId=1",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        status: 415,
        error: ReviewRefusal.NotJson,
      },
    ];
    for (const refusal of refusals) {
      const reply = await postAnswer(handle, refusal.body, refusal.headers);
      assert.equal(reply.status, refusal.status, refusal.name);
      assert.deepEqual(JSON.parse(reply.body), { error: refusal.error }, refusal.name);
      assert.equal(await sizeOf(paths.ledgerFiles.human), null, refusal.name);
    }
    assert.equal((await postAnswer(handle, pairAnswer(taskId))).status, 200);
    const size = await sizeOf(paths.ledgerFiles.human);
    const again = await postAnswer(handle, pairAnswer(taskId));
    assert.equal(again.status, 409);
    assert.equal(await sizeOf(paths.ledgerFiles.human), size);
  });
});

describe("eval review server: rows under contention", () => {
  it("writes one row when the same answer arrives twice while the first is still being written", async () => {
    const written: ReviewRow[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { handle } = await pairSession({
      write: async (row) => {
        await gate;
        written.push(row);
      },
    });
    const view = await nextView(handle);
    assert.ok(view.task);
    const replies = [
      postAnswer(handle, pairAnswer(view.task.taskId)),
      postAnswer(handle, pairAnswer(view.task.taskId)),
    ];
    // Whichever arrived second is answered while the first row is still held at the gate.
    const early = await Promise.race(replies);
    release();
    assert.equal(early.status, 409);
    const statuses = (await Promise.all(replies)).map((reply) => reply.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    assert.equal(written.length, 1);
  });

  it("keeps a task open when the ledger refuses its row", async () => {
    const { handle } = await pairSession({
      write: async () => {
        throw new Error("refused");
      },
    });
    const view = await nextView(handle);
    assert.ok(view.task);
    const reply = await postAnswer(handle, pairAnswer(view.task.taskId));
    assert.equal(reply.status, 422);
    assert.deepEqual(JSON.parse(reply.body), { error: ReviewRefusal.RowRefused });
    const again = await nextView(handle);
    assert.equal(again.task?.taskId, view.task.taskId);
    assert.deepEqual(handle.progress(), { done: 0, total: 1 });
  });
});

describe("eval review server: grader-validation labels", () => {
  it("lands a grader-validation label in human.jsonl through the real ledger writer", async () => {
    const user = await tmpDir("eval-review-label-write-");
    const paths = evalsPaths(path.join(user, ".genex-evals"));
    const run = runRow(LANES[0] as string);
    const row = graderValidationRow(
      {
        campaignId: CAMPAIGN,
        caseId: run.case.id,
        caseVersion: run.case.version,
        reviewerId: REVIEWER,
        placementSeed: "s2",
        recordedAt: "2026-10-02T14:00:00Z",
        reviewSeconds: 12,
      },
      {
        runId: run.runId,
        itemId: "sample-case-01",
        verdicts: { [GraderFamily.Claude]: ItemVerdict.Pass, [GraderFamily.Gpt]: ItemVerdict.Fail },
        human: ItemVerdict.Fail,
        defect: DefectCode.None,
      },
    );
    await appendLedgerRow(row, { paths, homes: defaultHomes(user) });
    assert.deepEqual(await readHumanRows(paths), [row]);
  });

  it("writes a grader-validation label with both families' verdicts, the owner's own and no pick", async () => {
    const user = await tmpDir("eval-review-graders-");
    const paths = evalsPaths(path.join(user, ".genex-evals"));
    const run = runRow(LANES[0] as string);
    await writeRunEvidence(paths.evidence, run, 2, checklistResult());
    const source = evidenceReviewSource(
      paths.evidence,
      { runs: async () => [run], pairwise: async () => [], human: async () => [] },
      [],
    );
    const tasks = await loadReviewTasks(
      { campaignId: CAMPAIGN, mode: ReviewMode.GraderValidation, seed: "s2", reviewerId: REVIEWER, sample: 1 },
      source,
    );
    assert.equal(tasks.length, 1);
    const written: ReviewRow[] = [];
    const handle = await startReviewServer({
      tasks,
      evidenceRoot: paths.evidence,
      reviewerId: REVIEWER,
      now: () => 5_000,
      write: async (row) => {
        written.push(row);
      },
    });
    closeBeforeCleanup(() => handle.close());
    const view = await nextView(handle);
    assert.ok(view.task?.mode === ReviewMode.GraderValidation);
    assert.equal(view.task.side.frames.length, 2);
    const noVerdict = await postAnswer(handle, { ...pairAnswer(view.task.taskId), pick: null });
    assert.equal(noVerdict.status, 400);
    const reply = await postAnswer(handle, {
      ...pairAnswer(view.task.taskId),
      pick: null,
      human: ItemVerdict.Fail,
      defect: DefectCode.BriefUnmet,
    });
    assert.equal(reply.status, 200);
    const task = tasks[0] as ItemTask;
    assert.deepEqual(written, [
      {
        schema: HUMAN_ROW_SCHEMA,
        campaignId: CAMPAIGN,
        recordedAt: new Date(5_000).toISOString(),
        caseId: run.case.id,
        caseVersion: run.case.version,
        reviewerId: REVIEWER,
        runIds: { a: run.runId, b: run.runId },
        placementSeed: "s2",
        pick: null,
        defect: DefectCode.BriefUnmet,
        requestSatisfied: null,
        reviewSeconds: 0,
        item: { id: task.item.id, verdicts: task.item.verdicts, human: ItemVerdict.Fail },
      },
    ]);
    await handle.finished;
  });
});

/** Load the page, its script and style, then answer every task; returns every body the server sent. */
/** The engine ids a served body must not name; `cursor` is also a CSS property the page styles with. */
const ENGINE_IDS: ReadonlySet<string> = new Set(Object.values(EngineId));

/**
 * Whether `body` names `word`. An engine id counts as a word of its own, and a CSS declaration
 * (`cursor: pointer;`) is no mention of the Cursor engine; anything else counts wherever it appears.
 */
function names(body: string, word: string): boolean {
  if (!ENGINE_IDS.has(word)) return body.includes(word);
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b(?!\\s*:\\s*[a-z-]+\\s*;)`).test(body);
}

async function answerEverything(handle: ReviewServerHandle): Promise<string[]> {
  const token = tokenOf(handle);
  const served: string[] = [];
  for (const route of [ReviewPath.Page, ReviewPath.Script, ReviewPath.Style])
    served.push((await request(handle, { path: withQuery(route, token) })).body);
  for (;;) {
    const reply = await request(handle, { path: withQuery(ReviewPath.Task, token) });
    served.push(reply.body);
    const view: SessionView = JSON.parse(reply.body);
    if (!view.task) return served;
    const pair = view.task.mode === ReviewMode.Pair;
    const answer = pair
      ? pairAnswer(view.task.taskId)
      : { ...pairAnswer(view.task.taskId), pick: null, human: ItemVerdict.Pass };
    assert.equal((await postAnswer(handle, answer)).status, 200);
  }
}

describe("eval review server: blinding", () => {
  it("never names a lane, run, campaign, engine, model or evidence path in anything it serves", async () => {
    const user = await tmpDir("eval-review-blind-");
    const paths = evalsPaths(path.join(user, ".genex-evals"));
    const runs = LANES.map((lane) => runRow(lane));
    for (const row of runs) await writeRunEvidence(paths.evidence, row, 2, checklistResult());
    const ledger = { runs: async () => runs, pairwise: async () => [], human: async () => [] };
    const source = evidenceReviewSource(paths.evidence, ledger, []);
    const forbidden = [
      ...LANES,
      ...runs.map((row) => row.runId),
      CAMPAIGN,
      ...Object.values(EngineId),
      ...runs.flatMap((row) => [row.model.requested, row.model.main ?? ""]).filter(Boolean),
      paths.evidence,
      "frame-0",
      "quick-probe",
    ];
    for (const mode of [ReviewMode.Pair, ReviewMode.GraderValidation]) {
      const tasks: ReviewTask[] = await loadReviewTasks(
        { campaignId: CAMPAIGN, mode, seed: "s3", reviewerId: REVIEWER, sample: 3 },
        source,
      );
      assert.ok(tasks.length >= 3, mode);
      const handle = await startReviewServer({
        tasks,
        evidenceRoot: paths.evidence,
        reviewerId: REVIEWER,
        write: async () => {},
      });
      closeBeforeCleanup(() => handle.close());
      const served = await answerEverything(handle);
      for (const body of served)
        for (const word of forbidden) assert.ok(!names(body, word), `${mode} served ${word}`);
      if (mode === ReviewMode.GraderValidation)
        assert.ok(
          served.some((body) => body.includes(`"family":"${GraderFamily.Claude}"`)),
          "families are shown",
        );
    }
  });

  it("places pairs left and right from the seed, so a lane is not always on one side", async () => {
    const user = await tmpDir("eval-review-sides-");
    const paths = evalsPaths(path.join(user, ".genex-evals"));
    const runs = [1, 2, 3, 4, 5, 6, 7, 8].flatMap((rep) => LANES.slice(0, 2).map((lane) => runRow(lane, rep)));
    const source = evidenceReviewSource(
      paths.evidence,
      { runs: async () => runs, pairwise: async () => [], human: async () => [] },
      [],
    );
    const tasks = (await loadReviewTasks(
      { campaignId: CAMPAIGN, mode: ReviewMode.Pair, seed: "s4", reviewerId: REVIEWER, sample: null },
      source,
    )) as PairTask[];
    assert.equal(tasks.length, 8);
    const leftLanes = new Set(tasks.map((task) => runs.find((row) => row.runId === task.left.runId)?.lane.id));
    assert.equal(leftLanes.size, 2);
  });
});

/** A review source over rows in memory and an (empty unless written) evidence folder. */
function memorySource(
  evidenceRoot: string,
  rows: { runs?: RunRow[]; pairwise?: PairwiseRow[]; human?: ReviewRow[]; cases?: EvalCase[] },
): ReviewSource {
  return evidenceReviewSource(
    evidenceRoot,
    {
      runs: async () => rows.runs ?? [],
      pairwise: async () => rows.pairwise ?? [],
      human: async () => rows.human ?? [],
    },
    rows.cases ?? [],
  );
}

const pairKeyOf = (task: PairTask) => [task.left.runId, task.right.runId].sort().join("|");

describe("eval review tasks: pairs", () => {
  it("takes the pairs the judge saw once each, and only reviewable build runs", () => {
    const [a, b, c] = LANES.map((lane) => runRow(lane)) as [RunRow, RunRow, RunRow];
    const failed = runRow(LANES[3] as string, 1, (row) => {
      row.outcome.harnessFailure = HarnessFailure.RateLimited;
    });
    const canary = runRow("canary-lane", 1, (row) => {
      row.kind = RowKind.Canary;
    });
    const otherCampaign = pairwiseRow(a, c, (row) => {
      row.campaignId = "20261003T100000-other";
    });
    const pairwise = [
      pairwiseRow(a, b),
      pairwiseRow(a, b, (row) => {
        row.family = GraderFamily.Claude;
      }),
      pairwiseRow(b, a),
      pairwiseRow(a, failed),
      pairwiseRow(canary, b),
      otherCampaign,
    ];
    const pairs = campaignPairs([a, b, c, failed, canary], pairwise, CAMPAIGN);
    assert.deepEqual(
      pairs.map((pair) => [pair.first.runId, pair.second.runId]),
      [[a.runId, b.runId]],
    );
  });

  it("pairs every two lanes of one case and rep when no judge ran yet", () => {
    const runs = [
      ...LANES.slice(0, 3).map((lane) => runRow(lane, 1)),
      ...LANES.slice(0, 2).map((lane) => runRow(lane, 2)),
    ];
    const pairs = campaignPairs(runs, [], CAMPAIGN);
    assert.equal(pairs.length, 3 + 1);
    for (const pair of pairs) {
      assert.notEqual(pair.first.lane.id, pair.second.lane.id);
      assert.equal(pair.first.runId.slice(-3), pair.second.runId.slice(-3));
    }
  });

  it("draws placement from a recorded seed that does not depend on the pair's order", () => {
    const a = "20261002T101500-genex-claude-sample-case-r1";
    const b = "20261002T101500-raw-claude-sample-case-r1";
    const seed = placementSeedFor("s1", a, b);
    assert.equal(seed, placementSeedFor("s1", b, a));
    assert.notEqual(seed, placementSeedFor("s2", a, b));
    assert.match(seed, SEED_PATTERN);
    assert.equal(firstOnLeft(seed), firstOnLeft(seed));
    const sides = new Set(Array.from({ length: 16 }, (_, index) => firstOnLeft(placementSeedFor(`s${index}`, a, b))));
    assert.equal(sides.size, 2);
  });
});

describe("eval review tasks: sessions", () => {
  it("builds the same session from the same seed and leaves out pairs this reviewer already answered", async () => {
    const root = path.join(await tmpDir("eval-review-plan-"), "evidence");
    const runs = LANES.map((lane) => runRow(lane));
    const request = { campaignId: CAMPAIGN, mode: ReviewMode.Pair, seed: "s5", reviewerId: REVIEWER, sample: null };
    const first = await loadReviewTasks(request, memorySource(root, { runs }));
    assert.equal(first.length, 6);
    assert.deepEqual(await loadReviewTasks(request, memorySource(root, { runs })), first);
    const done = first[0] as PairTask;
    const base = {
      campaignId: CAMPAIGN,
      caseId: done.caseId,
      caseVersion: done.caseVersion,
      placementSeed: done.placementSeed,
      recordedAt: "2026-10-02T14:00:00Z",
      reviewSeconds: 30,
    };
    const answer = {
      leftRunId: done.right.runId,
      rightRunId: done.left.runId,
      pick: HumanPick.Tie,
      defect: DefectCode.None,
      satisfied: { a: CheckResult.Unknown, b: CheckResult.Unknown },
    };
    const human = [
      pairReviewRow({ ...base, reviewerId: REVIEWER }, answer),
      pairReviewRow({ ...base, reviewerId: "aaaaaaaa" }, answer),
    ];
    const resumed = (await loadReviewTasks(request, memorySource(root, { runs, human }))) as PairTask[];
    assert.equal(resumed.length, 5);
    assert.ok(!resumed.map(pairKeyOf).includes(pairKeyOf(done)));
    const otherReviewer = await loadReviewTasks(
      { ...request, reviewerId: "bbbbbbbb" },
      memorySource(root, { runs, human }),
    );
    assert.equal(otherReviewer.length, 6);
  });

  it("shows a case's brief only while the case file still holds the version the run was built from", async () => {
    const root = path.join(await tmpDir("eval-review-brief-"), "evidence");
    const runs = LANES.slice(0, 2).map((lane) => runRow(lane));
    const run = runs[0] as RunRow;
    const evalCase = {
      id: run.case.id,
      version: run.case.version,
      label: "Mini golf",
      brief: "Make a mini golf game.",
    };
    const request = { campaignId: CAMPAIGN, mode: ReviewMode.Pair, seed: "s6", reviewerId: REVIEWER, sample: null };
    const same = await loadReviewTasks(request, memorySource(root, { runs, cases: [evalCase as EvalCase] }));
    assert.deepEqual(same[0]?.caseText, { label: "Mini golf", brief: "Make a mini golf game." });
    const moved = await loadReviewTasks(
      request,
      memorySource(root, { runs, cases: [{ ...evalCase, version: "ffffffffffff" } as EvalCase] }),
    );
    assert.equal(moved[0]?.caseText, null);
  });
});

describe("eval review tasks: grader-validation sample", () => {
  it("samples 10% of the judged items, at least five, unless the session names a number", () => {
    const table: Array<[available: number, requested: number | null, size: number]> = [
      [0, null, 0],
      [3, null, 3],
      [40, null, 5],
      [51, null, 6],
      [100, null, 10],
      [100, 7, 7],
      [4, 9, 4],
    ];
    for (const [available, requested, size] of table)
      assert.equal(validationSampleSize(available, requested), size, `${available} ${requested}`);
  });

  it("samples only judged items of reviewable runs, and never one this reviewer already labelled", async () => {
    const root = path.join(await tmpDir("eval-review-sample-"), "evidence");
    const runs = LANES.map((lane) => runRow(lane));
    const failed = runRow("raw-failed", 1, (row) => {
      row.outcome.harnessFailure = HarnessFailure.RateLimited;
    });
    for (const row of [...runs, failed]) await writeRunEvidence(root, row, 1, checklistResult());
    const request = {
      campaignId: CAMPAIGN,
      mode: ReviewMode.GraderValidation,
      seed: "s7",
      reviewerId: REVIEWER,
      sample: 100,
    };
    const all = (await loadReviewTasks(request, memorySource(root, { runs: [...runs, failed] }))) as ItemTask[];
    assert.equal(all.length, runs.length * 2);
    assert.ok(all.every((task) => task.runId !== failed.runId && task.item.id !== "sample-case-03"));
    const labelled = all[0] as ItemTask;
    const base = {
      campaignId: CAMPAIGN,
      caseId: labelled.caseId,
      caseVersion: labelled.caseVersion,
      reviewerId: REVIEWER,
      placementSeed: "s7",
      recordedAt: "2026-10-02T14:00:00Z",
      reviewSeconds: 10,
    };
    const human = [
      graderValidationRow(base, {
        runId: labelled.runId,
        itemId: labelled.item.id,
        verdicts: labelled.item.verdicts,
        human: ItemVerdict.Pass,
        defect: DefectCode.None,
      }),
    ];
    const rest = (await loadReviewTasks(request, memorySource(root, { runs, human }))) as ItemTask[];
    assert.equal(rest.length, all.length - 1);
    assert.ok(!rest.some((task) => task.runId === labelled.runId && task.item.id === labelled.item.id));
    const sampled = await loadReviewTasks({ ...request, sample: null }, memorySource(root, { runs }));
    assert.equal(sampled.length, 5);
    assert.deepEqual(sampled, await loadReviewTasks({ ...request, sample: null }, memorySource(root, { runs })));
  });
});

describe("eval review command", () => {
  it("parses a campaign and its flags, and refuses anything else", () => {
    const table: Array<[args: string[], expected: ReturnType<typeof parseReviewArgs>]> = [
      [[CAMPAIGN], { campaignId: CAMPAIGN, mode: ReviewMode.Pair, sample: null, seed: null, reviewerId: null }],
      [
        [CAMPAIGN, "--graders", "--sample", "12", "--seed", "abc9", "--reviewer", "0a1b2c3d"],
        { campaignId: CAMPAIGN, mode: ReviewMode.GraderValidation, sample: 12, seed: "abc9", reviewerId: "0a1b2c3d" },
      ],
      [[], null],
      [["not a campaign"], null],
      [[CAMPAIGN, "--sample", "0"], null],
      [[CAMPAIGN, "--sample"], null],
      [[CAMPAIGN, "--seed", "Has-Caps"], null],
      [[CAMPAIGN, "--reviewer", ["someone", "example.com"].join("@")], null],
      [[CAMPAIGN, "--reviewer", "Ivan"], null],
      [[CAMPAIGN, "--open"], null],
    ];
    for (const [args, expected] of table) assert.deepEqual(parseReviewArgs(args), expected, args.join(" "));
  });

  it("keeps one random hex reviewer id under the home and replaces anything that is not one", async () => {
    const home = await tmpDir("eval-review-reviewer-");
    const minted = await localReviewerId(home);
    assert.match(minted, REVIEWER_ID_PATTERN);
    assert.equal(await localReviewerId(home), minted);
    await writeFile(path.join(home, REVIEWER_ID_FILE), ["someone", "example.com"].join("@"));
    const replaced = await localReviewerId(home);
    assert.match(replaced, REVIEWER_ID_PATTERN);
    assert.equal((await readFile(path.join(home, REVIEWER_ID_FILE), "utf8")).trim(), replaced);
  });

  it("serves a campaign from the real ledger and writes the answers there", async () => {
    const user = await tmpDir("eval-review-command-");
    const home = path.join(user, ".genex-evals");
    const paths = evalsPaths(home);
    const runs = LANES.slice(0, 2).map((lane) => runRow(lane));
    for (const row of runs) {
      await appendLedgerRow(row, { paths, homes: defaultHomes(user) });
      await writeRunEvidence(paths.evidence, row, 2);
    }
    const out: string[] = [];
    const env = { GENEX_EVALS_HOME: home };
    const code = await reviewCommand({
      out: (line) => out.push(line),
      env,
      repoRoot: user,
      write: (target) => (row) => appendLedgerRow(row, { paths: target, homes: defaultHomes(user) }).then(() => {}),
      untilDone: async (handle) => {
        const view = await nextView(handle);
        assert.ok(view.task);
        assert.equal((await postAnswer(handle, pairAnswer(view.task.taskId))).status, 200);
        await handle.finished;
      },
    })([CAMPAIGN, "--seed", "s8"]);
    assert.equal(code, 0);
    assert.ok(out.some((line) => line.startsWith(`${ReviewLine.Serving} http://${REVIEW_HOST}:`)));
    assert.ok(out.includes(`${ReviewLine.Done} 1/1`));
    const rows = await readHumanRows(paths);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.reviewerId, (await readFile(path.join(home, REVIEWER_ID_FILE), "utf8")).trim());
    const resumed = await reviewCommand({ out: (line) => out.push(line), env, repoRoot: user })([CAMPAIGN]);
    assert.equal(resumed, 0);
    assert.equal(out.at(-1), ReviewLine.NothingToReview);
    assert.equal(await reviewCommand({ out: (line) => out.push(line) })(["--graders"]), EXIT_USAGE);
  });
});

describe("review over a graded campaign", () => {
  it("reads the checklist and frames the grade command kept, in both modes", async () => {
    const h = await harness();
    await seedCampaign(h);
    assert.equal((await gradeCampaign(GRADING_CAMPAIGN, h.deps)).graded.length, 4);
    const runs = currentRows(await readRunRows(h.deps.paths));
    const pairwise = await readPairwiseRows(h.deps.paths);
    const source = evidenceReviewSource(
      h.deps.paths.evidence,
      { runs: async () => runs, pairwise: async () => pairwise, human: async () => [] },
      [gradingCase],
    );
    const request = { campaignId: GRADING_CAMPAIGN, seed: "s9", reviewerId: REVIEWER, sample: 100 };
    const items = (await loadReviewTasks({ ...request, mode: ReviewMode.GraderValidation }, source)) as ItemTask[];
    assert.equal(items.length, runs.length * gradingCase.acceptance.length, "every judged item of every graded run");
    assert.ok(items.every((task) => task.side.frames.length > 0 && task.item.verdicts[GraderFamily.Claude]));
    const pairs = (await loadReviewTasks({ ...request, mode: ReviewMode.Pair }, source)) as PairTask[];
    assert.ok(pairs.length > 0);
    assert.ok(pairs.every((task) => task.left.frames.length > 0 && task.right.frames.length > 0));
  });
});
