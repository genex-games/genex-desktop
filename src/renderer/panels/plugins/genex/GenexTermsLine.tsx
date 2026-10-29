/**
 * "Genex terms updated" with Review, while the signed-in account has Genex's updated terms to
 * accept: one line at the foot of the sidebar, dressed as the plugin updates line, and under a Genex
 * call in the chat that waits on them. Review opens genex.games' terms page in the browser; the
 * line goes once the account reads as accepted (the app reads it again when it comes back to front).
 */
import type { JSX } from "react";
import { useState } from "react";
import { usePeople, usePlugins } from "../../../state/hooks.ts";
import { Icon } from "../../../ui/icons.tsx";
import { GENEX_TERMS_WORDS as WORDS } from "../../../words.ts";
import { reviewGenexTerms } from "./genex-terms.ts";

/** The line, or nothing while no terms wait; `className` places it (the sidebar's foot, a chat entry). */
export function GenexTermsLine({ className }: { className?: string }): JSX.Element | null {
  const pending = usePeople((s) => s.genexTermsPending);
  const plugins = usePlugins((s) => s.list);
  const [opening, setOpening] = useState(false);
  if (!pending) return null;
  const review = (): void => {
    setOpening(true);
    // Opening the page is the whole press: a browser that does not open leaves the line to try again.
    void reviewGenexTerms(plugins)
      .catch(() => {})
      .finally(() => setOpening(false));
  };
  return (
    <div className={className ? `genex-terms-line ${className}` : "genex-terms-line"} data-genex-terms>
      <span className="genex-terms-line-label">
        <Icon name="file" size={16} />
        <span className="min-w-0 flex-1 truncate">{WORDS.line}</span>
      </span>
      <button
        type="button"
        className="plugin-updates-run"
        aria-label={WORDS.reviewLabel}
        disabled={opening}
        onClick={review}
        data-genex-terms-review
      >
        {WORDS.review}
      </button>
    </div>
  );
}
