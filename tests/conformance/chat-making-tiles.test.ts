/**
 * The chat's cards of what a piece of work is still making are a view of the game's inventory: a
 * step's card is the waiting job that goes by one of its ids, once, in the order the steps ran, so
 * a card ends with its job. The inventory is read while it has not been, while a step still runs,
 * or while a shown job is on its way, and not otherwise: an old chat reads it once.
 */
import assert from "node:assert/strict";
import { it } from "node:test";
import { MakingKind, type MakingJob, MakingPhase } from "../../src/shared/asset-making.ts";
import { jobsOfCalls, keepsReading, makingCalls } from "../../src/renderer/chat/making-calls.ts";
import { ActivityItemKind, type ActivityItem } from "../../src/renderer/chat/conversation-entries.ts";
import { ToolState } from "../../src/renderer/ui/tool-state.ts";

const job = (jobId: string, phase: MakingPhase = MakingPhase.Making): MakingJob => ({
  source: "genex",
  jobId,
  kind: MakingKind.Image,
  phase,
});

it("finds each step's waiting job by any of its ids, once, in the steps' order", () => {
  const jobs = [job("g-2"), job("call-1"), job("gen-1")];
  const shown = jobsOfCalls(jobs, [
    { ids: ["call-1"], running: true },
    { ids: ["call-9", "job-2", "g-2"], running: false },
    { ids: ["call-3", "gen-1"], running: false },
    { ids: ["call-4", "gen-1"], running: false },
    { ids: ["call-5", "landed"], running: false },
  ]);
  assert.deepEqual(
    shown.map((found) => found.jobId),
    ["call-1", "g-2", "gen-1"],
  );
});

it("keeps the inventory fresh only while it is unread or something is on its way", () => {
  const ended = [{ ids: ["a"], running: false }];
  assert.equal(keepsReading(false, ended, []), true, "an inventory not read yet is read");
  assert.equal(keepsReading(true, [{ ids: ["a"], running: true }], []), true, "a step still running");
  assert.equal(keepsReading(true, ended, [job("a")]), true, "a job being made");
  assert.equal(keepsReading(true, ended, [job("a", MakingPhase.Review)]), true, "a job waiting on the person");
  assert.equal(keepsReading(true, ended, [job("a", MakingPhase.Failed)]), false, "a job that ended");
  assert.equal(keepsReading(true, ended, []), false, "nothing left to watch");
});

it("takes a work's making steps from its tool rows alone", () => {
  const tool = (key: string, making: string[] | null, state: ToolState): ActivityItem => ({
    kind: ActivityItemKind.Tool,
    id: key,
    tool: { key, icon: "game", label: "Genex", state, ...(making ? { making: { ids: making } } : {}) },
  });
  const items: ActivityItem[] = [
    tool("a", ["a", "j"], ToolState.Succeeded),
    tool("b", null, ToolState.Running),
    { kind: ActivityItemKind.Note, id: "n", text: "a note" },
    tool("c", ["c"], ToolState.Running),
  ];
  assert.deepEqual(makingCalls(items), [
    { ids: ["a", "j"], running: false },
    { ids: ["c"], running: true },
  ]);
});
