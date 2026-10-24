/**
 * Every language's translations, each loaded only when chosen: in the renderer each catalog is a
 * chunk of its own, so a window reads one language, never all eight.
 */
import type { Catalog } from "../i18n.ts";
import { Locale } from "../locale.ts";

const LOADERS: Record<Locale, () => Promise<{ default: Catalog }>> = {
  [Locale.English]: async () => ({ default: {} }),
  [Locale.Russian]: () => import("./ru.ts"),
  [Locale.Spanish]: () => import("./es.ts"),
  [Locale.PortugueseBrazil]: () => import("./pt-BR.ts"),
  [Locale.German]: () => import("./de.ts"),
  [Locale.French]: () => import("./fr.ts"),
  [Locale.Japanese]: () => import("./ja.ts"),
  [Locale.Korean]: () => import("./ko.ts"),
  [Locale.ChineseSimplified]: () => import("./zh-Hans.ts"),
};

/** One language's translations; English has none, its messages are the code's own words. */
export async function loadCatalog(locale: Locale): Promise<Catalog> {
  return (await LOADERS[locale]()).default;
}
