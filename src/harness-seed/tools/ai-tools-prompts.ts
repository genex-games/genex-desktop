/**
 * What the play-time AI tools (`ai-tools.ts`) say to the model: their descriptions and how each
 * answer reads. Text, not a tool module: the registry skips `*-prompts.ts`.
 */
import { AI_BENCH_MAX_SAMPLES, AI_REPLAY_MAX_SEEDS, AiReplayAnswers, AiSchemaProblem } from "../loop/ai-contract.ts";
import type {
  AiBenchResult,
  AiCheckResult,
  AiRecordResult,
  AiReplayResult,
  AiTapeSummary,
} from "../types/host-api.d.ts";

/** A count with its noun. */
const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** What each schema problem means, and what to do about it. */
const SCHEMA_PROBLEM_WORDS: Record<AiSchemaProblem, string> = {
  [AiSchemaProblem.NotObject]: "the schema is not a JSON object",
  [AiSchemaProblem.TooDeep]: "it nests deeper than five levels — flatten it",
  [AiSchemaProblem.UnknownType]: "a type is not one of object, array, string, number, integer, boolean or null",
  [AiSchemaProblem.UnknownKeyword]:
    "it uses a keyword the dialect has no room for ($ref, pattern, anyOf, oneOf and format are refused) — use enum and bounds instead",
  [AiSchemaProblem.BadAnnotation]: "a description is over 500 characters or a title over 100",
  [AiSchemaProblem.BadEnum]:
    "an enum is empty, has more than 32 values, repeats one or holds something other than a scalar",
  [AiSchemaProblem.ObjectShape]:
    "an object is not closed — every object needs properties, required and additionalProperties: false, with at most 32 properties",
  [AiSchemaProblem.BadPropertyName]: "a property name is empty, over 80 characters or a reserved word",
  [AiSchemaProblem.BadRequired]: "required does not list exactly the object's properties",
  [AiSchemaProblem.MisplacedKeyword]:
    "a keyword sits on a type it does not apply to (maxLength on a number, items on a string)",
  [AiSchemaProblem.BadBound]: "a bound is not a whole number in range, or its minimum is over its maximum",
};

/** One replay's answer, as the model reads it. */
function replayWords(result: AiReplayResult): string {
  const lines = [
    `${result.demo}: ${result.deterministic ? "every seed replayed the same frames" : "the seeds replayed DIFFERENT frames"}.`,
    `${count(result.misses, "call")} the tape had no answer for, ${count(result.fallbacks, "fallback")} played, ${count(result.rejected, "tape line")} refused.`,
  ];
  if (result.settled !== undefined)
    lines.push(
      result.settled ? "Every seed's demo ended cleanly." : "A seed's demo crashed, logged an error or never ended.",
    );
  if (result.stuck) lines.push(`${count(result.stuck, "call")} still waited for an answer when a demo ended.`);
  const refused = Object.entries(result.refused ?? {}).filter(([, n]) => (n ?? 0) > 0);
  if (refused.length) lines.push(`Refused: ${refused.map(([code, n]) => `${code} ×${n}`).join(", ")}.`);
  return lines.join(" ");
}

