/**
 * The Report and model-check half of play-time AI's IPC host (`main/ipc/game-ai-report-check.ts`):
 * after the registrar read each payload, a project still has to be a game of the library whose
 * folder is a real folder (never a link someone put in the library, never a file or a missing
 * folder) before the check reads or spends anything; a refusal touches nothing. Reports and the
 * check are reached only through it, the check always on all the creator's own models.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AiCheckState, type AiCheckResult, type AiPublishFacts } from "../../src/shared/game-ai-check.ts";
import { AiDoor } from "../../src/shared/game-ai.ts";
import { AiReportKind, AiReportReason, type AiReportBundle } from "../../src/shared/game-ai-report.ts";
import { reportCheckIpcHost } from "../../src/main/ipc/game-ai-report-check.ts";
import type { GameAiModelCheck } from "../../src/main/game-ai/types.ts";
import { PLAY_GAME } from "../helpers/game-ai-traces.ts";
import { tmpDir } from "../helpers/tmp.ts";

const BUNDLE: AiReportBundle = {
  v: 1,
  id: "report-0001",
  kind: AiReportKind.Player,
  createdAt: "2026-10-20T18:00:00.000Z",
  game: { key: PLAY_GAME, title: "Crowns of 1444" },
  reason: AiReportReason.Other,
  note: null,
  calls: [],
  replay: { seed: null, commit: null, engine: "web", templateVersion: null, inputs: [], tape: [] },
  digests: [],
  aiState: null,
  consoleErrors: [],
  frame: null,
  modelCheck: null,
  playerText: true,
};

const result = (project: string): AiCheckResult => ({
  project,
  state: AiCheckState.Ready,
  moments: 3,
  progress: null,
  rows: [],
  recommended: null,
  checkedAt: null,
});

/** A host over a library of real folders, every call to the check and Reports recorded. */
async function host() {
  const root = await tmpDir("studio-ai-ipc-");
  const outside = await tmpDir("studio-ai-ipc-outside-");
  await mkdir(path.join(root, "Lantern Run"));
  await writeFile(path.join(root, "Not A Folder"), "x");
  await symlink(outside, path.join(root, "Linked"));
  const games = ["Lantern Run", "Not A Folder", "Linked", "Gone"].map((name) => ({ name, dir: path.join(root, name) }));
  const calls: unknown[][] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return result(String(args[0]));
    };
  const check: GameAiModelCheck = {
    start: record("start"),
    state: record("state"),
    stop: record("stop"),
    recommend: record("recommend"),
    publishFacts: async (project) => {
      calls.push(["publishFacts", project]);
      const facts: AiPublishFacts = {
        project,
        playtested: false,
        playtestModel: null,
        check: null,
        bestWith: null,
        fits: null,
        cost: null,
        creatorShareBps: null,
      };
      return facts;
    },
  };
  const ipc = reportCheckIpcHost({
    games: async () => games,
    check,
    reports: {
      preview: async (game) => {
        calls.push(["preview", game]);
        return BUNDLE;
      },
      send: async (request) => {
        calls.push(["send", request]);
        return { ok: true, id: "report-0001" };
      },
    },
  });
  return { ipc, calls };
}

describe("the model check over IPC", () => {
  it("runs on a library game on all the creator's own models", async () => {
    const fx = await host();
    await fx.ipc.check("Lantern Run");
    await fx.ipc.checkState("Lantern Run");
    await fx.ipc.checkStop("Lantern Run");
    const model = { door: AiDoor.Local, engine: "ollama", model: "qwen3:8b" };
    await fx.ipc.recommend("Lantern Run", model);
    await fx.ipc.publishFacts("Lantern Run");
    assert.deepEqual(fx.calls, [
      ["start", "Lantern Run", { localOnly: false }],
      ["state", "Lantern Run"],
      ["stop", "Lantern Run"],
      ["recommend", "Lantern Run", model],
      ["publishFacts", "Lantern Run"],
    ]);
  });

  const refused: Array<[string, string]> = [
    ["a name the library does not list", "Other Game"],
    ["a library entry that is a file", "Not A Folder"],
    ["a library entry that is a link", "Linked"],
    ["a library entry whose folder is gone", "Gone"],
  ];
  for (const [name, project] of refused)
    it(`refuses ${name}, and touches nothing`, async () => {
      const fx = await host();
      for (const call of [
        () => fx.ipc.check(project),
        () => fx.ipc.checkState(project),
        () => fx.ipc.checkStop(project),
        () => fx.ipc.recommend(project, null),
        () => fx.ipc.publishFacts(project),
      ])
        await assert.rejects(call(), /not a game in the library/);
      assert.deepEqual(fx.calls, []);
    });
});

describe("Reports over IPC", () => {
  it("previews and sends through Reports", async () => {
    const fx = await host();
    await fx.ipc.reportPreview(PLAY_GAME);
    const request = { game: PLAY_GAME, reason: AiReportReason.Sexual, note: null };
    assert.deepEqual(await fx.ipc.report(request), { ok: true, id: "report-0001" });
    assert.deepEqual(fx.calls, [
      ["preview", PLAY_GAME],
      ["send", request],
    ]);
  });
});
