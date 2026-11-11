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
import { type PublishButton, publishView } from "./genex-publish-view.ts";

/** How often the dialog re-reads the record while an attempt runs, and otherwise. */
const RUNNING_POLL_MS = 2 * SECOND_MS;
const IDLE_POLL_MS = 10 * SECOND_MS;
/** A file list this recent is what Publish uploads; an older one is listed again first. */
const FILES_FRESH_MS = 60 * SECOND_MS;

/** A cancelled review or approval is the person's choice, not an error to show. */
const CANCELLED = /Cancelled/;
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The game's publish record as the plugin keeps it now. */
export async function readPublishState(pluginId: string, project?: string): Promise<GenexPublishState> {
  const args = { operation: GenexPublishStatusOperation.Status };
  const state = await window.studio.pluginAction(pluginId, GenexAction.PublishStatus, args, project);
  return state as GenexPublishState;
}

/** What is being pressed right now: Publish (listing files, then starting the upload), a rename, or another action. */
export const Pressing = { None: "none", Publish: "publish", Files: "files", Action: "action", Name: "name" } as const;
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
      setState(await readPublishState(id, project ?? undefined));
      setReadError("");
    } catch (e) {
      setReadError(words(e));
    }
  }, [id, project]);
  // A Publish press shows its first steps (preparing the copy) while the press itself still runs,
  // and the game's apps going behind its web build are followed as closely as the build.
  const sendingApps = state?.native?.sending === true;
  const busy = (state ? publishView(state).running : false) || sendingApps || pressing === Pressing.Publish;
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
    /**
     * Move the game to a new link: answers why Genex refused, for the line under the link's field,
     * or null once it moved. The record is read again either way.
     */
    changeLink: async (link: string): Promise<string | null> => {
      setPressing(Pressing.Name);
      try {
        await runPluginAction({ plugin, name: GenexAction.PublishLink, args: { link }, project, review: setReview });
        return null;
      } catch (e) {
        return words(e);
      } finally {
        setPressing(Pressing.None);
        await refresh();
      }
    },
    /**
     * Save the game's new name: on Genex at once when the game is there, else for its first publish.
     * Answers whether it was saved; a refusal is the record's error line.
     */
    rename: async (title: string): Promise<boolean> => {
      let saved = false;
      await run(Pressing.Name, async () => {
        await runPluginAction({ plugin, name: GenexAction.PublishName, args: { title }, project, review: setReview });
        saved = true;
      });
      return saved;
    },
    /**
     * Publish under `title`: the press is the consent to exactly the listed files, to the game's
     * project when `remix` (Allow remixing) is ticked, and to the web build taking the place of a page
     * that shows only the game's apps when `replaceNativePage` (the dialog said so above the press).
     */
    publish: (title: string, remix?: boolean, replaceNativePage?: boolean, platforms?: string[]): Promise<void> =>
      run(Pressing.Publish, async () =>
        window.studio.genexPublish(game, await currentFiles(), title, remix, replaceNativePage, platforms),
      ),
    /**
     * Publish a game's apps on their own under `title`: the press is the consent to the apps its rows
     * name, or only the `platforms` the Publish card's press names, and to the apps Genex Cloud
     * built or builds for the platforms `release` names.
     */
    publishApps: (title: string, remix?: boolean, platforms?: string[], release?: string[]): Promise<void> =>
      run(Pressing.Publish, () => window.studio.genexPublishApps(game, title, remix, platforms, release)),
    /** Ask Genex Cloud to build the game's `platform` app and keep it for a publish; a refusal is the record's error line. */
    buildOnCloud: (platform: string): Promise<void> =>
      run(Pressing.Action, () => window.studio.genexCloudBuild(game, platform, true)),
    /**
     * Publish again while Studio cannot tell whether the last upload reached Genex: settle that
     * upload (`again` names it), then publish under `title` as Publish does.
     */
    publishAgain: (again: PublishButton, title: string): Promise<void> =>
      run(Pressing.Publish, async () => {
        await runPluginAction({ plugin, name: again.action, args: again.args ?? {}, project, review: setReview });
        await window.studio.genexPublish(game, await currentFiles(), title);
      }),
  };
}
