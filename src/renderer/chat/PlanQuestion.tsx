import { useId, useRef, useState } from "react";
import { type PlanReview, PlanReviewState } from "../../shared/composer.ts";
import { EngineFailureKind } from "../../shared/engine-requests.ts";
import { t } from "../../shared/i18n.ts";
import { Markdown } from "../ui/Markdown.tsx";
import { FileText } from "../ui/FileText.tsx";
import { problemWords } from "../words.ts";
import { answerKeys } from "./answer-keys.ts";
import { AnswerKeyCaps, useAnswerKeys } from "./ChatQuestion.tsx";
import { hostPlatform } from "../platform.ts";
import { planAwaitsAnswer } from "./use-plan-review.ts";

type Review = Omit<PlanReview, "options">;

/** Why a plan could not be prepared, as its failure says: sign-in, the model, or anything else. */
const Recovery = {
  Auth: "auth",
  Limited: "limited",
  Other: "other",
} as const;
type Recovery = (typeof Recovery)[keyof typeof Recovery];

/** The failures a person recovers from somewhere else than Try again: a sign-in, or another model. */
const FAILURE_RECOVERY: Partial<Record<EngineFailureKind, Recovery>> = {
  [EngineFailureKind.Auth]: Recovery.Auth,
  [EngineFailureKind.RateLimit]: Recovery.Limited,
  [EngineFailureKind.UsageLimit]: Recovery.Limited,
  [EngineFailureKind.Unavailable]: Recovery.Limited,
};

const RECOVERY_WORDS: Record<Recovery, { title: string; next: string }> = {
  [Recovery.Auth]: {
    title: t("Reconnect your model"),
    next: t("Open Model providers to reconnect, then try again."),
  },
  [Recovery.Limited]: {
    title: t("This model is unavailable"),
    next: t("Choose another model or check your account in Model providers, then try again."),
  },
  [Recovery.Other]: { title: t("Couldn’t prepare the plan"), next: t("Try again, or choose another model.") },
};

/** How to recover from a plan's failure; a record written before failures were kept reads as Other. */
function recoveryOf(failure: EngineFailureKind | undefined): Recovery {
  return (failure && FAILURE_RECOVERY[failure]) || Recovery.Other;
}

/** One action at a time: a second click while one runs does nothing, and a failure is shown. */
function useSingleAction() {
  const running = useRef(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string>();
  const run = async (action: () => Promise<void>): Promise<void> => {
    if (running.current) return;
    running.current = true;
    setPending(true);
    setFailure(undefined);
    try {
      await action();
    } catch (error) {
      setFailure(problemWords(error));
    } finally {
      running.current = false;
      setPending(false);
    }
  };
  return { pending, failure, run };
}

interface PlanQuestionProps {
  review: Review;
  busy: boolean;
  revising?: boolean;
  onRetry?: () => Promise<void>;
  onChooseModel?: () => void;
  onSettings?: () => void;
  onAnswer: (approved: boolean) => Promise<void>;
  onRevise: () => void;
}

/** Whether a plan can be approved now: it is written and waits, and no revision is under way. */
const approvable = (review: Review, revising: boolean | undefined): boolean =>
  !revising && review.state === PlanReviewState.Waiting && Boolean(review.plan);

/**
 * The plan scrolls; its three explicit actions always remain in view, Approve first and filled,
 * pressed from anywhere in the chat by the answer keys.
 */
export function PlanQuestion(props: PlanQuestionProps) {
  const titleId = useId();
  const card = useRef<HTMLElement>(null);
  const action = useSingleAction();
  const blocked = props.busy || action.pending;
  const answer = (approved: boolean): void => {
    if (blocked) return;
    void action.run(() => props.onAnswer(approved));
  };
  const { review } = props;
  const canApprove = approvable(review, props.revising);
  useAnswerKeys(card, planAwaitsAnswer(review) && canApprove && !blocked, () => answer(true));
  if (!planAwaitsAnswer(review)) return null;
  if (review.state === PlanReviewState.Failed)
    return <PlanRecovery {...props} titleId={titleId} blocked={blocked} action={action} answer={answer} />;
  const problem = action.failure || review.error;
  return (
    <section ref={card} data-plan-review aria-labelledby={titleId} aria-busy={blocked} className="chat-plan">
      <div
        data-plan-body
        tabIndex={0}
        role="region"
        aria-label={t("Plan")}
        className="min-h-0 overflow-y-auto px-4 py-3"
      >
        <h3 id={titleId} className="mb-3 text-chat font-medium">
          {t("Review plan")}
        </h3>
        {review.plan && <Markdown text={review.plan} />}
        {problem && (
          <p role="alert" className="mt-2 text-chat text-red">
            <FileText text={problem} />
          </p>
        )}
      </div>
      <div data-plan-actions className="chat-answers shrink-0 border-t border-line">
        <button
          type="button"
          data-plan-approve
          aria-keyshortcuts={answerKeys(hostPlatform()).aria}
          className="chat-answer chat-answer-primary"
          disabled={blocked || !canApprove}
          onClick={() => answer(true)}
        >
          {t("Approve")}
          <AnswerKeyCaps />
        </button>
        <button
          type="button"
          data-plan-revise
          className="chat-answer chat-answer-secondary"
          disabled={blocked}
          onClick={props.onRevise}
        >
          {t("Make changes")}
        </button>
        <button
          type="button"
          data-plan-cancel
          className="chat-answer chat-answer-secondary"
          disabled={blocked}
          onClick={() => answer(false)}
        >
          {t("Cancel")}
        </button>
      </div>
    </section>
  );
}

/** A plan that could not be prepared: why, and the ways on (another model, providers, again). */
function PlanRecovery({
  review,
  titleId,
  blocked,
  action,
  answer,
  onChooseModel,
  onSettings,
  onRetry,
}: PlanQuestionProps & {
  titleId: string;
  blocked: boolean;
  action: ReturnType<typeof useSingleAction>;
  answer: (approved: boolean) => void;
}) {
  const words = RECOVERY_WORDS[recoveryOf(review.failure)];
  return (
    <section data-model-recovery aria-labelledby={titleId} aria-busy={blocked} className="chat-plan">
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <h3 id={titleId} className="text-chat font-medium">
          {words.title}
        </h3>
        <p className="mt-2 text-chat-sub text-ink-2">{words.next}</p>
        {review.error && (
          <details className="mt-2 text-chat-sub text-ink-3">
            <summary className="cursor-pointer">{t("Details")}</summary>
            <p className="mt-1 [overflow-wrap:anywhere]">
              <FileText text={review.error} />
            </p>
          </details>
        )}
        {action.failure && (
          <p role="alert" className="mt-2 text-chat-sub text-red">
            {action.failure}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-line px-2 py-2">
        <button type="button" className="chat-question-submit" disabled={blocked} onClick={onChooseModel}>
          {t("Choose model")}
        </button>
        <button type="button" className="chat-plan-secondary" disabled={blocked} onClick={onSettings}>
          {t("Model providers")}
        </button>
        <button
          type="button"
          className="chat-plan-secondary"
          disabled={blocked}
          onClick={async () => {
            if (onRetry) await action.run(onRetry);
          }}
        >
          {t("Try again")}
        </button>
        <button type="button" className="chat-plan-secondary" disabled={blocked} onClick={() => answer(false)}>
          {t("Dismiss")}
        </button>
      </div>
    </section>
  );
}
