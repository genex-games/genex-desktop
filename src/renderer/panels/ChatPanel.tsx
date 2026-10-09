/**
 * Chat — user story 1 & 2. One thread at a time: the transcript is the active thread's slice of
 * the event log, never local state; consecutive tool calls group into a ToolChips block, the
 * composer is the PromptBar, and the busy line is the shimmering LoadingState.
 *
 * The panel's hooks are wired in `chat/use-chat-panel.ts`: the open thread (`use-chat-thread.ts`),
 * its composer (`use-chat-composer.ts`), its work (`use-chat-work.ts`) and sending
 * (`use-submit.ts` over `send-route.ts`). What the chat shows is derived in `chat/transcript.ts`;
 * the header is drawn by `chat/ChatPanelHeader.tsx`, the conversation by `chat/ChatConversation.tsx`
 * and the cards above the composer by `chat/ComposerDock.tsx`. This file lays them out and draws
 * the composer.
 */
import type { JSX, RefObject } from "react";
import { RunState } from "../../shared/run-state.ts";
import { EntryKind } from "../chat-entries.ts";
import { ChatFilesScope, useChatFilesRecheck } from "../chat-files.ts";
import type { ChatPanelProps } from "../chat/chat-panel-props.ts";
import { ChatConversation } from "../chat/ChatConversation.tsx";
import { ChatPanelHeader } from "../chat/ChatPanelHeader.tsx";
import { answerConsent, answerPermission, planPrompt } from "../chat/composer-cards.ts";
import { ComposerDock } from "../chat/ComposerDock.tsx";
import { stepsOffer } from "../chat/engine-steps.ts";
import { EngineStepsCard } from "../chat/EngineStepsCard.tsx";
import { RewindDialog } from "../chat/RewindDialog.tsx";
import { type ChatParts, useChatPanel } from "../chat/use-chat-panel.ts";
import { chatPlaceholder } from "../composer-placeholder.ts";
import { loopAvailableFor } from "../loop-setting.ts";
import { Pending } from "../ui/Pending.tsx";
import { LoadFailed } from "../ui/LoadFailed.tsx";
import { PromptBar, type PromptBarHandle } from "../ui/PromptBar.tsx";
import { unrealLoopGate, unrealRewindNote } from "../unreal-game.ts";

export function ChatPanel(props: ChatPanelProps): JSX.Element {
  const { loading } = props;
  const { parts, composerRef, chatExport } = useChatPanel(props);
  const { chat, rewind } = parts;
  useChatFilesRecheck(chat.threadId ?? null, chat.threadEvents.length);
  return (
    // Every file name this chat shows is asked about in this chat (renderer/chat-files.ts).
    <ChatFilesScope.Provider value={chat.threadId ?? null}>
      <div
        data-studio-chat={chat.isStudioThread || undefined}
        className={`${chat.isStudioThread ? "studio-view" : ""} column flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-r border-line bg-page`}
      >
        <ChatPanelHeader {...parts} chatExport={chatExport} />
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div
            className="flex min-h-0 flex-1 flex-col"
            inert={loading}
            style={{ visibility: loading ? "hidden" : "visible" }}
          >
            <ChatConversation {...parts} />
            <ChatComposer {...parts} composerRef={composerRef} />
          </div>
          {loading && (
            <div className="absolute inset-0 bg-page">
              {props.loadError ? (
                <LoadFailed what="this chat" error={props.loadError} onRetry={props.onRetryLoad} />
              ) : (
                <Pending label="Loading conversation…" className="p-4 text-sm" />
              )}
            </div>
          )}
          {rewind.target && (
            <RewindDialog
              key={rewind.target.eventId}
              {...rewind.target}
              engineNote={unrealRewindNote(chat.folder)}
              returnFocus={rewind.returnFocus}
              onRewound={(result) => rewind.target && rewind.rewound(rewind.target, result)}
              onDismiss={rewind.dismiss}
            />
          )}
        </div>
      </div>
    </ChatFilesScope.Provider>
  );
}

/** The composer and the cards docked above it: sign-in, questions, the plan and consents. */
function ChatComposer(parts: ChatParts & { composerRef: RefObject<PromptBarHandle | null> }): JSX.Element {
  const { chat, composer, work, submit, composerRef, focusComposer, reply } = parts;
  const { threadId, transcript, working, run } = chat;
  const { drafts, gate, model, compact } = composer;
  const { plan } = work;
  const busy = drafts.busy;
  const { about } = reply;
  // A summary written mid-turn or mid-build would miss what is happening.
  const compactWaits = busy || working || chat.answering || run?.state === RunState.Running;
  return (
    <ComposerDock
      {...(threadId ? { conversationKey: threadId } : {})}
      loading={parts.props.loading}
      connectModel={chat.isStudioThread && !gate.needsSignIn && composer.noModel}
      signIn={gate.card}
      questions={transcript.interviewQuestions.filter((entry) => entry.kind === EntryKind.Question)}
      questionsDisabled={busy || working}
      onAnswerQuestion={(answer) => submit(answer, undefined, true)}
      onChatAbout={() => requestAnimationFrame(focusComposer)}
      plan={planPrompt(parts, composerRef)}
      consents={transcript.pendingConsents.filter((entry) => entry.kind === EntryKind.Action)}
      onConsent={answerConsent}
      permissions={transcript.pendingPermissions.filter((entry) => entry.kind === EntryKind.Action)}
      onPermission={answerPermission}
      planModes={composer.permissions.planModes}
      steps={
        chat.isStudioThread ? null : (
          <EngineStepsCard offer={stepsOffer(chat.threadEvents)} onNotice={parts.props.onNotice} />
        )
      }
    >
      <PromptBar
        ref={composerRef}
        project={chat.meta.project}
        loopAvailable={loopAvailableFor(chat.folder)}
        loopGate={unrealLoopGate(chat.folder)}
        conversationKey={threadId}
        build={composer.build}
        about={
          about
            ? { label: about.label, placeholder: about.placeholder, onClear: () => reply.drop(about.threadId) }
            : null
        }
        activityLabel={work.activity.label}
        gameMode={!chat.isStudioThread}
        contextUsage={composer.contextUsage}
        onCompact={compact.compactNow}
        compacting={compact.compacting}
        compactBusy={compactWaits}
        // A finished or paused run is not a run in progress: leaving this true kept the
        // composer saying "Building" for the rest of the chat's life, and took the hours control
        // switch away with no way back.
        coordinating={run?.state === RunState.Running}
        leadListens={chat.leadListens}
        placeholder={chatPlaceholder({
          revisingPlan: plan.revising,
          studio: chat.isStudioThread,
          // A game still waiting for its idea asks for one, as home does.
          draft: chat.isDraft || chat.folder?.provisional === true,
        })}
        value={drafts.draft}
        onChange={drafts.setDraft}
        model={model.bar}
        permissions={composer.permissions.bar}
        busy={busy}
        // A game chat with no model keeps its prompt: Connect AI model takes the model's place.
        disabled={composer.noModel && chat.isStudioThread}
        onSend={submit}
        stoppable={work.stoppable && Boolean(parts.props.activeThread)}
        onStop={work.stop.requestStop}
        blockSend={gate.needsSignIn}
        onBlockedSend={() => void gate.signIn()}
      />
    </ComposerDock>
  );
}
