/**
 * Generated avatars: everything a Genex account's avatar is comes from its id alone, so the app
 * and genex.games draw the same one. The golden table pins ids to recipes; the site's copy of
 * `avatar-recipe.ts` must answer the same table, value for value.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AVATAR_BODIES,
  AvatarBody,
  AvatarEyes,
  AvatarGear,
  AVATAR_VARIANT_MAX,
  type AvatarRecipe,
  avatarRecipe,
  BlockState,
  ghostRecipe,
  hasBackGear,
  isAvatarVariant,
  nextAvatarVariant,
} from "../../src/shared/avatar-recipe.ts";

type Golden = Pick<
  AvatarRecipe,
  | "body"
  | "palette"
  | "dark"
  | "glow"
  | "seed"
  | "turn"
  | "eyes"
  | "state"
  | "gear"
  | "tilt"
  | "len"
  | "thick"
  | "fire"
  | "gap"
  | "eyeY"
  | "slats"
  | "side"
  | "sides"
  | "curl"
  | "blink"
  | "phase"
>;

/** Recipes the approved prototype gave these ids; a change here changes everyone's face. */
const GOLDEN: Record<string, Golden> = {
  "rab neba": {
    body: AvatarBody.Galaxy,
    palette: ["#0a0306", "#ff5a2c", "#ffd36b", "#c28cff"],
    dark: true,
    glow: "#c28cff",
    seed: 887,
    turn: -0.1,
    eyes: AvatarEyes.Blocks,
    state: BlockState.Fury,
    gear: AvatarGear.None,
    tilt: 0.12,
    len: 0.525,
    thick: 0.13,
    fire: 2,
    gap: 0.31,
    eyeY: -0.02,
    slats: 4,
    side: -1,
    sides: 8,
    curl: 0,
    blink: 3.25,
    phase: 0,
  },
  mira: {
    body: AvatarBody.Circuit,
    palette: ["#0b0f14", "#1e2a38", "#ffcf5a", "#5affc8"],
    dark: true,
    glow: "#5affc8",
    seed: 67,
    turn: 0.15,
    eyes: AvatarEyes.Blades,
    state: BlockState.Cold,
    gear: AvatarGear.None,
    tilt: 0.2,
    len: 0.525,
    thick: 0.15,
    fire: 1,
    gap: 0.285,
    eyeY: -0.06,
    slats: 2,
    side: -1,
    sides: 8,
    curl: 2,
    blink: 5.95,
    phase: 5.769230769230769,
  },
  cmb3x9q2k0000abcd: {
    body: AvatarBody.Neon,
    palette: ["#0a0610", "#b45cff", "#ff4f6d", "#5affc8"],
    dark: true,
    glow: "#ff4f6d",
    seed: 567,
    turn: 0.25,
    eyes: AvatarEyes.Grille,
    state: BlockState.Cold,
    gear: AvatarGear.None,
    tilt: 0.12,
    len: 0.455,
    thick: 0.13,
    fire: 0,
    gap: 0.285,
    eyeY: 0.02,
    slats: 4,
    side: -1,
    sides: 8,
    curl: 1,
    blink: 5.95,
    phase: 2.076923076923077,
  },
  "fx-kenji-mori": {
    body: AvatarBody.Crt,
    palette: ["#000000", "#aa00aa", "#55ffff", "#ffffff"],
    dark: false,
    glow: "#ffffff",
    seed: 932,
    turn: -0.25,
    eyes: AvatarEyes.Blocks,
    state: BlockState.Menace,
    gear: AvatarGear.Mast,
    tilt: 0.12,
    len: 0.49,
    thick: 0.11,
    fire: 1,
    gap: 0.285,
    eyeY: 0.02,
    slats: 2,
    side: 1,
    sides: 8,
    curl: 0,
    blink: 5.95,
    phase: 7.076923076923077,
  },
  juno: {
    body: AvatarBody.Matrix,
    palette: ["#020a04", "#00ff66", "#d8ffe6", "#0a3d1c"],
    dark: true,
    glow: "#00ff66",
    seed: 397,
    turn: -0.15,
    eyes: AvatarEyes.Optic,
    state: BlockState.Slit,
    gear: AvatarGear.Jack,
    tilt: 0.28,
    len: 0.42,
    thick: 0.11,
    fire: 2,
    gap: 0.335,
    eyeY: 0.02,
    slats: 2,
    side: -1,
    sides: 8,
    curl: 2,
    blink: 5.95,
    phase: 1.4615384615384615,
  },
  tomás: {
    body: AvatarBody.Vapor,
    palette: ["#ffd1a6", "#ff5f9e", "#3d1d7a", "#40e0d0"],
    dark: false,
    glow: "#40e0d0",
    seed: 257,
    turn: 0.1,
    eyes: AvatarEyes.Demon,
    state: BlockState.Fury,
    gear: AvatarGear.Scar,
    tilt: 0.04,
    len: 0.525,
    thick: 0.13,
    fire: 2,
    gap: 0.285,
    eyeY: 0.02,
    slats: 4,
    side: -1,
    sides: 8,
    curl: 2,
    blink: 5.95,
    phase: 2.5384615384615383,
  },
  "u_8Hq-2": {
    body: AvatarBody.Foil,
    palette: ["#ece6dc", "#a8988a", "#ffffff", "#c6f0ff"],
    dark: false,
    glow: "#c6f0ff",
    seed: 754,
    turn: -0.25,
    eyes: AvatarEyes.Blocks,
    state: BlockState.Cold,
    gear: AvatarGear.Mast,
    tilt: -0.06,
    len: 0.42,
    thick: 0.11,
    fire: 1,
    gap: 0.285,
    eyeY: 0.06,
    slats: 3,
    side: 1,
    sides: 6,
    curl: 1,
    blink: 3.25,
    phase: 0.07692307692307693,
  },
  x: {
    body: AvatarBody.Glitch,
    palette: ["#00ff9f", "#bd00ff", "#0a0a1a", "#ffffff"],
    dark: true,
    glow: "#bd00ff",
    seed: 199,
    turn: 0.2,
    eyes: AvatarEyes.Mono,
    state: BlockState.Wide,
    gear: AvatarGear.None,
    tilt: -0.06,
    len: 0.455,
    thick: 0.15,
    fire: 0,
    gap: 0.26,
    eyeY: 0.06,
    slats: 3,
    side: 1,
    sides: 6,
    curl: 0,
    blink: 5.95,
    phase: 4,
  },
};

