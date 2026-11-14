/**
 * The lead's plan as short steps: named when it starts a build (`start_autopilot` `steps`) and
 * again at a save point when it changes (`save_point` `steps`). Each save point the lead makes ticks
 * the next step; the app shows "Step 3 of 4 · <step>" on the chat's Building card and in Builds.
 */

/** The most steps a plan keeps; a longer list is cut. */
export const MAX_PLAN_STEPS = 6;
/** The longest one step's name may be, in characters; a longer one is cut and ends in "…". */
export const MAX_STEP_CHARS = 60;

/** What a plan's steps are, as the tools describe them to the lead. */
export const STEPS_WORDS = `Your plan as 2 to ${MAX_PLAN_STEPS} short steps, in order, a few words each, in the language the person writes in, such as ["Three places", "People and sounds", "Game code", "Light and miracles"]. The person sees them on the Building card as "Step 2 of 4 · People and sounds"; each save point you make ticks the next one, so make one save point per step. Naming the plan again (it changed) lists all of it, done steps included.`;

/** One step's name on one line, cut to its longest; "" when it says nothing. */
function stepName(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const line = raw.replace(/\s+/g, " ").trim();
  const chars = Array.from(line);
  return chars.length > MAX_STEP_CHARS
    ? `${chars
        .slice(0, MAX_STEP_CHARS - 1)
        .join("")
        .trimEnd()}…`
    : line;
}

/**
 * A plan's steps as a tool call names them: a list, or a text of one step per line (a live tool's
 * flat parameters hold no list); its non-empty names, at most `MAX_PLAN_STEPS`; null when it names none.
 */
export function planSteps(raw: unknown): string[] | null {
  const list = typeof raw === "string" ? raw.split("\n") : raw;
  if (!Array.isArray(list)) return null;
  const steps = list.map(stepName).filter(Boolean).slice(0, MAX_PLAN_STEPS);
  return steps.length ? steps : null;
}
