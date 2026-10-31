import { HostMethod } from "../host-methods.ts";
/** Instrument real host-call boundaries; translated tool events are not timing sources. */
import { timedOperation } from "./timing.ts";
import type { OperationSpan } from "./timing.ts";
import type { ForwardedCall, HarnessCtx, Run } from "../../types/harness.d.ts";

const MEASURED = new Set<string>([
  HostMethod.EngineDelegate,
  HostMethod.EngineComplete,
  HostMethod.PluginsInvoke,
  HostMethod.SnapshotWorktree,
  HostMethod.SnapshotRemoveWorktree,
  HostMethod.SnapshotCreate,
  HostMethod.PreviewLoad,
  HostMethod.PreviewReady,
  HostMethod.PreviewScreenshot,
  HostMethod.PreviewAcquire,
  HostMethod.GameValidate,
  HostMethod.RunExec,
]);

/** A derived context inherits live cancellation getters and preserves the host's original authority. */
export function tracedContext(ctx: HarnessCtx, run: Run, record: (span: OperationSpan) => void): HarnessCtx {
  const forward: ForwardedCall = ctx.call;
  const call: ForwardedCall = (method, args) => {
    if (!MEASURED.has(method)) return forward(method, args);
    let usage: Record<string, number> | undefined;
    return timedOperation(
      method,
      null,
      async () => {
        const result = await forward(method, args);
        if (method === HostMethod.EngineComplete || method === HostMethod.EngineDelegate)
          usage = measuredUsage(result?.usage);
        return result;
      },
      (span) => record({ ...span, ...callIdentity(args), runId: run.runId, ...(usage ? { usage } : {}) }),
    );
  };
  return Object.create(ctx, { call: { value: call } });
}

const USAGE_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "cost_usd"];

/** Store one final host response; do not sum context snapshots or infer absent provider usage. */
function measuredUsage(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const usage: Record<string, number> = {};
  for (const key of USAGE_FIELDS) {
    const amount = record[key];
    if (typeof amount === "number" && Number.isFinite(amount) && amount >= 0) usage[key] = amount;
  }
  return Object.keys(usage).length ? usage : undefined;
}

function callIdentity(value: unknown): Pick<OperationSpan, "model" | "effort" | "role" | "worker"> {
  if (!value || typeof value !== "object") return {};
  const args = value as Record<string, unknown>;
  const capture = args.selfCapture as { facetId?: unknown } | undefined;
  const role = args.director ? "planner" : args.class;
  return {
    model: typeof args.model === "string" ? args.model : null,
    effort: typeof args.effort === "string" ? args.effort : null,
    role: typeof role === "string" ? role : null,
    worker: typeof capture?.facetId === "string" ? capture.facetId : null,
  };
}
