/** Customization crosses only the panel's own identity, never an id supplied by a message. */
import { CustomizationMethod } from "../../shared/plugin-customization.ts";
import { PluginCapability, type PluginInfo } from "../../shared/plugins.ts";
import type { StudioApi } from "../../shared/studio-api.ts";
const MESSAGE = {
  Permission: "UI customization capability required on an enabled plugin",
  Unsupported: "Unsupported customization operation",
} as const;

/** Whether the method belongs to the versioned customization panel API. */
export function isCustomizationRequest(method: unknown): boolean {
  return Object.values(CustomizationMethod).some((known) => known === method);
}
/** The renderer rejects unpermitted requests before IPC; the registry checks again before saving. */
export async function answerCustomizationRequest(
  method: unknown,
  args: unknown,
  plugin: PluginInfo,
  api: Pick<StudioApi, "pluginCustomization" | "pluginSetCustomization">,
  id: string,
): Promise<unknown> {
  const permitted =
    plugin.manifest.id === id &&
    plugin.enabled &&
    !plugin.removed &&
    !plugin.unlisted &&
    plugin.manifest.capabilities.includes(PluginCapability.UiCustomization);
  if (!permitted) throw new Error(MESSAGE.Permission);
  if (method === CustomizationMethod.Read) return await api.pluginCustomization(id);
  if (method === CustomizationMethod.Set) return await api.pluginSetCustomization(id, args);
  if (method === CustomizationMethod.Reset) return await api.pluginSetCustomization(id, null);
  throw new Error(MESSAGE.Unsupported);
}
