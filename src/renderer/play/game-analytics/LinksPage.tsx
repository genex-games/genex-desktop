/**
 * Campaign links: the form that makes a link to post, how a visit is credited, and the links the
 * creator saved with what each brought. The shell mounts it only with the list to draw
 * (`report-props.ts` says what it is given); the page keeps what is typed and what a press on Save
 * or Remove is doing, `links-view.ts` works out what that means, and `links-form.tsx` and
 * `links-table.tsx` draw it.
 */
import type { JSX, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { CampaignField, type CampaignTags } from "../../../shared/game-analytics.ts";
import { ReportColumns, ReportSection } from "./kit/index.ts";
import { type LinkFormActions, NewLinkForm } from "./links-form.tsx";
import { type LinkTableActions, SavedLinks } from "./links-table.tsx";
import {
  creditRules,
  EMPTY_DRAFT,
  formView,
  type LinkDraft,
  type LinkField,
  phaseAfterRefusal,
  phaseAfterRemoval,
  phaseAfterTyping,
  type Removal,
  removalAsked,
  removalEnded,
  removalStarted,
  SavePhase,
  usedSources,
} from "./links-view.ts";
import { LINKS_WORDS as WORDS } from "./links-words.ts";
import { focusAfterRemoval } from "./page-view.ts";
import type { LinksPageProps } from "./report-props.ts";

/**
 * Where the focus goes once a removed link's row is gone with its buttons: the Remove of `next` (the
 * neighbour), else the form's first tag, so it never falls to the page.
 */
function useFocusAfterRemoval(): {
  root: RefObject<HTMLDivElement | null>;
  moveTo: (next: { id: string | null }) => void;
} {
  const root = useRef<HTMLDivElement>(null);
  const [target, moveTo] = useState<{ id: string | null } | null>(null);
  useEffect(() => {
    if (!target) return;
    const row = target.id === null ? null : `[data-game-analytics-link-remove="${CSS.escape(target.id)}"]`;
    const next = row ? root.current?.querySelector<HTMLElement>(row) : null;
    const field = root.current?.querySelector<HTMLElement>(
      `[data-game-analytics-link-field="${CampaignField.Source}"]`,
    );
    (next ?? field)?.focus();
  }, [target]);
  return { root, moveTo };
}

/** How a visit is credited: the five rules in the order they apply, and what is never counted. */
function CreditRules(): JSX.Element {
  return (
    <ReportSection id="credit" title={WORDS.credit} footnote={WORDS.neverCounted}>
      <ol className="game-analytics-links-rules" data-game-analytics-link-rules>
        {creditRules().map((rule) => (
          <li key={rule.id} data-game-analytics-link-rule={rule.id}>
            <span className="game-analytics-links-rule-text">
              <span className="game-analytics-links-rule-lead">{rule.lead}</span> {rule.detail}
            </span>
          </li>
        ))}
      </ol>
    </ReportSection>
  );
}

/** The Campaign links tab's body. */
export function LinksPage({ gameUrl, days, links, onSave, onRemove }: LinksPageProps): JSX.Element {
  const [draft, setDraft] = useState<LinkDraft>(EMPTY_DRAFT);
  const [phase, setPhase] = useState<SavePhase>(SavePhase.Idle);
  const [removal, setRemoval] = useState<Removal | null>(null);
  const focus = useFocusAfterRemoval();
  const view = formView(draft, links, gameUrl);

  const typeInto = (field: LinkField, value: string): void => {
    setDraft((current) => ({ ...current, [field]: value }));
    setPhase(phaseAfterTyping);
  };
  const save = (tags: CampaignTags): void => {
    setPhase(SavePhase.Saving);
    onSave(tags).then(
      () => setPhase(SavePhase.Idle),
      (error: unknown) => setPhase(phaseAfterRefusal(error)),
    );
  };
  const form: LinkFormActions = {
    onType: typeInto,
    onPickSource: (source) => typeInto(CampaignField.Source, source),
    onSave: save,
  };

  const table: LinkTableActions = {
    onAsk: (id) => setRemoval(removalAsked(id)),
    onKeep: () => setRemoval(null),
    onRemove: (id) => {
      setRemoval(removalStarted(id));
      const next = focusAfterRemoval(
        links.map((link) => link.id),
        id,
      );
      onRemove(id).then(
        () => {
          setRemoval((current) => removalEnded(current, id, false));
          setPhase(phaseAfterRemoval);
          focus.moveTo({ id: next });
        },
        () => setRemoval((current) => removalEnded(current, id, true)),
      );
    },
  };

  return (
    <div ref={focus.root} className="game-analytics-report" data-game-analytics-links>
      <ReportColumns>
        <NewLinkForm draft={draft} view={view} sources={usedSources(links)} phase={phase} actions={form} />
        <CreditRules />
      </ReportColumns>
      <SavedLinks links={links} days={days} removal={removal} actions={table} />
    </div>
  );
}
