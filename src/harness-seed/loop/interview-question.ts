import type { AnyRecord, HarnessTool, ToolCtx } from "../types/harness.d.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent } from "./run-events.ts";
import { clip, CLIP_REASON } from "./text.ts";

/** How long a recorded question and its recap may be, how many choices it offers, and how long each choice's label. */
const QUESTION_CHARS = 600;
const RECAP_CHARS = 300;
const MAX_CHOICES = 3;
const CHOICE_LABEL_CHARS = 160;

/** Intake uses a recorded question, then resumes on the next normal user message.
 * No provider session, permission grant or timeout is held while the user decides. */
export function interviewQuestion(args: AnyRecord = {}): {
  question: string;
  recap?: string;
  choices: Array<{ id: string; label: string; description?: string }>;
} {
  const question = typeof args.question === "string" ? args.question.trim().slice(0, QUESTION_CHARS) : "";
  if (!question) throw new Error("Ask one short question.");
  const recap = typeof args.recap === "string" ? args.recap.trim().slice(0, RECAP_CHARS) : "";
  const choices = String(args.options ?? "")
    .split("\n")
    .filter((line) => line.trim())
    .slice(0, MAX_CHOICES)
    .map((line, index) => {
      const [label, ...description] = line.split("|");
      return {
        id: String(index),
        label: (label ?? "").trim().slice(0, CHOICE_LABEL_CHARS),
        ...(description.length ? { description: clip(description.join("|").trim(), CLIP_REASON) } : {}),
      };
    })
    .filter((choice) => choice.label);
  return { question, ...(recap ? { recap } : {}), choices };
}

/** The next user reply inherits the question's commission, including after a restart.
 * A later message or a registered run clears it; progress updates never grant launch authority. */
export function interviewForReply(events: readonly AnyRecord[] = []): string | null {
  let pending: string | null = null,
    reply: string | null = null;
  for (const event of events) {
    const data = event.data ?? event;
    if (
      data.type === EventKind.Messages &&
      data.messages.some((message: { role?: string }) => message.role === "user")
    ) {
      reply = pending;
      pending = null;
    } else if (data.type === EventKind.Custom && data.event_type === RunEvent.InterviewQuestion)
      pending = data.payload.intakeId ?? null;
    else if (data.type === EventKind.Custom && [RunEvent.RunRegistered, RunEvent.RunStarted].includes(data.event_type))
      pending = reply = null;
  }
  return reply;
}

/** The run this interview is commissioning, kept beside the question: autopilot or loop options. */
function commissionOf(ctx: ToolCtx): AnyRecord | null {
  if (ctx.autopilot) return { autopilot: ctx.autopilot };
  if (ctx.loop) return { loop: ctx.loop };
  return null;
}

export async function recordInterviewQuestion(ctx: ToolCtx, args: AnyRecord): Promise<void> {
  const question = interviewQuestion(args);
  const intake = commissionOf(ctx);
  const intakeId = intake ? `interview_${ctx.turnId}` : null;
  // Reference images and commissioning options stay out of the paged chat payload.
  if (intakeId)
    await ctx.call(HostMethod.ArtifactWrite, { threadId: ctx.threadId, artifactId: intakeId, value: intake });
  await ctx.call(HostMethod.TurnAppend, {
    turnId: ctx.turnId!,
    batch: [
      {
        type: EventKind.Custom,
        event_type: RunEvent.InterviewQuestion,
        payload: { ...question, ...(intakeId ? { intakeId } : {}) },
      },
    ],
  });
}

export const askUser: HarnessTool = {
  name: "ask_user",
  description:
    "Ask one necessary question in the chat's answer panel. Offer up to 3 concise choices, recommended first. The user can also type a different answer. End your reply after calling this; wait for the next user message before starting a run. Before a build, ask it when you do not know what the game is or how it should look. Never use this for progress updates, permission to do work already requested, or a reply to a greeting or small talk (answer that in words).",
  parameters: {
    type: "object",
    properties: {
      recap: {
        type: "string",
        description:
          "Optional: one short sentence on what you found or just did, shown above the question (for example: The road, two cars and the lap timer are in.).",
      },
      question: {
        type: "string",
        description:
          "One short question whose answer changes what you do next (for example: what the player does or how the game should look, before a build; or a build versus research and a plan first).",
      },
      options: {
        type: "string",
        description:
          "Up to 3 choices, one per line: Label | optional short description. Put (Recommended) in the first label when appropriate. No Other choice; the composer supports custom answers.",
      },
    },
    required: ["question"],
  },
  async execute(args, ctx) {
    await recordInterviewQuestion(ctx, args);
    return { ok: true, content: "Question shown. Wait for the user's next message.", stopTurn: "done" };
  },
};
