/**
 * The checks under a build's Technical details, as the person reads them (`RunOutcome.tsx`
 * `OutcomeChecks`): this build's checks first and an earlier build's apart, failures before passes,
 * each saying its state in words, who checked and what it rests on. Category and revision stay out
 * of the row: the group says which build, and Technical details keeps the revision above.
 */
import type { ChatJudgeResultPayload } from "../shared/chat-judge.ts";
import { InteractionSource, type RunEvidence } from "../shared/run-summary.ts";
import type { IconName } from "./ui/icons.tsx";
import { CHAT_JUDGE_WORDS, CHECK_WORDS, OBJECTIVE_WORDS, PLAYED_SOURCE_WORDS } from "./words.ts";

/**
 * Each check state's mark: an icon in its state colour, beside the state's word in the row's line —
 * the build's checks list and a chat's judge line alike.
 */
export const CHECK_MARKS: Record<RunEvidence["status"], { icon: IconName; tone: string }> = {
  passed: { icon: "check", tone: "text-green" },
  failed: { icon: "close", tone: "text-red" },
  incomplete: { icon: "minus", tone: "text-ink-3" },
  unknown: { icon: "minus", tone: "text-ink-3" },
};

/** The order a check's state is read in: what needs attention first. */
const STATUS_ORDER: Record<RunEvidence["status"], number> = { failed: 0, incomplete: 1, unknown: 2, passed: 3 };

/** A build's checks: the ones taken on it, and the ones an earlier build's checks left. */
export interface CheckGroups {
  current: RunEvidence[];
  earlier: RunEvidence[];
}

/** Failures first, the rest in the order they were recorded. */
function byAttention(rows: readonly RunEvidence[]): RunEvidence[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => STATUS_ORDER[a.row.status] - STATUS_ORDER[b.row.status] || a.index - b.index)
    .map(({ row }) => row);
}

/**
 * The checks by the build they were taken on. Only a check that names another revision is an
 * earlier build's: one whose revision was not recorded is never called earlier.
 */
export function checkGroups(rows: readonly RunEvidence[], head: string | null): CheckGroups {
  const earlier = (row: RunEvidence) => row.head !== null && row.head !== head;
  return {
    current: byAttention(rows.filter((row) => !earlier(row))),
    earlier: byAttention(rows.filter(earlier)),
  };
}

/** The source a check names, when it is one of those that played the build. */
function playedSource(row: RunEvidence): InteractionSource | undefined {
  return Object.values(InteractionSource).find((source) => source === row.source);
}

/** Who took a check: one that played the build, a reviewer (visual and structural), or a recorded check. */
function checkSource(row: RunEvidence): string {
  const played = playedSource(row);
  if (played) return PLAYED_SOURCE_WORDS[played];
  return row.category === "visual" || row.category === "structural" ? CHECK_WORDS.reviewer : CHECK_WORDS.recorded;
}

/** The line under a check's title: its state, who took it and, for one that played, what it rests on. */
export function checkMeta(row: RunEvidence): string {
  const rests = row.objective ? [OBJECTIVE_WORDS[row.objective]] : [];
  return [CHECK_WORDS.status[row.status], checkSource(row), ...rests].join(" · ");
}

/** A replayed route is named by what it is; its id is a slug of the question it was kept from. */
export function checkTitle(row: RunEvidence): string {
  return playedSource(row) === InteractionSource.RouteReplay ? CHECK_WORDS.routeTitle : row.label;
}

/** A replay that held says so in words; one that parted ways keeps the step it parted at. */
export function checkNote(row: RunEvidence): string | null {
  const held = playedSource(row) === InteractionSource.RouteReplay && row.status === "passed";
  return held ? CHECK_WORDS.routeHeld : row.note;
}

/**
 * A chat's judge line, in the checks list's words ("Passed · Judge who played it · verified by the
 * studio"); one where nothing was played says so, its reason inside.
 */
export function judgeLineLabel(judge: ChatJudgeResultPayload): string {
  if (judge.refusal) return CHAT_JUDGE_WORDS.notPlayed;
  return checkMeta({
    id: "",
    head: null,
    category: "interaction",
    label: judge.ask,
    status: judge.status,
    note: judge.note,
    source: InteractionSource.HandsOnJudge,
    objective: judge.objective,
  });
}
