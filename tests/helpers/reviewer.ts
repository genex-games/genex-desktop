/**
 * A Loop's reviewer as a fake engine answers it: the session result whose last words are the JSON
 * verdict its brief asks for (`reviewerAnswer`), and how a fake engine tells a reviewer's request
 * from a lead's or a worker's (`seatedReviewer`: the host seats every reviewer in a home of its own
 * under scratch's `reviewers` folder; at the harness's side the request names `reviewer`), and the
 * host's finish check over a fake host (`fakeFinishReview`).
 */
import path from "node:path";
import { FinishReviews } from "../../src/main/core/finish-review.ts";
import { HostMethod } from "../../src/shared/harness-api.ts";

/** The folder under scratch where the host seats the Loops' reviewers. */
const REVIEWERS_FOLDER = "reviewers";

/** A reviewer's session result: yes or no, with its reasons, what isn't done and what is, as the brief's JSON at the end of its summary. */
export function reviewerAnswer(
  verdict: string,
  reasons: readonly string[] = [],
  engine = "claude-code",
  notDone: readonly string[] = [],
  done: readonly string[] = [],
) {
  const answer = JSON.stringify({ verdict, reasons, done, notDone });
  return {
    ok: true,
    engine,
    turns: 2,
    usage: {},
    sessionId: `reviewer-${verdict}`,
    summary: `I read the folder and looked at the pictures.\n\`\`\`json\n${answer}\n\`\`\``,
  };
}

/** Whether a request the host handed an engine is a Loop's reviewer's: it runs in a reviewers' home under scratch. */
export function seatedReviewer(request: { cwd?: string }): boolean {
  return typeof request.cwd === "string" && request.cwd.split(path.sep).includes(REVIEWERS_FOLDER);
}

/** Whether a delegation the harness asked for is a Loop's reviewer's. */
export const asksReviewer = (params: Record<string, unknown>): boolean =>
  typeof params.reviewer === "object" && params.reviewer !== null;

/** What a fake host keeps for its finish checks: how its reviewer answers, and where its records live. */
export interface FakeFinishHost {
  /** The reviewer's session, as the host's `engine.delegate` would run it: its params are the ones the host sends. */
  delegate: (params: Record<string, unknown>) => unknown;
  /** Keep one `finish_check` record where the fake keeps its events. */
  append: (payload: Record<string, unknown>) => unknown;
  /** The `finish_check` payloads the fake keeps, oldest first (one ask: the fake never reopens a run). */
  records: () => Array<Record<string, unknown>>;
  /** Whether a run is going now (a running run of the game); every run is, by default. */
  running?: (runId: string) => boolean;
}

/** The chat a fake host's runs report to. */
const FAKE_CHAT = "fake-chat";

/**
 * The host's finish check over a fake host (`finish.review`, `finish.settle`): the app's own rules
 * (`core/finish-review.ts`) with the fake's reviewer, records and runs as its ports. `asked` holds the
 * reviewer sessions the host started, with the params it started them with.
 */
export function fakeFinishReview(fake: FakeFinishHost) {
  const asked: Array<Record<string, unknown>> = [];
  const reviews = new FinishReviews({
    runningChat: async (_project, runId) => ((fake.running?.(runId) ?? true) ? FAKE_CHAT : null),
    history: async () => ({ all: fake.records(), sinceOpened: fake.records() }),
    append: async (_threadId, payload) => fake.append({ ...payload }),
    delegate: async (params) => {
      asked.push(params as unknown as Record<string, unknown>);
      return fake.delegate(params as unknown as Record<string, unknown>);
    },
  });
  return {
    asked,
    reviews,
    handlers: {
      [HostMethod.FinishReview]: (params: Record<string, unknown>) => reviews.review(params as never),
      [HostMethod.FinishSettle]: (params: Record<string, unknown>) => reviews.settle(params as never),
    },
  };
}
