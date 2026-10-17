/**
 * Home's background: a source (one picture, or a live shader from `shared/backdrop-shader.ts`)
 * and an effect drawn over it (lines, dots or characters, in the theme's ink for a picture and in
 * the shader's own colours for a live one). These are its settings, what each may hold, and how a
 * saved copy is read back; the drawing is `draw.ts`'s and `shader-stage.ts`'s.
 */
import { Scheme } from "../appearance/themes.ts";

/** What is behind home: nothing (its plain page), a picture, or a live shader. */
export const BackdropSource = {
  Off: "off",
  Picture: "picture",
  Shader: "shader",
} as const;
export type BackdropSource = (typeof BackdropSource)[keyof typeof BackdropSource];

/** How the source is drawn: as it is, or through marks (lines, dots or characters). */
export const BackdropEffect = {
  None: "none",
  Lines: "lines",
  Dots: "dots",
  Ascii: "ascii",
} as const;
export type BackdropEffect = (typeof BackdropEffect)[keyof typeof BackdropEffect];

/** A dot grid: square, or every other row shifted half a step (Ben-Day). */
export const DotGrid = {
  Regular: "regular",
  Benday: "benday",
} as const;
export type DotGrid = (typeof DotGrid)[keyof typeof DotGrid];

/** A colour for each theme: marks that suit the light page and the dark one differ. */
export type BackdropColors = Record<Scheme, string | null>;

/** Every setting of home's background. */
export interface BackdropSettings {
  source: BackdropSource;
  effect: BackdropEffect;
  /** A bundled picture (`builtin:<name>`) or one the user added (`upload:<id>`). */
  image: string;
  /** How strongly the drawing shows over the page, 0.1–1. */
  strength: number;
  /** The marks' colour in each theme as `#rrggbb`, or null for that theme's text colour. */
  colors: BackdropColors;
  /** Marks are left out where the ink is below this, 0–255: a hard edge between drawn and bare. */
  threshold: number;
  /** Image preparation, before the effect: softening, noise, midtones and levels. */
  blur: number;
  grain: number;
  gamma: number;
  blackPoint: number;
  whitePoint: number;
  /** Lines: columns across, and segments down each one. */
  lineColumns: number;
  lineRows: number;
  /** Dots: the grid's step and the smallest and largest dot, in points, and the grid's turn. */
  dotStep: number;
  dotMin: number;
  dotMax: number;
  dotGrid: DotGrid;
  dotAngle: number;
  /** Dots: a dot's corner radius in points (past half its size it is round), and how far dots stray. */
  dotCorner: number;
  dotNoise: number;
  /** ASCII: characters across, and the ramp from lightest to densest. */
  asciiColumns: number;
  asciiCharacters: string;
  /** Shader: the one drawn, bundled (`preset:<id>`) or made by a model (`custom:<id>`). */
  shader: string;
  /** Shader: how fast it moves (0 holds it still) and how large its pattern is. */
  speed: number;
  scale: number;
  /** Shader: how much its brightest parts glow, 0 for none. */
  glow: number;
  /** Shader: its two colours in each theme as `#rrggbb`, or null for the theme's ink and accent. */
  shaderColors: BackdropColors;
  shaderAccents: BackdropColors;
}

/** Decimal places a number shows: as many as its step has. */
export function backdropDecimals(key: BackdropNumber): number {
  const step = String(BACKDROP_RANGES[key].step);
  return step.includes(".") ? (step.split(".")[1]?.length ?? 0) : 0;
}

/** The numeric settings. */
export type BackdropNumber = {
  [K in keyof BackdropSettings]: BackdropSettings[K] extends number ? K : never;
}[keyof BackdropSettings];

/** Each number's range and step: what a slider offers and what a saved value is held to. */
export const BACKDROP_RANGES = {
  strength: { min: 0.1, max: 1, step: 0.05 },
  threshold: { min: 0, max: 255, step: 1 },
  blur: { min: 0, max: 10, step: 0.5 },
  grain: { min: 0, max: 1, step: 0.01 },
  gamma: { min: 0.2, max: 3, step: 0.05 },
  blackPoint: { min: 0, max: 254, step: 1 },
  whitePoint: { min: 1, max: 255, step: 1 },
  lineColumns: { min: 40, max: 480, step: 1 },
  lineRows: { min: 20, max: 300, step: 1 },
  dotStep: { min: 2, max: 24, step: 1 },
  dotMin: { min: 0, max: 12, step: 0.5 },
  dotMax: { min: 1, max: 24, step: 0.5 },
  dotAngle: { min: 0, max: 90, step: 1 },
  dotCorner: { min: 0, max: 12, step: 0.5 },
  dotNoise: { min: 0, max: 1, step: 0.05 },
  asciiColumns: { min: 40, max: 480, step: 1 },
  speed: { min: 0, max: 2, step: 0.05 },
  scale: { min: 0.5, max: 2, step: 0.05 },
  glow: { min: 0, max: 1.5, step: 0.05 },
} as const satisfies Record<BackdropNumber, { min: number; max: number; step: number }>;

