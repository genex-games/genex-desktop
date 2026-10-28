/**
 * The Open Game sheet — see the folder before anything is written.
 *
 * Picking a folder used to *be* opening it: the studio scaffolded its template into whatever the
 * dialog returned, which is how somebody's 85k-line game in `wreckage/` was wrapped in an empty
 * project and hand-ported for the whole run. Now the picker only answers
 * *which folder*; this sheet says what is in it, what would run it, what would stop a run on
 * it, and exactly which files would appear — and nothing is written until its button is pressed.
 *
 * The rows themselves are data (`shared/shape-words.ts` `openOptions`), so what a folder offers
 * is tested without a window; this file is the window.
 */
import type { JSX } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { type SheetFacts, sheetViewedProperties } from "../analytics/workspace-properties.ts";
import { DismissVia } from "../analytics/workspace-vocabulary.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import type { FolderInspection } from "../types.ts";
import {
  engineExportRefusal,
  openOptions,
  type OpenChoice,
  type OpenOption,
  suggestedOption,
} from "../../shared/shape-words.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Switch } from "../ui/switch.tsx";
import { t } from "../../shared/i18n.ts";

/** The sheet's words. */
const MESSAGE = {
  title: t("Open a game folder"),
  which: t("Which game should Genex open?"),
  details: t("Details"),
  problems: t("Before a build can be reviewed"),
  addsNothing: t("Nothing is added to this folder."),
  adds: (count: number) =>
    t("{count, plural, one {Genex adds # file.} other {Genex adds # files.}} Everything else stays as it is.", {
      count,
    }),
  trustLabel: t("Trust this folder's Claude settings and hooks"),
  trustDetail: t("Hooks can run commands with your access."),
  cancel: t("Cancel"),
  opening: t("Opening…"),
  open: t("Open"),
};

/** The files whose name does not say what they are for — the rest are the game's own. */
const WHAT_FOR: Record<string, string> = {
  ".git": t("version history, so any change can be undone"),
  ".gitignore": t(
    "a few lines, keeping Genex's scratch, installed packages, build output and secrets out of your commits",
  ),
  "studio.json": t("how Genex runs this game"),
  "src/studio.js": t("the contract reviewers read"),
};

/** A phrase as a line of its own: "a 3D game" → "A 3D game". */
const sentence = (phrase: string): string => phrase.charAt(0).toLocaleUpperCase() + phrase.slice(1);

/**
 * What the person does on the sheet, for usage analytics: counted when it comes up, kept until it
 * ends. `facts()` is the record so far, with the kind of the row chosen (null for a folder started in).
 */
function useSheetFacts(inspection: FolderInspection, chosen: OpenOption | null) {
  const kept = useRef({ shownAt: Date.now(), changedOption: false, detailsOpened: false, trustToggled: false });
  // Once for each folder shown: StrictMode's development replay runs the effect again for the same one.
  const viewed = useRef<FolderInspection | null>(null);
  useEffect(() => {
    if (viewed.current === inspection) return;
    viewed.current = inspection;
    track(AnalyticsEvent.OpenFolderSheetViewed, sheetViewedProperties(inspection));
  }, [inspection]);
  const facts = (): SheetFacts => {
    const candidate = inspection.candidates.find((found) => found.rel === chosen?.id);
    return { ...kept.current, kind: candidate?.shape.kind ?? null };
  };
  return { kept: kept.current, facts };
}

export function OpenGameSheet({
  inspection,
  busy,
  onOpen,
  onDismiss,
}: {
  inspection: FolderInspection;
  busy: boolean;
  /** Open it this way; `facts` is what the person did on the sheet first (usage analytics). */
  onOpen: (choice: OpenChoice, facts: SheetFacts) => void;
  /** Put the sheet away, by its Cancel or its close. */
  onDismiss: (via: DismissVia, facts: SheetFacts) => void;
}): JSX.Element {
  const options = useMemo(() => openOptions(inspection), [inspection]);
  const [selected, setSelected] = useState(() => suggestedOption(options, inspection.suggested));
  const [trustProjectSettings, setTrustProjectSettings] = useState(true);
  // There is always at least one row: a folder with no game of its own can still be started in.
  const chosen = options[Math.min(selected, options.length - 1)] ?? null;
  const primary = useRef<HTMLButtonElement>(null);
  const { kept, facts } = useSheetFacts(inspection, chosen);
  return (
    <DialogSurface
      title={MESSAGE.title}
      description={inspection.pathLabel}
      size="lg"
      testId="open-game-sheet"
      initialFocus={primary}
      onDismiss={() => onDismiss(DismissVia.Close, facts())}
    >
      {options.length > 1 ? (
        <GameChoices
          options={options}
          selected={selected}
          onSelect={(index) => {
            kept.changedOption = true;
            setSelected(index);
          }}
        />
      ) : (
        chosen && <FolderSummary option={chosen} />
      )}
      {chosen ? (
        <ChosenDetails
          chosen={chosen}
          onOpened={() => {
            kept.detailsOpened = true;
          }}
        />
      ) : null}
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-body-sm text-ink">{MESSAGE.trustLabel}</span>
          <span className="block text-xs text-ink-3">{MESSAGE.trustDetail}</span>
        </span>
        <Switch
          aria-label={MESSAGE.trustLabel}
          checked={trustProjectSettings}
          onCheckedChange={(trusted) => {
            kept.trustToggled = true;
            setTrustProjectSettings(trusted);
          }}
          className="my-0.5"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDismiss(DismissVia.Cancel, facts())}>
          {MESSAGE.cancel}
        </Button>
        <Button
          variant="default"
          ref={primary}
          type="button"
          data-open-game-confirm
          // Its words can name the game.
          data-analytics-mask
          disabled={busy || !chosen}
          onClick={() => chosen && onOpen({ ...chosen.choice, trustProjectSettings }, facts())}
        >
          {busy ? MESSAGE.opening : (chosen?.button ?? MESSAGE.open)}
        </Button>
      </div>
    </DialogSurface>
  );
}

