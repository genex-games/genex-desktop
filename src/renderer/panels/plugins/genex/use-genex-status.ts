/**
 * The Genex page's live status: the plugin's own `status` action, read on open, on focus, when
 * the plugin or its connections change, and on a timer that quickens while a sign-in or a
 * generation is under way. Actions run through the shared review → ticket → approval sequence.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GenexAction, type GenexStatus } from "../../../../shared/genex.ts";
import { t } from "../../../../shared/i18n.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { UiEvent } from "../../../../shared/ui-events.ts";
import { type PluginReviewRequest, runPluginAction } from "../../../plugin-actions.ts";
import { genexPollMs, isGenexStatus, type PageAttention } from "./genex-view.ts";

/** Why an answer is not a status. */
const MESSAGE = { unreadable: t("Genex answered with something Studio can’t read.") } as const;

/** A cancelled review or approval is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;

/**
 * The plugin's status and the one action that may run at a time. While `reading` is false (the
 * plugin is off) it reads nothing and holds no status, so turning it on starts from a fresh read.
 */
export function useGenexStatus(plugin: PluginInfo, project: string | null | undefined, reading = true) {
  const id = plugin.manifest.id;
  const [status, setStatus] = useState<GenexStatus | null>(null);
  // A failed read clears on the next good read; a failed action stays until the next action, so
  // re-reading the status after it never hides why it failed.
  const [readError, setReadError] = useState("");
  const [actionError, setActionError] = useState("");
  const [running, setRunning] = useState<string | null>(null);
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  const latest = useRef(0);
  // Declarations are looked up on the plugin as it is now.
  const pluginRef = useRef(plugin);
  pluginRef.current = plugin;

  const refresh = useCallback(async (): Promise<void> => {
    const request = ++latest.current;
    try {
      const next = await window.studio.pluginAction(id, GenexAction.Status, {}, project ?? undefined);
      if (request !== latest.current) return;
      if (!isGenexStatus(next)) throw new Error(MESSAGE.unreadable);
      setStatus(next);
      setReadError("");
    } catch (e) {
      if (request === latest.current) setReadError(e instanceof Error ? e.message : String(e));
    }
  }, [id, project]);

  const act = useCallback(
    async (name: string, args: Record<string, unknown> = {}): Promise<void> => {
      setRunning(name);
      setActionError("");
      try {
        await runPluginAction({ plugin: pluginRef.current, name, args, project, review: setReview });
      } catch (e) {
        const words = e instanceof Error ? e.message : String(e);
        if (!CANCELLED.test(words)) setActionError(words);
      } finally {
        setRunning(null);
        await refresh();
      }
    },
    [project, refresh],
  );

  useEffect(() => {
    if (!reading) {
      latest.current++;
      setStatus(null);
      setReadError("");
      setActionError("");
      return;
    }
    void refresh();
    const again = (): void => void refresh();
    const shown = (): void => {
      if (!document.hidden) again();
    };
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", shown);
    const unsubscribe = window.studio.onEvent((event) => {
      const own = event.type === UiEvent.PluginsChanged && event.payload?.id === id;
      if (own || event.type === UiEvent.ConnectionsChanged) again();
    });
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", shown);
      unsubscribe();
    };
  }, [id, refresh, reading]);

  const attention = usePageAttention();
  const pollMs = genexPollMs(status, attention);
  useEffect(() => {
    if (!reading || pollMs === null) return;
    const timer = window.setInterval(() => void refresh(), pollMs);
    return () => window.clearInterval(timer);
  }, [pollMs, refresh, reading]);

  const error = actionError || readError;
  return { status, error, running, act, refresh, review, closeReview: () => setReview(null) };
}

const readAttention = (): PageAttention => ({ hidden: document.hidden, focused: document.hasFocus() });

/** Whether the window can be seen and is in front, kept current as the person moves between apps. */
function usePageAttention(): PageAttention {
  const [attention, setAttention] = useState(readAttention);
  useEffect(() => {
    const update = (): void =>
      setAttention((current) => {
        const next = readAttention();
        return next.hidden === current.hidden && next.focused === current.focused ? current : next;
      });
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return attention;
}

/** What the Genex page's parts share from the live status. */
export type GenexLive = ReturnType<typeof useGenexStatus>;
