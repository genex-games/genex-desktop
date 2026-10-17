/**
 * The developer colour tweaker's model, as pure functions: a draft of one preset's roles,
 * whole-palette knobs over its neutrals, and the text a finished tweak is copied as (the preset's
 * own `preset(...)` entry in `themes.ts`). Offered only in an unpackaged developer run.
 */
import {
  ALL_ROLES,
  type AnyRole,
  COLOR_ROLES,
  type ColorRole,
  DETAIL_ROLES,
  type DetailRole,
  contrastRatio,
  DEFAULT_CONTRAST,
  defaultPresetId,
  hex,
  PRESETS,
  PEOPLE_ROLES,
  PLAY_HUE_ROLES,
  type Palette,
  type PeopleRole,
  type PlayHueRole,
  SHADOW_PLACES,
  Scheme,
  type Shadow,
  type ShadowPlace,
  type Shadows,
  shadowOf,
  isSidebarRow,
  type SidebarRow,
  sidebarRowMix,
  type ThemePreset,
  themeVariables,
} from "../themes.ts";
import { channels, fromOklch, oklch, rgbHex } from "../../../shared/oklch.ts";
import { MARK_FACE_INK, SHEET_INK } from "../../onboarding/art.ts";

/** The whole-palette knobs: each moves every neutral at once. */
export type Knobs = {
  /** Lightness added to the canvas and every layer on it, in OKLCH lightness points. */
  lift: number;
  /** Each layer's lightness distance from the canvas, in percent of the designed distance. */
  depth: number;
  /** The neutrals' own colourfulness, in percent. */
  saturation: number;
  /** The hue of the tint added to every neutral, in degrees. */
  tintHue: number;
  /** How strong that tint is, 0–100. */
  tint: number;
};
export type KnobKey = keyof Knobs;

/** Every knob at the value that leaves the palette as it is. */
export const IDENTITY_KNOBS: Knobs = { lift: 0, depth: 100, saturation: 100, tintHue: 250, tint: 0 };

/** Each knob's range, in the order the panel shows them. */
export const KNOB_SPECS: readonly { key: KnobKey; label: string; min: number; max: number; step: number }[] = [
  { key: "lift", label: "Lift", min: -12, max: 12, step: 0.1 },
  { key: "depth", label: "Depth", min: 0, max: 250, step: 1 },
  { key: "saturation", label: "Saturation", min: 0, max: 300, step: 1 },
  { key: "tint", label: "Tint", min: 0, max: 100, step: 1 },
  { key: "tintHue", label: "Tint hue", min: 0, max: 360, step: 1 },
];

/** The chroma a full tint adds to a neutral. */
const TINT_MAX_CHROMA = 0.04;
/** A lightness point, in OKLCH lightness. */
const LIGHTNESS_POINT = 0.01;
const DEGREE = Math.PI / 180;

/** The canvas: lift moves it; depth measures from it. */
const CANVAS: ColorRole = "background";
/** The layers on the canvas: lift moves them, depth spreads them. */
const LAYERS: readonly ColorRole[] = ["surface", "sidebar", "popover", "field", "hover", "border", "controlBorder"];
/** Text keeps its lightness and takes the neutrals' saturation and tint. */
const TEXT: readonly ColorRole[] = ["foreground", "muted"];
/** The surfaces text and icons are read on. */
const SURFACES: readonly ColorRole[] = ["background", "surface", "sidebar", "popover", "field", "hover"];
/** The roles drawn as text on those surfaces. */
const READ_ON_SURFACES: readonly AnyRole[] = [
  "foreground",
  "muted",
  "accent",
  "success",
  "warning",
  "danger",
  "settingsTab",
];
/** Play's blue (genex.games' own): the selected tab and switch side unless a palette sets one (play.css `--play-blue`). */
const PLAY_BLUE = "#4b60bf";
/** WCAG AA: body text, and icons and other graphics that identify a control. */
const TEXT_CONTRAST = 4.5;
const GRAPHIC_CONTRAST = 3;
/** How much of the selector track is the canvas; the rest is the menu (theme.css `--picker-well`). */
const WELL_CANVAS_SHARE = 0.75;
/** The variable each detail role is drawn as while it is left to the app; the selector's track and thumb are not. */
const DETAIL_VARIABLE: Record<
  Exclude<
    DetailRole,
    | "well"
    | "thumb"
    | "artPaper"
    | "artMark"
    | "artButton"
    | "logoShade"
    | "promptEdge"
    | "hatch"
    | "promptChipFill"
    | "sidebarSelected"
    | "sidebarHover"
    | "playSelected"
    | "playSelectedEdge"
    | "playTrackEdge"
    | "playTabEdge"
    | "playSearchFocus"
    | PeopleRole
    | PlayHueRole
  >,
  string
