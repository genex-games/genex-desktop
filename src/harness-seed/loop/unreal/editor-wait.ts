/**
 * A chat's first steps with Unreal, as the harness takes them through the Unreal plugin's own
 * harness tools: before a new game's engine question, whether this computer has an Unreal Genex
 * makes projects with (`engine-status`), so the question is honest; and after a turn that made the
 * game's Unreal project while Unreal still opens it, waiting for its editor to answer
 * (`wait-editor`), so the chat goes on by itself instead of ending on a promise nobody keeps.
 * Plugin: `src/plugins/unreal/editor-wait.ts`. The names and wire values below are the plugin's as
 * they were when a module last called this; nothing holds them to the plugin's now.
 *
 * No current module calls this: a chat waits on Genex's `health` moment, and the engine
 * card reads each kind's readiness from its plugin (`kinds[].ready`). It stays because older copies
 * of `delegated-turn.ts`, `unreal-prompts.ts`, `project-prompts.ts` and `chat-session.ts` an agent
 * kept import it.
 */
import { MINUTE_MS, SECOND_MS } from "../time.ts";

/** The Unreal plugin's harness tools, as the host serves them (`<plugin>__<tool>`). */
export const UnrealChatTool = {
  WaitEditor: "unreal__wait-editor",
  EngineStatus: "unreal__engine-status",
} as const;
export type UnrealChatTool = (typeof UnrealChatTool)[keyof typeof UnrealChatTool];

/** Where a game's editor stands at the end of a wait, as the plugin names it. Wire values: never rename. */
export const EditorWait = {
  Ready: "ready",
  Starting: "starting",
  NotStarting: "not-starting",
  PortBlocked: "port-blocked",
  NoProject: "no-project",
} as const;
export type EditorWait = (typeof EditorWait)[keyof typeof EditorWait];

/**
 * Whether this computer has the Unreal Genex makes projects with, only a newer one, only an older
 * one, or none, as the plugin names it. Wire values: never rename.
 */
export const EngineReadiness = {
  Ready: "ready",
  NewerOnly: "newer-only",
  OlderOnly: "older-only",
  None: "none",
} as const;
export type EngineReadiness = (typeof EngineReadiness)[keyof typeof EngineReadiness];

/** What the engine question knows about this computer's Unreal: its readiness and the version found. */
export type UnrealOnComputer = { engine: EngineReadiness; version: string | null };

/** How long the chat waits for Unreal's first start before it says so and ends the turn (Genex's own start window). */
export const UNREAL_START_WAIT_MS = 20 * MINUTE_MS;
/** One `wait-editor` call's wait, in seconds: under the plugin's limit for one call, so each answers in time. */
const WAIT_CALL_SECONDS = 150;

/** Calls one of the plugin's harness tools for the chat's game; any failure is an answer of null. */
export type UnrealInvoke = (tool: UnrealChatTool, args: Record<string, unknown>) => Promise<unknown>;

const WAITS: ReadonlySet<string> = new Set(Object.values(EditorWait));
const READINESS: ReadonlySet<string> = new Set(Object.values(EngineReadiness));
const isWait = (value: unknown): value is EditorWait => typeof value === "string" && WAITS.has(value);
const isReadiness = (value: unknown): value is EngineReadiness => typeof value === "string" && READINESS.has(value);
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

/** Where this computer's Unreal stands for the engine question; null when the plugin can't say (an older plugin). */
export async function unrealOnComputer(invoke: UnrealInvoke): Promise<UnrealOnComputer | null> {
  const answer = await invoke(UnrealChatTool.EngineStatus, {}).catch(() => null);
  const engine = field(answer, "engine");
  if (!isReadiness(engine)) return null;
  const version = field(answer, "version");
  return { engine, version: typeof version === "string" ? version : null };
}

/** What the chat says while it waits for Unreal, and when the wait ends without it. */
export const WAIT_MESSAGE = {
  waiting: (project: string | null) =>
    `Unreal is opening ${project ?? "this game's project"}; a first start can take several minutes. This chat goes on by itself when it's ready. Stop ends the wait.`,
  stopped: "Stopped waiting for Unreal. Send a message to go on once it's open.",
  notReady: (project: string | null) =>
    `Unreal didn't finish opening ${project ?? "this game's project"}. Open it from the Unreal button above the game, then send a message to go on.`,
  /** The wait's cap passed while Unreal still opens it: a cold first start can take that long. */
  stillOpening: (project: string | null) =>
    `Unreal is still opening ${project ?? "this game's project"} after ${UNREAL_START_WAIT_MS / MINUTE_MS} minutes; a first start on a new Mac can take longer. Send a message once the Unreal button says Ready.`,
} as const;

/** What the chat says when a wait ends without Unreal answering: still opening at the cap, else it stopped opening. */
export const waitEndWords = (end: EditorWaitEnd): string =>
  end.state === EditorWait.Starting ? WAIT_MESSAGE.stillOpening(end.project) : WAIT_MESSAGE.notReady(end.project);

/** A wait's end: where the editor stands and the project's name (null when the plugin named none). */
export type EditorWaitEnd = { state: EditorWait; project: string | null };

/** One `wait-editor` call of up to `seconds`; a call that fails or answers oddly reads as no project. */
async function askOnce(invoke: UnrealInvoke, seconds: number): Promise<EditorWaitEnd> {
  const answer = await invoke(UnrealChatTool.WaitEditor, { seconds }).catch(() => null);
  const state = field(answer, "state");
  const project = field(answer, "project");
  return { state: isWait(state) ? state : EditorWait.NoProject, project: typeof project === "string" ? project : null };
}

/**
 * Waits for the game's editor while it starts, one plugin call after another, until it answers,
 * stops starting, the person stops the turn, or `capMs` passes. `capMs` of 0 only looks.
 */
export async function waitForEditor(
  invoke: UnrealInvoke,
  clock: { now: () => number; cancelled: () => boolean },
  capMs: number,
): Promise<EditorWaitEnd> {
  const ends = clock.now() + capMs;
  let last = await askOnce(invoke, 0);
  while (last.state === EditorWait.Starting && !clock.cancelled() && clock.now() < ends) {
    const seconds = Math.max(1, Math.min(WAIT_CALL_SECONDS, Math.ceil((ends - clock.now()) / SECOND_MS)));
    last = await askOnce(invoke, seconds);
  }
  return last;
}
