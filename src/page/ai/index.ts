/**
 * `genex-ai`: the one way a game asks a model while it is played. A game imports it by its
 * import-map name (`import { createAi, s } from "genex-ai"`), and Studio serves this module's
 * build from its vendor folder (`GENEX_AI_VENDOR`). On genex.games its platform lane calls the
 * embed SDK the page's connect module connected (`GENEX_EMBED_SDK_GLOBAL`).
 *
 *   const ai = createAi({ sites: ["npc.reply"], requires: "optional" });
 *   await ai.ready();
 *   button.onclick = () => ai.requestBudget();         // inside a gesture
 *   ai.ask({ site: "npc.reply", prompt, schema: Reply, untrusted: { said }, fallback: STOCK });
 *   // in update(): for (const result of ai.drain()) apply(result);
 *
 * Answers are data that enter the game only through `drain()`; the game never names a model, a
 * price or a payer. Builder agents read the same surface in `src/game-template/src/ai.d.ts` and
 * `docs/AI.md`.
 */
import { GENEX_AI_STUDIO_GLOBAL, AI_LANE_ATTRIBUTE, SHIM_TAG_SELECTOR } from "../../shared/game-ai-lane.ts";
import { GENEX_EMBED_SDK_GLOBAL } from "../../shared/genex.ts";
import { laneSource, type PageEnv } from "./lanes/choose.ts";
import { createRuntime, type RuntimeDeps } from "./runtime.ts";
import type { CreateAiOptions, GameAi } from "./types.ts";

export {
  AiAuthority,
  AiDoor,
  AiErrorCode,
  AiOp,
  AiProvenance,
  AiRequirement,
  AiSource,
  AiTier,
} from "../../shared/game-ai.ts";
export { checkSchema } from "../../shared/game-ai-schema.ts";
export type { AiMemory, AiMemoryLine, AiMemorySnapshot } from "./memory.ts";
export { type Infer, type Schema, s } from "./schema.ts";
export {
  type ActRequest,
  type AiDisclosure,
  type AiFailure,
  AiGrantPeriod,
  AiJudgeKind,
  type AiResult,
  type AiStatus,
  type AiTicket,
  type AskRequest,
  type CallBase,
  type CreateAiOptions,
  type GameAi,
  type JudgeAnswers,
  type JudgeQuestion,
  type JudgeQuestions,
  type JudgeRequest,
  type PlatformOptions,
  type SayRequest,
  type ToolCall,
  type ToolSet,
  type ToolSpec,
} from "./types.ts";

/** The page as the browser gives it. */
function browserEnv(): PageEnv {
  return {
    scope: globalThis,
    fetch: (input, init) => globalThis.fetch(input, init),
    hint: () => globalThis.document?.querySelector(SHIM_TAG_SELECTOR)?.getAttribute(AI_LANE_ATTRIBUTE) ?? null,
    embedSdk: () => Reflect.get(globalThis, GENEX_EMBED_SDK_GLOBAL),
    session: () => globalThis.crypto.randomUUID(),
  };
}

/** A person's click or key is being handled now. */
function gesture(): boolean {
  const activation: unknown = Reflect.get(globalThis.navigator ?? {}, "userActivation");
  return typeof activation === "object" && activation !== null && Reflect.get(activation, "isActive") === true;
}

/** Where the studio contract finds this page's AI. */
function register(handle: Parameters<RuntimeDeps["register"]>[0]): void {
  Object.defineProperty(globalThis, GENEX_AI_STUDIO_GLOBAL, { value: handle, configurable: true, writable: true });
}

/** Start the game's AI. Call it once, at boot; `await ai.ready()` before the first frame. */
export function createAi(options?: CreateAiOptions): GameAi {
  return createRuntime(options, { lanes: laneSource(browserEnv(), options?.platform), gesture, register });
}
