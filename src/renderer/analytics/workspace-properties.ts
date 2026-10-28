/**
 * The workspace's events as pure functions of what happened: each takes the app's own facts
 * (a launch, a folder inspection, a game, a notice) and the times it began and ended, and answers
 * with properties that are enums, switches, counts, buckets and durations only. Nothing a person
 * wrote or named, and no path, ever leaves through them.
 */
import { DAY_MS, HOUR_MS } from "../../shared/duration.ts";
import { errorCodeIn } from "../../shared/errors.ts";
import { ExportRefusal, WorkspaceRefusal } from "../../shared/game-library.ts";
import type { FolderInspection, GameProject } from "../../shared/game-project.ts";
import { ReasoningEffort } from "../../shared/model-preferences.ts";
import { EngineId } from "../../shared/providers.ts";
import { openOptions } from "../../shared/shape-words.ts";
import { parseModelKey } from "../model-key.ts";
import type { Notice } from "../notifications.ts";
import type { StageView } from "../stage.ts";
import { type Launch, LaunchPhase } from "../state/launch.ts";
import { Room } from "../state/threads.ts";
import type { ComposerExtras } from "../ui/PromptBar.tsx";
import type { ExportCode, WorkspaceEvent, WorkspaceEventProperties } from "./events/workspace.ts";
import { charsBucket, countBucket, elapsedMs } from "./properties.ts";
import {
  ActionOutcome,
  AgeBucket,
  type DismissVia,
  DraftSource,
  FreeSpaceAnswer,
  type GameAction,
  type GameCreatedFrom,
  HomeLeftTo,
  HomeWords,
  type LaunchFailReason,
  LaunchMode,
  type LaunchStage,
  type ManageVia,
  type NoticeVia,
  type NoticeWent,
  SearchOutcome,
  SearchTarget,
  SheetOutcome,
  SizeBucket,
  type StageSwitchVia,
  type StorageSurface,
} from "./workspace-vocabulary.ts";

type Props<E extends WorkspaceEvent> = WorkspaceEventProperties[E];

const GB = 1024 ** 3;
const SIZE_LIMITS: ReadonlyArray<[number, SizeBucket]> = [
  [GB, SizeBucket.Small],
  [5 * GB, SizeBucket.Medium],
  [20 * GB, SizeBucket.Large],
];

/** The bucket a size on disk falls in; anything under a gigabyte, nothing included, is the smallest. */
export function sizeBucket(bytes: number): SizeBucket {
  return SIZE_LIMITS.find(([limit]) => bytes < limit)?.[1] ?? SizeBucket.Huge;
}

const AGE_LIMITS: ReadonlyArray<[number, AgeBucket]> = [
  [HOUR_MS, AgeBucket.Hour],
  [DAY_MS, AgeBucket.Day],
  [7 * DAY_MS, AgeBucket.Week],
  [30 * DAY_MS, AgeBucket.Month],
];

/** The bucket an age falls in; a clock that jumped back reads as the youngest. */
export function ageBucket(ms: number): AgeBucket {
  return AGE_LIMITS.find(([limit]) => ms < limit)?.[1] ?? AgeBucket.Older;
}

/** How long ago an ISO time was, as a bucket; null when the time is unreadable. */
export function sinceBucket(iso: string | null | undefined, now: number): AgeBucket | null {
  const at = Date.parse(iso ?? "");
  return Number.isFinite(at) ? ageBucket(elapsedMs(at, now)) : null;
}

const ENGINES: ReadonlyMap<string, EngineId> = new Map(Object.values(EngineId).map((engine) => [engine, engine]));
const EFFORTS: ReadonlyMap<string, ReasoningEffort> = new Map(
  Object.values(ReasoningEffort).map((effort) => [effort, effort]),
);

/** A provider engine the app knows, or null for anything else (never what a person typed). */
export const providerEngine = (value: string | null | undefined): EngineId | null => ENGINES.get(value ?? "") ?? null;

/** An effort the app offers, or null for anything else. */
export const effortOf = (value: string | null | undefined): ReasoningEffort | null => EFFORTS.get(value ?? "") ?? null;

