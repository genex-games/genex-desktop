/** Conversations: the bootstrap, sending, stopping, the event feed and the thread records. */
import { type ThreadStatusMap, UiEvent } from "../../shared/ui-events.ts";
import { MentionRetry, readMentionRefs } from "../../shared/prompt-mention.ts";
import type { SmokeReadGates } from "../smoke/read-gates.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";
import { errorMessage } from "../../shared/errors.ts";
import type { EngineBoot } from "../engine-boot.ts";

/** Why a thread read (or a tag's retry) from the renderer is refused. */
const MESSAGE = {
  badTag: "Not a tag of this chat",
  fixtureBootstrapUnavailable: "Fixture bootstrap unavailable",
  fixtureThreadUnavailable: "Fixture thread unavailable",
  invalidPage: "Invalid conversation page",
} as const;

export interface ThreadsIpcDeps {
  core: StudioCore;
  /** The engines a bootstrap shows: the remembered ones while the launch's checks run (`engine-boot.ts`). */
  engines: Pick<EngineBoot, "bootstrap">;
  /** `~/AI Games`, as a human reads it — the renderer never sees absolute paths. */
  gamesRootLabel(root: string): string;
  /** The harness's last reported status per thread, for a renderer that loads mid-run. */
  threadStatus(): ThreadStatusMap;
  pushUiEvent(event: UiEvent): void;
  appendErrorDurably(threadId: string | undefined, message: string): Promise<void>;
  /** The build smoke's read gates; null outside `--studio-smoke`. */
  smokeReads: SmokeReadGates | null;
  /** This launch may welcome a first launch: not smoke, self test or a fixture other than `first-launch`. */
  welcome: boolean;
  /** An unpackaged developer run, where the renderer offers its developer tools. */
  developer: boolean;
  /** The website Play links to (`play/origins.ts`). */
  playWeb: string;
}

/** A sent message's failed @ tag tried again or taken off: the renderer names the tag, main re-checks it as a send does. */
export function registerMentionRetry(handle: IpcHandle, core: StudioCore): void {
  handle("studio:mentions.retry", async (payload) => {
    const [tag] = readMentionRefs([payload?.tag]);
    const action = payload?.action;
    const known = action === MentionRetry.Again || action === MentionRetry.Remove;
    const ids = typeof payload?.threadId === "string" && typeof payload?.messageId === "string";
    if (!tag || !known || !ids) throw new Error(MESSAGE.badTag);
    await core.retryMention(payload.threadId, payload.messageId, tag, action);
  });
}

