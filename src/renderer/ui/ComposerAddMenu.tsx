import {
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref,
  type RefObject,
} from "react";
import type { ConnectionSnapshot } from "../../shared/connections.ts";
import { t } from "../../shared/i18n.ts";
import type { PluginInfo } from "../../shared/plugins.ts";
import type { McpConnectorView } from "../../shared/mcp.ts";
import { UiEvent, type UiEventType } from "../../shared/ui-events.ts";
import { SECOND_MS } from "../../shared/duration.ts";
import { useAsyncEffect } from "../use-async-effect.ts";
import {
  type AddMenuEntry,
  addMenuEntries,
  type EntryActions,
  EntryScope,
  IMAGES_OPTION,
  type MentionOption,
  mentionOptions,
  visibleConnectors,
} from "./add-menu-entries.ts";
import { Popover, PopoverContent, PopoverTrigger } from "./popover.tsx";
import { ComposerTip, PickerLabel, PickerSeparator, PickerSwitch, pickerItem, pickerRow } from "./PickerPanel.tsx";
import { Shortcut } from "./Shortcut.tsx";
import { Icon } from "./icons.tsx";
import { PluginIcon } from "./PluginIcon.tsx";
import { PLAN_MODE_WORDS, PLUGINS_WORDS, SKILLS_WORDS } from "../words.ts";
import { RovingAxis, rovingTarget } from "./roving-focus.ts";
import { type MentionDoc, MentionKind, pluginDoc } from "../../shared/prompt-mention.ts";
import { AssetScope } from "../../shared/asset-library.ts";
import {
  filterMentions,
  MENTION_FILTER_ALL,
  mentionAdmits,
  type MentionFilter,
  MentionWhat,
  shelfCaps,
} from "../../shared/mention-corpus.ts";
import { gridTarget } from "./mention-grid.ts";
import { mentionCards, MentionPanel } from "./MentionPanel.tsx";
import { useMentionDocs } from "./use-mention-docs.ts";

/** Shell navigation shared with the Plugins page. */
export const OPEN_PLUGINS_EVENT = "studio:open-plugins";

/** Opens the Plugins page at one plugin, where it turns on or updates. */
export const openPluginsAt = (id: string): void => {
  window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin: id } }));
};
/** Lets the composer's text box steer the @ list while its own focus stays in the text. */
export interface AddMenuHandle {
  keyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean;
}

/** While the menu is open, the plugins, servers and accounts are read again this often. */
const ADD_MENU_POLL_MS = 5 * SECOND_MS;
/** The events after which the menu reads its lists again. */
const REFRESHING_EVENTS: ReadonlySet<UiEventType> = new Set<UiEventType>([
  UiEvent.PluginsChanged,
  UiEvent.McpChanged,
  UiEvent.ConnectionsChanged,
]);

/**
 * The plugins, servers and accounts the menu lists, read while it is open: at once, on every
 * change main announces, and on a poll. A read that a newer one overtook is dropped.
 */
function useAddMenuData(open: boolean, project: string | null | undefined) {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [connectors, setConnectors] = useState<McpConnectorView[]>([]);
  const [connections, setConnections] = useState<ConnectionSnapshot | null>(null);
  const [error, setError] = useState("");
  // Until the first read answers, an empty list means "not read yet", not "nothing there".
  const [read, setRead] = useState(false);
  const refreshSequence = useRef(0);
  const refresh = async (isLive = () => true) => {
    const sequence = ++refreshSequence.current;
    const current = () => isLive() && sequence === refreshSequence.current;
    try {
      const [p, m, c] = await Promise.all([
        window.studio.pluginsList(),
        window.studio.mcpList(),
        window.studio.connections(undefined, project),
      ]);
      if (!current()) return;
      setPlugins(p.filter((plugin) => !plugin.removed && !plugin.unlisted));
      setConnectors(m);
      setConnections(c);
      setError("");
      setRead(true);
    } catch (e) {
      if (!current()) return;
      setConnections(null);
      setError(String(e));
      setRead(true);
    }
  };
  useAsyncEffect(
    (alive) => {
      if (!open) return;
      const update = () => void refresh(alive);
      update();
      const off = window.studio.onEvent((e) => {
        if (REFRESHING_EVENTS.has(e.type)) update();
      });
      const timer = setInterval(update, ADD_MENU_POLL_MS);
      return () => {
        off();
        clearInterval(timer);
      };
    },
    [open, project],
  );
  return { plugins, connectors, connections, error, read, setError, refresh };
}