/** What home sent as a launch, as `launchGame` takes it. */
export interface LaunchFacts {
  text: string;
  extras?: ComposerExtras;
  modelKey: string | null;
  effort: string | null;
  parent?: string;
}

/** Where the launch's words came from, and how many games there were. */
export interface LaunchContext {
  fromSuggestion: boolean;
  fromWelcomeIdea: boolean;
  games: number;
}

/** Home's first message leaving for its game: its shape, never its words or the folder chosen. */
export function launchStartedProperties(
  launch: LaunchFacts,
  context: LaunchContext,
): Props<typeof WorkspaceEvent.GameLaunchStarted> {
  const extras = launch.extras ?? {};
  return {
    chars_bucket: charsBucket(launch.text.trim().length),
    from_suggestion: context.fromSuggestion,
    from_welcome_idea: context.fromWelcomeIdea,
    mode: extras.autopilot ? LaunchMode.Loop : LaunchMode.Auto,
    review_plan: extras.reviewPlan === true,
    pictures: extras.frames?.length ?? 0,
    mentions: extras.mentions?.length ?? 0,
    engine: providerEngine(parseModelKey(launch.modelKey).engine),
    effort: effortOf(launch.effort),
    custom_location: Boolean(launch.parent),
    games_bucket: countBucket(context.games),
  };
}

/** A game made: from where, how long it took, and its ref. */
export function gameCreatedProperties(input: {
  from: GameCreatedFrom;
  startedAt?: number;
  at: number;
  customLocation: boolean;
  provisional: boolean;
  games: number;
  ref: string | null;
}): Props<typeof WorkspaceEvent.GameCreated> {
  return {
    from: input.from,
    ...(input.startedAt === undefined ? {} : { create_ms: elapsedMs(input.startedAt, input.at) }),
    custom_location: input.customLocation,
    provisional: input.provisional,
    games_bucket: countBucket(input.games),
    game_ref: input.ref,
  };
}

/** The launch's chat took its message: once, as the launch moves into Handed. */
export function launchHandedProperties(
  previous: Launch | null,
  next: Launch | null,
  at: number,
  ref: string | null,
): Props<typeof WorkspaceEvent.GameLaunchHanded> | null {
  const handedNow = next?.phase === LaunchPhase.Handed && previous?.phase !== LaunchPhase.Handed;
  if (!next || !handedNow) return null;
  return { total_ms: elapsedMs(next.at, at), game_ref: ref };
}

/** What a picked folder holds, as the Open Game sheet shows it: counts and kinds, never its names. */
export function sheetViewedProperties(
  inspection: FolderInspection,
): Props<typeof WorkspaceEvent.OpenFolderSheetViewed> {
  const options = openOptions(inspection);
  const suggested = inspection.candidates.find((candidate) => candidate.rel === inspection.suggested) ?? null;
  return {
    candidates: inspection.candidates.length,
    must_choose: inspection.suggested === null || options.length > 1,
    suggested_kind: suggested?.shape.kind ?? null,
    nested_repos: inspection.nested.length,
    engine_export: options.some((option) => option.engineExport),
    needs_install: inspection.candidates.some((candidate) => candidate.preflight.needsInstall),
    problems: options[0]?.problems.length ?? 0,
    git: suggested?.preflight.git ?? null,
  };
}

/** What the person did on the Open Game sheet before it ended. */
export interface SheetFacts {
  /** When the sheet came up. */
  shownAt: number;
  changedOption: boolean;
  detailsOpened: boolean;
  trustToggled: boolean;
  /** The kind of the row chosen last; null for a folder started in. */
  kind: GameProject["shape"]["kind"] | null;
}

/** The code a game or folder was refused with (`WorkspaceRefusal`), or null: never its words. */
export const workspaceCode = (error: unknown): WorkspaceRefusal | null => errorCodeIn(WorkspaceRefusal, error);

/** The code an export was refused with: its own, or the library's for an unknown game. */
export const exportCode = (error: unknown): ExportCode | null =>
  errorCodeIn(ExportRefusal, error) ?? errorCodeIn(WorkspaceRefusal, error);

