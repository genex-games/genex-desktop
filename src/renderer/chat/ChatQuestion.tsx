import { useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { t } from "../../shared/i18n.ts";
import { problemWords } from "../words.ts";
import { Icon } from "../ui/icons.tsx";
import { FileText } from "../ui/FileText.tsx";

export interface ChatChoice {
  id: string;
  label: string;
  description?: string;
}

/** The pick that is the person's own words, typed in the card. */
const OWN = "\u0000own";
/** What the own-words row says before anything is typed, unless the card says otherwise. */
const OWN_PLACEHOLDER = t("Write your own answer…");

/** A choice row's class: dimmed while the card cannot answer, else the cursor for its kind. */
const choiceClass = (blocked: boolean, cursor: string): string =>
  `chat-choice ${blocked ? "cursor-default opacity-50" : cursor}`;

/**
 * Sending the picked answer: one send at a time, and its failure in the user's words. A pick of
 * the typed row sends the typed text.
 */
function useAnswerSubmit(input: {
  blocked: boolean;
  ready: boolean;
  picked: string;
  own: string;
  onConfirm: (id: string) => Promise<void> | void;
  onAnswerText?: (text: string) => Promise<void> | void;
  setBusy: (busy: boolean) => void;
}) {
  const [failure, setFailure] = useState<string>();
  const submitting = useRef(false);
  const submit = async () => {
    if (input.blocked || !input.ready) return;
    if (submitting.current) return;
    submitting.current = true;
    input.setBusy(true);
    setFailure(undefined);
    try {
      await (input.picked === OWN ? input.onAnswerText?.(input.own.trim()) : input.onConfirm(input.picked));
    } catch (error) {
      setFailure(problemWords(error));
    } finally {
      submitting.current = false;
      input.setBusy(false);
    }
  };
  return { failure, submit };
}

/** The row that takes the person's own answer, typed in the card. */
function OwnAnswer({
  name,
  picked,
  own,
  blocked,
  input,
  placeholder,
  onPick,
  onType,
}: {
  name: string;
  picked: boolean;
  own: string;
  blocked: boolean;
  input: RefObject<HTMLInputElement | null>;
  placeholder: string;
  onPick: () => void;
  onType: (text: string) => void;
}) {
  return (
    <label data-question-own className={choiceClass(blocked, "cursor-text")}>
      <input
        type="radio"
        name={name}
        value={OWN}
        aria-label={t("Your own answer")}
        checked={picked}
        onChange={() => {
          onPick();
          input.current?.focus();
        }}
        className="chat-choice-mark"
      />
      <input
        ref={input}
        type="text"
        value={own}
        placeholder={placeholder}
        aria-label={t("Your own answer")}
        onFocus={onPick}
        onChange={(event) => {
          onType(event.target.value);
          onPick();
        }}
        className="chat-choice-input"
      />
    </label>
  );
}

/** "Chat about this": the card steps aside and the conversation continues, even while it cannot be answered. */
function ChatAboutButton({ blocked, onClick }: { blocked: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-question-chat
      onClick={onClick}
      className={`chat-question-secondary ${blocked ? "opacity-50" : ""}`}
    >
      <Icon name="chat" size={14} />
      {t("Chat about this")}
    </button>
  );
}

/**
 * The card's footer, outside its scroll: Chat about this at the leading edge, the answer's send at
 * the trailing one. Nothing when the card offers neither.
 */
function QuestionFooter({
  blocked,
  answerable,
  submitLabel,
  canSubmit,
  onChatAbout,
}: {
  blocked: boolean;
  /** The card takes an answer, so it has a send. */
  answerable: boolean;
  submitLabel: string;
  canSubmit: boolean;
  onChatAbout: (() => void) | undefined;
}) {
  if (!answerable && !onChatAbout) return null;
  return (
    <div className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-2.5">
      {onChatAbout && <ChatAboutButton blocked={blocked} onClick={onChatAbout} />}
      {answerable && (
        <button type="submit" disabled={blocked || !canSubmit} className="chat-question-submit ms-auto">
          {submitLabel}
          <Icon name="chevron-right" size={14} />
        </button>
      )}
    </div>
  );
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

/** The web chat's question layout, with explicit submission for desktop decisions.
 * The caller keys this by request id. Only the host can settle a request. */
export function ChatQuestion({
  title,
  description,
  choices,
  onConfirm,
  onAnswerText,
  onChatAbout,
  children,
  disabled = false,
  error,
  confirmLabel = t("Continue"),
  reopenLabel = t("Answer question"),
  answerPlaceholder = OWN_PLACEHOLDER,
}: {
  title: string;
  description?: string;
  choices: ChatChoice[];
  onConfirm: (id: string) => Promise<void> | void;
  /** Offers a row to type an answer in the card itself. */
  onAnswerText?: (text: string) => Promise<void> | void;
  /** What that row says before anything is typed. */
  answerPlaceholder?: string;
  /** Offers "Chat about this": the card steps aside and the conversation continues. */
  onChatAbout?: () => void;
  children?: ReactNode;
  disabled?: boolean;
  error?: string;
  confirmLabel?: string;
  reopenLabel?: string;
}) {
  const id = useId();
  const [picked, setPicked] = useState("");
  const [own, setOwn] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const reopen = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const ownInput = useRef<HTMLInputElement>(null);
  const blocked = disabled || busy;
  const ready = picked === OWN ? own.trim().length > 0 : choices.some((choice) => choice.id === picked);
  const { failure, submit } = useAnswerSubmit({ blocked, ready, picked, own, onConfirm, onAnswerText, setBusy });
  const putAside = (): void => {
    setCollapsed(true);
    requestAnimationFrame(() => reopen.current?.focus());
  };
  if (collapsed)
    return (
      <ReopenButton
        buttonRef={reopen}
        label={reopenLabel}
        onReopen={() => {
          setCollapsed(false);
          requestAnimationFrame(() => (close.current ?? ownInput.current)?.focus());
        }}
      />
    );
  const problem = error || failure;
  const answerable = choices.length > 0 || Boolean(onAnswerText);
  return (
    <form
      data-chat-question
      aria-labelledby={id}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="chat-question"
    >
      <div className="min-h-0 overflow-y-auto px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <h3 id={id} className="min-w-0 text-chat font-medium [overflow-wrap:anywhere]">
            {title}
          </h3>
          {!onChatAbout && (
            <button
              ref={close}
              type="button"
              aria-label={t("Put question aside")}
              disabled={busy}
              onClick={putAside}
              className="-me-1 flex size-6 shrink-0 items-center justify-center rounded-control text-ink-3 enabled:hover:bg-control-hover enabled:hover:text-control-text-hover disabled:cursor-default"
            >
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
        {description && (
          <p className="mt-1 text-chat-sub text-ink-2 [overflow-wrap:anywhere]">
            <FileText text={description} />
          </p>
        )}
        {children}
        <fieldset disabled={blocked} className="mt-2 flex min-w-0 flex-col gap-0.5">
          <legend className="sr-only">{t("Choose an answer")}</legend>
          {choices.map((choice) => (
            <label key={choice.id} className={choiceClass(blocked, "cursor-pointer")}>
              <input
                type="radio"
                name={id}
                value={choice.id}
                checked={picked === choice.id}
                onChange={() => setPicked(choice.id)}
                className="chat-choice-mark"
              />
              <span className="min-w-0">
                <span className="block text-chat text-ink-2">{choice.label}</span>
                {choice.description && <span className="block text-chat-sub text-ink-3">{choice.description}</span>}
              </span>
            </label>
          ))}
          {onAnswerText && (
            <OwnAnswer
              name={id}
              picked={picked === OWN}
              own={own}
              blocked={blocked}
              input={ownInput}
              placeholder={answerPlaceholder}
              onPick={() => setPicked(OWN)}
              onType={setOwn}
            />
          )}
        </fieldset>
        {problem && (
          <p role="alert" className="mt-2 text-chat-sub text-red">
            {problem}
          </p>
        )}
      </div>
      <QuestionFooter
        blocked={blocked}
        answerable={answerable}
        submitLabel={busy ? t("Sending…") : confirmLabel}
        canSubmit={ready}
        onChatAbout={
          onChatAbout &&
          (() => {
            putAside();
            onChatAbout();
          })
        }
      />
    </form>
  );
}
