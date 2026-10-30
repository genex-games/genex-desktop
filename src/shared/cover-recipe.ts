import { turnHue } from "./oklch.ts";

/**
 * Cover recipes: the agent picks a family, the host owns every pixel. A recipe is a family, its
 * look (a named palette, or a hue slot for the orb families) and a seed, plus optional motion.
 * The six named-palette families share one host-owned sphere program; each orb family is its own
 * program (`cover-orbs.ts`). Values arrive as uniforms, so a new game never writes shader code.
 */
export const COVER_PALETTES = {
  clouds: ["genex", "day", "night", "dawn", "mint", "storm"],
  aurora: ["aurora", "solar", "ice"],
  bands: ["amber", "ice", "rose"],
  marble: ["indigo", "jade", "onyx"],
  ember: ["lava", "violet", "toxic"],
  ocean: ["earth", "desert", "alien"],
} as const;
/** A family whose looks are named palettes, drawn by the shared sphere program. */
export type PaletteFamily = keyof typeof COVER_PALETTES;
/** Families ported from orbkit's MIT orbs; each takes a hue slot instead of a named palette. */
export const OrbFamily = {
  Orbital: "orbital",
  Bricks: "bricks",
  Plasma: "plasma",
  Pixel: "pixel",
  Caustic: "caustic",
  Tempest: "tempest",
  Nimbus: "nimbus",
  Terminal: "terminal",
  Voxel: "voxel",
  Meadow: "meadow",
  Galaxy: "galaxy",
  Thermal: "thermal",
} as const;
export type OrbFamily = (typeof OrbFamily)[keyof typeof OrbFamily];
export type CoverFamily = PaletteFamily | OrbFamily;
const ORB_FAMILIES: readonly OrbFamily[] = Object.values(OrbFamily);
/** Every family, in menu order: the six palette families first, so their program index holds. */
export const COVER_FAMILIES: CoverFamily[] = [...(Object.keys(COVER_PALETTES) as PaletteFamily[]), ...ORB_FAMILIES];
/** An orb family's hues: slot `n` turns its colours by `n × COVER_HUE_STEP` degrees. */
export const COVER_HUE_SLOTS = 9;
export const COVER_HUE_STEP = 40;
export type CoverRecipe = {
  kind: "recipe";
  family: CoverFamily;
  /** A palette family's named palette; absent for orb families. */
  palette?: string;
  /** An orb family's hue slot, 0 to COVER_HUE_SLOTS − 1; absent for palette families. */
  hue?: number;
  seed: number;
  /** 0 still to 1 lively; absent means the default pace. */
  motion?: number;
  /** Rolled by the host at birth; the agent may replace it once with a look that fits the game. */
  placeholder?: true;
};

/**
 * Seeds are below this prime: small enough that the sphere program's noise offsets keep full
 * float precision, and each game still draws its own.
 */
export const COVER_SEED_RANGE = 997;
/** FNV-1a's 32-bit offset basis and prime. */
const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/** The 21 named-palette looks, in menu order. */
export const COVER_LOOKS: ReadonlyArray<readonly [PaletteFamily, string]> = (
  Object.keys(COVER_PALETTES) as PaletteFamily[]
).flatMap((family) => COVER_PALETTES[family].map((palette) => [family, palette] as const));

/** What tells two covers apart: a family with its palette or hue slot. */
export type CoverLook = Pick<CoverRecipe, "family" | "palette" | "hue">;
export const isOrbFamily = (family: unknown): family is OrbFamily => ORB_FAMILIES.includes(family as OrbFamily);
const isCoverFamily = (family: unknown): family is CoverFamily => COVER_FAMILIES.includes(family as CoverFamily);
/** One key per look: `ember/violet`, `plasma@6`. */
export const coverLookKey = (look: CoverLook): string =>
  look.hue === undefined ? `${look.family}/${look.palette}` : `${look.family}@${look.hue}`;
