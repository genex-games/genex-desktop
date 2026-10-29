/**
 * Game chats: the one canonical conversation per game, legacy unbound drafts, titles and bindings,
 * and the repair that re-binds a chat the old binding gap orphaned. Composed by `StudioCore`.
 */
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { EventKind, ThreadKind } from "../../shared/event-log.ts";
import { t } from "../../shared/i18n.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import type { ConversationRecord, EventEnvelope } from "../../substrate/types.ts";
import type { StudioCore } from "../studio-core.ts";

/** Why a thread change is refused, as the person reads it. */
const MESSAGE = {
  chatNeedsName: () => t("a chat needs a name"),
} as const;

/** The title a game's own conversation starts with. */
export const NEW_CHAT_TITLE = "New chat";
/** The title an unbound game draft starts with. */
export const NEW_GAME_TITLE = "New game";
/** Characters kept of a chat's new name. */
const THREAD_TITLE_MAX = 80;
/** The tool that scaffolds a game: its `name` argument is the game it built. */
const NEW_GAME_TOOL = "new_game";

type GameThreadMeta = { kind?: string; project?: string | null; archived?: boolean };

const metaOf = (thread: ConversationRecord): GameThreadMeta => (thread.metadata ?? {}) as GameThreadMeta;

/** A live game chat bound to a folder. */
function isBoundGameThread(meta: GameThreadMeta): meta is GameThreadMeta & { project: string } {
  return meta.kind === ThreadKind.Game && Boolean(meta.project) && !meta.archived;
}

/** A live game chat bound to nothing yet: a draft. */
function isUnboundGameThread(meta: GameThreadMeta): boolean {
  return meta.kind === ThreadKind.Game && !meta.project && !meta.archived;
}

export class GameThreadService {
  readonly #core: StudioCore;

  constructor(core: StudioCore) {
    this.#core = core;
  }

  async threadForGame(project: string): Promise<string> {
    const threads = (await this.#core.store.listThreads())
      .filter((t) => {
        const meta = metaOf(t);
        return meta.kind === ThreadKind.Game && meta.project === project && !meta.archived;
      })
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    const primary = (await this.#core.games.presentation(project)).primaryThreadId;
    const current = threads.find((thread) => thread.id === primary) ?? threads[0];
    if (current) {
      if (primary !== current.id) await this.#core.games.rememberThread(project, current.id);
      return current.id;
    }
    const id = await this.#core.store.createThread({
      title: NEW_CHAT_TITLE,
      metadata: { kind: ThreadKind.Game, project },
    });
    await this.#core.games.rememberThread(project, id);
    this.#core.emit(UiEvent.ThreadCreated, { threadId: id, project });
    await this.#core.games.touch(project).catch(() => {});
    return id;
  }

  /**
   * A game always reuses its canonical conversation. Unbound drafts remain a legacy API
   * for existing callers; the desktop creates a named folder before opening its conversation.
   */
  async createGameThread(project?: string): Promise<string> {
    const threads = await this.#core.store.listThreads();
    if (project) return this.#core.threadForGame(project);
    for (const thread of threads) {
      if (!isUnboundGameThread(metaOf(thread))) continue;
      if (await this.threadIsEmpty(thread.id)) return thread.id;
    }
    const id = await this.#core.store.createThread({
      title: NEW_GAME_TITLE,
      metadata: { kind: ThreadKind.Game, project: null },
    });
    this.#core.emit(UiEvent.ThreadCreated, { threadId: id, project: null });
    return id;
  }

  /** Retitle a chat. The record is the index; `thread_updated` is the durable truth. */
  async renameThread(threadId: string, title: string): Promise<ConversationRecord> {
    const next = title.trim().slice(0, THREAD_TITLE_MAX);
    if (!next) throw new Error(MESSAGE.chatNeedsName());
    const record = await this.#core.store.updateThread(threadId, { title: next });
    this.#core.emit(UiEvent.ThreadUpdated, { threadId, title: next });
    return record;
  }

  /** Nothing but the `thread_created` event — nobody has spoken in this chat yet. */
  async threadIsEmpty(threadId: string): Promise<boolean> {
    const events = await this.#core.store.listEvents(threadId).catch(() => []);
    return events.every((e) => e.data.type === EventKind.ThreadCreated);
  }

  async bindThreadToProject(threadId: string, project: string): Promise<void> {
    await this.#core.store.getRecord(threadId);
    // Keep the first-ask title (or "New chat"). Naming the chat after the folder made every
    // row in that folder identical — the rail then had nothing to tell chats apart.
    // updateThread merges: only the keys this changes, so a stale copy never overwrites others.
    await this.#core.store.updateThread(threadId, { metadata: { kind: ThreadKind.Game, project } });
    this.#core.emit(UiEvent.ThreadBound, { threadId, project });
  }

  /**
   * Adopt chats the old binding gap orphaned. A chat that scaffolded a game but was never named
   * after it shows up as a permanent "New game" row holding a real conversation, while the game
   * it built answers to a different, empty chat. Both halves are repaired here — the chat is
   * bound to the game it actually built, and the empty stand-in is archived. Anything ambiguous
   * (two chats with real history claiming one game) is left exactly as it is: the point is to
   * recover history, never to choose between two of them.
   */
  async adoptOrphanedGameThreads(): Promise<void> {
    const games = new Set((await this.#core.games.list()).map((g) => g.name));
    if (games.size === 0) return;
    const threads = await this.#core.store.listThreads();
    const bound = new Map<string, ConversationRecord>();
    for (const t of threads) {
      const m = metaOf(t);
      if (isBoundGameThread(m)) bound.set(m.project, t);
    }

    for (const thread of threads) {
      if (!isUnboundGameThread(metaOf(thread))) continue;
      const events = await this.#core.store.listEvents(thread.id).catch(() => []);
      const project = this.projectBuiltIn(events, games);
      if (!project) continue;
      if (await this.#adopt(thread, project, bound.get(project))) bound.set(project, thread);
    }
  }

  /** Bind an orphaned chat to the game it built, archiving an empty stand-in; false when both have history. */
  async #adopt(thread: ConversationRecord, project: string, incumbent: ConversationRecord | undefined) {
    if (incumbent) {
      if (!(await this.threadIsEmpty(incumbent.id))) return false; // two real chats — not ours to merge
      await this.#core.store.updateThread(incumbent.id, { metadata: { archived: true } });
    }
    await this.#core.bindThreadToProject(thread.id, project);
    await this.#core.append([customEventData(CustomEvent.ThreadAdopted, { threadId: thread.id, project })]);
    return true;
  }

  /** The game a chat actually worked in, read back off its own log. */
  projectBuiltIn(events: EventEnvelope[], games: Set<string>): string | null {
    let found: string | null = null;
    for (const event of events) {
      const data = event.data as { type?: string; request?: { name?: string; arguments?: Record<string, unknown> } };
      if (data.type !== EventKind.ToolRequested) continue;
      const args = data.request?.arguments ?? {};
      const named = data.request?.name === NEW_GAME_TOOL ? args.name : args.project;
      if (typeof named === "string" && games.has(named)) found = named;
    }
    return found;
  }
}
