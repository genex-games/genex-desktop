/** Theme offers follow plugin lifecycle; selection belongs only to Appearance. */
import { useEffect, useMemo } from "react";
import { customizationProviders, parsePluginCustomization } from "../../shared/plugin-customization.ts";
import { usePlugins } from "../state/hooks.ts";
import { setPluginThemes } from "./store.ts";
/** Mount once in the shell; withdrawing an offer restores the person's built-in appearance. */
export function PluginCustomizationHost() {
  const data = usePlugins((state) =>
    JSON.stringify(
      customizationProviders(state.list).map((p) => ({ id: p.manifest.id, theme: p.customization?.theme })),
    ),
  );
  const offers = useMemo(() => {
    const entries: { id: string; theme?: unknown }[] = JSON.parse(data);
    return entries.flatMap((entry) => {
      try {
        const theme = parsePluginCustomization({ version: 1, theme: entry.theme }).theme;
        return theme ? [{ id: entry.id, theme }] : [];
      } catch {
        return [];
      }
    });
  }, [data]);
  useEffect(() => {
    setPluginThemes(offers);
    return () => setPluginThemes([]);
  }, [offers]);
  return null;
}
