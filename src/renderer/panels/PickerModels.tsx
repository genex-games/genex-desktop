/**
 * Settings → Model Providers: which of a provider's models the model picker lists. The newest
 * models are on by default (model-lineup.ts); older ones wait, switched off, under Older models.
 * The provider's default model is always listed.
 */
import { type JSX, useId, useState } from "react";
import { latestModels, modelName, runnableModels, shownModels } from "../model-lineup.ts";
import { matchingModels, offersSearch } from "./picker-search.ts";
import { useEngines, useModelPicker } from "../state/hooks.ts";
import { pickerModelSet, pickerModelsReset } from "../state/model-picker.ts";
import { studio } from "../state/studio.ts";
import type { EngineDescriptor } from "../types.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { Switch } from "../ui/switch.tsx";
import { PICKER_MODELS_WORDS } from "../words.ts";

/** The model id that means "whatever the CLI is set to"; it is no model of its own. */
const DEFAULT_MODEL = "default";
/** One empty object, so the selector returns the same reference while an engine has no choices. */
const NO_CHOICES: Readonly<Record<string, boolean>> = {};

interface PickerRow {
  id: string;
  name: string;
  /** Listed by the rule, before any Settings choice. */
  byDefault: boolean;
  shown: boolean;
  /** The provider's default model, which is always listed. */
  locked: boolean;
}

function pickerRows(
  engine: EngineDescriptor,
  choices: Readonly<Record<string, boolean>>,
  runnable: ReadonlySet<string>,
): PickerRow[] {
  const models = engine.models.filter((model) => model.id !== DEFAULT_MODEL);
  const latest = latestModels(engine.id, models, runnable);
  const shown = shownModels(engine.id, models, choices, runnable);
  return models.map((model) => ({
    id: model.id,
    name: modelName(engine.id, model),
    byDefault: latest.has(model.id) || model.providerDefault === true,
    shown: shown.has(model.id),
    locked: model.providerDefault === true,
  }));
}

function ModelSwitch({ row, onChange }: { row: PickerRow; onChange: (shown: boolean) => void }): JSX.Element {
  const id = useId();
  return (
    <div
      className="flex min-h-9 items-center gap-2 px-2.5"
      title={row.locked ? PICKER_MODELS_WORDS.alwaysShown : undefined}
    >
      <label htmlFor={id} className="min-w-0 truncate text-chat-sub text-ink">
        {row.name}
      </label>
      {row.locked && <span className="text-micro text-ink-3">{PICKER_MODELS_WORDS.defaultModel}</span>}
      <Switch
        id={id}
        data-picker-model={row.id}
        className="ml-auto"
        checked={row.shown}
        disabled={row.locked}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/** The search over a long Older models list; Escape clears a query before it can close Settings. */
function OlderSearch({
  name,
  query,
  onQuery,
}: {
  name: string;
  query: string;
  onQuery: (query: string) => void;
}): JSX.Element {
  return (
    <div className="px-2.5 pt-1 pb-1.5" data-keeps-escape={query ? "" : undefined}>
      <input
        type="search"
        aria-label={PICKER_MODELS_WORDS.searchLabel(name)}
        placeholder={PICKER_MODELS_WORDS.search}
        data-picker-search
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || !query) return;
          event.stopPropagation();
          onQuery("");
        }}
        className="h-8 w-full rounded-control border border-input bg-field px-2.5 text-chat-sub text-foreground outline-none placeholder:text-muted-foreground focus:border-accent-ink"
      />
    </div>
  );
}

export function PickerModels({ engine, name }: { engine: EngineDescriptor; name: string }): JSX.Element | null {
  const choices = useModelPicker((state) => state.choices[engine.id] ?? NO_CHOICES);
  const [olderOpen, setOlderOpen] = useState(false);
  const [query, setQuery] = useState("");
  const olderId = useId();
  const engines = useEngines((state) => state.list);
  const rows = pickerRows(engine, choices, runnableModels(engine.id, engines));
  if (rows.length === 0) return null;
  const store = studio().modelPicker;
  const change = (row: PickerRow) => (shown: boolean) =>
    store.setState(
      (state) => pickerModelSet(state, { engine: engine.id, model: row.id, shown, byDefault: row.byDefault }),
      true,
    );
  const latest = rows.filter((row) => row.byDefault);
  const older = rows.filter((row) => !row.byDefault);
  const changed = rows.some((row) => !row.locked && row.shown !== row.byDefault);
  const olderShown = older.filter((row) => row.shown).length;
  const searchable = offersSearch(older.length);
  const found = searchable ? matchingModels(older, query) : older;
  return (
    <div
      role="group"
      aria-label={PICKER_MODELS_WORDS.group(name)}
      data-picker-models={engine.id}
      // Inside its provider's card: a hairline under the account, not a second card.
      className="mt-1 -mx-2.5 flex flex-col border-t border-line pt-2"
    >
      <div className="flex min-h-8 items-center gap-2 px-2.5">
        <span className="text-body-sm font-medium text-ink">{PICKER_MODELS_WORDS.title}</span>
        {changed && (
          <Button
            className="ml-auto"
            onClick={() => store.setState((state) => pickerModelsReset(state, engine.id), true)}
          >
            {PICKER_MODELS_WORDS.reset}
          </Button>
        )}
      </div>
      {latest.map((row) => (
        <ModelSwitch key={row.id} row={row} onChange={change(row)} />
      ))}
      {older.length > 0 && (
        <>
          <div role="separator" className="mx-2.5 my-1.5 h-px bg-line" />
          <button
            type="button"
            aria-expanded={olderOpen}
            aria-controls={olderId}
            onClick={() => setOlderOpen(!olderOpen)}
            className="flex min-h-9 w-full cursor-pointer items-center gap-2 rounded-control px-2.5 text-left text-chat-sub text-ink hover:bg-control-hover"
          >
            {PICKER_MODELS_WORDS.older}
            <span className="text-micro text-ink-3">{PICKER_MODELS_WORDS.olderShown(olderShown, older.length)}</span>
            <Icon
              name="chevron-down"
              size={14}
              className={`ml-auto text-icon transition-transform motion-reduce:transition-none ${olderOpen ? "rotate-180" : ""}`}
            />
          </button>
          <div id={olderId} hidden={!olderOpen}>
            {searchable && <OlderSearch name={name} query={query} onQuery={setQuery} />}
            {found.map((row) => (
              <ModelSwitch key={row.id} row={row} onChange={change(row)} />
            ))}
            {found.length === 0 && (
              <p role="status" className="px-2.5 py-2 text-chat-sub text-ink-3">
                {PICKER_MODELS_WORDS.noMatch(query)}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}
