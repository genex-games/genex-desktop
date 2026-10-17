/**
 * The harness's two cheap questions about Unreal for a chat (`wait-editor`, `engine-status`): after
 * a turn that made a game's Unreal project, whether its editor answers yet (waiting while it
 * starts, so the chat can go on by itself once it is ready); and before a new game's first build,
 * whether an Unreal Genex can make projects with is installed (so the engine question is honest).
 * Both only read: Genex's own records, the editor's process and log, its project's port, and Epic's
 * list of installed engines.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { canCreateWith } from "./create-project.ts";
import { EditorStart } from "./editor-status.ts";
import type { Engine } from "./setup.ts";

/** Where a game's editor stands at the end of a wait. Wire values: the seed reads them (`loop/unreal/editor-wait.ts`). */
export const EditorWait = {
  Ready: "ready",
  Starting: "starting",
  NotStarting: "not-starting",
  PortBlocked: "port-blocked",
  /** The game has no set-up Unreal project to wait for. */
  NoProject: "no-project",
} as const;
export type EditorWait = (typeof EditorWait)[keyof typeof EditorWait];

/**
 * Whether this computer has an Unreal Genex makes projects with (`ready`), only a newer one it
 * opens but makes no projects with yet (`newer-only`), only one older than Unreal games need
 * (`older-only`), or none (`none`). Wire values: the seed reads them.
 */
export const EngineReadiness = {
  Ready: "ready",
  NewerOnly: "newer-only",
  OlderOnly: "older-only",
  None: "none",
} as const;
export type EngineReadiness = (typeof EngineReadiness)[keyof typeof EngineReadiness];

/**
 * The longest one wait runs: under the host's limit for a plugin call (190 s), so the answer always
 * arrives; the harness asks again for a longer wait.
 */
export const WAIT_EDITOR_MAX_MS = 170 * SECOND_MS;
/** How often a wait asks the editor again. */
const WAIT_POLL_MS = 3 * SECOND_MS;

/** What a wait reads: the editor's answer on its project's port, where its start stands, the clock and a pause. */
export type EditorWaitDeps = {
  answers: () => Promise<boolean>;
  start: () => Promise<EditorStart>;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** A start that ended without an answer, as the wait names it. */
const endedWithout = (start: EditorStart): EditorWait =>
  start === EditorStart.PortBlocked ? EditorWait.PortBlocked : EditorWait.NotStarting;

/**
 * Waits up to `waitMs` (at most {@link WAIT_EDITOR_MAX_MS}) for the editor to answer: Ready once it
 * does; NotStarting or PortBlocked as soon as it stops starting without answering; Starting when
 * the time runs out or `signal` ends the wait first. A `waitMs` of 0 only looks.
 */
export async function waitForEditor(deps: EditorWaitDeps, waitMs: number, signal?: AbortSignal): Promise<EditorWait> {
  const ends = deps.now() + Math.min(Math.max(0, waitMs), WAIT_EDITOR_MAX_MS);
  for (;;) {
    if (await deps.answers()) return EditorWait.Ready;
    const start = await deps.start();
    if (start !== EditorStart.Starting) return endedWithout(start);
    if (deps.now() >= ends || signal?.aborted) return EditorWait.Starting;
    await deps.sleep(WAIT_POLL_MS, signal).catch(() => undefined);
  }
}

/** Whether the installed engines let Genex make an Unreal project: 5.8, only a newer one, only an older one, or none. */
export function engineReadiness(engines: readonly Engine[]): { engine: EngineReadiness; version: string | null } {
  const creatable = engines.find(canCreateWith);
  if (creatable) return { engine: EngineReadiness.Ready, version: creatable.version };
  const newer = engines.find((e) => e.supported);
  if (newer) return { engine: EngineReadiness.NewerOnly, version: newer.version };
  // Newest first: the older Unreal the question names is the newest one installed.
  const older = engines[0];
  if (older) return { engine: EngineReadiness.OlderOnly, version: older.version };
  return { engine: EngineReadiness.None, version: null };
}
