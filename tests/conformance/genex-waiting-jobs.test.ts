/**
 * Genex's jobs with no file in the game yet, as the Assets inventory lists them (`ProjectAssets.jobs`)
 * in the shared words: one per generation, saying what it makes, where it is and the tool its lane
 * is routed to. A call that makes nothing and an approved review have none, and neither may hide
 * the job of the generation it shares an id with.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, it } from "node:test";
import { type AssetJobRecord, reconcileGeneratedAssets } from "../../src/main/game-assets.ts";
import { GenexTool, MakingKind, MakingPhase } from "../../src/shared/asset-making.ts";
import { GenexBlocked, GenexJobStatus, GenexOperation } from "../../src/shared/genex.ts";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "genex-waiting-"));
  await mkdir(path.join(root, "game"));
});
after(() => rm(root, { recursive: true, force: true }));

const empty = () => ({ project: "game", assets: [], truncated: false, skipped: [] });
const record = (id: string, over: Partial<AssetJobRecord>): AssetJobRecord => ({ id, files: [], ...over });
const NOW = Date.parse("2026-10-13T12:30:00.000Z");
const waiting = async (jobs: AssetJobRecord[], now = NOW) =>
  (await reconcileGeneratedAssets(path.join(root, "game"), root, empty(), jobs, [], [], now)).jobs ?? [];

it("lists a generation in the shared words: its kind, its phase and its routed tool", async () => {
  const jobs = await waiting([
    record("a", {
      operation: GenexOperation.Character,
      status: GenexJobStatus.Generating,
      prompt: "Knight",
      createdAt: "2026-10-13T12:00:00.000Z",
    }),
  ]);
  assert.deepEqual(jobs, [
    {
      source: "genex",
      jobId: "a",
      phase: MakingPhase.Making,
      kind: MakingKind.Character,
      tool: GenexTool.Meshy,
      at: "2026-10-13T12:00:00.000Z",
      operation: GenexOperation.Character,
      prompt: "Knight",
      pluginStatus: GenexJobStatus.Generating,
    },
  ]);
});

it("never lists a character's clips, a catalog search or a status as a job", async () => {
  const lookups = [GenexOperation.CharacterMotions, GenexOperation.AnimationsSearch, GenexOperation.Status];
  const jobs = await waiting(
    lookups.map((operation, i) => record(`l${i}`, { operation, status: GenexJobStatus.Generated })),
  );
  assert.deepEqual(jobs, []);
});

it("keeps a generation's job when a wait for it, or its approved review, shares its id", async () => {
  // Folder names order the records; the wait and the approved review sort after the job they share an id with.
  const jobs = await waiting([
    record("1-create", { operation: GenexOperation.Model, status: GenexJobStatus.Generating, generationId: "gen-1" }),
    record("2-wait", { operation: GenexOperation.Wait, status: GenexJobStatus.Generating, generationId: "gen-1" }),
    record("3-finalize", {
      operation: GenexOperation.CharacterFinalize,
      status: GenexJobStatus.ApprovalRequired,
      generationId: "gen-2",
    }),
    record("4-preview", {
      operation: GenexOperation.CharacterPreview,
      status: GenexJobStatus.Approved,
      generationId: "gen-2",
    }),
  ]);
  assert.deepEqual(
    jobs.map((job) => [job.jobId, job.operation, job.phase]),
    [
      ["gen-1", GenexOperation.Model, MakingPhase.Making],
      ["gen-2", GenexOperation.CharacterFinalize, MakingPhase.Review],
    ],
  );
});

it("says a job that delivered files the game no longer holds is not in the game, never still making", async () => {
  const [job] = await waiting([
    record("d", {
      operation: GenexOperation.Image,
      status: GenexJobStatus.Generating,
      files: ["assets/genex/d/a.png"],
    }),
  ]);
  assert.deepEqual([job?.phase, job?.delivered], [MakingPhase.NotInGame, true]);
});

it("lists no card for requests Genex refused before starting one, however many the agent retried", async () => {
  const refused = Array.from({ length: 11 }, (_, i) =>
    record(`r${i}`, { operation: GenexOperation.Character, status: GenexJobStatus.Failed, prompt: "Imperial guard" }),
  );
  const jobs = await waiting([
    ...refused,
    record("lost", { operation: GenexOperation.Model, status: GenexJobStatus.Failed, generationId: "gen-lost" }),
  ]);
  assert.deepEqual(
    jobs.map((job) => [job.jobId, job.phase]),
    [["gen-lost", MakingPhase.Failed]],
    "a generation that failed still says so",
  );
});

it("says a job that still claims to be made hours after it started is not confirmed, not still making", async () => {
  const started = "2026-10-13T12:00:00.000Z";
  const job = record("old", {
    operation: GenexOperation.Creature,
    status: GenexJobStatus.Accepted,
    createdAt: started,
  });
  assert.equal((await waiting([job], Date.parse(started) + 40 * 60_000))[0]?.phase, MakingPhase.Making);
  assert.equal((await waiting([job], Date.parse(started) + 3 * 3_600_000))[0]?.phase, MakingPhase.Unsure);
});

it("lists a request refused for too few credits as waiting on credits, and still no card for other refusals", async () => {
  const jobs = await waiting([
    record("short", {
      operation: GenexOperation.Model,
      status: GenexJobStatus.Failed,
      blocked: GenexBlocked.Credits,
      prompt: "Dragon boss",
    }),
    record("quote", { operation: GenexOperation.Model, status: GenexJobStatus.Failed, prompt: "Imperial guard" }),
  ]);
  assert.deepEqual(
    jobs.map((job) => [job.jobId, job.phase, job.prompt]),
    [["short", MakingPhase.NeedsCredits, "Dragon boss"]],
  );
});

it("waits on credits only for a job that ended unmade: one still being made is being made", async () => {
  const jobs = await waiting([
    record("made", {
      operation: GenexOperation.Model,
      status: GenexJobStatus.Generating,
      blocked: GenexBlocked.Credits,
    }),
  ]);
  assert.equal(jobs[0]?.phase, MakingPhase.Making);
});

it("carries what a job costs onto its card, and nothing when Genex never named a price", async () => {
  const jobs = await waiting([
    record("priced", { operation: GenexOperation.Model, status: GenexJobStatus.Generating, credits: 35 }),
    record("plain", { operation: GenexOperation.Image, status: GenexJobStatus.Generating }),
  ]);
  assert.deepEqual(
    jobs.map((job) => [job.jobId, job.credits]),
    [
      ["priced", 35],
      ["plain", undefined],
    ],
  );
});
