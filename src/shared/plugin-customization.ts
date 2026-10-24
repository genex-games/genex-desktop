/** Bounded theme offers and one host-owned New Chat slot. Never executable CSS. */
import { PluginCapability, type PluginInfo } from "./plugins.ts";
import { contrastRatio } from "./color-contrast.ts";
import { COLOR_ROLES, type CorePalette } from "./theme-palette.ts";

/** Independent feature version, additive to plugin API 3. */
export const PLUGIN_CUSTOMIZATION_VERSION = 1;
/** Named operations accepted by the opaque panel bridge. */
export const CustomizationMethod = {
  Read: "customization.read",
  Set: "customization.set",
  Reset: "customization.reset",
} as const;
/** A theme may use the native core palette, without arbitrary CSS tokens. */
export { COLOR_ROLES as PLUGIN_COLOR_ROLES } from "./theme-palette.ts";
/** Pixel limits for native corner radii. Text size stays with Genex. */
export const PLUGIN_GEOMETRY = { buttonRadius: { min: 0, max: 24 }, cardRadius: { min: 0, max: 32 } } as const;
/** Optional native corner radii. */
export type PluginGeometry = Partial<Record<keyof typeof PLUGIN_GEOMETRY, number>>;
/** Existing local font stacks, without plugin-supplied URLs. */
export const PLUGIN_FONTS = {
  uiFont: ["studio", "system"],
  contentFont: ["inherit", "system", "serif", "mono"],
  codeFont: ["geist", "system"],
} as const;
/** Optional native font choices. */
export type PluginFonts = { [K in keyof typeof PLUGIN_FONTS]?: (typeof PLUGIN_FONTS)[K][number] };
/** The plugin offers both schemes; the person's light/dark choice remains in charge. */
export interface PluginTheme {
  name: string;
  light: CorePalette;
  dark: CorePalette;
  geometry: PluginGeometry;
  fonts: PluginFonts;
}
/** One reference to this plugin's declared settings panel, inside the host's labelled box. */
export interface NewChatPanel {
  panel: string;
  height: number;
}
/** An offered theme is inactive until selected in Appearance. No free placement or backgrounds. */
export interface PluginCustomization {
  version: 1;
  theme?: PluginTheme;
  newChat?: NewChatPanel;
}
/** The panel content height, excluding the host-owned source label. */
export const NEW_CHAT_PANEL_HEIGHT = { min: 96, max: 240 } as const;
/** WCAG AA floor for normal text; controls have a separate non-text floor. */
export const PLUGIN_THEME_CONTRAST = { text: 4.5, control: 3 } as const;
const NAME_MAX = 64;
const PANEL_ID = /^[a-z][a-z0-9-]{0,47}$/;
const TEXT_ROLES = ["foreground", "muted", "accent", "success", "warning", "danger"] as const;
const SURFACE_ROLES = ["background", "surface", "sidebar", "popover", "field", "hover"] as const;
const MESSAGE = {
  Invalid: "Invalid UI customization profile",
  Version: "Unsupported UI customization profile version",
  Contrast: (scheme: string, text: string, surface: string, floor: number) =>
    `Plugin theme ${scheme}: ${text} on ${surface} must have at least ${floor}:1 contrast`,
} as const;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(MESSAGE.Invalid);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(MESSAGE.Invalid);
  return value as Record<string, unknown>;
}
function onlyKeys(raw: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error(MESSAGE.Invalid);
}
function fonts(value: unknown): PluginFonts {
  const raw = value === undefined ? {} : object(value);
  onlyKeys(raw, Object.keys(PLUGIN_FONTS));
  const result: Record<string, string> = {};
  for (const [key, choices] of Object.entries(PLUGIN_FONTS)) {
    if (!Object.hasOwn(raw, key)) continue;
    const selected = choices.find((choice) => choice === raw[key]);
    if (!selected) throw new Error(MESSAGE.Invalid);
    result[key] = selected;
  }
  return result;
}
function geometry(value: unknown): PluginGeometry {
  const raw = value === undefined ? {} : object(value);
  onlyKeys(raw, Object.keys(PLUGIN_GEOMETRY));
  const result: PluginGeometry = {};
  for (const key of Object.keys(PLUGIN_GEOMETRY) as (keyof PluginGeometry)[]) {
    if (!Object.hasOwn(raw, key)) continue;
    const n = raw[key],
      bounds = PLUGIN_GEOMETRY[key];
    const valid = typeof n === "number" && Number.isFinite(n) && n >= bounds.min && n <= bounds.max;
    if (!valid) throw new Error(MESSAGE.Invalid);
    result[key] = n;
  }
  return result;
}
function palette(value: unknown, scheme: string): CorePalette {
  const raw = object(value);
  onlyKeys(raw, COLOR_ROLES);
  const result = {} as CorePalette;
  for (const role of COLOR_ROLES) {
    const color = raw[role];
    if (typeof color !== "string" || color.length !== 7 || !/^#[0-9a-f]{6}$/i.test(color))
      throw new Error(MESSAGE.Invalid);
    result[role] = color.toLowerCase();
  }
  for (const surface of SURFACE_ROLES) {
    for (const role of TEXT_ROLES) {
      if (contrastRatio(result[role], result[surface]) < PLUGIN_THEME_CONTRAST.text)
        throw new Error(MESSAGE.Contrast(scheme, role, surface, PLUGIN_THEME_CONTRAST.text));
    }
    if (contrastRatio(result.controlBorder, result[surface]) < PLUGIN_THEME_CONTRAST.control)
      throw new Error(MESSAGE.Contrast(scheme, "controlBorder", surface, PLUGIN_THEME_CONTRAST.control));
  }
  return result;
}
function theme(value: unknown): PluginTheme {
  const raw = object(value);
  onlyKeys(raw, ["name", "light", "dark", "geometry", "fonts"]);
  if (
    typeof raw.name !== "string" ||
    !raw.name.trim() ||
    raw.name.length > NAME_MAX ||
    /[\x00-\x1f\x7f]/.test(raw.name)
  )
    throw new Error(MESSAGE.Invalid);
  return {
    name: raw.name.trim(),
    light: palette(raw.light, "light"),
    dark: palette(raw.dark, "dark"),
    geometry: geometry(raw.geometry),
    fonts: fonts(raw.fonts),
  };
}
function newChat(value: unknown): NewChatPanel {
  const raw = object(value);
  onlyKeys(raw, ["panel", "height"]);
  if (typeof raw.panel !== "string" || !PANEL_ID.test(raw.panel)) throw new Error(MESSAGE.Invalid);
  const height = raw.height;
  const valid =
    typeof height === "number" &&
    Number.isInteger(height) &&
    height >= NEW_CHAT_PANEL_HEIGHT.min &&
    height <= NEW_CHAT_PANEL_HEIGHT.max;
  if (!valid) throw new Error(MESSAGE.Invalid);
  return { panel: raw.panel, height };
}
/** Validate the entire offer before saving; omitted sections withdraw the previous offers. */
export function parsePluginCustomization(value: unknown): PluginCustomization {
  const raw = object(value);
  onlyKeys(raw, ["version", "theme", "newChat"]);
  if (raw.version !== PLUGIN_CUSTOMIZATION_VERSION) throw new Error(MESSAGE.Version);
  return {
    version: PLUGIN_CUSTOMIZATION_VERSION,
    ...(raw.theme === undefined ? {} : { theme: theme(raw.theme) }),
    ...(raw.newChat === undefined ? {} : { newChat: newChat(raw.newChat) }),
  };
}
/** Enabled, listed providers with permission to offer customization. */
export function customizationProviders<
  T extends Pick<PluginInfo, "enabled" | "removed" | "unlisted" | "manifest" | "customization">,
>(plugins: readonly T[]): T[] {
  return plugins.filter(
    (p) =>
      p.enabled &&
      !p.removed &&
      !p.unlisted &&
      p.customization &&
      p.manifest.capabilities.includes(PluginCapability.UiCustomization),
  );
}