/** What a key does in the @ list. */
const MentionKey = {
  Move: "move",
  Pick: "pick",
  Close: "close",
} as const;
type MentionKey = (typeof MentionKey)[keyof typeof MentionKey];

/** The arrows move, Enter (not a new line, not mid-composition) or Tab picks, Escape closes. */
function mentionIntent(event: KeyboardEvent<HTMLTextAreaElement>): MentionKey | null {
  if (event.key === "Escape") return MentionKey.Close;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") return MentionKey.Move;
  if (event.key === "Tab") return MentionKey.Pick;
  const enter = event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing;
  return enter ? MentionKey.Pick : null;
}

/** An option list the composer's text box drives: the @ list, and the / commands. */
export interface MentionState {
  mentioning: boolean;
  matches: MentionOption[];
  active: number;
  setHighlight: (index: number) => void;
  onClose?: () => void;
}

/** One key in the composer's text box while an option list is up; true when the list took it. */
export function mentionKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, mention: MentionState): boolean {
  const { matches, active } = mention;
  const intent = mention.mentioning ? mentionIntent(event) : null;
  if (intent === null) return false;
  if (intent === MentionKey.Close) {
    event.preventDefault();
    event.stopPropagation();
    mention.onClose?.();
    return true;
  }
  if (!matches.length) return false;
  event.preventDefault();
  if (intent === MentionKey.Move)
    mention.setHighlight(rovingTarget(event.key, active, matches.length, RovingAxis.Vertical) ?? active);
  else matches[active]?.pick();
  return true;
}

/** The @ picker's cards and rows, as the text box's keys walk them. */
interface MentionGridState extends MentionState {
  /** Rows above the cards (Images). */
  lead: number;
  cards: number;
  columns: number;
}

/** One key while the @ picker is up: all four arrows walk the cards' grid, then the rows. */
function mentionGridKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, mention: MentionGridState): boolean {
  if (!mention.mentioning) return false;
  const { lead, cards, columns } = mention;
  const shape = { lead, cards, rows: mention.matches.length - lead - cards, columns };
  const target = gridTarget(event.key, mention.active, shape);
  if (target === null) return mentionKeyDown(event, mention);
  event.preventDefault();
  mention.setHighlight(target);
  return true;
}

/** The @ picker's keys, handed to the composer's text box: arrows move, Enter or Tab picks, Escape closes. */
function useMentionKeys(ref: Ref<AddMenuHandle> | undefined, mention: MentionGridState): void {
  const { mentioning, matches, active, columns } = mention;
  useImperativeHandle(ref, () => ({ keyDown: (event) => mentionGridKeyDown(event, mention) }), [
    mentioning,
    matches,
    active,
    columns,
  ]);
}

/**
 * The @ list's outline: the highlighted option kept inside the list, the keys the text box hands
 * over, and the option the text box points at (`aria-activedescendant`).
 */
function useMentionOutline(
  ref: Ref<AddMenuHandle> | undefined,
  input: {
    mentioning: boolean;
    matches: MentionOption[];
    /** The words after the @ and the switchers: a change puts the outline back on the first option. */
    query: string | null;
    filter: MentionFilter;
    onClose: (() => void) | undefined;
    shape: { lead: number; cards: number; columns: number };
    list: string;
    onActiveOption: ((id: string | null) => void) | undefined;
  },
) {
  const { mentioning, matches } = input;
  const [highlight, setHighlight] = useState(0);
  useEffect(() => setHighlight(0), [input.query, input.filter]);
  const active = Math.min(highlight, Math.max(0, matches.length - 1));
  useMentionKeys(ref, {
    mentioning,
    matches,
    active,
    setHighlight,
    onClose: input.onClose,
    ...input.shape,
  });
  const optionId = (index: number) => `${input.list}-${index}`;
  const activeOption = mentioning && matches.length ? optionId(active) : null;
  useEffect(() => input.onActiveOption?.(activeOption), [activeOption]);
  return { active, optionId, setHighlight };
}

/** Cards go three across in a composer this wide (the home screen's), else two. */
const THREE_COLUMNS_PX = 560;
/** What the composer tells its @ picker about tagging. */
export interface MentionTagging {
  /** The handles already tagged in the message. */
  tagged: ReadonlySet<string>;
  /** The message holds as many tags as it may. */
  atCap: boolean;
  /** A card picked: the composer puts its tag in the text. */
  onPick: (doc: MentionDoc) => void;
  /** Where the picker opens: under the home screen's prompt bar, above a chat's. */
  side: "top" | "bottom";
}

