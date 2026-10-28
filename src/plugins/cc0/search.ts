/**
 * `cc0__search`: Poly Haven's asset lists (cached for an hour per kind, as their API asks clients
 * to be gentle) filtered by the query's words, most downloaded first, and ambientCG's own search
 * for materials. A result names its source and id, which is what `cc0__fetch` takes.
 */
import { HOUR_MS } from "../../shared/duration.ts";
import { Cc0Error, Cc0Refusal } from "../../substrate/cc0-fetch.ts";
import type { Cc0Net } from "./net.ts";
import { Cc0Kind, Cc0Source } from "./sources.ts";

/** How long one Poly Haven list answers searches. */
const LIST_CACHE_MS = HOUR_MS;
/** Results a search returns when no limit is given, and at most. */
const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 24;
/** The line Poly Haven's API terms ask a UI to show next to its live results. */
export const POLYHAVEN_CREDIT = "Powered by Poly Haven";

/** Poly Haven's list type for each kind. */
const POLYHAVEN_LIST: Readonly<Record<Cc0Kind, string>> = {
  [Cc0Kind.Model]: "models",
  [Cc0Kind.Texture]: "textures",
  [Cc0Kind.Hdri]: "hdris",
};
const KINDS: ReadonlySet<string> = new Set(Object.values(Cc0Kind));

/** One search result. */
export interface Cc0Result {
  source: Cc0Source;
  id: string;
  name: string;
  kind: Cc0Kind;
  page: string;
  authors: string[];
  polycount?: number;
  /** Poly Haven's dimensions, in millimetres. */
  dimensions?: number[];
}

/** A checked search. */
interface Search {
  words: string[];
  kind: Cc0Kind;
  source: Cc0Source | null;
  limit: number;
}

interface PolyHavenEntry {
  name?: unknown;
  tags?: unknown;
  categories?: unknown;
  download_count?: unknown;
  polycount?: unknown;
  dimensions?: unknown;
  authors?: unknown;
}

function invalid(detail: string): Cc0Error {
  return new Cc0Error(Cc0Refusal.ManifestInvalid, detail);
}

function checkedSearch(args: Record<string, unknown>): Search {
  if (typeof args.query !== "string" || args.query.trim() === "") throw invalid("query: the words to look for");
  const kind = args.kind ?? Cc0Kind.Texture;
  if (typeof kind !== "string" || !KINDS.has(kind)) throw invalid(`kind: one of ${[...KINDS].join(", ")}`);
  const source = args.source ?? null;
  const known = source === null || source === Cc0Source.PolyHaven || source === Cc0Source.AmbientCg;
  if (!known) throw invalid(`source: ${Cc0Source.PolyHaven} or ${Cc0Source.AmbientCg}`);
  const asked = typeof args.limit === "number" && Number.isInteger(args.limit) ? args.limit : DEFAULT_LIMIT;
  const words = args.query.toLowerCase().split(/\s+/).filter(Boolean);
  return {
    words,
    kind: kind as Cc0Kind,
    source: source as Cc0Source | null,
    limit: Math.min(Math.max(asked, 1), MAX_LIMIT),
  };
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

function polyHavenResult(id: string, entry: PolyHavenEntry, kind: Cc0Kind): Cc0Result {
  const result: Cc0Result = {
    source: Cc0Source.PolyHaven,
    id,
    name: typeof entry.name === "string" ? entry.name : id,
    kind,
    page: `https://polyhaven.com/a/${id}`,
    authors: Object.keys(typeof entry.authors === "object" && entry.authors !== null ? entry.authors : {}).sort(),
  };
  if (typeof entry.polycount === "number") result.polycount = entry.polycount;
  const dimensions = Array.isArray(entry.dimensions) ? entry.dimensions.filter((n) => typeof n === "number") : [];
  if (dimensions.length === 3) result.dimensions = dimensions.map((n) => Math.round(n));
  return result;
}

function matches(id: string, entry: PolyHavenEntry, words: readonly string[]): boolean {
  const text = [id, String(entry.name ?? ""), ...strings(entry.tags), ...strings(entry.categories)]
    .join(" ")
    .toLowerCase();
  return words.every((word) => text.includes(word));
}

const downloads = (entry: PolyHavenEntry) => (typeof entry.download_count === "number" ? entry.download_count : 0);

/** A searcher over `net` with its own list cache; `now` is injectable for the cache's clock. */
export function createSearch(net: Cc0Net, now: () => number = Date.now) {
  const lists = new Map<Cc0Kind, { at: number; entries: Record<string, PolyHavenEntry> }>();
  const polyHavenList = async (kind: Cc0Kind) => {
    const cached = lists.get(kind);
    if (cached && now() - cached.at < LIST_CACHE_MS) return cached.entries;
    const answer = await net.json(new URL(`https://api.polyhaven.com/assets?t=${POLYHAVEN_LIST[kind]}`));
    const entries = typeof answer === "object" && answer !== null ? (answer as Record<string, PolyHavenEntry>) : {};
    lists.set(kind, { at: now(), entries });
    return entries;
  };
  const polyHaven = async (search: Search): Promise<Cc0Result[]> => {
    const entries = Object.entries(await polyHavenList(search.kind)).filter(([id, entry]) =>
      matches(id, entry, search.words),
    );
    entries.sort(([a, x], [b, y]) => downloads(y) - downloads(x) || (a < b ? -1 : 1));
    return entries.slice(0, search.limit).map(([id, entry]) => polyHavenResult(id, entry, search.kind));
  };
  const ambient = async (search: Search): Promise<Cc0Result[]> => {
    const query = new URLSearchParams({ q: search.words.join(" "), type: "Material", sort: "Popular" });
    query.set("limit", String(search.limit));
    const answer = await net.json(new URL(`https://ambientcg.com/api/v2/full_json?${query}`));
    const found = (answer as { foundAssets?: unknown } | null)?.foundAssets;
    return (Array.isArray(found) ? found : [])
      .filter((item) => typeof item?.assetId === "string")
      .slice(0, search.limit)
      .map((item) => ({
        source: Cc0Source.AmbientCg,
        id: item.assetId as string,
        name: typeof item.displayName === "string" ? item.displayName : item.assetId,
        kind: Cc0Kind.Texture,
        page: `https://ambientcg.com/a/${item.assetId}`,
        authors: ["ambientCG"],
      }));
  };
  return async (args: Record<string, unknown>) => {
    const search = checkedSearch(args);
    const fromPolyHaven = search.source !== Cc0Source.AmbientCg;
    const fromAmbient = search.kind === Cc0Kind.Texture && search.source !== Cc0Source.PolyHaven;
    const results = [...(fromPolyHaven ? await polyHaven(search) : []), ...(fromAmbient ? await ambient(search) : [])];
    const credited = results.some((result) => result.source === Cc0Source.PolyHaven);
    return { results, ...(credited ? { credit: POLYHAVEN_CREDIT } : {}) };
  };
}