> = {
  accentFill: "--accent-fill",
  accentHover: "--accent-hover",
  accentText: "--accent-foreground",
  icon: "--muted-foreground",
  iconSelected: "--accent-ink",
  logo: "--foreground",
  graph: "--accent-primary",
  art: "--accent-ink",
  controlFill: "--hover",
  controlHover: "--hover",
  controlText: "--muted-foreground",
  controlTextHover: "--foreground",
  chipHover: "--line-strong",
  meterTrack: "--hover",
  meterFill: "--muted-foreground",
  meterHigh: "--orange",
  meterFull: "--destructive",
  viewSwitch: "--accent-fill",
  playTrack: "--hover",
  playSelectedText: "--foreground",
  playTab: "--background",
  playTabText: "--muted-foreground",
  wireArt: "--accent-ink",
  hatchGround: "--background",
  settingsTab: "--accent-ink",
};
/** Marks read on their own grounds: labels on fills (text contrast) and meter fills on their track (graphic). */
const ON_GROUND: readonly { marks: readonly DetailRole[]; grounds: readonly DetailRole[]; minimum: number }[] = [
  { marks: ["accentText"], grounds: ["accentFill", "accentHover"], minimum: TEXT_CONTRAST },
  // The Live / Assets switch writes the current view's name in the button text on its own fill.
  { marks: ["accentText"], grounds: ["viewSwitch"], minimum: TEXT_CONTRAST },
  { marks: ["controlText"], grounds: ["controlFill", "promptChipFill", "well"], minimum: TEXT_CONTRAST },
  { marks: ["controlTextHover"], grounds: ["controlHover", "chipHover", "thumb"], minimum: TEXT_CONTRAST },
  { marks: ["meterFill", "meterHigh", "meterFull"], grounds: ["meterTrack"], minimum: GRAPHIC_CONTRAST },
];

/** The panel's role groups and the names it shows (the order comment above `PRESETS`). */
export const ROLE_GROUPS: readonly { label: string; roles: readonly AnyRole[] }[] = [
  // First while Play's colours are being tuned, so the panel opens on them.
  {
    label: "Play: chips, buttons and cards",
    roles: [
      "peopleChip",
      "peopleChipText",
      "peopleChipNumber",
      "peopleTint",
      "peoplePrimary",
      "peoplePrimaryShade",
      "creditsCard",
      "inviteCard",
    ],
  },
  {
    label: "Play: switches and tabs (Play / Create, Tools / Credits, stats period)",
    roles: [
      "playSelected",
      "playSelectedEdge",
      "playSelectedText",
      "playTrack",
      "playTrackEdge",
      "playTab",
      "playTabEdge",
      "playTabText",
      "playSearchFocus",
    ],
  },
  {
    label: "Play: people and stats",
    roles: [
      "playBlue",
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
    ],
  },
  { label: "Surfaces", roles: ["background", "sidebar", "surface", "popover", "field", "hover"] },
  { label: "Sidebar rows", roles: ["sidebarSelected", "sidebarHover"] },
  { label: "Lines", roles: ["border", "controlBorder"] },
  { label: "Text", roles: ["foreground", "muted"] },
  { label: "Accent and status", roles: ["accent", "success", "warning", "danger"] },
  { label: "Accent button and icons", roles: ["accentFill", "accentHover", "accentText", "icon", "iconSelected"] },
  { label: "Logo", roles: ["logo", "logoShade"] },
  { label: "Prompt bar", roles: ["promptEdge"] },
  { label: "Builds graph", roles: ["graph"] },
  { label: "Stage (Live / Assets)", roles: ["viewSwitch", "wireArt", "hatch", "hatchGround"] },
  { label: "Settings", roles: ["settingsTab"] },
  { label: "Onboarding art", roles: ["art", "artPaper", "artMark", "artButton"] },
  {
    label: "Chips, tabs and hover",
    roles: ["controlFill", "promptChipFill", "chipHover", "controlHover", "controlText", "controlTextHover"],
  },
  { label: "Selectors (Window, Loop time)", roles: ["well", "thumb"] },
  { label: "Meters", roles: ["meterTrack", "meterFill", "meterHigh", "meterFull"] },
];
export const ROLE_LABEL: Record<AnyRole, string> = {
  background: "Canvas",
  foreground: "Text",
  surface: "Surface",
  sidebar: "Sidebar",
  popover: "Menu",
  field: "Field",
  hover: "Hover",
  muted: "Muted text",
  border: "Divider",
  controlBorder: "Control edge",
  accent: "Accent",
  success: "Success",
  warning: "Warning",
  danger: "Error",
  accentFill: "Button fill",
  accentHover: "Button hover",
  accentText: "Button text",
  icon: "Icons",
  iconSelected: "Selected icon",
  logo: "Logo",
  logoShade: "Logo shade",
  graph: "Graph accent",
  art: "Art accent",
  artPaper: "Plan sheet",
  artMark: "Sign-in marks",
  artButton: "Buttons",
  controlFill: "Chip fill (canvas)",
  promptChipFill: "Chip fill (prompt bar)",
  controlHover: "Hover fill",
  controlText: "Chip text",
  controlTextHover: "Hover text",
  chipHover: "Chip hover",
  sidebarSelected: "Selected row",
  sidebarHover: "Row hover",
  well: "Selector track",
  thumb: "Selected fill",
  meterTrack: "Meter track",
  meterFill: "Meter fill",
  meterHigh: "Meter high",
  meterFull: "Meter full",
  promptEdge: "Prompt bar edge",
  viewSwitch: "View switch",
  playSelected: "Selected blue",
  playTrack: "Switch track",
  playSelectedText: "Selected text",
  playSelectedEdge: "Selected edge",
  playTrackEdge: "Switch edge",
  playTab: "Tab backing",
  playTabEdge: "Tab edge",
  playTabText: "Tab text",
  playSearchFocus: "Search focus edge",
  wireArt: "Cube",
  hatch: "Stripes",
  hatchGround: "Stripe ground",
  settingsTab: "Selected tab",
  peopleChip: "Chips and edit button",
  peopleChipText: "Chip label",
  peopleChipNumber: "Chip number",
  peopleTint: "Tint buttons (Invite, Join, Copy)",
  creditsCard: "Credits card",
  inviteCard: "Invite card",
  playBlue: "Genex blue",
  peoplePrimary: "Primary button",
  peoplePrimaryShade: "Primary button shade",
  peopleLive: "Playing now dot",
  peopleLiveText: "Playing now text",
  peoplePro: "Pro",
  peopleRequest: "Request count",
  statsLine: "Stats line",
  statsUp: "Up",
  statsDown: "Down",
  shardLight: "Credit shard light",
  shardMid: "Credit shard",
  shardDark: "Credit shard dark",
};

