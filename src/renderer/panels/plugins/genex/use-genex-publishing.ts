/**
 * A game's Genex publish record for a surface that only needs whether a publish runs and how the
 * kept cover frame was answered (the chat's cover card): read when it mounts, again whenever Genex
 * announces something, and on the Publish dialog's cadence, quicker while an attempt runs. Nothing
 * is read while `enabled` is false. The last record read for a game is remembered, so a card that
 * remounts knows it at once.
 */
import { useEffect, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import {
  GENEX_PLUGIN_ID,
  GenexAction,
  type GenexPublishState,
  GenexPublishStatusOperation,
} from "../../../../shared/genex.ts";
import { UiEvent } from "../../../../shared/ui-events.ts";
import { isLive } from "./genex-publish-view.ts";

/** How often the record is read again while an attempt runs, and otherwise (the dialog's cadence). */
const RUNNING_POLL_MS = 2 * SECOND_MS;
const IDLE_POLL_MS = 10 * SECOND_MS;

/** The last record read per game (null: it could not be read). */
const lastRead = new Map<string, GenexPublishState | null>();

/** A publish-status answer worth reading: an object (a plugin older than publishing answers nothing). */
const asState = (value: unknown): GenexPublishState | null =>
  value && typeof value === "object" ? (value as GenexPublishState) : null;

/** The game's publish record as last read: `read` is false until the first answer for this game. */
export interface GenexPublishReading {
  read: boolean;
  state: GenexPublishState | null;
}

const reading = (project: string | null): GenexPublishReading =>
  project && lastRead.has(project)
    ? { read: true, state: lastRead.get(project) ?? null }
    : { read: false, state: null };

/** The game's publish record, read while `enabled`. */
export function useGenexPublishState(project: string | null, enabled: boolean): GenexPublishReading {
  const [value, setValue] = useState<GenexPublishReading>(() => reading(project));
  useEffect(() => {
    setValue(reading(project));
    if (!project || !enabled) return;
    let current = true;
    let request = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const read = async () => {
      const mine = ++request;
      if (timer) clearTimeout(timer);
      const args = { operation: GenexPublishStatusOperation.Status };
      const answer = await window.studio
        .pluginAction(GENEX_PLUGIN_ID, GenexAction.PublishStatus, args, project)
        .catch(() => null);
      // A later read (an announcement during this one) owns the record and the next timer.
      if (!current || mine !== request) return;
      const state = asState(answer);
      lastRead.set(project, state);
      setValue({ read: true, state });
      timer = setTimeout(() => void read(), isLive(state?.job) ? RUNNING_POLL_MS : IDLE_POLL_MS);
    };
    void read();
    const off = window.studio.onEvent((event) => {
      if (event.type === UiEvent.PluginEvent && event.payload?.id === GENEX_PLUGIN_ID) void read();
    });
    return () => {
      current = false;
      if (timer) clearTimeout(timer);
      off();
    };
  }, [project, enabled]);
  return value;
}
