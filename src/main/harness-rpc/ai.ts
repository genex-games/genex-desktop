/**
 * Harness RPC: play-time AI for the builder agent. It checks a schema against the closed dialect,
 * lists a game's saved playtests, replays a demo's tape under seeds (or with no answer at all),
 * records a tape and benches a call site on this Mac's models, and runs the model check on local
 * models only. Nothing here reaches the network: replays answer from tapes, and recording, benching
 * and checking run on a run budget this module creates for the one call (`createRunBudget`: this
 * Mac's models, one call at a time, at most `AI_RECORD_MAX_CALLS`), which the agent can neither
 * create nor raise — nothing it sends sizes the budget, and the budget closes when the call answers.
 *
 * Every call names a game of the library, and a build folder (`root`) only when it is that game's
 * own folder or a run's copy under scratch, checked real (`assertHarnessRoot`, as `preview.load`'s).
 * Params are read through the same schemas the harness host checks them with, so a handler reached
 * any other way reads only the fields it names. A refusal never reaches the play-time AI host. A
 * studio started without play-time AI (`StudioCoreOptions.gameAi`) answers every call but the schema
 * check with a refusal that says so.
 */
import { HARNESS_PARAM_SCHEMAS, HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { AiDoor } from "../../shared/game-ai.ts";
import { AI_BENCH_MAX_SAMPLES } from "../../shared/game-ai-check.ts";
import { checkSchema } from "../../shared/game-ai-schema.ts";
import { AI_RECORD_MAX_CALLS, AiReplayAnswers } from "../../shared/game-ai-tape.ts";
import type { AiRunBudget, GameAiHarnessHost } from "../game-ai/types.ts";
import type { CoreInternals } from "../core/internals.ts";
import type { StudioCore } from "../studio-core.ts";

/** The doors a harness run budget opens: this Mac's models, never a plan, a key or credits. */
export const HARNESS_RUN_DOORS: readonly AiDoor[] = [AiDoor.Local];
/** Model calls one bench sample may take: the reply, and its one repair. */
const CALLS_PER_SAMPLE = 2;

/** Why there is no answer for this call. */
const MESSAGE = {
  off: "play-time AI isn't running in this studio",
} as const;

/** A run budget as its creator holds it: the budget, and the close only the creator calls. */
export interface OwnedRunBudget {
  budget: AiRunBudget;
  close(): void;
}

/**
 * A run budget for one harness call: `maxCalls` model calls on `doors`, one at a time. A slot is
 * taken per call and released when it answers; once closed it takes nothing, so a host that kept a
 * reference past its answer cannot spend it.
 */
export function createRunBudget(maxCalls: number, doors: readonly AiDoor[] = HARNESS_RUN_DOORS): OwnedRunBudget {
  const cap = Number.isSafeInteger(maxCalls) && maxCalls > 0 ? maxCalls : 0;
  const allowed: readonly AiDoor[] = Object.freeze([...doors]);
  let used = 0;
  let running = false;
  let closed = false;
  const take = (door: AiDoor): { release(): void } | null => {
    if (closed || running || used >= cap || !allowed.includes(door)) return null;
    used += 1;
    running = true;
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        running = false;
      },
    };
  };
  const budget: AiRunBudget = Object.freeze({
    doors: allowed,
    maxCalls: cap,
    concurrency: 1 as const,
    take,
    used: () => used,
    closed: () => closed,
  });
  return {
    budget,
    close() {
      closed = true;
    },
  };
}

/** Run `work` on a fresh run budget of `maxCalls`, and close the budget however the work ends. */
async function onRunBudget<R>(maxCalls: number, work: (budget: AiRunBudget) => Promise<R>): Promise<R> {
  const owned = createRunBudget(maxCalls);
  try {
    return await work(owned.budget);
  } finally {
    owned.close();
  }
}

/** The harness host for play-time AI, or a refusal when the studio runs without it. */
function hostOf(core: StudioCore): GameAiHarnessHost {
  const host = core.options.gameAi;
  if (!host) throw new Error(MESSAGE.off);
  return host;
}

/** The checked build folder of a call: the library's game (refused otherwise) and its real root, or null for its own folder. */
function buildOf(x: CoreInternals, project: string, root: string | null | undefined): Promise<string | null> {
  return x.assertHarnessRoot(project, root ?? null);
}

/** `ai.*`: the schema check is pure; the rest run through the host on tapes and local models. */
export function aiRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.AiSchemaCheck]: async (p) => {
      const problem = checkSchema(p?.schema ?? null);
      return problem === null ? { ok: true } : { ok: false, problem };
    },
    [HostMethod.AiTapes]: async (raw) => {
      const p = HARNESS_PARAM_SCHEMAS[HostMethod.AiTapes].parse(raw);
      const host = hostOf(core);
      const root = await buildOf(x, p.project, p.root);
      return host.tapes(p.project, { root });
    },
    [HostMethod.AiReplay]: async (raw) => {
      const p = HARNESS_PARAM_SCHEMAS[HostMethod.AiReplay].parse(raw);
      const host = hostOf(core);
      const root = await buildOf(x, p.project, p.root);
      const answers = p.answers ?? AiReplayAnswers.Tape;
      return host.replay(p.project, p.demo, [...p.seeds], { root, answers });
    },
    [HostMethod.AiRecord]: async (raw) => {
      const p = HARNESS_PARAM_SCHEMAS[HostMethod.AiRecord].parse(raw);
      const host = hostOf(core);
      const root = await buildOf(x, p.project, p.root);
      return onRunBudget(AI_RECORD_MAX_CALLS, (budget) => host.record(p.project, p.demo, p.seed, { root, budget }));
    },
    [HostMethod.AiBench]: async (raw) => {
      const p = HARNESS_PARAM_SCHEMAS[HostMethod.AiBench].parse(raw);
      const host = hostOf(core);
      const root = await buildOf(x, p.project, p.root);
      const samples = p.samples ?? AI_BENCH_MAX_SAMPLES;
      return onRunBudget(samples * CALLS_PER_SAMPLE, (budget) =>
        host.bench(p.project, p.site, samples, { root, budget }),
      );
    },
    [HostMethod.AiModelCheck]: async (raw) => {
      const p = HARNESS_PARAM_SCHEMAS[HostMethod.AiModelCheck].parse(raw);
      const host = hostOf(core);
      await buildOf(x, p.project, null);
      return onRunBudget(AI_RECORD_MAX_CALLS, (budget) => host.modelCheck(p.project, { localOnly: true, budget }));
    },
  } satisfies Partial<HarnessHostHandlers>;
}
