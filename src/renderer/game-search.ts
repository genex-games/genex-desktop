/** Genex BM25 search, adapted to the local library. No network or analytics. */
import { buildIndex } from "../shared/catalog-search/buildIndex.ts";
import { createSearcher } from "../shared/catalog-search/query.ts";
import { ThreadKind } from "../shared/event-log.ts";
import { t } from "../shared/i18n.ts";
import type { ConversationRecord, GameProject, ThreadMeta } from "./types.ts";

/** How many games a search returns at most. */
const SEARCH_LIMIT = 20;
export type GameSearchItem = {
  id: string;
  title: string;
  detail: string;
  game?: GameProject;
  threadId?: string;
  searchText: string;
};
export function librarySearch(games: GameProject[], threads: ConversationRecord[], firstAsks: Record<string, string>) {
  const items: GameSearchItem[] = games.map((game) => ({
    id: game.name,
    title: game.title,
    detail: game.pathLabel,
    game,
    searchText: threads
      .filter((thread) => (thread.metadata as ThreadMeta)?.project === game.name)
      .map((thread) => `${thread.title} ${firstAsks[thread.id] ?? ""}`)
      .join(" "),
  }));
  // Existing drafts are recoverable; new games no longer create a separate sidebar chat entity.
  for (const thread of threads) {
    const meta = (thread.metadata ?? {}) as ThreadMeta;
    const folderlessDraft = meta.kind === ThreadKind.Game && !meta.project && !meta.archived;
    if (folderlessDraft)
      items.push({
        id: `thread:${thread.id}`,
        title: thread.title || firstAsks[thread.id] || t("Untitled conversation"),
        detail: t("Earlier conversation · no folder"),
        threadId: thread.id,
        searchText: firstAsks[thread.id] ?? "",
      });
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  const searcher = createSearcher(
    buildIndex(
      items.map((item) => ({
        id: item.id,
        slug: item.id,
        title: item.title,
        description: item.searchText,
        categories: [],
        author: item.game?.name ?? "",
        thumbnailUrl: null,
        playsCount: 0,
        multiplayer: false,
      })),
    ),
  );
  return {
    items,
    search: (query: string) =>
      searcher.search(query, SEARCH_LIMIT).flatMap((hit) => {
        const item = byId.get(hit.doc.id);
        return item ? [item] : [];
      }),
  };
}
