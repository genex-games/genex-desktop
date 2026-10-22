/**
 * Generated avatars: every Genex account gets its own animated avatar, and everything it is (the
 * body's shader, its palette and hue, the eyes and their rhythm, the gear) comes from the account
 * id alone. genex.games draws the same avatar from the same id, so this file is a contract: the
 * site keeps a copy, and `avatar-recipe.test.ts` pins ids to recipes that both copies must answer.
 * The orders of the tables below are part of it: an id picks an entry by its index.
 *
 * Eyes are lit hardware, never cartoon features: no brows, mouths or glossy lenses.
 */

/** The twelve body shaders, in recipe order. */
export const AvatarBody = {
  Vapor: "vapor",
  Crt: "crt",
  Matrix: "matrix",
  Holo: "holo",
  Circuit: "circuit",
  Toon: "toon",
  Glitch: "glitch",
  Chrome: "chrome",
  Halftone: "halftone",
  Foil: "foil",
  Neon: "neon",
  Galaxy: "galaxy",
} as const;
export type AvatarBody = (typeof AvatarBody)[keyof typeof AvatarBody];
/** Every body, in recipe order: a body's index is what its shader branches on. */
export const AVATAR_BODIES: readonly AvatarBody[] = Object.values(AvatarBody);

/** The seven eye styles, in recipe order. */
export const AvatarEyes = {
  /** Plain squares on the body's pixel grid: the mood is the silhouette. */
  Blocks: "blocks",
  /** Slanted slits, the inner end low, flickering, with a white-hot surge now and then. */
  Blades: "blades",
  /** Low-poly flat-shaded triangles on a coarse wobbling grid. */
  Shards: "shards",
  /** Level vents with light behind them and a sweep down the stack. */
  Grille: "grille",
  /** One plain slit and one square implant whose brackets hunt and lock. */
  Optic: "optic",
  /** One flat six- or eight-blade aperture that turns and shuts. */
  Mono: "mono",
  /** Burning slit pupils. */
  Demon: "demon",
} as const;
export type AvatarEyes = (typeof AvatarEyes)[keyof typeof AvatarEyes];
const EYES: readonly AvatarEyes[] = Object.values(AvatarEyes);

/** How block eyes look, said only through their shape, in recipe order. */
export const BlockState = {
  Steady: "steady",
  Wide: "wide",
  Cold: "cold",
  Slit: "slit",
  Menace: "menace",
  Fury: "fury",
  Tired: "tired",
  Squint: "squint",
  Scan: "scan",
} as const;
export type BlockState = (typeof BlockState)[keyof typeof BlockState];
const STATES: readonly BlockState[] = Object.values(BlockState);

/** Gear, in recipe order: flat-shaded like a PS1 model, with a hot rim in the body's light. */
export const AvatarGear = {
  None: "none",
  Horns: "horns",
  Blades: "blades",
  Spikes: "spikes",
  /** A mast with a blinking red LED. */
  Mast: "mast",
  /** A cable jack in the side. */
  Jack: "jack",
  Headset: "headset",
  /** A glowing mark on the forehead. */
  Sigil: "sigil",
  /** A glowing crack from the crown past one eye. */
  Scar: "scar",
} as const;
export type AvatarGear = (typeof AvatarGear)[keyof typeof AvatarGear];
const GEAR: readonly AvatarGear[] = Object.values(AvatarGear);

/** Gear that stands behind the body (and so needs room above it). */
const BACK_GEAR: readonly AvatarGear[] = [AvatarGear.Horns, AvatarGear.Blades, AvatarGear.Spikes, AvatarGear.Mast];
/** Gear marked on the shell itself, which stays at every size. */
const SKIN_GEAR: readonly AvatarGear[] = [AvatarGear.Scar, AvatarGear.Sigil];

/** Whether `gear` is drawn behind the body. */
export const hasBackGear = (gear: AvatarGear): boolean => BACK_GEAR.includes(gear);
/** Whether `gear` is a mark on the shell, kept even where gear is left out. */
export const isSkinGear = (gear: AvatarGear): boolean => SKIN_GEAR.includes(gear);

type Palette = readonly [string, string, string, string];

