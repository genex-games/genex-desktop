/**
 * A fake harness `ctx`, shaped like the one `harness-seed/loop/main.ts` scopes to a thread
 * (`call`, `notify`, `setStatus`, `cancelled`, `workspace`, `threadId`, `host`), that records
 * every substrate call in order and answers from a handler map.
 *
 * Use it to pin *which* substrate calls a loop makes and in what order — the snapshot, restore
 * and worktree sequence of an accept, a reject or a crash — without a harness process or a core.
 * An unhandled method throws the same `UnknownMethod` error the real host returns, so a loop that
 * starts calling something new shows up as a failure rather than as a silent `undefined`. A call
 * whose params the real host would refuse (`HARNESS_PARAM_SCHEMAS`) throws its `InvalidParams`
 * error before any handler runs, so a seed call shape the host gate would reject fails here too.
 */
import { harnessParamsProblem } from "../../src/shared/harness-api.ts";
import type { SnapshotRecord } from "../../src/substrate/snapshots.ts";

export interface RecordedCall {
  method: string;
  params: Record<string, unknown>;
}

export type CtxHandler = (params: Record<string, unknown>, recorder: CtxRecorder) => unknown;

export interface CtxRecorderOptions {
  /** Answers by method name; each replaces the default for that method. */
  handlers?: Record<string, CtxHandler>;
  workspace?: string;
  threadId?: string;
  /** The answer for a method with no handler and no default: throw like the host (default) or return this value. */
  unknown?: "throw" | { value: unknown };
  /** Extra fields a loop reads off its ctx (`project`, `runInbox`, `engine`, …). */
  extra?: Record<string, unknown>;
}

export interface HarnessCtx {
  host: { call: HarnessCtx["call"]; notify: HarnessCtx["notify"]; workspace: string };
  // biome-ignore lint/suspicious/noExplicitAny: a recorder answers whatever its handlers return
  call(method: string, params?: any): Promise<any>;
  notify(type: string, payload?: unknown): void;
  setStatus(status: string): void;
  workspace: string;
  threadId: string;
  cancelled: boolean;
  [extra: string]: unknown;
}

export interface CtxRecorder {
  ctx: HarnessCtx;
  calls: RecordedCall[];
  notifications: Array<{ type: string; payload: unknown }>;
  statuses: string[];
  /** Method names in call order, optionally only those matching a prefix or predicate. */
  sequence(filter?: string | ((method: string) => boolean)): string[];
  paramsOf(method: string): Array<Record<string, unknown>>;
  handle(method: string, handler: CtxHandler): void;
  /** Raise the thread's stop flag, as the user's Stop does; `cancelAfter` does it on a given call. */
  cancel(): void;
  cancelAfter(method: string, nth?: number): void;
}

function defaultHandlers(): Record<string, CtxHandler> {
  let snapshots = 0;
  return {
    "events.list": () => [],
    "events.head": () => null,
    "ui.notify": () => true,
    "snapshot.list": () => [],
    "snapshot.markHealthy": () => true,
    // The self-edit gate passes everything here: a recorded sequence is about order, not verdicts.
    "guardian.validate_edit": () => ({ ok: true, checked: [] }),
    "snapshot.restore": () => true,
    "snapshot.removeWorktree": () => true,
    "snapshot.create": (p): SnapshotRecord => ({
      snapshot_id: `snap-${++snapshots}`,
      scope: (p.scope as SnapshotRecord["scope"]) ?? "both",
      git: {},
      created_at: new Date(0).toISOString(),
      reason: String(p.reason ?? ""),
      healthy: p.healthy === true,
    }),
    // Nothing is checked out: the path is a name for assertions, not a folder.
    "snapshot.worktree": (p, r) => ({
      path: `${r.ctx.workspace}/scratch/autopilot/${String(p.runId ?? "shared")}/${String(p.name)}`,
      commit: p.commit ?? "HEAD",
    }),
  };
}

export function ctxRecorder(options: CtxRecorderOptions = {}): CtxRecorder {
  const handlers = { ...defaultHandlers(), ...options.handlers };
  const calls: RecordedCall[] = [];
  const notifications: Array<{ type: string; payload: unknown }> = [];
  const statuses: string[] = [];
  const cancelOn = new Map<string, number>();
  let cancelled = false;
  const recorder = {} as CtxRecorder;

  const call = async (method: string, params: Record<string, unknown> = {}) => {
    calls.push({ method, params });
    const pending = cancelOn.get(method);
    if (pending !== undefined) {
      if (pending <= 1) {
        cancelOn.delete(method);
        cancelled = true;
      } else cancelOn.set(method, pending - 1);
    }
    // The same shape check `HarnessHost` runs before dispatch, answered the way it answers.
    const refused = harnessParamsProblem(method, params);
    if (refused)
      throw Object.assign(new Error(refused.message), {
        name: "InvalidParams",
        data: { method: refused.method, issues: refused.issues },
      });
    const handler = handlers[method];
    if (handler) return handler(params, recorder);
    if (options.unknown && options.unknown !== "throw") return options.unknown.value;
    throw Object.assign(new Error(`unknown substrate method: ${method}`), { name: "UnknownMethod" });
  };
  const notify = (type: string, payload: unknown = null) => void notifications.push({ type, payload });
  const workspace = options.workspace ?? "/fake/workspaces/harness";
  const ctx = {
    ...options.extra,
    host: { call, notify, workspace },
    call,
    notify,
    workspace,
    threadId: options.threadId ?? "thread-1",
    setStatus: (status: string) => void statuses.push(status),
    // A getter like the real ctx, so `{...ctx}` snapshots it the way the seed's own spreads do.
    get cancelled() {
      return cancelled;
    },
    set cancelled(value: boolean) {
      cancelled = value;
    },
  } as HarnessCtx;

  Object.assign(recorder, {
    ctx,
    calls,
    notifications,
    statuses,
    sequence: (filter?: string | ((method: string) => boolean)) => {
      const keep = typeof filter === "string" ? (m: string) => m.startsWith(filter) : (filter ?? (() => true));
      return calls.map((c) => c.method).filter(keep);
    },
    paramsOf: (method: string) => calls.filter((c) => c.method === method).map((c) => c.params),
    handle: (method: string, handler: CtxHandler) => void (handlers[method] = handler),
    cancel: () => void (cancelled = true),
    cancelAfter: (method: string, nth = 1) => void cancelOn.set(method, nth),
  } satisfies CtxRecorder);
  return recorder;
}
