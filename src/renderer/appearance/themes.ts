/** Profile-local appearance data. No CSS, scripts, extensions or file includes are evaluated. */
import { t } from "../../shared/i18n.ts";
import { channels, fromOklch, oklch, rgbHex } from "../../shared/oklch.ts";
/** A colour scheme: every theme has a light side and a dark side. */
export const Scheme = {
  Light: "light",
  Dark: "dark",
} as const;
export type Scheme = (typeof Scheme)[keyof typeof Scheme];
/** Which scheme the app shows: one of them, or whichever the system is in. */
export const AppearanceMode = {
  System: "system",
  Light: Scheme.Light,
  Dark: Scheme.Dark,
} as const;
export type AppearanceMode = (typeof AppearanceMode)[keyof typeof AppearanceMode];
export const COLOR_ROLES = [
  "background",
  "foreground",
  "surface",
  "sidebar",
  "popover",
  "field",
  "hover",
  "muted",
  "border",
  "controlBorder",
  "accent",
  "success",
  "warning",
  "danger",
] as const;
export type ColorRole = (typeof COLOR_ROLES)[number];
/**
 * Play's tinted families (people.css): the profile chips and edit button, the tint buttons (Invite,
 * Join, Copy), the credits card and the invite card, each a hue the stylesheet mixes into its fill and
 * edge. Unset, each wears the Play / Create switch's selected blue, the credits card the chips' hue.
 */
export const PLAY_HUE_ROLES = ["peopleChip", "peopleTint", "creditsCard", "inviteCard"] as const;
export type PlayHueRole = (typeof PLAY_HUE_ROLES)[number];
/**
 * Play's people, stats and credits colours set by name (people.css): the chips' label and number, the
 * primary button, genex.games' blue, playing now, Pro, the request count, the stats' line and changes,
 * and the credit shard. Unset, each keeps the stylesheet's own colour for the scheme.
 */
export const PEOPLE_ROLES = [
  "peopleChipText",
  "peopleChipNumber",
  "playBlue",
  "peoplePrimary",
  "peoplePrimaryShade",
  "peopleLive",
  "peopleLiveText",
  "peoplePro",
  "peopleRequest",
  "statsLine",
  "statsUp",
  "statsDown",
  "shardLight",
  "shardMid",
  "shardDark",
] as const;
export type PeopleRole = (typeof PEOPLE_ROLES)[number];
/** Roles a palette may set or leave to the app, which derives each from the core roles until it is set. */
export const DETAIL_ROLES = [
  "accentFill",
  "accentHover",
  "accentText",
  "icon",
  "iconSelected",
  "logo",
  "logoShade",
  "graph",
  "art",
  "artPaper",
  "artMark",
  "artButton",
  "controlFill",
  "promptChipFill",
  "controlHover",
  "controlText",
  "controlTextHover",
  "chipHover",
  "sidebarSelected",
  "sidebarHover",
  "well",
  "thumb",
  "meterTrack",
  "meterFill",
  "meterHigh",
  "meterFull",
  "promptEdge",
  "viewSwitch",
  "playSelected",
  "playSelectedEdge",
  "playTrack",
  "playTrackEdge",
  "playSelectedText",
  "playTab",
  "playTabEdge",
  "playTabText",
  "playSearchFocus",
  "wireArt",
  "hatch",
  "hatchGround",
  "settingsTab",
  ...PLAY_HUE_ROLES,
  ...PEOPLE_ROLES,
] as const;
export type DetailRole = (typeof DETAIL_ROLES)[number];
/** Every role a palette can carry: the core ones, then the details. */
export const ALL_ROLES: readonly (ColorRole | DetailRole)[] = [...COLOR_ROLES, ...DETAIL_ROLES];
export type AnyRole = ColorRole | DetailRole;
/** The places a preset may give its own shadow; unset, each keeps the one theme.css draws. */
export const SHADOW_PLACES = ["panel", "promptBar", "thumb"] as const;
export type ShadowPlace = (typeof SHADOW_PLACES)[number];
/** One drop shadow: offset down, blur and spread in px, and its colour at an opacity of 0–100. */
export type Shadow = { y: number; blur: number; spread: number; color: string; alpha: number };
export type Shadows = Partial<Record<ShadowPlace, Shadow>>;
/** What a preset sets beyond its core roles: the details it does not leave to the app, and its shadows. */
export type Details = Partial<Record<DetailRole, string>> & { shadows?: Shadows };
export type Palette = Record<ColorRole, string> & Details;
/** The core role each detail is derived from: a settings override of it re-derives the detail. */
const DETAIL_SOURCE: Record<DetailRole, ColorRole> = {
  accentFill: "accent",
  accentHover: "accent",
  accentText: "accent",
  icon: "muted",
  iconSelected: "accent",
  logo: "foreground",
  logoShade: "foreground",
  graph: "accent",
  art: "accent",
  artPaper: "foreground",
  artMark: "foreground",
  artButton: "accent",
  controlFill: "hover",
  promptChipFill: "hover",
  controlHover: "hover",
  controlText: "muted",
  controlTextHover: "foreground",
  chipHover: "controlBorder",
  sidebarSelected: "sidebar",
  sidebarHover: "sidebar",
  well: "background",
  thumb: "controlBorder",
  meterTrack: "hover",
  meterFill: "muted",
  meterHigh: "warning",
  meterFull: "danger",
  promptEdge: "border",
  viewSwitch: "accent",
  playSelected: "accent",
  playSelectedEdge: "accent",
  playTrack: "hover",
  playTrackEdge: "controlBorder",
  playSelectedText: "foreground",
  playTab: "background",
  playTabEdge: "border",
  playTabText: "muted",
  playSearchFocus: "controlBorder",
  wireArt: "accent",
  hatch: "foreground",
  hatchGround: "background",
  settingsTab: "accent",
  peopleChip: "accent",
  peopleTint: "accent",
  creditsCard: "accent",
  inviteCard: "accent",
  peopleChipText: "accent",
  peopleChipNumber: "accent",
  playBlue: "accent",
  peoplePrimary: "accent",
  peoplePrimaryShade: "accent",
  peopleLive: "success",
  peopleLiveText: "success",
  peoplePro: "accent",
  peopleRequest: "accent",
  statsLine: "accent",
  statsUp: "success",
  statsDown: "danger",
  shardLight: "accent",
  shardMid: "accent",
  shardDark: "accent",
};
/** The variable each place-dependent detail is drawn as; unset, theme.css falls back per place. */
const PLACE_VARIABLE: Partial<Record<DetailRole, string>> = {
  icon: "--icon",
  iconSelected: "--icon-selected",
  logo: "--logo",
  graph: "--graph",
  art: "--art",
  artPaper: "--art-paper",
  artMark: "--art-mark",
  artButton: "--art-button",
  controlFill: "--control-fill",
  promptChipFill: "--prompt-chip-fill",
  controlHover: "--control-hover",
  controlText: "--control-text",
  controlTextHover: "--control-text-hover",
  chipHover: "--chip-hover",
  sidebarSelected: "--sidebar-selected",
  sidebarHover: "--sidebar-hover",
  well: "--well",
  thumb: "--thumb",
  meterTrack: "--meter-track",
  meterFill: "--meter-fill",
  meterHigh: "--meter-high",
  meterFull: "--meter-full",
  promptEdge: "--prompt-edge",
  viewSwitch: "--switch-fill",
  playSelected: "--play-selected",
  playSelectedEdge: "--play-selected-edge",
  playTrack: "--play-switch-track",
  playTrackEdge: "--play-switch-edge",
  playSelectedText: "--play-selected-text",
  playTab: "--play-tab-backing",
  playTabEdge: "--play-tab-edge",
  playTabText: "--play-tab-text",
  playSearchFocus: "--play-search-focus",
  wireArt: "--wire-art",
  hatch: "--hatch-stripe",
  hatchGround: "--hatch-ground",
  settingsTab: "--settings-tab",
  peopleChip: "--people-chip-hue",
  peopleTint: "--people-tint-hue",
  creditsCard: "--credits-card-hue",
  inviteCard: "--people-invite-hue",
  peopleChipText: "--people-chip-ink",
  peopleChipNumber: "--people-chip-number",
  playBlue: "--play-blue",
  peoplePrimary: "--people-primary-top",
  peoplePrimaryShade: "--people-primary-bottom",
  peopleLive: "--people-live",
  peopleLiveText: "--people-live-ink",
  peoplePro: "--people-pro",
  peopleRequest: "--people-request",
  statsLine: "--stats-line",
  statsUp: "--stats-up",
  statsDown: "--stats-down",
  shardLight: "--shard-light",
  shardMid: "--shard-mid",
  shardDark: "--shard-dark",
};
/** The variable each shadow is drawn as; unset, theme.css keeps the place's own. */
const SHADOW_VARIABLE: Record<ShadowPlace, string> = {
  panel: "--panel-shadow",
  promptBar: "--prompt-shadow",
  thumb: "--thumb-shadow",
};
/** The range each shadow measure is kept in. */
const SHADOW_RANGE: Record<Exclude<keyof Shadow, "color">, [number, number]> = {
  y: [-64, 64],
  blur: [0, 128],
  spread: [-64, 64],
  alpha: [0, 100],
};
export type ThemePreset = { id: string; name: string; scheme: Scheme; colors: Palette; contrast?: number };
export type ThemeSelection = { preset: string; overrides: Partial<Palette>; contrast: number };
export type Appearance = {
  version: 1;
  mode: AppearanceMode;
  light: ThemeSelection;
  dark: ThemeSelection;
  uiFont: "studio" | "system";
  contentFont: "inherit" | "system" | "serif" | "mono";
  codeFont: "geist" | "system";
  saved: ThemePreset[];
};

