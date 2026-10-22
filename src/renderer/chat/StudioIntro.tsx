import { t } from "../../shared/i18n.ts";
import { Markdown } from "../ui/Markdown.tsx";
import { Presence } from "../ui/Presence.tsx";

const GREETING = t("You can ask about Harness and its improvements here. Games are built in their own chats.");
const QUESTIONS = [
  t("How does Harness build a game?"),
  t("How does Harness improve itself?"),
  t("What has it improved so far?"),
];

/**
 * The start of the Harness conversation: its first message, written like its replies, and while
 * nothing has been asked, three questions that send in one click; once asked, they close.
 */
export function StudioIntro({
  empty,
  disabled,
  onAsk,
}: {
  empty: boolean;
  disabled: boolean;
  onAsk: (question: string) => void;
}) {
  return (
    <section data-studio-intro aria-label={t("About this chat")} className="flex min-w-0 flex-col gap-3">
      <Markdown text={GREETING} />
      <Presence>{empty ? [{ key: "questions", node: <Questions disabled={disabled} onAsk={onAsk} /> }] : []}</Presence>
    </section>
  );
}

/** The three questions that send in one click. */
function Questions({ disabled, onAsk }: { disabled: boolean; onAsk: (question: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {QUESTIONS.map((question) => (
        <button
          key={question}
          type="button"
          disabled={disabled}
          onClick={() => onAsk(question)}
          className="rounded-[16px] bg-field px-3 py-1.5 text-start text-chat-sub text-ink-2 transition-colors duration-(--duration-quick) enabled:cursor-pointer enabled:hover:bg-control-hover enabled:hover:text-control-text-hover disabled:cursor-default disabled:opacity-45 motion-reduce:transition-none"
        >
          {question}
        </button>
      ))}
    </div>
  );
}