/** The longest character ramp, and the shortest that still draws a picture. */
export const ASCII_RAMP_MAX = 24;
const ASCII_RAMP_MIN = 2;

/** The picture home starts with. */
export const DEFAULT_BACKDROP_IMAGE = "builtin:city";
/** The shader a live background starts with, and home's background before anything is chosen. */
export const DEFAULT_BACKDROP_SHADER = "preset:datamosh";
const IMAGE_ID = /^(builtin:[a-z-]+|upload:[A-Za-z0-9-]+)$/;
/** A bundled shader's id, or a made one's (`custom-shaders.ts`). */
export const SHADER_ID = /^(preset:[a-z-]+|custom:[A-Za-z0-9-]+)$/;
/** Each theme's own colours: what a live background draws in until colours are picked. */
export const THEME_COLORS: BackdropColors = Object.freeze({ [Scheme.Light]: null, [Scheme.Dark]: null });
const HEX_COLOR = /^#[0-9a-f]{6}$/;

/** The settings an effect's look is tuned by: how strongly it shows, how the scene moves, and how the scene is read into ink. */
export type EffectLook = Pick<
  BackdropSettings,
  "strength" | "speed" | "scale" | "glow" | "threshold" | "grain" | "gamma" | "blackPoint" | "whitePoint"
>;

/** Lines' look: faint hairlines that fill in where the scene is bright, lightly grained, slow. */
const LINES_LOOK: EffectLook = Object.freeze({
  strength: 0.15,
  speed: 0.35,
  scale: 1.5,
  glow: 0.75,
  threshold: 23,
  grain: 0.42,
  gamma: 1.25,
  blackPoint: 142,
  whitePoint: 255,
});

/**
 * Each effect's tuned look, put in place when the effect is chosen (the sliders then move it on);
 * with no effect the look stays as it was.
 */
/** Dots' look: one size of dot, on or off at a hard edge, so the scene reads as a clean silhouette. */
const DOTS_LOOK: EffectLook = Object.freeze({
  strength: 0.55,
  speed: 0.05,
  scale: 1.15,
  glow: 0.1,
  threshold: 42,
  grain: 0.37,
  gamma: 1.3,
  blackPoint: 117,
  whitePoint: 118,
});

export const EFFECT_LOOKS: Readonly<Record<BackdropEffect, EffectLook | null>> = Object.freeze({
  [BackdropEffect.None]: null,
  [BackdropEffect.Lines]: LINES_LOOK,
  [BackdropEffect.Dots]: DOTS_LOOK,
  // Characters keep Dots' clean silhouette, with a softer edge so the ramp shows through it.
  [BackdropEffect.Ascii]: Object.freeze({ ...DOTS_LOOK, blackPoint: 105, whitePoint: 175 }),
});

/**
 * Home starts behind a quiet live background: fine lines over Datamosh on the City picture, in
 * white and a pale steel blue on either page.
 */
export const DEFAULT_BACKDROP: Readonly<BackdropSettings> = Object.freeze({
  source: BackdropSource.Shader,
  effect: BackdropEffect.Lines,
  image: DEFAULT_BACKDROP_IMAGE,
  ...LINES_LOOK,
  colors: THEME_COLORS,
  blur: 5,
  lineColumns: 462,
  lineRows: 300,
  dotStep: 3,
  dotMin: 1.5,
  dotMax: 1.5,
  dotGrid: DotGrid.Regular,
  dotAngle: 23,
  dotCorner: 11,
  dotNoise: 0.15,
  asciiColumns: 274,
  asciiCharacters: " .:-=+*#%@",
  shader: DEFAULT_BACKDROP_SHADER,
  shaderColors: Object.freeze({ [Scheme.Light]: "#ffffff", [Scheme.Dark]: "#ffffff" }),
  shaderAccents: Object.freeze({ [Scheme.Light]: "#a9bad6", [Scheme.Dark]: "#a9bad6" }),
});

/** Settings drawing `effect`, in its tuned look when it is a new choice. */
export function withEffect(previous: BackdropSettings, effect: BackdropEffect): BackdropSettings {
  const look = previous.effect === effect ? null : EFFECT_LOOKS[effect];
  return { ...previous, ...look, effect };
}

