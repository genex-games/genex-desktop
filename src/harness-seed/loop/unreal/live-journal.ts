/**
 * The Unreal plugin's tool call where it lived before one lead took the Unreal Loop over: a harness
 * file the agent kept from then (its own `restore.ts`) still imports `unrealTool` from here. It lives
 * in `lead-journal.ts` now (seed-upgrade.ts `SEED_MOVES`).
 */
export { unrealTool } from "./lead-journal.ts";