/** Each body's palettes, in recipe order. */
const PALETTES: readonly (readonly Palette[])[] = [
  [
    ["#ffe66d", "#ff6ad5", "#7b2ff7", "#00f0ff"],
    ["#ffd1a6", "#ff5f9e", "#3d1d7a", "#40e0d0"],
    ["#fff1a8", "#ff8a5c", "#b4247a", "#6bf2ff"],
  ],
  [
    ["#0f380f", "#306230", "#8bac0f", "#c4d82a"],
    ["#000000", "#aa00aa", "#55ffff", "#ffffff"],
    ["#1a0f00", "#6b3d00", "#e08a00", "#ffd27a"],
    ["#352879", "#6c5eb5", "#9a9ae0", "#ffffff"],
  ],
  [
    ["#020a04", "#00ff66", "#d8ffe6", "#0a3d1c"],
    ["#02080c", "#00e5ff", "#e0fbff", "#06323d"],
    ["#0c0204", "#ff2a55", "#ffd6de", "#3d0610"],
  ],
  [
    ["#060a1a", "#00e5ff", "#ff3df2", "#ffffff"],
    ["#08060f", "#7cff6b", "#00b3ff", "#ffffff"],
    ["#0a0612", "#ffb800", "#ff3d6e", "#ffffff"],
  ],
  [
    ["#0b0f14", "#1e2a38", "#ffcf5a", "#5affc8"],
    ["#0d0a12", "#2a1e3a", "#ff4fd8", "#7cf7ff"],
    ["#0a1210", "#18342c", "#7cff9b", "#e8ffef"],
  ],
  [
    ["#ffb3c7", "#e0708f", "#fff0f4", "#7a5cff"],
    ["#a8e6ff", "#5aa9d6", "#f0fbff", "#ff7ab6"],
    ["#ffe08a", "#e0a040", "#fff8e0", "#5a7cff"],
    ["#c9b3ff", "#8a6ad8", "#f4efff", "#ff9a5a"],
  ],
  [
    ["#ff2a6d", "#05d9e8", "#1b1b3a", "#ffffff"],
    ["#f9f871", "#ff00a0", "#2a0a3a", "#ffffff"],
    ["#00ff9f", "#bd00ff", "#0a0a1a", "#ffffff"],
  ],
  [
    ["#ff7ad9", "#2a1b5c", "#ffffff", "#7cf7ff"],
    ["#7cc8ff", "#1a1a2e", "#ffffff", "#ff9ae6"],
    ["#ffd27a", "#2b1a10", "#ffffff", "#9ab8ff"],
  ],
  [
    ["#fff7e8", "#1a1a2a", "#ff4f6d", "#ffd84f"],
    ["#eef7ff", "#14213d", "#3a86ff", "#ffbe0b"],
    ["#fff0f6", "#2b1028", "#ff5fa2", "#7ae7ff"],
  ],
  [
    ["#e4e6f0", "#8a8fa8", "#ffffff", "#ffd6f5"],
    ["#ece6dc", "#a8988a", "#ffffff", "#c6f0ff"],
  ],
  [
    ["#07060f", "#ff2fd0", "#2ff3ff", "#fff36b"],
    ["#060a0a", "#39ff88", "#ff8a2f", "#2fa8ff"],
    ["#0a0610", "#b45cff", "#ff4f6d", "#5affc8"],
  ],
  [
    ["#05030f", "#6a2cff", "#ff4fb8", "#9ad8ff"],
    ["#020812", "#1f7aff", "#5affd0", "#ffd6f0"],
    ["#0a0306", "#ff5a2c", "#ffd36b", "#c28cff"],
  ],
];
/** Which bodies are dark shells (lit eyes glow) rather than light ones (lit eyes are dark cuts). */
const DARK = [false, false, true, true, true, false, true, false, false, false, true, true] as const;
/** The palette slot each body's light is, which the eyes and gear glow in. */
const GLOW_SLOT = [3, 3, 1, 1, 3, 3, 1, 3, 2, 3, 2, 3] as const;
/** How often each eye style is picked for a body that has a choice. */
const EYES_WEIGHTS = [20, 18, 12, 12, 12, 10, 16] as const;
const STATE_WEIGHTS = [16, 8, 14, 8, 14, 10, 8, 12, 10] as const;
const GEAR_WEIGHTS = [28, 12, 8, 9, 9, 8, 8, 8, 10] as const;
/** The eye tilts an id picks among, in radians. */
const TILTS = [-0.06, 0.04, 0.12, 0.2, 0.28, 0.12] as const;
/** Seeds stay below this prime, so the shader's noise offsets keep full float precision. */
const SEED_RANGE = 997;
/** The placeholder's shell: a quiet grey that sits behind real people. */
const GHOST_PALETTE: Palette = ["#e9e9ee", "#cfd0d8", "#f7f7fa", "#bfc1cc"];

/** Everything one avatar is. */
export interface AvatarRecipe {
  body: AvatarBody;
  /** The body's index in {@link AVATAR_BODIES}: what its shader branches on. */
  bodyIndex: number;
  palette: Palette;
  /** A dark shell: lit eyes glow on it. A light one: lit eyes are dark cuts with light inside. */
  dark: boolean;
  /** The colour the eyes and gear glow in. */
  glow: string;
  /** The shader's seed, below 997. */
  seed: number;
  /** How far the palette's hue is turned, in radians (a YIQ rotation). */
  turn: number;
  eyes: AvatarEyes;
  /** The block eyes' shape; set for every recipe, used only by block eyes. */
  state: BlockState;
  gear: AvatarGear;
  /** The eyes' shape: tilt (radians), length, thickness, gap and height, as shares of the radius. */
  tilt: number;
  len: number;
  thick: number;
  gap: number;
  eyeY: number;
  /** Which of the three fire colours demon eyes burn in. */
  fire: number;
  /** How many vents a grille eye has, less one. */
  slats: number;
  /** The side an optic's implant, a mast or a scar is on: 1 right, -1 left. */
  side: 1 | -1;
  /** How many blades a mono eye's aperture has: 6 or 8. */
  sides: number;
  /** How horns curl: 0, 1 or 2. */
  curl: number;
  /** Seconds between blinks, and where in that rhythm the avatar starts. */
  blink: number;
  phase: number;
}