/**
 * The sidebar wordmark's width in px: theme.css draws `--logo-width`, else `base`. It is the same in
 * every theme, so the tweaker keeps it beside the drafts rather than in one.
 */
export const LOGO_WIDTH = { base: 80, min: 56, max: 160 } as const;

/** A tweaked logo width as a line to carry into theme.css; empty when it is left as designed. */
export const logoWidthText = (width: number | null): string =>
  width === null ? "" : `/* theme.css .sidebar-wordmark: --logo-width ${LOGO_WIDTH.base}px → ${width}px */`;

/** One measure of the label type: the variable theme.css draws, else `base`, and the range tried. */
type TypeMeasure = {
  label: string;
  variable: string;
  base: number;
  min: number;
  max: number;
  step: number;
  unit: string;
};

/**
 * The sidebar's labels (New game … Settings, the game titles) and the chat header's title share one
 * type. It is the same in every theme, so the tweaker keeps it beside the drafts, as the logo width.
 */
export const LABEL_TYPE = {
  size: { label: "Size", variable: "--label-size", base: 14, min: 11, max: 20, step: 0.5, unit: "px" },
  tracking: {
    label: "Letter spacing",
    variable: "--label-tracking",
    base: -0.015,
    min: -0.1,
    max: 0.1,
    step: 0.005,
    unit: "em",
  },
  weight: { label: "Weight", variable: "--label-weight", base: 450, min: 300, max: 800, step: 10, unit: "" },
} as const satisfies Record<string, TypeMeasure>;
export type LabelTypeKey = keyof typeof LABEL_TYPE;
/** The label type's measures, in the order the panel shows them; the line height stays as designed. */
export const LABEL_TYPE_KEYS: readonly LabelTypeKey[] = ["size", "tracking", "weight"];

/** `n` on its measure's step, without the float tail a fractional step leaves (`-0.035`, not `-0.035000000000000003`). */
export function onStep(key: LabelTypeKey, n: number): number {
  const { min, max, step } = LABEL_TYPE[key];
  return Number(Math.min(max, Math.max(min, Math.round(n / step) * step)).toFixed(3));
}
/** The label type being tried: only the measures moved from the design. */
export type LabelType = Partial<Record<LabelTypeKey, number>>;

