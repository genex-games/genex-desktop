/**
 * What a run's lead reads of a chat message beyond its words (live-chat.ts). A module with no
 * imports, so the live chat never pulls the director's prompts into an import cycle.
 */

/**
 * The line a message's pictures add to the words its run's lead reads: the chat saved each in the
 * game's references folder, so the lead looks at them there.
 */
export function attachedPicturesLine(files: readonly string[]): string {
  const count = files.length === 1 ? "a picture" : `${files.length} pictures`;
  return `They attached ${count}, saved in this game's folder: ${files.join(", ")}. Look at each before you answer.`;
}
