/**
 * What Play remembers about voice chat: the games whose mic switch was left on, and the microphone
 * chosen in the switch's menu (by name: a page's device ids are its own). One small file in the
 * profile; missing or damaged, it reads as nothing remembered. Writes are atomic and queued.
 */
import { readFile } from "node:fs/promises";
import { isPlaySlug } from "../../shared/play.ts";
import { micDeviceName } from "../../shared/play-mic.ts";
import { atomicWriteJson } from "../../substrate/fsx.ts";

/** The file's format. */
const STORE_VERSION = 1;
/** The most games remembered with their mic on; the longest unused go first. */
const GAMES_MAX = 500;

/** The games whose mic is on and the chosen microphone, read and changed at once. */
export interface PlayMicStore {
  /** Whether `slug`'s mic switch was left on. */
  on(slug: string): boolean;
  setOn(slug: string, on: boolean): void;
  /** The chosen microphone's name, or null for the system's. */
  device(): string | null;
  setDevice(device: string | null): void;
}

interface Saved {
  games: string[];
  device: string | null;
}

const NOTHING: Saved = { games: [], device: null };

/** The file's content as the store keeps it: valid slugs, each once, bounded; a clean name or none. */
function parse(text: string): Saved {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return NOTHING;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return NOTHING;
  const { games, device } = data as Record<string, unknown>;
  const slugs = Array.isArray(games) ? games.filter(isPlaySlug) : [];
  return { games: [...new Set(slugs)].slice(-GAMES_MAX), device: micDeviceName(device) };
}

/** The store over `file`: it reads the file at once and answers from memory, as nothing remembered until then. */
export function playMicStore(file: string): PlayMicStore & { ready: Promise<void>; flush(): Promise<void> } {
  let saved: Saved = NOTHING;
  let tail: Promise<unknown> = Promise.resolve();
  const ready = readFile(file, "utf8").then(
    (text) => {
      saved = parse(text);
    },
    () => undefined,
  );
  const write = (next: Saved): void => {
    saved = next;
    tail = tail
      .then(() => ready)
      .then(() => atomicWriteJson(file, { version: STORE_VERSION, ...next }))
      .catch(() => undefined);
  };
  return {
    ready,
    on: (slug) => saved.games.includes(slug),
    setOn: (slug, on) => {
      if (!isPlaySlug(slug)) return;
      const others = saved.games.filter((game) => game !== slug);
      write({ ...saved, games: on ? [...others, slug].slice(-GAMES_MAX) : others });
    },
    device: () => saved.device,
    setDevice: (device) => write({ ...saved, device: micDeviceName(device) }),
    /** Every change made so far is on disk. */
    flush: () => tail.then(() => undefined),
  };
}

/** The store over `file`, once the file has been read. */
export async function openPlayMicStore(file: string): Promise<ReturnType<typeof playMicStore>> {
  const store = playMicStore(file);
  await store.ready;
  return store;
}
