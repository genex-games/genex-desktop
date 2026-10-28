/**
 * A question waiting on the person, asked the way Claude asks: a bold question (a short grey recap
 * above it, or one grey line under it), then its answers as buttons from the card's left edge. The
 * first answer is the recommended one, filled, with the keys that press it from anywhere in the chat
 * (⌘↩, Ctrl+Enter elsewhere). A press answers at once; the person's own words go in the composer.
 */
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { t } from "../../shared/i18n.ts";
import { hostPlatform } from "../platform.ts";
import { problemWords } from "../words.ts";
import { Icon } from "../ui/icons.tsx";
import { FileText } from "../ui/FileText.tsx";
import { answerKeys, pressesAnswer } from "./answer-keys.ts";
import { QuestionDeferral } from "../analytics/chat-vocabulary.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";

export interface ChatChoice {
  id: string;
  label: string;
  /** Shown as the answer's tooltip: the answer's own words carry the card. */
  description?: string;
}

/** The mark a model puts on its recommended choice, which the first button already says. */
const RECOMMENDED_MARK = /\s*\(Recommended\)\s*$/i;

/** A choice's words as its button and its sent answer say them. */
export function choiceLabel(choice: ChatChoice): string {
  return choice.label.replace(RECOMMENDED_MARK, "");
}

/** Whether `element` takes typing. */
const takesTyping = (element: HTMLElement): boolean =>
  element.isContentEditable || element.matches("input, textarea, select");

/**
 * Whether the answer keys pressed at `target` are this card's: it shows, no dialog stands over it,
 * and the press is not someone else's typing (the chat's own composer is fine).
 */
function keysReachCard(target: EventTarget | null, card: HTMLElement): boolean {
  if (!card.isConnected || card.getClientRects().length === 0) return false;
  const dialog = document.querySelector('[aria-modal="true"], dialog[open]');
  if (dialog && !dialog.contains(card)) return false;
  if (!(target instanceof HTMLElement) || !takesTyping(target)) return true;
  return Boolean(card.closest("[data-chat-composer]")?.contains(target)) || card.contains(target);
}

/**
 * The answer keys press `answer` while `card` shows. The latest `answer` is read at the press, and
 * the press goes no further: one card answers, and the composer does not also send.
 */
