/**
 * The Publish dialog's share of the game's assets: where its files stand with the library and what
 * they were made from (read as the dialog opens), the switch (off by default), the first few
 * pictures, and the share itself, run once when the game goes live with the switch on.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type GameLibraryStates, shareInBatches } from "../../../../shared/asset-library.ts";
import { GenexAccountStatus } from "../../../../shared/genex-account.ts";
import type { ProjectAsset } from "../../../../shared/game-assets.ts";
import { usePeople } from "../../../state/hooks.ts";
import { useAsyncEffect } from "../../../use-async-effect.ts";
import {
  allMissed,
  CelebrationStep,
  celebrationStep,
  closedBeforeShare,
  NO_SHARES,
  retryItems,
  type ShareTally,
  shareItems,
  shareLineShown,
  shareThumbs,
  tallyShares,
} from "./publish-share.ts";

/** Games whose Publish closed with the switch on before the share ran (this launch). */
const closedUnshared = new Set<string>();

/** Where the share stands: not run, under way, or answered. */
export const ShareRun = { Idle: "idle", Sharing: "sharing", Done: "done" } as const;
export type ShareRun = (typeof ShareRun)[keyof typeof ShareRun];

/** A picture of an asset to share: the library's thumbnail, or null for its kind's glyph. */
export interface ShareThumbView {
  file: string;
  url: string | null;
  kind: ReturnType<typeof shareThumbs>[number]["kind"];
}

/** The game's files and their library states, read again when the account signs in or a share ends. */
function useShareSources(project: string, signedIn: boolean, again: number) {
  const [states, setStates] = useState<GameLibraryStates | null>(null);
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  useAsyncEffect(
    (alive) => {
      if (!signedIn || !project) return undefined;
      void Promise.all([window.studio.assetLibraryStates(project), window.studio.projectAssets(project)]).then(
        ([read, files]) => {
          if (!alive()) return;
          setStates(read);
          setAssets(files.assets);
        },
        () => {
          // The line stays hidden: Publish works the same without it.
        },
      );
      return undefined;
    },
    [project, signedIn, again],
  );
  return { states, assets };
}

/** The pictures of the first few files to share, read from the library by their generations. */
function useShareThumbs(states: GameLibraryStates | null, assets: readonly ProjectAsset[]): ShareThumbView[] {
  const thumbs = useMemo(() => shareThumbs(states, assets), [states, assets]);
  const [urls, setUrls] = useState<Record<string, string | null>>({});
  const ids = thumbs.flatMap((thumb) => (thumb.generationId ? [thumb.generationId] : []));
  useAsyncEffect(
    (alive) => {
      if (ids.length === 0) return undefined;
      void window.studio.assetLibrary({ ids }).then(
        (page) => alive() && setUrls(Object.fromEntries(page.assets.map((asset) => [asset.id, asset.thumbnailUrl]))),
        () => {
          // Each picture stays its kind's glyph.
        },
      );
      return undefined;
    },
    [ids.join(",")],
  );
  return thumbs.map((thumb) => ({
    file: thumb.file,
    kind: thumb.kind,
    url: thumb.generationId ? (urls[thumb.generationId] ?? null) : null,
  }));
}

/** The share line's state and presses for `project`. */
export function usePublishShare(project: string) {
  const signedIn = usePeople((s) => s.account === GenexAccountStatus.SignedIn);
  const [again, setAgain] = useState(0);
  const { states, assets } = useShareSources(project, signedIn, again);
  const items = useMemo(() => shareItems(states, assets), [states, assets]);
  const thumbs = useShareThumbs(states, assets);
  const [on, setOn] = useState(false);
  const [run, setRun] = useState<ShareRun>(ShareRun.Idle);
  const [tally, setTally] = useState<ShareTally>(NO_SHARES);
  const started = useRef(false);
  // Publish closed with the switch on before the share ran: say so, never drop it silently.
  const [unsharedBefore, setUnsharedBefore] = useState(() => closedUnshared.has(project));
  const leaving = useRef({ on, count: items.length });
  leaving.current = { on, count: items.length };
  useEffect(
    () => () => {
      const { on: wanted, count } = leaving.current;
      if (closedBeforeShare(wanted, started.current, count)) closedUnshared.add(project);
    },
    [project],
  );

  const send = useCallback(
    async (batch: typeof items, before: ShareTally): Promise<void> => {
      closedUnshared.delete(project);
      setUnsharedBefore(false);
      started.current = true;
      setRun(ShareRun.Sharing);
      try {
        setTally(tallyShares(await shareInBatches((run) => window.studio.assetShare(project, run), batch), before));
      } catch {
        setTally(allMissed(batch, before));
      }
      setRun(ShareRun.Done);
      setAgain((count) => count + 1);
    },
    [project],
  );
  /** Share once, as the game goes live with the switch on. */
  const start = useCallback(() => {
    if (started.current || !on || items.length === 0) return;
    started.current = true;
    void send(items, NO_SHARES);
  }, [on, items, send]);
  /** Ready for the next publish: the line offers the switch again for what is still not on Play. */
  const reset = useCallback(() => {
    started.current = false;
    setRun(ShareRun.Idle);
    setTally(NO_SHARES);
  }, []);
  const retry = () => void send(retryItems(items, tally), tally);
  const shareNow = () => void send(items, NO_SHARES);
  const shown = shareLineShown(signedIn, states);
  const missedBefore = unsharedBefore && shown && run === ShareRun.Idle;
  return { shown, count: items.length, thumbs, on, setOn, run, tally, start, reset, retry, shareNow, missedBefore };
}

export type PublishShare = ReturnType<typeof usePublishShare>;

/**
 * The share for `project`, run once as the game goes live (`celebrate`, the dialog's own success)
 * with the switch on; a new publish offers the switch again.
 */
export function useShareWhenLive(project: string, celebrate: boolean): PublishShare {
  const share = usePublishShare(project);
  const { start, reset } = share;
  const was = useRef(celebrate);
  useEffect(() => {
    const step = celebrationStep(was.current, celebrate);
    was.current = celebrate;
    if (step === CelebrationStep.Start) start();
    if (step === CelebrationStep.Reset) reset();
  }, [celebrate, start, reset]);
  return share;
}
