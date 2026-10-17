/**
 * The judges a game's engine plugin declares, as the host lists them on a game it plays in its
 * engine's editor (`game.list`'s `judges`, beside `editorPlay`): read from a descriptor, offered by id
 * on a Loop lead's `judge_play`, and played one at a time after each save point of an open Loop
 * (`director/open/judge-rounds.ts`). The host checks every id against the game's own judges and plays
 * the judge's brief, players and probe; the harness only names it.
 *
 * A module of its own: an agent-edited copy of an older sibling never shadows these names.
 */
import type { JudgeRef } from "../types/host-api.d.ts";
import type { LiveToolSpec } from "../types/host-api.d.ts";
import { ENGINE_JUDGE_WORDS } from "./engine-judges-prompts.ts";
import * as handsOn from "./hands-on-judge.ts";
import * as judgePlay from "./judge-play.ts";

export type { JudgeRef };

/** The most judges a game lists: the most an engine plugin's manifest declares. */
const MAX_JUDGES = 8;

/** Is this a judge as the host lists one: an id and a label, both words? */
function isJudgeRef(value: unknown): value is JudgeRef {
  if (!value || typeof value !== "object") return false;
  const { id, label } = value as Record<string, unknown>;
  return typeof id === "string" && id !== "" && typeof label === "string" && label !== "";
}

/**
 * A game as a Loop keeps it from `game.list`: the moments its plugins hook, whether the studio plays
 * it in its engine's editor, and the judges its engine plugin declares for it.
 */
export type LoopGame = { hookEvents?: unknown; editorPlay?: boolean; judges?: JudgeRef[] };

/** What a descriptor says of its play in an editor: the host's word and its judges; nothing from a host that says nothing. */
export function editorPlayOf(
  game: { editorPlay?: unknown; judges?: unknown } | null | undefined,
): Pick<LoopGame, "editorPlay" | "judges"> {
  const judges = judgesOf(game);
  return {
    ...(typeof game?.editorPlay === "boolean" ? { editorPlay: game.editorPlay } : {}),
    ...(judges.length ? { judges } : {}),
  };
}

/** The judges a game descriptor lists, each once, as id and label; none from a host that lists none. */
export function judgesOf(game: { judges?: unknown } | null | undefined): JudgeRef[] {
  const listed = Array.isArray(game?.judges) ? game.judges : [];
  const judges: JudgeRef[] = [];
  for (const entry of listed) {
    if (!isJudgeRef(entry) || judges.some((judge) => judge.id === entry.id)) continue;
    judges.push({ id: entry.id, label: entry.label });
  }
  return judges.slice(0, MAX_JUDGES);
}

/**
 * Do the judge modules this depends on hand a named judge to the host? A kept older
 * `hands-on-judge.ts` or `judge-play.ts` does not: its judge would play as a plain one, so a judge
 * named there is refused and no round plays.
 */
export function servesEngineJudges(
  parts: readonly Readonly<Record<string, unknown>>[] = [handsOn, judgePlay],
): boolean {
  return parts.every((part) => part.SERVES_ENGINE_JUDGES === true);
}

/** `judge_play` as a Loop lead's engine sees it: with `judge`, listing the game's judges, when it has any. */
export function judgePlaySpec(judges: readonly JudgeRef[]): LiveToolSpec {
  const spec = judgePlay.JUDGE_PLAY_SPEC;
  if (!judges.length) return spec;
  const properties = {
    ...spec.parameters.properties,
    judge: { type: "string", description: ENGINE_JUDGE_WORDS.leadArg(judges) },
  };
  return { ...spec, parameters: { ...spec.parameters, properties } };
}
