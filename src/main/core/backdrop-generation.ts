/**
 * A live background for home made from a description: one tool-free completion on the model the
 * user picked, answering with a name and a WGSL shader body, a filter over the picture or a scene
 * of its own. A body that fails the static checks (`shaderProblem`) is sent back once with the
 * reason; the GPU's compiler, which only the renderer has, asks for its own repair through
 * `request.repair`, and the renderer's look at a body that runs (its moments, what stood out)
 * asks for a better one through `request.refine`.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  type BackdropLook,
  BackdropShaderKind,
  type BackdropShaderRequest,
  type BackdropShaderResult,
  LookFinding,
  SHADER_LOOK_IMAGE_MAX_CHARS,
  SHADER_LOOK_IMAGES_MAX,
  SHADER_LOOK_TYPES,
  SHADER_MAX_CHARS,
  SHADER_PROMPT_MAX_CHARS,
  SHADER_TITLE_MAX_CHARS,
  ShaderFailure,
  ShaderProblem,
  shaderProblem,
} from "../../shared/backdrop-shader.ts";
import { WorkClass } from "../../shared/harness-api.ts";
import type { Message, MessageImage } from "../../shared/event-log.ts";
import type { CompleteRequest, CompleteResponse, Engine } from "../../substrate/engines/types.ts";
import {
  BACKDROP_SYSTEM_PROMPT,
  backdropRefine,
  backdropRepair,
  backdropRequest,
  SHADER_PROBLEM_WORDS,
} from "./backdrop-generation-prompts.ts";

/** The longest a model may take to write one shader. */
const GENERATION_TIMEOUT_MS = 180 * SECOND_MS;
/** Room for a shader of the longest kept size, and the thinking around it. */
const GENERATION_MAX_TOKENS = 16_000;
/** A shader wants some thought, not a long meditation. */
const GENERATION_EFFORT = "medium";
/** How much compiler output goes back to the model, in characters. */
const REPAIR_PROBLEM_MAX_CHARS = 2_000;
/** Static-check failures sent back to the model before giving up. */
const STATIC_REPAIRS = 1;

