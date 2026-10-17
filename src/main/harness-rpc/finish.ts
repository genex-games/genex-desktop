/**
 * Harness RPC: a Loop's finish check (`finish.review`, `finish.settle`). Only the host writes the
 * reviewer's verdict: the harness asks for a review of a running run of this game and settles the
 * round the host holds, which may turn the answer into no answer, never into a yes
 * (`core/finish-review.ts`).
 */
import { HostMethod, type HarnessHostHandlers } from "../../shared/harness-api.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** Why a review from the harness is refused. */
const MESSAGE = { unknownGame: "No such game" } as const;

export function finishRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.FinishReview]: async (p) => {
      await core.games.kindOf(p.project).catch(() => {
        throw new Error(MESSAGE.unknownGame);
      });
      return x.finishReviews.review(p);
    },
    [HostMethod.FinishSettle]: async (p) => x.finishReviews.settle(p),
  } satisfies Partial<HarnessHostHandlers>;
}
