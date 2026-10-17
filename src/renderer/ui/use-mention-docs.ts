/**
 * Everything the @ picker may offer: the games in the library, read at once, and the genex.games
 * half, read from main when the picker first opens and kept for a few minutes. A failed or
 * refused read (offline, a fixture profile) leaves the local games and the plugins.
 */
import { useMemo, useState } from "react";
import { MINUTE_MS } from "../../shared/duration.ts";
import { type LocalMentionGame, type MentionCatalog, mentionCorpus } from "../../shared/mention-corpus.ts";
import type { MentionDoc } from "../../shared/prompt-mention.ts";
import { useLibrary } from "../state/hooks.ts";
import { useAsyncEffect } from "../use-async-effect.ts";

/** How long one genex.games read serves the picker before the next open reads again. */
const CATALOG_TTL_MS = 5 * MINUTE_MS;

/** Where the genex.games read stands. */
export const CatalogState = { Reading: "reading", Read: "read", Failed: "failed" } as const;
export type CatalogState = (typeof CatalogState)[keyof typeof CatalogState];

let cached: { at: number; catalog: MentionCatalog } | null = null;

/** The catalog and who is signed in, read together; signed out (or unreadable) means no one. */
async function readCatalog(): Promise<MentionCatalog> {
  const [items, me] = await Promise.all([window.studio.playCatalog(), window.studio.playMe().catch(() => null)]);
  return { items, userId: me?.id ?? null };
}

/** The picker's docs, with the current game left out; `open` starts the genex.games read. */
export function useMentionDocs(open: boolean, project: string | null | undefined) {
  const games = useLibrary((s) => s.games);
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
  const docs = useMemo(() => {
    const local: LocalMentionGame[] = [...games]
      .filter((game) => game.name !== project)
      .sort((a, b) => (b.lastOpenedAt ?? "").localeCompare(a.lastOpenedAt ?? ""))
      .map((game) => ({
        name: game.name,
        title: game.title,
        coverUrl: null,
      }));
    return mentionCorpus(local, catalog ?? { items: [], userId: null });
  }, [games, catalog, project]);
  const covers = useMemo(() => new Map(games.map((game) => [game.name, game.cover])), [games]);
  return { docs, covers, state };
}

/** Forget the genex.games read, as a sign-out must: own drafts are not public. */
export function resetMentionCatalog(): void {
  cached = null;
}

export type { MentionDoc };
