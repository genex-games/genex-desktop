/**
 * The scripted engines of a fixture session: Ollama, Claude Code, Codex, OpenCode and OpenRouter
 * stand-ins that answer from fixed text, never reach an account, a key or the network, and start no
 * vendor worker. Markers in
 * the user's words (`fixture:pending`, `fixture:stream`, `fixture:plan`, …) choose the script.
 */
import { ChatActivityPhase } from "../../shared/chat-activity.ts";
import { EngineKind, EngineStatusCode } from "../../shared/engine-descriptor.ts";
import { EngineFailureKind, StopReason } from "../../shared/engine-requests.ts";
import { HOUR_MS } from "../../shared/duration.ts";
import { EngineId } from "../../shared/providers.ts";
import {
  type CompleteRequest,
  DelegateEventType,
  type DelegateRequest,
  type DelegateResult,
  type Engine,
  EngineError,
  type EngineStatus,
} from "../../substrate/engines/types.ts";
import { GAME_NAME_SYSTEM_PROMPT } from "../core/game-naming-prompts.ts";
import { FIXTURE_MODEL } from "./fixture-kit.ts";
import { setTimeout as sleep } from "node:timers/promises";
import { ReasoningEffort } from "../../shared/model-preferences.ts";

const DAY_MS = 24 * HOUR_MS;
const FIXTURE_ENGINES = [
  EngineId.Ollama,
  EngineId.ClaudeCode,
  EngineId.Codex,
  EngineId.OpenCode,
  EngineId.OpenRouter,
] as const;
/** The fixture engines the studio's own loop drives: the local model, and OpenRouter's API. */
const DIRECT_FIXTURES: ReadonlySet<string> = new Set([EngineId.Ollama, EngineId.OpenRouter]);
const READY_STATUS: EngineStatus = { code: EngineStatusCode.Ready, detail: "AG-933 fixture; no account or network" };
/** How long naming a game takes, so home's Naming step can be seen. */
const NAMING_DELAY_MS = 2500;
/** How long a scripted plan takes to come back, so its progress can be seen. */
const PLAN_DELAY_MS = 1200;
/** Pauses between streamed pieces: a Studio reply, a slow one, and a game chat's. */
const STUDIO_PIECE_MS = 25;
const SLOW_PIECE_MS = 60;
const STREAM_PIECE_MS = 35;
/** A long reply arrives as fast as a quick model writes: about 1,500 characters a second. */
const LONG_PIECE_CHARS = 12;
const LONG_PIECE_MS = 8;
/** How many sections the long reply has; each is a heading, prose, a list and a code block. */
const LONG_REPLY_SECTIONS = 12;
/** What the fixture engines answer and refuse, word for word. */
const MESSAGE = {
  plainReply: "Fixture response. No new build was started.",
  gameName: "Tiny Island Fishing",
  studioReply:
    "Fixture Studio reply: game chats build games. This conversation explains Studio, its runs, and the instruction changes in Activity.",
  studioFollowUp: "Fixture follow-up: the earlier conversation and recorded Studio activity are still in context.",
  streamedReply:
    "The bridge is ready. **You can cross the river now.** I kept the path level with the river bank and added rails along both sides. The village lights are warm and the cover is ready in Assets. You can try the crossing in the preview. The water keeps moving beneath it.",
  modelLimit: "You have reached your model limit. Choose another model.",
  coordinatorOnly: "Fixture accepts coordinator work only; no vendor worker is started",
  stoppedByYou: "stopped by you",
  commandReply:
    "Converting the engine recordings needs ffmpeg, and my sandbox can’t download it. Run this once, then I’ll convert them:\n\n```bash\nbrew install ffmpeg\n```",
} as const;
/** The marker whose game-chat reply is long and code-heavy, streamed fast: what drawing a long reply costs. */
const LONG_STREAM_MARKER = "fixture:stream-long";
/** The marker that keeps a fixture session working until a real Stop. */
const PENDING_MARKER = "fixture:pending";
/** The marker whose reply offers the user a command to run, as a reply the sandbox blocked does. */
const COMMAND_MARKER = "fixture:command";
/** Where a coordinator's prompt puts the words it answers. */
const LATEST_MESSAGE = "LATEST USER MESSAGE:\n";

/**
 * First launch: an empty library, Claude Code waiting for a sign-in, Codex and OpenCode not
 * installed, and OpenRouter with no key.
 */
