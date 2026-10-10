/**
 * One entry of the transcript, drawn by its kind (`chat-entries.ts` decides what the entries are).
 */
import { type JSX, memo, useCallback, useMemo } from "react";
import { type Entry, EntryAction, EntryKind } from "../chat-entries.ts";
import { ExportReview } from "./ExportReview.tsx";
import { type ConversationEntry, WORK_KIND } from "./conversation-entries.ts";
import { MorningCard } from "../panels/MorningCard.tsx";
import { FileText } from "../ui/FileText.tsx";
import { Icon } from "../ui/icons.tsx";
import { Markdown } from "../ui/Markdown.tsx";
import { ResultButton } from "../ui/ResultButton.tsx";
import { ToolRow } from "../ui/ToolChips.tsx";
import { compactedWords, consentRequestedWords } from "../words.ts";
import { type Notify, notifyProblem } from "../state/toasts.ts";
import { AssetResults } from "./AssetResults.tsx";
import { ChatDisclosure } from "./ChatDisclosure.tsx";
import { CommandRun } from "./CommandRun.tsx";
import { GenexCoverCard } from "./GenexCoverCard.tsx";
import { ChatQuestion } from "./ChatQuestion.tsx";
import { PermissionOutcome } from "./PermissionRequest.tsx";
import { StudioLearningLine } from "./LearningSummary.tsx";
import { UserMessage } from "./UserMessage.tsx";
import { WorkLog } from "./WorkLog.tsx";

/** A paused run while nothing else runs: its own card offers Resume. */
const resumable = (runId: string | null | undefined, context: TranscriptContext): runId is string =>
  Boolean(runId) && runId === context.pausedRunId && !context.activeRunId;

export interface TranscriptContext {
  /** The run this chat is building right now, if any. */
  activeRunId: string | null;
  /** The chat's run that is paused (Resume belongs to it), if any. */
  pausedRunId: string | null;
  /** The chat's game, for a morning card that did not record its own. */
  project: string | null;
  /** The chat itself, whose saved attachments a message's pictures are read from. */
  threadId: string | null;
  /** Pictures sent with a user entry's message (`sentImages`). */
  images: ReadonlyMap<string, { messageId: string; count?: number }>;
  onShowLive?: () => void;
  onShowAssets?: () => void;
  onOpenStudio?: () => void;
  onNotice: Notify;
  /** A held build plan's "Approve plan": answer it with "go", keeping the draft. */
  onApprovePlan: () => Promise<void>;
  /** "Make changes": start the reply in the composer. */
  onRevisePlan: () => void;
  /** Whether a user bubble (by entry id) offers Rewind now. */
  canRewind?: (entryId: string) => boolean;
  /** Rewind the chat to before this bubble (stable, so memoized bubbles keep still). */
  onRewind?: (entryId: string) => void;
  /** Where a command a reply offers runs: this chat's game. Absent in Studio, whose replies offer none. */
  commands?: { threadId: string; project: string };
}

