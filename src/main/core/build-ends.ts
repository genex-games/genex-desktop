/**
 * What the end of a piece of building (an answered message in any of a game's chats, a finished
 * run on it) changes on the game list. The game's first build: the first such end with the game
 * made (its folder has a kind: `kindPending` no longer holds), recorded once and kept
 * (`GameProject.awaitingFirstBuild`). And whether the game is multiplayer now
 * (`GameProject.multiplayer`), which the agent changes by editing files Studio does not watch. The
 * list is told when either changed, so Multiplayer on the stage strip shows only on a game that was
 * built and is not multiplayer yet.
 */
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { type EventEnvelope, ThreadKind } from "../../shared/event-log.ts";
import { type GameKind, kindPending } from "../../shared/project-facts.ts";

/** The records that end a piece of building: an answered message, a finished run. */
const BUILD_ENDS: ReadonlySet<string> = new Set<string>([
  CustomEvent.CoordinatorMessageHandled,
  CustomEvent.RunFinished,
]);

/** What noting a build's end reads and writes. */
export interface BuildEndDeps {
  /** The game a chat belongs to, or null for a chat of no game. */
  gameOf: (threadId: string) => Promise<string | null>;
  /** Whether the game still waits for its first build. */
  awaiting: (project: string) => Promise<boolean>;
  kindOf: (project: string) => Promise<GameKind>;
  /** Records the first build; true when this call recorded it. */
  markBuilt: (project: string) => Promise<boolean>;
  /** Whether the game loads Genex's multiplayer now. */
  multiplayer: (project: string) => Promise<boolean>;
  /** What the game list was last told of each game's multiplayer, kept by the caller. */
  toldMultiplayer: Map<string, boolean>;
  /** Tells the game list the game changed. */
  changed: (project: string) => void;
}

/** The game a chat's metadata names, when the chat is a game's. */
export function gameOfThread(metadata: unknown): string | null {
  const meta = metadata as { kind?: unknown; project?: unknown } | undefined;
  if (meta?.kind !== ThreadKind.Game || typeof meta.project !== "string") return null;
  return meta.project;
}

/** Whether `events` end a piece of building, and the project a run's end names itself. */
function buildEnd(events: readonly EventEnvelope[]): { ends: boolean; project: string | null } {
  let ends = false;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (!custom || !BUILD_ENDS.has(custom.event_type)) continue;
    ends = true;
    if (typeof custom.payload.project === "string") return { ends, project: custom.payload.project };
  }
  return { ends, project: null };
}

/** Records the game's first build when it is made now; true when this call recorded it. */
async function firstBuildMade(deps: BuildEndDeps, project: string): Promise<boolean> {
  if (!(await deps.awaiting(project))) return false;
  if (kindPending(await deps.kindOf(project))) return false;
  return deps.markBuilt(project);
}

/** Whether the game's multiplayer differs from what the list was last told; remembers it. */
async function multiplayerMoved(deps: BuildEndDeps, project: string): Promise<boolean> {
  const now = await deps.multiplayer(project);
  if (deps.toldMultiplayer.get(project) === now) return false;
  deps.toldMultiplayer.set(project, now);
  return true;
}

/** Tells the game list what `events`, just appended to `threadId`, changed when they end a build. */
export async function noteBuildEnd(
  deps: BuildEndDeps,
  threadId: string,
  events: readonly EventEnvelope[],
): Promise<void> {
  const { ends, project: named } = buildEnd(events);
  if (!ends) return;
  const project = named ?? (await deps.gameOf(threadId));
  if (!project) return;
  const built = await firstBuildMade(deps, project);
  const moved = await multiplayerMoved(deps, project);
  if (built || moved) deps.changed(project);
}
