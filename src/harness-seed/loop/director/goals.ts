/** Durable acceptance belongs to the request, never to a disposable worker id. */
export const GoalStatus = {
  Pending: "pending",
  Passed: "passed",
  Failed: "failed",
  Blocked: "blocked",
  Unverified: "unverified",
} as const;
export type GoalStatus = (typeof GoalStatus)[keyof typeof GoalStatus];
export const GoalBlocker = {
  Approval: "approval_required",
  Network: "network_unavailable",
  Hosted: "hosted_verification_unavailable",
  NoProgress: "no_verified_progress",
} as const;
export type GoalBlocker = (typeof GoalBlocker)[keyof typeof GoalBlocker];
const ATTEMPTS_BEFORE_REPLAN = 2;
const ATTEMPTS_AFTER_REPLAN = 1;
const MAX_REPLAN_CHARS = 1500;

export interface RunGoal {
  multiplayer?: boolean;
  id: string;
  required: boolean;
  acceptance: string[];
  status: GoalStatus;
  head: string | null;
  attempts: number;
  replan: string | null;
  blocker: GoalBlocker | null;
  /** Acceptance indices independently verified on head; best count measures progress across attempts. */
  verified?: number[];
  bestCount?: number;
}
export interface GoalLedger {
  version: 1;
  scopeRevisions?: string[];
  entries: RunGoal[];
}

/**
 * Freeze initial plan outcomes; future plans assign workers without replacing these goals. A part
 * the plan built beyond the user's ask (`added`, loop/scope.ts) is an optional goal: it never
 * holds the finish, and the ask the user made is what gets frozen.
 */
export function createGoals(
  parts: readonly { id: string; done: string[]; multiplayer?: boolean; added?: boolean }[],
): GoalLedger {
  return {
    version: 1,
    entries: parts.map(({ id, done, multiplayer, added }) => ({
      ...(multiplayer ? { multiplayer: true } : {}),
      id,
      required: added !== true,
      acceptance: [...done],
      status: GoalStatus.Pending,
      head: null,
      attempts: 0,
      replan: null,
      blocker: null,
    })),
  };
}

/** A required blocker suspends only after the remaining independent requirements are verified. */
export function goalDecision(ledger: GoalLedger, head: string | null): GoalStatus {
  const required = ledger.entries.filter((goal) => goal.required);
  if (!required.length) return GoalStatus.Unverified;
  const unresolved = required.filter((goal) => goal.status !== GoalStatus.Passed || !head || goal.head !== head);
  if (!unresolved.length) return GoalStatus.Passed;
  return unresolved.every((goal) => goal.status === GoalStatus.Blocked) ? GoalStatus.Blocked : GoalStatus.Pending;
}

/** Validate before allocating any worker resource; a renamed worker shares the goal's attempt budget. */
export function goalAttemptRefusal(ledger: GoalLedger, id: string): string | null {
  const goal = ledger.entries.find((entry) => entry.id === id);
  if (!goal) return "worker_start needs goal=<initial required goal id>; changing a worker id does not change scope";
  if (goal.status === GoalStatus.Passed)
    return `goal ${id} is already verified; advance another required gap, or recheck it on the changed integration revision before rebuilding`;
  if (goal.status === GoalStatus.Blocked)
    return `goal ${id} is blocked: ${goal.blocker}; report the prerequisite before more work`;
  const limit = ATTEMPTS_BEFORE_REPLAN + (goal.replan ? ATTEMPTS_AFTER_REPLAN : 0);
  if (goal.attempts >= limit)
    return `goal ${id} made no verified progress: ${goal.replan ? "pause and report the unresolved acceptance" : "record one concrete replan with goal_update before another attempt"}`;
  return null;
}

/** Charge only a worker that is actually ready to launch. */
export function startGoalAttempt(ledger: GoalLedger, id: string): string | null {
  const refusal = goalAttemptRefusal(ledger, id);
  if (refusal) return refusal;
  const goal = ledger.entries.find((entry) => entry.id === id);
  if (goal) goal.attempts += 1;
  return null;
}

