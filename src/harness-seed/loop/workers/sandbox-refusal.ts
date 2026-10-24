/**
 * Engines whose worker sandbox this computer cannot run. A worker always runs in its engine's sandbox
 * and never without it (Claude Code's `failIfUnavailable`): where that box cannot run, the CLI refuses
 * the session before it does anything (`StopReason.SandboxUnavailable`), and it would refuse every
 * later one the same way. So once an engine has refused, no worker starts on it for
 * `REFUSAL_HOLD_MS`: the lead is told to do the work itself, and the person, once per Loop, that
 * another signed-in engine can take the Workers role. The hold bounds what it costs to try again once
 * the provider turns the sandbox on.
 *
 * A module of its own: a workspace may keep agent-edited older pool and director files, and a name
 * imported from one that it never exported would keep the harness from linking.
 */
import type { HarnessCtx } from "../../types/harness.d.ts";
import type { EngineDescriptor } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { DELEGATED_ENGINES, engineLabel } from "../model-roles.ts";
import { StopCode } from "../outcomes.ts";
import { StopReason } from "../outage.ts";
import { CLIP_REASON, clip } from "../text.ts";
import { HOUR_MS } from "../time.ts";
import { WorkerStopCode } from "./contract.ts";
import { SANDBOX_REFUSAL_WORDS } from "./sandbox-refusal-prompts.ts";

/** How long an engine's refusal holds before a worker may be started on it again. */
const REFUSAL_HOLD_MS = HOUR_MS;

/**
 * An engine the host reports signed in and able to take work: the app's `EngineStatusCode.Ready`
 * (`shared/engine-descriptor.ts`), held to it by `seed-contracts.test.ts`.
 */
export const ENGINE_READY = "ready";

/** What the person reads on the Loop's card: the engine that can't run workers, and the one they can pick instead. */
const MESSAGE = {
  record: (engine: string, said: string) =>
    `the workers' engine (${engine}) cannot run workers on this computer; the lead works without them: ${said}`,
  plain: (engine: string, onWindows: boolean, other: string | null) =>
    `${engine} can't run workers on ${onWindows ? "Windows" : "this computer"} yet, so the lead builds on its own.${other ? ` Pick ${other} for Workers to use them.` : ""}`,
} as const;

/** An engine's refusal, kept: which engine, in its own words, and when. */
export interface SandboxRefusal {
  engine: string;
  said: string;
  at: number;
}

/** The engines that refused, by id. Every pool and Loop of this harness reads the same table. */
const REFUSED = new Map<string, SandboxRefusal>();
/** The Loops whose person has been told already. */
const TOLD = new WeakSet<object>();

/** Did the engine refuse this session because the sandbox it asked for cannot run on this computer? */
export function sandboxRefused(ending: { stopReason?: unknown } | null | undefined): boolean {
  return typeof ending?.stopReason === "string" && ending.stopReason === StopReason.SandboxUnavailable;
}

/** Did a builder's facet stop on that refusal (`StopCode.SandboxUnavailable`)? */
export function sandboxStopped(result: { stopCode?: unknown } | null | undefined): boolean {
  return typeof result?.stopCode === "string" && result.stopCode === StopCode.SandboxUnavailable;
}

/** Keep `engine`'s refusal, in its own words; answers it. */
export function noteSandboxRefusal(engine: string, said: unknown, at = Date.now()): SandboxRefusal {
  const refusal = { engine, said: clip(String(said ?? ""), CLIP_REASON), at };
  REFUSED.set(engine, refusal);
  return refusal;
}

/** The refusal that holds `engine` at `now`, or null: none, or one older than the hold. */
export function sandboxRefusalOn(engine: unknown, now = Date.now()): SandboxRefusal | null {
  if (typeof engine !== "string") return null;
  const refusal = REFUSED.get(engine) ?? null;
  if (!refusal || now < refusal.at + REFUSAL_HOLD_MS) return refusal;
  REFUSED.delete(engine);
  return null;
}

/** Forget every refusal: each engine is asked again. */
export function forgetSandboxRefusals(): void {
  REFUSED.clear();
}

/** The other workers' engine, by name, when the host reports it signed in; null when none is. */
export async function otherWorkersEngine(ctx: Pick<HarnessCtx, "call">, engine: string): Promise<string | null> {
  const described: EngineDescriptor[] = await ctx.call(HostMethod.EngineDescribe, {}).catch(() => []);
  const ready = (Array.isArray(described) ? described : []).find(
    (other) =>
      other.id !== engine && DELEGATED_ENGINES.includes(other.id as never) && other.status?.code === ENGINE_READY,
  );
  return ready ? engineLabel(ready.id) : null;
}

/** Why no worker starts on the engine that refused, as the lead reads it. */
export async function refusedStart(ctx: Pick<HarnessCtx, "call">, refusal: SandboxRefusal): Promise<string> {
  const other = await otherWorkersEngine(ctx, refusal.engine);
  return SANDBOX_REFUSAL_WORDS.notStarted(engineLabel(refusal.engine), refusal.said, other);
}

/** What a Loop needs to tell its person: the host, and its decision card. */
export interface TellsPerson {
  ctx: Pick<HarnessCtx, "call">;
  decision: (text: string, plain?: string | null) => Promise<unknown>;
}

/** Tell the Loop's person, once, that its workers' engine can't run workers here, and what they can pick instead. */
export async function tellSandboxRefusal(
  loop: TellsPerson,
  refusal: SandboxRefusal,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (TOLD.has(loop)) return;
  TOLD.add(loop);
  const other = await otherWorkersEngine(loop.ctx, refusal.engine);
  const engine = engineLabel(refusal.engine);
  await loop.decision(MESSAGE.record(engine, refusal.said), MESSAGE.plain(engine, platform === "win32", other));
}

/** A pool worker of a Loop whose engine refused it for a sandbox this computer cannot run: the person is told, once. */
export function tellIfRefused(loop: TellsPerson, engine: string, stopCode: unknown): void {
  const refused = typeof stopCode === "string" && stopCode === WorkerStopCode.SandboxUnavailable;
  const refusal = refused ? sandboxRefusalOn(engine) : null;
  if (refusal) tellSandboxRefusal(loop, refusal).catch(() => {});
}
