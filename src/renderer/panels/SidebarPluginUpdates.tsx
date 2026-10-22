/**
 * The sidebar's plugin updates: one line over the foot of the game list while installed plugins
 * have newer versions waiting. Hovering it lists them, each with its versions and a box to leave it
 * out; the line and the list install what is ticked, one update after another.
 */
import type { JSX } from "react";
import { useState } from "react";
import { chosenUpdates, type PluginUpdate, updateKey } from "../state/plugins.ts";
import { Checkbox } from "../ui/Checkbox.tsx";
import { Icon } from "../ui/icons.tsx";
import { PluginIcon } from "../ui/PluginIcon.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover.tsx";
import { PLUGIN_UPDATE_WORDS } from "../words.ts";
import { shownName } from "./plugins/labels.ts";

/** How long the pointer rests on the line before the list opens, and lingers off it before it closes. */
const OPEN_DELAY_MS = 150;
const CLOSE_DELAY_MS = 200;

interface Props {
  /** The updates waiting, in the installed order (`pluginUpdates`). */
  updates: readonly PluginUpdate[];
  /** Update plugins is installing them. */
  updating: boolean;
  /** Install every waiting update but the unticked ones (`updateKey`), one after another. */
  onUpdate: (skipped: ReadonlySet<string>) => void;
  onOpenPlugins: () => void;
  /** Open Plugins at one plugin's page. */
  onOpenPlugin: (id: string) => void;
}

/** The line, its list and the boxes they share: an untick in the list changes the line's count too. */
export function SidebarPluginUpdates({ updates, updating, onUpdate, onOpenPlugins, onOpenPlugin }: Props): JSX.Element {
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState(false);
  const chosen = chosenUpdates(updates, skipped).length;
  const total = updates.length;
  const toggle = (update: PluginUpdate): void =>
    setSkipped((current) => {
      const next = new Set(current);
      const key = updateKey(update);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const chooseAll = (all: boolean): void => setSkipped(all ? new Set() : new Set(updates.map(updateKey)));
  const update = (): void => {
    setOpen(false);
    onUpdate(skipped);
  };
  /** Close the list, then go where its button leads. */
  const closeThen = (go: () => void) => (): void => {
    setOpen(false);
    go();
  };
  // The last update installs before the run ends: nothing is left to count then.
  const label = total > 0 && !updating ? PLUGIN_UPDATE_WORDS.count(total) : PLUGIN_UPDATE_WORDS.updating;
  return (
    <div className="sidebar-plugin-updates" data-plugin-updates aria-busy={updating}>
      <Popover open={open && total > 0} onOpenChange={setOpen}>
        <PopoverTrigger
          openOnHover
          delay={OPEN_DELAY_MS}
          closeDelay={CLOSE_DELAY_MS}
          className="sidebar-plugin-updates-open"
          data-plugin-updates-open
        >
          <Icon name={updating ? "reload" : "plugins"} size={16} />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" sideOffset={6} className="plugin-updates-panel">
          <PluginUpdatesList
            updates={updates}
            skipped={skipped}
            disabled={updating}
            onToggle={toggle}
            onChooseAll={chooseAll}
            onOpenPlugin={(id) => closeThen(() => onOpenPlugin(id))()}
          />
          <div className="plugin-updates-actions">
            <button type="button" className="plugin-updates-open-all" onClick={closeThen(onOpenPlugins)}>
              {PLUGIN_UPDATE_WORDS.openPlugins}
            </button>
            <button type="button" className="plugin-updates-run" disabled={updating || chosen === 0} onClick={update}>
              {PLUGIN_UPDATE_WORDS.update(chosen, total)}
            </button>
          </div>
        </PopoverContent>
      </Popover>
      {!updating && total > 0 && (
        <button
          type="button"
          className="plugin-updates-run"
          data-plugins-update
          disabled={chosen === 0}
          onClick={update}
        >
          {PLUGIN_UPDATE_WORDS.update(chosen, total)}
        </button>
      )}
    </div>
  );
}

/** The list: a box for all of them, then one row a plugin, scrolling past a handful. */
function PluginUpdatesList({
  updates,
  skipped,
  disabled,
  onToggle,
  onChooseAll,
  onOpenPlugin,
}: {
  updates: readonly PluginUpdate[];
  skipped: ReadonlySet<string>;
  disabled: boolean;
  onToggle: (update: PluginUpdate) => void;
  onChooseAll: (all: boolean) => void;
  onOpenPlugin: (id: string) => void;
}): JSX.Element {
  const chosen = chosenUpdates(updates, skipped).length;
  const total = updates.length;
  return (
    <>
      <label className="plugin-updates-heading">
        <Checkbox
          aria-label={PLUGIN_UPDATE_WORDS.chooseAll}
          checked={chosen === total}
          indeterminate={chosen > 0 && chosen < total}
          disabled={disabled}
          onChange={(event) => onChooseAll(event.currentTarget.checked)}
        />
        <span className="flex-1">{PLUGIN_UPDATE_WORDS.heading}</span>
        {chosen < total && <span>{PLUGIN_UPDATE_WORDS.chosen(chosen, total)}</span>}
      </label>
      <ul className="plugin-updates-list">
        {updates.map((update) => (
          <PluginUpdateRow
            key={updateKey(update)}
            update={update}
            ticked={!skipped.has(updateKey(update))}
            disabled={disabled}
            onToggle={() => onToggle(update)}
            onOpen={() => onOpenPlugin(update.plugin.manifest.id)}
          />
        ))}
      </ul>
    </>
  );
}

/** One plugin: its box, picture and name, the version it moves from and to, and its page. */
function PluginUpdateRow({
  update,
  ticked,
  disabled,
  onToggle,
  onOpen,
}: {
  update: PluginUpdate;
  ticked: boolean;
  disabled: boolean;
  onToggle: () => void;
  onOpen: () => void;
}): JSX.Element {
  const name = shownName(update.plugin);
  const from = update.plugin.manifest.version;
  return (
    <li className="plugin-update-row" data-plugin-update={update.plugin.manifest.id} data-off={!ticked}>
      <label className="plugin-update-pick">
        <Checkbox checked={ticked} disabled={disabled} onChange={onToggle} />
        <PluginIcon name={name} src={update.plugin.iconUrl} size="menu" />
        <span className="plugin-update-name">{name}</span>
        <span className="plugin-update-versions" aria-hidden="true">
          {from} → <b>{update.version}</b>
        </span>
        <span className="sr-only">{PLUGIN_UPDATE_WORDS.versions(from, update.version)}</span>
      </label>
      <button
        type="button"
        className="plugin-update-page"
        aria-label={PLUGIN_UPDATE_WORDS.openPlugin(name)}
        onClick={onOpen}
      >
        <Icon name="chevron-right" size={14} />
      </button>
    </li>
  );
}