/** A plugin row as a tag, named by its plugin id. */
function pluginTag(entry: AddMenuEntry): MentionDoc {
  return pluginDoc({ ...entry, id: entry.pluginId ?? entry.id });
}

const NO_TAGGING: MentionTagging = { tagged: new Set(), atCap: false, onPick: () => {}, side: "top" };

/** A plugin's card as the switchers judge it: never the person's own, so under All and Everyone alone. */
const PLUGIN_CARD = { kind: MentionKind.Plugin, own: false } as const;

/** The switchers show the library: All and Assets list assets. */
const showsAssets = (filter: MentionFilter): boolean =>
  filter.what === MentionWhat.All || filter.what === MentionWhat.Assets;

/** The library is the heart of the view (Mine, or Assets): a skeleton stands in while it answers. */
const libraryLeads = (filter: MentionFilter): boolean =>
  filter.whose === AssetScope.Mine || filter.what === MentionWhat.Assets;

/**
 * The @ picker's cards for what was typed and what the switchers let through, laid out for the
 * composer's width, each as a pick the text box's Enter can take. A card past the message's limit
 * is listed but not taken.
 */
function useMentionPicker(input: {
  open: boolean;
  query: string;
  project: string | null | undefined;
  anchor: RefObject<HTMLDivElement | null>;
  tagging: MentionTagging;
  /** Images and the plugins that are on, which the picker shows as a row and as cards. */
  rows: MentionOption[];
}) {
  // The switchers keep their place while the composer lives, so a second tag starts where the first did.
  const [filter, setFilter] = useState<MentionFilter>(MENTION_FILTER_ALL);
  const read = useMentionDocs(input.open, input.project, input.query, showsAssets(filter));
  const { docs, covers, state } = read;
  const width = input.open ? (input.anchor.current?.offsetWidth ?? 0) : 0;
  const columns = width >= THREE_COLUMNS_PX ? 3 : 2;
  const groups = input.open ? mentionCards(filterMentions(docs, filter), input.query, shelfCaps(filter)) : [];
  const cardPicks: MentionOption[] = groups
    .flatMap((group) => group.docs)
    .map((doc) => ({
      id: `card-${doc.handle}`,
      name: doc.title,
      pick: input.tagging.atCap && !input.tagging.tagged.has(doc.handle) ? () => {} : () => input.tagging.onPick(doc),
    }));
  // Images heads the list as a row; the cards follow, the plugins' cards last.
  const lead = input.rows.filter((row) => row.id === IMAGES_OPTION);
  const pluginCards = mentionAdmits(PLUGIN_CARD, filter) ? input.rows.filter((row) => row.id !== IMAGES_OPTION) : [];
  // A typed name reaches a plugin first: its tile leads the matches, as its shelf ends the panel.
  const matches = input.query.trim()
    ? [...lead, ...pluginCards, ...cardPicks]
    : [...lead, ...cardPicks, ...pluginCards];
  const shape = { lead: lead.length, cards: cardPicks.length + pluginCards.length, columns };
  const libraryReading = read.libraryReading && libraryLeads(filter);
  const shownRows = [...lead, ...pluginCards];
  return { groups, matches, shape, columns, covers, state, rows: shownRows, libraryReading, filter, setFilter };
}

/** What a row says beside its picture: its name, then a status, else where its switch applies. */
function EntryWords({ entry, id, scope }: { entry: AddMenuEntry; id: string; scope: string | undefined }) {
  const action = entry.status?.action;
  return (
    <>
      <PluginIcon name={entry.name} src={entry.icon} size="menu" />
      {/* The status gives up its room first; the name ellipsizes only once that is gone. */}
      <span className="min-w-0 shrink-[0.01] truncate">{entry.name}</span>
      {entry.status?.text && (
        <span id={`${id}-status`} className="picker-desc">
          {action && <span className="picker-dot" aria-hidden />}
          {entry.status.text}
        </span>
      )}
      {scope && (
        <span id={scope} className="picker-desc" data-plugin-scope={entry.scope}>
          {SKILLS_WORDS.allGames}
        </span>
      )}
    </>
  );
}

/** A row's name spans the space its controls leave, top to bottom, so all of it takes the click. */
const ENTRY_NAME = "flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 self-stretch text-left";

