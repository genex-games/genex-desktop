/**
 * `character.verify` (Track A): the agent hands Studio the engine's character-check report from the
 * game, and Studio answers with the next step (`shared/character-loop.ts`) while it keeps the
 * character's ledger itself: repair calls made, credits those jobs were quoted at, a rig already
 * re-imported. The caps hold however the agent behaves. Local and free: no Genex call.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson } from "../../substrate/fsx.ts";
import {
  DEFAULT_LOOP_CAPS,
  type LoopCall,
  type LoopCaps,
  type LoopLedger,
  LoopStatus,
  type LoopStep,
  nextStep,
  parseCheckReport,
} from "../../shared/character-loop.ts";
import { GenexOperation, type GenexJob, type GenexRequest } from "../../shared/genex.ts";

/** A report file larger than this is not read. */
const REPORT_MAX_BYTES = 1024 * 1024;
/** The jobs that repair a character: what spends the ledger's credits. */
const REPAIR_OPERATIONS: ReadonlySet<string> = new Set([
  GenexOperation.CharacterAnimate,
  GenexOperation.CharacterImport,
  GenexOperation.Character,
]);

const MESSAGE = {
  NeedsId: "character.verify takes the character's Genex generation id as id",
  NeedsReport: "character.verify takes the game file holding the engine's character-check report as prompt",
  Outside: "The character-check report is not a file inside this game",
  NotReport: "That file is not a character-check report (run the engine's character_check and pass its JSON)",
  TooBig: "The character-check report is too large to read",
} as const;

/** What Studio keeps for one character between checks. */
interface StoredLedger extends LoopLedger {
  /** When the last check ran: repair jobs created after it are what spent credits since. */
  since: string;
}

/** The answer to the agent. */
export interface VerifyAnswer {
  status: LoopStatus;
  call?: LoopCall;
  why?: string;
  reason?: string;
  summary?: string;
  ledger: { attempts: number; credits: number };
  caps: LoopCaps;
}

export interface VerifyInput {
  /** The Genex workspace for the project: the ledger lives in `characters/<id>.json` here. */
  workspace: string;
  /** The game folder the report is read from. */
  root: string;
  request: GenexRequest;
  /** The project's jobs, for the credits repair calls were quoted at. */
  jobs: readonly GenexJob[];
  now: () => Date;
  caps?: LoopCaps;
}

/** The report file's text, read from inside the game only. */
async function readReport(root: string, relative: string): Promise<string> {
  const allowed = await realpath(root);
  const file = await realpath(path.resolve(root, relative)).catch(() => "");
  if (!file.startsWith(allowed + path.sep) || (await lstat(file)).isDirectory()) throw new Error(MESSAGE.Outside);
  if ((await lstat(file)).size > REPORT_MAX_BYTES) throw new Error(MESSAGE.TooBig);
  return readFile(file, "utf8");
}

async function readLedger(file: string, now: Date): Promise<StoredLedger> {
  try {
    const stored = JSON.parse(await readFile(file, "utf8")) as StoredLedger;
    if (Number.isFinite(stored.attempts) && Number.isFinite(stored.credits) && typeof stored.since === "string")
      return stored;
  } catch {}
  return { attempts: 0, credits: 0, since: now.toISOString() };
}

/** The credits the repair jobs created after `since` were quoted at. */
function creditsSince(jobs: readonly GenexJob[], since: string): number {
  return jobs
    .filter((job) => REPAIR_OPERATIONS.has(job.operation) && job.createdAt > since)
    .reduce((sum, job) => sum + (job.creditsQuoted ?? 0), 0);
}

/** Judge the character's report and say what to do next, recording what the loop has spent. */
export async function verifyCharacter(input: VerifyInput): Promise<VerifyAnswer> {
  const { request, now } = input;
  const caps = input.caps ?? DEFAULT_LOOP_CAPS;
  if (!request.id) throw new Error(MESSAGE.NeedsId);
  if (!request.prompt) throw new Error(MESSAGE.NeedsReport);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readReport(input.root, request.prompt));
  } catch (error) {
    if (Object.values(MESSAGE).includes((error as Error).message as never)) throw error;
    throw new Error(MESSAGE.NotReport);
  }
  const report = parseCheckReport(parsed);
  if (!report) throw new Error(MESSAGE.NotReport);
  const file = path.join(input.workspace, "characters", `${request.id.replace(/[^\w-]/g, "_")}.json`);
  const stored = await readLedger(file, now());
  const ledger: StoredLedger = {
    ...stored,
    credits: stored.credits + creditsSince(input.jobs, stored.since),
    since: now().toISOString(),
  };
  const options = request.options ?? {};
  const who = { id: request.id, model: String(options.model ?? ""), prompt: String(options["character-prompt"] ?? "") };
  const step: LoopStep = nextStep(report, ledger, caps, who);
  if (step.status === LoopStatus.Act) {
    ledger.attempts += 1;
    if (step.call.operation === GenexOperation.CharacterImport) ledger.reimported = true;
  }
  await atomicWriteJson(file, ledger);
  const shown = { attempts: ledger.attempts, credits: ledger.credits };
  if (step.status === LoopStatus.Pass) return { status: step.status, ledger: shown, caps };
  if (step.status === LoopStatus.Act)
    return { status: step.status, call: step.call, why: step.why, ledger: shown, caps };
  return { status: step.status, reason: step.reason, summary: step.summary, ledger: shown, caps };
}
