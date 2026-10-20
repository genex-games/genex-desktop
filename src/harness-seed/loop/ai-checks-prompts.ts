/**
 * The words of the play-time AI checks (`ai-checks.ts`): each failing reason says what the build did
 * and the one thing that fixes it, and the board's notes say what each check holds the game to. A
 * builder reads them in its brief; the tools it fixes them with are `ai_record` and `ai_replay`.
 */
import { AiCheckTest } from "./ai-contract.ts";

/** A count with its noun. */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** Why an AI check failed or went unmeasured. */
export const AI_CHECK_WORDS = {
  notDeterministic: (demo: string) =>
    `demo "${demo}" replayed different frames on two runs of the same seed from the same tape — answers must enter the game only through ai.drain() in update(), and nothing may read the wall clock or Math.random()`,
  misses: (demo: string, misses: number) =>
    `demo "${demo}" made ${count(misses, "call")} its tape has no answer for — record the demo again with ai_record after changing a prompt, a schema or a site`,
  rejected: (demo: string, rejected: number) =>
    `demo "${demo}"'s tape has ${count(rejected, "line")} the reader refused — record it again with ai_record; never write a tape by hand`,
  unsettledOff: (demo: string) =>
    `with AI off, demo "${demo}" crashed, logged a console error or never ended — an optional game plays on its fallback, an AI-only game (requires: "ai") leaves the call to Studio's "needs AI" state`,
  unsettledEdge: (demo: string) =>
    `demo "${demo}" broke on the largest answers its schemas allow — clamp every number, cut every string and drop unknown ids in the applier before an answer reaches the game`,
  stuck: (demo: string, stuck: number) =>
    `demo "${demo}" ended with ${count(stuck, "call")} still waiting for an answer — read every result from ai.drain(), the failures included`,
  noGesture: (demo: string, outside: number) =>
    `demo "${demo}" asked for AI outside a gesture ${count(outside, "time")} — ask from a click or key handler, never at load or on a timer`,
  notDisclosed:
    "the AI disclosure is not drawn — draw ai.disclosure() on the HUD once the game uses AI, so state().ai.disclosed reads true",
  noStatus: (path: string) =>
    `the state does not report ${path} — copy ai.status() into state().ai so Genex can see the AI the game uses`,
  noDemo:
    "the game registers no demo, so no saved playtest can replay it — add a demo that reaches an AI moment and record it with ai_record",
  noBuild: "the evidence names no build to replay",
  noFolder: (project: string) => `the folder of ${project} could not be found`,
  cannotTell: "the studio could not tell how the demo ended",
  cannotReplay: (error: string) => `the studio could not replay the demo: ${error}`,
  unknownTest: (test: string) => `"${test}" is not an AI check`,
  hit: (hit: { vendor: string; file: string; what: "host" | "key"; host?: string }) =>
    hit.what === "key" ? `${hit.file} holds a ${hit.vendor} key` : `${hit.file} calls ${hit.host} (${hit.vendor})`,
  directCalls: (named: readonly string[], total: number) =>
    `${named.join("; ")}${total > named.length ? ` and ${total - named.length} more` : ""} — use genex-ai for every model call and ship no key`,
} as const;

/** What each AI check holds the game to: its note on the board and in the brief. */
export const AI_CHECK_NOTES: Record<AiCheckTest, string> = {
  [AiCheckTest.ReplayDeterministic]:
    "harness-owned: every demo replays the same frames from its tape under seeds 1–3 (the play-time AI method is in .studio/AI.md)",
  [AiCheckTest.TapeCoversDemos]:
    "harness-owned: every AI call a demo makes is answered by its saved playtest (ai/tapes/<demo>.jsonl, written by ai_record)",
  [AiCheckTest.HandlesNoAnswer]:
    'harness-owned: with AI off every demo ends with no call left waiting, no crash and no console error — a fallback, or Studio\'s "needs AI" state for requires: "ai"',
  [AiCheckTest.OutputClamped]:
    "harness-owned: the largest and smallest answers the schemas allow break nothing — the applier clamps what a model says",
  [AiCheckTest.DisclosureShown]: "harness-owned: the HUD draws ai.disclosure(), and state().ai.disclosed says so",
  [AiCheckTest.NoDirectModelCalls]:
    "harness-owned: the build calls no AI vendor's API and holds no vendor key — genex-ai is the only way to a model",
  [AiCheckTest.BudgetInGesture]: "harness-owned: AI is asked for only inside a click or key handler, never at load",
};