/** A reply's name line. */
const TITLE_LINE = /^\s*\**\s*title\s*\**\s*:\s*(.+)$/im;
/** A reply's fenced code: the first block, whatever its language tag. */
const CODE_BLOCK = /```[a-z]*[^\S\n]*\n([\s\S]*?)```/i;
/** Wrapping a name may come in. */
const WRAPPING = /^[\s#>*_`"'“”‘’«»]+|[\s*_`"'“”‘’«».!?]+$/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** What making a background needs from the core: its engines and budget, and (for tests) its patience. */
export interface BackdropGenerationDeps {
  engines: { get(id: string): Engine; firstReady(): Promise<Engine | null> };
  budget: {
    run<T extends { usage?: unknown }>(workClass: WorkClass, work: () => Promise<T>, engine?: string): Promise<T>;
  };
  timeoutMs?: number;
}

/** `text` as a name: no wrapping or control characters, cut on a word to a name's length. */
function tidyTitle(text: string): string {
  const words = text.replace(CONTROL, "").replace(WRAPPING, "").replace(/\s+/g, " ").trim();
  if (words.length <= SHADER_TITLE_MAX_CHARS) return words;
  const cut = words.slice(0, SHADER_TITLE_MAX_CHARS + 1);
  const space = cut.lastIndexOf(" ");
  return (space > 0 ? cut.slice(0, space) : cut.slice(0, SHADER_TITLE_MAX_CHARS)).trim();
}

/** A reply's name and shader body; the body is empty when the reply holds none. */
export function shaderFromReply(reply: string, description: string): { title: string; wgsl: string } {
  const named = tidyTitle(TITLE_LINE.exec(reply)?.[1] ?? "");
  const block = CODE_BLOCK.exec(reply)?.[1];
  const wgsl = (block ?? (reply.includes("@fragment") ? reply.replace(TITLE_LINE, "") : "")).trim();
  return { title: named || tidyTitle(description) || "Background", wgsl };
}

const KINDS: readonly string[] = Object.values(BackdropShaderKind);
const FINDINGS: readonly string[] = Object.values(LookFinding);
/** Base64, as an image's bytes come. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** The slowest frame worth telling the model about, in milliseconds. */
const FRAME_MS_MAX = 10_000;

/** A request after reading: a description, and a kind always. */
type ReadRequest = BackdropShaderRequest & { kind: BackdropShaderKind };

/** An image the model may be shown: a picture type and base64 bytes of a bounded size. */
function readImage(image: unknown): MessageImage | null {
  if (!image || typeof image !== "object") return null;
  const { mimeType, data } = image as Record<string, unknown>;
  if (typeof mimeType !== "string" || !SHADER_LOOK_TYPES.includes(mimeType)) return null;
  if (typeof data !== "string" || data.length > SHADER_LOOK_IMAGE_MAX_CHARS || !BASE64.test(data)) return null;
  return { mimeType, data };
}

/** A look to improve on, as the model may read it, or null when it holds no body. */
function readLook(look: unknown): BackdropLook | null {
  if (!look || typeof look !== "object") return null;
  const { wgsl, images, findings, frameMs } = look as Record<string, unknown>;
  if (typeof wgsl !== "string" || !wgsl.trim()) return null;
  const shown = Array.isArray(images) ? images.slice(0, SHADER_LOOK_IMAGES_MAX).map(readImage) : [];
  const found = Array.isArray(findings) ? findings.filter((finding) => FINDINGS.includes(finding)) : [];
  const cost =
    typeof frameMs === "number" && Number.isFinite(frameMs) ? Math.min(Math.max(frameMs, 0), FRAME_MS_MAX) : 0;
  return {
    wgsl: wgsl.slice(0, SHADER_MAX_CHARS),
    images: shown.filter((image): image is MessageImage => image !== null),
    findings: [...new Set(found)] as LookFinding[],
    frameMs: cost,
  };
}

/** The request as the model may read it, or null when it asks for nothing. */
function readRequest(request: BackdropShaderRequest): ReadRequest | null {
  if (typeof request?.prompt !== "string") return null;
  const prompt = request.prompt.replace(CONTROL, " ").trim().slice(0, SHADER_PROMPT_MAX_CHARS);
  if (!prompt) return null;
  const repair = request.repair;
  const repairs =
    typeof repair?.wgsl === "string" && typeof repair.problem === "string"
      ? { wgsl: repair.wgsl.slice(0, SHADER_MAX_CHARS), problem: repair.problem.slice(0, REPAIR_PROBLEM_MAX_CHARS) }
      : null;
  const refine = readLook(request.refine);
  const kind = KINDS.includes(request.kind as string)
    ? (request.kind as BackdropShaderKind)
    : BackdropShaderKind.Filter;
  return {
    prompt,
    kind,
    ...(typeof request.engine === "string" && request.engine ? { engine: request.engine } : {}),
    ...(typeof request.model === "string" && request.model ? { model: request.model } : {}),
    ...(repairs ? { repair: repairs } : {}),
    ...(refine ? { refine } : {}),
  };
}

/** The first message: a repair, another pass after a look, or the description. */
function firstMessage(asked: ReadRequest): Message {
  if (asked.repair)
    return { role: "user", content: backdropRepair(asked.prompt, asked.kind, asked.repair.wgsl, asked.repair.problem) };
  if (!asked.refine) return { role: "user", content: backdropRequest(asked.prompt, asked.kind) };
  const { wgsl, images, findings, frameMs } = asked.refine;
  const content = backdropRefine(asked.prompt, asked.kind, wgsl, { findings, frameMs, shown: images.length > 0 });
  return { role: "user", content, ...(images.length ? { images } : {}) };
}

/** The engine that writes the shader: the one picked, else the first ready; null when none can complete. */
async function generationEngine(deps: BackdropGenerationDeps, engineId: string | undefined): Promise<Engine | null> {
  try {
    const engine = engineId ? deps.engines.get(engineId) : await deps.engines.firstReady();
    return typeof engine?.complete === "function" ? engine : null;
  } catch {
    return null;
  }
}

/** One completion's text, or null when the model fails, times out or answers with no text. */
async function ask(
  deps: BackdropGenerationDeps,
  engine: Engine,
  model: string | undefined,
  messages: Message[],
): Promise<string | null> {
  const timeoutMs = deps.timeoutMs ?? GENERATION_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeoutMs);
  const request: CompleteRequest = {
    ...(model ? { model } : {}),
    effort: GENERATION_EFFORT,
    signal,
    timeoutMs,
    maxTokens: GENERATION_MAX_TOKENS,
    systemPrompt: BACKDROP_SYSTEM_PROMPT,
    messages,
    tools: [],
  };
  const answered = deps.budget.run(
    WorkClass.User,
    () => engine.complete?.(request) as Promise<CompleteResponse>,
    engine.id,
  );
  // An engine that does not honour the signal still does not hold the panel waiting.
  const timedOut = new Promise<null>((resolve) => signal.addEventListener("abort", () => resolve(null)));
  try {
    const response = await Promise.race([answered, timedOut]);
    const content = response?.message.content;
    return typeof content === "string" ? content : null;
  } catch {
    return null;
  } finally {
    answered.catch(() => {});
  }
}

/** A background from `request.prompt`, or why there is none. Never throws for a model's failure. */
export async function makeBackdropShader(
  deps: BackdropGenerationDeps,
  request: BackdropShaderRequest,
): Promise<BackdropShaderResult> {
  const asked = readRequest(request);
  if (!asked) throw new Error("A background is made from a description.");
  const engine = await generationEngine(deps, asked.engine);
  if (!engine) return { ok: false, failure: ShaderFailure.NoModel };
  let message = firstMessage(asked);
  let problem: ShaderProblem = ShaderProblem.Empty;
  for (let attempt = 0; attempt <= STATIC_REPAIRS; attempt++) {
    const reply = await ask(deps, engine, asked.model, [message]);
    if (reply === null) return { ok: false, failure: ShaderFailure.NoReply };
    const shader = shaderFromReply(reply, asked.prompt);
    const found = shaderProblem(shader.wgsl);
    if (!found) return { ok: true, shader };
    problem = found;
    message = {
      role: "user",
      content: backdropRepair(asked.prompt, asked.kind, shader.wgsl, SHADER_PROBLEM_WORDS[found]),
    };
  }
  return { ok: false, failure: ShaderFailure.Refused, problem };
}