function preset(id: string, name: string, scheme: Scheme, values: string[], details: Details = {}): ThemePreset {
  // Every preset lists one colour per core role, in COLOR_ROLES order; appearance.test.ts checks each is a hex.
  const core = Object.fromEntries(COLOR_ROLES.map((key, i) => [key, values[i] ?? ""])) as Record<ColorRole, string>;
  return { id: `${id}-${scheme}`, name, scheme, colors: { ...core, ...details } };
}
// Palette adaptations, not editor theme replicas. Sources and licenses: design/genex/THEMES.md.
// Dark palettes share one OKLCH lightness ramp from the canvas: sidebar -2.6, surface +3, menu +4.8,
// field +6, hover +8.5, divider +5.6, control edge +11.2. Each family keeps its own hue, text and accent.
// Order: canvas, text, surface, sidebar, menu, field, hover, muted text, divider, control edge, accent, success, warning, error.
export const PRESETS: ThemePreset[] = [
  preset(
    "genex",
    "Genex",
    Scheme.Dark,
    [
      "#0f0f10",
      "#ecf0f3",
      "#151516",
      "#0d0d0e",
      "#19191a",
      "#232425",
      "#222324",
      "#a8a9ac",
      "#1b1b1b",
      "#333336",
      "#4759c2",
      "#7cd194",
      "#efbe72",
      "#f08287",
    ],
    {
      icon: "#939393",
      iconSelected: "#5474d0",
      logo: "#ffffff",
      logoShade: "#efefef",
      graph: "#4d7fd6",
      art: "#6c80be",
      artPaper: "#1b1a1b",
      promptEdge: "#292929",
      playSelected: "#2454d2",
      playSelectedEdge: "#24304e",
      playTrack: "#141417",
      playTrackEdge: "#1f2021",
      playTab: "#0d0d0e",
      playTabEdge: "#232325",
      peopleChip: "#4169d1",
      inviteCard: "#4160b1",
      peopleChipText: "#e3e6f4",
      peopleChipNumber: "#d8ddf4",
      peoplePrimaryShade: "#1a34b5",
    },
  ),
  preset(
    "genex",
    "Genex",
    Scheme.Light,
    [
      "#f9faf9",
      "#101112",
      "#ffffff",
      "#f9faf9",
      "#ffffff",
      "#f1f1f1",
      "#ebedef",
      "#8d8e8e",
      "#eaeaea",
      "#c6c7c9",
      "#3f61f5",
      "#249f56",
      "#dfa04a",
      "#ba3441",
    ],
    {
      accentFill: "#3f61f5",
      accentHover: "#3c70e9",
      accentText: "#ffffff",
      icon: "#5e75d7",
      iconSelected: "#2a49d2",
      logo: "#0c0c0c",
      logoShade: "#12295d",
      graph: "#738cf6",
      art: "#91a1e7",
      artPaper: "#f6f6f6",
      artMark: "#fefeff",
      artButton: "#e8e9ec",
      controlFill: "#f0f0f0",
      promptChipFill: "#f4f4f4",
      controlText: "#3f3f3f",
      controlTextHover: "#303030",
      chipHover: "#ececec",
      sidebarSelected: "#ecedee",
      sidebarHover: "#f0f2f3",
      well: "#efefef",
      thumb: "#ffffff",
      meterFill: "#b6b6b6",
      meterHigh: "#f1cb46",
      meterFull: "#d13c4a",
      promptEdge: "#e9e9ea",
      playSelected: "#1661d9",
      playSelectedEdge: "#cadbf6",
      playTrack: "#ffffff",
      playTrackEdge: "#ebebeb",
      playTab: "#ffffff",
      playTabEdge: "#f1f1f1",
      wireArt: "#a2abd5",
      peopleChip: "#bfbfbf",
      peopleTint: "#c3d5ff",
      creditsCard: "#b1c3e6",
      inviteCard: "#a9b8d9",
      peopleChipText: "#3f61b2",
      peopleChipNumber: "#3a5ace",
      peoplePrimary: "#5b84e3",
      peoplePrimaryShade: "#4561e4",
      shadows: {
        panel: { y: 17, blur: 40, spread: -10, color: "#000000", alpha: 0 },
        promptBar: { y: 3, blur: 8, spread: 0, color: "#000000", alpha: 3 },
        thumb: { y: 1, blur: 2, spread: 0, color: "#000000", alpha: 0 },
      },
    },
  ),
  preset("tokyo", "Tokyo Night", Scheme.Dark, [
    "#1a1b26",
    "#c0caf5",
    "#20222e",
    "#16161e",
    "#252632",
    "#282935",
    "#2d303d",
    "#9aa5ce",
    "#272834",
    "#343644",
    "#7aa2f7",
    "#9ece6a",
    "#e0af68",
    "#f7768e",
  ]),
  preset("tokyo", "Tokyo Night", Scheme.Light, [
    "#e7e9f2",
    "#343b58",
    "#f2f3f8",
    "#dfe1ea",
    "#f4f5f9",
    "#e1e2eb",
    "#dbdde6",
    "#555972",
    "#d3d5dd",
    "#c2c4cc",
    "#2856c4",
    "#3d6726",
    "#82520c",
    "#b3214a",
  ]),
  preset("catppuccin", "Catppuccin", Scheme.Dark, [
    "#1e1e2e",
    "#cdd6f4",
    "#252536",
    "#181825",
    "#2a2a3a",
    "#2c2d3d",
    "#313244",
    "#a6adc8",
    "#2b2c3c",
    "#45475a",
    "#cba6f7",
    "#a6e3a1",
    "#f9e2af",
    "#f38ba8",
  ]),
  preset("catppuccin", "Catppuccin", Scheme.Light, [
    "#eff1f5",
    "#4c4f69",
    "#f7f8fa",
    "#e6e9ef",
    "#fbfbfc",
    "#e8eaef",
    "#dce0e8",
    "#5c5f77",
    "#dbdde1",
    "#bcc0cc",
    "#7d33e0",
    "#2f6d1e",
    "#835208",
    "#bb0d34",
  ]),
  preset("rose", "Rosé Pine", Scheme.Dark, [
    "#191724",
    "#e0def4",
    "#1f1d2e",
    "#13111f",
    "#242231",
    "#26233a",
    "#2d2b3c",
    "#a8a4c0",
    "#262433",
    "#343243",
    "#c4a7e7",
    "#9ccfd8",
    "#f6c177",
    "#eb6f92",
  ]),
  preset("rose", "Rosé Pine", Scheme.Light, [
    "#faf4ed",
    "#575279",
    "#fffaf3",
    "#f2ece5",
    "#fffaf3",
    "#f2e9e1",
    "#eee8e1",
    "#625e7c",
    "#e5e0d9",
    "#d4cec8",
    "#735e91",
    "#286983",
    "#8c560b",
    "#a14b66",
  ]),
  preset("github", "GitHub", Scheme.Dark, [
    "#0d1117",
    "#e6edf3",
    "#13181e",
    "#080b11",
    "#171c22",
    "#1a1f25",
    "#20252c",
    "#9198a1",
    "#191e24",
    "#262b33",
    "#4493f8",
    "#3fb950",
    "#d29922",
    "#f85149",
  ]),
  preset("github", "GitHub", Scheme.Light, [
    "#ffffff",
    "#1f2328",
    "#ffffff",
    "#f6f8fa",
    "#ffffff",
    "#f6f8fa",
    "#eef1f4",
    "#59636e",
    "#d1d9e0",
    "#c3ccd6",
    "#0969da",
    "#197434",
    "#875b00",
    "#d1242f",
  ]),
];
/** The most custom presets an appearance keeps. */
export const MAX_SAVED_PRESETS = 24;
/** The longest preset or imported theme name kept. */
export const PRESET_NAME_MAX = 48;
/** The largest theme file an import reads (128 KB). */
export const THEME_FILE_MAX_BYTES = 128 * 1024;

