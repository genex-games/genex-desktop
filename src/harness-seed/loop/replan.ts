/**
 * Checks that can be retired or re-pointed — HARNESS-FIX-PLAN.md WP5, plus the builder →
 * harness channel of WP1e.
 *
 * A check nobody can satisfy (a camera pitched away from what it asks about, a helper whose
 * shape the check misreads) burned 12 iterations of one run with the same failure reason and
 * no way out. Three signals now open a replan: a spike whose VERDICT.md says `unsatisfiable`,
 * a `HARNESS:` line in the builder's notes naming the check, or the same failure reason on
 * four consecutive judged iterations. The planner role — fresh context, the run's planner
 * model — answers `repoint | relax | drop` with a corrected check; the decision is applied at
 * once as a decision card the user can overturn, and a drop stands for one iteration
 * unopposed before it takes effect. Two replans per check, then the check stays as it is.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseVerdict } from "./judge.ts";
import { LIGHT_EFFORT } from "./config.ts";
import { EngineId, plannerModel } from "./model-roles.ts";
import { EngineFailure } from "./outage.ts";
import { HostMethod } from "./host-methods.ts";
import { clip, CLIP_BRIEF, CLIP_QUOTE, CLIP_REASON } from "./text.ts";
import { CheckOrigin, normalizeCheck, validateFacetSpec, type Check } from "./spec.ts";
import { MoveScope } from "./scope.ts";
import {
  NEXT_MOVE_SYSTEM,
  nextMoveUserPrompt,
  REPLAN_SYSTEM,
  replanUserPrompt,
  type PlannedFacet,
} from "./replan-prompts.ts";
import type { AnyRecord, HarnessCtx, Run } from "../types/harness.d.ts";

/** Steering the plan review and a running facet both understand. */
export interface PlanSteering {
  go: boolean;
  drops: string[];
  repoints: Array<{ checkId: string; camera: string }>;
  keeps: string[];
}

/**
 * What becomes of a check nobody can satisfy as written (`facet_check_replanned.action`). The
 * planner answers one of the first three; `keep` is every answer it could not give. The record
 * keeps the value: never rename one.
 */
export const ReplanAction = {
  Repoint: "repoint",
  Relax: "relax",
  Drop: "drop",
  Keep: "keep",
  /** A drop that stands one iteration unopposed before it takes effect. */
  DropPending: "drop-pending",
  /** The builder flagged the check as another facet's, and that facet took it. */
  Rerouted: "rerouted",
} as const;
export type ReplanAction = (typeof ReplanAction)[keyof typeof ReplanAction];

/** The planner's answer about one check: keep or drop it, or the corrected check. */
export type ReplanDecision =
  /** `unanswered`: the planner gave no decision (unreachable, or no usable reply) — not one of its goes. */
  | { action: typeof ReplanAction.Keep; why: string; unanswered?: boolean }
  | { action: typeof ReplanAction.Drop; why: string }
  | { action: typeof ReplanAction.Repoint | typeof ReplanAction.Relax; why: string; check: Check };

/** The actions a planner may answer with; anything else keeps the check. */
const PLANNER_ACTIONS: readonly string[] = [ReplanAction.Repoint, ReplanAction.Relax, ReplanAction.Drop];

/** How many times the loop replans one check on its own; a request from the user is not counted. */
export const MAX_REPLANS_PER_CHECK = 2;
/** Failures in a row for one reason that send a check to the planner (again at every multiple). */
export const REPLAN_AFTER_SAME_REASON = 4;
/** How much of a normalized failure reason is compared. */
const REASON_KEY_CHARS = 160;

/** A failure reason with the volatile parts stripped, so "the same reason" is comparable. */
export function normalizeReason(text: unknown): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/\/[^\s"']+/g, "<path>")
    .replace(/\b\d+(\.\d+)?\b/g, "#")
    .replace(/observed .*$/m, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REASON_KEY_CHARS);
}

