/**
 * Plugin skill `stacks` with a third stack (Rust · wgpu). A skill names the games it serves; the
 * names a manifest may use follow its API: `rust-wgpu` only from the API that knows it, and a list
 * naming every stack that existed before Rust, on an older API, means "every game", Rust included.
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { GameStack } from "../../src/shared/game-project.ts";
import {
  PRE_RUST_SKILL_STACKS,
  type PluginManifest,
  type PluginSkill,
  RUST_SKILL_STACKS_API,
} from "../../src/shared/plugins.ts";
import {
  manifestForStack,
  PluginManifestError,
  PluginManifestRefusal,
  servesStack,
  validateManifest,
} from "../../src/substrate/plugins/manifest.ts";

const source = path.resolve(import.meta.dirname, "../../src/plugins/example");
const example: PluginManifest = JSON.parse(await readFile(path.join(source, "plugin.json"), "utf8"));

// biome-ignore lint/suspicious/noExplicitAny: a hostile manifest is any shape a writer may send.
type RawManifest = any;

/** The example manifest on `apiVersion` with one inline skill naming `stacks`. */
function manifestWith(apiVersion: number, stacks: unknown): RawManifest {
  const m: RawManifest = structuredClone(example);
  m.apiVersion = apiVersion;
  m.skills = [{ name: "card", text: "A card.", stacks }];
  return m;
}

/** The single skill of a validated manifest. */
function onlySkill(m: PluginManifest): PluginSkill {
  const [skill] = m.skills;
  assert.ok(skill);
  return skill;
}

/** The names of the skills a game of `stack` is handed from a validated manifest. */
const handed = (m: PluginManifest, stack: GameStack) => manifestForStack(m, stack).skills.map((s) => s.name);

/** Is `error` the typed refusal of `rust-wgpu` on an API that does not know it? */
const isRustStackRefusal = (error: unknown) =>
  error instanceof PluginManifestError && error.code === PluginManifestRefusal.RustSkillStackNeedsApi;

describe("a skill's stacks on the API before Rust", () => {
  test("a list naming every pre-Rust stack serves a Rust game too, and is kept as written", () => {
    const m = validateManifest(manifestWith(3, [GameStack.ThreeJs, GameStack.RaylibCpp]));
    assert.deepEqual(handed(m, GameStack.RustWgpu), ["card"]);
    assert.equal(servesStack(onlySkill(m), GameStack.RustWgpu, m.apiVersion), true);
    assert.deepEqual(onlySkill(m).stacks, [GameStack.ThreeJs, GameStack.RaylibCpp]);
  });

  test("in either order", () => {
    const m = validateManifest(manifestWith(3, [GameStack.RaylibCpp, GameStack.ThreeJs]));
    assert.deepEqual(handed(m, GameStack.RustWgpu), ["card"]);
  });

  test("a list naming one pre-Rust stack still serves only that stack", () => {
    for (const only of PRE_RUST_SKILL_STACKS) {
      const m = validateManifest(manifestWith(3, [only]));
      assert.deepEqual(handed(m, GameStack.RustWgpu), [], `${only} card withheld from Rust`);
      assert.deepEqual(handed(m, only), ["card"], `${only} card handed to ${only}`);
    }
  });

  test("a manifest naming rust-wgpu is refused with a typed refusal, whatever else it names", () => {
    const lists = [
      [GameStack.RustWgpu],
      [GameStack.ThreeJs, GameStack.RustWgpu],
      [GameStack.ThreeJs, GameStack.RaylibCpp, GameStack.RustWgpu],
    ];
    for (const stacks of lists) {
      assert.throws(() => validateManifest(manifestWith(3, stacks)), isRustStackRefusal, JSON.stringify(stacks));
    }
  });
});

