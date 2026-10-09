/**
 * The https addresses a sign-in terminal prints (OpenCode's browser sign-in), noticed so Settings
 * can offer to open the page. It reads the output and never changes it: an interactive sign-in
 * keeps drawing exactly as it would in a terminal of its own.
 */
import { stripVTControlCharacters } from "node:util";

/** The longest unfinished word the scanner holds while it waits for the rest of an address. */
const MAX_HELD_CHARS = 16_384;
/** An https address as a terminal prints one, up to the first space or quote. */
const HTTPS_ADDRESS = /https:\/\/[^\s"'<>]+/g;

/** Finds whole https addresses in terminal output, across chunks and color codes. */
export class LinkScanner {
  #held = "";
  /** The held word grew too long: drop the rest of it, up to the next space. */
  #dropping = false;
  private readonly onUrl: (url: string) => void;
  constructor(onUrl: (url: string) => void) {
    this.onUrl = onUrl;
  }

  /** Read one chunk of output; every address it completes is reported once. */
  write(data: string): void {
    let text = this.#held + data;
    this.#held = "";
    if (this.#dropping) {
      const end = text.search(/\s/);
      if (end < 0) return;
      this.#dropping = false;
      text = text.slice(end);
    }
    const lastSpace = Math.max(text.lastIndexOf(" "), text.lastIndexOf("\n"), text.lastIndexOf("\r"));
    const tail = text.slice(lastSpace + 1);
    if (tail.length > MAX_HELD_CHARS) this.#dropping = true;
    else this.#held = tail;
    this.#report(text.slice(0, lastSpace + 1));
  }

  #report(text: string): void {
    for (const match of stripVTControlCharacters(text).matchAll(HTTPS_ADDRESS)) this.onUrl(match[0]);
  }
}
