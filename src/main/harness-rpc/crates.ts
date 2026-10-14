/**
 * Harness RPC: crate requests (extension ladder level 4). An agent asks for one extra crate at one
 * exact version for a Rust game; the answer is the request's id and state (with the typed refusal
 * of an earlier decision on the same crate), never an approval. Only the person decides, in
 * Studio's window (`studio:crates.decide`), so no method here approves, fetches or vendors anything.
 * A request is filed only against a game this harness may work on, like every project method:
 * inside the allowed project root, and never a game a newer Genex made (read-only here).
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import { readOnlyRefusal, readProjectShape } from "../../substrate/game-workspace.ts";
import { crateRequestsFor } from "../crate-requests.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** The crate request method: its params' shape is checked by `HARNESS_PARAM_SCHEMAS` before it runs. */
export function cratesRpc(core: StudioCore, _x: CoreInternals) {
  return {
    [HostMethod.CratesRequest]: async (params) => {
      const dir = core.games.dirFor(params.project);
      await core.assertProjectAllowed(dir);
      const readOnly = readOnlyRefusal(await readProjectShape(dir));
      if (readOnly) throw readOnly;
      return await crateRequestsFor(core).request(params);
    },
  } satisfies Partial<HarnessHostHandlers>;
}
