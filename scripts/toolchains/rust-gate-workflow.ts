/**
 * The vendored-set gate's order in CI (`.github/workflows/rust-toolchain.yml`): nothing that
 * compiles the vendored crates may run once the gate has failed. A compile runs every build
 * script and proc macro in the closure, so a crate the inventory check or cargo-deny just refused
 * would still run its build-time code on the runner. Read as a table of steps, never by matching
 * prose: each step's `if:` and the commands its `run:` calls.
 */

/** One step of a workflow job, as this check reads it. */
export interface WorkflowStep {
  name: string;
  /** The step's `if:` expression; empty when it has none (it runs only after every earlier step succeeded). */
  condition: string;
  /** Its `run:` script, every line of a block included. */
  run: string;
}

/** A command that compiles crates (and so runs their build scripts and proc macros), or a test run that may. */
const COMPILES = /\bcargo\s+(?:build|check|clippy|test|run|doc|bench|rustc)\b|\bnode\s+--test\b/;
/** The gate's own steps: the inventory check and cargo-deny. */
const GATE = /\brust-vendor\.ts\s+check\b|\bcargo\s+deny\s+check\b/;
/** An `if:` under which a step runs after an earlier step failed. */
const RUNS_AFTER_FAILURE = /\balways\(\)|\bcancelled\(\)|\bfailure\(\)/;

/** A step's key and value when `line` sets one (`- key: value` or `key: value`), else null. */
function keyOf(line: string): { key: string; value: string } | null {
  const match = /^\s*(?:-\s+)?([A-Za-z_-]+):\s?(.*)$/.exec(line);
  return match ? { key: match[1] ?? "", value: (match[2] ?? "").trim() } : null;
}

/** The lines of job `job`'s body, up to the next job. */
function jobBody(text: string, job: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  if (start === -1) return [];
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  return lines.slice(start + 1, end === -1 ? lines.length : end);
}

/** Read one line of a step into it; true while the line opens or continues a block `run: |`. */
function readStepLine(step: WorkflowStep, line: string, inBlock: boolean): boolean {
  if (inBlock && /^ {10}/.test(line)) {
    step.run += `${line.trim()}\n`;
    return true;
  }
  const field = /^ {6}(?:- | {2})\S/.test(line) ? keyOf(line) : null;
  if (field?.key === "name") step.name = field.value;
  if (field?.key === "if") step.condition = field.value;
  if (field?.key !== "run") return false;
  const block = field.value === "|";
  step.run = block ? "" : `${field.value}\n`;
  return block;
}

/** The steps of job `job`, in order. */
export function workflowSteps(text: string, job: string): WorkflowStep[] {
  const steps: WorkflowStep[] = [];
  let inBlock = false;
  for (const line of jobBody(text, job)) {
    if (/^ {6}- /.test(line)) steps.push({ name: "", condition: "", run: "" });
    const step = steps.at(-1);
    inBlock = step ? readStepLine(step, line, inBlock) : false;
  }
  return steps;
}

/**
 * The steps of `job` that compile crates yet can run after the gate failed: under an `if:` that
 * runs after a failure, or before the gate's own steps. Empty when the gate holds.
 */
export function compilesPastFailedGate(text: string, job: string): string[] {
  const steps = workflowSteps(text, job);
  const lastGate = steps.findLastIndex((step) => GATE.test(step.run));
  return steps
    .filter((step, index) => COMPILES.test(step.run) && (index < lastGate || RUNS_AFTER_FAILURE.test(step.condition)))
    .map((step) => step.name || step.run.trim());
}
