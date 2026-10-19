/**
 * Harness RPC: play-time AI for the builder agent. It checks a schema against the closed dialect,
 * lists a game's saved playtests, replays a demo's tape under seeds, records a tape and benches a
 * call site on this Mac's models, and runs the model check on local models only. Nothing here
 * reaches the network: replays answer from tapes, and recording, benching and checking run on a
 * run budget the host creates (at most `AI_RECORD_MAX_CALLS` calls, one at a time, yielding to
 * builds), which the agent can neither create nor raise. A studio started without play-time AI
 * (`StudioCoreOptions.gameAi`) answers every call but the schema check with a refusal that says so.
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { AI_BENCH_MAX_SAMPLES } from "../../shared/game-ai-check.ts";
import { checkSchema } from "../../shared/game-ai-schema.ts";
import type { GameAiHarnessHost } from "../game-ai/types.ts";
import type { StudioCore } from "../studio-core.ts";

/** Why there is no answer for this call. */
const MESSAGE = {
  off: "play-time AI isn't running in this studio",
  notInLibrary: (project: string) => `${project} is not a game in the library`,
} as const;

/** The harness host for play-time AI, or a refusal when the studio runs without it. */
function hostOf(core: StudioCore): GameAiHarnessHost {
  const host = core.options.gameAi;
  if (!host) throw new Error(MESSAGE.off);
  return host;
}

/** The game's name, once the library has it: the harness names only games it was given. */
async function libraryGame(core: StudioCore, project: string): Promise<string> {
  const known = (await core.games.list()).some((game) => game.name === project);
  if (!known) throw new Error(MESSAGE.notInLibrary(project));
  return project;
}

/** `ai.*`: the schema check is pure; the rest run through the host on tapes and local models. */
export function aiRpc(core: StudioCore) {
  return {
    [HostMethod.AiSchemaCheck]: async (p) => {
      const problem = checkSchema(p?.schema ?? null);
      return problem === null ? { ok: true } : { ok: false, problem };
    },
    [HostMethod.AiTapes]: async (p) => hostOf(core).tapes(await libraryGame(core, p.project)),
    [HostMethod.AiReplay]: async (p) => hostOf(core).replay(await libraryGame(core, p.project), p.demo, [...p.seeds]),
    [HostMethod.AiRecord]: async (p) => hostOf(core).record(await libraryGame(core, p.project), p.demo, p.seed),
    [HostMethod.AiBench]: async (p) =>
      hostOf(core).bench(await libraryGame(core, p.project), p.site, p.samples ?? AI_BENCH_MAX_SAMPLES),
    [HostMethod.AiModelCheck]: async (p) => hostOf(core).modelCheck(await libraryGame(core, p.project)),
  } satisfies Partial<HarnessHostHandlers>;
}
