/**
 * `cc0__search`: Poly Haven's asset lists (cached for an hour per kind, as their API asks clients
 * to be gentle) ranked by the query's words, and ambientCG's own search for materials. A result
 * names its source and id, which is what `cc0__fetch` takes.
 *
 * Ranking (WP-0): any word may match, so "snow ground" still finds snow and ground textures. A word
 * matches a whole word of the asset's id, name, tags or categories, a plural its singular, never part
 * of one ("fir" is not "fire"). Results that match more of the query's words come first, then those
 * whose id or name holds them over those whose tags do, then the most downloaded. A model result
 * carries its triangles and how they stand against the import cap, with a hint to decimate past it.
 */
import { HOUR_MS } from "../../shared/duration.ts";
import {
  MODEL_IMPORT_TRIANGLES,
  MODEL_TIER_TRIANGLES,
  ModelBudgetFit,
  modelBudgetFit,
} from "../../shared/model-budget.ts";
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
  /** A model's triangles (Poly Haven's polycount counts triangles). */
  triangles?: number;
  /** How a model's triangles stand against the import cap. */
  budget?: ModelBudgetFit;
  /** Past the cap: what to do about it. */
  hint?: string;
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

const MESSAGE = {
  OverImportCap: (triangles: number) =>
    `${triangles} triangles, over the ${MODEL_IMPORT_TRIANGLES} import cap: fetch it with cc0__fetch tier ` +
    `(${Object.entries(MODEL_TIER_TRIANGLES)
      .map(([tier, budget]) => `${tier} ${budget}`)
      .join(", ")}) and it arrives decimated to that budget; LODs and the impostor build from there.`,
} as const;

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
  if (typeof entry.polycount === "number") {
    result.polycount = entry.polycount;
    result.triangles = entry.polycount;
    result.budget = modelBudgetFit(entry.polycount);
    if (result.budget === ModelBudgetFit.OverImportCap) result.hint = MESSAGE.OverImportCap(entry.polycount);
  }
  const dimensions = Array.isArray(entry.dimensions) ? entry.dimensions.filter((n) => typeof n === "number") : [];
  if (dimensions.length === 3) result.dimensions = dimensions.map((n) => Math.round(n));
  return result;
}

/** The singular lowercase words of `texts`: runs of letters and digits ("collection: pine_forest" → collection, pine, forest). */
const wordsOf = (texts: readonly string[]): Set<string> =>
  new Set(
    texts
      .flatMap((text) => text.toLowerCase().split(/[^a-z0-9]+/))
      .filter(Boolean)
      .map(singular),
  );

/** A word's singular: "trees" → tree, "boxes" → box, "glass" stays. */
function singular(word: string): string {
  if (/(?:x|ch|sh)es$/.test(word)) return word.slice(0, -2);
  return word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** How well an entry matches: the query's words it holds anywhere, and those its id or name holds. */
interface Rank {
  matched: number;
  named: number;
}

function rank(id: string, entry: PolyHavenEntry, words: readonly string[]): Rank {
  const named = wordsOf([id, String(entry.name ?? "")]);
  const tagged = wordsOf([...strings(entry.tags), ...strings(entry.categories)]);
  const rank: Rank = { matched: 0, named: 0 };
  for (const word of words.map(singular)) {
    if (named.has(word)) rank.named++;
    if (named.has(word) || tagged.has(word)) rank.matched++;
  }
  return rank;
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
    const ranked = Object.entries(await polyHavenList(search.kind))
      .map(([id, entry]) => ({ id, entry, rank: rank(id, entry, search.words) }))
      .filter((row) => row.rank.matched > 0);
    ranked.sort(
      (a, b) =>
        b.rank.matched - a.rank.matched ||
        b.rank.named - a.rank.named ||
        downloads(b.entry) - downloads(a.entry) ||
        (a.id < b.id ? -1 : 1),
    );
    return ranked.slice(0, search.limit).map((row) => polyHavenResult(row.id, row.entry, search.kind));
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
