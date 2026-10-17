/**
 * Opening a file the chat names. Markdown and images of the game open beside the chat, as do
 * the images someone sent; any surface can ask and the shell owns the stage. Every other file
 * opens in its app through main, and the shell reports what went wrong (renderer/chat-files.ts
 * finds the names).
 */
import type { ChatFileRef } from "../shared/chat-files.ts";

export type BesideTarget = { kind: "file"; path: string } | { kind: "image"; name: string; src: string };

/** A file's or image's own name, as its tab and its viewer show it. */
export function besideName(target: BesideTarget): string {
  return target.kind === "image" ? target.name : (target.path.split("/").filter(Boolean).pop() ?? target.path);
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