export const FIRST_LAUNCH_STATUS: Record<string, EngineStatus> = {
  [EngineId.ClaudeCode]: {
    code: EngineStatusCode.NeedsLogin,
    detail: "AG-933 fixture; sign-in is refused in fixture sessions",
  },
  [EngineId.Codex]: { code: EngineStatusCode.NotInstalled, detail: "AG-933 fixture; no Codex app" },
  [EngineId.OpenCode]: { code: EngineStatusCode.NotInstalled, detail: "AG-933 fixture; no OpenCode CLI" },
  [EngineId.OpenRouter]: { code: EngineStatusCode.NeedsLogin, detail: "AG-933 fixture; no OpenRouter key" },
};

export function fixtureEngines(directChat = false, statuses: Record<string, EngineStatus> = {}): Engine[] {
  // The pending sessions of this fixture: a steered one is resumed and keeps working.
  const pendingSessions = new Set<string>();
  return FIXTURE_ENGINES.map((id) => fixtureEngine(id, directChat, statuses, pendingSessions));
}

function fixtureEngine(
  id: EngineId,
  directChat: boolean,
  statuses: Record<string, EngineStatus>,
  pendingSessions: Set<string>,
): Engine {
  const direct = DIRECT_FIXTURES.has(id);
  // Ollama completes one turn at a time; OpenRouter holds a Genex session, as the real one does.
  const local = id === EngineId.Ollama;
  return {
    id,
    label: `${id} [fixture]`,
    kind: direct ? EngineKind.Direct : EngineKind.Delegated,
    supportsSessions: !(directChat && local),
    // Claude Code reads the person's messages mid-turn; Codex is interrupted and resumed instead.
    ...(id === EngineId.ClaudeCode ? { steersMidTurn: true } : {}),
    status: async () => statuses[id] ?? READY_STATUS,
    models: async () => [
      {
        id: FIXTURE_MODEL,
        label: "Fixture v1",
        efforts: [ReasoningEffort.Low, ReasoningEffort.Medium, ReasoningEffort.High],
        defaultEffort: ReasoningEffort.Medium,
        supportsFast: !direct,
        contextWindow: 200000,
        maxTokens: 8192,
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true,
      },
    ],
    defaultModel: async () => FIXTURE_MODEL,
    // Deterministic plan limits so the composer's usage panel has something honest to show; only a
    // subscription has a plan.
    ...(isSubscriptionFixture(id) ? { readUsage: async () => fixtureUsage(id) } : {}),
    complete: (request: CompleteRequest) => completeFixture(id, request),
    delegate: (request: DelegateRequest) => delegateFixture(id, request, pendingSessions),
  };
}

/** A subscription's stand-in: the only fixtures with plan limits. */
const isSubscriptionFixture = (id: EngineId): boolean => id === EngineId.ClaudeCode || id === EngineId.Codex;

function fixtureUsage(id: EngineId) {
  const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();
  if (id === EngineId.Codex)
    return {
      measuredAt: new Date().toISOString(),
      plan: "pro",
      windows: [{ id: "codex:10080", label: "Weekly limit", percent: 76, resetsAt: inDays(3) }],
    };
  return {
    measuredAt: new Date().toISOString(),
    plan: "max",
    windows: [
      {
        id: "five_hour",
        label: "5-hour limit",
        percent: 12,
        resetsAt: new Date(Date.now() + 3.9 * HOUR_MS).toISOString(),
      },
      { id: "seven_day", label: "Weekly · all models", percent: 52, resetsAt: inDays(5) },
      { id: "model:fable", label: "Weekly · Fable", percent: 100, resetsAt: inDays(5) },
    ],
  };
}

/** A completion as the scripted engines return one. */
function reply(id: EngineId, content: string, usage: Record<string, number> = {}) {
  return {
    engine: id,
    model: FIXTURE_MODEL,
    stopReason: "stop",
    message: { role: "assistant" as const, content },
    usage,
  };
}

async function completeFixture(id: EngineId, request: CompleteRequest) {
  // A game started from home is named first, whatever markers its request carries.
  if (request.systemPrompt === GAME_NAME_SYSTEM_PROMPT) {
    await sleep(NAMING_DELAY_MS, undefined, { signal: request.signal }).catch(() => {});
    return reply(id, MESSAGE.gameName);
  }
  const latestUser = request.messages.findLast((message) => message.role === "user")?.content ?? "";
  if (latestUser.includes(PENDING_MARKER)) await pending(request.signal, id);
  if (request.systemPrompt?.startsWith("You are the Harness assistant")) return studioReply(id, request, latestUser);
  const transcript = JSON.stringify(request.messages);
  const asksForPlan = request.systemPrompt?.includes("planning-only") && transcript.includes("fixture:plan");
  if (asksForPlan) return planReply(id, transcript);
  if (transcript.includes("fixture:stream")) {
    request.onActivity?.(ChatActivityPhase.Thinking);
    await streamPieces(id, request, MESSAGE.streamedReply, { size: 3, pauseMs: STREAM_PIECE_MS });
    return reply(id, MESSAGE.streamedReply);
  }
  return reply(id, MESSAGE.plainReply);
}

