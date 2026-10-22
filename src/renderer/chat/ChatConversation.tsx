/**
 * The chat's scrolling conversation: Studio's intro, the transcript with its earlier pages loaded
 * ahead of the reader, messages on their way, the work below it and the follow-ups that wait for it.
 */
import { memo, useMemo, useRef, useCallback, type JSX, type ReactNode } from "react";
import { PerformanceBoundary } from "../performance.tsx";
import { PerformanceComponent } from "../../shared/performance.ts";
import { t } from "../../shared/i18n.ts";
import { QueueState } from "../../shared/message-queue.ts";
import { EntryKind } from "../chat-entries.ts";
import { QueuedMessage, SendingMessage } from "../panels/QueuedMessage.tsx";
import { MessageOrigin } from "../../shared/protocol.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { Button } from "../ui/Button.tsx";
import { Presence, type PresenceChild } from "../ui/Presence.tsx";
import { PLAN_WORDS, pluginTurnedOnWords } from "../words.ts";
import type { ChatHistory } from "./chat-panel-props.ts";
import { ChatWork } from "./ChatWork.tsx";
import { type ConversationEntry, entrySize } from "./conversation-entries.ts";
import { JumpToLatest } from "./JumpToLatest.tsx";
import { SendPlacement } from "./pending-sends.ts";
import { StreamingReply } from "./StreamingReply.tsx";
import { StudioIntro } from "./StudioIntro.tsx";
import { continuedEntrance } from "./transcript-motion.ts";
import { TranscriptEntry, type TranscriptContext } from "./TranscriptEntry.tsx";
import type { ChatParts } from "./use-chat-panel.ts";
import type { FollowScroll } from "./use-follow-scroll.ts";
import type { PendingSends } from "./use-pending-sends.ts";
import type { ThreadTranscript } from "./use-thread-transcript.ts";
import { UserMessage } from "./UserMessage.tsx";
import { VirtualTranscript } from "./VirtualTranscript.tsx";

/** The transcript's context: the chat's run, game and pictures, and what its cards and bubbles do. */
function useTranscriptContext(parts: ChatParts): TranscriptContext {
  const latest = useRef(parts);
  latest.current = parts;
  const { props, chat, rewind } = parts;
  const actions = useMemo(
    () => ({
      onApprovePlan: () => latest.current.submit(PLAN_WORDS.go, undefined, true),
      onRevisePlan: () => {
        const { composer, focusComposer } = latest.current;
        if (!composer.drafts.draft) composer.drafts.setDraft(PLAN_WORDS.changePrefill);
        focusComposer();
      },
      onPluginTurnedOn: (name: string) => {
        const { report, props } = latest.current;
        void report(pluginTurnedOnWords(name), MessageOrigin.PluginTurnedOn).catch(notifyProblem(props.onNotice));
      },
    }),
    [],
  );
  return useMemo(
    () => ({
      activeRunId: chat.activeRunId,
      pausedRunId: chat.pausedRunId,
      project: chat.project,
      threadId: chat.threadId ?? null,
      images: chat.transcript.imagesByEntry,
      onShowLive: props.onShowLive,
      onShowAssets: props.onShowAssets,
      onOpenStudio: props.onOpenStudio,
      onNotice: props.onNotice,
      ...actions,
      canRewind: rewind.offers,
      onRewind: rewind.open,
      ...(!chat.isStudioThread && chat.project && chat.threadId
        ? { commands: { threadId: chat.threadId, project: chat.project } }
        : {}),
    }),
    [
      chat.activeRunId,
      chat.pausedRunId,
      chat.project,
      chat.threadId,
      chat.transcript.imagesByEntry,
      chat.isStudioThread,
      props.onShowLive,
      props.onShowAssets,
      props.onOpenStudio,
      props.onNotice,
      actions,
      rewind.offers,
      rewind.open,
    ],
  );
}

/** Retain a view's identity while its consumed fields stay equal. */
function useStableView<T extends object>(value: T): T {
  const previous = useRef(value);
  const keys = Object.keys(value) as (keyof T)[];
  if (
    Object.keys(previous.current).length !== keys.length ||
    keys.some((key) => !Object.is(previous.current[key], value[key]))
  )
    previous.current = value;
  return previous.current;
}

