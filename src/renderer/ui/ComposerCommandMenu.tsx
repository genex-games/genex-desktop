import {
  type JSX,
  type Ref,
  type RefObject,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useState,
} from "react";
import { ComposerCommand, commandMatches, commandQuery } from "../chat/composer-commands.ts";
import { COMPACT_WORDS, MENTION_WORDS } from "../words.ts";
import { Icon } from "./icons.tsx";
import { type AddMenuHandle, mentionKeyDown } from "./ComposerAddMenu.tsx";
import { Popover, PopoverContent } from "./popover.tsx";
import { PickerLabel, pickerItem } from "./PickerPanel.tsx";

/** One / command as the list offers it: what it does, and whether it can run now. */
export interface CommandOption {
  name: ComposerCommand;
  description: string;
  disabled: boolean;
  run: () => void;
}

/**
 * The / commands while one is typed: what was typed after the slash (null when the message is no
 * command), the list's id and highlighted option for the text box, and running a pick, which
 * clears the message instead of sending it.
 */
export function useComposerCommands(draft: string, setDraft: (text: string) => void) {
  const [query, setQuery] = useState<string | null>(null);
  const [activeOption, setActiveOption] = useState<string | null>(null);
  const listId = useId();
  const track = (text: string, caret: number | null): void => setQuery(commandQuery(text, caret));
  // A draft replaced from outside (another chat, a prefill, a send) is read again as typed.
  useLayoutEffect(() => {
    if (query !== null) setQuery(commandQuery(draft, draft.length));
  }, [draft]);
  const runner = (run: () => void) => () => {
    setDraft("");
    setQuery(null);
    run();
  };
  return { query, setQuery, track, listId, activeOption, setActiveOption, runner };
}

/** The /compact option, when the chat's model can be compacted. */
export function compactCommand(
  compact: { shown: boolean; disabled: boolean },
  onCompact: (() => void) | undefined,
): CommandOption[] {
  if (!compact.shown || !onCompact) return [];
  return [
    {
      name: ComposerCommand.Compact,
      description: compact.disabled ? COMPACT_WORDS.waits : COMPACT_WORDS.caption,
      disabled: compact.disabled,
      run: onCompact,
    },
  ];
}

/** A plugin the / list offers: picking it tags it in the message, as @ does. */
export interface PluginCommand {
  id: string;
  name: string;
  pick: () => void;
}

/** The plugins whose names hold what was typed after the slash. */
function pluginMatches(query: string, plugins: readonly PluginCommand[]): PluginCommand[] {
  return plugins.filter((plugin) => plugin.name.toLowerCase().includes(query));
}

/**
 * The / list above the composer, opened by typing "/" as a message: the commands whose names
 * start with what follows it, then the plugins whose names hold it. Focus stays in the text box,
 * which hands it the keys: the arrows move, Enter or Tab runs, Escape closes. A command that
 * cannot run now is listed but not taken.
 */
export function ComposerCommandMenu({
  query,
  options,
  plugins = [],
  anchor,
  listId,
  onClose,
  onActiveOption,
  ref,
}: {
  query: string | null;
  options: CommandOption[];
  /** The plugins that are on, which the list offers after its commands. */
  plugins?: readonly PluginCommand[];
  anchor: RefObject<HTMLDivElement | null>;
  listId: string;
  onClose: () => void;
  onActiveOption: (id: string | null) => void;
  ref?: Ref<AddMenuHandle>;
}): JSX.Element {
  const [highlight, setHighlight] = useState(0);
  useEffect(() => setHighlight(0), [query]);
  const names =
    query === null
      ? []
      : commandMatches(
          query,
          options.map((option) => option.name),
        );
  const matches = options.filter((option) => names.includes(option.name));
  const pluginRows = query === null ? [] : pluginMatches(query, plugins);
  const picks = [
    ...matches.map((option) => ({
      id: option.name,
      name: option.name,
      pick: option.disabled ? () => {} : option.run,
    })),
    ...pluginRows,
  ];
  const open = picks.length > 0;
  const active = Math.min(highlight, Math.max(0, picks.length - 1));
  useImperativeHandle(
    ref,
    () => ({
      keyDown: (event) => mentionKeyDown(event, { mentioning: open, matches: picks, active, setHighlight, onClose }),
    }),
    [open, picks, active],
  );
  const optionId = (index: number) => `${listId}-${index}`;
  const activeOption = open ? optionId(active) : null;
  useEffect(() => onActiveOption(activeOption), [activeOption]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="top"
        align="start"
        sideOffset={8}
        initialFocus={false}
        finalFocus={false}
        className="picker-panel composer-add-panel w-(--anchor-width) p-1.5"
        aria-label={COMPACT_WORDS.commands}
      >
        <div role="listbox" id={listId} aria-label={COMPACT_WORDS.commands} data-command-list>
          {pluginRows.length > 0 && matches.length > 0 ? (
            <PickerLabel first>{COMPACT_WORDS.commands}</PickerLabel>
          ) : null}
          {matches.map((option, index) => (
            <div
              key={option.name}
              id={optionId(index)}
              role="option"
              aria-selected={index === active}
              aria-disabled={option.disabled || undefined}
              data-command={option.name}
              data-highlighted={index === active || undefined}
              className={`${pickerItem} ${option.disabled ? "" : "cursor-pointer hover:bg-control-hover"}`}
              onMouseDown={(event) => event.preventDefault()}
              onClick={option.disabled ? undefined : option.run}
              onMouseMove={() => setHighlight(index)}
            >
              <span className={option.disabled ? "text-ink-3" : ""}>/{option.name}</span>
              <span className="min-w-0 truncate text-ink-3">{option.description}</span>
            </div>
          ))}
          {pluginRows.length > 0 ? (
            <PickerLabel first={matches.length === 0}>{MENTION_WORDS.plugins}</PickerLabel>
          ) : null}
          {pluginRows.map((plugin, index) => {
            const at = matches.length + index;
            return (
              <div
                key={plugin.id}
                id={optionId(at)}
                role="option"
                aria-selected={at === active}
                data-command-plugin={plugin.id}
                data-highlighted={at === active || undefined}
                className={`${pickerItem} cursor-pointer hover:bg-control-hover`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={plugin.pick}
                onMouseMove={() => setHighlight(at)}
              >
                <Icon name="plugins" className="text-icon-strong" />
                <span className="min-w-0 truncate">{plugin.name}</span>
              </div>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}
