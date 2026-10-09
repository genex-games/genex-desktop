/**
 * Genex's moments and a plugin's locks (manifest `hooks` and `locks`, API 3). At a moment (a run
 * starting, a checkpoint, a restore, a worker starting…) Genex runs the harness tools the enabled
 * plugins hook to it, in plugin order and then declaration order, for the games their `facts`
 * reach. A handler is told the moment (`HookContext`) and answers `HookAnswer`: it may block the
 * moment with a reason, add a note, say it is not ready yet or hand back pictures; it never
 * rewrites arguments and never gives instructions. Git stays Genex's: no hook takes or restores a
 * snapshot. A lock serializes the tools and connectors that `need` it, and gives way to the person
 * while its `personFirst` probe says they are using what it guards.
 *
 * Renderer-safe: no Node. Validation is `substrate/plugins/hook-manifest.ts`; the registry plans a
 * moment through `hookPlan`, and `main/core/plugin-hooks.ts` runs it.
 */
import type { SnapshotRecord } from "./event-log.ts";
import type { PluginManifest } from "./plugins.ts";
import { type GameKind, scopeReaches } from "./project-facts.ts";

/** Genex's moments a plugin may hook. Manifest values: never rename one. */
export const HookEvent = {
  RunPrepare: "run.prepare",
  RunEnd: "run.end",
  TurnStart: "turn.start",
  TurnEnd: "turn.end",
  CheckpointBefore: "checkpoint.before",
  CheckpointAfter: "checkpoint.after",
  RestoreBefore: "restore.before",
  RestoreAfter: "restore.after",
  WorkerStart: "worker.start",
  WorkerEnd: "worker.end",
  ToolBefore: "tool.before",
  ToolAfter: "tool.after",
  Health: "health",
  Crash: "crash",
  Finish: "finish",
} as const;
export type HookEvent = (typeof HookEvent)[keyof typeof HookEvent];

/** Every moment, in declaration order. */
const HOOK_EVENTS: readonly HookEvent[] = Object.values(HookEvent);
const HOOK_EVENT_SET: ReadonlySet<unknown> = new Set(HOOK_EVENTS);

/** Whether a value names one of Genex's moments. */
export const isHookEvent = (value: unknown): value is HookEvent => HOOK_EVENT_SET.has(value);

/**
 * The moments a handler's `block` stops: a run that would start (`run.prepare`), a turn
 * (`turn.start`), a checkpoint or a restore before it changes anything, a worker before it starts,
 * a plugin's own tool before it runs, and a finish the lead asked for. At any other moment a
 * block is only a note.
 */
export const BLOCKING_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set([
  HookEvent.RunPrepare,
  HookEvent.TurnStart,
  HookEvent.CheckpointBefore,
  HookEvent.RestoreBefore,
  HookEvent.WorkerStart,
  HookEvent.ToolBefore,
  HookEvent.Finish,
]);

/** The moments whose handlers write (save, close or reopen an app): held while the chat plans. */
export const WRITING_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set([
  HookEvent.RunPrepare,
  HookEvent.CheckpointBefore,
  HookEvent.CheckpointAfter,
  HookEvent.RestoreBefore,
  HookEvent.RestoreAfter,
  HookEvent.Crash,
]);

/**
 * The moments the harness itself announces. Genex fires the checkpoint and tool moments around
 * its own work; a restore the harness announces is a restart in which no file changes.
 */
export const SEED_FIRED_HOOK_EVENTS: ReadonlySet<HookEvent> = new Set(
  HOOK_EVENTS.filter(
    (on) =>
      on !== HookEvent.CheckpointBefore &&
      on !== HookEvent.CheckpointAfter &&
      on !== HookEvent.ToolBefore &&
      on !== HookEvent.ToolAfter,
  ),
);

/** What a lock is shared by: one game (`project`) or every game on this Mac (`app`). Manifest values. */
export const LockScope = { Project: "project", App: "app" } as const;
export type LockScope = (typeof LockScope)[keyof typeof LockScope];

const LOCK_SCOPES: ReadonlySet<unknown> = new Set(Object.values(LockScope));

/** Whether a value is a lock's scope. */
export const isLockScope = (value: unknown): value is LockScope => LOCK_SCOPES.has(value);

/** A lock's id: lowercase letters, digits and dashes, starting with a letter, at most 40. */
export const LOCK_ID = /^[a-z][a-z0-9-]{0,39}$/;

/** The longest lock label, which names the app the person sees ("Working in Unreal"). */
export const LOCK_LABEL_CHARS = 60;

/** One of a plugin's handlers: its harness tool `tool` runs at `on`, for the games its `facts` reach (every game when absent). */
export interface PluginHook {
  on: HookEvent;
  tool: string;
  facts?: string[];
}

