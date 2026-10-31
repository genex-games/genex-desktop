/** Port of Genex SearchBox: same local ranking, debounce, keyboard navigation and visual pattern. */
import type { JSX, KeyboardEvent, RefObject } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ConversationRecord, GameProject } from "../types.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { searchClosedProperties } from "../analytics/workspace-properties.ts";
import { librarySearch, type GameSearchItem } from "../game-search.ts";
import { DialogSurface } from "../ui/dialog.tsx";
import { GameAvatar } from "../ui/GameAvatar.tsx";
import { Icon } from "../ui/icons.tsx";
import { Shortcut } from "../ui/Shortcut.tsx";
import { t } from "../../shared/i18n.ts";

/** How long typing pauses before the results follow it. */
const SEARCH_DEBOUNCE_MS = 120;
/** How many recent games an empty search shows. */
const RECENT_LIMIT = 10;

const openedAt = (item: GameSearchItem): number => Date.parse(item.game?.lastOpenedAt ?? "") || 0;

/** The search as typed, as searched (debounced), its results, and the highlighted one. */
function useGameSearch(games: GameProject[], threads: ConversationRecord[], firstAsks: Record<string, string>) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [active, setActive] = useState(0);
  const catalog = useMemo(() => librarySearch(games, threads, firstAsks), [games, threads, firstAsks]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(query);
      setActive(0);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const items = useMemo(
    () =>
      debounced.trim()
        ? catalog.search(debounced)
        : [...catalog.items].sort((a, b) => openedAt(b) - openedAt(a)).slice(0, RECENT_LIMIT),
    [catalog, debounced],
  );
  const selected = Math.max(0, Math.min(active, items.length - 1));
  return { query, setQuery, debounced, items, selected, setActive };
}

/**
 * The search's end for usage analytics, counted once: the result picked or none, with how long the
 * query was, how many results it had, and whether a search came up empty on the way.
 */
function useSearchEnd(query: string, debounced: string, items: GameSearchItem[]) {
  const openedAt = useRef(Date.now());
  const emptySeen = useRef(false);
  const ended = useRef(false);
  useEffect(() => {
    if (debounced.trim() && items.length === 0) emptySeen.current = true;
  }, [debounced, items]);
  return (picked: GameSearchItem | null): void => {
    if (ended.current) return;
    ended.current = true;
    const index = picked ? items.indexOf(picked) : -1;
    const at = Date.now();
    const pick = picked ? { index, earlierChat: !picked.game } : null;
    const closed = { picked: pick, query, results: items.length, noResultsSeen: emptySeen.current };
    track(AnalyticsEvent.GameSearchClosed, searchClosedProperties({ ...closed, openedAt: openedAt.current, at }));
  };
}

/** The results: recent games for an empty search, else the matches, or what to say without any. */
function SearchResults({
  list,
  items,
  selected,
  query,
  debounced,
  onHover,
  onSelect,
}: {
  list: RefObject<HTMLDivElement | null>;
  items: GameSearchItem[];
  selected: number;
  query: string;
  debounced: string;
  onHover: (index: number) => void;
  onSelect: (item: GameSearchItem) => void;
}): JSX.Element {
  const searched = debounced.trim();
  return (
    <div
      ref={list}
      className="game-search-results"
      // The results are the person's games and chats.
      data-analytics-mask
      role="listbox"
      id="game-search-results"
      aria-label={t("Games")}
      aria-busy={query !== debounced}
    >
      {!searched && items.length > 0 && <div className="px-3 py-2 text-xs text-ink-3">{t("Recent games")}</div>}
      {items.map((item, index) => (
        <button
          key={item.id}
          type="button"
          role="option"
          id={`game-search-${index}`}
          aria-selected={selected === index}
          data-search-index={index}
          className="game-search-result"
          onMouseEnter={() => onHover(index)}
          onClick={() => onSelect(item)}
        >
          <GameAvatar cover={item.game?.cover} gameKey={item.game?.name} className="search-cover" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-body-sm text-ink">{item.title}</span>
            <span className="mt-1 block truncate text-xs text-ink-3">{item.detail}</span>
          </span>
        </button>
      ))}
      {items.length === 0 && (
        <p className="px-4 py-8 text-center text-body-sm text-ink-3">
          {searched ? t("No games for “{query}”.", { query: searched }) : t("Your games will appear here.")}
        </p>
      )}
    </div>
  );
}

export function GameSearchDialog({
  games,
  threads,
  firstAsks,
  onSelectGame,
  onSelectThread,
  onDismiss,
}: {
  games: GameProject[];
  threads: ConversationRecord[];
  firstAsks: Record<string, string>;
  onSelectGame: (name: string) => void;
  onSelectThread: (id: string) => void;
  onDismiss: () => void;
}) {
  const { query, setQuery, debounced, items, selected, setActive } = useGameSearch(games, threads, firstAsks);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-search-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  const end = useSearchEnd(query, debounced, items);
  const dismiss = (): void => {
    end(null);
    onDismiss();
  };
  function select(item: GameSearchItem) {
    end(item);
    onDismiss();
    if (item.game) onSelectGame(item.game.name);
    else if (item.threadId) onSelectThread(item.threadId);
  }
  const onKey = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    const current = items[selected];
    // Enter picks the highlighted result only once the list matches what was typed.
    const choice = query === debounced ? current : undefined;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === "k") {
      event.preventDefault();
      dismiss();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(selected + 1, items.length - 1));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(0, selected - 1));
    }
    if (event.key === "Enter" && choice) {
      event.preventDefault();
      select(choice);
    }
  };
  return (
    <DialogSurface
      title={t("Search games")}
      size="xl"
      testId="game-search-dialog"
      initialFocus={input}
      onDismiss={dismiss}
      className="gap-0 p-0"
      showClose={false}
    >
      <div className="game-search-input">
        <Icon name="search" size={18} />
        <input
          ref={input}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("Search anything…")}
          aria-label={t("Search games")}
          role="combobox"
          aria-expanded="true"
          aria-controls="game-search-results"
          aria-autocomplete="list"
          aria-activedescendant={items[selected] ? `game-search-${selected}` : undefined}
          onKeyDown={onKey}
        />
        <button type="button" aria-label={t("Close search")} onClick={dismiss}>
          <Shortcut>esc</Shortcut>
        </button>
      </div>
      <SearchResults
        list={list}
        items={items}
        selected={selected}
        query={query}
        debounced={debounced}
        onHover={setActive}
        onSelect={select}
      />
      <div className="game-search-footer">
        <span>
          <Shortcut>↑↓</Shortcut> {t("navigate")}
        </span>
        <span>
          <Shortcut>↵</Shortcut> {t("open")}
        </span>
        <span>
          <Shortcut>esc</Shortcut> {t("close")}
        </span>
      </div>
    </DialogSurface>
  );
}
