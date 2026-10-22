/**
 * The Publish banner's cover: Studio takes one as the dialog opens when the game has none, the
 * arrows make one of the recent frames the kept one, and Another cover asks the game's chat for a
 * new one. Once the chat sent that ask it is kept on this Mac (`cover-asks.ts`), so the banner
 * opened again still says it is being made, until the agent's own frame arrives.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { GenexAction, type GenexCoverRecord, type GenexPublishState } from "../../../../shared/genex.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { runPluginAction } from "../../../plugin-actions.ts";
import { GENEX_WORDS } from "../../../words.ts";
import {
  type CoverAsk,
  type CoverAskMemory,
  CoverKind,
  readCoverAsks,
  rememberCoverAsk,
  settleCoverAsk,
  writeCoverAsks,
} from "./cover-asks.ts";
import { coverChoices, flipCover, needsCover } from "./genex-publish-view.ts";

const WORDS = GENEX_WORDS.publish;

/** Seconds since `startedAt` (an ISO time), ticking each second while there is one. */
export function useElapsed(startedAt: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), SECOND_MS);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return null;
  return Math.max(0, Math.floor((now - Date.parse(startedAt)) / SECOND_MS));
}

/**
 * The game's kept asks as the cover record last read settles them (the wait shown is that one),
 * and a way to keep an ask the chat sent. The stored asks are read once per game.
 */
function useCoverAsks(
  project: string,
  record: GenexCoverRecord | undefined,
): [CoverAskMemory, (ask: CoverAsk) => void] {
  const stored = useMemo(() => readCoverAsks(project), [project]);
  const [kept, setKept] = useState<{ project: string; memory: CoverAskMemory } | null>(null);
  const memory = kept?.project === project ? kept.memory : stored;
  const settled = record ? settleCoverAsk(memory, record, Date.now()) : memory;
  useEffect(() => {
    if (settled === memory) return;
    writeCoverAsks(project, settled);
    setKept({ project, memory: settled });
  }, [project, memory, settled]);
  const remember = useCallback(
    (ask: CoverAsk) => setKept({ project, memory: rememberCoverAsk(project, ask) }),
    [project],
  );
  return [settled, remember];
}

/** What the banner's cover controls read and do. */
export interface PublishCover {
  /** Studio is taking the game's first cover right now. */
  taking: boolean;
  /**
   * Another picture or clip was asked for and none has arrived yet: which, since when (ISO), and how
   * long this game's last one of that kind took (ms; undefined before one was timed).
   */
  making: { kind: CoverKind; since: string; took: number | undefined } | null;
  /** The recent frames and which is kept. */
  choices: { shas: string[]; index: number };
  /** Make the frame an arrow lands on the kept one. */
  flip: (step: 1 | -1) => void;
  /** Ask the game's chat for another picture or clip showing `want`; null while nobody there can make one. */
  ask: ((kind: CoverKind, want: string) => void) | null;
}

/** The cover controls for one game's Publish dialog; `refresh` re-reads its record. */
export function usePublishCover({
  plugin,
  project,
  state,
  refresh,
}: {
  plugin: PluginInfo;
  project: string;
  state: GenexPublishState | null;
  refresh: () => Promise<void>;
}): PublishCover {
  const [taking, setTaking] = useState(false);
  const [asks, rememberAsk] = useCoverAsks(project, state?.cover);
  const tried = useRef(false);
  const kept = state?.cover?.shot?.sha256 ?? null;
  const clip = state?.cover?.clip?.sha256 ?? null;
  const wanted = state ? needsCover(state) : false;
  useEffect(() => {
    if (!wanted || tried.current || !project) return;
    // Once per opening: a game whose cover could not be taken is not asked again on every read.
    tried.current = true;
    setTaking(true);
    void runPluginAction({ plugin, name: GenexAction.CoverAuto, args: {}, project, review: () => {} })
      .catch(() => {})
      .finally(() => {
        setTaking(false);
        void refresh();
      });
  }, [wanted, plugin, project, refresh]);
  const asked = asks.ask;
  const choices = coverChoices(state?.cover);
  const flip = useCallback(
    (step: 1 | -1) => {
      const sha256 = flipCover(choices, step);
      if (!sha256) return;
      void runPluginAction({ plugin, name: GenexAction.CoverPick, args: { sha256 }, project, review: () => {} })
        .catch(() => {})
        .finally(() => void refresh());
    },
    [choices, plugin, project, refresh],
  );
  const ask = (kind: CoverKind, want: string): void => {
    const text =
      kind === CoverKind.Clip ? WORDS.coverAnotherClipPrompt(want.trim()) : WORDS.coverAnotherPrompt(want.trim());
    const pending: CoverAsk = { kind, from: kind === CoverKind.Clip ? clip : kept, at: Date.now() };
    // Kept only once the chat really sent it: words left in its composer (no model, a sign-in
    // first) start nothing, so the banner says nothing is being made.
    composeInChat({ project, text, send: true, sent: () => rememberAsk(pending) });
  };
  return {
    taking,
    making: asked ? { kind: asked.kind, since: new Date(asked.at).toISOString(), took: asks.took[asked.kind] } : null,
    choices,
    flip,
    // A cover is the Genex plugin's to make: with it off, nobody in the chat can.
    ask: plugin.enabled ? ask : null,
  };
}
