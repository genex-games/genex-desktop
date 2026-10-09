/**
 * The developer control's wire protocol: the request envelope, the operations and their
 * parameters, the response and its error codes. `scripts/studio-dev` speaks the other end, so
 * every value here is a wire value: never rename one.
 */
import { z } from "zod";
import { SECOND_MS } from "../../shared/duration.ts";

const GRAPH_DRAG_MIN_MS = 100;
const GRAPH_DRAG_MAX_MS = 5 * SECOND_MS;
const GRAPH_DRAG_MAX_DISTANCE = 300;
const GRAPH_DRAG_MAX_STEPS = 120;
const WINDOW_RESIZE_MAX_DELTA = 600;
const WINDOW_RESIZE_MAX_STEPS = 120;

/** The protocol version every envelope and response carries. */
export const DEV_PROTOCOL_VERSION = 1;

/** The largest request line the control socket reads. */
export const MAX_REQUEST_BYTES = 64 * 1024;

/** Why an operation was refused or failed: the `error.code` of a response. */
export const DevErrorCode = {
  AmbiguousSelector: "ambiguous-selector",
  Busy: "busy",
  DebuggerDetached: "debugger-detached",
  InvalidDiagnostic: "invalid-diagnostic",
  InvalidRequest: "invalid-request",
  InvalidSelector: "invalid-selector",
  MissingPrerequisite: "missing-prerequisite",
  NotReady: "not-ready",
  StaleBuild: "stale-build",
  TargetNotVisible: "target-not-visible",
  Timeout: "timeout",
  UnsupportedSurface: "unsupported-surface",
  WrongInstance: "wrong-instance",
} as const;
export type DevErrorCode = (typeof DevErrorCode)[keyof typeof DevErrorCode];

/** Whether the launch is ready for operations: the `readiness` field of `status`. */
export const DevReadiness = { Ready: "ready", NotReady: "not-ready" } as const;
export type DevReadiness = (typeof DevReadiness)[keyof typeof DevReadiness];

/** What an operation acts on: the studio window or the game view. */
export const DevSurface = { Desktop: "desktop", Game: "game" } as const;
export type DevSurface = (typeof DevSurface)[keyof typeof DevSurface];

/** Where `logs` reads: a surface's console, the core's events, the harness or the launch's own streams. */
export const DevLogSurface = {
  ...DevSurface,
  Core: "core",
  Harness: "harness",
  Stdout: "stdout",
  Stderr: "stderr",
} as const;
export type DevLogSurface = (typeof DevLogSurface)[keyof typeof DevLogSurface];

/** Every operation the control performs, by its `method`. */
export const DevMethod = {
  Status: "status",
  Snapshot: "snapshot",
  Click: "click",
  Type: "type",
  Key: "key",
  Select: "select",
  Scroll: "scroll",
  GameInput: "game.input",
  GraphDrag: "graph.drag",
  WindowResize: "window.resize",
  FixtureGraph: "fixture.graph",
  GameState: "game.state",
  Capture: "capture",
  Logs: "logs",
  Runs: "runs",
  CpuStart: "cpu.start",
  CpuStop: "cpu.stop",
  MainCpuStart: "main.cpu.start",
  MainCpuStop: "main.cpu.stop",
  Heap: "heap",
  TraceStart: "trace.start",
  TraceStop: "trace.stop",
  Stop: "stop",
} as const;
export type DevMethod = (typeof DevMethod)[keyof typeof DevMethod];

/** Fixed synthetic graph stimuli, available only in the large graph fixture. */
export const GraphFixtureAction = {
  OtherProjectFrames: "other-project-frames",
  AppendRound: "append-round",
  WorkerFrames: "worker-frames",
} as const;
export type GraphFixtureAction = (typeof GraphFixtureAction)[keyof typeof GraphFixtureAction];

const surface = z.enum(DevSurface);
const selector = z.string().min(1).max(1000);
const name = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/)
  .refine((s) => !s.includes(".."));
const target = { selector, scope: selector.optional() };
const key = {
  surface,
  key: z.string().min(1).max(40),
  code: z.string().min(1).max(40),
  modifiers: z
    .array(z.enum(["Alt", "Control", "Meta", "Shift"]))
    .max(4)
    .default([]),
};
const input = z.discriminatedUnion("type", [
  z.object({ type: z.enum(["tap", "down", "up"]), keys: z.array(z.string().max(40)).min(1).max(8) }).strict(),
  z
    .object({
      type: z.literal("hold"),
      keys: z.array(z.string().max(40)).min(1).max(8),
      ms: z.number().min(0).max(8000).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("click"),
      x: z.number().optional(),
      y: z.number().optional(),
      button: z.enum(["left", "right", "middle"]).optional(),
    })
    .strict(),
  z.object({ type: z.literal("move"), x: z.number(), y: z.number() }).strict(),
  z
    .object({ type: z.literal("look"), dx: z.number().min(-2000).max(2000), dy: z.number().min(-2000).max(2000) })
    .strict(),
  z.object({ type: z.literal("scroll"), dx: z.number().optional(), dy: z.number().optional() }).strict(),
  z.object({ type: z.literal("wait"), ms: z.number().min(0).max(8000) }).strict(),
]);
const operation = <M extends string, T extends z.ZodRawShape>(method: M, params: T) =>
  z.object({ method: z.literal(method), params: z.object(params).strict() }).strict();
