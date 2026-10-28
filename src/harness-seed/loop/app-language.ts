/**
 * The language Genex speaks, as the agents learn it from the host (`studio.language`); its rules
 * are in `language-prompts.ts`.
 */
import { HostMethod } from "./host-methods.ts";
import type { HarnessCtx } from "../types/harness.d.ts";

/** The language Genex speaks, as the host names it (`studio.language`): its tag and its own name. */
export interface AppLanguage {
  tag: string;
  name: string;
}

/** A tag as the host sends one ("ru", "pt-BR", "zh-Hans"); anything else is no language. */
const TAG = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
/** A language's own name: one short line of letters, never instructions. */
const NAME = /^[\p{L}\p{M} ()-]{1,40}$/u;

/** The language Genex speaks, or null when the host cannot say (an older host) or says something else. */
export async function appLanguage(ctx: HarnessCtx): Promise<AppLanguage | null> {
  const answer = await ctx.call(HostMethod.StudioLanguage).catch(() => null);
  if (typeof answer?.tag !== "string" || typeof answer?.name !== "string") return null;
  return TAG.test(answer.tag) && NAME.test(answer.name) ? { tag: answer.tag, name: answer.name } : null;
}
