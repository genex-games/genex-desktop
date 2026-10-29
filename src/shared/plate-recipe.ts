/**
 * Pro nameplates: the moving art behind a Pro's name at the foot of the sidebar. Everything one is
 * (the piece, its colours, its own takes and the dials every piece shares) comes from the account
 * id and the variant the person rolled, the way the avatar does. Variant 0 is one of the avatar
 * body's pieces in the avatar's own colours, so the face and the plate match; any other variant is
 * a fresh roll of any piece. The orders of the tables below are part of the recipe: an id picks an
 * entry by its index.
 */
import { AvatarBody, AVATAR_VARIANT_MAX, avatarRecipe, isAvatarVariant } from "./avatar-recipe.ts";

/** The pieces, in recipe order: a piece's index is which shader draws it. */
export const PlateScene = {
  NeonRain: "neon-rain",
  CodeRain: "code-rain",
  FlowLines: "flow-lines",
  PixelSort: "pixel-sort",
  FluidGradient: "fluid-gradient",
  Moire: "moire",
  VoronoiGlow: "voronoi-glow",
  AsciiField: "ascii-field",
  SignalLines: "signal-lines",
  TruchetFlow: "truchet-flow",
  Electric: "electric",
  Kaleido: "kaleido",
  Spectrum: "spectrum",
  NeonTunnel: "neon-tunnel",
  Hyperspace: "hyperspace",
  Datamosh: "datamosh",
  HoloCard: "holo-card",
  LiquidChrome: "liquid-chrome",
  Aurora: "aurora",
  NeonCity: "neon-city",
} as const;
export type PlateScene = (typeof PlateScene)[keyof typeof PlateScene];
/** Every piece, in recipe order. */
export const PLATE_SCENES: readonly PlateScene[] = Object.values(PlateScene);

/** The pieces each avatar body draws its first plate from. */
const FAMILY = {
  [AvatarBody.Vapor]: [PlateScene.FluidGradient, PlateScene.NeonTunnel, PlateScene.Moire],
  [AvatarBody.Crt]: [PlateScene.Spectrum, PlateScene.AsciiField, PlateScene.NeonCity],
  [AvatarBody.Matrix]: [PlateScene.CodeRain, PlateScene.AsciiField, PlateScene.NeonRain],
  [AvatarBody.Holo]: [PlateScene.HoloCard, PlateScene.FlowLines, PlateScene.FluidGradient],
  [AvatarBody.Circuit]: [PlateScene.TruchetFlow, PlateScene.SignalLines, PlateScene.Spectrum],
  [AvatarBody.Toon]: [PlateScene.FluidGradient, PlateScene.Kaleido, PlateScene.VoronoiGlow],
  [AvatarBody.Glitch]: [PlateScene.Datamosh, PlateScene.PixelSort, PlateScene.Electric],
  [AvatarBody.Chrome]: [PlateScene.LiquidChrome, PlateScene.Moire, PlateScene.NeonTunnel],
  [AvatarBody.Halftone]: [PlateScene.Moire, PlateScene.SignalLines, PlateScene.Kaleido],
  [AvatarBody.Foil]: [PlateScene.HoloCard, PlateScene.Aurora, PlateScene.FlowLines],
  [AvatarBody.Neon]: [PlateScene.NeonRain, PlateScene.NeonCity, PlateScene.NeonTunnel],
  [AvatarBody.Galaxy]: [PlateScene.Hyperspace, PlateScene.Aurora, PlateScene.VoronoiGlow],
} as const satisfies Record<AvatarBody, readonly PlateScene[]>;

/** The five colours every piece paints with, as `#rrggbb`. */
export interface PlateColors {
  /** Near black: the ground. */
  deep: string;
  /** Dark: the far layers. */
  mid: string;
  /** The palette's most colourful entry: the main light. */
  acc: string;
  /** Bright: highlights. */
  light: string;
  /** The avatar's glow: the name, the PRO mark and the sparkles shine in it. */
  glow: string;
}