/** A tried label type as a line to carry into theme.css; empty when it is left as designed. */
export function labelTypeText(type: LabelType): string {
  const moved = LABEL_TYPE_KEYS.flatMap((key) => {
    const value = type[key];
    const { variable, base, unit } = LABEL_TYPE[key];
    return value === undefined ? [] : [`${variable} ${base}${unit} → ${value}${unit}`];
  });
  return moved.length ? `/* theme.css sidebar labels and chat header title: ${moved.join(", ")} */` : "";
}

/** Whether a role is one the app derives until the palette sets it. */
export const isDetail = (role: AnyRole): role is DetailRole => (DETAIL_ROLES as readonly string[]).includes(role);

/** `a` and `b` mixed in OKLab, `share` of `a`: the hex of a CSS `color-mix(in oklab, …)`. */
/** How much accent the tinted buttons carry over the canvas (`accentChipClass`). */
const ACCENT_TINT = 0.12;
/** How much of the divider the prompt bar's edge carries over its panel (theme.css `.composer-panel`). */
const PROMPT_EDGE_SHARE = 0.65;
/** How much text the stage's stripes carry over the canvas (theme.css `--stripe`). */
const STRIPE_INK = 0.04;
/**
 * Play's edges while unset (play.css): the selected blue's, the switch track's grey, the scrolled
 * tabs' ink and the focused search's muted ink.
 */
const PLAY_SELECTED_EDGE_SHARE = 0.4;
const PLAY_TRACK_EDGE = { color: "#797f8b", share: 0.21 } as const;
const PLAY_TAB_EDGE_SHARE = 0.09;
const PLAY_SEARCH_FOCUS_SHARE = 0.18;
/** How much of the logo the wordmark's secondary ink keeps against the muted text (`--logo-2`). */
const LOGO_SHADE_SHARE = 0.7;
/** `color` at `alpha` over `ground`, blended as the browser composites it. */
function over(ground: string, color: string, alpha: number): string {
  const ink = channels(color);
  return rgbHex(channels(ground).map((g, i) => g + ((ink[i] ?? 0) - g) * alpha));
}
function mixOklab(a: string, b: string, share: number): string {
  const lab = (color: string): [number, number, number] => {
    const [l, c, h] = oklch(color);
    return [l, c * Math.cos(h), c * Math.sin(h)];
  };
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  const mix = (x: number, y: number): number => x * share + y * (1 - share);
  const [A, B] = [mix(a1, a2), mix(b1, b2)];
  return fromOklch(mix(l1, l2), Math.hypot(A, B), Math.atan2(B, A));
}

/** An unset sidebar row fill, mixed into the sidebar as theme.css draws it. */
function sidebarRowColor(palette: Palette, row: SidebarRow): string {
  const { color, percent } = sidebarRowMix(palette, row);
  return mixOklab(color, palette.sidebar, percent / 100);
}

/** people.css's own colours for Play's people, stats and credits, on a dark canvas and a light one. */
const PEOPLE_COLORS: Record<Scheme, Record<PeopleRole, string>> = {
  [Scheme.Dark]: {
    peopleChipText: "#9fb0ff",
    peopleChipNumber: "#d3dbff",
    playBlue: "#4b60bf",
    peoplePrimary: "#4b60bf",
    peoplePrimaryShade: "#3f51a8",
    peopleLive: "#22a55b",
    peopleLiveText: "#5fd18b",
    peoplePro: "#8d9bff",
    peopleRequest: "#3f61f5",
    statsLine: "#7d8ff0",
    statsUp: "#5fd18b",
    statsDown: "#ff8a7a",
    shardLight: "#aeb7e2",
    shardMid: "#6b7fdc",
    shardDark: "#4555a8",
  },
  [Scheme.Light]: {
    peopleChipText: "#3d58d8",
    peopleChipNumber: "#1e33b4",
    playBlue: "#4b60bf",
    peoplePrimary: "#4b60bf",
    peoplePrimaryShade: "#3f51a8",
    peopleLive: "#22a55b",
    peopleLiveText: "#16803f",
    peoplePro: "#4353d9",
    peopleRequest: "#3f61f5",
    statsLine: "#4b60bf",
    statsUp: "#16803f",
    statsDown: "#b42318",
    shardLight: "#aeb7e2",
    shardMid: "#4b60bf",
    shardDark: "#313e7c",
  },
};
/** A canvas darker than this is a dark scheme's: people.css picks its colours by the theme. */
const DARK_CANVAS_LIGHTNESS = 0.5;
const isPeopleRole = (role: AnyRole): role is PeopleRole => (PEOPLE_ROLES as readonly string[]).includes(role);
const isPlayHueRole = (role: AnyRole): role is PlayHueRole => (PLAY_HUE_ROLES as readonly string[]).includes(role);
/** An unset people role's colour: people.css's own for the palette's scheme. */
function peopleColor(palette: Palette, role: PeopleRole): string {
  const scheme = oklch(palette.background)[0] < DARK_CANVAS_LIGHTNESS ? Scheme.Dark : Scheme.Light;
  return PEOPLE_COLORS[scheme][role];
}

