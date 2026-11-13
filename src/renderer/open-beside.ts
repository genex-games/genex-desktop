/**
 * Opening a file the chat names. A picture (an image someone sent, a screenshot, an image of the
 * game) opens over the window, as an asset does; Markdown of the game opens beside the chat. Any
 * surface can ask and the shell owns both. Every other file opens in its app through main, and
 * the shell reports what went wrong (renderer/chat-files.ts finds the names).
 */
import type { ChatFileRef } from "../shared/chat-files.ts";
import { fileKind } from "../shared/game-file.ts";
import { pathLeaf } from "../shared/path-label.ts";

/** A game file the chat names, by its path in the game. */
export type BesideFile = { kind: "file"; path: string };
/** What the chat asks to open: a game file, or a picture it already holds. */
export type BesideTarget = BesideFile | { kind: "image"; name: string; src: string };

/** Whether a target opens over the window as a picture rather than beside the chat. */
export function opensAsPicture(target: BesideTarget): boolean {
  return target.kind === "image" || fileKind(target.path) === "image";
}

/** A file's or image's own name, as its tab and its viewer show it. */
export function besideName(target: BesideTarget): string {
  return target.kind === "image" ? target.name : pathLeaf(target.path);
}

export const OPEN_BESIDE_EVENT = "studio:open-beside";
export const OPEN_FILE_EVENT = "studio:open-file";

/** A file link clicked in a chat: the words it names, in that chat. */
export interface OpenFileRequest {
  threadId: string;
  ref: ChatFileRef;
  /** The words the link shows, for a message about it. */
  label: string;
}

export function openBeside(target: BesideTarget): void {
  window.dispatchEvent(new CustomEvent<BesideTarget>(OPEN_BESIDE_EVENT, { detail: target }));
}

/** Asks the shell to open a file the chat named in its app (main decides how). */
export function openChatFile(request: OpenFileRequest): void {
  window.dispatchEvent(new CustomEvent<OpenFileRequest>(OPEN_FILE_EVENT, { detail: request }));
}
