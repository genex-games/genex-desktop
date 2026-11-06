/**
 * Request human review (mockup D1): a person at Genex checks a turned-down app or a taken-down game,
 * usually within a day, with the creator's optional note. Send is the consent to ask, and to send the
 * app again when Genex keeps no copy of it. A refusal Genex names is said in its own words here. An
 * old API that still needs a takedown note of at least 20 characters gets that field and its floor.
 */
import type { JSX } from "react";
import { useId, useState } from "react";
import { errorMessage } from "../../../../shared/errors.ts";
import { REVIEW_NOTE_CHARS, REVIEW_NOTE_COUNTER_AT, GenexReviewRefusal } from "../../../../shared/genex-review.ts";
import { Button } from "../../../ui/Button.tsx";
import { DialogSurface } from "../../../ui/dialog.tsx";
import { REVIEW_WORDS } from "../../../words.ts";

const WORDS = REVIEW_WORDS.request;

/** A refusal's words, by its code; Studio's note floor names its length. */
function refusalWords(code: GenexReviewRefusal, min: number): string {
  if (code === GenexReviewRefusal.NoteTooShort) return WORDS.refused.note_too_short(min);
  return WORDS.refused[code];
}

/** What the request is about: an app (named or every one that allows it) or the takedown. */
export interface ReviewRequestTarget {
  takedown: boolean;
  platform?: string;
  arch?: string;
  /** An old API's floor for a takedown's note. */
  noteMin?: number;
}

export function RequestReviewDialog({
  project,
  target,
  onClose,
}: {
  project: string;
  target: ReviewRequestTarget;
  onClose: (sent: boolean) => void;
}): JSX.Element {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useId();
  const min = target.noteMin ?? 0;
  const short = note.trim().length < min;
  const send = async () => {
    setBusy(true);
    setProblem(null);
    try {
      const answer = await window.studio.genexRequestReview(project, {
        ...(target.platform ? { platform: target.platform } : {}),
        ...(target.arch ? { arch: target.arch } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      if (answer.refused) setProblem(refusalWords(answer.refused, min));
      else onClose(true);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogSurface title={WORDS.title} onDismiss={() => onClose(false)} size="sm" testId="genex-review-request">
      <div className="genex-review-request">
        <p className="genex-review-request-body">{target.takedown ? WORDS.bodyTakedown : WORDS.bodyApp}</p>
        <label htmlFor={field} className="genex-review-request-label">
          {min > 0 ? WORDS.labelOld(min) : WORDS.label}
        </label>
        <textarea
          id={field}
          className="genex-review-request-note"
          data-analytics-mask
          rows={3}
          maxLength={REVIEW_NOTE_CHARS}
          placeholder={WORDS.placeholder}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        {note.length > REVIEW_NOTE_COUNTER_AT && (
          <p className="genex-review-request-counter" aria-live="polite">
            {WORDS.counter(note.length, REVIEW_NOTE_CHARS)}
          </p>
        )}
        {problem && (
          <p role="alert" className="genex-review-request-problem">
            {problem}
          </p>
        )}
        <div className="genex-review-request-presses">
          <Button variant="secondary" onClick={() => onClose(false)} data-genex-review-request-cancel>
            {WORDS.cancel}
          </Button>
          <Button
            variant="default"
            busy={busy}
            disabled={busy || short}
            onClick={() => void send()}
            data-genex-review-request-send
          >
            {WORDS.send}
          </Button>
        </div>
      </div>
    </DialogSurface>
  );
}

/** The words of an error a press of the card met, for its line. */
export const pressProblem = (error: unknown): string => errorMessage(error);