/** Regenerated avatars: an id and a variant, pinned like the first ones. */
const VARIANTS: Array<{ id: string; variant: number; golden: Golden }> = [
  {
    id: "mira",
    variant: 1,
    golden: {
      body: AvatarBody.Halftone,
      palette: ["#fff0f6", "#2b1028", "#ff5fa2", "#7ae7ff"],
      dark: false,
      glow: "#ff5fa2",
      seed: 178,
      turn: -0.2,
      eyes: AvatarEyes.Blocks,
      state: BlockState.Steady,
      gear: AvatarGear.Scar,
      tilt: 0.2,
      len: 0.525,
      thick: 0.11,
      fire: 2,
      gap: 0.335,
      eyeY: -0.06,
      slats: 2,
      side: 1,
      sides: 8,
      curl: 0,
      blink: 3.7,
      phase: 4.769230769230769,
    },
  },
  {
    id: "rab neba",
    variant: 7,
    golden: {
      body: AvatarBody.Neon,
      palette: ["#060a0a", "#39ff88", "#ff8a2f", "#2fa8ff"],
      dark: true,
      glow: "#ff8a2f",
      seed: 238,
      turn: 0.3,
      eyes: AvatarEyes.Demon,
      state: BlockState.Scan,
      gear: AvatarGear.Spikes,
      tilt: 0.2,
      len: 0.525,
      thick: 0.13,
      fire: 2,
      gap: 0.335,
      eyeY: -0.02,
      slats: 3,
      side: 1,
      sides: 8,
      curl: 1,
      blink: 5.95,
      phase: 6.153846153846154,
    },
  },
  {
    id: "cmb3x9q2k0000abcd",
    variant: AVATAR_VARIANT_MAX,
    golden: {
      body: AvatarBody.Vapor,
      palette: ["#fff1a8", "#ff8a5c", "#b4247a", "#6bf2ff"],
      dark: false,
      glow: "#6bf2ff",
      seed: 273,
      turn: 0.1,
      eyes: AvatarEyes.Blocks,
      state: BlockState.Fury,
      gear: AvatarGear.None,
      tilt: 0.2,
      len: 0.49,
      thick: 0.11,
      fire: 2,
      gap: 0.285,
      eyeY: -0.02,
      slats: 4,
      side: 1,
      sides: 6,
      curl: 0,
      blink: 5.05,
      phase: 6.076923076923077,
    },
  },
];

const FLOATS = ["turn", "tilt", "len", "thick", "gap", "eyeY", "blink", "phase"] as const;
const EPSILON = 1e-9;

/** Recipes for many made-up ids. */
const many = (count: number): AvatarRecipe[] =>
  Array.from({ length: count }, (_, index) => avatarRecipe(`user-${index}`));

