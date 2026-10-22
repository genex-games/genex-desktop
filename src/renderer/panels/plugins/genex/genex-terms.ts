/**
 * Genex's updated terms, as the app offers them: Review opens genex.games' terms page in the
 * browser (the Genex plugin's `terms` action), and the chat offers it under a Genex call that is
 * waiting on them or went no further than them.
 */
import { GENEX_PLUGIN_ID, GenexAction, GenexBlocked } from "../../../../shared/genex.ts";
import type { PluginInfo } from "../../../../shared/plugins.ts";
import { runPluginAction } from "../../../plugin-actions.ts";
import type { ToolChipRow } from "../../../ui/ToolChips.tsx";
import { ToolState } from "../../../ui/tool-state.ts";

/** A Genex call that runs (a generation waits on the terms before it submits) or stopped at the terms. */
function waitsOnGenexTerms(row: ToolChipRow): boolean {
  if (row.source?.id !== GENEX_PLUGIN_ID) return false;
  return row.state === ToolState.Running || row.blocked === GenexBlocked.Terms;
}

/** Whether a group of tool rows holds a Genex call the terms hold up: the chat offers Review under it. */
export function asksForGenexTerms(rows: readonly ToolChipRow[]): boolean {
  return rows.some(waitsOnGenexTerms);
}

/** Open Genex's terms page in the browser, through the Genex plugin's own action. */
export async function reviewGenexTerms(plugins: readonly PluginInfo[]): Promise<void> {
  const genex = plugins.find((plugin) => plugin.manifest.id === GENEX_PLUGIN_ID);
  if (!genex) return;
  // The terms action asks nothing first, so there is no review to show.
  await runPluginAction({ plugin: genex, name: GenexAction.Terms, args: {}, project: null, review: () => {} });
}