/** What a theme import that cannot be read tells the person, and the one build defect it can hit. */
const MESSAGE = {
  presetMissing: (scheme: Scheme) => `The ${scheme} Genex preset is missing.`,
  unclosedComment: t("Close the unfinished JSON comment."),
  newerFormat: t("This theme uses a newer format. Choose a version 1 theme."),
  notOpaqueToken: (role: string) => t("Use an opaque sRGB color token for {role}.", { role }),
  includesFile: t("This theme includes another file. Export its resolved colors from VS Code first."),
  notHex: (key: string) => t("Use a hex color for {key}.", { key }),
  tooLarge: t("Choose a theme smaller than 128 KB."),
  notJson: t("Use a valid JSON or JSONC theme file."),
  noColors: t("No supported UI colors found. Choose a Genex token file or a VS Code color theme."),
} as const;
/** The contrast a theme starts at: its palette as designed. */
export const DEFAULT_CONTRAST = 50;
/** The contrast slider's range. */
export const CONTRAST_MAX = 100;
/** WCAG AA contrast for body text. */
export const WCAG_AA_TEXT = 4.5;
/** The contrast an accent button's fill keeps under white text: a little above AA. */
const ACCENT_FILL_CONTRAST = 5;
/** How many halvings find the lightest fill white text still reads on. */
const LIGHTNESS_BISECTIONS = 24;
/** The hover's lightness steps, and how far it may lighten at most. */
const HOVER_STEP = 0.005;
const HOVER_MAX_LIFT = 0.06;
/** A hand-set button fill's hover: this much lighter in OKLCH, or darker once the fill is this light. */
const SET_FILL_HOVER_SHIFT = 0.04;
const SET_FILL_DARKENS_ABOVE = 0.85;
/** How many steps a colour takes toward black or white to become readable. */
const READABLE_STEPS = 100;
/** The luminance above which a background reads as light. */
const LIGHT_BACKGROUND = 0.4;
/** How vivid a dark theme's destructive fill may be in OKLCH: a deep red, never a neon one. */
const DARK_DANGER_CHROMA = 0.15;
/** Every custom preset's id starts with this. */
export const CUSTOM_PRESET_PREFIX = "custom-";
/** The appearance modes, in the order Settings offers them. */
export const APPEARANCE_MODES: readonly AppearanceMode[] = [
  AppearanceMode.System,
  AppearanceMode.Light,
  AppearanceMode.Dark,
];
const SCHEMES: readonly Scheme[] = [Scheme.Light, Scheme.Dark];
const CONTENT_FONTS: readonly Appearance["contentFont"][] = ["system", "serif", "mono"];