/** A launch that stopped: the step, why, how long it had run, and the refusal's code when main named one. */
export function launchFailedProperties(input: {
  stage: LaunchStage;
  reason: LaunchFailReason;
  startedAt: number;
  at: number;
  customLocation: boolean;
  failure?: unknown;
}): Props<typeof WorkspaceEvent.GameLaunchFailed> {
  return {
    stage: input.stage,
    reason: input.reason,
    elapsed_ms: elapsedMs(input.startedAt, input.at),
    custom_location: input.customLocation,
    code: workspaceCode(input.failure),
  };
}

/** How the sheet ended: adopted, failed (with how long adopting took and its refusal's code), or put away. */
export function sheetClosedProperties(
  facts: SheetFacts,
  end: { outcome: SheetOutcome; at: number; via?: DismissVia; adoptStartedAt?: number; failure?: unknown },
): Props<typeof WorkspaceEvent.OpenFolderSheetClosed> {
  const adopted = end.outcome !== SheetOutcome.Dismissed ? end.adoptStartedAt : undefined;
  return {
    outcome: end.outcome,
    ...(end.via && end.outcome === SheetOutcome.Dismissed ? { via: end.via } : {}),
    dwell_ms: elapsedMs(facts.shownAt, end.adoptStartedAt ?? end.at),
    changed_option: facts.changedOption,
    details_opened: facts.detailsOpened,
    trust_toggled: facts.trustToggled,
    kind: facts.kind,
    ...(adopted === undefined ? {} : { adopt_ms: elapsedMs(adopted, end.at) }),
    ...(end.outcome === SheetOutcome.Failed ? { code: workspaceCode(end.failure) } : {}),
  };
}

/** A game opened: whether it is pinned, how far down the sidebar it sat, and how long opening took. */
export function gameOpenedProperties(input: {
  via: Props<typeof WorkspaceEvent.GameOpened>["via"];
  game: Pick<GameProject, "pinned"> | null;
  /** Its row's place in the sidebar, or -1 when it has none. */
  index: number;
  startedAt: number;
  at: number;
  reload: boolean;
  ref: string | null;
}): Props<typeof WorkspaceEvent.GameOpened> {
  return {
    via: input.via,
    pinned: input.game?.pinned === true,
    sidebar_index_bucket: input.index < 0 ? null : countBucket(input.index),
    open_ms: elapsedMs(input.startedAt, input.at),
    reload: input.reload,
    game_ref: input.ref,
  };
}

/** Something done to a game, how it ended, how old the game was, and a failure's code. */
export function gameManagedProperties(input: {
  action: GameAction;
  via: ManageVia;
  outcome: ActionOutcome;
  game: Pick<GameProject, "createdAt"> | null;
  at: number;
  ref: string | null;
  failure?: unknown;
}): Props<typeof WorkspaceEvent.GameManaged> {
  return {
    action: input.action,
    via: input.via,
    outcome: input.outcome,
    ms_since_created_bucket: sinceBucket(input.game?.createdAt, input.at),
    game_ref: input.ref,
    ...(input.outcome === ActionOutcome.Failed ? { code: workspaceCode(input.failure) } : {}),
  };
}

/** An export's result as counts, never the files it names or the folder it wrote; a failure says its code. */
export function exportFinishedProperties(
  result: { files: number; excluded: readonly string[] } | null,
  timing: { startedAt: number; at: number; ref: string | null },
  failure: unknown = null,
): Props<typeof WorkspaceEvent.GameExportFinished> {
  const ended = result
    ? { files_bucket: countBucket(result.files), excluded_bucket: countBucket(result.excluded.length) }
    : { code: exportCode(failure) };
  return {
    outcome: result ? ActionOutcome.Ok : ActionOutcome.Failed,
    ...ended,
    export_ms: elapsedMs(timing.startedAt, timing.at),
    game_ref: timing.ref,
  };
}

/** What a stage switch moved from and to, what moved it, and how long the last view stayed. */
export function stageChangedProperties(input: {
  from: StageView;
  to: StageView;
  via: StageSwitchVia;
  since: number;
  at: number;
  running: boolean;
}): Props<typeof WorkspaceEvent.StageViewChanged> {
  return {
    from: input.from,
    to: input.to,
    via: input.via,
    from_dwell_ms: elapsedMs(input.since, input.at),
    run_running: input.running,
  };
}