export const TranscriptEntry = memo(function TranscriptEntry({
  entry,
  context,
}: {
  entry: ConversationEntry;
  context: TranscriptContext;
}): JSX.Element | null {
  const { onNotice } = context;
  const resume = useCallback(
    (runId: string) => () => void window.studio.resumeAutopilot(runId).catch(notifyProblem(onNotice)),
    [onNotice],
  );
  const deliveries = useMemo(() => (entry.kind === EntryKind.Assets ? [entry.delivery] : []), [entry]);
  switch (entry.kind) {
    case WORK_KIND:
      return <WorkLog items={entry.items} />;
    case EntryKind.Assets:
      return <AssetResults deliveries={deliveries} onOpenAssets={context.onShowAssets} />;
    case EntryKind.GenexCover:
      return <GenexCoverCard entry={entry} project={context.project} />;
    case EntryKind.User:
      return <UserEntry key={entry.id} entry={entry} context={context} />;
    case EntryKind.Assistant:
      return <AssistantEntry key={entry.id} entry={entry} commands={context.commands} />;
    case EntryKind.Notice:
      return (
        <div className="chat-tool-frame">
          <ToolRow row={entry.row} />
        </div>
      );
    case EntryKind.System:
      return <SystemEntry key={entry.id} entry={entry} />;
    case EntryKind.Learning:
      return <StudioLearningLine text={entry.text} link={entry.link} onOpenStudio={context.onOpenStudio} />;
    case EntryKind.Question:
      return (
        <ChatDisclosure label={entry.text}>
          <p className="px-3 py-2 text-step text-ink-3">Answered in the conversation.</p>
        </ChatDisclosure>
      );
    case EntryKind.Morning:
      return (
        <MorningCard
          key={entry.id}
          runId={entry.runId}
          rounds={entry.rounds}
          summary={entry.summary}
          landingLine={entry.landingLine}
          learned={entry.learned}
          stoppedBecause={entry.stoppedBecause}
          pausedOn={entry.pausedOn}
          kept={entry.kept}
          undone={entry.undone}
          landed={entry.landed}
          // A run the plan limit cut off is paused, not finished: the card says so and
          // offers Resume itself, instead of leaving it to a grey line underneath.
          paused={!entry.superseded && resumable(entry.runId, context)}
          handedOff={entry.handedOff}
          project={entry.project ?? context.project}
          commit={entry.commit}
          before={entry.before}
          after={entry.after}
          {...(entry.assets ? { assets: entry.assets } : {})}
          onShowLive={context.onShowLive}
          onOpenAssets={context.onShowAssets}
          onOpenStudio={context.onOpenStudio}
          onNotice={onNotice}
          {...(entry.runId ? { onResume: resume(entry.runId) } : {})}
        />
      );
    case EntryKind.Action:
      return <ActionEntry entry={entry} context={context} resume={resume} />;
    case EntryKind.Compaction:
      return <CompactionEntry messages={entry.messages} summary={entry.summary} />;
    default:
      return null;
  }
});

/** A finished compaction, in the work rows' type: it opens to the summary that replaced the messages. */
function CompactionEntry({ messages, summary }: { messages: number | null; summary: string | null }): JSX.Element {
  const label = compactedWords(messages);
  if (!summary)
    return (
      <p data-compaction className="flex min-h-[30px] items-center text-chat text-ink-3">
        {label}
      </p>
    );
  return (
    <ChatDisclosure data-compaction label={label} frame={false}>
      <div data-compaction-summary className="chat-compaction-summary">
        <Markdown text={summary} />
      </div>
    </ChatDisclosure>
  );
}

/** A reply: its Markdown, and Run and Copy under a one-line shell command it offers in a game's chat. */
function AssistantEntry({
  entry,
  commands,
}: {
  entry: { id: string; text: string };
  commands: TranscriptContext["commands"];
}) {
  const threadId = commands?.threadId;
  const project = commands?.project;
  const renderCommand = useCallback(
    (command: string) =>
      threadId && project ? (
        <CommandRun command={command} threadId={threadId} project={project} entryId={entry.id} />
      ) : null,
    [threadId, project, entry.id],
  );
  return (
    <div className="flex flex-col gap-1">
      <Markdown text={entry.text} {...(commands ? { renderCommand } : {})} />
    </div>
  );
}

/** A message the user sent, with the pictures sent with it. */
function UserEntry({
  entry,
  context,
}: {
  entry: { id: string; text: string; about?: string };
  context: TranscriptContext;
}) {
  const images = context.images.get(entry.id);
  const pictures =
    context.threadId && images
      ? { threadId: context.threadId, imagesOf: images.messageId, imageCount: images.count }
      : {};
  const { onRewind } = context;
  const rewind = onRewind && context.canRewind?.(entry.id) ? { rewindId: entry.id, onRewind } : {};
  return <UserMessage text={entry.text} {...pictures} {...(entry.about ? { about: entry.about } : {})} {...rewind} />;
}

/** The harness's system tags; UPDATE lines carry no heading. */
const SystemTag = {
  Error: "ERROR",
  Update: "UPDATE",
} as const;
/** How a turn the user stopped is recorded. */
const CANCELLED_TEXT = "cancelled";

/** A system tag as a heading: an error in plain words, any other tag in sentence case. */
const systemHeading = (tag: string): string =>
  tag === SystemTag.Error ? "Something went wrong" : tag.charAt(0) + tag.slice(1).toLowerCase();

