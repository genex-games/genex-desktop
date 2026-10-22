import { randomUUID } from "node:crypto";
import { type ComposerSendOptions, type PlanReview, PlanReviewState } from "../shared/composer.ts";
import { errorMessage } from "../shared/errors.ts";
import { t } from "../shared/i18n.ts";
import { approvedPlanMessage, planRevisionRequest } from "./plan-review-prompts.ts";

/**
 * What the user reads when a plan cannot be written or started yet. `emptyPlan` is saved on the
 * review (its Details line), so it stays English like the other errors saved there.
 */
const MESSAGE = {
  starting: () => t("The approved plan is starting. Please wait."),
  emptyPlan: "The model returned an empty plan. Send a message to try again.",
} as const;

/** A review still open: a new request revises it, and an answer may still settle it. */
const OPEN_REVIEW: ReadonlySet<PlanReviewState> = new Set([
  PlanReviewState.Waiting,
  PlanReviewState.Generating,
  PlanReviewState.Failed,
]);

interface ReviewHost {
  load: (thread: string) => Promise<PlanReview | null>;
  save: (thread: string, review: PlanReview) => Promise<void>;
  generate: (
    text: string,
    options: ComposerSendOptions,
    signal: AbortSignal,
    prior?: PlanReview | null,
  ) => Promise<string>;
  dispatch: (text: string, options: ComposerSendOptions) => Promise<void>;
}
/**
 * The review a request opens: a revision of an open one (its words and options carried), or a new
 * one; cancelled at once when Stop was pressed since its message was sent.
 */
function requestedReview(request: {
  thread: string;
  text: string;
  options: ComposerSendOptions;
  prior: PlanReview | null;
  stopped: boolean;
}): PlanReview {
  const { thread, text, options, prior, stopped } = request;
  const revision = prior !== null && OPEN_REVIEW.has(prior.state);
  const combined = revision && text.trim() !== prior.text.trim() ? planRevisionRequest(prior.text, text) : text;
  return {
    id: randomUUID(),
    state: stopped ? PlanReviewState.Cancelled : PlanReviewState.Generating,
    text: combined,
    options: { ...(revision ? prior.options : {}), ...options, thread },
  };
}

/** A durable approval gate before either execution path. No timer can approve a plan. */
export class PlanReviewController {
  #active = new Map<string, AbortController>();
  #answering = new Set<string>();
  /** When the user last pressed Stop in each chat: a plan for a message sent before it is not written. */
  #stoppedAt = new Map<string, number>();
  private host: ReviewHost;
  constructor(host: ReviewHost) {
    this.host = host;
  }
  /**
   * Write a plan for a message. `sentAt` is when its send began: a Stop pressed since (while the
   * send read the chat, before this request began) keeps the request, cancelled, and writes nothing.
   */
  async request(
    thread: string,
    text: string,
    options: ComposerSendOptions,
    { sentAt }: { sentAt?: number } = {},
  ): Promise<void> {
    if (this.#answering.has(thread)) throw new Error(MESSAGE.starting());
    this.#active.get(thread)?.abort();
    const abort = new AbortController();
    this.#active.set(thread, abort);
    const prior = await this.host.load(thread);
    if (abort.signal.aborted) return;
    const review = requestedReview({ thread, text, options, prior, stopped: this.#stoppedSince(thread, sentAt) });
    try {
      await this.host.save(thread, review);
      if (review.state === PlanReviewState.Cancelled || abort.signal.aborted) return;
      await this.#write(thread, review, prior, abort.signal);
    } catch (e) {
      if (!abort.signal.aborted)
        await this.host.save(thread, { ...review, state: PlanReviewState.Failed, error: String(errorMessage(e) ?? e) });
    } finally {
      if (this.#active.get(thread) === abort) this.#active.delete(thread);
    }
  }
  /** Was Stop pressed in this chat since a send that began at `sentAt`? */
  #stoppedSince(thread: string, sentAt: number | undefined): boolean {
    if (sentAt === undefined) return false;
    return (this.#stoppedAt.get(thread) ?? Number.NEGATIVE_INFINITY) >= sentAt;
  }
  /** Generate the plan and leave it waiting for the user's answer, unless it was stopped meanwhile. */
  async #write(thread: string, review: PlanReview, prior: PlanReview | null, signal: AbortSignal): Promise<void> {
    const plan = await this.host.generate(review.text, review.options, signal, prior);
    if (signal.aborted) return;
    if (!plan.trim()) throw new Error(MESSAGE.emptyPlan);
    await this.host.save(thread, { ...review, plan, state: PlanReviewState.Waiting });
  }
  async answer(thread: string, id: string, approved: boolean): Promise<boolean> {
    if (this.#answering.has(thread)) return false;
    this.#answering.add(thread);
    try {
      const review = await this.host.load(thread);
      const answerable = review?.id === id && OPEN_REVIEW.has(review.state);
      if (!review || !answerable) return false;
      if (!approved) {
        this.#active.get(thread)?.abort();
        await this.host.save(thread, { ...review, state: PlanReviewState.Cancelled });
        return true;
      }
      if (review.state !== PlanReviewState.Waiting || !review.plan) return false;
      await this.host.save(thread, { ...review, state: PlanReviewState.Starting });
      const options = {
        ...review.options,
        reviewPlan: false,
        autopilot: review.options.autopilot ? { ...review.options.autopilot, reviewPlan: false } : undefined,
      };
      try {
        await this.host.dispatch(approvedPlanMessage(review.text, review.plan), options);
        await this.host.save(thread, { ...review, state: PlanReviewState.Approved });
      } catch (e) {
        await this.host.save(thread, {
          ...review,
          state: PlanReviewState.Waiting,
          error: String(errorMessage(e) ?? e),
        });
        throw e;
      }
      return true;
    } finally {
      this.#answering.delete(thread);
    }
  }
  async cancel(thread: string): Promise<void> {
    this.#stoppedAt.set(thread, Date.now());
    this.#active.get(thread)?.abort();
    const review = await this.host.load(thread);
    if (review) await this.answer(thread, review.id, false);
  }
  stop(): void {
    for (const abort of this.#active.values()) abort.abort();
    this.#active.clear();
  }
  /** A plan is being written or its approval is starting, in this process (a saved state can outlive a crash). */
  busy(thread: string): boolean {
    return this.#active.has(thread) || this.#answering.has(thread);
  }
}
