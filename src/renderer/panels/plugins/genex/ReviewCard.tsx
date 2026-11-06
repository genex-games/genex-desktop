/**
 * The review card, the same in the Publish dialog and in the chat (mockups B1, C2, C3, D2): what Genex
 * said of the game's apps or its takedown, its things to fix (three, then Show more), and the presses
 * its state offers. Fix with agent sends the game's chat the brief and Studio's step after it; Request
 * human review opens its dialog; a sent fix offers the link that takes the automatic step back. The
 * view is `review-card-view.ts`'s: this only draws it.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_PLUGIN_ID } from "../../../../shared/genex.ts";
import { REVIEW_THINGS_SHOWN, type GenexReviewRecord, type GenexReviewThing } from "../../../../shared/genex-review.ts";
import { signInToGenex } from "../../../play/use-genex-sign-in.ts";
import { openPluginSetup } from "../../../plugin-setup.ts";
import { Button } from "../../../ui/Button.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { REVIEW_WORDS } from "../../../words.ts";
import { pressProblem, RequestReviewDialog, type ReviewRequestTarget } from "./RequestReviewDialog.tsx";
import { elapsedWords, ReviewPlace, ReviewPress, type ReviewCardView } from "./review-card-view.ts";
import { useElapsed } from "./use-publish-cover.ts";

const WORDS = REVIEW_WORDS;

/** The things to fix: three, then Show {n} more (Show less once open). */
function Things({ things }: { things: readonly GenexReviewThing[] }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  if (things.length === 0) return null;
  const shown = open ? things : things.slice(0, REVIEW_THINGS_SHOWN);
  const more = things.length - REVIEW_THINGS_SHOWN;
  return (
    <>
      <ul className="genex-review-things" data-analytics-mask>
        {shown.map((thing) => (
          <li key={thing.text}>{thing.text}</li>
        ))}
      </ul>
      {more > 0 && (
        <button type="button" className="genex-review-more" data-genex-review-more onClick={() => setOpen(!open)}>
          {open ? WORDS.press.showLess : WORDS.press.showMore(more)}
        </button>
      )}
    </>
  );
}

/** A checked card's clock: the time Genex has taken so far. */
function Clock({ since }: { since: string }): JSX.Element {
  useElapsed(since);
  return <span className="genex-review-clock">{elapsedWords(since, Date.now())}</span>;
}

/** What Request human review asks about, from the record the card was drawn from. */
function requestTarget(record: GenexReviewRecord | null): ReviewRequestTarget {
  if (record?.takedown)
    return { takedown: true, ...(record.takedown.noteMin ? { noteMin: record.takedown.noteMin } : {}) };
  return { takedown: false };
}

export function ReviewCard({
  project,
  view,
  record,
  place,
  fixId,
  onPublish,
}: {
  project: string;
  view: ReviewCardView;
  /** The record the view was drawn from: what Request human review asks about. */
  record: GenexReviewRecord | null;
  place: ReviewPlace;
  /** The newest fix press, for its Don't publish it automatically. */
  fixId?: string | undefined;
  /** The dialog's own Publish, in place of opening it. */
  onPublish?: () => void;
}): JSX.Element {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<ReviewPress | "link" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = (which: ReviewPress | "link", step: () => Promise<unknown>) => {
    setBusy(which);
    setProblem(null);
    void step()
      .catch((error: unknown) => setProblem(pressProblem(error)))
      .finally(() => setBusy(null));
  };
  const onPress = (which: ReviewPress) => {
    if (which === ReviewPress.Request) return setAsking(true);
    if (which === ReviewPress.SignIn) return run(which, signInToGenex);
    if (which === ReviewPress.Publish) return onPublish ? onPublish() : openPluginSetup(GENEX_PLUGIN_ID);
    // Build again asks the agent to build the fixed app, and Studio publishes it once that is done.
    const rebuild = which === ReviewPress.BuildAgain ? { rebuild: true } : {};
    run(which, () => window.studio.genexFixReview(project, { autoPublish: true, ...rebuild }));
  };
  const presses = place === ReviewPlace.Dialog ? [...view.presses].reverse() : view.presses;
  return (
    <section
      className="genex-review-card"
      data-genex-review={view.kind}
      data-tone={view.tone}
      data-place={place}
      data-one-line={view.oneLine || undefined}
      aria-label={WORDS.label}
    >
      {view.title && (
        <p className="genex-review-title">
          {view.tone === "done" && <Icon name="check" size={14} />}
          <span>{view.title}</span>
          {view.since && <Clock since={view.since} />}
        </p>
      )}
      {view.lines.map((line) => (
        <p key={line} className="genex-review-line">
          {view.oneLine && <span className="genex-review-dot" aria-hidden />}
          {line}
        </p>
      ))}
      {view.quote && (
        <blockquote className="genex-review-quote" data-analytics-mask>
          “{view.quote}”
        </blockquote>
      )}
      <Things things={view.things} />
      {view.after.map((line) => (
        <p key={line} className="genex-review-after">
          {line}
        </p>
      ))}
      {view.link && (
        <button
          type="button"
          className="genex-review-link"
          data-genex-review-link={view.link.link}
          disabled={busy !== null || !fixId}
          onClick={() =>
            run("link", () =>
              window.studio.genexFixReview(project, { autoPublish: false, ...(fixId ? { fixId } : {}) }),
            )
          }
        >
          {view.link.label}
        </button>
      )}
      {presses.length > 0 && (
        <div className="genex-review-presses">
          {presses.map((one) => (
            <Button
              key={one.press}
              variant={one.primary ? "default" : "secondary"}
              size="sm"
              data-genex-review-press={one.press}
              busy={busy === one.press}
              disabled={busy !== null}
              onClick={() => onPress(one.press)}
            >
              {one.label}
            </Button>
          ))}
        </div>
      )}
      {problem && (
        <p role="alert" className="genex-review-problem">
          {problem}
        </p>
      )}
      {view.footer && <p className="genex-review-footer">{view.footer}</p>}
      {asking && (
        <RequestReviewDialog project={project} target={requestTarget(record)} onClose={() => setAsking(false)} />
      )}
    </section>
  );
}
