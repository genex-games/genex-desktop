/**
 * Which names in a chat are files, as main answered (shared/chat-files.ts). Answers are kept per
 * chat for as long as the window lives: the transcript remounts rows as it scrolls, and a name is
 * asked about once. Work in the chat writes, moves and deletes files, so `recheckChatFiles` asks
 * again about the names on screen; an answer stays until a different one replaces it.
 */
import { createContext, type MouseEvent, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import {
  CHAT_FILE_LIMIT,
  ChatFileOpen,
  type ChatFileLink,
  type ChatFileLookup,
  type ChatFileRef,
  chatFileKey,
} from "../shared/chat-files.ts";
import { namedDesignPage } from "../shared/design-board.ts";
import { SECOND_MS } from "../shared/duration.ts";
import { openBeside, openChatFile, openDesignPage } from "./open-beside.ts";

/** The chat whose files the text inside names. Without one, nothing becomes a file link. */
export const ChatFilesScope = createContext<string | null>(null);

/** How long names asked about together wait, so one render's names go to main as one request. */
const ASK_BATCH_MS = 16;
/** Names on screen are asked about again at most this often while a chat's events arrive. */
const RECHECK_MS = 3 * SECOND_MS;

const answers = new Map<string, Map<string, ChatFileLink | null>>();
/** Names shown right now, per chat, with how many places show them. */
const shown = new Map<string, Map<string, { ref: ChatFileRef; count: number }>>();
const queued = new Map<string, Map<string, ChatFileRef>>();
const asking = new Set<string>();
const listeners = new Set<() => void>();
/** Bumped when a chat's answers change, so only that chat's text renders again. */
const versions = new Map<string, number>();
let flushing: ReturnType<typeof setTimeout> | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const same = (a: ChatFileLink | null | undefined, b: ChatFileLink | null): boolean =>
  a === b || Boolean(a && b && a.open === b.open && a.path === b.path && a.build === b.build);

/** The map a chat's entries live in, made on first use. */
function entryOf<V>(maps: Map<string, Map<string, V>>, threadId: string): Map<string, V> {
  const existing = maps.get(threadId);
  if (existing) return existing;
  const created = new Map<string, V>();
  maps.set(threadId, created);
  return created;
}

function settle(threadId: string, keys: string[], links: Array<ChatFileLink | null>): void {
  const known = entryOf(answers, threadId);
  let changed = false;
  keys.forEach((key, index) => {
    asking.delete(`${threadId}\0${key}`);
    const link = links[index] ?? null;
    const before = known.get(key);
    known.set(key, link);
    // A first answer of "not a file" shows nothing new: the name was text already.
    if (!same(before, link) && (before !== undefined || link !== null)) changed = true;
  });
  if (!changed) return;
  versions.set(threadId, (versions.get(threadId) ?? 0) + 1);
  for (const listener of listeners) listener();
}

function flush(): void {
  flushing = undefined;
  for (const [threadId, refs] of queued) {
    queued.delete(threadId);
    const entries = [...refs.entries()];
    for (let start = 0; start < entries.length; start += CHAT_FILE_LIMIT) {
      const batch = entries.slice(start, start + CHAT_FILE_LIMIT);
      const keys = batch.map(([key]) => key);
      void window.studio
        .resolveChatFiles(
          threadId,
          batch.map(([, ref]) => ref),
        )
        .then(
          (links) => settle(threadId, keys, Array.isArray(links) ? links : []),
          // A chat that cannot answer (gone, no folder) links nothing rather than asking forever.
          () => settle(threadId, keys, []),
        );
    }
  }
}

function ask(threadId: string, refs: ChatFileRef[], again: boolean): void {
  const known = answers.get(threadId);
  for (const ref of refs) {
    const key = chatFileKey(ref.name, ref.base);
    if ((!again && known?.has(key)) || asking.has(`${threadId}\0${key}`)) continue;
    asking.add(`${threadId}\0${key}`);
    entryOf(queued, threadId).set(key, ref);
  }
  if (queued.size && flushing === undefined) flushing = setTimeout(flush, ASK_BATCH_MS);
}

/** Ask again about the names on screen, or only `refs`: files come and go while a chat works. */
export function recheckChatFiles(threadId: string, refs?: ChatFileRef[]): void {
  const again = refs ?? [...(shown.get(threadId)?.values() ?? [])].map(({ ref }) => ref);
  if (again.length) ask(threadId, again, true);
}

/**
 * Work in a chat writes files: as its events arrive (`events` is how many there are), the names
 * on screen are asked about again, at most every few seconds.
 */
export function useChatFilesRecheck(threadId: string | null, events: number): void {
  const checkedAt = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new event is what asks again
  useEffect(() => {
    if (!threadId) return;
    const timer = setTimeout(
      () => {
        checkedAt.current = Date.now();
        recheckChatFiles(threadId);
      },
      Math.max(0, checkedAt.current + RECHECK_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [threadId, events]);
}

/**
 * This text's own answers as one string: a memo keyed on it renders the text again only when a
 * name in it changes, not whenever any name of the chat is answered.
 */
export function answersOf(lookup: ChatFileLookup, refs: ChatFileRef[]): string {
  return refs
    .map((ref) => {
      const link = lookup(ref.name, ref.base);
      return link ? `${link.open}\n${link.path}\n${link.build ? 1 : ""}` : "";
    })
    .join("\0");
}

/** The chat in scope and what main has answered about its names so far. */
export function useChatFiles(): { threadId: string | null; lookup: ChatFileLookup } {
  const threadId = useContext(ChatFilesScope);
  const at = useSyncExternalStore(subscribe, () => (threadId ? (versions.get(threadId) ?? 0) : 0));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `at` is the version the lookup reads
  const lookup = useMemo<ChatFileLookup>(
    () => (name, base) => (threadId ? answers.get(threadId)?.get(chatFileKey(name, base)) : null),
    [threadId, at],
  );
  return { threadId, lookup };
}

/** Counts `unique` as shown in `threadId`; the returned function takes them away again. */
function show(threadId: string, unique: Array<[string, ChatFileRef]>): () => void {
  const names = entryOf(shown, threadId);
  for (const [name, ref] of unique) {
    const entry = names.get(name);
    if (entry) entry.count += 1;
    else names.set(name, { ref, count: 1 });
  }
  return () => {
    for (const [name] of unique) {
      const entry = names.get(name);
      if (!entry) continue;
      entry.count -= 1;
      if (entry.count <= 0) names.delete(name);
    }
  };
}

/** The names a piece of text shows: asked about once, and again by `recheckChatFiles` while shown. */
export function useChatFileNames(threadId: string | null, refs: ChatFileRef[]): void {
  const key = refs.map((ref) => chatFileKey(ref.name, ref.base)).join("\0");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `refs`: the same names register once
  useEffect(() => {
    if (!threadId || !refs.length) return;
    const unique = [...new Map(refs.map((ref) => [chatFileKey(ref.name, ref.base), ref])).entries()];
    const hide = show(threadId, unique);
    ask(
      threadId,
      unique.map(([, ref]) => ref),
      false,
    );
    return hide;
  }, [threadId, key]);
}

/** A click on a file link (`data-file-open`) inside this element opens that file. */
export function clickFileLink(event: MouseEvent<HTMLElement>, threadId: string | null): void {
  const element = (event.target as Element | null)?.closest?.("[data-file-open]");
  if (!threadId || !element || !event.currentTarget.contains(element)) return;
  event.preventDefault();
  if (element.getAttribute("data-file-open") === ChatFileOpen.Beside) {
    openBeside({ kind: "file", path: element.getAttribute("data-file-target") ?? "" });
    return;
  }
  const name = element.getAttribute("data-file-path") ?? "";
  const base = element.getAttribute("data-file-base");
  // A page of the game's design board opens where it is drawn, on the Design tab.
  const page = namedDesignPage(name, base);
  if (page) {
    openDesignPage(page);
    return;
  }
  openChatFile({ threadId, ref: base ? { name, base } : { name }, label: element.textContent?.trim() || name });
}
