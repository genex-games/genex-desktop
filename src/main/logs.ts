/**
 * `userData/logs/studio.log`: the one file a bug report can attach. Main writes its own errors,
 * the harness's stderr and the core's `[core]`/`[host]` lines, and the renderer's console errors
 * here, each line redacted before it reaches the disk. The file rotates by size
 * (`studio.log` → `studio.log.1` …) and keeps a fixed number of files, so it never grows without
 * bound. Logging never throws: a folder that cannot be written loses lines, not the app.
 */
import { closeSync, mkdirSync, openSync, readSync, fstatSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../shared/redact.ts";

export const LOG_FILE = "studio.log";
/** 5 files of 5 MB: a few runs of harness stderr. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_FILES = 5;

const TAIL_CHUNK_BYTES = 8 * 1024;

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const REGEXP_SPECIAL = /[.*+?^$()|[\]{}\\]/g;

/**
 * `text` as a log or a report may show it: credentials by shape, email addresses and the user's
 * home folder (as `~`, when it is a whole path segment) removed.
 */
export function scrubForLog(text: string, home: string): string {
  return scrubWithPattern(text, homePattern(home));
}

function homePattern(home: string): RegExp | null {
  if (home.length <= 1) return null;
  const folder = home.replace(REGEXP_SPECIAL, "\\$&");
  return new RegExp(`${folder}(?![\\w-])`, "g");
}

function scrubWithPattern(text: string, pattern: RegExp | null): string {
  const redacted = redactSecrets(text);
  // The email pattern retries from every letter of a long word (a base64 image takes seconds);
  // text without an @ holds no address to find.
  const out = redacted.includes("@") ? redacted.replace(EMAIL, "[email]") : redacted;
  return pattern ? out.replace(pattern, "~") : out;
}

/** Read backwards by bytes, decoding only after complete line boundaries were collected. */
function tailFile(file: string, count: number): string[] {
  const handle = openSync(file, "r");
  try {
    let position = fstatSync(handle).size;
    let completed = 0;
    let hasContent = false;
    const chunks: Buffer[] = [];
    while (position > 0 && completed < count) {
      const size = Math.min(position, TAIL_CHUNK_BYTES);
      position -= size;
      const chunk = Buffer.alloc(size);
      const bytes = readSync(handle, chunk, 0, size, position);
      const read = chunk.subarray(0, bytes);
      chunks.unshift(read);
      for (let at = read.length - 1; at >= 0; at--) {
        if (read[at] === 10) {
          if (hasContent) completed++;
          hasContent = false;
        } else hasContent = true;
      }
    }
    const lines = Buffer.concat(chunks).toString("utf8").split("\n");
    if (position > 0) lines.shift();
    return lines.filter(Boolean).slice(-count);
  } finally {
    closeSync(handle);
  }
}

export interface StudioLog {
  /** The current file's path. */
  readonly file: string;
  write(source: string, line: string): void;
  /** The newest `count` lines, oldest first, reading into rotated files when needed. */
  tail(count: number): string[];
  close(): void;
}

export interface StudioLogOptions {
  home: string;
  maxBytes?: number;
  files?: number;
  now?: () => Date;
}

/** Open (or continue) the log in `dir`. */
export function openStudioLog(
  dir: string,
  { home, maxBytes = LOG_MAX_BYTES, files = LOG_FILES, now = () => new Date() }: StudioLogOptions,
): StudioLog {
  const file = path.join(dir, LOG_FILE);
  const pattern = homePattern(home);
  const rotated = (index: number) => (index === 0 ? file : `${file}.${index}`);
  let fd: number | null = null;
  let size = 0;
  let broken = false;

  const open = (): number | null => {
    if (fd !== null || broken) return fd;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      fd = openSync(file, "a", 0o600);
      size = statSync(file).size;
    } catch {
      // Not writable (a file where the folder should be, a full disk): stop trying this launch.
      broken = true;
      fd = null;
    }
    return fd;
  };

  const rotate = () => {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
      fd = null;
    }
    try {
      rmSync(rotated(files - 1), { force: true });
      for (let index = files - 2; index >= 0; index--) {
        try {
          renameSync(rotated(index), rotated(index + 1));
        } catch {
          /* that generation does not exist yet */
        }
      }
    } catch {
      /* keep writing into whatever file opens next */
    }
    size = 0;
  };

  return {
    file,
    write(source, line) {
      const text = `${now().toISOString()} [${source}] ${scrubWithPattern(line, pattern)}\n`;
      const bytes = Buffer.byteLength(text);
      let handle = open();
      if (handle === null) return;
      if (size > 0 && size + bytes > maxBytes) {
        rotate();
        handle = open();
        if (handle === null) return;
      }
      try {
        writeSync(handle, text);
        size += bytes;
      } catch {
        /* a lost line, never a thrown write */
      }
    },
    tail(count) {
      const lines: string[] = [];
      for (let index = 0; index < files && lines.length < count; index++) {
        try {
          lines.unshift(...tailFile(rotated(index), count - lines.length));
        } catch {
          break;
        }
      }
      return lines;
    },
    close() {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {}
        fd = null;
      }
    },
  };
}
