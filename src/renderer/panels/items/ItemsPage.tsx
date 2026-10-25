/**
 * Create › Items (marketplace plan 10.3, P10–P12; screens 07–08): a room over the workspace, like
 * Plugins, with two tabs. Browse lists other creators' shared items with a search and the item on
 * show beside them; its Add to \<game> allows the item in one of the account's games on Genex, then
 * opens that game's chat and sends the agent the prompt that puts it in ("Your agent puts it in the
 * game."). Selling lists the account's own items with the ready / on-hold strip; New item opens the
 * chosen game's chat with the cursor in its composer, which asks for an item. Every number is
 * genex.games' own; every press is the person's, carried out by main.
 */
import type { JSX } from "react";
import { useCallback, useEffect, useId, useMemo } from "react";
import { type BrowseItem, isStoreRefused, type SellingRow } from "../../../shared/store-items.ts";
import { chatPrompt, composeInChatWhenOpen } from "../../compose-in-chat.ts";
import { SIDEBAR_TOGGLE, SidebarToggle } from "../../shell/use-shell-chrome.ts";
import { useItems, useLibrary, usePeople, useThreads } from "../../state/hooks.ts";
import {
  addTarget,
  askedForItem,
  hostedGames,
  ItemsRead,
  ItemsTab,
  localGameOf,
  targetChosen,
} from "../../state/items.ts";
import { studio } from "../../state/studio.ts";
import { sidebarGames, threadMeta } from "../../state/threads.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/icons.tsx";
import { ITEMS_WORDS } from "../../words.ts";
import { type AddToGame, BrowseTab } from "./BrowseTab.tsx";
import type { OfferedGame } from "./ItemDetail.tsx";
import { addItemPrompt, changeItemPrompt } from "./items-prompts.ts";
import { SellingTab } from "./SellingTab.tsx";

const WORDS = ITEMS_WORDS;
const TABS = [ItemsTab.Browse, ItemsTab.Selling] as const;

interface Props {
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Open a local game's chat; `focus` puts the cursor in its composer. */
  onOpenGame: (game: string, focus: boolean) => Promise<void>;
  /** New item with no game yet: start one. */
  onNewGame: () => void;
}

/** The account's local games in the sidebar's order, and the one whose chat was open last. */
function useLocalGames(): { games: OfferedGame[]; open: string | null } {
  const games = useLibrary((s) => s.games);
  const records = useThreads((s) => s.records);
  const open = useThreads((s) => {
    const active = s.records.find((record) => record.id === s.activeThreadId);
    return active ? (threadMeta(active).project ?? null) : null;
  });
  const sorted = useMemo(
    () => sidebarGames(games, records).map((game) => ({ name: game.name, title: game.title })),
    [games, records],
  );
  return { games: sorted, open };
}

/**
 * Read Browse, Selling and which local games are on Genex: on opening, and when the account changes;
 * and the tab on show again when the window comes back to the front (a burst of them reads once).
 */