/**
 * A plugin or server row: its name, a status only when something needs doing, and its switch. A
 * plugin's name opens its page, and Settings shows beside the switch while the row is hovered or
 * holds focus (the pointer's way there; keys take the name); a server's name works its switch. Its
 * ids are by place, not by name: a server's id is the person's own.
 */
function EntryRow({
  entry,
  index,
  list,
  pending,
}: {
  entry: AddMenuEntry;
  index: number;
  list: string;
  pending: boolean;
}) {
  const id = `${list}-${entry.kind}-${index}`;
  const action = entry.status?.action;
  // Where the switch applies, while no status needs the space: a plugin is on or off for every game.
  const scope = !entry.status && entry.scope === EntryScope.AllGames ? `${id}-scope` : undefined;
  const words = <EntryWords entry={entry} id={id} scope={scope} />;
  return (
    <div className={`${pickerItem} hover:bg-control-hover`} data-plugin-row={entry.id}>
      {entry.open ? (
        <button
          type="button"
          className={ENTRY_NAME}
          data-plugin-open
          aria-label={PLUGINS_WORDS.menuRow.openLabel(entry.name)}
          aria-describedby={entry.status?.text ? `${id}-status` : undefined}
          onClick={entry.open}
        >
          {words}
        </button>
      ) : (
        <label htmlFor={id} className={ENTRY_NAME}>
          {words}
        </label>
      )}
      {entry.settings && (
        <button
          type="button"
          className="picker-settings"
          data-plugin-settings
          tabIndex={-1}
          aria-label={PLUGINS_WORDS.menuRow.settingsLabel(entry.name)}
          onClick={entry.settings}
        >
          {PLUGINS_WORDS.menuRow.settings}
        </button>
      )}
      {action && (
        <button
          type="button"
          className="picker-action"
          disabled={pending}
          aria-label={t("{action} {name}", { action: action.label, name: entry.name })}
          onClick={action.run}
        >
          {action.label}
        </button>
      )}
      <PickerSwitch
        id={id}
        checked={entry.on}
        disabled={pending || entry.locked}
        label={t("Use {name}", { name: entry.name })}
        describedBy={scope}
        onChange={entry.toggle}
      />
    </div>
  );
}

/**
 * Add's Plan mode: the next message gets a plan, written in one go and reviewed in the chat
 * (Approve, Make changes, Cancel) before anything is built (`reviewPlan`). Sending resets it.
 */
export interface ComposerPlanMode {
  on: boolean;
  /** Offered where Mode's Loop is the chat's own: a build that owns the chat keeps its own plan. */
  available: boolean;
  onChange: (on: boolean) => void;
}

/** What Plan mode's row says: why it is not offered, else what a click does. */
function planRowWords(plan: ComposerPlanMode): string {
  if (!plan.available) return PLAN_MODE_WORDS.duringBuild;
  return plan.on ? PLAN_MODE_WORDS.turnOff : PLAN_MODE_WORDS.turnOn;
}

/** Plan mode, as in Codex: a row that turns it on (the bulb then shows it) or, while on, off. */
function PlanModeItem({ plan, onPicked }: { plan: ComposerPlanMode; onPicked: () => void }) {
  const description = planRowWords(plan);
  return (
    <button
      type="button"
      className={pickerRow}
      data-plan-mode-row
      aria-pressed={plan.on}
      disabled={!plan.available}
      onClick={() => {
        onPicked();
        plan.onChange(!plan.on);
      }}
    >
      <Icon name="bulb" className="text-ink" />
      <span className="shrink-0">{PLAN_MODE_WORDS.label}</span>
      <span className="picker-desc" title={description}>
        {description}
      </span>
    </button>
  );
}

/**
 * The bulb the composer shows while Add's Plan mode is on, behind a hairline as in Codex: one click
 * turns it off. Only Add turns it on; the permissions pill's Plan is another thing.
 */
export function PlanModeOff({ onOff, disabled = false }: { onOff: () => void; disabled?: boolean }) {
  return (
    <>
      <span aria-hidden className="composer-divider" />
      <ComposerTip align="start" content={PLAN_MODE_WORDS.turnOff}>
        <button
          type="button"
          aria-label={PLAN_MODE_WORDS.turnOff}
          data-plan-mode-off
          disabled={disabled}
          className="composer-icon"
          onClick={onOff}
        >
          <Icon name="bulb" />
        </button>
      </ComposerTip>
    </>
  );
}

/**
 * The full menu: Images and Plan mode, then the plugins and servers with their switches, then
 * Manage plugins.
 */
