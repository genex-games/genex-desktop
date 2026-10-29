/**
 * The shapes the model answers in. Each is a plain JSON schema of the closed dialect genex-ai holds
 * every answer to (what genex-ai's `s.object`, `s.list`, `s.int`, `s.oneOf` and `s.string` build):
 * every object closed, every string bounded, every list capped, every number ranged. Check a change
 * with `ai_schema_check` before it goes in the game.
 */

/** The nations of the continent, by id: the only ids an answer may name. */
export const NATION_IDS = ["aurel", "brenn", "calder", "dorvan", "esk", "fallow"];
/** What a nation may do in reaction to a turn. */
export const ACTIONS = ["ally", "war", "trade", "reform", "idle"];

const int = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const text = (maxLength) => ({ type: "string", maxLength });
const oneOf = (values) => ({ type: "string", enum: [...values] });
const list = (items, maxItems) => ({ type: "array", items, maxItems });
const object = (properties) => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});

/** One turn's resolution: at most 8 nations react; every number is bounded. */
export const TurnDelta = object({
  reactions: list(
    object({
      nation: oneOf(NATION_IDS),
      stance: int(-3, 3),
      action: oneOf(ACTIONS),
      target: oneOf(NATION_IDS),
      troops: int(-500, 500),
      note: text(120),
    }),
    8,
  ),
  headline: text(160),
});

/** One line of the court's dispatch about the turn. */
export const Dispatch = object({ line: text(200) });

/** The background nations' slow drift, every few turns. */
export const MinorDrift = object({
  drifts: list(object({ nation: oneOf(NATION_IDS), stability: int(-2, 2) }), NATION_IDS.length),
});