describe("generated avatar recipe", () => {
  for (const [id, golden] of Object.entries(GOLDEN))
    it(`gives "${id}" the recipe the approved prototype gave it`, () => {
      const recipe = avatarRecipe(id);
      for (const [key, value] of Object.entries(golden)) {
        const got = recipe[key as keyof Golden];
        if ((FLOATS as readonly string[]).includes(key))
          assert.ok(Math.abs((got as number) - (value as number)) < EPSILON, `${key}: ${got} != ${value}`);
        else assert.deepEqual(got, value, key);
      }
      assert.equal(recipe.bodyIndex, AVATAR_BODIES.indexOf(golden.body));
    });

  for (const { id, variant, golden } of VARIANTS)
    it(`gives "${id}" regenerated as variant ${variant} the same recipe everywhere`, () => {
      const recipe = avatarRecipe(id, variant);
      for (const [key, value] of Object.entries(golden)) {
        const got = recipe[key as keyof Golden];
        if ((FLOATS as readonly string[]).includes(key))
          assert.ok(Math.abs((got as number) - (value as number)) < EPSILON, `${key}: ${got} != ${value}`);
        else assert.deepEqual(got, value, key);
      }
    });

  it("keeps variant 0 as the account's first avatar", () => {
    for (const id of Object.keys(GOLDEN)) assert.deepEqual(avatarRecipe(id, 0), avatarRecipe(id));
  });

  it("regenerates to a variant the account does not have, within range", () => {
    assert.equal(nextAvatarVariant(0, 0), 1);
    assert.equal(nextAvatarVariant(1, 0), 2, "never the variant it has");
    assert.equal(nextAvatarVariant(AVATAR_VARIANT_MAX, 1 - Number.EPSILON), 1, "wraps past the largest");
    for (const random of [0, 0.25, 0.5, 0.999999]) assert.ok(isAvatarVariant(nextAvatarVariant(3, random)));
    for (const bad of [-1, 1.5, AVATAR_VARIANT_MAX + 1, Number.NaN, "2", null])
      assert.equal(isAvatarVariant(bad), false, String(bad));
  });

  it("gives an id the same recipe every time, and two ids two recipes", () => {
    assert.deepEqual(avatarRecipe("cmb3x9q2k0000abcd"), avatarRecipe("cmb3x9q2k0000abcd"));
    assert.notDeepEqual(avatarRecipe("cmb3x9q2k0000abcd"), avatarRecipe("cmb3x9q2k0000abce"));
  });

  it("keeps CRT bodies on block eyes and glitch bodies on a mono eye or an optic", () => {
    for (const recipe of many(4000)) {
      if (recipe.body === AvatarBody.Crt) assert.equal(recipe.eyes, AvatarEyes.Blocks);
      if (recipe.body === AvatarBody.Glitch)
        assert.ok(recipe.eyes === AvatarEyes.Mono || recipe.eyes === AvatarEyes.Optic, recipe.eyes);
    }
  });

  it("spreads people evenly over the twelve bodies and gives most of them gear", () => {
    const recipes = many(12000);
    const bodies = new Map<string, number>();
    for (const recipe of recipes) bodies.set(recipe.body, (bodies.get(recipe.body) ?? 0) + 1);
    assert.equal(bodies.size, AVATAR_BODIES.length);
    for (const [body, count] of bodies) assert.ok(count > 800 && count < 1200, `${body}: ${count}`);
    const bare = recipes.filter((recipe) => recipe.gear === AvatarGear.None).length / recipes.length;
    assert.ok(bare > 0.22 && bare < 0.34, `no gear: ${bare}`);
  });

  it("draws a placeholder as a quiet grey shell with no gear", () => {
    const ghost = ghostRecipe("ghost-a");
    assert.equal(ghost.body, AvatarBody.Toon);
    assert.equal(ghost.dark, false);
    assert.equal(ghost.gear, AvatarGear.None);
    assert.equal(ghost.turn, 0);
    const light = (hex: string) => [1, 3, 5].every((at) => Number.parseInt(hex.slice(at, at + 2), 16) >= 0xb0);
    assert.ok(ghost.palette.every(light), ghost.palette.join());
  });

  it("puts horns, blades, spikes and masts behind the body, and nothing else", () => {
    const behind = Object.values(AvatarGear).filter((gear) => hasBackGear(gear));
    assert.deepEqual(behind.sort(), [AvatarGear.Blades, AvatarGear.Horns, AvatarGear.Mast, AvatarGear.Spikes].sort());
  });
});