/** A system line: its tag as a heading (an error in plain words), then its text. */
function SystemEntry({ entry }: { entry: Extract<Entry, { kind: typeof EntryKind.System }> }) {
  // A turn the user stopped reads as stopped, not as a failure.
  const stopped = entry.tag === SystemTag.Error && entry.text === CANCELLED_TEXT;
  const tag = entry.tag;
  const showsHeading = tag && tag !== SystemTag.Update && !stopped;
  return (
    <div className="flex min-w-0 flex-col gap-1 text-chat-sub leading-relaxed text-ink-2">
      {showsHeading && <span className="text-[12px] font-medium text-ink-3">{systemHeading(tag)}</span>}
      <span>{stopped ? "Stopped" : <FileText text={entry.text} />}</span>
    </div>
  );
}

function ConsentOutcome({ entry }: { entry: Extract<Entry, { kind: typeof EntryKind.Action }> }): JSX.Element {
  return (
    <div className="text-chat text-ink-2">
      <p>{entry.consentPrompt || consentRequestedWords(entry.consentSource)}</p>
      {entry.consentExport && <ExportReview review={entry.consentExport} />}
      <p className="mt-1 text-chat-sub text-ink-3">{entry.outcome}</p>
      <details className="group/request mt-1">
        <summary className="chat-disclosure">
          Request details
          <Icon name="chevron-right" size={14} className="chat-chevron group-open/request:rotate-90" />
        </summary>
        <p className="mt-1 text-chat-sub text-ink-3 [overflow-wrap:anywhere]">
          <FileText text={entry.text} />
        </p>
      </details>
    </div>
  );
}

function ActionEntry({
  entry,
  context,
  resume,
}: {
  entry: Extract<Entry, { kind: typeof EntryKind.Action }>;
  context: TranscriptContext;
  resume: (runId: string) => () => void;
}): JSX.Element {
  const { activeRunId } = context;
  if (entry.action === EntryAction.Permission && entry.permission)
    return <PermissionOutcome event={entry.permission} />;
  if (entry.action === EntryAction.Consent) return <ConsentOutcome entry={entry} />;
  if (entry.action === EntryAction.Steer) {
    const held = entry.pending && entry.runId === activeRunId && (entry.expiresAt ?? 0) > Date.now();
    return held ? (
      <ChatQuestion
        title="Review the build plan"
        choices={[
          { id: "approve", label: "Approve plan" },
          { id: "revise", label: "Make changes" },
        ]}
        onConfirm={async (choice) => {
          if (choice === "approve") await context.onApprovePlan();
          else context.onRevisePlan();
        }}
      >
        <Markdown text={entry.text} />
      </ChatQuestion>
    ) : (
      <ChatDisclosure label="Build plan">
        <div className="px-3 py-2">
          <Markdown text={entry.text} />
        </div>
      </ChatDisclosure>
    );
  }
  if (entry.action === EntryAction.Live) {
    return (
      <div data-build-updated className="flex min-w-0 items-center gap-3 text-chat text-ink-3">
        <span>Build updated</span>
        <ResultButton onClick={() => context.onShowLive?.()}>See it</ResultButton>
      </div>
    );
  }
  if (entry.action === EntryAction.Resume) {
    return (
      <div key={entry.id} className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-chat text-ink-3">
        <span>
          <FileText text={entry.text} />
        </span>
        {resumable(entry.runId, context) ? (
          <ResultButton type="button" data-run-resume={entry.runId} onClick={resume(entry.runId)}>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
            Resume
          </ResultButton>
        ) : null}
      </div>
    );
  }
  const snapshotId = entry.snapshotId;
  return (
    <div key={entry.id} className="flex min-w-0 flex-col gap-1 text-chat-sub leading-relaxed text-ink-2">
      <span className="text-[12px] font-medium text-ink-3">{entry.tag}</span>
      <span className="min-w-0">
        <FileText text={entry.text} />
        {entry.action === EntryAction.Rewind && snapshotId ? (
          <ResultButton
            type="button"
            title="Roll the studio back to the moment before this change"
            onClick={() => void window.studio.rollback(snapshotId).catch(() => {})}
            className="ml-2 align-middle"
          >
            Rewind
          </ResultButton>
        ) : null}
      </span>
    </div>
  );
}
