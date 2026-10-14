/**
 * A recipe's sketch, fenced in the language of the stack it is written for (three.js, C++ · raylib,
 * Rust · wgpu). Its own module because the seed modules that render a sketch (`brief-budget.ts`,
 * `library.ts`) are ones an installed harness may keep from before compiled stacks: a kept copy
 * still links, and fences every sketch as JavaScript as it always did.
 */
import { GameStack } from "./native-contract.ts";

/** The language a recipe's sketch is fenced as, by the stack it is written for. */
const SKETCH_FENCE = {
  [GameStack.ThreeJs]: "js",
  [GameStack.RaylibCpp]: "cpp",
  [GameStack.RustWgpu]: "rust",
} as const satisfies Record<GameStack, string>;

/** A recipe's sketch, fenced in the language of the stack it is written for (three.js when absent). */
export function sketchBlock(recipe: { sketch?: string; runtime?: GameStack }): string {
  const fence = SKETCH_FENCE[recipe.runtime ?? GameStack.ThreeJs];
  return `\`\`\`${fence}\n${String(recipe.sketch ?? "").trim()}\n\`\`\``;
}
