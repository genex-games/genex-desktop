/**
 * Allow remixing in the Publish dialog: a checkbox under the press says whether the game's project
 * goes with this publish so others can remix it, and Rights turns the dialog to a page on what
 * remixers can do. Unticked, or when the project could not go, remixing is off on Genex; a publish
 * whose project could not go says why under the checkbox. Shown only while Studio's Genex can send
 * a game's project.
 */
import type { JSX } from "react";
import { GenexRemixProblem, type GenexRemixRecord } from "../../../../shared/genex.ts";
import { Button } from "../../../ui/Button.tsx";
import { Icon } from "../../../ui/icons.tsx";
import { PUBLISH_REMIX_WORDS as WORDS } from "../../../words.ts";

/** Genex's terms, whose section 4 is the remix license. */
const TERMS_URL = "https://genex.games/terms";

/** Whether this publish allows remixing: the person's tick when they made one, else their last choice, else yes. */
export const remixAllowedNow = (record: GenexRemixRecord | undefined, ticked: boolean | null): boolean =>
  ticked ?? record?.allowed ?? true;

/** Why the last publish's project didn't go, while remixing was wanted; null when it went or wasn't. */
function problemLine(record: GenexRemixRecord): string | null {
  if (!record.allowed || !record.problem) return null;
  return record.problem === GenexRemixProblem.TooBig ? WORDS.tooBig : WORDS.notSent;
}

/** The checkbox and Rights under the press, and why the last project didn't go; nothing while it can't be sent. */
export function RemixChoice({
  record,
  allowed,
  onAllowed,
  onRights,
}: {
  record: GenexRemixRecord | undefined;
  allowed: boolean;
  onAllowed: (allowed: boolean) => void;
  onRights: () => void;
}): JSX.Element | null {
  if (!record?.supported) return null;
  const problem = problemLine(record);
  return (
    <div className="genex-remix-choice" data-genex-remix={allowed ? "allowed" : "off"}>
      <p className="genex-remix-line">
        <label>
          <input
            type="checkbox"
            checked={allowed}
            onChange={(event) => onAllowed(event.currentTarget.checked)}
            data-genex-remix-allow
          />
          {WORDS.allow}
        </label>
        <span aria-hidden="true">·</span>
        <button
          type="button"
          className="genex-publish-text-button"
          aria-label={WORDS.rightsLabel}
          onClick={onRights}
          data-genex-remix-rights
        >
          {WORDS.rights}
        </button>
      </p>
      {problem && <p className="genex-remix-problem">{problem}</p>}
    </div>
  );
}

/** The dialog turned to what remixers can do, with the way back to Publish. */
export function RemixRights({ title, onBack }: { title: string; onBack: () => void }): JSX.Element {
  return (
    <div className="genex-remix-rights" data-genex-remix-page>
      <div className="genex-remix-rights-head">
        <button type="button" className="genex-remix-back" aria-label={WORDS.back} onClick={onBack}>
          <Icon name="chevron-left" size={14} />
        </button>
        <h2>{WORDS.title}</h2>
      </div>
      <section>
        <h3>{WORDS.canHeading}</h3>
        {WORDS.can(title).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </section>
      <section>
        <h3>{WORDS.goodToKnowHeading}</h3>
        {WORDS.goodToKnow.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </section>
      <button
        type="button"
        className="genex-publish-text-button genex-remix-terms"
        onClick={() => void window.studio.openUrl(TERMS_URL)}
      >
        {WORDS.terms}
        <Icon name="arrow-up-right" size={12} />
      </button>
      <Button variant="default" size="default" className="genex-publish-primary" onClick={onBack}>
        {WORDS.gotIt}
      </Button>
    </div>
  );
}