function FullMenu({
  entries,
  list,
  pending,
  error,
  plan,
  onImages,
  onPicked,
  onManage,
}: {
  entries: AddMenuEntry[];
  list: string;
  pending: boolean;
  error: string;
  plan: ComposerPlanMode | null;
  onImages: () => void;
  /** Closes the menu once a row acted. */
  onPicked: () => void;
  onManage: () => void;
}) {
  const pluginEntries = entries.filter((e) => e.kind === "plugin");
  const serverEntries = entries.filter((e) => e.kind === "mcp");
  const row = (entry: AddMenuEntry, index: number) => (
    <EntryRow key={entry.id} entry={entry} index={index} list={list} pending={pending} />
  );
  return (
    <>
      <PickerLabel first>{t("Add")}</PickerLabel>
      <button type="button" className={pickerRow} onClick={onImages}>
        <Icon name="image" className="text-ink" />
        <span className="shrink-0">{t("Images")}</span>
        <span className="picker-desc">{t("Reference or mood board")}</span>
      </button>
      {plan && <PlanModeItem plan={plan} onPicked={onPicked} />}
      {pluginEntries.length > 0 && <PickerLabel>{t("Plugins")}</PickerLabel>}
      {pluginEntries.map(row)}
      {serverEntries.length > 0 && <PickerLabel>{t("MCP servers")}</PickerLabel>}
      {serverEntries.map(row)}
      {error && (
        <p role="alert" className="px-2.5 py-1.5 text-[12px] leading-4 text-red">
          {error}
        </p>
      )}
      <PickerSeparator />
      <button type="button" onClick={onManage} className={pickerRow}>
        <Icon name="plugins" className="text-ink" />
        {t("Manage plugins")}
        <Icon name="chevron-right" className="ml-auto text-ink-3" />
      </button>
    </>
  );
}

/** The rows' actions, each run through the menu's `act` (one at a time, then a fresh read). */
function entryActions(
  act: (fn: () => Promise<unknown>) => Promise<void>,
  manage: (plugin?: string) => void,
  project: string | null | undefined,
): EntryActions {
  const where = project ?? undefined;
  return {
    manage,
    connect: (view) => void act(() => window.studio.mcpConnect(view.connector.id, where)),
    connectAccount: (plugin) =>
      void act(async () => {
        const name = plugin.manifest.account?.connect;
        if (name === undefined) return;
        const action = plugin.manifest.actions.find((a) => a.name === name);
        const review = action?.confirmation
          ? await window.studio.pluginReview(plugin.manifest.id, name, {}, where)
          : undefined;
        await window.studio.pluginAction(plugin.manifest.id, name, {}, where, review?.ticket);
      }),
    enablePlugin: (plugin, on) => void act(() => window.studio.pluginEnable(plugin.manifest.id, on)),
    enableServer: (view, on) => void act(() => window.studio.mcpSave({ ...view.connector, enabled: on })),
  };
}

/** Add's button, with its tip while the menu is closed. */
function AddTrigger({ open, disabled }: { open: boolean; disabled: boolean }) {
  return (
    <ComposerTip
      hidden={open}
      align="start"
      content={
        <span className="flex items-center gap-2">
          {t("Add images and more")} <Shortcut>@</Shortcut>
        </span>
      }
    >
      <PopoverTrigger
        render={<button type="button" />}
        disabled={disabled}
        aria-label={t("Add images and more")}
        className="composer-icon composer-add"
      >
        <Icon name="plus" />
      </PopoverTrigger>
    </ComposerTip>
  );
}

/**
 * The rows' entries and their actions, one at a time and each followed by a fresh read; Manage
 * closes the menu (`close`) and opens the Plugins page.
 */
function useEntryActions(
  data: ReturnType<typeof useAddMenuData>,
  project: string | null | undefined,
  close: () => void,
) {
  const [pending, setPending] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setPending(true);
    data.setError("");
    try {
      await fn();
      await data.refresh();
    } catch (e) {
      data.setError(String(e));
    } finally {
      setPending(false);
    }
  };
  const manage = (plugin?: string) => {
    close();
    window.dispatchEvent(new CustomEvent(OPEN_PLUGINS_EVENT, { detail: { plugin } }));
  };
  const actions = entryActions(act, manage, project);
  const visible = visibleConnectors(data.connectors, data.plugins, project);
  const entries = addMenuEntries(data.plugins, visible, data.connections, actions);
  return { pending, entries, manage };
}

/**
 * The panel's frame: the @ picker keeps its header put and scrolls its own list under it, so it
 * holds no padding or scroll of its own; the full menu scrolls whole.
 */