/**
 * The dials every piece shares, each 0..1, in the order the shader reads them: zoom, speed, warp,
 * mirror, hue, glow, grain and colour steps.
 */
export interface PlateDials {
  zoom: number;
  speed: number;
  warp: number;
  mirror: number;
  hue: number;
  glow: number;
  grain: number;
  steps: number;
}

/** Everything one nameplate is. */
export interface PlateRecipe {
  scene: PlateScene;
  /** The piece's index in {@link PLATE_SCENES}: which shader draws it. */
  sceneIndex: number;
  /** The shader's seed, below 1047. */
  seed: number;
  /** The piece's own takes (rain or fog, a moon or none, ...), each 0..1. */
  vars: readonly [number, number, number, number];
  dials: PlateDials;
  colors: PlateColors;
  /** The row's own colour under the art: a deep shade of the accent. */
  tint: string;
}

/** A variant is what an avatar's is: 0 (the account's first plate) up to the largest. */
export const PLATE_VARIANT_MAX = AVATAR_VARIANT_MAX;
/** Whether `value` names a plate variant. */
export const isPlateVariant = isAvatarVariant;

/** A new variant for a plate on `current`: never the one it has, from `random` in [0, 1). */
export function nextPlateVariant(current: number, random: number): number {
  const next = 1 + Math.floor(random * PLATE_VARIANT_MAX);
  return next === current ? (next % PLATE_VARIANT_MAX) + 1 : next;
}

/** The deep colour is pushed down until its luminance is at most this: every piece reads as night. */
const DEEP_MAX_LUMA = 0.09;
/** The mid colour is pushed toward deep until its luminance is at most this. */
const MID_MAX_LUMA = 0.32;
/** A light colour dimmer than this is lifted toward white. */
const LIGHT_MIN_LUMA = 0.6;
/** A glow dimmer or greyer than these borrows the accent instead. */
const GLOW_MIN_LUMA = 0.45;
const GLOW_MIN_CHROMA = 0.15;
/** How many halving steps a colour is pushed at most. */
const PUSH_STEPS = 6;
/** How much of the accent the row's tint holds over near black. */
const TINT_SHARE = 0.24;
/** The ground the tint and the deep colour are pushed toward. */
const NIGHT = "#0b0b0e";
const NEAR_BLACK = "#05050a";
const WHITE = "#ffffff";

type Rgb = readonly [number, number, number];

const rgbOf = (hex: string): Rgb => [
  Number.parseInt(hex.slice(1, 3), 16) / 255,
  Number.parseInt(hex.slice(3, 5), 16) / 255,
  Number.parseInt(hex.slice(5, 7), 16) / 255,
];
const channel = (value: number): string =>
  Math.round(Math.max(0, Math.min(1, value)) * 255)
    .toString(16)
    .padStart(2, "0");