/**
 * Something one holder at a time may use, such as an editor: the tools and connectors that `need`
 * it wait their turn. `personFirst` names the harness tool that answers whether the person is
 * using it (`PersonFirstAnswer`); while they are, the agents' work waits.
 */
export interface PluginLock {
  id: string;
  label: string;
  per: LockScope;
  personFirst?: string;
}

/**
 * What a handler is told about the moment it runs at (`PluginBinding.hook`). `args` is only a
 * digest of a plugin tool's arguments at `tool.*`, never the arguments themselves.
 */
export interface HookContext {
  on: HookEvent;
  runId?: string;
  turn?: string;
  label?: string;
  worker?: { id: string; title: string; type?: string };
  tool?: string;
  args?: string;
  forPerson?: boolean;
}

/** A picture a handler hands back (a base64 PNG), with any numbers it measured. */
export interface HookImage {
  name: string;
  data: string;
  measures?: Record<string, number>;
}

/**
 * A handler's answer: `block` stops a blocking moment with a reason, `note` adds a line to the
 * record, `pending` says it is not ready yet (Genex asks again), `images` hands back pictures.
 */
export interface HookAnswer {
  block?: string;
  note?: string;
  pending?: string;
  images?: HookImage[];
}

/** The longest reason a block or a pending answer keeps. */
export const HOOK_REASON_CHARS = 300;
/** The longest note a handler adds. */
export const HOOK_NOTE_CHARS = 2_000;
/** How many pictures one answer keeps. */
export const HOOK_IMAGES_MAX = 8;
/** The largest picture one answer keeps, decoded. */
export const HOOK_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
/** How many measures one picture keeps. */
const HOOK_MEASURES_MAX = 16;
/** A picture's name, and each measure's. */
const HOOK_IMAGE_NAME = /^[A-Za-z0-9 ._-]{1,80}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A string trimmed and clipped to `max`, or undefined when it is no string or empty. */
function clipped(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, max);
  return text || undefined;
}

/** How many bytes a base64 text decodes to. */
const decodedBytes = (data: string): number => Math.floor((data.length * 3) / 4) - (data.match(/=+$/)?.[0].length ?? 0);

/** A picture's measures: finite numbers under plain names, at most the cap. */
function measuresOf(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const kept = Object.entries(value)
    .filter(([key, n]) => HOOK_IMAGE_NAME.test(key) && typeof n === "number" && Number.isFinite(n))
    .slice(0, HOOK_MEASURES_MAX);
  return kept.length ? (Object.fromEntries(kept) as Record<string, number>) : undefined;
}

/** One picture of an answer, or null when it is not one Genex keeps. */
function hookImageOf(value: unknown): HookImage | null {
  if (!isRecord(value)) return null;
  const { name, data } = value;
  const named = typeof name === "string" && HOOK_IMAGE_NAME.test(name);
  const encoded = typeof data === "string" && BASE64.test(data) && decodedBytes(data) <= HOOK_IMAGE_MAX_BYTES;
  if (!named || !encoded) return null;
  const measures = measuresOf(value.measures);
  return measures ? { name, data, measures } : { name, data };
}

/** A handler's answer as Genex keeps it: only the known fields, trimmed, clipped and capped; anything else ignored. */
export function hookAnswerOf(answer: unknown): HookAnswer {
  if (!isRecord(answer)) return {};
  const kept: HookAnswer = {};
  const block = clipped(answer.block, HOOK_REASON_CHARS);
  const note = clipped(answer.note, HOOK_NOTE_CHARS);
  const pending = clipped(answer.pending, HOOK_REASON_CHARS);
  if (block) kept.block = block;
  if (note) kept.note = note;
  if (pending) kept.pending = pending;
  const images = Array.isArray(answer.images)
    ? answer.images
        .map(hookImageOf)
        .filter((image): image is HookImage => image !== null)
        .slice(0, HOOK_IMAGES_MAX)
    : [];
  if (images.length) kept.images = images;
  return kept;
}

/** One handler a moment runs: the plugin, its harness tool's manifest name, and the locks that tool needs. */
export interface HookStep {
  plugin: string;
  tool: string;
  needs: string[];
}

/**
 * Why Genex itself held a moment, a checkpoint or a restore back before any step ran: the chat's
 * Plan mode, the person using what a step's lock guards, Genex unable to tell whether they were, or
 * another holder working there. Callers word the person's line from it, never from the reason's
 * text. Answered to the harness: never rename a value.
 */
export const HookHold = { Plan: "plan", PersonFirst: "person_first", CantTell: "cant_tell", Busy: "busy" } as const;
export type HookHold = (typeof HookHold)[keyof typeof HookHold];

