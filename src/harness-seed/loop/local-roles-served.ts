/**
 * Does this harness run a game whose jobs cross to or from a completion-only local engine? main.ts
 * claims the local-roles capability only when every part such a run depends on says so
 * (`SERVES_LOCAL_ROLES`): a seed upgrade keeps any of them the agent edited, and a kept older
 * model-roles.ts drops the cross but keeps the slot's model on the run's own engine. A module of
 * its own, read through namespace imports, so a kept copy without the marker still links.
 */
import * as modelRoles from "./model-roles.ts";
import * as playtester from "./playtester.ts";
import * as scout from "./scout.ts";

/** The capability main.ts claims for it: the app's `HarnessCapability.LocalRoles`. */
export const LOCAL_ROLES_CAPABILITY = "local-roles";

/** The parts a run whose jobs cross to or from a local engine depends on. */
const LOCAL_ROLES_PARTS: readonly Readonly<Record<string, unknown>>[] = [modelRoles, playtester, scout];

/** Does every part a local-roles run depends on serve it? */
export function servesLocalRoles(parts: readonly Readonly<Record<string, unknown>>[] = LOCAL_ROLES_PARTS): boolean {
  return parts.every((part) => part.SERVES_LOCAL_ROLES === true);
}