/** Only production verification calls this; model-authored status updates cannot manufacture a pass. */
export function recordGoalEvidence(
  ledger: GoalLedger,
  id: string,
  head: string,
  passed: boolean | undefined,
  scenario?: number,
): void {
  const goal = ledger.entries.find((entry) => entry.id === id);
  if (!goal || !goal.acceptance.length) return;
  if (goal.head !== head) goal.verified = [];
  const verified = new Set(goal.verified ?? []);
  const indices = scenario === undefined ? goal.acceptance.map((_, index) => index) : [scenario];
  for (const index of indices) {
    if (index < 0 || index >= goal.acceptance.length) continue;
    if (passed) verified.add(index);
    else verified.delete(index);
  }
  goal.verified = [...verified];
  goal.head = head;
  goal.status = GoalStatus.Unverified;
  if (passed !== undefined) goal.status = GoalStatus.Failed;
  if (verified.size === goal.acceptance.length) goal.status = GoalStatus.Passed;
  recordProgress(goal, verified.size, passed);
}

function recordProgress(goal: RunGoal, count: number, passed: boolean | undefined): void {
  if (count > (goal.bestCount ?? 0)) {
    goal.bestCount = count;
    goal.attempts = 0;
    goal.replan = null;
    goal.blocker = null;
  }
  if (!passed && goal.replan && goal.attempts >= ATTEMPTS_BEFORE_REPLAN + ATTEMPTS_AFTER_REPLAN) {
    goal.status = GoalStatus.Blocked;
    goal.blocker = GoalBlocker.NoProgress;
  }
}

/** Restore only the versioned ledger shape; old journals are migrated from their original plan. */
export function restoreGoals(value: unknown): GoalLedger | undefined {
  if (
    !value ||
    typeof value !== "object" ||
    !("version" in value) ||
    value.version !== 1 ||
    !("entries" in value) ||
    !Array.isArray(value.entries)
  )
    return undefined;
  const valid = value.entries.every(
    (goal) =>
      goal &&
      typeof goal.id === "string" &&
      Array.isArray(goal.acceptance) &&
      goal.acceptance.every((item: unknown) => typeof item === "string") &&
      Object.values(GoalStatus).includes(goal.status) &&
      typeof goal.attempts === "number" &&
      Number.isFinite(goal.attempts) &&
      goal.attempts >= 0,
  );
  if (!valid) return undefined;
  return {
    version: 1,
    scopeRevisions:
      "scopeRevisions" in value && Array.isArray(value.scopeRevisions)
        ? value.scopeRevisions.filter((entry): entry is string => typeof entry === "string")
        : [],
    entries: value.entries.map((goal) => ({
      id: goal.id,
      ...(goal.multiplayer === true ? { multiplayer: true } : {}),
      required: goal.required !== false,
      acceptance: [...goal.acceptance],
      status: goal.status,
      head: typeof goal.head === "string" ? goal.head : null,
      attempts: goal.attempts,
      replan: typeof goal.replan === "string" ? goal.replan : null,
      blocker: Object.values(GoalBlocker).includes(goal.blocker) ? goal.blocker : null,
      verified: Array.isArray(goal.verified)
        ? goal.verified.filter(
            (index: unknown) => Number.isInteger(index) && Number(index) >= 0 && Number(index) < goal.acceptance.length,
          )
        : [],
      bestCount: typeof goal.bestCount === "number" ? goal.bestCount : 0,
    })),
  };
}

/** A user steer can revise scope once; a routine plan replacement cannot redefine acceptance. */
export function reviseGoals(
  ledger: GoalLedger,
  parts: readonly { id: string; done: string[]; multiplayer?: boolean }[],
  instruction: string,
  userInstructions: readonly string[],
): GoalLedger | null {
  if (!parts.length || parts.some((part) => !part.done.length || part.done.some((item) => !item.trim()))) return null;
  if (!instruction || !userInstructions.includes(instruction) || ledger.scopeRevisions?.includes(instruction))
    return null;
  const next = createGoals(parts);
  next.scopeRevisions = [...(ledger.scopeRevisions ?? []), instruction];
  next.entries = next.entries.map((goal) => {
    const previous = ledger.entries.find(
      (entry) =>
        entry.id === goal.id &&
        entry.multiplayer === goal.multiplayer &&
        JSON.stringify(entry.acceptance) === JSON.stringify(goal.acceptance),
    );
    return previous ? structuredClone(previous) : goal;
  });
  return next;
}

/** One bounded replan per gap, after attempts have failed to establish progress. */
export function replanGoal(goal: RunGoal, reason: unknown): boolean {
  const canReplan =
    !goal.replan && goal.attempts >= ATTEMPTS_BEFORE_REPLAN && typeof reason === "string" && reason.trim().length > 0;
  if (!canReplan) return false;
  goal.replan = reason.trim().slice(0, MAX_REPLAN_CHARS);
  return true;
}
