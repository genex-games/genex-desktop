/**
 * What reaches a web Loop's lead while its own turn works, as an open Loop's lead hears it
 * (open/news.ts): a worker of its run that ended and a job of the run that ended, each said into the
 * turn under way once (`engine.steer`, never cutting it short), as Claude Code's background agents
 * tell their lead. A line the session read (`DelegateResult.steered`) is not told again by a digest
 * and wakes nobody after the turn; one it did not read rides the next digest as news always did. An
 * engine that cannot read mid-turn takes none, and hears it when its turn ends. A module of its own,
 * so a kept older wake.ts or open/news.ts still loads beside it.
 */
import type { DelegateResult } from "../../types/host-api.d.ts";
import { HostMethod } from "../host-methods.ts";
import { SECOND_MS } from "../time.ts";
import type { LoopRun, LoopRunLogEntry } from "./loop-run.ts";
import { NoteKind } from "./wake-schedule.ts";

/** How often a turn under way is looked at for news. */
const TURN_WATCH_MS = SECOND_MS;

/** The kinds of line a working web lead hears at once. */
const TURN_NEWS: ReadonlySet<string> = new Set([NoteKind.WorkerEnded, NoteKind.JobEnded]);

/** Each run's log lines a turn under way took in, by sequence number. */
const heardByRun = new WeakMap<object, Set<number>>();

/** Whether a web lead's turn under way already took this line of the run's log: no digest tells it again. */
export function heardInTurn(loopRun: object, seq: number): boolean {
  return heardByRun.get(loopRun)?.has(seq) === true;
}

/** The run's set of lines its turns took, made on first use. */
function heardOf(loopRun: LoopRun): Set<number> {
  const known = heardByRun.get(loopRun);
  if (known) return known;
  const made = new Set<number>();
  heardByRun.set(loopRun, made);
  return made;
}

/** The clock a watch sleeps on: the wake loop's own. */
export interface TurnNewsClock {
  sleep(ms: number): Promise<void>;
}

/** One turn's watch: the lines it offered, and those its session took, by the id they went in under. */
interface TurnWatch {
  turn: number;
  tried: Set<number>;
  taken: Map<string, number>;
}

/** The news lines of the run's log no turn has taken and this one has not offered. */
function newsFor(loopRun: LoopRun, heard: ReadonlySet<number>, watch: TurnWatch): LoopRunLogEntry[] {
  return loopRun
    .notesSince(loopRun.waitSeq)
    .filter((entry) => entry.kind !== undefined && TURN_NEWS.has(entry.kind))
    .filter((entry) => !heard.has(entry.seq) && !watch.tried.has(entry.seq));
}

/** Says one line into the turn under way, never cutting it short; whether the session took it. */
async function steer(loopRun: LoopRun, id: string, text: string): Promise<boolean> {
  const params = { threadId: loopRun.threadId, into: loopRun.run.runId, messages: [{ id, text }], interrupt: false };
  const answer = await loopRun.ctx.call(HostMethod.EngineSteer, params).catch(() => null);
  return Boolean(answer?.accepted?.includes(id));
}

/** One look at the turn under way: each new line offered once, and those taken kept as heard. */
async function lookOnce(loopRun: LoopRun, watch: TurnWatch): Promise<void> {
  if (loopRun.state.finished || loopRun.ctx.cancelled === true) return;
  const heard = heardOf(loopRun);
  for (const entry of newsFor(loopRun, heard, watch)) {
    watch.tried.add(entry.seq);
    const id = `${loopRun.run.runId}:${watch.turn}:turn-news-${entry.seq}`;
    if (!(await steer(loopRun, id, entry.text))) continue;
    heard.add(entry.seq);
    watch.taken.set(id, entry.seq);
  }
}

/**
 * Watches one session call of a web Loop's lead until `stop`; `settle` takes the call's result, and
 * what its session took in but never read is news again for the next digest.
 */
export function watchTurnNews(
  loopRun: LoopRun,
  { clock, turn }: { clock: TurnNewsClock; turn: number },
): { stop: () => Promise<void>; settle: (result: Partial<DelegateResult> | undefined) => void } {
  const watch: TurnWatch = { turn, tried: new Set(), taken: new Map() };
  let over = false;
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const watching = (async () => {
    while (!over) {
      await lookOnce(loopRun, watch).catch(() => {});
      await Promise.race([clock.sleep(TURN_WATCH_MS), ended]);
    }
  })();
  return {
    stop: async () => {
      over = true;
      end();
      await watching;
    },
    settle: (result) => {
      const read = new Set(result?.steered ?? []);
      const heard = heardOf(loopRun);
      for (const [id, seq] of watch.taken) if (!read.has(id)) heard.delete(seq);
      watch.taken.clear();
    },
  };
}