function looksOf(family: CoverFamily): CoverLook[] {
  if (isOrbFamily(family)) return Array.from({ length: COVER_HUE_SLOTS }, (_, hue) => ({ family, hue }));
  return COVER_PALETTES[family].map((palette) => ({ family, palette }));
}
/** Every look a cover can take, in menu order. */
export const ALL_COVER_LOOKS: readonly CoverLook[] = COVER_FAMILIES.flatMap(looksOf);

/** Base, second base, detail, highlight and atmosphere for each look. */
const COLORS: Record<string, readonly [string, string, string, string, string]> = {
  "clouds/genex": ["#1b2a6b", "#5d8df0", "#8497c9", "#eef2ff", "#7aa2f7"],
  "clouds/day": ["#1f4fa8", "#6cc0ff", "#9db6dc", "#ffffff", "#9ad8ff"],
  "clouds/night": ["#050817", "#1d2f66", "#4f5d86", "#e6ecff", "#8aa0ff"],
  "clouds/dawn": ["#34488f", "#f0a67f", "#b49bb5", "#fff3e6", "#ffc6a4"],
  "clouds/mint": ["#0e4650", "#52c6b4", "#86b8b1", "#f0fffb", "#9ff2e1"],
  "clouds/storm": ["#1a2132", "#50618a", "#6d7a98", "#dde5f5", "#a3b5e8"],
  "aurora/aurora": ["#070b1f", "#1a2a55", "#54f2b0", "#b38cff", "#5fe0c0"],
  "aurora/solar": ["#0a0a14", "#1f2340", "#ffc452", "#5ff2c4", "#ffcf73"],
  "aurora/ice": ["#050d18", "#12304a", "#7ae3ff", "#c2f5ff", "#7fd6ff"],
  "bands/amber": ["#6b3f2a", "#e2b98a", "#f6e3c8", "#c2553a", "#ffc79a"],
  "bands/ice": ["#274b6b", "#9fd0e8", "#e8f6ff", "#3d6fa3", "#a8dcff"],
  "bands/rose": ["#3a1e3a", "#c98ab0", "#f7d9e8", "#7a2e5a", "#ffb3d6"],
  "marble/indigo": ["#1b1f3a", "#3a3f78", "#d9c6ff", "#ffffff", "#a99cff"],
  "marble/jade": ["#0f2e2a", "#1f5c50", "#bff0d8", "#ffffff", "#8ef0c8"],
  "marble/onyx": ["#0d0d10", "#2a2a33", "#e8e2d0", "#ffffff", "#d8d0b8"],
  "ember/lava": ["#0b0706", "#2b1510", "#ff5a1c", "#ffe08a", "#ff6424"],
  "ember/violet": ["#0f0a18", "#2a1640", "#b45cff", "#ffb3f0", "#c27aff"],
  "ember/toxic": ["#0a120a", "#1d2e16", "#8cff5a", "#e8ffb0", "#9dff6a"],
  "ocean/earth": ["#0b2d5c", "#1f7fb8", "#5f9a5a", "#f4f7ff", "#8cc8ff"],
  "ocean/desert": ["#123a5c", "#2a7fa0", "#c9a46a", "#ffffff", "#9fd3ff"],
  "ocean/alien": ["#2a0d3a", "#6b2a8a", "#3fd1a0", "#f5e8ff", "#c28cff"],
};

const RECIPE_KEYS = new Set(["kind", "family", "palette", "hue", "seed", "motion", "placeholder"]);
export const COVER_SEED_MAX = 0xffff;
const DEFAULT_MOTION = 0.6;

/** Whether `palette` is one of palette family `family`'s named palettes. */
export function isCoverLook(family: unknown, palette: unknown): family is PaletteFamily {
  return (
    typeof family === "string" &&
    Object.hasOwn(COVER_PALETTES, family) &&
    (COVER_PALETTES[family as PaletteFamily] as readonly string[]).includes(palette as string)
  );
}

const isHueSlot = (hue: unknown): boolean =>
  typeof hue === "number" && Number.isInteger(hue) && hue >= 0 && hue < COVER_HUE_SLOTS;
