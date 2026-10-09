/**
 * The words the tool loop puts in place of pictures its model cannot see. A module of its own: a
 * seed upgrade keeps an agent-edited tool-loop-prompts.ts, and a name the tool loop imported from an
 * older copy would not link.
 */

/** What a model that cannot see images hears in place of this turn's pictures. */
export function picturesNotShown(labels: string): string {
  return `This turn has pictures (${labels}), but your model cannot see images, so they are not attached. Work from the tools' text answers and the game's state instead.`;
}