export function registerThreadsIpc(
  handle: IpcHandle,
  {
    core,
    engines: engineList,
    gamesRootLabel,
    threadStatus,
    pushUiEvent,
    appendErrorDurably,
    smokeReads,
    welcome,
    developer,
    playWeb,
  }: ThreadsIpcDeps,
): void {
  handle("studio:bootstrap", async () => {
    if (smokeReads) {
      await smokeReads.bootstrap;
      if (smokeReads.failBootstrap) {
        throw new Error(MESSAGE.fixtureBootstrapUnavailable);
      }
    }
    // The renderer's poll continues from `eventsCursor`, never from the tail's last id. The reads
    // are independent; the engines come remembered while their checks run, so the loader no
    // longer waits seconds for every CLI.
    const [feed, threads, games, engines] = await Promise.all([
      core.store.listAllSince(undefined, 600),
      core.store.listThreads(),
      core.games.list(),
      engineList.bootstrap(),
    ]);
    return {
      threadId: core.mainThread,
      layout: core.layout,
      gamesRootLabel: gamesRootLabel(core.layout.gamesRoot),
      harness: { state: core.host.state, version: core.host.harnessVersion, capabilities: core.host.capabilities },
      threads,
      events: feed.events,
      eventsCursor: feed.cursor,
      games,
      engines,
      threadStatus: threadStatus(),
      activeDelegations: core.activeBuilders(),
      welcome,
      developer,
      playWebOrigin: playWeb,
    };
  });

  handle("studio:send", async (payload) => {
    try {
      const { text, ...options } = payload;
      await core.sendUserMessage(text, options);
    } catch (err) {
      // The composer already cleared the draft, and the renderer's send is fire-and-forget —
      // a swallowed rejection here would leave no trace of the ask ever failing.
      const message = String(errorMessage(err));
      await appendErrorDurably(payload.thread, `The message could not be sent: ${message}`);
      pushUiEvent({ type: UiEvent.ChatError, payload: { threadId: payload.thread ?? core.mainThread, message } });
      throw err;
    }
    return true;
  });

  // The stop button: abort the thread's contractor (finished edits stay; the turn reports the
  // partial state and offers Continue) and wind down the harness loop.
  handle("studio:plan.answer", async (payload) => core.answerPlan(payload.threadId, payload.id, payload.approved));
  handle("studio:cancel", async (payload) => {
    await core.stopThread(payload.threadId);
    return true;
  });
  registerQueueIpc(handle, core);

  handle("studio:events", async (payload) =>
    core.store.listAllSince(typeof payload?.after === "string" ? payload.after : undefined),
  );
  // The bootstrap's 600-event tail keeps startup fast, but a thread with a long run behind it
  // loses its head — the intake conversation — to the window. Opening a thread backfills it.
  handle("studio:thread.events", async (payload) => {
    if (smokeReads) {
      await smokeReads.thread;
      if (smokeReads.failThread) {
        throw new Error(MESSAGE.fixtureThreadUnavailable);
      }
    }
    return core.store.listEvents(payload.threadId);
  });
  handle("studio:chat.page", async (payload) => {
    if (smokeReads) {
      await smokeReads.thread;
      if (smokeReads.failThread) throw new Error(MESSAGE.fixtureThreadUnavailable);
    }
    if (
      !payload ||
      typeof payload.threadId !== "string" ||
      (payload.before !== undefined && typeof payload.before !== "string")
    )
      throw new Error(MESSAGE.invalidPage);
    return core.store.chatPage(payload.threadId, payload.before);
  });
  handle("studio:threads", async () => core.store.listThreads());
  // The images a message was sent with, as the harness saved them; the chat shows them on reload.
  handle("studio:message-images", async (payload) =>
    core.messageImages(String(payload.threadId), String(payload.messageId)),
  );
  handle("studio:thread.new", async (payload) => {
    const threadId = await core.createGameThread(payload?.project);
    return core.store.getRecord(threadId);
  });
  handle("studio:thread.forGame", async (payload) => {
    const threadId = await core.threadForGame(payload.project);
    return core.store.getRecord(threadId);
  });
  handle("studio:thread.rename", async (payload) => core.renameThread(payload.threadId, payload.title));
  handle("studio:context.get", (p) => core.contextPreferences.get(p.engine, p.model, p.threadId));
  handle("studio:context.set", async (p) => {
    const result = await core.contextPreferences.set(p.engine, p.model, p.policy, p.threadId);
    return result;
  });
  handle("studio:compact", async (payload) => {
    await core.compactThread(payload.threadId, {
      ...(payload.engine ? { engine: payload.engine } : {}),
      ...(payload.model ? { model: payload.model } : {}),
    });
    return true;
  });
}

/** A chat's waiting messages, and rewinding it to before one of its messages. */
function registerQueueIpc(handle: IpcHandle, core: StudioCore): void {
  handle("studio:queue.message", async (payload) => {
    await core.changeQueuedMessage(payload.threadId, payload.messageId, payload.operation, payload.text);
  });
  handle("studio:chat.rewind.preview", async (payload) =>
    core.rewindPreview(String(payload?.threadId), String(payload?.eventId), String(payload?.messageId)),
  );
  handle("studio:chat.rewind", async (payload) =>
    core.rewindChat(String(payload?.threadId), String(payload?.eventId), String(payload?.messageId), {
      files: payload?.files === true,
    }),
  );
  handle("studio:chat.rewind.undo", async (payload) =>
    core.undoRewind(String(payload?.threadId), String(payload?.rewindId)),
  );
}