/** What held a moment back, beside its reason: Genex's hold and the lock's label, when it was Genex's. */
export interface HookHeld {
  hold?: HookHold;
  label?: string;
}

/** What a moment's handlers answered: the first block, the first pending, every note and picture, and who ran (agent names, in order). */
export interface HookReport {
  blocked: ({ plugin: string; tool: string; reason: string } & HookHeld) | null;
  pending: { plugin: string; reason: string } | null;
  notes: Array<{ plugin: string; text: string }>;
  images: HookImage[];
  ran: string[];
}

/** The report of a moment no handler ran at. */
export const EMPTY_HOOK_REPORT: HookReport = Object.freeze({
  blocked: null,
  pending: null,
  notes: [],
  images: [],
  ran: [],
});

/** An enabled plugin as a moment's plan reads it. */
export interface HookedPlugin {
  id: string;
  manifest: Pick<PluginManifest, "hooks" | "tools">;
}

/** Whether a moment runs only a plugin's own handlers, around its own tool. */
const isToolMoment = (on: HookEvent): boolean => on === HookEvent.ToolBefore || on === HookEvent.ToolAfter;

/**
 * The handlers a moment runs for a game: plugin order as given, then declaration order; a hook
 * reaches when its `facts` reach the game (`scopeReaches`). `tool.*` runs only the hooks of the
 * plugin `own`, whose tool is called; without one, none.
 */
export function hookPlan(plugins: readonly HookedPlugin[], on: HookEvent, game: GameKind, own?: string): HookStep[] {
  return plugins
    .filter((plugin) => !isToolMoment(on) || plugin.id === own)
    .flatMap(({ id, manifest }) =>
      (manifest.hooks ?? [])
        .filter((hook) => hook.on === on && scopeReaches(hook.facts, game))
        .map((hook) => ({
          plugin: id,
          tool: hook.tool,
          needs: [...(manifest.tools.find((tool) => tool.name === hook.tool)?.needs ?? [])],
        })),
    );
}

/** The moments some plugin has a handler at for a game, in declaration order (`tool.*` counting each plugin's own). */
export function hookEventsOf(plugins: readonly HookedPlugin[], game: GameKind): HookEvent[] {
  return HOOK_EVENTS.filter((on) => plugins.some((plugin) => hookPlan([plugin], on, game, plugin.id).length > 0));
}

/** What a lock's `personFirst` probe answers: whether the person is using what it guards, and how much unsaved work it holds. */
export interface PersonFirstAnswer {
  personActive: boolean;
  unsaved?: number;
}

/** A probe's answer, or null when Genex can't tell (no boolean `personActive`, or an `unsaved` that is no count). */
export function personFirstOf(answer: unknown): PersonFirstAnswer | null {
  if (!isRecord(answer) || typeof answer.personActive !== "boolean") return null;
  const { unsaved } = answer;
  if (unsaved === undefined) return { personActive: answer.personActive };
  if (typeof unsaved !== "number" || !Number.isSafeInteger(unsaved) || unsaved < 0) return null;
  return { personActive: answer.personActive, unsaved };
}

/** Why a checkpoint asked only if something is unsaved was skipped. Written in records: never rename a value. */
export const CheckpointSkip = { NothingUnsaved: "nothing_unsaved", CantTell: "cant_tell" } as const;
export type CheckpointSkip = (typeof CheckpointSkip)[keyof typeof CheckpointSkip];

/** The longest label a moment carries (a checkpoint's name, a turn's words). */
export const HOOK_LABEL_CHARS = 120;
const CONTROL_CHARS = /\p{Cc}/u;

/** Whether a value is a moment's label: 1 to `HOOK_LABEL_CHARS` characters on one line, none of them control characters. */
export const isHookLabel = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= HOOK_LABEL_CHARS && !CONTROL_CHARS.test(value);

/** Whether the harness may announce a moment (`SEED_FIRED_HOOK_EVENTS`). */
export const isSeedFiredHookEvent = (value: unknown): value is HookEvent =>
  isHookEvent(value) && SEED_FIRED_HOOK_EVENTS.has(value);

/** The code of the error a restore a handler blocked fails with (`restoreWithHooks`): nothing was restored. */
export const HOOK_BLOCKED = "hook_blocked";

/**
 * What a checkpoint answers: the snapshot it took with its handlers' notes and pictures; why a
 * handler, a lock or Plan mode stopped it (no snapshot; `hold` when it was Genex's); or why one
 * asked only if something is unsaved was skipped.
 */
export type CheckpointAnswer =
  | { snapshot: SnapshotRecord; notes: HookReport["notes"]; images: HookImage[] }
  | ({ blocked: string } & HookHeld)
  | { skipped: CheckpointSkip; reason: string };
