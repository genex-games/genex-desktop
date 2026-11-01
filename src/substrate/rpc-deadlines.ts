/**
 * How long the host services one harness call before it answers the harness with a timeout.
 *
 * A call nobody answers keeps the harness awaiting it, and a harness awaiting the host is not
 * wedged, so the watchdog stays quiet while any call is in flight. A generated game whose
 * `state()` never returns, or a page that stops answering, therefore used to freeze a whole run
 * with nothing to notice it. Every call now has a class, and a class with a deadline is answered
 * with `RpcDeadline` once it passes; the watchdog sees the harness's own silence again after that.
 *
 * Engine work, runs, snapshots and plugin calls bound themselves (the engines' timeouts, consent
 * windows, the director's tool timeout) and some legitimately take hours, so their class has none.
 */
import { MINUTE_MS } from "../shared/duration.ts";
import type { HarnessHostMethod } from "../shared/harness-api.ts";

/** A class of harness call, by how long it may take. */
export const RpcClass = {
  /** The studio's own records and settings: local and quick, whatever the log's size. */
  Record: "record",
  /** A question or an action on a loaded game page. */
  Page: "page",
  /** Loading, reloading or waiting for a game page, or profiling one. */
  PageLoad: "page-load",
  /** Engine work, runs, snapshots, plugins: bounded by their own timeouts, some for hours. */
  Work: "work",
} as const;
export type RpcClass = (typeof RpcClass)[keyof typeof RpcClass];

/** The longest a call of each class is serviced; null leaves it to the work's own bounds. */
const CLASS_DEADLINE_MS: Record<RpcClass, number | null> = {
  [RpcClass.Record]: 5 * MINUTE_MS,
  [RpcClass.Page]: 5 * MINUTE_MS,
  [RpcClass.PageLoad]: 15 * MINUTE_MS,
  [RpcClass.Work]: null,
};

/** Every host method's class. A new method must be classified here, or the typecheck fails. */
export const RPC_CLASSES = {
  "events.append": RpcClass.Record,
  "events.list": RpcClass.Record,
  "events.head": RpcClass.Record,
  "events.messages": RpcClass.Record,
  "events.inbox": RpcClass.Record,
  "thread.main": RpcClass.Record,
  "thread.list": RpcClass.Record,
  "thread.fork": RpcClass.Record,
  "artifact.read": RpcClass.Record,
  "artifact.write": RpcClass.Record,
  "turn.begin": RpcClass.Record,
  "turn.append": RpcClass.Record,
  "turn.end": RpcClass.Record,
  "snapshot.create": RpcClass.Work,
  "snapshot.restore": RpcClass.Work,
  "snapshot.list": RpcClass.Record,
  "snapshot.markHealthy": RpcClass.Record,
  "snapshot.diff": RpcClass.Work,
  "snapshot.worktree": RpcClass.Work,
  "snapshot.removeWorktree": RpcClass.Work,
  "plugins.tools": RpcClass.Work,
  "plugins.workerTypes": RpcClass.Work,
  "jobs.list": RpcClass.Record,
  "plugins.find": RpcClass.Record,
  "plugins.suggest": RpcClass.Record,
  "capabilities.describe": RpcClass.Record,
  "plugins.invoke": RpcClass.Work,
  "mcp.tools": RpcClass.Work,
  "mcp.invoke": RpcClass.Work,
  "locks.hold": RpcClass.Record,
  "locks.release": RpcClass.Record,
  "checkpoint.take": RpcClass.Work,
  "hooks.fire": RpcClass.Work,
  "observers.capture": RpcClass.Work,
  "run.exec": RpcClass.Work,
  "engine.describe": RpcClass.Work,
  "studio.context": RpcClass.Record,
  "studio.language": RpcClass.Record,
  "context.policy": RpcClass.Record,
  "engine.complete": RpcClass.Work,
  "engine.abort": RpcClass.Work,
  "engine.interrupt": RpcClass.Work,
  "engine.delegate": RpcClass.Work,
  "finish.review": RpcClass.Work,
  "finish.settle": RpcClass.Record,
  "engine.steer": RpcClass.Work,
  "coordinator.tool": RpcClass.Work,
  "engine.delegations": RpcClass.Record,
  "engine.hardware": RpcClass.Record,
  "game.list": RpcClass.Record,
  "game.setCover": RpcClass.Work,
  "game.setCoverShader": RpcClass.Work,
  "game.contentStamp": RpcClass.Record,
  "game.recents": RpcClass.Record,
  "game.scaffold": RpcClass.Work,
  "game.start": RpcClass.Work,
  "game.validate": RpcClass.Work,
  "game.read": RpcClass.Record,
  "game.write": RpcClass.Record,
  "game.tree": RpcClass.Record,
  "game.export": RpcClass.Work,
  "game.references": RpcClass.Record,
  "preview.load": RpcClass.PageLoad,
  "preview.reload": RpcClass.PageLoad,
  "preview.screenshot": RpcClass.Page,
  "preview.crop": RpcClass.Page,
  "preview.input": RpcClass.Page,
  // The person may take minutes to answer the consent card; the card's own timeout bounds it.
  "desktop.computer": RpcClass.Work,
  "preview.console": RpcClass.Page,
  "preview.gpuErrors": RpcClass.Page,
  "preview.status": RpcClass.Page,
  "preview.ready": RpcClass.PageLoad,
  "preview.showing": RpcClass.Page,
  "preview.observe": RpcClass.PageLoad,
  "preview.acquire": RpcClass.PageLoad,
  "preview.release": RpcClass.Page,
  "preview.capacity": RpcClass.Page,
  "run.artifact": RpcClass.Record,
  "guardian.rebuild_and_restart": RpcClass.Work,
  "guardian.validate_edit": RpcClass.Work,
  "guardian.write_self": RpcClass.Work,
  "ui.notify": RpcClass.Record,
} as const satisfies Record<HarnessHostMethod, RpcClass>;

/** How long the host services a call of `method`; null for no deadline of its own. Unknown methods are refused before this. */
export function rpcDeadlineMs(method: string): number | null {
  const rpcClass: RpcClass | undefined = (RPC_CLASSES as Record<string, RpcClass>)[method];
  return rpcClass ? CLASS_DEADLINE_MS[rpcClass] : null;
}