/** The Studio thread's assistant: a first reply, a follow-up, or nothing for `fixture:failure`. */
async function studioReply(id: EngineId, request: CompleteRequest, latestUser: string) {
  let content = studioReplyText(latestUser);
  const images = request.messages.reduce((count, message) => count + (message.images?.length ?? 0), 0);
  if (images && content) content += ` Received ${images} attached image.`;
  request.onActivity?.(ChatActivityPhase.Thinking);
  // This marker leaves enough time to inspect and navigate during a real stream.
  const slowStream = latestUser.includes("fixture:stream");
  await streamPieces(id, request, content, {
    size: slowStream ? 3 : 8,
    pauseMs: slowStream ? SLOW_PIECE_MS : STUDIO_PIECE_MS,
    studio: true,
  });
  return reply(id, content, { input_tokens: 1234 });
}

function studioReplyText(latestUser: string): string {
  if (latestUser.includes("follow up")) return MESSAGE.studioFollowUp;
  if (latestUser.includes("fixture:failure")) return "";
  return MESSAGE.studioReply;
}

/** Stream `content` in pieces of `size` characters; a Stop between pieces aborts. */
async function streamPieces(
  id: EngineId,
  request: CompleteRequest,
  content: string,
  pace: { size: number; pauseMs: number; studio?: boolean },
): Promise<void> {
  const stopped = pace.studio ? "Fixture Studio reply stopped" : "Fixture streaming stopped";
  for (const piece of content.match(new RegExp(`.{1,${pace.size}}`, "g")) ?? []) {
    if (request.signal?.aborted) throw new EngineError(EngineFailureKind.Aborted, id, stopped);
    request.onDelta?.(piece);
    await sleep(pace.pauseMs);
  }
}

/** A game chat's reply, streamed as a coordinator's text deltas arrive; the whole text is its summary. */
async function streamCoordinatorReply(id: EngineId, request: DelegateRequest, content: string): Promise<string> {
  for (const delta of content.match(new RegExp(`[\\s\\S]{1,${LONG_PIECE_CHARS}}`, "g")) ?? []) {
    if (request.signal?.aborted) throw new EngineError(EngineFailureKind.Aborted, id, "Fixture streaming stopped");
    request.onEvent?.({ type: DelegateEventType.TextDelta, payload: { streamId: "fixture-long-reply", delta } });
    await sleep(LONG_PIECE_MS);
  }
  return content;
}

/** A plan for review: blue, or purple once the user asked for purple; `fixture:plan-unavailable` hits a limit. */
async function planReply(id: EngineId, transcript: string) {
  await sleep(PLAN_DELAY_MS);
  if (id === EngineId.ClaudeCode && transcript.includes("fixture:plan-unavailable"))
    throw new EngineError(EngineFailureKind.UsageLimit, id, MESSAGE.modelLimit);
  const revised = transcript.includes("purple");
  const plan = [
    "### A rotating cube",
    "- Use the existing `<canvas>` in `src/main.js`.",
    revised ? "- Use a purple material." : "- Use a blue material.",
    "### Build steps",
    ...Array.from(
      { length: 12 },
      (_, i) =>
        `${i + 1}. Check the camera and the cube controls inside the existing game. Keep the scene responsive when the window changes size.`,
    ),
  ].join("\n");
  return reply(id, plan);
}

async function delegateFixture(id: EngineId, request: DelegateRequest, pendingSessions: Set<string>) {
  const reads = steerReads(request);
  if (request.prompt.split(LATEST_MESSAGE).at(-1)?.includes(COMMAND_MARKER)) return reads.answer(commandReply(id));
  if (request.interviewTools?.some((tool) => tool.name === "ask_user"))
    return reads.answer(interviewReply(id, request));
  if (!request.coordinator) throw new Error(MESSAGE.coordinatorOnly);
  const stopped = await pendingSession(id, request, pendingSessions);
  if (stopped) return reads.answer(stopped);
  if (request.onLiveTool) await request.onLiveTool("run_status", {});
  const long = request.prompt.split(LATEST_MESSAGE).at(-1)?.includes(LONG_STREAM_MARKER);
  const summary = long ? await streamCoordinatorReply(id, request, longReply()) : MESSAGE.plainReply;
  return reads.answer({
    ok: true,
    engine: id,
    model: FIXTURE_MODEL,
    turns: 1,
    usage: {},
    sessionId: "fixture-coordinator-v1",
    summary,
  });
}

