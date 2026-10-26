// What one canary machine found: each step's outcome, written as result.json beside its logs, and
// read back by the report job. A machine passed when no step failed; a warning is shown, never fatal.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PackageKind } from "./links.ts";

/** The steps a machine runs, in order. */
export const CanaryStep = {
  Link: "link",
  Checksum: "checksum",
  Trust: "trust",
  Install: "install",
  FirstStart: "first-start",
  Repository: "repository",
  AgentCommand: "agent-command",
  /** Upgrade mode: the earlier release's install and first start, which set the sandbox up. */
  EarlierRelease: "earlier-release",
  /** Upgrade mode: the build installed over it shows the card that asks to update the sandbox. */
  UpgradeCard: "upgrade-card",
  /** Upgrade mode: its Update button asks Windows for exactly one approval. */
  UpgradeApproval: "upgrade-approval",
  /** Upgrade mode: the studio comes up on the updated sandbox, the earlier profile's games kept. */
  UpgradeStart: "upgrade-start",
  Crashes: "crashes",
} as const;
export type CanaryStep = (typeof CanaryStep)[keyof typeof CanaryStep];

/** How a step ended. */
export const StepOutcome = { Pass: "pass", Fail: "fail", Warn: "warn", Skip: "skip" } as const;
export type StepOutcome = (typeof StepOutcome)[keyof typeof StepOutcome];

/** Who runs Genex on a Windows machine: its administrator first, then an account without admin rights. */
export const Persona = { Owner: "owner", StandardUser: "standard-user" } as const;
export type Persona = (typeof Persona)[keyof typeof Persona];

/** One step's outcome. */
export interface StepResult {
  step: CanaryStep;
  outcome: StepOutcome;
  persona?: Persona;
  seconds?: number;
  detail: string;
}

/** Everything one machine (or one persona on it) found. */
export interface MachineResult {
  machine: string;
  /** The package it installed; absent on the report's stand-in for a machine that sent nothing. */
  kind?: PackageKind;
  tag: string;
  steps: StepResult[];
}

/** How each outcome shows in a run's log. */
const MARK = {
  [StepOutcome.Pass]: "✔",
  [StepOutcome.Fail]: "✖",
  [StepOutcome.Warn]: "!",
  [StepOutcome.Skip]: "-",
} as const satisfies Record<StepOutcome, string>;

/** The file a run writes beside its logs. */
export const RESULT_FILE = "result.json";

/** Whether no step on the machine failed. */
export function machinePassed(result: MachineResult): boolean {
  return result.steps.every((step) => step.outcome !== StepOutcome.Fail);
}

/** Collects one machine's steps as they finish and writes them after each, so a crash keeps the rest. */
export function recorder(dir: string, base: Omit<MachineResult, "steps">) {
  const result: MachineResult = { ...base, steps: [] };
  return {
    result,
    async add(step: StepResult): Promise<void> {
      result.steps.push(step);
      console.log(
        `${MARK[step.outcome]} ${step.persona ? `${step.persona} ` : ""}${step.step}: ${step.outcome}  ${step.detail}`,
      );
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
    },
  };
}

/** One machine's result as its run wrote it. */
export async function readResult(file: string): Promise<MachineResult> {
  return JSON.parse(await readFile(file, "utf8")) as MachineResult;
}

/** Results of the same machine (its personas' runs) merged into one, in the order given. */
export function mergeMachines(results: readonly MachineResult[]): MachineResult[] {
  const byMachine = new Map<string, MachineResult>();
  for (const result of results) {
    const known = byMachine.get(result.machine);
    if (known) known.steps.push(...result.steps);
    else byMachine.set(result.machine, { ...result, steps: [...result.steps] });
  }
  return [...byMachine.values()];
}