function useItemsReads(names: readonly string[]): { retryBrowse: () => void; retrySelling: () => void } {
  const account = usePeople((s) => s.me?.id ?? null);
  const key = names.join("\n");
  const retryBrowse = useCallback(() => void studio().items.search(studio().items.getState().browse.query), []);
  const retrySelling = useCallback(() => void studio().items.readSelling(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the account is what asks for the read again.
  useEffect(() => {
    retryBrowse();
    retrySelling();
  }, [account, retryBrowse, retrySelling]);
  useEffect(() => {
    void studio().items.readHosted(key ? key.split("\n") : []);
  }, [key]);
  useEffect(() => {
    const refresh = () => void studio().items.refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return { retryBrowse, retrySelling };
}

/** What Browse's Add to and Selling's presses do with the account's local games. */
function useGameActions(onOpenGame: Props["onOpenGame"], onNewGame: () => void) {
  const hosted = useItems((s) => s.hosted);
  const target = useItems((s) => s.target);
  const { games, open } = useLocalGames();
  const names = useMemo(() => games.map((game) => game.name), [games]);
  const reads = useItemsReads(names);
  const chosen = target ?? open ?? names[0] ?? null;
  const offered = useMemo(() => {
    const on = new Set(hostedGames(hosted, names));
    return games.filter((game) => on.has(game.name));
  }, [games, hosted, names]);
  const addName = addTarget({ hosted, target: chosen }, names);
  const add: AddToGame = {
    games: offered,
    target: offered.find((game) => game.name === addName) ?? null,
    onChoose: (game) => studio().items.setState((state) => targetChosen(state, game), true),
    onAdd: (item: BrowseItem, game: string) => {
      void studio()
        .items.addToGame(item.id, game)
        .then((answer) => {
          if (isStoreRefused(answer)) return;
          // The game's agent puts it in: the prompt goes to that game's chat as it opens.
          composeInChatWhenOpen({ project: game, text: addItemPrompt(item.name, item.id), send: true });
          return onOpenGame(game, false);
        });
    },
    // Asked first in the panel; what genex.games refuses shows under it.
    onRemove: (item: BrowseItem, game: string) => void studio().items.removeFromGame(item.id, game),
  };
  const newItem = () => {
    if (!chosen) return onNewGame();
    studio().items.setState((state) => askedForItem(state, chosen), true);
    void onOpenGame(chosen, true).then(() => requestAnimationFrame(() => chatPrompt()?.focus()));
  };
  const askAgent = (row: SellingRow) => {
    const game = localGameOf(hosted, row.game?.id);
    if (!game) return;
    composeInChatWhenOpen({ project: game, text: changeItemPrompt(row.name, row.id) });
    void onOpenGame(game, true);
  };
  const askable = (row: SellingRow) => localGameOf(hosted, row.game?.id) !== null;
  return { add, newItem, askAgent, askable, ...reads };
}

/** Browse and Selling, as a pair of tabs; the arrow keys move between them. A tab chosen is read again when its last read is old. */
function Tabs({ tab, panel }: { tab: ItemsTab; panel: string }): JSX.Element {
  const choose = (next: ItemsTab) => void studio().items.chooseTab(next);
  return (
    <div className="no-drag store-tabs items-tabs" role="tablist" aria-label={WORDS.tabsLabel}>
      {TABS.map((one) => (
        <button
          key={one}
          type="button"
          role="tab"
          className="store-tab"
          aria-selected={one === tab}
          aria-controls={panel}
          tabIndex={one === tab ? 0 : -1}
          data-items-tab={one}
          onClick={() => choose(one)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            const next = one === ItemsTab.Browse ? ItemsTab.Selling : ItemsTab.Browse;
            choose(next);
            event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-items-tab="${next}"]`)?.focus();
          }}
        >
          {one === ItemsTab.Browse ? WORDS.browse : WORDS.selling}
        </button>
      ))}
    </div>
  );
}

/** Browse's search field. */
function Search(): JSX.Element {
  const query = useItems((s) => s.browse.query);
  return (
    <label className="no-drag items-search">
      <Icon name="search" size={16} />
      <input
        type="search"
        aria-label={WORDS.search}
        placeholder={WORDS.search}
        data-items-search
        defaultValue={query}
        onChange={(event) => studio().items.searchTyped(event.currentTarget.value)}
      />
    </label>
  );
}

/**
 * The page's head, which the window drags by: the sidebar's toggle while it is hidden, the title,
 * the tabs, then Browse's search or Selling's New item.
 */
function Head({
  tab,
  panel,
  sidebarHidden,
  onToggleSidebar,
  onNewItem,
}: Pick<Props, "sidebarHidden" | "onToggleSidebar"> & {
  tab: ItemsTab;
  panel: string;
  onNewItem: () => void;
}): JSX.Element {
  const searchable = useItems((s) => s.browse.read !== ItemsRead.SignedOut && s.browse.read !== ItemsRead.Off);
  return (
    <div className={`items-head titlebar-drag ${sidebarHidden ? "items-head-inset" : ""}`}>
      {sidebarHidden && (
        <button
          type="button"
          className="no-drag sidebar-toggle"
          data-sidebar-toggle={SidebarToggle.Show}
          aria-label={SIDEBAR_TOGGLE.Show}
          aria-controls="studio-sidebar"
          aria-expanded="false"
          onClick={onToggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
      )}
      <h1 className="items-title">{WORDS.title}</h1>
      <Tabs tab={tab} panel={panel} />
      <div className="items-head-end">
        {tab === ItemsTab.Browse && searchable && <Search />}
        {tab === ItemsTab.Selling && (
          <Button variant="default" className="no-drag" data-items-new onClick={onNewItem}>
            <Icon name="sparkle" size={14} />
            {WORDS.newItem}
          </Button>
        )}
      </div>
    </div>
  );
}

export function ItemsPage({ sidebarHidden, onToggleSidebar, onOpenGame, onNewGame }: Props): JSX.Element {
  const panel = useId();
  const tab = useItems((s) => s.tab);
  const actions = useGameActions(onOpenGame, onNewGame);
  const head = (
    <Head
      tab={tab}
      panel={panel}
      sidebarHidden={sidebarHidden}
      onToggleSidebar={onToggleSidebar}
      onNewItem={actions.newItem}
    />
  );
  return (
    <section data-items-page={tab} aria-label={WORDS.title} className="items-page">
      {tab === ItemsTab.Browse ? (
        <BrowseTab head={head} panel={panel} add={actions.add} onRetry={actions.retryBrowse} />
      ) : (
        <SellingTab
          head={head}
          panel={panel}
          onAsk={actions.askAgent}
          askable={actions.askable}
          onRetry={actions.retrySelling}
        />
      )}
    </section>
  );
}
