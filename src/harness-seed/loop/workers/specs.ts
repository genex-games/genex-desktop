/**
 * The six worker tools as a lead's engine sees them: their schemas (flat string properties, so both
 * bridges carry them), with the kinds of worker the plugins on offer declare listed in
 * `worker_start`'s description at session start.
 */
import type { LiveToolSpec, WorkerType } from "../../types/host-api.d.ts";
import { MAX_WORKER_WAIT_S, MAX_WORKERS_AT_ONCE, WorkerTool } from "./contract.ts";

/** One string property of a tool's schema. */
const text = (description: string) => ({ type: "string", description });

/** `worker_start`'s description, naming the kinds of worker on offer. */
function startDescription(types: readonly WorkerType[]): string {
  const kinds = types.length
    ? ` Kinds of worker the plugins on offer declare (type): ${types.map((type) => `${type.id} (${type.description})`).join("; ")}.`
    : "";
  return `Start a worker for one task, in the background: a reader in place (isolation read), a writer in its own copy that you merge with ${WorkerTool.Mark} (copy), or the one writer in place (lock). It works in this chat's permission mode and sees nothing but its task. Up to ${MAX_WORKERS_AT_ONCE} at once; answers its id.${kinds}`;
}

/** The six worker tools, with `worker_start` naming the kinds of worker on offer. */
export function workerTools(types: readonly WorkerType[] = []): LiveToolSpec[] {
  return [
    {
      name: WorkerTool.Start,
      description: startDescription(types),
      parameters: {
        type: "object",
        properties: {
          title: text("A short title the chat and the graph show."),
          task: text("Everything the worker needs; it sees nothing else."),
          isolation: text("read | copy | lock. Required unless type gives one."),
          type: text("A kind of worker a plugin declares (listed above); it brings that kind's tools."),
          research: text('"yes" gives it web search.'),
          inputs: text("Comma-separated paths in the project a copy must start from."),
        },
        required: ["title", "task"],
      },
    },
    {
      name: WorkerTool.Status,
      description:
        "Where each worker stands (or the one named): running, waiting for the person, done, failed or stopped.",
      parameters: { type: "object", properties: { id: text("One worker's id; all when absent.") } },
    },
    {
      name: WorkerTool.Wait,
      description: `Wait until a worker ends or waits for the person, or the seconds pass (at most ${MAX_WORKER_WAIT_S}). Use instead of polling.`,
      parameters: {
        type: "object",
        properties: { id: text("Only wake for this worker."), seconds: text(`1–${MAX_WORKER_WAIT_S}`) },
      },
    },
    {
      name: WorkerTool.Steer,
      description: "Tell one running worker something: it reads it now, in the same session.",
      parameters: {
        type: "object",
        properties: { id: text("The worker's id."), text: text("What it should hear.") },
        required: ["id", "text"],
      },
    },
    {
      name: WorkerTool.Stop,
      description: "Stop one worker. A copy's work so far is kept for worker_mark.",
      parameters: {
        type: "object",
        properties: { id: text("The worker's id."), why: text("Why, in one line.") },
        required: ["id"],
      },
    },
    {
      name: WorkerTool.Mark,
      description:
        "Your word on a finished worker: used merges a copy's work into your folder (conflicts come back to you), rejected drops it.",
      parameters: {
        type: "object",
        properties: {
          id: text("The worker's id."),
          verdict: text("used | rejected"),
          note: text(
            "Why, in one line. The person reads it in the chat beside the worker: plain words, no ids or tool names.",
          ),
        },
        required: ["id", "verdict"],
      },
    },
  ];
}

/** The six worker tools, with no kinds of worker on offer. */
export const WORKER_TOOLS: LiveToolSpec[] = workerTools();