/**
 * Lines beginning `HARNESS:` in a facet's notes — the builder talking to the loop, not to the
 * next builder. `{ what, checkId }` per line; the check id is the first check id the line
 * names, if any.
 */
export function harnessFlags(
  notes: unknown,
  checks: ReadonlyArray<{ id?: string }> | null = [],
): Array<{ what: string; checkId?: string }> {
  const flags: Array<{ what: string; checkId?: string }> = [];
  for (const raw of String(notes ?? "").split("\n")) {
    const m = /^\s*(?:[-*]\s*)?HARNESS:\s*(.+)$/i.exec(raw);
    if (!m) continue;
    const what = clip((m[1] ?? "").trim(), CLIP_BRIEF);
    const lower = what.toLowerCase();
    const named =
      ((checks ?? []).map((c) => c.id).filter((id) => id && lower.includes(String(id).toLowerCase())) as string[]).sort(
        (a, b) => b.length - a.length,
      )[0] ?? null;
    flags.push({ what, ...(named ? { checkId: named } : {}) });
  }
  return flags;
}

/** `spike/VERDICT.md` (or the builder's final message): `passes` | `unsatisfiable: <reason>`. */
export function parseSpikeVerdict(text: unknown): { verdict: string; reason: string } | null {
  const source = String(text ?? "").trim();
  if (!source) return null;
  const line = /^\s*(?:[-*#]+\s*)?(passes|unsatisfiable)\b\s*:?\s*(.*)$/im.exec(source);
  if (line) return { verdict: line[1]!.toLowerCase(), reason: clip(line[2]?.trim(), CLIP_REASON) };
  if (/\b(cannot|can't|impossible|unsatisfiable|not (?:be )?satisfiable|geometrically)\b/i.test(source)) {
    return {
      verdict: "unsatisfiable",
      reason: clip(
        source
          .split("\n")
          .find((l) => /cannot|can't|impossible|unsatisfiable|satisfiable|geometrically/i.test(l))
          ?.trim(),
        CLIP_REASON,
      ),
    };
  }
  return null;
}

export async function readSpikeVerdict(
  root: string | null | undefined,
): Promise<{ verdict: string; reason: string } | null> {
  if (!root) return null;
  const text = await readFile(path.join(root, "spike", "VERDICT.md"), "utf8").catch(() => "");
  return parseSpikeVerdict(text);
}

/**
 * Steering the plan review (WP7) and a running facet both understand:
 *   go · drop <check> · repoint <check> to <camera> · keep <check>
 */
export function parsePlanSteering(text: unknown): PlanSteering {
  const out: PlanSteering = { go: false, drops: [], repoints: [], keeps: [] };
  for (const raw of String(text ?? "").split(/\n|;/)) {
    const line = raw.trim().replace(/^\[USER FEEDBACK(?: on [^\]]*)?\]\s*/i, "");
    if (!line) continue;
    if (/^(go|start|continue|proceed|ok|build)\b/i.test(line)) out.go = true;
    let m = /^drop\s+(?:check\s+)?([a-z0-9][a-z0-9-_]*)/i.exec(line);
    if (m) out.drops.push(m[1]!.toLowerCase());
    m = /^repoint\s+(?:check\s+)?([a-z0-9][a-z0-9-_]*)\s+(?:to|at|onto)\s+([a-z0-9:_-]+)/i.exec(line);
    if (m) out.repoints.push({ checkId: m[1]!.toLowerCase(), camera: m[2]! });
    m = /^keep\s+(?:check\s+)?([a-z0-9][a-z0-9-_]*)/i.exec(line);
    if (m) out.keeps.push(m[1]!.toLowerCase());
  }
  return out;
}

/** Did the planner call fail because the run was stopped? Then the caller stops too. */
function isStop(err: unknown, ctx: HarnessCtx): boolean {
  return (err as AnyRecord | null)?.kind === EngineFailure.Aborted || Boolean(ctx.cancelled);
}

/** One planner call on the orchestrator's engine (the planner model is that engine's), read as JSON. */
async function askPlanner(ctx: HarnessCtx, run: Run, system: string, user: string): Promise<AnyRecord> {
  const plannerPick = plannerModel(run);
  const response = await ctx.call(HostMethod.EngineComplete, {
    // Planner work runs on the orchestrator's engine: the model above is that engine's.
    engine: run.engine ?? EngineId.Ollama,
    ...(plannerPick ? { model: plannerPick } : {}),
    systemPrompt: system,
    stream: false,
    effort: LIGHT_EFFORT,
    messages: [{ role: "user", content: user }],
  });
  return parseVerdict(response.message?.content ?? "");
}

/**
 * Ask the planner what to do with a check that cannot be satisfied as written. Reply:
 * `{"action":"repoint"|"relax"|"drop","check":{…},"why":"…"}`. Never throws on a bad reply —
 * an unusable answer is `{ action: "keep" }` and the check stands.
 */
export async function replanCheck(
  ctx: HarnessCtx,
  {
    run,
    spec,
    check,
    reason,
    cameras = [],
    eyes = [],
    evidence = null,
  }: {
    run: Run;
    spec: PlannedFacet;
    check: Check;
    reason: string;
    cameras?: string[];
    eyes?: string[];
    evidence?: { state?: unknown } | null;
  },
): Promise<ReplanDecision> {
  let raw: AnyRecord;
  try {
    const user = replanUserPrompt({ spec, check, reason, cameras, eyes, evidence });
    raw = await askPlanner(ctx, run, REPLAN_SYSTEM, user);
  } catch (err: any) {
    if (isStop(err, ctx)) throw err;
    return { action: ReplanAction.Keep, why: `planner unavailable: ${err?.message ?? err}`, unanswered: true };
  }
  if (!PLANNER_ACTIONS.includes(raw?.action))
    return {
      action: ReplanAction.Keep,
      why: String(raw?.why ?? raw?.reason ?? "unusable reply").slice(0, CLIP_REASON),
      // A planner that chose to keep the check decided; one whose reply named no action did not.
      ...(raw?.action === ReplanAction.Keep ? {} : { unanswered: true }),
    };
  if (raw.action === ReplanAction.Drop)
    return { action: ReplanAction.Drop, why: String(raw?.why ?? "").slice(0, CLIP_REASON) };
  return correctedCheck(spec, check, raw);
}

/** The planner's corrected check, validated like a plan's own; a check that does not validate is kept as it was. */
function correctedCheck(spec: PlannedFacet, check: Check, raw: AnyRecord): ReplanDecision {
  const action: typeof ReplanAction.Repoint | typeof ReplanAction.Relax = raw.action;
  const candidate =
    raw?.check && typeof raw.check === "object"
      ? normalizeCheck(
          {
            ...check,
            ...raw.check,
            id: check.id,
            kind: raw.check.kind ?? check.kind,
            weight: check.weight,
            origin: check.origin,
          },
          0,
        )
      : null;
  if (!candidate) return { action: ReplanAction.Keep, why: "the planner returned no check" };
  const checked = validateFacetSpec({ id: spec.id, intent: spec.intent, checks: [candidate] });
  const corrected = checked.spec.checks[0];
  if (!checked.ok || !corrected)
    return { action: ReplanAction.Keep, why: `the planner's check did not validate: ${checked.problems.join("; ")}` };
  return {
    action,
    check: {
      ...corrected,
      replanned: ((check.replanned as number | undefined) ?? 0) + 1,
      note: [check.note, `${action}ed by the planner: ${clip(raw?.why, CLIP_QUOTE)}`].filter(Boolean).join("; "),
    },
    why: String(raw?.why ?? "").slice(0, CLIP_REASON),
  };
}

// ── the move (HARNESS-POSTMORTEM-VILLAGE.md §5): one structural change per iteration ──────

/**
 * A builder's flag that says a check is another facet's problem: "not fixable from this
 * facet", "belongs to lighting-daycycle", "please re-point this check at village-fabric".
 * Returns the other facet's id when the flag names one (and it is not the flagging facet),
 * else null. The loop then drops the check here, blocks its class from re-growing, and routes
 * the defect to the facet named, so no facet burns iterations on a defect that is not its to fix.
 */
export function flagTarget(
  flag: unknown,
  facets: ReadonlyArray<string | { id?: string } | null | undefined> | null = [],
  ownId: string | null = null,
): string | null {
  const what = String((flag as AnyRecord | null)?.what ?? flag ?? "");
  if (!what) return null;
  const disowns =
    /not (?:be )?fix(?:able|ed) (?:from|by|in) this facet|cannot be fixed (?:from|by) this facet|belongs? to|owned by|is (?:really )?(?:the )?(?:job|work|problem) of|re-?point(?:ed|ing)? .{0,80}?\b(?:at|to)\b|route (?:it|this) to|hand (?:it|this) to/i.test(
      what,
    );
  if (!disowns) return null;
  const lower = what.toLowerCase();
  const candidates = (facets ?? [])
    .map((f) => (typeof f === "string" ? f : f?.id))
    .filter((id) => id && id !== ownId) as string[];
  const named = candidates.filter((id) => lower.includes(String(id).toLowerCase())).sort((a, b) => b.length - a.length);
  return named[0] ?? null;
}

/** The artefact class a defect line is filed under (`[haze-plane] …`), or null. */
export function defectClass(text: unknown): string | null {
  const m = /^\s*\[([a-z][a-z0-9-]*)\]/i.exec(String(text ?? ""));
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * Ask the planner for the next structural move on a facet whose identity holds and whose
 * milestone ladder is climbed (or was never written). The answer is one change to what the
 * game IS — its extent, a system, a mechanic, where the player goes next, the UI — never a
 * material, lighting or parameter tweak; the defect ledger already covers those. Returns
 * `{ what, why, check|null }` or null when the planner has nothing usable.
 */
export async function nextMove(
  ctx: HarnessCtx,
  {
    run,
    spec,
    defects = [],
    notes = "",
    moves = [],
    counts = null,
    cameras = [],
    asked = [],
  }: {
    run: Run;
    spec: PlannedFacet;
    board?: unknown;
    defects?: readonly unknown[];
    notes?: string;
    moves?: ReadonlyArray<{ what?: string; delivered?: boolean }>;
    counts?: unknown;
    cameras?: string[];
    /** Steps beyond the ask already put to the user (facet/beyond.ts): never proposed again. */
    asked?: readonly string[];
  },
): Promise<{ what: string; why: string; check: Check | null; scope?: MoveScope } | null> {
  let raw: AnyRecord;
  try {
    const user = nextMoveUserPrompt({ run, spec, defects, notes, moves, counts, cameras, asked });
    raw = await askPlanner(ctx, run, NEXT_MOVE_SYSTEM, user);
  } catch (err: any) {
    if (isStop(err, ctx)) throw err;
    return null;
  }
  const what = typeof raw?.what === "string" ? clip(raw.what.trim(), CLIP_BRIEF) : "";
  if (!what) return null;
  return {
    what,
    why: typeof raw?.why === "string" ? raw.why.trim().slice(0, CLIP_REASON) : "",
    check: moveCheck(spec, raw.check),
    // Typed, never read from the move's words: "adds" is the user's decision (facet/phases/plan.ts).
    ...(raw.scope === MoveScope.Adds ? { scope: MoveScope.Adds } : {}),
  };
}

/** The check a move names, when it is new to the facet and validates; else none. */
function moveCheck(spec: PlannedFacet, raw: unknown): Check | null {
  if (!raw || typeof raw !== "object") return null;
  const candidate = normalizeCheck({ ...raw, origin: CheckOrigin.Milestone }, (spec.checks ?? []).length);
  if (!candidate || (spec.checks ?? []).some((c) => c.id === candidate.id)) return null;
  const checked = validateFacetSpec({ id: spec.id, intent: spec.intent, checks: [candidate] });
  return checked.spec.checks.length === 1 ? (checked.spec.checks[0] ?? null) : null;
}
