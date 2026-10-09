/**
 * Searching a provider's Older models in Settings → Model Providers: OpenRouter lists hundreds, so
 * a long list offers a search field that matches the words of a model's name or id.
 */

/** From how many older models the list offers a search; a shorter list is read at a glance. */
const SEARCH_FROM_MODELS = 13;

/** Does a list of this many older models offer a search? */
export const offersSearch = (count: number): boolean => count >= SEARCH_FROM_MODELS;

/** The rows whose name or id holds every word of the query, in any case; all of them for a blank one. */
export function matchingModels<Row extends { id: string; name: string }>(rows: readonly Row[], query: string): Row[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.name} ${row.id}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
