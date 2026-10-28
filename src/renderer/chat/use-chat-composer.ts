import { useMemo, useState } from "react";
import { measuredContext } from "../../shared/context.ts";
import type { ComposerBuild } from "../loop-setting.ts";
import { parseModelKey } from "../model-key.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import { problemWords } from "../words.ts";
import type { ChatPanelProps } from "./chat-panel-props.ts";
import { useComposerModel } from "./use-composer-model.ts";
import { usePermissionMode } from "./use-permission-mode.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import { useSignInGate } from "./use-sign-in-gate.ts";
import { runLoopSetting } from "./transcript.ts";
import { useThreadDrafts } from "./use-thread-drafts.ts";
import { errorCode } from "../../shared/errors.ts";

/** Compact the chat's context on the model it runs on; a failure is toasted. */
function useCompact(threadId: string | undefined, selected: string | null, onNotice: Notify) {
  const [compacting, setCompacting] = useState(false);
  const compactNow = async (): Promise<void> => {
    if (!threadId || compacting) return;
    const { engine, model } = parseModelKey(selected);
    setCompacting(true);
    try {
      await window.studio.compactThread(threadId, { ...(engine ? { engine } : {}), ...(model ? { model } : {}) });
    } catch (err) {
      onNotice(problemWords(err), ToastTone.Error, errorCode(err));
    } finally {
      setCompacting(false);
    }
  };
  return { compacting, compactNow: () => void compactNow() };
}

/**
 * The composer's side of the chat: its model and sign-in gate, its draft and in-flight send, and
 * what a send carries (the context gauge, compaction).
 */
export function useChatComposer(props: ChatPanelProps, chat: ChatThread) {
  const { engines, onEnginesRefresh, onSend, onNotice } = props;
  const drafts = useThreadDrafts(chat.threadId);
  const model = useComposerModel({
    thread: props.activeThread ? { id: props.activeThread.id, meta: chat.meta } : null,
    engines,
    onEnginesRefresh,
  });
  const { choices, selected, selectedEngine, setModelKey } = model;
  const gate = useSignInGate({
    engines,
    selected,
    selectedEngine,
    threadEvents: chat.threadEvents,
    onEnginesRefresh,
    setModelKey,
    onSend,
  });
  const contextUsage = useMemo(() => {
    const { engine, model: modelId } = parseModelKey(selected);
    const catalogModel = selectedEngine?.models.find((entry) => entry.id === (modelId || "default"));
    return measuredContext(chat.threadEvents, engine, modelId, catalogModel?.resolvedModel);
  }, [chat.threadEvents, selected, selectedEngine]);
  // The chat's permission mode on its engine: the pill after Mode, and what a plan card may continue in.
  const permissions = usePermissionMode({
    threadId: chat.threadId,
    studio: chat.isStudioThread,
    recorded: chat.meta.permissionMode,
    selected,
    onNotice,
  });
  const { run, threadEvents } = chat;
  const build = useMemo<ComposerBuild | null>(
    () => (run ? { state: run.state, loop: runLoopSetting(threadEvents, run.runId) } : null),
    [run, threadEvents],
  );
  return {
    drafts,
    model,
    permissions,
    gate,
    contextUsage,
    /** The chat's build as Mode reads it: its state and the Loop its start record kept. */
    build,
    // Unavailable choices still need an operable model menu and sign-in recovery.
    noModel: choices.length === 0,
    compact: useCompact(chat.threadId, selected, onNotice),
  };
}

/** The composer's state as the panel's hooks and parts read it. */
export type ChatComposerState = ReturnType<typeof useChatComposer>;
