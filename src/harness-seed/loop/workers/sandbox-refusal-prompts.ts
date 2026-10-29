/**
 * What a lead reads when its workers' engine cannot run a worker's sandbox on this computer
 * (`sandbox-refusal.ts`): why a worker ended, and why `worker_start` starts none on that engine.
 */
import { WorkerTool } from "./contract.ts";

/** The other engine the person may pick for Workers, as the lead passes it on; nothing when none is signed in. */
const otherWorkers = (other: string | null): string =>
  other ? ` The person can pick ${other} for Workers in the model picker: tell them so once.` : "";

export const SANDBOX_REFUSAL_WORDS = {
  /** A builder's facet stopped on its first build: the line its end carries for the lead (`said` is the engine's). */
  stopped: (said: string) => `${said}. No build was made, and no worker can run on that engine here.`,
  /** A `worker_start` on the engine that refused: nothing was started. */
  notStarted: (engine: string, said: string, other: string | null) =>
    `Not started: ${said}. Every ${WorkerTool.Start} on ${engine} is refused the same way for now, so do the work yourself.${otherWorkers(other)}`,
} as const;
