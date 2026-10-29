/**
 * The recipe library per stack (M3.2): a Rust · wgpu night retrieves, is offered and adopts only
 * recipes written for Rust, its facets' briefs read the Rust rules, and the shipped Rust recipes
 * are well formed. A three.js recipe (one that names no stack) never reaches a Rust game.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  craftChecks,
  craftForNewCheck,
  isCraftRecipe,
  loadRecipes,
  type Recipe,
  recipesForChecks,
  renderBrief,
  renderCraftForPlanner,
  withCraftChecks,
} from "../../src/harness-seed/loop/library.ts";
import { GameStack } from "../../src/harness-seed/loop/native-contract.ts";
import { RUST_FACET } from "../../src/harness-seed/loop/rust-briefs.ts";
import { CPP_FACET } from "../../src/harness-seed/loop/native-briefs.ts";

const SEED_DIR = fileURLToPath(new URL("../../src/harness-seed", import.meta.url));

/** Every shipped recipe, as a workspace seeded from this checkout loads them. */
const shipped = (): Promise<Recipe[]> => loadRecipes(SEED_DIR);

/** One check per shipped recipe, in its own words: the widest net a failing board could cast. */
function checksFor(recipes: readonly Recipe[]) {
  return recipes.map((recipe, index) => ({
    id: String(recipe.check?.id ?? `${recipe.checkClass}-${index}`),
    kind: String(recipe.check?.kind ?? recipe.checkClass),
    ask: `${recipe.title} ${recipe.tags.join(" ")}`,
  }));
}

describe("a Rust · wgpu night's recipes (M3.2)", () => {
  it("retrieves only Rust recipes for any failing board, and some for the Rust checks", async () => {
    const recipes = await shipped();
    const hits = recipesForChecks(recipes, checksFor(recipes), 1000, { stack: GameStack.RustWgpu });
    assert.ok(hits.length > 0, "the shipped Rust recipes answer Rust checks");
    for (const { recipe } of hits) assert.equal(recipe.runtime, GameStack.RustWgpu, recipe.id);
  });

  it("offers its planner no three.js or raylib craft, and adopts none by id", async () => {
    const recipes = await shipped();
    const foreign = recipes.filter((recipe) => recipe.runtime !== GameStack.RustWgpu && isCraftRecipe(recipe));
    assert.ok(foreign.length > 0, "the library has craft for other stacks");
    const menu = renderCraftForPlanner(recipes, { stack: GameStack.RustWgpu });
    for (const recipe of foreign) assert.ok(!menu.includes(recipe.id), `${recipe.id} is not on a Rust menu`);
    // A Rust game has craft of its own (the bodycam ports); none of it comes from another stack.
    const rustCraft = [...craftChecks(recipes, { stack: GameStack.RustWgpu }).values()];
    for (const { recipe } of rustCraft)
      assert.equal(recipe.runtime, GameStack.RustWgpu, `${recipe.id}: no foreign craft check`);
    const asked = foreign.slice(0, 2).map((recipe) => recipe.id);
    const adopted = withCraftChecks({ craft: asked, checks: [] }, recipes, { stack: GameStack.RustWgpu });
    assert.deepEqual(adopted.added, []);
    assert.deepEqual(adopted.unknown, asked, "a recipe for another stack is unknown to a Rust game");
    // Words a foreign check shares may reach a Rust recipe; never the foreign one itself.
    for (const check of checksFor(foreign))
      for (const { recipe } of craftForNewCheck(recipes, check, { stack: GameStack.RustWgpu, min: Number.MIN_VALUE }))
        assert.equal(recipe.runtime, GameStack.RustWgpu, `${check.id}: ${recipe.id}`);
  });

  it("a caller that names no stack keeps the menu it always had (characterization)", async () => {
    const recipes = await shipped();
    const three = recipes.find((recipe) => recipe.runtime === GameStack.ThreeJs && isCraftRecipe(recipe));
    assert.ok(three && renderCraftForPlanner(recipes, {}).includes(three.id));
    assert.ok(craftChecks(recipes).size > 0);
  });

  it("ships Rust recipes that name their stack and fence their sketch as Rust", async () => {
    const rust = (await shipped()).filter((recipe) => recipe.id.startsWith("rust."));
    assert.ok(rust.length >= 4, rust.map((recipe) => recipe.id).join(", "));
    for (const recipe of rust) {
      assert.equal(recipe.runtime, GameStack.RustWgpu, recipe.id);
      assert.ok(recipe.intent.trim() && recipe.sketch.trim(), recipe.id);
    }
    const brief = renderBrief({
      run: { runId: "r1", goal: "a pond" },
      spec: { id: "dash", title: "Dash", intent: "a dash", identity: [], owns: [], checks: [] },
      iteration: 1,
      recipes: [{ recipe: rust[0] as Recipe, score: 3, checkIds: ["c1"], primaryCheckId: "c1" }],
      stack: GameStack.RustWgpu,
      entryMain: "src/main.rs",
    });
    assert.match(brief, /```rust\n/);
  });

  it("a Rust facet's brief reads the Rust rules, never the three.js or C++ ones", () => {
    const brief = renderBrief({
      run: { runId: "r1", goal: "a pond" },
      spec: { id: "dash", title: "Dash", intent: "a dash", identity: [], owns: [], checks: [] },
      iteration: 1,
      stack: GameStack.RustWgpu,
      entryMain: "src/main.rs",
    });
    assert.ok(brief.includes(RUST_FACET.tag), "Rust tagging");
    assert.ok(brief.includes(RUST_FACET.determinism), "Rust determinism");
    assert.ok(!brief.includes("obj.userData.tag"), "no three.js tagging");
    assert.ok(!brief.includes(CPP_FACET.tag), "no C++ tagging");
  });
});
