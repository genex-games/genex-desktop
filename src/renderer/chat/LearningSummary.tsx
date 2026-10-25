import { Fragment } from "react";
import { t } from "../../shared/i18n.ts";
import { ChatDisclosure } from "./ChatDisclosure.tsx";
import { learningParts } from "./learning-parts.ts";
import { Icon } from "../ui/icons.tsx";
import { FileText } from "../ui/FileText.tsx";

export function LearningSummary({ text, onOpenStudio }: { text: string; onOpenStudio?: () => void }) {
  const parts = learningParts(text);
  if (!parts.length) return null;
  return (
    <ChatDisclosure label={t("What was learned")}>
      <p className="px-3 py-2 text-step text-ink-3 whitespace-pre-wrap">
        {parts.map((part, index) => (
          <Fragment key={index}>
            {index > 0 ? " · " : ""}
            {part.link && onOpenStudio ? (
              <button
                type="button"
                onClick={onOpenStudio}
                title={t("Open Studio Activity")}
                className="rounded-sm underline underline-offset-4 hover:text-control-text-hover"
              >
                {part.text}
              </button>
            ) : (
              <FileText text={part.text} />
            )}
          </Fragment>
        ))}
      </p>
    </ChatDisclosure>
  );
}

/** What Studio learned from a build, in one plain line, with its way into Activity on its own line. */
export function StudioLearningLine({
  text,
  link,
  onOpenStudio,
}: {
  text: string;
  link: string;
  onOpenStudio?: () => void;
}) {
  return (
    <div data-learning-line className="flex min-w-0 items-start gap-2.5 text-chat text-ink-3">
      <Icon name="harness" size={16} className="mt-[3px]" />
      <div className="flex min-w-0 flex-col items-start gap-0.5">
        <p>
          <FileText text={text} />
        </p>
        {onOpenStudio && (
          <button
            type="button"
            onClick={onOpenStudio}
            className="cursor-pointer rounded-sm text-accent-ink underline underline-offset-4 hover:text-control-text-hover"
          >
            {link}
          </button>
        )}
      </div>
    </div>
  );
}