/**
 * Steer: a message sent while this session works is read at once, where the turn is; the result
 * lists what was read, and nothing is taken once the session has answered.
 */
function steerReads(request: DelegateRequest) {
  const steered: string[] = [];
  let answered = false;
  request.steer?.ready((message) => {
    if (answered) return false;
    steered.push(message.id);
    queueMicrotask(() => request.onEvent?.({ type: DelegateEventType.SteerDelivered, payload: { id: message.id } }));
    return true;
  });
  return {
    answer: <T extends object>(result: T) => {
      answered = true;
      return { ...result, steered: [...steered] };
    },
  };
}

/**
 * A pending session waits for a real stop, and stays pending when resumed to read a steered
 * message. Stopped, it hands back its session like a real engine instead of throwing; null when
 * this session is not a pending one.
 */
async function pendingSession(
  id: EngineId,
  request: DelegateRequest,
  pendingSessions: Set<string>,
): Promise<DelegateResult | null> {
  const resumed = request.resume && pendingSessions.has(request.resume) ? request.resume : null;
  const asked = request.prompt.split(LATEST_MESSAGE).at(-1)?.includes(PENDING_MARKER);
  if (!asked && !resumed) return null;
  const sessionId = resumed ?? `fixture-pending-${pendingSessions.size + 1}`;
  pendingSessions.add(sessionId);
  try {
    await pending(request.signal, id);
    return null;
  } catch {
    return {
      ok: false,
      engine: id,
      model: FIXTURE_MODEL,
      turns: 1,
      usage: {},
      sessionId,
      summary: "",
      stopReason: StopReason.Stopped,
      errorText: MESSAGE.stoppedByYou,
    };
  }
}

/** A reply that hands the user one command to run. */
function commandReply(id: EngineId) {
  return {
    ok: true,
    engine: id,
    model: FIXTURE_MODEL,
    turns: 1,
    usage: {},
    sessionId: "fixture-command-v1",
    summary: MESSAGE.commandReply,
  };
}

/** The build interview: one question first, then the answer understood. */
function interviewReply(id: EngineId, request: DelegateRequest) {
  const question = {
    name: "ask_user",
    args: {
      question: "Where should the scene take place?",
      options: "Ashlands (Recommended) | Open terrain and mushroom trees\nTown street | Buildings and lanterns",
    },
  };
  return {
    ok: true,
    engine: id,
    model: FIXTURE_MODEL,
    turns: 1,
    usage: {},
    sessionId: "fixture-interview-v1",
    summary: request.resume
      ? "A coast at night, understood."
      : "I can build a small scene with a clear sense of place.",
    studioToolCalls: request.resume ? [] : [question],
  };
}

function pending(signal: AbortSignal | undefined, id: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(new EngineError(EngineFailureKind.Aborted, id, "Fixture pending operation aborted by real Stop"));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

/** About ten thousand characters of Markdown a coding reply is made of: headings, prose, lists, code and a table. */
function longReply(): string {
  const sections = Array.from({ length: LONG_REPLY_SECTIONS }, (_, i) =>
    [
      `### Step ${i + 1}: the bridge's ${["deck", "rails", "lamps", "water"][i % 4]}`,
      "The bridge keeps its deck level with the river bank, and every plank snaps to the same grid so the player never catches a foot on a seam. **Nothing here changes the camera.**",
      "- Keep the `planks` group under one parent so a single matrix update moves them all.",
      "- Reuse the `MeshStandardMaterial` instead of making one per plank.",
      "- Leave `castShadow` off for the rails; the lamps cast enough.",
      "```js",
      `export function buildSection${i}(scene, planks) {`,
      "  const group = new THREE.Group();",
      "  for (let x = 0; x < planks; x++) {",
      "    const plank = new THREE.Mesh(PLANK_GEOMETRY, WOOD);",
      "    plank.position.set(x * 0.42 - planks * 0.21, 0, 0);",
      "    group.add(plank);",
      "  }",
      "  scene.add(group);",
      "  return group;",
      "}",
      "```",
    ].join("\n"),
  );
  const table = [
    "| Part | Draw calls | Triangles |",
    "| --- | --- | --- |",
    "| Deck | 1 | 2,400 |",
    "| Rails | 2 | 960 |",
  ];
  return [...sections, table.join("\n")].join("\n\n");
}