/** A folder with one way to open it: what it holds, with nothing to choose. */
function FolderSummary({ option }: { option: OpenOption }): JSX.Element {
  const nested = option.id !== ".";
  return (
    <div
      data-candidate={option.id}
      data-analytics-mask
      className="flex items-center gap-3 rounded-card bg-inset px-3.5 py-3"
    >
      <Icon name="folder" size={18} className="shrink-0 text-ink-3" />
      <span className="min-w-0">
        <span className="block text-body-sm font-medium text-ink">
          {nested ? `${option.label} · ${option.headline}` : sentence(option.headline)}
        </span>
      </span>
    </div>
  );
}

/** A folder holding more than one game: one radio row each, the suggested one first. */
function GameChoices({
  options,
  selected,
  onSelect,
}: {
  options: OpenOption[];
  selected: number;
  onSelect: (index: number) => void;
}): JSX.Element {
  return (
    // The folder's own games, by the names found in it.
    <fieldset className="flex min-w-0 flex-col gap-1" data-analytics-mask>
      <legend className="mb-2 text-dialog-body text-ink-2">{MESSAGE.which}</legend>
      {options.map((option, index) => (
        <label
          key={`${option.id}-${index}`}
          data-candidate={option.id}
          className={`-mx-3 flex cursor-pointer items-start gap-3 rounded-control px-3 py-2 transition-colors duration-100 ${
            index === selected ? "bg-inset" : "hover:bg-control-hover"
          }`}
        >
          <input
            type="radio"
            name="open-game-candidate"
            checked={index === selected}
            onChange={() => onSelect(index)}
            className="chat-choice-mark mt-px"
          />
          <span className="min-w-0">
            <span className="block text-body-sm font-medium text-ink">
              {option.label} <span className="font-normal text-ink-2">· {option.headline}</span>
            </span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * What opening the chosen game means. Only what changes the decision shows: a compiled export that
 * builders cannot edit. How it runs, its packages and history, what a build still needs and every
 * file Genex adds wait under Details — open from the start when a nested repository makes opening
 * it a consent.
 */
function ChosenDetails({ chosen, onOpened }: { chosen: OpenOption; onOpened: () => void }): JSX.Element {
  return (
    <>
      {chosen.engineExport ? (
        <div
          data-testid="engine-export-card"
          className="rounded-control bg-inset px-3 py-2 text-xs leading-relaxed text-ink-2"
        >
          {engineExportRefusal()}
        </div>
      ) : null}
      <details
        key={chosen.id}
        open={chosen.choice.versionNested === true}
        onToggle={(event) => {
          if (event.currentTarget.open) onOpened();
        }}
        className="group/details text-xs leading-relaxed text-ink-3"
      >
        <summary className="flex w-fit cursor-pointer select-none list-none items-center gap-1 text-body-sm text-ink-2 hover:text-control-text-hover [&::-webkit-details-marker]:hidden">
          {MESSAGE.details}
          <Icon name="chevron-right" size={14} className="shrink-0 text-ink-3 group-open/details:rotate-90" />
        </summary>
        <div className="mt-2 flex flex-col gap-1">
          <p>{sentence(chosen.detail)}.</p>
          {chosen.facts.map((fact) => (
            <p key={fact}>{fact}</p>
          ))}
          <PlannedWrites writes={chosen.writes} />
          {chosen.problems.length > 0 ? (
            <div className="mt-1 flex flex-col gap-0.5">
              <span className="font-medium text-ink-2">{MESSAGE.problems}</span>
              {chosen.problems.map((problem) => (
                <span key={problem}>{problem}</span>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </>
  );
}

/** The files Genex would add, each with what it is for; a plain line when it adds none. */
function PlannedWrites({ writes }: { writes: string[] }): JSX.Element {
  if (writes.length === 0) return <p data-testid="planned-writes">{MESSAGE.addsNothing}</p>;
  return (
    <div data-testid="planned-writes">
      <p>{MESSAGE.adds(writes.length)}</p>
      <ul className="m-0 mt-0.5 flex list-none flex-col gap-0.5 p-0 font-mono text-micro leading-relaxed text-ink-2">
        {writes.map((file) => (
          <li key={file}>
            {file}
            {WHAT_FOR[file] ? <span className="font-sans text-ink-3"> — {WHAT_FOR[file]}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