/** A notification's own kind, tone and whether it holds work: never its words or its game. */
export function noticeProperties(notice: Pick<Notice, "kind" | "tone" | "waiting">) {
  return { kind: notice.kind, tone: notice.tone ?? null, waiting: notice.waiting === true };
}

/** A notification opened: how, how old it was, and where it took the person. */
export function noticeOpenedProperties(
  notice: Pick<Notice, "kind" | "tone" | "waiting" | "at">,
  input: { via: NoticeVia; went: NoticeWent; now: number },
): Props<typeof WorkspaceEvent.NoticeOpened> {
  const at = Date.parse(notice.at);
  return {
    ...noticeProperties(notice),
    via: input.via,
    age_ms: Number.isFinite(at) ? elapsedMs(at, input.now) : null,
    went: input.went,
  };
}

/** Where the person went when home went away: a game, Harness, or anywhere else. */
export function homeLeftTo(room: Room): HomeLeftTo {
  if (room === Room.Build) return HomeLeftTo.Game;
  return room === Room.Studio ? HomeLeftTo.Harness : HomeLeftTo.Other;
}

/** The words home came up with: a failed launch's, the welcome's idea, or none. */
export function homeWords(returned: boolean, words: string | null | undefined): HomeWords {
  if (returned) return HomeWords.FailedLaunch;
  return words ? HomeWords.WelcomeIdea : HomeWords.None;
}

/** The first words a visit expects from what home came up with. */
export const WAITING_SOURCE = {
  [HomeWords.None]: null,
  [HomeWords.WelcomeIdea]: DraftSource.WelcomeIdea,
  [HomeWords.FailedLaunch]: DraftSource.FailedLaunch,
} as const satisfies Record<HomeWords, DraftSource | null>;

/** The Appearance fields a change is counted by: the settings' own names, never a preset's. */
const APPEARANCE_FIELDS = ["mode", "light", "dark", "uiFont", "contentFont", "codeFont", "saved"] as const;

/** The Appearance fields that differ between two appearances. */
export function appearanceFieldsChanged(previous: object, next: object): string[] {
  const before = new Map(Object.entries(previous));
  const after = new Map(Object.entries(next));
  return APPEARANCE_FIELDS.filter((field) => JSON.stringify(before.get(field)) !== JSON.stringify(after.get(field)));
}

/** How ⌘K search ended: the result picked (by its place and kind, never its name), or none. */
export function searchClosedProperties(input: {
  /** The result picked: its place in the list, and whether it was an earlier chat rather than a game. */
  picked: { index: number; earlierChat: boolean } | null;
  query: string;
  results: number;
  noResultsSeen: boolean;
  openedAt: number;
  at: number;
}): Props<typeof WorkspaceEvent.GameSearchClosed> {
  const { picked } = input;
  const pick = picked
    ? { result_index: picked.index, target: picked.earlierChat ? SearchTarget.EarlierChat : SearchTarget.Game }
    : {};
  return {
    outcome: picked ? SearchOutcome.Opened : SearchOutcome.Dismissed,
    query_chars_bucket: charsBucket(input.query.trim().length),
    results_count: input.results,
    ...pick,
    no_results_seen: input.noResultsSeen,
    dwell_ms: elapsedMs(input.openedAt, input.at),
  };
}

/** Free up answered and done: how much was offered and freed, in buckets, and how many games were left alone. */
export function freedProperties(
  surface: StorageSurface,
  offeredBytes: number,
  freed: { freedBytes: number; skipped: readonly string[] } | null,
): Props<typeof WorkspaceEvent.FreeSpaceAnswered> {
  const result = freed
    ? { freed_bucket: sizeBucket(freed.freedBytes), skipped_games: freed.skipped.length, failed: false }
    : { failed: true };
  return { surface, answer: FreeSpaceAnswer.Free, freeable_bucket: sizeBucket(offeredBytes), ...result };
}
