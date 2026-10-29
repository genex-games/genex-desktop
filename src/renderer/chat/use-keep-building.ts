/**
 * The open chat answers Keep building (`keep-building.ts`): a tap on its result card or on its
 * run's Builds card sends what is left as the person's message, with the chat's Loop switched on as
 * its composer's Mode would (`PromptBarHandle.loopOn`) and marked so the build goes on whatever the
 * words read like. It answers the tap whether the message went out: a tap while that send is under
 * way, a sign-in first, or a game whose Loop can't run sends nothing, and the button stays.
 */
import { type RefObject, useEffect, useRef } from "react";
import {
  KEEP_BUILDING_EVENT,
  type KeepBuilding,
  keepBuildingAsk,
  keepBuildingExtras,
  oneAtATime,
} from "../keep-building.ts";
import { type Notify, notifyProblem, ToastTone } from "../state/toasts.ts";
import type { PromptBarHandle } from "../ui/PromptBar.tsx";
import { STILL_TO_FIX_WORDS } from "../words.ts";
import type { SendAnswered } from "./use-submit.ts";

export function useKeepBuilding(
  threadId: string | undefined,
  submit: SendAnswered,
  onNotice: Notify,
  composer: RefObject<PromptBarHandle | null>,
): void {
  const latest = useRef({ threadId, submit, onNotice });
  latest.current = { threadId, submit, onNotice };
  useEffect(() => {
    const sendOnce = oneAtATime(async (notDone: string[]): Promise<boolean> => {
      const { submit: send, onNotice: notify } = latest.current;
      const extras = keepBuildingExtras(composer.current?.loopOn() ?? {});
      if (!extras) {
        notify(STILL_TO_FIX_WORDS.noLoop, ToastTone.Error);
        return false;
      }
      return send(keepBuildingAsk(notDone), extras, true).catch((error: unknown) => {
        notifyProblem(notify)(error);
        return false;
      });
    });
    const keep = (event: Event): void => {
      const detail = (event as CustomEvent<KeepBuilding>).detail;
      if (!detail?.threadId || detail.threadId !== latest.current.threadId) return;
      detail.taken = true;
      void sendOnce(detail.notDone).then(detail.answer);
    };
    window.addEventListener(KEEP_BUILDING_EVENT, keep);
    return () => window.removeEventListener(KEEP_BUILDING_EVENT, keep);
  }, [composer]);
}
