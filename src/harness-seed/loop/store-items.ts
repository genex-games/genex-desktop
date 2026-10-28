/**
 * What a build sells in its game's Genex store: each thing the user prices in Nex (Genex's
 * currency), named by the chat at the launch (`store_items`, tools/game-tools.ts). The run's scope
 * carries them (`storeScopeItems`), which scope-prompts.ts shows every agent that reads the goal, so
 * no plan can cut them; the build draws each item's picture and lists it with `genex__cli shop add`,
 * which refuses an item without one. Any agent lists or changes items that way at any time, so a
 * launch is never the only moment. Coins, gold or gems are a currency the game keeps itself and
 * never come here.
 *
 * A new module, so a kept older sibling can never shadow these names.
 */
import { isPlainRecord } from "./json.ts";

/** The most items one launch names. */
export const STORE_ITEMS_MAX = 12;
/** The longest name one item keeps. */
const NAME_CHARS = 80;
/** The longest description one item keeps: what genex.games keeps. */
const DESCRIPTION_CHARS = 1000;
/** The longest description an item keeps in the scope every agent reads. */
const SCOPE_DESCRIPTION_CHARS = 200;
/** The price an item gets when the user named none: the store grid's first step. */
export const DEFAULT_ITEM_PRICE = 100;
/**
 * The store's default grid of paid prices in Nex (0 is Free): genex.games refuses any other
 * (`price_off_grid`) when a draft goes up, so a named price takes the nearest step.
 */
const PRICE_GRID = [100, 300, 800, 1200, 5000, 20000, 50000] as const;

/** What a store item is once bought: kept (a class, a skin, a rod), or used up. Wire values. */
export const StoreItemType = { Durable: "durable", Consumable: "consumable" } as const;
export type StoreItemType = (typeof StoreItemType)[keyof typeof StoreItemType];

/** One thing the user sells for Nex: its name, its price in whole Nex, whether it is kept, and what it is. */
export interface StoreItem {
  name: string;
  price: number;
  type: StoreItemType;
  description?: string;
}

const MESSAGE = {
  launched: (names: string) =>
    `${names} will be on the Shop tab, each with its picture, as soon as the build draws it. Ask me to change any of them at any time.`,
} as const;

/** One line of text, its whitespace folded, clipped to `max`; '' for anything else. */
function oneLine(value: unknown, max: number): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
}

/** The grid's step nearest `price` by ratio (a tie takes the higher one): 10 is 100, 500 is 800. */
function gridPrice(price: number): number {
  const distance = (step: number) => Math.abs(Math.log(step / price));
  return PRICE_GRID.reduce((best, step) => (distance(step) <= distance(best) ? step : best));
}

/** A price in whole Nex as a model sends it (a number or its digits) on the store's grid; the default for anything else. */
function priceOf(value: unknown): number {
  const price = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof price !== "number" || !Number.isInteger(price) || price < 0) return DEFAULT_ITEM_PRICE;
  return price === 0 ? 0 : gridPrice(price);
}

/** One item a launch named, or null when it has no name. */
function storeItemOf(entry: unknown): StoreItem | null {
  if (!isPlainRecord(entry)) return null;
  const name = oneLine(entry.name, NAME_CHARS);
  if (!name) return null;
  const description = oneLine(entry.description, DESCRIPTION_CHARS);
  const type = entry.type === StoreItemType.Consumable ? StoreItemType.Consumable : StoreItemType.Durable;
  return { name, price: priceOf(entry.price), type, ...(description ? { description } : {}) };
}

/** The list a model sent: an array, or that array as JSON text (an engine that sends every field as a string). */
function listOf(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** A launch's `store_items`: each named item once (names compared without case), at most `STORE_ITEMS_MAX`. */
export function storeItemsOf(value: unknown): StoreItem[] {
  const list = listOf(value);
  if (!Array.isArray(list)) return [];
  const items: StoreItem[] = [];
  for (const entry of list) {
    const item = storeItemOf(entry);
    const named = item && items.some((kept) => kept.name.toLowerCase() === item.name.toLowerCase());
    if (item && !named) items.push(item);
  }
  return items.slice(0, STORE_ITEMS_MAX);
}

/** The items as the run's scope keeps them: one line each, with what `shop add` needs to list it. */
export function storeScopeItems(items: readonly StoreItem[]): string[] {
  return items.map((item) => {
    const sold = `${item.name} for ${item.price} Nex, ${item.type}`;
    const description = item.description?.slice(0, SCOPE_DESCRIPTION_CHARS);
    return description ? `${sold}: ${description}` : sold;
  });
}

/** What the chat tells the user at a launch that sells items; '' when it sells none. */
export function storeLaunchWords(items: readonly StoreItem[]): string {
  return items.length ? MESSAGE.launched(items.map((item) => item.name).join(", ")) : "";
}