/** {@link DETAIL_VARIABLE} looked up by any role: the details with no variable of their own answer nothing. */
const DETAIL_VARIABLES: ReadonlyMap<string, string> = new Map(Object.entries(DETAIL_VARIABLE));

/**
 * Details drawn, while unset, as one colour over a ground: the ground, the colour and its share. The
 * onboarding art's sheet and marks are faint ink over the canvas and its buttons the accent tint; the
 * prompt bar's edge is the divider over its panel; the stage's stripes are faint ink; Play's edges are
 * its blue, a grey and faint ink over the page.
 */
const LAYERED: Partial<Record<AnyRole, (p: Palette) => [string, string, number]>> = {
  artPaper: (p) => [p.background, p.foreground, SHEET_INK],
  artMark: (p) => [p.background, p.foreground, MARK_FACE_INK],
  artButton: (p) => [p.background, p.accent, ACCENT_TINT],
  promptEdge: (p) => [p.surface, p.border, PROMPT_EDGE_SHARE],
  hatch: (p) => [p.background, p.foreground, STRIPE_INK],
  playSelectedEdge: (p) => [p.background, p.playSelected ?? PLAY_BLUE, PLAY_SELECTED_EDGE_SHARE],
  playTrackEdge: (p) => [p.background, PLAY_TRACK_EDGE.color, PLAY_TRACK_EDGE.share],
  playTabEdge: (p) => [p.background, p.foreground, PLAY_TAB_EDGE_SHARE],
  playSearchFocus: (p) => [p.background, p.foreground, PLAY_SEARCH_FOCUS_SHARE],
};

/**
 * An unset Play colour: the selected blue is Play's own, the tinted families wear it (the credits card
 * the chips' hue), and the people and stats colours are people.css's own; null for any other role.
 */
function unsetPlayColor(palette: Palette, role: AnyRole): string | null {
  if (role === "playSelected") return PLAY_BLUE;
  if (isPeopleRole(role)) return peopleColor(palette, role);
  if (!isPlayHueRole(role)) return null;
  return role === "creditsCard" ? shownColor(palette, "peopleChip") : (palette.playSelected ?? PLAY_BLUE);
}

/** The colour a role is drawn in: its own, or for an unset detail the one the app derives. */
export function shownColor(palette: Palette, role: AnyRole): string {
  const own = palette[role];
  if (own || !isDetail(role)) return own ?? "";
  if (role === "well") return mixOklab(palette.background, palette.popover, WELL_CANVAS_SHARE);
  if (role === "thumb") return shownColor(palette, "chipHover");
  if (isSidebarRow(role)) return sidebarRowColor(palette, role);
  // Unset, the prompt bar's chips wear the canvas chip's fill (theme.css `--prompt-chip-fill`).
  if (role === "promptChipFill") return shownColor(palette, "controlFill");
  const layered = LAYERED[role]?.(palette);
  if (layered) return over(...layered);
  // Unset, the logo's shade is mixed as --ink-2 is.
  if (role === "logoShade") return mixOklab(palette.logo ?? palette.foreground, palette.muted, LOGO_SHADE_SHARE);
  const play = unsetPlayColor(palette, role);
  if (play) return play;
  const variable = DETAIL_VARIABLES.get(role);
  return variable ? (themeVariables(palette, DEFAULT_CONTRAST)[variable] ?? "") : "";
}

/** Each shadow's name in the panel, and what it falls on. */
export const SHADOW_LABEL: Record<ShadowPlace, { label: string; title: string }> = {
  panel: { label: "Menus", title: "Composer menus: Add (+), model, Loop, context, effort, notifications" },
  promptBar: { label: "Prompt bar", title: "The prompt bar's panel" },
  thumb: { label: "Selected segment", title: "The selected segment in Window and Loop time" },
};
/**
 * Each place's own shadow while the palette leaves it (theme.css), as the start of an edit. The menus'
 * is the first layer of Tailwind's shadow-lg; the prompt bar has none, so it starts sized but clear.
 */
