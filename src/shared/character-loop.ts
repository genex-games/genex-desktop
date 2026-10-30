/**
 * The character verification loop (Track A). The agent builds the game, the engine's character
 * check reports (`character-check.ts`), and {@link nextStep} decides what happens next from that
 * report and what the loop has already spent: pass, the one Genex call that repairs the worst
 * fault (`character-repair.ts` says which kind), or a stop with a plain report once an attempt or
 * credit cap is reached. One call per step: the loop re-checks after each action. Browser-safe.
 */
import {
  CharacterCheckCause,
  CharacterCheckCode,
  type CharacterCheckDiagnostic,
  type CharacterCheckReport,
  ClipRole,
} from "./character-check.ts";
import { RepairAction, repairPlan } from "./character-repair.ts";

/** What the loop says to do next. Wire values. */
export const LoopStatus = {
  /** The character passes: it may reach the game. */
  Pass: "pass",
  /** Make this one Genex call, then check again. */
  Act: "act",
  /** Give up, with the report of what still fails. */
  Stop: "stop",
} as const;
export type LoopStatus = (typeof LoopStatus)[keyof typeof LoopStatus];

/** Why the loop stopped. Wire values. */
export const LoopStop = {
  Attempts: "attempts",
  Credits: "credits",
  /** No call can repair what the report finds. */
  NoRepair: "no-repair",
} as const;
export type LoopStop = (typeof LoopStop)[keyof typeof LoopStop];

/** What a character's loop has spent so far. Studio keeps it per character, not the agent. */
export interface LoopLedger {
  /** Repair calls made. */
  attempts: number;
  /** Credits those calls were quoted at. */
  credits: number;
  /** Whether a bad rig was already re-imported through Uthana, so the next fault regenerates. */
  reimported?: boolean;
}

/** The limits on a character's loop. */
export interface LoopCaps {
  attempts: number;
  credits: number;
}

/** The loop's default limits: three repair calls, a hundred credits. */
export const DEFAULT_LOOP_CAPS: LoopCaps = { attempts: 3, credits: 100 };

/** The character a loop repairs. */
export interface LoopCharacter {
  /** The Genex generation id `character.animate` acts on. */
  id: string;
  /** The model file in the game, for `character.import`; empty when there is none. */
  model: string;
  /** The prompt that made the character, for a regeneration. */
  prompt: string;
}

/** One Genex tool call, in the plugin's own request shape. */
export interface LoopCall {
  operation: string;
  id?: string;
  prompt?: string;
  options?: Record<string, string | boolean>;
}

/** The loop's answer. */
export type LoopStep =
  | { status: typeof LoopStatus.Pass }
  | { status: typeof LoopStatus.Act; call: LoopCall; why: string }
  | { status: typeof LoopStatus.Stop; reason: LoopStop; summary: string };

/** The plain-word action that asks Meshy for a clip filling each role. */
export const ROLE_ACTIONS: Readonly<Record<ClipRole, string>> = {
  idle: "idle",
  walk: "walk forward",
  run: "run forward",
  crouch: "crouch idle",
  aim: "aim rifle",
  fire: "fire rifle",
  reload: "reload rifle",
  hit: "hit reaction",
  death: "death",
};

/** One line per remaining finding, for a stop. */
function summaryOf(report: CharacterCheckReport, reason: string): string {
  const lines = report.diagnostics.map((finding) => {
    const where = [
      finding.clip && `clip ${finding.clip}`,
      finding.role && `role ${finding.role}`,
      finding.bone && `bone ${finding.bone}`,
    ];
    return `${finding.code} (${finding.cause})${where.filter(Boolean).length ? `: ${where.filter(Boolean).join(", ")}` : ""}`;
  });
  return `Character not playable, ${reason}. Still failing: ${lines.join("; ")}.`;
}

/** The call that repairs a rig or pose fault: re-import a bad rig once, else regenerate in an A-pose. */
function rigCall(
  report: CharacterCheckReport,
  ledger: LoopLedger,
  who: LoopCharacter,
): { call: LoopCall; why: string } {
  const poseFault = report.diagnostics.some((finding) => finding.cause === CharacterCheckCause.WrongPose);
  if (!poseFault && !ledger.reimported && who.model)
    return {
      call: { operation: "character.import", prompt: who.model },
      why: "the rig is bad: re-rig the model through Uthana",
    };
  return {
    call: { operation: "character", prompt: who.prompt, options: { "direct-text": true, pose: "a-pose" } },
    why: "the rig or its pose cannot be saved: make the body again in an A-pose",
  };
}

/** The role a clip fills in the report's findings, when one says. */
function roleOfClip(report: CharacterCheckReport, clip: string): ClipRole | null {
  return report.diagnostics.find((finding) => finding.clip === clip && finding.role)?.role ?? null;
}

/** What to do next for `report`, given what the loop has spent and its `caps`. */
export function nextStep(
  report: CharacterCheckReport,
  ledger: LoopLedger,
  caps: LoopCaps,
  who: LoopCharacter,
): LoopStep {
  const plan = repairPlan(report);
  if (plan.ok) return { status: LoopStatus.Pass };
  if (ledger.attempts >= caps.attempts)
    return {
      status: LoopStatus.Stop,
      reason: LoopStop.Attempts,
      summary: summaryOf(report, `${ledger.attempts} repair calls made`),
    };
  if (ledger.credits >= caps.credits)
    return {
      status: LoopStatus.Stop,
      reason: LoopStop.Credits,
      summary: summaryOf(report, `${ledger.credits} credits spent`),
    };
  const step = plan.steps[0];
  if (step?.action === RepairAction.Regenerate) return { status: LoopStatus.Act, ...rigCall(report, ledger, who) };
  const role = step?.action === RepairAction.SwapClips ? roleOfClip(report, step.clips[0] ?? "") : step?.roles[0];
  if (!role)
    return { status: LoopStatus.Stop, reason: LoopStop.NoRepair, summary: summaryOf(report, "no call repairs this") };
  return {
    status: LoopStatus.Act,
    call: { operation: "character.animate", id: who.id, prompt: ROLE_ACTIONS[role] },
    why: `${step?.action === RepairAction.SwapClips ? "replace" : "make"} the ${role} clip`,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const CODES: readonly unknown[] = Object.values(CharacterCheckCode);
const CAUSES: readonly unknown[] = Object.values(CharacterCheckCause);
const ROLES: readonly unknown[] = Object.values(ClipRole);

function parseDiagnostic(value: unknown): CharacterCheckDiagnostic | null {
  if (!isRecord(value)) return null;
  const { code, cause, clip, role, time, bone, value: measured, limit } = value;
  const roleOk = role === null || ROLES.includes(role);
  const boneOk = bone === null || typeof bone === "string";
  const numbersOk =
    typeof time === "number" && typeof limit === "number" && (measured === null || typeof measured === "number");
  if (!CODES.includes(code) || !CAUSES.includes(cause) || typeof clip !== "string" || !roleOk || !boneOk || !numbersOk)
    return null;
  return value as unknown as CharacterCheckDiagnostic;
}

/** The engine's character-check report as a checked value; null for anything that is not one. */
export function parseCheckReport(value: unknown): CharacterCheckReport | null {
  if (!isRecord(value) || typeof value.pass !== "boolean" || !Array.isArray(value.diagnostics)) return null;
  const diagnostics = value.diagnostics.map(parseDiagnostic);
  if (diagnostics.includes(null) || !isRecord(value.roles) || typeof value.file !== "string") return null;
  return { ...(value as unknown as CharacterCheckReport), diagnostics: diagnostics as CharacterCheckDiagnostic[] };
}
