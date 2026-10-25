/**
 * Everything the @ picker may offer: the games in the library, read at once, the genex.games
 * half, read from main when the picker first opens and kept for a few minutes, and the signed-in
 * person's own asset library, asked again as the words after the @ change. A failed or refused
 * read (offline, signed out, a fixture profile) leaves the local games and the plugins.
 */
import { useMemo, useState } from "react";
import { LIBRARY_QUERY_MAX, type LibraryAsset } from "../../shared/asset-library.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type LocalMentionGame, type MentionCatalog, mentionCorpus } from "../../shared/mention-corpus.ts";
import type { MentionDoc } from "../../shared/prompt-mention.ts";
import { useLibrary, usePeople } from "../state/hooks.ts";
import { useAsyncEffect } from "../use-async-effect.ts";

/** How long one genex.games read serves the picker before the next open reads again. */
const CATALOG_TTL_MS = 5 * MINUTE_MS;
/** How long typing rests before the library is asked for the new words. */
const LIBRARY_DEBOUNCE_MS = 200;

/** Where the genex.games read stands. */
export const CatalogState = { Reading: "reading", Read: "read", Failed: "failed" } as const;
export type CatalogState = (typeof CatalogState)[keyof typeof CatalogState];

let cached: { at: number; catalog: MentionCatalog } | null = null;
/** No library: one array, so the docs are not rebuilt for a new empty one. */
const NO_ASSETS: readonly LibraryAsset[] = [];

/** The catalog and who is signed in, read together; signed out (or unreadable) means no one. */
async function readCatalog(): Promise<MentionCatalog> {
  const [items, me] = await Promise.all([window.studio.playCatalog(), window.studio.playMe().catch(() => null)]);
  return { items, userId: me?.id ?? null };
}

/** The genex.games half, read when the picker opens unless a recent read still serves. */
function useMentionCatalog(open: boolean) {
  const [catalog, setCatalog] = useState<MentionCatalog | null>(cached?.catalog ?? null);
  const [state, setState] = useState<CatalogState>(cached ? CatalogState.Read : CatalogState.Reading);
  useAsyncEffect(
    (alive) => {
      if (!open) return;
      if (cached && Date.now() - cached.at < CATALOG_TTL_MS) {
        setCatalog(cached.catalog);
        setState(CatalogState.Read);
        return;
      }
      readCatalog().then(
        (read) => {
          cached = { at: Date.now(), catalog: read };
          if (!alive()) return;
          setCatalog(read);
          setState(CatalogState.Read);
        },
        () => {
          if (alive()) setState(CatalogState.Failed);
        },
      );
    },
    [open],
  );
  return { catalog, state };
}

/**
 * The signed-in person's library for the words after the @, asked once typing rests. The last
 * answer stays until the next one comes, so the cards don't blink while typing; `reading` is true
 * only while there is no answer for this account yet. Signed out, nothing is asked.
 */
function useLibraryAssets(open: boolean, wanted: boolean, query: string) {
  const account = usePeople((s) => s.me?.id ?? null);
  const [answer, setAnswer] = useState<{ account: string; assets: LibraryAsset[] } | null>(null);
  const words = query.trim().slice(0, LIBRARY_QUERY_MAX);
  const asks = open && wanted && account !== null;
  useAsyncEffect(
    (alive) => {
      if (!asks || account === null) return;
      const timer = setTimeout(() => {
        window.studio.assetLibrary(words ? { query: words } : {}).then(
          (page) => {
            if (alive()) setAnswer({ account, assets: page.assets });
          },
          // Signed out after all, or offline: no library cards, and nothing to say about it.
          () => {
            if (alive()) setAnswer({ account, assets: [] });
          },
        );
      }, LIBRARY_DEBOUNCE_MS);
      return () => clearTimeout(timer);
    },
    [asks, account, words],
  );
  // Another account's answer is not this one's library.
  const assets = asks && answer?.account === account ? answer.assets : null;
  return { assets: assets ?? NO_ASSETS, reading: asks && assets === null };
}

/**
 * The picker's docs, with the current game left out; `open` starts the genex.games read, and the
 * library is asked for the typed `query` while `withLibrary` (the switchers show assets).
 */
export function useMentionDocs(open: boolean, project: string | null | undefined, query = "", withLibrary = false) {
  const games = useLibrary((s) => s.games);
  const { catalog, state } = useMentionCatalog(open);
  const library = useLibraryAssets(open, withLibrary, query);
  const docs = useMemo(() => {
    const local: LocalMentionGame[] = [...games]
      .filter((game) => game.name !== project)
      .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
      .map((game) => ({
        name: game.name,
        title: game.title,
        coverUrl: null,
      }));
    return mentionCorpus(local, catalog ?? { items: [], userId: null }, library.assets);
  }, [games, catalog, project, library.assets]);
  const covers = useMemo(() => new Map(games.map((game) => [game.name, game.cover])), [games]);
  return { docs, covers, state, libraryReading: library.reading };
}

/** Forget the genex.games read, as a sign-out must: own drafts are not public. */
export function resetMentionCatalog(): void {
  cached = null;
}

export type { MentionDoc };