export const SHADOW_AUTO: Record<ShadowPlace, Shadow> = {
  panel: { y: 10, blur: 15, spread: -3, color: "#000000", alpha: 10 },
  promptBar: { y: 8, blur: 24, spread: 0, color: "#000000", alpha: 0 },
  thumb: { y: 1, blur: 2, spread: 0, color: "#000000", alpha: 25 },
};
/** A shadow's measures, in the order the panel shows them. */
export const SHADOW_SPECS: readonly {
  key: Exclude<keyof Shadow, "color">;
  label: string;
  min: number;
  max: number;
  unit: string;
}[] = [
  { key: "alpha", label: "Opacity", min: 0, max: 100, unit: "%" },
  { key: "y", label: "Offset Y", min: -32, max: 64, unit: "px" },
  { key: "blur", label: "Blur", min: 0, max: 96, unit: "px" },
  { key: "spread", label: "Spread", min: -32, max: 32, unit: "px" },
];

/** The shadow a place is drawn with: the palette's own, else the place's. */
export const shownShadow = (palette: Palette, place: ShadowPlace): Shadow =>
  palette.shadows?.[place] ?? SHADOW_AUTO[place];

/** A shadow in a line: `y 1 · blur 2 · spread 0 · #000000 25%`. */
export const shadowText = (s: Shadow | undefined): string =>
  s ? `y ${s.y} · blur ${s.blur} · spread ${s.spread} · ${s.color} ${s.alpha}%` : "auto";

/** The shadows `palette` has changed from the preset's own. */
export const changedShadows = (preset: ThemePreset, palette: Palette): ShadowPlace[] =>
  SHADOW_PLACES.filter((place) => shadowText(palette.shadows?.[place]) !== shadowText(preset.colors.shadows?.[place]));

/** How many roles and shadows `palette` has changed from the preset's own. */
export const changeCount = (preset: ThemePreset, palette: Palette): number =>
  changedRoles(preset, palette).length + changedShadows(preset, palette).length;

/** One preset's tweak: its roles as edited, and the knobs over them. */
export type Draft = { colors: Palette; knobs: Knobs };

/** Whether every knob leaves the palette as it is. */
export const knobsAreIdentity = (k: Knobs): boolean =>
  k.lift === 0 && k.depth === 100 && k.saturation === 100 && k.tint === 0;

/** A fresh draft of `preset`: its colours as designed. */
export const freshDraft = (preset: ThemePreset): Draft => ({ colors: { ...preset.colors }, knobs: IDENTITY_KNOBS });

/** One neutral under the knobs, in OKLab: lightness by its place, colour scaled then tinted. */
function knobbed(color: string, lightness: (l: number) => number, k: Knobs): string {
  const [l, c, h] = oklch(color);
  const scale = k.saturation / 100;
  const tint = (k.tint / 100) * TINT_MAX_CHROMA;
  const a = c * Math.cos(h) * scale + tint * Math.cos(k.tintHue * DEGREE);
  const b = c * Math.sin(h) * scale + tint * Math.sin(k.tintHue * DEGREE);
  const next = Math.min(1, Math.max(0, lightness(l)));
  return fromOklch(next, Math.hypot(a, b), Math.atan2(b, a));
}

/** The palette the knobs make of `colors`; the accent and statuses are left as they are. */
export function applyKnobs(colors: Palette, k: Knobs): Palette {
  if (knobsAreIdentity(k)) return colors;
  const canvas = oklch(colors[CANVAS])[0];
  const lift = k.lift * LIGHTNESS_POINT;
  const out = { ...colors };
  out[CANVAS] = knobbed(colors[CANVAS], (l) => l + lift, k);
  for (const role of LAYERS)
    out[role] = knobbed(colors[role], (l) => canvas + lift + (l - canvas) * (k.depth / 100), k);
  for (const role of TEXT) out[role] = knobbed(colors[role], (l) => l, k);
  return out;
}

/** What the draft shows. */
export const shownPalette = (draft: Draft): Palette => applyKnobs(draft.colors, draft.knobs);

/** The draft with its knobs written into its colours and set back to identity. */
export const baked = (draft: Draft): Draft => ({ colors: shownPalette(draft), knobs: IDENTITY_KNOBS });

/** The draft with one role set, or a detail left to the app (undefined); knobs are baked first. */
export function withColor(draft: Draft, role: AnyRole, color: string | undefined): Draft {
  const base = baked(draft);
  const colors: Palette = { ...base.colors };
  if (color) colors[role] = color;
  else if (isDetail(role)) delete colors[role];
  return { ...base, colors };
}

