/**
 * The Copy buttons of the Campaign links and SDK tabs: one with a word on it, for a link or a code
 * sample that sits in a block of its own, and one that is only an icon, for a row of a table. Each
 * keeps its own "Copied" for a moment (`useCopy`), so pressing one never changes another.
 */
import type { JSX } from "react";
import { t } from "../../../shared/i18n.ts";
import { useCopy } from "../../use-copy.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";

const COPY_WORDS = {
  copy: t("Copy"),
  copied: t("Copied"),
} as const;

/** Props of both buttons: what to copy, what the button is called to assistive technology, and its stable name. */
export interface CopyButtonProps {
  /** `data-game-analytics-copy-text`: which thing this copies ("link", "short", "sample", a saved link's id). */
  id: string;
  text: string;
  label: string;
}

/** A Copy button with its word: "Copy", then "Copied" for a moment. */
export function CopyButton({ id, text, label }: CopyButtonProps): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <Button
      variant="secondary"
      data-game-analytics-copy-text={id}
      aria-label={copied ? COPY_WORDS.copied : label}
      onClick={() => copy(text)}
    >
      {copied ? COPY_WORDS.copied : COPY_WORDS.copy}
    </Button>
  );
}

/** A Copy button that is only an icon, as the header's is: it turns into a check for a moment. */
export function CopyIconButton({ id, text, label }: CopyButtonProps): JSX.Element {
  const [copied, copy] = useCopy();
  return (
    <button
      type="button"
      className="game-analytics-copy"
      data-game-analytics-copy-text={id}
      aria-label={copied ? COPY_WORDS.copied : label}
      onClick={() => copy(text)}
    >
      <Icon name={copied ? "check" : "copy"} size={14} />
    </button>
  );
}
