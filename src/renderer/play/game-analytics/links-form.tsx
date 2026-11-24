/**
 * The form that makes a campaign link: the four tags, the sources already used as chips, the link
 * as it will be with Copy, and Save. It is told everything it draws (the typed words, what a press
 * on Save is doing); `LinksPage` keeps that state and `links-view.ts` works out what it means.
 */
import type { FormEvent, JSX } from "react";
import {
  CAMPAIGN_LINKS_MAX,
  CAMPAIGN_TAG_MAX,
  CampaignField,
  type CampaignLink,
  type CampaignTags,
} from "../../../shared/game-analytics.ts";
import { Button } from "../../ui/Button.tsx";
import { Input } from "../../ui/input.tsx";
import { ReportSection } from "./kit/index.ts";
import { CopyButton } from "./links-copy.tsx";
import { LINK_FIELDS, type LinkDraft, type LinkField, type LinkFormView, SavePhase, SaveStep } from "./links-view.ts";
import { LINKS_WORDS as WORDS } from "./links-words.ts";

/** The tags a link cannot do without: Content is the one a person may leave empty. */
const REQUIRED_FIELDS: ReadonlySet<LinkField> = new Set([
  CampaignField.Source,
  CampaignField.Medium,
  CampaignField.Campaign,
]);

/** What the form asks of the page that keeps its state. */
export interface LinkFormActions {
  onType(field: LinkField, value: string): void;
  /** Put a source the saved links already use in Source. */
  onPickSource(source: string): void;
  /** Save these tags; asked only for tags the form says can be saved. */
  onSave(tags: CampaignTags): void;
}

/** What the form draws. */
export interface LinkFormProps {
  draft: LinkDraft;
  /** The draft worked out: the link it makes, whether it can be saved, which words are too long. */
  view: LinkFormView;
  /** The sources saved links already use. */
  sources: readonly string[];
  phase: SavePhase;
  actions: LinkFormActions;
}

/** One tag: its name and what to write in it over the box, and a note under it when the words are too long. */
function Field({
  field,
  value,
  tooLong,
  onType,
}: {
  field: LinkField;
  value: string;
  tooLong: boolean;
  onType: LinkFormActions["onType"];
}): JSX.Element {
  const words = WORDS.fields[field];
  return (
    <label className="game-analytics-links-field">
      <span className="game-analytics-links-field-head">
        <span className="game-analytics-links-field-name">{words.label}</span>
        <span className="game-analytics-links-field-hint">{words.hint}</span>
      </span>
      <Input
        type="text"
        className="game-analytics-links-input"
        data-game-analytics-link-field={field}
        data-analytics-mask
        value={value}
        required={REQUIRED_FIELDS.has(field)}
        aria-invalid={tooLong || undefined}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        onChange={(event) => onType(field, event.target.value)}
      />
      {tooLong && <span className="game-analytics-links-field-note">{WORDS.tooLong(CAMPAIGN_TAG_MAX)}</span>}
    </label>
  );
}

/** The sources saved links already use: a press puts one in Source. */
function SourceChips({
  sources,
  onPick,
}: {
  sources: readonly string[];
  onPick: LinkFormActions["onPickSource"];
}): JSX.Element | null {
  if (sources.length === 0) return null;
  return (
    <div className="game-analytics-links-chips" role="group" aria-label={WORDS.usedSources}>
      <span className="game-analytics-links-chips-label">{WORDS.usedSources}</span>
      {sources.map((source) => (
        <button
          key={source}
          type="button"
          className="game-analytics-links-chip"
          data-game-analytics-link-source={source}
          onClick={() => onPick(source)}
        >
          <span data-analytics-mask>{source}</span>
        </button>
      ))}
    </div>
  );
}

/** One address with its Copy: the link as it will be, or the short link of the saved link that has these tags. */
function Address({
  id,
  label,
  url,
  copyLabel,
}: {
  id: string;
  label: string;
  url: string;
  copyLabel: string;
}): JSX.Element {
  return (
    <div className="game-analytics-links-address" data-game-analytics-link-address={id}>
      <div className="game-analytics-links-address-text">
        <span className="game-analytics-links-address-label">{label}</span>
        <span className="game-analytics-links-address-url" data-analytics-mask>
          {url}
        </span>
      </div>
      <CopyButton id={id} text={url} label={copyLabel} />
    </div>
  );
}

/** The link as it will be, and, once a saved link has these tags, its short link when it has one. */
function Preview({ url, saved }: { url: string; saved: CampaignLink | null }): JSX.Element {
  const shortUrl = saved?.shortUrl ?? null;
  return (
    <div className="game-analytics-links-preview">
      <Address id="link" label={WORDS.yourLink} url={url} copyLabel={WORDS.copyYourLink} />
      {shortUrl && <Address id="short" label={WORDS.shortLink} url={shortUrl} copyLabel={WORDS.copyShortLink} />}
    </div>
  );
}

/** What the Save button says in each step. */
function saveLabel(step: SaveStep, saving: boolean): string {
  if (saving) return WORDS.saving;
  return step === SaveStep.Saved ? WORDS.saved : WORDS.save;
}

/** What stands where Save does: the button, or, when the game keeps no more links, a sentence saying so. */
function SaveRow({ step, phase }: { step: SaveStep; phase: SavePhase }): JSX.Element {
  const saving = phase === SavePhase.Saving;
  return (
    <div className="game-analytics-links-save">
      {step === SaveStep.Full ? (
        <p className="game-analytics-links-full" data-game-analytics-link-full>
          {WORDS.full(CAMPAIGN_LINKS_MAX)}
        </p>
      ) : (
        <Button
          variant="default"
          type="submit"
          data-game-analytics-link-save={step}
          busy={saving}
          disabled={step === SaveStep.Incomplete || step === SaveStep.Saved}
        >
          {saveLabel(step, saving)}
        </Button>
      )}
      <p className="game-analytics-links-note">{WORDS.tagsNote}</p>
      {phase === SavePhase.Refused && (
        <p className="game-analytics-links-refused" role="alert" data-game-analytics-link-refused>
          {WORDS.refused}
        </p>
      )}
      {phase === SavePhase.Full && (
        <p className="game-analytics-links-refused" role="alert" data-game-analytics-link-refused={SavePhase.Full}>
          {WORDS.full(CAMPAIGN_LINKS_MAX)}
        </p>
      )}
    </div>
  );
}

/** New campaign link: the form, with Enter saving when the link can be saved. */
export function NewLinkForm({ draft, view, sources, phase, actions }: LinkFormProps): JSX.Element {
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (view.step === SaveStep.Ready && view.tags && phase !== SavePhase.Saving) actions.onSave(view.tags);
  };
  return (
    <ReportSection id="new-link" title={WORDS.newLink} hint={WORDS.newLinkHint}>
      <form className="game-analytics-links-form" data-game-analytics-link-form onSubmit={submit}>
        <div className="game-analytics-links-fields">
          {LINK_FIELDS.map((field) => (
            <Field
              key={field}
              field={field}
              value={draft[field]}
              tooLong={view.tooLong.includes(field)}
              onType={actions.onType}
            />
          ))}
        </div>
        <SourceChips sources={sources} onPick={actions.onPickSource} />
        <Preview url={view.url} saved={view.saved} />
        <SaveRow step={view.step} phase={phase} />
      </form>
    </ReportSection>
  );
}
