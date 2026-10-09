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
import { useMemo, useRef, useState } from "react";
import { DialogSurface } from "../ui/dialog.tsx";
import type { FolderInspection } from "../types.ts";
import {
  ENGINE_EXPORT_REFUSAL,
  openOptions,
  type OpenChoice,
  type OpenOption,
  suggestedOption,
} from "../../shared/shape-words.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Switch } from "../ui/switch.tsx";
import { plural } from "../../shared/skill-words.ts";

/** The sheet's words. */
const MESSAGE = {
  title: "Open a game folder",
  which: "Which game should Genex open?",
  details: "Details",
  problems: "Before a build can be reviewed",
  addsNothing: "Nothing is added to this folder.",
  adds: (files: number) => `Genex adds ${plural(files, "file")}. Everything else stays as it is.`,
  trustLabel: "Trust this folder's Claude settings and hooks",
  trustDetail: "Hooks can run commands with your access.",
  cancel: "Cancel",
  opening: "Opening…",
  open: "Open",
} as const;

/** The files whose name does not say what they are for — the rest are the game's own. */
const WHAT_FOR: Record<string, string> = {
  ".git": "version history, so any change can be undone",
  ".gitignore":
    "a few lines, keeping Genex's scratch, installed packages, build output and secrets out of your commits",
  "studio.json": "how Genex runs this game",
  "src/studio.js": "the contract reviewers read",
};

/** A phrase as a line of its own: "a 3D game" → "A 3D game". */
const sentence = (phrase: string): string => phrase.charAt(0).toLocaleUpperCase() + phrase.slice(1);

export function OpenGameSheet({
  inspection,
  busy,
  onOpen,
  onDismiss,
}: {
  inspection: FolderInspection;
  busy: boolean;
  onOpen: (choice: OpenChoice) => void;
  onDismiss: () => void;
}): JSX.Element {
  const options = useMemo(() => openOptions(inspection), [inspection]);
  const [selected, setSelected] = useState(() => suggestedOption(options, inspection.suggested));
  const [trustProjectSettings, setTrustProjectSettings] = useState(true);
  // There is always at least one row: a folder with no game of its own can still be started in.
  const chosen = options[Math.min(selected, options.length - 1)] ?? null;
  const primary = useRef<HTMLButtonElement>(null);
  return (
    <DialogSurface
      title={MESSAGE.title}
      description={inspection.pathLabel}
      size="lg"
      testId="open-game-sheet"
      initialFocus={primary}
      onDismiss={onDismiss}
    >
      {options.length > 1 ? (
        <GameChoices options={options} selected={selected} onSelect={setSelected} />
      ) : (
        chosen && <FolderSummary option={chosen} />
      )}
      {chosen ? <ChosenDetails chosen={chosen} /> : null}
      <label className="flex items-start justify-between gap-4">
        <span className="min-w-0">
          <span className="block text-body-sm text-ink">{MESSAGE.trustLabel}</span>
          <span className="block text-xs text-ink-3">{MESSAGE.trustDetail}</span>
        </span>
        <Switch
          aria-label={MESSAGE.trustLabel}
          checked={trustProjectSettings}
          onCheckedChange={setTrustProjectSettings}
          className="my-0.5"
        />
      </label>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDismiss}>
          {MESSAGE.cancel}
        </Button>
        <Button
          variant="default"
          ref={primary}
          type="button"
          data-open-game-confirm
          disabled={busy || !chosen}
          onClick={() => chosen && onOpen({ ...chosen.choice, trustProjectSettings })}
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
    <div data-candidate={option.id} className="flex items-center gap-3 rounded-card bg-inset px-3.5 py-3">
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
    <fieldset className="flex min-w-0 flex-col gap-1">
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
function ChosenDetails({ chosen }: { chosen: OpenOption }): JSX.Element {
  return (
    <>
      {chosen.engineExport ? (
        <div
          data-testid="engine-export-card"
          className="rounded-control bg-inset px-3 py-2 text-xs leading-relaxed text-ink-2"
        >
          {ENGINE_EXPORT_REFUSAL}
        </div>
      ) : null}
      <details
        key={chosen.id}
        open={chosen.choice.versionNested === true}
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
