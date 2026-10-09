/**
 * The Publish dialog's record of a game on Genex: re-read on open and on a timer that quickens
 * while an attempt runs, the one press under way, and the files Publish uploads, listed on request.
 * One Publish press lists the files (or reuses a fresh list) and publishes exactly those.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { GenexAction, GenexPublishStatusOperation, type GenexPublishState } from "../../../../shared/genex.ts";
import type { ExportReview, PluginInfo } from "../../../../shared/plugins.ts";
import { type PluginReviewRequest, runPluginAction } from "../../../plugin-actions.ts";
import { publishView } from "./genex-publish-view.ts";

/** How often the dialog re-reads the record while an attempt runs, and otherwise. */
const RUNNING_POLL_MS = 2 * SECOND_MS;
const IDLE_POLL_MS = 10 * SECOND_MS;
/** A file list this recent is what Publish uploads; an older one is listed again first. */
const FILES_FRESH_MS = 60 * SECOND_MS;

/** A cancelled review or approval is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** What is being pressed right now: Publish (listing files, then starting the upload), or another action. */
export const Pressing = { None: "none", Publish: "publish", Files: "files", Action: "action" } as const;
export type Pressing = (typeof Pressing)[keyof typeof Pressing];

/** The game's publish record, the press under way and the files Publish uploads. */
export function usePublishRecord(plugin: PluginInfo, project: string | null) {
  const [state, setState] = useState<GenexPublishState | null>(null);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [review, setReview] = useState<PluginReviewRequest | null>(null);
  const [pressing, setPressing] = useState<Pressing>(Pressing.None);
  const [files, setFiles] = useState<ExportReview | null>(null);
  const listedAt = useRef(0);
  const id = plugin.manifest.id;
  const game = project ?? "";
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const args = { operation: GenexPublishStatusOperation.Status };
      setState(
        (await window.studio.pluginAction(
          id,
          GenexAction.PublishStatus,
          args,
          project ?? undefined,
        )) as GenexPublishState,
      );
      setReadError("");
    } catch (e) {
      setReadError(words(e));
    }
  }, [id, project]);
  // A Publish press shows its first steps (preparing the copy) while the press itself still runs.
  const busy = (state ? publishView(state).running : false) || pressing === Pressing.Publish;
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), busy ? RUNNING_POLL_MS : IDLE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, busy]);
  const run = async (press: Pressing, step: () => Promise<unknown>): Promise<void> => {
    setError("");
    setPressing(press);
    try {
      await step();
    } catch (e) {
      if (!CANCELLED.test(words(e))) setError(words(e));
    } finally {
      setPressing(Pressing.None);
      await refresh();
    }
  };
  /** The files Publish would upload now, listed again unless the shown list is fresh. */
  const currentFiles = async (): Promise<ExportReview> => {
    if (files && Date.now() - listedAt.current < FILES_FRESH_MS) return files;
    const listed = await window.studio.genexPublishReview(game);
    listedAt.current = Date.now();
    setFiles(listed);
    return listed;
  };
  return {
    state,
    error,
    readError,
    review,
    closeReview: () => setReview(null),
    pressing,
    files,
    refresh,
    act: (name: string, args: Record<string, unknown> = {}): Promise<void> =>
      run(Pressing.Action, () => runPluginAction({ plugin, name, args, project, review: setReview })),
    listFiles: (): Promise<void> => run(Pressing.Files, currentFiles),
    /** Publish under `title`: the press is the consent to exactly the listed files. */
    publish: (title: string): Promise<void> =>
      run(Pressing.Publish, async () => window.studio.genexPublish(game, await currentFiles(), title)),
  };
}