const SOURCES: ReadonlySet<unknown> = new Set<BackdropSource>(Object.values(BackdropSource));
const EFFECTS: ReadonlySet<unknown> = new Set<BackdropEffect>(Object.values(BackdropEffect));
/** What `effect` held before the source had a field of its own: Off and the live shader were effects. */
const LEGACY_OFF = "off";
const LEGACY_SHADER = "shader";

/** The source and effect saved, reading settings from before the source was its own field. */
function lookFrom(source: Record<string, unknown>): Pick<BackdropSettings, "source" | "effect"> {
  const effect = EFFECTS.has(source.effect) ? (source.effect as BackdropEffect) : null;
  if (SOURCES.has(source.source))
    return { source: source.source as BackdropSource, effect: effect ?? DEFAULT_BACKDROP.effect };
  if (source.effect === LEGACY_OFF) return { source: BackdropSource.Off, effect: DEFAULT_BACKDROP.effect };
  if (source.effect === LEGACY_SHADER) return { source: BackdropSource.Shader, effect: BackdropEffect.None };
  // An effect saved on its own is from before sources: it was drawn over the picture.
  if (effect) return { source: BackdropSource.Picture, effect };
  return { source: DEFAULT_BACKDROP.source, effect: DEFAULT_BACKDROP.effect };
}
const GRIDS: ReadonlySet<unknown> = new Set<DotGrid>(Object.values(DotGrid));

/** `value` snapped to `key`'s step inside its range, else the default. */
function numberIn(key: BackdropNumber, value: unknown): number {
  const { min, max, step } = BACKDROP_RANGES[key];
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_BACKDROP[key];
  const snapped = Math.round((value - min) / step) * step + min;
  return Number(Math.min(max, Math.max(min, snapped)).toFixed(4));
}

/** A ramp of printable characters, cut to its longest; too short a ramp is the default. */
function rampFrom(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_BACKDROP.asciiCharacters;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
  const ramp = Array.from(value.replace(/[\u0000-\u001f\u007f]/g, ""))
    .slice(0, ASCII_RAMP_MAX)
    .join("");
  return Array.from(ramp).length >= ASCII_RAMP_MIN ? ramp : DEFAULT_BACKDROP.asciiCharacters;
}

/** A saved colour: hex as it is, null as the theme's, anything else `fallback`. */
function colorFrom(value: unknown, fallback: string | null): string | null {
  if (value === null) return null;
  if (typeof value === "string" && HEX_COLOR.test(value.toLowerCase())) return value.toLowerCase();
  return fallback;
}

/**
 * Each theme's saved colour, else `defaults`'. A single `color` saved before the themes had their
 * own is not read: no one theme can claim it, so each starts from its default.
 */
function colorsFrom(value: unknown, defaults: BackdropColors = DEFAULT_BACKDROP.colors): BackdropColors {
  const saved = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    [Scheme.Light]: colorFrom(saved[Scheme.Light], defaults[Scheme.Light]),
    [Scheme.Dark]: colorFrom(saved[Scheme.Dark], defaults[Scheme.Dark]),
  };
}

/** Settings read from anything saved: each field it cannot use is its default. */
export function normalizeBackdrop(saved: unknown): BackdropSettings {
  const source = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const numbers = Object.fromEntries(
    (Object.keys(BACKDROP_RANGES) as BackdropNumber[]).map((key) => [key, numberIn(key, source[key])]),
  ) as Pick<BackdropSettings, BackdropNumber>;
  const settings: BackdropSettings = {
    ...numbers,
    ...lookFrom(source),
    image: typeof source.image === "string" && IMAGE_ID.test(source.image) ? source.image : DEFAULT_BACKDROP.image,
    dotGrid: GRIDS.has(source.dotGrid) ? (source.dotGrid as DotGrid) : DEFAULT_BACKDROP.dotGrid,
    colors: colorsFrom(source.colors),
    asciiCharacters: rampFrom(source.asciiCharacters),
    shader:
      typeof source.shader === "string" && SHADER_ID.test(source.shader) ? source.shader : DEFAULT_BACKDROP.shader,
    shaderColors: colorsFrom(source.shaderColors, DEFAULT_BACKDROP.shaderColors),
    shaderAccents: colorsFrom(source.shaderAccents, DEFAULT_BACKDROP.shaderAccents),
  };
  // Levels need a range to stretch: the white point stays above the black.
  if (settings.whitePoint <= settings.blackPoint) settings.whitePoint = Math.min(255, settings.blackPoint + 1);
  if (settings.dotMin > settings.dotMax) settings.dotMin = settings.dotMax;
  return settings;
}
