/**
 * How long the harness's own look waits for the page to say it is ready. The bodycam rerun's map
 * round broke on the 15 s default while a Rust game compiled its pipelines: the look brief asked
 * builders to declare `bootMs`, and none did. A look bar loads 2k and 4k scans, so the harness asks
 * for that boot itself rather than trusting a declaration. A page that is ready answers at once,
 * and a page past the shim's own bound keeps booting until it says so (page/shim.ts).
 *
 * A new module: a kept older sibling can never shadow these names.
 */
import { LOOK_BAR_BOOT_MS } from "./destination-budgets.ts";
import { asksForLook } from "./look-bar.ts";
import type { AnyRecord } from "../types/harness.d.ts";

/** The `preview.ready` wait a run's look asks for: a look bar's boot, else the folder's own `bootMs`. */
export function readyWaitOf(run: AnyRecord | null | undefined): { timeoutMs?: number } {
  return run && asksForLook(run as never) ? { timeoutMs: LOOK_BAR_BOOT_MS } : {};
}
