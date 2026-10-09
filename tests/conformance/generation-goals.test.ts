import assert from "node:assert/strict";
import { it } from "node:test";
import {
  createGoals,
  goalDecision,
  startGoalAttempt,
  recordGoalEvidence,
  GoalStatus,
  restoreGoals,
  reviseGoals,
} from "../../src/harness-seed/loop/director/goals.ts";

it("required acceptance stays fixed across renamed workers and stops on current evidence", () => {
  const goals = createGoals([{ id: "online", done: ["Two players exchange a legal move"] }]);
  assert.equal(startGoalAttempt(goals, "online"), null);
  assert.equal(startGoalAttempt(goals, "online"), null);
  assert.match(startGoalAttempt(goals, "online") ?? "", /replan/);
  assert.equal(goalDecision(goals, "a"), GoalStatus.Pending);
  recordGoalEvidence(goals, "online", "a", true);
  assert.equal(goalDecision(goals, "a"), GoalStatus.Passed);
  assert.equal(goalDecision(goals, "b"), GoalStatus.Pending, "new revision invalidates the completion claim");
});

it("blocked multiplayer cannot be replaced by optional cosmetics", () => {
  const goals = createGoals([
    { id: "online", done: ["Two clients play"] },
    { id: "board", done: ["Local legal moves"] },
  ]);
  const online = goals.entries[0];
  assert.ok(online);
  online.status = GoalStatus.Blocked;
  online.blocker = "approval_required";
  assert.equal(goalDecision(goals, "a"), GoalStatus.Pending, "independent required work may continue");
  recordGoalEvidence(goals, "board", "a", true);
  assert.equal(goalDecision(goals, "a"), GoalStatus.Blocked);
  assert.match(startGoalAttempt(goals, "new-cosmetics") ?? "", /initial required goal/);
  assert.match(startGoalAttempt(goals, "online") ?? "", /blocked/);
});

it("measured partial acceptance resets attempts while repeating a failed check does not", () => {
  const goals = createGoals([{ id: "rules", done: ["Legal moves", "Checkmate"] }]);
  startGoalAttempt(goals, "rules");
  startGoalAttempt(goals, "rules");
  recordGoalEvidence(goals, "rules", "a", true, 0);
  assert.equal(goals.entries[0]?.attempts, 0);
  assert.equal(goalDecision(goals, "a"), GoalStatus.Pending);
  startGoalAttempt(goals, "rules");
  recordGoalEvidence(goals, "rules", "a", false, 1);
  assert.equal(goals.entries[0]?.attempts, 1);
  recordGoalEvidence(goals, "rules", "a", true, 1);
  assert.equal(goalDecision(goals, "a"), GoalStatus.Passed);
});

it("scope changes need a new user steer and cannot replay one to reset attempts", () => {
  const goals = createGoals([{ id: "board", done: ["Local chess"] }]);
  const parts = [{ id: "online", done: ["Two clients play"] }];
  assert.equal(reviseGoals(goals, parts, "invented", []), null);
  const revised = reviseGoals(goals, parts, "add online play", ["add online play"]);
  assert.ok(revised);
  assert.equal(revised.entries[0]?.id, "online");
  assert.equal(reviseGoals(revised, parts, "add online play", ["add online play"]), null);
});

it("scope revisions cannot erase measurable acceptance", () => {
  const goals = createGoals([{ id: "board", done: ["Legal chess"] }]);
  assert.equal(reviseGoals(goals, [{ id: "board", done: [] }], "change board", ["change board"]), null);
});

it("soft review reports gaps once without treating the review time as a deadline", async () => {
  const { progressReview } = await import("../../src/harness-seed/loop/director/progress.ts");
  const goals = createGoals([{ id: "board", done: ["Legal chess"] }]);
  assert.equal(progressReview(goals, "a", 29 * 60_000, false), null);
  assert.match(progressReview(goals, "a", 30 * 60_000, false) ?? "", /0\/1 outcomes verified/);
  assert.equal(progressReview(goals, "a", 31 * 60_000, true), null);
});

it("missing interaction evidence stays unverified rather than becoming a failed gameplay claim", () => {
  const goals = createGoals([{ id: "online", done: ["Two clients exchange moves"] }]);
  recordGoalEvidence(goals, "online", "head", undefined);
  assert.equal(goals.entries[0]?.status, GoalStatus.Unverified);
  assert.notEqual(goalDecision(goals, "head"), GoalStatus.Passed);
});

it("two attempts allow one replan and a third failure blocks renamed work", async () => {
  const { replanGoal, GoalBlocker } = await import("../../src/harness-seed/loop/director/goals.ts");
  const goals = createGoals([{ id: "online", done: ["Two clients exchange moves"] }]);
  const goal = goals.entries[0];
  assert.ok(goal);
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal(startGoalAttempt(goals, "online"), null);
    recordGoalEvidence(goals, "online", "head", false);
  }
  assert.equal(replanGoal(goal, "Check relay admission before changing cosmetics"), true);
  assert.equal(replanGoal(goal, "Try again"), false);
  assert.equal(startGoalAttempt(goals, "online"), null);
  recordGoalEvidence(goals, "online", "head", false);
  assert.equal(goal.blocker, GoalBlocker.NoProgress);
  assert.equal(goalDecision(goals, "head"), GoalStatus.Blocked);
  assert.match(startGoalAttempt(goals, "renamed") ?? "", /initial required goal/);
});

it("a verified goal cannot receive cosmetic workers while another required goal is unfinished", () => {
  const goals = createGoals([
    { id: "board", done: ["Local legal moves"] },
    { id: "online", done: ["Two clients play"] },
  ]);
  recordGoalEvidence(goals, "board", "head", true);
  assert.match(startGoalAttempt(goals, "board") ?? "", /verified/);
  assert.equal(startGoalAttempt(goals, "online"), null);
});

it("a part the plan added beyond the user's ask is an optional goal: the required ones decide, and an older ledger stays required", () => {
  const goals = createGoals([
    { id: "race", done: ["Four rivals race one lap"] },
    { id: "pursuit", done: ["A pursuit meter fills"], added: true },
  ]);
  assert.deepEqual(
    goals.entries.map((goal) => [goal.id, goal.required]),
    [
      ["race", true],
      ["pursuit", false],
    ],
  );
  recordGoalEvidence(goals, "race", "a", true);
  assert.equal(goalDecision(goals, "a"), GoalStatus.Passed, "the added part never holds the finish");
  const older = restoreGoals({ ...goals, entries: goals.entries.map(({ required: _, ...goal }) => goal) });
  assert.deepEqual(
    older?.entries.map((goal) => goal.required),
    [true, true],
    "a journal from before the flag keeps every goal required",
  );
});
