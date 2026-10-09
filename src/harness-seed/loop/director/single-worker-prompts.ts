/**
 * What a single-session worker is told when it is resumed. A module of its own: a seed upgrade
 * keeps an agent-edited facet-loop.ts or facet/prompt.ts, and a name imported from an older copy
 * would not link.
 */

/** A session interrupted for a steer it had already been handed: nothing new, carry on. */
export function carryOnPrompt(): string {
  return `Your turn was interrupted, but everything sent to you has already reached you — nothing new arrived. Continue exactly where you were. Do not start over, and undo nothing you have already written.`;
}