export function useAnswerKeys(card: RefObject<HTMLElement | null>, on: boolean, answer: () => void): void {
  const latest = useRef(answer);
  latest.current = answer;
  useEffect(() => {
    if (!on) return;
    const onKey = (event: KeyboardEvent): void => {
      const shown = card.current;
      if (!shown || !pressesAnswer(event, hostPlatform())) return;
      if (!keysReachCard(event.target, shown)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      latest.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [card, on]);
}

/** The answer keys as the recommended button shows them; screen readers get `aria-keyshortcuts` instead. */
export function AnswerKeyCaps(): ReactNode {
  return (
    <span data-keys aria-hidden="true" className="chat-answer-keys">
      {answerKeys(hostPlatform()).caps.map((cap) => (
        <kbd key={cap}>{cap}</kbd>
      ))}
    </span>
  );
}

/**
 * Sending the pressed answer: one send at a time, and its failure in the person's words. Which
 * answer is on its way stays until it settles.
 */
function useAnswerSubmit(blocked: boolean, onConfirm: (id: string) => Promise<void> | void) {
  const [failure, setFailure] = useState<string>();
  const [sending, setSending] = useState<string | null>(null);
  const submitting = useRef(false);
  const submit = async (id: string): Promise<void> => {
    if (blocked || submitting.current) return;
    submitting.current = true;
    setSending(id);
    setFailure(undefined);
    try {
      await onConfirm(id);
    } catch (error) {
      setFailure(problemWords(error));
    } finally {
      submitting.current = false;
      setSending(null);
    }
  };
  return { failure, sending, submit };
}

/** A card put aside: one button brings it back. */
function ReopenButton({
  buttonRef,
  label,
  onReopen,
}: {
  buttonRef: RefObject<HTMLButtonElement | null>;
  label: string;
  onReopen: () => void;
}) {
  return (
    <button ref={buttonRef} type="button" data-question-reopen className="chat-disclosure" onClick={onReopen}>
      {label}
      <Icon name="chevron-right" size={14} />
    </button>
  );
}

/**
 * The answers in one row from the card's left edge, the recommended one first, showing the answer
 * keys where they press it. While one sends, only a filled "Sending…" stays: the others can do
 * nothing until it settles.
 */
function Answers({
  choices,
  sending,
  disabled,
  keys,
  first,
  onAnswer,
}: {
  choices: ChatChoice[];
  sending: boolean;
  disabled: boolean;
  keys: boolean;
  first: RefObject<HTMLButtonElement | null>;
  onAnswer: (id: string) => void;
}) {
  if (sending)
    return (
      <div data-question-answers className="chat-answers">
        <button type="button" data-primary="" aria-busy="true" disabled className="chat-answer chat-answer-primary">
          {t("Sending…")}
        </button>
      </div>
    );
  if (choices.length === 0) return null;
  return (
    <div data-question-answers className="chat-answers">
      {choices.map((choice, index) => {
        const shortcut = index === 0 && keys;
        return (
          <button
            key={choice.id}
            ref={index === 0 ? first : undefined}
            type="button"
            data-answer={choice.id}
            data-primary={index === 0 ? "" : undefined}
            aria-keyshortcuts={shortcut ? answerKeys(hostPlatform()).aria : undefined}
            title={choice.description}
            disabled={disabled}
            onClick={() => onAnswer(choice.id)}
            className={`chat-answer ${index === 0 ? "chat-answer-primary" : "chat-answer-secondary"}`}
          >
            {choiceLabel(choice)}
            {shortcut && <AnswerKeyCaps />}
          </button>
        );
      })}
    </div>
  );
}

/** The grey line under the question, ending in "Details ›" when the card has details to open. */
function Fineprint({
  description,
  hasDetails,
  open,
  onToggle,
}: {
  description?: string;
  hasDetails: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  if (!description && !hasDetails) return null;
  return (
    <p className="chat-question-sub">
      {description && <FileText text={description} />}
      {description && hasDetails && " "}
      {hasDetails && (
        <button type="button" data-question-details-toggle aria-expanded={open} onClick={onToggle}>
          {t("Details")}
          <Icon name="chevron-right" size={13} className={`chat-chevron ${open ? "rotate-90" : ""}`} />
        </button>
      )}
    </p>
  );
}

/**
 * A waiting question: the caller keys it by request id, and only the host settles a request.
 * `recap` sits above the question (an agent's own question); `description` is one grey line under
 * it, with `details` behind "Details ›". `keys` off leaves the answer keys to the docked cards.
 */
export function ChatQuestion({
  title,
  recap,
  description,
  details,
  choices,
  onConfirm,
  children,
  disabled = false,
  error,
  reopenLabel = t("Answer question"),
  keys = true,
}: {
  title: string;
  recap?: string;
  description?: string;
  details?: ReactNode;
  choices: ChatChoice[];
  onConfirm: (id: string) => Promise<void> | void;
  children?: ReactNode;
  disabled?: boolean;
  error?: string;
  reopenLabel?: string;
  keys?: boolean;
}) {
  const id = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [open, setOpen] = useState(false);
  const card = useRef<HTMLFormElement>(null);
  const reopen = useRef<HTMLButtonElement>(null);
  const first = useRef<HTMLButtonElement>(null);
  const { failure, sending, submit } = useAnswerSubmit(disabled, onConfirm);
  const blocked = disabled || sending !== null;
  const recommended = choices[0];
  useAnswerKeys(card, keys && !collapsed && !blocked && Boolean(recommended), () => {
    if (recommended) void submit(recommended.id);
  });
  const putAside = (): void => {
    track(AnalyticsEvent.ChatQuestionDeferred, { action: QuestionDeferral.PutAside });
    setCollapsed(true);
    requestAnimationFrame(() => reopen.current?.focus());
  };
  if (collapsed)
    return (
      <ReopenButton
        buttonRef={reopen}
        label={reopenLabel}
        onReopen={() => {
          track(AnalyticsEvent.ChatQuestionDeferred, { action: QuestionDeferral.Reopened });
          setCollapsed(false);
          requestAnimationFrame(() => (first.current ?? card.current)?.focus());
        }}
      />
    );
  const problem = error || failure;
  return (
    <form
      ref={card}
      data-chat-question
      aria-labelledby={id}
      aria-busy={sending !== null}
      tabIndex={-1}
      onSubmit={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.stopPropagation();
        putAside();
      }}
      className="chat-question"
    >
      <div className="chat-question-body">
        {recap && (
          <p data-question-recap className="chat-question-recap">
            {recap}
          </p>
        )}
        <h3 id={id} className="chat-question-title">
          {title}
        </h3>
        <Fineprint
          description={description}
          hasDetails={Boolean(details)}
          open={open}
          onToggle={() => setOpen((shown) => !shown)}
        />
        {open && details && (
          <div data-question-details className="chat-question-details">
            {details}
          </div>
        )}
        {children}
        {problem && (
          <p role="alert" className="mt-2 text-chat-sub text-red">
            {problem}
          </p>
        )}
      </div>
      <Answers
        choices={choices}
        sending={sending !== null}
        disabled={blocked}
        keys={keys}
        first={first}
        onAnswer={(choice) => void submit(choice)}
      />
      <button
        type="button"
        aria-label={t("Put question aside")}
        disabled={sending !== null}
        onClick={putAside}
        className="chat-question-aside"
      >
        <Icon name="close" size={14} />
      </button>
    </form>
  );
}