/** Keep draft updates in the composer; callbacks still read the latest panel state. */
export function ChatConversation(parts: ChatParts): JSX.Element {
  const latest = useRef(parts);
  latest.current = parts;
  const context = useTranscriptContext(parts);
  const actions = useMemo(
    () => ({
      ask: (question: string) => void latest.current.submit(question),
      streaming: (showing: boolean) => latest.current.stream.onShowing(showing),
      jumpToLatest: () => latest.current.follow.jumpToLatest(),
      loadEarlier: () => latest.current.props.history.loadEarlier(),
      handlers: {
        onWheel: (event: Parameters<FollowScroll["handlers"]["onWheel"]>[0]) =>
          latest.current.follow.handlers.onWheel(event),
        onPointerDown: (event: Parameters<FollowScroll["handlers"]["onPointerDown"]>[0]) =>
          latest.current.follow.handlers.onPointerDown(event),
        onKeyDown: (event: Parameters<FollowScroll["handlers"]["onKeyDown"]>[0]) =>
          latest.current.follow.handlers.onKeyDown(event),
        onScroll: () => latest.current.follow.handlers.onScroll(),
      },
    }),
    [],
  );
  const history = useStableView({ ...parts.props.history, loadEarlier: actions.loadEarlier });
  const follow = useStableView({ ...parts.follow, ...actions });
  const transcript = useStableView(parts.chat.transcript);
  const sends = useStableView({
    shown: parts.chat.sends.shown,
    adoptedRows: parts.chat.sends.adoptedRows,
    placeholders: parts.chat.sends.placeholders,
  });
  const line = useStableView(parts.work.line);
  const view = useStableView({
    history,
    follow,
    transcript,
    sends,
    line,
    threadId: parts.chat.threadId,
    events: parts.chat.events,
    idle: !parts.composer.drafts.busy && !parts.chat.working,
    studioIntro: parts.chat.isStudioThread && !parts.props.loading && !history.hasMore,
    noModel: parts.composer.noModel,
    visibleEntries: parts.work.visibleEntries,
    streaming: parts.stream.showing,
    loading: parts.props.loading,
    onNotice: parts.props.onNotice,
  });
  return <ConversationContent view={view} context={context} onAsk={actions.ask} onStreaming={actions.streaming} />;
}

type ConversationSends = Pick<PendingSends, "shown" | "adoptedRows" | "placeholders">;

type ConversationView = {
  history: ChatHistory;
  follow: FollowScroll;
  transcript: ThreadTranscript;
  sends: ConversationSends;
  line: ChatParts["work"]["line"];
  threadId: string | undefined;
  events: ChatParts["chat"]["events"];
  idle: boolean;
  studioIntro: boolean;
  noModel: boolean;
  visibleEntries: ChatParts["work"]["visibleEntries"];
  /** A reply is being written on screen. */
  streaming: boolean;
  /** The chat is loading: what arrives with it is simply there. */
  loading: boolean;
  onNotice: Notify;
};

/**
 * How a transcript row arrives (`VirtualTranscript`'s `entrance`). A saved message carries on the
 * opening its bubble began in the same place; a reply taking over the one written on screen is
 * already there; anything else that arrives after the rows before it opens; history is simply there.
 */
function rowEntrance(
  entry: ConversationEntry,
  appended: boolean,
  view: Pick<ConversationView, "sends" | "streaming">,
): number | null {
  const placeholder = view.sends.placeholders.get(entry.id);
  if (placeholder?.placement === SendPlacement.Transcript)
    return continuedEntrance(placeholder.shownAt, performance.now());
  if (!appended) return null;
  return entry.kind === EntryKind.Assistant && view.streaming ? null : 0;
}

const ConversationContent = memo(function ConversationContent({
  view,
  context,
  onAsk,
  onStreaming,
}: {
  view: ConversationView;
  context: TranscriptContext;
  onAsk: (question: string) => void;
  onStreaming: (showing: boolean) => void;
}): JSX.Element {
  const { history, follow, transcript, sends, threadId, studioIntro, loading, onNotice } = view;
  const studioEmpty = studioIntro && transcript.readingEntries.length === 0 && view.idle;
  const renderItem = useCallback(
    (entry: Parameters<typeof TranscriptEntry>[0]["entry"]) => <TranscriptEntry entry={entry} context={context} />,
    [context],
  );
  return (
    <PerformanceBoundary id={PerformanceComponent.ChatConversation}>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <ChatScroll follow={follow}>
          {studioIntro && <StudioIntro empty={studioEmpty} disabled={view.noModel} onAsk={onAsk} />}
          {history.pageError && <EarlierFailed onRetry={history.loadEarlier} />}
          <VirtualTranscript
            key={threadId}
            items={view.visibleEntries}
            scroller={follow.scroller}
            follow={follow.atBottom}
            hold={follow.holding}
            entrance={(entry, appended) => rowEntrance(entry, appended, view)}
            still={loading}
            renderItem={renderItem}
            sizeOf={entrySize}
          />
          <PendingBubbles key={`pending:${threadId}`} sends={sends} />
          <StreamingReply threadId={threadId} events={view.events} onShowing={onStreaming} />

          <ChatWork key={`work:${threadId}`} {...view.line} still={loading} onNotice={onNotice} />
          {threadId && (
            <WaitingFollowUps
              key={`waiting:${threadId}`}
              threadId={threadId}
              transcript={transcript}
              sends={sends}
              still={loading}
              onNotice={onNotice}
            />
          )}
        </ChatScroll>
        <JumpToLatest unseen={follow.unseen} working={!view.idle} onJump={follow.jumpToLatest} />
      </div>
    </PerformanceBoundary>
  );
});

