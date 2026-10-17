/**
 * The lead's news of its generic workers (the run's shared pool, `loop/workers/`): each one's end,
 * kept until the lead's next news (its 15-second steer or its next turn's digest) takes it, so the
 * lead hears that a copy is ready to merge as it hears of its typed workers.
 */
import { RUN_POOL_WORDS } from "../workers/prompts.ts";
import type { WorkerRecord, WorkerState } from "../workers/records.ts";

/** One generic worker's end, as the lead's news carries it beside its typed workers'. */
export type PoolNews = { id: string; state: WorkerState; text: string };

/** Each lead's generic workers' ends it has not been told yet, oldest first. */
const untold = new WeakMap<object, PoolNews[]>();

/** A generic worker of the lead's run ended: its line waits for the lead's next news. */
export function notePoolEnd(lead: object, record: WorkerRecord): void {
  const news = untold.get(lead) ?? [];
  news.push({ id: record.id, state: record.state, text: RUN_POOL_WORDS.ended(record.id, record.title, record.state) });
  untold.set(lead, news);
}

/** The generic workers' ends the lead has not heard yet, each told once. */
export function takePoolNews(lead: object): PoolNews[] {
  const news = untold.get(lead) ?? [];
  untold.delete(lead);
  return news;
}
