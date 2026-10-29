/**
 * Pro nameplates: a plate is the account id and the variant it rolled, nothing else, so the same
 * account sees the same plate on every Mac. The first plate is drawn from its avatar's pieces in
 * its avatar's colours; every colour stays dark enough at the bottom to read as night under a name.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { avatarRecipe } from "../../src/shared/avatar-recipe.ts";
import {
  isPlateVariant,
  nextPlateVariant,
  PLATE_SCENES,
  PLATE_VARIANT_MAX,
  PlateScene,
  plateColors,
  plateRecipe,
} from "../../src/shared/plate-recipe.ts";

const IDS = Array.from({ length: 400 }, (_, at) => `account-${at}`);
const luma = (hex: string): number => {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  return 0.299 * (r ?? 0) + 0.587 * (g ?? 0) + 0.114 * (b ?? 0);
};
const HEX = /^#[0-9a-f]{6}$/;

describe("Pro nameplate recipe", () => {
  it("is the same plate for the same account and variant, every time", () => {
    for (const id of ["fx-rab-neba", "u_42", "Ünïcødé ☃"])
      for (const variant of [0, 1, 77, PLATE_VARIANT_MAX])
        assert.deepEqual(plateRecipe(id, variant), plateRecipe(id, variant));
  });

  it("pins a known account's first plate", () => {
    const plate = plateRecipe("fx-rab-neba");
    assert.equal(avatarRecipe("fx-rab-neba").body, "circuit");
    assert.ok(
      [PlateScene.TruchetFlow, PlateScene.SignalLines, PlateScene.Spectrum].includes(
        plate.scene as typeof PlateScene.TruchetFlow,
      ),
      plate.scene,
    );
    assert.equal(plate.sceneIndex, PLATE_SCENES.indexOf(plate.scene));
  });

  it("draws the first plate in the colours of the avatar the account shows, regenerated or not", () => {
    for (const id of IDS.slice(0, 60))
      for (const avatarVariant of [0, 7]) {
        const shown = avatarRecipe(id, avatarVariant);
        assert.deepEqual(
          plateRecipe(id, 0, avatarVariant).colors,
          plateColors(shown.palette, shown.turn, shown.glow),
          `${id} with avatar ${avatarVariant}`,
        );
      }
    assert.notDeepEqual(plateRecipe("fx-rab-neba", 0, 3).colors, plateRecipe("fx-rab-neba").colors);
  });

  it("draws every first plate from its avatar body's own pieces", () => {
    const seen = new Map<string, Set<string>>();
    for (const id of IDS) {
      const body = avatarRecipe(id).body;
      const pieces = seen.get(body) ?? new Set<string>();
      pieces.add(plateRecipe(id).scene);
      seen.set(body, pieces);
    }
    for (const [body, pieces] of seen) assert.ok(pieces.size <= 3, `${body} drew ${[...pieces].join(", ")}`);
  });

  it("lets a rolled plate be any piece, each about as often", () => {
    const counts = new Map<string, number>();
    for (const id of IDS)
      for (let variant = 1; variant <= 5; variant++) {
        const { scene } = plateRecipe(id, variant);
        counts.set(scene, (counts.get(scene) ?? 0) + 1);
      }
    assert.equal(counts.size, PLATE_SCENES.length);
    for (const [scene, count] of counts) assert.ok(count > 40, `${scene} rolled ${count} times of 2000`);
  });

  it("keeps every number in range and every colour a hex", () => {
    for (const id of IDS.slice(0, 80))
      for (const variant of [0, 3]) {
        const plate = plateRecipe(id, variant);
        for (const value of [...plate.vars, ...Object.values(plate.dials)])
          assert.ok(value >= 0 && value <= 1, `${id}/${variant}: ${value}`);
        for (const hex of [...Object.values(plate.colors), plate.tint]) assert.match(hex, HEX, `${id}/${variant}`);
        assert.ok(Number.isInteger(plate.seed) && plate.seed >= 0 && plate.seed < 1047);
      }
  });

  it("keeps the ground dark and the light bright, whatever the avatar's palette", () => {
    for (const id of IDS) {
      const { colors, tint } = plateRecipe(id);
      assert.ok(luma(colors.deep) <= 0.09 + 1e-9, `${id} deep ${colors.deep}`);
      assert.ok(luma(colors.mid) <= 0.32 + 1e-9, `${id} mid ${colors.mid}`);
      assert.ok(luma(colors.light) >= 0.5, `${id} light ${colors.light}`);
      assert.ok(luma(tint) < 0.35, `${id} tint ${tint}`);
    }
  });

  it("turns a pastel palette into a night one", () => {
    const colors = plateColors(["#ffb3c7", "#e0708f", "#fff0f4", "#7a5cff"], 0, "#7a5cff");
    assert.ok(luma(colors.deep) <= 0.09 + 1e-9);
    assert.equal(colors.glow, "#7a5cff");
  });

  it("rolls a new variant, never the one the plate has", () => {
    assert.equal(nextPlateVariant(5, 0.5), 1 + Math.floor(0.5 * PLATE_VARIANT_MAX));
    const current = 1 + Math.floor(0.25 * PLATE_VARIANT_MAX);
    assert.notEqual(nextPlateVariant(current, 0.25), current);
    for (const value of [0, 1, PLATE_VARIANT_MAX]) assert.ok(isPlateVariant(value));
    for (const value of [-1, 1.5, PLATE_VARIANT_MAX + 1, "3", null]) assert.ok(!isPlateVariant(value));
  });
});