/** A palette family names a palette and no hue; an orb family takes a hue slot and no palette. */
function isValidLook(look: Partial<CoverLook>): boolean {
  if (isOrbFamily(look.family)) return look.palette === undefined && isHueSlot(look.hue);
  return look.hue === undefined && isCoverLook(look.family, look.palette);
}
const isSeedValue = (seed: unknown): boolean =>
  typeof seed === "number" && Number.isInteger(seed) && seed >= 0 && seed <= COVER_SEED_MAX;
const isMotion = (motion: unknown): boolean =>
  motion === undefined || (typeof motion === "number" && motion >= 0 && motion <= 1);

export function validateCoverRecipe(value: unknown): asserts value is CoverRecipe {
  const recipe = value as Partial<CoverRecipe> | null;
  if (
    !recipe ||
    typeof recipe !== "object" ||
    recipe.kind !== "recipe" ||
    Object.keys(recipe).some((key) => !RECIPE_KEYS.has(key))
  )
    throw new Error("Unknown cover recipe.");
  if (!isValidLook(recipe)) throw new Error(unknownLook(recipe.family, recipe.palette ?? recipe.hue));
  if (!isSeedValue(recipe.seed)) throw new Error(`Cover seed must be a whole number from 0 to ${COVER_SEED_MAX}.`);
  if (!isMotion(recipe.motion)) throw new Error("Cover motion must be a number from 0 to 1.");
  if (recipe.placeholder !== undefined && recipe.placeholder !== true) throw new Error("Unknown cover recipe.");
}

const COVER_LOOKS_BY_FAMILY = Object.entries(COVER_PALETTES);
function unknownLook(family: unknown, look: unknown): string {
  const named = COVER_LOOKS_BY_FAMILY.map(([name, palettes]) => `${name}: ${palettes.join(", ")}`).join("; ");
  const asked = look === undefined ? String(family) : `${String(family)}/${String(look)}`;
  return `Unknown cover look ${asked}. The current cover was kept. Looks: ${named}; and ${ORB_FAMILIES.join(", ")}, in a colour Genex picks.`;
}
const pick = <T>(items: readonly T[], random: () => number): T | undefined =>
  items[Math.floor(random() * items.length) % items.length];
/** How many slots apart two hues sit on the circle of COVER_HUE_SLOTS. */
function slotDistance(a: number, b: number): number {
  const apart = Math.abs(a - b) % COVER_HUE_SLOTS;
  return Math.min(apart, COVER_HUE_SLOTS - apart);
}

/** An orb family's free hue slot farthest from its other games; its own colours when it has none. */
function freeHue(family: OrbFamily, free: CoverLook[], used: number[], random: () => number): CoverLook {
  const room = (look: CoverLook): number =>
    used.length ? Math.min(...used.map((hue) => slotDistance(hue, look.hue ?? 0))) : Number(look.hue === 0);
  const best = Math.max(...free.map(room));
  return (
    pick(
      free.filter((look) => room(look) === best),
      random,
    ) ?? { family, hue: 0 }
  );
}

/** A look inside `family`: the wished palette or another free one, or the roomiest free hue. */
function lookInFamily(
  family: CoverFamily,
  taken: readonly CoverLook[],
  palette: string | undefined,
  random: () => number,
): CoverLook {
  const keys = new Set(taken.map(coverLookKey));
  const free = looksOf(family).filter((look) => !keys.has(coverLookKey(look)));
  if (isOrbFamily(family)) {
    if (!free.length) return { family, hue: Math.floor(random() * COVER_HUE_SLOTS) % COVER_HUE_SLOTS };
    const used = taken.flatMap((look) => (look.family === family && look.hue !== undefined ? [look.hue] : []));
    return freeHue(family, free, used, random);
  }
  const wished = free.find((look) => look.palette === palette);
  const fallback = palette ?? pick(COVER_PALETTES[family], random);
  return wished ?? pick(free, random) ?? { family, palette: fallback };
}

