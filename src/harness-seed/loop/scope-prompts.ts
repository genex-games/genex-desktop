/**
 * The scope as every agent that reads the goal reads it (loop/scope.ts): the user's own words, what
 * is in scope, what is cut, and that a named reference sets the look, not the features. The rules
 * travel here, in code, and not only in skills/director.md or a judge rubric, which a seed upgrade
 * keeps at an agent-edited older vintage. A run without scope renders nothing, so an older run's
 * prompts stay byte-identical. A new module; it imports only from scope.ts, which is as new.
 */
import { runScope, type ScopeCarrier } from "./scope.ts";

/** The words the scope is rendered with. */
const WORDS = {
  heading: "SCOPE",
  asked: "THE USER ASKED (verbatim):",
  inScope: "IN SCOPE:",
  inScopeUnnamed: "IN SCOPE: what the user asked, nothing more",
  cut: "CUT — not this build; never build or propose it:",
  added: "ADDED beyond the ask — not in scope until the user says yes:",
  store:
    "GENEX STORE — sold in this build for Nex whatever CUT says. Give each item its picture as soon as it can be drawn (render it alone on a transparent background with the game's own code, save the PNG under .genex/scratch/), then list it with genex__cli shop add, its name in args and its price, type, description and image options, unless genex__cli shop list shows it already: the store takes no item without its picture, and shop set changes one at any time. Build each in, unlock it with getEntitlements() and sell it with buy() (the genex-items skill):",
  reference: "The reference is a look-and-feel bar, not a feature list.",
} as const;

/** How the items of one line are joined. */
const ITEM_JOIN = "; ";

/**
 * What deepens the ask and what adds to it, in the same words for the lead and every judge, so
 * "work only inside SCOPE" never reads as "never grow the world". A place the user's mood calls for
 * is the ask, deeper; a new system is not.
 */
const DEEPENS = "a vista, skyline, water, landmark or set-piece that serves the mood the user asked for deepens SCOPE";
const ADDS = "a new system, mechanic or mode SCOPE does not name (police, nitro, a garage, multiplayer)";

/** The judges' rule: depth of what is in scope; a proposal needing more says so in its typed field. */
export const SCOPE_RULE =
  'Judge the depth and quality of what is in SCOPE; a proposal that needs something not in scope is scope:"adds".';

/** The lead's rule: it cuts systems, deepens the world, and the user widens. */
export const DIRECTOR_SCOPE_RULE = `Cut systems the user did not ask for; deepen the world they did: ${DEEPENS}. Only ${ADDS} is a decision card the user can accept.`;

/** How a proposal says whether it stays inside the ask: the typed field every reader of it decides on. */
export const PROPOSAL_SCOPE_RULE = `Every proposal you name (bigMove, the move) carries "scope": "deepens" when it deepens what SCOPE names (${DEEPENS}), "adds" for ${ADDS}.`;

/** The liveness critic's half: a fix that adds is flagged on its principle, and `biggest` stays inside SCOPE. */
export const LIVENESS_SCOPE_RULE = `A principle whose fix is ${ADDS} sets "adds":true beside its score; any other fix sets false (${DEEPENS}). \`biggest\` is the deepest change inside SCOPE, and a cut item is never a fix.`;

/** The scope with a judge's rule after it, for every agent that judges or proposes; '' for a run without scope. */
export function judgeScopeLines(run: ScopeCarrier, rules: readonly string[] = []): string {
  const lines = scopeLines(run);
  if (!lines) return "";
  return [lines, SCOPE_RULE, ...rules].join("\n");
}

/** One message of the ask as a list item; a message of several lines stays together, indented. */
function askedItem(message: string): string {
  return `- ${message.split("\n").join("\n  ")}`;
}

/**
 * The scope block an agent reads beside the goal: the user's words verbatim, in scope, cut, added
 * beyond the ask, and the reference rule. '' for a run without scope.
 */
export function scopeLines(run: ScopeCarrier): string {
  const scope = runScope(run);
  if (!scope) return "";
  return [
    WORDS.heading,
    WORDS.asked,
    ...scope.asked.map(askedItem),
    scope.inScope.length ? `${WORDS.inScope} ${scope.inScope.join(ITEM_JOIN)}` : WORDS.inScopeUnnamed,
    scope.store?.length ? `${WORDS.store} ${scope.store.join(ITEM_JOIN)}` : "",
    scope.cut.length ? `${WORDS.cut} ${scope.cut.join(ITEM_JOIN)}` : "",
    scope.added.length ? `${WORDS.added} ${scope.added.join(ITEM_JOIN)}` : "",
    WORDS.reference,
  ]
    .filter(Boolean)
    .join("\n");
}