/** A scheme's own Genex preset: what an unknown or missing preset falls back to. */
export const defaultPresetId = (scheme: Scheme): string => `genex-${scheme}`;

/** A contrast from saved data: a finite number rounded into 0–100, else the default. */
function contrastOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_CONTRAST;
  return Math.min(CONTRAST_MAX, Math.max(0, Math.round(value)));
}

export const DEFAULT_APPEARANCE: Appearance = {
  version: 1,
  mode: AppearanceMode.System,
  light: { preset: defaultPresetId(Scheme.Light), overrides: {}, contrast: DEFAULT_CONTRAST },
  dark: { preset: defaultPresetId(Scheme.Dark), overrides: {}, contrast: DEFAULT_CONTRAST },
  uiFont: "studio",
  contentFont: "inherit",
  codeFont: "geist",
  saved: [],
};
export function hex(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const s = value.trim();
  if (/^#[\da-f]{6}$/i.test(s)) return s.toLowerCase();
  if (/^#[\da-f]{3}$/i.test(s))
    return (
      "#" +
      [...s.slice(1)]
        .map((c) => c + c)
        .join("")
        .toLowerCase()
    );
}
function object(value: unknown): Record<string, unknown> {
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  return isObject ? (value as Record<string, unknown>) : {};
}
/** The roles as stored that are hex colours, and the shadows that read. */
function colors(value: unknown): Partial<Palette> {
  const raw = object(value);
  const kept: Partial<Palette> = Object.fromEntries(
    ALL_ROLES.flatMap((role) => {
      const color = hex(raw[role]);
      return color ? [[role, color]] : [];
    }),
  );
  const shadows = shadowsOf(raw.shadows);
  return shadows ? { ...kept, shadows } : kept;
}

/** A shadow as stored or pasted: every measure a number, kept in its range, and a hex colour; else undefined. */
export function shadowOf(value: unknown): Shadow | undefined {
  const raw = object(value);
  const color = hex(raw.color);
  const measures = Object.entries(SHADOW_RANGE).map(([key, [min, max]]) => {
    const n = raw[key];
    return [key, typeof n === "number" && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : null];
  });
  if (!color || measures.some(([, n]) => n === null)) return;
  return { ...Object.fromEntries(measures), color } as Shadow;
}
/** The shadows as stored or pasted, each place's kept only when it reads; undefined when none does. */
export function shadowsOf(value: unknown): Shadows | undefined {
  const raw = object(value);
  const kept = SHADOW_PLACES.flatMap((place) => {
    const read = shadowOf(raw[place]);
    return read ? [[place, read] as const] : [];
  });
  return kept.length ? Object.fromEntries(kept) : undefined;
}
/** A shadow's colour at its opacity, as `#rrggbbaa`. */
export function shadowColor({ color, alpha }: Shadow): string {
  const opacity = Math.round((alpha / 100) * 255)
    .toString(16)
    .padStart(2, "0");
  return `${color}${opacity}`;
}
/** A shadow as a CSS box-shadow layer; opacity 0 draws a transparent one, which a shadow list still accepts. */
export const shadowCss = (s: Shadow): string => `0 ${s.y}px ${s.blur}px ${s.spread}px ${shadowColor(s)}`;

const CUSTOM_ID = /^custom-[a-z0-9-]{1,80}$/;

/** A saved custom preset as stored, if it is one to keep: a fresh custom id, a known scheme and every colour. */
function savedPreset(value: unknown, kept: ThemePreset[]): ThemePreset | null {
  const item = object(value);
  const palette = colors(item.colors);
  if (typeof item.id !== "string" || !CUSTOM_ID.test(item.id)) return null;
  const id = item.id;
  const complete = COLOR_ROLES.every((role) => palette[role]);
  const scheme = SCHEMES.find((s) => s === String(item.scheme));
  if (!scheme || !complete) return null;
  if (kept.some((p) => p.id === id)) return null;
  const name =
    typeof item.name === "string" ? item.name.trim().slice(0, PRESET_NAME_MAX) || t("Custom theme") : t("Custom theme");
  return { id, name, scheme, colors: palette as Palette, contrast: contrastOf(item.contrast) };
}

/** The saved custom presets worth keeping, first come first kept, up to the cap. */
function savedPresets(value: unknown): ThemePreset[] {
  const saved: ThemePreset[] = [];
  for (const item of (Array.isArray(value) ? value : []).slice(0, MAX_SAVED_PRESETS)) {
    const preset = savedPreset(item, saved);
    if (preset) saved.push(preset);
  }
  return saved;
}

/** A scheme's selection as stored: its preset when that preset exists for the scheme, its overrides and contrast. */
function selectionOf(value: unknown, scheme: Scheme, saved: ThemePreset[]): ThemeSelection {
  const s = object(value);
  const known = [...PRESETS, ...saved].some((p) => p.id === s.preset && p.scheme === scheme);
  return {
    preset: known ? String(s.preset) : defaultPresetId(scheme),
    overrides: colors(s.overrides),
    contrast: contrastOf(s.contrast),
  };
}

export function normalizeAppearance(value: unknown): Appearance {
  const raw = object(value);
  if (raw.version !== 1) return structuredClone(DEFAULT_APPEARANCE);
  const saved = savedPresets(raw.saved);
  const mode = APPEARANCE_MODES.find((m) => m === String(raw.mode)) ?? DEFAULT_APPEARANCE.mode;
  return {
    version: 1,
    mode,
    light: selectionOf(raw.light, Scheme.Light, saved),
    dark: selectionOf(raw.dark, Scheme.Dark, saved),
    saved,
    uiFont: raw.uiFont === "system" ? "system" : "studio",
    contentFont: CONTENT_FONTS.find((f) => f === String(raw.contentFont)) ?? "inherit",
    codeFont: raw.codeFont === "system" ? "system" : "geist",
  };
}
export function selectedPreset(appearance: Appearance, scheme: Scheme): ThemePreset {
  const chosen = [...PRESETS, ...appearance.saved].find(
    (p) => p.id === appearance[scheme].preset && p.scheme === scheme,
  );
  return chosen ?? defaultPreset(scheme);
}
/** A scheme's Genex preset, which every build ships. */
function defaultPreset(scheme: Scheme): ThemePreset {
  const preset = PRESETS.find((p) => p.id === defaultPresetId(scheme));
  if (!preset) throw new Error(MESSAGE.presetMissing(scheme));
  return preset;
}
export function paletteFor(appearance: Appearance, scheme: Scheme): Palette {
  const overrides = appearance[scheme].overrides;
  const palette: Palette = { ...selectedPreset(appearance, scheme).colors, ...overrides };
  // A detail the preset set for its own accent (or muted text) would not match an overridden one.
  for (const role of DETAIL_ROLES) if (overrides[DETAIL_SOURCE[role]] && !overrides[role]) delete palette[role];
  return palette;
}
/** Only the core roles of `palette`: what an import starts from, so it never inherits a preset's details. */
function coreOf(palette: Palette): Palette {
  return Object.fromEntries(COLOR_ROLES.map((role) => [role, palette[role]])) as Record<ColorRole, string>;
}
export function resolveScheme(mode: AppearanceMode, systemDark: boolean): Scheme {
  if (mode !== AppearanceMode.System) return mode;
  return systemDark ? Scheme.Dark : Scheme.Light;
}
type Rgb = [number, number, number];
export function luminance(color: string): number {
  const [r, g, b] = channels(color).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as Rgb;
  return r * 0.2126 + g * 0.7152 + b * 0.0722;
}
export function contrastRatio(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function onColor(color: string): string {
  return contrastRatio(color, "#ffffff") >= contrastRatio(color, "#000000") ? "#ffffff" : "#000000";
}
/** The same hue and chroma at the lightest step where white text still reaches `ratio`. */
function underWhite(color: string, ratio: number): string {
  const [L, C, h] = oklch(color);
  if (contrastRatio(color, "#ffffff") >= ratio) return color;
  let lo = 0,
    hi = L;
  for (let i = 0; i < LIGHTNESS_BISECTIONS; i++) {
    const mid = (lo + hi) / 2;
    if (contrastRatio(fromOklch(mid, C, h), "#ffffff") >= ratio) lo = mid;
    else hi = mid;
  }
  return fromOklch(lo, C, h);
}
/**
 * The accent as a button fill under white text: darkened in OKLCH only as far as white needs
 * (5:1), keeping the theme's hue and saturation; the hover lightens while white keeps 4.5:1.
 */
export function accentFill(accent: string): { fill: string; hover: string } {
  const fill = underWhite(accent, ACCENT_FILL_CONTRAST);
  const [L, C, h] = oklch(fill);
  let hover = fill;
  for (let step = HOVER_STEP; step <= HOVER_MAX_LIFT; step += HOVER_STEP) {
    const next = fromOklch(L + step, C, h);
    if (contrastRatio(next, "#ffffff") < WCAG_AA_TEXT) break;
    hover = next;
  }
  return { fill, hover };
}
/** Contrast correction only, not palette generation. Adjust toward a readable endpoint. */
export function readable(color: string, backgrounds: string[], minimum = WCAG_AA_TEXT): string {
  if (backgrounds.every((bg) => contrastRatio(color, bg) >= minimum)) return color;
  const worst = (end: string) => Math.min(...backgrounds.map((bg) => contrastRatio(end, bg)));
  // White wins a tie.
  const target = worst("#000000") > worst("#ffffff") ? "#000000" : "#ffffff";
  const start = channels(color);
  const end = channels(target);
  for (let i = 1; i <= READABLE_STEPS; i++) {
    const next = rgbHex(start.map((v, k) => v + (((end[k] ?? v) - v) * i) / READABLE_STEPS));
    if (backgrounds.every((bg) => contrastRatio(next, bg) >= minimum)) return next;
  }
  return target;
}
/** A control's edge at a contrast: as designed at the default, toward the text above it, toward the field below. */
function controlEdge(p: Palette, contrast: number, mix: (a: string, b: string, n: number) => string): string {
  if (contrast === DEFAULT_CONTRAST) return p.controlBorder;
  if (contrast > DEFAULT_CONTRAST) return mix(p.foreground, p.controlBorder, (contrast - DEFAULT_CONTRAST) * 0.45);
  return mix(p.controlBorder, p.field, DEFAULT_CONTRAST + contrast);
}
/** Muted text at a contrast: as set at or below the default; above it, lifted past its own contrast. */
function mutedAt(p: Palette, contrast: number): string {
  if (contrast <= DEFAULT_CONTRAST) return p.muted;
  const surfaces = [p.background, p.surface, p.sidebar, p.popover, p.field, p.hover];
  const own = Math.min(...surfaces.map((bg) => contrastRatio(p.muted, bg)));
  return readable(p.muted, surfaces, own + (contrast - DEFAULT_CONTRAST) * 0.05);
}
/** A hand-set fill's hover: a step lighter, or darker for a fill already near white. */
function setFillHover(fill: string): string {
  const [L, C, h] = oklch(fill);
  const shift = L > SET_FILL_DARKENS_ABOVE ? -SET_FILL_HOVER_SHIFT : SET_FILL_HOVER_SHIFT;
  return fromOklch(L + shift, C, h);
}
/** The accent button's fill, hover and label: as the palette sets them, else derived from the accent. */
function accentButton(p: Palette): { fill: string; hover: string; text: string } {
  const derived = accentFill(p.accent);
  const fill = p.accentFill ?? derived.fill;
  const hover = p.accentHover ?? (p.accentFill ? setFillHover(p.accentFill) : derived.hover);
  return { fill, hover, text: p.accentText ?? "#ffffff" };
}
/** The sidebar's row fills a palette may set; unset, each is mixed into the sidebar (`sidebarRowMix`). */
export type SidebarRow = Extract<DetailRole, "sidebarSelected" | "sidebarHover">;
/** Whether a role is one of the sidebar's row fills. */
export const isSidebarRow = (role: AnyRole): role is SidebarRow =>
  role === "sidebarSelected" || role === "sidebarHover";
/** The percentage each unset row fill mixes in: of the hover on a dark sidebar, of the text on a light one. */
const SIDEBAR_ROW_SHARE: Record<SidebarRow, { dark: number; light: number }> = {
  sidebarSelected: { dark: 62, light: 7 },
  sidebarHover: { dark: 45, light: 4 },
};
/**
 * What an unset sidebar row fill mixes into the sidebar, and how much (in oklab). Rows are quieter
 * than the shared hover in dark themes and visible at all in light ones.
 */
export function sidebarRowMix(p: Palette, row: SidebarRow): { color: string; percent: number } {
  const share = SIDEBAR_ROW_SHARE[row];
  return luminance(p.sidebar) > 0.4
    ? { color: p.foreground, percent: share.light }
    : { color: p.hover, percent: share.dark };
}
/**
 * A dark theme's destructive fill and hover: its red, no more vivid than `DARK_DANGER_CHROMA`,
 * deepened under a white label as the accent fill is, so it pairs with the accent button. Null in a
 * light theme, whose red fills as set.
 */
export function darkDangerFill(p: Palette): { fill: string; hover: string } | null {
  if (luminance(p.background) > LIGHT_BACKGROUND) return null;
  const [L, C, h] = oklch(p.danger);
  return accentFill(fromOklch(L, Math.min(C, DARK_DANGER_CHROMA), h));
}
/**
 * The CSS variables a palette draws. Every colour is drawn exactly as set, however low its contrast:
 * the palette's author owns readability (the colour tweaker shows each role's contrast). Only a
 * contrast above the default lifts muted text further.
 */
export function themeVariables(p: Palette, contrast = DEFAULT_CONTRAST): Record<string, string> {
  const mix = (a: string, b: string, n: number) => `color-mix(in oklab, ${a} ${n}%, ${b})`;
  const ink = p.foreground,
    muted = mutedAt(p, contrast);
  const edge =
    contrast > DEFAULT_CONTRAST
      ? mix(p.foreground, p.border, (contrast - DEFAULT_CONTRAST) * 0.65)
      : mix(p.border, p.surface, 60 + contrast * 0.8);
  const accentInk = p.accent;
  // Boundaries are quiet decoration; labels, icons and fills identify controls.
  // Honor the configured edge instead of brightening every border to text contrast.
  const controlBorder = controlEdge(p, contrast, mix);
  const hoverFill = (color: string) => mix(color, onColor(color) === "#000000" ? "#ffffff" : "#000000", 92);
  const primary = accentButton(p);
  const darkDanger = darkDangerFill(p);
  const dangerFill = darkDanger?.fill ?? p.danger;
  const sidebarFill = (row: SidebarRow) => {
    const { color, percent } = sidebarRowMix(p, row);
    return mix(color, p.sidebar, percent);
  };
  return {
    "--background": p.background,
    "--foreground": ink,
    "--card": p.surface,
    "--sidebar": p.sidebar,
    "--popover": p.popover,
    "--muted": p.field,
    "--field": p.field,
    "--hover": p.hover,
    "--hover-2": mix(p.foreground, p.hover, 6),
    "--secondary": p.hover,
    "--muted-foreground": muted,
    "--ink-2": mix(ink, muted, 70),
    "--border": edge,
    "--input": controlBorder,
    "--line-strong": controlBorder,
    // A box inside a card (a setup step): as quiet as the card's own edge where light, which a
    // dark card would swallow, so there it takes the control edge.
    "--line-soft": luminance(p.background) > LIGHT_BACKGROUND ? edge : controlBorder,
    // Every floating menu's one edge (dropdowns, popovers, the composer's menus): the prompt bar's
    // where light; a dark menu's fill swallows that, so there it takes the control edge.
    "--menu-edge": luminance(p.background) > LIGHT_BACKGROUND ? "var(--prompt-bar-edge)" : controlBorder,
    "--accent-primary": p.accent,
    "--accent-primary-dark": p.accent,
    "--accent-ink": accentInk,
    "--accent-fill": primary.fill,
    "--accent-foreground": primary.text,
    "--accent-hover": primary.hover,
    "--ring": accentInk,
    "--focus-edge": mix(p.accent, controlBorder, 18),
    "--sidebar-selected": sidebarFill("sidebarSelected"),
    "--sidebar-hover": sidebarFill("sidebarHover"),
    "--primary": ink,
    "--primary-foreground": p.background,
    "--control-quiet": p.field,
    "--control-quiet-edge": controlBorder,
    "--composer": p.surface,
    "--composer-panel": p.popover,
    "--composer-panel-border": edge,
    "--stripe": mix(ink, "transparent", 4),
    "--green": p.success,
    "--orange": p.warning,
    "--destructive": p.danger,
    "--danger-fill": dangerFill,
    "--danger-foreground": onColor(dangerFill),
    "--danger-hover": darkDanger?.hover ?? hoverFill(p.danger),
    "--success-foreground": onColor(p.success),
    "--error-foreground": onColor(p.danger),
    "--image-outline": luminance(p.background) > LIGHT_BACKGROUND ? "#0000001a" : "#ffffff1a",
    "--shadow-overlay": `0 0 0 1px ${edge}, 0 16px 48px #00000026`,
    "--shadow-raised": `0 0 0 1px ${edge}, 0 8px 24px #00000020`,
    ...placeVariables(p),
    ...logoVariables(p, muted, mix),
    // The onboarding buttons' own fill darkens toward the text on hover, as the tint deepens.
    ...(p.artButton ? { "--art-button-hover": mix(p.artButton, p.foreground, 92) } : {}),
    ...shadowVariables(p),
  };
}
/**
 * The wordmark's gradient: it runs through the palette's own shade, else a secondary ink mixed as
 * --ink-2 is. Shaded in its own colour it has no gradient left, so its fade goes too and it is solid.
 */
function logoVariables(
  p: Palette,
  muted: string,
  mix: (a: string, b: string, n: number) => string,
): Record<string, string> {
  const shade = p.logoShade ?? (p.logo ? mix(p.logo, muted, 70) : undefined);
  if (!shade) return {};
  const solid = shade === (p.logo ?? p.foreground);
  return solid ? { "--logo-2": shade, "--logo-fade": "1" } : { "--logo-2": shade };
}
/** The place-dependent details the palette sets; unset, each place keeps its own colour (theme.css falls back). */
function placeVariables(p: Palette): Record<string, string> {
  return Object.fromEntries(
    DETAIL_ROLES.flatMap((role) => {
      const variable = PLACE_VARIABLE[role];
      const color = p[role];
      return variable && color ? [[variable, color]] : [];
    }),
  );
}
/** The shadows the palette sets; unset, each place keeps its own. */
function shadowVariables(p: Palette): Record<string, string> {
  return Object.fromEntries(
    SHADOW_PLACES.flatMap((place) => {
      const set = p.shadows?.[place];
      return set ? [[SHADOW_VARIABLE[place], shadowCss(set)]] : [];
    }),
  );
}

const tokenValue = (color: string) => ({
  $type: "color",
  $value: { colorSpace: "srgb", components: channels(color), alpha: 1, hex: color },
});
/** DTCG 2025.10 color tokens; app-only metadata lives in the extensions namespace. */
export function exportTheme(appearance: Appearance, scheme: Scheme): string {
  const p = paletteFor(appearance, scheme);
  return JSON.stringify(
    {
      $description: `${selectedPreset(appearance, scheme).name} · ${scheme}`,
      $extensions: {
        "app.genex.studio": {
          version: 1,
          scheme,
          name: selectedPreset(appearance, scheme).name,
          contrast: appearance[scheme].contrast,
          ...(p.shadows ? { shadows: p.shadows } : {}),
        },
      },
      colors: Object.fromEntries(
        ALL_ROLES.flatMap((role) => {
          const color = p[role];
          return color ? [[role, tokenValue(color)]] : [];
        }),
      ),
    },
    null,
    2,
  );
}
/** JSONC lexer: preserve quoted strings, remove comments/trailing commas without eval. */
function parseJsonc(text: string): unknown {
  let output = "";
  let i = 0;
  while (i < text.length) {
    const [out, next] = lexStep(text, i);
    output += out;
    i = next;
  }
  // A second pass handles commas followed by comments stripped by the first pass.
  if (output !== text) return parseJsonc(output);
  return JSON.parse(output);
}
/** One step of the lexer at `i`: what it writes, and where it reads next. */
function lexStep(text: string, i: number): [string, number] {
  const c = text[i] ?? "";
  const n = text[i + 1];
  if (c === '"') {
    const end = stringEnd(text, i);
    return [text.slice(i, end), end];
  }
  if (c === "/" && n === "/") return ["\n", lineEnd(text, i) + 1];
  if (c === "/" && n === "*") return [" ", blockCommentEnd(text, i) + 1];
  if (c === "," && closesNext(text, i)) return ["", i + 1];
  return [c, i + 1];
}
/** Where the string opening at `start` ends: just past its closing quote, or the end of the text. */
function stringEnd(text: string, start: number): number {
  let escaped = false;
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (escaped) escaped = false;
    else if (c === "\\") escaped = true;
    else if (c === '"') return i + 1;
  }
  return text.length;
}
/** The newline that ends a line comment starting at `start`, or the end of the text. */
function lineEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && text[i] !== "\n") i++;
  return i;
}
/** The `/` that closes a block comment starting at `start`; an unclosed one is an error. */
function blockCommentEnd(text: string, start: number): number {
  let i = start + 2;
  while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
  if (i === text.length) throw new Error(MESSAGE.unclosedComment);
  return i + 1;
}
/** Whether the comma at `at` is a trailing one: only whitespace between it and a closing bracket. */
function closesNext(text: string, at: number): boolean {
  let j = at + 1;
  while (/\s/.test(text[j] ?? "") && j < text.length) j++;
  return text[j] === "]" || text[j] === "}";
}
function importHex(value: unknown, base: string): string | undefined {
  const plain = hex(value);
  if (plain) return plain;
  if (typeof value !== "string" || !/^#(?:[\da-f]{4}|[\da-f]{8})$/i.test(value)) return;
  const full = value.length === 5 ? `#${[...value.slice(1)].map((c) => c + c).join("")}` : value;
  const a = parseInt(full.slice(7, 9), 16) / 255;
  return rgbHex(channels(full.slice(0, 7)).map((v, i) => v * a + (channels(base)[i] ?? 0) * (1 - a)));
}

/** Is this value one of the two schemes? */
const isScheme = (value: unknown): value is Scheme => value === Scheme.Light || value === Scheme.Dark;

/** The scheme an imported theme is for: its own metadata's, a VS Code theme's type, else the one importing it. */
function importedScheme(metadata: Record<string, unknown>, raw: Record<string, unknown>, target: Scheme): Scheme {
  if (isScheme(metadata.scheme)) return metadata.scheme;
  if (isScheme(raw.type)) return raw.type;
  return target;
}

/** Whether a colour channel is a number in 0–1. */
const isUnitChannel = (n: unknown): boolean => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;

/** Whether a design token is an opaque sRGB colour with three channels in 0–1. */
function isOpaqueColorToken(token: Record<string, unknown>): boolean {
  const v = object(token.$value);
  const c = v.components;
  const channelsOk = Array.isArray(c) && c.length === 3 && c.every(isUnitChannel);
  return token.$type === "color" && v.colorSpace === "srgb" && channelsOk && (v.alpha === undefined || v.alpha === 1);
}

/** The colours of a Genex design-token file, each an opaque sRGB token. */
function tokenColors(metadata: Record<string, unknown>, data: Record<string, unknown>): Partial<Palette> {
  if (metadata.version !== undefined && metadata.version !== 1) throw new Error(MESSAGE.newerFormat);
  const result: Partial<Palette> = {};
  for (const role of ALL_ROLES) {
    if (data[role] === undefined) continue;
    const token = object(data[role]);
    if (!isOpaqueColorToken(token)) throw new Error(MESSAGE.notOpaqueToken(role));
    result[role] = rgbHex(object(token.$value).components as number[]);
  }
  return result;
}

/** Which VS Code colour keys each role reads, in order of preference. */
const VSCODE_KEYS: Record<ColorRole, string[]> = {
  background: ["editor.background"],
  foreground: ["editor.foreground", "foreground"],
  surface: ["panel.background", "sideBar.background"],
  sidebar: ["sideBar.background"],
  popover: ["dropdown.background", "editorWidget.background"],
  field: ["input.background"],
  hover: ["list.hoverBackground"],
  muted: ["descriptionForeground"],
  border: ["panel.border", "sideBar.border"],
  controlBorder: ["input.border", "dropdown.border"],
  accent: ["button.background", "focusBorder"],
  success: ["terminal.ansiGreen"],
  warning: ["terminal.ansiYellow"],
  danger: ["errorForeground", "terminal.ansiRed"],
};

/** The colours of a VS Code colour theme, translucent ones blended onto its editor background (written into `base`). */
function vscodeColors(raw: Record<string, unknown>, data: Record<string, unknown>, base: Palette): Partial<Palette> {
  if (raw.include !== undefined) throw new Error(MESSAGE.includesFile);
  const background = importHex(data["editor.background"], base.background);
  if (background) base.background = background;
  const result: Partial<Palette> = {};
  for (const role of COLOR_ROLES) {
    const key = VSCODE_KEYS[role].find((candidate) => data[candidate] !== undefined);
    if (key === undefined) continue;
    const value = importHex(data[key], base.background);
    if (!value) throw new Error(MESSAGE.notHex(key));
    result[role] = value;
  }
  return result;
}

export function importTheme(
  text: string,
  target: Scheme,
): { name: string; scheme: Scheme; colors: Palette; contrast: number; source: string } {
  if (text.length > THEME_FILE_MAX_BYTES) throw new Error(MESSAGE.tooLarge);
  let raw: Record<string, unknown>;
  try {
    raw = object(parseJsonc(text.replace(/^\uFEFF/, "")));
  } catch {
    throw new Error(MESSAGE.notJson);
  }
  const metadata = object(object(raw.$extensions)["app.genex.studio"]);
  const scheme = importedScheme(metadata, raw, target);
  const base = coreOf(defaultPreset(scheme).colors);
  const data = object(raw.colors);
  const tokens = Object.keys(metadata).length > 0 || COLOR_ROLES.some((role) => object(data[role]).$type === "color");
  const result = tokens ? tokenColors(metadata, data) : vscodeColors(raw, data, base);
  if (!Object.keys(result).length) throw new Error(MESSAGE.noColors);
  const shadows = shadowsOf(metadata.shadows);
  const name = String(metadata.name ?? raw.name ?? t("Imported theme"))
    .trim()
    .slice(0, PRESET_NAME_MAX);
  return {
    name: name || t("Imported theme"),
    scheme,
    colors: shadows ? { ...base, ...result, shadows } : { ...base, ...result },
    contrast: contrastOf(metadata.contrast),
    source: tokens ? "Design tokens" : "VS Code UI colors",
  };
}
