/**
 * The chat's permission mode, as the composer's pill shows and changes it: the chat's own, else the
 * one new chats start in. Every engine offers it, each with the modes its session honours
 * (`permissionModesFor`); the pill shows the mode the engine runs in, which is the chat's own where
 * the engine honours it, else Auto. The host keeps the choice (thread metadata and the permission
 * store), and the pill shows a pick at once.
 */
import { useEffect, useState } from "react";
import {
  DEFAULT_PERMISSION_MODE,
  engineMode,
  isPermissionMode,
  ModeSwitchFailure,
  PermissionMode,
  planContinuations,
} from "../../shared/permissions.ts";
import { runsClaudeCode } from "../../shared/providers.ts";
import { parseModelKey } from "../model-key.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import type { ComposerPermissions } from "../ui/PromptBar.tsx";
import { usePermissionSettings } from "../use-permission-settings.ts";
import { problemWords } from "../words.ts";
import { ModeVia } from "../analytics/chat-vocabulary.ts";
import { track } from "../analytics/client.ts";
import { AnalyticsEvent } from "../analytics/events.ts";
import { errorCode, errorCodeIn } from "../../shared/errors.ts";

export interface ChatPermissionMode {
  /** The composer's pill, or null in Studio's own chat. */
  bar: ComposerPermissions | null;
  /** The modes the plan card offers to continue in: the engine's, without Auto where its model cannot use it. */
  planModes: PermissionMode[];
}

/** The modes a plan approval may continue in on this engine and model. */
export function planModesFor(engine: string, autoUnavailable: boolean): PermissionMode[] {
  return planContinuations(engine).filter((mode) => !autoUnavailable || mode !== PermissionMode.Auto);
}

/**
 * The mode a chat's pill shows on its engine: a pick still on its way to the host, else the mode the
 * chat's record keeps, else the one new chats start in.
 */
export function shownPermissionMode(input: {
  engine: string;
  picked: PermissionMode | undefined;
  /** The mode the thread's metadata records. */
  recorded: unknown;
  defaultMode: PermissionMode | undefined;
}): PermissionMode {
  const recorded = isPermissionMode(input.recorded) ? input.recorded : undefined;
  return engineMode(input.engine, input.picked ?? recorded ?? input.defaultMode ?? DEFAULT_PERMISSION_MODE);
}

export function usePermissionMode(input: {
  threadId: string | undefined;
  studio: boolean;
  /** The mode the thread's metadata records. */
  recorded: unknown;
  /** The composer's model key (`engine::model`). */
  selected: string | null;
  onNotice: Notify;
}): ChatPermissionMode {
  const { threadId, studio, recorded, selected, onNotice } = input;
  const { settings, setSettings } = usePermissionSettings();
  const [pick, setPick] = useState<{ thread?: string; mode: PermissionMode } | null>(null);
  // The host's word replaces the pick as soon as it arrives (an approved plan changes the mode too).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the pick is dropped when the recorded mode or the chat changes
  useEffect(() => setPick(null), [recorded, threadId]);
  const { engine, model } = parseModelKey(selected);
  // Auto's gate is Claude Code's: another engine's model of the same name says nothing about it.
  const autoUnavailable = runsClaudeCode(engine) && Boolean(settings?.autoUnavailable.includes(model));
  const planModes = planModesFor(engine, autoUnavailable);
  if (studio) return { bar: null, planModes };
  const picked = pick?.thread === threadId ? pick?.mode : undefined;
  const mode = shownPermissionMode({ engine, picked, recorded, defaultMode: settings?.defaultMode });
  const onMode = (next: PermissionMode): void => {
    setPick({ thread: threadId, mode: next });
    // Why a switch failed is its error's code, when the session gave one.
    const changed = (failed: boolean, error?: unknown): void =>
      track(AnalyticsEvent.PermissionModeChanged, {
        from: mode,
        to: next,
        via: ModeVia.Composer,
        failed,
        ...(failed ? { code: errorCodeIn(ModeSwitchFailure, error) } : {}),
      });
    void window.studio
      .setPermissionMode(threadId ?? null, next)
      .then((settings) => {
        setSettings(settings);
        changed(false);
      })
      .catch((error) => {
        setPick(null);
        changed(true, error);
        onNotice(problemWords(error), ToastTone.Error, errorCode(error));
      });
  };
  return { bar: { mode, onMode, autoUnavailable, engine }, planModes };
}
