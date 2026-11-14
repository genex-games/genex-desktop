/**
 * A check as the person reads it on a chat's judge line: its state in words, who checked and what
 * it rests on.
 */
import type { ChatJudgeResultPayload } from "../shared/chat-judge.ts";
import { InteractionSource, type RunEvidence } from "../shared/run-summary.ts";
import type { IconName } from "./ui/icons.tsx";
import { CHAT_JUDGE_WORDS, CHECK_WORDS, OBJECTIVE_WORDS, PLAYED_SOURCE_WORDS } from "./words.ts";

/**
 * Each check state's mark: an icon in its state colour, beside the state's word on a chat's judge line.
 */
export const CHECK_MARKS: Record<RunEvidence["status"], { icon: IconName; tone: string }> = {
  passed: { icon: "check", tone: "text-green" },
  failed: { icon: "close", tone: "text-red" },
  incomplete: { icon: "minus", tone: "text-ink-3" },
  unknown: { icon: "minus", tone: "text-ink-3" },
};

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