const hexOf = ([r, g, b]: Rgb): string => `#${channel(r)}${channel(g)}${channel(b)}`;
const luma = (hex: string): number => {
  const [r, g, b] = rgbOf(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};
const chroma = (hex: string): number => {
  const rgb = rgbOf(hex);
  return Math.max(...rgb) - Math.min(...rgb);
};
/** `share` of `a` over `b`. */
function mixHex(a: string, b: string, share: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  return hexOf([
    x[0] * share + y[0] * (1 - share),
    x[1] * share + y[1] * (1 - share),
    x[2] * share + y[2] * (1 - share),
  ]);
}

/** A colour with its hue turned `turn` radians in YIQ, as the avatar's shader turns its palette. */
export function turnHue(hex: string, turn: number): string {
  const [r, g, b] = rgbOf(hex);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const i0 = 0.596 * r - 0.274 * g - 0.322 * b;
  const q0 = 0.211 * r - 0.523 * g + 0.312 * b;
  const i = i0 * Math.cos(turn) - q0 * Math.sin(turn);
  const q = i0 * Math.sin(turn) + q0 * Math.cos(turn);
  return hexOf([y + 0.956 * i + 0.621 * q, y - 0.272 * i - 0.647 * q, y - 1.106 * i + 1.703 * q]);
}

/** Push `hex` toward `toward` until its luminance is at most `max`. */
function darkenTo(hex: string, toward: string, max: number, share: number): string {
  let out = hex;
  for (let step = 0; step < PUSH_STEPS && luma(out) > max; step++) out = mixHex(out, toward, share);
  return out;
}

/** A glow worth shining in: the avatar's own, or the accent when that is too dim or grey. */
function glowFrom(glow: string, acc: string): string {
  if (luma(glow) >= GLOW_MIN_LUMA && chroma(glow) >= GLOW_MIN_CHROMA) return glow;
  return luma(acc) > 0.3 ? acc : mixHex(acc, WHITE, 0.4);
}

/** The five colours from an avatar's four, hue-turned, sorted by luminance and kept dark at the bottom. */
export function plateColors(palette: readonly string[], turn: number, glow: string): PlateColors {
  const sorted = palette.map((hex) => turnHue(hex, turn)).sort((a, b) => luma(a) - luma(b));
  const first = sorted[0] ?? NIGHT;
  const second = sorted[1] ?? NIGHT;
  const last = sorted[3] ?? WHITE;
  const acc = sorted.slice(1).reduce((best, hex) => (chroma(hex) > chroma(best) ? hex : best), second);
  const deep = darkenTo(first, NEAR_BLACK, DEEP_MAX_LUMA, 0.6);
  const mid = darkenTo(second === acc ? mixHex(acc, deep, 0.55) : second, deep, MID_MAX_LUMA, 0.3);
  const light = luma(last) < LIGHT_MIN_LUMA ? mixHex(last, WHITE, 0.5) : last;
  return { deep, mid, acc, light, glow: glowFrom(turnHue(glow, turn), acc) };
}

/** FNV-1a over the text's UTF-16 code units. */
function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619) >>> 0;
  return hash >>> 0;
}

/** Mulberry32: a small seeded stream of numbers in [0, 1). */
function stream(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The dials, from the roll's stream: warp and grain lean low so most plates stay clean. */
function rollDials(next: () => number): PlateDials {
  return {
    zoom: next(),
    speed: next(),
    warp: next() ** 1.4,
    mirror: next(),
    hue: next(),
    glow: next() * 0.85,
    grain: next() ** 2 * 0.8,
    steps: next(),
  };
}

/**
 * The nameplate an account id stands for. `variant` 0 is its first, drawn from the avatar the
 * account shows (`avatarVariant`, the one it regenerated to); a rolled one is another.
 */
export function plateRecipe(accountId: string, variant = 0, avatarVariant = 0): PlateRecipe {
  const first = variant === 0;
  const avatar = first ? avatarRecipe(accountId, avatarVariant) : avatarRecipe(`${accountId}#plate`, variant);
  const next = stream(fnv1a(first ? `${accountId}|0|${avatarVariant}` : `${accountId}|${variant}`));
  const family = FAMILY[avatar.body];
  const scene = first
    ? (family[Math.floor(next() * family.length)] ?? PlateScene.NeonRain)
    : (PLATE_SCENES[Math.floor(next() * PLATE_SCENES.length)] ?? PlateScene.NeonRain);
  const colors = plateColors(avatar.palette, avatar.turn, avatar.glow);
  const vars = [next(), next(), next(), next()] as const;
  const seed = avatar.seed + Math.floor(next() * 50);
  return {
    scene,
    sceneIndex: PLATE_SCENES.indexOf(scene),
    seed,
    vars,
    dials: rollDials(next),
    colors,
    tint: mixHex(colors.acc, NIGHT, TINT_SHARE),
  };
}
