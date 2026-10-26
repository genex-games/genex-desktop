/**
 * The game's store items for the stage: what Shop shows and whether its tab is there. Kept out of
 * `ShopStage.tsx`, which loads only when Shop opens.
 */
import { useEffect, useMemo } from "react";
import type { ListingRecord } from "../../../shared/item-draft.ts";
import { useItems } from "../../state/hooks.ts";
import { studio } from "../../state/studio.ts";
import { shopItems } from "./shop-model.ts";

/** The game's items, read from main and, once the game is on Genex, from genex.games' Selling. */
export function useShopItems(project: string | null): ListingRecord[] {
  const local = useItems((s) => (project ? s.local[project] : undefined));
  const hosted = useItems((s) => (project ? s.hosted[project] : undefined));
  const rows = useItems((s) => s.selling.selling?.items);
  useEffect(() => {
    if (!project) return;
    void studio().items.readLocal(project);
    void studio().items.readHosted([project]);
  }, [project]);
  useEffect(() => {
    if (hosted) void studio().items.readSelling();
  }, [hosted]);
  return useMemo(() => (project ? shopItems(project, local, hosted, rows) : []), [project, local, hosted, rows]);
}