/** The draft with some roles and shadows set, as `withColor`; shadows are set place by place. */
export function withColors(draft: Draft, colors: Partial<Palette>): Draft {
  const base = baked(draft);
  const shadows = { ...base.colors.shadows, ...colors.shadows };
  const next: Palette = { ...base.colors, ...colors };
  if (Object.keys(shadows).length) next.shadows = shadows;
  return { ...base, colors: next };
}

/** The draft with one place's shadow set, or left to the place (undefined). */
export function withShadow(draft: Draft, place: ShadowPlace, shadow: Shadow | undefined): Draft {
  const base = baked(draft);
  const { [place]: _dropped, ...rest } = base.colors.shadows ?? {};
  const shadows: Shadows = shadow ? { ...rest, [place]: shadow } : rest;
  const { shadows: _old, ...colors } = base.colors;
  return { ...base, colors: Object.keys(shadows).length ? { ...colors, shadows } : colors };
}

/** The roles `palette` has changed from the preset's own. */
export const changedRoles = (preset: ThemePreset, palette: Palette): AnyRole[] =>
  ALL_ROLES.filter((role) => palette[role] !== preset.colors[role]);

/** The family a preset's id names: `genex` for `genex-dark`. */
export const presetFamily = (preset: ThemePreset): string => preset.id.replace(new RegExp(`-${preset.scheme}$`), "");

/** The same family's preset in `scheme`, else that scheme's Genex. */
export function counterpart(preset: ThemePreset, scheme: Scheme, all: readonly ThemePreset[]): ThemePreset {
  if (preset.scheme === scheme) return preset;
  const family = presetFamily(preset);
  const found = all.find((p) => p.scheme === scheme && presetFamily(p) === family);
  return found ?? all.find((p) => p.id === defaultPresetId(scheme)) ?? preset;
}

/** `palette` as the preset's entry in `PRESETS`, ready to paste over it in `appearance/themes.ts`. */
export function presetCode(preset: ThemePreset, palette: Palette): string {
  const scheme = preset.scheme === Scheme.Dark ? "Scheme.Dark" : "Scheme.Light";
  const head = `  preset(${JSON.stringify(presetFamily(preset))}, ${JSON.stringify(preset.name)}, ${scheme}, [`;
  const colors = DETAIL_ROLES.flatMap((role) => (palette[role] ? [`    ${role}: "${palette[role]}",`] : []));
  const shadows = SHADOW_PLACES.flatMap((place) => {
    const s = palette.shadows?.[place];
    if (!s) return [];
    return [
      `      ${place}: { y: ${s.y}, blur: ${s.blur}, spread: ${s.spread}, color: "${s.color}", alpha: ${s.alpha} },`,
    ];
  });
  const details = shadows.length ? [...colors, "    shadows: {", ...shadows, "    },"] : colors;
  const close = details.length ? ["  ], {", ...details, "  }),"] : ["  ]),"];
  return [head, ...COLOR_ROLES.map((role) => `    "${palette[role]}",`), ...close].join("\n");
}

/** The changed roles, one per line (`Canvas background #1d1d1f → #1b1b1e`), under the preset's name. */
export function changesText(preset: ThemePreset, palette: Palette): string {
  const lines = changedRoles(preset, palette).map(
    (role) => `  ${ROLE_LABEL[role]} (${role}): ${preset.colors[role] ?? "auto"} → ${palette[role] ?? "auto"}`,
  );
  for (const place of changedShadows(preset, palette)) {
    const [before, after] = [preset.colors.shadows?.[place], palette.shadows?.[place]].map(shadowText);
    lines.push(`  ${SHADOW_LABEL[place].label} shadow (shadows.${place}): ${before} → ${after}`);
  }
  return [`${preset.name} · ${preset.scheme}`, ...(lines.length ? lines : ["  (unchanged)"])].join("\n");
}