/** The transcript's scroller: it follows the newest entry until the reader scrolls away. */
function ChatScroll({ follow, children }: { follow: FollowScroll; children: ReactNode }): JSX.Element {
  return (
    <div
      ref={follow.scroller}
      {...follow.handlers}
      // The virtual transcript owns anchoring. Native anchoring to the active workers
      // below it would jump past an expanded tool list and unmount its disclosure.
      style={{ overflowAnchor: "none" }}
      data-chat-scroll
      aria-label={t("Conversation")}
      tabIndex={0}
      // Nothing in the conversation is wider than its column: a long unbroken line wraps or scrolls
      // in its own box, never the whole conversation sideways.
      className="h-full overflow-x-clip overflow-y-auto px-5 py-5"
    >
      <div className="chat-conversation-stack flex min-w-0 flex-col gap-4">{children}</div>
    </div>
  );
}

/** An earlier page that did not load: the only time paging shows, since the next page loads ahead of the reader. */
function EarlierFailed({ onRetry }: { onRetry: () => Promise<void> }): JSX.Element {
  return (
    <div role="alert" className="flex items-center justify-center gap-2 text-xs text-red">
      {t("Could not load earlier messages.")}
      <Button variant="ghost" onClick={() => void onRetry()}>
        {t("Try again")}
      </Button>
    </div>
  );
}

/**
 * Messages on their way that show at the end of the conversation until their rows arrive. Each
 * opens in place; its saved row takes over where it is, carrying the opening on (`rowEntrance`).
 * A send that failed closes.
 */
function PendingBubbles({ sends }: { sends: ConversationSends }): JSX.Element {
  const bubbles = sends.shown
    .filter((send) => send.placement === SendPlacement.Transcript)
    .map((send) => ({
      key: send.clientId,
      node: (
        <div data-pending-send className="flow-root min-w-0">
          <UserMessage text={send.text} frames={send.frames} />
        </div>
      ),
    }));
  return <Presence handedOver={(clientId) => savedFrom(sends, clientId)}>{bubbles}</Presence>;
}

/** Whether a bubble on its way became a saved row (its row took its place). */
const savedFrom = (sends: ConversationSends, clientId: string): boolean =>
  [...sends.placeholders.values()].some((placeholder) => placeholder.clientId === clientId);

/**
 * Follow-ups that wait below the current work until it reads them, then those still being sent;
 * each reads Sending… either way, and one no turn has taken yet can be removed. A waiting message
 * keeps the place of the bubble it was sent as; delivered, it closes here as it opens where it was read.
 */
function WaitingFollowUps({
  threadId,
  transcript,
  sends,
  still,
  onNotice,
}: {
  threadId: string;
  transcript: ThreadTranscript;
  sends: ConversationSends;
  /** The chat is loading: its waiting messages are simply there. */
  still: boolean;
  onNotice: Notify;
}): JSX.Element {
  const waiting = transcript.waitingEntries.flatMap((entry): PresenceChild[] => {
    const queued = transcript.queuedByEvent.get(entry.id);
    if (entry.kind !== EntryKind.User || !queued) return [];
    const images = transcript.imagesByEntry.get(entry.id);
    return [
      {
        key: sends.placeholders.get(entry.id)?.clientId ?? entry.id,
        node: (
          <QueuedMessage
            threadId={threadId}
            messageId={queued.messageId}
            sending={queued.state === QueueState.Steering}
            text={entry.text}
            {...(images ? { images: { count: images.count } } : {})}
            onNotice={onNotice}
          />
        ),
      },
    ];
  });
  const sending = sends.shown
    .filter((send) => send.placement === SendPlacement.Waiting)
    .map((send) => ({ key: send.clientId, node: <SendingMessage text={send.text} frames={send.frames} /> }));
  return <Presence still={still}>{[...waiting, ...sending]}</Presence>;
}
