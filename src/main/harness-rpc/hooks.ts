/**
 * Harness RPC: Genex's moments. A checkpoint of a game folder (`checkpoint.take`), its plugins'
 * steps around the snapshot, and the moments the harness announces itself (`hooks.fire`). The
 * host fires the checkpoint and tool moments around its own work, so the harness may not. The
 * run's or the chat's Stop ends a moment it asked for (`moment-stops.ts`).
 */
import { HostMethod, type HarnessHostHandlers, type HarnessParams } from "../../shared/harness-api.ts";
import { HOOK_LABEL_CHARS, isHookLabel, isSeedFiredHookEvent } from "../../shared/plugin-hooks.ts";
import { isWorkerId, isWorkerTitle, WORKER_NAMING } from "../../shared/workers.ts";
import { stoppableMoment } from "../core/moment-stops.ts";
import type { HookScope } from "../core/plugin-hooks.ts";
import type { CoreInternals, StudioCore } from "../studio-core.ts";

/** Why a moment from the harness is refused. */
const MESSAGE = {
  unknownGame: "No such game",
  notSeedFired: (on: unknown) => `The harness may not announce the moment ${JSON.stringify(on)}`,
  badLabel: `A moment's label is one line of 1 to ${HOOK_LABEL_CHARS} characters`,
  badWorker: WORKER_NAMING,
} as const;

/** An optional label: absent, or one the schema would let through. */
function optionalLabel(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isHookLabel(value)) throw new Error(MESSAGE.badLabel);
  return value;
}

/** The worker a moment is about, refused unless its id, title and kind are plain. */
function workerOf(value: HarnessParams<typeof HostMethod.HooksFire>["worker"]): HookScope["worker"] {
  if (value === undefined || value === null) return undefined;
  const { id, title, type } = value;
  const plainType = type === undefined || type === null || isWorkerId(type);
  if (!(isWorkerId(id) && isWorkerTitle(title) && plainType)) throw new Error(MESSAGE.badWorker);
  return { id, title, ...(type ? { type } : {}) };
}

/** A game the harness names, refused unless its folder is there to read (whatever kind of game it holds). */
async function knownGame(core: StudioCore, project: string): Promise<string> {
  await core.games.kindOf(project).catch(() => {
    throw new Error(MESSAGE.unknownGame);
  });
  return project;
}

/** The thread and run a moment answers to, as given. */
function answersTo(p: { threadId?: string | null; runId?: string | null }): Pick<HookScope, "threadId" | "runId"> {
  return { ...(p.threadId ? { threadId: p.threadId } : {}), ...(p.runId ? { runId: p.runId } : {}) };
}

export function hooksRpc(core: StudioCore, x: CoreInternals) {
  return {
    [HostMethod.CheckpointTake]: async (p) => {
      if (!isHookLabel(p.label)) throw new Error(MESSAGE.badLabel);
      const project = await knownGame(core, p.project);
      const scope = { project, ...answersTo(p) };
      return stoppableMoment(x, scope, (signal) =>
        x.hooks.takeCheckpoint({
          ...scope,
          label: p.label,
          ...(p.onlyIfUnsaved === true ? { onlyIfUnsaved: true } : {}),
          signal,
        }),
      );
    },
    [HostMethod.HooksFire]: async (p) => {
      if (!isSeedFiredHookEvent(p.on)) throw new Error(MESSAGE.notSeedFired(p.on));
      const turn = optionalLabel(p.turn);
      const label = optionalLabel(p.label);
      const worker = workerOf(p.worker);
      const project = await knownGame(core, p.project);
      const scope = { project, ...answersTo(p) };
      const told = { ...(turn ? { turn } : {}), ...(label ? { label } : {}), ...(worker ? { worker } : {}) };
      return stoppableMoment(x, scope, (signal) => x.hooks.fire(p.on, { ...scope, ...told }, { signal }));
    },
  } satisfies Partial<HarnessHostHandlers>;
}
