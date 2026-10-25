/** Self-improvement: the SkillOpt pass, its staged proposals, and undoing the studio's own changes. */
import type { StagedProposal } from "../../shared/studio-api.ts";
import { UiEvent } from "../../shared/ui-events.ts";
import { fixtureImprovementPass } from "../dev/fixtures.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";
import { errorMessage } from "../../shared/errors.ts";
import { t } from "../../shared/i18n.ts";
import { DispatchActionType } from "../../shared/protocol.ts";

/** Why a self-improvement request from the renderer is refused. */
const MESSAGE = {
  learningOff: () => t("Self-improvement is off. Turn it on at the top of Studio to look for improvements."),
} as const;

export interface LearningIpcDeps {
  core: StudioCore;
  /** The `studio-activity` development fixture scripts the pass instead of dispatching it. */
  scriptedImprovementPass: boolean;
  pushUiEvent(event: UiEvent): void;
}

export function registerLearningIpc(
  handle: IpcHandle,
  { core, scriptedImprovementPass, pushUiEvent }: LearningIpcDeps,
): void {
  handle("studio:skillopt.start", async () => {
    if (!core.settings.learning) throw new Error(MESSAGE.learningOff());
    if (scriptedImprovementPass) {
      void fixtureImprovementPass(core)
        .then(() => pushUiEvent({ type: UiEvent.SkilloptFinished, payload: {} }))
        .catch((err: unknown) =>
          pushUiEvent({ type: UiEvent.SkilloptFailed, payload: { error: String(errorMessage(err)) } }),
        );
      return true;
    }
    // The dispatch acknowledges when the whole pass completes — potentially an hour of local
    // model time. Fire it and return; the pass narrates itself through events and status.
    void core.host
      .dispatch({ type: DispatchActionType.SkilloptStart, threadId: core.mainThread })
      .catch((err: unknown) => {
        pushUiEvent({ type: UiEvent.SkilloptFailed, payload: { error: String(errorMessage(err)) } });
      });
    return true;
  });

  handle("studio:selfchanges", async () => {
    const staged = (await core.store.readArtifact<StagedProposal[]>(core.mainThread, "skillopt_staged")) ?? [];
    return { changes: await core.selfChangeList(), staged };
  });

  handle("studio:skillopt.accept", async (payload) =>
    core.acceptStagedProposal(payload.index, "human", { at: payload.at, skill: payload.skill }),
  );
  handle("studio:staged", async () => (await core.store.readArtifact(core.mainThread, "skillopt_staged")) ?? []);
  handle("studio:skillopt.discard", async (payload) => {
    await core.discardStagedProposal(payload.index, payload.reason, { at: payload.at, skill: payload.skill });
    return true;
  });

  handle("studio:rollback", async (payload) => {
    await core.rollbackTo(payload.snapshotId);
    return true;
  });
  handle("studio:selfchange.undo", async (payload) => core.undoSelfChange(payload.snapshotId));
}