/** FNV-1a over the id's UTF-16 code units. */
function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let at = 0; at < text.length; at++) hash = Math.imul(hash ^ text.charCodeAt(at), 16777619) >>> 0;
  return hash >>> 0;
}

/** A 32-bit finaliser, so neighbouring ids land far apart. */
function mix(value: number): number {
  let hash = (value ^ 0x9e3779b9) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** An index picked by `hash` with these weights. */
function pick(hash: number, weights: readonly number[]): number {
  const sum = weights.reduce((total, weight) => total + weight, 0);
  let left = hash % sum;
  for (const [index, weight] of weights.entries()) {
    if (left < weight) return index;
    left -= weight;
  }
  return 0;
}

const CRT_INDEX = AVATAR_BODIES.indexOf(AvatarBody.Crt);
const GLITCH_INDEX = AVATAR_BODIES.indexOf(AvatarBody.Glitch);

/** The eyes a body wears: CRT always blocks on its own grid, glitch a mono eye (60%) or an optic. */
function eyesFor(body: number, hash: number): number {
  if (body === CRT_INDEX) return EYES.indexOf(AvatarEyes.Blocks);
  if (body === GLITCH_INDEX) return hash % 10 < 6 ? EYES.indexOf(AvatarEyes.Mono) : EYES.indexOf(AvatarEyes.Optic);
  return pick(hash, EYES_WEIGHTS);
}

/** The eyes' shape and rhythm, from the second hash. */
function eyeShape(g: number) {
  return {
    tilt: TILTS[(g >>> 4) % TILTS.length] ?? 0,
    len: 0.42 + ((g >>> 7) % 4) * 0.035,
    thick: 0.11 + ((g >>> 9) % 3) * 0.02,
    fire: (g >>> 20) % 3,
    gap: 0.26 + (g % 4) * 0.025,
    eyeY: -0.06 + ((g >>> 11) % 4) * 0.04,
    slats: 2 + ((g >>> 13) % 3),
    side: (g >>> 15) % 2 ? (1 as const) : (-1 as const),
    sides: 6 + ((g >>> 16) % 2) * 2,
    curl: (g >>> 17) % 3,
    blink: 2.8 + ((g >>> 18) % 8) * 0.45,
    phase: ((g >>> 22) % 97) / 13,
  };
}

/** The largest avatar variant: a regenerated avatar is one of this many others per account. */
export const AVATAR_VARIANT_MAX = 2_147_483_647;

/** Whether `value` names an avatar variant: 0 (the account's first avatar) up to the largest. */
export const isAvatarVariant = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= AVATAR_VARIANT_MAX;

/** A new variant for an account on `current`: never the one it has, from `random` in [0, 1). */
export function nextAvatarVariant(current: number, random: number): number {
  const next = 1 + Math.floor(random * AVATAR_VARIANT_MAX);
  return next === current ? (next % AVATAR_VARIANT_MAX) + 1 : next;
}

/**
 * The avatar an account id stands for. `variant` 0 is the account's first avatar; a regenerated
 * one is another variant, hashed from the id and the variant together.
 */
export function avatarRecipe(accountId: string, variant = 0): AvatarRecipe {
  const h = mix(fnv1a(variant === 0 ? accountId : `${accountId}#${variant}`));
  const g = mix(h + 1);
  const k = mix(h + 2);
  const bodyIndex = h % AVATAR_BODIES.length;
  const palettes = PALETTES[bodyIndex] ?? PALETTES[0];
  const palette = palettes?.[(h >>> 5) % palettes.length] ?? GHOST_PALETTE;
  return {
    body: AVATAR_BODIES[bodyIndex] ?? AvatarBody.Vapor,
    bodyIndex,
    palette,
    dark: DARK[bodyIndex] ?? false,
    glow: palette[GLOW_SLOT[bodyIndex] ?? 3],
    seed: (h >>> 8) % SEED_RANGE,
    turn: (((h >>> 18) % 13) - 6) * 0.05,
    eyes: EYES[eyesFor(bodyIndex, g >>> 3)] ?? AvatarEyes.Blocks,
    state: STATES[pick(k >>> 17, STATE_WEIGHTS)] ?? BlockState.Steady,
    gear: GEAR[pick(k >>> 5, GEAR_WEIGHTS)] ?? AvatarGear.None,
    ...eyeShape(g),
  };
}

/** A placeholder where a person will be: a light grey shell, its own eyes, no gear and no hue. */
export function ghostRecipe(id: string): AvatarRecipe {
  const recipe = avatarRecipe(id);
  return {
    ...recipe,
    body: AvatarBody.Toon,
    bodyIndex: AVATAR_BODIES.indexOf(AvatarBody.Toon),
    palette: GHOST_PALETTE,
    dark: false,
    glow: GHOST_PALETTE[3],
    turn: 0,
    gear: AvatarGear.None,
  };
}
