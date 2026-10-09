/**
 * The `computer` tool in the harness's own tool loop. A direct engine (Ollama) has no session the
 * studio can hand live tools to, so the harness asks the model, runs each call it makes through
 * `preview.computer` on a leased window, and hands back what the host answered — the same tool,
 * pacing, budget, goal check and trace a session engine's playtester or judge holds.
 *
 * A file of its own: playtester.ts and hands-on-judge.ts both play through it, and a seed upgrade
 * may keep an older playtester.ts the agent edited, which never imports it.
 */
import { LIGHT_EFFORT } from "./config.ts";
import { HostMethod } from "./host-methods.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import type {
  CompletionRole,
  ComputerTraceSummary,
  DelegatePlaytestGrant,
  LiveToolResult,
  Message,
  MessageImage,
  ToolDefinition,
} from "../types/host-api.d.ts";

/** Who holds the computer (`DelegatePlaytestGrant.role`), in the host's own spelling. */
export const PlayRole = { Playtester: "playtester", Scout: "scout", Judge: "judge" } as const;
export type PlayRole = (typeof PlayRole)[keyof typeof PlayRole];

/** How the build's clock is held between moves (`DelegatePlaytestGrant.pacing`). */
export const PlayPacing = { Paced: "paced", Stepped: "stepped" } as const;
export type PlayPacing = (typeof PlayPacing)[keyof typeof PlayPacing];

/** The most pictures one turn sends back to the model: the latest ones. */
const MAX_TURN_IMAGES = 3;
/** How much of one tool answer goes back to the model. */
const TOOL_RESULT_CHARS = 4_000;

/** What the model reads in the loop's own turns. */
const MESSAGE = {
  spent: "Your action budget is spent. Reply now with the JSON answers and report.",
  look: (labels: string) => `Look at these pictures (${labels}). A path is not a picture.`,
  failed: (why: string) => `computer failed: ${why}`,
} as const;

/** The grant a `preview.computer` call carries: a playtest grant on a window the harness leased. */
export type ComputerGrant = DelegatePlaytestGrant & { handle: string };

/**
 * The `computer` tool's definition as the host describes it for this grant, or null when the host
 * cannot run one here (an older host without `preview.computer`, a root it refuses, no lease).
 */
export async function describeComputer(ctx: HarnessCtx, grant: ComputerGrant): Promise<ToolDefinition | null> {
  try {
    const answer = await ctx.call(HostMethod.PreviewComputer, { ...grant, describe: true });
    const tool = answer && "tool" in answer ? answer.tool : null;
    if (!tool?.name) return null;
    return { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? tool.parameters };
  } catch {
    return null;
  }
}

/** One computer session in the harness's loop: who answers, what it is told, and the window it plays. */
export interface ComputerSession {
  engineId: string;
  model: string | undefined;
  system: string;
  brief: string;
  grant: ComputerGrant;
  tool: ToolDefinition;
  maxActions: number;
  deadline?: number | null;
  /** Who the completions are recorded as (judge-provenance.ts `CompletionRole`). */
  role: CompletionRole;
  runId?: string;
}

/** What a session came back with: its moves, its final text, and its trace. */
export interface ComputerPlayed {
  actions: number;
  transcript: string;
  trace: ComputerTraceSummary | null;
}

/** The loop's own state: the conversation, the moves made, and what the host last said. */
interface Loop {
  ctx: HarnessCtx;
  session: ComputerSession;
  messages: Message[];
  played: ComputerPlayed;
}

/** Play the session out: the model moves through the computer until it answers or the budget is spent. */
export async function playWithComputer(ctx: HarnessCtx, session: ComputerSession): Promise<ComputerPlayed> {
  const loop: Loop = {
    ctx,
    session,
    messages: [{ role: "user", content: session.brief }],
    played: { actions: 0, transcript: "", trace: null },
  };
  for (let round = 0; round <= session.maxActions; round++) {
    const outOfTime = Boolean(session.deadline && Date.now() > session.deadline);
    if (ctx.cancelled || outOfTime) break;
    const transcript = await turn(loop, round === session.maxActions);
    if (transcript !== null) return { ...loop.played, transcript };
  }
  return loop.played;
}

/** One turn: the model moves, or answers. The final text once it answers, else null. */
async function turn(loop: Loop, lastTurn: boolean): Promise<string | null> {
  const message: Message = (await ask(loop, true)) ?? { role: "assistant", content: "" };
  loop.messages.push(message);
  const calls = message.tool_calls ?? [];
  if (calls.length > 0 && !lastTurn) {
    await runCalls(loop, calls);
    return null;
  }
  const text = String(message.content ?? "");
  if (calls.length === 0) return text;
  loop.messages.push({ role: "user", content: MESSAGE.spent });
  const final = await ask(loop, false);
  return String(final?.content ?? text);
}

/** One completion: with the computer, or (for the final answers) without it. */
async function ask({ ctx, session, messages }: Loop, withTools: boolean): Promise<Message | undefined> {
  const response = await ctx.call(HostMethod.EngineComplete, {
    engine: session.engineId,
    ...(session.model ? { model: session.model } : {}),
    systemPrompt: session.system,
    messages,
    ...(withTools ? { tools: [session.tool] } : {}),
    stream: false,
    effort: LIGHT_EFFORT,
    provenance: { role: session.role, ...(session.runId ? { runId: session.runId } : {}) },
  });
  return response.message;
}

/** Run the model's calls through the host, hand back each answer, and show it the pictures they took. */
async function runCalls(loop: Loop, calls: NonNullable<Message["tool_calls"]>): Promise<void> {
  const images: MessageImage[] = [];
  for (const call of calls) {
    loop.played.actions++;
    const answer = await runCall(loop, call);
    loop.messages.push({
      role: "tool",
      content: answer.text.slice(0, TOOL_RESULT_CHARS),
      tool_call_id: call.id,
      name: call.name,
      ...(answer.isError ? { is_error: true } : {}),
    });
    for (const image of answer.images) if (image?.data) images.push(image);
  }
  if (!images.length) return;
  const kept = images.slice(-MAX_TURN_IMAGES);
  loop.messages.push({
    role: "user",
    content: MESSAGE.look(kept.map((i) => i.label ?? "shot").join(", ")),
    images: kept.map((i) => ({
      mimeType: i.mimeType || "image/jpeg",
      data: i.data,
      ...(i.label ? { label: i.label } : {}),
    })),
  });
}

/** One call through `preview.computer`; a throw comes back as a failed answer the model can read. */
async function runCall(
  loop: Loop,
  call: NonNullable<Message["tool_calls"]>[number],
): Promise<{ text: string; images: MessageImage[]; isError: boolean }> {
  const { ctx, session, played } = loop;
  try {
    const args = call.arguments && typeof call.arguments === "object" ? (call.arguments as AnyRecord) : {};
    const answered = await ctx.call(HostMethod.PreviewComputer, { ...session.grant, args });
    if (!answered || !("answer" in answered)) return { text: "", images: [], isError: false };
    played.trace = answered.trace ?? played.trace;
    return readAnswer(answered.answer);
  } catch (err: any) {
    return { text: MESSAGE.failed(String(err?.message ?? err)), images: [], isError: true };
  }
}

/** A tool answer as text, pictures and whether it failed. */
function readAnswer(answer: LiveToolResult): { text: string; images: MessageImage[]; isError: boolean } {
  if (typeof answer === "string") return { text: answer, images: [], isError: false };
  return { text: String(answer?.text ?? ""), images: answer?.images ?? [], isError: answer?.isError === true };
}
