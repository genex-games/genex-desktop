/** What a generated avatar is made of, in words: its body, its eyes, how block eyes look, its gear. */
import { type AvatarRecipe, AvatarEyes } from "../../shared/avatar-recipe.ts";
import { AVATAR_WORDS } from "../words.ts";

/** The names of an avatar's parts, as the first-sign-in dialog lists them. */
export function mixOf(recipe: AvatarRecipe): string[] {
  const parts: string[] = [AVATAR_WORDS.bodies[recipe.body], AVATAR_WORDS.eyes[recipe.eyes]];
  if (recipe.eyes === AvatarEyes.Blocks) parts.push(AVATAR_WORDS.states[recipe.state]);
  const gear = AVATAR_WORDS.gear[recipe.gear];
  if (gear) parts.push(gear);
  return parts;
}