/** The family used least by other games, among those that still have a free look. */
function leastUsedFamily(taken: readonly CoverLook[], random: () => number): CoverFamily {
  const keys = new Set(taken.map(coverLookKey));
  const open = COVER_FAMILIES.filter((family) => looksOf(family).some((look) => !keys.has(coverLookKey(look))));
  const candidates = open.length ? open : COVER_FAMILIES;
  const uses = (family: CoverFamily): number => taken.filter((look) => look.family === family).length;
  const fewest = Math.min(...candidates.map(uses));
  return (
    pick(
      candidates.filter((family) => uses(family) === fewest),
      random,
    ) ?? "clouds"
  );
}

/**
 * The look a cover takes so that no two games share one: in the wished family (its wished palette
 * when free), else in the family other games use least. A look repeats only once every look of
 * its family is taken; the seed still sets it apart.
 */
export function pickCoverLook(
  taken: readonly CoverLook[],
  wish: { family?: CoverFamily; palette?: string } = {},
  random: () => number = Math.random,
): CoverLook {
  const family = wish.family ?? leastUsedFamily(taken, random);
  return lookInFamily(family, taken, wish.palette, random);
}

/** A new game's look: free of every look in `taken`, any seed. */
export function rollCoverRecipe(taken: readonly CoverLook[] = [], random: () => number = Math.random): CoverRecipe {
  const look = pickCoverLook(taken, {}, random);
  return { kind: "recipe", ...look, seed: Math.floor(random() * COVER_SEED_RANGE), placeholder: true };
}

/** The first game in an empty library is always Clouds in the Genex sky. */
export function firstCoverRecipe(random: () => number = Math.random): CoverRecipe {
  return {
    kind: "recipe",
    family: "clouds",
    palette: "genex",
    seed: Math.floor(random() * COVER_SEED_RANGE),
    placeholder: true,
  };
}