/** The tools' descriptions and answers. */
export const AI_TOOL_WORDS = {
  schemaCheckDescription:
    "Check a schema for a genex-ai ask/judge/act call against the closed dialect genex.games and Studio both hold answers to: no $ref, pattern, anyOf or format; every object closed (additionalProperties: false) with every property required; at most 5 deep, 32 properties, enums of 1–32 values. Pass the JSON schema; run it before a schema goes in the game.",
  tapesDescription:
    "List this game's saved playtests (ai/tapes/<demo>.jsonl): each demo's recorded AI calls, the call sites they cover and the lines the reader refused.",
  replayDescription: `Replay a demo from its saved playtest under each seed (at most ${AI_REPLAY_MAX_SEEDS}), on this Mac with no network: whether every seed reached the same frames, the calls the tape had no answer for and the fallbacks that played. answers=${AiReplayAnswers.None} replays with AI off (does the game still end cleanly?); answers=${AiReplayAnswers.Edge} with the largest and smallest answers its schemas allow (does the applier clamp them?).`,
  recordDescription:
    "Play a demo with this Mac's own models and save what they answered as its playtest (ai/tapes/<demo>.jsonl). Free, never the network; the studio caps the calls and runs one at a time. Record again after changing a prompt, a schema or a call site.",
  benchDescription: `Sample one call site on this Mac's models (at most ${AI_BENCH_MAX_SAMPLES} samples): how many replies fit the game's shape, the median reply time and tokens. Free, never the network.`,
  modelCheckDescription:
    "Replay the game's saved AI moments on this Mac's models and score how well each fits the game. Local models only: the creator runs the full check, on their own plan or key, from Create.",
  demo: "the demo's name: its tape is ai/tapes/<demo>.jsonl (lowercase letters, digits, - and _)",
  seeds: `whole numbers ≥ 0, comma-separated (default 1,2,3; at most ${AI_REPLAY_MAX_SEEDS})`,
  seed: "a whole number ≥ 0 (default 1)",
  answers: `${AiReplayAnswers.Tape} (default), ${AiReplayAnswers.None} or ${AiReplayAnswers.Edge}`,
  site: "the call site's name, as the game passes it (`site:` in ask, say, judge or act)",
  samples: `1–${AI_BENCH_MAX_SAMPLES} (default ${AI_BENCH_MAX_SAMPLES})`,
  schema: "the JSON schema, as JSON text",
  noProject: "Open a game first.",
  candidate: "A candidate cannot use play-time AI tools.",
  badDemo: (demo: string) =>
    `"${demo}" is not a demo's name: lowercase letters, digits, - and _, at most 64, starting with a letter or digit.`,
  badSeeds: `Seeds are whole numbers ≥ 0, at most ${AI_REPLAY_MAX_SEEDS} of them.`,
  badSeed: "The seed is a whole number ≥ 0.",
  badAnswers: `answers is ${AiReplayAnswers.Tape}, ${AiReplayAnswers.None} or ${AiReplayAnswers.Edge}.`,
  badSite: "A site is a name like turn.resolve: a letter first, then letters, digits, ., _ or -, at most 64.",
  badSamples: `samples is a whole number from 1 to ${AI_BENCH_MAX_SAMPLES}.`,
  badSchema: "The schema is not JSON.",
  schemaFits: "The schema fits the dialect.",
  schemaRefused: (problem: AiSchemaProblem) => `The schema is refused: ${SCHEMA_PROBLEM_WORDS[problem]}.`,
  tapes: (tapes: readonly AiTapeSummary[]) =>
    tapes.length === 0
      ? "This game has no saved playtest yet: add an AI demo and record it with ai_record."
      : tapes
          .map(
            (tape) =>
              `${tape.name}: ${count(tape.calls, "call")} over ${tape.sites.join(", ") || "no site"}${tape.rejected ? `, ${count(tape.rejected, "line")} refused` : ""}`,
          )
          .join("\n"),
  replay: replayWords,
  record: (result: AiRecordResult) =>
    `Saved ${result.file}: ${count(result.calls, "call")} answered${result.refused ? `, ${count(result.refused, "call")} refused (the fallback played)` : ""}. Replay it with ai_replay.`,
  bench: (result: AiBenchResult) =>
    result.model === null
      ? `No model on this Mac answered ${result.site}: download one in Settings → Model Providers.`
      : `${result.site} on ${result.model.model}: ${result.fitted}/${result.samples} replies fit${result.medianLatencyMs === null ? "" : `, median ${result.medianLatencyMs} ms`}${result.medianOutputTokens === null ? "" : `, ${result.medianOutputTokens} tokens out`}.`,
  modelCheck: (result: AiCheckResult) =>
    result.rows.length === 0
      ? `No model was checked (${result.moments} saved AI ${result.moments === 1 ? "moment" : "moments"}): record a playtest first, and have a model on this Mac.`
      : result.rows.map((row) => `${row.label}: ${row.fit}, ${row.fitted}/${row.moments} fit`).join("\n"),
  failed: (what: string, error: string) => `${what} failed: ${error}`,
} as const;