describe("a skill's stacks on the Rust-aware API", () => {
  test("rust-wgpu is accepted and serves only the stacks named", () => {
    const m = validateManifest(manifestWith(RUST_SKILL_STACKS_API, [GameStack.RustWgpu]));
    assert.equal(m.apiVersion, RUST_SKILL_STACKS_API);
    assert.deepEqual(onlySkill(m).stacks, [GameStack.RustWgpu]);
    assert.deepEqual(handed(m, GameStack.RustWgpu), ["card"]);
    assert.deepEqual(handed(m, GameStack.ThreeJs), []);
    assert.deepEqual(handed(m, GameStack.RaylibCpp), []);
  });

  test("all three stacks fit the raised limit", () => {
    const all = [GameStack.ThreeJs, GameStack.RaylibCpp, GameStack.RustWgpu];
    const m = validateManifest(manifestWith(RUST_SKILL_STACKS_API, all));
    assert.deepEqual(onlySkill(m).stacks, all);
  });

  test("naming both pre-Rust stacks there is an explicit choice to leave Rust out", () => {
    const m = validateManifest(manifestWith(RUST_SKILL_STACKS_API, [GameStack.ThreeJs, GameStack.RaylibCpp]));
    assert.deepEqual(handed(m, GameStack.RustWgpu), []);
    assert.deepEqual(handed(m, GameStack.RaylibCpp), ["card"]);
  });

  test("what API 3 allows still loads on the newer API: object parameters", () => {
    const m: RawManifest = structuredClone(example);
    m.apiVersion = RUST_SKILL_STACKS_API;
    m.tools[0].parameters.properties.options = { type: "object", acceptJsonString: true };
    const canonical = validateManifest(m);
    assert.equal(canonical.tools[0]?.parameters.properties.options?.type, "object");
  });

  test("and every bundled plugin loads unchanged", async () => {
    for (const id of ["example", "genex", "blender"]) {
      const raw = JSON.parse(await readFile(path.join(source, "..", id, "plugin.json"), "utf8"));
      const m = validateManifest(raw);
      assert.equal(m.apiVersion, raw.apiVersion, id);
      assert.deepEqual(
        m.skills.map((s) => s.stacks ?? null),
        raw.skills.map((s: RawManifest) => s.stacks ?? null),
        `${id} skill stacks`,
      );
    }
  });
});

/** Hostile `stacks` values: each is refused on both APIs and never reaches a canonical manifest. */
const HOSTILE_STACKS: ReadonlyArray<[string, unknown]> = [
  ["an empty list", []],
  ["a repeated stack", [GameStack.ThreeJs, GameStack.ThreeJs]],
  ["four entries", [GameStack.ThreeJs, GameStack.RaylibCpp, GameStack.ThreeJs, GameStack.RaylibCpp]],
  ["an unknown stack", ["unity"]],
  ["a case variant", ["Three-JS"]],
  ["a padded name", [" three-js"]],
  ["a non-string", [4]],
  ["null inside", [null]],
  ["not a list", GameStack.ThreeJs],
  ["a list-like object", { 0: GameStack.ThreeJs, length: 1 }],
];

describe("hostile stacks", () => {
  for (const apiVersion of [3, RUST_SKILL_STACKS_API]) {
    for (const [label, stacks] of HOSTILE_STACKS) {
      test(`API ${apiVersion}: ${label} is refused`, () => {
        assert.throws(() => validateManifest(manifestWith(apiVersion, stacks)), /stacks/);
      });
    }
  }

  test("a repeated rust-wgpu on the Rust-aware API is refused like any repeat", () => {
    const repeated = [GameStack.RustWgpu, GameStack.RustWgpu];
    assert.throws(() => validateManifest(manifestWith(RUST_SKILL_STACKS_API, repeated)), /stacks/);
  });

  test("an API the host does not know is still refused", () => {
    assert.throws(() => validateManifest(manifestWith(RUST_SKILL_STACKS_API + 1, [GameStack.ThreeJs])), /incompatible/);
  });

  test("API 2 never carries stacks: the skill serves every game, Rust included", () => {
    const m = validateManifest(manifestWith(2, [GameStack.RustWgpu]));
    assert.equal("stacks" in onlySkill(m), false);
    assert.deepEqual(handed(m, GameStack.RustWgpu), ["card"]);
  });
});