export const operationSchema = z.discriminatedUnion("method", [
  operation(DevMethod.Status, {}),
  operation(DevMethod.Snapshot, {
    surface: z.literal("desktop"),
    scope: selector.optional(),
    limit: z.number().int().min(1).max(500).default(150),
  }),
  operation(DevMethod.Click, target),
  operation(DevMethod.Type, { ...target, text: z.string().max(16000), replace: z.boolean().default(false) }),
  operation(DevMethod.Key, key),
  operation(DevMethod.Select, { ...target, value: z.string().max(1000) }),
  operation(DevMethod.Scroll, {
    surface,
    deltaX: z.number().min(-10000).max(10000),
    deltaY: z.number().min(-10000).max(10000),
    selector: selector.optional(),
    scope: selector.optional(),
  }),
  operation(DevMethod.GameInput, {
    actions: z
      .array(input)
      .min(1)
      .max(24)
      .refine(
        (a) => a.reduce((n, x) => n + ("ms" in x ? (x.ms ?? 0) : 0), 0) <= 15000,
        "combined input duration exceeds 15 seconds",
      ),
  }),
  operation(DevMethod.GraphDrag, {
    durationMs: z.number().int().min(GRAPH_DRAG_MIN_MS).max(GRAPH_DRAG_MAX_MS),
    distanceX: z.number().min(-GRAPH_DRAG_MAX_DISTANCE).max(GRAPH_DRAG_MAX_DISTANCE),
    steps: z.number().int().min(2).max(GRAPH_DRAG_MAX_STEPS),
  }),
  operation(DevMethod.WindowResize, {
    deltaWidth: z.number().int().min(-WINDOW_RESIZE_MAX_DELTA).max(WINDOW_RESIZE_MAX_DELTA),
    deltaHeight: z.number().int().min(-WINDOW_RESIZE_MAX_DELTA).max(WINDOW_RESIZE_MAX_DELTA),
    steps: z.number().int().min(2).max(WINDOW_RESIZE_MAX_STEPS),
    durationMs: z.number().int().min(GRAPH_DRAG_MIN_MS).max(GRAPH_DRAG_MAX_MS),
  }),
  operation(DevMethod.FixtureGraph, { action: z.enum(GraphFixtureAction) }),
  operation(DevMethod.GameState, {}),
  operation(DevMethod.Capture, { surface, name }),
  operation(DevMethod.Logs, {
    surface: z.enum(DevLogSurface),
    cursor: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(100),
  }),
  operation(DevMethod.Runs, {}),
  operation(DevMethod.CpuStart, { surface, profileId: name }),
  operation(DevMethod.CpuStop, { surface, profileId: name }),
  operation(DevMethod.MainCpuStart, { profileId: name }),
  operation(DevMethod.MainCpuStop, { profileId: name }),
  operation(DevMethod.Heap, { surface, name }),
  operation(DevMethod.TraceStart, {
    traceId: name,
    durationMs: z.number().int().min(100).max(30000),
    categories: z
      .array(z.enum(["devtools.timeline", "v8", "blink.user_timing", "toplevel"]))
      .min(1)
      .max(4),
  }),
  operation(DevMethod.TraceStop, { traceId: name }),
  operation(DevMethod.Stop, {}),
]);
export type Operation = z.infer<typeof operationSchema>;
export const envelopeSchema = z
  .object({
    version: z.literal(DEV_PROTOCOL_VERSION),
    requestId: z.string().min(1).max(80),
    instanceId: z.string().uuid(),
    capability: z.string().min(32).max(128),
    method: z.string(),
    params: z.unknown(),
  })
  .strict();
/** What an operation failed with, as a response carries it. */
export interface DevFailure {
  code: DevErrorCode;
  message: string;
  prerequisite?: string;
}

export type DevResponse =
  | { version: typeof DEV_PROTOCOL_VERSION; requestId: string; ok: true; value: unknown }
  | { version: typeof DEV_PROTOCOL_VERSION; requestId: string; ok: false; error: DevFailure };

/** A refusal the control reports with its code; anything else thrown reports as `invalid-request`. */
export class DevError extends Error {
  code: DevErrorCode;
  constructor(code: DevErrorCode, message: string = code) {
    super(message);
    this.code = code;
  }
}

/** Operations that answer in any state of the launch: they read its identity or its records, or stop it. */
const UNGATED: ReadonlySet<DevMethod> = new Set([DevMethod.Status, DevMethod.Runs, DevMethod.Stop]);
/** Operations that still answer on a stale build: they collect what an earlier call started. */
const STALE_SAFE: ReadonlySet<DevMethod> = new Set([
  DevMethod.Logs,
  DevMethod.CpuStop,
  DevMethod.MainCpuStop,
  DevMethod.TraceStop,
]);

/** What the gate reads about a launch when an operation arrives; staleness is worked out only when asked. */
export interface DevLaunchState {
  ready: boolean;
  authVisible: boolean;
  stale: () => boolean;
}

/**
 * Why a launch refuses an operation now, or null when it may run: an action needs a ready harness,
 * no native sign-in sheet over the window, and a build that still matches its source.
 */
export function devRefusal(method: DevMethod, launch: DevLaunchState): DevError | null {
  if (UNGATED.has(method)) return null;
  if (!launch.ready) return new DevError(DevErrorCode.NotReady);
  if (launch.authVisible)
    return new DevError(
      DevErrorCode.MissingPrerequisite,
      "dismiss native account UI before collecting diagnostics or acting",
    );
  if (!STALE_SAFE.has(method) && launch.stale())
    return new DevError(
      DevErrorCode.StaleBuild,
      "source/dependency/output changed; restart this profile for current evidence",
    );
  return null;
}
