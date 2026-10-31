/**
 * What analytics hears without a click: the log's records and main's UI events, each handed to the
 * part of the app that knows what it means (`events/<area>.ts`), and any stream a part watches
 * itself. Subscribed once, beside the stores.
 *
 * A record is counted once: the newest one counted is kept per profile (`analyticsLogSeen`), so a
 * reload's bootstrap tail never counts again what the window already did. On a profile that never
 * counted one, the log before this launch is history, not news, and is skipped.
 */
import type { EventEnvelope } from "../../shared/studio-api.ts";
import type { UiEvent } from "../../shared/ui-events.ts";
import type { Studio } from "../state/studio.ts";
import { type KeyValueStorage, readNumber, STORAGE_KEYS, writeText } from "../storage.ts";
import { createChatObservers } from "./chat-observe.ts";
import { guarded, quietly } from "./client.ts";
import { createBuildsObservers } from "./events/builds.ts";
import { createLaunchObservers } from "./events/launch.ts";
import { createPluginsObservers } from "./events/plugins.ts";
import { createWelcomeObservers } from "./events/welcome.ts";
import { createWorkspaceObservers } from "./events/workspace.ts";

/** What one part of the app listens to. Each hook only calls `track`; none changes a store. */
export interface AreaObservers {
  /** A log record not counted before, oldest first. */
  log?(record: EventEnvelope): void;
  /** One of main's UI events, as it arrives. */
  ui?(event: UiEvent): void;
  /** Subscriptions of its own (a store, a sign-in or install stream); returns the stop. */
  start?(app: Studio): () => void;
}

/** The parts that listen, made fresh for each start so their own pairing state starts empty. */
const AREAS: ReadonlyArray<() => AreaObservers> = [
  createLaunchObservers,
  createWelcomeObservers,
  createWorkspaceObservers,
  createChatObservers,
  createBuildsObservers,
  createPluginsObservers,
];

const recordTime = (record: EventEnvelope): number => {
  const at = Date.parse(record.created_at);
  return Number.isFinite(at) ? at : 0;
};

/**
 * The records a feed read brings that were never counted, oldest first, and the new mark. Records
 * at the mark itself were counted with it; a feed is oldest first but is sorted again to be sure.
 */
export function uncounted(events: readonly EventEnvelope[], mark: number): { fresh: EventEnvelope[]; mark: number } {
  const fresh = events.filter((record) => recordTime(record) > mark).sort((a, b) => recordTime(a) - recordTime(b));
  const last = fresh.at(-1);
  return { fresh, mark: last ? Math.max(mark, recordTime(last)) : mark };
}

const NOTHING_TO_STOP = (): void => undefined;

/** One part, made so that a part that fails to be made is a part that does not listen. */
function makeArea(create: () => AreaObservers): AreaObservers {
  let area: AreaObservers = {};
  quietly(() => {
    area = create();
  });
  return area;
}

/** One part's own subscriptions: a part that fails to start does not listen, and its stop never throws. */
function startArea(area: AreaObservers, app: Studio): () => void {
  let stop = NOTHING_TO_STOP;
  quietly(() => {
    stop = area.start?.(app) ?? NOTHING_TO_STOP;
  });
  return () => quietly(stop);
}

/** Subscribe every part's listeners (the app's parts unless a test names others). Returns the stop. */
export function startObservers(
  app: Studio,
  storage: KeyValueStorage | null,
  now: number,
  parts: ReadonlyArray<() => AreaObservers> = AREAS,
): () => void {
  const areas = parts.map(makeArea);
  let mark = readNumber(STORAGE_KEYS.analyticsLogSeen, 0, Number.MAX_SAFE_INTEGER, storage) ?? now;
  const offLog = app.eventLog.onArrived(
    guarded((events) => {
      const read = uncounted(events, mark);
      if (read.fresh.length === 0) return;
      mark = read.mark;
      writeText(STORAGE_KEYS.analyticsLogSeen, String(mark), storage);
      for (const record of read.fresh) for (const area of areas) quietly(() => area.log?.(record));
    }),
  );
  const offUi = app.onUiEvent(
    guarded((event) => {
      for (const area of areas) quietly(() => area.ui?.(event));
    }),
  );
  const stops = areas.map((area) => startArea(area, app));
  return () => {
    offLog();
    offUi();
    for (const stop of stops) stop();
  };
}
