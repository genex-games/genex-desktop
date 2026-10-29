/**
 * Playing a demo for the harness's play-time AI calls (`AiDemoPlayer`, `game-ai/harness-host.ts`)
 * on an agent's preview window: one window leased for the play and always given back, the build
 * served with the lane `genex-ai` plays on named on the page (`AiLaneHint`), the page awaited, the
 * world seeded (`__studio.seed`), the demo run to its end (awaited when it is async), and what the
 * page holds read back small: a SHA-256 of each checkpoint the demo returned (or of the final state),
 * `genex-ai`'s status and the calls its tape missed. The probe runs in the page from its own source;
 * everything it answers is hostile input to the harness host. Electron-free: the window comes in
 * through `DemoPlayerDeps`.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import { isPlainRecord } from "../../shared/game-ai.ts";
import { canonicalJson } from "../../shared/game-ai-schema.ts";
import type { PreviewPort } from "../../substrate/preview-port.ts";
import { awaitReady } from "../../substrate/preview-ready.ts";
import type { AiDemoPlayer, AiDemoResult, AiDemoRun } from "../game-ai/harness-host.ts";
import type { CoreInternals } from "./internals.ts";

/** The console level a page's error is logged at. */
const ERROR_LEVEL = "error";
/** The most checkpoints the probe digests. */
const PROBE_MAX_CHECKPOINTS = 256;

/** A window leased for one play. */
export interface LeasedWindow {
  handle: string;
  port: PreviewPort;
  release(): Promise<void>;
}

/** What the player runs on: a window, serving the build into it, and the page's readiness. */
export interface DemoPlayerDeps {
  lease(): Promise<LeasedWindow>;
  /** Serve `run`'s build into the leased window with its lane named on the page. */
  load(handle: string, run: AiDemoRun): Promise<void>;
  /** Wait until the page says it is up; false when it never did. */
  ready(window: LeasedWindow, project: string): Promise<boolean>;
  now(): number;
}

/** What the probe answers, before the harness host reads it. */
interface ProbeAnswer {
  ended?: unknown;
  digests?: unknown;
  status?: unknown;
  missed?: unknown;
}

/**
 * The probe the page runs: seed, run the demo, digest its checkpoints, read `genex-ai`. Serialized
 * into the page, so it names nothing outside itself; the canonical JSON it digests comes in as an
 * argument, from the one place that defines it.
 */
async function demoProbe(
  args: { demo: string; seed: number; max: number },
  canonical: (value: unknown) => string,
): Promise<ProbeAnswer> {
  const studio: unknown = Reflect.get(globalThis, "__studio");
  const ai: unknown = Reflect.get(globalThis, "__genexAi");
  const call = (target: unknown, name: string, ...rest: unknown[]): unknown => {
    const method: unknown = typeof target === "object" && target !== null ? Reflect.get(target, name) : undefined;
    return typeof method === "function" ? Reflect.apply(method, target, rest) : undefined;
  };
  const field = (target: unknown, name: string): unknown =>
    typeof target === "object" && target !== null ? Reflect.get(target, name) : undefined;
  const hex = async (text: string): Promise<string> => {
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };
  /** The demo's checkpoints, once it ran to its end; null when it did not. */
  const run = async (): Promise<unknown[] | null> => {
    call(studio, "seed", args.seed);
    const ran = call(studio, "demo", args.demo);
    if (field(ran, "ok") !== true) return null;
    const raw = field(ran, "result");
    const result = typeof field(raw, "then") === "function" ? await raw : raw;
    return Array.isArray(result) && result.length ? result : [call(studio, "state") ?? result];
  };
  const points = await run().catch(() => null);
  const digests: string[] = [];
  for (const point of (points ?? []).slice(0, args.max)) digests.push(await hex(canonical(point)));
  return { ended: points !== null, digests, status: call(ai, "status") ?? null, missed: call(ai, "missed") ?? [] };
}

/** The expression a window evaluates for one play. */
const probeExpression = (run: AiDemoRun): string =>
  `(${demoProbe.toString()})(${JSON.stringify({ demo: run.demo, seed: run.seed, max: PROBE_MAX_CHECKPOINTS })}, ${canonicalJson.toString()})`;

/** The demo player over `deps`. */
export function previewDemoPlayer(deps: DemoPlayerDeps): AiDemoPlayer {
  return {
    async play(run): Promise<AiDemoResult> {
      const window = await deps.lease();
      try {
        await deps.load(window.handle, run);
        const since = deps.now();
        if (!(await deps.ready(window, run.project))) {
          return { ended: false, digests: [], status: null, missed: [], consoleErrors: 0 };
        }
        const raw = await window.port.evaluate(probeExpression(run));
        const answer: ProbeAnswer = isPlainRecord(raw) ? raw : {};
        const errors = window.port.consoleEntries(since).filter((entry) => entry.level === ERROR_LEVEL).length;
        return {
          ended: answer.ended === true,
          digests: answer.digests ?? [],
          status: answer.status ?? null,
          missed: answer.missed ?? [],
          consoleErrors: errors,
        };
      } finally {
        await window.release();
      }
    },
  };
}

/** The label a play's window carries in the pool's list. */
const PLAY_LABEL = "ai-demo";
/** How long a play waits for a window when every one is in use. */
const LEASE_WAIT_MS = 5 * MINUTE_MS;

/**
 * The player's deps over the core's previews: a hidden window of its own (never Live; one past the
 * pool's ceiling when every window is busy, waiting for room up to {@link LEASE_WAIT_MS}), the build
 * served by the same path `preview.load` serves it by, and the page's own word that it is up.
 */
export function corePlayerDeps(x: CoreInternals): DemoPlayerDeps {
  return {
    async lease() {
      const lease = await x.previews.pool().acquire({
        label: PLAY_LABEL,
        owner: `harness:${x.harnessBoot}`,
        overflow: true,
        signal: AbortSignal.timeout(LEASE_WAIT_MS),
      });
      return {
        handle: lease.handle,
        port: lease.port,
        release: async () => {
          await x.previewPool?.release(lease.handle);
        },
      };
    },
    async load(handle, run) {
      await x.previews.loadPreview({ project: run.project, root: run.root, handle }, { aiLane: run.lane });
    },
    async ready(window, project) {
      const timeoutMs = await x.previews.bootMsFor(project);
      return (await awaitReady(window.port, { timeoutMs, gesture: false })).ready;
    },
    now: () => Date.now(),
  };
}
