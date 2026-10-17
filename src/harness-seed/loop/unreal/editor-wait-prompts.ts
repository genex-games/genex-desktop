/**
 * What the chat's own session is told when Unreal answers after a turn that made the game's Unreal
 * project (`editor-wait.ts`): it goes on with what it said it would build, now through the editor.
 *
 * No current module calls this: the session goes on with its game's new kind
 * (`factsReadyPrompt`). It stays because an older copy of `delegated-turn.ts` an agent kept imports it.
 */

/** The prompt that resumes the session once the game's Unreal project answers. */
export function unrealReadyPrompt(project: string | null): string {
  const name = project ?? "this game's Unreal project";
  return `Unreal has opened ${name} and answers now; the Unreal tools reach it. Carry on from your last reply: build what you said you would build first, in the editor through the Unreal tools, look at the result, then tell the user what you made and what to try.`;
}
