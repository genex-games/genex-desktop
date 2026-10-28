/**
 * A game's local item drafts (contract "Local item drafts"): main's record of them is read when any
 * chat of the game opens. While the chat shows a local draft's card, or the record holds a draft still
 * waiting to go up, main is asked to settle them (upload them and put on sale what the person
 * approved, once the game is on Genex) when the chat opens, when the window comes back, and at once
 * when the game's Genex publish finishes. Main paces every ask (`LOCAL_SETTLE_GAP_MS`) and runs one
 * at a time per game.
 */
import { useEffect, useRef } from "react";
import { GenexPublishJobState, type GenexPublishState } from "../../shared/genex.ts";
import { useGenexPublishState } from "../panels/plugins/genex/use-genex-publishing.ts";
import { useItems } from "../state/hooks.ts";
import { studio } from "../state/studio.ts";
import { holdsLocalDrafts } from "./listing-draft.ts";

/** When the game's last Genex publish finished, as its record says; null while none has. */
export function finishedPublish(state: GenexPublishState | null): string | null {
  const job = state?.job;
  return job?.state === GenexPublishJobState.Done ? (job.finishedAt ?? null) : null;
}

/**
 * Whether the record now names a publish that finished since the one read before (`before`;
 * undefined before the first read, which names an earlier publish, not a new one).
 */
export const publishFinishedSince = (before: string | null | undefined, now: string | null): boolean =>
  before !== undefined && now !== null && now !== before;

/**
 * Read `project`'s local drafts from main, and settle them while its chat shows a local draft's card
 * (`showsLocalDraft`) or main's record holds one still waiting to go up.
 */
export function useLocalItemsSettle(project: string | null, showsLocalDraft: boolean): void {
  const held = useItems((s) => (project ? holdsLocalDrafts(s.local[project]) : false));
  const watching = showsLocalDraft || held;
  const publishing = useGenexPublishState(project, watching);
  const finished = finishedPublish(publishing.state);
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (project) void studio().items.readLocal(project);
  }, [project]);
  useEffect(() => {
    seen.current = undefined;
    if (!project || !watching) return;
    const items = studio().items;
    void items.settleLocal(project, false);
    const focused = () => void items.settleLocal(project, false);
    window.addEventListener("focus", focused);
    return () => window.removeEventListener("focus", focused);
  }, [project, watching]);
  useEffect(() => {
    if (!project || !watching || !publishing.read) return;
    const before = seen.current;
    seen.current = finished;
    if (publishFinishedSince(before, finished)) void studio().items.settleLocal(project, true);
  }, [project, watching, publishing.read, finished]);
}
