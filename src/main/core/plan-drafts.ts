/**
 * The plan a reviewed request waits on: the lead writes it in one tool-free completion, and the
 * thread's metadata keeps it (with a `plan_review` record in the log) until the user answers.
 * `PlanReviewController` (`../plan-review.ts`) owns the approval gate; this module is its host.
 */
import { type ComposerSendOptions, type PlanReview, PlanReviewState } from "../../shared/composer.ts";
import { conversationThrough, latestRun, runSnapshot } from "../../shared/coordinator.ts";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind, type Message } from "../../shared/event-log.ts";
import { WorkClass } from "../../shared/harness-api.ts";
import { t } from "../../shared/i18n.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { Engine } from "../../substrate/engines/types.ts";
import type { EventEnvelope } from "../../substrate/types.ts";
import { PlanReviewController } from "../plan-review.ts";
import type { StudioCore } from "../studio-core.ts";
import type { CoreInternals } from "./internals.ts";
import { PLAN_SYSTEM_PROMPT, planContext } from "./plan-drafts-prompts.ts";
import { CapabilityAudience } from "../planning-capabilities.ts";

/** The longest plan the lead may write, in tokens. */
const PLAN_MAX_TOKENS = 4096;
/** How many of the conversation's last messages the plan is written from. */
const PLAN_RECENT_MESSAGES = 20;
/** The most of that conversation, in characters, counted from its end. */
const PLAN_CONVERSATION_CHARS = 18_000;
/** The most of the run's state, and of its saved plan, in characters of JSON each. */
const PLAN_STATE_CHARS = 12_000;

/** What the user reads when a plan cannot be written. */
const MESSAGE = {
  cannotPlan: () => t("This provider cannot prepare a reviewable plan. Choose another model."),
} as const;

type PlanCore = Pick<StudioCore, "store" | "engines" | "budget" | "mainThread" | "append" | "emit" | "sendUserMessage">;
type PlanFacts = Pick<CoreInternals, "capabilityFacts" | "rewind">;
type PlanningEngine = Engine & Required<Pick<Engine, "complete">>;

/** What the controller asks for: the request text, its options, and the plan it revises. */
interface PlanAsk {
  text: string;
  options: ComposerSendOptions;
  signal: AbortSignal;
  prior?: PlanReview | null;
}

/** The plan-review gate, keeping its reviews in thread metadata and asking the lead for plans. */
export function createPlanReviews(core: PlanCore, x: PlanFacts): PlanReviewController {
  return new PlanReviewController({
    load: (thread) => loadReview(core, thread),
    save: (thread, review) => saveReview(core, thread, review),
    generate: (text, options, signal, prior) => draftPlan(core, x, { text, options, signal, prior }),
    dispatch: (text, options) => core.sendUserMessage(text, options),
  });
}

async function loadReview(core: PlanCore, thread: string): Promise<PlanReview | null> {
  const record = await core.store.getRecord(thread);
  return (record.metadata as { planReview?: PlanReview } | undefined)?.planReview ?? null;
}

async function saveReview(core: PlanCore, thread: string, review: PlanReview): Promise<void> {
  await core.store.updateThread(thread, { metadata: { planReview: review } });
  const { options: _options, ...payload } = review;
  await core.append([customEventData(CustomEvent.PlanReview, payload)], thread);
  core.emit(UiEvent.ThreadUpdated, { threadId: thread });
}

/** One tool-free completion, billed as user work, that returns the plan's text. */
async function draftPlan(core: PlanCore, x: PlanFacts, ask: PlanAsk): Promise<string> {
  const engine = await planningEngine(core, ask.options.engine);
  const response = await core.budget.run(
    WorkClass.User,
    async () => {
      const context = await planRequest(core, x, engine.id, ask);
      return engine.complete({
        model: ask.options.model,
        effort: ask.options.effort,
        preferences: ask.options.preferences,
        signal: ask.signal,
        maxTokens: PLAN_MAX_TOKENS,
        systemPrompt: PLAN_SYSTEM_PROMPT,
        messages: [
          { role: "user", content: context, ...(ask.options.frames?.length ? { images: ask.options.frames } : {}) },
        ],
        tools: [],
      });
    },
    engine.id,
  );
  const content = response.message.content;
  return typeof content === "string" ? content : JSON.stringify(content);
}

/** The engine the user picked, or the first one ready; it must be able to answer a completion. */
async function planningEngine(core: PlanCore, engineId: string | undefined): Promise<PlanningEngine> {
  const engine = engineId ? core.engines.get(engineId) : await core.engines.firstReady();
  if (!canComplete(engine)) throw new Error(MESSAGE.cannotPlan());
  return engine;
}

function canComplete(engine: Engine | null): engine is PlanningEngine {
  return typeof engine?.complete === "function";
}

/**
 * The plan's one user message: the capabilities this thread's builders have (recorded as applied
 * to planning), the conversation so far, the plan being revised, the run's state and the request.
 */
async function planRequest(core: PlanCore, x: PlanFacts, engineId: string, ask: PlanAsk): Promise<string> {
  const thread = ask.options.thread ?? core.mainThread;
  // A rewound chat is planned from the conversation that remains.
  const events = await x.rewind.harnessView(thread, await core.store.listEvents(thread));
  const run = latestRun(events);
  const journal = run ? await core.store.readArtifact(thread, `autopilot_${run.runId}`).catch(() => null) : null;
  const conversation = spokenMessages(events);
  const record = await core.store.getRecord(thread);
  const project = ask.options.project ?? (record.metadata as { project?: string } | undefined)?.project;
  const { revision, text: capabilities } = await x.capabilityFacts(thread, project, CapabilityAudience.Planning);
  await core.append(
    [
      // Not `customEventData`: the log records "no game" as null, which the shared payload type lacks.
      {
        type: EventKind.Custom,
        event_type: CustomEvent.PlanningCapabilitiesApplied,
        payload: { revision, engine: engineId, project: project ?? null },
      },
    ],
    thread,
  );
  return planContext({
    capabilities,
    originalRequest: conversation.find((m) => m.role === "user")?.content ?? ask.prior?.text ?? ask.text,
    recentConversation: recentLines(conversation),
    ...(ask.prior?.plan
      ? { previous: { plan: ask.prior.plan, approved: ask.prior.state === PlanReviewState.Approved } }
      : {}),
    ...(run
      ? {
          build: {
            state: JSON.stringify(runSnapshot(events, run.runId)).slice(0, PLAN_STATE_CHARS),
            savedPlan: JSON.stringify(savedPlan(journal)).slice(0, PLAN_STATE_CHARS),
          },
        }
      : {}),
    latestRequest: ask.text,
  });
}

/** What the user and the lead said in the conversation, oldest first. */
function spokenMessages(events: EventEnvelope[]): Message[] {
  return conversationThrough(events)
    .flatMap((e) => (e.data.type === EventKind.Messages ? e.data.messages : []))
    .filter((m) => m.role === "user" || m.role === "assistant");
}

/** The conversation's last messages as `role: text` lines, cut to the character cap from the end. */
function recentLines(conversation: Message[]): string {
  return conversation
    .slice(-PLAN_RECENT_MESSAGES)
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n")
    .slice(-PLAN_CONVERSATION_CHARS);
}

/** The plan an Autopilot journal saved: the director's, else the journal's own, else none. */
function savedPlan(journal: unknown): unknown {
  const saved = journal as { director?: { plan?: unknown }; plan?: unknown } | null;
  return saved?.director?.plan ?? saved?.plan ?? null;
}