function panelClass(listMode: boolean): string {
  const frame = "picker-panel composer-add-panel w-(--anchor-width)";
  return listMode
    ? `${frame} flex flex-col overflow-hidden p-0 max-h-[min(var(--available-height),480px)]`
    : `${frame} overflow-y-auto p-1.5 max-h-(--available-height)`;
}

/** Add: images and Plan mode, then plugins and MCP servers with their switches. Typing @ in the
 * composer opens the same list to mention one by name. A status appears only when something needs
 * doing, with the action that fixes it beside it. */
export function ComposerAddMenu({
  onReferences,
  anchor,
  disabled = false,
  project,
  plan = null,
  mention = null,
  listId,
  onMention,
  onMentionClose,
  onMentionFocus,
  onMentionClear,
  onActiveOption,
  tagging = NO_TAGGING,
  ref,
}: {
  onReferences: () => void;
  anchor: RefObject<HTMLDivElement | null>;
  disabled?: boolean;
  project?: string | null;
  /** Plan mode's row; null where the composer offers none. */
  plan?: ComposerPlanMode | null;
  /** The text after an @ at the caret, or null when the caret is not in a mention. */
  mention?: string | null;
  onMention?: (text: string | null) => void;
  onMentionClose?: () => void;
  /** Put the caret back at the end of the text after the @ (the picker's search field was clicked). */
  onMentionFocus?: () => void;
  /** Empty the text after the @, keeping the @ and the focus (the search field's Clear). */
  onMentionClear?: () => void;
  /** The @ list's id and its highlighted option, for the text box's aria-controls/activedescendant. */
  listId?: string;
  onActiveOption?: (id: string | null) => void;
  /** The @ picker's tags: what is tagged, the cap, a pick, and where it opens. */
  tagging?: MentionTagging;
  ref?: Ref<AddMenuHandle>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const ownId = useId();
  const list = listId ?? ownId;
  const mentioning = mention !== null && !menuOpen;
  const open = menuOpen || mentioning;
  // A mention list stays a mention list until it has fully closed, and focus stays in the text
  // throughout: switching to the full menu mid-exit would pull focus into it.
  const viaMention = useRef(false);
  if (menuOpen) viaMention.current = false;
  else if (mentioning) viaMention.current = true;
  const listMode = viaMention.current;
  const data = useAddMenuData(open, project);
  const { pending, entries, manage } = useEntryActions(data, project, () => {
    setMenuOpen(false);
    onMentionClose?.();
  });
  const pickImages = () => {
    onMention?.(null);
    onReferences();
  };
  const rows = mentionOptions(mention, entries, pickImages, (entry) => tagging.onPick(pluginTag(entry)));
  const picker = useMentionPicker({ open: mentioning, query: mention ?? "", project, anchor, tagging, rows });
  const { active, optionId, setHighlight } = useMentionOutline(ref, {
    mentioning,
    matches: picker.matches,
    query: mention,
    filter: picker.filter,
    onClose: onMentionClose,
    shape: picker.shape,
    list,
    onActiveOption,
  });
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onMentionClose?.();
        setMenuOpen(next);
      }}
    >
      <AddTrigger open={open} disabled={disabled} />
      <PopoverContent
        anchor={anchor}
        side={listMode ? tagging.side : "top"}
        align="start"
        sideOffset={8}
        initialFocus={!listMode}
        finalFocus={() => !viaMention.current}
        className={panelClass(listMode)}
        aria-label={t("Add")}
      >
        {listMode ? (
          <MentionPanel
            list={list}
            query={mention ?? ""}
            groups={picker.groups}
            rows={picker.rows}
            columns={picker.columns}
            catalog={picker.state}
            libraryReading={picker.libraryReading}
            rowsRead={data.read}
            picked={tagging.tagged}
            atCap={tagging.atCap}
            covers={picker.covers}
            active={active}
            optionId={optionId}
            onHighlight={setHighlight}
            onPick={tagging.onPick}
            filter={picker.filter}
            onFilter={picker.setFilter}
            onFocusQuery={() => onMentionFocus?.()}
            onClearQuery={() => onMentionClear?.()}
          />
        ) : (
          <FullMenu
            entries={entries}
            list={list}
            pending={pending}
            error={data.error}
            plan={plan}
            onPicked={() => setMenuOpen(false)}
            onImages={() => {
              setMenuOpen(false);
              onReferences();
            }}
            onManage={() => manage()}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}
