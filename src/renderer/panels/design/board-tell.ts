/**
 * What Tell Genex sends: the person's new notes and picks as one message of theirs in the game's
 * chat, phrased as their next message carries them (`shared/design-tell.ts`), with each note's
 * place read off the artboard where it hangs now.
 */
import { type BoardNews, boardNewsMessage } from "../../../shared/design-tell.ts";

/** An artboard as a note's place is told: where it hangs and how large. */
type Hung = { file: string; x: number; y: number; width: number; height: number };

/** The message for this news: the notes, then the picks; nothing to send for none. */
export function tellMessage(news: BoardNews, frames: readonly Hung[], captionOf: (file: string) => string): string {
  const hung = (file: string): Hung | undefined => frames.find((frame) => frame.file === file);
  return boardNewsMessage(news, {
    titleOf: captionOf,
    onBoard: (file) => hung(file) !== undefined,
    sizeOf: hung,
  });
}
