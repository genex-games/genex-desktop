/** Harness RPC: the engines — describe, complete, delegate, abort, interrupt, steer — and the delegations running. */
import path from "node:path";
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { ToolPermissionBy } from "../../shared/permissions.ts";
import { workerLockKey } from "../../shared/workers.ts";
import { steerIntoChat } from "../core/chat-steer.ts";
import { CompletionService } from "../core/completion.ts";
import { hardwareReport } from "../core/hardware-report.ts";
import type { ActiveDelegation } from "../core/internals.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/**
 * The delegation Stop or an interrupt reaches in `cwd`: the one keyed by it, or with `worker`, that
 * worker's alone (an in-place worker runs under `workerLockKey`, beside the chat's own session in
 * the same folder; a worker in its own copy, or one the host did not seat, is keyed by its folder
 * and found by the id its grant named, `askedWorker`). Never another session there.
 */
function delegationAt(x: CoreInternals, cwd: string, worker: string | undefined): ActiveDelegation | undefined {
  const key = path.resolve(cwd);
  if (typeof worker !== "string") return x.activeDelegations.get(key);
  const inPlace = x.activeDelegations.get(workerLockKey(key, worker));
  if (inPlace) return inPlace;
  const atFolder = x.activeDelegations.get(key);
  return atFolder?.askedWorker === worker ? atFolder : undefined;
}

export function engineRpc(core: StudioCore, x: CoreInternals) {
  const completion = new CompletionService(core, x);
  return {
    // — engines —
    [HostMethod.EngineDescribe]: async () => core.engines.describe(),
    [HostMethod.EngineComplete]: async (p) => completion.complete(p),
    // Stop, reaching into a generation: aborts the thread's in-flight direct completions
    // (all of them when no thread is given — the shutdown and stop-everything paths).
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the worker-stop path is owned elsewhere and kept as written
    [HostMethod.EngineAbort]: async (p) => {
      let aborted = 0;
      if (!p.cwd) {
        x.cancelConnectorCalls(p);
        core.plugins?.cancel({ project: p.project, threadId: p.threadId });
        const scope = { ...(p.project ? { project: p.project } : {}), ...(p.threadId ? { threadId: p.threadId } : {}) };
        x.consent.cancel(scope, "stop");
        x.permissions.cancel(scope, ToolPermissionBy.Stop);
      }
      // One worker: the delegation building in this worktree, nothing else.
      if (p.cwd) {
        const running = delegationAt(x, p.cwd, p.worker);
        if (running) {
          running.abort.abort();
          aborted += 1;
        }
        return { aborted };
      }
      // A whole run: every delegation of the project — the director's session and its workers.
      if (p.project) {
        for (const delegation of x.activeDelegations.values()) {
          if (delegation.project === p.project) {
            delegation.abort.abort();
            aborted += 1;
          }
        }
        return { aborted };
      }
      const sets = p.threadId
        ? [x.activeCompletions.get(p.threadId)].filter((s): s is Set<AbortController> => Boolean(s))
        : [...x.activeCompletions.values()];
      for (const set of sets) {
        for (const controller of set) {
          controller.abort();
          aborted += 1;
        }
      }
      return { aborted };
    },
    /**
     * Steering that cannot wait (M3.4). The same signal `engine.abort` sends, named for what
     * it is for: one worktree's build turn is cut short so its caller can resume that same
     * session with the new instruction in front of it. The engine reports the turn as
     * `stopped` and hands back its session id, so nothing the builder wrote or read is lost.
     * `interrupted: false` means the worktree had no turn in flight — the worker is between
     * rounds, and reads its queue at the top of the next one anyway.
     */
    [HostMethod.EngineInterrupt]: async (p) => {
      const running = p.cwd ? delegationAt(x, p.cwd, p.worker) : undefined;
      if (!running) return { interrupted: false };
      running.abort.abort();
      return { interrupted: true };
    },
    [HostMethod.EngineDelegate]: async (p) => x.delegation.delegate(p),
    /**
     * Steer (the chat's own turn, or a run's lead): messages the person sent while that turn
     * works, into the session answering it — read mid-turn by an engine that can, or taken by
     * interrupting the session so its caller resumes it with them in front. A builder's session
     * never carries `chatTurn`: only the lead answers the chat during a build.
     */
    [HostMethod.EngineSteer]: async (p) => steerIntoChat(x.activeDelegations, p),
    [HostMethod.CoordinatorTool]: async (p) =>
      x.conversation.coordinatorTool(p.threadId, p.runId, p.name, p.args ?? {}, p.messageId),
    [HostMethod.EngineDelegations]: async () =>
      [...x.activeDelegations.entries()]
        .filter(([, d]) => d.started === true)
        .map(([cwd, d]) => ({
          project: d.project,
          cwd,
          engine: d.engine,
          startedAt: d.startedAt,
        })),
    [HostMethod.EngineHardware]: async () => hardwareReport(),
  } satisfies Partial<HarnessHostHandlers>;
}