/** Deterministic look for records made before recipes: no two old games look alike. */
export function coverRecipeFromSeed(seed: number): CoverRecipe {
  let h = (seed >>> 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  const [family, palette] = COVER_LOOKS[h % COVER_LOOKS.length]!;
  return { kind: "recipe", family, palette, seed: (seed >>> 0) % COVER_SEED_RANGE, placeholder: true };
}

/** A text's 32-bit FNV-1a hash over its code points: the same text always seeds the same look. */
export function coverKeySeed(key: string): number {
  let seed = FNV_OFFSET;
  for (const character of key) seed = Math.imul(seed ^ (character.codePointAt(0) ?? 0), FNV_PRIME) >>> 0;
  return seed;
}

export function coverColors(
  recipe: Pick<CoverRecipe, "family" | "palette">,
): readonly [string, string, string, string, string] {
  return COLORS[`${recipe.family}/${recipe.palette}`] ?? COLORS["clouds/genex"]!;
}

/** A recipe's seed as the sphere program's uniform, within {@link COVER_SEED_RANGE}. */
export const coverShaderSeed = (seed: number): number => (seed >>> 0) % COVER_SEED_RANGE;
/** Every sphere's clock starts somewhere of its own. */
export const coverStartTime = (recipe: CoverRecipe): number => coverShaderSeed(recipe.seed) * 3.1 + 1.7;
export const coverMotionRate = (recipe: CoverRecipe): number => (recipe.motion ?? DEFAULT_MOTION) / DEFAULT_MOTION;

/** Values for COVER_RECIPE_FRAGMENT at a given backing size. */
export function coverUniforms(recipe: CoverRecipe, size: number): Record<string, number | number[]> {
  const [c0, c1, c2, c3, atmo] = coverColors(recipe).map(rgb);
  return {
    u_fam: COVER_FAMILIES.indexOf(recipe.family),
    u_px: 2 / size,
    u_c0: c0!,
    u_c1: c1!,
    u_c2: c2!,
    u_c3: c3!,
    u_atmo: atmo!,
  };
}

function rgb(hex: string): number[] {
  const value = parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

/** An orb family's deep, body, light and rim colours at hue slot 0, taken from its shader's own. */
const ORB_POSTER: Record<OrbFamily, readonly [string, string, string, string]> = {
  orbital: ["#1a1c2e", "#8a8fb3", "#e8ecff", "#b6a8ff"],
  bricks: ["#1e5aa8", "#c4281c", "#f2cd37", "#f4f4f4"],
  plasma: ["#140a2e", "#5a5cff", "#ff70d8", "#8f8fff"],
  pixel: ["#101426", "#5a6f8f", "#cfe6ff", "#cfe6ff"],
  caustic: ["#0b2f6e", "#1f6fb0", "#7ff6ff", "#bfe8ff"],
  tempest: ["#2a0f4e", "#0fd0c3", "#ff5e9d", "#ffd166"],
  nimbus: ["#3a4a8c", "#b89a8a", "#ffd7a3", "#ffd7a3"],
  terminal: ["#0b3b2d", "#1f7a5c", "#57ffc9", "#57ffc9"],
  voxel: ["#2f66d0", "#6abe30", "#dbcf9c", "#8cc8ff"],
  meadow: ["#12401f", "#5aa63a", "#4a92e0", "#cfe6ff"],
  galaxy: ["#04050f", "#7fb4ff", "#c46bff", "#8fb0ff"],
  thermal: ["#0b0a1e", "#3b2a9a", "#f05a28", "#f6b53a"],
};

/** An orb family's hue slot, in degrees its colours turn. */
export const coverHueDegrees = (recipe: Pick<CoverRecipe, "hue">): number => (recipe.hue ?? 0) * COVER_HUE_STEP;

/** A cover's deep, body, light and rim colours, for a still drawn without the GPU. */
function posterColors(recipe: CoverRecipe): readonly [string, string, string, string] {
  if (!isOrbFamily(recipe.family)) {
    const [c0, c1, c2, , atmo] = coverColors(recipe);
    return [c0, c1, c2, atmo];
  }
  const degrees = coverHueDegrees(recipe);
  const [deep, body, light, rim] = ORB_POSTER[recipe.family].map((color) => turnHue(color, degrees));
  return [deep ?? "#000000", body ?? "#000000", light ?? "#ffffff", rim ?? "#ffffff"];
}

/** Whether a cover's silhouette is a clean circle, or breaks it (Voxel's blocks stand proud of the ball). */
export const CoverEdge = { Round: "round", Ragged: "ragged" } as const;
export type CoverEdge = (typeof CoverEdge)[keyof typeof CoverEdge];
export const coverEdge = (cover: CoverRecipe | { kind: string }): CoverEdge =>
  "family" in cover && cover.family === OrbFamily.Voxel ? CoverEdge.Ragged : CoverEdge.Round;

/** A light-free still for places without GPU drawing: the sphere's own colours, lit from the upper left. */
export function coverPosterSvg(recipe: CoverRecipe): string {
  const [c0, c1, c2, atmo] = posterColors(recipe);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="s" cx="34%" cy="30%" r="78%"><stop offset="0" stop-color="${c2}"/><stop offset=".42" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></radialGradient><radialGradient id="a" cx="50%" cy="50%" r="50%"><stop offset=".82" stop-color="${atmo}" stop-opacity="0"/><stop offset="1" stop-color="${atmo}" stop-opacity=".45"/></radialGradient></defs><circle cx="32" cy="32" r="32" fill="url(#s)"/><circle cx="32" cy="32" r="32" fill="url(#a)"/></svg>`;
}

/** One program for all six families: sphere normals, tilt, spin, light, rim and highlight. */
export const COVER_RECIPE_FRAGMENT = `precision highp float;
varying vec2 uv;
uniform float u_time; uniform float u_seed; uniform float u_fam; uniform float u_px;
uniform vec3 u_c0; uniform vec3 u_c1; uniform vec3 u_c2; uniform vec3 u_c3; uniform vec3 u_atmo;
float hash(vec3 p){p=fract(p*0.3183099+vec3(0.1,0.2,0.3));p*=17.0;return fract(p.x*p.y*p.z*(p.x+p.y+p.z));}
float noise(vec3 p){vec3 i=floor(p);vec3 f=fract(p);f=f*f*(3.0-2.0*f);
return mix(mix(mix(hash(i),hash(i+vec3(1.0,0.0,0.0)),f.x),mix(hash(i+vec3(0.0,1.0,0.0)),hash(i+vec3(1.0,1.0,0.0)),f.x),f.y),
mix(mix(hash(i+vec3(0.0,0.0,1.0)),hash(i+vec3(1.0,0.0,1.0)),f.x),mix(hash(i+vec3(0.0,1.0,1.0)),hash(i+vec3(1.0,1.0,1.0)),f.x),f.y),f.z);}
float fbm(vec3 p){return 0.5*noise(p)+0.25*noise(p*2.03+vec3(1.7))+0.125*noise(p*4.07+vec3(3.1))+0.0625*noise(p*8.13+vec3(5.3));}
void main(){
vec2 q=uv*2.0-1.0; float r2=dot(q,q);
if(r2>=1.0){gl_FragColor=vec4(0.0);return;}
float r=sqrt(r2); float edge=1.0-smoothstep(1.0-u_px*1.6,1.0,r); float t=u_time;
vec3 col=vec3(0.0); vec3 emi=vec3(0.0);
vec3 n=vec3(q,sqrt(1.0-r2)); float tilt=0.4;
vec3 m=vec3(n.x,n.y*cos(tilt)-n.z*sin(tilt),n.y*sin(tilt)+n.z*cos(tilt));
float a=t*0.11+u_seed*2.39;
vec3 p=vec3(m.x*cos(a)+m.z*sin(a),m.y,-m.x*sin(a)+m.z*cos(a));
vec3 so=vec3(u_seed*1.31,u_seed*0.77,u_seed*2.03);
vec3 L=normalize(vec3(-0.55,0.62,0.75)); float lit=smoothstep(-0.35,0.95,dot(n,L));
if(u_fam<0.5){
 float h=fbm(p*1.4+so);
 col=mix(u_c0,u_c1,smoothstep(-0.7,1.0,n.y*0.55+(h-0.5)*1.4+0.25));
 vec3 w=p*2.1+so+vec3(0.0,0.0,t*0.035);
 float wp=fbm(w*0.9); vec3 cw=w+vec3(wp*1.1);
 float c=fbm(cw); float cl=fbm(cw+vec3(-0.09,0.11,0.12));
 float cloud=smoothstep(0.45,0.66,c); float bright=clamp(0.55+(c-cl)*6.0,0.0,1.0);
 col=mix(col,mix(u_c2,u_c3,bright),cloud);
}else if(u_fam<1.5){
 float h=fbm(p*1.8+so+vec3(t*0.05,0.0,0.0));
 col=mix(u_c0,u_c1,h*0.8);
 float rib=smoothstep(0.72,1.0,sin(p.y*7.0+h*5.0+t*0.4));
 float rib2=smoothstep(0.84,1.0,sin(p.y*11.0-h*6.0-t*0.3+1.7));
 emi=u_c2*rib*0.95+u_c3*rib2*0.75;
}else if(u_fam<2.5){
 float h=fbm(p*vec3(1.2,3.2,1.2)+so+vec3(t*0.03,0.0,0.0));
 col=mix(u_c0,u_c1,smoothstep(-1.0,1.0,sin(p.y*9.0+h*3.4)));
 col=mix(col,u_c2,smoothstep(0.5,0.95,sin(p.y*4.0+h*2.2+1.0))*0.65);
 float st=(1.0-smoothstep(0.1,0.22,length(vec2(p.x-0.3,(p.y+0.28)*1.9))))*step(0.0,p.z);
 col=mix(col,u_c3,st*0.9);
}else if(u_fam<3.5){
 float h=fbm(p*1.6+so+vec3(0.0,0.0,t*0.03));
 float v=abs(sin(p.x*2.5+p.y*1.5+h*7.0));
 col=mix(u_c0,u_c1,smoothstep(0.2,0.8,h));
 col=mix(col,u_c2,1.0-smoothstep(0.0,0.14,v));
 col=mix(col,u_c3,(1.0-smoothstep(0.0,0.04,v))*0.8);
}else if(u_fam<4.5){
 float h=fbm(p*2.2+so);
 float cr=abs(noise(p*3.4+so+vec3(h*1.6,t*0.05,0.0))-0.5);
 float crack=1.0-smoothstep(0.0,0.04,cr);
 float halo=1.0-smoothstep(0.0,0.17,cr);
 float glow=0.72+0.28*sin(t*1.1+h*6.0);
 col=mix(u_c0,u_c1,smoothstep(0.25,0.85,h))*(0.75+0.5*h);
 emi=(u_c2*halo*halo*0.42+mix(u_c2,u_c3,crack)*crack)*glow;
}else{
 float h=fbm(p*1.5+so);
 float land=smoothstep(0.52,0.555,h);
 vec3 sea=mix(u_c0,u_c1,smoothstep(0.28,0.52,h));
 vec3 gr=mix(u_c2*0.75,u_c2*1.1,smoothstep(0.56,0.74,h));
 col=mix(sea,gr,land);
 vec3 w=p*2.4+so.yzx+vec3(t*0.05,0.0,0.0);
 float cloud=smoothstep(0.52,0.72,fbm(w+vec3(fbm(w)*0.8)));
 col=mix(col,u_c3,cloud*0.9);
}
vec3 o=col*(0.3+0.82*lit)+emi;
float rim=pow(1.0-n.z,2.0); o+=u_atmo*rim*(0.22+0.78*lit)*0.85;
vec3 H=normalize(L+vec3(0.0,0.0,1.0)); o+=vec3(pow(max(dot(n,H),0.0),36.0)*0.26);
gl_FragColor=vec4(clamp(o,0.0,1.0),edge);
}`;

const TOOL_PALETTES = [...new Set(COVER_LOOKS.map(([, palette]) => palette))];
/** Enums in the schema, no shader code: about thirty tokens of output for a whole cover. */
export const COVER_TOOL = {
  name: "set_game_cover",
  description: `Pick this game's sidebar cover once. Families with named palettes: ${COVER_LOOKS_BY_FAMILY.map(([family, palettes]) => `${family}: ${palettes.join("|")}`).join("; ")}. Families whose colour the host picks: ${ORB_FAMILIES.join(", ")}. The host keeps every game's cover different, so it may use another palette or colour than the one named. The host draws it; an unknown look keeps the current cover. Uploaded or already chosen covers are kept.`,
  parameters: {
    type: "object" as const,
    properties: {
      family: { type: "string", enum: COVER_FAMILIES },
      palette: { type: "string", enum: TOOL_PALETTES, description: "Only for the families with named palettes." },
      seed: {
        type: "integer",
        minimum: 0,
        maximum: COVER_SEED_MAX,
        description: "Varies shapes, tilt and starting spin.",
      },
      motion: { type: "number", minimum: 0, maximum: 1, description: "0 still to 1 lively." },
    },
    required: ["family"],
  },
};

/**
 * The tool's arguments as a saved recipe, or an error that names the valid looks. The family is
 * kept; its palette or hue is moved off any look in `taken`, so no two games share one.
 */
export function coverRecipeFromTool(
  args: Record<string, unknown>,
  taken: readonly CoverLook[] = [],
  random: () => number = Math.random,
): CoverRecipe {
  const { family } = args;
  if (!isCoverFamily(family)) throw new Error(unknownLook(family, args.palette));
  const palette = isOrbFamily(family) || args.palette === undefined ? undefined : args.palette;
  if (palette !== undefined && !isCoverLook(family, palette)) throw new Error(unknownLook(family, palette));
  const look = pickCoverLook(taken, { family, palette: palette as string | undefined }, random);
  const recipe: CoverRecipe = {
    kind: "recipe",
    ...look,
    seed: args.seed === undefined ? Math.floor(random() * COVER_SEED_RANGE) : Number(args.seed),
  };
  if (args.motion !== undefined) recipe.motion = Number(args.motion);
  validateCoverRecipe(recipe);
  return recipe;
}

/** A look as people and the builder read it: `Ember · violet`, `Plasma · 240°`. */
export function coverLookName(look: CoverLook): string {
  const family = `${look.family.charAt(0).toUpperCase()}${look.family.slice(1)}`;
  return look.hue === undefined ? `${family} · ${look.palette}` : `${family} · ${coverHueDegrees(look)}°`;
}