const SHADOW_ASSIGNMENT = new RegExp(`\\b(${SHADOW_PLACES.join("|")})\\b["']?\\s*:\\s*\\{([^{}]*)\\}`, "g");
const SHADOW_FIELD = /\b(y|blur|spread|alpha|color)["']?\s*:\s*["']?(-?\d+(?:\.\d+)?|#[\da-f]{3,6})\b/gi;
const ROLE_ASSIGNMENT = new RegExp(`\\b(${ALL_ROLES.join("|")})\\b["']?\\s*[:=]\\s*["']?(#[\\da-f]{3,6})\\b`, "gi");
const HEX_IN_TEXT = /#(?:[\da-f]{6}|[\da-f]{3})\b/gi;

/** The shadows in pasted text: `place: { y, blur, spread, color, alpha }`, each only when complete. */
function pastedShadows(text: string): Shadows {
  const found: Shadows = {};
  for (const [, place, body = ""] of text.matchAll(SHADOW_ASSIGNMENT)) {
    const fields = [...body.matchAll(SHADOW_FIELD)].map(([, key = "", value = ""]) => {
      const isColor = key.toLowerCase() === "color";
      return [key.toLowerCase(), isColor ? value : Number(value)] as const;
    });
    const read = shadowOf(Object.fromEntries(fields));
    const known = SHADOW_PLACES.find((p) => p === place);
    if (known && read) found[known] = read;
  }
  return found;
}

/**
 * Colours pasted as text: `role: #hex` pairs, fourteen hex values in core role order (a copied
 * `preset(...)` entry, whose details are keyed) and its shadows. Null when none is there.
 */
export function pastedColors(pasted: string): Partial<Palette> | null {
  const shadows = pastedShadows(pasted);
  const text = pasted.replace(SHADOW_ASSIGNMENT, "");
  const keyed: Partial<Palette> = Object.keys(shadows).length ? { shadows } : {};
  for (const [, key, value] of text.matchAll(ROLE_ASSIGNMENT)) {
    const role = ALL_ROLES.find((r) => r.toLowerCase() === key?.toLowerCase());
    const color = hex(value);
    if (role && color) keyed[role] = color;
  }
  const values = [...text.replace(ROLE_ASSIGNMENT, "").matchAll(HEX_IN_TEXT)].map(([value]) => hex(value));
  const ordered =
    values.length >= COLOR_ROLES.length ? Object.fromEntries(COLOR_ROLES.map((r, i) => [r, values[i]])) : {};
  const colors = { ...ordered, ...keyed } as Partial<Palette>;
  return Object.keys(colors).length ? colors : null;
}

/** How well a role reads: its worst contrast where it is drawn, and the least WCAG AA asks of it. */
export type Readability = { ratio: number; minimum: number };

/** A role's contrast where it is drawn: text and icons on the surfaces, the accent button's label on its fills. */
export function readability(palette: Palette, role: AnyRole): Readability | null {
  const worst = (color: string, grounds: string[]) => Math.min(...grounds.map((bg) => contrastRatio(color, bg)));
  const surfaces = SURFACES.map((s) => palette[s]);
  if (READ_ON_SURFACES.includes(role))
    return { ratio: worst(shownColor(palette, role), surfaces), minimum: TEXT_CONTRAST };
  if (role === "icon") return { ratio: worst(shownColor(palette, role), surfaces), minimum: GRAPHIC_CONTRAST };
  // The graph writes its live status words in this colour, on the canvas and on its nodes.
  if (role === "graph")
    return { ratio: worst(shownColor(palette, role), [palette.background, palette.surface]), minimum: TEXT_CONTRAST };
  // The current sidebar row's icon sits on the selected fill, a faint lift of the sidebar.
  if (role === "logo" || role === "logoShade" || role === "iconSelected")
    return { ratio: contrastRatio(shownColor(palette, role), palette.sidebar), minimum: GRAPHIC_CONTRAST };
  // The onboarding art and the empty-state cube draw their lines and glows in this colour on the canvas.
  if (role === "art" || role === "wireArt")
    return { ratio: contrastRatio(shownColor(palette, role), palette.background), minimum: GRAPHIC_CONTRAST };
  // The sidebar writes the current and hovered game or page name in the text colour on these rows.
  if (isSidebarRow(role))
    return { ratio: contrastRatio(palette.foreground, shownColor(palette, role)), minimum: TEXT_CONTRAST };
  const pair = ON_GROUND.find((p) => [...p.marks, ...p.grounds].some((r) => r === role));
  if (!pair) return null;
  const grounds = pair.grounds.map((ground) => shownColor(palette, ground));
  const ratio = Math.min(...pair.marks.map((mark) => worst(shownColor(palette, mark), grounds)));
  return { ratio, minimum: pair.minimum };
}

/** The CSS variables a role drives: those that change when only that role does. */
export function drivenVariables(palette: Palette, role: AnyRole): string[] {
  const before = themeVariables(palette, DEFAULT_CONTRAST);
  const probe = palette[role] === "#ff00ff" ? "#00ff00" : "#ff00ff";
  const after = themeVariables({ ...palette, [role]: probe }, DEFAULT_CONTRAST);
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((key) => before[key] !== after[key]);
}

/** Every preset the tweaker can open: the built-in ones, then the saved custom ones. */
export const tweakablePresets = (saved: readonly ThemePreset[]): ThemePreset[] => [...PRESETS, ...saved];
